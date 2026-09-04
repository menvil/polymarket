# @polymarket/external-message-recorder

Recording-подписчик общего `ExternalMessageBus`: персистит наблюдения
Polymarket и CEX в JSONL-архивы Replayable Raw Format V2 через существующий
storage-движок `@polymarket/data-collection`. Source-native `message.payload`
уходит на диск неизменённым — внутри archive envelope
`{type, ingress, payload}`.

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
        ↓ toRecordedExternalObservationV2(message)
DataRecorder (@polymarket/data-collection)
        ↓
market JSONL file (.jsonl → .jsonl.gz)
```

Source не импортирует recorder; recorder не получает данные напрямую из
source. Единственный путь данных — общий bus (закреплено
`__tests__/contour-boundary.test.ts`).

## 2. Archive envelope ВОКРУГ payload (Replayable Raw Format V2)

Recorder получает весь `ExternalMessage` и пишет на диск
`RecordedExternalObservationV2` — конверт, добавленный СНАРУЖИ
source-native payload:

```jsonc
// строка файла (2+):
{
  "type": "POLYMARKET_MARKET",
  "ingress": {
    "runId": "k8f3pz7q", "sequence": 100,
    "createdAtUnixSeconds": 1786668087, "millisecondOfSecond": 123,
    "microsecondOfMillisecond": 456, "nanosecondOfMicrosecond": 789
  },
  "payload": {"topic":"market","type":"book","payload":{"market":"0x...","bids":[...]}}
}
```

`payload` — decoded SDK-событие как есть: без clone / rename / flatten /
normalize / VO-конверсии (та же ссылка, что пришла на шину). Никакой
semantic normalization до записи не выполняется — replay обязан отдать
Semantic Adapter-у ровно то, что тот видел бы live.

`ingress` копируется НАПРЯМУЮ из `message.metadata` (`Date.now()` в момент
записи не используется — это время нашей обработки, а не наблюдения). Без
него после записи терялся бы точный порядок наблюдений МЕЖДУ
Polymarket-файлом и CEX-партициями: физически это разные файлы, а
vendor-timestamp-ы у них из разных часов и разной точности.

Ключ исторического порядка — пара `(runId, sequence)`. `sequence` без
`runId` глобальной identity НЕ образует: после рестарта процесса нумерация
начинается заново.

НЕ записываются live-only поля metadata: `messageId`, `correlationId`,
`causationId`, `createdAt`. Они принадлежат execution конкретного процесса.
При replay сообщение получит СВОЮ runtime metadata, а записанный `ingress` —
вход для replay scheduler-а, воспроизводящего историческую временную линию;
выдавать одно за другое нельзя.

Формат и его decoder живут в `@polymarket/raw-archive-format` — одном месте
на весь репозиторий (writer и reader-ы говорят одними типами).

## 3. Формат market-файла

- **LINE 1** — fixed-width market header (reserved 16 KiB, padding пробелами,
  `\n` на последнем байте): `{"t":"meta","formatVersion":2,"ts":...,
  "marketId":...,"question":...,"tokenIds":[...],"m":{...}}`. Переписывается
  in-place через `updateMarketMeta()` без переписывания payload-строк.
- **LINE 2+** — `RecordedExternalObservationV2` в порядке фактического
  поступления recorder-у (arrival order, БЕЗ сортировки по source-timestamp —
  replay обязан видеть ту же последовательность, что live-консюмеры; тот же
  порядок независимо закреплён `ingress.sequence` каждой строки).

`formatVersion: 2` — дискриминатор Replayable Raw Format V2: строки 2+
содержат `RecordedExternalObservationV2`, а не bare payload и не legacy raw
wire-фреймы. Legacy-файлы старого коллектора поля `formatVersion` не имеют и
читаются с `timingQuality: 'LEGACY_APPROXIMATE'`.

### CEX-партиции

У CEX-партиции свой header (LINE 1), потому что у CCXT-payload-а нет ни
биржи, ни типа рынка, а имя файла контрактом не является:

```jsonc
{"t":"meta","formatVersion":2,"source":"CEX","exchangeId":"binance",
 "marketType":"swap","symbol":"BTC/USDT:USDT","stream":"orderbook",
 "windowStartMs":…,"windowEndMs":…}
```

Окно партиции выбирается по времени INGRESS наблюдения, а не по wall-clock
момента записи: наблюдение, увиденное до границы окна, но доставленное чуть
позже неё, обязано попасть в СТАРОЕ окно (подробности —
`docs/guides/replayable-raw-format-v2.md`).

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

## 4a. Ленивый допуск по первому наблюдению (Collector-cutover)

До cutover recording-сессию создавал координатор ДО открытия подписки
(recorder-first): рынок регистрировался заранее, и первое CLOB-событие
попадало в готовую сессию. После cutover физические подписки принадлежат
общему control-plane (`collector:raw`), и recorder не знает заранее, какой
рынок и когда пришлёт первое наблюдение.

Опциональный `sessionProvider` закрывает этот разрыв:

```text
POLYMARKET_MARKET (market = X)
        ↓
активная сессия X?  ──YES──►  пишем напрямую (policy НЕ пересчитывается)
        │NO
        ▼
sessionProvider(X)  ── undefined ──►  игнор (marketMessagesIgnoredByPolicy++)
        │ registration
        ▼
registerMarket(registration)  →  записать ЭТО ЖЕ первое сообщение
```

Ключевой инвариант: провайдер вызывается СИНХРОННО внутри обработчика того
же сообщения, поэтому первое наблюдение, инициировавшее сессию, пишется, а
не теряется (нет `await` между созданием сессии и записью, нет «начнём со
следующего»). Провайдер спрашивается ТОЛЬКО при отсутствии активной сессии —
для уже активной сессии policy не пересчитывается. RTDS-сообщения провайдер
не трогают (у них нет marketId). Без `sessionProvider` поведение прежнее:
незарегистрированный рынок остаётся `unroutedMarketMessages`. Саму политику
допуска (`MarketUniverse` + `Policy`) держит collector, а не recorder —
провайдер приходит функцией `(sourceMarketId) => registration | undefined`,
и граница пакета не расширяется (закреплено `contour-boundary.test.ts`).

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

## 7a. Seal — expiry-cutoff без архива (N-004)

`sealMarket(marketId)` — переход между записью и архивом: market/RTDS
routing сессии снимается НЕМЕДЛЕННО (новые ExternalMessages в payload не
попадают; общие RTDS-фиды других рынков не затронуты), storage
замораживает файл (`DataRecorder.sealMarket`: буфер flushed, append-stream
закрыт), но writer сохраняется — `updateMarketMeta()` (enrichment header-а)
и `finalizeMarket(EXPIRED)` продолжают работать. `updateMarketMeta`
возвращает наблюдаемый `boolean` — finalizer не объявляет успех, если
header фактически не записан.

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
