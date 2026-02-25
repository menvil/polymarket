/**
 * MarketViewModel — presentation/serialization layer для Market entity
 *
 * @remarks
 * Выносит из доменной сущности Market всю инфраструктурную логику:
 * - построение URL
 * - сериализация в JSON
 * - десериализация из JSON
 *
 * ### Почему вынесено из Market?
 * Согласно принципам DDD, доменная сущность не должна знать
 * об URL-схемах, форматах JSON или других инфраструктурных деталях.
 * Market содержит только бизнес-логику.
 *
 * @example
 * ```typescript
 * import { MarketViewModel } from './view/MarketViewModel';
 *
 * // Получение URL
 * const url = MarketViewModel.getMarketUrl(market);
 * // → 'https://polymarket.com/event/will-trump-win-2024'
 *
 * // Сериализация
 * const json = MarketViewModel.toJSON(market);
 *
 * // Десериализация
 * const result = MarketViewModel.fromJSON(json);
 * if (result.ok) {
 *   const market = result.value;
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { Market } from '../Market.js';
import {
  type OutcomeIndex,
  asMarketId,
  parseMarketSlug,
  parseOutcomeTokenId,
  MarketState,
  isValidMarketStatus,
} from '../value-objects/index.js';
import { MarketValidationError } from '../errors/MarketErrors.js';

/**
 * Базовый URL Polymarket для построения ссылок
 */
const POLYMARKET_BASE_URL = 'https://polymarket.com/event';

/**
 * MarketJSON — типизированный JSON формат для сериализации Market
 *
 * @remarks
 * Используется в MarketViewModel.toJSON() и MarketViewModel.fromJSON().
 * Все типы primitive для совместимости с JSON.
 */
export interface MarketJSON {
  /** Идентификатор рынка */
  readonly id: string;
  /** URL-safe слаг */
  readonly slug: string;
  /** Вопрос рынка */
  readonly question: string;
  /** Исходы рынка */
  readonly outcomes: readonly [
    { readonly tokenId: string; readonly index: 0; readonly name: string },
    { readonly tokenId: string; readonly index: 1; readonly name: string },
  ];
  /** Дата истечения в ISO 8601 формате */
  readonly expirationDate: string;
  /** Состояние рынка */
  readonly state:
    | { readonly status: 'ACTIVE' }
    | { readonly status: 'CLOSED' }
    | { readonly status: 'RESOLVED'; readonly resolvedOutcomeIndex: 0 | 1 };
}

/**
 * MarketViewModel — статический класс для presentation/serialization логики
 *
 * @remarks
 * Намеренно реализован как static-only класс (cannot instantiate).
 * Это подчёркивает что MarketViewModel — это набор pure функций,
 * а не объект с состоянием.
 */
export class MarketViewModel {
  /**
   * Приватный конструктор — класс не предназначен для инстанциации
   */
  private constructor() {
    throw new Error('MarketViewModel is a static utility class and cannot be instantiated');
  }

  /**
   * Строит URL рынка на Polymarket
   *
   * @param market - Market entity
   * @returns URL вида 'https://polymarket.com/event/{slug}'
   *
   * @example
   * ```typescript
   * const url = MarketViewModel.getMarketUrl(market);
   * // → 'https://polymarket.com/event/will-trump-win-2024'
   * ```
   */
  public static getMarketUrl(market: Market): string {
    return `${POLYMARKET_BASE_URL}/${market.slug}`;
  }

  /**
   * Сериализует Market в типизированный JSON объект
   *
   * @param market - Market entity для сериализации
   * @returns MarketJSON plain object
   *
   * @remarks
   * Выполняет round-trip с fromJSON():
   * `fromJSON(toJSON(market))` возвращает эквивалентный Market.
   *
   * @example
   * ```typescript
   * const json = MarketViewModel.toJSON(market);
   * console.log(JSON.stringify(json, null, 2));
   * // {
   * //   "id": "market-abc",
   * //   "slug": "will-trump-win",
   * //   "question": "Will Trump win?",
   * //   "outcomes": [...],
   * //   "expirationDate": "2024-11-05T00:00:00.000Z",
   * //   "state": { "status": "ACTIVE" }
   * // }
   * ```
   */
  public static toJSON(market: Market): MarketJSON {
    const state = market.state;
    let serializedState: MarketJSON['state'];

    if (state.status === 'ACTIVE') {
      serializedState = { status: 'ACTIVE' };
    } else if (state.status === 'CLOSED') {
      serializedState = { status: 'CLOSED' };
    } else {
      serializedState = {
        status: 'RESOLVED',
        resolvedOutcomeIndex: state.resolvedOutcomeIndex,
      };
    }

    return {
      id: market.id,
      slug: market.slug,
      question: market.question,
      outcomes: [
        {
          tokenId: market.outcomes[0].tokenId,
          index: 0,
          name: market.outcomes[0].name,
        },
        {
          tokenId: market.outcomes[1].tokenId,
          index: 1,
          name: market.outcomes[1].name,
        },
      ],
      expirationDate: market.expirationDate.toISOString(),
      state: serializedState,
    };
  }

  /**
   * Десериализует Market из unknown JSON объекта
   *
   * @param json - Неизвестный объект (из JSON.parse или внешнего источника)
   * @returns Result<Market, MarketValidationError>
   *
   * @remarks
   * ### Алгоритм:
   * 1. Проверяем что json — объект (не null, не массив)
   * 2. Извлекаем и валидируем id, slug, question
   * 3. Валидируем outcomes (массив из 2 элементов)
   * 4. Парсим expirationDate из ISO строки
   * 5. Парсим state (discriminated union)
   * 6. Создаём Market через Market.create()
   *
   * Выполняет round-trip с toJSON():
   * `fromJSON(toJSON(market))` возвращает эквивалентный Market.
   *
   * @example
   * ```typescript
   * const raw = JSON.parse(jsonString);
   * const result = MarketViewModel.fromJSON(raw);
   * if (result.ok) {
   *   console.log(result.value.id);
   * } else {
   *   console.error(result.error.message);
   * }
   * ```
   */
  public static fromJSON(json: unknown): Result<Market, MarketValidationError> {
    // Проверяем что json — объект
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      return Err(
        new MarketValidationError('Market JSON must be a non-null object', {
          context: { type: typeof json },
        })
      );
    }

    const raw = json as Record<string, unknown>;

    // Валидация id
    if (typeof raw.id !== 'string') {
      return Err(
        new MarketValidationError('Market JSON: id must be a string', {
          context: { field: 'id', type: typeof raw.id },
        })
      );
    }
    const id = asMarketId(raw.id);

    // Валидация slug
    if (typeof raw.slug !== 'string') {
      return Err(
        new MarketValidationError('Market JSON: slug must be a string', {
          context: { field: 'slug', type: typeof raw.slug },
        })
      );
    }
    const slug = parseMarketSlug(raw.slug);
    if (!slug) {
      return Err(
        new MarketValidationError(
          'Market JSON: slug must contain only lowercase letters, digits and hyphens',
          { context: { field: 'slug', value: raw.slug } }
        )
      );
    }

    // Валидация question
    if (typeof raw.question !== 'string' || raw.question.trim().length === 0) {
      return Err(
        new MarketValidationError('Market JSON: question must be a non-empty string', {
          context: { field: 'question', value: raw.question },
        })
      );
    }

    // Валидация outcomes
    if (!Array.isArray(raw.outcomes) || raw.outcomes.length !== 2) {
      return Err(
        new MarketValidationError('Market JSON: outcomes must be an array of exactly 2 elements', {
          context: { field: 'outcomes', length: Array.isArray(raw.outcomes) ? raw.outcomes.length : 'not array' },
        })
      );
    }

    // Валидация outcome[0]
    const o0 = raw.outcomes[0] as Record<string, unknown>;
    if (!o0 || typeof o0 !== 'object') {
      return Err(
        new MarketValidationError('Market JSON: outcomes[0] must be an object', {
          context: { field: 'outcomes[0]' },
        })
      );
    }
    const tokenId0 = parseOutcomeTokenId(String(o0.tokenId ?? ''));
    if (!tokenId0) {
      return Err(
        new MarketValidationError('Market JSON: outcomes[0].tokenId must be a non-empty string', {
          context: { field: 'outcomes[0].tokenId', value: o0.tokenId },
        })
      );
    }
    if (typeof o0.name !== 'string' || o0.name.trim().length === 0) {
      return Err(
        new MarketValidationError('Market JSON: outcomes[0].name must be a non-empty string', {
          context: { field: 'outcomes[0].name', value: o0.name },
        })
      );
    }

    // Валидация outcome[1]
    const o1 = raw.outcomes[1] as Record<string, unknown>;
    if (!o1 || typeof o1 !== 'object') {
      return Err(
        new MarketValidationError('Market JSON: outcomes[1] must be an object', {
          context: { field: 'outcomes[1]' },
        })
      );
    }
    const tokenId1 = parseOutcomeTokenId(String(o1.tokenId ?? ''));
    if (!tokenId1) {
      return Err(
        new MarketValidationError('Market JSON: outcomes[1].tokenId must be a non-empty string', {
          context: { field: 'outcomes[1].tokenId', value: o1.tokenId },
        })
      );
    }
    if (typeof o1.name !== 'string' || o1.name.trim().length === 0) {
      return Err(
        new MarketValidationError('Market JSON: outcomes[1].name must be a non-empty string', {
          context: { field: 'outcomes[1].name', value: o1.name },
        })
      );
    }

    // Валидация expirationDate
    if (typeof raw.expirationDate !== 'string') {
      return Err(
        new MarketValidationError('Market JSON: expirationDate must be an ISO date string', {
          context: { field: 'expirationDate', type: typeof raw.expirationDate },
        })
      );
    }
    const expirationMs = Date.parse(raw.expirationDate);
    if (isNaN(expirationMs)) {
      return Err(
        new MarketValidationError('Market JSON: expirationDate is not a valid ISO date string', {
          context: { field: 'expirationDate', value: raw.expirationDate },
        })
      );
    }

    // Валидация state
    const stateResult = MarketViewModel._parseState(raw.state);
    if (!stateResult.ok) {
      return stateResult as Result<never, MarketValidationError>;
    }

    return Market.create({
      id,
      slug,
      question: raw.question,
      outcomeNames: [o0.name as string, o1.name as string],
      outcomeTokenIds: [tokenId0, tokenId1],
      expirationMs,
      state: stateResult.value,
    });
  }

  /**
   * Строковое представление рынка (human-readable)
   *
   * @param market - Market entity
   * @returns Строка вида 'Market[id](STATUS): question'
   *
   * @example
   * ```typescript
   * MarketViewModel.toString(market);
   * // → 'Market[market-abc](ACTIVE): Will Trump win?'
   * ```
   */
  public static toString(market: Market): string {
    return market.toString();
  }

  /**
   * Парсит MarketState из сырого JSON объекта
   *
   * @param raw - Сырые данные для парсинга
   * @returns Result<MarketState, MarketValidationError>
   *
   * @remarks
   * Вспомогательный приватный метод для fromJSON().
   * Валидирует discriminated union состояния.
   */
  private static _parseState(raw: unknown): Result<MarketState, MarketValidationError> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return Err(
        new MarketValidationError('Market JSON: state must be a non-null object', {
          context: { field: 'state', type: typeof raw },
        })
      );
    }

    const s = raw as Record<string, unknown>;

    if (!isValidMarketStatus(s.status)) {
      return Err(
        new MarketValidationError(
          'Market JSON: state.status must be one of ACTIVE, CLOSED, RESOLVED',
          { context: { field: 'state.status', value: s.status } }
        )
      );
    }

    if (s.status === 'ACTIVE') {
      return Ok(MarketState.active());
    }

    if (s.status === 'CLOSED') {
      return Ok(MarketState.closed());
    }

    // RESOLVED — нужен resolvedOutcomeIndex
    if (s.resolvedOutcomeIndex !== 0 && s.resolvedOutcomeIndex !== 1) {
      return Err(
        new MarketValidationError(
          'Market JSON: state.resolvedOutcomeIndex must be 0 or 1 for RESOLVED state',
          { context: { field: 'state.resolvedOutcomeIndex', value: s.resolvedOutcomeIndex } }
        )
      );
    }

    return Ok(MarketState.resolved(s.resolvedOutcomeIndex as OutcomeIndex));
  }
}
