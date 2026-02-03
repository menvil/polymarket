# Balance Value Object

**Balance** — иммутабельный value object, представляющий торговый баланс с доступными (available) и зарезервированными (reserved) средствами.

## Описание

Balance инкапсулирует логику управления средствами на торговом счёте:

- **Available** — доступные средства для новых операций
- **Reserved** — зарезервированные средства под активные ордера
- **Total** — общий баланс (available + reserved)

## Быстрый старт

```typescript
import { Balance, BalanceService } from '@polymarket/value-objects/balance';
import { Money } from '@polymarket/value-objects/money';

// Создание баланса
const result = BalanceService.create(
  Money.of(10000), // available: $100.00
  Money.of(2000)   // reserved: $20.00
);

if (isErr(result)) {
  console.error(result.error.context?.reason);
  return;
}

const balance = result.value;

// Query методы
console.log(balance.total().value());           // 12000 ($120.00)
console.log(balance.reservedPercentage());       // 16.67%

// Резервирование средств (для открытия ордера)
const reserveResult = BalanceService.reserve(balance, Money.of(3000));
if (reserveResult.ok) {
  const newBalance = reserveResult.value;
  console.log(newBalance.available().value()); // 7000 ($70.00)
  console.log(newBalance.reserved().value());  // 5000 ($50.00)
}

// Освобождение средств (после закрытия ордера)
const releaseResult = BalanceService.release(newBalance, Money.of(3000));
if (releaseResult.ok) {
  console.log(releaseResult.value.available().value()); // 10000
}
```

## Основные возможности

### Инварианты (Core Layer)

Balance гарантирует соблюдение бизнес-правил:

1. ✅ **available >= 0** — доступные средства не могут быть отрицательными
2. ✅ **reserved >= 0** — зарезервированные средства не могут быть отрицательными
3. ✅ **Единая валюта** — available и reserved должны быть в одной валюте

### Операции (Facade Layer)

Все операции возвращают `Result<Balance, InvalidBalanceError>`:

- `BalanceService.create()` — создание баланса
- `BalanceService.reserve()` — резервирование средств (available → reserved)
- `BalanceService.release()` — освобождение средств (reserved → available)
- `BalanceService.updateAvailable()` — обновление доступных средств

### Сериализация (Adapters Layer)

```typescript
import { BalanceSerializer } from '@polymarket/value-objects/balance';

// JSON сериализация
const json = BalanceSerializer.toJSON(balance);
// { available: { amount: "10000", currency: "USDC" }, reserved: { amount: "2000", currency: "USDC" } }

// Десериализация с валидацией
const result = BalanceSerializer.fromJSON(json);
if (result.ok) {
  console.log(result.value.total().value()); // 12000
}
```

### Форматирование (Adapters Layer)

```typescript
import { BalanceFormatter } from '@polymarket/value-objects/balance';

// Полная сводка
BalanceFormatter.toSummary(balance);
// "Available: $100.00, Reserved: $20.00, Total: $120.00 (16.67% reserved)"

// Компактный формат
BalanceFormatter.toCompact(balance);
// "Avail: $100.00 | Res: $20.00 | Total: $120.00"

// Debug-строка
BalanceFormatter.toDebugString(balance);
// "Balance(available: 10000 USDC, reserved: 2000 USDC, total: 12000 USDC)"
```

## Архитектура

Balance реализован по паттерну **Throws+Facade**:

```
┌──────────────────────────────────────────────┐
│  Core Layer (Balance)                        │
│  - Throws на нарушение инвариантов           │
│  - Иммутабельные операции                    │
│  - Query методы                              │
└─────────────────┬────────────────────────────┘
                  │
┌─────────────────▼────────────────────────────┐
│  Rules Layer                                 │
│  - ValidateReserveAmount                     │
│  - ValidateReleaseAmount                     │
│  - ValidateCurrencyMatch                     │
└─────────────────┬────────────────────────────┘
                  │
┌─────────────────▼────────────────────────────┐
│  Facade Layer (BalanceService)               │
│  - Ловит exceptions → Result                 │
│  - Never Throw контракт                      │
│  - Оркестрация Rules + Core                  │
└─────────────────┬────────────────────────────┘
                  │
┌─────────────────▼────────────────────────────┐
│  Adapters Layer                              │
│  - BalanceSerializer (JSON ↔ Balance)        │
│  - BalanceFormatter (Balance → строки)       │
└──────────────────────────────────────────────┘
```

Подробнее: [architecture.md](./architecture.md)

## Типизированные ошибки

```typescript
import { BalanceErrorReason } from '@polymarket/value-objects/balance';

// Type-safe проверка ошибок
if (isErr(result)) {
  switch (result.error.context?.reason) {
    case BalanceErrorReason.INSUFFICIENT_FUNDS:
      console.log('Недостаточно available для резервирования');
      break;
    case BalanceErrorReason.INSUFFICIENT_RESERVED:
      console.log('Недостаточно reserved для освобождения');
      break;
    case BalanceErrorReason.CURRENCY_MISMATCH:
      console.log('Несовпадение валют');
      break;
    case BalanceErrorReason.NEGATIVE_AVAILABLE:
      console.log('Отрицательный available');
      break;
    case BalanceErrorReason.NEGATIVE_RESERVED:
      console.log('Отрицательный reserved');
      break;
    case BalanceErrorReason.INVALID_FORMAT:
      console.log('Ошибка парсинга');
      break;
    case BalanceErrorReason.UNSUPPORTED_CURRENCY:
      console.log('Неподдерживаемая валюта');
      break;
  }
}
```

## Документация

- [architecture.md](./architecture.md) — архитектура и слои
- [core.md](./core.md) — Core Layer (Balance, инварианты, query методы)
- [facade.md](./facade.md) — Facade Layer (BalanceService API)
- [examples.md](./examples.md) — примеры использования
- [migration.md](./migration.md) — миграция с предыдущих версий

## Связанные модули

- **Money** — базовый value object для денежных сумм
- **MoneyService** — используется для арифметических операций
- **InvalidBalanceError** — типизированная ошибка из `@polymarket/errors`
- **Result** — монада для обработки ошибок из `@polymarket/result`

## Принципы

- ✅ **Иммутабельность** — все операции возвращают новые экземпляры
- ✅ **Type Safety** — полная типизация с TypeScript
- ✅ **Never Throw** — Facade никогда не бросает исключения
- ✅ **Композиция** — построен на базе Money value object
- ✅ **Точность** — использует Decimal.js для вычислений
