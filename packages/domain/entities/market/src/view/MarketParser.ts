/**
 * MarketParser — валидация сериализованного канонического рынка и конвертация в MarketSnapshot
 *
 * @remarks
 * Первый шаг двухэтапной реконструкции:
 * ```text
 * unknown serialized canonical market
 *   ↓  MarketParser.from()      — структура, типы, конвертация примитивов в canonical VO
 * MarketSnapshot
 *   ↓  Market.fromSnapshot()    — доменные инварианты
 * Market
 * ```
 *
 * ### Чего MarketParser НЕ знает
 * ```text
 * @polymarket/client   @polymarket/bindings   Gamma DTO   RTDS
 * ```
 * Он разбирает **нашу собственную** сериализацию canonical Market
 * ({@link MarketJSON}) — из БД, кэша, файла снапшота. Маппинг vendor → Domain
 * живёт в Infrastructure и в Domain не просачивается.
 *
 * ### Разделение с Market.create()
 * Парсер отвечает за «данные вообще пригодны к типизации»: строка ли `id`,
 * число ли `startsAt`, известен ли `status`. Доменные инварианты (различимость
 * исходов, `startsAt < expiresAt`, обязательность crypto-спецификации для
 * своего семейства) проверяет `Market.create()` — в одном месте и одинаково
 * для парсинга и для первичного создания.
 *
 * @example
 * ```typescript
 * import { MarketParser, Market } from '@polymarket/market';
 *
 * const snapshotResult = MarketParser.from(JSON.parse(stored));
 * if (!snapshotResult.ok) {
 *   logger.error('Corrupt market data', { error: snapshotResult.error.message });
 *   return;
 * }
 * const marketResult = Market.fromSnapshot(snapshotResult.value);
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import { MarketValidationError } from '@polymarket/errors/market';
import {
  asMarketId,
  asVenueId,
  asInstrumentId,
  asCryptoAssetId,
  asMarketDuration,
  isValidMarketStatus,
  isValidMarketFamily,
  parseMarketSlug,
  MarketState,
  type MarketFamily,
  type MarketOutcome,
  type CryptoUpDownSpec,
  type OutcomeIndex,
} from '../value-objects/index.js';
import { type MarketSnapshot } from './MarketSnapshot.js';

/**
 * MarketParser — статический класс реконструкции Market из сериализованных данных
 *
 * @remarks
 * Намеренно реализован как static-only класс: чистые функции без состояния.
 */
export class MarketParser {
  /**
   * Приватный конструктор — класс не предназначен для инстанциации
   *
   * @throws {Error} Всегда, при любой попытке создать экземпляр
   */
  private constructor() {
    throw new Error('MarketParser is a static utility class and cannot be instantiated');
  }

  /**
   * Валидирует сериализованный рынок и возвращает доменно-типизированный снапшот
   *
   * @param raw - Неизвестные данные (из БД, файла, `JSON.parse`)
   * @returns `Result` с {@link MarketSnapshot} либо `MarketValidationError`
   * @throws Ничего не бросает — все нарушения возвращаются как `Err`
   *
   * @remarks
   * Алгоритм:
   * 1. `raw` — не-null объект, не массив;
   * 2. `id` → `MarketId`, `venueId` → `VenueId`, `slug` (если задан) → `MarketSlug`;
   * 3. `question` — непустая строка (с `trim`);
   * 4. `startsAt`/`expiresAt` — epoch milliseconds → `Timestamp`;
   * 5. `outcomes` — ровно два элемента → `MarketOutcome` с `InstrumentId`;
   * 6. `state` → `MarketState`;
   * 7. `family` → `MarketFamily`; для `CRYPTO_UP_DOWN` обязателен `crypto` →
   *    `CryptoUpDownSpec`, для остальных семейств `crypto` должен отсутствовать.
   *
   * @example
   * ```typescript
   * const result = MarketParser.from({
   *   id: 'btc-up-down-1200',
   *   venueId: 'POLYMARKET',
   *   question: 'Bitcoin Up or Down?',
   *   startsAt: 1_772_366_400_000,
   *   expiresAt: 1_772_366_700_000,
   *   state: { status: 'ACTIVE' },
   *   outcomes: [
   *     { index: 0, label: 'Up', instrumentId: '7147' },
   *     { index: 1, label: 'Down', instrumentId: '2299' },
   *   ],
   *   family: 'CRYPTO_UP_DOWN',
   *   crypto: { asset: 'btc', duration: 300_000 },
   * });
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

    // ── identity ────────────────────────────────────────────
    if (typeof data.id !== 'string') {
      return Err(new MarketValidationError('Market data: id must be a string', {
        context: { field: 'id', type: typeof data.id },
      }));
    }
    const marketId = asMarketId(data.id);
    if (!marketId) {
      return Err(new MarketValidationError('Market data: id must be a non-empty string', {
        context: { field: 'id', value: data.id },
      }));
    }

    if (typeof data.venueId !== 'string') {
      return Err(new MarketValidationError('Market data: venueId must be a string', {
        context: { field: 'venueId', type: typeof data.venueId },
      }));
    }
    const venueId = asVenueId(data.venueId);
    if (!venueId) {
      return Err(new MarketValidationError(
        'Market data: venueId must contain only uppercase letters, digits and underscores',
        { context: { field: 'venueId', value: data.venueId } }
      ));
    }

    // slug необязателен: площадка может его не публиковать
    let slug: MarketSnapshot['slug'];
    if (data.slug !== undefined) {
      if (typeof data.slug !== 'string') {
        return Err(new MarketValidationError('Market data: slug must be a string when present', {
          context: { field: 'slug', type: typeof data.slug },
        }));
      }
      const parsed = parseMarketSlug(data.slug);
      if (!parsed) {
        return Err(new MarketValidationError(
          'Market data: slug must contain only lowercase letters, digits and hyphens',
          { context: { field: 'slug', value: data.slug } }
        ));
      }
      slug = parsed;
    }

    const question = typeof data.question === 'string' ? data.question.trim() : '';
    if (!question) {
      return Err(new MarketValidationError('Market data: question must be a non-empty string', {
        context: { field: 'question', value: data.question },
      }));
    }

    // ── schedule ────────────────────────────────────────────
    const startsAtResult = MarketParser._parseTimestamp(data.startsAt, 'startsAt');
    if (!startsAtResult.ok) return Err(startsAtResult.error);

    const expiresAtResult = MarketParser._parseTimestamp(data.expiresAt, 'expiresAt');
    if (!expiresAtResult.ok) return Err(expiresAtResult.error);

    // ── outcomes ────────────────────────────────────────────
    if (!Array.isArray(data.outcomes) || data.outcomes.length !== 2) {
      return Err(new MarketValidationError(
        'Market data: outcomes must be an array of exactly 2 elements',
        {
          context: {
            field: 'outcomes',
            length: Array.isArray(data.outcomes) ? data.outcomes.length : 'not array',
          },
        }
      ));
    }

    const outcome0Result = MarketParser._parseOutcome(data.outcomes[0], 0);
    if (!outcome0Result.ok) return Err(outcome0Result.error);

    const outcome1Result = MarketParser._parseOutcome(data.outcomes[1], 1);
    if (!outcome1Result.ok) return Err(outcome1Result.error);

    // ── state ───────────────────────────────────────────────
    const stateResult = MarketParser._parseState(data.state);
    if (!stateResult.ok) return Err(stateResult.error);

    // ── family + spec ───────────────────────────────────────
    if (!isValidMarketFamily(data.family)) {
      return Err(new MarketValidationError('Market data: family must be a known MarketFamily', {
        context: { field: 'family', value: data.family },
      }));
    }
    const family: MarketFamily = data.family;

    let crypto: CryptoUpDownSpec | undefined;
    if (family === 'CRYPTO_UP_DOWN') {
      const cryptoResult = MarketParser._parseCryptoSpec(data.crypto);
      if (!cryptoResult.ok) return Err(cryptoResult.error);
      crypto = cryptoResult.value;
    } else if (data.crypto !== undefined) {
      // Не отбрасываем молча: crypto-спека на не-crypto семействе — это
      // повреждённые данные, и `Market.create()` их тоже отвергнет.
      return Err(new MarketValidationError(
        `Market data: family ${family} must not carry a crypto spec`,
        { context: { field: 'crypto', family } }
      ));
    }

    return Ok({
      id: marketId,
      venueId,
      ...(slug !== undefined ? { slug } : {}),
      question,
      startsAt: startsAtResult.value,
      expiresAt: expiresAtResult.value,
      state: stateResult.value,
      outcomes: [outcome0Result.value, outcome1Result.value] as const,
      family,
      ...(crypto !== undefined ? { crypto } : {}),
    });
  }

  /**
   * Парсит epoch milliseconds в Timestamp
   *
   * @param raw - Сырое значение поля
   * @param field - Имя поля для контекста ошибки
   * @returns `Result` с `Timestamp` либо `MarketValidationError`
   *
   * @remarks
   * Инварианты самого времени (конечность, знак, диапазон) проверяет
   * `TimestampService.create()` — дублировать их здесь незачем. Оттуда же
   * наследуется его канонический контракт: дробные миллисекунды обрезаются
   * до целых, а не отклоняются. Свою сериализацию (`MarketViewModel.toJSON()`)
   * это не затрагивает — `TimestampSerializer` всегда пишет целые.
   */
  private static _parseTimestamp(
    raw: unknown,
    field: string,
  ): Result<Timestamp, MarketValidationError> {
    if (typeof raw !== 'number') {
      return Err(new MarketValidationError(
        `Market data: ${field} must be epoch milliseconds as number`,
        { context: { field, type: typeof raw } }
      ));
    }
    const result = TimestampService.create(raw);
    if (!result.ok) {
      return Err(new MarketValidationError(
        `Market data: ${field} is not a valid timestamp`,
        { context: { field, value: raw, cause: result.error.message } }
      ));
    }
    return Ok(result.value);
  }

  /**
   * Парсит один исход рынка
   *
   * @param raw - Сырой элемент массива outcomes
   * @param position - Ожидаемая позиция исхода (0 или 1)
   * @returns `Result` с {@link MarketOutcome} либо `MarketValidationError`
   *
   * @remarks
   * Позиция задаётся вызывающим и подставляется в `index`: порядок в массиве —
   * и есть источник истины для индекса. Если сериализованный `index` ему
   * противоречит, это повреждённые данные, и парсер сообщает об этом.
   */
  private static _parseOutcome(
    raw: unknown,
    position: OutcomeIndex,
  ): Result<MarketOutcome, MarketValidationError> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return Err(new MarketValidationError(
        `Market data: outcomes[${position}] must be an object`,
        { context: { field: `outcomes[${position}]` } }
      ));
    }

    const outcome = raw as Record<string, unknown>;

    if (outcome.index !== position) {
      return Err(new MarketValidationError(
        `Market data: outcomes[${position}].index must be ${position}`,
        { context: { field: `outcomes[${position}].index`, value: outcome.index } }
      ));
    }

    if (typeof outcome.label !== 'string' || outcome.label.trim().length === 0) {
      return Err(new MarketValidationError(
        `Market data: outcomes[${position}].label must be a non-empty string`,
        { context: { field: `outcomes[${position}].label`, value: outcome.label } }
      ));
    }

    if (typeof outcome.instrumentId !== 'string') {
      return Err(new MarketValidationError(
        `Market data: outcomes[${position}].instrumentId must be a string`,
        { context: { field: `outcomes[${position}].instrumentId`, type: typeof outcome.instrumentId } }
      ));
    }
    const instrumentId = asInstrumentId(outcome.instrumentId);
    if (!instrumentId) {
      return Err(new MarketValidationError(
        `Market data: outcomes[${position}].instrumentId is not a valid InstrumentId`,
        { context: { field: `outcomes[${position}].instrumentId`, value: outcome.instrumentId } }
      ));
    }

    return Ok({ index: position, label: outcome.label.trim(), instrumentId });
  }

  /**
   * Парсит состояние рынка
   *
   * @param raw - Сырой объект state
   * @returns `Result` с `MarketState` либо `MarketValidationError`
   */
  private static _parseState(raw: unknown): Result<MarketState, MarketValidationError> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return Err(new MarketValidationError('Market data: state must be a non-null object', {
        context: { field: 'state', type: typeof raw },
      }));
    }

    const state = raw as Record<string, unknown>;

    if (!isValidMarketStatus(state.status)) {
      return Err(new MarketValidationError(
        'Market data: state.status must be one of ACTIVE, CLOSED, RESOLVED',
        { context: { field: 'state.status', value: state.status } }
      ));
    }

    if (state.status === 'ACTIVE') return Ok(MarketState.active());
    if (state.status === 'CLOSED') return Ok(MarketState.closed());

    if (state.resolvedOutcomeIndex !== 0 && state.resolvedOutcomeIndex !== 1) {
      return Err(new MarketValidationError(
        'Market data: state.resolvedOutcomeIndex must be 0 or 1 for RESOLVED state',
        { context: { field: 'state.resolvedOutcomeIndex', value: state.resolvedOutcomeIndex } }
      ));
    }

    return Ok(MarketState.resolved(state.resolvedOutcomeIndex));
  }

  /**
   * Парсит спецификацию семейства `CRYPTO_UP_DOWN`
   *
   * @param raw - Сырой объект crypto
   * @returns `Result` с {@link CryptoUpDownSpec} либо `MarketValidationError`
   */
  private static _parseCryptoSpec(
    raw: unknown,
  ): Result<CryptoUpDownSpec, MarketValidationError> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return Err(new MarketValidationError(
        'Market data: crypto spec is required for family CRYPTO_UP_DOWN',
        { context: { field: 'crypto', type: typeof raw } }
      ));
    }

    const spec = raw as Record<string, unknown>;

    if (typeof spec.asset !== 'string') {
      return Err(new MarketValidationError('Market data: crypto.asset must be a string', {
        context: { field: 'crypto.asset', type: typeof spec.asset },
      }));
    }
    const asset = asCryptoAssetId(spec.asset);
    if (!asset) {
      return Err(new MarketValidationError(
        'Market data: crypto.asset is not a valid CryptoAssetId',
        { context: { field: 'crypto.asset', value: spec.asset } }
      ));
    }

    if (typeof spec.duration !== 'number') {
      return Err(new MarketValidationError(
        'Market data: crypto.duration must be a number of milliseconds',
        { context: { field: 'crypto.duration', type: typeof spec.duration } }
      ));
    }
    const duration = asMarketDuration(spec.duration);
    if (duration === undefined) {
      return Err(new MarketValidationError(
        'Market data: crypto.duration must be a positive integer number of milliseconds',
        { context: { field: 'crypto.duration', value: spec.duration } }
      ));
    }

    return Ok({ asset, duration });
  }
}
