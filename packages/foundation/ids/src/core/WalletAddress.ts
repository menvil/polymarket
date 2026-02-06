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
 * Проверка что строка является валидным Ethereum address
 *
 * @param address - Строка для проверки
 * @returns true если address имеет валидный формат (0x + 40 hex chars)
 *
 * @remarks
 * Проверяет только формат, НЕ проверяет EIP-55 checksum.
 * Для валидации и нормализации используй parseWalletAddress().
 *
 * Type guard позволяет TypeScript сузить тип до WalletAddress,
 * но помни что WalletAddress должен быть lowercase canonical format.
 *
 * @example
 * ```typescript
 * isValidWalletAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'); // → true
 * isValidWalletAddress('0xINVALID'); // → false
 * isValidWalletAddress('5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'); // → false (no 0x)
 * ```
 */
export function isValidWalletAddress(address: string): address is WalletAddress {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

/**
 * Нормализация address (lowercase)
 *
 * @param address - WalletAddress для нормализации
 * @returns Lowercase WalletAddress
 *
 * @deprecated Используй parseWalletAddress() для валидации и нормализации,
 *             или walletAddressToString() для canonical format.
 *             Эта функция оставлена для backward compatibility.
 *
 * @example
 * ```typescript
 * const normalized = normalizeWalletAddress('0xABC...' as WalletAddress);
 * // → '0xabc...' as WalletAddress
 * ```
 */
export function normalizeWalletAddress(address: WalletAddress): WalletAddress {
  return address.toLowerCase() as WalletAddress;
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
  if (!isValidWalletAddress(address)) {
    return undefined;
  }

  // Return lowercase canonical format
  return address.toLowerCase() as WalletAddress;
}

/**
 * Преобразовать WalletAddress в EIP-55 checksum format
 *
 * @deprecated Требует реальной keccak256 реализации.
 * Используй `getAddress()` из viem или ethers напрямую:
 *
 * ```typescript
 * import { getAddress } from 'viem';
 * const checksum = getAddress(wallet);
 * ```
 *
 * или
 *
 * ```typescript
 * import { getAddress } from 'ethers';
 * const checksum = getAddress(wallet);
 * ```
 *
 * @param _address - WalletAddress (не используется)
 * @returns Никогда не возвращает (throws)
 * @throws Error - всегда, так как требуется реальная keccak256 реализация
 *
 * @remarks
 * Предыдущая реализация использовала fake keccak256, который генерировал
 * НЕВАЛИДНЫЕ EIP-55 checksums. Это опасно - кошельки и эксплореры отвергают
 * такие адреса.
 *
 * Для корректного EIP-55 checksum нужна настоящая keccak256 реализация
 * из crypto библиотеки. Так как @polymarket/ids стремится к zero dependencies,
 * эта функция deprecated. Используй viem.getAddress() или ethers.getAddress().
 *
 * @example
 * ```typescript
 * // ❌ Не работает (throws)
 * const checksum = toChecksumAddress(wallet);
 *
 * // ✅ Используй вместо этого:
 * import { getAddress } from 'viem';
 * const wallet = parseWalletAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')!;
 * const checksum = getAddress(wallet);
 * // → '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
 * ```
 */
export function toChecksumAddress(_address: WalletAddress): string {
  throw new Error(
    'toChecksumAddress() requires a real keccak256 implementation. ' +
      'Use viem.getAddress() or ethers.getAddress() directly for EIP-55 checksum formatting.'
  );
}

/**
 * Case-insensitive сравнение WalletAddress
 *
 * @param a - Первый WalletAddress
 * @param b - Второй WalletAddress
 * @returns true если addresses идентичны (ignoring case)
 *
 * @remarks
 * Выполняет case-insensitive сравнение, так как Ethereum addresses
 * не зависят от регистра (checksum это только error detection).
 *
 * @example
 * ```typescript
 * const addr1 = parseWalletAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')!;
 * const addr2 = parseWalletAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')!;
 *
 * walletAddressEquals(addr1, addr2); // → true (same address, different case)
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
 * Для display в UI используй toChecksumAddress().
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
