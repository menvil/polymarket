# @polymarket/collector

Сборщик сырых данных как **sibling-consumer** общего `ExternalMessageBus`.
После Collector-cutover сборщик перестаёт владеть источниками данных: он
выражает интерес claim-ами `collector:raw` в общем control-plane и записывает
интересующие рынки как обычный подписчик шины.

## 1. Место в контуре

```text
Sources
  ↓ source-native ExternalMessage
ОДИН ExternalMessageBus
  ├── Collector (ExternalMessageRecorder + PolymarketCollectionGate)
  ├── PolymarketSemanticAdapter
  └── CexSemanticAdapter

PolymarketSubscriptionController
  ▲ getHeldMarket (допуск) / release (граница датасета)
  └── PolymarketCollectionLifecycle → MarketFinalizer
```

Collector — **sibling**, а не gate: если он отключён/сломан/не хочет рынок,
семантический путь всё равно получает сообщения. Пакет НЕ создаёт и не
закрывает источники, не создаёт вторую шину и не управляет физическими
подписками — этим владеет shared control-plane
(`@polymarket/polymarket-control-runtime`,
`@polymarket/cex-subscription-control`).

## 2. Что делает пакет

- **`COLLECTOR_RAW_OWNER_KEY`** (`'collector:raw'`) — canonical идентичность
  владельца-коллектора. Ею параметризуются ДВА спроса (Polymarket и CEX);
  одна константа не даёт им разъехаться на разных владельцев.
- **`PolymarketCollectionGate`** — политика допуска Polymarket-рынка к записи
  по первому наблюдению (universe + policy + подтверждённый claim). Передаётся
  recorder-у как `sessionProvider`.
- **`PolymarketCollectionLifecycle`** — жизненный цикл УЖЕ НАЧАТОЙ записи:
  `ACTIVE → expiresAt → FINALIZING → settlement grace → seal → release claim`.
- **`buildFinalizedMarketHeader`** и DTO финализации — формат
  `finalization`-раздела canonical header-а, который заполняет
  `MarketFinalizer`.

Подписка на шину, запись на диск, RTDS fan-out, CEX-окна — всё это делает
`ExternalMessageRecorder`; storage — `@polymarket/data-collection`; физические
подписки — `PolymarketSubscriptionController`. Второго пути записи и второго
владельца подписок здесь нет.

## 3. Главный routing-инвариант

```text
POLYMARKET_MARKET (market = X)
        ↓
активная сессия X?  ──YES──►  пишем напрямую (policy НЕ пересчитывается)
        │NO
        ▼
gate.admit(X):
   MarketUniverse.get(POLYMARKET, X)  ── нет ──►  игнор (unknown)
        │ есть
        ▼
   policy подошла на market.startsAt?  ── нет ──►  игнор (uninteresting)
        │ да
        ▼
   collector:raw реально держит X?    ── нет ──►  игнор
        │ да                                     (ignoredNotHeldByCollector)
        ▼
   registration  →  recorder создаёт сессию и пишет ЭТО ЖЕ первое сообщение
```

Первое raw-наблюдение, инициировавшее сессию, **не теряется**: recorder
спрашивает провайдера синхронно внутри обработчика того же сообщения и сразу
его записывает (см. `sessionProvider` в
`@polymarket/external-message-recorder`).

## 4. Policy — на `market.startsAt`

Gate оценивает owner policy на `market.startsAt` — тот же момент, что
использует subscription planner при ПРИОБРЕТЕНИИ рынка. Так решение
«записывать ли» согласовано с решением «подписываться ли»: рынок, который
control-plane приобрёл под `collector:raw`, будет и допущен к записи, когда
придёт его первое наблюдение — независимо от того, сместилось ли к этому
моменту полуоткрытое окно policy.

Policy коллектора ДОЛЖНА совпадать с policy спроса `collector:raw`. Иначе
коллектор подписался бы на одно, а записывал другое.

## 5. Registration из canonical `Market`

Единственное представление рынка после cutover — canonical `Market` из
`MarketUniverse`. Из него строится:

- `marketMeta` (marketId=conditionId, question, tokenIds из `outcomes`,
  expiresAt) — **без `startsAt`**: запись активируется НЕМЕДЛЕННО, чтобы
  первое наблюдение (опорный `book`-снапшот при подписке, до старта торгов) не
  отбрасывалось storage как `inactive`. Без опорного снапшота последующие
  `price_change`-дельты не с чем сопоставить;
- canonical header (`headerVersion: 2`, `source: 'polymarket'`, identity,
  timing, outcomes, crypto-номинал) — НЕ vendor Gamma blob. `headerVersion: 2`
  СОЗНАТЕЛЬНО отличается от legacy `headerVersion: 1` координатора (иначе один
  дискриминатор нёс бы два несовместимых shape).

`rtdsFeeds` берутся из immutable vendor-подготовки УДЕРЖИВАЕМОГО рынка —
той же, по которой контроллер открыл транспорт. Второй `prepareMarket()` был
бы хуже его отсутствия: два независимых снимка discovery разошлись бы, и
рынок записывался бы с одним набором фидов, а подписан был бы с другим. Сами
подписки gate не открывает — `rtdsFeeds` регистрации это ТОЛЬКО маршрутизация
записи.

## 6. Границы (закреплено `contour-boundary.test.ts`)

- **E.** src не импортирует `CexSource`/`PolymarketSource`/`Ccxt*Watcher`,
  `ccxt`, `@polymarket/client`, `@polymarket/cex-market-data`,
  `@polymarket/bindings`; закрытый allow-list импортов.
- **I.** replay-контур (`backtesting`, `data-collection`, `snapshot-readers`)
  и recorder не зависят от коллектора — провайдер сессий инъецируется, а не
  импортируется.

## 7. Использование

```typescript
import {
  COLLECTOR_RAW_OWNER_KEY,
  PolymarketCollectionGate,
  PolymarketCollectionLifecycle,
} from '@polymarket/collector';
import { ExternalMessageRecorder } from '@polymarket/external-message-recorder';

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

// Спрос коллектора в общий control-plane:
await pmControlRuntime.runOnce([{ ownerKey: COLLECTOR_RAW_OWNER_KEY, policy: pmPolicy, acquireLimit }]);
await cexController.reconcile([{ ownerKey: COLLECTOR_RAW_OWNER_KEY, policy: cexPolicy }], now);
```

## 8. Жизненный цикл записи

```text
claim collector:raw ДО открытия рынка   (control-plane)
        ↓
первое CLOB-наблюдение → ACTIVE          (gate + recorder)
        ↓ таймер РОВНО на expiresAt
FINALIZING                               CLOB и обычные RTDS больше не пишутся
        ↓ settlementGraceMs (5 с)        только settlement TWAP точной identity
seal                                     payload заморожен
        ↓
release('collector:raw')                 claim снимается ПОСЛЕ заморозки
        ↓
MarketFinalizer                          Gamma → финальный header → .jsonl.gz
```

Три решения, которые определяют этот порядок, разобраны в
`docs/collector.md`: истечение по таймеру сессии (а не по control-тику),
снятие claim-а ПОСЛЕ seal (иначе теряется граничное наблюдение TWAP) и
независимость сессии от `MarketUniverse` (рынок исчезает из снимка discovery
сразу после истечения).

Конфигурация: `settlementGraceMs` (по умолчанию `5_000` — измеренная
задержка доставки RTDS ×2).

## 9. Чего в пакете НЕТ

Собственная шина, собственный subscription manager, control-события на шине,
прямое владение источниками — их не будет здесь никогда. Ни `subscribeMarket`,
ни `prepareMarket`, ни ref-count физических фидов: это проверяется
structural-тестом границы.

Осознанно отложено:

- **Замена отказавшего источника** для уже пишущихся сессий: реконсиляция
  терминального отказа `PolymarketSource` живёт в контроллере подписок.
- **Crash recovery незавершённых `.jsonl`**: их удаляет startup cleanup
  storage — восстановление прерванной сессии требует доверия к недописанному
  файлу, а не только к его наличию.
