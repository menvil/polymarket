# Replayable Raw Format V2

Формат raw-архивов нового коллектора: что лежит на диске, почему именно так,
и как это читать. Контракт и decoder живут в одном пакете —
`@polymarket/raw-archive-format`.

## Почему это сделано так

### Проблема

Canonical live-контур ставит recorder sibling-консюмером общей шины рядом с
semantic-адаптерами:

```text
Sources
  ↓
ExternalMessage { type, payload, metadata }
  ↓
ONE ExternalMessageBus
  ├── Collector / Recorder → JSONL
  ├── PolymarketSemanticAdapter
  └── CexSemanticAdapter
```

Recorder видит ВЕСЬ `ExternalMessage`, но до V2 сохранял только
`message.payload`. Source-native payload переживал запись идеально — а
вместе с внешним конвертом терялось описание самого НАБЛЮДЕНИЯ:

- `metadata.runId` — какой запуск процесса это видел;
- `metadata.sequence` — в каком порядке относительно остальных наблюдений;
- high-resolution момент наблюдения;
- `type` — на какую typed-подписку это наблюдение шло.

Последствие: после записи невозможно восстановить точный порядок наблюдений
**между** Polymarket и разными CEX-потоками. Они физически лежат в разных
файлах, а vendor-timestamp-ы у них из разных часов, разной точности и с
неизвестной задержкой публикации. Backtest, склеивающий такие ряды по
vendor-времени, считал бы не то, что видела торговля.

### Решение

Archive envelope **вокруг** payload, а не вместо него:

```text
ExternalMessage { type, payload, metadata }
       ↓ recorder
RecordedExternalObservationV2 { type, ingress, payload }
       ↓ JSONL
archive
```

Формат менялся до первого production-запуска нового коллектора: архива с
`formatVersion: 2` ещё не существовало, поэтому payload-only V2 не был
историческим контрактом. Legacy-архивы старого коллектора не тронуты.

## Что лежит на диске

### Polymarket market-файл

```text
LINE 1  {"t":"meta","formatVersion":2,"ts":…,"marketId":…,"question":…,
         "tokenIds":[…],"m":{…}}                      ← fixed-width 16 KiB
LINE 2+ {"type":"POLYMARKET_MARKET","ingress":{…},"payload":{…}}
```

Header переписывается in-place (`updateMarketMeta`) без изменения строк
наблюдений. RTDS-наблюдения рынка идут в ТОТ ЖЕ файл, в порядке прихода.

### CEX-партиция

```text
LINE 1  {"t":"meta","formatVersion":2,"source":"CEX","exchangeId":"binance",
         "marketType":"swap","symbol":"BTC/USDT:USDT","stream":"orderbook",
         "windowStartMs":…,"windowEndMs":…,"windowStartUTC":…,"windowEndUTC":…}
LINE 2+ {"type":"CEX_ORDERBOOK","ingress":{…},"payload":{…}}
```

ORDERBOOK и TRADES — разные физические партиции. Canonical identity
транспорта — тройка `exchangeId + marketType + stream`; `symbol` адресует
инструмент внутри неё.

### Data-line

```jsonc
{
  "type": "CEX_ORDERBOOK",           // внешний discriminator
  "ingress": {
    "runId": "k8f3pz7q",             // identity запуска процесса
    "sequence": 101,                 // порядок внутри runId (с 1)
    "createdAtUnixSeconds": 1786668087,
    "millisecondOfSecond": 123,
    "microsecondOfMillisecond": 456, // 0 без sub-ms precision
    "nanosecondOfMicrosecond": 789
  },
  "payload": { /* source-native, НЕИЗМЕНЁННЫЙ */ }
}
```

## Инварианты

### 1. Payload неизменен

```text
record.payload === source-native message.payload
```

Никакой semantic normalization до записи. Payload уходит на диск ТОЙ ЖЕ
ссылкой: без clone, rename, flatten, VO-конверсии. Semantic adapter в live
и в replay обязан получать идентичное представление — иначе бэктест
считает не то, что торговля.

### 2. Время не пересчитывается

`ingress` копируется напрямую из `message.metadata` того сообщения, которое
реально пришло recorder-у. `Date.now()` в момент записи не используется:
между наблюдением и storage-write лежат bus, буферы и планировщик, поэтому
wall-clock записи — это время нашей обработки, а не время наблюдения.

Прямое следствие — выбор окна CEX-партиции. Наблюдение, увиденное
источником до границы окна, но доставленное чуть позже неё, обязано попасть
в СТАРОЕ окно:

```text
source увидел event до boundary
   → bus/consumer обработал чуть позже boundary
   → партиция выбирается по ingress, а не по времени записи
```

`CexWindowRecorder` принимает V2-наблюдение целиком и берёт окно из того же
`ingress`, который уходит на диск — рассинхронизировать их невозможно.
Таймер ротации «тихих» окон отложен на `boundaryGraceMs` (default 250 ms),
чтобы граничное наблюдение успело дойти до архивации своей партиции.
Наблюдение уже завершённого окна возвращает `'late'` и считается в
`CexWindowRecorderStats.lateObservations` — воскрешать заархивированную
партицию нельзя (новая ротация затёрла бы `.jsonl.gz` полного окна одной
опоздавшей строкой).

### 3. Ключ порядка — `(runId, sequence)`

`sequence` без `runId` глобальной identity НЕ образует: после рестарта
процесса начинается новый run и нумерация стартует заново. Сравнение по
`sequence` допустимо только внутри одного `runId` — `compareIngress`
возвращает `undefined` для разных run-ов. Это не ошибка, а точное
утверждение об их несравнимости.

### 4. Historical ≠ replay-runtime metadata

Decoder никогда не возвращает `MessageMetadata` и не собирает
`ExternalMessage`. При replay сообщение получит СВОЮ runtime metadata
(новый `runId`, новый `sequence`, новый момент создания), а исторический
`ingress` — вход для simulator/replay scheduler-а, воспроизводящего
временную линию.

Поэтому live-only поля metadata на диск не пишутся вовсе: `messageId`,
`correlationId`, `causationId`, `createdAt`.

## Как это читать

```typescript
import { SnapshotReaderFactory, RawArchiveObservationReader } from '@polymarket/snapshot-readers';

const factory = new SnapshotReaderFactory(logger);
const reader = new RawArchiveObservationReader(factory.create(filePath));
try {
  const header = await reader.readHeader();          // meta-строка либо undefined
  for await (const observation of reader.readObservations()) {
    if (observation.timingQuality === 'EXACT_INGRESS') {
      scheduler.enqueue(observation.ingress, observation.type, observation.payload);
    }
  }
} finally {
  await reader.close();
}
```

Формат определяется ПО HEADER-у (LINE 1) — не по имени файла и не по форме
первой data-строки:

```text
LINE 1 = meta с formatVersion 2   → V2          (EXACT_INGRESS)
LINE 1 = meta без formatVersion   → LEGACY      (market-файл старого коллектора)
LINE 1 ≠ meta                     → LEGACY      (CEX-партиция; LINE 1 уже данные)
LINE 1 = meta с иной версией      → UNSUPPORTED (читать нельзя)
```

В архиве, объявившем `formatVersion: 2`, строка без валидного конверта —
это ПОВРЕЖДЕНИЕ (декодер вернёт `undefined`), а не «наверное, legacy».
Иначе испорченная строка молча получала бы приблизительный тайминг.

### Legacy — это отсутствие версии, а не «версия ≠ 2»

Архив, объявивший неизвестный `formatVersion` (например, будущий
коллектор с версией 3), **не** читается как legacy: его строки имеют
неизвестную нам структуру, и разбор наугад подменил бы данные.
`RawArchiveObservationReader.readObservations()` такой архив отвергает
исключением — молчаливый ноль наблюдений дал бы бэктесту «чистый»
результат на пустоте. `readFormat()`/`readHeader()` при этом работают:
версию можно узнать, не ловя исключение.

Ingress-поля тоже проверяются по контракту, а не принимаются на веру:
`sequence` ≥ 1, целые в безопасном диапазоне, суб-секундные компоненты
0..999. Строка вне этих границ — повреждение, а не `EXACT_INGRESS`.

### Реконструкция общего порядка

Файлы сводить в один не нужно — достаточно общего ключа:

```text
market.jsonl.gz    → PM#100, PM#103
partition.jsonl.gz → CEX#101, CEX#102
                         ↓ merge by (runId, sequence)
                   100 PM, 101 CEX, 102 CEX, 103 PM
```

## Legacy

| Артефакт | header | `timingQuality` |
|---|---|---|
| V2-архив | `t:'meta'` + `formatVersion: 2` | `EXACT_INGRESS` |
| legacy market-файл | `t:'meta'` без `formatVersion` | `LEGACY_APPROXIMATE` |
| legacy CEX-партиция | нет вовсе | `LEGACY_APPROXIMATE` |

Legacy-архивы **не переписываются и не мигрируются**. Порядок строк внутри
файла сохраняется строго: никакой пересортировки по vendor-timestamp,
никакого фиктивного `sequence`. Сложная multi-file вероятностная
реконструкция и Monte Carlo latency-модель СОЗНАТЕЛЬНО не реализуются —
достаточно корректно читать legacy и явно знать, что тайминг там
приблизительный.

`DecodedObservation` — discriminated union по `timingQuality`, поэтому у
legacy-строки типы просто не дают прочитать несуществующий точный тайминг:
`ingress` и `type` там `undefined`.

## Границы этого формата

Здесь нет и не будет: DecisionScheduler, virtual-time backtester,
calibrated latency model, RTDS/TWAP lifecycle routing, resolution/fallback.
Формат описывает ФАКТЫ архива, а не их воспроизведение.

## Где что лежит

| Слой | Пакет |
|---|---|
| Контракт формата + encode/decode | `@polymarket/raw-archive-format` |
| Writer (market-файлы, CEX-партиции) | `@polymarket/data-collection` |
| Ingestion/routing (строит конверт) | `@polymarket/external-message-recorder` |
| File-level reader | `@polymarket/snapshot-readers` |
