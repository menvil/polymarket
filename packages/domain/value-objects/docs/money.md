# Money Value Object

## Описание

**Money** — неизменяемый value object для представления денежных сумм с высокой точностью вычислений.

Использует `decimal.js` для финансовых расчётов и `Result<T, E>` для Railway-Oriented Programming.

## Основные характеристики

- ✅ **Неизменяемость** — все операции возвращают новые экземпляры
- ✅ **Высокая точность** — использует Decimal.js (без проблем floating point)
- ✅ **Безопасность типов** — явная обработка ошибок через Result
- ✅ **Поддержка отрицательных значений** — для PnL (Profit & Loss) расчётов
- ✅ **Защита от overflow** — явные ошибки вместо silent overflow
- ✅ **Мультивалютность** — архитектура готова для расширения (сейчас только USDC)

## Поддерживаемые валюты

В текущей версии поддерживается только **USDC**:

```typescript
type SupportedCurrency = 'USDC';
```

**Для расширения** просто добавьте валюты в тип:

```typescript
type SupportedCurrency = 'USDC' | 'BTC' | 'ETH';
```

## Диапазон значений

```typescript
MAX: 1e15 (= 1 квадриллион центов = 10 триллионов долларов)
```

Этого достаточно для:
- Капитализация всех криптовалют: ~2-3 трлн $
- ВВП США: ~25 трлн $
- Типичные объёмы Polymarket: миллионы-миллиарды $

## Создание (Factory Methods)

### fromValue(amount: number | string | Decimal, currency?: SupportedCurrency)

Универсальный метод для создания Money из различных типов значений.

**Параметры:**
- `amount` — сумма (number, string или Decimal)
- `currency` — валюта (опционально, по умолчанию 'USDC')

**Поддерживаемые типы amount:**
- `number` — обычное число (100, -50, 100.50)
- `string` — строковое представление числа ("100.123456789012345")
- `Decimal` — объект Decimal.js для высокой точности

**Примеры:**

```typescript
import { Money } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

// ✅ Создание из числа (USDC по умолчанию)
const money1 = Money.fromValue(100);
money1.match({
  ok: (m) => console.log(m.getAmount()),    // 100
  err: (error) => console.error(error)
});

// ✅ С явной валютой
const usdc = Money.fromValue(100, 'USDC');

// ✅ Из строки (высокая точность)
const money2 = Money.fromValue('100.123456789012345');
money2.match({
  ok: (m) => {
    // Decimal.js сохраняет всю точность
    console.log(m.toDecimal().toString()); // "100.123456789012345"
  },
  err: (error) => console.error(error)
});

// ✅ Из Decimal
const decimal = new Decimal('100.123456789');
const money3 = Money.fromValue(decimal);
money3.match({
  ok: (m) => console.log(m.toDecimal().toString()), // "100.123456789"
  err: (error) => console.error(error)
});

// ✅ Отрицательные значения для PnL
const loss = Money.fromValue(-50);
loss.match({
  ok: (m) => {
    console.log(m.getAmount());    // -50
    console.log(m.isNegative());   // true
  },
  err: (error) => console.error(error)
});
```

**Отклоняет:**
- `NaN`
- `Infinity` / `-Infinity`
- Значения вне диапазона [-1e15, 1e15]
- Невалидные строки

**Алгоритм валидации:**
1. Преобразует входное значение в `Decimal`
2. Проверяет `Decimal.isNaN()`
3. Проверяет `Decimal.isFinite()`
4. Проверяет диапазон значений
5. Возвращает `Ok(Money)` или `Err(InvalidMoneyError)`

**Когда использовать строки:**
- Для значений с высокой точностью (>15 знаков)
- При парсинге из JSON/API
- Для избежания проблем floating point

**Когда использовать Decimal:**
- Когда уже есть Decimal объект из других вычислений
- Для сохранения максимальной точности в цепочке операций

### zero(currency?: SupportedCurrency)

Создать нулевую сумму.

```typescript
const zero = Money.zero();        // 0 USDC
const zeroUsdc = Money.zero('USDC'); // 0 USDC

console.log(zero.isZero());        // true
console.log(zero.getAmount());     // 0
console.log(zero.getCurrency());   // "USDC"
```

## Математические операции

Все операции возвращают `Result<Money, Error>` и **не изменяют** исходные объекты.

### add(other: Money)

Сложение денежных сумм.

```typescript
import { unwrap } from '@polymarket/result';

const m1 = unwrap(Money.fromValue(100));
const m2 = unwrap(Money.fromValue(50));

const sum = m1.add(m2);
sum.match({
  ok: (money) => console.log(money.getAmount()), // 150
  err: (error) => console.error(error)
});
```

**Валидация:**
- Проверяет совпадение валют
- Возвращает `CurrencyMismatchError` если валюты разные

**Ошибки:**
- `CurrencyMismatchError` — несоответствие валют

**Пример ошибки валюты:**
```typescript
const usdc = unwrap(Money.fromValue(100, 'USDC'));
const btc = unwrap(Money.fromValue(1, 'BTC')); // Если BTC добавлен

const result = usdc.add(btc);
result.match({
  ok: (money) => console.log(money),
  err: (error) => {
    // CurrencyMismatchError: "Cannot add BTC to USDC"
    console.error(error.message);
  }
});
```

### subtract(other: Money)

Вычитание денежных сумм.

```typescript
const m1 = unwrap(Money.fromValue(100));
const m2 = unwrap(Money.fromValue(30));

const diff = m1.subtract(m2);
diff.match({
  ok: (money) => console.log(money.getAmount()), // 70
  err: (error) => console.error(error)
});
```

**Разрешает отрицательный результат:**
```typescript
const cost = unwrap(Money.fromValue(100));
const revenue = unwrap(Money.fromValue(80));

const pnl = revenue.subtract(cost);
pnl.match({
  ok: (money) => {
    console.log(money.getAmount());    // -20
    console.log(money.isNegative());   // true
  },
  err: (error) => console.error(error)
});
```

### multiply(factor: number | Decimal)

Умножение на коэффициент.

```typescript
const money = unwrap(Money.fromValue(100));

// Умножение на число
const doubled = money.multiply(2);
doubled.match({
  ok: (m) => console.log(m.getAmount()), // 200
  err: (error) => console.error('Overflow')
});

// Умножение на Decimal
const factor = new Decimal('1.5');
const result = money.multiply(factor);
result.match({
  ok: (m) => console.log(m.getAmount()), // 150
  err: (error) => console.error(error)
});
```

**Ошибки:**
- `ArithmeticOverflowError` — результат > 1e15

**Пример overflow:**
```typescript
const huge = unwrap(Money.fromValue(1e15));
const result = huge.multiply(1000);

result.match({
  ok: (m) => console.log(m),
  err: (error) => {
    // ArithmeticOverflowError: "Multiplication overflow"
    console.error(error.message);
  }
});
```

### divide(divisor: number | Decimal)

Деление на коэффициент.

```typescript
const money = unwrap(Money.fromValue(100));

const half = money.divide(2);
half.match({
  ok: (m) => console.log(m.getAmount()), // 50
  err: (error) => console.error('Division by zero')
});
```

**Ошибки:**
- `DivisionByZeroError` — деление на 0

**Пример ошибки деления:**
```typescript
const money = unwrap(Money.fromValue(100));
const result = money.divide(0);

result.match({
  ok: (m) => console.log(m),
  err: (error) => {
    if (error instanceof DivisionByZeroError) {
      console.error('Cannot divide by zero!');
    }
  }
});
```

## Сравнение

Все методы сравнения требуют одинаковые валюты.

### equals(other: Money)

Проверка равенства.

```typescript
const m1 = unwrap(Money.fromValue(100));
const m2 = unwrap(Money.fromValue(100));
const m3 = unwrap(Money.fromValue(50));

console.log(m1.equals(m2)); // true
console.log(m1.equals(m3)); // false
```

**Точность Decimal.js:**
```typescript
const m1 = unwrap(Money.fromValue('100.1'));
const m2 = unwrap(Money.fromValue('100.10'));

console.log(m1.equals(m2)); // true (Decimal.js сравнивает значения)
```

### greaterThan(other: Money)

Проверка больше.

```typescript
const m1 = unwrap(Money.fromValue(100));
const m2 = unwrap(Money.fromValue(50));

const result = m1.greaterThan(m2);
result.match({
  ok: (isGreater) => console.log(isGreater), // true
  err: (error) => console.error('Currency mismatch')
});
```

### lessThan(other: Money)

Проверка меньше.

```typescript
const m1 = unwrap(Money.fromValue(50));
const m2 = unwrap(Money.fromValue(100));

const result = m1.lessThan(m2);
result.match({
  ok: (isLess) => console.log(isLess), // true
  err: (error) => console.error(error)
});
```

### greaterThanOrEqual / lessThanOrEqual

```typescript
const m1 = unwrap(Money.fromValue(100));
const m2 = unwrap(Money.fromValue(100));

const result = m1.greaterThanOrEqual(m2);
result.match({
  ok: (gte) => console.log(gte), // true
  err: (error) => console.error(error)
});
```

## Утилиты

### isZero() / isPositive() / isNegative()

Проверка знака.

```typescript
const zero = Money.zero();
const profit = unwrap(Money.fromValue(100));
const loss = unwrap(Money.fromValue(-50));

console.log(zero.isZero());         // true
console.log(profit.isPositive());   // true (> 0)
console.log(profit.isNegative());   // false
console.log(loss.isNegative());     // true
```

**Важно:** `isPositive()` возвращает `true` только для значений **больше нуля**.

```typescript
const zero = Money.zero();
console.log(zero.isPositive()); // false (ноль не является положительным)
```

### abs()

Абсолютное значение.

```typescript
const loss = unwrap(Money.fromValue(-50));
const absLoss = loss.abs();

console.log(loss.getAmount());    // -50 (оригинал не изменён)
console.log(absLoss.getAmount()); // 50
```

### negate()

Изменить знак.

```typescript
const profit = unwrap(Money.fromValue(100));
const loss = profit.negate();

console.log(profit.getAmount()); // 100
console.log(loss.getAmount());   // -100
```

### toString(decimals?: number)

Форматирование в строку.

```typescript
const money = unwrap(Money.fromValue(100.5));

console.log(money.toString());     // "$100.50 USDC"
console.log(money.toString(4));    // "$100.5000 USDC"
console.log(money.toString(0));    // "$100 USDC"
```

### getAmount() / getCurrency() / toDecimal()

Получение значений.

```typescript
const money = unwrap(Money.fromValue(100.5, 'USDC'));

console.log(money.getAmount());    // 100.5 (number)
console.log(money.getCurrency());  // "USDC"
console.log(money.toDecimal());    // Decimal(100.5)
```

## Примеры использования

### 1. Расчёт комиссий

```typescript
import { Money } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';

const orderSize = unwrap(Money.fromValue(10000));      // 10,000 USDC
const feeRate = 0.0025;                                  // 0.25%

const fee = orderSize.multiply(feeRate);
fee.match({
  ok: (feeAmount) => {
    console.log(`Fee: ${feeAmount.toString()}`); // "$25.00 USDC"
  },
  err: (error) => console.error(error)
});
```

### 2. PnL (Profit & Loss) расчёты

```typescript
const entryPrice = unwrap(Money.fromValue(100));
const exitPrice = unwrap(Money.fromValue(95));
const quantity = 100;

const entryCost = unwrap(entryPrice.multiply(quantity));  // $10,000
const exitRevenue = unwrap(exitPrice.multiply(quantity)); // $9,500

const pnl = exitRevenue.subtract(entryCost);
pnl.match({
  ok: (result) => {
    if (result.isNegative()) {
      console.log(`Убыток: ${result.abs().toString()}`); // "Убыток: $500.00 USDC"
    } else {
      console.log(`Прибыль: ${result.toString()}`);
    }
  },
  err: (error) => console.error(error)
});
```

### 3. Проблема 0.1 + 0.2 = 0.3

```typescript
// ❌ С обычным number (проблема floating point)
const wrong = 0.1 + 0.2; // 0.30000000000000004

// ✅ С Money + Decimal.js (точно!)
const m1 = unwrap(Money.fromValue('0.1'));
const m2 = unwrap(Money.fromValue('0.2'));
const correct = unwrap(m1.add(m2));

console.log(correct.toDecimal().toString()); // "0.3" (точно!)
```

### 4. Композиция операций

```typescript
const initialBalance = unwrap(Money.fromValue(1000));
const deposit = unwrap(Money.fromValue(500));
const withdrawal = unwrap(Money.fromValue(200));

// Цепочка операций через Result
const result = initialBalance.add(deposit)
  .flatMap(balance => balance.subtract(withdrawal));

result.match({
  ok: (finalBalance) => {
    console.log(`Final balance: ${finalBalance.toString()}`);
    // "Final balance: $1,300.00 USDC"
  },
  err: (error) => console.error('Operation failed:', error)
});
```

### 5. Валидация балансов (неотрицательные значения)

```typescript
// Money может быть отрицательным для PnL
const pnl = unwrap(Money.fromValue(-100));
console.log(pnl.isNegative()); // true - допустимо

// Для балансов счетов используйте Balance
import { Balance } from '@polymarket/value-objects';

const balance = Balance.fromAmount(-100, 'USDC');
balance.match({
  ok: (b) => console.log(b),
  err: (error) => {
    // InvalidMoneyError: балансы не могут быть отрицательными
    console.error(error.message);
  }
});
```

### 6. Точные вычисления с большими числами

```typescript
const price = unwrap(Money.fromValue('0.123456789012345'));
const quantity = new Decimal('1000000');

const total = price.multiply(quantity);
total.match({
  ok: (amount) => {
    // Decimal.js сохраняет всю точность
    console.log(amount.toDecimal().toString());
    // "123456.789012345"
  },
  err: (error) => console.error(error)
});
```

## Ошибки

### InvalidMoneyError

Выбрасывается при создании невалидной денежной суммы.

```typescript
import { InvalidMoneyError } from '@polymarket/errors';

const result = Money.fromValue(NaN);

result.match({
  ok: (money) => console.log(money),
  err: (error) => {
    if (error instanceof InvalidMoneyError) {
      console.error(error.message); // "Amount cannot be NaN"
      console.error(error.code);    // "INVALID_MONEY"
      console.error(error.context); // { amount: NaN, currency: 'USDC', reason: 'NaN' }
    }
  }
});
```

**Причины:**
- `NaN`
- `Infinity` / `-Infinity`
- Неподдерживаемая валюта

### CurrencyMismatchError

Выбрасывается при операциях с разными валютами.

```typescript
import { CurrencyMismatchError } from '@polymarket/errors';

const usdc = unwrap(Money.fromValue(100, 'USDC'));
const btc = unwrap(Money.fromValue(1, 'BTC')); // Если BTC добавлен

const result = usdc.add(btc);

result.match({
  ok: (money) => console.log(money),
  err: (error) => {
    if (error instanceof CurrencyMismatchError) {
      console.error(error.message);
      // "Cannot add BTC to USDC"
      console.error(error.context);
      // { operation: 'add', expected: 'USDC', actual: 'BTC' }
    }
  }
});
```

### ArithmeticOverflowError

Выбрасывается при переполнении.

```typescript
import { ArithmeticOverflowError } from '@polymarket/errors';

const huge = unwrap(Money.fromValue(1e15));
const result = huge.multiply(1000);

result.match({
  ok: (money) => console.log(money),
  err: (error) => {
    if (error instanceof ArithmeticOverflowError) {
      console.error(error.message);
      // "Multiplication overflow: result 1e+18 exceeds maximum 1e+15"
    }
  }
});
```

### DivisionByZeroError

Выбрасывается при делении на ноль.

```typescript
import { DivisionByZeroError } from '@polymarket/errors';

const money = unwrap(Money.fromValue(100));
const result = money.divide(0);

result.match({
  ok: (m) => console.log(m),
  err: (error) => {
    if (error instanceof DivisionByZeroError) {
      console.error(error.message);
      // "Cannot divide 100 by 0"
    }
  }
});
```

## Best Practices

### ✅ DO: Используйте unwrap() для упрощения

```typescript
import { unwrap } from '@polymarket/result';

// Короткий синтаксис когда уверены в валидности
const money = unwrap(Money.fromValue(100));
console.log(money.getAmount()); // 100
```

### ✅ DO: Обрабатывайте ошибки явно

```typescript
const result = Money.fromValue(value);

result.match({
  ok: (money) => processMoney(money),
  err: (error) => {
    if (error instanceof InvalidMoneyError) {
      logError(error);
    }
  }
});
```

### ✅ DO: Используйте строки для высокой точности

```typescript
// ✅ ХОРОШО - точность сохранена
const money = unwrap(Money.fromValue('100.123456789012345'));

// ❌ ПЛОХО - теряется точность из-за floating point
const money2 = unwrap(Money.fromValue(100.123456789012345));
```

### ✅ DO: Проверяйте валюты перед операциями

```typescript
const m1 = unwrap(Money.fromValue(100, 'USDC'));
const m2 = unwrap(Money.fromValue(50, 'USDC'));

// Валюты совпадают - операция безопасна
const sum = m1.add(m2);
```

### ❌ DON'T: Не игнорируйте Result

```typescript
// ❌ ПЛОХО - Result игнорируется
const money = Money.fromValue(value);

// ✅ ХОРОШО - Result обработан
const result = Money.fromValue(value);
if (!result.ok) {
  throw result.error;
}
const money = result.value;
```

### ❌ DON'T: Не мутируйте объекты

```typescript
// ❌ ПЛОХО (не скомпилируется)
money.amount = new Decimal(200); // Error: Cannot assign

// ✅ ХОРОШО
const newMoney = unwrap(money.multiply(2));
```

### ❌ DON'T: Не смешивайте валюты

```typescript
// ❌ ПЛОХО - ошибка выполнения
const usdc = unwrap(Money.fromValue(100, 'USDC'));
const btc = unwrap(Money.fromValue(1, 'BTC'));
const result = usdc.add(btc); // CurrencyMismatchError

// ✅ ХОРОШО - конвертация перед операцией
const btcInUsdc = convertToUsdc(btc);
const result = usdc.add(btcInUsdc);
```

## Архитектурные решения

### Почему Decimal.js?

**Проблема:**
```typescript
0.1 + 0.2 === 0.3 // false! (0.30000000000000004)
```

**Решение:**
```typescript
const m1 = unwrap(Money.fromValue('0.1'));
const m2 = unwrap(Money.fromValue('0.2'));
const sum = unwrap(m1.add(m2));
sum.toDecimal().toString() === '0.3' // true!
```

### Почему Result<T, E>?

**Проблема с exceptions:**
```typescript
try {
  const money = Money.fromValue(value); // Может выбросить
} catch (error) {
  // Неявная обработка, легко пропустить
}
```

**Решение с Result:**
```typescript
const result = Money.fromValue(value);
result.match({
  ok: (money) => processMoney(money),
  err: (error) => handleError(error) // Компилятор заставит обработать
});
```

### Почему поддержка отрицательных значений?

Для PnL (Profit & Loss) расчётов нужны отрицательные значения:

```typescript
const cost = unwrap(Money.fromValue(100));
const revenue = unwrap(Money.fromValue(80));
const pnl = unwrap(revenue.subtract(cost)); // -20 (убыток)
```

Для балансов счетов используйте **Balance** (только неотрицательные).

## Тесты

Money покрыт 77 unit-тестами:

```bash
npm test -- Money.test.ts
```

**Категории тестов:**
- ✅ Фабричные методы (17 тестов)
- ✅ Математические операции (22 теста)
- ✅ Сравнение (18 тестов)
- ✅ Утилиты (14 тестов)
- ✅ Граничные случаи (6 тестов)

## TypeScript типы

```typescript
// Фабричные методы
Money.fromValue(amount: number, currency?: SupportedCurrency): Result<Money, InvalidMoneyError>
Money.fromValue(amount: Decimal, currency?: SupportedCurrency): Result<Money, InvalidMoneyError>
Money.fromValue(amount: string, currency?: SupportedCurrency): Result<Money, InvalidMoneyError>
Money.zero(currency?: SupportedCurrency): Money

// Геттеры
getAmount(): number
getCurrency(): SupportedCurrency
toDecimal(): Decimal

// Математические операции
add(other: Money): Result<Money, CurrencyMismatchError>
subtract(other: Money): Result<Money, CurrencyMismatchError>
multiply(factor: number | Decimal): Result<Money, ArithmeticOverflowError>
divide(divisor: number | Decimal): Result<Money, DivisionByZeroError>

// Сравнение
equals(other: Money): boolean
greaterThan(other: Money): Result<boolean, CurrencyMismatchError>
lessThan(other: Money): Result<boolean, CurrencyMismatchError>
greaterThanOrEqual(other: Money): Result<boolean, CurrencyMismatchError>
lessThanOrEqual(other: Money): Result<boolean, CurrencyMismatchError>

// Утилиты
isZero(): boolean
isPositive(): boolean
isNegative(): boolean
abs(): Money
negate(): Money
toString(decimals?: number): string
```

## Связанные value objects

- **[Balance](./balance.md)** — баланс счёта (только неотрицательные значения)
- **[Percentage](./percentage.md)** — процентные значения
- **[Price](./price.md)** — цены на рынке предсказаний
- **[Quantity](./quantity.md)** — количество акций

## См. также

- [Decimal.js Documentation](https://mikemcl.github.io/decimal.js/)
- [Railway-Oriented Programming](https://fsharpforfunandprofit.com/rop/)
- [Value Objects Pattern](https://martinfowler.com/bliki/ValueObject.html)
- [Domain-Driven Design](https://martinfowler.com/bliki/DomainDrivenDesign.html)
