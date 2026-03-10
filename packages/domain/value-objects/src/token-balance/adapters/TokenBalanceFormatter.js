import Decimal from 'decimal.js';
import { OutcomeTokenFormatter } from '../../outcome-token/adapters/OutcomeTokenFormatter.js';
import { accountIdToString } from '@polymarket/ids';
/**
 * Форматтер для TokenBalance
 *
 * @remarks
 * Предоставляет методы для форматирования TokenBalance в строки
 * для UI и логирования.
 *
 * Использует QuantityFormatter для форматирования available и reserved.
 * Все методы безопасны и не бросают исключений.
 *
 * @example
 * ```typescript
 * import { TokenBalanceService, TokenBalanceFormatter } from '@polymarket/value-objects/token-balance';
 * import { OutcomeTokenService } from '@polymarket/value-objects/outcome-token';
 * import { BinaryOutcome, KnownVenues, accountIdFromWallet, parseWalletAddress } from '@polymarket/ids';
 * import Decimal from 'decimal.js';
 *
 * const token = expectOk(OutcomeTokenService.create(onChainRef, BinaryOutcome.UP));
 * const balance = expectOk(TokenBalanceService.create(
 *   token,
 *   Quantity.of(new Decimal(100)),
 *   Quantity.of(new Decimal(20)),
 *   accountId,
 *   KnownVenues.POLYMARKET
 * ));
 *
 * console.log(TokenBalanceFormatter.toSummary(balance));
 * // "Available: 100, Reserved: 20, Total: 120 (16.67% reserved) [UP]"
 *
 * console.log(TokenBalanceFormatter.toCompact(balance));
 * // "Avail: 100 | Res: 20 | Total: 120"
 * ```
 */
export class TokenBalanceFormatter {
    /**
     * Форматирует TokenBalance в подробную строку
     *
     * @remarks
     * Показывает available, reserved, total и процент зарезервированных токенов.
     * Опционально показывает accountId и venueId.
     * Используется для детального отображения баланса.
     *
     * @param balance - TokenBalance для форматирования
     * @param decimals - Количество десятичных знаков (по умолчанию 2)
     * @param includeAccount - Показывать ли accountId (по умолчанию false)
     * @param includeVenue - Показывать ли venueId (по умолчанию false)
     * @returns Отформатированная строка вида "Available: X, Reserved: Y, Total: Z (P% reserved) [OutcomeKey]"
     *
     * @example
     * ```typescript
     * const balance = expectOk(TokenBalanceService.create(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * ));
     *
     * console.log(TokenBalanceFormatter.toSummary(balance));
     * // "Available: 100.00, Reserved: 20.00, Total: 120.00 (16.67% reserved) [UP]"
     *
     * // С accountId и venueId
     * console.log(TokenBalanceFormatter.toSummary(balance, 2, true, true));
     * // "Available: 100.00, Reserved: 20.00, Total: 120.00 (16.67% reserved) [UP] [Account: wallet:0x..., Venue: POLYMARKET]"
     * ```
     */
    static toSummary(balance, decimals = 2, includeAccount = false, includeVenue = false) {
        const safeDecimals = Decimal.max(0, Decimal.min(100, new Decimal(decimals).floor())).toNumber();
        const avail = balance.available().value().toFixed(safeDecimals);
        const res = balance.reserved().value().toFixed(safeDecimals);
        const total = balance.total().value().toFixed(safeDecimals);
        const pct = balance.reservedPercentage().toFixed(2);
        const token = balance.outcomeKey();
        let result = `Available: ${avail}, Reserved: ${res}, Total: ${total} (${pct}% reserved) [${token}]`;
        // Добавляем accountId и venueId если запрошено
        if (includeAccount || includeVenue) {
            const parts = [];
            if (includeAccount) {
                parts.push(`Account: ${accountIdToString(balance.accountId())}`);
            }
            if (includeVenue) {
                parts.push(`Venue: ${balance.venueId()}`);
            }
            result += ` [${parts.join(', ')}]`;
        }
        return result;
    }
    /**
     * Форматирует TokenBalance компактно
     *
     * @remarks
     * Короткий формат для отображения в ограниченном пространстве.
     * Опционально показывает venueId (accountId слишком длинный для компактного формата).
     *
     * @param balance - TokenBalance для форматирования
     * @param decimals - Количество десятичных знаков (по умолчанию 1)
     * @param includeVenue - Показывать ли venueId (по умолчанию false)
     * @returns Отформатированная строка вида "Avail: X | Res: Y | Total: Z"
     *
     * @example
     * ```typescript
     * const balance = expectOk(TokenBalanceService.create(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * ));
     *
     * console.log(TokenBalanceFormatter.toCompact(balance));
     * // "Avail: 100.0 | Res: 20.0 | Total: 120.0"
     *
     * // С venueId
     * console.log(TokenBalanceFormatter.toCompact(balance, 1, true));
     * // "Avail: 100.0 | Res: 20.0 | Total: 120.0 @ POLYMARKET"
     * ```
     */
    static toCompact(balance, decimals = 1, includeVenue = false) {
        const safeDecimals = Decimal.max(0, Decimal.min(100, new Decimal(decimals).floor())).toNumber();
        const avail = balance.available().value().toFixed(safeDecimals);
        const res = balance.reserved().value().toFixed(safeDecimals);
        const total = balance.total().value().toFixed(safeDecimals);
        let result = `Avail: ${avail} | Res: ${res} | Total: ${total}`;
        // Добавляем venueId если запрошено
        if (includeVenue) {
            result += ` @ ${balance.venueId()}`;
        }
        return result;
    }
    /**
     * Форматирует TokenBalance для отладки
     *
     * @remarks
     * Показывает все поля баланса для отладки.
     * Использует полную точность Decimal.
     * Всегда показывает outcomeKey, accountId и venueId для полной диагностики.
     *
     * @param balance - TokenBalance для форматирования
     * @returns Строка вида "TokenBalance(available: X, reserved: Y, total: Z, token: ..., account: ..., venue: ...)"
     *
     * @example
     * ```typescript
     * const balance = expectOk(TokenBalanceService.create(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * ));
     *
     * console.log(TokenBalanceFormatter.toDebugString(balance));
     * // "TokenBalance(available: 100, reserved: 20, total: 120, token: UP, account: wallet:0x..., venue: POLYMARKET)"
     * ```
     */
    static toDebugString(balance) {
        const available = balance.available().value().toString();
        const reserved = balance.reserved().value().toString();
        const total = balance.total().value().toString();
        const token = balance.outcomeKey();
        const account = accountIdToString(balance.accountId());
        const venue = balance.venueId();
        return `TokenBalance(available: ${available}, reserved: ${reserved}, total: ${total}, token: ${token}, account: ${account}, venue: ${venue})`;
    }
    /**
     * Форматирует только available
     *
     * @remarks
     * Convenience метод для отображения только доступных токенов.
     *
     * @param balance - TokenBalance для форматирования
     * @param decimals - Количество десятичных знаков (по умолчанию 2)
     * @returns Отформатированная строка вида "100.00"
     *
     * @example
     * ```typescript
     * const balance = expectOk(TokenBalanceService.create(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * ));
     *
     * console.log(TokenBalanceFormatter.toAvailableString(balance));
     * // "100.00"
     * ```
     */
    static toAvailableString(balance, decimals = 2) {
        const safeDecimals = Decimal.max(0, Decimal.min(100, new Decimal(decimals).floor())).toNumber();
        return balance.available().value().toFixed(safeDecimals);
    }
    /**
     * Форматирует только reserved
     *
     * @remarks
     * Convenience метод для отображения только зарезервированных токенов.
     *
     * @param balance - TokenBalance для форматирования
     * @param decimals - Количество десятичных знаков (по умолчанию 2)
     * @returns Отформатированная строка вида "20.00"
     *
     * @example
     * ```typescript
     * const balance = expectOk(TokenBalanceService.create(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * ));
     *
     * console.log(TokenBalanceFormatter.toReservedString(balance));
     * // "20.00"
     * ```
     */
    static toReservedString(balance, decimals = 2) {
        const safeDecimals = Decimal.max(0, Decimal.min(100, new Decimal(decimals).floor())).toNumber();
        return balance.reserved().value().toFixed(safeDecimals);
    }
    /**
     * Форматирует только total
     *
     * @remarks
     * Convenience метод для отображения только общего количества токенов.
     *
     * @param balance - TokenBalance для форматирования
     * @param decimals - Количество десятичных знаков (по умолчанию 2)
     * @returns Отформатированная строка вида "120.00"
     *
     * @example
     * ```typescript
     * const balance = expectOk(TokenBalanceService.create(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * ));
     *
     * console.log(TokenBalanceFormatter.toTotalString(balance));
     * // "120.00"
     * ```
     */
    static toTotalString(balance, decimals = 2) {
        const safeDecimals = Decimal.max(0, Decimal.min(100, new Decimal(decimals).floor())).toNumber();
        return balance.total().value().toFixed(safeDecimals);
    }
    /**
     * Форматирует процент зарезервированных токенов
     *
     * @remarks
     * Показывает какая часть баланса зарезервирована.
     *
     * @param balance - TokenBalance для форматирования
     * @param decimals - Количество десятичных знаков (по умолчанию 2)
     * @returns Отформатированная строка вида "16.67%"
     *
     * @example
     * ```typescript
     * const balance = expectOk(TokenBalanceService.create(
     *   token,
     *   Quantity.of(new Decimal(80)),
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * ));
     *
     * console.log(TokenBalanceFormatter.toPercentageString(balance));
     * // "20.00%"
     * ```
     */
    static toPercentageString(balance, decimals = 2) {
        const safeDecimals = Decimal.max(0, Decimal.min(100, new Decimal(decimals).floor())).toNumber();
        return `${balance.reservedPercentage().toFixed(safeDecimals)}%`;
    }
    /**
     * Форматирует TokenBalance как полную строку с деталями
     *
     * @remarks
     * Включает total, outcomeKey и детальную информацию о token.
     * Используется для логирования и диагностики.
     *
     * @param balance - TokenBalance для форматирования
     * @returns Отформатированная строка
     *
     * @example
     * ```typescript
     * const balance = expectOk(TokenBalanceService.create(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * ));
     *
     * const str = TokenBalanceFormatter.toString(balance);
     * // → "TokenBalance[available=100, reserved=20, total=120, token=OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xabc...:UP]"
     * ```
     */
    static toString(balance) {
        const available = balance.available().value().toString();
        const reserved = balance.reserved().value().toString();
        const total = balance.total().value().toString();
        const tokenStr = OutcomeTokenFormatter.toString(balance.token());
        return `TokenBalance[available=${available}, reserved=${reserved}, total=${total}, token=${tokenStr}]`;
    }
    /**
     * Форматирует TokenBalance для отображения в UI
     *
     * @remarks
     * Более читаемый формат с total, outcomeKey и кратким описанием protocol/chain.
     * Используется для UI элементов.
     *
     * @param balance - TokenBalance для форматирования
     * @returns Human-readable строка
     *
     * @example
     * ```typescript
     * const balance = expectOk(TokenBalanceService.create(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * ));
     *
     * const display = TokenBalanceFormatter.toDisplayString(balance);
     * // → "120 UP (POLYMARKET_CTF:137:0xabc...)"
     * ```
     */
    static toDisplayString(balance) {
        const total = balance.total().value().toString();
        const tokenDisplay = OutcomeTokenFormatter.toDisplayString(balance.token());
        return `${total} ${tokenDisplay}`;
    }
    /**
     * Форматирует TokenBalance в краткую строку (total + outcome key)
     *
     * @remarks
     * Минимальное представление - total и ключ outcome.
     * Используется для компактного отображения в таблицах и списках.
     *
     * @param balance - TokenBalance для форматирования
     * @returns Краткая строка (total + outcome key)
     *
     * @example
     * ```typescript
     * const balance = expectOk(TokenBalanceService.create(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * ));
     *
     * const short = TokenBalanceFormatter.toShortString(balance);
     * // → "120 UP"
     * ```
     */
    static toShortString(balance) {
        const total = balance.total().value().toString();
        const outcomeKey = balance.outcomeKey();
        return `${total} ${outcomeKey}`;
    }
    /**
     * Форматирует TokenBalance с полной информацией
     *
     * @remarks
     * Включает все детали token и amounts для debug/logging.
     * Используется для подробного логирования.
     *
     * @param balance - TokenBalance для форматирования
     * @returns Детальная строка с полной информацией
     *
     * @example
     * ```typescript
     * const balance = expectOk(TokenBalanceService.create(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * ));
     *
     * const verbose = TokenBalanceFormatter.toVerboseString(balance);
     * // → "TokenBalance[available=100, reserved=20, total=120, token=OutcomeToken[outcomeKey=UP, condition=ONCHAIN:POLYMARKET_CTF:137:0xabc...]]"
     * ```
     */
    static toVerboseString(balance) {
        const available = balance.available().value().toString();
        const reserved = balance.reserved().value().toString();
        const total = balance.total().value().toString();
        const tokenVerbose = OutcomeTokenFormatter.toVerboseString(balance.token());
        return `TokenBalance[available=${available}, reserved=${reserved}, total=${total}, token=${tokenVerbose}]`;
    }
    /**
     * Форматирует total с указанным числом десятичных знаков
     *
     * @remarks
     * Удобный метод для форматирования total с округлением.
     * Используется для отображения в UI с фиксированной точностью.
     *
     * @param balance - TokenBalance для форматирования
     * @param decimalPlaces - Количество десятичных знаков (по умолчанию 2)
     * @returns Отформатированная строка с округленным total
     *
     * @example
     * ```typescript
     * const balance = expectOk(TokenBalanceService.create(
     *   token,
     *   Quantity.of(new Decimal(100.5)),
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * ));
     *
     * const formatted = TokenBalanceFormatter.toFixedString(balance, 2);
     * // → "120.50 UP"
     *
     * const formatted4 = TokenBalanceFormatter.toFixedString(balance, 4);
     * // → "120.5000 UP"
     * ```
     */
    static toFixedString(balance, decimalPlaces = 2) {
        const safeDecimals = Decimal.max(0, Decimal.min(100, new Decimal(decimalPlaces).floor())).toNumber();
        const total = balance.total().value().toFixed(safeDecimals);
        const outcomeKey = balance.outcomeKey();
        return `${total} ${outcomeKey}`;
    }
}
//# sourceMappingURL=TokenBalanceFormatter.js.map