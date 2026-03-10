/**
 * MarketParser — валидация raw данных и конвертация в доменно-типизированный MarketSnapshot
 *
 * @remarks
 * Первый шаг двухэтапного pipeline реконструкции:
 * `raw JSON → MarketParser.from() → MarketSnapshot → Market.fromSnapshot() → Market`
 *
 * MarketParser отвечает за:
 * - Проверку структуры и типов полей
 * - Конвертацию примитивов в доменные типы (MarketId, MarketSlug, OutcomeToken, MarketState)
 * - НЕ знает доменных инвариантов (distinct tokens, valid names — это Market.create())
 *
 * ### Алгоритм валидации в from():
 * 1. Проверяем что raw — объект (не null, не массив)
 * 2. Валидируем id (строка, непустая) → конвертируем в MarketId
 * 3. Валидируем slug (URL-safe формат) → конвертируем в MarketSlug
 * 4. Валидируем question (непустая строка)
 * 5. Валидируем outcomes (массив из 2 элементов, каждый с валидным токеном) → OutcomeToken
 * 6. Проверяем expirationDate (ISO строка, парсируемая в Date) → expirationMs: number
 * 7. Парсим state (discriminated union) → MarketState
 * 8. Возвращаем Ok(MarketSnapshot) с доменными типами
 *
 * @example
 * ```typescript
 * import { MarketParser, Market } from '@polymarket/market';
 *
 * // Двухэтапный pipeline:
 * const snapshotResult = MarketParser.from(await db.findMarket(id));
 * if (!snapshotResult.ok) {
 *   logger.error('Corrupt market data', { error: snapshotResult.error.message });
 *   return;
 * }
 * const marketResult = Market.fromSnapshot(snapshotResult.value);
 * if (marketResult.ok) {
 *   console.log(marketResult.value.state.status);
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { OutcomeTokenSerializer } from '@polymarket/value-objects/outcome-token';
import { asMarketId, isValidMarketStatus, parseMarketSlug, MarketState } from '../value-objects/index.js';
import { MarketValidationError } from '@polymarket/errors/market';
import { type MarketSnapshot } from './MarketSnapshot.js';

/**
 * MarketParser — статический класс для реконструкции Market из raw данных
 *
 * @remarks
 * Намеренно реализован как static-only класс.
 */
export class MarketParser {
  private constructor() {
    throw new Error('MarketParser is a static utility class and cannot be instantiated');
  }

  /**
   * Валидирует raw данные и возвращает доменно-типизированный MarketSnapshot
   *
   * @param raw - Неизвестный объект для парсинга (из БД, API, JSON.parse)
   * @returns Result<MarketSnapshot, MarketValidationError>
   *
   * @remarks
   * Выполняет всю конвертацию: примитивы → доменные типы.
   * Для получения Market вызовите `Market.fromSnapshot(result.value)` следующим шагом.
   *
   * @example
   * ```typescript
   * const snapshotResult = MarketParser.from(JSON.parse(storedJson));
   * if (!snapshotResult.ok) {
   *   console.error(snapshotResult.error.message);
   *   return;
   * }
   * const market = Market.fromSnapshot(snapshotResult.value);
   * ```
   */
  public static from(raw: unknown): Result<MarketSnapshot, MarketValidationError> {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return Err(
        new MarketValidationError('Market data must be a non-null object', {
          context: { type: typeof raw },
        })
      );
    }

    const data = raw as Record<string, unknown>;

    // id
    if (typeof data.id !== 'string') {
      return Err(
        new MarketValidationError('Market data: id must be a string', {
          context: { field: 'id', type: typeof data.id },
        })
      );
    }
    const marketId = asMarketId(data.id);
    if (!marketId) {
      return Err(
        new MarketValidationError('Market data: id must be a non-empty string', {
          context: { field: 'id', value: data.id },
        })
      );
    }

    // slug — делегируем parseMarketSlug для проверки формата
    if (typeof data.slug !== 'string') {
      return Err(
        new MarketValidationError('Market data: slug must be a string', {
          context: { field: 'slug', type: typeof data.slug },
        })
      );
    }
    const marketSlug = parseMarketSlug(data.slug);
    if (!marketSlug) {
      return Err(
        new MarketValidationError(
          'Market data: slug must contain only lowercase letters, digits and hyphens',
          { context: { field: 'slug', value: data.slug } }
        )
      );
    }

    // question — trim перед валидацией и хранением для консистентности
    const question = typeof data.question === 'string' ? data.question.trim() : '';
    if (!question) {
      return Err(
        new MarketValidationError('Market data: question must be a non-empty string', {
          context: { field: 'question', value: data.question },
        })
      );
    }

    // outcomes
    if (!Array.isArray(data.outcomes) || data.outcomes.length !== 2) {
      return Err(
        new MarketValidationError('Market data: outcomes must be an array of exactly 2 elements', {
          context: {
            field: 'outcomes',
            length: Array.isArray(data.outcomes) ? data.outcomes.length : 'not array',
          },
        })
      );
    }

    const o0 = data.outcomes[0] as Record<string, unknown>;
    if (!o0 || typeof o0 !== 'object' || Array.isArray(o0)) {
      return Err(
        new MarketValidationError('Market data: outcomes[0] must be an object', {
          context: { field: 'outcomes[0]' },
        })
      );
    }
    const token0Result = OutcomeTokenSerializer.fromJSON(o0.token);
    if (!token0Result.ok) {
      return Err(
        new MarketValidationError('Market data: outcomes[0].token is invalid', {
          context: { field: 'outcomes[0].token', cause: token0Result.error.message },
        })
      );
    }
    if (typeof o0.name !== 'string' || o0.name.trim().length === 0) {
      return Err(
        new MarketValidationError('Market data: outcomes[0].name must be a non-empty string', {
          context: { field: 'outcomes[0].name', value: o0.name },
        })
      );
    }

    const o1 = data.outcomes[1] as Record<string, unknown>;
    if (!o1 || typeof o1 !== 'object' || Array.isArray(o1)) {
      return Err(
        new MarketValidationError('Market data: outcomes[1] must be an object', {
          context: { field: 'outcomes[1]' },
        })
      );
    }
    const token1Result = OutcomeTokenSerializer.fromJSON(o1.token);
    if (!token1Result.ok) {
      return Err(
        new MarketValidationError('Market data: outcomes[1].token is invalid', {
          context: { field: 'outcomes[1].token', cause: token1Result.error.message },
        })
      );
    }
    if (typeof o1.name !== 'string' || o1.name.trim().length === 0) {
      return Err(
        new MarketValidationError('Market data: outcomes[1].name must be a non-empty string', {
          context: { field: 'outcomes[1].name', value: o1.name },
        })
      );
    }

    // expirationDate → expirationMs
    if (typeof data.expirationDate !== 'string') {
      return Err(
        new MarketValidationError('Market data: expirationDate must be an ISO date string', {
          context: { field: 'expirationDate', type: typeof data.expirationDate },
        })
      );
    }
    const expirationMs = Date.parse(data.expirationDate);
    if (isNaN(expirationMs)) {
      return Err(
        new MarketValidationError('Market data: expirationDate is not a valid ISO date string', {
          context: { field: 'expirationDate', value: data.expirationDate },
        })
      );
    }

    // state
    const stateResult = MarketParser._parseState(data.state);
    if (!stateResult.ok) {
      return stateResult as Result<never, MarketValidationError>;
    }

    return Ok({
      id: marketId,
      slug: marketSlug,
      question,
      outcomes: [
        { token: token0Result.value, index: 0 as const, name: (o0.name as string).trim() },
        { token: token1Result.value, index: 1 as const, name: (o1.name as string).trim() },
      ] as const,
      expirationMs,
      state: stateResult.value,
    });
  }

  /**
   * Парсит state из raw объекта в MarketState
   *
   * @param raw - Сырые данные для парсинга
   * @returns Result<MarketState, MarketValidationError>
   */
  private static _parseState(raw: unknown): Result<MarketState, MarketValidationError> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return Err(
        new MarketValidationError('Market data: state must be a non-null object', {
          context: { field: 'state', type: typeof raw },
        })
      );
    }

    const s = raw as Record<string, unknown>;

    if (!isValidMarketStatus(s.status)) {
      return Err(
        new MarketValidationError(
          'Market data: state.status must be one of ACTIVE, CLOSED, RESOLVED',
          { context: { field: 'state.status', value: s.status } }
        )
      );
    }

    if (s.status === 'ACTIVE') return Ok(MarketState.active());
    if (s.status === 'CLOSED') return Ok(MarketState.closed());

    if (s.resolvedOutcomeIndex !== 0 && s.resolvedOutcomeIndex !== 1) {
      return Err(
        new MarketValidationError(
          'Market data: state.resolvedOutcomeIndex must be 0 or 1 for RESOLVED state',
          { context: { field: 'state.resolvedOutcomeIndex', value: s.resolvedOutcomeIndex } }
        )
      );
    }

    return Ok(MarketState.resolved(s.resolvedOutcomeIndex as 0 | 1));
  }
}
