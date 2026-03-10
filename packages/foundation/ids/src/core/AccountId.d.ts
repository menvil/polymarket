import type { WalletAddress } from './WalletAddress.js';
import type { VenueId } from './VenueId.js';
import type { Result } from '@polymarket/result';
import { AccountIdDepthError, AccountIdValidationError } from '@polymarket/errors';
export { AccountIdDepthError, AccountIdValidationError };
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
export type AccountId = {
    readonly kind: 'WALLET';
    readonly address: WalletAddress;
} | {
    readonly kind: 'VENUE';
    readonly venueId: VenueId;
    readonly userId: string;
} | {
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
     * @remarks
     * Семантика: maxDepth=N означает "допускать depth от 0 до N включительно".
     * - depth 0: базовый аккаунт (WALLET или VENUE)
     * - depth 1-N: N уровней SUBACCOUNT
     * - depth > N: отклоняется
     *
     * @default MAX_SUBACCOUNT_DEPTH (5)
     */
    maxDepth?: number;
    /**
     * Максимальная длина входной строки
     *
     * @default MAX_ACCOUNT_ID_STRING_LENGTH (4096)
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
 * @returns Глубина вложенности (0 для WALLET/VENUE, ≥1 для SUBACCOUNT).
 *   При обнаружении цикла или аномальной глубины возвращает значение
 *   `> MAX_SUBACCOUNT_DEPTH`, что гарантирует отказ `accountIdForSubaccount`
 *   с `Err(AccountIdDepthError)`.
 *
 * @remarks
 * Тотальная функция — никогда не бросает и не зависает в бесконечном цикле.
 *
 * Защита реализована двумя независимыми механизмами:
 * 1. **Детект цикла через `visited`** (WeakSet): если текущий объект уже был
 *    посещён, граф содержит цикл вида `a.base === a`. Немедленно возвращаем
 *    `MAX_SUBACCOUNT_DEPTH + 1`.
 * 2. **Hard cap по итерациям** (`MAX_SUBACCOUNT_DEPTH + SAFETY_MARGIN`):
 *    страховка на случай аномально длинной, но технически ациклической цепочки.
 *    Возвращаем `MAX_SUBACCOUNT_DEPTH + 1`.
 *
 * Итеративная реализация — не рекурсивная.
 *
 * @example
 * ```typescript
 * const wallet = accountIdFromWallet(parseWalletAddress('0x1234...')!);
 * getSubaccountDepth(wallet); // → 0
 *
 * const sub1 = accountIdForSubaccount(wallet, 'level1');
 * getSubaccountDepth(sub1.value!); // → 1
 *
 * // Защита от цикла (обходится TypeScript через as any):
 * const mutable = { kind: 'SUBACCOUNT' as const, base: wallet, name: 'x' };
 * (mutable as any).base = mutable; // цикл
 * getSubaccountDepth(mutable as AccountId); // → 6 (> MAX_SUBACCOUNT_DEPTH)
 * ```
 */
export declare function getSubaccountDepth(id: AccountId): number;
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
export declare function accountIdFromWallet(address: WalletAddress): AccountId;
/**
 * Создать AccountId для venue account
 *
 * @param venueId - ID venue (биржа/платформа)
 * @param userId - User ID на этом venue
 * @returns Result с AccountId типа VENUE или ошибкой при невалидном userId
 *
 * @remarks
 * Используется для идентификации аккаунтов на centralized venues
 * (POLYMARKET, KALSHI, etc).
 *
 * Валидирует userId теми же правилами что и parser для гарантии round-trip:
 * - Не пустая строка
 * - Максимум 256 символов
 * - Не содержит control characters
 *
 * @example
 * ```typescript
 * const result = accountIdFromVenue(KnownVenues.POLYMARKET, 'user_123');
 *
 * if (result.ok) {
 *   console.log(accountIdToString(result.value));
 *   // → 'venue:POLYMARKET:user_123'
 * } else {
 *   console.error('Invalid userId:', result.error.message);
 * }
 *
 * // Невалидный userId
 * accountIdFromVenue(KnownVenues.POLYMARKET, ''); // → Err (empty string)
 * accountIdFromVenue(KnownVenues.POLYMARKET, 'x'.repeat(300)); // → Err (too long)
 * ```
 */
export declare function accountIdFromVenue(venueId: VenueId, userId: string): Result<AccountId, AccountIdValidationError>;
/**
 * Создать AccountId для subaccount
 *
 * @param base - Base account (может быть любого типа)
 * @param name - Имя subaccount
 * @returns Result с AccountId типа SUBACCOUNT или ошибкой
 *
 * @remarks
 * Subaccounts используются для разделения балансов внутри одного base account.
 * Например: 'main_strategy', 'arbitrage', 'hedging', etc.
 *
 * Может быть вложенным: subaccount может иметь свои subaccounts.
 * Максимальная глубина вложенности ограничена для защиты от stack overflow.
 *
 * Валидирует name теми же правилами что и parser для гарантии round-trip:
 * - Не пустая строка
 * - Максимум 256 символов
 * - Не содержит control characters
 *
 * Возвращает ошибку при:
 * - Невалидном name (AccountIdValidationError)
 * - Превышении depth limit (AccountIdDepthError)
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
 * // Ошибки:
 * accountIdForSubaccount(wallet, ''); // → Err(AccountIdValidationError)
 * accountIdForSubaccount(deeplyNested, 'tooDeep'); // → Err(AccountIdDepthError)
 * ```
 */
export declare function accountIdForSubaccount(base: AccountId, name: string): Result<AccountId, AccountIdDepthError | AccountIdValidationError>;
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
 * // accountIdFromVenue возвращает Result — нужно проверить ok
 * const venueResult = accountIdFromVenue(KnownVenues.POLYMARKET, 'user:123');
 * if (venueResult.ok) {
 *   accountIdToString(venueResult.value);
 *   // → 'venue:POLYMARKET:user\\:123' (escaped colon)
 * }
 *
 * const specialResult = accountIdFromVenue(KnownVenues.POLYMARKET, 'user\\:test');
 * if (specialResult.ok) {
 *   accountIdToString(specialResult.value);
 *   // → 'venue:POLYMARKET:user\\\\\\:test' (escaped backslash and colon)
 * }
 * ```
 */
export declare function accountIdToString(id: AccountId): string;
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
export declare function parseAccountId(str: string, options?: ParseAccountIdOptions): AccountId | undefined;
/**
 * Сравнение двух AccountId на равенство
 *
 * @param a - Первый AccountId
 * @param b - Второй AccountId
 * @returns true если AccountId идентичны, false если разные или превышен depth limit
 *
 * @remarks
 * Deep comparison для всех типов аккаунтов.
 * Для WALLET сравнивает нормализованные (lowercase) адреса через walletAddressEquals.
 * Для SUBACCOUNT рекурсивно сравнивает base accounts.
 *
 * При превышении MAX_SUBACCOUNT_DEPTH возвращает false (безопасный fallback).
 *
 * @remarks
 * Depth limit намеренно фиксирован на MAX_SUBACCOUNT_DEPTH.
 * AccountId созданные через parseAccountId с кастомным maxDepth > MAX_SUBACCOUNT_DEPTH
 * будут некорректно сравниваться (вернут false). Используйте accountIdForSubaccount
 * для создания AccountId — он enforces тот же MAX_SUBACCOUNT_DEPTH.
 *
 * @example
 * ```typescript
 * const acc1 = accountIdFromWallet(parseWalletAddress('0xABC...')!);
 * const acc2 = accountIdFromWallet(parseWalletAddress('0xabc...')!);
 *
 * accountIdEquals(acc1, acc2); // → true (оба нормализованы в lowercase parseWalletAddress)
 *
 * // Глубоко вложенные структуры:
 * accountIdEquals(deeplyNested1, deeplyNested2); // → false (depth limit)
 * ```
 */
export declare function accountIdEquals(a: AccountId, b: AccountId): boolean;
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
export declare function isWalletAccount(id: AccountId): id is Extract<AccountId, {
    kind: 'WALLET';
}>;
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
export declare function isVenueAccount(id: AccountId): id is Extract<AccountId, {
    kind: 'VENUE';
}>;
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
export declare function isSubaccount(id: AccountId): id is Extract<AccountId, {
    kind: 'SUBACCOUNT';
}>;
//# sourceMappingURL=AccountId.d.ts.map