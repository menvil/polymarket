import { Result, Err } from '@polymarket/result';
import { ErrorSource } from '@polymarket/errors';
import type { OnChainConditionRef } from '@polymarket/ids';
import {
  parseOutcomeKey,
  asOnChainProtocolId,
  parseChainId,
  parseConditionId,
} from '@polymarket/ids';
import { OutcomeToken } from '../core/OutcomeToken.js';
import { OutcomeTokenService } from '../facade/OutcomeTokenService.js';
import { InvalidOutcomeTokenError, OutcomeTokenErrorReason } from '../errors/index.js';

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
          `Expected object, got ${typeof json}`,
          {
            reason: OutcomeTokenErrorReason.INVALID_FORMAT,
            details: { type: typeof json, json: safeStringify(json) },
          },
          source
        )
      );
    }

    // Проверка что это не массив
    if (Array.isArray(json)) {
      return Err(
        new InvalidOutcomeTokenError(
          'Expected object, got array',
          {
            reason: OutcomeTokenErrorReason.INVALID_FORMAT,
            details: { type: 'array', json: safeStringify(json) },
          },
          source
        )
      );
    }

    const obj = json as Record<string, unknown>;

    // Проверка наличия conditionRef
    if (!('conditionRef' in obj)) {
      return Err(
        new InvalidOutcomeTokenError(
          "Missing required field 'conditionRef'",
          {
            reason: OutcomeTokenErrorReason.INVALID_FORMAT,
            details: { json: safeStringify(json) },
          },
          source
        )
      );
    }

    // Проверка наличия outcomeKey
    if (!('outcomeKey' in obj)) {
      return Err(
        new InvalidOutcomeTokenError(
          "Missing required field 'outcomeKey'",
          {
            reason: OutcomeTokenErrorReason.INVALID_FORMAT,
            details: { json: safeStringify(json) },
          },
          source
        )
      );
    }

    // Валидация conditionRef
    const conditionRef = obj.conditionRef;
    if (typeof conditionRef !== 'object' || conditionRef === null) {
      return Err(
        new InvalidOutcomeTokenError(
          "Field 'conditionRef' must be object",
          {
            reason: OutcomeTokenErrorReason.INVALID_CONDITION_REF,
            details: { type: typeof conditionRef, json: safeStringify(json) },
          },
          source
        )
      );
    }

    const refObj = conditionRef as Record<string, unknown>;

    // Проверка полей conditionRef
    if (
      !('kind' in refObj) ||
      !('protocolId' in refObj) ||
      !('chainId' in refObj) ||
      !('conditionId' in refObj)
    ) {
      return Err(
        new InvalidOutcomeTokenError(
          'ConditionRef missing required fields (kind, protocolId, chainId, conditionId)',
          {
            reason: OutcomeTokenErrorReason.INVALID_CONDITION_REF,
            details: { conditionRef: safeStringify(conditionRef) },
          },
          source
        )
      );
    }

    // Проверка что kind === 'ONCHAIN'
    if (refObj.kind !== 'ONCHAIN') {
      return Err(
        new InvalidOutcomeTokenError(
          `ConditionRef.kind must be 'ONCHAIN', got ${refObj.kind}`,
          {
            reason: OutcomeTokenErrorReason.NOT_ONCHAIN_CONDITION,
            details: { kind: refObj.kind },
          },
          source
        )
      );
    }

    // Проверка типов полей conditionRef
    if (typeof refObj.protocolId !== 'string') {
      return Err(
        new InvalidOutcomeTokenError(
          "Field 'protocolId' must be string",
          {
            reason: OutcomeTokenErrorReason.INVALID_CONDITION_REF,
            details: { type: typeof refObj.protocolId },
          },
          source
        )
      );
    }

    if (typeof refObj.chainId !== 'number') {
      return Err(
        new InvalidOutcomeTokenError(
          "Field 'chainId' must be number",
          {
            reason: OutcomeTokenErrorReason.INVALID_CONDITION_REF,
            details: { type: typeof refObj.chainId },
          },
          source
        )
      );
    }

    if (typeof refObj.conditionId !== 'string') {
      return Err(
        new InvalidOutcomeTokenError(
          "Field 'conditionId' must be string",
          {
            reason: OutcomeTokenErrorReason.INVALID_CONDITION_REF,
            details: { type: typeof refObj.conditionId },
          },
          source
        )
      );
    }

    // Проверка outcomeKey
    const outcomeKeyValue = obj.outcomeKey;
    if (typeof outcomeKeyValue !== 'string') {
      return Err(
        new InvalidOutcomeTokenError(
          "Field 'outcomeKey' must be string",
          {
            reason: OutcomeTokenErrorReason.INVALID_OUTCOME_KEY,
            details: { type: typeof outcomeKeyValue },
          },
          source
        )
      );
    }

    // Валидация outcomeKey
    const outcomeKey = parseOutcomeKey(outcomeKeyValue);
    if (!outcomeKey) {
      return Err(
        new InvalidOutcomeTokenError(
          `Invalid outcomeKey format: '${outcomeKeyValue}'`,
          {
            reason: OutcomeTokenErrorReason.INVALID_OUTCOME_KEY,
            details: { outcomeKey: outcomeKeyValue },
          },
          source
        )
      );
    }

    // Валидация protocolId (формат: UPPERCASE_WITH_UNDERSCORES)
    const validatedProtocolId = asOnChainProtocolId(refObj.protocolId);
    if (!validatedProtocolId) {
      return Err(
        new InvalidOutcomeTokenError(
          `Invalid protocolId format: '${refObj.protocolId}'. Must be UPPERCASE_WITH_UNDERSCORES`,
          {
            reason: OutcomeTokenErrorReason.INVALID_CONDITION_REF,
            details: { protocolId: refObj.protocolId },
          },
          source
        )
      );
    }

    // Валидация chainId (должен быть валидным положительным integer)
    const validatedChainId = parseChainId(String(refObj.chainId));
    if (!validatedChainId) {
      return Err(
        new InvalidOutcomeTokenError(
          `Invalid chainId: ${refObj.chainId}. Must be positive integer`,
          {
            reason: OutcomeTokenErrorReason.INVALID_CONDITION_REF,
            details: { chainId: refObj.chainId },
          },
          source
        )
      );
    }

    // Валидация conditionId (должен быть 32-byte hex с 0x префиксом)
    const validatedConditionId = parseConditionId(refObj.conditionId);
    if (!validatedConditionId) {
      return Err(
        new InvalidOutcomeTokenError(
          `Invalid conditionId format: '${refObj.conditionId}'. Must be 32-byte hex (0x...)`,
          {
            reason: OutcomeTokenErrorReason.INVALID_CONDITION_REF,
            details: { conditionId: refObj.conditionId },
          },
          source
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
    return OutcomeTokenService.create(onChainRef, outcomeKey, source);
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
