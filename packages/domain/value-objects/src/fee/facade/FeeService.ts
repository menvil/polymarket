/**
 * Фасад для работы с Fee - публичный API
 *
 * @remarks
 * Публичный API для работы с Fee со строгой валидацией.
 *
 * **Result-based методы (Never Throws):**
 * - `create()` - создание Fee с валидацией (Result<Fee, InvalidFeeError>)
 * - `add()` - сложение fees (Result<Fee, FeeOperationError>)
 *
 * **Простые методы:**
 * - `of()` - marked @internal, создание без валидации
 * - `zero()` - создание нулевой комиссии
 * - `equals()` - проверка равенства
 *
 * @example
 * ```typescript
 * import { FeeService } from '@polymarket/value-objects';
 * import { AssetIdHelpers } from '@polymarket/ids';
 *
 * // Result-based create
 * const result = FeeService.create(AssetIdHelpers.USDC, 0.10);
 * if (result.ok) {
 *   console.log(result.value.quantity.amount().toNumber()); // 0.1
 * }
 *
 * // Result-based add
 * const addResult = FeeService.add(fee1, fee2);
 * if (addResult.ok) {
 *   console.log(addResult.value.quantity.amount().toNumber());
 * }
 * ```
 */

import type { AssetId } from '@polymarket/ids';
import { isSupportedCurrency } from '@polymarket/ids';
import { Result, Ok, Err, isErr } from '@polymarket/result';
import { InvalidFeeError, toDecimal, rewrap, wrapOp } from '@polymarket/errors';
import type Decimal from 'decimal.js';
import { AssetQuantity } from '../../asset-quantity/index.js';
import { Quantity } from '../../quantity/index.js';
import { Fee, FeeErrorReason, FeeOperationError, FeeOperationErrorReason } from '../index.js';

export class FeeService {
  private static readonly SERVICE_NAME = 'FeeService';

  /**
   * Создать Fee с валидацией
   *
   * @param asset - AssetId (currency или outcome token)
   * @param amount - Сумма комиссии (number, string, или Decimal)
   * @returns Result<Fee, InvalidFeeError>
   *
   * @remarks
   * Проверяет инварианты:
   * - amount должен быть finite (не NaN, не Infinity)
   * - amount должен быть >= 0 (non-negative)
   * - asset должен быть валидный AssetId
   *
   * Это основной метод для создания Fee. Never throws - все ошибки через Result.
   *
   * @example
   * ```typescript
   * import { FeeService } from '@polymarket/value-objects';
   * import { AssetIdHelpers } from '@polymarket/ids';
   *
   * // Создание из number
   * const result = FeeService.create(AssetIdHelpers.USDC, 0.10);
   * if (result.ok) {
   *   console.log(result.value.quantity.amount().toNumber()); // 0.1
   * } else {
   *   console.error(result.error.message);
   * }
   *
   * // Создание из string (для точности)
   * const preciseResult = FeeService.create(AssetIdHelpers.USDC, '0.123456789012345');
   * if (preciseResult.ok) {
   *   console.log(preciseResult.value.quantity.amount().value().toString());
   * }
   *
   * // Ошибки валидации
   * const negativeResult = FeeService.create(AssetIdHelpers.USDC, -10);
   * expect(negativeResult.ok).toBe(false);
   * if (!negativeResult.ok) {
   *   console.log(negativeResult.error.context.reason); // FeeErrorReason.NEGATIVE_FEE
   * }
   * ```
   */
  public static create(
    asset: AssetId,
    amount: number | string | Decimal
  ): Result<Fee, InvalidFeeError> {
    const ctx = { asset, amount };

    return wrapOp(
      FeeService.SERVICE_NAME,
      'create',
      ctx,
      () => {
        // 1. Parse amount → Decimal
        const amountDecimal = toDecimal('amount', amount, FeeErrorReason.INVALID_QUANTITY, InvalidFeeError);
        if (isErr(amountDecimal)) {
          return Err(rewrap(FeeService.SERVICE_NAME, 'create', ctx, amountDecimal.error, InvalidFeeError));
        }

        const decimal = amountDecimal.value;

        // 2. Validate non-negative (finite check already done by toDecimal)
        if (decimal.lessThan(0)) {
          return Err(
            new InvalidFeeError('Fee amount must be non-negative', {
              context: {
                service: FeeService.SERVICE_NAME,
                op: 'create',
                reason: FeeErrorReason.NEGATIVE_FEE,
                amount: decimal.toString(),
              },
            })
          );
        }

        // 4. Validate AssetId structure
        if (!asset || typeof asset !== 'object' || !('type' in asset)) {
          return Err(
            new InvalidFeeError('Invalid asset: must be object with type field', {
              context: {
                service: FeeService.SERVICE_NAME,
                op: 'create',
                reason: FeeErrorReason.INVALID_ASSET,
                asset,
              },
            })
          );
        }

        // 4a. Validate asset type
        const assetObj = asset as { type: unknown };
        if (assetObj.type !== 'CURRENCY' && assetObj.type !== 'OUTCOME_TOKEN') {
          return Err(
            new InvalidFeeError('Invalid asset type: must be CURRENCY or OUTCOME_TOKEN', {
              context: {
                service: FeeService.SERVICE_NAME,
                op: 'create',
                reason: FeeErrorReason.INVALID_ASSET,
                assetType: assetObj.type,
              },
            })
          );
        }

        // 4b. Validate CURRENCY specific fields
        if (assetObj.type === 'CURRENCY') {
          const currencyField = 'currency' in assetObj ? (assetObj as Record<string, unknown>).currency : undefined;
          if (typeof currencyField !== 'string') {
            return Err(
              new InvalidFeeError('Invalid CURRENCY asset: missing or invalid currency field', {
                context: {
                  service: FeeService.SERVICE_NAME,
                  op: 'create',
                  reason: FeeErrorReason.INVALID_ASSET,
                  currency: currencyField,
                },
              })
            );
          }
          // Validate currency is non-empty string
          if (currencyField.length === 0) {
            return Err(
              new InvalidFeeError('Invalid CURRENCY asset: currency must be non-empty string', {
                context: {
                  service: FeeService.SERVICE_NAME,
                  op: 'create',
                  reason: FeeErrorReason.INVALID_ASSET,
                  currency: currencyField,
                },
              })
            );
          }
          // Validate currency is supported
          if (!isSupportedCurrency(currencyField)) {
            return Err(
              new InvalidFeeError(`Invalid CURRENCY asset: unsupported currency '${currencyField}'`, {
                context: {
                  service: FeeService.SERVICE_NAME,
                  op: 'create',
                  reason: FeeErrorReason.INVALID_ASSET,
                  currency: currencyField,
                },
              })
            );
          }
        }

        // 4c. Validate OUTCOME_TOKEN specific fields
        if (assetObj.type === 'OUTCOME_TOKEN') {
          // Check fields exist
          if (!('conditionRef' in assetObj) || !('outcomeKey' in assetObj)) {
            return Err(
              new InvalidFeeError('Invalid OUTCOME_TOKEN asset: missing conditionRef or outcomeKey', {
                context: {
                  service: FeeService.SERVICE_NAME,
                  op: 'create',
                  reason: FeeErrorReason.INVALID_ASSET,
                  missingFields: [
                    'conditionRef' in assetObj ? null : 'conditionRef',
                    'outcomeKey' in assetObj ? null : 'outcomeKey',
                  ].filter(Boolean),
                },
              })
            );
          }

          const tokenObj = assetObj as Record<string, unknown>;
          const conditionRef = tokenObj.conditionRef;
          const outcomeKey = tokenObj.outcomeKey;

          // Validate conditionRef is object (not null, not primitive)
          if (typeof conditionRef !== 'object' || conditionRef === null) {
            return Err(
              new InvalidFeeError('Invalid OUTCOME_TOKEN asset: conditionRef must be object', {
                context: {
                  service: FeeService.SERVICE_NAME,
                  op: 'create',
                  reason: FeeErrorReason.INVALID_ASSET,
                  conditionRef,
                  conditionRefType: typeof conditionRef,
                },
              })
            );
          }

          // Validate conditionRef has 'kind' field
          if (!('kind' in conditionRef)) {
            return Err(
              new InvalidFeeError('Invalid OUTCOME_TOKEN asset: conditionRef must have kind field', {
                context: {
                  service: FeeService.SERVICE_NAME,
                  op: 'create',
                  reason: FeeErrorReason.INVALID_ASSET,
                  conditionRef,
                },
              })
            );
          }

          // Validate kind is string
          const kind = (conditionRef as Record<string, unknown>).kind;
          if (typeof kind !== 'string') {
            return Err(
              new InvalidFeeError('Invalid OUTCOME_TOKEN asset: conditionRef.kind must be string', {
                context: {
                  service: FeeService.SERVICE_NAME,
                  op: 'create',
                  reason: FeeErrorReason.INVALID_ASSET,
                  kind,
                  kindType: typeof kind,
                },
              })
            );
          }

          // Validate kind is a supported value (only ONCHAIN is supported)
          if (kind !== 'ONCHAIN') {
            return Err(
              new InvalidFeeError(`Invalid OUTCOME_TOKEN asset: unsupported conditionRef kind '${kind}'`, {
                context: {
                  service: FeeService.SERVICE_NAME,
                  op: 'create',
                  reason: FeeErrorReason.INVALID_ASSET,
                  kind,
                  supportedKinds: ['ONCHAIN'],
                },
              })
            );
          }

          // Validate ONCHAIN-specific fields (kind === 'ONCHAIN' гарантирован проверкой выше)
          const conditionRefObj = conditionRef as Record<string, unknown>;

          // Check required fields exist
          if (!('protocolId' in conditionRefObj) || !('chainId' in conditionRefObj) || !('conditionId' in conditionRefObj)) {
            return Err(
              new InvalidFeeError('Invalid OUTCOME_TOKEN asset: ONCHAIN conditionRef missing required fields', {
                context: {
                  service: FeeService.SERVICE_NAME,
                  op: 'create',
                  reason: FeeErrorReason.INVALID_ASSET,
                  kind: 'ONCHAIN',
                  missingFields: [
                    'protocolId' in conditionRefObj ? null : 'protocolId',
                    'chainId' in conditionRefObj ? null : 'chainId',
                    'conditionId' in conditionRefObj ? null : 'conditionId',
                  ].filter(Boolean),
                },
              })
            );
          }

          // Validate protocolId is string
          const protocolId = conditionRefObj.protocolId;
          if (typeof protocolId !== 'string') {
            return Err(
              new InvalidFeeError('Invalid OUTCOME_TOKEN asset: protocolId must be string', {
                context: {
                  service: FeeService.SERVICE_NAME,
                  op: 'create',
                  reason: FeeErrorReason.INVALID_ASSET,
                  protocolId,
                  protocolIdType: typeof protocolId,
                },
              })
            );
          }

          // Validate protocolId is non-empty
          if (protocolId.length === 0) {
            return Err(
              new InvalidFeeError('Invalid OUTCOME_TOKEN asset: protocolId must be non-empty string', {
                context: {
                  service: FeeService.SERVICE_NAME,
                  op: 'create',
                  reason: FeeErrorReason.INVALID_ASSET,
                  protocolId,
                },
              })
            );
          }

          // Validate chainId is number
          const chainId = conditionRefObj.chainId;
          if (typeof chainId !== 'number') {
            return Err(
              new InvalidFeeError('Invalid OUTCOME_TOKEN asset: chainId must be number', {
                context: {
                  service: FeeService.SERVICE_NAME,
                  op: 'create',
                  reason: FeeErrorReason.INVALID_ASSET,
                  chainId,
                  chainIdType: typeof chainId,
                },
              })
            );
          }

          // Validate conditionId is string
          const conditionId = conditionRefObj.conditionId;
          if (typeof conditionId !== 'string') {
            return Err(
              new InvalidFeeError('Invalid OUTCOME_TOKEN asset: conditionId must be string', {
                context: {
                  service: FeeService.SERVICE_NAME,
                  op: 'create',
                  reason: FeeErrorReason.INVALID_ASSET,
                  conditionId,
                  conditionIdType: typeof conditionId,
                },
              })
            );
          }

          // Validate conditionId is non-empty
          if (conditionId.length === 0) {
            return Err(
              new InvalidFeeError('Invalid OUTCOME_TOKEN asset: conditionId must be non-empty string', {
                context: {
                  service: FeeService.SERVICE_NAME,
                  op: 'create',
                  reason: FeeErrorReason.INVALID_ASSET,
                  conditionId,
                },
              })
            );
          }

          // Validate outcomeKey is string
          if (typeof outcomeKey !== 'string') {
            return Err(
              new InvalidFeeError('Invalid OUTCOME_TOKEN asset: outcomeKey must be string', {
                context: {
                  service: FeeService.SERVICE_NAME,
                  op: 'create',
                  reason: FeeErrorReason.INVALID_ASSET,
                  outcomeKey,
                  outcomeKeyType: typeof outcomeKey,
                },
              })
            );
          }

          // Validate outcomeKey is non-empty
          if (outcomeKey.length === 0) {
            return Err(
              new InvalidFeeError('Invalid OUTCOME_TOKEN asset: outcomeKey must be non-empty string', {
                context: {
                  service: FeeService.SERVICE_NAME,
                  op: 'create',
                  reason: FeeErrorReason.INVALID_ASSET,
                  outcomeKey,
                },
              })
            );
          }
        }

        // 5. Create AssetQuantity and Fee
        // ВАЖНО: Валидация выше (шаги 1-4c) должна предотвратить большинство AssetQuantity/Fee ошибок.
        // Проверяется структура asset (type, обязательные поля, типы), но не все edge cases
        // (например, сложная вложенная структура conditionRef для non-ONCHAIN типов).
        // Любые исключения на этом этапе будут обработаны как UNEXPECTED_ERROR через wrapOp.
        const quantity = Quantity.of(decimal);
        const assetQuantity = new AssetQuantity(asset, quantity);
        const fee = Fee.of(assetQuantity);

        return Ok(fee);
      },
      InvalidFeeError
    );
  }

  /**
   * Создать Fee из AssetQuantity
   *
   * @param quantity - Количество актива (должно быть >= 0)
   * @returns Fee
   *
   * @remarks
   * AssetQuantity уже гарантирует amount >= 0 через Quantity инвариант,
   * поэтому дополнительная валидация не требуется.
   *
   * @example
   * ```typescript
   * const qty = Quantity.of(new Decimal('0.10'));
   * const assetQty = AssetQuantity.usdc(qty);
   * const fee = FeeService.of(assetQty);
   * console.log(fee.quantity.amount().toNumber()); // 0.10
   * ```
   */
  public static of(quantity: AssetQuantity): Fee {
    return Fee.of(quantity);
  }

  /**
   * Создать нулевую комиссию для указанного актива
   *
   * @param asset - Asset identifier
   * @returns Fee с amount = 0
   *
   * @example
   * ```typescript
   * import { AssetIdHelpers } from '@polymarket/ids';
   *
   * const zeroFee = FeeService.zero(AssetIdHelpers.USDC);
   * console.log(zeroFee.isZero()); // true
   * ```
   */
  public static zero(asset: AssetId): Fee {
    return Fee.zero(asset);
  }

  /**
   * Сложить две комиссии
   *
   * @param fee1 - Первая комиссия
   * @param fee2 - Вторая комиссия
   * @returns Result<Fee, FeeOperationError>
   *
   * @remarks
   * Never throws - все ошибки через Result.
   * Проверяет что assets совпадают перед сложением.
   *
   * @example
   * ```typescript
   * import { FeeService, FeeOperationErrorReason } from '@polymarket/value-objects';
   *
   * const result = FeeService.add(fee1, fee2);
   * if (result.ok) {
   *   console.log(result.value.quantity.amount().toNumber());
   * } else {
   *   if (result.error.context?.reason === FeeOperationErrorReason.ASSET_MISMATCH) {
   *     console.error('Cannot add fees with different assets');
   *   }
   * }
   * ```
   */
  public static add(fee1: Fee, fee2: Fee): Result<Fee, FeeOperationError> {
    try {
      const result = fee1.add(fee2);
      return Ok(result);
    } catch (e) {
      if (e instanceof FeeOperationError) {
        return Err(e);
      }
      // Wrap unexpected errors to maintain Never Throws contract
      return Err(
        new FeeOperationError(
          `Unexpected error during fee addition: ${e instanceof Error ? e.message : String(e)}`,
          {
            context: {
              operation: 'add',
              reason: FeeOperationErrorReason.UNEXPECTED_ERROR,
              originalError: e instanceof Error ? e.name : typeof e,
              fee1Amount: fee1.quantity.amount().value().toString(),
              fee2Amount: fee2.quantity.amount().value().toString(),
            },
          }
        )
      );
    }
  }

  /**
   * Проверить равенство двух fees
   *
   * @param fee1 - Первая Fee
   * @param fee2 - Вторая Fee
   * @returns true если fees равны
   *
   * @example
   * ```typescript
   * if (FeeService.equals(fee1, fee2)) {
   *   console.log('Same fee');
   * }
   * ```
   */
  public static equals(fee1: Fee, fee2: Fee): boolean {
    return fee1.equals(fee2);
  }
}
