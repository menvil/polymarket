# @polymarket/external-message-recorder

Recording-подписчик общего `ExternalMessageBus`: персистит source-native
`message.payload` Polymarket-сообщений в market JSONL-файлы через
существующий storage-движок `@polymarket/data-collection`.

## 1. Recorder — consumer bus, а не callback source

```text
@polymarket/client
        ↓
PolymarketSource                 ← НЕ знает о Recorder
        ↓
ExternalMessage {type, payload, metadata}
        ↓
общий ExternalMessageBus         ← принадлежит composition root
        ↓ subscribe('POLYMARKET_MARKET' | 'POLYMARKET_CRYPTO_BINANCE' | 'POLYMARKET_CRYPTO_CHAINLINK')
ExternalMessageRecorder          ← этот пакет
        ↓ message.payload
DataRecorder (@polymarket/data-collection)
        ↓
market JSONL file (.jsonl → .jsonl.gz)
```

Source не импортирует recorder; recorder не получает данные напрямую из
source. Единственный путь данных — общий bus (закреплено
`__tests__/contour-boundary.test.ts`).

## 2. Payload-only: canonical metadata — runtime-only

Recorder получает весь `ExternalMessage`, но на диск пишет ТОЛЬКО
`message.payload` — decoded SDK-событие как есть, без clone / rename /
flatten / normalize / VO-конверсии:

```jsonc
// строка файла (2+):
{"topic":"market","type":"book","payload":{"market":"0x...","tokenId":"...","bids":[...],"asks":[...]}}
```

НЕ записываются: `ExternalMessage.type` (`POLYMARKET_MARKET`), `messageId`,
`runId`, `sequence`, `createdAt`, `correlationId`, `causationId`. Canonical
runtime metadata принадлежит live execution; recording dataset содержит
source-native observation. Vendor-поля payload (`topic`, `type`) при этом
сохраняются — это дискриминаторы самого SDK.

Инвариант replay: payload, записанный в файл, — тот же source-native payload,
который получает Semantic Adapter в live. Будущий Reader создаст НОВЫЙ
`ExternalMessage` вокруг того же payload и опубликует в ТОТ ЖЕ bus для ТОГО ЖЕ
adapter-а.

## 3. Формат market-файла

- **LINE 1** — fixed-width market header (reserved 16 KiB, padding пробелами,
  `\n` на последнем байте): `{"t":"meta","formatVersion":2,"ts":...,
  "marketId":...,"question":...,"tokenIds":[...],"m":{...}}`. Переписывается
  in-place через `updateMarketMeta()` без переписывания payload-строк.
- **LINE 2+** — source-native события в порядке фактического поступления
  recorder-у (arrival order, БЕЗ сортировки по source-timestamp — replay
  обязан видеть ту же последовательность, что live-консюмеры).

`formatVersion: 2` — дискриминатор V2-формата: строки 2+ содержат
SDK-decoded события, а не legacy raw wire-фреймы. Legacy-файлы старого
коллектора поля `formatVersion` не имеют.

## 4. Маршрутизация

- **Market-события** (`book`/`price_change`/`last_trade_price`/
  `tick_size_change`): по source market id — `payload.market` (conditionId).
  Он равен `String(marketMeta.marketId)` (доказано аудитом
  `PolymarketMarketDiscoveryAdapter`: `MarketId` строится из `conditionId`),
  поэтому отдельного routing-поля в регистрации нет. `price_change` с
  изменениями по нескольким tokenIds пишется ОДНОЙ строкой.
- **RTDS-события**: по точному ключу `(topic, symbol)` — vendor `topic`
  дискриминирует источник (`prices.crypto.binance` / `prices.crypto.chainlink`);
  эвристика формата символа (`symbol.includes('/')`) из legacy-коллектора
  сюда не переносится. Один RTDS-фид может писаться в N активных
  market-файлов — по одной строке на файл на входное событие.

Регистрацию приносит вызывающий (`PolymarketRecordingRegistration
{marketMeta, rtdsFeeds}`) — recorder НЕ решает, какие фиды нужны рынку
(это будущий Market Discovery/Coordinator N-003), и НЕ ходит в Gamma
(header-данные приносят `registerMarket`/`updateMarketMeta`; Gamma-refresh
и финализация после expiry — будущий Market Finalizer N-004).

## 5. Ingestion отделён от storage

Пакет — ТОЛЬКО тонкий bus-subscriber/routing-слой. Buffering, flush
(threshold + периодический), fs-streams, gzip, fixed-width header,
активация по `startsAt`, cleanup незавершённых файлов — всё остаётся в
`DataRecorder`; второй storage-движок не написан. Bus-handler дёшев:
route lookup → `JSON.stringify` → enqueue в память; per-message fsync нет.

## 6. Policy отказов

Recorder — optional/non-trading consumer. Ошибка записи:

- наблюдаема — лог + счётчики `getStats()` (routed/written/skipped
  inactive/serialization failures/registration failures/unrouted/handler
  errors);
- НЕ убивает `PolymarketSource`, не останавливает bus, не мешает будущему
  SemanticAdapter (handlers синхронные и никогда не бросают);
- изолируется на каждое направление RTDS fan-out независимо: отказ storage
  для одного рынка не лишает события остальные подписанные рынки;
- отказ регистрации в storage (writer не установлен) НЕ создаёт
  routing-состояния — `registerMarket` возвращает `false`, отказ залогирован,
  `registrationFailures++`, повторная регистрация возможна (retryable);
- отказ ОТЛОЖЕННОЙ активации storage (таймер `startsAt`) асинхронно
  инвалидирует сессию через hook `onDelayedActivationFailure`: routing
  (включая RTDS-фиды сессии) снимается, чужие рынки на общих фидах не
  затрагиваются, `registrationFailures++`, и повторный `registerMarket`
  выполняет настоящую новую регистрацию — оба слоя состояния (storage
  writer + recorder session) остаются согласованными;
- retry-очереди нет сознательно.

## 7. Lifecycle

```typescript
const storage = new DataRecorder(
  { ...DEFAULT_RECORDER_CONFIG, sourceSubDir: 'polymarket', formatVersion: 2 },
  new NDJSONFormatter(), new GzipCompressor(), logger,
);
const recorder = new ExternalMessageRecorder({ bus, storage, logger });
recorder.start();                                  // подписка на 3 typed-типа
recorder.registerMarket({ marketMeta, rtdsFeeds }); // сессия записи
await recorder.finalizeMarket(marketId, 'EXPIRED'); // flush → gzip-архив
await recorder.close();                             // отписка + storage.close()
```

Порядок shutdown контура (composition root):
`source.close()` → `bus.drain()` → `recorder.close()` → `bus.close()`.

`close()` идемпотентен, снимает bus-подписки, дожидается всех in-flight
`finalizeMarket` (cleanup не может удалить файл во время его финализации) и
только затем закрывает storage (recorder — его единственный писатель); общий
bus НЕ закрывается. `EXPIRED` = завершённый dataset (архив `.jsonl.gz`
остаётся); `SHUTDOWN` = незавершённый dataset (файл удаляется storage,
архив НЕ создаётся). Сообщения, регистрации и финализации после close
игнорируются (warn).

## 8. Независимые consumers одного bus

```text
ExternalMessageBus
  ├── ExternalMessageRecorder      (этот пакет: payload → диск)
  └── future PolymarketSemanticAdapter (payload → OrderBook/Trade/VO)
```

Recorder живёт строго ДО semantic-конверсии: пакет не импортирует
OrderBook/Trade/VO/ApplicationEvent/Strategy (закреплено contour-тестом).

## 9. Будущий CEX — тот же bus, тот же Recorder service

```text
CCXT → future CexSource → ExternalMessage → ТОТ ЖЕ ExternalMessageBus
                                                  ↓
                                       ТОТ ЖЕ Recorder service
                                                  ↓
                              CEX writer policy (exchange+symbol+window)
```

Второй Recorder service, второй bus и прямой Source→disk путь не понадобятся:
порт подписки принимает bus с расширенным union
(`PolymarketExternalMessage | CexExternalMessage`) без кастов (закреплено
types-тестом). ONE Recorder service ≠ one file policy: CEX сохранит своё
партиционирование (fixed time-window вместо market-session) — см. аудит
совместимости в `docs/cex-compatibility-audit.md`. В N-002 CEX-путь НЕ
мигрирован: production `CexCollectorService`/`CexFileRotator` не тронуты.

## 10. Тесты и smoke

- `__tests__/ExternalMessageRecorder.test.ts` — маршрутизация market/RTDS,
  payload identity, stats, lifecycle;
- `__tests__/recording-persistence.integration.test.ts` — реальный pipeline
  до диска: exact payload parity, no-outer-envelope, header in-place update,
  arrival order, RTDS duplication, finalize+gzip, shutdown cleanup;
- `__tests__/ExternalMessageRecorder.types.test.ts` — compile-time контракты
  (widened-bus порт, storage-порт);
- `__tests__/contour-boundary.test.ts` — dependency graph границы;
- `scripts/smoke.ts` — live smoke полного pipeline против публичных
  endpoints (~30 сек): `npx tsx packages/infrastructure/persistence/external-message-recorder/scripts/smoke.ts`.
