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
import { isErr } from '@polymarket/result';
import type { AccountId, VenueId, WalletAddress } from '@polymarket/ids';
import Decimal from 'decimal.js';

// Подготовка идентификаторов
const accountId: AccountId = {
  kind: 'WALLET',
  address: '0x1234567890123456789012345678901234567890' as WalletAddress
};
const venueId: VenueId = 'POLYMARKET' as VenueId;

// Создание баланса
const result = BalanceService.create(
  Money.of(new Decimal(10000)), // available: $100.00 (10000 units = $100.00)
  Money.of(new Decimal(2000)),  // reserved: $20.00 (2000 units = $20.00)
  accountId,       // ID аккаунта владельца
  venueId          // ID площадки (venue)
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
const reserveResult = BalanceService.reserve(balance, Money.of(new Decimal(3000)));
if (!reserveResult.ok) {
  console.error('Failed to reserve');
  return;
}

const balanceWithReserved = reserveResult.value;
console.log(balanceWithReserved.available().value()); // 7000 ($70.00)
console.log(balanceWithReserved.reserved().value());  // 5000 ($50.00)

// Вариант 1: Отмена ордера (размораживание средств)
const unfreezeResult = BalanceService.unfreezeReserved(balanceWithReserved, Money.of(new Decimal(3000)));
if (unfreezeResult.ok) {
  console.log(unfreezeResult.value.available().value()); // 10000
}

// Вариант 2: Исполнение ордера (списание средств)
const consumeResult = BalanceService.consumeReserved(balanceWithReserved, Money.of(new Decimal(3000)));
if (consumeResult.ok) {
  console.log(consumeResult.value.available().value()); // 7000 (не изменился)
  console.log(consumeResult.value.total().value());     // 9000 (уменьшился)
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
- `BalanceService.unfreezeReserved()` — размораживание средств (reserved → available)
- `BalanceService.consumeReserved()` — списание зарезервированных средств (уменьшает total)
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
import { expectOk } from '@polymarket/result';

// Полная сводка (возвращает Result)
const summaryResult = BalanceFormatter.toSummary(balance);
if (summaryResult.ok) {
  console.log(summaryResult.value);
  // "Available: $100.00, Reserved: $20.00, Total: $120.00 (16.67% reserved)"
}
// или с expectOk (бросает исключение если Err)
console.log(expectOk(BalanceFormatter.toSummary(balance)));

// Компактный формат (возвращает Result)
const compactResult = BalanceFormatter.toCompact(balance);
if (compactResult.ok) {
  console.log(compactResult.value);
  // "Avail: $100.00 | Res: $20.00 | Total: $120.00"
}

// Debug-строка (не возвращает Result, всегда string)
console.log(BalanceFormatter.toDebugString(balance));
// "Balance(available: 10000 USDC, reserved: 2000 USDC, total: 12000 USDC, account: wallet:0x..., venue: POLYMARKET)"
```

## Архитектура

Balance реализован по паттерну **Throws+Facade**:

```text
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
- [facade.md](./facade.md) — Facade Layer (BalanceService API)
- [examples.md](./examples.md) — примеры использования

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
