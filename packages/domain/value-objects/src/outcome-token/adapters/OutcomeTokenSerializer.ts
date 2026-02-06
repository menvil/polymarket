import { Result, Err } from '@polymarket/result';
import { ErrorSource } from '@polymarket/errors';
import type { OnChainConditionRef, OutcomeKey } from '@polymarket/ids';
import { outcomeKey as createOutcomeKey } from '@polymarket/ids';
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

    // Создаем OnChainConditionRef
    const onChainRef: OnChainConditionRef = {
      kind: 'ONCHAIN',
      protocolId: refObj.protocolId as any,
      chainId: refObj.chainId as any,
      conditionId: refObj.conditionId as any,
    };

    const outcomeKey: OutcomeKey = createOutcomeKey(outcomeKeyValue);

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
