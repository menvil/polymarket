# Ledger Layer — бухгалтерский учёт исполнений

## Проблема

Без Ledger layer:
- Portfolio и Position обновляются напрямую из Fill
- Нет единого источника истины
- Replay невозможен без перегонки всего state
- P&L зависит от состояния, а не от фактов

## Решение: Append-only Ledger

```
Venue Trade
      │
      ▼
Fill (execution fact)
      │
      ▼  FillLedgerAdapter
LedgerEntry[]
      │
      ▼  (projection)
Portfolio / Position / PnL
```

Ledger — append-only источник истины.
Portfolio и Position — проекции (projections) над Ledger.

## LedgerEntry

Атомарное изменение баланса актива:

```typescript
interface LedgerEntry {
  fillId: FillId;             // ссылка на исполнение
  accountId: AccountId;       // чей баланс меняется
  balanceDelta: AssetDelta;   // { asset: AssetId; amount: SignedQuantity }
  type: LedgerEntryType;      // семантика операции
  timestamp: Timestamp;
}

type LedgerEntryType =
  | 'POSITION_DELTA'  // изменение позиции в токене
  | 'CASH_DELTA'      // изменение денежного баланса
  | 'FEE_DEBIT';      // списание комиссии
```

`balanceDelta.amount` — не `Decimal`, а `SignedQuantity` VO (`@polymarket/value-objects`):
гарантирует конечность значения, нормализует `-0 → 0`, даёт семантические методы
(`isPositive`/`isNegative`/`isZero`). Числовое значение — `balanceDelta.amount.toNumber()`
или `.value()` для дальнейшей `Decimal`-арифметики.

## Разворачивание Fill → LedgerEntry[]

### BUY YES 10 @ 0.62, fee 0.02 USDC

```typescript
const entries = FillLedgerAdapter.toLedgerEntries(fill);

// entries:
// { type: 'POSITION_DELTA', balanceDelta: { asset: YES,  amount: +10.00 } }
// { type: 'CASH_DELTA',     balanceDelta: { asset: USDC, amount: -6.20  } }
// { type: 'FEE_DEBIT',      balanceDelta: { asset: USDC, amount: -0.02  } }
```

### SELL YES 10 @ 0.62, fee 0.02 USDC

```typescript
// entries:
// { type: 'POSITION_DELTA', balanceDelta: { asset: YES,  amount: -10.00 } }
// { type: 'CASH_DELTA',     balanceDelta: { asset: USDC, amount: +6.20  } }
// { type: 'FEE_DEBIT',      balanceDelta: { asset: USDC, amount: -0.02  } }
```

При нулевой комиссии — 2 записи, при ненулевой — 3.

## Почему `toLedgerEntries()` принимает только `Fill`

`FillLedgerAdapter.toLedgerEntries(fill: Fill)` — один аргумент, без отдельного
`settlementAssetId`. Раньше расчётная валюта передавалась явно вторым параметром — сейчас
`Fill` сам несёт `settlementAssetId` (рыночное знание уже встроено в исполнение при его
конструировании), и адаптер читает её через экономические методы самого `Fill`
(`getCashFlow()`/`getFeeFlow()`), не через отдельный аргумент. Для Polymarket
расчётный актив на практике всегда `AssetIdHelpers.USDC`.

## Архитектурные принципы

**Fill — независимая запись:**
- Не принадлежит Order aggregate
- Не принадлежит Portfolio
- Out-of-order events обрабатываются корректно

**Ledger — единственный источник истины:**
- Append-only (никаких обновлений, только добавление)
- Replay возможен в любой момент
- P&L = сумма всех CASH_DELTA + FEE_DEBIT по accountId

**Portfolio = проекция:**
- Строится из LedgerEntry[]
- Не является агрегатом с мутациями
- Пересчитывается при необходимости

## Пример: P&L через Ledger

```typescript
// Ledger.getBalance() уже делает суммирование по accountId+asset:
const usdcPnl = ledger.getBalance(accountId, AssetIdHelpers.USDC);
// = итоговое изменение USDC баланса (Decimal)
```

## Пакет

`packages/domain/accounting/ledger/` → `@polymarket/ledger`

Зависит от:
- `@polymarket/fill` (через paths в tsconfig + moduleNameMapper в jest)
- `@polymarket/ids`
- `@polymarket/value-objects`

Подробный API-референс (все экспорты, инварианты `LedgerEntry.create()`, точный алгоритм
`FillLedgerAdapter`) — `packages/domain/accounting/ledger/docs/ledger.md`.
