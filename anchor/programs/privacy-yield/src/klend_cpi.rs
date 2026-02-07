use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

// sha256("global:deposit_reserve_liquidity")[0..8]
const DEPOSIT_DISCRIMINATOR: [u8; 8] = [169, 201, 30, 126, 6, 205, 102, 68];

// sha256("global:redeem_reserve_collateral")[0..8]
const REDEEM_DISCRIMINATOR: [u8; 8] = [234, 117, 181, 125, 185, 142, 220, 29];

/// CPI into klend's deposit_reserve_liquidity instruction.
///
/// Account order (from klend IDL):
///   0. owner (signer, writable)
///   1. reserve (writable)
///   2. lending_market
///   3. lending_market_authority
///   4. reserve_liquidity_mint (writable)
///   5. reserve_liquidity_supply (writable)
///   6. reserve_collateral_mint (writable)
///   7. user_source_liquidity (writable)
///   8. user_destination_collateral (writable)
///   9. collateral_token_program
///  10. liquidity_token_program
///  11. instruction_sysvar_account
pub fn deposit_reserve_liquidity<'info>(
    klend_program: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    reserve: &AccountInfo<'info>,
    lending_market: &AccountInfo<'info>,
    lending_market_authority: &AccountInfo<'info>,
    reserve_liquidity_mint: &AccountInfo<'info>,
    reserve_liquidity_supply: &AccountInfo<'info>,
    reserve_collateral_mint: &AccountInfo<'info>,
    user_source_liquidity: &AccountInfo<'info>,
    user_destination_collateral: &AccountInfo<'info>,
    collateral_token_program: &AccountInfo<'info>,
    liquidity_token_program: &AccountInfo<'info>,
    instruction_sysvar: &AccountInfo<'info>,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&DEPOSIT_DISCRIMINATOR);
    data.extend_from_slice(&amount.to_le_bytes());

    let accounts = vec![
        AccountMeta::new(*owner.key, true),
        AccountMeta::new(*reserve.key, false),
        AccountMeta::new_readonly(*lending_market.key, false),
        AccountMeta::new_readonly(*lending_market_authority.key, false),
        AccountMeta::new(*reserve_liquidity_mint.key, false),
        AccountMeta::new(*reserve_liquidity_supply.key, false),
        AccountMeta::new(*reserve_collateral_mint.key, false),
        AccountMeta::new(*user_source_liquidity.key, false),
        AccountMeta::new(*user_destination_collateral.key, false),
        AccountMeta::new_readonly(*collateral_token_program.key, false),
        AccountMeta::new_readonly(*liquidity_token_program.key, false),
        AccountMeta::new_readonly(*instruction_sysvar.key, false),
    ];

    let ix = Instruction {
        program_id: *klend_program.key,
        accounts,
        data,
    };

    let account_infos = &[
        owner.clone(),
        reserve.clone(),
        lending_market.clone(),
        lending_market_authority.clone(),
        reserve_liquidity_mint.clone(),
        reserve_liquidity_supply.clone(),
        reserve_collateral_mint.clone(),
        user_source_liquidity.clone(),
        user_destination_collateral.clone(),
        collateral_token_program.clone(),
        liquidity_token_program.clone(),
        instruction_sysvar.clone(),
        klend_program.clone(),
    ];

    invoke_signed(&ix, account_infos, signer_seeds)?;
    Ok(())
}

/// CPI into klend's redeem_reserve_collateral instruction.
///
/// Account order (from klend IDL):
///   0. owner (signer, writable)
///   1. lending_market
///   2. reserve (writable)
///   3. lending_market_authority
///   4. reserve_liquidity_mint (writable)
///   5. reserve_collateral_mint (writable)
///   6. reserve_liquidity_supply (writable)
///   7. user_source_collateral (writable)
///   8. user_destination_liquidity (writable)
///   9. collateral_token_program
///  10. liquidity_token_program
///  11. instruction_sysvar_account
pub fn redeem_reserve_collateral<'info>(
    klend_program: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    lending_market: &AccountInfo<'info>,
    reserve: &AccountInfo<'info>,
    lending_market_authority: &AccountInfo<'info>,
    reserve_liquidity_mint: &AccountInfo<'info>,
    reserve_collateral_mint: &AccountInfo<'info>,
    reserve_liquidity_supply: &AccountInfo<'info>,
    user_source_collateral: &AccountInfo<'info>,
    user_destination_liquidity: &AccountInfo<'info>,
    collateral_token_program: &AccountInfo<'info>,
    liquidity_token_program: &AccountInfo<'info>,
    instruction_sysvar: &AccountInfo<'info>,
    collateral_amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&REDEEM_DISCRIMINATOR);
    data.extend_from_slice(&collateral_amount.to_le_bytes());

    let accounts = vec![
        AccountMeta::new(*owner.key, true),
        AccountMeta::new_readonly(*lending_market.key, false),
        AccountMeta::new(*reserve.key, false),
        AccountMeta::new_readonly(*lending_market_authority.key, false),
        AccountMeta::new(*reserve_liquidity_mint.key, false),
        AccountMeta::new(*reserve_collateral_mint.key, false),
        AccountMeta::new(*reserve_liquidity_supply.key, false),
        AccountMeta::new(*user_source_collateral.key, false),
        AccountMeta::new(*user_destination_liquidity.key, false),
        AccountMeta::new_readonly(*collateral_token_program.key, false),
        AccountMeta::new_readonly(*liquidity_token_program.key, false),
        AccountMeta::new_readonly(*instruction_sysvar.key, false),
    ];

    let ix = Instruction {
        program_id: *klend_program.key,
        accounts,
        data,
    };

    let account_infos = &[
        owner.clone(),
        lending_market.clone(),
        reserve.clone(),
        lending_market_authority.clone(),
        reserve_liquidity_mint.clone(),
        reserve_collateral_mint.clone(),
        reserve_liquidity_supply.clone(),
        user_source_collateral.clone(),
        user_destination_liquidity.clone(),
        collateral_token_program.clone(),
        liquidity_token_program.clone(),
        instruction_sysvar.clone(),
        klend_program.clone(),
    ];

    invoke_signed(&ix, account_infos, signer_seeds)?;
    Ok(())
}
