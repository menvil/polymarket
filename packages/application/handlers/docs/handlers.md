# @polymarket/handlers

## Обзор

Тонкие адаптеры: WS-события Polymarket → `IEventBus` (`@polymarket/event-bus`). Ни один
из трёх handler'ов не содержит доменной логики — только парсинг/маршрутизация входа и
публикация типизированных `ApplicationEvent`. Доменная обработка (Order/Portfolio/Ledger)
живёт ниже по потоку, в `orchestrators` → `use-cases`.

| Handler | Вход | Публикует |
|---|---|---|
| `BookUpdateHandler` | Полный снапшот стакана (`type='book'`) | `BOOK_UPDATED`, `BOOK_DEPTH` |
| `FillEventHandler` | Fill-событие user-channel (`WsFillStatus`) | `FILL_RECEIVED`, `FILL_CONFIRMED`, `FILL_FAILED` |
| `OrderUpdateHandler` | `VenueOrderUpdate` (venue-статус ордера) | `ORDER_UPDATE_RECEIVED` |

`IBookRegistry` — порт реестра `OrderBook`-экземпляров по ключу `(marketId, tokenId)`,
которым владеет `BookUpdateHandler`.

## `IEventBus.publish()` → `Result` (Этап 6 плана миграции)

Все 8 сайтов `.publish()` в пакете проверяют `Result` явно и логируют на `Err`, вместо
падения/проглатывания ошибки молча:

- **`BookUpdateHandler`** (2 сайта: `BOOK_UPDATED`, `BOOK_DEPTH`) — на `Err` логирует через
  `this._logger.error(...)` и продолжает (публикация стакана — fire-and-forget по своей
  природе, следующий снапшот придёт по WS независимо).
- **`OrderUpdateHandler`** (1 сайт) — на `Err` логирует. До Этапа 6 здесь был `try/catch`
  вокруг `publish()` (когда та бросала); теперь это прямая проверка `result.ok` — код стал
  проще, не сложнее, так как `Result` не требует `try/catch` для ожидаемых ошибок.
- **`FillEventHandler`** (5 сайтов) — на `Err` логирует с контекстом (`fillId`/`orderId`) и:
  - в циклах по нескольким fills (`_handleMatchedFill`'s MATCHED-путь, `_handleFailedFill`'s
    maker-путь) — `continue`: сбой публикации одного fill не должен остановить публикацию
    остальных fills того же WS-события;
  - в одиночных путях (`_handleConfirmedFill`'s normal/fallback-публикация,
    `_handleFailedFill`'s taker-путь) — ранний `return`: публиковать больше нечего в рамках
    этого вызова.

Ни один из 8 сайтов не ретраит и не эскалирует ошибку публикации выше — `EventBus`'s
`Result` здесь диагностический (лог), не управляющий поток. Это осознанное продолжение
уже существовавшего до Этапа 6 поведения (`publish()` раньше либо не проверялась вовсе,
либо оборачивалась в `try/catch`, который тоже просто логировал) — Этап 6 меняет механизм
обработки ошибки (`Result` вместо throw/catch), не её семантику.

## `IBookRegistry`/`OrderBook` — намеренно не тронуты в Этапе 6

`BookUpdateHandler`/`IBookRegistry` работают с **mutable** `OrderBook`
(`@polymarket/order-book`, market-data пакет, план на удаление). Миграция на immutable
`Orderbook`-entity (`@polymarket/orderbook`, domain-пакет) требует: (а) новый метод
интерфейса `IBookRegistry` (иммутабельное обновление не может мутировать существующий
инстанс — реестр обязан явно "положить обновлённый экземпляр назад"), (б) решения о
graceful-деградации при невалидном WS-вводе в `MarketDataFeedAdapter._convertLevels()`
(единственном месте, конструирующем `PriceLevel[]` для `handleSnapshot()`) — оба вопроса
вне периметра Этапа 6 и требуют отдельного расследования файла, явно закреплённого за
Этапом 10 плана миграции. `BookUpdateHandler`/`IBookRegistry`/`MarketDataFeedAdapter.ts`
мигрируют одним куском в Этапе 10, не растягиваясь через границу этапов.

## Ссылки

- ADR: `docs/architecture/boundary-contract.md`
- `@polymarket/event-bus/docs/event-bus.md` — контракт `IEventBus`, deprecation-мост
- План миграции, Этап 6: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`
