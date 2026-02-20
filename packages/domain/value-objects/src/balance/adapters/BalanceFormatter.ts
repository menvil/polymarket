import { Balance } from '../core/Balance';
import { Money } from '../../money/core/Money';
import { MoneyFormatter } from '../../money/adapters/MoneyFormatter';
import { InvalidBalanceError, ErrorSource } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';
import { accountIdToString } from '@polymarket/ids';

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
export class BalanceFormatter {
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
  public static toSummary(
    balance: Balance,
    decimals: number = 2,
    includeAccount: boolean = false,
    includeVenue: boolean = false
  ): Result<string, InvalidBalanceError> {
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

    let result = `Available: ${availableResult.value}, Reserved: ${reservedResult.value}, Total: ${totalResult.value} (${percentage}% reserved)`;

    // Добавляем accountId и venueId если запрошено
    if (includeAccount || includeVenue) {
      const parts: string[] = [];
      if (includeAccount) {
        parts.push(`Account: ${accountIdToString(balance.accountId())}`);
      }
      if (includeVenue) {
        parts.push(`Venue: ${balance.venueId()}`);
      }
      result += ` [${parts.join(', ')}]`;
    }

    return Ok(result);
  }

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
  public static toCompact(balance: Balance, decimals: number = 1, includeVenue: boolean = false): Result<string, InvalidBalanceError> {
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

    let result = `Avail: ${availableResult.value} | Res: ${reservedResult.value} | Total: ${totalResult.value}`;

    // Добавляем venueId если запрошено
    if (includeVenue) {
      result += ` @ ${balance.venueId()}`;
    }

    return Ok(result);
  }

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
  public static toDebugString(balance: Balance): string {
    const available = `${balance.available().value().toString()} ${balance.currency()}`;
    const reserved = `${balance.reserved().value().toString()} ${balance.currency()}`;
    const total = `${balance.total().value().toString()} ${balance.currency()}`;
    const account = accountIdToString(balance.accountId());
    const venue = balance.venueId();

    return `Balance(available: ${available}, reserved: ${reserved}, total: ${total}, account: ${account}, venue: ${venue})`;
  }

  /**
   * Внутренний helper для форматирования поля баланса (available/reserved/total)
   *
   * @param money - Money для форматирования
   * @param fieldName - Название поля для контекста ошибки ('available', 'reserved', 'total')
   * @param op - Название операции для контекста ошибки
   * @param showCurrency - Показывать ли код валюты
   * @param decimals - Количество десятичных знаков
   * @returns Result с отформатированной строкой или ошибкой
   *
   * @remarks
   * DRY helper для toAvailableString/toReservedString/toTotalString.
   * Инкапсулирует:
   * - Валидацию decimals
   * - Форматирование через MoneyFormatter
   * - Стандартную обработку ошибок с правильным context
   */
  private static formatBalanceField(
    money: Money,
    fieldName: string,
    op: string,
    showCurrency: boolean,
    decimals: number
  ): Result<string, InvalidBalanceError> {
    // Валидация decimals
    if (decimals < 0 || !Number.isInteger(decimals)) {
      return Err(
        new InvalidBalanceError('decimals argument must be a non-negative integer', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            service: 'BalanceFormatter',
            op,
            decimals: String(decimals)
          }
        })
      );
    }

    // Форматирование через MoneyFormatter
    const result = MoneyFormatter.toCurrency(money, showCurrency, decimals);
    if (!result.ok) {
      return Err(
        new InvalidBalanceError(`Failed to format ${fieldName} amount`, {
          context: {
            source: ErrorSource.SERVICE_CALL,
            service: 'BalanceFormatter',
            op,
            cause: result.error
          }
        })
      );
    }

    return result;
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
   * import Decimal from 'decimal.js';
   *
   * const balance = Balance.of(
   *   Money.of(new Decimal(10000), 'USDC'),
   *   Money.of(new Decimal(2000), 'USDC'),
   *   accountId,
   *   venueId
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
    return this.formatBalanceField(
      balance.available(),
      'available',
      'toAvailableString',
      showCurrency,
      decimals
    );
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
   * import Decimal from 'decimal.js';
   *
   * const balance = Balance.of(
   *   Money.of(new Decimal(10000), 'USDC'),
   *   Money.of(new Decimal(2000), 'USDC'),
   *   accountId,
   *   venueId
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
    return this.formatBalanceField(
      balance.reserved(),
      'reserved',
      'toReservedString',
      showCurrency,
      decimals
    );
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
   * import Decimal from 'decimal.js';
   *
   * const balance = Balance.of(
   *   Money.of(new Decimal(10000), 'USDC'),
   *   Money.of(new Decimal(2000), 'USDC'),
   *   accountId,
   *   venueId
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
    return this.formatBalanceField(
      balance.total(),
      'total',
      'toTotalString',
      showCurrency,
      decimals
    );
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
