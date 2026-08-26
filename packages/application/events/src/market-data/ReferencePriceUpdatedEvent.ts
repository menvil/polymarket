/**
 * Наблюдение референсной цены ВНЕШНЕГО актива (BTC/USD, ETH/USD, ...).
 *
 * @remarks
 * ### Зачем отдельное событие
 *
 * Рынок предсказаний и базовый актив живут в разных ценовых доменах:
 * `BOOK_UPDATED`/`TRADE_RECEIVED` несут `Price` outcome-токена
 * (`[0.0001, 0.9999]`), а `79341.36626633028` в этот домен не помещается
 * ПО ИНВАРИАНТУ. Поэтому референсные цены получают собственный канал с
 * собственным VO — {@link ReferencePrice}.
 *
 * ### Source-agnostic
 *
 * Контракт НЕ привязан к Polymarket: `sourceId` и `symbol` описывают любой
 * источник референсной цены. Будущий CEX Semantic Adapter публикует ЭТО ЖЕ
 * событие со своим `sourceId` — второго контракта заводить не нужно.
 *
 * ### Провенанс обязателен
 *
 * «BTC подорожал» — недостаточная семантика: Binance-спот, Chainlink-спот и
 * Chainlink TWAP в один и тот же момент дают РАЗНЫЕ числа, и по TWAP
 * рассчитываются Up/Down-рынки. Поэтому наблюдение всегда несёт и
 * `sourceId` (кто прислал), и {@link ReferencePriceFeed} (спот или TWAP
 * с конкретным окном усреднения).
 *
 * ### Два времени
 *
 * `venueTimestamp` — момент, которым источник ДАТИРОВАЛ значение;
 * `receivedAt` — момент получения наблюдения нами. Их разность и есть
 * задержка доставки, поэтому склеивать их нельзя.
 *
 * Canonical envelope `{ type, payload, metadata }` (M-003).
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { MarketDataSourceId } from '@polymarket/ids';
import type { ReferencePrice } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/timestamp';

/**
 * Вид потока референсной цены.
 *
 * @remarks
 * Дискриминированный union, а не «опциональное поле `windowSeconds`»:
 * окно — часть ИДЕНТИЧНОСТИ усреднённого потока (`btc/usd` TWAP 30 и
 * `btc/usd` TWAP 60 — разные ряды), а у спота его не существует вовсе.
 * `SPOT`-вариант делает окно НЕПРЕДСТАВИМЫМ, а не «обычно undefined».
 */
export type ReferencePriceFeed =
  | {
      /** Мгновенная (не усреднённая) цена источника. */
      readonly kind: 'SPOT';
    }
  | {
      /** Цена, усреднённая по времени (TWAP). */
      readonly kind: 'TWAP';
      /** Окно усреднения в секундах — часть идентичности потока. */
      readonly windowSeconds: number;
    };

export type ReferencePriceUpdatedEvent = MessageEnvelope<
  'REFERENCE_PRICE_UPDATED',
  {
    /** Источник наблюдения (кто прислал значение). */
    readonly sourceId: MarketDataSourceId;
    /**
     * Символ инструмента в НАТИВНОМ формате источника
     * (Binance — `btcusdt`, Chainlink — `btc/usd`).
     *
     * @remarks
     * Не нормализуется: приведение символов к общему виду — задача
     * потребителя/маппинга, а не границы наблюдения. Потеря нативной формы
     * лишила бы возможности сопоставить событие с записанным raw-архивом.
     */
    readonly symbol: string;
    /** Спот либо TWAP с окном — см. {@link ReferencePriceFeed}. */
    readonly feed: ReferencePriceFeed;
    /** Значение цены актива (произвольная положительная точность). */
    readonly value: ReferencePrice;
    /** Момент, которым источник датировал значение. */
    readonly venueTimestamp: Timestamp;
    /** Момент получения наблюдения нами. */
    readonly receivedAt: Timestamp;
  }
>;
