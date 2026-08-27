/**
 * Публичный трейд с ленты — маркет-принт.
 *
 * @remarks
 * OutcomePrice и Quantity VOs: это application-layer событие, не wire DTO.
 *
 * ### Идентичность трейда
 *
 * `venueTradeId` несёт ФАКТИЧЕСКИЙ идентификатор сделки на venue и никогда
 * не конструируется из других полей. Для Polymarket это `transactionHash`
 * события `last_trade_price`: замер на записанном архиве (37 407 трейдов,
 * 51 рынок, 29 часов, 2026-08-25/26) дал 37 407 различных хешей — включая
 * до 8 сделок в одну миллисекунду, у каждой свой хеш. То есть хеш уникален
 * на сделку, и синтетические ключи вида `{marketId}_{tokenId}_{ts}_{price}_{size}`
 * не нужны (на той же выборке такой ключ давал 7 коллизий).
 *
 * Поле опционально, потому что vendor-контракт помечает `transaction_hash`
 * как `optional | nullable`. Отсутствие означает «venue не сообщил
 * идентификатор»; выдумывать его вместо этого ЗАПРЕЩЕНО — фальшивый id
 * молча склеил бы разные сделки в ленте.
 *
 * Canonical envelope `{ type, payload, metadata }` (M-003): root-событие —
 * первичная реакция на внешнее WS-наблюдение.
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { InstrumentId, MarketId, VenueTradeId } from '@polymarket/ids';
import type { OutcomePrice, Quantity, Side } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/timestamp';

export type TradeReceivedEvent = MessageEnvelope<
  'TRADE_RECEIVED',
  {
    /** ID токена (UP/DOWN outcome token) */
    readonly instrumentId: InstrumentId;
    /**
     * ID рынка (condition_id), если источник его сообщает.
     *
     * @remarks
     * Опционально по причине МИГРАЦИИ, а не по природе данных: V2-контур
     * (`PolymarketSemanticAdapter`) заполняет поле всегда — vendor присылает
     * `market` в каждом событии. Legacy-мост `apps/bot` его дать не может:
     * его `WsTradeDto` несёт только `asset_id`. Поле станет обязательным,
     * когда legacy-продюсеры уйдут; до тех пор `undefined` честно означает
     * «этот источник рынок не сообщил», а не «рынка нет».
     */
    readonly marketId?: MarketId;
    /**
     * Фактический идентификатор сделки на venue.
     *
     * @remarks
     * `undefined` — venue его не сообщил. НЕ синтезируется (см. докблок модуля).
     */
    readonly venueTradeId?: VenueTradeId;
    /** Цена трейда (VO, не string) */
    readonly price: OutcomePrice;
    /** Объём трейда (VO, не string) */
    readonly size: Quantity;
    /** Сторона агрессора */
    readonly side: Side;
    /** Timestamp трейда */
    readonly timestamp: Timestamp;
  }
>;
