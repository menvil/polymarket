import { Result, Err } from '@polymarket/result';
import { InvalidMoneyError, ErrorSource } from '@polymarket/errors';
import { Money, type SupportedCurrency } from '../core/Money.js';
import { MoneyService } from '../facade/MoneyService.js';
import { MoneyErrorReason } from '../errors/MoneyErrorReason.js';
import { safeStringify } from '../../shared/json/index.js';

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
      const displayedType = json === null ? 'null' : Array.isArray(json) ? 'array' : typeof json;
      return Err(
        new InvalidMoneyError(`Expected object, got ${displayedType}`, {
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
    if (!Object.hasOwn(obj, 'amount')) {
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
    if (!Object.hasOwn(obj, 'currency')) {
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
