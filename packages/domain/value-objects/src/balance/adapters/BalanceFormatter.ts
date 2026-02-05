import { Balance } from '../core/Balance.js';
import { MoneyFormatter } from '../../money/adapters/MoneyFormatter.js';
import { InvalidBalanceError, ErrorSource } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';

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
 *
 * const balance = Balance.of(
 *   Money.fromUSDC(10000),
 *   Money.fromUSDC(2000)
 * );
 *
 * console.log(expectOk(BalanceFormatter.toSummary(balance)));
 * // "Available: $10000.00, Reserved: $2000.00, Total: $12000.00 (16.67% reserved)"
 *
 * console.log(expectOk(BalanceFormatter.toCompact(balance)));
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
   * @returns Result с отформатированной строкой вида "Available: $X, Reserved: $Y, Total: $Z (P% reserved)" или ошибкой валидации
   * @throws Никогда не бросает исключения, возвращает Result
   *
   * @example
   * ```typescript
   * const balance = Balance.of(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000)
   * );
   *
   * const result1 = BalanceFormatter.toSummary(balance);
   * if (result1.ok) {
   *   console.log(result1.value);
   *   // "Available: $10000.00, Reserved: $2000.00, Total: $12000.00 (16.67% reserved)"
   * }
   *
   * // Ошибка валидации
   * const result2 = BalanceFormatter.toSummary(balance, -1);
   * if (!result2.ok) {
   *   console.log(result2.error.message); // ошибка валидации decimals
   * }
   * ```
   */
  public static toSummary(balance: Balance, decimals: number = 2): Result<string, InvalidBalanceError> {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      return Err(
        new InvalidBalanceError('decimals argument must be a non-negative integer', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            service: 'BalanceFormatter',
            op: 'toSummary',
            decimals: String(decimals)
          }
        })
      );
    }

    const availableResult = MoneyFormatter.toCurrency(balance.available(), false, decimals);
    if (!availableResult.ok) {
      return Err(
        new InvalidBalanceError('Failed to format available amount', {
          context: {
            source: ErrorSource.SERVICE_CALL,
            service: 'BalanceFormatter',
            op: 'toSummary',
            cause: availableResult.error
          }
        })
      );
    }

    const reservedResult = MoneyFormatter.toCurrency(balance.reserved(), false, decimals);
    if (!reservedResult.ok) {
      return Err(
        new InvalidBalanceError('Failed to format reserved amount', {
          context: {
            source: ErrorSource.SERVICE_CALL,
            service: 'BalanceFormatter',
            op: 'toSummary',
            cause: reservedResult.error
          }
        })
      );
    }

    const totalResult = MoneyFormatter.toCurrency(balance.total(), false, decimals);
    if (!totalResult.ok) {
      return Err(
        new InvalidBalanceError('Failed to format total amount', {
          context: {
            source: ErrorSource.SERVICE_CALL,
            service: 'BalanceFormatter',
            op: 'toSummary',
            cause: totalResult.error
          }
        })
      );
    }

    const percentage = balance.reservedPercentage().toFixed(2);

    return Ok(`Available: ${availableResult.value}, Reserved: ${reservedResult.value}, Total: ${totalResult.value} (${percentage}% reserved)`);
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
   * @returns Result с отформатированной строкой вида "Avail: $X | Res: $Y | Total: $Z" или ошибкой валидации
   * @throws Никогда не бросает исключения, возвращает Result
   *
   * @example
   * ```typescript
   * const balance = Balance.of(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000)
   * );
   *
   * const result = BalanceFormatter.toCompact(balance);
   * if (result.ok) {
   *   console.log(result.value);
   *   // "Avail: $10.0K | Res: $2.0K | Total: $12.0K"
   * }
   * ```
   */
  public static toCompact(balance: Balance, decimals: number = 1): Result<string, InvalidBalanceError> {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      return Err(
        new InvalidBalanceError('decimals argument must be a non-negative integer', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            service: 'BalanceFormatter',
            op: 'toCompact',
            decimals: String(decimals)
          }
        })
      );
    }

    const availableResult = MoneyFormatter.toCompact(balance.available(), decimals);
    if (!availableResult.ok) {
      return Err(
        new InvalidBalanceError('Failed to format available amount', {
          context: {
            source: ErrorSource.SERVICE_CALL,
            service: 'BalanceFormatter',
            op: 'toCompact',
            cause: availableResult.error
          }
        })
      );
    }

    const reservedResult = MoneyFormatter.toCompact(balance.reserved(), decimals);
    if (!reservedResult.ok) {
      return Err(
        new InvalidBalanceError('Failed to format reserved amount', {
          context: {
            source: ErrorSource.SERVICE_CALL,
            service: 'BalanceFormatter',
            op: 'toCompact',
            cause: reservedResult.error
          }
        })
      );
    }

    const totalResult = MoneyFormatter.toCompact(balance.total(), decimals);
    if (!totalResult.ok) {
      return Err(
        new InvalidBalanceError('Failed to format total amount', {
          context: {
            source: ErrorSource.SERVICE_CALL,
            service: 'BalanceFormatter',
            op: 'toCompact',
            cause: totalResult.error
          }
        })
      );
    }

    return Ok(`Avail: ${availableResult.value} | Res: ${reservedResult.value} | Total: ${totalResult.value}`);
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
  public static toAvailableString(
    balance: Balance,
    showCurrency: boolean = true,
    decimals: number = 2
  ): Result<string, InvalidBalanceError> {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      return Err(
        new InvalidBalanceError('decimals argument must be a non-negative integer', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            service: 'BalanceFormatter',
            op: 'toAvailableString',
            decimals: String(decimals)
          }
        })
      );
    }

    const result = MoneyFormatter.toCurrency(balance.available(), showCurrency, decimals);
    if (!result.ok) {
      return Err(
        new InvalidBalanceError('Failed to format available amount', {
          context: {
            source: ErrorSource.SERVICE_CALL,
            service: 'BalanceFormatter',
            op: 'toAvailableString',
            cause: result.error
          }
        })
      );
    }

    return result;
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
  public static toReservedString(
    balance: Balance,
    showCurrency: boolean = true,
    decimals: number = 2
  ): Result<string, InvalidBalanceError> {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      return Err(
        new InvalidBalanceError('decimals argument must be a non-negative integer', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            service: 'BalanceFormatter',
            op: 'toReservedString',
            decimals: String(decimals)
          }
        })
      );
    }

    const result = MoneyFormatter.toCurrency(balance.reserved(), showCurrency, decimals);
    if (!result.ok) {
      return Err(
        new InvalidBalanceError('Failed to format reserved amount', {
          context: {
            source: ErrorSource.SERVICE_CALL,
            service: 'BalanceFormatter',
            op: 'toReservedString',
            cause: result.error
          }
        })
      );
    }

    return result;
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
  public static toTotalString(
    balance: Balance,
    showCurrency: boolean = true,
    decimals: number = 2
  ): Result<string, InvalidBalanceError> {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      return Err(
        new InvalidBalanceError('decimals argument must be a non-negative integer', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            service: 'BalanceFormatter',
            op: 'toTotalString',
            decimals: String(decimals)
          }
        })
      );
    }

    const result = MoneyFormatter.toCurrency(balance.total(), showCurrency, decimals);
    if (!result.ok) {
      return Err(
        new InvalidBalanceError('Failed to format total amount', {
          context: {
            source: ErrorSource.SERVICE_CALL,
            service: 'BalanceFormatter',
            op: 'toTotalString',
            cause: result.error
          }
        })
      );
    }

    return result;
  }

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
  public static toPercentageString(balance: Balance, decimals: number = 2): Result<string, InvalidBalanceError> {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      return Err(
        new InvalidBalanceError('decimals argument must be a non-negative integer', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            service: 'BalanceFormatter',
            op: 'toPercentageString',
            decimals: String(decimals)
          }
        })
      );
    }

    return Ok(`${balance.reservedPercentage().toFixed(decimals)}%`);
  }
}
