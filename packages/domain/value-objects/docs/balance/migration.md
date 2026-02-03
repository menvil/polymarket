# Миграция на Balance Value Object

Руководство по переходу с plain objects на иммутабельный Balance.

## Было (plain object)

```typescript
// Старый подход
interface BalanceData {
  available: number;
  reserved: number;
  currency: string;
}

// Мутабельные операции
function reserveFunds(balance: BalanceData, amount: number): void {
  if (balance.available < amount) {
    throw new Error('Insufficient funds');
  }
  balance.available -= amount; // мутация!
  balance.reserved += amount;   // мутация!
}

// Использование
const balance: BalanceData = { available: 10000, reserved: 2000, currency: 'USDC' };
reserveFunds(balance, 3000);
console.log(balance.available); // 7000 (объект изменился!)
```

## Стало (Balance value object)

```typescript
import { Balance, BalanceService } from '@polymarket/value-objects/balance';
import { Money } from '@polymarket/value-objects/money';

// Создание через Facade
const balanceResult = BalanceService.create(
  Money.of(10000),
  Money.of(2000)
);

if (!balanceResult.ok) {
  console.error(balanceResult.error.message);
  return;
}

const balance = balanceResult.value;

// Иммутабельная операция
const reserveResult = BalanceService.reserve(balance, Money.of(3000));

if (!reserveResult.ok) {
  if (reserveResult.error.context?.reason === BalanceErrorReason.INSUFFICIENT_FUNDS) {
    console.log('Недостаточно средств');
  }
  return;
}

const newBalance = reserveResult.value;

// Оригинальный balance не изменился!
console.log(balance.available().value());    // 10000
console.log(newBalance.available().value()); // 7000
```

---

## Чеклист миграции

### 1. ✅ Замените plain objects на Balance

**Было:**

```typescript
interface BalanceData {
  available: number;
  reserved: number;
  currency: string;
}

const balance: BalanceData = { available: 10000, reserved: 2000, currency: 'USDC' };
```

**Стало:**

```typescript
import { Balance, BalanceService } from '@polymarket/value-objects/balance';
import { Money } from '@polymarket/value-objects/money';

const balance = expectOk(BalanceService.create(
  Money.of(10000),
  Money.of(2000)
));
```

---

### 2. ✅ Замените мутабельные функции на иммутабельные

**Было:**

```typescript
function reserveFunds(balance: BalanceData, amount: number): void {
  balance.available -= amount;
  balance.reserved += amount;
}

// Использование
reserveFunds(balance, 3000);
```

**Стало:**

```typescript
import { BalanceService } from '@polymarket/value-objects/balance';

const newBalance = expectOk(BalanceService.reserve(balance, Money.of(3000)));

// balance не изменился, newBalance — новый объект
```

---

### 3. ✅ Обработка ошибок через Result

**Было:**

```typescript
function reserveFunds(balance: BalanceData, amount: number): void {
  if (balance.available < amount) {
    throw new Error('Insufficient funds'); // throw
  }
  balance.available -= amount;
  balance.reserved += amount;
}

// Использование с try-catch
try {
  reserveFunds(balance, 15000);
} catch (error) {
  console.error(error.message); // строка, не типизировано
}
```

**Стало:**

```typescript
const result = BalanceService.reserve(balance, Money.of(15000));

if (!result.ok) {
  // Типизированная проверка ошибок
  switch (result.error.context?.reason) {
    case BalanceErrorReason.INSUFFICIENT_FUNDS:
      console.log('Недостаточно средств');
      break;
    case BalanceErrorReason.CURRENCY_MISMATCH:
      console.log('Несовпадение валют');
      break;
  }
  return;
}

const newBalance = result.value;
```

---

### 4. ✅ Используйте Query методы вместо прямого доступа

**Было:**

```typescript
const total = balance.available + balance.reserved;
const reservedPercent = (balance.reserved / total) * 100;
const canAfford = balance.available >= requestedAmount;
```

**Стало:**

```typescript
const total = balance.total().value();
const reservedPercent = balance.reservedPercentage();
const canAfford = balance.canAfford(Money.of(requestedAmount));
```

---

### 5. ✅ Сериализация через Adapters

**Было:**

```typescript
// JSON.stringify напрямую
const json = JSON.stringify(balance);

// JSON.parse + ручная валидация
const parsed = JSON.parse(json);
if (typeof parsed.available !== 'number') {
  throw new Error('Invalid balance');
}
```

**Стало:**

```typescript
import { BalanceSerializer } from '@polymarket/value-objects/balance';

// Сериализация
const json = BalanceSerializer.toJSON(balance);

// Десериализация с валидацией
const result = BalanceSerializer.fromJSON(json);
if (!result.ok) {
  console.error(result.error.message);
  return;
}
const deserializedBalance = result.value;
```

---

### 6. ✅ Форматирование через Adapters

**Было:**

```typescript
const formatted = `Available: $${(balance.available / 100).toFixed(2)}, Reserved: $${(balance.reserved / 100).toFixed(2)}`;
```

**Стало:**

```typescript
import { BalanceFormatter } from '@polymarket/value-objects/balance';

const formatted = BalanceFormatter.toSummary(balance);
// "Available: $100.00, Reserved: $20.00, Total: $120.00 (16.67% reserved)"
```

---

## Частые проблемы миграции

### Проблема 1: Мутация баланса

**❌ Неправильно:**

```typescript
let balance = expectOk(BalanceService.create(Money.of(10000), Money.of(2000)));

// Попытка переиспользовать переменную
balance = expectOk(BalanceService.reserve(balance, Money.of(3000)));
balance = expectOk(BalanceService.reserve(balance, Money.of(2000)));
```

**✅ Правильно:**

```typescript
const balance1 = expectOk(BalanceService.create(Money.of(10000), Money.of(2000)));
const balance2 = expectOk(BalanceService.reserve(balance1, Money.of(3000)));
const balance3 = expectOk(BalanceService.reserve(balance2, Money.of(2000)));

// Или используйте chain операций
const finalBalance = pipe(
  BalanceService.create(Money.of(10000), Money.of(2000)),
  (result) => result.ok ? BalanceService.reserve(result.value, Money.of(3000)) : result,
  (result) => result.ok ? BalanceService.reserve(result.value, Money.of(2000)) : result
);
```

---

### Проблема 2: Игнорирование Result

**❌ Неправильно:**

```typescript
const balance = BalanceService.create(Money.of(10000), Money.of(2000)).value; // может упасть!
```

**✅ Правильно:**

```typescript
const result = BalanceService.create(Money.of(10000), Money.of(2000));
if (!result.ok) {
  console.error(result.error.message);
  return;
}
const balance = result.value;

// Или используйте helper
import { expectOk } from '@polymarket/result';
const balance = expectOk(BalanceService.create(Money.of(10000), Money.of(2000)));
```

---

### Проблема 3: Работа с number вместо Money

**❌ Неправильно:**

```typescript
// Попытка использовать number
const result = BalanceService.reserve(balance, 3000); // Type Error!
```

**✅ Правильно:**

```typescript
import { Money } from '@polymarket/value-objects/money';

const result = BalanceService.reserve(balance, Money.of(3000));
```

---

### Проблема 4: Обращение к внутренним полям

**❌ Неправильно:**

```typescript
// Попытка прямого доступа
console.log(balance.avail); // undefined! Поле private
```

**✅ Правильно:**

```typescript
// Используйте Query методы
console.log(balance.available().value());
console.log(balance.reserved().value());
console.log(balance.total().value());
```

---

## Пример полной миграции

### До миграции

```typescript
// types.ts
interface BalanceData {
  available: number;
  reserved: number;
  currency: string;
}

// balance.ts
export function createBalance(available: number, reserved: number): BalanceData {
  if (available < 0 || reserved < 0) {
    throw new Error('Negative amounts not allowed');
  }
  return { available, reserved, currency: 'USDC' };
}

export function reserveFunds(balance: BalanceData, amount: number): void {
  if (balance.available < amount) {
    throw new Error('Insufficient funds');
  }
  balance.available -= amount;
  balance.reserved += amount;
}

export function getTotalBalance(balance: BalanceData): number {
  return balance.available + balance.reserved;
}

// usage.ts
const balance = createBalance(10000, 2000);
console.log(`Total: ${getTotalBalance(balance)}`);

try {
  reserveFunds(balance, 3000);
  console.log(`Available: ${balance.available}`);
} catch (error) {
  console.error(error.message);
}
```

### После миграции

```typescript
// usage.ts
import { Balance, BalanceService, BalanceFormatter } from '@polymarket/value-objects/balance';
import { Money } from '@polymarket/value-objects/money';

const balanceResult = BalanceService.create(Money.of(10000), Money.of(2000));

if (!balanceResult.ok) {
  console.error(balanceResult.error.message);
  return;
}

const balance = balanceResult.value;
console.log(`Total: ${balance.total().value()}`);

const reserveResult = BalanceService.reserve(balance, Money.of(3000));

if (!reserveResult.ok) {
  if (reserveResult.error.context?.reason === BalanceErrorReason.INSUFFICIENT_FUNDS) {
    console.error('Недостаточно средств');
  }
  return;
}

const newBalance = reserveResult.value;
console.log(`Available: ${newBalance.available().value()}`);
```

---

## Преимущества после миграции

1. ✅ **Иммутабельность** — баланс не может быть случайно изменён
2. ✅ **Type Safety** — типизированные ошибки через enum
3. ✅ **Композиция** — переиспользование Money для работы с суммами
4. ✅ **Валидация** — автоматическая проверка инвариантов
5. ✅ **Тестируемость** — легко писать тесты для иммутабельных объектов
6. ✅ **Безопасность** — Never Throw контракт через Result
