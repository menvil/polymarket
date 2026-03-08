# @polymarket/portfolio

Portfolio aggregate for the Polymarket trading system.

## Overview

- **Immutable aggregate root** — all mutations return a new instance
- **Balance management** — `reserveForOrder`, `releaseReservation`, `applyDebit`, `applyCredit`
- **Position tracking** — `upsertPosition` auto-removes closed positions
- **Structural typing** — `IPosition` interface decouples Portfolio from Position package
- **Result pattern** — no exceptions from domain methods, explicit error handling

## Balance lifecycle

```
reserveForOrder(amount)    →  available -= amount, reserved += amount
releaseReservation(amount) →  available += amount, reserved -= amount
applyDebit(amount)         →  reserved -= amount  (order executed)
applyCredit(amount)        →  available += amount (profit / deposit)
```

## Valuation

`getTotalValue` and `getTotalUnrealizedPnL` are standalone functions that require
current market prices (external data not owned by the aggregate):

```typescript
import { getTotalValue, getTotalUnrealizedPnL } from '@polymarket/portfolio';

const totalValue = getTotalValue(portfolio.getPositions(), getPrice, 'USDC');
const totalPnL   = getTotalUnrealizedPnL(portfolio.getPositions(), getPrice);
```
