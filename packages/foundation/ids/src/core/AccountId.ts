import type { WalletAddress } from './WalletAddress.js';

/**
 * AccountId - идентификатор аккаунта (кошелёк или venue account)
 *
 * @remarks
 * Может быть:
 * - Wallet address (0x...)
 * - Venue account ID (user_123)
 * - Subaccount (wallet/strategy)
 *
 * Используется для идентификации "кому принадлежит" баланс/позиция.
 *
 * @example
 * ```typescript
 * // Wallet address как account
 * const walletAccount = '0x1234...' as AccountId;
 *
 * // Venue account ID
 * const venueAccount = 'polymarket_user_123' as AccountId;
 *
 * // Subaccount
 * const subaccount = '0x1234.../main_strategy' as AccountId;
 * ```
 */
export type AccountId = string & { readonly __brand: 'AccountId' };

/**
 * Создать AccountId из wallet address
 */
export function accountIdFromWallet(wallet: WalletAddress): AccountId {
  return wallet as unknown as AccountId;
}

/**
 * Создать AccountId для venue account
 */
export function accountIdFromVenue(venueId: string, userId: string): AccountId {
  return `${venueId}_${userId}` as AccountId;
}

/**
 * Создать AccountId для subaccount
 */
export function accountIdForSubaccount(
  baseAccount: AccountId,
  subaccountName: string
): AccountId {
  return `${baseAccount}/${subaccountName}` as AccountId;
}
