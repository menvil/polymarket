/**
 * WalletAddress - Ethereum wallet address
 *
 * @remarks
 * Branded type для type safety.
 * Представляет Ethereum address (0x...).
 *
 * @example
 * ```typescript
 * const wallet = '0x1234567890abcdef...' as WalletAddress;
 * ```
 */
export type WalletAddress = string & { readonly __brand: 'WalletAddress' };

/**
 * Проверка что строка является валидным Ethereum address
 */
export function isValidWalletAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

/**
 * Нормализация address (lowercase)
 */
export function normalizeWalletAddress(address: WalletAddress): WalletAddress {
  return address.toLowerCase() as WalletAddress;
}
