# @polymarket/collector — допуск, жизненный цикл записи и владелец `collector:raw`

## Почему это сделано так

До cutover recording-сессию рынка создавал `MarketCollectionCoordinator` ДО
открытия подписки (recorder-first): координатор владел источником, знал набор
рынков заранее и регистрировал их в recorder до первого события. Это связывало
сбор с владением источниками: коллектор создавал `PolymarketSource`/`CexSource`,
открывал подписки и закрывал транспорт.

Cutover разрывает эту связь. Источники существуют физически независимо от
коллектора; их подписками управляет общий control-plane
(`PolymarketControlRuntime` / `CexSubscriptionController`). Коллектор становится
обычным владельцем claim-ов (`collector:raw`) и обычным подписчиком общей шины.
Появляется новый вопрос, которого раньше не было: **как решить, записывать ли
рынок, если recorder видит его первое наблюдение, а заранее список рынков ему
никто не отдал.** На него отвечает `PolymarketCollectionGate`.

## Алгоритм допуска

```text
POLYMARKET_MARKET (payload.market = X)
        ↓  (в recorder)
активная сессия X есть?
   ├── ДА  → писать напрямую, policy НЕ пересчитывать
   └── НЕТ → sessionProvider(X) == gate.admit(X):
                asMarketId(X)                      → невалиден → игнор
                universe.get(POLYMARKET, marketId) → нет       → игнор (unknown)
                filter.matches(entry, policy, market.startsAt) → нет → игнор (policy)
                controller.getHeldMarket('collector:raw', id)  → нет → игнор
                                                       (ignoredNotHeldByCollector)
                → registration → recorder.registerMarket → записать ЭТО ЖЕ сообщение
```

### Шаги

1. **Активная сессия important сначала.** Recorder держит карту сессий. Если
   сессия рынка уже есть, запись идёт напрямую; провайдер (а значит и policy)
   не вызывается вовсе. Так policy решает вопрос «НАЧИНАТЬ ли сбор», а не рвёт
   уже начатый lifecycle на каждом сообщении.
2. **Парсинг identity.** `payload.market` — это conditionId рынка, он же
   canonical `MarketId`. Непарсируемое значение — защитный игнор.
3. **Lookup в canonical universe.** Рынок, которого нет в текущем
   `MarketUniverse`, коллектору неизвестен — игнор. Это же отсекает чужой
   трафик разделяемых подписок.
4. **Owner policy на `market.startsAt`.** Тот же момент, что у планировщика
   подписок при приобретении. Согласует «записывать ли» с «подписываться ли».
5. **Подтверждение claim-а.** Совпадения policy НЕДОСТАТОЧНО: на общей шине
   рынок мог открыть ДРУГОЙ владелец (`strategy:A`). Контроллер подписок
   отвечает, держит ли рынок сам коллектор, и отдаёт immutable
   vendor-подготовку. Чужой рынок игнорируется отдельным счётчиком
   `ignoredNotHeldByCollector` — это не «не подошёл под policy», а нормальная
   работа shared control-plane.
6. **Сборка registration** из canonical `Market` + подготовки: canonical header
   (`headerVersion: 2`), tokenIds из `outcomes`, `rtdsFeeds` из подготовки
   удерживаемого рынка. Без `startsAt` — запись с первого наблюдения, потому
   что это опорный снапшот стакана.

## Почему первое сообщение не теряется

Провайдер вызывается СИНХРОННО внутри обработчика того же сообщения; между
`registerMarket` и записью нет `await`. Поэтому событие, которое инициировало
создание сессии, проходит через неё немедленно (одна запись, не ноль). Это
прямой инвариант, а не следствие порядка подписчиков на шине.

## Почему policy на `startsAt`, а не на `now`

Первое наблюдение книги приходит уже ПОСЛЕ старта торгов. Если оценивать
policy на `now`, рынок с полуоткрытым окном policy (`effectiveUntil`) мог бы
«внезапно» перестать подходить ровно тогда, когда начал присылать данные, —
хотя control-plane законно приобрёл его до старта. Оценка на `startsAt`
повторяет решение планировщика: приобрели → значит и записываем.

## Что делает recorder, а что gate

| Ответственность | Владелец |
| --- | --- |
| подписка на шину, запись, RTDS fan-out, CEX-окна, seal/finalize | `ExternalMessageRecorder` |
| «начинать ли собирать этот рынок» (universe + policy + claim) | `PolymarketCollectionGate` |
| граница датасета, seal, снятие claim-а | `PolymarketCollectionLifecycle` |
| Gamma-резолюция, финальный header, архив | `MarketFinalizer` |
| физические подписки под `collector:raw` | shared control-plane |

Gate не подписывается на шину и не пишет на диск. Он — чистая политика,
которую recorder дёргает функцией при отсутствии сессии. Поэтому граница
recorder-а не расширяется (он по-прежнему не знает про `MarketUniverse`/policy),
а коллектор остаётся sibling-consumer, а не gate перед семантикой.

## Пример кода

```typescript
const gate = new PolymarketCollectionGate({
  universe,
  policy: pmPolicy,
  subscriptions: polymarketController,
  logger,
});
const recorder = new ExternalMessageRecorder({
  bus,
  storage: polymarketStorage,
  logger,
  cex: { bus, storage: cexStorage },
  sessionProvider: gate.sessionProvider(),
});
const lifecycle = new PolymarketCollectionLifecycle<SelectedPolymarketMarket>(
  { recorder, subscriptions: polymarketController, clock, logger },
  { settlementGraceMs: 5_000 },
);
recorder.start();
```

## Границы и что отложено

Границы (E/I) закреплены `contour-boundary.test.ts`: src не импортирует
source-классы/транспорт (`polymarket-v2`/`cex-v2` НЕТ в allow-list — registration
строится из canonical `Market`, без vendor-деривации фидов); replay-контур и
recorder не зависят от коллектора.

Отложено осознанно:

- **Замена отказавшего источника** для уже пишущихся сессий: реконсиляция
  терминального отказа `PolymarketSource` живёт в контроллере подписок, и
  восстановление recording-сессий поверх нового поколения подписок — отдельная
  задача.
- **Crash recovery незавершённых `.jsonl`**: их по-прежнему удаляет startup
  cleanup storage. Восстановление прерванной сессии требует доверия к
  недописанному файлу, а не только к его наличию.

## Жизненный цикл записи (`PolymarketCollectionLifecycle`)

```text
claim collector:raw ДО открытия рынка          (control-plane)
        ↓
первое CLOB-наблюдение → gate → recorder       (сессия создана)
        ↓ syncSessions(): attach + immutable selected
ACTIVE ───────────────── таймер РОВНО на expiresAt
        ↓ beginFinalization()
FINALIZING              CLOB и обычные RTDS больше не пишутся
        ↓ settlementGraceMs (5 с по умолчанию)
seal                    payload заморожен
        ↓
release('collector:raw')   claim снимается ПОСЛЕ заморозки
        ↓
MarketFinalizer            Gamma → финальный header → .jsonl.gz
        ↓ completeFinalization()
сессии больше нет
```

### Три решения, которые определяют этот порядок

1. **Истечение по таймеру, а не по control-тику.** Тик ходит раз в
   секунды-десятки секунд. Ждать его значило бы дописывать CLOB истёкшего
   рынка всё это время: граница датасета определялась бы каденцией discovery,
   а не расписанием рынка. `runOnce()` остаётся страховкой.
2. **Claim снимается ПОСЛЕ seal.** Последний claim закрывает разом CLOB,
   spot-фиды И settlement-поток. Снять его на `expiresAt` значило бы потерять
   граничное наблюдение TWAP, которое RTDS доставляет на 1.1–2.2 с позже
   (характеризация 2026-08-26) — то самое, по которому рынок и рассчитывается.
   Осознанный размен: физический CLOB живёт ещё несколько секунд, но в датасет
   уже НЕ пишется (границу держит recorder, а не транспорт). «Полуclaim-ов» и
   частичного владения ресурсом ради этих секунд не вводится.
3. **Сессия не зависит от `MarketUniverse`.** Рынок исчезает из снимка
   discovery СРАЗУ после истечения — ровно тогда, когда его сессии предстоит
   самое важное. После attach lifecycle держит immutable подготовку у себя.

### Граница датасета в recorder-е

`beginMarketFinalization(marketId, settlementFeeds)` СИНХРОННО (ни одного
`await`) переводит recording-сессию в `FINALIZING`:

| Поток | До границы | После границы |
| --- | --- | --- |
| `POLYMARKET_MARKET` (book/price_change/…) | пишется | НЕ пишется |
| обычные RTDS (binance/chainlink spot) | пишется | НЕ пишется |
| settlement TWAP точной identity | пишется | пишется до seal |

После `sealMarket` сессия остаётся `SEALED`-надгробием до `finalizeMarket`:
между заморозкой и снятием claim-а рынок ещё присылает события, и без
надгробия ленивый допуск создал бы ВТОРУЮ сессию поверх готового датасета.

## Финальный header: обогащение, а не пересборка

`buildFinalizedMarketHeader` берёт ТОТ ЖЕ canonical header, который записал
допуск, и добавляет к нему `finalization` + момент начала записи:

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
разными версиями в ОДНОМ датасете: читатель, диспетчеризующий по
`headerVersion`, увидел бы у одного рынка V2-строку при регистрации и
V1-строку после архивации. При нехватке места в meta-блоке выбрасывается
только `finalization.outcomes` (флаг `truncated`); победитель, происхождение и
settlement-числа не усекаются никогда — архив без итога хуже отсутствия архива.
