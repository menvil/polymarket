# @polymarket/cex-v2

CEX V2 ingress boundary: public market data CCXT / CCXT Pro, обёрнутая в
canonical ExternalMessages и опубликованная в общий `ExternalMessageBus`.

## Место в архитектуре (N-005)

```text
CCXT / CCXT Pro
      ↓
CexSource                       ← этот пакет
      ↓
ExternalMessage { type: CEX_ORDERBOOK | CEX_TRADE, payload, metadata }
      ↓
ОДИН общий ExternalMessageBus   (union с PolymarketExternalMessage)
      ↓
ОДИН ExternalMessageRecorder → CEX time-window policy → JSONL.gz
```

Пакет заканчивается на bus. Recorder-интеграция живёт в
`@polymarket/external-message-recorder` (CEX-конфигурация того же сервиса),
оконная storage-policy — в `@polymarket/data-collection`
(`CexWindowRecorder`).

## Ответственность

- открыть CCXT Pro транспорт одной биржи × одного типа рынка
  (несколько бирж = несколько независимых `CexSource` на одном bus);
- прочитать public streams: **order book** и **trades**;
- зафиксировать наблюдение immutable JSON-снапшотом (CCXT Pro возвращает
  живые объекты своих кэшей и мутирует их после возврата — доказано
  `scripts/characterize.ts`);
- обернуть каждое независимое наблюдение в root ExternalMessage
  (`metadataGenerator.nextRoot()`) и опубликовать в общий bus.

## Source boundary (payload identity)

`payload` = routing identity + нетронутый unified-объект CCXT:

```jsonc
// CEX_ORDERBOOK
{ "exchangeId": "binance", "marketType": "spot", "symbol": "BTC/USDT",
  "orderBook": { "bids": [[78920, 1.54]], "asks": [[78920.01, 0.94]], "nonce": 99078403438, "symbol": "BTC/USDT" } }

// CEX_TRADE (одна сделка = одно сообщение)
{ "exchangeId": "binance", "marketType": "spot", "symbol": "BTC/USDT",
  "trade": { "id": "6613140621", "price": 78920, "amount": 0.00059, "side": "sell",
             "timestamp": 1787607120042, "info": { /* raw exchange payload */ } } }
```

Vendor-поля не переименовываются, VO/Entity не строятся — semantic-граница
принадлежит будущему CEX Semantic Adapter. `exchangeId`/`marketType`/
`symbol` — идентичность CCXT-инстанса и подписки (у vendor-объекта их нет
или они ненадёжны); по doctrine M-003 semantic-идентичность источника живёт
в typed payload, НЕ в canonical metadata. Допущенные транспортные операции:
JSON-снапшот (ownership/immutability/serializability) и truncate стакана до
depth подписки.

## Supported streams / transport

| Поток | Основной метод | Fallback |
|---|---|---|
| Order book | `watchOrderBookForSymbols` | `watchOrderBook` per-symbol → сконфигурированный REST `fetchOrderBook` |
| Trades | `watchTradesForSymbols` | `watchTrades` per-symbol |

Один CCXT-инстанс НА ПОТОК: сбой транспорта стакана не валит поток сделок
и наоборот. Trades публикуются без повторной эмиссии кэша: инстансы
создаются с явным `newUpdates: true` (официальный механизм CCXT Pro;
характеризация: redelivered=0), эвристического dedup нет.

## Failure ownership / reconnect semantics

- **transport/vendor отказ** (сеть, WS, rejection, stale 60s/180s, crossed
  book) — supervised restart сессии (`RestartingTask`): backoff 2s→60s
  (+jitter), cooldown после серии отказов; второй поток не затрагивается;
- **плановый перезапуск** инстансов (default 30 мин ±10% jitter) —
  контроль внутренних кэшей/памяти CCXT Pro;
- **`Err` от `bus.publish`** — терминальный `failed`: оба потока
  останавливаются, retry отсутствует (отказ контура доставки — не
  транзиентная ошибка); наблюдаемо через `hasFailed` + error-лог;
- shutdown детерминирован: `close()` абортит сессии, pending watch
  разблокируются закрытием инстанса, инстанс закрывается ровно один раз.

## Message types

- `CEX_ORDERBOOK` — payload `CexOrderbookPayload`;
- `CEX_TRADE` — payload `CexTradePayload`;
- `CexExternalMessage` — union для параметризации общего bus на
  composition root: `ExternalMessageBus<PolymarketExternalMessage | CexExternalMessage>`.

## Recorder integration

Пакет НЕ пишет на диск и не знает о recorder-е. Композиция (см.
`scripts/smoke.ts`):

```typescript
const bus = new ExternalMessageBus<PolymarketExternalMessage | CexExternalMessage>();
const recorder = new ExternalMessageRecorder({
  bus, storage: dataRecorder, logger,
  cex: { bus, storage: cexWindowRecorder }, // тот же bus, оконная policy
});
recorder.start();
const source = new CexSource({ config, bus, metadataGenerator, logger });
source.start();
```

## Non-goals

- private streams (orders/fills/balances/positions), execution, funding,
  OHLCV, ticker;
- semantic-нормализация (Price/Quantity/Timestamp VO, Orderbook/Trade
  Entity) — CEX Semantic Adapter, после CHECKPOINT #1;
- собственный recorder/бас/очередь — ONE bus, ONE recorder;
- миграция Application/Risk/Strategies и legacy cutover
  (`cex-market-data` остаётся работать для старых consumers).

## Скрипты

```bash
npx tsx packages/infrastructure/cex-v2/scripts/characterize.ts  # vendor-контракты против реальной биржи
npx tsx packages/infrastructure/cex-v2/scripts/smoke.ts         # полный live-путь до .jsonl.gz readback
```
