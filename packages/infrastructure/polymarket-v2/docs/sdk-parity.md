# Характеризация @polymarket/client 0.6.0 и parity со старым stack

Зафиксировано на N-001 (2026-08-19), SDK `@polymarket/client@0.6.0`
(+ `@polymarket/bindings@0.6.0`). Источники: `.d.ts` установленной версии,
live smoke `scripts/smoke.ts` против публичных endpoints.

## Почему это сделано так

Старый Recorder получал сырой WS frame до DTO-маппинга. В V2 source-native
payload — это **decoded event официального SDK**: SDK уже владеет
transport/decode (zod-схемы, reconnect), и повторное вскрытие сырых frames
означало бы дублировать vendor-логику. Решение принято после проверки, что
SDK-событие не теряет данных, нужных Recorder / SemanticAdapter /
backtest-replay (таблицы ниже).

## Endpoints SDK (production environment)

| Канал | SDK endpoint | Старый stack |
|---|---|---|
| CLOB market WS | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | тот же |
| RTDS | `wss://ws-live-data.polymarket.com` | тот же |
| Gamma REST | `https://gamma-api.polymarket.com` | тот же |

Транспорт один и тот же — меняется только слой декодирования.

## Использованные API SDK

- `createPublicClient()` → `PublicClient` (без credentials);
- `client.subscribe([...specs])` → `SubscriptionHandle` =
  `{ close(): Promise<void> } & AsyncIterable<Event>`;
  - `{ topic: 'market', tokenIds }` → `StandardMarketEvent`
    (без `customFeatureEnabled`);
  - `{ topic: 'prices.crypto.binance' | 'prices.crypto.chainlink', symbols }`
    → `CryptoPricesBinanceEvent | CryptoPricesChainlinkEvent`;
- `client.listMarkets(request)` → `Paginated<Market[]>`
  (`firstPage()` / `for await` по страницам, keyset-cursor);
- `client.fetchMarket({ id | slug | url })` → `Market`;
- `client.closeSubscriptions()` — закрытие всех подписок клиента
  (Source закрывает только СВОИ handles через `handle.close()`).

Reconnect/backoff/heartbeat — внутри SDK (переподключается, пока есть
активные подписки). Source свой reconnect не реализует.

## Известные ограничения типов SDK (зафиксировано)

`@polymarket/client@0.6.0` НЕ экспортирует с public root типы
subscribe-контракта (`SubscriptionHandle`, `PublicSubscriptionSpec`,
`MarketSubscription`, ...) и realtime event-типы. Поэтому:

- event-типы импортируются из **public subpath**
  `@polymarket/bindings/subscriptions` (объявлен в `exports` пакета
  bindings; версия pin-ится ровно той, которую использует client — 0.6.0);
- порт `PolymarketSubscribeClient` выведен как
  `Pick<ReturnType<typeof createPublicClient>, 'subscribe'>` — рукописные
  overload-ы не проходят structural-check против `const`-generic метода SDK;
- internal SDK paths (chunk-модули) НЕ импортируются (закреплено тестом).

## CLOB parity: старый wire event → SDK event

SDK декодирует тот же wire и **трансформирует представление**:
`event_type` → `type` (+ `topic: 'market'`), `asset_id` → `payload.tokenId`,
snake_case → camelCase, `timestamp` string → number (epoch ms). Данные
сохраняются полностью.

| Старый wire event / поле | SDK event / поле | Данные |
|---|---|---|
| `book.event_type` | `type: 'book'` + `topic: 'market'` | present (переименовано) |
| `book.asset_id` | `payload.tokenId` | present (переименовано) |
| `book.market` | `payload.market` | present |
| `book.bids[].price/size` (строки) | `payload.bids[].price/size` (DecimalString) | present |
| `book.asks[]` | `payload.asks[]` | present |
| `book.hash` | `payload.hash` | present |
| `book.timestamp` (string ms) | `payload.timestamp` (number ms) | present (тип) |
| `book.min_order_size` | `payload.minOrderSize` | present (optional) |
| `book.tick_size` | `payload.tickSize` | present |
| `book.neg_risk` | `payload.negRisk` | present (optional) |
| `book.last_trade_price` | `payload.lastTradePrice` | present |
| `price_change.price_changes[].asset_id` | `payload.priceChanges[].tokenId` | present |
| `price_change...price/size/side/hash` | `...price/size/side/hash` | present |
| `price_change...best_bid/best_ask` | `...bestBid/bestAsk` | present |
| `last_trade_price.price/size/side` | `payload.price/size/side` | present |
| `last_trade_price.fee_rate_bps` | `payload.feeRateBps` | present |
| `last_trade_price.transaction_hash` | `payload.transactionHash` | present |
| `tick_size_change.old/new_tick_size` | `payload.oldTickSize/newTickSize` | present |
| `trade` (market channel) | НЕТ отдельного типа | см. ниже |

**Про `trade` в market channel**: старый router обрабатывал
`trade`/`last_trade_price` как одну семью «трейд-обновление»; semantic-
потребителей у публичного market-channel `trade` в production-путях нет
(live-торговля использует только `book`; recorder писал raw). В SDK 0.6.0
`StandardMarketEvent` публичные принты передаёт типом `last_trade_price`
(price/size/side/feeRateBps/transactionHash/timestamp — подтверждено live).
Пользовательские fills (`trade` user-channel) — вне scope N-001 (не public).

Custom-события (`best_bid_ask`/`new_market`/`market_resolved`) существуют в
SDK только при `customFeatureEnabled: true` — сознательно НЕ подключены
(текущая система их не использует).

## RTDS parity: старый payload → SDK event

Старый `RtdsWebSocketClient` получал
`{ topic, type, timestamp, payload: { symbol, value, timestamp } }` и
отдавал callback `(symbol, price=Number(value), ts)`; recorder писал
`{ t: 'crypto_price', symbol, price, ts, source }`.

| Требуемое поле (старое) | SDK event | Данные |
|---|---|---|
| `symbol` | `payload.symbol` | present |
| `price` (= `value`) | `payload.value` (DecimalString) | present (строка — точнее старого `Number()`) |
| `ts` (= `payload.timestamp`) | `payload.timestamp` (epoch ms) | present |
| envelope `timestamp` | `timestamp` (epoch ms) | present |
| `source` discriminator | `topic` | present (переименован: wire `crypto_prices` → `prices.crypto.binance`, `crypto_prices_chainlink` → `prices.crypto.chainlink`) |
| `type: 'update'` | `type: 'update'` | present |

Формат символов сохранён: Binance `btcusdt`, Chainlink `btc/usd`.
Подключены ТОЛЬКО эти два topic — ровно те, что использует collect-data;
TWAP/equity/comments/sports/perps каналы SDK не подключаются.

## Gamma coverage: поля текущего Discovery/header → SDK `Market`

SDK нормализует raw Gamma JSON в структурированный `Market`
(id/state/outcomes/metrics/prices/trading/resolution/...). Live-проверка на
реальном рынке (`XRP Up or Down`, 15m):

| Текущее поле (GammaMarketDto) | SDK Market | Статус |
|---|---|---|
| `conditionId` | `conditionId` | present |
| `question` | `question` | present |
| `slug` | `slug` | present |
| `clobTokenIds` (JSON-строка) | `outcomes.yes/no.tokenId` | present (transformed: распарсено) |
| `outcomes` (JSON-строка) | `outcomes.yes/no.label` | present (transformed) |
| `outcomePrices` (JSON-строка) | `outcomes.yes/no.price` | present (transformed) |
| `active` / `closed` / `enableOrderBook` | `state.active/closed/enableOrderBook` | present |
| `endDate` | `state.endDate` | present |
| `liquidity` | `metrics.liquidity` | present |
| `volume` | `metrics.volume` | present (optional в обоих; у молодых рынков null) |
| `spread` | `prices.spread` | present |
| `bestBid` / `bestAsk` | `prices.bestBid/bestAsk` | present |
| `orderPriceMinTickSize` | `trading.minimumTickSize` | present |
| `orderMinSize` | `trading.minimumOrderSize` | present |
| `description` | `description` | present |
| `tags` | `tags` | present |
| `resolutionSource` | `resolution.source` | present |
| `eventStartTime` | — | **missing** (есть в raw `GammaMarket`, но НЕ переносится в normalized `Market`) |
| `events[].eventMetadata` (`priceToBeat`/`finalPrice`) | — | **missing** (Market.events усечён до `{id, slug, title}`) |
| `rawMarket` (полный raw JSON для recording header) | — | **transformed** (SDK отдаёт normalized model, не raw JSON) |

**Значение для N-003 (не для N-001):** `eventStartTime` и
`events[].eventMetadata.priceToBeat/finalPrice` используются текущим
`CryptoMarketMeta`; при миграции Discovery на SDK их придётся брать иначе
(eventMetadata сохраняется в Event-схемах SDK — `fetchEvent`/`listEvents`;
`eventStartTime` — вопрос к upstream или парс slug). Recording header
`rawMarket` при миграции станет normalized `Market` — формат заголовка
станет иным (решение N-002/N-003). Market Discovery в N-001 не менялся.

## Решение (PART 19)

**«SDK event is the V2 source-native payload» — ДА.**

Доказательства:

1. Полнота данных: обе parity-таблицы выше — вся информация старых wire
   events (CLOB) и RTDS payload присутствует в SDK events; отличается только
   представление (переименования, camelCase, числовой timestamp), и оно
   зафиксировано здесь для будущего SemanticAdapter/Reader.
2. Сериализуемость: `JSON.stringify(payload)` без потерь (unit-тест +
   live smoke: 5 видов payload, 0 failures).
3. Self-contained: payload содержит vendor discriminators (`topic`, `type`)
   и не требует нашей metadata для интерпретации.
4. Никаких SDK class instances/functions/streams/circular refs в событиях —
   это plain-объекты из zod-парса.

Точный raw wire frame НЕ сохраняется (например, wire `event_type`
переименован в `type`) — это осознанная цена за официальный decode-слой;
для целей Recorder/replay значимой является информация, а не байтовая
форма, и информация сохранена полностью.

## Live smoke (2026-08-19, ~25 s)

Полный pipeline `PolymarketSource → ExternalMessage → ExternalMessageBus`
на живом рынке `XRP Up or Down - August 19, 7:30AM-7:45AM ET` + RTDS
btc/eth:

| Метрика | Значение |
|---|---|
| `POLYMARKET_MARKET/book` | 6 |
| `POLYMARKET_MARKET/price_change` | 748 |
| `POLYMARKET_MARKET/last_trade_price` | 1 |
| `POLYMARKET_CRYPTO_BINANCE/update` | 48 |
| `POLYMARKET_CRYPTO_CHAINLINK/update` | 46 |
| bus stats | published 849 / dispatched 849, queue 0, 0 ошибок |
| metadata | у всех сообщений root (correlation=messageId, causation отсутствует), sequence строго растёт |
| serialization | 0 failures |
| close | source → bus закрылись чисто, процесс завершился сам |

Gamma: `listMarkets` (100 items/страница, keyset), `fetchMarket` по id —
работают; coverage полей — в таблице выше.
