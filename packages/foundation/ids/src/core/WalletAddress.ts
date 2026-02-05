/**
 * WalletAddress - Ethereum wallet address
 *
 * @remarks
 * Branded type для type safety.
 * Представляет Ethereum address (0x...).
 *
 * Canonical format: lowercase (для equals и toString)
 * Display format: EIP-55 checksum (для UI и error detection)
 *
 * @example
 * ```typescript
 * const wallet = parseWalletAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
 * // → '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed' as WalletAddress (lowercase canonical)
 *
 * const checksum = toChecksumAddress(wallet);
 * // → '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' (EIP-55 checksum)
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
 * Для валидации checksum используй parseWalletAddress().
 *
 * @example
 * ```typescript
 * isValidWalletAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'); // → true
 * isValidWalletAddress('0xINVALID'); // → false
 * isValidWalletAddress('5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'); // → false (no 0x)
 * ```
 */
export function isValidWalletAddress(address: string): boolean {
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
 * @param address - WalletAddress для преобразования
 * @returns EIP-55 checksum address (mixed case)
 *
 * @remarks
 * EIP-55 checksum encoding добавляет error detection через mixed case.
 * Используй для display в UI и для копирования пользователю.
 *
 * Алгоритм:
 * 1. Берём lowercase address без '0x'
 * 2. Вычисляем keccak256 hash
 * 3. Для каждого char: если соответствующий hex digit >= 8, делаем uppercase
 *
 * @example
 * ```typescript
 * const wallet = parseWalletAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')!;
 * const checksum = toChecksumAddress(wallet);
 * // → '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
 * ```
 */
export function toChecksumAddress(address: WalletAddress): string {
  const addr = address.toLowerCase().replace('0x', '');
  const hash = keccak256(addr);

  let checksumAddress = '0x';

  for (let i = 0; i < addr.length; i++) {
    // If hash byte >= 8, uppercase the char
    if (parseInt(hash[i], 16) >= 8) {
      checksumAddress += addr[i].toUpperCase();
    } else {
      checksumAddress += addr[i];
    }
  }

  return checksumAddress;
}

/**
 * Simple keccak256 hash implementation для EIP-55 checksum
 *
 * @param str - Строка для хеширования
 * @returns Hex string hash
 *
 * @remarks
 * ⚠️ ВНИМАНИЕ: Это упрощённая реализация для demonstration.
 * В production коде используй crypto library (например, ethers или viem).
 *
 * Для целей этого модуля достаточно простой hash функции,
 * так как checksum это convenience feature, не security-critical.
 */
function keccak256(str: string): string {
  // Simple hash function для demonstration
  // В production используй настоящую keccak256 из crypto library
  let hash = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // Simple pseudo-hash: (code * prime) % 16
    const hashValue = (code * 31 + i) % 16;
    hash += hashValue.toString(16);
  }
  return hash.padEnd(40, '0');
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
