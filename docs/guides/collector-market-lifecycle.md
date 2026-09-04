# Полный жизненный цикл рынка в новом коллекторе

## Зачем этот этап существует

После Collector-cutover (PR #83) сборщик перестал владеть источниками и стал
обычным подписчиком общей шины, а после Replayable Raw Format V2 (PR #84) на
диск начал попадать конверт наблюдения `{type, ingress, payload}`. Но у
записи не было КОНЦА: recording-сессия рынка жила до остановки процесса,
RTDS-фиды не писались вовсе (иначе цены актива дописывались бы в датасет
давно истёкшего рынка), claim `collector:raw` не снимался, а финализация
работала через legacy-координатора.

Этот этап закрывает цикл: запись рынка получает точную границу, датасет —
итог, а физический claim — момент снятия.

## Контур

```text
Discovery → MarketUniverse → Planner → PolymarketSubscriptionController
                                             │ claim collector:raw
                                             ▼
                              PolymarketSource → ОДИН ExternalMessageBus
                                                      ├── ExternalMessageRecorder
                                                      └── SemanticAdapter (sibling)
                                                            ▲
   PolymarketCollectionLifecycle ── listMarketSessions() ────┘ read-only
          │ beginMarketFinalization / sealMarket / finalizeMarket
          ├ release('collector:raw', marketId) ──► SubscriptionController
          └ listSessions / beginFinalization ───► MarketFinalizer
```

Физический ресурс существует ТОЛЬКО через `PolymarketSubscriptionController`.
Коллектор его не создаёт, не закрывает и не ref-count-ит.

## Полный цикл одного рынка

```text
рынок приобретён collector:raw ДО открытия торгов
        ↓
первое CLOB-наблюдение (опорный book-снапшот)
        ↓ gate: universe + policy + подтверждённый claim
CollectionSession ACTIVE
        ↓ пишем: CLOB, RTDS spot, Chainlink, settlement TWAP
expiresAt                        ← таймер СЕССИИ, не control-тик
        ↓
FINALIZING                       CLOB и обычные RTDS больше НЕ пишутся
        ↓ settlement grace (5 с)  только settlement TWAP точной identity
seal dataset                     payload заморожен
        ↓
release collector:raw            claim снимается ПОСЛЕ заморозки
        ↓
Gamma resolution polling         (30 с cadence, бюджет 60 мин)
        ↓ official / deterministic fallback / discard
final header                     canonical V2 + finalization
        ↓
finalize(EXPIRED) → .jsonl.gz
        ↓
CollectionSession удалена
```

## Четыре решения, определяющие этот порядок

### 1. Допуск требует ПОДТВЕРЖДЁННОГО claim-а, а не только policy

Шина общая. Физическая подписка рынка может существовать из-за чужого
владельца:

```text
strategy:A держит рынок X   →  события X идут на общую шину
collector:raw НЕ приобрёл X →  коллектор писать X не имеет права
```

Совпадение policy этого не различает: policy отвечает «такие рынки нам
интересны», а не «этот рынок мы приобрели». Поэтому допуск завершается
вопросом к контроллеру подписок; чужой рынок игнорируется отдельным
счётчиком `ignoredNotHeldByCollector`.

### 2. Истечение — по таймеру сессии, а не по каденции discovery

Control-цикл ходит раз в секунды-десятки секунд:

```text
expiresAt              = 18:05:00
следующий control-тик  = 18:05:27
```

Ждать тик означало бы ещё 27 секунд дописывать CLOB истёкшего рынка: граница
датасета определялась бы каденцией discovery, а не расписанием рынка. Поэтому
на каждую принятую сессию ставится таймер РОВНО на `expiresAt`, а
`lifecycle.runOnce()` остаётся страховкой (пропущенный таймер, рестарт цикла,
shutdown).

### 3. Claim снимается ПОСЛЕ seal, а не на истечении

Последний claim закрывает разом CLOB, spot-фиды И settlement-поток. Снять его
на `expiresAt` значило бы потерять граничное наблюдение TWAP — то самое, по
которому рынок и рассчитывается: RTDS доставляет его на 1.1–2.2 с позже
(характеризация 2026-08-26, n≈90, p50 ≈ 1.5 с).

Поэтому физический CLOB живёт ещё несколько секунд, но в датасет уже НЕ
пишется: границу держит recorder, а не транспорт. Это осознанный размен —
несколько секунд лишнего трафика вместо «полуclaim-ов» и частичного владения
ресурсом в контроллере подписок.

### 3a. Переход `ACTIVE → FINALIZING` совершает один, а подхватывает другой

Границу держит таймер сессии, а Gamma-резолюцией владеет `MarketFinalizer` —
это два разных компонента и два разных момента времени:

```text
18:05:00.000  таймер сессии → FINALIZING → grace → seal → release
18:05:05.000  finalizer.runOnce()  ← видит рынок уже FINALIZING
```

`beginFinalization` устроен «ровно один раз» и второму вызывающему честно
отвечает `undefined`. Если бы финализатор искал только `ACTIVE`, такой рынок
не попал бы в `_pending` НИКОГДА: seal и release состоялись бы, а Gamma
polling нет — сессия висела бы `FINALIZING` вечно, архив не создавался.

Поэтому инвариант формулируется по РЕЗУЛЬТАТУ, а не по инициатору:

```text
кто бы ни совершил ACTIVE → FINALIZING
  (точный таймер сессии / lifecycle.runOnce / сам финализатор)

MarketFinalizer обязан получить РОВНО ОДИН immutable
FinalizingCollectionSession и зарегистрировать рынок один раз
```

Источников снимка два, регистрация одна:

| Стадия сессии | Как финализатор получает снимок |
| --- | --- |
| `ACTIVE` и `expiresAt <= now` | `beginFinalization()` — переход делает сам |
| `FINALIZING` | `getFinalizingSession()` — переход сделал кто-то другой |

Дедупликация — по собственному `_pending` финализатора. Перестановка
`finalizer.runOnce` перед `lifecycle.runOnce` эту дыру НЕ закрывает: точный
таймер асинхронен и срабатывает между тиками.

Момент границы едет в снимке (`finalizingSinceMs`) и попадает в
`finalization.startedAtMs` архива: брать `now` в момент подхвата значило бы
записать момент, который к границе датасета отношения не имеет, и сдвинуть
отсчёт бюджета ожидания на задержку control-тика.

### 4. Gamma polling — ПОСЛЕ immutable-границы датасета

```text
expiresAt → cutoff → settlement grace → SEAL → release claim
                                          │
                                          └── и только теперь: Gamma polling
```

Ни один Gamma-запрос не влияет на поток сырых наблюдений: к моменту первой
попытки enrichment датасет уже заморожен, а claim снят.

## Граница датасета в recorder-е

`beginMarketFinalization(marketId, settlementFeeds)` СИНХРОННО (ни одного
`await`) переводит recording-сессию в `FINALIZING`:

| Поток | До границы | После границы |
| --- | --- | --- |
| `POLYMARKET_MARKET` (book/price_change/…) | пишется | НЕ пишется |
| обычные RTDS (binance/chainlink spot) | пишется | НЕ пишется |
| settlement TWAP точной identity | пишется | пишется до seal |

Отсутствие `await` — не стиль: события, уже стоящие в очереди шины, и
наблюдения общих spot-фидов (живых ради ДРУГИХ рынков) не должны иметь шанса
попасть в датасет после границы.

После `sealMarket` сессия остаётся `SEALED`-надгробием до `finalizeMarket`:
между заморозкой и снятием claim-а рынок ещё присылает события, и без
надгробия ленивый допуск создал бы ВТОРУЮ сессию поверх готового датасета.

## Сирота откаченного приобретения

Снимок удерживаемого рынка доступен уже в `OPENING` — иначе терялся бы первый
(опорный) book-снапшот. Плата за это — окно, в котором запись уже началась, а
транзакция приобретения ещё может откатиться:

```text
OPENING: subscribeMarket() ok → initial book → допуск → сессия + первая строка
         RTDS subscribe FAILED → rollback → claim рынка исчез
         recording-сессия ОСТАЛАСЬ с одной строкой
```

Оставить её нельзя: на следующем тике приобретение повторится, но
recording-сессия уже существует, и новый initial book попадёт в ТОТ ЖЕ файл
БЕЗ повторного допуска. Один датасет склеил бы отказавшее поколение подписки,
дыру и поколение-повтор — для replay это ложь о непрерывности наблюдений.

Поэтому `lifecycle.runOnce()` начинается со сноса сирот:

```text
recording-сессия ACTIVE
  + есть первая записанная строка
  + НЕ принята lifecycle
  + claim collector:raw отсутствует
        ↓
recorder.finalizeMarket(SHUTDOWN)   storage удаляет незавершённый .jsonl,
                                    recorder снимает сессию и routing
        ↓
следующее приобретение начинает ЧИСТУЮ новую сессию
```

**Почему «нет claim-а» — надёжный признак, а не гонка.** Claim создаётся
СИНХРОННО при резервации рынка, до первого `await` транзакции, и исчезает
только при откате либо явном `release`. Значит, пока приобретение идёт, claim
есть; «строки есть, claim-а нет» — это уже завершившийся откат. Предусловие
вызова (`runOnce()` идёт ПОСЛЕ дожданного control-прохода тика) закрывает
остаток.

**Что не сносится:** сессии, уже принятые lifecycle (у них свой путь границы);
`FINALIZING`/`SEALED` (там claim снят ШТАТНО — после заморозки датасета, и
архивом владеет финализатор); сессии без единой записанной строки.

## Разделение владения RTDS

```text
PolymarketSubscriptionController:  физическая подписка фида + ref-count по рынкам
ExternalMessageRecorder:           в какие market-файлы писать наблюдение фида
```

Один физический фид `btcusdt` обслуживает все BTC-рынки: одно наблюдение
записывается в файл КАЖДОГО подписанного рынка (по одной строке на файл), но
физическая подписка при этом ровно одна. Второго ref-counter-а в коллекторе
нет.

## Финальный header: обогащение, а не пересборка

```text
LINE 1 при допуске                     LINE 1 после финализации
─────────────────────────────────      ─────────────────────────────────
{ headerVersion: 2,                    { headerVersion: 2,
  source, conditionId, question,         source, conditionId, question,
  outcomes, family,                      outcomes, family,
  timing: { startsAt, expiresAt },       timing: { …, recordingStartsAt },
  crypto }                               crypto,
                                         finalization: { status, winning,
                                           provenance, crypto, settlement } }
```

Возврат к legacy `headerVersion: 1` означал бы два несовместимых shape под
разными версиями в ОДНОМ датасете. При нехватке места в meta-блоке (16 KiB)
выбрасывается только `finalization.outcomes` (флаг `truncated`); победитель,
происхождение и settlement-числа не усекаются никогда.

## Порядок остановки

```text
stop control loop / no new acquisitions
      ↓
lifecycle.runOnce()                  истёкшие сессии → FINALIZING
lifecycle.awaitAllSettlementCaptures() датасеты заморожены, claim-ы сняты
      ↓
MarketFinalizer.drain()              дождаться официальных резолюций
MarketFinalizer.close()              official → fallback → discard
      ↓
lifecycle.close()                    ACTIVE (не истёкшие) → SHUTDOWN,
                                     claim-ы сняты
      ↓
CEX controller close → PM controller close → PM source close
      → client.closeSubscriptions → bus.drain → recorder.close → bus.close
```

Порядок продиктован данными: сначала доводятся до конца уже начатые записи
(иначе истёкший рынок остался бы без архива, а его незавершённый `.jsonl`
забрал бы startup cleanup), и только потом снимаются физические подписки.

## CEX не привязан к PM lifecycle

Истёкший BTC 5m рынок Polymarket НЕ означает остановку Binance/Bybit/OKX. CEX
остаётся независимым непрерывным raw-потоком, чьё желаемое состояние задаёт
только `CexPolicy`:

```text
CexPolicy → CexSubscriptionController → CexSource → ExternalMessageBus
                                                      → CexWindowRecorder
```

## Конфигурация

| Параметр | Env | Дефолт | Обоснование |
| --- | --- | --- | --- |
| `collection.settlementGraceMs` | `COLLECTOR_SETTLEMENT_GRACE_MS` | `5000` | измеренная задержка доставки TWAP 1116–2155 мс (2026-08-26) с запасом ×2 |
| `finalization.enrichmentRetryMs` | `COLLECTOR_ENRICHMENT_RETRY_MS` | `30000` | parity с legacy `ENRICHMENT_INTERVAL_MS` |
| `finalization.enrichmentMaxWaitMs` | `COLLECTOR_ENRICHMENT_MAX_WAIT_MS` | `3600000` | замер: самый медленный сигнал (`finalPrice`) до ~21.6 мин; 60 мин покрывают ×2.8 |
| `control.acquireLimit` | `DATA_COLLECTION_MAX_MARKETS` | `10` | сколько первых кандидатов плана приобретать за тик |
| `control.tickMs` | `COLLECTOR_CONTROL_TICK_MS` | `5000` | каденция control-цикла (границу датасета НЕ определяет) |

## Диагностика

`DataCollector.status()` несёт два новых раздела:

```text
collection:    activeSessions, finalizingSessions, attachedTotal, sealedTotal,
               claimsReleased, completedTotal, shutdownSessions,
               finalizationFailures, sessionsWithoutClaim,
               orphanSessionsDiscarded
finalization:  pendingFinalizations, archivedTotal, archiveFailures,
               officialFinalizations, fallbackFinalizations,
               fallbackByTimeout, fallbackByShutdown, discardedUnresolvable
```

`sessionsWithoutClaim` ненулевой означает рассинхрон recording-контура и
control-plane: запись идёт, а claim-а нет — такую сессию нельзя корректно
финализировать. `orphanSessionsDiscarded` растёт вместе с `failed`-исходами
приобретения: это нестабильный транспорт, а не дефект записи.

## Проверка датасета после реального прогона

```bash
npx tsx scripts/validate-raw-archives.mts ./data/snapshots --json report.json
```

Валидатор читает УЖЕ ЗАПИСАННЫЙ корень и проверяет: `formatVersion: 2` и
`headerVersion: 2`, наличие `runId`/`sequence` у каждого наблюдения и
строгое возрастание `sequence` внутри одного прогона, опорный book-снапшот
CLOB, наличие RTDS у крипто-рынка, ОТСУТСТВИЕ CLOB-строк после границы
датасета, `finalization` с победителем и происхождением у завершённых
архивов, а для CEX — что ни одно наблюдение не вышло за окно партиции.
Сравнения OLD и NEW датасетов он не делает: это следующий этап квалификации.
