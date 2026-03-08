/**
 * WalletAddress - Ethereum wallet address
 *
 * @remarks
 * Branded type для type safety.
 * Представляет Ethereum address (0x...).
 *
 * **Canonical format**: lowercase (для equals и toString)
 * **Display format**: EIP-55 checksum (используй viem.getAddress() или ethers.getAddress())
 *
 * @example
 * ```typescript
 * // Парсинг и валидация
 * const wallet = parseWalletAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
 * // → '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed' as WalletAddress (lowercase canonical)
 *
 * // Для EIP-55 checksum используй viem или ethers:
 * import { getAddress } from 'viem';
 * const checksum = getAddress(wallet);
 * // → '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
 * ```
 */
export type WalletAddress = string & { readonly __brand: 'WalletAddress' };

/**
 * Проверка формата Ethereum address (lowercase canonical)
 *
 * @param address - Строка для проверки
 * @returns true если address имеет валидный lowercase canonical формат (0x + 40 lowercase hex chars)
 *
 * @remarks
 * Проверяет только формат, НЕ проверяет EIP-55 checksum.
 * Принимает ТОЛЬКО lowercase hex — смешанный регистр возвращает false.
 * Для нормализации mixed-case (например EIP-55 checksum) используй parseWalletAddress(),
 * которая принимает любой регистр и возвращает WalletAddress в canonical lowercase.
 *
 * @example
 * ```typescript
 * isValidWalletAddressFormat('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'); // → true
 * isValidWalletAddressFormat('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'); // → false (mixed-case)
 * isValidWalletAddressFormat('0xINVALID'); // → false
 * isValidWalletAddressFormat('5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'); // → false (no 0x)
 * ```
 */
export function isValidWalletAddressFormat(address: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(address);
}

/**
 * Парсинг и валидация Ethereum address
 *
 * @param address - Строка address для парсинга
 * @returns WalletAddress (lowercase canonical format) или undefined если невалидный
 *
 * @remarks
 * Выполняет:
 * 1. Проверку формата (0x + 40 hex chars)
 * 2. Возвращает lowercase canonical format
 *
 * Используй эту функцию для валидации user input.
 *
 * @example
 * ```typescript
 * const userInput = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
 *
 * const wallet = parseWalletAddress(userInput);
 * if (wallet) {
 *   // TypeScript знает: wallet is WalletAddress
 *   console.log(wallet); // → '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'
 * } else {
 *   throw new Error('Invalid wallet address');
 * }
 * ```
 */
export function parseWalletAddress(address: string): WalletAddress | undefined {
  // Защита от non-string runtime-ввода через as any
  if (typeof address !== 'string') {
    return undefined;
  }

  // Нормализуем до lowercase перед валидацией: isValidWalletAddressFormat принимает только lowercase
  const lower = address.toLowerCase();
  if (!isValidWalletAddressFormat(lower)) {
    return undefined;
  }
  return lower as WalletAddress;
}

/**
 * Сравнение WalletAddress на равенство
 *
 * @param a - Первый WalletAddress
 * @param b - Второй WalletAddress
 * @returns true если addresses идентичны
 *
 * @remarks
 * WalletAddress гарантированно хранится в canonical lowercase формате
 * (parseWalletAddress всегда нормализует через toLowerCase).
 * Поэтому достаточно строгого равенства без дополнительной нормализации.
 *
 * ВАЖНО: Всегда создавайте WalletAddress через parseWalletAddress(),
 * а не через type assertion. Type assertion обходит нормализацию и может
 * привести к некорректному сравнению.
 *
 * @example
 * ```typescript
 * const addr1 = parseWalletAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')!;
 * const addr2 = parseWalletAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')!;
 *
 * walletAddressEquals(addr1, addr2); // → true (both normalized to lowercase by parseWalletAddress)
 * ```
 */
export function walletAddressEquals(a: WalletAddress, b: WalletAddress): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Преобразовать WalletAddress в canonical string format
 *
 * @param address - WalletAddress для преобразования
 * @returns Lowercase canonical string
 *
 * @remarks
 * Возвращает lowercase canonical format для:
 * - Serialization в database
 * - Comparison и hashing
 * - Logging
 *
 * Для display в UI используй checksum format: viem getAddress() или ethers getAddress().
 *
 * @example
 * ```typescript
 * const wallet = parseWalletAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')!;
 * walletAddressToString(wallet);
 * // → '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'
 * ```
 */
export function walletAddressToString(address: WalletAddress): string {
  return address.toLowerCase();
}
