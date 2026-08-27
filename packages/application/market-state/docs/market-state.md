# @polymarket/market-state

## Обзор

Application-layer пакет для накопления рыночных данных из WS-потока/реплея бэктеста.
Два независимых семейства: Polymarket market-data (стакан/трейды текущего прогнозного
рынка) и crypto market-data (долгоживущая история базового актива, переживает ротацию
5-минутных рынков).

| Компонент | Роль |
|---|---|
| `BookDepthCollector` | Пассивный буфер: история снапшотов Polymarket-стакана per tokenId |
| `TradeTapeCollector` | Пассивный буфер: лента Polymarket-трейдов per tokenId |
| `TradeIndexCollector` | Индекс построенных `Trade` по `VenueTradeId` (для `ExecutionLinker`) |
| `MarketDataStore` | Фасад/единственный владелец подписок EventBus — объединяет три коллектора выше |
| `CryptoMarketDataStore` | Long-lived история цен/CEX-стаканов/трейдов per asset |
| `CryptoResolutionStore` | Strike/resolution lifecycle крипто-рынков |
| `CryptoSignalRegistry` | Реестр вычисляемых crypto-сигналов (lead-lag, дивергенция, ...) |

```typescript
import { BookDepthCollector, TradeTapeCollector, TradeIndexCollector, MarketDataStore } from '@polymarket/market-state';

const bookCollectorResult = BookDepthCollector.create({ logger, clock }, { maxCount: 500 });
if (!bookCollectorResult.ok) throw bookCollectorResult.error;

const tapeCollectorResult = TradeTapeCollector.create({ catalog, logger, clock }, { maxAgeMs: 300_000 });
if (!tapeCollectorResult.ok) throw tapeCollectorResult.error;

const tradeIndexResult = TradeIndexCollector.create({ maxAgeMs: 300_000 }, clock);
if (!tradeIndexResult.ok) throw tradeIndexResult.error;

const store = new MarketDataStore({
  eventBus, bookCollector: bookCollectorResult.value, tapeCollector: tapeCollectorResult.value,
  tradeIndex: tradeIndexResult.value, logger,
});
store.start();
```

## `BookDepthCollector`/`TradeTapeCollector` — throw→Result (Этап 8)

До Этапа 8 оба коллектора бросали `RangeError` из конструктора при невалидной retention-
policy. Конверсия — `constructor` стал `private`, публичная точка создания —
`static create(deps, config): Result<T, ValidationError>`, по образцу уже существующего
`TradeIndexCollector.create()` (Этап 2). Единственный реальный продакшн-конструктор —
`apps/bot/src/bot/buildMarketData.ts`, который уже содержал точно такой же паттерн для
`TradeIndexCollector` рядом (и явный комментарий "не менять сигнатуру `buildMarketData()`
под один Result-возврат") — оба новых `.create()`-вызова развёрнуты в `throw new
Error(...)` в этой же точке, синхронно с уже существующим кодом.

`BookDepthCollector.clearMarket()`/`_cleanup()` дополнительно приведены к `MarketId`
(параметр), выравнивая с уже эталонным `TradeTapeCollector.clearMarket(marketId:
MarketId)` (Этап 2). Внутреннее хранилище (`_byMarket`/`_instrumentToMarket`) остаётся
string-keyed в обоих классах — конвертация `String(marketId)` происходит в точке
использования, не меняя структуру Map. `_registerMarket()`'s параметр **не**
конвертирован — он получает `marketId` из `OrderBookSnapshot.marketId: string`, поля
старого `@polymarket/order-book` (пакет удаляется в Этапе 10, не в собственности Этапа 8).

## Почему числовой пул `CryptoMarketDataStore` остаётся `number`

Черновой план миграции предполагал перевод `price`/`exchangeTsMs`/`receivedTsMs` на
`OutcomePrice`/`Timestamp` и `bids`/`asks` на `PriceLevel`/`OrderbookLevel`. При расследовании
Этапа 8 это решение пересмотрено — оба независимых основания уже применялись раньше в
этой миграции (Этап 4, `cross-market`'s `NumericLevel`), здесь они впервые встретились в
одном пакете вместе с генуинно холодными полями (см. `docs/architecture/boundary-
contract.md`, Решение 10):

1. **Hot-path.** `updatePrice()`/`updateCexBook()`/`updateCexTrade()` вызываются на каждое
   WS-событие — и в реплее бэктеста (`infrastructure/backtesting/BacktestEngine.ts`), и в
   живом сборе (`infrastructure/cex-market-data/CexCollectorService.ts`). Заворачивание в
   VO на этой частоте — измеримая деградация ради типобезопасности, не нужной внутри уже
   строго типизированного внутреннего API.
2. **Диапазон.** `price` здесь — крипто-спот-цена произвольного масштаба (например,
   ~78 000 для BTC), а не вероятностная цена prediction-market. `OutcomePrice` VO жёстко
   ограничен `[0.0001, 0.9999]` — `OutcomePrice.of(new Decimal(78237))` бросит
   `OutcomePriceInvariantViolation`. Готового VO для «произвольная USD-цена крипто-актива» в
   кодовой базе нет. Это тот же вопрос, что `MarketInfo.priceToBeat`/`finalPrice` в
   `@polymarket/cross-market` (Этап 4) — там уже было решено оставить `number` и явно
   отложить форму до Этапа 8; здесь вывод расширяется, а не пересматривается: подходящего
   VO по-прежнему нет, и хот-путная причина применяется независимо.

Оба основания достаточны сами по себе — поле остаётся `number` даже если бы только одно
из них выполнялось. Это касается: `CryptoPricePoint.price/exchangeTsMs/receivedTsMs`,
`CexBookTick.bids/asks/exchangeTsMs/receivedTsMs`, `CexTradeTick.price/size/exchangeTsMs/
receivedTsMs`, всех числовых полей `CexVenueState`. `CryptoResolutionStore`'s strike/
resolution-цены (`_targets`/`_resolutions: Map<string, number>`) — та же логика, тот же
вывод.

`pruneAndCap()`/`insertSortedUniqueByTimestamp()` (внутренний retention-механизм
`CryptoMarketDataStore`) не переведены на `RollingWindow<T>` (`@polymarket/rolling-
window`, Этап 1) — `insertSortedUniqueByTimestamp` делает сортированную вставку с
дедупликацией по точному timestamp (replace-if-exact-match, поддержка out-of-order
доставки), чего `RollingWindow`'s простой `append()`-only API не поддерживает. Расширение
`RollingWindow` ради одного потребителя — не тот случай "3 независимые реализации
сошлись", который оправдал создание класса в Этапе 1.

## `CryptoAssetId` — построен, не подключён

`packages/foundation/ids/src/market-data/CryptoAssetId.ts` (Этап 8) — branded ID для
нормализованного символа актива (`'btc'`, `'eth'`, ...), решает открытый с Этапа 1/4
вопрос о форме (branded ID через `validateBrandedId`, не литеральный union — пространство
значений открытое, `inferAssetFromSymbol()`/`normalizeAsset()` выводят произвольные
тикеры с бирж, не маленький закрытый список вроде `CexVenue`).

Тип **не подключён** к полям `asset`/`symbolOrAsset` в `CryptoMarketDataStore`/
`CryptoResolutionStore`/`CryptoSignalRegistry` — те остаются `string`. Реальные
потребители этих полей (через `CryptoSignalResult`/`CryptoSignalContext`) — 6 файлов
`apps/bot/src/strategies/*` + `packages/application/strategy/src/types/
StrategySnapshot.ts` — целиком в периметре Этапа 9. Подключение произойдёт там же, тем же
принципом, что `StrategyId`/`QueueOverflowError` были построены в Этапе 1, но подключены
только в Этапах 6/9.

## `CryptoSignalRegistry` — что отложено и почему

`CryptoSignalResult`/`CryptoSignalContext`'s поля `tsMs`/`asset`/`quality`/`confidence` —
по частоте (per-evaluation, не per-tick) технически подходящие кандидаты на
`Timestamp`/`Ratio`/`CryptoAssetId`. Отложены не по этой причине, а потому что реальные
потребители (8 файлов, все — `apps/bot/strategies/*` и `application/strategy`'s
собственный `StrategySnapshot.ts`) целиком в периметре Этапа 9 — тот же паттерн, что
`IDecisionJournal` (Этап 5) и `IBookRegistry` (Этап 6).

`strength` (диапазон `[0, 10]`) сознательно **не** становится `Ratio`, даже несмотря на
доступность поля к моменту, когда `CryptoSignalResult` будет мигрировать: `Ratio`'s core
не ограничивает диапазон `[0,1]` формально, но его документированная конвенция трактует
значения как доли/проценты ("1.0 = 100%") — насильное помещение 0-10 магнитудной оценки в
эту семантику ввело бы читателя в заблуждение. `CryptoSignalRequest`'s конфиг-пороги
(`lookbackMs`, `staleMs`, `maxCrossVenueSkewMs`, ...) корректно остаются `number` — тот же
прецедент, что `IMarketFilterConfig` (Этап 5).

## Мёртвый код: `getTopOfBookState()`/`areBooksSynchronized()`

`MarketDataStore.getTopOfBookState()`/`areBooksSynchronized()` подтверждены не имеющими
ни одного реального вызывающего в репозитории (только собственные TSDoc-примеры). Оба
читают ту же `_topOfBookTimestampsMs: Map<InstrumentId, number>`, что и
`getTopOfBookTimestampMs()` — единственный реальный потребитель которого
(`apps/bot/src/strategies/CrossMarketArbStrategy.ts`'s `ITopOfBookReader`) требует
`number` (фидит напрямую в хот-путный числовой пул `cross-market`, Этап 4). Раз общее
хранилище вынуждено остаться `number`, у двух мёртвых методов не появляется отдельного
основания меняться. Не удалены — удаление неиспользуемого публичного API вне мандата
этой миграции (типизация, не чистка мёртвого кода); оставлены как явно
задокументированное наблюдение, не молчаливый пробел.

## Ссылки

- ADR: `docs/architecture/boundary-contract.md` (Решение 10 — частотный класс
  hot-path-vs-VO)
- План миграции, Этап 8: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`
- `@polymarket/rolling-window` — `TradeIndexCollector`'s retention (не
  `CryptoMarketDataStore`'s `pruneAndCap`, см. выше)
- `packages/foundation/ids/docs/types-reference.md` — `CryptoAssetId`
