use anchor_lang::prelude::*;
use light_hasher::Poseidon;
use ark_ff::PrimeField;
use ark_bn254::Fr;
use anchor_spl::token::{self, Token, TokenAccount, Mint, Transfer as SplTransfer};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("5S7PQfffWm4uYMg62Zsjzp2BZgTQSVFj8cmoNBRggwWw");

pub mod merkle_tree;
pub mod utils;
pub mod groth16;
pub mod errors;
pub mod klend_cpi;

use merkle_tree::MerkleTree;

const MERKLE_TREE_HEIGHT: u8 = 26;
const ROOT_HISTORY_SIZE: usize = 100;

#[program]
pub mod privacy_yield {
    use crate::utils::{verify_proof, VERIFYING_KEY};

    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let tree_account = &mut ctx.accounts.tree_account.load_init()?;
        tree_account.authority = ctx.accounts.authority.key();
        tree_account.next_index = 0;
        tree_account.root_index = 0;
        tree_account.bump = ctx.bumps.tree_account;
        tree_account.max_deposit_amount = 1_000_000_000_000; // 1M USDC (6 decimals)
        tree_account.height = MERKLE_TREE_HEIGHT;
        tree_account.root_history_size = ROOT_HISTORY_SIZE as u8;

        MerkleTree::initialize::<Poseidon>(tree_account)?;

        let pool_config = &mut ctx.accounts.pool_config;
        pool_config.authority = ctx.accounts.authority.key();
        pool_config.usdc_mint = ctx.accounts.usdc_mint.key();
        pool_config.bump = ctx.bumps.pool_config;

        msg!("Privacy Yield pool initialized: height={}, mint={}",
            MERKLE_TREE_HEIGHT, pool_config.usdc_mint);
        Ok(())
    }

    pub fn transact(
        ctx: Context<Transact>,
        proof: Proof,
        ext_data_minified: ExtDataMinified,
        encrypted_output1: Vec<u8>,
        encrypted_output2: Vec<u8>,
    ) -> Result<()> {
        let tree_account = &mut ctx.accounts.tree_account.load_mut()?;
        let pool_config = &ctx.accounts.pool_config;

        // Validate signer's token account ownership and mint
        require!(
            ctx.accounts.signer_token_account.owner == ctx.accounts.signer.key(),
            ErrorCode::InvalidTokenAccount
        );
        require!(
            ctx.accounts.signer_token_account.mint == ctx.accounts.mint.key(),
            ErrorCode::InvalidTokenAccountMintAddress
        );

        // Validate mint matches pool_config (prevent depositing other tokens)
        require!(
            ctx.accounts.mint.key() == pool_config.usdc_mint,
            ErrorCode::InvalidTokenAccountMintAddress
        );

        // Reconstruct full ExtData from minified version and context accounts
        let ext_data = ExtData {
            recipient: ctx.accounts.recipient_token_account.key(),
            ext_amount: ext_data_minified.ext_amount,
            fee: ext_data_minified.fee,
            fee_recipient: ctx.accounts.signer.key(), // No fee recipient — use signer as placeholder
            mint_address: ctx.accounts.mint.key(),
        };

        // Check if proof.root is in the tree_account's root history
        require!(
            MerkleTree::is_known_root(&tree_account, proof.root),
            ErrorCode::UnknownRoot
        );

        // Verify extDataHash
        let calculated_ext_data_hash = utils::calculate_complete_ext_data_hash(
            ext_data.recipient,
            ext_data.ext_amount,
            &encrypted_output1,
            &encrypted_output2,
            ext_data.fee,
            ext_data.fee_recipient,
            ext_data.mint_address,
        )?;

        require!(
            Fr::from_le_bytes_mod_order(&calculated_ext_data_hash) == Fr::from_be_bytes_mod_order(&proof.ext_data_hash),
            ErrorCode::ExtDataHashMismatch
        );

        // Check public amount = ext_amount - fee (fee always 0 in Phase 1)
        require!(
            utils::check_public_amount(ext_data.ext_amount, ext_data.fee, proof.public_amount),
            ErrorCode::InvalidPublicAmountData
        );

        // Verify the Groth16 proof
        require!(verify_proof(proof.clone(), VERIFYING_KEY), ErrorCode::InvalidProof);

        let ext_amount = ext_data.ext_amount;

        if ext_amount > 0 {
            // Deposit: check limit, transfer signer → pool_vault
            let deposit_amount = ext_amount as u64;
            require!(
                deposit_amount <= tree_account.max_deposit_amount,
                ErrorCode::DepositLimitExceeded
            );

            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    SplTransfer {
                        from: ctx.accounts.signer_token_account.to_account_info(),
                        to: ctx.accounts.pool_vault.to_account_info(),
                        authority: ctx.accounts.signer.to_account_info(),
                    },
                ),
                deposit_amount,
            )?;
        } else if ext_amount < 0 {
            // Withdrawal: transfer pool_vault → recipient (PDA-signed)
            let ext_amount_abs: u64 = ext_amount.checked_neg()
                .ok_or(ErrorCode::ArithmeticOverflow)?
                .try_into()
                .map_err(|_| ErrorCode::InvalidExtAmount)?;

            require!(
                ctx.accounts.pool_vault.amount >= ext_amount_abs,
                ErrorCode::InsufficientFundsForWithdrawal
            );

            let bump = &[pool_config.bump];
            let seeds: &[&[u8]] = &[b"pool_config", bump];
            let signer_seeds = &[seeds];

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    SplTransfer {
                        from: ctx.accounts.pool_vault.to_account_info(),
                        to: ctx.accounts.recipient_token_account.to_account_info(),
                        authority: pool_config.to_account_info(),
                    },
                    signer_seeds,
                ),
                ext_amount_abs,
            )?;
        }
        // ext_amount == 0 → merge operation, no token transfer

        // Append both output commitments to Merkle tree
        let next_index_to_insert = tree_account.next_index;
        MerkleTree::append::<Poseidon>(proof.output_commitments[0], tree_account)?;
        MerkleTree::append::<Poseidon>(proof.output_commitments[1], tree_account)?;

        let second_index = next_index_to_insert.checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        emit!(CommitmentData {
            index: next_index_to_insert,
            commitment: proof.output_commitments[0],
            encrypted_output: encrypted_output1.to_vec(),
        });

        emit!(CommitmentData {
            index: second_index,
            commitment: proof.output_commitments[1],
            encrypted_output: encrypted_output2.to_vec(),
        });

        Ok(())
    }

    pub fn configure_klend(ctx: Context<ConfigureKlend>) -> Result<()> {
        let klend_config = &mut ctx.accounts.klend_config;
        klend_config.authority = ctx.accounts.authority.key();
        klend_config.klend_program = ctx.accounts.klend_program.key();
        klend_config.lending_market = ctx.accounts.lending_market.key();
        klend_config.reserve = ctx.accounts.reserve.key();
        klend_config.lending_market_authority = ctx.accounts.lending_market_authority.key();
        klend_config.reserve_liquidity_supply = ctx.accounts.reserve_liquidity_supply.key();
        klend_config.reserve_collateral_mint = ctx.accounts.collateral_mint.key();
        klend_config.bump = ctx.bumps.klend_config;

        msg!("Klend config initialized: program={}, reserve={}",
            klend_config.klend_program, klend_config.reserve);
        Ok(())
    }

    pub fn kamino_deposit(ctx: Context<KaminoDeposit>) -> Result<()> {
        let amount = ctx.accounts.pool_vault.amount;
        if amount == 0 {
            return Ok(());
        }

        let bump = &[ctx.accounts.pool_config.bump];
        let seeds: &[&[u8]] = &[b"pool_config", bump];
        let signer_seeds = &[seeds];

        klend_cpi::deposit_reserve_liquidity(
            &ctx.accounts.klend_program,
            &ctx.accounts.pool_config.to_account_info(),
            &ctx.accounts.reserve,
            &ctx.accounts.lending_market,
            &ctx.accounts.lending_market_authority,
            &ctx.accounts.reserve_liquidity_mint.to_account_info(),
            &ctx.accounts.reserve_liquidity_supply,
            &ctx.accounts.reserve_collateral_mint,
            &ctx.accounts.pool_vault.to_account_info(),
            &ctx.accounts.pool_ctoken_account.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.instruction_sysvar,
            amount,
            signer_seeds,
        )?;

        msg!("Deposited {} USDC to Kamino", amount);
        Ok(())
    }

    pub fn kamino_redeem(ctx: Context<KaminoRedeem>) -> Result<()> {
        let collateral_amount = ctx.accounts.pool_ctoken_account.amount;
        if collateral_amount == 0 {
            return Ok(());
        }

        let bump = &[ctx.accounts.pool_config.bump];
        let seeds: &[&[u8]] = &[b"pool_config", bump];
        let signer_seeds = &[seeds];

        klend_cpi::redeem_reserve_collateral(
            &ctx.accounts.klend_program,
            &ctx.accounts.pool_config.to_account_info(),
            &ctx.accounts.lending_market,
            &ctx.accounts.reserve,
            &ctx.accounts.lending_market_authority,
            &ctx.accounts.reserve_liquidity_mint.to_account_info(),
            &ctx.accounts.reserve_collateral_mint,
            &ctx.accounts.reserve_liquidity_supply,
            &ctx.accounts.pool_ctoken_account.to_account_info(),
            &ctx.accounts.pool_vault.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.instruction_sysvar,
            collateral_amount,
            signer_seeds,
        )?;

        msg!("Redeemed {} cTokens from Kamino", collateral_amount);
        Ok(())
    }
}

#[event]
pub struct CommitmentData {
    pub index: u64,
    pub commitment: [u8; 32],
    pub encrypted_output: Vec<u8>,
}

// All public inputs in big endian format
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Proof {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub root: [u8; 32],
    pub public_amount: [u8; 32],
    pub ext_data_hash: [u8; 32],
    pub input_nullifiers: [[u8; 32]; 2],
    pub output_commitments: [[u8; 32]; 2],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExtData {
    pub recipient: Pubkey,
    pub ext_amount: i64,
    pub fee: u64,
    pub fee_recipient: Pubkey,
    pub mint_address: Pubkey,
}

// fee is kept in ExtDataMinified because it's part of the circuit's extDataHash computation
// but always set to 0 in Phase 1
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExtDataMinified {
    pub ext_amount: i64,
    pub fee: u64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<MerkleTreeAccount>(),
        seeds = [b"merkle_tree"],
        bump
    )]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,

    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<PoolConfig>(),
        seeds = [b"pool_config"],
        bump
    )]
    pub pool_config: Account<'info, PoolConfig>,

    pub usdc_mint: Account<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proof: Proof, ext_data_minified: ExtDataMinified, encrypted_output1: Vec<u8>, encrypted_output2: Vec<u8>)]
pub struct Transact<'info> {
    #[account(
        mut,
        seeds = [b"merkle_tree"],
        bump = tree_account.load()?.bump
    )]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,

    /// Nullifier account to mark the first input as spent.
    /// Using `init` ensures the transaction fails if this nullifier already exists.
    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<NullifierAccount>(),
        seeds = [b"nullifier0", proof.input_nullifiers[0].as_ref()],
        bump
    )]
    pub nullifier0: Account<'info, NullifierAccount>,

    /// Nullifier account to mark the second input as spent.
    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<NullifierAccount>(),
        seeds = [b"nullifier1", proof.input_nullifiers[1].as_ref()],
        bump
    )]
    pub nullifier1: Account<'info, NullifierAccount>,

    /// Cross-check: verify nullifier[1] hasn't been used in slot 0
    #[account(
        seeds = [b"nullifier0", proof.input_nullifiers[1].as_ref()],
        bump
    )]
    pub nullifier2: SystemAccount<'info>,

    /// Cross-check: verify nullifier[0] hasn't been used in slot 1
    #[account(
        seeds = [b"nullifier1", proof.input_nullifiers[0].as_ref()],
        bump
    )]
    pub nullifier3: SystemAccount<'info>,

    #[account(
        seeds = [b"pool_config"],
        bump = pool_config.bump
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(mut)]
    pub signer: Signer<'info>,

    /// USDC mint
    pub mint: Account<'info, Mint>,

    /// Signer's USDC token account (source for deposits)
    #[account(mut)]
    pub signer_token_account: Account<'info, TokenAccount>,

    /// CHECK: recipient wallet (authority of recipient_token_account)
    pub recipient: UncheckedAccount<'info>,

    /// Recipient's USDC token account (destination for withdrawals)
    #[account(
        mut,
        token::mint = mint,
        token::authority = recipient
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    /// Pool vault ATA (owned by pool_config PDA)
    #[account(
        init_if_needed,
        payer = signer,
        associated_token::mint = mint,
        associated_token::authority = pool_config
    )]
    pub pool_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct PoolConfig {
    pub authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub bump: u8,
}

#[account]
pub struct NullifierAccount {
    // Zero-data: account existence is the check, no fields needed
}

#[account]
pub struct KlendConfig {
    pub authority: Pubkey,                  // 32
    pub klend_program: Pubkey,              // 32
    pub lending_market: Pubkey,             // 32
    pub reserve: Pubkey,                    // 32
    pub lending_market_authority: Pubkey,   // 32
    pub reserve_liquidity_supply: Pubkey,   // 32
    pub reserve_collateral_mint: Pubkey,    // 32
    pub bump: u8,                           // 1
}

#[derive(Accounts)]
pub struct ConfigureKlend<'info> {
    #[account(
        has_one = authority,
        seeds = [b"pool_config"],
        bump = pool_config.bump
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<KlendConfig>(),
        seeds = [b"klend_config"],
        bump
    )]
    pub klend_config: Account<'info, KlendConfig>,

    /// Collateral token mint (cToken) from klend reserve
    pub collateral_mint: Account<'info, Mint>,

    /// Pool's cToken ATA — created here
    #[account(
        init,
        payer = authority,
        associated_token::mint = collateral_mint,
        associated_token::authority = pool_config
    )]
    pub pool_ctoken_account: Account<'info, TokenAccount>,

    /// CHECK: Klend program to be stored in config
    pub klend_program: UncheckedAccount<'info>,

    /// CHECK: Klend lending market
    pub lending_market: UncheckedAccount<'info>,

    /// CHECK: Klend reserve
    pub reserve: UncheckedAccount<'info>,

    /// CHECK: Klend lending market authority (PDA of klend program)
    pub lending_market_authority: UncheckedAccount<'info>,

    /// CHECK: Reserve liquidity supply token account
    pub reserve_liquidity_supply: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct KaminoDeposit<'info> {
    #[account(
        seeds = [b"klend_config"],
        bump = klend_config.bump,
    )]
    pub klend_config: Account<'info, KlendConfig>,

    #[account(
        mut,
        seeds = [b"pool_config"],
        bump = pool_config.bump
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(mut)]
    pub signer: Signer<'info>,

    /// Pool USDC vault (source for deposit into klend)
    #[account(
        mut,
        associated_token::mint = reserve_liquidity_mint,
        associated_token::authority = pool_config
    )]
    pub pool_vault: Account<'info, TokenAccount>,

    /// Pool cToken account (destination for klend collateral)
    #[account(
        mut,
        associated_token::mint = reserve_collateral_mint,
        associated_token::authority = pool_config,
        constraint = reserve_collateral_mint.key() == klend_config.reserve_collateral_mint @ ErrorCode::InvalidKlendAccount,
    )]
    pub pool_ctoken_account: Account<'info, TokenAccount>,

    /// CHECK: Klend program — validated against config
    #[account(
        constraint = klend_program.key() == klend_config.klend_program @ ErrorCode::InvalidKlendProgram
    )]
    pub klend_program: UncheckedAccount<'info>,

    /// CHECK: Klend reserve — validated against config
    #[account(
        mut,
        constraint = reserve.key() == klend_config.reserve @ ErrorCode::InvalidKlendAccount
    )]
    pub reserve: UncheckedAccount<'info>,

    /// CHECK: Klend lending market — validated against config
    #[account(
        constraint = lending_market.key() == klend_config.lending_market @ ErrorCode::InvalidKlendAccount
    )]
    pub lending_market: UncheckedAccount<'info>,

    /// CHECK: Klend lending market authority — validated against config
    #[account(
        constraint = lending_market_authority.key() == klend_config.lending_market_authority @ ErrorCode::InvalidKlendAccount
    )]
    pub lending_market_authority: UncheckedAccount<'info>,

    /// USDC mint (mut required for klend CPI)
    #[account(mut)]
    pub reserve_liquidity_mint: Account<'info, Mint>,

    /// CHECK: Reserve liquidity supply — validated against config
    #[account(
        mut,
        constraint = reserve_liquidity_supply.key() == klend_config.reserve_liquidity_supply @ ErrorCode::InvalidKlendAccount
    )]
    pub reserve_liquidity_supply: UncheckedAccount<'info>,

    /// CHECK: Reserve collateral mint — validated against config
    #[account(
        mut,
        constraint = reserve_collateral_mint.key() == klend_config.reserve_collateral_mint @ ErrorCode::InvalidKlendAccount
    )]
    pub reserve_collateral_mint: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: Instruction sysvar
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct KaminoRedeem<'info> {
    #[account(
        seeds = [b"klend_config"],
        bump = klend_config.bump,
    )]
    pub klend_config: Account<'info, KlendConfig>,

    #[account(
        mut,
        seeds = [b"pool_config"],
        bump = pool_config.bump
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(mut)]
    pub signer: Signer<'info>,

    /// Pool USDC vault (destination for redeemed liquidity)
    #[account(
        mut,
        associated_token::mint = reserve_liquidity_mint,
        associated_token::authority = pool_config
    )]
    pub pool_vault: Account<'info, TokenAccount>,

    /// Pool cToken account (source for redeem from klend)
    #[account(
        mut,
        associated_token::mint = reserve_collateral_mint,
        associated_token::authority = pool_config,
        constraint = reserve_collateral_mint.key() == klend_config.reserve_collateral_mint @ ErrorCode::InvalidKlendAccount,
    )]
    pub pool_ctoken_account: Account<'info, TokenAccount>,

    /// CHECK: Klend program — validated against config
    #[account(
        constraint = klend_program.key() == klend_config.klend_program @ ErrorCode::InvalidKlendProgram
    )]
    pub klend_program: UncheckedAccount<'info>,

    /// CHECK: Klend reserve — validated against config
    #[account(
        mut,
        constraint = reserve.key() == klend_config.reserve @ ErrorCode::InvalidKlendAccount
    )]
    pub reserve: UncheckedAccount<'info>,

    /// CHECK: Klend lending market — validated against config
    #[account(
        constraint = lending_market.key() == klend_config.lending_market @ ErrorCode::InvalidKlendAccount
    )]
    pub lending_market: UncheckedAccount<'info>,

    /// CHECK: Klend lending market authority — validated against config
    #[account(
        constraint = lending_market_authority.key() == klend_config.lending_market_authority @ ErrorCode::InvalidKlendAccount
    )]
    pub lending_market_authority: UncheckedAccount<'info>,

    /// USDC mint (mut required for klend CPI)
    #[account(mut)]
    pub reserve_liquidity_mint: Account<'info, Mint>,

    /// CHECK: Reserve liquidity supply — validated against config
    #[account(
        mut,
        constraint = reserve_liquidity_supply.key() == klend_config.reserve_liquidity_supply @ ErrorCode::InvalidKlendAccount
    )]
    pub reserve_liquidity_supply: UncheckedAccount<'info>,

    /// CHECK: Reserve collateral mint — validated against config
    #[account(
        mut,
        constraint = reserve_collateral_mint.key() == klend_config.reserve_collateral_mint @ ErrorCode::InvalidKlendAccount
    )]
    pub reserve_collateral_mint: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: Instruction sysvar
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instruction_sysvar: UncheckedAccount<'info>,
}

#[account(zero_copy)]
pub struct MerkleTreeAccount {
    pub authority: Pubkey,
    pub next_index: u64,
    pub subtrees: [[u8; 32]; MERKLE_TREE_HEIGHT as usize],
    pub root: [u8; 32],
    pub root_history: [[u8; 32]; ROOT_HISTORY_SIZE],
    pub root_index: u64,
    pub max_deposit_amount: u64,
    pub height: u8,
    pub root_history_size: u8,
    pub bump: u8,
    pub _padding: [u8; 5],
}

#[error_code]
pub enum ErrorCode {
    #[msg("Not authorized to perform this action")]
    Unauthorized,
    #[msg("External data hash does not match the one in the proof")]
    ExtDataHashMismatch,
    #[msg("Root is not known in the tree")]
    UnknownRoot,
    #[msg("Public amount is invalid")]
    InvalidPublicAmountData,
    #[msg("Insufficient funds for withdrawal")]
    InsufficientFundsForWithdrawal,
    #[msg("Proof is invalid")]
    InvalidProof,
    #[msg("Invalid ext amount")]
    InvalidExtAmount,
    #[msg("Arithmetic overflow/underflow occurred")]
    ArithmeticOverflow,
    #[msg("Deposit limit exceeded")]
    DepositLimitExceeded,
    #[msg("Merkle tree is full: cannot add more leaves")]
    MerkleTreeFull,
    #[msg("Invalid token account: not owned by signer")]
    InvalidTokenAccount,
    #[msg("Invalid token account mint address")]
    InvalidTokenAccountMintAddress,
    #[msg("Invalid klend program")]
    InvalidKlendProgram,
    #[msg("Invalid klend account")]
    InvalidKlendAccount,
}
