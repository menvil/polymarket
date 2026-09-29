# @polymarket/in-memory

## Обзор

General-purpose in-memory реализации портов из `@polymarket/ports`, используемые во всех
режимах бота (paper/backtest/live) до перехода на Redis/PostgreSQL для конкретного порта.
Не production-grade персистентность — состояние не переживает перезапуск процесса.

| Экспорт | Реализует | Назначение |
|---|---|---|
| `InMemoryOrderRepository` | `IOrderRepository` + `IOrderStateStore` | Хранилище ордеров |
| `InMemoryPortfolioStore` | `IPortfolioStore` | CAS-хранилище `Portfolio` |
| `InMemoryProcessedFillRepository` | `IProcessedFillRepository` | Idempotency + lifecycle guard для `Fill` |
| `InMemoryReconciliationIssueRepository` | `IReconciliationIssueRepository` | Queryable хранилище reconciliation issues |
| `InMemoryOrderSubmissionRepository` | `IOrderSubmissionRepository` | Submission guard + reservation journal |
| `InMemoryKeyedMutex` | `IKeyedMutex` | Keyed mutex для сериализации fill/cancel |

```typescript
import {
  InMemoryOrderRepository,
  InMemoryPortfolioStore,
  InMemoryProcessedFillRepository,
  InMemoryKeyedMutex,
} from '@polymarket/in-memory';

const orderRepo = new InMemoryOrderRepository();
const portfolioStore = new InMemoryPortfolioStore();
const processedFillRepo = new InMemoryProcessedFillRepository();
const keyedMutex = new InMemoryKeyedMutex();
```

## `InMemoryOrderSubmissionRepository` — submission guard + reservation journal

`begin()` — центральный state-machine метод, классифицирует попытку submission по текущему
статусу записи: новая запись → `ACQUIRED`; fingerprint не совпадает с сохранённым →
`FINGERPRINT_MISMATCH` (clientOrderId переиспользован под другой ордер — эта проверка идёт
ПЕРВОЙ); терминальные статусы (`COMMITTED`/`VENUE_ACCEPTED`/`SUBMITTING`/`UNKNOWN`/
`CANCELLED`) возвращаются как есть без мутации; `FAILED` с безопасной резервацией (`NONE`
или `SETTLED` с `remaining === 0`) → retry разрешён (`FAILED_RETRYABLE`, attempt+1); `FAILED`
с небезопасной резервацией → `RECONCILIATION_REQUIRED` (retry заблокирован — повторный
reserve заморозил бы капитал дважды).

`heldReservation()` (внутренняя журнальная арифметика, `@polymarket/ports`'s
`reservationJournal.ts`) — `Result`-based с Этапа 5 плана миграции; единственный вызывающий
сайт (`markReservationHeld()`, ~строка 287) читает `Result` напрямую без try/catch — до
Этапа 5 throw от `heldReservation()` перехватывался вручную здесь же.

## Почему `in-memory`, а не только тестовые дублёры

Пакет — не test-only заглушка: paper- и backtest-режимы бота используют его как основное
хранилище состояния (не только `live`-режим переключается на Redis/PostgreSQL-реализации тех
же портов). Отсюда — реальное внимание к concurrency-корректности (CAS в
`InMemoryPortfolioStore`, keyed mutex), не только к простоте.

## Ссылки

- Порты: `@polymarket/ports` (`docs/ports.md`) — `IOrderRepository`, `IPortfolioStore`,
  `IOrderSubmissionRepository`, `IKeyedMutex` и др.
- ADR: `docs/architecture/boundary-contract.md`,
  `docs/architecture/reservation-journal-safety.md`
- План миграции, Этапы 5/10d/11: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`
