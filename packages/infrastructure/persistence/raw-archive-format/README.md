# @polymarket/raw-archive-format

Canonical wire-контракт **Replayable Raw Format V2** и его decoder на
persistence/replay-границе. Один пакет знает, как выглядит raw-архив: и
writer (`@polymarket/data-collection`), и reader-ы
(`@polymarket/snapshot-readers`, `@polymarket/market-finalizer`) говорят о
формате ОДНИМИ типами. Второго определения формата в репозитории нет.

Пакет — leaf БЕЗ зависимостей (даже на `@polymarket/messages`): metadata
описана структурно, чтобы контракт персистентности не тянул за собой
runtime-слой сообщений.

## 1. Зачем понадобился конверт

Canonical live-контур не меняется — recorder остаётся sibling-консюмером
общей шины рядом с semantic-адаптерами:

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

До V2 recorder сохранял ТОЛЬКО `message.payload`. Source-native payload при
этом переживал запись идеально, но вместе с внешним конвертом терялось всё,
что описывает НАБЛЮДЕНИЕ: `runId`, `sequence` и high-resolution момент
ingress. Из-за этого после записи было невозможно восстановить точный
порядок наблюдений МЕЖДУ файлами: Polymarket-рынок и каждая CEX-партиция
физически лежат в разных файлах, а vendor-timestamp-ы у них из разных часов
и разной точности.

V2 добавляет archive envelope **вокруг** payload:

```jsonc
{
  "type": "CEX_ORDERBOOK",
  "ingress": {
    "runId": "k8f3pz7q", "sequence": 101,
    "createdAtUnixSeconds": 1786668087, "millisecondOfSecond": 123,
    "microsecondOfMillisecond": 456, "nanosecondOfMicrosecond": 789
  },
  "payload": { "exchangeId": "binance", "orderBook": { "bids": [[64000, 1.5]] } }
}
```

## 2. Инварианты

### Payload неизменен

```text
record.payload === source-native message.payload
```

Никакой semantic normalization до записи: конверт добавляется СНАРУЖИ,
payload уходит на диск той же ссылкой — без clone / rename / flatten /
VO-конверсии. Replay обязан отдать semantic adapter-у ровно то, что тот
видел бы live.

### Время не пересчитывается

Все `ingress`-поля копируются из `message.metadata` того сообщения, которое
реально пришло recorder-у. `Date.now()` в момент записи не используется:
между наблюдением и storage-write лежат bus, буферы и планировщик, поэтому
wall-clock записи — это время НАШЕЙ обработки, а не время наблюдения.

### Ключ порядка — пара `(runId, sequence)`

`sequence` без `runId` глобальной identity НЕ образует: после рестарта
процесса начинается новый run и нумерация стартует заново. `compareIngress`
возвращает `undefined` для наблюдений разных run-ов — это не ошибка, а
точное утверждение об их несравнимости.

### Historical ≠ replay-runtime metadata

Decoder никогда не возвращает `MessageMetadata` и не собирает
`ExternalMessage`. При replay сообщение получит СВОЮ runtime metadata
(новый `runId`, новый `sequence`), а исторический `ingress` — вход для
simulator/replay scheduler-а. Live-only поля (`messageId`, `correlationId`,
`causationId`, `createdAt`) на диск не пишутся вовсе.

## 3. Файлы архива

### Polymarket market-файл

```text
LINE 1  {"t":"meta","formatVersion":2,"ts":…,"marketId":…,"tokenIds":[…],"m":{…}}
LINE 2+ {"type":"POLYMARKET_MARKET","ingress":{…},"payload":{…}}
```

Fixed-width header (16 KiB reserved) переписывается in-place через
`updateMarketMeta()`, не трогая строки наблюдений.

### CEX-партиция

```text
LINE 1  {"t":"meta","formatVersion":2,"source":"CEX","exchangeId":"binance",
         "marketType":"swap","symbol":"BTC/USDT:USDT","stream":"orderbook",
         "windowStartMs":…,"windowEndMs":…,"windowStartUTC":…,"windowEndUTC":…}
LINE 2+ {"type":"CEX_ORDERBOOK","ingress":{…},"payload":{…}}
```

Header обязателен: у CCXT-payload-а нет ни биржи, ни типа рынка, а имя файла
контрактом не является. Canonical identity транспорта — тройка
`exchangeId + marketType + stream`; `symbol` адресует инструмент внутри неё.
ORDERBOOK и TRADES остаются разными физическими партициями.

## 4. Reader-контракт

```typescript
const format = detectRawArchiveFormat(firstLine);  // ТОЛЬКО по LINE 1
for (const line of dataLines) {
  const observation = decodeRawArchiveLine(line, format);
  if (observation?.timingQuality === 'EXACT_INGRESS') {
    scheduler.enqueue(observation.ingress, observation.type, observation.payload);
  }
}
```

Формат берётся из header-а, а не угадывается по имени файла или по форме
первой data-строки. В архиве, объявившем `formatVersion: 2`, строка без
валидного конверта — это ПОВРЕЖДЕНИЕ (`undefined`), а не «наверное,
legacy»: иначе испорченная строка молча получала бы приблизительный тайминг.

`decodeDetachedArchiveLine` — узкое исключение для вызывающих, которые
получают строки уже без header-а (`DataRecorder.readSealedPayloadLines`).
File-level reader (`RawArchiveObservationReader` из
`@polymarket/snapshot-readers`) обязан идти через `detectRawArchiveFormat`.

## 5. Legacy

| | header | `kind` | `timingQuality` |
|---|---|---|---|
| V2-архив | `t:'meta'` + `formatVersion: 2` | `V2` | `EXACT_INGRESS` |
| legacy market-файл | `t:'meta'` без `formatVersion` | `LEGACY` | `LEGACY_APPROXIMATE` |
| legacy CEX-партиция | нет вовсе (LINE 1 = данные) | `LEGACY` | `LEGACY_APPROXIMATE` |
| архив чужой версии | `t:'meta'` + иной `formatVersion` | `UNSUPPORTED` | — |

Legacy — это ОТСУТСТВИЕ версии, а не «любая версия, кроме нашей». Архив с
объявленной неизвестной версией декодер не читает вовсе, а file-level reader
отвергает исключением (fail closed): его строки имеют неизвестную структуру,
и выдача их за legacy подменила бы данные.

Legacy-архивы НЕ переписываются и НЕ мигрируются. Порядок строк внутри файла
сохраняется строго: никакой пересортировки по vendor-timestamp, никакого
фиктивного `sequence`, никакой latency-модели и multi-file реконструкции.
`DecodedObservation` — discriminated union, поэтому у legacy-строки типы
просто не дают прочитать несуществующий точный тайминг.

## 6. Чего здесь нет

Ни DecisionScheduler, ни virtual-time backtester, ни calibrated latency
model legacy-архивов. Пакет описывает ФАКТЫ архива, а не их воспроизведение.
