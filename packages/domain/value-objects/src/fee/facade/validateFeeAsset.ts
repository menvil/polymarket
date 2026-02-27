/**
 * Shared-функция полной валидации структуры AssetId для Fee
 *
 * @remarks
 * Используется в FeeService.create() и FeeSerializer.fromUnknown()
 * для единообразной валидации с предсказуемым reason=INVALID_ASSET.
 *
 * Порядок проверок для OUTCOME_TOKEN/ONCHAIN:
 * 1. Наличие conditionRef, outcomeKey
 * 2. conditionRef — object (не null)
 * 3. conditionRef.kind — строка и === 'ONCHAIN'
 * 4. protocolId — string, non-empty, валидный формат (нет '-', ':', '\'...)
 * 5. chainId — number
 * 6. conditionId — string, non-empty, hex-формат (0x + 64 hex-символа)
 * 7. outcomeKey — string, non-empty
 */

import { Err, Ok } from '@polymarket/result';
import type { Result } from '@polymarket/result';
import { InvalidFeeError } from '@polymarket/errors';
import { isSupportedCurrency, asOnChainProtocolId, isValidConditionId } from '@polymarket/ids';
import { FeeErrorReason } from '../errors/FeeErrorReason.js';

/**
 * Параметры контекста для сообщений об ошибках валидации
 */
interface ValidationContext {
  /** Имя сервиса для поля context.service */
  readonly service: string;
  /** Название операции для поля context.op */
  readonly op: string;
}

/**
 * Полная валидация структуры AssetId для Fee.
 *
 * @param asset - Значение для валидации
 * @param ctx   - Контекст: имя сервиса и операции (для error context)
 * @returns Ok(undefined) если asset корректен, иначе Err(InvalidFeeError)
 *
 * @remarks
 * Все ошибки возвращаются с reason=INVALID_ASSET, source=INPUT_VALIDATION.
 * Функция никогда не бросает исключений.
 *
 * @example
 * ```typescript
 * const result = validateFeeAsset(asset, { service: 'FeeService', op: 'create' });
 * if (!result.ok) return result;
 * ```
 */
export function validateFeeAsset(
  asset: unknown,
  ctx: ValidationContext
): Result<undefined, InvalidFeeError> {
  // 1. Должен быть непустой объект с полем type
  if (!asset || typeof asset !== 'object' || !('type' in asset)) {
    return Err(
      new InvalidFeeError('Invalid asset: must be object with type field', {
        context: { service: ctx.service, op: ctx.op, reason: FeeErrorReason.INVALID_ASSET, asset },
      })
    );
  }

  const assetObj = asset as Record<string, unknown>;

  // 2. type должен быть CURRENCY или OUTCOME_TOKEN
  if (assetObj.type !== 'CURRENCY' && assetObj.type !== 'OUTCOME_TOKEN') {
    return Err(
      new InvalidFeeError('Invalid asset type: must be CURRENCY or OUTCOME_TOKEN', {
        context: {
          service: ctx.service,
          op: ctx.op,
          reason: FeeErrorReason.INVALID_ASSET,
          assetType: assetObj.type,
        },
      })
    );
  }

  // 3. Валидация CURRENCY
  if (assetObj.type === 'CURRENCY') {
    const currency = assetObj.currency;
    if (typeof currency !== 'string') {
      return Err(
        new InvalidFeeError('Invalid CURRENCY asset: missing or invalid currency field', {
          context: { service: ctx.service, op: ctx.op, reason: FeeErrorReason.INVALID_ASSET, currency },
        })
      );
    }
    if (currency.length === 0) {
      return Err(
        new InvalidFeeError('Invalid CURRENCY asset: currency must be non-empty string', {
          context: { service: ctx.service, op: ctx.op, reason: FeeErrorReason.INVALID_ASSET, currency },
        })
      );
    }
    if (!isSupportedCurrency(currency)) {
      return Err(
        new InvalidFeeError(`Invalid CURRENCY asset: unsupported currency '${currency}'`, {
          context: { service: ctx.service, op: ctx.op, reason: FeeErrorReason.INVALID_ASSET, currency },
        })
      );
    }
    return Ok(undefined);
  }

  // 4. Валидация OUTCOME_TOKEN
  if (!('conditionRef' in assetObj) || !('outcomeKey' in assetObj)) {
    return Err(
      new InvalidFeeError('Invalid OUTCOME_TOKEN asset: missing conditionRef or outcomeKey', {
        context: {
          service: ctx.service,
          op: ctx.op,
          reason: FeeErrorReason.INVALID_ASSET,
          missingFields: [
            'conditionRef' in assetObj ? null : 'conditionRef',
            'outcomeKey' in assetObj ? null : 'outcomeKey',
          ].filter(Boolean),
        },
      })
    );
  }

  const conditionRef = assetObj.conditionRef;
  const outcomeKey = assetObj.outcomeKey;

  // 4a. conditionRef должен быть объектом
  if (typeof conditionRef !== 'object' || conditionRef === null) {
    return Err(
      new InvalidFeeError('Invalid OUTCOME_TOKEN asset: conditionRef must be object', {
        context: {
          service: ctx.service,
          op: ctx.op,
          reason: FeeErrorReason.INVALID_ASSET,
          conditionRef,
          conditionRefType: typeof conditionRef,
        },
      })
    );
  }

  const conditionRefObj = conditionRef as Record<string, unknown>;

  // 4b. conditionRef должен иметь поле kind
  if (!('kind' in conditionRefObj)) {
    return Err(
      new InvalidFeeError('Invalid OUTCOME_TOKEN asset: conditionRef must have kind field', {
        context: { service: ctx.service, op: ctx.op, reason: FeeErrorReason.INVALID_ASSET, conditionRef },
      })
    );
  }

  // 4c. kind должен быть строкой
  const kind = conditionRefObj.kind;
  if (typeof kind !== 'string') {
    return Err(
      new InvalidFeeError('Invalid OUTCOME_TOKEN asset: conditionRef.kind must be string', {
        context: {
          service: ctx.service,
          op: ctx.op,
          reason: FeeErrorReason.INVALID_ASSET,
          kind,
          kindType: typeof kind,
        },
      })
    );
  }

  // 4d. Только ONCHAIN поддерживается
  if (kind !== 'ONCHAIN') {
    return Err(
      new InvalidFeeError(`Invalid OUTCOME_TOKEN asset: unsupported conditionRef kind '${kind}'`, {
        context: {
          service: ctx.service,
          op: ctx.op,
          reason: FeeErrorReason.INVALID_ASSET,
          kind,
          supportedKinds: ['ONCHAIN'],
        },
      })
    );
  }

  // 4e. ONCHAIN: обязательные поля должны присутствовать
  if (
    !('protocolId' in conditionRefObj) ||
    !('chainId' in conditionRefObj) ||
    !('conditionId' in conditionRefObj)
  ) {
    return Err(
      new InvalidFeeError('Invalid OUTCOME_TOKEN asset: ONCHAIN conditionRef missing required fields', {
        context: {
          service: ctx.service,
          op: ctx.op,
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

  const protocolId = conditionRefObj.protocolId;
  const chainId = conditionRefObj.chainId;
  const conditionId = conditionRefObj.conditionId;

  // 4f. protocolId: string, non-empty, валидный формат [A-Z_][A-Z0-9_]{0,31}
  if (typeof protocolId !== 'string') {
    return Err(
      new InvalidFeeError('Invalid OUTCOME_TOKEN asset: protocolId must be string', {
        context: {
          service: ctx.service,
          op: ctx.op,
          reason: FeeErrorReason.INVALID_ASSET,
          protocolId,
          protocolIdType: typeof protocolId,
        },
      })
    );
  }
  if (asOnChainProtocolId(protocolId) === undefined) {
    return Err(
      new InvalidFeeError(
        `Invalid OUTCOME_TOKEN asset: protocolId '${protocolId}' has invalid format (must match [A-Z_][A-Z0-9_]{0,31})`,
        {
          context: {
            service: ctx.service,
            op: ctx.op,
            reason: FeeErrorReason.INVALID_ASSET,
            protocolId,
          },
        }
      )
    );
  }

  // 4g. chainId: number
  if (typeof chainId !== 'number') {
    return Err(
      new InvalidFeeError('Invalid OUTCOME_TOKEN asset: chainId must be number', {
        context: {
          service: ctx.service,
          op: ctx.op,
          reason: FeeErrorReason.INVALID_ASSET,
          chainId,
          chainIdType: typeof chainId,
        },
      })
    );
  }

  // 4h. conditionId: string, валидный hex-формат (0x + 64 hex-символа)
  if (typeof conditionId !== 'string') {
    return Err(
      new InvalidFeeError('Invalid OUTCOME_TOKEN asset: conditionId must be string', {
        context: {
          service: ctx.service,
          op: ctx.op,
          reason: FeeErrorReason.INVALID_ASSET,
          conditionId,
          conditionIdType: typeof conditionId,
        },
      })
    );
  }
  if (!isValidConditionId(conditionId)) {
    return Err(
      new InvalidFeeError(
        `Invalid OUTCOME_TOKEN asset: conditionId '${conditionId}' has invalid format (must be 0x + 64 hex chars)`,
        {
          context: {
            service: ctx.service,
            op: ctx.op,
            reason: FeeErrorReason.INVALID_ASSET,
            conditionId,
          },
        }
      )
    );
  }

  // 4i. outcomeKey: string, non-empty
  if (typeof outcomeKey !== 'string') {
    return Err(
      new InvalidFeeError('Invalid OUTCOME_TOKEN asset: outcomeKey must be string', {
        context: {
          service: ctx.service,
          op: ctx.op,
          reason: FeeErrorReason.INVALID_ASSET,
          outcomeKey,
          outcomeKeyType: typeof outcomeKey,
        },
      })
    );
  }
  if (outcomeKey.length === 0) {
    return Err(
      new InvalidFeeError('Invalid OUTCOME_TOKEN asset: outcomeKey must be non-empty string', {
        context: {
          service: ctx.service,
          op: ctx.op,
          reason: FeeErrorReason.INVALID_ASSET,
          outcomeKey,
        },
      })
    );
  }

  return Ok(undefined);
}
