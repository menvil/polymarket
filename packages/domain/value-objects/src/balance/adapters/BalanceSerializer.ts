import { Result, Err } from '@polymarket/result';
import { InvalidBalanceError, ErrorSource } from '@polymarket/errors';
import { Balance } from '../core/Balance.js';
import { BalanceService } from '../facade/BalanceService.js';
import { MoneySerializer } from '../../money/adapters/MoneySerializer.js';
import { BalanceErrorReason } from '../errors/BalanceErrorReason.js';

/**
 * Безопасная сериализация в JSON с обработкой циклических ссылок
 *
 * @param value - Значение для сериализации
 * @returns JSON строка
 *
 * @remarks
 * Заменяет циклические ссылки на "[Circular]" вместо выброса исключения.
 * Используется для читаемой диагностики ошибок.
 */
function safeStringify(value: unknown): string {
  try {
    const seen = new WeakSet();
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) {
          return '[Circular]';
        }
        seen.add(val);
      }
      return val;
    });
  } catch {
    return '[Unstringifiable]';
  }
}

/**
 * Тип для JSON представления Balance
 *
 * @remarks
 * Использует string для amount чтобы сохранить точность Decimal.
 */
export interface BalanceJSON {
  available: {
    amount: string;
    currency: string;
  };
  reserved: {
    amount: string;
    currency: string;
  };
}

/**
 * JSON сериализатор для Balance
 *
 * @remarks
 * ГРАНИЦА СИСТЕМЫ: принимает unknown, валидирует структуру.
 *
 * Отвечает за:
 * - Валидацию типов на границе (unknown → typed)
 * - Сериализацию/десериализацию JSON
 * - Читаемую диагностику через safeStringify
 * - Использует string для сохранения точности Decimal
 *
 * **Формат JSON:**
 * ```json
 * {
 *   "available": { "amount": "10000", "currency": "USDC" },
 *   "reserved": { "amount": "2000", "currency": "USDC" }
 * }
 * ```
 *
 * @example
 * ```typescript
 * import { BalanceSerializer } from '@polymarket/value-objects/balance';
 * import { Money } from '@polymarket/value-objects/money';
 *
 * // Десериализация
 * const result = BalanceSerializer.fromJSON({
 *   available: { amount: "10000", currency: "USDC" },
 *   reserved: { amount: "2000", currency: "USDC" }
 * });
 * if (result.ok) {
 *   console.log(result.value.total().value()); // 12000
 * }
 *
 * // Сериализация
 * const balance = expectOk(BalanceService.create(
 *   Money.fromUSDC(10000),
 *   Money.fromUSDC(2000)
 * ));
 * const json = BalanceSerializer.toJSON(balance);
 * console.log(json);
 * // {
 * //   available: { amount: "10000", currency: "USDC" },
 * //   reserved: { amount: "2000", currency: "USDC" }
 * // }
 * ```
 */
export class BalanceSerializer {
  private static readonly SERVICE_NAME = 'BalanceSerializer';
  /**
   * Десериализует Balance из JSON
   *
   * @remarks
   * Принимает unknown - граница валидации типов.
   * Валидирует структуру JSON перед парсингом.
   *
   * Этапы валидации:
   * 1. Проверка что json это объект (не null, array, primitive)
   * 2. Проверка наличия обязательных полей 'available' и 'reserved'
   * 3. Проверка типов полей (должны быть объектами)
   * 4. Десериализация available через MoneySerializer
   * 5. Десериализация reserved через MoneySerializer
   * 6. Делегирование BalanceService.create для бизнес-валидации
   *
   * @param json - JSON данные (unknown)
   * @returns Result с Balance или InvalidBalanceError
   *
   * @example
   * ```typescript
   * // ✅ Валидные примеры
   * BalanceSerializer.fromJSON({
   *   available: { amount: "10000", currency: "USDC" },
   *   reserved: { amount: "2000", currency: "USDC" }
   * });
   *
   * BalanceSerializer.fromJSON({
   *   available: { amount: 10000, currency: "USDC" },
   *   reserved: { amount: 2000, currency: "USDC" }
   * });
   *
   * // ❌ Структурные ошибки
   * BalanceSerializer.fromJSON(null);                    // Err: expected object
   * BalanceSerializer.fromJSON({ available: ... });      // Err: missing 'reserved'
   * BalanceSerializer.fromJSON({ reserved: ... });       // Err: missing 'available'
   * BalanceSerializer.fromJSON({ available: "...", ... }); // Err: invalid type
   *
   * // ❌ Бизнес-ошибки (делегированы BalanceService)
   * BalanceSerializer.fromJSON({
   *   available: { amount: "-100", currency: "USDC" },  // Err: negative available
   *   reserved: { amount: "0", currency: "USDC" }
   * });
   *
   * BalanceSerializer.fromJSON({
   *   available: { amount: "100", currency: "USDC" },
   *   reserved: { amount: "50", currency: "BTC" }       // Err: currency mismatch
   * });
   * ```
   */
  public static fromJSON(json: unknown): Result<Balance, InvalidBalanceError> {
    // 1. Проверка что json - объект
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      return Err(
        new InvalidBalanceError(`Expected object, got ${typeof json}`, {
          context: {
            source: ErrorSource.PARSING,
            service: BalanceSerializer.SERVICE_NAME,
            op: 'fromJSON',
            json: safeStringify(json),
            reason: BalanceErrorReason.INVALID_FORMAT
          }
        })
      );
    }

    const obj = json as Record<string, unknown>;

    // 2. Проверка наличия поля available
    if (!('available' in obj)) {
      return Err(
        new InvalidBalanceError(`Missing required field 'available'`, {
          context: {
            source: ErrorSource.PARSING,
            service: BalanceSerializer.SERVICE_NAME,
            op: 'fromJSON',
            json: safeStringify(json),
            reason: BalanceErrorReason.INVALID_FORMAT
          }
        })
      );
    }

    // 3. Проверка наличия поля reserved
    if (!('reserved' in obj)) {
      return Err(
        new InvalidBalanceError(`Missing required field 'reserved'`, {
          context: {
            source: ErrorSource.PARSING,
            service: BalanceSerializer.SERVICE_NAME,
            op: 'fromJSON',
            json: safeStringify(json),
            reason: BalanceErrorReason.INVALID_FORMAT
          }
        })
      );
    }

    // 4. Проверка типа available (должен быть объектом)
    if (
      typeof obj.available !== 'object' ||
      obj.available === null ||
      Array.isArray(obj.available)
    ) {
      return Err(
        new InvalidBalanceError(`Field 'available' must be an object`, {
          context: {
            source: ErrorSource.PARSING,
            service: BalanceSerializer.SERVICE_NAME,
            op: 'fromJSON',
            available: safeStringify(obj.available),
            reason: BalanceErrorReason.INVALID_FORMAT
          }
        })
      );
    }

    // 5. Проверка типа reserved (должен быть объектом)
    if (
      typeof obj.reserved !== 'object' ||
      obj.reserved === null ||
      Array.isArray(obj.reserved)
    ) {
      return Err(
        new InvalidBalanceError(`Field 'reserved' must be an object`, {
          context: {
            source: ErrorSource.PARSING,
            service: BalanceSerializer.SERVICE_NAME,
            op: 'fromJSON',
            reserved: safeStringify(obj.reserved),
            reason: BalanceErrorReason.INVALID_FORMAT
          }
        })
      );
    }

    // 6. Десериализация available через MoneySerializer
    const availableResult = MoneySerializer.fromJSON(obj.available);
    if (!availableResult.ok) {
      // Пробрасываем reason из ошибки Money, если он есть
      const errorContext = availableResult.error as unknown as { context?: { reason?: string } };
      const moneyReason = errorContext.context?.reason;
      const balanceReason = moneyReason === 'UNSUPPORTED_CURRENCY'
        ? BalanceErrorReason.UNSUPPORTED_CURRENCY
        : BalanceErrorReason.INVALID_FORMAT;

      return Err(
        new InvalidBalanceError(`Failed to deserialize 'available': ${availableResult.error.message}`, {
          context: {
            source: ErrorSource.PARSING,
            service: BalanceSerializer.SERVICE_NAME,
            op: 'fromJSON',
            field: 'available',
            available: safeStringify(obj.available),
            reason: balanceReason,
            cause: {
              name: availableResult.error.name,
              message: availableResult.error.message
            }
          }
        })
      );
    }

    // 7. Десериализация reserved через MoneySerializer
    const reservedResult = MoneySerializer.fromJSON(obj.reserved);
    if (!reservedResult.ok) {
      // Пробрасываем reason из ошибки Money, если он есть
      const errorContext = reservedResult.error as unknown as { context?: { reason?: string } };
      const moneyReason = errorContext.context?.reason;
      const balanceReason = moneyReason === 'UNSUPPORTED_CURRENCY'
        ? BalanceErrorReason.UNSUPPORTED_CURRENCY
        : BalanceErrorReason.INVALID_FORMAT;

      return Err(
        new InvalidBalanceError(`Failed to deserialize 'reserved': ${reservedResult.error.message}`, {
          context: {
            source: ErrorSource.PARSING,
            service: BalanceSerializer.SERVICE_NAME,
            op: 'fromJSON',
            field: 'reserved',
            reserved: safeStringify(obj.reserved),
            reason: balanceReason,
            cause: {
              name: reservedResult.error.name,
              message: reservedResult.error.message
            }
          }
        })
      );
    }

    // 8. Делегирование бизнес-валидации BalanceService
    return BalanceService.create(availableResult.value, reservedResult.value);
  }

  /**
   * Сериализует Balance в JSON
   *
   * @remarks
   * Возвращает plain object с полями available и reserved.
   * Каждое поле содержит { amount: string, currency: string }.
   * Используем string для amount чтобы избежать потери точности.
   *
   * @param balance - Balance для сериализации
   * @returns Plain object { available: {...}, reserved: {...} }
   *
   * @example
   * ```typescript
   * const balance = expectOk(BalanceService.create(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000)
   * ));
   *
   * const json = BalanceSerializer.toJSON(balance);
   * console.log(json);
   * // {
   * //   available: { amount: "10000", currency: "USDC" },
   * //   reserved: { amount: "2000", currency: "USDC" }
   * // }
   *
   * // Можно сериализовать в JSON строку
   * const jsonString = JSON.stringify(json);
   * console.log(jsonString);
   * // '{"available":{"amount":"10000","currency":"USDC"},"reserved":{"amount":"2000","currency":"USDC"}}'
   * ```
   */
  public static toJSON(balance: Balance): BalanceJSON {
    return {
      available: MoneySerializer.toJSON(balance.available()),
      reserved: MoneySerializer.toJSON(balance.reserved())
    };
  }
}
