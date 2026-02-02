import { Money } from '../core/Money.js';

/**
 * Форматтер для Money
 *
 * @remarks
 * Предоставляет методы для форматирования Money в строки
 * для UI и логирования.
 *
 * @example
 * ```typescript
 * import { Money, MoneyFormatter } from '@polymarket/value-objects/money';
 *
 * const money = Money.of(100.50);
 *
 * console.log(MoneyFormatter.toFixed(money, 2));           // "100.50"
 * console.log(MoneyFormatter.toCurrency(money));           // "$100.50 USDC"
 * console.log(MoneyFormatter.toCurrency(money, false));    // "$100.50"
 * ```
 */
export class MoneyFormatter {
  /**
   * Форматирует Money с указанным количеством знаков
   *
   * @remarks
   * Использует Decimal.toFixed() для точного форматирования.
   * Всегда возвращает строго заданное количество десятичных знаков.
   *
   * @param money - Money для форматирования
   * @param decimals - Количество десятичных знаков (по умолчанию 2)
   * @returns Строка с фиксированным количеством знаков
   * @throws {RangeError} Если decimals отрицательное или не целое число
   *
   * @example
   * ```typescript
   * const money = Money.of(100.5);
   * console.log(MoneyFormatter.toFixed(money));       // "100.50"
   * console.log(MoneyFormatter.toFixed(money, 0));    // "101"
   * console.log(MoneyFormatter.toFixed(money, 4));    // "100.5000"
   *
   * const money2 = Money.of(99.9999);
   * console.log(MoneyFormatter.toFixed(money2));      // "100.00"
   * console.log(MoneyFormatter.toFixed(money2, 2));   // "100.00"
   * ```
   */
  public static toFixed(money: Money, decimals: number = 2): string {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      throw new RangeError('decimals argument must be a non-negative integer');
    }
    return money.amount().toFixed(decimals);
  }

  /**
   * Форматирует Money с символом валюты
   *
   * @remarks
   * Добавляет символ доллара и код валюты.
   * Используется для отображения денежных сумм в UI.
   *
   * @param money - Money для форматирования
   * @param showCurrency - Показывать ли код валюты (по умолчанию true)
   * @param decimals - Количество десятичных знаков (по умолчанию 2)
   * @returns Строка вида "$100.50 USDC" или "$100.50"
   *
   * @example
   * ```typescript
   * const money = Money.of(100.50);
   * console.log(MoneyFormatter.toCurrency(money));              // "$100.50 USDC"
   * console.log(MoneyFormatter.toCurrency(money, false));       // "$100.50"
   * console.log(MoneyFormatter.toCurrency(money, true, 0));     // "$101 USDC"
   *
   * const money2 = Money.of(1234.5678);
   * console.log(MoneyFormatter.toCurrency(money2));             // "$1234.57 USDC"
   * console.log(MoneyFormatter.toCurrency(money2, true, 4));    // "$1234.5678 USDC"
   * ```
   */
  public static toCurrency(
    money: Money,
    showCurrency: boolean = true,
    decimals: number = 2
  ): string {
    const amount = money.amount();
    const isNegative = amount.isNegative();
    const absAmount = amount.abs().toFixed(decimals);
    const formatted = isNegative ? `-$${absAmount}` : `$${absAmount}`;
    return showCurrency ? `${formatted} ${money.currency()}` : formatted;
  }

  /**
   * Форматирует Money компактно (сокращает большие числа)
   *
   * @remarks
   * Использует суффиксы K, M, B для тысяч, миллионов, миллиардов.
   * Полезно для отображения больших сумм в ограниченном пространстве.
   *
   * @param money - Money для форматирования
   * @param decimals - Количество десятичных знаков после сокращения (по умолчанию 1)
   * @returns Строка вида "$1.5K", "$2.3M", "$1.0B"
   *
   * @example
   * ```typescript
   * const m1 = Money.of(1500);
   * console.log(MoneyFormatter.toCompact(m1));        // "$1.5K"
   *
   * const m2 = Money.of(2300000);
   * console.log(MoneyFormatter.toCompact(m2));        // "$2.3M"
   *
   * const m3 = Money.of(1000000000);
   * console.log(MoneyFormatter.toCompact(m3));        // "$1.0B"
   *
   * const m4 = Money.of(999);
   * console.log(MoneyFormatter.toCompact(m4));        // "$999.0"
   * ```
   */
  public static toCompact(money: Money, decimals: number = 1): string {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      throw new RangeError('decimals argument must be a non-negative integer');
    }

    const absAmount = money.amount().abs();

    if (absAmount.greaterThanOrEqualTo(1_000_000_000)) {
      const billions = money.amount().dividedBy(1_000_000_000);
      return `$${billions.toFixed(decimals)}B`;
    }

    if (absAmount.greaterThanOrEqualTo(1_000_000)) {
      const millions = money.amount().dividedBy(1_000_000);
      return `$${millions.toFixed(decimals)}M`;
    }

    if (absAmount.greaterThanOrEqualTo(1_000)) {
      const thousands = money.amount().dividedBy(1_000);
      return `$${thousands.toFixed(decimals)}K`;
    }

    return `$${money.amount().toFixed(decimals)}`;
  }
}
