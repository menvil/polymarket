# Примеры использования Balance

## Базовые операции

### Создание баланса

```typescript
import { BalanceService } from '@polymarket/value-objects/balance';
import { Money } from '@polymarket/value-objects/money';

const result = BalanceService.create(
  Money.of(10000), // $100.00 available
  Money.of(2000)   // $20.00 reserved
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
console.log(balance.isEmpty()); // false
console.log(balance.hasReserved()); // true
```

---

## Торговые сценарии

### Открытие ордера (резервирование)

```typescript
// У пользователя $100 available, $20 reserved
const balance = expectOk(BalanceService.create(Money.of(10000), Money.of(2000)));

// Открываем ордер на покупку за $30
const orderAmount = Money.of(3000);

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

### Закрытие ордера (освобождение)

```typescript
// Ордер закрылся, освобождаем $30
const releaseResult = BalanceService.release(newBalance, Money.of(3000));

if (releaseResult.ok) {
  const finalBalance = releaseResult.value;
  console.log(finalBalance.available().value()); // 10000
  console.log(finalBalance.reserved().value());  // 2000
}
```

### Пополнение баланса

```typescript
// Пользователь вносит депозит $50
const depositAmount = Money.of(5000);

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

const balance = expectOk(BalanceService.create(Money.of(10000), Money.of(2000)));

// Сериализация
const json = BalanceSerializer.toJSON(balance);
console.log(json);
// {
//   available: { amount: "10000", currency: "USDC" },
//   reserved: { amount: "2000", currency: "USDC" }
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

const balance = expectOk(BalanceService.create(Money.of(10000), Money.of(2000)));

// Полная сводка
console.log(BalanceFormatter.toSummary(balance));
// "Available: $100.00, Reserved: $20.00, Total: $120.00 (16.67% reserved)"

console.log(BalanceFormatter.toSummary(balance, 0));
// "Available: $100, Reserved: $20, Total: $120 (17% reserved)"
```

### Компактный формат

```typescript
console.log(BalanceFormatter.toCompact(balance));
// "Avail: $100.00 | Res: $20.00 | Total: $120.00"

// Большие суммы
const bigBalance = expectOk(BalanceService.create(Money.of(1500000), Money.of(500000)));
console.log(BalanceFormatter.toCompact(bigBalance));
// "Avail: $1.5K | Res: $0.5K | Total: $2.0K"
```

### Отдельные компоненты

```typescript
// Available
console.log(BalanceFormatter.toAvailableString(balance)); // "$100.00"
console.log(BalanceFormatter.toAvailableString(balance, false)); // "100.00"

// Reserved
console.log(BalanceFormatter.toReservedString(balance)); // "$20.00"

// Total
console.log(BalanceFormatter.toTotalString(balance)); // "$120.00"

// Процент резервирования
console.log(BalanceFormatter.toPercentageString(balance)); // "16.67%"
console.log(BalanceFormatter.toPercentageString(balance, 0)); // "17%"
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
function handleBalanceOperation(
  balance: Balance,
  operation: 'reserve' | 'release',
  amount: Money
): Balance | null {
  const result = operation === 'reserve'
    ? BalanceService.reserve(balance, amount)
    : BalanceService.release(balance, amount);

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
console.log(emptyBalance.isEmpty()); // true

// Проверка singleton
console.log(Balance.ZERO.USDC === Balance.ZERO.USDC); // true
```

### Создание баланса без резерва

```typescript
const balanceWithoutReserved = Balance.withZeroReserved(Money.of(10000));
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
  return (
    <div className="balance-display">
      <div className="balance-summary">
        {BalanceFormatter.toSummary(balance)}
      </div>
      <div className="balance-breakdown">
        <div>Available: {BalanceFormatter.toAvailableString(balance)}</div>
        <div>Reserved: {BalanceFormatter.toReservedString(balance)}</div>
        <div>Total: {BalanceFormatter.toTotalString(balance)}</div>
      </div>
      {balance.hasReserved() && (
        <div className="reserved-percentage">
          Reserved: {BalanceFormatter.toPercentageString(balance)}
        </div>
      )}
    </div>
  );
}
```
