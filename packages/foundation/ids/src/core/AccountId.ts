import type { WalletAddress } from './WalletAddress.js';
import type { VenueId } from './VenueId.js';

/**
 * AccountId - универсальный идентификатор аккаунта
 *
 * @remarks
 * Discriminated union для type-safe работы с различными типами аккаунтов:
 *
 * **WALLET**: Wallet address как аккаунт
 * - Используется для on-chain балансов
 * - Содержит WalletAddress
 *
 * **VENUE**: Account на конкретном venue (биржа/платформа)
 * - Используется для off-chain балансов
 * - Содержит venueId и userId
 *
 * **SUBACCOUNT**: Subaccount внутри другого аккаунта
 * - Используется для разделения балансов/стратегий
 * - Содержит base account и имя subaccount
 *
 * Архитектурное решение: tagged union вместо string concatenation
 * для избежания коллизий и обеспечения type safety.
 *
 * @example
 * ```typescript
 * // Wallet account
 * const walletAcc: AccountId = {
 *   kind: 'WALLET',
 *   address: parseWalletAddress('0x1234...')!
 * };
 *
 * // Venue account
 * const venueAcc: AccountId = {
 *   kind: 'VENUE',
 *   venueId: KnownVenues.POLYMARKET,
 *   userId: 'user_123'
 * };
 *
 * // Subaccount
 * const subAcc: AccountId = {
 *   kind: 'SUBACCOUNT',
 *   base: walletAcc,
 *   name: 'trading'
 * };
 *
 * // Type-safe pattern matching
 * if (acc.kind === 'WALLET') {
 *   // TypeScript знает: acc.address is WalletAddress
 *   console.log(acc.address);
 * }
 * ```
 */
export type AccountId =
  | {
      readonly kind: 'WALLET';
      readonly address: WalletAddress;
    }
  | {
      readonly kind: 'VENUE';
      readonly venueId: VenueId;
      readonly userId: string;
    }
  | {
      readonly kind: 'SUBACCOUNT';
      readonly base: AccountId;
      readonly name: string;
    };

/**
 * Создать AccountId из wallet address
 *
 * @param address - WalletAddress для аккаунта
 * @returns AccountId типа WALLET
 *
 * @example
 * ```typescript
 * const wallet = parseWalletAddress('0x1234...')!;
 * const accountId = accountIdFromWallet(wallet);
 *
 * console.log(accountIdToString(accountId));
 * // → 'wallet:0x1234...'
 * ```
 */
export function accountIdFromWallet(address: WalletAddress): AccountId {
  return {
    kind: 'WALLET',
    address,
  };
}

/**
 * Создать AccountId для venue account
 *
 * @param venueId - ID venue (биржа/платформа)
 * @param userId - User ID на этом venue
 * @returns AccountId типа VENUE
 *
 * @remarks
 * Используется для идентификации аккаунтов на centralized venues
 * (POLYMARKET, KALSHI, etc).
 *
 * @example
 * ```typescript
 * const accountId = accountIdFromVenue(KnownVenues.POLYMARKET, 'user_123');
 *
 * console.log(accountIdToString(accountId));
 * // → 'venue:POLYMARKET:user_123'
 * ```
 */
export function accountIdFromVenue(venueId: VenueId, userId: string): AccountId {
  return {
    kind: 'VENUE',
    venueId,
    userId,
  };
}

/**
 * Создать AccountId для subaccount
 *
 * @param base - Base account (может быть любого типа)
 * @param name - Имя subaccount
 * @returns AccountId типа SUBACCOUNT
 *
 * @remarks
 * Subaccounts используются для разделения балансов внутри одного base account.
 * Например: 'main_strategy', 'arbitrage', 'hedging', etc.
 *
 * Может быть вложенным: subaccount может иметь свои subaccounts.
 *
 * @example
 * ```typescript
 * const wallet = accountIdFromWallet(parseWalletAddress('0x1234...')!);
 * const subaccount = accountIdForSubaccount(wallet, 'trading');
 *
 * console.log(accountIdToString(subaccount));
 * // → 'sub:wallet:0x1234...:trading'
 * ```
 */
export function accountIdForSubaccount(base: AccountId, name: string): AccountId {
  return {
    kind: 'SUBACCOUNT',
    base,
    name,
  };
}

/**
 * Преобразовать AccountId в строку для serialization
 *
 * @param id - AccountId для преобразования
 * @returns Строковое представление
 *
 * @remarks
 * Canonical format с escaping для безопасного парсинга:
 *
 * - WALLET: `wallet:0x1234...`
 * - VENUE: `venue:POLYMARKET:user_123`
 * - SUBACCOUNT: `sub:wallet:0x1234...:trading`
 *
 * Escaping: ':' в userId/name заменяется на '\:'
 *
 * @example
 * ```typescript
 * const walletAcc = accountIdFromWallet(parseWalletAddress('0x1234...')!);
 * accountIdToString(walletAcc);
 * // → 'wallet:0x1234...'
 *
 * const venueAcc = accountIdFromVenue(KnownVenues.POLYMARKET, 'user:123');
 * accountIdToString(venueAcc);
 * // → 'venue:POLYMARKET:user\:123' (escaped colon)
 * ```
 */
export function accountIdToString(id: AccountId): string {
  if (id.kind === 'WALLET') {
    return `wallet:${id.address}`;
  }

  if (id.kind === 'VENUE') {
    const escapedUserId = escapeColon(id.userId);
    return `venue:${id.venueId}:${escapedUserId}`;
  }

  // SUBACCOUNT
  const baseStr = accountIdToString(id.base);
  const escapedName = escapeColon(id.name);
  return `sub:${baseStr}:${escapedName}`;
}

/**
 * Парсинг AccountId из строки
 *
 * @param str - Строка в формате accountIdToString()
 * @returns AccountId или undefined если формат неверный
 *
 * @remarks
 * Обратная функция для accountIdToString().
 * Гарантирует round-trip: parseAccountId(accountIdToString(id)) === id
 *
 * Поддерживаемые форматы:
 * - 'wallet:0x1234...'
 * - 'venue:POLYMARKET:user_123'
 * - 'sub:wallet:0x1234...:trading'
 *
 * @example
 * ```typescript
 * const wallet = parseAccountId('wallet:0x1234...');
 * // → { kind: 'WALLET', address: '0x1234...' }
 *
 * const venue = parseAccountId('venue:POLYMARKET:user_123');
 * // → { kind: 'VENUE', venueId: 'POLYMARKET', userId: 'user_123' }
 *
 * const invalid = parseAccountId('INVALID:FORMAT');
 * // → undefined
 * ```
 */
export function parseAccountId(str: string): AccountId | undefined {
  const parts = splitWithEscape(str, ':');

  if (parts.length < 2) {
    return undefined;
  }

  const kind = parts[0];

  if (kind === 'wallet') {
    if (parts.length !== 2) {
      return undefined;
    }

    const address = parts[1] as WalletAddress;
    return {
      kind: 'WALLET',
      address,
    };
  }

  if (kind === 'venue') {
    if (parts.length !== 3) {
      return undefined;
    }

    const venueId = parts[1] as VenueId;
    const userId = unescapeColon(parts[2]);
    return {
      kind: 'VENUE',
      venueId,
      userId,
    };
  }

  if (kind === 'sub') {
    if (parts.length < 3) {
      return undefined;
    }

    // Extract subaccount name (last part)
    const name = unescapeColon(parts[parts.length - 1]);

    // Reconstruct base account string (everything except 'sub' and name)
    const baseParts = parts.slice(1, -1);
    const baseStr = baseParts.join(':');

    const base = parseAccountId(baseStr);
    if (!base) {
      return undefined;
    }

    return {
      kind: 'SUBACCOUNT',
      base,
      name,
    };
  }

  return undefined;
}

/**
 * Сравнение двух AccountId на равенство
 *
 * @param a - Первый AccountId
 * @param b - Второй AccountId
 * @returns true если AccountId идентичны
 *
 * @remarks
 * Deep comparison для всех типов аккаунтов.
 * Для WALLET использует case-insensitive сравнение addresses.
 * Для SUBACCOUNT рекурсивно сравнивает base accounts.
 *
 * @example
 * ```typescript
 * const acc1 = accountIdFromWallet(parseWalletAddress('0xABC...')!);
 * const acc2 = accountIdFromWallet(parseWalletAddress('0xabc...')!);
 *
 * accountIdEquals(acc1, acc2); // → true (case-insensitive)
 * ```
 */
export function accountIdEquals(a: AccountId, b: AccountId): boolean {
  if (a.kind !== b.kind) {
    return false;
  }

  if (a.kind === 'WALLET' && b.kind === 'WALLET') {
    return a.address.toLowerCase() === b.address.toLowerCase();
  }

  if (a.kind === 'VENUE' && b.kind === 'VENUE') {
    return a.venueId === b.venueId && a.userId === b.userId;
  }

  if (a.kind === 'SUBACCOUNT' && b.kind === 'SUBACCOUNT') {
    return accountIdEquals(a.base, b.base) && a.name === b.name;
  }

  return false;
}

/**
 * Type guard для WALLET account
 *
 * @param id - AccountId для проверки
 * @returns true если id является WALLET account
 *
 * @example
 * ```typescript
 * if (isWalletAccount(accountId)) {
 *   // TypeScript знает: accountId.address is WalletAddress
 *   console.log(accountId.address);
 * }
 * ```
 */
export function isWalletAccount(
  id: AccountId
): id is Extract<AccountId, { kind: 'WALLET' }> {
  return id.kind === 'WALLET';
}

/**
 * Type guard для VENUE account
 *
 * @param id - AccountId для проверки
 * @returns true если id является VENUE account
 *
 * @example
 * ```typescript
 * if (isVenueAccount(accountId)) {
 *   // TypeScript знает: accountId имеет venueId и userId
 *   console.log(accountId.venueId, accountId.userId);
 * }
 * ```
 */
export function isVenueAccount(id: AccountId): id is Extract<AccountId, { kind: 'VENUE' }> {
  return id.kind === 'VENUE';
}

/**
 * Type guard для SUBACCOUNT
 *
 * @param id - AccountId для проверки
 * @returns true если id является SUBACCOUNT
 *
 * @example
 * ```typescript
 * if (isSubaccount(accountId)) {
 *   // TypeScript знает: accountId имеет base и name
 *   console.log(accountId.base, accountId.name);
 * }
 * ```
 */
export function isSubaccount(id: AccountId): id is Extract<AccountId, { kind: 'SUBACCOUNT' }> {
  return id.kind === 'SUBACCOUNT';
}

/**
 * Helper: escape colons в строке
 */
function escapeColon(str: string): string {
  return str.replace(/:/g, '\\:');
}

/**
 * Helper: unescape colons в строке
 */
function unescapeColon(str: string): string {
  return str.replace(/\\:/g, ':');
}

/**
 * Helper: split string с учётом escaped separators
 */
function splitWithEscape(str: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let escaped = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      current += char;
      continue;
    }

    if (char === separator) {
      parts.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  parts.push(current);
  return parts;
}
