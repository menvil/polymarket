# @polymarket/cross-market

## Обзор

Доменный пакет кросс-маркетного арбитража: обнаружение расхождений вероятностей между
рынками разной длительности (5m/15m/hourly/daily) на одном активе с одним `endDate`, и
генерация исполнимых арбитражных сигналов с учётом глубины ордербука и комиссий.

Подробный разбор находки, экономики и историю бэктестов см. в
[`docs/guides/cross-market-arbitrage.md`](../../../../docs/guides/cross-market-arbitrage.md)
— этот файл про API, тот — про стратегию и результаты.

## Компоненты

### `MarketPairMatcher`

Матчит рынки в пары `(easy, hard)` по `(asset, endDate)` с разной `recurrence`.

```typescript
import { MarketPairMatcher } from '@polymarket/cross-market';

// Парсинг ticker (Gamma API): 'btc-updown-15m-1774231200' → {asset, recurrence, startEpoch, endEpoch}
const parsed = MarketPairMatcher.parseTicker('btc-updown-15m-1774231200');

// Парсинг meta-строки снапшота (backtest) — один файл за раз, обход директории на
// стороне вызывающего кода (см. CrossMarketBacktestEngine._indexMarkets())
const info = MarketPairMatcher.parseSnapshotMeta(rawMetaLine, filePath);

// Группировка и матчинг в пары
const matcher = new MarketPairMatcher();
const pairs = matcher.findPairs(marketInfos); // MarketPair[], отсортированы по endEpochMs
```

Easy = рынок с большим `recurrence` (длиннее → легче → ниже strike после нормализации).
Hard = рынок с меньшим `recurrence` (короче → сложнее → выше strike).

### `FeeCalculator`

Комиссия Polymarket для crypto-рынков: `fee = round5(size × feeRate × (price×(1-price))^exponent)`.

```typescript
import { FeeCalculator, FEE_MODEL_CURRENT } from '@polymarket/cross-market';

const calc = new FeeCalculator(FEE_MODEL_CURRENT);
const fee = calc.takerFee(0.50);              // комиссия одной ноги, 1 share
const cost = calc.pairFee(0.45, true, 0.55, false); // сумма по двум ногам (taker + maker)
```

`FeeModel.feeRate` — `Ratio`, распаковывается один раз в конструкторе `FeeCalculator`
(см. "Почему хот-путь остаётся number" ниже — `takerFee()` сам вызывается в хот-пути).

### `DepthAnalyzer`

VWAP-анализ по глубине ордербука (уровни 1..maxDepth) для обеих ног.

```typescript
const analyzer = new DepthAnalyzer(feeCalculator);
const levels = analyzer.analyze(hardUpBids, easyUpAsks, { maxDepth: 5, easyIsTaker: true, hardIsMaker: true });
const optimal = analyzer.findOptimal(levels); // уровень с максимальным totalPnl
```

Алгоритм на каждом уровне `depth`: кумулятивный VWAP обеих ног → `spread = hardVwap -
easyVwap` (останов при `spread <= 0`) → `execSize = min(cumHard, cumEasy)` →
`pnl = 1 - cost - fee`. `analyzeDown()` — зеркальная версия для DOWN-направления.

### `DivergenceDetector`

Обнаруживает `hard_Up_bid > easy_Up_ask` (или зеркально для DOWN), прогоняет
`DepthAnalyzer`, фильтрует по `minSpreadAfterFees`.

```typescript
const detector = new DivergenceDetector({ maxDepth: 5, feeModel: FEE_MODEL_CURRENT, minSpreadAfterFees: 0.005 });
const signal = detector.detect(easyBook, hardBook, pair, Date.now()); // ArbitrageSignal | null
const best = detector.detectBest(easyBook, hardBook, pair, Date.now()); // лучший из UP/DOWN
```

## Почему хот-путь остаётся `number`, а не VO

`NumericLevel`/`SimpleBook`/`DepthLevel` и `ArbitrageSignal.hardUpBestBid`/`easyUpBestAsk` —
сознательно **не** переведены на `Price`/`Quantity`/`Money`, в отличие от остальной
кодовой базы, где примитивы на публичной границе — долг, который убирается.

Причина — не лень, а измеренная стоимость: `CrossMarketBacktestEngine` в реальном
зафиксированном прогоне (23 марта 2026, см. guide) реплеит **798 968** расходящихся
снапшотов ордербука за один день. Для каждого `DivergenceDetector.detect()` считает VWAP
по глубине 1..5 в `DepthAnalyzer` — то есть эта петля выполняется до ~4 млн раз за прогон.
`Decimal.js`-арифметика на 1-2 порядка медленнее нативного `number`; заворачивание сюда
измеримо замедлило бы бэктест ради типобезопасности, которая не нужна **внутри** уже
строго типизированной сигнатуры (`analyze(levels: readonly NumericLevel[], ...)` — не
`unknown`, компилятор и так не пропустит случайную строку).

Прямой прецедент того же принципа — `TradeFlowCalculator.compute()` (Этап 2 плана
миграции): внутренняя `Decimal`-арифметика после распаковки VO оставлена как есть,
поскольку "правило ADR про арифметику применяется к тому, что пересекает публичную
границу... не к внутренней реализации" (`docs/architecture/boundary-contract.md`). Здесь
тот же принцип применяется чуть шире — не только к телу функции, но и к форме самого
хот-путного структурного типа, — по той же логике: `SimpleBook`/`NumericLevel` узко
типизированы и не принимают произвольный ввод, только к решению об однократном раунде
VO↔number на границе (что уже сделано в вызывающем коде, см. `CrossMarketArbStrategy.
topOfBookToSimpleBook()`) добавляется решение НЕ платить за VO ещё и внутри самой петли.

## Классификация полей: что VO, что остаётся number

| Поле | Тип | Почему |
|---|---|---|
| `MarketInfo.endEpochMs`/`startEpochMs` | `Timestamp` | Точка во времени, конструируется редко (раз на пару, не на снапшот) |
| `ArbitrageSignal.detectedAtMs` | `Timestamp` | Разреженный результат (только прибыльные сигналы) |
| `FeeModel.feeRate` | `Ratio` | Безразмерная доля, читается один раз при конструировании `FeeCalculator` |
| `NumericLevel.price/size` | `number` | Хот-путь, см. выше |
| `SimpleBook.bids/asks/timestampMs` | `number` | Хот-путь целиком, включая timestamp — согласованность с bids/asks |
| `DepthLevel` (8 полей) | `number` | Хот-путь, per-level результат VWAP-петли |
| `ArbitrageSignal.hardUpBestBid/easyUpBestAsk` | `number` | Та же хот-путная группа, что `depthLevels` |
| `MarketInfo.priceToBeat/finalPrice` | `number` | Крипто-спот-цена (например ~78237 для BTC) — `Price` VO ограничен `[0.0001, 0.9999]`, не подходит. Открытый вопрос, решается согласованно с `CryptoMarketDataStore` (Этап 8) |
| `MarketInfo.asset` | `string` | Отложено в Этап 8 (согласованно с `market-state`) |
| `MarketInfo.endDate/startDate` | `string` | Ключ группировки по равенству, дуальное представление рядом с `endEpochMs`/`startEpochMs` |
| `FeeModel.exponent`, `DetectorConfig.maxDepth` | `number` | Показатель степени / счётчик, не "величина" |
| `DetectorConfig.minSpreadAfterFees` | `number` | Конфиг-порог, сравнивается с хот-путным `pnlPerUnit` |
| `overlapMs`, `OVERLAP_DURATION_MS`, `RECURRENCE_DURATION_SEC` | `number` | Длительности/константы конфигурации |

## Потребители

- `packages/infrastructure/backtesting/src/CrossMarketBacktestEngine.ts` — основной
  потребитель, использует полный API пакета (детектор, матчер, все типы).
- `apps/bot/src/strategies/CrossMarketArbStrategy.ts` — live-стратегия. **Не использует
  `DivergenceDetector`** — реализует ту же VWAP/spread/cost/fee/pnl логику инлайн в
  `_detectTakerBuySignal()` (дублирование, не дедуплицировано — см. план миграции, Этап 4,
  п.6 "Что НЕ входит"). Использует `FeeCalculator`/`FEE_MODEL_CURRENT` напрямую.
- `apps/bot/src/main.ts` — live-обнаружение пар из Gamma API discovery-кандидатов, строит
  `MarketInfo` вручную из `ticker`+`endDate` (3 похожих блока: warming/upgrade/fill).
- `apps/bot/src/arbitrage/runArbBacktest.ts` — CLI-обёртка над `CrossMarketBacktestEngine`.

Ни `CrossMarketArbStrategy.ts`, ни `CrossMarketBacktestEngine.ts` не имеют юнит-тестов —
при правках учитывать, что защита от регрессии — только `build`+`typecheck`.
