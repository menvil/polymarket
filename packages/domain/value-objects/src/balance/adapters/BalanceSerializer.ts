import { Result, Err } from '@polymarket/result';
import { InvalidBalanceError, ErrorSource } from '@polymarket/errors';
import { accountIdToString, parseAccountId, asVenueId } from '@polymarket/ids';
import { Balance } from '../core/Balance';
import { BalanceService } from '../facade/BalanceService';
import { Money } from '../../money/core/Money';
import { MoneySerializer } from '../../money/adapters/MoneySerializer';
import { BalanceErrorReason } from '../errors/BalanceErrorReason';

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
 * Helper для десериализации Money поля с стандартной обработкой ошибок
 *
 * @param fieldObj - Объект поля для десериализации
 * @param fieldName - Имя поля ('available' или 'reserved')
 * @returns Result<Money, InvalidBalanceError>
 *
 * @remarks
 * DRY helper для fromJSON - инкапсулирует:
 * - Вызов MoneySerializer.fromJSON
 * - Проброс reason из Money ошибки (UNSUPPORTED_CURRENCY)
 * - Стандартное оборачивание в InvalidBalanceError с правильным context
 */
function deserializeMoneyField(
  fieldObj: unknown,
  fieldName: string
): Result<Money, InvalidBalanceError> {
  const moneyResult = MoneySerializer.fromJSON(fieldObj);
  if (!moneyResult.ok) {
    // Пробрасываем reason из ошибки Money, если он есть
    const errorContext = moneyResult.error as { context?: { reason?: string } };
    const moneyReason = errorContext.context?.reason;
    const balanceReason = moneyReason === 'UNSUPPORTED_CURRENCY'
      ? BalanceErrorReason.UNSUPPORTED_CURRENCY
      : BalanceErrorReason.INVALID_FORMAT;

    return Err(
      new InvalidBalanceError(`Failed to deserialize '${fieldName}': ${moneyResult.error.message}`, {
        context: {
          source: ErrorSource.PARSING,
          service: 'BalanceSerializer',
          op: 'fromJSON',
          field: fieldName,
          [fieldName]: safeStringify(fieldObj),
          reason: balanceReason,
          cause: {
            name: moneyResult.error.name,
            message: moneyResult.error.message
          }
        }
      })
    );
  }

  return moneyResult;
}

/**
 * JSON контракт для Balance сериализации
 *
 * @remarks
 * Используется как:
 * - Контракт API (документация структуры)
 * - Return type для toJSON()
 * - Type hint при создании JSON
 *
 * При парсинге (fromJSON) НЕ полагайся на этот тип -
 * делай полную runtime валидацию с unknown!
 *
 * Использует string для amount чтобы сохранить точность Decimal.
 *
 * @example
 * ```json
 * {
 *   "available": { "amount": "10000", "currency": "USDC" },
 *   "reserved": { "amount": "2000", "currency": "USDC" },
 *   "accountId": "wallet:0x1234567890123456789012345678901234567890",
 *   "venueId": "POLYMARKET"
 * }
 * ```
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
  accountId: string;
  venueId: string;
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
 * Контракт:
 * - fromJSON НИКОГДА не доверяет типам, делает полную проверку
 * - toJSON ВСЕГДА возвращает валидный BalanceJSON
 * - Все ошибки возвращаются через Result.Err
 *
 * **Формат JSON:**
 * ```json
 * {
 *   "available": { "amount": "10000", "currency": "USDC" },
 *   "reserved": { "amount": "2000", "currency": "USDC" },
 *   "accountId": "wallet:0x1234567890123456789012345678901234567890",
 *   "venueId": "POLYMARKET"
 * }
 * ```
 *
 * @example
 * ```typescript
 * import { BalanceSerializer } from '@polymarket/value-objects/balance';
 * import { Money } from '@polymarket/value-objects/money';
 * import type { AccountId, VenueId, WalletAddress } from '@polymarket/ids';
 *
 * // Десериализация
 * const result = BalanceSerializer.fromJSON({
 *   available: { amount: "10000", currency: "USDC" },
 *   reserved: { amount: "2000", currency: "USDC" },
 *   accountId: "wallet:0x1234567890123456789012345678901234567890",
 *   venueId: "POLYMARKET"
 * });
 * if (result.ok) {
 *   console.log(result.value.total().value()); // 12000
 * }
 *
 * // Сериализация
 * const accountId: AccountId = { kind: 'WALLET', address: '0x...' as WalletAddress };
 * const venueId: VenueId = 'POLYMARKET' as VenueId;
 *
 * const balance = expectOk(BalanceService.create(
 *   Money.fromUSDC(10000),
 *   Money.fromUSDC(2000),
 *   accountId,
 *   venueId
 * ));
 * const json = BalanceSerializer.toJSON(balance);
 * console.log(json);
 * // {
 * //   available: { amount: "10000", currency: "USDC" },
 * //   reserved: { amount: "2000", currency: "USDC" },
 * //   accountId: "wallet:0x...",
 * //   venueId: "POLYMARKET"
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
   * 3. Проверка типов полей available/reserved (должны быть объектами)
   * 4. Десериализация available через MoneySerializer
   * 5. Десериализация reserved через MoneySerializer
   * 6. Проверка наличия обязательных полей 'accountId' и 'venueId'
   * 7. Проверка типов полей accountId/venueId (должны быть строками)
   * 8. Парсинг accountId через parseAccountId()
   * 9. Создание VenueId (branded string)
   * 10. Делегирование BalanceService.create для бизнес-валидации
   *
   * @param json - JSON данные (unknown)
   * @returns Result с Balance или InvalidBalanceError
   *
   * @example
   * ```typescript
   * // ✅ Валидные примеры
   * BalanceSerializer.fromJSON({
   *   available: { amount: "10000", currency: "USDC" },
   *   reserved: { amount: "2000", currency: "USDC" },
   *   accountId: "wallet:0x1234567890123456789012345678901234567890",
   *   venueId: "POLYMARKET"
   * });
   *
   * // ❌ Структурные ошибки
   * BalanceSerializer.fromJSON(null);                    // Err: expected object
   * BalanceSerializer.fromJSON({ available: ... });      // Err: missing 'reserved'
   * BalanceSerializer.fromJSON({
   *   available: ...,
   *   reserved: ...
   * });  // Err: missing 'accountId'
   *
   * // ❌ Бизнес-ошибки (делегированы BalanceService)
   * BalanceSerializer.fromJSON({
   *   available: { amount: "-100", currency: "USDC" },  // Err: negative available
   *   reserved: { amount: "0", currency: "USDC" },
   *   accountId: "wallet:0x...",
   *   venueId: "POLYMARKET"
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

    // 6. Десериализация available через helper (используем DRY helper вместо дублирования кода)
    const availableResult = deserializeMoneyField(obj.available, 'available');
    if (!availableResult.ok) {
      return availableResult;
    }

    // 7. Десериализация reserved через helper (используем DRY helper вместо дублирования кода)
    const reservedResult = deserializeMoneyField(obj.reserved, 'reserved');
    if (!reservedResult.ok) {
      return reservedResult;
    }

    // 8. Проверка наличия поля accountId
    if (!('accountId' in obj)) {
      return Err(
        new InvalidBalanceError(`Missing required field 'accountId'`, {
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

    // 9. Проверка наличия поля venueId
    if (!('venueId' in obj)) {
      return Err(
        new InvalidBalanceError(`Missing required field 'venueId'`, {
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

    // 10. Проверка типа accountId (должен быть строкой)
    if (typeof obj.accountId !== 'string') {
      return Err(
        new InvalidBalanceError(`Field 'accountId' must be a string`, {
          context: {
            source: ErrorSource.PARSING,
            service: BalanceSerializer.SERVICE_NAME,
            op: 'fromJSON',
            accountId: safeStringify(obj.accountId),
            reason: BalanceErrorReason.INVALID_FORMAT
          }
        })
      );
    }

    // 11. Проверка типа venueId (должен быть строкой)
    if (typeof obj.venueId !== 'string') {
      return Err(
        new InvalidBalanceError(`Field 'venueId' must be a string`, {
          context: {
            source: ErrorSource.PARSING,
            service: BalanceSerializer.SERVICE_NAME,
            op: 'fromJSON',
            venueId: safeStringify(obj.venueId),
            reason: BalanceErrorReason.INVALID_FORMAT
          }
        })
      );
    }

    // 12. Парсинг accountId через parseAccountId()
    const accountId = parseAccountId(obj.accountId);
    if (!accountId) {
      return Err(
        new InvalidBalanceError(`Invalid accountId format: ${obj.accountId}`, {
          context: {
            source: ErrorSource.PARSING,
            service: BalanceSerializer.SERVICE_NAME,
            op: 'fromJSON',
            accountId: obj.accountId,
            reason: BalanceErrorReason.INVALID_FORMAT
          }
        })
      );
    }

    // 13. Валидация venueId через asVenueId()
    const venueId = asVenueId(obj.venueId);
    if (!venueId) {
      return Err(
        new InvalidBalanceError(
          `Field 'venueId' has invalid format. Must be uppercase letters, digits, underscores, 1-32 chars, not starting with digit`,
          {
            context: {
              source: ErrorSource.PARSING,
              service: BalanceSerializer.SERVICE_NAME,
              op: 'fromJSON',
              venueId: obj.venueId,
              reason: BalanceErrorReason.INVALID_FORMAT
            }
          }
        )
      );
    }

    // 14. Делегирование бизнес-валидации BalanceService
    return BalanceService.create(
      availableResult.value,
      reservedResult.value,
      accountId,
      venueId
    );
  }

  /**
   * Сериализует Balance в JSON
   *
   * @remarks
   * Возвращает plain object с полями available, reserved, accountId и venueId.
   * Каждое поле available/reserved содержит { amount: string, currency: string }.
   * Используем string для amount чтобы избежать потери точности.
   * accountId сериализуется через accountIdToString() в canonical format.
   * venueId сериализуется как string (branded VenueId).
   *
   * @param balance - Balance для сериализации
   * @returns Plain object { available: {...}, reserved: {...}, accountId: string, venueId: string }
   *
   * @example
   * ```typescript
   * const accountId: AccountId = { kind: 'WALLET', address: '0x...' as WalletAddress };
   * const venueId: VenueId = 'POLYMARKET' as VenueId;
   *
   * const balance = expectOk(BalanceService.create(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000),
   *   accountId,
   *   venueId
   * ));
   *
   * const json = BalanceSerializer.toJSON(balance);
   * console.log(json);
   * // {
   * //   available: { amount: "10000", currency: "USDC" },
   * //   reserved: { amount: "2000", currency: "USDC" },
   * //   accountId: "wallet:0x...",
   * //   venueId: "POLYMARKET"
   * // }
   *
   * // Можно сериализовать в JSON строку
   * const jsonString = JSON.stringify(json);
   * ```
   */
  public static toJSON(balance: Balance): BalanceJSON {
    return {
      available: MoneySerializer.toJSON(balance.available()),
      reserved: MoneySerializer.toJSON(balance.reserved()),
      accountId: accountIdToString(balance.accountId()),
      venueId: balance.venueId()
    };
  }
}
