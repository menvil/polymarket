/**
 * Площадка объявила исход рынка, и торговый рантайм это зафиксировал.
 *
 * @remarks
 * Payload несёт целый canonical `Market`, а не один победивший исход. Это
 * решает три задачи одним событием:
 *
 * 1. фиксирует резолюцию в торговом состоянии;
 * 2. обновляет сохранённый canonical `Market` до последнего внешнего
 *    состояния (`state.status === 'RESOLVED'`);
 * 3. отдаёт победивший исход через существующий `market.resolvedOutcome`.
 *
 * Поэтому параллельных `winnerInstrumentId` / `winnerIndex` / `outcome` в
 * payload нет: они уже выражены в `Market.state` и `resolvedOutcome`, а
 * второе представление победителя пришлось бы синхронизировать с первым.
 *
 * Ожидается `market.isResolved() === true` и та же trading-critical
 * структура, что у принятого рынка (расписание, индексы и `InstrumentId`
 * исходов, семейство и его спецификация). `question`/`slug` площадка вправе
 * уточнить — это display metadata, не идентичность торговли.
 *
 * `resolvedAt` — это `event.metadata.createdAt`.
 *
 * @example
 * ```typescript
 * const event = {
 *   type: 'TRADING_MARKET_RESOLVED',
 *   payload: { market: resolvedMarket },
 *   metadata: metadataGenerator.nextRoot(),
 * } satisfies TradingMarketResolvedEvent;
 * ```
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { Market } from '@polymarket/market';

export type TradingMarketResolvedEvent = MessageEnvelope<
  'TRADING_MARKET_RESOLVED',
  {
    /**
     * Canonical рынок в разрешённом внешнем состоянии.
     *
     * @remarks
     * Это ТОТ ЖЕ рынок, что был принят: `venueId` + `id` совпадают, а
     * изменилось внешнее `state`. Потребитель обязан проверить и то, и
     * другое — контракт события описывает форму, а не инварианты состояния.
     */
    readonly market: Market;
  }
>;
