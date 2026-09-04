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
```

Collector — **sibling**, а не gate: если он отключён/сломан/не хочет рынок,
семантический путь всё равно получает сообщения. Пакет НЕ создаёт и не
закрывает источники, не создаёт вторую шину и не управляет физическими
подписками — этим владеет shared control-plane
(`@polymarket/polymarket-control-runtime`,
`@polymarket/cex-subscription-control`).

## 2. Что делает пакет

Ровно две вещи:

- **`COLLECTOR_RAW_OWNER_KEY`** (`'collector:raw'`) — canonical идентичность
  владельца-коллектора. Ею параметризуются ДВА спроса (Polymarket и CEX);
  одна константа не даёт им разъехаться на разных владельцев.
- **`PolymarketCollectionGate`** — политика допуска Polymarket-рынка к записи
  по первому наблюдению. Передаётся recorder-у как `sessionProvider`.

Подписка на шину, запись на диск, RTDS fan-out, CEX-окна — всё это делает
`ExternalMessageRecorder`; storage — `@polymarket/data-collection`. Второго
пути записи здесь нет.

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

RTDS-фиды в этой фазе НЕ регистрируются (`rtdsFeeds` не задаётся) — см. §8.
Vendor-подготовку (`prepareMarket`) gate не трогает: она принадлежит
subscription-controller.

## 6. Границы (закреплено `contour-boundary.test.ts`)

- **E.** src не импортирует `CexSource`/`PolymarketSource`/`Ccxt*Watcher`,
  `ccxt`, `@polymarket/client`, `@polymarket/cex-market-data`,
  `@polymarket/bindings`; закрытый allow-list импортов.
- **I.** replay-контур (`backtesting`, `data-collection`, `snapshot-readers`)
  и recorder не зависят от коллектора — провайдер сессий инъецируется, а не
  импортируется.

## 7. Использование

```typescript
import { PolymarketCollectionGate, COLLECTOR_RAW_OWNER_KEY } from '@polymarket/collector';
import { ExternalMessageRecorder } from '@polymarket/external-message-recorder';

const gate = new PolymarketCollectionGate({ universe, policy: pmPolicy, logger });
const recorder = new ExternalMessageRecorder({
  bus,
  storage: polymarketStorage,
  logger,
  cex: { bus, storage: cexStorage },
  sessionProvider: gate.sessionProvider(),
});
recorder.start();

// Спрос коллектора в общий control-plane:
await pmControlRuntime.runOnce([{ ownerKey: COLLECTOR_RAW_OWNER_KEY, policy: pmPolicy, acquireLimit }]);
await cexController.reconcile([{ ownerKey: COLLECTOR_RAW_OWNER_KEY, policy: cexPolicy }], now);
```

## 8. Чего в пакете НЕТ (и что отложено на lifecycle-этап)

Собственная шина, собственный subscription manager, control-события на шине,
прямое владение источниками — их не будет здесь никогда.

Отложено на следующий этап (полный CollectionSession lifecycle), причём
осознанно, а не по недосмотру:

- **RTDS-запись (spot-цены + settlement TWAP).** Фиды `btcusdt`/`btc/usd`
  РАЗДЕЛЯЕМЫ между всеми рынками актива. Без expiry/seal сессия рынка живёт до
  остановки процесса, и запись фидов в неё дописывала бы цены актива в датасет
  давно истёкшего рынка. Поэтому фиды регистрирует этап, который вводит
  expiry/seal. CLOB-события самого рынка так не текут: они прекращаются с его
  истечением.
- **Терминальное состояние сессии.** Gate stateless, а истёкший 5m-рынок Gamma
  держит `active` до резолюции, поэтому в мире, где есть seal/finalize, позднее
  наблюдение могло бы РЕ-допустить уже закрытый рынок (zombie-сессия). В этой
  фазе seal/finalize НЕ вызываются, так что триггера нет; терминальный набор
  ключей введёт lifecycle-этап вместе с seal.
- **Vendor-данные для финализации.** `MarketFinalizer` требует
  `SelectedPolymarketMarket` (vendor-модель), которой canonical registration не
  несёт. Как финализация получит vendor-данные (из кэша `prepareMarket`
  контроллера либо повторным `fetchMarket` по `gammaMarketId`) — решает
  lifecycle-этап.
- **Допуск по claim-состоянию.** Сейчас допуск — по policy (как требует
  спецификация этапа). Гарантия «полный архив только для рынков, приобретённых
  самим коллектором» (а не подхваченных с середины на разделяемой подписке) —
  тоже lifecycle-этап.
- **release claim, expiry, settlement grace, resolution fallback, dataset
  sealing.**
