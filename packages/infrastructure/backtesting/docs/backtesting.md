# @polymarket/backtesting

## Обзор

Движок воспроизведения записанных рыночных снапшотов через те же application-layer
хендлеры, что используются при live-торговле — реплей, а не отдельная симуляция. Два
независимых движка: `BacktestEngine` (один файл/рынок, полный стек `EventBus`+
`BookUpdateHandler`+`StrategyScheduler`) и `CrossMarketBacktestEngine` (пара файлов
одновременно, напрямую через `DivergenceDetector`, без `EventBus`).

| Экспорт | Назначение |
|---|---|
| `BacktestEngine` | Главный оркестратор: NDJSON-снапшоты → `EventBus`/`BookUpdateHandler` → `StrategyScheduler` |
| `CrossMarketBacktestEngine` | Реплей пары файлов (easy+hard) синхронно по timestamp через `DivergenceDetector` |
| `MockExchangeClient` | `IExchangeClient` без сети: `submitOrder`/`cancelOrder` в памяти, `getOpenOrders`/`getTrades` — пустые (ордера/сделки приходят из снапшотов, не venue API) |
| `BacktestConfig`/`BacktestDeps`/`BacktestResult` | Конфигурация/зависимости/результат `BacktestEngine.run()` |

```typescript
import { BacktestEngine, MockExchangeClient } from '@polymarket/backtesting';
import { InMemoryOrderRepository } from '@polymarket/in-memory';

const engine = new BacktestEngine(
  { filePaths: ['./snapshots/Bitcoin_Up_or_Down.jsonl'], outcomeIndex: 1 },
  { bookUpdateHandler, eventBus, replayClock, logger },
);
const result = await engine.run();
console.log(`book=${result.bookEvents}, trades=${result.tradeEvents}, errors=${result.errors}`);
```

## Поток данных `BacktestEngine`

```
filePaths → JsonlSnapshotReader (построчно, @polymarket/snapshot-readers)
  → meta-строка → marketId + tokenIds[outcomeIndex]
  → book-событие → BookUpdateHandler.handleSnapshot() → BOOK_UPDATED в EventBus
  → last_trade_price → EventBus.publish(TRADE_RECEIVED)
  → ReplayClock.update(timestamp) перед каждым событием
```

Поддерживает два формата файлов: актуальный (`@polymarket/data-collection`'s
`{"event_type": "book"/"last_trade_price", ...}`) и legacy (`{"_type": "META"/"EVENT", ...}`).
Обработка ошибок — fail-open на уровне отдельной строки/события (невалидный JSON/asset_id/
OutcomePrice/Quantity — лог + счётчик ошибок + продолжение), не fail-closed на весь прогон.

## Почему в пакете свои копии `InMemory*`-классов, а не только re-export

`index.ts` re-экспортирует `InMemoryOrderRepository`/`InMemoryPortfolioStore`/
`InMemoryProcessedFillRepository`/`InMemoryReconciliationIssueRepository`/
`InMemoryKeyedMutex` из ЛОКАЛЬНЫХ файлов пакета (не проксирует `@polymarket/in-memory`
напрямую) — явно помеченных в докблоке `index.ts` как "для обратной совместимости, новый
код должен импортировать напрямую из `@polymarket/in-memory`".

**Проверено прямым diff**: 3 из 5 локальных файлов (`InMemoryPortfolioStore.ts`,
`InMemoryReconciliationIssueRepository.ts`, `InMemoryKeyedMutex.ts`) байт-в-байт идентичны
своим аналогам в `@polymarket/in-memory`. **2 из 5 — разошлись и отстали**:
`InMemoryOrderRepository.ts` здесь не имеет более новых processing-block-докблоков, и
`InMemoryProcessedFillRepository.ts` здесь не имеет lease/fencing-token функциональности
(`FillProcessingLease`, reclaim просроченного `PROCESSING`), уже присутствующей в
`@polymarket/in-memory`'s текущей версии.

**Проверено repo-wide grep — реальных потребителей этих локальных файлов нет вообще**: ни
один файл в `apps/*`/`packages/*` не импортирует `InMemoryOrderRepository` и т.п. из
`@polymarket/backtesting` — все реальные конструкторы (`apps/bot/src/bot/buildRepositories.ts`,
`apps/bot/scripts/shadow-validate-portfolio-service.ts`, `apps/bot/src/bot/MarketRotation.ts`)
уже импортируют напрямую из `@polymarket/in-memory`. Это означает: 5 локальных файлов —
мёртвый, орфанный backward-compat код (2 из них ещё и содержательно устаревшие копии), не
активно используемый дубликат. Зафиксировано как находка Этапа 11 плана миграции (сам этап
— документация/ESLint, не входит в его мандат удалять мёртвый код) — кандидат на удаление в
отдельной, не связанной с типизацией задаче.

## `CrossMarketBacktestEngine` — почему отдельный движок, не режим `BacktestEngine`

Работает с ПАРОЙ файлов одновременно (`easy`+`hard` рынки одного кросс-маркетного
арбитража), реплеит их синхронно по timestamp через `TimelineMerger`, обновляет оба стакана
и проверяет расхождение через `DivergenceDetector.detect()` на каждом шаге — не использует
`EventBus`/`BookUpdateHandler`/`StrategyScheduler` вообще (нет одной "стратегии", есть прямой
арбитражный сигнал между двумя книгами). Результат на пару: количество расхождений,
суммарный/средний PnL, длительность расхождений — см. `docs/guides/cross-market-arbitrage.md`
за подробным разбором и реальными результатами прогонов.

## Ссылки

- `@polymarket/in-memory` (docs/in-memory.md) — актуальные, поддерживаемые реализации
  используемых здесь портов
- `@polymarket/snapshot-readers` (docs/snapshot-readers.md) — чтение NDJSON-архивов
- `docs/guides/cross-market-arbitrage.md` — реальные результаты прогонов `CrossMarketBacktestEngine`
- ADR: `docs/architecture/boundary-contract.md`
- План миграции, Этапы 2/4/10a/10d/11: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`
