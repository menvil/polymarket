/**
 * MarketViewModel — presentation layer для Market entity
 *
 * @remarks
 * Отвечает исключительно за представление Market:
 * - Построение URL
 * - Сериализация в MarketSnapshot (plain object для БД / API / кэша)
 *
 * ### Почему вынесено из Market?
 * Согласно принципам DDD, доменная сущность не должна знать
 * об URL-схемах или форматах JSON.
 *
 * ### Что здесь НЕ делается:
 * - Десериализация (реконструкция Market из raw данных) — за это отвечает `MarketParser`
 *
 * @example
 * ```typescript
 * import { MarketViewModel } from './view/MarketViewModel';
 * import { MarketParser } from './view/MarketParser';
 *
 * // Получение URL
 * const url = MarketViewModel.getMarketUrl(market);
 * // → 'https://polymarket.com/event/will-trump-win-2024'
 *
 * // Сериализация → сохранение
 * const snapshot = MarketViewModel.toSnapshot(market);
 * await db.save(snapshot);
 *
 * // Загрузка → реконструкция
 * const result = MarketParser.from(await db.load(id));
 * ```
 */

import { OutcomeTokenSerializer } from '@polymarket/value-objects/outcome-token';
import { Market } from '../Market.js';
import { type MarketSnapshot } from './MarketSnapshot.js';

/**
 * Базовый URL Polymarket для построения ссылок
 */
const POLYMARKET_BASE_URL = 'https://polymarket.com/event';

/**
 * MarketViewModel — статический класс для presentation логики
 *
 * @remarks
 * Намеренно реализован как static-only класс (cannot instantiate).
 * Содержит только методы представления — без доменной логики.
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
   * Сериализует Market в MarketSnapshot (plain object для хранения/передачи)
   *
   * @param market - Market entity для сериализации
   * @returns MarketSnapshot — JSON-совместимый plain object
   *
   * @remarks
   * Первый шаг round-trip pipeline:
   * `MarketParser.from(snapshot)` → `Market.fromSnapshot(snapshotResult.value)` возвращает
   * эквивалентный Market.
   *
   * @example
   * ```typescript
   * const snapshot = MarketViewModel.toSnapshot(market);
   * await db.save(snapshot);
   * // или
   * res.json(snapshot);
   * ```
   */
  public static toSnapshot(market: Market): MarketSnapshot {
    const state = market.state;
    let serializedState: MarketSnapshot['state'];

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
          token: OutcomeTokenSerializer.toJSON(market.outcomes[0].token),
          index: 0,
          name: market.outcomes[0].name,
        },
        {
          token: OutcomeTokenSerializer.toJSON(market.outcomes[1].token),
          index: 1,
          name: market.outcomes[1].name,
        },
      ],
      expirationDate: market.expirationDate.toISOString(),
      state: serializedState,
    };
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
}
