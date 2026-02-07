import type { WalletAddress } from './WalletAddress.js';
import { parseWalletAddress } from './WalletAddress.js';
import type { VenueId } from './VenueId.js';
import { asVenueId } from './VenueId.js';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';

/**
 * @todo реализовать поддержку Decimal
 */

/**
 * Ошибка при превышении depth limit для SUBACCOUNT
 *
 * @remarks
 * Выбрасывается при попытке создать или сериализовать AccountId
 * с глубиной вложенности превышающей MAX_SUBACCOUNT_DEPTH.
 */
export class AccountIdDepthError extends Error {
  constructor(
    public readonly currentDepth: number,
    public readonly maxDepth: number,
    public readonly operation: 'create' | 'serialize'
  ) {
    super(
      `Subaccount depth limit exceeded during ${operation}: current=${currentDepth}, max=${maxDepth}`
    );
    this.name = 'AccountIdDepthError';
  }
}

/**
 * Максимальная глубина вложенности SUBACCOUNT
 *
 * @remarks
 * Защита от stack overflow при рекурсивной обработке.
 * Ограничивает цепочки типа: sub:sub:sub:...
 */
const MAX_SUBACCOUNT_DEPTH = 5;

/**
 * Максимальная длина serialized AccountId строки
 *
 * @remarks
 * Защита от DoS атак с аномально длинными строками.
 * Проверяется при парсинге перед началом обработки.
 */
const MAX_ACCOUNT_ID_STRING_LENGTH = 512;

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
 * Опции для парсинга AccountId
 *
 * @remarks
 * Позволяет кастомизировать валидацию и ограничения при парсинге.
 */
export interface ParseAccountIdOptions {
  /**
   * Максимальная глубина вложенности SUBACCOUNT
   *
   * @default MAX_SUBACCOUNT_DEPTH (5)
   */
  maxDepth?: number;

  /**
   * Максимальная длина входной строки
   *
   * @default MAX_ACCOUNT_ID_STRING_LENGTH (512)
   */
  maxLen?: number;

  /**
   * Функция валидации WalletAddress
   *
   * @remarks
   * Если передана — используется для проверки формата wallet address.
   * При невалидном адресе должна вернуть undefined.
   *
   * Если не передана — используется дефолтная валидация через parseWalletAddress():
   * - Проверяет формат 0x + 40 hex символов
   * - Возвращает lowercase canonical format
   *
   * @param raw - Строка с потенциальным wallet address
   * @returns WalletAddress или undefined если формат неверный
   *
   * @example
   * ```typescript
   * // Дефолтная валидация (parseWalletAddress)
   * parseAccountId('wallet:0xINVALID'); // → undefined
   * parseAccountId('wallet:0x1234567890123456789012345678901234567890'); // → AccountId
   *
   * // Кастомная валидация
   * parseAccountId('wallet:0xINVALID', {
   *   validateWalletAddress: (raw) => {
   *     return /^0x[0-9a-f]{40}$/i.test(raw) ? raw as WalletAddress : undefined;
   *   }
   * }); // → undefined
   * ```
   */
  validateWalletAddress?: (raw: string) => WalletAddress | undefined;
}

/**
 * Вычислить глубину вложенности SUBACCOUNT
 *
 * @param id - AccountId для проверки
 * @returns Глубина вложенности (0 для WALLET/VENUE, ≥1 для SUBACCOUNT)
 *
 * @remarks
 * Итеративная реализация (не рекурсивная) для безопасности.
 * Используется для проверки depth limit перед рекурсивными операциями.
 *
 * @example
 * ```typescript
 * const wallet = accountIdFromWallet(parseWalletAddress('0x1234...')!);
 * getSubaccountDepth(wallet); // → 0
 *
 * const sub1 = accountIdForSubaccount(wallet, 'level1');
 * getSubaccountDepth(sub1); // → 1
 *
 * const sub2 = accountIdForSubaccount(sub1, 'level2');
 * getSubaccountDepth(sub2); // → 2
 * ```
 */
export function getSubaccountDepth(id: AccountId): number {
  let depth = 0;
  let current = id;

  while (current.kind === 'SUBACCOUNT') {
    depth++;
    current = current.base;
  }

  return depth;
}

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
 * @returns Result с AccountId типа SUBACCOUNT или ошибкой при превышении depth limit
 *
 * @remarks
 * Subaccounts используются для разделения балансов внутри одного base account.
 * Например: 'main_strategy', 'arbitrage', 'hedging', etc.
 *
 * Может быть вложенным: subaccount может иметь свои subaccounts.
 * Максимальная глубина вложенности ограничена для защиты от stack overflow.
 *
 * Использует Result pattern вместо exceptions для явной обработки ошибок.
 *
 * @example
 * ```typescript
 * const wallet = accountIdFromWallet(parseWalletAddress('0x1234...')!);
 * const result = accountIdForSubaccount(wallet, 'trading');
 *
 * if (result.ok) {
 *   console.log(accountIdToString(result.value));
 *   // → Ok('sub:wallet:0x1234...:trading')
 * } else {
 *   console.error('Error:', result.error.message);
 * }
 *
 * // Ошибка при превышении лимита:
 * const deepResult = accountIdForSubaccount(deeplyNested, 'tooDeep');
 * // → Err(AccountIdDepthError)
 * ```
 */
export function accountIdForSubaccount(
  base: AccountId,
  name: string
): Result<AccountId, AccountIdDepthError> {
  const currentDepth = getSubaccountDepth(base);

  if (currentDepth >= MAX_SUBACCOUNT_DEPTH) {
    return Err(
      new AccountIdDepthError(currentDepth, MAX_SUBACCOUNT_DEPTH, 'create')
    );
  }

  return Ok({
    kind: 'SUBACCOUNT',
    base,
    name,
  });
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
 * Escaping: '\' и ':' в userId/name экранируются ('\\' и '\:')
 *
 * Тотальная функция: всегда возвращает string, никогда не падает.
 * Инвариант depth <= MAX_SUBACCOUNT_DEPTH гарантируется фабрикой accountIdForSubaccount.
 * Bounded loop с safety margin как страховка (dev-only assertion при превышении).
 *
 * @example
 * ```typescript
 * const walletAcc = accountIdFromWallet(parseWalletAddress('0x1234...')!);
 * const str = accountIdToString(walletAcc);
 * console.log(str); // → 'wallet:0x1234...'
 *
 * const venueAcc = accountIdFromVenue(KnownVenues.POLYMARKET, 'user:123');
 * accountIdToString(venueAcc);
 * // → 'venue:POLYMARKET:user\\:123' (escaped colon)
 *
 * const specialChars = accountIdFromVenue(KnownVenues.POLYMARKET, 'user\\:test');
 * accountIdToString(specialChars);
 * // → 'venue:POLYMARKET:user\\\\\\:test' (escaped backslash and colon)
 * ```
 */
export function accountIdToString(id: AccountId): string {
  return accountIdToStringImpl(id, 0);
}

/**
 * Internal implementation с depth tracking
 *
 * @param id - AccountId для преобразования
 * @param depth - Текущая глубина рекурсии
 * @returns Строковое представление
 *
 * @remarks
 * Рекурсивная реализация с отслеживанием глубины.
 * При каждом вызове для SUBACCOUNT инкрементирует depth.
 * Bounded loop с safety margin (MAX_SUBACCOUNT_DEPTH + 10).
 * Если инвариант нарушен (depth > limit) — dev-only assertion, возвращает fallback string.
 */
function accountIdToStringImpl(id: AccountId, depth: number): string {
  // Bounded loop защита с safety margin
  const SAFETY_MARGIN = 10;
  if (depth > MAX_SUBACCOUNT_DEPTH + SAFETY_MARGIN) {
    // Dev-only assertion: не должно случиться если фабрика держит инвариант
    if (process.env.NODE_ENV !== 'production') {
      console.assert(
        false,
        `Unexpected depth ${depth} > ${MAX_SUBACCOUNT_DEPTH} in accountIdToString. This indicates a bug in accountIdForSubaccount.`
      );
    }
    // Fallback для production: возвращаем placeholder вместо crash
    return '[INVALID:DEPTH_EXCEEDED]';
  }

  if (id.kind === 'WALLET') {
    return `wallet:${id.address}`;
  }

  if (id.kind === 'VENUE') {
    const escapedUserId = escape(id.userId);
    return `venue:${id.venueId}:${escapedUserId}`;
  }

  // SUBACCOUNT
  const baseStr = accountIdToStringImpl(id.base, depth + 1);
  const escapedName = escape(id.name);
  return `sub:${baseStr}:${escapedName}`;
}

/**
 * Парсинг AccountId из строки
 *
 * @param str - Строка в формате accountIdToString()
 * @param options - Опции парсинга (валидация, лимиты)
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
 * Защита от DoS:
 * - Проверка длины строки (maxLen)
 * - Проверка глубины вложенности (maxDepth)
 * - Опциональная валидация WalletAddress
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
 *
 * // С валидацией:
 * const validated = parseAccountId('wallet:INVALID', {
 *   validateWalletAddress: (raw) => /^0x[0-9a-f]{40}$/i.test(raw)
 *     ? raw as WalletAddress
 *     : undefined
 * });
 * // → undefined (невалидный адрес)
 * ```
 */
export function parseAccountId(
  str: string,
  options?: ParseAccountIdOptions
): AccountId | undefined {
  const maxLen = options?.maxLen ?? MAX_ACCOUNT_ID_STRING_LENGTH;
  const maxDepth = options?.maxDepth ?? MAX_SUBACCOUNT_DEPTH;

  // Проверка длины строки
  if (str.length > maxLen) {
    return undefined;
  }

  return parseAccountIdImpl(str, 0, maxDepth, options);
}

/**
 * Internal implementation с depth tracking
 *
 * @param str - Строка для парсинга
 * @param depth - Текущая глубина рекурсии
 * @param maxDepth - Максимально допустимая глубина
 * @param options - Опции парсинга (валидация, лимиты)
 * @returns AccountId или undefined если формат неверный или превышен depth limit
 *
 * @remarks
 * Рекурсивная реализация с отслеживанием глубины.
 * При каждом рекурсивном вызове для SUBACCOUNT инкрементирует depth.
 * Проверка depth > maxDepth предотвращает stack overflow при парсинге
 * злонамеренно вложенных структур.
 *
 * Возвращает undefined (graceful rejection) вместо throw для внешнего ввода.
 */
function parseAccountIdImpl(
  str: string,
  depth: number,
  maxDepth: number,
  options?: ParseAccountIdOptions
): AccountId | undefined {
  if (depth > maxDepth) {
    return undefined;
  }

  const parts = splitEscaped(str);

  if (parts.length < 2) {
    return undefined;
  }

  const kind = parts[0];

  if (kind === 'wallet') {
    if (parts.length !== 2) {
      return undefined;
    }

    const rawAddress = parts[1];

    // Используем дефолтную валидацию или кастомную из options
    const validate = options?.validateWalletAddress ?? parseWalletAddress;
    const validatedAddress = validate(rawAddress);

    if (!validatedAddress) {
      return undefined;
    }

    return {
      kind: 'WALLET',
      address: validatedAddress,
    };
  }

  if (kind === 'venue') {
    if (parts.length !== 3) {
      return undefined;
    }

    // Валидация VenueId через asVenueId
    const venueId = asVenueId(parts[1]);
    if (!venueId) {
      return undefined;
    }

    const userId = unescape(parts[2]);
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
    const name = unescape(parts[parts.length - 1]);

    // Reconstruct base account string (everything except 'sub' and name)
    const baseParts = parts.slice(1, -1);
    const baseStr = baseParts.join(':');

    const base = parseAccountIdImpl(baseStr, depth + 1, maxDepth, options);
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
 * @returns true если AccountId идентичны, false если разные или превышен depth limit
 *
 * @remarks
 * Deep comparison для всех типов аккаунтов.
 * Для WALLET использует case-insensitive сравнение addresses.
 * Для SUBACCOUNT рекурсивно сравнивает base accounts.
 *
 * При превышении MAX_SUBACCOUNT_DEPTH возвращает false (безопасный fallback).
 *
 * @example
 * ```typescript
 * const acc1 = accountIdFromWallet(parseWalletAddress('0xABC...')!);
 * const acc2 = accountIdFromWallet(parseWalletAddress('0xabc...')!);
 *
 * accountIdEquals(acc1, acc2); // → true (case-insensitive)
 *
 * // Глубоко вложенные структуры:
 * accountIdEquals(deeplyNested1, deeplyNested2); // → false (depth limit)
 * ```
 */
export function accountIdEquals(a: AccountId, b: AccountId): boolean {
  return accountIdEqualsImpl(a, b, 0);
}

/**
 * Internal implementation с depth tracking
 *
 * @param a - Первый AccountId
 * @param b - Второй AccountId
 * @param depth - Текущая глубина рекурсии
 * @returns true если AccountId идентичны, false если разные или превышен depth limit
 *
 * @remarks
 * Рекурсивная реализация с отслеживанием глубины.
 * При каждом рекурсивном вызове для SUBACCOUNT инкрементирует depth.
 * Проверка depth > MAX_SUBACCOUNT_DEPTH предотвращает stack overflow.
 *
 * Возвращает false (безопасный fallback) при превышении depth limit,
 * вместо crash или throw.
 */
function accountIdEqualsImpl(a: AccountId, b: AccountId, depth: number): boolean {
  if (depth > MAX_SUBACCOUNT_DEPTH) {
    return false;
  }

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
    return accountIdEqualsImpl(a.base, b.base, depth + 1) && a.name === b.name;
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
 * Helper: escape backslashes и colons в строке
 *
 * @param str - Строка для экранирования
 * @returns Строка с экранированными '\' и ':'
 *
 * @remarks
 * Порядок важен: сначала '\' → '\\', затем ':' → '\:'
 * Это обеспечивает правильный round-trip для строк типа "user\:123"
 *
 * Алгоритм:
 * 1. Заменяем все '\' на '\\' (backslash escaping)
 * 2. Заменяем все ':' на '\:' (colon escaping)
 *
 * Если поменять порядок, round-trip сломается.
 */
function escape(str: string): string {
  // Сначала escape backslash, потом colon
  return str.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

/**
 * Helper: unescape backslashes и colons в строке
 *
 * @param str - Строка для декодирования
 * @returns Строка с раскодированными escape-последовательностями
 *
 * @remarks
 * Посимвольный автомат для корректной обработки:
 * - '\\' → '\'
 * - '\:' → ':'
 * - Любой другой символ после '\' остаётся как есть
 *
 * Алгоритм:
 * 1. Итерируем по символам строки
 * 2. При встрече '\' проверяем следующий символ:
 *    - Если '\\' → добавляем '\', пропускаем оба символа
 *    - Если '\:' → добавляем ':', пропускаем оба символа
 *    - Иначе → добавляем '\', продолжаем с текущей позиции
 * 3. Обычные символы просто добавляем в результат
 *
 * Не использует простой replace(), так как это не обработает
 * правильно последовательности типа '\\\:' (backslash + escaped colon).
 */
function unescape(str: string): string {
  let result = '';
  let i = 0;

  while (i < str.length) {
    const char = str[i];

    if (char === '\\' && i + 1 < str.length) {
      const next = str[i + 1];

      if (next === '\\') {
        result += '\\';
        i += 2;
        continue;
      }

      if (next === ':') {
        result += ':';
        i += 2;
        continue;
      }

      // Неизвестная escape-последовательность - оставляем как есть
      result += char;
      i++;
      continue;
    }

    result += char;
    i++;
  }

  return result;
}

/**
 * Helper: split строки по ':' с учётом escaped separators
 *
 * @param str - Строка для разбиения
 * @returns Массив частей строки, разделённых неэкранированными ':'
 *
 * @remarks
 * Посимвольный автомат:
 * - '\\' → literal '\' (не устанавливает escape-флаг)
 * - '\:' → literal ':' (не разделитель)
 * - ':' → разделитель
 *
 * Алгоритм:
 * 1. Итерируем по символам строки
 * 2. При встрече '\' проверяем следующий символ:
 *    - Если '\\' или '\:' → добавляем оба символа в current, пропускаем оба
 *    - Иначе → добавляем '\' в current, продолжаем
 * 3. При встрече неэкранированного ':':
 *    - Добавляем current в parts
 *    - Обнуляем current
 * 4. Обычные символы просто добавляем в current
 * 5. В конце добавляем последний current в parts
 *
 * Не использует простой split(':'), так как это не учитывает
 * экранированные colons типа '\:'.
 */
function splitEscaped(str: string): string[] {
  const parts: string[] = [];
  let current = '';
  let i = 0;

  while (i < str.length) {
    const char = str[i];

    if (char === '\\' && i + 1 < str.length) {
      const next = str[i + 1];

      if (next === '\\' || next === ':') {
        // Escaped backslash или colon - добавляем оба символа в current
        current += char + next;
        i += 2;
        continue;
      }

      // Обычный backslash - не escape-последовательность
      current += char;
      i++;
      continue;
    }

    if (char === ':') {
      // Неэкранированный разделитель
      parts.push(current);
      current = '';
      i++;
      continue;
    }

    current += char;
    i++;
  }

  parts.push(current);
  return parts;
}
