/**
 * MarketViewModel — представление канонического Market наружу
 *
 * @remarks
 * Отвечает за две вещи и только за них:
 * - {@link MarketViewModel.toSnapshot} — доменно-типизированный data carrier (in-memory);
 * - {@link MarketViewModel.toJSON} — сериализация в примитивы (БД, кэш, сеть).
 *
 * Обратное направление — `MarketParser` (сериализованные данные → снапшот) и
 * `Market.fromSnapshot()` (снапшот → entity).
 *
 * ### Почему это вынесено из Market
 * Доменная сущность не должна знать форматов хранения и передачи. Market знает
 * свои инварианты; как его записать в БД — вопрос слоя представления.
 *
 * ### Почему здесь больше нет `getMarketUrl()`
 * Метод собирал `https://polymarket.com/event/{slug}` — то есть зашивал в
 * generic domain entity знание о конкретной площадке и о том, что слаг у рынка
 * вообще есть. После перевода Market на `venueId` + необязательный `slug` это
 * стало прямым противоречием модели: у Kalshi-рынка такого URL не существует.
 * Построение ссылок — задача presentation-слоя конкретной площадки, и метод
 * удалён вместе со своим `POLYMARKET_BASE_URL`, а не перенесён «на всякий
 * случай»: потребителей у него не было.
 *
 * @example
 * ```typescript
 * // Сериализация → сохранение
 * await db.save(JSON.stringify(MarketViewModel.toJSON(market)));
 *
 * // Round-trip in-memory
 * const restored = Market.fromSnapshot(MarketViewModel.toSnapshot(market));
 * ```
 */

import { TimestampSerializer } from '@polymarket/timestamp';
import { Market } from '../Market.js';
import { MarketState } from '../value-objects/index.js';
import { type MarketSnapshot } from './MarketSnapshot.js';
import type { MarketJSON, MarketOutcomeJSON, MarketStateJSON } from './MarketJSON.js';

/**
 * MarketViewModel — статический класс представления Market
 *
 * @remarks
 * Намеренно реализован как static-only класс: чистые функции без состояния
 * и без доменной логики.
 */
export class MarketViewModel {
  /**
   * Приватный конструктор — класс не предназначен для инстанциации
   *
   * @throws {Error} Всегда, при любой попытке создать экземпляр
   */
  private constructor() {
    throw new Error('MarketViewModel is a static utility class and cannot be instantiated');
  }

  /**
   * Конвертирует Market в доменно-типизированный снапшот
   *
   * @param market - Market entity
   * @returns {@link MarketSnapshot} с canonical VO (без деградации в примитивы)
   *
   * @remarks
   * Снапшот структурно идентичен `MarketProps`, поэтому
   * `Market.fromSnapshot(MarketViewModel.toSnapshot(market))` возвращает
   * эквивалентный Market. Необязательные поля (`slug`, `crypto`) переносятся
   * только когда они заданы — чтобы round-trip не подменял «нет значения»
   * на «значение undefined».
   *
   * Состояние, исходы и crypto-спецификация **копируются**, а не разделяются
   * по ссылке с entity: снапшот — отдельный объект, и мутация его полей не
   * должна доставать до Market.
   *
   * @example
   * ```typescript
   * const snapshot = MarketViewModel.toSnapshot(market);
   * const restored = Market.fromSnapshot(snapshot);
   * ```
   */
  public static toSnapshot(market: Market): MarketSnapshot {
    return {
      id: market.id,
      venueId: market.venueId,
      ...(market.slug !== undefined ? { slug: market.slug } : {}),
      question: market.question,
      startsAt: market.startsAt,
      expiresAt: market.expiresAt,
      state: MarketState.normalize(market.state),
      outcomes: [
        { ...market.outcomes[0] },
        { ...market.outcomes[1] },
      ],
      family: market.family,
      ...(market.crypto !== undefined ? { crypto: { ...market.crypto } } : {}),
    };
  }

  /**
   * Сериализует Market в JSON-примитивы
   *
   * @param market - Market entity
   * @returns {@link MarketJSON} — форма для БД/кэша/сети
   *
   * @remarks
   * Время сериализуется через `TimestampSerializer.toJSON()` (epoch milliseconds),
   * чтобы формат совпадал со всеми остальными временными полями проекта.
   * Результат разбирается обратно `MarketParser.from()`.
   *
   * @example
   * ```typescript
   * const json = MarketViewModel.toJSON(market);
   * const snapshot = MarketParser.from(json);        // Ok
   * const restored = snapshot.ok && Market.fromSnapshot(snapshot.value);
   * ```
   */
  public static toJSON(market: Market): MarketJSON {
    const state: MarketStateJSON = market.state.status === 'RESOLVED'
      ? { status: market.state.status, resolvedOutcomeIndex: market.state.resolvedOutcomeIndex }
      : { status: market.state.status };

    const toOutcomeJSON = (index: 0 | 1): MarketOutcomeJSON => ({
      index: market.outcomes[index].index,
      label: market.outcomes[index].label,
      instrumentId: market.outcomes[index].instrumentId,
    });

    return {
      id: market.id,
      venueId: market.venueId,
      ...(market.slug !== undefined ? { slug: market.slug } : {}),
      question: market.question,
      startsAt: TimestampSerializer.toJSON(market.startsAt),
      expiresAt: TimestampSerializer.toJSON(market.expiresAt),
      state,
      outcomes: [toOutcomeJSON(0), toOutcomeJSON(1)],
      family: market.family,
      ...(market.crypto !== undefined
        ? { crypto: { asset: market.crypto.asset, duration: market.crypto.duration } }
        : {}),
    };
  }

  /**
   * Строковое представление рынка (human-readable)
   *
   * @param market - Market entity
   * @returns Строка вида `Market[VENUE:id](STATUS): question`
   *
   * @example
   * ```typescript
   * MarketViewModel.toString(market);
   * // → 'Market[POLYMARKET:btc-up-down-1200](ACTIVE): Bitcoin Up or Down?'
   * ```
   */
  public static toString(market: Market): string {
    return market.toString();
  }
}
