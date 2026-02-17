# @polymarket/ids

Foundation ID types для Polymarket domain.

## Описание

Пакет содержит фундаментальные типы идентификаторов, используемые во всех слоях приложения.

- **Branded types** — compile-time type safety
- **Discriminated unions** — AccountId, ConditionRef, AssetId
- **Result pattern** — явная обработка ошибок через `@polymarket/result`
- **Runtime валидация** — parser функции с защитой от DoS

## Структура

```
src/
├── core/              # Domain IDs
│   ├── ConditionRef.ts       # On-chain | Off-chain ссылка на condition
│   ├── OutcomeKey.ts         # UP/DOWN outcome key
│   ├── AccountId.ts          # WALLET | VENUE | SUBACCOUNT
│   ├── VenueId.ts            # Где находятся балансы
│   └── AssetId.ts            # CURRENCY | OUTCOME_TOKEN
├── market-data/       # Market Data IDs (откуда ЧИТАЕМ данные)
│   ├── MarketDataSourceId.ts
│   └── InstrumentId.ts
└── execution/         # Execution IDs (куда ОТПРАВЛЯЕМ ордера)
    ├── ExecutionVenueId.ts
    ├── OrderId.ts
    └── FillId.ts
```

## Документация

- [Руководство по использованию](./docs/usage-guide.md) — быстрый старт, сценарии, best practices
- [Архитектура](./docs/architecture.md) — архитектурные решения и дизайн
- [Справочник типов](./docs/types-reference.md) — полный список типов и функций

## Subpath exports

```typescript
import { type ConditionRef, BinaryOutcome, AssetIdHelpers } from '@polymarket/ids';
import { type MarketDataSourceId, KnownMarketDataSources } from '@polymarket/ids/market-data';
import { type ExecutionVenueId, KnownExecutionVenues } from '@polymarket/ids/execution';
```

## Scripts

```bash
npm run build          # TypeScript компиляция
npm test               # Unit tests (Jest)
npm run typecheck      # Type checking без компиляции
npm run lint           # ESLint
```

## Dependencies

**Runtime:** `@polymarket/result` — Result pattern для error handling, `@polymarket/errors` — typed error classes

**Dev:** TypeScript, Jest, ESLint
