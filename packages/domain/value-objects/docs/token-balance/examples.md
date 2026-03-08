# Примеры использования TokenBalance

## Базовые операции

### Создание баланса токенов

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
  conditionId: '0xabc...' as any
};

const token = OutcomeToken.of(conditionRef, BinaryOutcome.UP);
const walletAddress = parseWalletAddress('0x1234567890123456789012345678901234567890')!;
const accountId: AccountId = accountIdFromWallet(walletAddress);
const venueId: VenueId = KnownVenues.POLYMARKET;

const result = TokenBalanceService.create(
  token,
  Quantity.of(new Decimal(100)), // 100 токенов available
  Quantity.of(new Decimal(20)),  // 20 токенов reserved
  accountId,
  venueId
);

if (isErr(result)) {
  console.error('Ошибка создания:', result.error.message);
  return;
}

const balance = result.value;
```

### Query методы

```typescript
// Общий баланс токенов
console.log(balance.total().value().toNumber()); // 120

// Процент резервирования
console.log(balance.reservedPercentage().toNumber()); // 16.67

// Проверка пустоты
console.log(balance.isZero()); // false
console.log(balance.hasReserved()); // true

// Токен исхода
console.log(balance.outcomeKey()); // "UP"
```

---

## Торговые сценарии

### Открытие ордера (резервирование токенов)

```typescript
// У пользователя 100 токенов UP available, 20 reserved
const balance = expectOk(TokenBalanceService.create(
  token,
  Quantity.of(new Decimal(100)),
  Quantity.of(new Decimal(20)),
  accountId,
  venueId
));

// Открываем ордер на продажу 30 токенов UP
const orderQty = Quantity.of(new Decimal(30));

// Резервируем токены
const reserveResult = TokenBalanceService.reserve(balance, orderQty);

if (!reserveResult.ok) {
  if (reserveResult.error.context?.reason === TokenBalanceErrorReason.INSUFFICIENT_AVAILABLE) {
    console.log('Недостаточно токенов для открытия ордера');
  }
  return;
}

const newBalance = reserveResult.value;
console.log(newBalance.available().value().toNumber()); // 70
console.log(newBalance.reserved().value().toNumber());  // 50
```

### Отмена ордера (размораживание токенов)

```typescript
// Ордер отменён, возвращаем 30 токенов в available
const unfreezeResult = TokenBalanceService.unfreezeReserved(
  newBalance,
  Quantity.of(new Decimal(30))
);

if (unfreezeResult.ok) {
  const finalBalance = unfreezeResult.value;
  console.log(finalBalance.available().value().toNumber()); // 100 (вернулись токены)
  console.log(finalBalance.reserved().value().toNumber());  // 20
  console.log(finalBalance.total().value().toNumber());     // 120 (total не изменился)
}
```

### Исполнение ордера (списание токенов)

```typescript
// Ордер исполнился, списываем 30 токенов из reserved
const consumeResult = TokenBalanceService.consumeReserved(
  newBalance,
  Quantity.of(new Decimal(30))
);

if (consumeResult.ok) {
  const finalBalance = consumeResult.value;
  console.log(finalBalance.available().value().toNumber()); // 70 (не изменился)
  console.log(finalBalance.reserved().value().toNumber());  // 20 (30 списано)
  console.log(finalBalance.total().value().toNumber());     // 90 (уменьшился на 30)
}
```

**Разница между unfreezeReserved и consumeReserved:**

```typescript
const balance = expectOk(TokenBalanceService.create(
  token,
  Quantity.of(new Decimal(100)),
  Quantity.of(new Decimal(50)),
  accountId,
  venueId
));
// total: 150

// Вариант 1: Размораживание (отмена)
const unfrozen = expectOk(TokenBalanceService.unfreezeReserved(
  balance,
  Quantity.of(new Decimal(30))
));
// available: 130 (+30), reserved: 20 (-30), total: 150 (без изменений)

// Вариант 2: Списание (исполнение)
const consumed = expectOk(TokenBalanceService.consumeReserved(
  balance,
  Quantity.of(new Decimal(30))
));
// available: 100 (без изменений), reserved: 20 (-30), total: 120 (-30)
```

### Синхронизация с blockchain

```typescript
// Получили обновление баланса из blockchain: 150 токенов
const newAvailable = Quantity.of(new Decimal(150));

const updatedBalance = expectOk(
  TokenBalanceService.updateAvailable(balance, newAvailable)
);

console.log(updatedBalance.available().value().toNumber()); // 150
console.log(updatedBalance.reserved().value().toNumber());  // 20 (без изменений)
```

---

## Сериализация

### JSON туда-обратно

```typescript
import { TokenBalanceSerializer } from '@polymarket/value-objects/token-balance';

const balance = expectOk(TokenBalanceService.create(
  token,
  Quantity.of(new Decimal(100)),
  Quantity.of(new Decimal(20)),
  accountId,
  venueId
));

// Сериализация
const json = TokenBalanceSerializer.toJSON(balance);
console.log(json);
// {
//   token: {
//     conditionRef: {
//       kind: 'ONCHAIN',
//       protocolId: 'POLYMARKET_CTF',
//       chainId: 137,
//       conditionId: '0xabc...'
//     },
//     outcomeKey: 'UP'
//   },
//   available: "100",
//   reserved: "20",
//   accountId: "wallet:0x1234567890123456789012345678901234567890",
//   venueId: "POLYMARKET"
// }

// Десериализация
const deserializedResult = TokenBalanceSerializer.fromJSON(json);
if (deserializedResult.ok) {
  const deserializedBalance = deserializedResult.value;
  console.log(TokenBalanceService.equals(deserializedBalance, balance)); // true
}
```

### API ответ

```typescript
// Получение баланса токенов с API
async function fetchTokenBalance(userId: string, tokenId: string): Promise<TokenBalance | null> {
  const response = await fetch(`/api/users/${userId}/tokens/${tokenId}/balance`);
  const json = await response.json();

  const result = TokenBalanceSerializer.fromJSON(json);
  if (isErr(result)) {
    console.error('Ошибка десериализации:', result.error.message);
    return null;
  }

  return result.value;
}
```

---

## Форматирование для UI

### Полная сводка

```typescript
import { TokenBalanceFormatter } from '@polymarket/value-objects/token-balance';

const balance = expectOk(TokenBalanceService.create(
  token,
  Quantity.of(new Decimal(100)),
  Quantity.of(new Decimal(20)),
  accountId,
  venueId
));

// Полная сводка
console.log(TokenBalanceFormatter.toSummary(balance));
// "Available: 100, Reserved: 20, Total: 120 (16.67% reserved) [UP]"

console.log(TokenBalanceFormatter.toSummary(balance, 0));
// "Available: 100, Reserved: 20, Total: 120 (17% reserved) [UP]"
```

### Компактный формат

```typescript
console.log(TokenBalanceFormatter.toCompact(balance));
// "Avail: 100.0 | Res: 20.0 | Total: 120.0"

// Большие количества
const bigBalance = expectOk(TokenBalanceService.create(
  token,
  Quantity.of(new Decimal(1500000)),
  Quantity.of(new Decimal(500000)),
  accountId,
  venueId
));
console.log(TokenBalanceFormatter.toCompact(bigBalance));
// "Avail: 1500000.0 | Res: 500000.0 | Total: 2000000.0"
```

### Отдельные компоненты

```typescript
// Available (default: 2 decimals)
console.log(TokenBalanceFormatter.toAvailableString(balance)); // "100.00"
console.log(TokenBalanceFormatter.toAvailableString(balance, 0)); // "100"

// Reserved (default: 2 decimals)
console.log(TokenBalanceFormatter.toReservedString(balance)); // "20.00"

// Total (default: 2 decimals)
console.log(TokenBalanceFormatter.toTotalString(balance)); // "120.00"

// Процент резервирования (default: 2 decimals)
console.log(TokenBalanceFormatter.toPercentageString(balance)); // "16.67%"
console.log(TokenBalanceFormatter.toPercentageString(balance, 0)); // "17%"
```

### Debug-вывод

```typescript
console.log(TokenBalanceFormatter.toDebugString(balance));
// "TokenBalance(available: 100, reserved: 20, total: 120, token: UP, account: wallet:0x..., venue: POLYMARKET)"
```

---

## Обработка ошибок

### Exhaustive error handling

```typescript
function handleTokenBalanceOperation(
  balance: TokenBalance,
  operation: 'reserve' | 'unfreezeReserved' | 'consumeReserved',
  qty: Quantity
): TokenBalance | null {
  let result: Result<TokenBalance, InvalidTokenBalanceError>;

  switch (operation) {
    case 'reserve':
      result = TokenBalanceService.reserve(balance, qty);
      break;
    case 'unfreezeReserved':
      result = TokenBalanceService.unfreezeReserved(balance, qty);
      break;
    case 'consumeReserved':
      result = TokenBalanceService.consumeReserved(balance, qty);
      break;
  }

  if (isErr(result)) {
    const { reason, op } = result.error.context || {};

    switch (reason) {
      case TokenBalanceErrorReason.INSUFFICIENT_AVAILABLE:
        console.error(`Недостаточно available для ${op}`);
        break;
      case TokenBalanceErrorReason.INSUFFICIENT_RESERVED:
        console.error(`Недостаточно reserved для ${op}`);
        break;
      case TokenBalanceErrorReason.INVALID_FORMAT:
        console.error(`Невалидный формат количества в ${op}`);
        break;
      default:
        console.error(`Неожиданная ошибка: ${result.error.message}`);
    }

    return null;
  }

  return result.value;
}
```

### Восстановление после ошибки

```typescript
// Попытка зарезервировать с fallback
function reserveWithFallback(
  balance: TokenBalance,
  preferredQty: Quantity,
  minimumQty: Quantity
): Result<TokenBalance, InvalidTokenBalanceError> {
  // Пробуем preferred
  const preferredResult = TokenBalanceService.reserve(balance, preferredQty);
  if (preferredResult.ok) {
    return preferredResult;
  }

  // Если не хватает токенов, пробуем minimum
  if (preferredResult.error.context?.reason === TokenBalanceErrorReason.INSUFFICIENT_AVAILABLE) {
    console.log('Не хватает токенов, пробуем минимум');
    return TokenBalanceService.reserve(balance, minimumQty);
  }

  // Другие ошибки не обрабатываем
  return preferredResult;
}
```

---

## Проверки перед операциями

### Проверка возможности резервирования

```typescript
// Проверка достаточности токенов
const canReserve = TokenBalanceService.canReserve(
  balance,
  Quantity.of(new Decimal(30))
);

if (canReserve) {
  const result = TokenBalanceService.reserve(balance, Quantity.of(new Decimal(30)));
  // ...
} else {
  console.log('Невозможно зарезервировать токены');
}
```

### Проверка возможности освобождения

```typescript
function canRelease(balance: TokenBalance, qty: Quantity): boolean {
  return qty.value().lte(balance.reserved().value());
}
```

---

## Helpers

### Создание баланса без резерва

```typescript
const balanceWithoutReserved = expectOk(TokenBalanceService.createWithZeroReserved(
  token,
  Quantity.of(new Decimal(100)),
  accountId,
  venueId
));

console.log(balanceWithoutReserved.available().value().toNumber()); // 100
console.log(balanceWithoutReserved.reserved().value().toNumber());  // 0
console.log(balanceWithoutReserved.hasReserved()); // false
```

---

## Lifecycle: Полный сценарий ордера

### Создание → Частичное исполнение → Отмена остатка

```typescript
// 1. Начальный баланс: 100 токенов UP
const initialBalance = expectOk(TokenBalanceService.create(
  token,
  Quantity.of(new Decimal(100)),
  Quantity.ZERO,
  accountId,
  venueId
));

// 2. Создаём ордер на продажу 40 токенов → резервируем
const afterReserve = expectOk(TokenBalanceService.reserve(
  initialBalance,
  Quantity.of(new Decimal(40))
));
// available: 60, reserved: 40, total: 100

// 3. Частичное исполнение: продано 30 токенов → списываем
const afterPartialFill = expectOk(TokenBalanceService.consumeReserved(
  afterReserve,
  Quantity.of(new Decimal(30))
));
// available: 60, reserved: 10, total: 70

// 4. Отмена остатка: 10 токенов → размораживаем
const afterCancel = expectOk(TokenBalanceService.unfreezeReserved(
  afterPartialFill,
  Quantity.of(new Decimal(10))
));
// available: 70, reserved: 0, total: 70

console.log('Итоговый баланс:', afterCancel.total().value().toNumber()); // 70
console.log('Продано токенов:', 100 - 70); // 30
```

### Множественные ордера

```typescript
let currentBalance = expectOk(TokenBalanceService.create(
  token,
  Quantity.of(new Decimal(1000)),
  Quantity.ZERO,
  accountId,
  venueId
));

// Ордер 1: резервируем 200
currentBalance = expectOk(TokenBalanceService.reserve(
  currentBalance,
  Quantity.of(new Decimal(200))
));
// available: 800, reserved: 200

// Ордер 2: резервируем ещё 300
currentBalance = expectOk(TokenBalanceService.reserve(
  currentBalance,
  Quantity.of(new Decimal(300))
));
// available: 500, reserved: 500

// Ордер 1 исполнен: списываем 200
currentBalance = expectOk(TokenBalanceService.consumeReserved(
  currentBalance,
  Quantity.of(new Decimal(200))
));
// available: 500, reserved: 300, total: 800

// Ордер 2 отменён: размораживаем 300
currentBalance = expectOk(TokenBalanceService.unfreezeReserved(
  currentBalance,
  Quantity.of(new Decimal(300))
));
// available: 800, reserved: 0, total: 800

console.log('Финальный баланс:', currentBalance.total().value().toNumber()); // 800
```

---

## Интеграция с React

### Компонент баланса токенов

```typescript
import { TokenBalance, TokenBalanceFormatter } from '@polymarket/value-objects/token-balance';

interface TokenBalanceDisplayProps {
  balance: TokenBalance;
}

function TokenBalanceDisplay({ balance }: TokenBalanceDisplayProps) {
  return (
    <div className="token-balance-display">
      <div className="balance-summary">
        {TokenBalanceFormatter.toSummary(balance)}
      </div>
      <div className="balance-breakdown">
        <div>Available: {TokenBalanceFormatter.toAvailableString(balance)}</div>
        <div>Reserved: {TokenBalanceFormatter.toReservedString(balance)}</div>
        <div>Total: {TokenBalanceFormatter.toTotalString(balance)}</div>
        <div>Token: {balance.outcomeKey()}</div>
      </div>
      {balance.hasReserved() && (
        <div className="reserved-percentage">
          Reserved: {TokenBalanceFormatter.toPercentageString(balance)}
        </div>
      )}
    </div>
  );
}
```

### Хук для управления балансом

```typescript
import { useState } from 'react';
import { TokenBalance, TokenBalanceService } from '@polymarket/value-objects/token-balance';
import { Quantity } from '@polymarket/value-objects/quantity';
import Decimal from 'decimal.js';

function useTokenBalance(initialBalance: TokenBalance) {
  const [balance, setBalance] = useState(initialBalance);

  const reserve = (qty: Quantity) => {
    const result = TokenBalanceService.reserve(balance, qty);
    if (result.ok) {
      setBalance(result.value);
      return true;
    }
    return false;
  };

  const unfreezeReserved = (qty: Quantity) => {
    const result = TokenBalanceService.unfreezeReserved(balance, qty);
    if (result.ok) {
      setBalance(result.value);
      return true;
    }
    return false;
  };

  const consumeReserved = (qty: Quantity) => {
    const result = TokenBalanceService.consumeReserved(balance, qty);
    if (result.ok) {
      setBalance(result.value);
      return true;
    }
    return false;
  };

  const canReserve = (qty: Quantity) => {
    return TokenBalanceService.canReserve(balance, qty);
  };

  return {
    balance,
    reserve,
    unfreezeReserved,
    consumeReserved,
    canReserve
  };
}
```
