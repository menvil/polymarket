# Корректность market-state: Tier 1 фиксы

## Контекст

Аудит `packages/application/market-state` выявил группу ошибок корректности,
способных давать ложные сделки и врать в бэктесте. Tier 1 — четыре фикса
в `CryptoMarketDataStore`, закрывающие look-ahead bias, потерю данных и
порчу истории битыми timestamp.

> Источник проблем и приоритизация: обсуждение ревью market-state (Tier 1 / #1 / #10+#9 / Tier 3).

---

## #6 Look-ahead в `recentTradePressure`

### Проблема
`_computeRecentTradePressure(asset, venue, nowMs)` шёл с конца массива трейдов
и ломался по нижней границе (`exchangeTsMs < minTs`), **но не проверял верхнюю
границу**. При out-of-order replay в бэктесте в массиве могут оказаться трейды
«из будущего» относительно времени снапшота книги — они попадали в расчёт
давления. Это look-ahead bias: сигнал «знает» про сделки, которых на момент
решения ещё не было.

### Решение
Добавлен пропуск будущих трейдов:

```typescript
for (let index = trades.length - 1; index >= 0; index--) {
  const trade = trades[index]!;
  if (trade.exchangeTsMs > nowMs) continue; // #6: skip future trades
  if (trade.exchangeTsMs < minTs) break;
  // ... аккумуляция давления
}
```

---

## #8 Окна `getRecent` привязаны к `nowMs`

### Проблема
`CryptoPriceHistoryView.getRecent(source, lookbackMs)` и
`CryptoVenueHistoryView.getRecentBooks/getRecentTrades` считали окно от timestamp
**последнего тика источника**, а не от текущего времени контекста. Если источник
давно не обновлялся, `getRecent(1000)` всё равно возвращал «последнюю секунду»
относительно старого тика — стратегия думала, что данные свежие.

### Решение
Добавлен опциональный параметр `nowMs` (как уже сделано в `TradeTape.getRecent`
и `OrderBookHistory.getRecent` в домен-слое):

```typescript
getRecent(source, lookbackMs, nowMs?) // окно [nowMs - lookbackMs, nowMs]
```

- Если `nowMs` задан — окно `[nowMs - lookbackMs, nowMs]` с **верхней границей**
  (заодно отсекает будущие точки — анти look-ahead).
- Если не задан — legacy-поведение (привязка к последнему тику).

Все вызовы в `CryptoSignalRegistry`, `RegimeDetector.classify`, `CrowdDeviation*`
и `OrderBookWallStrategy` обновлены и передают `context.nowMs` / `snapshot.nowMs`.

---

## #14 Timestamp-guard на входе

### Проблема
`updatePrice` / `updateCexBook` / `updateCexTrade` доверяли `exchangeTsMs`
без проверки. Так как `pruneByTimestamp` отсекает историю относительно
`latestTs - retention`, **один тик с битым «будущим» timestamp задирал `latestTs`
и вычищал всю реальную историю**. Timestamp в секундах (~1.7e9) вместо
миллисекунд тоже принимался и вставлялся как «очень старый» тик.

### Решение
Метод `_acceptTimestamp` отбраковывает тик, если timestamp:
1. не конечное число;
2. меньше `MIN_PLAUSIBLE_EPOCH_MS` (1e12, 2001-09) — отсекает секунды/мусор;
3. опережает `receivedTsMs` больше чем на `maxFutureSkewMs` (default 5000 мс).

Отбракованные тики считаются в `rejectedTickCount()` (наблюдаемость) и логируются,
если в конфиг передан `logger`. Конфиг: `maxFutureSkewMs`, `logger`.

---

## #5 Трейды не дедуплицируются по timestamp

### Проблема
`insertSortedUniqueByTimestamp` **замещал** элемент с тем же `exchangeTsMs`.
Для книг это допустимо (последний снапшот побеждает), но у трейдов несколько
сделок часто имеют одинаковый ms-timestamp — старая сделка терялась, искажая
объём и trade pressure.

### Решение
Для trade-истории используется новый помощник `insertSortedAllowDuplicates`,
который сохраняет порядок по timestamp, но **не замещает** элементы с равным ts.
Книги и цены по-прежнему используют unique-replace.

---

## #1 Утечка по закрытым рынкам (cleanup при MARKET_CLOSED)

### Проблема
В реальной сборке (`buildMarketData.ts`) запускается только `marketDataStore.start()`,
а `bookCollector.start()` / `tapeCollector.start()` **не вызываются**. Коллекторы
работают как пассивные буферы (запись через `recordDirect`). Но их обработчик
`MARKET_CLOSED` живёт только внутри их собственного `start()` — то есть был
**мёртв**. А `MarketDataStore` на `MARKET_CLOSED` вообще не подписывался.

Итог: истории стакана, ленты трейдов и `_topOfBooks` закрытых рынков **жили
вечно**. Для 5-минутных рынков 24/7 (~570 новых instrumentId в день) это утечка,
копящаяся днями.

### Решение
`MarketDataStore` стал **единственным владельцем** подписок EventBus и теперь
слушает `MARKET_CLOSED`:

1. Строит reverse index `marketId → Set<instrumentId>` из `BOOK_UPDATED`
   (событие несёт и `instrumentId`, и `marketId`).
2. На `MARKET_CLOSED` удаляет `_topOfBooks` / `_topOfBookTimestampsMs` рынка
   за O(k) и делегирует очистку коллекторам.

Коллекторы получили публичный `clearMarket(marketId)` — пассивную точку очистки
(параллель к `recordDirect`). Их `_cleanup` теперь вызывается через неё, а не
через собственную подписку.

### Footgun
**Не вызывайте `collector.start()`**, если коллектор передан в `MarketDataStore`:
иначе каждое событие запишется дважды (подписка коллектора + `recordDirect` стора).
Контракт владения задокументирован в TSDoc `MarketDataStore`.

## #9 + #10 Фильтрация бирж в `weightedVenuePrice`

### Проблема
`weightedVenuePrice` (используется сигналами `cex_vs_chainlink_basis` и
`cex_weighted_microprice_momentum`) усреднял microprice по биржам **без
фильтрации**:
- **#9**: устаревшие и широкие (большой спред) биржи попадали в среднюю цену.
  Одна свежая биржа маскировала две старые — `stale` считался уже постфактум
  по `max(lastTsMs)`.
- **#10**: рассинхрон между биржами не проверялся. При `staleMs=2000` одна биржа
  могла быть на 0мс, другая на 1900мс — обе «fresh», но вместе это мусор для
  секундного сигнала.

> Замечание: основной сигнал `cex_chainlink_lead_lag` уже фильтровал stale/spread
> в собственном цикле — проблема касалась только basis/momentum.

### Решение
`weightedVenuePrice` принимает `WeightedVenuePriceFilter` и:
1. **#9** — пропускает биржи с `ageMs ∉ [0, staleMs]` или `spreadBps > maxSpreadBps`;
   требует минимум `minVenueCount` прошедших фильтр бирж.
2. **#10** — отклоняет агрегат, если `maxVenueTs − minVenueTs > maxCrossVenueSkewMs`
   (новый параметр запроса, default `DEFAULT_MAX_CROSS_VENUE_SKEW_MS = 250`).

Если качество низкое — функция возвращает `undefined`, и сигнал не эмитится
(вместо выдачи мусорного значения с флагом `stale`). В `cex_vs_chainlink_basis`
дополнительно добавлен ранний выход при невалидном/устаревшем Chainlink
(консистентно с lead-lag).

Дефолты согласованы с lead-lag: `staleMs=2000`, `maxSpreadBps=10`,
`minVenueCount=min(2, venues.length)`.

> Blast radius: оба сигнала на момент изменения не потребляются ни одной
> продакшн-стратегией (диагностические) — поведение live-торговли не меняется.

## #3 Единый API свежести данных

### Проблема
`MarketDataStore` отдавал только `getTopOfBookTimestampMs`, и каждая стратегия
изобретала собственные stale-правила — путь к рассогласованным проверкам.

### Решение
Добавлены два метода:
- `getTopOfBookState(instrumentId, nowMs, staleMs): TopOfBookState | undefined`
  — `{ topOfBook, eventTsMs, ageMs, stale }`, возраст от `nowMs` (не от системных часов).
- `areBooksSynchronized(a, b, maxSkewMs): boolean` — проверка синхронности двух ног
  перед одновременной покупкой (кейс Binance/MEXC 10мс vs 100мс).

Тип `TopOfBookState` экспортируется из пакета. Методы аддитивны — существующий
`getTopOfBook` / `getTopOfBookTimestampMs` сохранены.

## #11 CryptoPriceStore — починка багов

Решение «только починить баги» (без рефакторинга — стор load-bearing для
CrossMarketArb / MarketRotation / BacktestEngine):
- **Валидация `updatePrice`**: игнор `price <= 0` / не конечной цены / не конечного timestamp.
- **Out-of-order**: тик старше уже сохранённого для того же источника не перезаписывает свежий.
- **Нормализация регистра** в `_parseSymbol` (lowercase+trim): `BTCUSDT` и `btc` → один asset.
- **`getResolution`**: fallback на последнюю Chainlink-цену **оставлен** (на него
  опирается live-settlement в `MarketRotation`), но задокументирован контракт —
  вызывать только на/после закрытия рынка, иначе преждевременный «исход».

## #12 + #13 Гигиена сигналов

- **#12**: `confidence` больше не выдаётся за вероятность. Добавлено поле
  `quality` (детерминированное качество данных: свежесть × согласие бирж),
  отделённое от `confidence`. TSDoc явно говорит: `confidence` калибрована
  только при переданном `confidenceByScore`, иначе это эвристика.
- **#13**: `CryptoSignalRequest.sources` и `CryptoSignalContext.venueHistory`
  задокументированы как сейчас не потребляемые встроенными сигналами
  (зарезервированы для пользовательских calculator'ов).

## #4 Top-N хранение стакана

`CexBookTick` хранил полный стакан CEX (до 50+ уровней) × частота × 30 мин
retention. Добавлен `maxBookLevels` (default 20) — стакан обрезается при записи.
Деривативы (mid/microprice/spread) считаются по top-of-book; OrderBookWall
работает с узкой полосой у вершины, поэтому top-20 безопасен.

## #7 Material-move notify layer

Промежуточный слой между «тишиной» (`notifyCexChanges=false`) и «шумом» (`=true`):
CEX-апдейт будит стратегию (`CRYPTO_MARKET_DATA`) только если microprice
сдвинулся ≥ `materialMoveBps` И прошло ≥ `materialMoveMinIntervalMs` (default 50)
с прошлого уведомления. По умолчанию слой выключен (`materialMoveBps=0`) —
поведение не меняется, пока не сконфигурирован. Закрывает потерю lead-lag edge
без захлёба scheduler.

## #2 BOOK_DEPTH будит стратегию

Раньше `BOOK_DEPTH` не вызывал `onChange` (допущение про paired `BOOK_UPDATED`) —
depth-only изменения (стенки, ликвидность, исчезновение уровней) терялись. Теперь
`BOOK_DEPTH` вызывает `onChange('BOOK')`. Scheduler коалесцирует dirty-флаги per
tick (`Map<strategyId, Set<TriggerReason>>`), поэтому парный
`BOOK_UPDATED + BOOK_DEPTH` даёт одну переоценку, а не двойную — флуда нет.

## #11 (полная миграция) Единый источник истины + удаление CryptoPriceStore

Вместо «только починить баги» выполнена полная миграция: `CryptoPriceStore`
**удалён**, его ответственности разделены.

### Было
`CryptoPriceStore` смешивал две вещи и **дублировал ценовой поток**: каждый тик
писался и в него, и в `CryptoMarketDataStore` (`main.ts`, `BacktestEngine`).

### Стало — две ответственности, два владельца
- **Цена** → `CryptoMarketDataStore` (единый источник истины; история + `getLatestPrice`).
- **Strike / resolution (lifecycle)** → новый `CryptoResolutionStore`. Цен не
  хранит; `getResolution()` берёт fallback-цену Chainlink из `CryptoMarketDataStore`.

### `snapshot.cryptoPrice` — теперь проекция
`StrategyScheduler` собирает `snapshot.cryptoPrice` из двух источников (цены из
`CryptoMarketDataStore`, strike/resolution из `CryptoResolutionStore`). Форма
поля не изменилась → ~12 стратегий-потребителей не тронуты. Лишняя подписка
`cryptoPriceStore.setOnChange` убрана из scheduler (CryptoMarketDataStore сам
эмитит `CRYPTO_PRICE`).

### Мигрированные потребители
`StrategyScheduler` (deps `cryptoResolutionStore`), `BacktestEngine`
(`IBacktestCryptoResolutionStore`, ценовой реплей только в marketData),
`MarketRotation`, `main.ts` (paper/live/backtest), `runMultiMarketBacktest`,
`buildStrategyEngine`. Арбитраж (`CrossMarketArb`) strike'и держал сам — не затронут.

### Валидация (money-critical)
- Unit + 2 интеграционных теста `CryptoResolutionStore` (settlement fallback на
  Chainlink из реального `CryptoMarketDataStore`, приоритет locked resolutionPrice).
- **E2E backtest** (BTC 5-мин, May 1): 0 errors, 2256 crypto price events,
  strike 78286.53 / resolution 78202.03 → `DOWN` (корректно), стратегия читает
  `chainlink`/`strike` из проекции. PnL-путь settlement не регрессировал.

## Follow-up батч (повторное ревью): #1–#10

Второй раунд ревью после миграции — закрыты остаточные баги и footgun'ы:

- **#1 пассивные коллекторы.** Из `BookDepthCollector`/`TradeTapeCollector` убраны
  `start()/stop()` и зависимость от EventBus — это чистые буферы (`recordDirect`/
  `clearMarket`). Двойная запись теперь невозможна на уровне типов (не «просьба в
  комментарии», а отсутствие `start()`). `buildMarketData` обновлён.
- **#2 надёжная очистка ленты.** `MarketDataStore` строит `instrumentId → marketId`
  из `BOOK_UPDATED` и прокидывает `marketId` в `tapeCollector.recordDirect`. Лента
  регистрируется под рынком даже когда каталог ещё не знает инструмент — дыра утечки закрыта.
- **#3 resetAsset.** `CryptoResolutionStore.resetAsset()` сбрасывает strike/resolution+locks;
  `MarketRotation._resolveStrikePrice` зовёт его на старте рынка — старое состояние
  не протекает в следующий 5-мин рынок при ротации.
- **#4 settlement-guard.** `getResolution(symbolOrAsset, { nowMs, settlementTsMs })`
  возвращает `undefined`, пока рынок не истёк — нет преждевременного исхода.
- **#5 cross-venue skew в главном lead-lag.** `cex_chainlink_lead_lag` теперь трекает
  `minTs/maxTs` и отклоняет агрегат при `maxTs-minTs > maxCrossVenueSkewMs`.
- **#6 linear lead-lag.** venue учитывается только при заданном ненулевом весе —
  без `weights` сигнал больше не строится из одного intercept.
- **#7 material notify per-venue.** `_lastCexNotify` теперь `Map<asset, Map<venue, …>>` —
  движение одной биржи не сбрасывает reference другой.
- **#8 trade-pressure notify.** `materialTradeNotional` — крупный трейд будит
  стратегию из `updateCexTrade` (раньше будил только book move).
- **#9 getNearest.** Добавлен `getNearest(source, tsMs, maxDistanceMs)`; momentum
  (в `weightedMicropriceMomentum` и `cex_chainlink_lead_lag`) берёт цену ~lookback
  назад с допуском, а не самую раннюю точку окна.
- **#10 нормализация стакана.** `updateCexBook` сортирует bids desc / asks asc —
  best bid/ask и деривативы не зависят от порядка уровней upstream.

Валидация follow-up: 81 тест market-state (+10), все пакеты build + typecheck,
e2e backtest даёт идентичный settlement (DOWN, strike 78286.53 / resolution 78202.03).

## Третий батч ревью (settlement lifecycle + остаточные дыры)

- **#2 marketId из BOOK_DEPTH.** `MarketDataStore` регистрирует `instrument→market`
  не только из `BOOK_UPDATED`, но и из `BOOK_DEPTH` (`snapshot.marketId`) — закрыт
  race «TRADE_RECEIVED до BOOK_UPDATED», когда лента не попала бы в reverse index.
- **#8 фильтрация уровней.** `updateCexBook` отсекает уровни с NaN/Inf/`price≤0`/`size≤0`
  до сортировки; пустая сторона → тик игнорируется. microprice/imbalance не мусорят.
- **#9 getNearestBeforeOrAt.** Добавлен метод «цена до-или-в-момент `tsMs`»; momentum
  (в `weighted_microprice_momentum` и live `cex_chainlink_lead_lag`) использует его
  вместо «ближайшей с любой стороны» — корректнее для бэктеста.
- **#3 startMarket lifecycle.** `CryptoResolutionStore.startMarket({symbolOrAsset,
  targetPrice?, settlementTsMs?, source?})` — атомарное открытие рынка (reset + lock +
  `_active` state). Инвариант «один активный рынок на актив» закреплён кодом: warn при
  перезаписи неразрешённого рынка. `setTargetPrice` остался только для replay/тестов;
  `MarketRotation._resolveStrikePrice` теперь использует `startMarket`. Полный
  `(asset, marketId)`-ключ отложен (runtime asset-ориентирован, один рынок на актив).
- **#7 momentum по одному набору venue.** `weightedVenuePrice` возвращает `usedVenues`;
  momentum считает `previous` только по биржам, вошедшим в `current`.
- **#5 cross-venue skew в linear + rolling.** `cex_chainlink_linear_lead_lag` (live) и
  `cex_chainlink_rolling_divergence` теперь трекают `minTs/maxTs` и отклоняют агрегат
  при рассинхроне — унифицировано с главным lead-lag.
- **#4 timestamp-aware settlement.** `LatestPriceReader` отдаёт `getLatestPricePoint`/
  `getNearestPricePoint` (с timestamp). `getResolution(opts{nowMs, settlementTsMs,
  maxResolutionLagMs})`: до истечения → `undefined`; Chainlink-fallback требует свежую
  цену около expiry (`getNearestPricePoint`, default лаг 10с), иначе `undefined` + warn —
  не резолвить рынок устаревшей ценой. `settlementTsMs` берётся из `startMarket`.
- **#9 docs.** `index.ts` и `TradeTapeCollector` header переписаны под пассивную модель
  (коллекторы не подписываются, нет `start()/stop()`).

Валидация: 91 тест market-state; все пакеты build + typecheck; e2e backtest даёт
идентичный settlement (DOWN, strike 78286.53 / resolution 78202.03, 0 errors),
без stale-price warnings.

## Четвёртый батч ревью (lifecycle settlement + остаточная утечка)

- **#1 поздняя регистрация marketId (TradeTapeCollector).** Раньше `_byMarket`
  пополнялся только при создании ленты — если первый трейд пришёл до того, как
  marketId стал известен, лента оставалась вне индекса и не чистилась (утечка).
  Теперь `_registerMarket` вызывается на **каждом** `_record()` (идемпотентно;
  warn при смене рынка инструментом). `clear()`/`_cleanup()` чистят `_instrumentToMarket`.
- **#2 settleMarket() — authoritative settlement.** `getResolution()` остаётся
  read-only (UI/диагностика), а **`settleMarket()`** выполняет переход состояния
  `unresolved → resolved`: вычисляет исход, **замораживает** `resolutionPrice`
  (`lockResolutionPrice`) и ставит `resolved=true`. Идемпотентен — повторный вызов
  отдаёт замороженный исход, а не пере-резолвит по более позднему тику. Используется
  **единообразно в live и backtest** (`MarketRotation._settleMarket`, `main.ts`
  backtest, `runMultiMarketBacktest`) — нет вилки lifecycle между средами.
- **#3 устаревшие комментарии.** Из `MarketDataStore` убраны фразы про
  «не вызывайте `collector.start()`» (у коллекторов нет `start()`).
- **#4 guard на допуск.** `nearestByTimestamp`/`nearestBeforeOrAtByTimestamp`
  возвращают `undefined` при `maxDistanceMs < 0` или NaN (защита от тихого
  странного поведения). Двойного `return false` в `insertSortedUniqueByTimestamp`
  не было — ложная тревога ревью, не трогали.

Тесты на порядок событий: `TRADE→BOOK_DEPTH→MARKET_CLOSED`,
`BOOK_DEPTH→TRADE→MARKET_CLOSED`, `BOOK_UPDATED→TRADE→MARKET_CLOSED`,
`startMarket→settle→startMarket` (без warn), stale Chainlink, идемпотентность settle.

Валидация: 100 тестов market-state; build/typecheck чисто; e2e backtest идентичен
(DOWN, strike 78286.53 / resolution 78202.03, 0 errors, без skip/overwrite warnings).

## Тесты

- `__tests__/unit/CryptoMarketDataStore.test.ts` — Tier 1 (9 кейсов), включая
  защиту prune от битого будущего timestamp.
- `__tests__/unit/MarketDataStore.test.ts` — MARKET_CLOSED cleanup (3 кейса):
  удаление TopOfBook рынка, изоляция между рынками, делегирование коллекторам.
- `__tests__/BookDepthCollector.test.ts` / `TradeTapeCollector.test.ts` —
  `clearMarket()` в пассивном режиме (без `start()`).
- `__tests__/unit/CryptoSignalRegistry.test.ts` — #9/#10 (5 кейсов): отсев
  устаревших бирж, minVenueCount, cross-venue skew, chainlink stale guard.
- `__tests__/unit/MarketDataStore.test.ts` — freshness API #3 (3 кейса),
  BOOK_DEPTH→onChange #2 (2 кейса).
- `__tests__/unit/CryptoResolutionStore.test.ts` — #11 (9 кейсов): strike/resolution,
  fallback на Chainlink, lock, нормализация, 2 интеграционных с CryptoMarketDataStore.
- `__tests__/unit/CryptoMarketDataStore.test.ts` — #4 top-N (2 кейса),
  #7 material-move notify (4 кейса).
- `__tests__/unit/CryptoPriceStore.test.ts` — #11 (8 кейсов): валидация,
  out-of-order, нормализация регистра.
