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
  fillId: FillId;        // ссылка на исполнение
  accountId: AccountId;  // чей баланс меняется
  asset: AssetId;        // какой актив
  delta: Decimal;        // +credit / -debit
  type: LedgerEntryType; // семантика операции
  timestamp: Timestamp;
}

type LedgerEntryType =
  | 'POSITION_DELTA'  // изменение позиции в токене
  | 'CASH_DELTA'      // изменение денежного баланса
  | 'FEE_DEBIT';      // списание комиссии
```

## Разворачивание Fill → LedgerEntry[]

### BUY YES 10 @ 0.62, fee 0.02 USDC

```typescript
const entries = FillLedgerAdapter.toLedgerEntries(fill, AssetIdHelpers.USDC);

// entries:
// { type: 'POSITION_DELTA', asset: YES,  delta: +10.00 }
// { type: 'CASH_DELTA',     asset: USDC, delta: -6.20  }
// { type: 'FEE_DEBIT',      asset: USDC, delta: -0.02  }
```

### SELL YES 10 @ 0.62, fee 0.02 USDC

```typescript
// entries:
// { type: 'POSITION_DELTA', asset: YES,  delta: -10.00 }
// { type: 'CASH_DELTA',     asset: USDC, delta: +6.20  }
// { type: 'FEE_DEBIT',      asset: USDC, delta: -0.02  }
```

При нулевой комиссии — 2 записи, при ненулевой — 3.

## Почему settlementAssetId передаётся явно

Fill — это запись исполнения. Знание о расчётной валюте (USDC) — это рыночное знание.
Fill не должен зависеть от конкретного рынка.

Для Polymarket: `settlementAssetId = AssetIdHelpers.USDC`.

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
// Получить все USDC дельты для аккаунта:
const usdcEntries = ledger.getEntries({ accountId, asset: AssetIdHelpers.USDC });
const pnl = usdcEntries.reduce((sum, e) => sum.plus(e.delta), new Decimal(0));
// = итоговое изменение USDC баланса
```

## Пакет

`packages/domain/accounting/ledger/` → `@polymarket/ledger`

Зависит от:
- `@polymarket/fill` (через paths в tsconfig + moduleNameMapper в jest)
- `@polymarket/ids`
- `@polymarket/value-objects`
