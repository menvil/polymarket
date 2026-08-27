import { Result, Err } from '@polymarket/result';
import { ErrorSource, InvalidOutcomeTokenError } from '@polymarket/errors';
import type { OnChainConditionRef } from '@polymarket/ids';
import {
  parseOutcomeKey,
  asOnChainProtocolId,
  parseChainId,
  parseConditionId,
} from '@polymarket/ids';
import { OutcomeToken } from '../core/OutcomeToken.js';
import { OutcomeTokenService } from '../facade/OutcomeTokenService.js';
import { safeStringify } from '../../shared/json/index.js';

/**
 * JSON контракт для OutcomeToken сериализации
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
export interface OutcomeTokenJSON {
  /**
   * On-chain condition reference
   */
  conditionRef: {
    kind: 'ONCHAIN';
    protocolId: string;
    chainId: number;
    conditionId: string;
  };

  /**
   * Outcome key (UP, DOWN, etc)
   */
  outcomeKey: string;
}

/**
 * JSON сериализатор для OutcomeToken
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
 * - toJSON ВСЕГДА возвращает валидный OutcomeTokenJSON
 * - Все ошибки возвращаются через Result.Err
 *
 * @example
 * ```typescript
 * import { OutcomeTokenSerializer } from '@polymarket/value-objects/outcome-token';
 *
 * // Десериализация
 * const json = {
 *   conditionRef: {
 *     kind: 'ONCHAIN',
 *     protocolId: 'POLYMARKET_CTF',
 *     chainId: 137,
 *     conditionId: '0xabc...'
 *   },
 *   outcomeKey: 'UP'
 * };
 * const result = OutcomeTokenSerializer.fromJSON(json);
 * if (result.ok) {
 *   console.log(result.value.outcomeKey()); // 'UP'
 * }
 *
 * // Сериализация
 * const token = expectOk(OutcomeTokenService.create(onChainRef, BinaryOutcome.UP));
 * const serialized = OutcomeTokenSerializer.toJSON(token);
 * ```
 */
export class OutcomeTokenSerializer {
  private static readonly SERVICE_NAME = 'OutcomeTokenSerializer';

  /**
   * Десериализует OutcomeToken из JSON
   *
   * @remarks
   * Принимает unknown - граница валидации типов.
   * Валидирует структуру JSON перед парсингом.
   *
   * Этапы валидации:
   * 1. Проверка что json это объект
   * 2. Проверка наличия обязательных полей (conditionRef, outcomeKey)
   * 3. Проверка структуры conditionRef
   * 4. Делегирование OutcomeTokenService.create для создания
   *
   * @param json - JSON данные (unknown)
   * @param source - Источник ошибки (опционально)
   * @returns Result с OutcomeToken или InvalidOutcomeTokenError
   *
   * @example
   * ```typescript
   * // ✅ Валидный пример
   * OutcomeTokenSerializer.fromJSON({
   *   conditionRef: { kind: 'ONCHAIN', protocolId: '...', chainId: 137, conditionId: '0x...' },
   *   outcomeKey: 'UP'
   * });
   *
   * // ❌ Структурные ошибки
   * OutcomeTokenSerializer.fromJSON(null);                    // Err: expected object
   * OutcomeTokenSerializer.fromJSON({});                      // Err: missing fields
   * OutcomeTokenSerializer.fromJSON({ conditionRef: {} });    // Err: invalid conditionRef
   * ```
   */
  public static fromJSON(
    json: unknown,
    source: ErrorSource = ErrorSource.PARSING
  ): Result<OutcomeToken, InvalidOutcomeTokenError> {
    // Проверка что это объект
    if (typeof json !== 'object' || json === null) {
      return Err(
        new InvalidOutcomeTokenError(
          (ctx) => `Expected object, got ${ctx.type}`,
          {
            context: {
              source,
              service: OutcomeTokenSerializer.SERVICE_NAME,
              op: 'fromJSON',
              kind: 'invalid_json',
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
        new InvalidOutcomeTokenError(
          () => 'Expected object, got array',
          {
            context: {
              source,
              service: OutcomeTokenSerializer.SERVICE_NAME,
              op: 'fromJSON',
              kind: 'invalid_json',
              type: 'array',
              json: safeStringify(json),
            },
          }
        )
      );
    }

    const obj = json as Record<string, unknown>;

    // Проверка наличия conditionRef
    if (!Object.hasOwn(obj, 'conditionRef')) {
      return Err(
        new InvalidOutcomeTokenError(
          () => "Missing required field 'conditionRef'",
          {
            context: {
              source,
              service: OutcomeTokenSerializer.SERVICE_NAME,
              op: 'fromJSON',
              kind: 'invalid_json',
              type: 'missing_field',
              json: safeStringify(json),
            },
          }
        )
      );
    }

    // Проверка наличия outcomeKey
    if (!Object.hasOwn(obj, 'outcomeKey')) {
      return Err(
        new InvalidOutcomeTokenError(
          () => "Missing required field 'outcomeKey'",
          {
            context: {
              source,
              service: OutcomeTokenSerializer.SERVICE_NAME,
              op: 'fromJSON',
              kind: 'invalid_json',
              type: 'missing_field',
              json: safeStringify(json),
            },
          }
        )
      );
    }

    // Валидация conditionRef
    const conditionRef = obj.conditionRef;
    if (typeof conditionRef !== 'object' || conditionRef === null || Array.isArray(conditionRef)) {
      return Err(
        new InvalidOutcomeTokenError(
          (ctx) => `Field 'conditionRef' must be object, got ${ctx.type}`,
          {
            context: {
              source,
              service: OutcomeTokenSerializer.SERVICE_NAME,
              op: 'fromJSON',
              kind: 'invalid_condition_ref',
              type: typeof conditionRef,
              json: safeStringify(json),
            },
          }
        )
      );
    }

    const refObj = conditionRef as Record<string, unknown>;

    // Проверка полей conditionRef
    if (
      !Object.hasOwn(refObj, 'kind') ||
      !Object.hasOwn(refObj, 'protocolId') ||
      !Object.hasOwn(refObj, 'chainId') ||
      !Object.hasOwn(refObj, 'conditionId')
    ) {
      return Err(
        new InvalidOutcomeTokenError(
          () =>
            'ConditionRef missing required fields (kind, protocolId, chainId, conditionId)',
          {
            context: {
              source,
              service: OutcomeTokenSerializer.SERVICE_NAME,
              op: 'fromJSON',
              kind: 'invalid_condition_ref',
              conditionRef: safeStringify(conditionRef),
            },
          }
        )
      );
    }

    // Проверка что kind === 'ONCHAIN'
    if (refObj.kind !== 'ONCHAIN') {
      return Err(
        new InvalidOutcomeTokenError(
          (ctx) => `ConditionRef.kind must be 'ONCHAIN', got ${ctx.conditionRefKind}`,
          {
            context: {
              source,
              service: OutcomeTokenSerializer.SERVICE_NAME,
              op: 'fromJSON',
              kind: 'not_onchain_condition',
              conditionRefKind: refObj.kind,
            },
          }
        )
      );
    }

    // Проверка типов полей conditionRef
    if (typeof refObj.protocolId !== 'string') {
      return Err(
        new InvalidOutcomeTokenError(
          (ctx) => `Field 'protocolId' must be string, got ${ctx.type}`,
          {
            context: {
              source,
              service: OutcomeTokenSerializer.SERVICE_NAME,
              op: 'fromJSON',
              kind: 'invalid_condition_ref',
              type: typeof refObj.protocolId,
            },
          }
        )
      );
    }

    if (typeof refObj.chainId !== 'number') {
      return Err(
        new InvalidOutcomeTokenError(
          (ctx) => `Field 'chainId' must be number, got ${ctx.type}`,
          {
            context: {
              source,
              service: OutcomeTokenSerializer.SERVICE_NAME,
              op: 'fromJSON',
              kind: 'invalid_condition_ref',
              type: typeof refObj.chainId,
            },
          }
        )
      );
    }

    if (typeof refObj.conditionId !== 'string') {
      return Err(
        new InvalidOutcomeTokenError(
          (ctx) => `Field 'conditionId' must be string, got ${ctx.type}`,
          {
            context: {
              source,
              service: OutcomeTokenSerializer.SERVICE_NAME,
              op: 'fromJSON',
              kind: 'invalid_condition_ref',
              type: typeof refObj.conditionId,
            },
          }
        )
      );
    }

    // Проверка outcomeKey
    const outcomeKeyValue = obj.outcomeKey;
    if (typeof outcomeKeyValue !== 'string') {
      return Err(
        new InvalidOutcomeTokenError(
          (ctx) => `Field 'outcomeKey' must be string, got ${ctx.type}`,
          {
            context: {
              source,
              service: OutcomeTokenSerializer.SERVICE_NAME,
              op: 'fromJSON',
              kind: 'invalid_outcome_key',
              type: typeof outcomeKeyValue,
            },
          }
        )
      );
    }

    // Валидация outcomeKey
    const outcomeKey = parseOutcomeKey(outcomeKeyValue);
    if (!outcomeKey) {
      return Err(
        new InvalidOutcomeTokenError(
          (ctx) => `Invalid outcomeKey format: '${ctx.outcomeKey}'`,
          {
            context: {
              source,
              service: OutcomeTokenSerializer.SERVICE_NAME,
              op: 'fromJSON',
              kind: 'invalid_outcome_key',
              outcomeKey: outcomeKeyValue,
            },
          }
        )
      );
    }

    // Валидация protocolId (формат: UPPERCASE_WITH_UNDERSCORES)
    const validatedProtocolId = asOnChainProtocolId(refObj.protocolId);
    if (!validatedProtocolId) {
      return Err(
        new InvalidOutcomeTokenError(
          (ctx) =>
            `Invalid protocolId format: '${ctx.protocolId}'. Must be UPPERCASE_WITH_UNDERSCORES`,
          {
            context: {
              source,
              service: OutcomeTokenSerializer.SERVICE_NAME,
              op: 'fromJSON',
              kind: 'invalid_condition_ref',
              protocolId: refObj.protocolId,
            },
          }
        )
      );
    }

    // Валидация chainId (должен быть валидным положительным integer)
    const validatedChainId = parseChainId(String(refObj.chainId));
    if (!validatedChainId) {
      return Err(
        new InvalidOutcomeTokenError(
          (ctx) => `Invalid chainId: ${ctx.chainId}. Must be positive integer`,
          {
            context: {
              source,
              service: OutcomeTokenSerializer.SERVICE_NAME,
              op: 'fromJSON',
              kind: 'invalid_condition_ref',
              chainId: refObj.chainId,
            },
          }
        )
      );
    }

    // Валидация conditionId (должен быть 32-byte hex с 0x префиксом)
    const validatedConditionId = parseConditionId(refObj.conditionId);
    if (!validatedConditionId) {
      return Err(
        new InvalidOutcomeTokenError(
          (ctx) =>
            `Invalid conditionId format: '${ctx.conditionId}'. Must be 32-byte hex (0x...)`,
          {
            context: {
              source,
              service: OutcomeTokenSerializer.SERVICE_NAME,
              op: 'fromJSON',
              kind: 'invalid_condition_ref',
              conditionId: refObj.conditionId,
            },
          }
        )
      );
    }

    // Создаем OnChainConditionRef с валидированными данными
    const onChainRef: OnChainConditionRef = {
      kind: 'ONCHAIN',
      protocolId: validatedProtocolId,
      chainId: validatedChainId,
      conditionId: validatedConditionId,
    };

    // Делегируем создание OutcomeTokenService
    return OutcomeTokenService.create(onChainRef, outcomeKey);
  }

  /**
   * Сериализует OutcomeToken в JSON объект
   *
   * @param token - OutcomeToken для сериализации
   * @returns OutcomeTokenJSON объект
   *
   * @remarks
   * Возвращает строго типизированный OutcomeTokenJSON.
   * Гарантирует что все поля присутствуют и имеют правильные типы.
   *
   * @example
   * ```typescript
   * const token = expectOk(OutcomeTokenService.create(onChainRef, BinaryOutcome.UP));
   * const json = OutcomeTokenSerializer.toJSON(token);
   * // → {
   * //   conditionRef: { kind: 'ONCHAIN', ... },
   * //   outcomeKey: 'UP'
   * // }
   * ```
   */
  public static toJSON(token: OutcomeToken): OutcomeTokenJSON {
    const conditionRef = token.conditionRef();
    return {
      conditionRef: {
        kind: 'ONCHAIN',
        protocolId: conditionRef.protocolId as string,
        chainId: conditionRef.chainId as number,
        conditionId: conditionRef.conditionId as string,
      },
      outcomeKey: token.outcomeKey() as string,
    };
  }
}
