# @polymarket/market-discovery

## Обзор

Два stateless-класса, отбирающие и ранжирующие рынки-кандидаты для торговли.

| Компонент | Роль |
|---|---|
| `MarketFilter` | Фильтрует `DiscoveredMarket[]` по `IMarketFilterConfig` (спред, ликвидность, срок до экспирации, ключевые слова) |
| `MarketScorer` | Сортирует отфильтрованные рынки: по часам до экспирации (ASC), затем ликвидности (DESC), затем `marketId` (ASC, для детерминизма) |

```typescript
import { MarketFilter, MarketScorer } from '@polymarket/market-discovery';

const filtered = new MarketFilter(config).apply(discoveredMarkets);
const ranked = new MarketScorer().scoreAndSort(filtered);
```

## `IMarketFilterConfig` — пороги остаются `number` (не трогается)

Все 8 полей (`minSpread`, `minLiquidity`, `minTimeToExpiryHours`, ...) — пороги фильтрации,
не единичные измеренные величины. Этап 5 явно оставил их `number` целиком ("не трогается
вообще") — тот же прецедент, что `DetectorConfig.minSpreadAfterFees` (Этап 4).

## `DiscoveredMarket` — брендированные поля (Этап 10c)

`DiscoveredMarket` (`@polymarket/ports`, `IMarketDiscoveryService.ts`) — `spread?: Ratio`,
`liquidity: Money`, `eventStartMs?: Timestamp` (были `Decimal`/`Decimal`/`number` до Этапа
10c плана миграции; единственная точка конструирования — `PolymarketMarketDiscoveryAdapter.
_mapToDiscoveredMarket()`). `score: Decimal` и `startsAt?: Timestamp` не меняются (см.
`@polymarket/ports`'s `docs/ports.md` за полным обоснованием).

Раз `Ratio`/`Money` не имеют методов сравнения на core-уровне, `MarketFilter`'s
`_passesSpreadFilter()`/`_passesLiquidityFilter()`/`_passesDurationFilter()` и
`MarketScorer`'s liquidity-компаратор используют VO-aware unwrap вместо прямых
`Decimal`-методов:

```typescript
// MarketFilter.ts
market.spread.toDecimal().greaterThanOrEqualTo(new Decimal(minSpread));  // Ratio
market.liquidity.value().greaterThanOrEqualTo(new Decimal(minLiquidity)); // Money
market.expiresAt.toNumber() - market.eventStartMs.toNumber();             // Timestamp

// MarketScorer.ts
b.liquidity.value().comparedTo(a.liquidity.value());                      // Money
```

`.toDecimal()`/`.value()` — точный unwrap без потери точности (не `.toNumber()`), тот же
принцип, что уже применялся в `OrderRiskChecker`/`TradeFlowCalculator` (Этапы 2, 7):
VO на публичной границе, `Decimal`-арифметика внутри реализации.

`MarketFilter.test.ts`/`MarketScorer.test.ts`'s `makeMarket()`-фикстуры используют
`Ratio.of(...)`/`Money.of(...)` напрямую (тот же паттерн, что уже применялся к `OutcomePrice`/
`Quantity` в этих же фикстурах) — не `RatioService`/`MoneyService`, поскольку значения
компайл-тайм известны и валидны. `_passesDurationFilter()` получил недостающее тестовое
покрытие (Этап 10c) — до этого не тестировался вообще.

`MarketFilter.ts`/`MarketScorer.ts` больше не нуждаются в Этап-0 allowlist для правила
"`decimal.js` вне `value-objects`/`math`" ради `DiscoveredMarket`'s полей — но остаются в
allowlist из-за `score: Decimal` (сознательно не-VO, см. выше) и собственной внутренней
`Decimal`-арифметики (`MarketScorer.scoreAndSort()`'s `hoursToExpiry`-вычисление).

## Ссылки

- План миграции, Этап 10c: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`
- `@polymarket/ports` — `IMarketFilterConfig`, `IMarketDiscoveryService.DiscoveredMarket`,
  `docs/ports.md` (полное обоснование `DiscoveredMarket`'s per-field решений)
