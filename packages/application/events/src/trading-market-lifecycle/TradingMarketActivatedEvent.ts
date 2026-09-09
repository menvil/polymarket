/**
 * Торговый рантайм перешёл к активной торговле по принятому рынку.
 *
 * @remarks
 * Разделено с `TRADING_MARKET_ADMITTED` намеренно: между admission и
 * активацией рынок уже подписан и накапливает warm history стакана и сделок,
 * но торговых решений по нему ещё не принимается. Один и тот же рынок
 * проходит обе фазы, и слить их значило бы либо потерять предысторию, либо
 * начать торговать до `startsAt`.
 *
 * `activatedAt` — это `event.metadata.createdAt`; ожидается
 * `market.startsAt <= activatedAt < market.expiresAt`.
 *
 * Кто публикует активацию ровно на `startsAt` — ответственность будущей
 * композиции торгового рантайма: планировщика в контракте события нет.
 *
 * @example
 * ```typescript
 * const event = {
 *   type: 'TRADING_MARKET_ACTIVATED',
 *   payload: { marketId },
 *   metadata: metadataGenerator.nextRoot(),
 * } satisfies TradingMarketActivatedEvent;
 * ```
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { MarketId } from '@polymarket/ids';

export type TradingMarketActivatedEvent = MessageEnvelope<
  'TRADING_MARKET_ACTIVATED',
  {
    /**
     * Рынок, по которому начинается торговля.
     *
     * @remarks
     * Только идентичность: структура рынка уже принята вместе с
     * `TRADING_MARKET_ADMITTED` и повторно не пересылается — иначе появилось
     * бы два места, где рынок можно «уточнить».
     */
    readonly marketId: MarketId;
  }
>;
