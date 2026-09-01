# @polymarket/market-discovery

## Обзор

| Компонент | Роль | Контракт |
|---|---|---|
| `MarketUniverse` | In-memory source of truth текущего canonical universe | `MarketDiscoverySnapshot` / `Market` |
| `MarketFilter` | LEGACY: фильтрует кандидатов по `IMarketFilterConfig` (спред, ликвидность, срок до экспирации, ключевые слова) | `DiscoveredMarket` |
| `MarketScorer` | LEGACY: сортирует по часам до экспирации (ASC), ликвидности (DESC), `marketId` (ASC) | `DiscoveredMarket` |

`MarketUniverse` работает с canonical `Market`. `MarketFilter`/`MarketScorer`
пока живут на LEGACY-контракте `DiscoveredMarket` и **не участвуют** в
Polymarket V2 Discovery: owner selection вынесен из Infrastructure и станет
Policy НАД universe в следующем MR — тогда они будут мигрированы на
`MarketDiscoveryEntry`, а `DiscoveredMarket` исчезнет.

## `MarketUniverse`

### Проблема

Discovery отдаёт полный снимок технически поддержанного universe. Кому-то
нужно держать «что сейчас известно Application» и отвечать на вопрос «есть
ли такой рынок и какие у него метаданные» — не заводя при этом второй
каталог инструментов.

### Решение

Простой in-memory holder снимка. Он **не** переиспользует `IMarketCatalog`:
тот решает другую задачу (`instrumentId → InstrumentInfo` для
strategy/risk/order path). Сталкивать две концепции в одном типе значило бы
получить объект с двумя несовместимыми причинами меняться.

Интерфейса `IMarketUniverse` нет: второй реализации не существует, а
интерфейс без неё не даёт dependency inversion — он даёт лишний файл.
Инверсия уже сделана там, где нужна: на порту `IMarketDiscoveryService`.

### API

```typescript
class MarketUniverse {
  constructor(clock: IClock);
  replace(snapshot: MarketDiscoverySnapshot): void;
  get(venueId: VenueId, marketId: MarketId): MarketDiscoveryEntry | undefined;
  getAll(): readonly MarketDiscoveryEntry[];
  getSnapshot(): MarketDiscoverySnapshot;
}
```

### Почему `replace`, а не `add`/`remove`

Discovery отдаёт СНИМОК: «вот полный технически поддержанный universe на
момент `observedAt`». Инкрементальные мутации потребовали бы считать диффы
в двух местах и допускали бы состояние, которого площадка никогда не
наблюдала — рынок, «забытый» в universe после исчезновения из окна. Замена
целиком делает такое состояние непредставимым.

### Идентичность рынка — ПАРА `venueId + marketId`

Один и тот же `marketId` на разных площадках означает разные рынки. Ключ
строится общей функцией `marketUniverseKey()` из `@polymarket/ports` — тем
же правилом, по которому дедуплицирует discovery, чтобы lookup и порядок
`getAll()` не разошлись.

### Иммутабельность

Universe — source of truth Application, поэтому он неизменяем по **двум**
независимым осям:

1. он не меняется из-под потребителя, который держит ссылку на результат
   `getAll()`/`get()`/`getSnapshot()`;
2. он не зависит от того, мутирует ли вызывающий переданный снимок **после**
   `replace()`.

Одной заморозки массива для этого мало: записи и их `metrics` остались бы
общими объектами с вызывающим, и `snapshot.entries[0].metrics.liquidity = x`
тихо менял бы source of truth. Поэтому `replace()` строит **свои** объекты и
замораживает именно их.

#### Что копируется и что замораживается

| Объект | Копируется | Замораживается | Почему |
|---|---|---|---|
| снимок `{ observedAt, entries, diagnostics }` | да (новый литерал) | да | universe владеет им целиком |
| `entries` | да (новый массив) | да | `push`/`pop` вызывающего не должны менять universe |
| запись `{ market, metrics }` | да (новый объект) | да | иначе universe делит объект с вызывающим |
| `metrics` | да (shallow copy) | да | мутабелен сам контейнер — обычный литерал адаптера |
| `diagnostics` | да (shallow copy) | да | счётчики — обычный мутабельный объект |
| `market` | **нет** — по ссылке | не трогается | иммутабельная доменная entity, см. ниже |

`Money`/`Ratio` внутри `metrics` не копируются: это value objects, их
неизменяемость — контракт `@polymarket/value-objects`. Копируется именно
контейнер `metrics`, а не его значения.

#### Почему `Market` остаётся по ссылке

`Market` — иммутабельная доменная сущность `@polymarket/market`, её
неизменяемость обеспечивает пакет-владелец. Клонировать её в universe значило
бы дублировать чужой инвариант и сломать identity-сравнение по ссылке, на
которое опираются потребители и тесты:

```typescript
universe.get(KnownVenues.POLYMARKET, market.id)?.market === market; // true
```

#### Почему копия входа, а не заморозка входа

Заморозить `snapshot.entries[i]` и `snapshot.entries[i].metrics` было бы
проще, но это побочный эффект на **чужих** данных: снимок принадлежит
discovery, а не universe. Universe замораживает только то, чем владеет сам.

```typescript
const snapshot = discovery.getSnapshot();
universe.replace(snapshot);

Object.isFrozen(snapshot.entries[0]);           // false — данные вызывающего не тронуты
Object.isFrozen(universe.getAll()[0]);          // true
Object.isFrozen(universe.getAll()[0].metrics);  // true

// мутация снимка после replace на universe не влияет
(snapshot.entries[0].metrics as { liquidity: Money }).liquidity = other;
universe.getAll()[0].metrics.liquidity;         // прежнее значение

// мутация того, что отдал universe (обход readonly), бросает TypeError
(universe.getAll()[0].metrics as { liquidity: Money }).liquidity = other;
```

### Пример кода (актуальный!)

```typescript
// packages/application/market-discovery/src/MarketUniverse.ts
import { MarketUniverse } from '@polymarket/market-discovery';

const universe = new MarketUniverse(clock);

await discovery.refresh();
universe.replace(discovery.getSnapshot());

const entry = universe.get(KnownVenues.POLYMARKET, marketId);
entry?.market.crypto?.asset;      // 'btc'
entry?.metrics.liquidity;         // наблюдение, а не часть Market

for (const { market } of universe.getAll()) {
  market.startsAt;                // подтверждено площадкой, не угадано
}
```

## LEGACY: `MarketFilter` / `MarketScorer`

```typescript
import { MarketFilter, MarketScorer } from '@polymarket/market-discovery';

const filtered = new MarketFilter().filterCandidates(candidates, config, nowMs);
const ranked = new MarketScorer(clock).scoreAndSort(filtered);
```

## `IMarketFilterConfig` — пороги остаются `number` (не трогается)

Все 8 полей (`minSpread`, `minLiquidity`, `minTimeToExpiryHours`, ...) — пороги фильтрации,
не единичные измеренные величины. Этап 5 явно оставил их `number` целиком ("не трогается
вообще") — тот же прецедент, что `DetectorConfig.minSpreadAfterFees` (Этап 4).

## `DiscoveredMarket` — брендированные поля (Этап 10c)

`DiscoveredMarket` (`@polymarket/ports`, `DiscoveredMarket.ts`) — `spread?: Ratio`,
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
- `@polymarket/ports` — `IMarketDiscoveryService` (порт + `MarketDiscoverySnapshot`),
  `DiscoveredMarket` (legacy), `IMarketFilterConfig`, `docs/ports.md`
- `packages/infrastructure/polymarket-v2/docs/market-discovery-v2.md` — как
  снимок строится из vendor-каталога
