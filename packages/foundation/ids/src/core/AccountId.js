import { parseWalletAddress, walletAddressEquals } from './WalletAddress.js';
import { asVenueId } from './VenueId.js';
import { Ok, Err } from '@polymarket/result';
import { escapeId, unescapeId, splitEscaped } from './utils/escaping.js';
import { AccountIdDepthError, AccountIdValidationError } from '@polymarket/errors';
export { AccountIdDepthError, AccountIdValidationError };
/**
 * Максимальная глубина вложенности SUBACCOUNT
 *
 * @remarks
 * Защита от stack overflow при рекурсивной обработке.
 * Ограничивает цепочки типа: sub:sub:sub:...
 *
 * Семантика: MAX_SUBACCOUNT_DEPTH = N означает "максимум N layers субаккаунтов".
 * - depth 0: базовый аккаунт (WALLET или VENUE)
 * - depth 1..N: допустимо (N layers SUBACCOUNT)
 * - depth N+1 и выше: отклоняется
 *
 * Два разных check в коде реализуют это:
 * - accountIdForSubaccount: `currentDepth >= N` (currentDepth — глубина base)
 * - parseAccountIdImpl: `depth > maxDepth` (depth — счётчик рекурсии, начинается с 0)
 */
const MAX_SUBACCOUNT_DEPTH = 5;
/**
 * Максимальная длина serialized AccountId строки
 *
 * @remarks
 * Защита от DoS атак с аномально длинными строками.
 * Проверяется при парсинге перед началом обработки.
 */
// 4096 покрывает worst-case: venue:VENUE_32:escaped_userId_512 плюс 5 уровней subaccount.
// Исходные 512 были слишком малы: venue + max userId (256 chars, doubled by escaping) = 551.
const MAX_ACCOUNT_ID_STRING_LENGTH = 4096;
/**
 * Максимальная длина значения в сообщении об ошибке
 *
 * @remarks
 * Ограничивает длину пользовательских данных в error messages для защиты от
 * утечки больших объёмов данных в логах и от аномально длинных сообщений.
 */
const MAX_ERROR_VALUE_LENGTH = 64;
/**
 * Дополнительный запас глубины для bounded-loop защиты
 *
 * @remarks
 * Используется в accountIdToStringImpl и accountIdEqualsImpl для единого лимита:
 * depth > MAX_SUBACCOUNT_DEPTH + SAFETY_MARGIN → безопасный fallback вместо crash.
 */
const SAFETY_MARGIN = 10;
/**
 * Обрезать строку для включения в error message
 *
 * @param value - Исходная строка
 * @returns Строка длиной не более MAX_ERROR_VALUE_LENGTH с '...' если обрезана
 */
function truncateForError(value) {
    return value.length > MAX_ERROR_VALUE_LENGTH
        ? `${value.substring(0, MAX_ERROR_VALUE_LENGTH)}...`
        : value;
}
/**
 * Валидация строкового поля (userId или name субаккаунта)
 *
 * @param value - Строка для валидации
 * @returns null если поле валидно, или строка-описание причины отказа
 *
 * @remarks
 * Правила валидации:
 * - Не пустая
 * - Максимум 256 символов
 * - Не содержит control characters (U+0000..U+001F, U+007F..U+009F)
 */
function validateStringField(value) {
    // Предел 256 измеряется в Unicode code points, а не UTF-16 code units.
    // [...value] разбивает строку по code points (суррогатные пары считаются как один символ).
    const codePoints = [...value];
    if (codePoints.length === 0)
        return 'empty string';
    if (codePoints.length > 256)
        return 'exceeds 256 characters';
    // Цикл по UTF-16 code units: control characters в диапазонах U+0000..U+001F и
    // U+007F..U+009F являются однобайтовыми и никогда не составляют суррогатные пары,
    // поэтому charCodeAt корректен для их обнаружения.
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
            return 'contains control characters';
        }
    }
    return null;
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
export function getSubaccountDepth(id) {
    const MAX_ITERATIONS = MAX_SUBACCOUNT_DEPTH + SAFETY_MARGIN;
    // Используем WeakSet: не удерживает ссылки и работает с объектами любого типа
    const visited = new WeakSet();
    let depth = 0;
    // unknown позволяет безопасно проверить повреждённые структуры без as any
    let current = id;
    while (current !== null &&
        current !== undefined &&
        typeof current === 'object' &&
        current.kind === 'SUBACCOUNT') {
        const node = current;
        // Детект цикла: объект уже встречался в цепочке → зацикленный граф
        if (visited.has(node)) {
            return MAX_SUBACCOUNT_DEPTH + 1;
        }
        visited.add(node);
        depth++;
        // Hard cap: страховка на аномально длинную (но ациклическую) цепочку
        if (depth > MAX_ITERATIONS) {
            return MAX_SUBACCOUNT_DEPTH + 1;
        }
        current = node.base;
    }
    // Инвариант: цепочка должна завершиться на WALLET или VENUE-узле.
    // Если current — не объект или его kind неизвестен (null/undefined/{}), цепочка повреждена.
    const terminal = current;
    if (terminal === null ||
        terminal === undefined ||
        typeof terminal !== 'object' ||
        (terminal.kind !== 'WALLET' && terminal.kind !== 'VENUE')) {
        return MAX_SUBACCOUNT_DEPTH + 1;
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
export function accountIdFromWallet(address) {
    return Object.freeze({
        kind: 'WALLET',
        address,
    });
}
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
export function accountIdFromVenue(venueId, userId) {
    // Валидация userId теми же правилами что в parser
    const userIdReason = validateStringField(userId);
    if (userIdReason !== null) {
        return Err(new AccountIdValidationError((ctx) => `Invalid ${ctx.field}: ${ctx.reason} (value: "${ctx.value}")`, { context: { field: 'userId', value: truncateForError(userId), reason: userIdReason } }));
    }
    return Ok(Object.freeze({
        kind: 'VENUE',
        venueId,
        userId,
    }));
}
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
export function accountIdForSubaccount(base, name) {
    // Валидация name теми же правилами что в parser
    const nameReason = validateStringField(name);
    if (nameReason !== null) {
        return Err(new AccountIdValidationError((ctx) => `Invalid ${ctx.field}: ${ctx.reason} (value: "${ctx.value}")`, { context: { field: 'name', value: truncateForError(name), reason: nameReason } }));
    }
    const currentDepth = getSubaccountDepth(base);
    if (currentDepth >= MAX_SUBACCOUNT_DEPTH) {
        return Err(new AccountIdDepthError((ctx) => `Subaccount depth limit exceeded during ${ctx.operation}: current=${ctx.currentDepth}, max=${ctx.maxDepth}`, { context: { currentDepth, maxDepth: MAX_SUBACCOUNT_DEPTH, operation: 'create' } }));
    }
    return Ok(Object.freeze({
        kind: 'SUBACCOUNT',
        base,
        name,
    }));
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
export function accountIdToString(id) {
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
function accountIdToStringImpl(id, depth) {
    // Bounded loop защита с safety margin (модульная константа SAFETY_MARGIN)
    if (depth > MAX_SUBACCOUNT_DEPTH + SAFETY_MARGIN) {
        // Dev-only assertion: не должно случиться если фабрика держит инвариант
        if (process.env.NODE_ENV !== 'production') {
            console.assert(false, `Unexpected depth ${depth} > ${MAX_SUBACCOUNT_DEPTH} in accountIdToString. This indicates a bug in accountIdForSubaccount.`);
        }
        // Fallback для production: возвращаем placeholder вместо crash
        return '[INVALID:DEPTH_EXCEEDED]';
    }
    // Runtime-защита от corrupted base (null/undefined вместо AccountId)
    // Достижимо только при нарушении инварианта через as any
    const idRaw = id;
    if (idRaw === null || idRaw === undefined || typeof idRaw !== 'object') {
        return '[INVALID:NULL_BASE]';
    }
    if (id.kind === 'WALLET') {
        return `wallet:${id.address}`;
    }
    if (id.kind === 'VENUE') {
        const escapedUserId = escapeId(id.userId);
        return `venue:${id.venueId}:${escapedUserId}`;
    }
    if (id.kind === 'SUBACCOUNT') {
        const baseStr = accountIdToStringImpl(id.base, depth + 1);
        const escapedName = escapeId(id.name);
        return `sub:${baseStr}:${escapedName}`;
    }
    // Runtime-защита от corrupted AccountId с неизвестным kind (достижимо только через as any)
    return '[INVALID:UNKNOWN_KIND]';
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
export function parseAccountId(str, options) {
    // Защита от non-string runtime-ввода через as any
    if (typeof str !== 'string') {
        return undefined;
    }
    // Guard против as any: maxLen/maxDepth должны быть конечными положительными числами
    const rawMaxLen = options?.maxLen;
    const maxLen = (typeof rawMaxLen === 'number' && Number.isFinite(rawMaxLen) && rawMaxLen >= 0)
        ? rawMaxLen
        : MAX_ACCOUNT_ID_STRING_LENGTH;
    const rawMaxDepth = options?.maxDepth;
    const maxDepth = (typeof rawMaxDepth === 'number' && Number.isFinite(rawMaxDepth) && rawMaxDepth >= 0)
        ? rawMaxDepth
        : MAX_SUBACCOUNT_DEPTH;
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
function parseAccountIdImpl(str, depth, maxDepth, options) {
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
        // Используем кастомную валидацию если передана и является функцией, иначе дефолтную
        // Guard против as any: options.validateWalletAddress может быть не функцией
        const customValidator = options?.validateWalletAddress;
        const validate = typeof customValidator === 'function' ? customValidator : parseWalletAddress;
        const validatedAddress = validate(rawAddress);
        if (!validatedAddress) {
            return undefined;
        }
        return Object.freeze({
            kind: 'WALLET',
            address: validatedAddress,
        });
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
        const userId = unescapeId(parts[2]);
        // Валидация userId
        if (validateStringField(userId) !== null) {
            return undefined;
        }
        return Object.freeze({
            kind: 'VENUE',
            venueId,
            userId,
        });
    }
    if (kind === 'sub') {
        // Минимальная структура: ['sub', 'wallet', '0x...', 'name'] — 4 элемента.
        // 3-элементные строки вроде 'sub:something:name' не имеют валидного base account,
        // отклоняем сразу, не тратя ресурсы на рекурсивный вызов parse.
        if (parts.length < 4) {
            return undefined;
        }
        // Extract subaccount name (last part)
        const name = unescapeId(parts[parts.length - 1]);
        // Валидация name
        if (validateStringField(name) !== null) {
            return undefined;
        }
        // Reconstruct base account string (everything except 'sub' prefix and trailing name).
        //
        // `parts` was produced by splitEscaped, so each element still contains its
        // original escape sequences (e.g. '\:' for a literal colon, '\\' for a backslash).
        // Joining with ':' is the exact inverse of splitEscaped for unescaped separators,
        // so baseParts.join(':') correctly rebuilds the serialized base AccountId string,
        // including any nested SUBACCOUNT layers.
        //
        // Escaped colons ('\:') and backslashes ('\\') inside individual parts are
        // preserved as-is by join — they will be correctly unescaped when
        // parseAccountIdImpl recurses into baseStr.
        const baseParts = parts.slice(1, -1);
        const baseStr = baseParts.join(':');
        const base = parseAccountIdImpl(baseStr, depth + 1, maxDepth, options);
        if (!base) {
            return undefined;
        }
        return Object.freeze({
            kind: 'SUBACCOUNT',
            base,
            name,
        });
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
export function accountIdEquals(a, b) {
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
function accountIdEqualsImpl(a, b, depth) {
    // Намеренно строгий лимит без SAFETY_MARGIN: идентификаторы глубже MAX_SUBACCOUNT_DEPTH
    // не могут быть созданы через accountIdForSubaccount, поэтому равенство == false — корректный fallback.
    if (depth > MAX_SUBACCOUNT_DEPTH) {
        return false;
    }
    if (a.kind !== b.kind) {
        return false;
    }
    if (a.kind === 'WALLET' && b.kind === 'WALLET') {
        return walletAddressEquals(a.address, b.address);
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
export function isWalletAccount(id) {
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
export function isVenueAccount(id) {
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
export function isSubaccount(id) {
    return id.kind === 'SUBACCOUNT';
}
//# sourceMappingURL=AccountId.js.map