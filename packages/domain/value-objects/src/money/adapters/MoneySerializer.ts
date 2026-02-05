import { Result, Ok, Err } from '@polymarket/result';
import { InvalidMoneyError, InvalidOperandError, ErrorSource } from '@polymarket/errors';
import { Money, type SupportedCurrency } from '../core/Money.js';
import { MoneyService } from '../facade/MoneyService.js';
import { MoneyErrorReason } from '../errors/MoneyErrorReason.js';

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
 * JSON контракт для Money сериализации
 *
 * @remarks
 * Используется как:
 * - Контракт API (документация структуры)
 * - Return type для toJSON()
 * - Type hint при создании JSON
 *
 * При парсинге (fromJSON) НЕ полагайся на этот тип -
 * делай полную runtime валидацию с unknown!
 */
export interface MoneyJSON {
  /**
   * Amount as string для сохранения точности
   */
  amount: string;

  /**
   * Currency code (USDC, etc.)
   */
  currency: string;
}

/**
 * JSON контракт для lossy сериализации (number)
 *
 * @remarks
 * ⚠️ ВНИМАНИЕ: Использует number, может привести к потере точности.
 * Для точной сериализации используй MoneyJSON.
 */
export interface MoneyLossyJSON {
  /**
   * Amount as number (может потерять точность)
   */
  amount: number;

  /**
   * Currency code (USDC, etc.)
   */
  currency: string;
}

/**
 * JSON сериализатор для Money
 *
 * @remarks
 * ГРАНИЦА СИСТЕМЫ: принимает unknown, валидирует структуру.
 *
 * Отвечает за:
 * - Валидацию типов на границе (unknown → typed)
 * - Сериализацию/десериализацию JSON
 * - Читаемую диагностику через safeStringify
 *
 * Контракт:
 * - fromJSON НИКОГДА не доверяет типам, делает полную проверку
 * - toJSON ВСЕГДА возвращает валидный MoneyJSON
 * - Все ошибки возвращаются через Result.Err
 *
 * @example
 * ```typescript
 * import { MoneySerializer } from '@polymarket/value-objects/money';
 *
 * // Десериализация
 * const result = MoneySerializer.fromJSON({ amount: 100.50, currency: 'USDC' });
 * if (result.ok) {
 *   console.log(result.value.toNumber()); // 100.5
 * }
 *
 * // Сериализация
 * const money = Money.of(100.50);
 * const json = MoneySerializer.toJSON(money);
 * console.log(json); // { amount: "100.5", currency: "USDC" }
 * ```
 */
export class MoneySerializer {
  private static readonly SERVICE_NAME = 'MoneySerializer';
  /**
   * Десериализует Money из JSON
   *
   * @remarks
   * Принимает unknown - граница валидации типов.
   * Валидирует структуру JSON перед парсингом.
   *
   * Этапы валидации:
   * 1. Проверка что json это объект (не null, array, primitive)
   * 2. Проверка наличия обязательных полей 'amount' и 'currency'
   * 3. Проверка типов полей
   * 4. Делегирование MoneyService.create для бизнес-валидации
   *
   * @param json - JSON данные (unknown)
   * @returns Result с Money или InvalidMoneyError
   *
   * @example
   * ```typescript
   * // ✅ Валидные примеры
   * MoneySerializer.fromJSON({ amount: 100, currency: 'USDC' });
   * MoneySerializer.fromJSON({ amount: "100.50", currency: 'USDC' });
   *
   * // ❌ Невалидные примеры
   * MoneySerializer.fromJSON(null);                    // not an object
   * MoneySerializer.fromJSON({ amount: 100 });         // missing currency
   * MoneySerializer.fromJSON({ currency: 'USDC' });    // missing amount
   * MoneySerializer.fromJSON({ amount: null, currency: 'USDC' }); // invalid amount type
   * ```
   */
  public static fromJSON(json: unknown): Result<Money, InvalidMoneyError> {
    // 1. Проверка что json - объект
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      return Err(
        new InvalidMoneyError(`Expected object, got ${typeof json}`, {
          context: {
            source: ErrorSource.PARSING,
            service: MoneySerializer.SERVICE_NAME,
            op: 'fromJSON',
            json: safeStringify(json),
            reason: MoneyErrorReason.INVALID_FORMAT,
          },
        })
      );
    }

    const obj = json as Record<string, unknown>;

    // 2. Проверка наличия поля amount
    if (!('amount' in obj)) {
      return Err(
        new InvalidMoneyError(`Missing required field 'amount'`, {
          context: {
            source: ErrorSource.PARSING,
            service: MoneySerializer.SERVICE_NAME,
            op: 'fromJSON',
            json: safeStringify(json),
            reason: MoneyErrorReason.INVALID_FORMAT,
          },
        })
      );
    }

    // 3. Проверка наличия поля currency
    if (!('currency' in obj)) {
      return Err(
        new InvalidMoneyError(`Missing required field 'currency'`, {
          context: {
            source: ErrorSource.PARSING,
            service: MoneySerializer.SERVICE_NAME,
            op: 'fromJSON',
            json: safeStringify(json),
            reason: MoneyErrorReason.INVALID_FORMAT,
          },
        })
      );
    }

    // 4. Проверка типа amount
    const { amount, currency } = obj;
    if (typeof amount !== 'number' && typeof amount !== 'string') {
      return Err(
        new InvalidMoneyError(`Field 'amount' must be number or string`, {
          context: {
            source: ErrorSource.PARSING,
            service: MoneySerializer.SERVICE_NAME,
            op: 'fromJSON',
            amount: safeStringify(amount),
            reason: MoneyErrorReason.INVALID_FORMAT,
          },
        })
      );
    }

    // 5. Проверка типа currency
    if (typeof currency !== 'string') {
      return Err(
        new InvalidMoneyError(`Field 'currency' must be string`, {
          context: {
            source: ErrorSource.PARSING,
            service: MoneySerializer.SERVICE_NAME,
            op: 'fromJSON',
            currency: safeStringify(currency),
            reason: MoneyErrorReason.INVALID_FORMAT,
          },
        })
      );
    }

    // 6. Делегирование бизнес-валидации MoneyService
    return MoneyService.create(amount, currency as SupportedCurrency);
  }

  /**
   * Сериализует Money в JSON объект
   *
   * @param money - Money для сериализации
   * @returns MoneyJSON объект с amount (string) и currency
   *
   * @remarks
   * Возвращает строго типизированный MoneyJSON.
   * Используем string для amount чтобы сохранить точность.
   * Гарантирует что все поля присутствуют и имеют правильные типы.
   *
   * @example
   * ```typescript
   * const money = Money.of(100.50);
   * const json = MoneySerializer.toJSON(money);
   * console.log(json); // { amount: "100.5", currency: "USDC" }
   *
   * // Можно сериализовать в JSON строку
   * const jsonString = JSON.stringify(json);
   * console.log(jsonString); // '{"amount":"100.5","currency":"USDC"}'
   * ```
   */
  public static toJSON(money: Money): MoneyJSON {
    return {
      amount: money.value().toString(),
      currency: money.currency(),
    };
  }
}

/**
 * Lossy serializer для случаев когда точность не критична
 *
 * @remarks
 * ⚠️ ВНИМАНИЕ: Использует number, что может привести к потере точности.
 * Используйте только для отображения или когда точность не критична.
 * Для точной сериализации используйте MoneySerializer.
 */
export class MoneyLossySerializer {
  private static readonly SERVICE_NAME = 'MoneyLossySerializer';

  /**
   * Сериализует Money в JSON объект (lossy)
   *
   * @param money - Money для сериализации
   * @returns Result с MoneyLossyJSON или ошибкой
   *
   * @remarks
   * ⚠️ ВНИМАНИЕ: Может потерять точность для больших чисел.
   * Использует number вместо string.
   *
   * @example
   * ```typescript
   * const result = MoneyLossySerializer.toJSON(money);
   * if (result.ok) {
   *   console.log(result.value); // { amount: 100.50, currency: "USDC" }
   * }
   * ```
   */
  public static toJSON(money: Money): Result<MoneyLossyJSON, InvalidOperandError> {
    const decimalValue = money.value();
    if (!decimalValue.isFinite()) {
      return Err(
        new InvalidOperandError(
          (ctx) => `Cannot serialize non-finite Money to JSON, got ${ctx.value}`,
          {
            context: {
              source: ErrorSource.PARSING,
              service: MoneyLossySerializer.SERVICE_NAME,
              op: 'toJSON',
              value: decimalValue.toString(),
              operation: 'toJSON'
            }
          }
        )
      );
    }
    return Ok({
      amount: money.toNumber(),
      currency: money.currency()
    });
  }

  /**
   * Десериализует Money из JSON (lossy)
   *
   * @param json - MoneyLossyJSON объект { amount: number, currency: string }
   * @returns Result с Money или InvalidMoneyError
   *
   * @example
   * ```typescript
   * const result = MoneyLossySerializer.fromJSON({ amount: 100.50, currency: 'USDC' });
   * ```
   */
  public static fromJSON(json: MoneyLossyJSON): Result<Money, InvalidMoneyError> {
    return MoneyService.create(json.amount, json.currency as SupportedCurrency);
  }
}
