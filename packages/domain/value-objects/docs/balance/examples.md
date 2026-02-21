# Примеры использования Balance

## Базовые операции

### Создание баланса

```typescript
import { BalanceService, BalanceErrorReason } from '@polymarket/value-objects/balance';
import { Money, MoneyService } from '@polymarket/value-objects/money';
import { isErr, expectOk } from '@polymarket/result';
import type { AccountId, VenueId, WalletAddress } from '@polymarket/ids';
import Decimal from 'decimal.js';

// Подготовка идентификаторов
const accountId: AccountId = {
  kind: 'WALLET',
  address: '0x1234567890123456789012345678901234567890' as WalletAddress
};
const venueId: VenueId = 'POLYMARKET' as VenueId;

const result = BalanceService.create(
  Money.of(new Decimal(10000)), // 10000 units available
  Money.of(new Decimal(2000)),  // 2000 units reserved
  accountId,       // ID аккаунта владельца
  venueId          // ID площадки (venue)
);

if (isErr(result)) {
  console.error('Ошибка создания:', result.error.message);
  return;
}

const balance = result.value;
```

### Query методы

```typescript
// Общий баланс
console.log(balance.total().value().toNumber()); // 12000

// Процент резервирования
console.log(balance.reservedPercentage()); // 16.67

// Проверка пустоты
console.log(balance.isZero()); // false
console.log(balance.hasReserved()); // true
```

---

## Торговые сценарии

### Открытие ордера (резервирование)

```typescript
import type { AccountId, VenueId, WalletAddress } from '@polymarket/ids';

const accountId: AccountId = {
  kind: 'WALLET',
  address: '0x1234567890123456789012345678901234567890' as WalletAddress
};
const venueId: VenueId = 'POLYMARKET' as VenueId;

// У пользователя $100 available, $20 reserved
const balance = expectOk(BalanceService.create(Money.of(new Decimal(10000)), Money.of(new Decimal(2000)), accountId, venueId));

// Открываем ордер на покупку за $30
const orderAmount = Money.of(new Decimal(3000));

// Резервируем средства
const reserveResult = BalanceService.reserve(balance, orderAmount);

if (!reserveResult.ok) {
  if (reserveResult.error.context?.reason === BalanceErrorReason.INSUFFICIENT_FUNDS) {
    console.log('Недостаточно средств для открытия ордера');
  }
  return;
}

const newBalance = reserveResult.value;
console.log(newBalance.available().value()); // 7000 ($70)
console.log(newBalance.reserved().value());  // 5000 ($50)
```

### Отмена ордера (размораживание средств)

```typescript
// Ордер отменён, возвращаем $30 в available
const unfreezeResult = BalanceService.unfreezeReserved(newBalance, Money.of(new Decimal(3000)));

if (unfreezeResult.ok) {
  const finalBalance = unfreezeResult.value;
  console.log(finalBalance.available().value()); // 10000 (вернулись средства)
  console.log(finalBalance.reserved().value());  // 2000
  console.log(finalBalance.total().value());     // 12000 (total не изменился)
}
```

### Исполнение ордера (списание средств)

```typescript
// Ордер исполнился, списываем $30 из reserved
const consumeResult = BalanceService.consumeReserved(newBalance, Money.of(new Decimal(3000)));

if (consumeResult.ok) {
  const finalBalance = consumeResult.value;
  console.log(finalBalance.available().value()); // 7000 (не изменился)
  console.log(finalBalance.reserved().value());  // 2000 (3000 списано)
  console.log(finalBalance.total().value());     // 9000 (уменьшился на 3000)
}
```

**Разница между unfreezeReserved и consumeReserved:**

```typescript
const accountId: AccountId = {
  kind: 'WALLET',
  address: '0x1234567890123456789012345678901234567890' as WalletAddress
};
const venueId: VenueId = 'POLYMARKET' as VenueId;

const balance = expectOk(BalanceService.create(Money.of(new Decimal(10000)), Money.of(new Decimal(5000)), accountId, venueId));
// total: 15000

// Вариант 1: Размораживание (отмена)
const unfrozen = expectOk(BalanceService.unfreezeReserved(balance, Money.of(new Decimal(3000))));
// available: 13000 (+3000), reserved: 2000 (-3000), total: 15000 (без изменений)

// Вариант 2: Списание (исполнение)
const consumed = expectOk(BalanceService.consumeReserved(balance, Money.of(new Decimal(3000))));
// available: 10000 (без изменений), reserved: 2000 (-3000), total: 12000 (-3000)
```

### Пополнение баланса

```typescript
// Пользователь вносит депозит $50
const depositAmount = Money.of(new Decimal(5000));

const newAvailable = expectOk(
  MoneyService.add(balance.available(), depositAmount)
);

const updatedBalance = expectOk(
  BalanceService.updateAvailable(balance, newAvailable)
);

console.log(updatedBalance.available().value()); // 15000 ($150)
console.log(updatedBalance.reserved().value());  // 2000 ($20, без изменений)
```

---

## Сериализация

### JSON туда-обратно

```typescript
import { BalanceSerializer } from '@polymarket/value-objects/balance';
import type { AccountId, VenueId, WalletAddress } from '@polymarket/ids';

const accountId: AccountId = {
  kind: 'WALLET',
  address: '0x1234567890123456789012345678901234567890' as WalletAddress
};
const venueId: VenueId = 'POLYMARKET' as VenueId;

const balance = expectOk(BalanceService.create(Money.of(new Decimal(10000)), Money.of(new Decimal(2000)), accountId, venueId));

// Сериализация
const json = BalanceSerializer.toJSON(balance);
console.log(json);
// {
//   available: { amount: "10000", currency: "USDC" },
//   reserved: { amount: "2000", currency: "USDC" },
//   accountId: "wallet:0x1234567890123456789012345678901234567890",
//   venueId: "POLYMARKET"
// }

// Десериализация
const deserializedResult = BalanceSerializer.fromJSON(json);
if (deserializedResult.ok) {
  const deserializedBalance = deserializedResult.value;
  const equalsResult = BalanceService.equals(deserializedBalance, balance);
  console.log(equalsResult.ok && equalsResult.value); // true
}
```

### API ответ

```typescript
import { Balance } from '@polymarket/value-objects/balance';

// Получение баланса с API
async function fetchUserBalance(userId: string): Promise<Balance | null> {
  const response = await fetch(`/api/users/${userId}/balance`);
  const json = await response.json();

  const result = BalanceSerializer.fromJSON(json);
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
import { BalanceFormatter } from '@polymarket/value-objects/balance';
import { expectOk } from '@polymarket/result';

const accountId: AccountId = { kind: 'WALLET', address: '0x...' as WalletAddress };
const venueId: VenueId = 'POLYMARKET' as VenueId;
const balance = expectOk(BalanceService.create(Money.of(new Decimal(10000)), Money.of(new Decimal(2000)), accountId, venueId));

// Полная сводка (возвращает Result<string, InvalidBalanceError>)
const summaryResult = BalanceFormatter.toSummary(balance);
if (summaryResult.ok) {
  console.log(summaryResult.value);
  // "Available: $100.00, Reserved: $20.00, Total: $120.00 (16.67% reserved)"
}

// или с expectOk для краткости (бросает если Err)
console.log(expectOk(BalanceFormatter.toSummary(balance)));
// "Available: $100.00, Reserved: $20.00, Total: $120.00 (16.67% reserved)"

console.log(expectOk(BalanceFormatter.toSummary(balance, 0)));
// "Available: $100, Reserved: $20, Total: $120 (17% reserved)"
```

### Компактный формат

```typescript
const compactResult = BalanceFormatter.toCompact(balance);
if (compactResult.ok) {
  console.log(compactResult.value);
  // "Avail: $100.00 | Res: $20.00 | Total: $120.00"
}

// Большие суммы
const bigBalance = expectOk(BalanceService.create(Money.of(new Decimal(1500000)), Money.of(new Decimal(500000)), accountId, venueId));
const bigCompactResult = BalanceFormatter.toCompact(bigBalance);
if (bigCompactResult.ok) {
  console.log(bigCompactResult.value);
  // "Avail: $1.5K | Res: $0.5K | Total: $2.0K"
}
```

### Отдельные компоненты

```typescript
// Available
const availableResult = BalanceFormatter.toAvailableString(balance);
if (availableResult.ok) {
  console.log(availableResult.value); // "$100.00"
}

const availableNoSymbolResult = BalanceFormatter.toAvailableString(balance, false);
if (availableNoSymbolResult.ok) {
  console.log(availableNoSymbolResult.value); // "100.00"
}

// Reserved
const reservedResult = BalanceFormatter.toReservedString(balance);
if (reservedResult.ok) {
  console.log(reservedResult.value); // "$20.00"
}

// Total
const totalResult = BalanceFormatter.toTotalString(balance);
if (totalResult.ok) {
  console.log(totalResult.value); // "$120.00"
}

// Процент резервирования
const percentageResult = BalanceFormatter.toPercentageString(balance);
if (percentageResult.ok) {
  console.log(percentageResult.value); // "16.67%"
}

const percentageResult0 = BalanceFormatter.toPercentageString(balance, 0);
if (percentageResult0.ok) {
  console.log(percentageResult0.value); // "17%"
}
```

### Debug-вывод

```typescript
console.log(BalanceFormatter.toDebugString(balance));
// "Balance(available: 10000 USDC, reserved: 2000 USDC, total: 12000 USDC)"
```

---

## Обработка ошибок

### Exhaustive error handling

```typescript
import { Result, isErr } from '@polymarket/result';
import { Balance, BalanceService, BalanceErrorReason, InvalidBalanceError } from '@polymarket/value-objects/balance';
import { Money } from '@polymarket/value-objects/money';

function handleBalanceOperation(
  balance: Balance,
  operation: 'reserve' | 'unfreezeReserved' | 'consumeReserved',
  amount: Money
): Balance | null {
  let result: Result<Balance, InvalidBalanceError>;

  switch (operation) {
    case 'reserve':
      result = BalanceService.reserve(balance, amount);
      break;
    case 'unfreezeReserved':
      result = BalanceService.unfreezeReserved(balance, amount);
      break;
    case 'consumeReserved':
      result = BalanceService.consumeReserved(balance, amount);
      break;
  }

  if (isErr(result)) {
    const { reason, op } = result.error.context || {};

    switch (reason) {
      case BalanceErrorReason.INSUFFICIENT_FUNDS:
        console.error(`Недостаточно available для ${op}`);
        break;
      case BalanceErrorReason.INSUFFICIENT_RESERVED:
        console.error(`Недостаточно reserved для ${op}`);
        break;
      case BalanceErrorReason.CURRENCY_MISMATCH:
        console.error(`Несовпадение валют в ${op}`);
        break;
      case BalanceErrorReason.INVALID_FORMAT:
        console.error(`Невалидный формат в ${op}`);
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
  balance: Balance,
  preferredAmount: Money,
  minimumAmount: Money
): Result<Balance, InvalidBalanceError> {
  // Пробуем preferred
  const preferredResult = BalanceService.reserve(balance, preferredAmount);
  if (preferredResult.ok) {
    return preferredResult;
  }

  // Если не хватает средств, пробуем minimum
  if (preferredResult.error.context?.reason === BalanceErrorReason.INSUFFICIENT_FUNDS) {
    console.log('Не хватает средств, пробуем минимум');
    return BalanceService.reserve(balance, minimumAmount);
  }

  // Другие ошибки не обрабатываем
  return preferredResult;
}
```

---

## Проверки перед операциями

### Проверка доступности резервирования

```typescript
function canReserve(balance: Balance, amount: Money): Result<boolean, InvalidBalanceError> {
  // Проверка достаточности средств (включая проверку валюты)
  return BalanceService.canAfford(balance, amount);
}

// Использование
const canReserveResult = canReserve(balance, orderAmount);
if (canReserveResult.ok && canReserveResult.value) {
  const result = BalanceService.reserve(balance, orderAmount);
  // ...
} else {
  console.log('Невозможно зарезервировать средства');
}
```

### Проверка доступности освобождения

```typescript
function canRelease(balance: Balance, amount: Money): boolean {
  if (amount.currency() !== balance.currency()) {
    return false;
  }

  return amount.value().lte(balance.reserved().value());
}
```

---

## Helpers

### Создание пустого баланса

```typescript
// Singleton - всегда один и тот же экземпляр
const emptyBalance = Balance.ZERO.USDC;
console.log(emptyBalance.available().value()); // 0
console.log(emptyBalance.reserved().value());  // 0
console.log(emptyBalance.isZero()); // true

// Проверка singleton
console.log(Balance.ZERO.USDC === Balance.ZERO.USDC); // true
```

### Создание баланса без резерва

```typescript
const accountId: AccountId = { kind: 'WALLET', address: '0x...' as WalletAddress };
const venueId: VenueId = 'POLYMARKET' as VenueId;

const balanceWithoutReserved = Balance.withZeroReserved(Money.of(new Decimal(10000)), accountId, venueId);
console.log(balanceWithoutReserved.available().value()); // 10000
console.log(balanceWithoutReserved.reserved().value());  // 0
console.log(balanceWithoutReserved.hasReserved()); // false
```

---

## Интеграция с React

### Компонент баланса

```typescript
import { Balance, BalanceFormatter } from '@polymarket/value-objects/balance';

interface BalanceDisplayProps {
  balance: Balance;
}

function BalanceDisplay({ balance }: BalanceDisplayProps) {
  // Форматтеры возвращают Result, нужно обработать
  const summaryResult = BalanceFormatter.toSummary(balance);
  const availableResult = BalanceFormatter.toAvailableString(balance);
  const reservedResult = BalanceFormatter.toReservedString(balance);
  const totalResult = BalanceFormatter.toTotalString(balance);
  const percentageResult = BalanceFormatter.toPercentageString(balance);

  return (
    <div className="balance-display">
      <div className="balance-summary">
        {summaryResult.ok ? summaryResult.value : 'Error formatting balance'}
      </div>
      <div className="balance-breakdown">
        <div>Available: {availableResult.ok ? availableResult.value : '-'}</div>
        <div>Reserved: {reservedResult.ok ? reservedResult.value : '-'}</div>
        <div>Total: {totalResult.ok ? totalResult.value : '-'}</div>
      </div>
      {balance.hasReserved() && percentageResult.ok && (
        <div className="reserved-percentage">
          Reserved: {percentageResult.value}
        </div>
      )}
    </div>
  );
}
```
