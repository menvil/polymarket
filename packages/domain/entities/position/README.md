# @polymarket/position

Position entity with FIFO/LIFO lot accounting for Polymarket trading system.

## Overview

- **Immutable entity** — all mutations return a new instance
- **`lots[]` = single source of truth** — `quantity` and `averageEntryPrice` are derived getters
- **FIFO / LIFO** accounting — `position.close(qty, price, 'FIFO'|'LIFO', closedAt)`
- **Result pattern** — no exceptions from domain methods, explicit error handling
- **No fees** — fees belong to Fill/Ledger, not Position
