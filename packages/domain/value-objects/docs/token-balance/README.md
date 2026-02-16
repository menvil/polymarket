# TokenBalance Value Object

**TokenBalance** — иммутабельный value object, представляющий баланс токенов исхода (outcome tokens) с доступными (available) и зарезервированными (reserved) токенами.

## Описание

TokenBalance инкапсулирует логику управления токенами исхода на торговом счёте:

- **Available** — доступные токены для новых операций
- **Reserved** — зарезервированные токены под активные ордера
- **Total** — общий баланс токенов (available + reserved)
- **Token** — идентификатор токена исхода (OutcomeToken)

## Быстрый старт

```typescript
import { TokenBalanceService } from '@polymarket/value-objects/token-balance';
import { OutcomeToken } from '@polymarket/value-objects/outcome-token';
import { Quantity } from '@polymarket/value-objects/quantity';
import { BinaryOutcome, KnownOnChainProtocols, KnownVenues } from '@polymarket/ids';
import type { OnChainConditionRef, AccountId, VenueId } from '@polymarket/ids';
import { parseWalletAddress, accountIdFromWallet } from '@polymarket/ids';
import { isErr } from '@polymarket/result';
import Decimal from 'decimal.js';

// Подготовка идентификаторов
const conditionRef: OnChainConditionRef = {
  kind: 'ONCHAIN',
  protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
  chainId: 137 as any,
  conditionId: '0x...' as any
};

const token = OutcomeToken.of(conditionRef, BinaryOutcome.UP);
const walletAddress = parseWalletAddress('0x1234567890123456789012345678901234567890')!;
const accountId: AccountId = accountIdFromWallet(walletAddress);
const venueId: VenueId = KnownVenues.POLYMARKET;

// Создание баланса токенов
const result = TokenBalanceService.create(
  token,                              // OutcomeToken
  Quantity.of(new Decimal(100)),      // available: 100 токенов
  Quantity.of(new Decimal(20)),       // reserved: 20 токенов
  accountId,                          // ID аккаунта владельца
  venueId                             // ID площадки (venue)
);

if (isErr(result)) {
  console.error(result.error.context?.reason);
  return;
}

const balance = result.value;

// Query методы
console.log(balance.total().value().toNumber());     // 120 токенов
console.log(balance.reservedPercentage().toNumber()); // 16.67%

// Резервирование токенов (для открытия ордера)
const reserveResult = TokenBalanceService.reserve(balance, Quantity.of(new Decimal(30)));
if (reserveResult.ok) {
  const newBalance = reserveResult.value;
  console.log(newBalance.available().value().toNumber()); // 70 токенов
  console.log(newBalance.reserved().value().toNumber());  // 50 токенов
}

// Отмена ордера (размораживание токенов)
const unfreezeResult = TokenBalanceService.unfreezeReserved(newBalance, Quantity.of(new Decimal(30)));
if (unfreezeResult.ok) {
  console.log(unfreezeResult.value.available().value().toNumber()); // 100
}

// Исполнение ордера (списание токенов)
const consumeResult = TokenBalanceService.consumeReserved(newBalance, Quantity.of(new Decimal(30)));
if (consumeResult.ok) {
  console.log(consumeResult.value.available().value().toNumber()); // 70 (не изменился)
  console.log(consumeResult.value.total().value().toNumber());     // 90 (уменьшился)
}
```

## Основные возможности

### Инварианты (Core Layer)

TokenBalance гарантирует соблюдение бизнес-правил:

1. ✅ **available >= 0** — доступные токены не могут быть отрицательными
2. ✅ **reserved >= 0** — зарезервированные токены не могут быть отрицательными
3. ✅ **Один токен** — available и reserved относятся к одному OutcomeToken
4. ✅ **Валидные идентификаторы** — accountId и venueId должны быть валидными

### Операции (Facade Layer)

Все операции возвращают `Result<TokenBalance, InvalidTokenBalanceError>`:

- `TokenBalanceService.create()` — создание баланса
- `TokenBalanceService.createWithZeroReserved()` — создание баланса без резерва
- `TokenBalanceService.reserve()` — резервирование токенов (available → reserved)
- `TokenBalanceService.unfreezeReserved()` — размораживание токенов (reserved → available)
- `TokenBalanceService.consumeReserved()` — списание зарезервированных токенов (уменьшает total)
- `TokenBalanceService.updateAvailable()` — обновление доступных токенов
- `TokenBalanceService.canReserve()` — проверка возможности резервирования

### Сериализация (Adapters Layer)

```typescript
import { TokenBalanceSerializer } from '@polymarket/value-objects/token-balance';

// JSON сериализация
const json = TokenBalanceSerializer.toJSON(balance);
// {
//   token: { conditionRef: {...}, outcomeKey: "UP" },
//   available: "100",
//   reserved: "20",
//   accountId: "wallet:0x...",
//   venueId: "POLYMARKET"
// }

// Десериализация с валидацией
const result = TokenBalanceSerializer.fromJSON(json);
if (result.ok) {
  console.log(result.value.total().value().toNumber()); // 120
}
```

### Форматирование (Adapters Layer)

```typescript
import { TokenBalanceFormatter } from '@polymarket/value-objects/token-balance';

// Полная сводка
console.log(TokenBalanceFormatter.toSummary(balance));
// "Available: 100, Reserved: 20, Total: 120 (16.67% reserved) [UP]"

// Компактный формат
console.log(TokenBalanceFormatter.toCompact(balance));
// "Avail: 100 | Res: 20 | Total: 120 [UP]"

// Debug-строка
console.log(TokenBalanceFormatter.toDebugString(balance));
// "TokenBalance(available: 100, reserved: 20, total: 120, token: UP, account: wallet:0x..., venue: POLYMARKET)"
```

## Архитектура

TokenBalance реализован по паттерну **Throws+Facade**:

```text
┌──────────────────────────────────────────────┐
│  Core Layer (TokenBalance)                   │
│  - Throws на нарушение инвариантов           │
│  - Иммутабельные операции                    │
│  - Query методы                              │
└─────────────────┬────────────────────────────┘
                  │
┌─────────────────▼────────────────────────────┐
│  Rules Layer                                 │
│  - ValidateReserveAmount                     │
│  - ValidateReleaseAmount                     │
│  - ValidateTokenMatch                        │
└─────────────────┬────────────────────────────┘
                  │
┌─────────────────▼────────────────────────────┐
│  Facade Layer (TokenBalanceService)          │
│  - Ловит exceptions → Result                 │
│  - Never Throw контракт                      │
│  - Оркестрация Rules + Core                  │
└─────────────────┬────────────────────────────┘
                  │
┌─────────────────▼────────────────────────────┐
│  Adapters Layer                              │
│  - TokenBalanceSerializer (JSON ↔ Balance)   │
│  - TokenBalanceFormatter (Balance → строки)  │
└──────────────────────────────────────────────┘
```

Подробнее: [architecture.md](./architecture.md)

## Типизированные ошибки

```typescript
import { TokenBalanceErrorReason } from '@polymarket/value-objects/token-balance';

// Type-safe проверка ошибок
if (isErr(result)) {
  switch (result.error.context?.reason) {
    case TokenBalanceErrorReason.INSUFFICIENT_AVAILABLE:
      console.log('Недостаточно available для резервирования');
      break;
    case TokenBalanceErrorReason.INSUFFICIENT_RESERVED:
      console.log('Недостаточно reserved для освобождения');
      break;
    case TokenBalanceErrorReason.TOKEN_MISMATCH:
      console.log('Несовпадение токенов');
      break;
    case TokenBalanceErrorReason.NEGATIVE_AVAILABLE:
      console.log('Отрицательный available');
      break;
    case TokenBalanceErrorReason.NEGATIVE_RESERVED:
      console.log('Отрицательный reserved');
      break;
    case TokenBalanceErrorReason.INVALID_FORMAT:
      console.log('Ошибка парсинга');
      break;
    case TokenBalanceErrorReason.INVALID_TOKEN:
      console.log('Невалидный токен');
      break;
    case TokenBalanceErrorReason.INVALID_AMOUNT:
      console.log('Невалидное количество');
      break;
  }
}
```

## Документация

- [architecture.md](./architecture.md) — архитектура и слои
- [facade.md](./facade.md) — Facade Layer (TokenBalanceService API)
- [examples.md](./examples.md) — примеры использования

## Связанные модули

- **OutcomeToken** — идентификатор токена исхода
- **Quantity** — базовый value object для количества токенов
- **QuantityService** — используется для арифметических операций
- **InvalidTokenBalanceError** — типизированная ошибка из `@polymarket/errors`
- **Result** — монада для обработки ошибок из `@polymarket/result`

## Принципы

- ✅ **Иммутабельность** — все операции возвращают новые экземпляры
- ✅ **Type Safety** — полная типизация с TypeScript
- ✅ **Never Throw** — Facade никогда не бросает исключения
- ✅ **Композиция** — построен на базе Quantity и OutcomeToken value objects
- ✅ **Точность** — использует Decimal.js для вычислений
