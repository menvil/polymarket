# Финализация V2-записей (N-004)

## Проблема

`closeSession(marketId, 'EXPIRED')` из N-003 делал всё одним действием:
закрыть подписки → снять routing → `finalizeMarket(EXPIRED)` → gzip.
После gzip зафиксированный first-line header обновить уже нельзя, а
официальные `priceToBeat`/`finalPrice` появляются в Gamma только ПОСЛЕ
конца события (лаг ~1-6 минут). Legacy решал это очередью pending
enrichment — V2 нужен явный lifecycle.

## Решение: два плана

### DATA LIFECYCLE (что происходит с файлом)

```text
ACTIVE .jsonl (append)
 │ expiresAt
 ↓ seal: буфер flushed, append-stream закрыт
SEALED .jsonl (payload заморожен; LINE 1 всё ещё перезаписывается r+)
 │ complete | timeout
 ↓ финальный header → finalize EXPIRED
.jsonl.gz (архив; header больше не меняется)
```

### CONTROL RETRY LIFECYCLE (кто и когда решает)

```text
MarketFinalizer.runOnce()          ← cadence у composition root
 │
 ├── listSessions(): ACTIVE && expiresAt <= now  → beginFinalization()
 │                    FINALIZING (перевёл не мы)  → getFinalizingSession()
 │        ↓            дедупликация по _pending: рынок регистрируется раз
 ├── lifecycle.beginFinalization(marketId)
 │     ├── state → FINALIZING ДО первого await (at most once)
 │     ├── recorder.beginMarketFinalization (CLOB и spot больше не пишутся)
 │     ├── settlement grace   (граничное наблюдение TWAP)
 │     ├── recorder.sealMarket (payload заморожен)
 │     └── release('collector:raw')  ПОСЛЕ заморозки, не на истечении
 │
 ├── pending: одна Gamma-попытка на проход (retry 30с, max 60 мин)
 │     ├── fetchMarket(gammaMarketId) → state/resolution/outcome prices
 │     ├── fetchEvent(event.id) → metadata (priceToBeat/finalPrice)
 │     ├── merge best-known (полученное однажды не теряется)
 │     └── header update:
 │           pending  → partial-данные записаны, архива нет
 │           complete → crypto: оба значения есть; non-crypto: сразу
 │           timeout  → бюджет исчерпан, best-known с явным статусом
 │
 └── финальный путь: header → finalizeMarket(EXPIRED) → gzip
        → lifecycle.completeFinalization (identity-guard: только FINALIZING)
```

## Почему подхват FINALIZING обязателен

Границу датасета держит ТОЧНЫЙ таймер сессии в lifecycle, а не проход
финализатора. Значит, к моменту прохода рынок обычно УЖЕ `FINALIZING`, а
`beginFinalization` устроен «ровно один раз» и отвечает `undefined`. Искать
только `ACTIVE` значило бы никогда не подхватить такой рынок:

```text
18:05:00.000  таймер сессии → FINALIZING → grace → seal → release
18:05:05.000  runOnce() видит FINALIZING и пропускает
              → Gamma polling не начинается
              → header не финализируется, архива нет
              → сессия висит FINALIZING вечно
```

Поэтому источников снимка два (`beginFinalization` для due `ACTIVE`,
`getFinalizingSession` для `FINALIZING`), а регистрация одна — по `_pending`.
`startedAtMs` берётся из снимка (`finalizingSinceMs`), а не из момента
подхвата: иначе `finalization.startedAtMs` архива и отсчёт бюджета ожидания
сдвигались бы на задержку control-тика.

## Почему НЕ «timer → closeSession(EXPIRED) → updateMarketMeta»

После gzip первая строка неизменяема. Порядок обязан быть:
**header ПЕРЕД gzip** (PART 22/34). Seal создаёт состояние, в котором
payload уже заморожен (никакие поздние ExternalMessages в датасет не
попадают — cutoff), но header ещё writable.

## Повторное открытие завершённого рынка

Duplicate reopen блокируется двумя независимыми контурами: recorder держит
`SEALED`-надгробие сессии до `finalizeMarket` (ленивый допуск не создаёт
вторую сессию поверх готового датасета), а gate требует ПОДТВЕРЖДЁННЫЙ claim
`collector:raw` — которого после `release` на границе датасета уже нет.
Отдельный closed-markets blacklist с TTL из legacy не нужен.

Capacity рынков считает `acquireLimit` спроса в control-plane: FINALIZING
слота не занимает, потому что физический claim к этому моменту снят.

## Финальный header (PART 22-25)

`updateMarketMeta` заменяет `m` первой строки ЦЕЛИКОМ, поэтому finalizer
собирает её из canonical header-а допуска через `buildFinalizedMarketHeader`
(`@polymarket/collector`). Это ОБОГАЩЕНИЕ, а не пересборка: база
(`headerVersion: 2`, identity/outcomes/timing/family/crypto) берётся такой,
какой её записал допуск, `timing` дополняется `recordingStartsAt`, и
добавляется `finalization`-раздел. Vendor-снапшоты Gamma в canonical header
не переносятся, а возврат к legacy `headerVersion: 1` невозможен: два
несовместимых shape под разными версиями в одном датасете сделали бы
дискриминатор бесполезным.

```json
"finalization": {
  "status": "complete",
  "startedAtMs": 0,
  "finalizedAtMs": 0,
  "attempts": 2,
  "resolution": { "closed": true, "closedTime": "2026-08-24 11:41:25+00", "umaResolutionStatus": "resolved" },
  "outcomes": [
    { "label": "Up", "instrumentId": "...", "price": "1" },
    { "label": "Down", "instrumentId": "...", "price": "0" }
  ],
  "winning": { "label": "Up", "instrumentId": "...", "source": "resolution", "exact": true },
  "crypto": { "priceToBeat": "78139.1880482839", "finalPrice": "78379.20527553321" }
}
```

Бюджет — тот же probe полного 16 KiB meta-конверта storage; лестница
усечения прежняя (`gammaEvent` → `gammaMarket`); критические
finalization-данные живут в ядре и переживают усечение vendor-снапшотов.
Backtest получает ответ о результате рынка из ОДНОЙ первой строки
(identity, timing, resolution, финальные цены, победитель, crypto-значения,
качество: complete/timeout + truncated).

## Vendor boundary (PART 18-21, live-характеризация 2026-08-24)

- `Event.metadata.priceToBeat/finalPrice` — JSON **numbers** →
  `extractCryptoFinalization` сохраняет точное десятичное представление
  строкой (`String(n)`, без `Number()`/`parseFloat`); строки — as-is;
- `Market.outcomes.*.price` — **DecimalString** (`"1"`/`"0"` у resolved,
  `"0.995"` до резолюции); vendor `yes`/`no` не покидают маппинг —
  `mapFinalOutcomes` отдаёт нейтральные `{label, instrumentId, price}`;
- победитель (`deriveWinningOutcome`) — ТОЛЬКО при
  `umaResolutionStatus === 'resolved'` и Decimal-однозначных ценах 1/0;
  иначе этот источник победителя не даёт (см. winner-ladder ниже).

## Winner-ladder: победитель и его происхождение (решение user 2026-08-25)

Проблема, найденная на артефактах CHECKPOINT #1: архив существовал, а
победителя в нём не было — Reader/бектест не мог ответить «какой токен
выиграл». Теперь при КАЖДОМ архивировании победитель берётся по лестнице
источников, и его происхождение записывается рядом:

```text
1. resolution       UMA resolved + settlement-цены 1/0        exact: true
2. official-prices  формула рынка на ОФИЦИАЛЬНЫХ ценах        exact: true
                    Gamma: finalPrice >= priceToBeat → Up
3. recorded-twap    (зарезервировано) формула на записанном   exact: true
                    TWAP-канале → DERIVED COMPLETE
4. recorded-rtds    приблизительно: записанный chainlink-ряд  exact: false
                    (только при полном отсутствии официальных
                     данных, т.е. на timeout-архиве)
—  winning отсутствует: ни один источник неприменим (non-crypto,
   нет записанного ряда, метки не Up/Down)
```

Формат: `{label, instrumentId, source, exact, basis?}`; `basis`
(`startValue`/`endValue`) заполняется derived-источниками. Архивы,
созданные ДО введения ladder, несут `winning` без `source` —
семантически это `'resolution'`.

Область гарантии: complete-архив **crypto Up/Down-рынка** всегда несёт
точного победителя — completion-условие такого рынка и есть наличие обеих
официальных цен, значит ступень 1 или 2 применима. На остальных рынках
работает только ступень 1: non-crypto архивируется немедленно после
expiry (`_isComplete` → `true` без ожидания), и при ещё не наступившей
UMA-резолюции `winning` отсутствует штатно. Ступени 2 и 4 к ним не
применяются — правило `finalPrice >= priceToBeat` принадлежит Up/Down-серии.

Ступень 2 — не эвристика: применяется правило САМОГО рынка (текст
`description` Up/Down-серий: _«resolve to "Up" if … greater than **or
equal to** [price to beat], otherwise "Down"»_) к официальным числам
оракула, из которых и следует UMA-резолюция; tie → Up. Guard: ровно два
исхода с метками `Up`/`Down` (правила других серий сюда не
распространяются). Сравнение — Decimal, без `Number()`.

Ступень 4 (`recordedChainlinkWinner.ts`) читает ЗАМОРОЖЕННЫЙ seal-ом
датасет (`readSealedPayloadLines`) и аппроксимирует официальную формулу:
`startValue` — первое наблюдение окна, `endValue` — среднее последних 60
секунд (равномерный 1 Гц каденс фида делает арифметическое среднее
эквивалентом time-weighted). Результат ВСЕГДА `exact: false`: секундные
тики — не оракульный TWAP, на близких финишах возможно расхождение.
Failed-writer (неполный датасет) не читается вовсе. Прежний запрет
PART 46 сохранён по сути: официальный `priceToBeat` НЕ выдумывается из
записанных данных — деривация помечена приблизительной и включается
только когда официальных данных нет вообще.

## Отказы

| Сбой | Поведение |
| --- | --- |
| Gamma fetch (crypto, до таймаута) | FINALIZING/best-known/файл сохранены; retry следующим runOnce |
| Gamma fetch (non-crypto) | немедленный архив с initial-данными (без crypto-ожидания enrichment-а — 60 мин по умолчанию) |
| header `false` при complete | архив отложен, error-лог, retry по cadence; success не объявляется |
| header `false` при timeout/shutdown | архив best-known ПРЕДЫДУЩЕГО header-а, error-лог (явная policy) |
| `finalizeMarket(EXPIRED)` throw | терминально: без success-лога, без повторного gzip; сессия остаётся FINALIZING |

## Shutdown (PART 40/41/60 + drain 2026-08-25)

### Почему появился drain

CHECKPOINT #1 показал: остановка процесса срезала 60-минутное окно
ожидания официальной резолюции — рынок BTC 6:45–6:50 ET был заархивирован
`timeout` (attempts=2) через 58 секунд после expiry, а Gamma зарезолвил
его через 20 секунд ПОСЛЕ выхода процесса. Решение user: остановка не
должна обрывать уже начатое ожидание.

### Штатный wind-down: `drain()` → `close()`

`finalizer.drain()`: крутит `runOnce()` с паузой `drainPollMs` (default —
cadence `enrichmentRetryMs`, 30 с), пока pending-финализации не опустеют:
каждый рынок архивируется `'complete'` при официальной резолюции либо
`'timeout'` по СВОЕМУ полному `enrichmentMaxWaitMs`-бюджету (60 мин).
Expiry-переходы продолжаются: ACTIVE-рынок, истёкший во время drain,
тоже дожидается. `archiveFailed`-остатки не ждутся (их архив терминально
отказал). Конкурентные drain разделяют одно ожидание. Верхняя граница:
последний вход в FINALIZING + `enrichmentMaxWaitMs`.

### Аварийный путь: `close()` без drain

`finalizer.close()`: запрет новых проходов → пробуждение спящего drain →
ожидание in-flight → все FINALIZING архивируются EXPIRED best-known БЕЗ
новых Gamma-запросов (сеть не задерживает shutdown; статус `'complete'`,
если условие уже выполнено, иначе `'timeout'`). ACTIVE/OPENING рынки не
трогаются — их закроет `lifecycle.close()` как SHUTDOWN. Итоговый
порядок контура — см. README.

Ветка `'timeout'` (оба пути) — зарезервированная точка расширения
TWAP-fallback: по исчерпании бюджета официальной резолюции итог будет
деривироваться из записанного TWAP-канала (`DERIVED COMPLETE`); до его
появления семантика не меняется.
