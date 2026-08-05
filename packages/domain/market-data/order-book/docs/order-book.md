# @polymarket/order-book

> **Статус: deprecated.** Заменяется сущностью `@polymarket/orderbook`
> (`packages/domain/entities/orderbook`, immutable, `Result`-based). План удаления —
> Этап 10 миграции (`/Users/menvil/.claude/plans/synthetic-swimming-heron.md`): каждый
> потребитель мигрирует в рамках своего этапа (6/8/9), Этап 10 закрывает оставшиеся
> `apps/*`/`infrastructure/*`, затем пакет удаляется физически. До этого момента пакет
> продолжает использоваться в проде — не удалять и не переставать поддерживать раньше
> времени.

## Почему это сделано так?

Исторически в кодовой базе было две несвязанные модели стакана ордеров: мутабельный,
throw-based `OrderBook` здесь (для market-data слоя, оптимизирован под частые обновления
без давления на GC) и immutable, `Result`-based `Orderbook`-entity в
`domain/entities/orderbook` (для доменного моделирования). Решение миграции — полная
замена, не мост: `applyDelta()` структурно мёртв для Polymarket (биржа шлёт только полные
снапшоты), и `applyFullState()` уже пересоздаёт обе внутренние `Map` с нуля при каждом
вызове — довод "mutable ради GC" не подтверждён реальным паттерном использования.

### Этап 2: throw → Result, без структурного рефакторинга

Единственное изменение, внесённое в рамках Этапа 2 плана миграции — 9 throw-сайтов
(`OrderBook.getImbalance/getBids/getAsks`, `OrderBookHistory.create`,
`ImbalanceCalculator.calculate`, `ImbalanceHistory.create`) переведены на
`Result<T, ValidationError>` — по ADR (`docs/architecture/boundary-contract.md`, Решение 2)
throw легитимен только внутри `value-objects`. Внутренняя ретеншн-логика
`OrderBookHistory` **осталась hand-rolled** (не переведена на `@polymarket/rolling-window`)
— инвестировать в рефакторинг пакета, который скоро удаляется целиком, противоречит
принципу "не инвестировать сверх необходимого в код на удаление".

Реальный blast radius этой конверсии был почти нулевым: из ~13 продакшн-потребителей
пакета только один — `packages/application/market-state/src/BookDepthCollector.ts` —
вызывал throwing-метод (`OrderBookHistory.create()`); остальные — либо type-only импорты,
либо вызывают не-throwing методы (`applyFullState`/`getBestBid`/`getBestAsk`/`getSpread`/
`toSnapshot`/`OrderBook.create`).

## Публичный API (после Этапа 2)

```typescript
import { OrderBook } from '@polymarket/order-book';

const book = OrderBook.create(marketId, tokenId); // не throws

book.applyFullState(bids, asks, timestamp); // мутирует in-place
book.applyDelta(delta);                      // структурно мёртв для Polymarket, оставлен

const bid = book.getBestBid();  // PriceLevel | undefined, не throws
const ask = book.getBestAsk();
const mid = book.getMidPrice(); // Decimal | undefined
const spread = book.getSpread();

// Result-based (Этап 2):
const bidsResult = book.getBids(5);
if (bidsResult.ok) { /* bidsResult.value: readonly PriceLevel[] */ }

const imbalanceResult = book.getImbalance(5);
if (imbalanceResult.ok) { /* imbalanceResult.value: Decimal */ }
```

`OrderBookHistory`/`ImbalanceHistory`/`ImbalanceCalculator` — та же схема: `.create()`
возвращает `Result`, остальные методы (`record`/`getLatest`/`getRecent`/...) не изменились.

## Пример кода (актуальный!)

```typescript
import { OrderBookHistory } from '@polymarket/order-book';
import { LiveClock } from '@polymarket/time';

const clock = new LiveClock();
const result = OrderBookHistory.create({ maxCount: 1000, maxAgeMs: 300_000 }, clock);
if (!result.ok) {
  throw result.error; // ValidationError
}
const history = result.value;

history.record(book.toSnapshot());
const recent = history.getRecent(60_000);
```

## Известные пробелы (не устраняются здесь — пакет удаляется)

- `package.json`'s `files` раньше ссылался на несуществующий `README.md` (убрано в Этапе 2,
  но `docs/` заменяет, а не дублирует README).
- Внутренняя ретеншн-логика `OrderBookHistory` дублирует `@polymarket/rolling-window` —
  осознанно не унифицировано (см. выше).
