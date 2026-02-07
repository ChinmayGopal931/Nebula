use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use anchor_spl::token::{MintTo, Burn, Transfer as SplTransfer};

declare_id!("CcubA6KJKRuBV1GBbXxeu9rNwv6UeVLZfCvfs6LqBZfk");

#[program]
pub mod mock_klend {
    use super::*;

    /// Initialize a lending market. Creates the LMA PDA.
    /// Real klend stores quote currency etc — mock just stores the bump.
    pub fn init_lending_market(ctx: Context<InitLendingMarket>, _quote_currency: [u8; 32]) -> Result<()> {
        let market = &mut ctx.accounts.lending_market;
        market.owner = ctx.accounts.owner.key();
        market.lma_bump = ctx.bumps.lending_market_authority;
        msg!("Mock klend: lending market initialized");
        Ok(())
    }

    /// Initialize a reserve for a given liquidity mint.
    /// Creates PDA token accounts for liquidity supply, fee receiver, collateral mint,
    /// and collateral supply.
    pub fn init_reserve(ctx: Context<InitReserve>) -> Result<()> {
        let reserve = &mut ctx.accounts.reserve;
        reserve.lending_market = ctx.accounts.lending_market.key();
        reserve.liquidity_mint = ctx.accounts.liquidity_mint.key();
        reserve.collateral_mint = ctx.accounts.reserve_collateral_mint.key();
        reserve.liquidity_supply = ctx.accounts.reserve_liquidity_supply.key();
        msg!("Mock klend: reserve initialized for mint {}", reserve.liquidity_mint);
        Ok(())
    }

    /// Deposit liquidity into the reserve. 1:1 exchange rate.
    /// Transfers `amount` from user_source_liquidity → reserve_liquidity_supply,
    /// then mints `amount` cTokens to user_destination_collateral.
    ///
    /// Account order matches real klend deposit_reserve_liquidity exactly
    /// (see klend_cpi.rs in privacy-yield).
    pub fn deposit_reserve_liquidity(ctx: Context<DepositReserveLiquidity>, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }

        // Transfer USDC: user_source_liquidity → reserve_liquidity_supply
        token::transfer(
            CpiContext::new(
                ctx.accounts.liquidity_token_program.to_account_info(),
                SplTransfer {
                    from: ctx.accounts.user_source_liquidity.to_account_info(),
                    to: ctx.accounts.reserve_liquidity_supply.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;

        // Mint cTokens 1:1: → user_destination_collateral
        let lending_market_key = ctx.accounts.lending_market.key();
        let seeds: &[&[u8]] = &[
            b"lma",
            lending_market_key.as_ref(),
            &[ctx.accounts.lending_market.lma_bump],
        ];
        let signer_seeds = &[seeds];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.collateral_token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.reserve_collateral_mint.to_account_info(),
                    to: ctx.accounts.user_destination_collateral.to_account_info(),
                    authority: ctx.accounts.lending_market_authority.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;

        msg!("Mock klend: deposited {} liquidity, minted {} cTokens", amount, amount);
        Ok(())
    }

    /// Redeem collateral from the reserve. 1:1 exchange rate.
    /// Burns `collateral_amount` cTokens from user_source_collateral,
    /// then transfers `collateral_amount` from reserve_liquidity_supply → user_destination_liquidity.
    ///
    /// Account order matches real klend redeem_reserve_collateral exactly
    /// (see klend_cpi.rs in privacy-yield).
    pub fn redeem_reserve_collateral(ctx: Context<RedeemReserveCollateral>, collateral_amount: u64) -> Result<()> {
        if collateral_amount == 0 {
            return Ok(());
        }

        let lending_market_key = ctx.accounts.lending_market.key();
        let seeds: &[&[u8]] = &[
            b"lma",
            lending_market_key.as_ref(),
            &[ctx.accounts.lending_market.lma_bump],
        ];
        let signer_seeds = &[seeds];

        // Burn cTokens from user_source_collateral
        // owner is the pool_config PDA which is already a signer via invoke_signed from privacy-yield
        token::burn(
            CpiContext::new(
                ctx.accounts.collateral_token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.reserve_collateral_mint.to_account_info(),
                    from: ctx.accounts.user_source_collateral.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            collateral_amount,
        )?;

        // Transfer USDC: reserve_liquidity_supply → user_destination_liquidity
        // LMA PDA signs as authority of reserve_liquidity_supply
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.liquidity_token_program.to_account_info(),
                SplTransfer {
                    from: ctx.accounts.reserve_liquidity_supply.to_account_info(),
                    to: ctx.accounts.user_destination_liquidity.to_account_info(),
                    authority: ctx.accounts.lending_market_authority.to_account_info(),
                },
                signer_seeds,
            ),
            collateral_amount,
        )?;

        msg!("Mock klend: burned {} cTokens, transferred {} liquidity", collateral_amount, collateral_amount);
        Ok(())
    }
}

// ==================== Accounts ====================

#[account]
pub struct LendingMarket {
    pub owner: Pubkey,
    pub lma_bump: u8,
}

#[account]
pub struct Reserve {
    pub lending_market: Pubkey,
    pub liquidity_mint: Pubkey,
    pub collateral_mint: Pubkey,
    pub liquidity_supply: Pubkey,
}

// ==================== Instruction Account Structs ====================

#[derive(Accounts)]
pub struct InitLendingMarket<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + std::mem::size_of::<LendingMarket>(),
    )]
    pub lending_market: Account<'info, LendingMarket>,

    /// CHECK: PDA derived from lending_market — just needs to exist for bump derivation
    #[account(
        seeds = [b"lma", lending_market.key().as_ref()],
        bump,
    )]
    pub lending_market_authority: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitReserve<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(has_one = owner)]
    pub lending_market: Account<'info, LendingMarket>,

    /// CHECK: LMA PDA
    #[account(
        seeds = [b"lma", lending_market.key().as_ref()],
        bump = lending_market.lma_bump,
    )]
    pub lending_market_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + std::mem::size_of::<Reserve>(),
    )]
    pub reserve: Account<'info, Reserve>,

    /// The liquidity token mint (e.g. USDC)
    pub liquidity_mint: Account<'info, Mint>,

    /// Reserve liquidity supply — PDA token account
    #[account(
        init,
        payer = owner,
        seeds = [b"reserve_liq_supply", reserve.key().as_ref()],
        bump,
        token::mint = liquidity_mint,
        token::authority = lending_market_authority,
    )]
    pub reserve_liquidity_supply: Account<'info, TokenAccount>,

    /// Fee receiver — PDA token account
    #[account(
        init,
        payer = owner,
        seeds = [b"fee_receiver", reserve.key().as_ref()],
        bump,
        token::mint = liquidity_mint,
        token::authority = lending_market_authority,
    )]
    pub fee_receiver: Account<'info, TokenAccount>,

    /// Reserve collateral mint — PDA mint
    #[account(
        init,
        payer = owner,
        seeds = [b"reserve_coll_mint", reserve.key().as_ref()],
        bump,
        mint::decimals = 6,
        mint::authority = lending_market_authority,
    )]
    pub reserve_collateral_mint: Account<'info, Mint>,

    /// Reserve collateral supply — PDA token account
    #[account(
        init,
        payer = owner,
        seeds = [b"reserve_coll_supply", reserve.key().as_ref()],
        bump,
        token::mint = reserve_collateral_mint,
        token::authority = lending_market_authority,
    )]
    pub reserve_collateral_supply: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Deposit reserve liquidity — account order matches klend_cpi.rs exactly:
///   0. owner (signer, mut)
///   1. reserve (mut)
///   2. lending_market
///   3. lending_market_authority
///   4. reserve_liquidity_mint (mut)
///   5. reserve_liquidity_supply (mut)
///   6. reserve_collateral_mint (mut)
///   7. user_source_liquidity (mut)
///   8. user_destination_collateral (mut)
///   9. collateral_token_program
///  10. liquidity_token_program
///  11. instruction_sysvar_account
#[derive(Accounts)]
pub struct DepositReserveLiquidity<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut)]
    pub reserve: Account<'info, Reserve>,

    #[account(
        constraint = lending_market.key() == reserve.lending_market,
    )]
    pub lending_market: Account<'info, LendingMarket>,

    /// CHECK: LMA PDA
    #[account(
        seeds = [b"lma", lending_market.key().as_ref()],
        bump = lending_market.lma_bump,
    )]
    pub lending_market_authority: UncheckedAccount<'info>,

    /// USDC mint
    #[account(mut)]
    pub reserve_liquidity_mint: Account<'info, Mint>,

    /// Reserve liquidity supply PDA token account
    #[account(
        mut,
        seeds = [b"reserve_liq_supply", reserve.key().as_ref()],
        bump,
    )]
    pub reserve_liquidity_supply: Account<'info, TokenAccount>,

    /// Collateral (cToken) mint
    #[account(
        mut,
        seeds = [b"reserve_coll_mint", reserve.key().as_ref()],
        bump,
    )]
    pub reserve_collateral_mint: Account<'info, Mint>,

    /// User's source USDC account
    #[account(mut)]
    pub user_source_liquidity: Account<'info, TokenAccount>,

    /// User's destination cToken account
    #[account(mut)]
    pub user_destination_collateral: Account<'info, TokenAccount>,

    pub collateral_token_program: Program<'info, Token>,
    pub liquidity_token_program: Program<'info, Token>,

    /// CHECK: Sysvar instructions — not used in mock but required for interface match
    pub instruction_sysvar_account: UncheckedAccount<'info>,
}

/// Redeem reserve collateral — account order matches klend_cpi.rs exactly:
///   0. owner (signer, mut)
///   1. lending_market
///   2. reserve (mut)
///   3. lending_market_authority
///   4. reserve_liquidity_mint (mut)
///   5. reserve_collateral_mint (mut)
///   6. reserve_liquidity_supply (mut)
///   7. user_source_collateral (mut)
///   8. user_destination_liquidity (mut)
///   9. collateral_token_program
///  10. liquidity_token_program
///  11. instruction_sysvar_account
#[derive(Accounts)]
pub struct RedeemReserveCollateral<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        constraint = lending_market.key() == reserve.lending_market,
    )]
    pub lending_market: Account<'info, LendingMarket>,

    #[account(mut)]
    pub reserve: Account<'info, Reserve>,

    /// CHECK: LMA PDA
    #[account(
        seeds = [b"lma", lending_market.key().as_ref()],
        bump = lending_market.lma_bump,
    )]
    pub lending_market_authority: UncheckedAccount<'info>,

    /// USDC mint
    #[account(mut)]
    pub reserve_liquidity_mint: Account<'info, Mint>,

    /// Collateral (cToken) mint
    #[account(
        mut,
        seeds = [b"reserve_coll_mint", reserve.key().as_ref()],
        bump,
    )]
    pub reserve_collateral_mint: Account<'info, Mint>,

    /// Reserve liquidity supply PDA token account
    #[account(
        mut,
        seeds = [b"reserve_liq_supply", reserve.key().as_ref()],
        bump,
    )]
    pub reserve_liquidity_supply: Account<'info, TokenAccount>,

    /// User's source cToken account
    #[account(mut)]
    pub user_source_collateral: Account<'info, TokenAccount>,

    /// User's destination USDC account
    #[account(mut)]
    pub user_destination_liquidity: Account<'info, TokenAccount>,

    pub collateral_token_program: Program<'info, Token>,
    pub liquidity_token_program: Program<'info, Token>,

    /// CHECK: Sysvar instructions — not used in mock but required for interface match
    pub instruction_sysvar_account: UncheckedAccount<'info>,
}
