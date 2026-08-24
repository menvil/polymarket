/**
 * Canonical ExternalMessage-контракты CEX V2 ingress.
 *
 * @remarks
 * ### Source-native payload = unified объект CCXT / CCXT Pro
 *
 * Для Polymarket source-native boundary — это decoded event официального SDK.
 * Для CEX source-native boundary — это **unified объект, который вернул
 * CCXT/CCXT Pro** (`watchOrderBook*` / `watchTrades*` / `fetchOrderBook`):
 *
 * ```text
 * CCXT unified object ──→ JSON-снапшот ──→ payload.orderBook / payload.trade
 * ```
 *
 * Никакого semantic-remapping нет: vendor-поля не переименовываются,
 * значения не конвертируются в наши VO (`Price`/`Quantity`/`Timestamp`),
 * Entity не строятся — это работа будущего CEX Semantic Adapter ПОСЛЕ bus.
 * Единственные допущенные транспортные операции над vendor-объектом:
 *
 * - **снапшот** (`JSON.parse(JSON.stringify(...))`) — CCXT Pro возвращает
 *   mutable-объекты своих внутренних кэшей (стакан мутируется in-place при
 *   каждом delta-обновлении), поэтому сообщение обязано зафиксировать
 *   состояние В МОМЕНТ наблюдения, а не ссылку на живой кэш;
 * - **truncate глубины стакана** до сконфигурированной depth — параметр
 *   ПОДПИСКИ (некоторые биржи игнорируют limit и присылают полный кэш),
 *   а не смысловая нормализация.
 *
 * ### Routing identity — в typed payload, НЕ в metadata
 *
 * CCXT unified объект сам по себе НЕ несёт identity биржи (`exchangeId` —
 * это идентичность инстанса, у которого вызван метод) и типа рынка. По
 * doctrine M-003 (`MessageMetadata`: «semantic-данные … source, exchange …
 * живут в payload конкретного сообщения») эта identity фиксируется в typed
 * payload РЯДОМ с нетронутым vendor-объектом, а не внутри него и не в
 * canonical metadata. Recorder маршрутизирует партиции ровно по этим полям.
 *
 * ### Granularity
 *
 * Одно независимое наблюдение = одно root-сообщение:
 *
 * - один resolve `watchOrderBook*` → один `CEX_ORDERBOOK`;
 * - один trade из batch `watchTrades*` → один `CEX_TRADE`
 *   (batch — транспортная упаковка CCXT, а не одно наблюдение).
 */
import type { ExternalMessage } from '@polymarket/external-messages';

/**
 * Тип рынка CEX-биржи в терминах CCXT (`options.defaultType`).
 *
 * - `spot` — спотовый рынок;
 * - `future` — фьючерсы с датой экспирации;
 * - `swap` — бессрочный своп (perpetual).
 *
 * @remarks
 * Значения — НАТИВНАЯ unified-терминология CCXT: expiring futures у CCXT
 * называются `future` (legacy-коллектор использовал собственное `futures`
 * — V2 это значение сознательно не наследует и alias не вводит: внешних
 * consumers V2-конфига ещё нет).
 */
export type CexMarketType = 'spot' | 'future' | 'swap';

/**
 * JSON-снапшот unified стакана CCXT в момент наблюдения.
 *
 * @remarks
 * Известные поля — СОБСТВЕННЫЕ имена unified-контракта CCXT
 * (`symbol`/`timestamp`/`datetime`/`nonce`/`bids`/`asks`), они не
 * переименовываются. Index-signature фиксирует, что снапшот сохраняет и
 * ЛЮБЫЕ прочие vendor-поля as-is: тип описывает структуру, а не whitelist.
 * Все опциональные поля после JSON-снапшота либо отсутствуют
 * (`undefined` у vendor), либо `null` — ровно как их отдаёт биржа.
 */
export interface CcxtOrderBookSnapshot {
  readonly [field: string]: unknown;
  /** Unified-символ пары (напр. `BTC/USDT` или `BTC/USDT:USDT`). */
  readonly symbol?: string;
  /** Timestamp биржи (Unix ms) — как отдал vendor. */
  readonly timestamp?: number | null;
  /** ISO-8601 представление того же момента — как отдал vendor. */
  readonly datetime?: string | null;
  /** Монотонный номер обновления книги (если биржа его отдаёт). */
  readonly nonce?: number | null;
  /** Уровни bid `[price, amount, ...vendor-extra]` по убыванию цены. */
  readonly bids?: ReadonlyArray<readonly unknown[]>;
  /** Уровни ask `[price, amount, ...vendor-extra]` по возрастанию цены. */
  readonly asks?: ReadonlyArray<readonly unknown[]>;
}

/**
 * JSON-снапшот unified сделки CCXT в момент наблюдения.
 *
 * @remarks
 * Поля — собственные имена unified Trade CCXT (`id`/`price`/`amount`/
 * `side`/`cost`/`info`/...); `info` — сырой exchange-specific объект,
 * который CCXT сам прикладывает к unified-структуре. Ничего не
 * переименовывается и не выбрасывается (см. index-signature).
 */
export interface CcxtTradeSnapshot {
  readonly [field: string]: unknown;
  /** ID сделки на бирже (если биржа его отдаёт). */
  readonly id?: string | null;
  /** Unified-символ пары. */
  readonly symbol?: string;
  /** Timestamp сделки (Unix ms) — как отдал vendor. */
  readonly timestamp?: number | null;
  /** ISO-8601 представление того же момента. */
  readonly datetime?: string | null;
  /** Сторона taker-а: `buy`/`sell` (или иное vendor-значение). */
  readonly side?: string | null;
  /** Цена сделки в котируемой валюте. */
  readonly price?: number | null;
  /** Объём сделки в базовом активе. */
  readonly amount?: number | null;
  /** Стоимость сделки (`price * amount`), если vendor её отдаёт. */
  readonly cost?: number | null;
  /** Сырой exchange-specific объект сделки (vendor-поле CCXT). */
  readonly info?: unknown;
}

/**
 * Payload наблюдения стакана: routing identity источника + нетронутый
 * vendor-снапшот.
 *
 * @remarks
 * `exchangeId`/`marketType` — идентичность CCXT-инстанса, выполнившего
 * наблюдение (у vendor-объекта их нет); `symbol` — routing-символ, который
 * знает source из своей подписки (vendor-объект НЕ патчится, если биржа
 * символ не проставила — в отличие от legacy-коллектора, мутировавшего
 * `ob.symbol`). Recorder партиционирует файлы ровно по этим трём полям +
 * типу сообщения; сам `orderBook` остаётся source-native.
 */
export interface CexOrderbookPayload {
  /** Идентификатор биржи в ccxt (`exchange.id`, напр. `binance`). */
  readonly exchangeId: string;
  /** Тип рынка CCXT-инстанса (`options.defaultType`). */
  readonly marketType: CexMarketType;
  /** Unified-символ наблюдения (routing identity подписки source). */
  readonly symbol: string;
  /** Нетронутый JSON-снапшот unified стакана CCXT. */
  readonly orderBook: CcxtOrderBookSnapshot;
}

/**
 * Payload наблюдения одной сделки: routing identity источника + нетронутый
 * vendor-снапшот.
 */
export interface CexTradePayload {
  /** Идентификатор биржи в ccxt (`exchange.id`). */
  readonly exchangeId: string;
  /** Тип рынка CCXT-инстанса. */
  readonly marketType: CexMarketType;
  /** Unified-символ наблюдения (routing identity подписки source). */
  readonly symbol: string;
  /** Нетронутый JSON-снапшот одной unified сделки CCXT. */
  readonly trade: CcxtTradeSnapshot;
}

/**
 * Наблюдение стакана CEX-биржи.
 *
 * @example
 * ```typescript
 * bus.subscribe('CEX_ORDERBOOK', (message) => {
 *   const { exchangeId, symbol, orderBook } = message.payload;
 *   // orderBook.bids / orderBook.asks — как отдал CCXT, без нормализации
 * });
 * ```
 */
export type CexOrderbookExternalMessage = ExternalMessage<'CEX_ORDERBOOK', CexOrderbookPayload>;

/**
 * Наблюдение одной сделки CEX-биржи.
 *
 * @example
 * ```typescript
 * bus.subscribe('CEX_TRADE', (message) => {
 *   const { exchangeId, symbol, trade } = message.payload;
 *   // trade.price / trade.amount / trade.side — vendor-значения CCXT
 * });
 * ```
 */
export type CexTradeExternalMessage = ExternalMessage<'CEX_TRADE', CexTradePayload>;

/**
 * Полный discriminated union внешних сообщений CEX V2 source.
 *
 * @remarks
 * Контур с несколькими sources параметризует ОДИН общий bus объединением
 * на composition root:
 * `ExternalMessageBus<PolymarketExternalMessage | CexExternalMessage>`.
 * Второй bus/Recorder под CEX не создаётся (acceptance N-005).
 */
export type CexExternalMessage = CexOrderbookExternalMessage | CexTradeExternalMessage;
