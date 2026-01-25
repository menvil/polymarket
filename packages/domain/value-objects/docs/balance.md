# Balance Value Object

## Описание

**Balance** — неизменяемый value object для представления баланса пользователя на рынке.

В отличие от **Money** (который используется для любых денежных сумм), **Balance** специфичен для балансов счетов и:
- Всегда неотрицательный (баланс не может быть отрицательным)
- Имеет специализированные методы для проверки достаточности средств
- Используется для представления доступных средств пользователя

## Основные характеристики

- ✅ **Неизменяемость** — все операции возвращают новый экземпляр
- ✅ **Высокая точность** — использует Decimal.js для финансовых расчётов
- ✅ **Безопасность типов** — Result<T, E> для явной обработки ошибок
- ✅ **Валидация** — автоматическая проверка на NaN, Infinity, отрицательные значения
- ✅ **Currency-aware** — операции только с одинаковой валютой

## Создание (Factory Methods)

### fromValue(amount: number | string | Decimal, currency: string)

Универсальный метод для создания Balance из различных типов значений.

**Параметры:**
- `amount` — сумма баланса (number, string или Decimal)
- `currency` — валюта (string, например 'USDC')

**Возвращает:**
- `Result<Balance, InvalidMoneyError>`

**Поддерживаемые типы amount:**
- `number` — обычное число (1000, 0.5, 1000.50)
- `string` — строковое представление числа ("1000.50", "0.1")
- `Decimal` — объект Decimal.js для высокой точности

**Валидация:**
- ❌ Отклоняет NaN
- ❌ Отклоняет Infinity/-Infinity
- ❌ Отклоняет отрицательные значения
- ❌ Отклоняет пустую валюту
- ❌ Отклоняет невалидные строки

**Примеры:**

```typescript
import { Balance } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';
import Decimal from 'decimal.js';

// ✅ Создание из числа
const balance1 = unwrap(Balance.fromValue(1000, 'USDC'));
console.log(balance1.getAmount()); // 1000

// ✅ Создание из строки
const balance2 = unwrap(Balance.fromValue('1000.50', 'USDC'));
console.log(balance2.getAmount()); // 1000.5

// ✅ Создание из Decimal (высокая точность)
const balance3 = unwrap(Balance.fromValue(new Decimal('1000.50'), 'USDC'));
console.log(balance3.toDecimal().toString()); // "1000.5"

// ✅ Нулевой баланс
const empty = unwrap(Balance.fromValue(0, 'USDC'));
console.log(empty.getAmount()); // 0

// ❌ Отклоняет отрицательные
const negative = Balance.fromValue(-100, 'USDC');
if (!negative.ok) {
  console.error(negative.error.message);
  // "Balance cannot be negative: -100 USDC"
}

// ❌ Отклоняет NaN
const invalid = Balance.fromValue(NaN, 'USDC');
if (!invalid.ok) {
  console.error(invalid.error.message);
  // "Balance amount must be finite"
}

// ❌ Отклоняет пустую валюту
const noCurrency = Balance.fromValue(100, '');
if (!noCurrency.ok) {
  console.error(noCurrency.error.message);
  // "Currency must be a non-empty string"
}

// ❌ Отклоняет невалидные строки
const invalidString = Balance.fromValue('not-a-number', 'USDC');
if (!invalidString.ok) {
  console.error(invalidString.error.message);
  // "Invalid balance format: \"not-a-number\""
}
```

## Доступ к данным (Getters)

### getAmount(): number

Получить сумму баланса как number.

**Возвращает:** `number`

**⚠️ Важно:** Для высокоточных вычислений используйте `toDecimal()`.

```typescript
const balance = unwrap(Balance.fromValue(1000.50, 'USDC'));
console.log(balance.getAmount()); // 1000.5
```

### getCurrency(): string

Получить валюту баланса.

**Возвращает:** `string`

```typescript
const balance = unwrap(Balance.fromValue(1000, 'USDC'));
console.log(balance.getCurrency()); // "USDC"
```

### toDecimal(): Decimal

Получить сумму как Decimal для высокоточных вычислений.

**Возвращает:** `Decimal`

```typescript
const balance = unwrap(Balance.fromValue(1000.5, 'USDC'));
const decimal = balance.toDecimal();

console.log(decimal.toString()); // "1000.5"
console.log(decimal.toFixed(2)); // "1000.50"
```

## Проверка достаточности средств

### hasEnough(required: number | Decimal): boolean

Проверить, достаточно ли средств на балансе.

**Параметры:**
- `required` — требуемая сумма (number или Decimal)

**Возвращает:** `boolean` — true если баланс >= required

**Примеры:**

```typescript
const balance = unwrap(Balance.fromValue(1000, 'USDC'));

// ✅ Достаточно средств
console.log(balance.hasEnough(500));   // true
console.log(balance.hasEnough(1000));  // true (равно)

// ❌ Недостаточно средств
console.log(balance.hasEnough(1500));  // false

// С Decimal
console.log(balance.hasEnough(new Decimal('999.99'))); // true
```

#### Use case: Проверка перед выполнением ордера

```typescript
function placeOrder(
  balance: Balance,
  orderSize: number,
  fee: number
): void {
  const totalRequired = orderSize + fee;

  if (!balance.hasEnough(totalRequired)) {
    throw new Error(`Insufficient balance: need ${totalRequired}, have ${balance.getAmount()}`);
  }

  // Выполнить ордер
  console.log('Order placed successfully');
}

const myBalance = unwrap(Balance.fromValue(1000, 'USDC'));
placeOrder(myBalance, 900, 10); // ✅ OK: 1000 >= 910
```

## Математические операции

### add(other: Balance): Result<Balance, CurrencyMismatchError>

Добавить к балансу другой баланс.

**Параметры:**
- `other` — другой баланс для добавления

**Возвращает:**
- `Result<Balance, CurrencyMismatchError>`

**Валидация:**
- ❌ Отклоняет операции с разными валютами

**Примеры:**

```typescript
const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
const b2 = unwrap(Balance.fromValue(500, 'USDC'));

// ✅ Сложение с той же валютой
const sum = unwrap(b1.add(b2));
console.log(sum.getAmount()); // 1500

// ❌ Разные валюты
const btc = unwrap(Balance.fromValue(0.1, 'BTC'));
const result = b1.add(btc);

if (!result.ok) {
  console.error(result.error.message);
  // "Cannot add BTC to USDC"
}
```

#### Use case: Пополнение баланса

```typescript
function deposit(
  currentBalance: Balance,
  depositAmount: number
): Result<Balance, InvalidMoneyError | CurrencyMismatchError> {
  const currency = currentBalance.getCurrency();

  // Создаем Balance для депозита
  const depositBalance = Balance.fromValue(depositAmount, currency);
  if (!depositBalance.ok) {
    return depositBalance;
  }

  // Добавляем к текущему балансу
  return currentBalance.add(depositBalance.value);
}

const balance = unwrap(Balance.fromValue(1000, 'USDC'));
const newBalance = unwrap(deposit(balance, 500));
console.log(newBalance.getAmount()); // 1500
```

### subtract(other: Balance): Result<Balance, CurrencyMismatchError | InvalidMoneyError>

Вычесть из баланса другой баланс.

**Параметры:**
- `other` — баланс для вычитания

**Возвращает:**
- `Result<Balance, CurrencyMismatchError | InvalidMoneyError>`

**Валидация:**
- ❌ Отклоняет операции с разными валютами
- ❌ Отклоняет операции, приводящие к отрицательному балансу

**Примеры:**

```typescript
const balance = unwrap(Balance.fromValue(1000, 'USDC'));
const amount = unwrap(Balance.fromValue(300, 'USDC'));

// ✅ Вычитание
const result = unwrap(balance.subtract(amount));
console.log(result.getAmount()); // 700

// ❌ Результат отрицательный (insufficient balance)
const large = unwrap(Balance.fromValue(1500, 'USDC'));
const insufficient = balance.subtract(large);

if (!insufficient.ok) {
  console.error(insufficient.error.message);
  // "Insufficient balance: 1000 - 1500 = -500"
  console.log(insufficient.error.context);
  // { available: 1000, required: 1500, result: -500, currency: 'USDC' }
}
```

#### Use case: Списание средств при выполнении ордера

```typescript
import { Balance } from '@polymarket/value-objects';
import { unwrap, Err, Result } from '@polymarket/result';
import { InvalidMoneyError, CurrencyMismatchError } from '@polymarket/errors';

function executeOrder(
  balance: Balance,
  orderCost: number
): Result<Balance, InvalidMoneyError | CurrencyMismatchError> {
  const currency = balance.getCurrency();

  // Проверяем достаточность средств
  if (!balance.hasEnough(orderCost)) {
    return Err(
      new InvalidMoneyError(
        `Insufficient funds: need ${orderCost}, have ${balance.getAmount()}`
      )
    );
  }

  // Создаем Balance для списания
  const cost = Balance.fromValue(orderCost, currency);
  if (!cost.ok) {
    return cost;
  }

  // Списываем средства
  return balance.subtract(cost.value);
}

const myBalance = unwrap(Balance.fromValue(1000, 'USDC'));
const newBalance = unwrap(executeOrder(myBalance, 300));
console.log(newBalance.getAmount()); // 700
```

## Сравнение

### equals(other: Balance): boolean

Проверить равенство двух балансов.

**Параметры:**
- `other` — другой баланс для сравнения

**Возвращает:** `boolean`

**Примеры:**

```typescript
const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
const b2 = unwrap(Balance.fromValue(1000, 'USDC'));
const b3 = unwrap(Balance.fromValue(500, 'USDC'));

console.log(b1.equals(b2)); // true (одинаковые суммы и валюты)
console.log(b1.equals(b3)); // false (разные суммы)

// Рефлексивность
console.log(b1.equals(b1)); // true

// Разные валюты
const btc = unwrap(Balance.fromValue(1000, 'BTC'));
console.log(b1.equals(btc)); // false (разные валюты)
```

## Преобразования

### toString(): string

Представление баланса в виде строки.

**Возвращает:** `string` в формате "amount currency"

**Примеры:**

```typescript
const balance = unwrap(Balance.fromValue(1000, 'USDC'));
console.log(balance.toString()); // "1000 USDC"

// Сохраняет десятичную точность
const precise = unwrap(Balance.fromValue('1000.50', 'USDC'));
console.log(precise.toString()); // "1000.5 USDC"
```

## Примеры использования

### 1. Управление балансом пользователя

```typescript
import { Balance } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';

class UserAccount {
  private balance: Balance;

  constructor(initialBalance: number, currency: string) {
    this.balance = unwrap(Balance.fromValue(initialBalance, currency));
  }

  getBalance(): Balance {
    return this.balance;
  }

  deposit(amount: number): void {
    const currency = this.balance.getCurrency();
    const depositBalance = unwrap(Balance.fromValue(amount, currency));
    this.balance = unwrap(this.balance.add(depositBalance));

    console.log(`Deposited ${amount} ${currency}`);
    console.log(`New balance: ${this.balance.toString()}`);
  }

  withdraw(amount: number): boolean {
    // Проверяем достаточность средств
    if (!this.balance.hasEnough(amount)) {
      console.error(`Insufficient funds: need ${amount}, have ${this.balance.getAmount()}`);
      return false;
    }

    const currency = this.balance.getCurrency();
    const withdrawBalance = unwrap(Balance.fromValue(amount, currency));

    const result = this.balance.subtract(withdrawBalance);
    if (!result.ok) {
      console.error(`Withdrawal failed: ${result.error.message}`);
      return false;
    }

    this.balance = result.value;
    console.log(`Withdrawn ${amount} ${currency}`);
    console.log(`New balance: ${this.balance.toString()}`);
    return true;
  }

  canAfford(amount: number): boolean {
    return this.balance.hasEnough(amount);
  }
}

// Использование
const account = new UserAccount(1000, 'USDC');
console.log(account.getBalance().toString()); // "1000 USDC"

account.deposit(500);  // "Deposited 500 USDC" → "New balance: 1500 USDC"
account.withdraw(300); // "Withdrawn 300 USDC" → "New balance: 1200 USDC"
account.withdraw(2000); // "Insufficient funds: need 2000, have 1200"

console.log(account.canAfford(1000)); // true
console.log(account.canAfford(1500)); // false
```

### 2. Проверка достаточности для трейдинга

```typescript
import { Balance } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';

interface OrderParams {
  size: number;
  fee: number;
}

function validateTradingBalance(
  balance: Balance,
  order: OrderParams
): { canTrade: boolean; reason?: string } {
  const totalRequired = order.size + order.fee;

  if (!balance.hasEnough(totalRequired)) {
    return {
      canTrade: false,
      reason: `Insufficient balance: need ${totalRequired}, have ${balance.getAmount()}`
    };
  }

  return { canTrade: true };
}

// Использование
const balance = unwrap(Balance.fromValue(1000, 'USDC'));

const order1 = { size: 900, fee: 10 };
const result1 = validateTradingBalance(balance, order1);
console.log(result1); // { canTrade: true }

const order2 = { size: 990, fee: 20 };
const result2 = validateTradingBalance(balance, order2);
console.log(result2);
// { canTrade: false, reason: "Insufficient balance: need 1010, have 1000" }
```

### 3. Проблема точности 0.1 + 0.2 = 0.3

Balance решает классическую проблему floating point:

```typescript
// ❌ Обычный JavaScript
const amount1 = 0.1;
const amount2 = 0.2;
const sum = amount1 + amount2;
console.log(sum); // 0.30000000000000004 ❌

// ✅ С Balance
const b1 = unwrap(Balance.fromValue('0.1', 'USDC'));
const b2 = unwrap(Balance.fromValue('0.2', 'USDC'));
const sumBalance = unwrap(b1.add(b2));

console.log(sumBalance.toDecimal().toString()); // "0.3" ✅
console.log(sumBalance.getAmount()); // 0.3 ✅
```

### 4. Работа с несколькими балансами

```typescript
interface MultiCurrencyWallet {
  usdc: Balance;
  btc: Balance;
}

function createWallet(): MultiCurrencyWallet {
  return {
    usdc: unwrap(Balance.fromValue(1000, 'USDC')),
    btc: unwrap(Balance.fromValue(0.5, 'BTC'))
  };
}

function getTotalInCurrency(
  wallet: MultiCurrencyWallet,
  currency: string
): Balance {
  // В реальном приложении здесь была бы конвертация валют
  // Пока просто возвращаем баланс нужной валюты
  if (currency === 'USDC') {
    return wallet.usdc;
  } else if (currency === 'BTC') {
    return wallet.btc;
  }
  throw new Error(`Unsupported currency: ${currency}`);
}

const wallet = createWallet();
console.log(wallet.usdc.toString()); // "1000 USDC"
console.log(wallet.btc.toString());  // "0.5 BTC"
```

## Ошибки

### InvalidMoneyError

Возникает при:
- Отрицательном балансе
- NaN или Infinity
- Пустой валюте
- Недостаточности средств при subtract

**Контекст ошибки:**

```typescript
{
  amount: number | string,
  currency: string,
  reason?: string,
  available?: number,    // Для insufficient balance
  required?: number,     // Для insufficient balance
  result?: number        // Для insufficient balance
}
```

### CurrencyMismatchError

Возникает при операциях с разными валютами (add, subtract).

**Контекст ошибки:**

```typescript
{
  operation: string,     // "add balance" | "subtract balance"
  expected: string,      // Валюта первого баланса
  actual: string         // Валюта второго баланса
}
```

## Best Practices

### ✅ DO

```typescript
// Всегда проверяйте достаточность средств перед операциями
if (balance.hasEnough(orderCost)) {
  executeOrder(balance, orderCost);
}

// Используйте Result для обработки ошибок
const result = balance.subtract(cost);
result.match({
  ok: (newBalance) => updateBalance(newBalance),
  err: (error) => handleError(error)
});

// Используйте toDecimal() для точных вычислений
const precise = balance.toDecimal().times('1.05').toNumber();

// Проверяйте валюту перед операциями
if (b1.getCurrency() === b2.getCurrency()) {
  const sum = b1.add(b2);
}
```

### ❌ DON'T

```typescript
// Не используйте number для финансовых вычислений
const wrong = balance.getAmount() * 1.05; // ❌ Потеря точности

// Не игнорируйте Result
balance.subtract(cost); // ❌ Не проверяет ошибку

// Не создавайте отрицательные балансы
Balance.fromValue(-100, 'USDC'); // ❌ Ошибка валидации

// Не складывайте балансы разных валют без проверки
balance1.add(balance2); // ❌ Может упасть если разные валюты
```

## Архитектурные решения

### 1. Почему Balance отдельно от Money?

**Money** — универсальный value object для денег:
- Может быть отрицательным (для долгов, PnL)
- Нет специализированных методов для балансов

**Balance** — специализированный для балансов:
- Всегда неотрицательный
- Имеет `hasEnough()` для проверки достаточности
- Семантически правильное название

### 2. Почему нет multiply/divide?

Балансы не умножаются и не делятся:
- Умножение баланса не имеет смысла
- Для расчёта процентов используйте Percentage + Money
- Для конвертации валют используйте отдельную логику

### 3. Почему Result<T, E>?

Railway-Oriented Programming обеспечивает:
- Явную обработку ошибок
- Type-safe error handling
- Композицию операций через flatMap

## Связанные Value Objects

- **[Money](./money.md)** — универсальный денежный value object
- **[Percentage](./percentage.md)** — для расчёта процентов и комиссий
- **Price** — цены на рынке
- **Quantity** — количества на рынке

## TypeScript Types

```typescript
// Factory method
static fromValue(
  amount: number | string | Decimal,
  currency: string
): Result<Balance, InvalidMoneyError>

// Getters
getAmount(): number
getCurrency(): string
toDecimal(): Decimal

// Utilities
hasEnough(required: number | Decimal): boolean

// Math operations
add(other: Balance): Result<Balance, CurrencyMismatchError>
subtract(other: Balance): Result<Balance, CurrencyMismatchError | InvalidMoneyError>

// Comparison
equals(other: Balance): boolean

// Conversion
toString(): string
```

## См. также

- [Money Documentation](./money.md)
- [Percentage Documentation](./percentage.md)
- [Railway-Oriented Programming](https://fsharpforfunandprofit.com/rop/)
- [Decimal.js Documentation](https://mikemcl.github.io/decimal.js/)
