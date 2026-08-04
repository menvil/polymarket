# Метрика архитектурного долга по пакетам

Сгенерировано: `node scripts/scan-conventions.mjs` — 2026-08-04T12:04:43.529Z

Эвристический скан (см. TSDoc в `scripts/scan-conventions.mjs`) — не типо-осведомлён,
не судит отдельный файл. Задача: воспроизводимый счётчик, который должен монотонно
падать по мере прохождения этапов плана миграции
(`docs/architecture/boundary-contract.md`, план — `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`).

| Пакет | rawDecimal | rawNumber | rawString | throw | undocumented/total exports | docs/ |
|---|---:|---:|---:|---:|---:|:---:|
| `apps/bot` | 104 | 1615 | 209 | 16 | 79/234 | ✅ |
| `apps/collect-data` | 0 | 27 | 14 | 39 | 0/18 | ❌ |
| `apps/pnl` | 0 | 57 | 88 | 4 | 0/24 | ❌ |
| `packages/application/event-bus` | 0 | 4 | 2 | 6 | 13/32 | ❌ |
| `packages/application/handlers` | 0 | 0 | 3 | 0 | 6/6 | ❌ |
| `packages/application/market-discovery` | 0 | 7 | 3 | 0 | 0/2 | ❌ |
| `packages/application/market-state` | 0 | 105 | 52 | 2 | 22/41 | ❌ |
| `packages/application/orchestrators` | 0 | 0 | 0 | 0 | 2/7 | ✅ |
| `packages/application/ports` | 5 | 54 | 80 | 3 | 30/97 | ❌ |
| `packages/application/risk` | 16 | 6 | 8 | 5 | 10/12 | ❌ |
| `packages/application/strategy` | 11 | 41 | 50 | 6 | 30/69 | ❌ |
| `packages/application/use-cases` | 12 | 21 | 84 | 5 | 16/70 | ✅ |
| `packages/domain/accounting/ledger` | 1 | 0 | 0 | 1 | 3/10 | ❌ |
| `packages/domain/cross-market` | 0 | 35 | 13 | 0 | 3/23 | ❌ |
| `packages/domain/entities/fill` | 10 | 9 | 11 | 0 | 8/20 | ✅ |
| `packages/domain/entities/market` | 0 | 12 | 10 | 8 | 1/23 | ✅ |
| `packages/domain/entities/order` | 2 | 10 | 24 | 0 | 11/27 | ✅ |
| `packages/domain/entities/orderbook` | 0 | 17 | 21 | 2 | 0/16 | ✅ |
| `packages/domain/entities/portfolio` | 12 | 1 | 3 | 1 | 3/14 | ✅ |
| `packages/domain/entities/position` | 2 | 1 | 5 | 0 | 6/19 | ✅ |
| `packages/domain/entities/trade` | 5 | 2 | 10 | 0 | 2/6 | ✅ |
| `packages/domain/market-data/order-book` | 13 | 23 | 5 | 9 | 6/16 | ❌ |
| `packages/domain/market-data/trade-tape` | 6 | 7 | 0 | 1 | 1/7 | ❌ |
| `packages/domain/value-objects` | 0 | 91 | 151 | 0 | 21/156 | ✅ |
| `packages/foundation/errors` | 0 | 4 | 32 | 97 | 6/57 | ✅ |
| `packages/foundation/ids` | 0 | 8 | 45 | 5 | 19/125 | ✅ |
| `packages/foundation/logger` | 0 | 1 | 30 | 1 | 2/11 | ✅ |
| `packages/foundation/math` | 0 | 3 | 8 | 0 | 1/46 | ✅ |
| `packages/foundation/result` | 0 | 1 | 7 | 9 | 0/31 | ✅ |
| `packages/foundation/time` | 0 | 3 | 6 | 7 | 3/12 | ✅ |
| `packages/infrastructure/adapters` | 0 | 0 | 6 | 0 | 1/1 | ❌ |
| `packages/infrastructure/backtesting` | 0 | 116 | 55 | 3 | 5/27 | ❌ |
| `packages/infrastructure/cex-market-data` | 0 | 50 | 26 | 4 | 6/25 | ❌ |
| `packages/infrastructure/in-memory` | 2 | 10 | 25 | 3 | 2/9 | ❌ |
| `packages/infrastructure/persistence/data-collection` | 0 | 3 | 21 | 7 | 6/12 | ❌ |
| `packages/infrastructure/persistence/snapshot-readers` | 0 | 3 | 18 | 1 | 6/11 | ❌ |
| `packages/infrastructure/polymarket` | 2 | 171 | 421 | 69 | 22/178 | ❌ |
| **ИТОГО** | **203** | **2518** | **1546** | **314** | **352/1494** | **20 пакетов без docs/** |

`decimal.js` импортируется вне `value-objects`/`math` в 85 файлах — полный список в `docs/migration/decimal-import-files.txt` (allowlist для ESLint-правила Этапа 0.4).
