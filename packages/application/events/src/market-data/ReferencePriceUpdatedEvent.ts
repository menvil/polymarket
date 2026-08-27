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
 * ### Source-agnostic и canonical
 *
 * Контракт НЕ привязан к Polymarket: `sourceId` и пара
 * `baseAsset`/`quoteAsset` описывают любой источник референсной цены.
 * Будущий CEX Semantic Adapter публикует ЭТО ЖЕ событие со своим
 * `sourceId` — второго контракта заводить не нужно.
 *
 * Идентичность пары — **canonical**, а не vendor-специфичная: за границей
 * адаптера никто не обязан знать, что Binance пишет `btcusdt`, а Chainlink
 * `btc/usd`. Нативная форма остаётся в `nativeSymbol` только как
 * provenance. В этом и смысл границы: пропусти мы наружу один лишь
 * vendor-символ, нормализация переехала бы в Application — что уже
 * случилось в legacy (`StrategyScheduler.normalizeCryptoAsset`).
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
import type { CryptoAssetId, MarketDataSourceId } from '@polymarket/ids';
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
     * Базовый актив пары в canonical-форме (`btc`, `eth`, ...).
     *
     * @remarks
     * Именно ЗДЕСЬ заканчивается знание о vendor-форматах. Если бы наружу
     * уходил только нативный символ, Application пришлось бы разбирать
     * `btcusdt` и `btc/usd` самому — то есть нормализация просто переехала
     * бы за границу адаптера. Так уже произошло в legacy
     * (`StrategyScheduler.normalizeCryptoAsset` режет символы регулярками),
     * и повторять это нельзя.
     */
    readonly baseAsset: CryptoAssetId;
    /**
     * Котируемый актив пары в canonical-форме (`usdt`, `usd`, ...).
     *
     * @remarks
     * Хранится ОТДЕЛЬНО и НЕ приводится к общему знаменателю: `BTC/USDT` и
     * `BTC/USD` — разные пары с разными ценами. Считать ли их
     * взаимозаменяемыми — решение стратегии, а не границы наблюдения;
     * приняв его здесь, мы бы необратимо потеряли различие. Legacy теряет
     * quote целиком (`btcusdt` → `btc`), из-за чего эти пары там
     * неразличимы.
     */
    readonly quoteAsset: CryptoAssetId;
    /**
     * Символ в НАТИВНОМ формате источника (`btcusdt`, `btc/usd`).
     *
     * @remarks
     * Только provenance: сопоставление события с записанным raw-архивом и
     * отладка. Для логики используются `baseAsset`/`quoteAsset` — на
     * нативный формат downstream опираться не должен.
     */
    readonly nativeSymbol: string;
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
