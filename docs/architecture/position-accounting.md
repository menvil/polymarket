# Position Accounting: blended-pool vs lot-based (FIFO)

**Статус:** Актуально с Этапа 3 плана миграции (`/Users/menvil/.claude/plans/synthetic-swimming-heron.md`).

## Контекст

До Этапа 3 `PortfolioService._applyPositionUpdate` (`packages/application/use-cases/src/services/PortfolioService.ts`)
вёл учёт позиций через `SimplePosition` (`packages/domain/entities/portfolio/src/SimplePosition.ts`)
— агрегированные `quantity` + `averageEntryPrice`, без истории отдельных входов (лотов).
С Этапа 3 та же функция строит/обновляет lot-based `Position`
(`packages/domain/entities/position`) — FIFO-закрытие с реальным учётом каждого лота
отдельно и накоплением `realizedPnL`.

Обе модели **согласуются** на `quantity` (обе одинаково сводят объём по одним и тем же
fill'ам) и на `averageEntryPrice` — но **только пока не было partial-close, затрагивающего
лоты с разными ценами входа**. Как только такой close происходит, `averageEntryPrice`
между моделями **расходится по значению** — не из-за бага, а потому что модели считают
принципиально разные вещи.

## Почему это ожидаемо, а не баг

**Blended-pool модель (`SimplePosition`)**: держит один "пул" с единой средней ценой.
Partial close уменьшает `quantity`, но **не трогает** `averageEntryPrice` — вся оставшаяся
позиция считается имеющей ту же среднюю цену, что и до close.

**Lot-based модель (`Position`, FIFO)**: держит отдельные лоты с собственной ценой входа
каждый. Partial close **потребляет конкретные лоты** в порядке FIFO (старейшие первыми) —
если закрытые и оставшиеся лоты имеют разные цены, средняя цена **оставшихся** лотов
после close отличается от средней цены **всех** лотов до close.

### Числовой пример

Позиция открыта двумя BUY по разным ценам:

```
Лот 1: 50 @ 0.60 (timestamp t1)
Лот 2: 50 @ 0.70 (timestamp t2, t2 > t1)
```

Blended-pool average: `(50×0.60 + 50×0.70) / 100 = 0.65`.

Теперь SELL 30:

**Blended-pool модель:**

```
quantity: 100 - 30 = 70
averageEntryPrice: 0.65 (неизменна)
```

**Lot-based модель (FIFO — закрывает Лот 1, старейший, первым):**

```
Лот 1: 50 - 30 = 20 @ 0.60 (остаток)
Лот 2: 50 @ 0.70 (не тронут)
quantity: 20 + 50 = 70            ← совпадает с blended-pool
averageEntryPrice: (20×0.60 + 50×0.70) / 70 = 47/70 ≈ 0.671428...  ← РАСХОДИТСЯ с 0.65
realizedPnL (при closePrice = 0.80): (0.80 - 0.60) × 30 = 6.0      ← blended-pool это вообще не считает
```

`quantity` совпадает точно (70 = 70) — обе модели одинаково отслеживают итоговый объём.
`averageEntryPrice` расходится (0.671428... ≠ 0.65) — это **корректное, ожидаемое**
поведение lot-based модели, не регрессия. Это ровно та причина, по которой lot-based учёт
вообще нужен: blended-pool "размазывает" cost basis по всему пулу, теряя информацию о том,
какие именно единицы были проданы; FIFO этого не делает.

## Практическое следствие для тестов/валидации

При написании тестов или ручной shadow-валидации (`apps/bot/data/journals-crowd-dev*`,
см. Task 2.5 плана) на `PortfolioService`:

- **`quantity`** — проверяй на точное совпадение между моделями всегда. Расхождение
  здесь означает реальный баг в проводке BUY/SELL/fee, не ожидаемое поведение.
- **`averageEntryPrice`** — точное совпадение ожидай только для: (a) позиции без
  закрытий (чистое накопление), (b) позиции с одним лотом (single entry price), (c)
  polneho закрытия (позиция удаляется в обеих моделях, сравнивать нечего). Для partial
  close с несколькими разноценовыми лотами — расхождение ожидаемо, не valid failure.
- **`realizedPnL`** — не существует в blended-pool модели вообще (не с чем сравнивать).
  Валидируется отдельно, через: (1) unit-тесты с заранее известными ожидаемыми
  значениями на конкретных сценариях (см.
  `packages/application/use-cases/__tests__/PortfolioService.test.ts`); (2) sanity-check
  реального исторического корпуса на экономическую правдоподобность (знак и порядок
  величины, без экстремальных выбросов) — не точное равенство.

## Shadow-валидация на историческом корпусе

`apps/bot/scripts/shadow-validate-portfolio-service.ts` — прогоняет реальные
последовательности fill'ов из `apps/bot/data/journals-crowd-dev*` (`*.journal.jsonl`)
через настоящий `PortfolioService` и параллельно через независимую blended-pool
реализацию, проверяя `quantity`/`averageEntryPrice`/`realizedPnL` по правилам выше.
Ручной sanity-прогон, не CI-гейт.

Результат прогона на полном корпусе (3 424 journal-файла, 216 с реальными fill'ами,
511 fill'ов: 318 BUY / 193 SELL): **0 аномалий** по всем четырём проверкам (quantity,
averageEntryPrice, realizedPnL bound, execution errors). Отдельно: 65 файлов заканчиваются
с открытой позицией, из них 8 — с несколькими ценами входа (потенциальный кейс
расхождения из примера выше) — ни один не показал числового расхождения на этом
конкретном корпусе (совпадение размеров SELL с границами лотов в этих сессиях, не
особенность валидации). Сам механизм расхождения проверен отдельно — адверсариальным
сценарием с заранее известным ответом в
`packages/application/use-cases/__tests__/PortfolioService.test.ts`.

## Где это реализовано

- `packages/application/use-cases/src/services/PortfolioService.ts` —
  `_applyPositionUpdate` (BUY → `addLots`/`Position.create`, SELL → `position.close(...,
  'FIFO', ...)`), `_openPosition`, `_toLotBasedPosition` (reconstruction non-lot-based
  `IPosition` — см. TSDoc этих методов для полной картины, включая известное ограничение
  с `reverseFill()`).
- `packages/domain/entities/position/src/Position.ts` — `close()` (реализация FIFO/LIFO
  через `algorithms/lot-closing.ts`), `averageEntryPrice` (derived getter,
  `calculateWeightedAveragePrice(lots)`).
- `packages/domain/entities/portfolio/src/SimplePosition.ts` — blended-pool модель,
  остаётся в использовании для `reverseFill()` (rollback при on-chain FAILED, редкий
  путь, не переведён на lot-based в Этапе 3 — см. `docs/architecture/boundary-contract.md`).

## Ссылки

- План миграции, Этап 3: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`
- ADR: `docs/architecture/boundary-contract.md`, Решение 4 (пересмотр валидационной
  стратегии Position)
- `docs/portfolio-entity.md` — раздел про lot-based учёт в `PortfolioService`
