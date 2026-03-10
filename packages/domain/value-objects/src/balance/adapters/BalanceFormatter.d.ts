import { Balance } from '../core/Balance.js';
import { InvalidBalanceError } from '@polymarket/errors';
import { Result } from '@polymarket/result';
/**
 * Форматтер для Balance
 *
 * @remarks
 * Предоставляет методы для форматирования Balance в строки
 * для UI и логирования.
 *
 * Использует MoneyFormatter для форматирования available и reserved.
 * Все методы возвращают Result для обработки ошибок валидации параметров.
 *
 * @example
 * ```typescript
 * import { Balance, BalanceFormatter } from '@polymarket/value-objects/balance';
 * import { Money } from '@polymarket/value-objects/money';
 * import { expectOk } from '@polymarket/result';
 * import type { AccountId, VenueId, WalletAddress } from '@polymarket/ids';
 *
 * const accountId: AccountId = { kind: 'WALLET', address: '0x...' as WalletAddress };
 * const venueId: VenueId = 'POLYMARKET' as VenueId;
 *
 * const balance = Balance.of(
 *   Money.fromUSDC(10000),
 *   Money.fromUSDC(2000),
 *   accountId,
 *   venueId
 * );
 *
 * console.log(expectOk(BalanceFormatter.toSummary(balance)));
 * // "Available: $10000.00, Reserved: $2000.00, Total: $12000.00 (16.67% reserved)"
 *
 * console.log(expectOk(BalanceFormatter.toCompact(balance)));
 * // "Avail: $10.0K | Res: $2.0K | Total: $12.0K"
 *
 * console.log(BalanceFormatter.toDebugString(balance));
 * // "Balance(available: 10000 USDC, reserved: 2000 USDC, total: 12000 USDC, account: wallet:0x..., venue: POLYMARKET)"
 * ```
 */
export declare class BalanceFormatter {
    /**
     * Форматирует Balance в подробную строку
     *
     * @remarks
     * Показывает available, reserved, total и процент зарезервированных средств.
     * Опционально показывает accountId и venueId.
     * Используется для детального отображения баланса.
     *
     * @param balance - Balance для форматирования
     * @param decimals - Количество десятичных знаков (по умолчанию 2)
     * @param includeAccount - Показывать ли accountId (по умолчанию false)
     * @param includeVenue - Показывать ли venueId (по умолчанию false)
     * @returns Result с отформатированной строкой вида "Available: $X, Reserved: $Y, Total: $Z (P% reserved)" или ошибкой валидации
     * @throws Никогда не бросает исключения, возвращает Result
     *
     * @example
     * ```typescript
     * const accountId: AccountId = { kind: 'WALLET', address: '0x...' as WalletAddress };
     * const venueId: VenueId = 'POLYMARKET' as VenueId;
     *
     * const balance = Balance.of(
     *   Money.fromUSDC(10000),
     *   Money.fromUSDC(2000),
     *   accountId,
     *   venueId
     * );
     *
     * const result1 = BalanceFormatter.toSummary(balance);
     * if (result1.ok) {
     *   console.log(result1.value);
     *   // "Available: $10000.00, Reserved: $2000.00, Total: $12000.00 (16.67% reserved)"
     * }
     *
     * // С accountId и venueId
     * const result2 = BalanceFormatter.toSummary(balance, 2, true, true);
     * if (result2.ok) {
     *   console.log(result2.value);
     *   // "Available: $10000.00, Reserved: $2000.00, Total: $12000.00 (16.67% reserved) [Account: wallet:0x..., Venue: POLYMARKET]"
     * }
     *
     * // Ошибка валидации
     * const result3 = BalanceFormatter.toSummary(balance, -1);
     * if (!result3.ok) {
     *   console.log(result3.error.message); // ошибка валидации decimals
     * }
     * ```
     */
    static toSummary(balance: Balance, decimals?: number, includeAccount?: boolean, includeVenue?: boolean): Result<string, InvalidBalanceError>;
    /**
     * Форматирует Balance компактно
     *
     * @remarks
     * Использует суффиксы K, M, B для тысяч, миллионов, миллиардов.
     * Опционально показывает venueId (accountId слишком длинный для компактного формата).
     * Полезно для отображения баланса в ограниченном пространстве.
     *
     * @param balance - Balance для форматирования
     * @param decimals - Количество десятичных знаков после сокращения (по умолчанию 1)
     * @param includeVenue - Показывать ли venueId (по умолчанию false)
     * @returns Result с отформатированной строкой вида "Avail: $X | Res: $Y | Total: $Z" или ошибкой валидации
     * @throws Никогда не бросает исключения, возвращает Result
     *
     * @example
     * ```typescript
     * const accountId: AccountId = { kind: 'WALLET', address: '0x...' as WalletAddress };
     * const venueId: VenueId = 'POLYMARKET' as VenueId;
     *
     * const balance = Balance.of(
     *   Money.fromUSDC(10000),
     *   Money.fromUSDC(2000),
     *   accountId,
     *   venueId
     * );
     *
     * const result = BalanceFormatter.toCompact(balance);
     * if (result.ok) {
     *   console.log(result.value);
     *   // "Avail: $10.0K | Res: $2.0K | Total: $12.0K"
     * }
     *
     * // С venueId
     * const result2 = BalanceFormatter.toCompact(balance, 1, true);
     * if (result2.ok) {
     *   console.log(result2.value);
     *   // "Avail: $10.0K | Res: $2.0K | Total: $12.0K @ POLYMARKET"
     * }
     * ```
     */
    static toCompact(balance: Balance, decimals?: number, includeVenue?: boolean): Result<string, InvalidBalanceError>;
    /**
     * Форматирует Balance для отладки
     *
     * @remarks
     * Показывает все поля баланса с валютой для отладки.
     * Использует полную точность Decimal.
     * Всегда показывает accountId и venueId для полной диагностики.
     *
     * @param balance - Balance для форматирования
     * @returns Строка вида "Balance(available: X USDC, reserved: Y USDC, total: Z USDC, account: ..., venue: ...)"
     *
     * @example
     * ```typescript
     * const accountId: AccountId = { kind: 'WALLET', address: '0x...' as WalletAddress };
     * const venueId: VenueId = 'POLYMARKET' as VenueId;
     *
     * const balance = Balance.of(
     *   Money.fromUSDC(10000),
     *   Money.fromUSDC(2000),
     *   accountId,
     *   venueId
     * );
     *
     * console.log(BalanceFormatter.toDebugString(balance));
     * // "Balance(available: 10000 USDC, reserved: 2000 USDC, total: 12000 USDC, account: wallet:0x..., venue: POLYMARKET)"
     * ```
     */
    static toDebugString(balance: Balance): string;
    /**
     * Форматирует только available с валютой
     *
     * @remarks
     * Convenience метод для отображения только доступных средств.
     *
     * @param balance - Balance для форматирования
     * @param showCurrency - Показывать ли код валюты (по умолчанию true)
     * @param decimals - Количество десятичных знаков (по умолчанию 2)
     * @returns Result с отформатированной строкой вида "$10000.00 USDC" или "$10000.00", или ошибкой валидации
     * @throws Никогда не бросает исключения, возвращает Result
     *
     * @example
     * ```typescript
     * const balance = Balance.of(
     *   Money.fromUSDC(10000),
     *   Money.fromUSDC(2000)
     * );
     *
     * const result = BalanceFormatter.toAvailableString(balance);
     * if (result.ok) {
     *   console.log(result.value);  // "$10000.00 USDC"
     * }
     * ```
     */
    static toAvailableString(balance: Balance, showCurrency?: boolean, decimals?: number): Result<string, InvalidBalanceError>;
    /**
     * Форматирует только reserved с валютой
     *
     * @remarks
     * Convenience метод для отображения только зарезервированных средств.
     *
     * @param balance - Balance для форматирования
     * @param showCurrency - Показывать ли код валюты (по умолчанию true)
     * @param decimals - Количество десятичных знаков (по умолчанию 2)
     * @returns Result с отформатированной строкой вида "$2000.00 USDC" или "$2000.00", или ошибкой валидации
     * @throws Никогда не бросает исключения, возвращает Result
     *
     * @example
     * ```typescript
     * const balance = Balance.of(
     *   Money.fromUSDC(10000),
     *   Money.fromUSDC(2000)
     * );
     *
     * const result = BalanceFormatter.toReservedString(balance);
     * if (result.ok) {
     *   console.log(result.value);  // "$2000.00 USDC"
     * }
     * ```
     */
    static toReservedString(balance: Balance, showCurrency?: boolean, decimals?: number): Result<string, InvalidBalanceError>;
    /**
     * Форматирует только total с валютой
     *
     * @remarks
     * Convenience метод для отображения только общей суммы.
     *
     * @param balance - Balance для форматирования
     * @param showCurrency - Показывать ли код валюты (по умолчанию true)
     * @param decimals - Количество десятичных знаков (по умолчанию 2)
     * @returns Result с отформатированной строкой вида "$12000.00 USDC" или "$12000.00", или ошибкой валидации
     * @throws Никогда не бросает исключения, возвращает Result
     *
     * @example
     * ```typescript
     * const balance = Balance.of(
     *   Money.fromUSDC(10000),
     *   Money.fromUSDC(2000)
     * );
     *
     * const result = BalanceFormatter.toTotalString(balance);
     * if (result.ok) {
     *   console.log(result.value);  // "$12000.00 USDC"
     * }
     * ```
     */
    static toTotalString(balance: Balance, showCurrency?: boolean, decimals?: number): Result<string, InvalidBalanceError>;
    /**
     * Форматирует процент зарезервированных средств
     *
     * @remarks
     * Показывает какая часть баланса зарезервирована.
     *
     * @param balance - Balance для форматирования
     * @param decimals - Количество десятичных знаков (по умолчанию 2)
     * @returns Result с отформатированной строкой вида "16.67%" или ошибкой валидации
     * @throws Никогда не бросает исключения, возвращает Result
     *
     * @example
     * ```typescript
     * const balance = Balance.of(
     *   Money.fromUSDC(8000),
     *   Money.fromUSDC(2000)
     * );
     *
     * const result = BalanceFormatter.toPercentageString(balance);
     * if (result.ok) {
     *   console.log(result.value);  // "20.00%"
     * }
     * ```
     */
    static toPercentageString(balance: Balance, decimals?: number): Result<string, InvalidBalanceError>;
}
//# sourceMappingURL=BalanceFormatter.d.ts.map