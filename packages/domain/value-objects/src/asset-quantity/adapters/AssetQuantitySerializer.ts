import { Result, Err } from '@polymarket/result';
import { ErrorSource, InvalidAssetQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { parseAssetId, assetIdToString } from '@polymarket/ids';
import { Quantity } from '../../quantity/core/Quantity.js';
import { AssetQuantity } from '../core/AssetQuantity.js';
import { AssetQuantityService } from '../facade/AssetQuantityService.js';
import { AssetQuantityErrorReason } from '../errors/index.js';
import { safeStringify } from '../../shared/json/index.js';

/**
 * JSON контракт для AssetQuantity сериализации
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
export interface AssetQuantityJSON {
  /**
   * Asset identifier в строковом формате
   * Examples:
   * - "CURRENCY:USDC"
   * - "OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xabc...:UP"
   */
  asset: string;

  /**
   * Amount as string (preserves precision)
   */
  amount: string;
}

/**
 * JSON сериализатор для AssetQuantity
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
 * - toJSON ВСЕГДА возвращает валидный AssetQuantityJSON
 * - Все ошибки возвращаются через Result.Err
 *
 * @example
 * ```typescript
 * import { AssetQuantitySerializer } from '@polymarket/value-objects/asset-quantity';
 *
 * // Десериализация
 * const json = {
 *   asset: 'CURRENCY:USDC',
 *   amount: '100.5'
 * };
 * const result = AssetQuantitySerializer.fromJSON(json);
 * if (result.ok) {
 *   console.log(result.value.amount().toNumber()); // 100.5
 *   console.log(result.value.isCurrency()); // true
 * }
 *
 * // Сериализация
 * const assetQty = expectOk(AssetQuantityService.createUsdc(100.5));
 * const serialized = AssetQuantitySerializer.toJSON(assetQty);
 * // → { asset: 'CURRENCY:USDC', amount: '100.5' }
 * ```
 */
export class AssetQuantitySerializer {
  /**
   * Десериализует AssetQuantity из JSON
   *
   * @remarks
   * Принимает unknown - граница валидации типов.
   * Валидирует структуру JSON перед парсингом.
   *
   * Этапы валидации:
   * 1. Проверка что json это объект
   * 2. Проверка наличия обязательных полей (asset, amount)
   * 3. Парсинг asset через parseAssetId
   * 4. Парсинг amount как Decimal
   * 5. Создание AssetQuantity через AssetQuantityService.create
   *
   * @param json - JSON данные (unknown)
   * @param source - Источник ошибки (опционально)
   * @returns Result с AssetQuantity или InvalidAssetQuantityError
   *
   * @example
   * ```typescript
   * // ✅ Валидный пример (USDC)
   * AssetQuantitySerializer.fromJSON({
   *   asset: 'CURRENCY:USDC',
   *   amount: '100.5'
   * });
   *
   * // ✅ Валидный пример (OutcomeToken)
   * AssetQuantitySerializer.fromJSON({
   *   asset: 'OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xabc...:UP',
   *   amount: '50.25'
   * });
   *
   * // ❌ Структурные ошибки
   * AssetQuantitySerializer.fromJSON(null);                    // Err: expected object
   * AssetQuantitySerializer.fromJSON({});                      // Err: missing fields
   * AssetQuantitySerializer.fromJSON({ asset: 'invalid', amount: '100' }); // Err: invalid asset
   * ```
   */
  public static fromJSON(
    json: unknown,
    source: ErrorSource = ErrorSource.PARSING
  ): Result<AssetQuantity, InvalidAssetQuantityError> {
    // Проверка что это объект
    if (typeof json !== 'object' || json === null) {
      return Err(
        new InvalidAssetQuantityError(
          (ctx) => `Expected object, got ${ctx.type}`,
          {
            context: {
              source,
              service: 'AssetQuantitySerializer',
              op: 'fromJSON',
              reason: AssetQuantityErrorReason.INVALID_FORMAT,
              type: typeof json,
              json: safeStringify(json),
            },
          }
        )
      );
    }

    // Проверка что это не массив
    if (Array.isArray(json)) {
      return Err(
        new InvalidAssetQuantityError(
          () => 'Expected object, got array',
          {
            context: {
              source,
              service: 'AssetQuantitySerializer',
              op: 'fromJSON',
              reason: AssetQuantityErrorReason.INVALID_FORMAT,
              type: 'array',
              json: safeStringify(json),
            },
          }
        )
      );
    }

    const obj = json as Record<string, unknown>;

    // Проверка наличия asset
    if (!Object.hasOwn(obj, 'asset')) {
      return Err(
        new InvalidAssetQuantityError(
          () => "Missing required field 'asset'",
          {
            context: {
              source,
              service: 'AssetQuantitySerializer',
              op: 'fromJSON',
              reason: AssetQuantityErrorReason.INVALID_FORMAT,
              json: safeStringify(json),
            },
          }
        )
      );
    }

    // Проверка наличия amount
    if (!Object.hasOwn(obj, 'amount')) {
      return Err(
        new InvalidAssetQuantityError(
          () => "Missing required field 'amount'",
          {
            context: {
              source,
              service: 'AssetQuantitySerializer',
              op: 'fromJSON',
              reason: AssetQuantityErrorReason.INVALID_FORMAT,
              json: safeStringify(json),
            },
          }
        )
      );
    }

    // Парсим asset
    const assetValue = obj.asset;
    if (typeof assetValue !== 'string') {
      return Err(
        new InvalidAssetQuantityError(
          (ctx) => `Field 'asset' must be string, got ${ctx.type}`,
          {
            context: {
              source,
              service: 'AssetQuantitySerializer',
              op: 'fromJSON',
              reason: AssetQuantityErrorReason.INVALID_ASSET,
              type: typeof assetValue,
            },
          }
        )
      );
    }

    const assetId = parseAssetId(assetValue);
    if (!assetId) {
      return Err(
        new InvalidAssetQuantityError(
          (ctx) => `Failed to parse asset: '${ctx.asset}'`,
          {
            context: {
              source,
              service: 'AssetQuantitySerializer',
              op: 'fromJSON',
              reason: AssetQuantityErrorReason.INVALID_ASSET,
              asset: assetValue,
            },
          }
        )
      );
    }

    // Проверка что amount это строка
    const amountValue = obj.amount;
    if (typeof amountValue !== 'string') {
      return Err(
        new InvalidAssetQuantityError(
          (ctx) => `Field 'amount' must be string, got ${ctx.type}`,
          {
            context: {
              source,
              service: 'AssetQuantitySerializer',
              op: 'fromJSON',
              reason: AssetQuantityErrorReason.INVALID_AMOUNT,
              type: typeof amountValue,
            },
          }
        )
      );
    }

    // Парсим amount как Decimal
    let amountDecimal: Decimal;
    try {
      amountDecimal = new Decimal(amountValue);
    } catch (error) {
      return Err(
        new InvalidAssetQuantityError(
          (ctx) =>
            `Failed to parse amount as Decimal: ${ctx.error}`,
          {
            context: {
              source,
              service: 'AssetQuantitySerializer',
              op: 'fromJSON',
              reason: AssetQuantityErrorReason.INVALID_AMOUNT,
              amount: amountValue,
              error: error instanceof Error ? error.message : String(error),
            },
          }
        )
      );
    }

    // Создаём Quantity
    let quantity: Quantity;
    try {
      quantity = Quantity.of(amountDecimal);
    } catch (error) {
      return Err(
        new InvalidAssetQuantityError(
          (ctx) =>
            `Failed to create Quantity: ${ctx.error}`,
          {
            context: {
              source,
              service: 'AssetQuantitySerializer',
              op: 'fromJSON',
              reason: AssetQuantityErrorReason.INVALID_AMOUNT,
              amount: amountValue,
              error: error instanceof Error ? error.message : String(error),
            },
          }
        )
      );
    }

    // Создаём AssetQuantity через сервис (без source - он определяется wrapOp)
    return AssetQuantityService.create(assetId, quantity);
  }

  /**
   * Сериализует AssetQuantity в JSON объект
   *
   * @param assetQty - AssetQuantity для сериализации
   * @returns AssetQuantityJSON объект
   *
   * @remarks
   * Возвращает строго типизированный AssetQuantityJSON.
   * Гарантирует что все поля присутствуют и имеют правильные типы.
   *
   * Asset сериализуется через assetIdToString для компактности.
   * Amount сериализуется как строка для сохранения точности.
   *
   * @example
   * ```typescript
   * // USDC
   * const usdcQty = expectOk(AssetQuantityService.createUsdc(100.5));
   * const json = AssetQuantitySerializer.toJSON(usdcQty);
   * // → { asset: 'CURRENCY:USDC', amount: '100.5' }
   *
   * // OutcomeToken
   * const tokenQty = expectOk(AssetQuantityService.createOutcomeToken(conditionRef, BinaryOutcome.UP, 50));
   * const json2 = AssetQuantitySerializer.toJSON(tokenQty);
   * // → { asset: 'OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xabc...:UP', amount: '50' }
   * ```
   */
  public static toJSON(assetQty: AssetQuantity): AssetQuantityJSON {
    return {
      asset: assetIdToString(assetQty.asset()),
      amount: assetQty.amount().value().toString(),
    };
  }
}
