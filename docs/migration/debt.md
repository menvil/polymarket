# Метрика архитектурного долга по пакетам

Сгенерировано: `node scripts/scan-conventions.mjs` — 2026-08-11T15:30:57.089Z

Эвристический скан (см. TSDoc в `scripts/scan-conventions.mjs`) — не типо-осведомлён,
не судит отдельный файл. Задача: воспроизводимый счётчик, который должен монотонно
падать по мере прохождения этапов плана миграции
(`docs/architecture/boundary-contract.md`, план — `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`).

| Пакет | rawDecimal | rawNumber | rawString | throw | undocumented/total exports | docs/ |
|---|---:|---:|---:|---:|---:|:---:|
| `apps/bot` | 104 | 1615 | 209 | 20 | 79/234 | ✅ |
| `apps/collect-data` | 0 | 27 | 14 | 39 | 0/18 | ❌ |
| `apps/pnl` | 0 | 57 | 88 | 4 | 0/24 | ❌ |
| `packages/application/event-bus` | 0 | 4 | 2 | 9 | 0/32 | ✅ |
| `packages/application/handlers` | 0 | 0 | 3 | 0 | 0/6 | ✅ |
| `packages/application/market-discovery` | 0 | 7 | 3 | 0 | 0/2 | ❌ |
| `packages/application/market-state` | 0 | 107 | 50 | 12 | 0/44 | ❌ |
| `packages/application/orchestrators` | 0 | 0 | 0 | 0 | 0/7 | ✅ |
| `packages/application/ports` | 5 | 54 | 80 | 2 | 0/97 | ✅ |
| `packages/application/risk` | 12 | 6 | 9 | 5 | 0/12 | ✅ |
| `packages/application/strategy` | 11 | 41 | 50 | 6 | 30/69 | ❌ |
| `packages/application/use-cases` | 6 | 22 | 84 | 5 | 0/73 | ✅ |
| `packages/domain/accounting/ledger` | 1 | 0 | 0 | 1 | 3/10 | ❌ |
| `packages/domain/cross-market` | 0 | 33 | 13 | 0 | 3/23 | ✅ |
| `packages/domain/entities/fill` | 6 | 6 | 14 | 1 | 7/20 | ✅ |
| `packages/domain/entities/market` | 0 | 12 | 10 | 4 | 1/23 | ✅ |
| `packages/domain/entities/order` | 2 | 10 | 24 | 0 | 0/27 | ✅ |
| `packages/domain/entities/orderbook` | 0 | 17 | 21 | 2 | 0/16 | ✅ |
| `packages/domain/entities/portfolio` | 9 | 1 | 3 | 1 | 3/14 | ✅ |
| `packages/domain/entities/position` | 2 | 1 | 5 | 0 | 0/19 | ✅ |
| `packages/domain/entities/trade` | 5 | 2 | 16 | 0 | 2/6 | ✅ |
| `packages/domain/market-data/order-book` | 11 | 23 | 5 | 4 | 6/16 | ✅ |
| `packages/domain/market-data/trade-tape` | 0 | 7 | 0 | 2 | 1/7 | ✅ |
| `packages/domain/value-objects` | 0 | 91 | 151 | 0 | 21/156 | ✅ |
| `packages/foundation/errors` | 0 | 4 | 32 | 98 | 7/59 | ✅ |
| `packages/foundation/ids` | 0 | 8 | 49 | 5 | 21/133 | ✅ |
| `packages/foundation/logger` | 0 | 1 | 30 | 1 | 2/11 | ✅ |
| `packages/foundation/math` | 0 | 3 | 8 | 0 | 1/46 | ✅ |
| `packages/foundation/result` | 0 | 1 | 7 | 9 | 0/31 | ✅ |
| `packages/foundation/rolling-window` | 0 | 6 | 0 | 1 | 0/2 | ✅ |
| `packages/foundation/time` | 0 | 3 | 6 | 7 | 3/12 | ✅ |
| `packages/infrastructure/adapters` | 0 | 0 | 6 | 0 | 1/1 | ❌ |
| `packages/infrastructure/backtesting` | 0 | 116 | 55 | 3 | 5/27 | ❌ |
| `packages/infrastructure/cex-market-data` | 0 | 50 | 26 | 4 | 6/25 | ❌ |
| `packages/infrastructure/in-memory` | 2 | 10 | 25 | 2 | 2/9 | ❌ |
| `packages/infrastructure/persistence/data-collection` | 0 | 3 | 21 | 7 | 6/12 | ❌ |
| `packages/infrastructure/persistence/snapshot-readers` | 0 | 3 | 18 | 1 | 6/11 | ❌ |
| `packages/infrastructure/polymarket` | 2 | 171 | 421 | 70 | 22/178 | ❌ |
| **ИТОГО** | **178** | **2522** | **1558** | **325** | **238/1512** | **13 пакетов без docs/** |

`decimal.js` импортируется вне `value-objects`/`math` в 84 файлах — полный список в `docs/migration/decimal-import-files.txt` (allowlist для ESLint-правила Этапа 0.4).
