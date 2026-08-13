# @polymarket/ledger

## Обзор

Бухгалтерская модель для торговой системы: append-only книга атомарных записей об
изменении балансов активов. `Fill` (исполнение) разворачивается в 2-3 `LedgerEntry` через
`FillLedgerAdapter`, `Ledger` хранит их и вычисляет балансы через суммирование (`getBalance`)
или полный replay истории (`replay`). `Portfolio`/`Position`/PnL — проекции над `Ledger`, не
агрегаты, владеющие состоянием.

| Экспорт | Назначение |
|---|---|
| `Ledger` | In-memory append-only книга: `append`/`getEntries`/`getBalance`/`getAllBalances`/`replay` |
| `LedgerEntry` | Неизменяемая запись (fillId, accountId, balanceDelta, type, timestamp), `create()` — `Result` |
| `LedgerEntryType` | `'POSITION_DELTA' \| 'CASH_DELTA' \| 'FEE_DEBIT'` |
| `FillLedgerAdapter` | `toLedgerEntries(fill: Fill): LedgerEntry[]` — Fill → 2-3 LedgerEntry |

```typescript
import { Ledger, FillLedgerAdapter } from '@polymarket/ledger';
import { AssetIdHelpers } from '@polymarket/ids';

const ledger = new Ledger();
ledger.append(FillLedgerAdapter.toLedgerEntries(fill));

const usdcBalance = ledger.getBalance(accountId, AssetIdHelpers.USDC); // Decimal
const history = ledger.replay(accountId); // LedgerEntry[], отсортированы по timestamp
```

## Архитектура

```
Fill (исполнение)
  │
  ▼  FillLedgerAdapter.toLedgerEntries(fill)
LedgerEntry[] (2-3 атомарные записи)
  │
  ▼  Ledger.append()
Ledger (in-memory источник истины, append-only)
  │
  ▼  getBalance / getAllBalances / replay
Portfolio / Position / PnL (проекции, вне этого пакета)
```

`Ledger` — чистый domain-объект без зависимости от инфраструктуры; персистентность (если
понадобится) — задача отдельного repository в infrastructure-слое, которого сегодня нет
(`Ledger` используется in-memory, реальный потребитель read-API — диагностический скрипт
`apps/bot/scripts/shadow-validate-ledger.ts` из Этапа 7, сверяющий баланс `Ledger` с
`Portfolio` на историческом корпусе).

## Fill → LedgerEntry: алгоритм разворачивания

`FillLedgerAdapter.toLedgerEntries(fill: Fill)` — **один аргумент**: `Fill` с Этапа 3 сам
несёт `settlementAssetId`, адаптеру не нужно знать расчётную валюту отдельным параметром.

**BUY tokenId qty @ price:**

```
POSITION_DELTA  tokenId          balanceDelta.amount = +qty
CASH_DELTA      settlementAsset  balanceDelta.amount = -(price × qty)
FEE_DEBIT       fee.asset        balanceDelta.amount = -feeAmount   (только если fee > 0)
```

**SELL tokenId qty @ price:** знаки `POSITION_DELTA`/`CASH_DELTA` инвертированы, `FEE_DEBIT`
всегда отрицателен независимо от направления сделки.

Источник значений — экономические методы самого `Fill` (`getSignedQuantity()`/
`getCashFlow()`/`getFeeFlow()`), не пересчёт полей адаптером — `FillLedgerAdapter` знает
только о структуре `Ledger`, не о деталях экономики исполнения (разделение ответственности:
`Fill` не должен зависеть от `Ledger`).

## Почему `balanceDelta.amount` — `SignedQuantity`, не `Decimal`

`AssetDelta` (`@polymarket/fill`) — `{ asset: AssetId; amount: SignedQuantity }`.
`SignedQuantity` — специализированный VO для знаковых количеств: гарантирует конечность
значения, нормализует `-0 → 0`, даёт семантические методы (`isPositive`/`isNegative`/
`isZero`/`neg`/`abs`) — согласуется с `Position.realizedPnL` и другими знаковыми полями
домена, а не просто заворачивает произвольный `Decimal`.

`Ledger.getBalance()`/`getAllBalances()` возвращают уже распакованный `Decimal`
(`balanceDelta.amount.value()`, суммированный через `.reduce()`) — публичный read-API
пакета намеренно остаётся на `Decimal`, а не оборачивается обратно в VO на выходе: вне
мандата этой миграции подбирать/строить VO для "баланс произвольного актива, возможно
отрицательный" (не единственная trade-цена/количество токенов, а сумма по всем `LedgerEntry`
аккаунта) — задокументировано как принятое ограничение, не пробел.

## Инварианты `LedgerEntry`

`LedgerEntry.create()` — `Result<LedgerEntry, ValidationError>`, две проверки:

1. `balanceDelta.amount != 0` — нулевые записи не имеют смысла.
2. `type === 'FEE_DEBIT'` ⇒ `balanceDelta.amount < 0` — комиссия всегда расход.

`FillLedgerAdapter`'s внутренний `createEntry()`-хелпер разворачивает `Err` в `throw` — это
`@internal`, не публичная граница: для валидного `Fill` (уже провалидированного при
конструировании) `LedgerEntry.create()` не может содержательно провалиться, throw здесь —
сигнал программной ошибки, симметрично уже принятому в этой миграции паттерну (Решение 2
ADR — throw легитимен как сигнал невозможного состояния).

## Ссылки

- ADR: `docs/architecture/boundary-contract.md`, `docs/architecture/ledger-layer.md`
  (более широкий архитектурный контекст: место Ledger в общем pipeline расчётов)
- Trade/Fill-архитектура: `docs/architecture/trade-fill-separation.md`
- План миграции, Этап 11: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`
