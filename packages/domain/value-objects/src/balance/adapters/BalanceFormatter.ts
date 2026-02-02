import { Balance } from '../core/Balance.js';
import { MoneyFormatter } from '../../money/adapters/MoneyFormatter.js';

/**
 * Форматтер для Balance
 *
 * @remarks
 * Предоставляет методы для форматирования Balance в строки
 * для UI и логирования.
 *
 * Использует MoneyFormatter для форматирования available и reserved.
 *
 * @example
 * ```typescript
 * import { Balance, BalanceFormatter } from '@polymarket/value-objects/balance';
 * import { Money } from '@polymarket/value-objects/money';
 *
 * const balance = Balance.of(
 *   Money.fromUSDC(10000),
 *   Money.fromUSDC(2000)
 * );
 *
 * console.log(BalanceFormatter.toSummary(balance));
 * // "Available: $10000.00, Reserved: $2000.00, Total: $12000.00 (16.67% reserved)"
 *
 * console.log(BalanceFormatter.toCompact(balance));
 * // "Avail: $10.0K | Res: $2.0K | Total: $12.0K"
 *
 * console.log(BalanceFormatter.toDebugString(balance));
 * // "Balance(available: 10000 USDC, reserved: 2000 USDC, total: 12000 USDC)"
 * ```
 */
export class BalanceFormatter {
  /**
   * Форматирует Balance в подробную строку
   *
   * @remarks
   * Показывает available, reserved, total и процент зарезервированных средств.
   * Используется для детального отображения баланса.
   *
   * @param balance - Balance для форматирования
   * @param decimals - Количество десятичных знаков (по умолчанию 2)
   * @returns Строка вида "Available: $X, Reserved: $Y, Total: $Z (P% reserved)"
   * @throws {RangeError} Если decimals отрицательное или не целое число
   *
   * @example
   * ```typescript
   * const balance = Balance.of(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000)
   * );
   *
   * console.log(BalanceFormatter.toSummary(balance));
   * // "Available: $10000.00, Reserved: $2000.00, Total: $12000.00 (16.67% reserved)"
   *
   * console.log(BalanceFormatter.toSummary(balance, 0));
   * // "Available: $10000, Reserved: $2000, Total: $12000 (16.67% reserved)"
   * ```
   */
  public static toSummary(balance: Balance, decimals: number = 2): string {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      throw new RangeError('decimals argument must be a non-negative integer');
    }

    const available = MoneyFormatter.toCurrency(balance.available(), false, decimals);
    const reserved = MoneyFormatter.toCurrency(balance.reserved(), false, decimals);
    const total = MoneyFormatter.toCurrency(balance.total(), false, decimals);
    const percentage = balance.reservedPercentage().toFixed(2);

    return `Available: ${available}, Reserved: ${reserved}, Total: ${total} (${percentage}% reserved)`;
  }

  /**
   * Форматирует Balance компактно
   *
   * @remarks
   * Использует суффиксы K, M, B для тысяч, миллионов, миллиардов.
   * Полезно для отображения баланса в ограниченном пространстве.
   *
   * @param balance - Balance для форматирования
   * @param decimals - Количество десятичных знаков после сокращения (по умолчанию 1)
   * @returns Строка вида "Avail: $X | Res: $Y | Total: $Z"
   * @throws {RangeError} Если decimals отрицательное или не целое число
   *
   * @example
   * ```typescript
   * const balance = Balance.of(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000)
   * );
   *
   * console.log(BalanceFormatter.toCompact(balance));
   * // "Avail: $10.0K | Res: $2.0K | Total: $12.0K"
   *
   * const smallBalance = Balance.of(
   *   Money.fromUSDC(500),
   *   Money.fromUSDC(100)
   * );
   *
   * console.log(BalanceFormatter.toCompact(smallBalance));
   * // "Avail: $500.0 | Res: $100.0 | Total: $600.0"
   * ```
   */
  public static toCompact(balance: Balance, decimals: number = 1): string {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      throw new RangeError('decimals argument must be a non-negative integer');
    }

    const available = MoneyFormatter.toCompact(balance.available(), decimals);
    const reserved = MoneyFormatter.toCompact(balance.reserved(), decimals);
    const total = MoneyFormatter.toCompact(balance.total(), decimals);

    return `Avail: ${available} | Res: ${reserved} | Total: ${total}`;
  }

  /**
   * Форматирует Balance для отладки
   *
   * @remarks
   * Показывает все поля баланса с валютой для отладки.
   * Использует полную точность Decimal.
   *
   * @param balance - Balance для форматирования
   * @returns Строка вида "Balance(available: X USDC, reserved: Y USDC, total: Z USDC)"
   *
   * @example
   * ```typescript
   * const balance = Balance.of(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000)
   * );
   *
   * console.log(BalanceFormatter.toDebugString(balance));
   * // "Balance(available: 10000 USDC, reserved: 2000 USDC, total: 12000 USDC)"
   * ```
   */
  public static toDebugString(balance: Balance): string {
    const available = `${balance.available().value().toString()} ${balance.currency()}`;
    const reserved = `${balance.reserved().value().toString()} ${balance.currency()}`;
    const total = `${balance.total().value().toString()} ${balance.currency()}`;

    return `Balance(available: ${available}, reserved: ${reserved}, total: ${total})`;
  }

  /**
   * Форматирует только available с валютой
   *
   * @remarks
   * Convenience метод для отображения только доступных средств.
   *
   * @param balance - Balance для форматирования
   * @param showCurrency - Показывать ли код валюты (по умолчанию true)
   * @param decimals - Количество десятичных знаков (по умолчанию 2)
   * @returns Строка вида "$10000.00 USDC" или "$10000.00"
   * @throws {RangeError} Если decimals отрицательное или не целое число
   *
   * @example
   * ```typescript
   * const balance = Balance.of(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000)
   * );
   *
   * console.log(BalanceFormatter.toAvailableString(balance));
   * // "$10000.00 USDC"
   *
   * console.log(BalanceFormatter.toAvailableString(balance, false));
   * // "$10000.00"
   * ```
   */
  public static toAvailableString(
    balance: Balance,
    showCurrency: boolean = true,
    decimals: number = 2
  ): string {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      throw new RangeError('decimals argument must be a non-negative integer');
    }

    return MoneyFormatter.toCurrency(balance.available(), showCurrency, decimals);
  }

  /**
   * Форматирует только reserved с валютой
   *
   * @remarks
   * Convenience метод для отображения только зарезервированных средств.
   *
   * @param balance - Balance для форматирования
   * @param showCurrency - Показывать ли код валюты (по умолчанию true)
   * @param decimals - Количество десятичных знаков (по умолчанию 2)
   * @returns Строка вида "$2000.00 USDC" или "$2000.00"
   * @throws {RangeError} Если decimals отрицательное или не целое число
   *
   * @example
   * ```typescript
   * const balance = Balance.of(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000)
   * );
   *
   * console.log(BalanceFormatter.toReservedString(balance));
   * // "$2000.00 USDC"
   *
   * console.log(BalanceFormatter.toReservedString(balance, false));
   * // "$2000.00"
   * ```
   */
  public static toReservedString(
    balance: Balance,
    showCurrency: boolean = true,
    decimals: number = 2
  ): string {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      throw new RangeError('decimals argument must be a non-negative integer');
    }

    return MoneyFormatter.toCurrency(balance.reserved(), showCurrency, decimals);
  }

  /**
   * Форматирует только total с валютой
   *
   * @remarks
   * Convenience метод для отображения только общей суммы.
   *
   * @param balance - Balance для форматирования
   * @param showCurrency - Показывать ли код валюты (по умолчанию true)
   * @param decimals - Количество десятичных знаков (по умолчанию 2)
   * @returns Строка вида "$12000.00 USDC" или "$12000.00"
   * @throws {RangeError} Если decimals отрицательное или не целое число
   *
   * @example
   * ```typescript
   * const balance = Balance.of(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000)
   * );
   *
   * console.log(BalanceFormatter.toTotalString(balance));
   * // "$12000.00 USDC"
   *
   * console.log(BalanceFormatter.toTotalString(balance, false));
   * // "$12000.00"
   * ```
   */
  public static toTotalString(
    balance: Balance,
    showCurrency: boolean = true,
    decimals: number = 2
  ): string {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      throw new RangeError('decimals argument must be a non-negative integer');
    }

    return MoneyFormatter.toCurrency(balance.total(), showCurrency, decimals);
  }

  /**
   * Форматирует процент зарезервированных средств
   *
   * @remarks
   * Показывает какая часть баланса зарезервирована.
   *
   * @param balance - Balance для форматирования
   * @param decimals - Количество десятичных знаков (по умолчанию 2)
   * @returns Строка вида "16.67%"
   * @throws {RangeError} Если decimals отрицательное или не целое число
   *
   * @example
   * ```typescript
   * const balance = Balance.of(
   *   Money.fromUSDC(8000),
   *   Money.fromUSDC(2000)
   * );
   *
   * console.log(BalanceFormatter.toPercentageString(balance));
   * // "20.00%"
   *
   * console.log(BalanceFormatter.toPercentageString(balance, 0));
   * // "20%"
   * ```
   */
  public static toPercentageString(balance: Balance, decimals: number = 2): string {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      throw new RangeError('decimals argument must be a non-negative integer');
    }

    return `${balance.reservedPercentage().toFixed(decimals)}%`;
  }
}
