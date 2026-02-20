import { Money } from '../core/Money';
import { InvalidMoneyError, ErrorSource } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';

/**
 * Максимально допустимое количество десятичных знаков для форматирования
 *
 * @remarks
 * Защита от чрезмерно большого количества decimals, которое может:
 * - Вызвать проблемы с производительностью
 * - Создать нечитаемый вывод
 * - Быть признаком ошибки в коде
 *
 * 20 десятичных знаков более чем достаточно для любых практических применений.
 */
const MAX_DECIMALS = 20;

/**
 * Валидирует параметр decimals
 *
 * @param decimals - Количество десятичных знаков для проверки
 * @param money - Money объект для контекста ошибки
 * @param op - Название операции для контекста ошибки
 * @returns Result с void или InvalidMoneyError
 */
function validateDecimals(
  decimals: number,
  money: Money,
  op: string
): Result<void, InvalidMoneyError> {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    return Err(
      new InvalidMoneyError('decimals argument must be a non-negative integer', {
        context: {
          source: ErrorSource.RULE_VALIDATION,
          service: 'MoneyFormatter',
          op,
          decimals: String(decimals),
          moneyValue: money.value().toString(),
          currency: money.currency()
        }
      })
    );
  }

  if (decimals > MAX_DECIMALS) {
    return Err(
      new InvalidMoneyError(`decimals argument must not exceed ${MAX_DECIMALS}`, {
        context: {
          source: ErrorSource.RULE_VALIDATION,
          service: 'MoneyFormatter',
          op,
          decimals: String(decimals),
          maxDecimals: String(MAX_DECIMALS),
          moneyValue: money.value().toString(),
          currency: money.currency()
        }
      })
    );
  }

  return Ok(undefined);
}

/**
 * Форматтер для Money
 *
 * @remarks
 * Предоставляет методы для форматирования Money в строки
 * для UI и логирования.
 *
 * Все методы возвращают Result для обработки ошибок валидации параметров.
 *
 * @example
 * ```typescript
 * import { Money, MoneyFormatter } from '@polymarket/value-objects/money';
 * import { expectOk } from '@polymarket/result';
 * import Decimal from 'decimal.js';
 *
 * const money = Money.of(new Decimal(100.50));
 *
 * console.log(expectOk(MoneyFormatter.toFixed(money, 2)));           // "100.50"
 * console.log(expectOk(MoneyFormatter.toCurrency(money)));           // "$100.50 USDC"
 * console.log(expectOk(MoneyFormatter.toCurrency(money, false)));    // "$100.50"
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
   * @returns Result с отформатированной строкой или ошибкой валидации
   * @throws Никогда не бросает исключения, возвращает Result
   *
   * @example
   * ```typescript
   * import Decimal from 'decimal.js';
   *
   * const money = Money.of(new Decimal(100.5));
   *
   * const result1 = MoneyFormatter.toFixed(money);
   * if (result1.ok) {
   *   console.log(result1.value);  // "100.50"
   * }
   *
   * const result2 = MoneyFormatter.toFixed(money, 0);
   * if (result2.ok) {
   *   console.log(result2.value);  // "101"
   * }
   *
   * // Ошибка валидации
   * const result3 = MoneyFormatter.toFixed(money, -1);
   * if (!result3.ok) {
   *   console.log(result3.error.message); // ошибка валидации decimals
   * }
   * ```
   */
  public static toFixed(money: Money, decimals: number = 2): Result<string, InvalidMoneyError> {
    const validationResult = validateDecimals(decimals, money, 'toFixed');
    if (!validationResult.ok) {
      return validationResult;
    }
    return Ok(money.value().toFixed(decimals));
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
   * @returns Result с отформатированной строкой вида "$100.50 USDC" или "$100.50", или ошибкой валидации
   * @throws Никогда не бросает исключения, возвращает Result
   *
   * @example
   * ```typescript
   * import Decimal from 'decimal.js';
   *
   * const money = Money.of(new Decimal(100.50));
   *
   * const result1 = MoneyFormatter.toCurrency(money);
   * if (result1.ok) {
   *   console.log(result1.value);  // "$100.50 USDC"
   * }
   *
   * const result2 = MoneyFormatter.toCurrency(money, false);
   * if (result2.ok) {
   *   console.log(result2.value);  // "$100.50"
   * }
   *
   * // Ошибка валидации
   * const result3 = MoneyFormatter.toCurrency(money, true, -1);
   * if (!result3.ok) {
   *   console.log(result3.error.message); // ошибка валидации decimals
   * }
   * ```
   */
  public static toCurrency(
    money: Money,
    showCurrency: boolean = true,
    decimals: number = 2
  ): Result<string, InvalidMoneyError> {
    const validationResult = validateDecimals(decimals, money, 'toCurrency');
    if (!validationResult.ok) {
      return validationResult;
    }

    const amount = money.value();
    const isNegative = amount.isNegative();
    const absAmount = amount.abs().toFixed(decimals);
    const formatted = isNegative ? `-$${absAmount}` : `$${absAmount}`;
    return Ok(showCurrency ? `${formatted} ${money.currency()}` : formatted);
  }

  /**
   * Форматирует Money компактно (сокращает большие числа)
   *
   * @remarks
   * Использует суффиксы K, M, B, T для тысяч, миллионов, миллиардов, триллионов.
   * Полезно для отображения больших сумм в ограниченном пространстве.
   *
   * @param money - Money для форматирования
   * @param decimals - Количество десятичных знаков после сокращения (по умолчанию 1)
   * @returns Result с отформатированной строкой вида "$1.5K", "$2.3M", "$1.0B", "$5.2T" или ошибкой валидации
   * @throws Никогда не бросает исключения, возвращает Result
   *
   * @example
   * ```typescript
   * import Decimal from 'decimal.js';
   *
   * const m1 = Money.of(new Decimal(1500));
   * const result1 = MoneyFormatter.toCompact(m1);
   * if (result1.ok) {
   *   console.log(result1.value);  // "$1.5K"
   * }
   *
   * const m2 = Money.of(new Decimal(2300000));
   * const result2 = MoneyFormatter.toCompact(m2);
   * if (result2.ok) {
   *   console.log(result2.value);  // "$2.3M"
   * }
   *
   * const m3 = Money.of(new Decimal(5200000000000));
   * const result3 = MoneyFormatter.toCompact(m3);
   * if (result3.ok) {
   *   console.log(result3.value);  // "$5.2T"
   * }
   *
   * // Ошибка валидации
   * const result4 = MoneyFormatter.toCompact(m1, -1);
   * if (!result4.ok) {
   *   console.log(result4.error.message); // ошибка валидации decimals
   * }
   * ```
   */
  public static toCompact(money: Money, decimals: number = 1): Result<string, InvalidMoneyError> {
    const validationResult = validateDecimals(decimals, money, 'toCompact');
    if (!validationResult.ok) {
      return validationResult;
    }

    const amount = money.value();
    const absAmount = amount.abs();
    const sign = amount.isNegative() ? '-' : '';

    if (absAmount.greaterThanOrEqualTo(1_000_000_000_000)) {
      const trillions = absAmount.dividedBy(1_000_000_000_000);
      return Ok(`${sign}$${trillions.toFixed(decimals)}T`);
    }

    if (absAmount.greaterThanOrEqualTo(1_000_000_000)) {
      const billions = absAmount.dividedBy(1_000_000_000);
      return Ok(`${sign}$${billions.toFixed(decimals)}B`);
    }

    if (absAmount.greaterThanOrEqualTo(1_000_000)) {
      const millions = absAmount.dividedBy(1_000_000);
      return Ok(`${sign}$${millions.toFixed(decimals)}M`);
    }

    if (absAmount.greaterThanOrEqualTo(1_000)) {
      const thousands = absAmount.dividedBy(1_000);
      return Ok(`${sign}$${thousands.toFixed(decimals)}K`);
    }

    return Ok(`${sign}$${absAmount.toFixed(decimals)}`);
  }
}
