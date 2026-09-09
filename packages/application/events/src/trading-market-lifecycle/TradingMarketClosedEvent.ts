/**
 * Торговый рантайм прекратил торговлю по рынку.
 *
 * @remarks
 * Это НАШЕ решение, а не подтверждение площадки. `market.state` может ещё
 * несколько секунд оставаться `ACTIVE` — площадка не обязана показывать нам
 * закрытие в тот же момент, когда мы сами перестали торговать по
 * `expiresAt`. Внешнее закрытие живёт в `Market.state`; это событие — только
 * про нас.
 *
 * Закрыть раньше `expiresAt` разрешено: это понадобится для risk,
 * kill switch, venue halt и контролируемой остановки.
 *
 * ### Почему нет enum причин
 *
 * Реальных producer-ов ещё нет, и набор причин, угаданный заранее, окажется
 * либо неполным, либо мёртвым. Причина появится в контракте тогда, когда
 * появится потребитель, который на неё смотрит.
 *
 * `tradingClosedAt` — это `event.metadata.createdAt`.
 *
 * ### Отличие от `MARKET_CLOSED`
 *
 * `MARKET_CLOSED` принадлежит старому рантайму: остановка старой стратегии,
 * освобождение аллокации, реализованный PnL. Семантика другая, и его
 * `MarketCloseReason` к этому событию отношения не имеет.
 *
 * @example
 * ```typescript
 * const event = {
 *   type: 'TRADING_MARKET_CLOSED',
 *   payload: { marketId },
 *   metadata: metadataGenerator.nextRoot(),
 * } satisfies TradingMarketClosedEvent;
 * ```
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { MarketId } from '@polymarket/ids';

export type TradingMarketClosedEvent = MessageEnvelope<
  'TRADING_MARKET_CLOSED',
  {
    /** Рынок, торговля по которому остановлена */
    readonly marketId: MarketId;
  }
>;
