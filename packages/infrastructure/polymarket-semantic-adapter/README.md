# @polymarket/polymarket-semantic-adapter

Граница «сырое наблюдение Polymarket → canonical Domain/Application».

## Место в контуре

```text
                     ExternalMessageBus
                    ↙                  ↘
       ExternalMessageRecorder    PolymarketSemanticAdapter
                 ↓                          ↓
               JSONL                Domain VO / Entities
                                            ↓
                                     ApplicationEvent
                                            ↓
                                        EventBus
```

Recorder и адаптер — **независимые потребители одной raw-шины**. Адаптер
ничего не знает ни про `DataCollector`, ни про recorder: он подписан на шину,
и только. Поэтому падение semantic-маппинга не мешает записи сырых данных, а
отключение адаптера не влияет на сбор.

## Использование

```typescript
import { PolymarketSemanticAdapter } from '@polymarket/polymarket-semantic-adapter';

const adapter = new PolymarketSemanticAdapter({
  bus,               // общий raw ExternalMessageBus (адаптер им НЕ владеет)
  eventBus,          // Application EventBus (создаёт composition root)
  metadataGenerator, // тот же генератор, что у источников контура
  logger,
});

adapter.start();
// ...
adapter.close(); // снимает ТОЛЬКО свои подписки, шину не трогает
```

## Матрица преобразования

| Raw-наблюдение | Semantic-выход |
| --- | --- |
| `POLYMARKET_MARKET` / `book` | `Orderbook` → `BOOK_DEPTH` (+ `BOOK_UPDATED` при смене верхушки) |
| `POLYMARKET_MARKET` / `price_change` | реконструированный `Orderbook` → `BOOK_DEPTH` (+ `BOOK_UPDATED` при смене верхушки) |
| `POLYMARKET_MARKET` / `last_trade_price` | `TRADE_RECEIVED` с `venueTradeId` = `transactionHash` и `marketId` (только при наличии объёма) |
| `POLYMARKET_MARKET` / `tick_size_change` | `TICK_SIZE_CHANGED` |
| `POLYMARKET_CRYPTO_BINANCE` | `REFERENCE_PRICE_UPDATED`, `btc`/`usdt`, `feed = SPOT` |
| `POLYMARKET_CRYPTO_CHAINLINK` | `REFERENCE_PRICE_UPDATED`, `btc`/`usd`, `feed = SPOT` |
| `POLYMARKET_CRYPTO_CHAINLINK_TWAP` | `REFERENCE_PRICE_UPDATED`, `btc`/`usd`, `feed = TWAP(windowSeconds)` |

## Ключевые инварианты

- **`book` ЗАМЕЩАЕТ состояние**, а не сливается с ним: уровни, которых нет в
  снапшоте, обязаны исчезнуть. Это же делает `book` механизмом восстановления
  после reconnect/desync.
- **`price_change` задаёт АБСОЛЮТНЫЙ размер уровня**, а не приращение;
  `size = 0` уровень удаляет. `currentSize += delta` — запрещённая операция.
- **`price_change` — это НЕ сделка.** `TRADE_RECEIVED` из него не выходит ни
  при каких условиях.
- **Дельта до первого `book` не строит частичную книгу** — отсутствие уровня в
  дельте не означает его отсутствия на venue.
- **Расхождение с объявленной источником верхушкой = DESYNC**: публикация по
  инструменту прекращается до следующего authoritative `book`. Чинить книгу
  угадыванием запрещено.
- **Точность не теряется**: путь всегда `десятичная строка vendor-а → VO`.
  `Number()` / `parseFloat()` / унарного `+` к финансовым значениям в пакете нет.
- **Два времени не смешиваются**: `venueTimestamp` из payload источника,
  `receivedAt` из metadata наблюдения. `Date.now()` не вызывается.
- **Ничего не выдумывается**: ни объём сделки, ни её идентификатор, ни
  отсутствующий шаг цены, ни уровни ради «полноты» `TopOfBook`.
- **Идентичность сделки берётся у источника**: `transactionHash` → `venueTradeId`
  как есть (замер: 37 407 трейдов — 37 407 различных хешей). Нет хеша —
  `undefined`, а не синтетический ключ.
- **Vendor-форматы заканчиваются здесь**: `btcusdt`/`btc/usd` разбираются в
  canonical `baseAsset`/`quoteAsset`, нативная форма остаётся только как
  provenance. `USDT` НЕ приводится к `USD` — это разные пары.

Подробное обоснование каждого решения —
[`docs/semantic-adapter.md`](./docs/semantic-adapter.md).

## Границы памяти

Адаптер СПЕЦИАЛЬНО не подписан на события жизненного цикла сбора: связав его с
ними, мы сделали бы semantic-слой collection-specific, а он обязан одинаково
работать и для live-торговли, и для будущего replay. Момент «этот рынок больше
не нужен» знает владелец, он и вызывает cleanup:

```typescript
adapter.forgetInstrument(tokenId);
adapter.forgetMarket(marketId); // → число забытых инструментов
```

`close()` освобождает всё состояние разом.

## Диагностика

`getStats()` возвращает read-only счётчики: принято/опубликовано книг, дельт,
трейдов и референсных цен, `deltaBeforeSnapshot`, `desyncs`/`resyncs`,
`tradesMissingSize`, `invalidPayloads`, `semanticPublishFailures`,
`activeBookStates`. Успешные обновления НЕ логируются на `info` — только
счётчики и `debug`; `warn`/`error` остаются для desync и отвергнутых данных.

## Чего пакет НЕ делает

- не владеет ни raw-шиной, ни Application-шиной;
- не вызывает Application-хендлеры напрямую;
- не резолвит рынки и не считает победителей (это `@polymarket/market-finalizer`);
- не мутирует SDK-payload наблюдения;
- не создаёт второй модели стакана — используется canonical `@polymarket/orderbook`.
