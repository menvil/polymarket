# Money Facade Layer

> MoneyService — единая точка входа с Result<T, E>

## Содержание

1. [Обзор](#обзор)
2. [MoneyService API](#moneyservice-api)
3. [Never Throw Contract](#never-throw-contract)
4. [Error Handling](#error-handling)
5. [Примеры](#примеры)

---

## Обзор

**MoneyService** — Facade слой, который:

- Оборачивает все операции в `Result<T, E>`
- Ловит все исключения (из Core и `@polymarket/math`)
- Никогда не бросает исключения
- Проверяет контекстные правила (совпадение валют)
- Предоставляет математические операции

---

## MoneyService API

### Создание

#### `create(value, currency?)`

Создаёт Money с валидацией и Result.

**Сигнатура:**

```typescript
public static create(
  value: number | string | Decimal,
  currency: SupportedCurrency = 'USDC'
): Result<Money, InvalidMoneyError>
```

**Процесс:**

1. Парсит value в Decimal (try/catch → INVALID_FORMAT)
2. Вызывает `Money.of()` (try/catch → reason из Core)
3. Возвращает Result

**Ошибки:**

- `INVALID_FORMAT` — parse error
- `UNSUPPORTED_CURRENCY` — валюта не поддерживается
- `NAN` — сумма NaN
- `NON_FINITE` — сумма Infinity
- `EXCEEDS_MAX_AMOUNT` — |сумма| > 1e15

**Пример:**

```typescript
const result = MoneyService.create("100.50");
if (!result.ok) {
  console.error(result.error.context?.reason);  // 'INVALID_FORMAT' | 'NAN' | ...
  return;
}
const money = result.value;
```

---

### Арифметика

#### `add(a, b)`

Складывает две денежные суммы.

**Сигнатура:**

```typescript
public static add(
  a: Money,
  b: Money
): Result<Money, InvalidMoneyError>
```

**Проверки:**

1. Валюты совпадают → иначе InvalidMoneyError (reason: 'CURRENCY_MISMATCH')
2. Арифметика через @polymarket/math (try/catch)
3. Создание через Money.of (try/catch)

**Пример:**

```typescript
const m1 = Money.of(new Decimal(100), 'USDC');
const m2 = Money.of(new Decimal(50), 'USDC');

const result = MoneyService.add(m1, m2);
if (result.ok) {
  console.log(result.value.value());  // 150
}
```

---

#### `subtract(a, b)`

Вычитает одну сумму из другой.

**Сигнатура:**

```typescript
public static subtract(
  a: Money,
  b: Money
): Result<Money, InvalidMoneyError>
```

**Процесс:** аналогичен `add()`

**Пример:**

```typescript
const m1 = Money.of(new Decimal(100), 'USDC');
const m2 = Money.of(new Decimal(30), 'USDC');

const result = MoneyService.subtract(m1, m2);
if (result.ok) {
  console.log(result.value.value());  // 70
}
```

---

#### `multiply(m, factor)`

Умножает сумму на множитель.

**Сигнатура:**

```typescript
public static multiply(
  m: Money,
  factor: number | string | Decimal
): Result<Money, InvalidMoneyError>
```

**Валидация factor:**

- Парсинг в Decimal (reason: 'INVALID_FORMAT')
- Не NaN (reason: 'NAN')
- Finite (reason: 'NON_FINITE')
- Валидация через ValidateFactorForMoneyMultiplication (Rules слой)

**Пример:**

```typescript
const money = Money.of(new Decimal(100), 'USDC');

const result = MoneyService.multiply(money, 1.5);
if (result.ok) {
  console.log(result.value.value());  // 150
}
```

---

#### `divide(m, divisor)`

Делит сумму на делитель.

**Сигнатура:**

```typescript
public static divide(
  m: Money,
  divisor: number | string | Decimal
): Result<Money, InvalidMoneyError>
```

**Валидация divisor:**

- Парсинг в Decimal (reason: 'INVALID_FORMAT')
- Не NaN (reason: 'NAN')
- Finite (reason: 'NON_FINITE')
- Не ноль (reason: 'DIVISION_BY_ZERO')
- Валидация через ValidateDivisorForMoneyDivision (Rules слой)

**Пример:**

```typescript
const money = Money.of(new Decimal(100), 'USDC');

const result = MoneyService.divide(money, 2);
if (result.ok) {
  console.log(result.value.value());  // 50
}

// Деление на ноль
const zeroResult = MoneyService.divide(money, 0);
// zeroResult.ok === false
// zeroResult.error instanceof InvalidMoneyError
// zeroResult.error.context.reason === 'DIVISION_BY_ZERO'
```

---

### Ratio Operations

#### `portion(m, rate)`

Вычисляет долю (portion) от суммы Money.

**Сигнатура:**

```typescript
public static portion(
  m: Money,
  rate: Ratio
): Result<Money, InvalidMoneyError>
```

**Семантика:** "Сколько денег составляет доля rate от суммы m"

**Формула:** `result = m * rate`

**Use cases:**

- Fee: `portion(orderAmount, RatioService.fromPercent(2))` → 2% trading fee
- Rebate: `portion(paidAmount, RatioService.fromBps(25))` → 0.25% cashback
- Allocation: `portion(budget, Ratio.of(new Decimal(0.3)))` → 30% от бюджета

**Пример:**

```typescript
// Fee calculation: 2% от $1000
const orderAmount = Money.of(new Decimal(1000), 'USDC');
const feeRate = Ratio.of(new Decimal(0.02)); // 2%
const feeResult = MoneyService.portion(orderAmount, feeRate);
if (feeResult.ok) {
  console.log(feeResult.value.value().toString()); // "20"
}

// Allocation: 30% от бюджета $5000
const budget = Money.of(new Decimal(5000), 'USDC');
const allocRate = Ratio.of(new Decimal(0.3)); // 30%
const allocResult = MoneyService.portion(budget, allocRate);
if (allocResult.ok) {
  console.log(allocResult.value.value().toString()); // "1500"
}
```

---

#### `increaseBy(m, delta)`

Увеличивает сумму на delta процентов.

**Сигнатура:**

```typescript
public static increaseBy(
  m: Money,
  delta: Ratio
): Result<Money, InvalidMoneyError>
```

**Семантика:** "Увеличить сумму на delta процентов"

**Формула:** `result = m * (1 + delta)`

**Инвариант:** `delta >= -1` (иначе `DELTA_LESS_THAN_MINUS_ONE`)

**Use cases:**

- Price increase: `increaseBy(price, RatioService.fromPercent(10))` → +10% наценка
- Interest: `increaseBy(principal, RatioService.fromPercent(5))` → +5% проценты
- Growth: `increaseBy(value, RatioService.fromPercent(15))` → +15% рост

**Пример:**

```typescript
// Наценка 20%: $100 → $120
const price = Money.of(new Decimal(100), 'USDC');
const markup = Ratio.of(new Decimal(0.2)); // 20%
const result = MoneyService.increaseBy(price, markup);
if (result.ok) {
  console.log(result.value.value().toString()); // "120"
}

// Удвоить цену: +100%
const double = Ratio.of(new Decimal(1)); // 100%
const doubled = MoneyService.increaseBy(price, double);
if (doubled.ok) {
  console.log(doubled.value.value().toString()); // "200"
}
```

---

#### `decreaseBy(m, delta)`

Уменьшает сумму на delta процентов.

**Сигнатура:**

```typescript
public static decreaseBy(
  m: Money,
  delta: Ratio
): Result<Money, InvalidMoneyError>
```

**Семантика:** "Уменьшить сумму на delta процентов"

**Формула:** `result = m * (1 - delta)` (эквивалентно `increaseBy(m, -delta)`)

**Инвариант:** `delta <= 1` (иначе после отрицания будет `DELTA_LESS_THAN_MINUS_ONE`)

**Use cases:**

- Discount: `decreaseBy(price, RatioService.fromPercent(10))` → -10% скидка
- Depreciation: `decreaseBy(value, RatioService.fromPercent(15))` → -15% износ

**Пример:**

```typescript
// Скидка 20%: $100 → $80
const price = Money.of(new Decimal(100), 'USDC');
const discount = Ratio.of(new Decimal(0.2)); // 20%
const result = MoneyService.decreaseBy(price, discount);
if (result.ok) {
  console.log(result.value.value().toString()); // "80"
}

// Снижение цены на 100% (обнуление)
const full = Ratio.of(new Decimal(1)); // 100%
const zeroed = MoneyService.decreaseBy(price, full);
if (zeroed.ok) {
  console.log(zeroed.value.value().toString()); // "0"
}
```

---

## Never Throw Contract

**ГАРАНТИЯ:** MoneyService НИКОГДА не бросает исключения.

### Обёртка всех операций

Каждый метод обёрнут в try/catch:

```typescript
public static create(value: number | string | Decimal, currency: SupportedCurrency = 'USDC') {
  // Шаг 1: парсинг
  let decimal: Decimal;
  try {
    decimal = new Decimal(value as any);
  } catch {
    return Err(InvalidMoneyError with INVALID_FORMAT);
  }

  // Шаг 2: создание через Core
  try {
    return Ok(Money.of(decimal, currency));
  } catch (error) {
    if (error instanceof MoneyInvariantViolation) {
      return Err(InvalidMoneyError with reason from Core);
    }
    // Unexpected error - возвращаем Err вместо throw
    return Err(unexpectedError('createFromDecimal', {}, error));
  }
}
```

### Math Operations Safety

Все @polymarket/math операции обёрнуты через wrapOp():

```typescript
public static add(a: Money, b: Money): Result<Money, InvalidMoneyError> {
  // 1. Проверка валют
  if (!a.hasSameCurrency(b)) {
    return Err(new InvalidMoneyError('Cannot add Money with different currencies', {
      context: {
        op: 'add',
        reason: 'CURRENCY_MISMATCH',
        expected: a.currency(),
        actual: b.currency()
      }
    }));
  }

  // 2. wrapOp автоматически обрабатывает math операции и создание Money
  const ctx = { a: a.value().toString(), b: b.value().toString(), currency: a.currency() };
  return this.wrapOp('add', ctx, () => {
    const sum = addDecimal(a.value(), b.value());
    return this.createFromDecimal(sum, a.currency(), 'add', {});
  });
}
```

---

## Error Handling

### Error Types

**ВСЕ операции возвращают InvalidMoneyError** с различными `reason` значениями.

**InvalidMoneyError** — единый тип ошибки для всех операций:

**Создание (create):**

```typescript
{
  message: "Failed to create Money",
  context: {
    op: 'create',
    raw: { field: 'value', value: "100.50" },
    currency: 'USDC',
    reason: 'INVALID_FORMAT' | 'NAN' | 'NON_FINITE' | 'EXCEEDS_MAX_AMOUNT' | 'UNSUPPORTED_CURRENCY'
  }
}
```

**Несовпадение валют (add/subtract):**

```typescript
{
  message: "Cannot add Money with different currencies",
  context: {
    op: 'add',
    reason: 'CURRENCY_MISMATCH',
    expected: 'USDC',
    actual: 'EUR'
  }
}
```

**Overflow в арифметике:**

```typescript
{
  message: "Money add result is invalid: EXCEEDS_MAX_AMOUNT",
  context: {
    op: 'add',
    a: "1e15",
    b: "1e15",
    currency: 'USDC',
    reason: 'EXCEEDS_MAX_AMOUNT'
  }
}
```

**Деление на ноль:**

```typescript
{
  message: "Cannot divide by zero",
  context: {
    op: 'divide',
    divisor: "0",
    reason: 'DIVISION_BY_ZERO'
  }
}
```

### Error Context

Каждая InvalidMoneyError содержит:

- `op` — операция ('create', 'add', 'divide', ...)
- `opChain` — цепочка операций (для вложенных вызовов)
- `reason` — причина ошибки (см. список выше)
- `raw` — сырой ввод для ошибок парсинга: { field, value }
- `cause` — для math-исключений: { name, message, stack? }
- Входные данные (amount, divisor, factor, a, b)
- `currency` — валюта (если применимо)

### Все возможные reason значения

- `INVALID_FORMAT` — ошибка парсинга значения
- `NAN` — значение NaN
- `NON_FINITE` — значение не finite (Infinity)
- `EXCEEDS_MAX_AMOUNT` — результат превышает максимальную сумму
- `CURRENCY_MISMATCH` — несовпадение валют в add/subtract
- `DIVISION_BY_ZERO` — деление на ноль
- `UNSUPPORTED_CURRENCY` — неподдерживаемая валюта
- `NEGATIVE_RESULT` — результат операции меньше нуля
- `INVALID_RATIO` — невалидный Ratio (NaN, Infinity)
- `RATIO_OUT_OF_RANGE` — Ratio вне допустимого диапазона
- `DELTA_LESS_THAN_MINUS_ONE` — delta < -1 в increaseBy/decreaseBy

---

## Примеры

### Создание с обработкой ошибок

```typescript
const result = MoneyService.create(userInput);

if (!result.ok) {
  const ctx = result.error.context;
  const reason = ctx?.reason;
  const rawValue = ctx?.raw?.value;

  switch (reason) {
    case 'INVALID_FORMAT':
      showError(`Invalid number format: ${rawValue}`);
      break;
    case 'EXCEEDS_MAX_AMOUNT':
      showError(`Amount too large (max: 1e15)`);
      break;
    case 'NON_FINITE':
      showError(`Amount must be finite`);
      break;
    default:
      showError(result.error.message);
  }
  return;
}

const money = result.value;
```

### Арифметика с проверкой валют

```typescript
function addBalances(balance1: Money, balance2: Money) {
  const result = MoneyService.add(balance1, balance2);

  if (!result.ok) {
    const { reason, expected, actual } = result.error.context || {};

    if (reason === 'CURRENCY_MISMATCH') {
      console.error(`Cannot add different currencies: ${expected} vs ${actual}`);
    } else {
      console.error(`Addition failed: ${result.error.message}`);
    }
    return null;
  }

  return result.value;
}
```

### Вычисление комиссии

```typescript
function calculateFee(amount: Money, feeRate: string): Money | null {
  const result = MoneyService.multiply(amount, feeRate);

  if (!result.ok) {
    console.error(`Fee calculation failed: ${result.error.message}`);
    return null;
  }

  return result.value;
}

const orderAmount = Money.of(new Decimal(1000), 'USDC');
const fee = calculateFee(orderAmount, "0.002");  // 0.2% fee
if (fee) {
  console.log(`Fee: $${fee.value()}`);  // $2.00
}
```

---

## Заключение

MoneyService:

- ✅ Never Throw — все ошибки через Result
- ✅ Type-safe — compile-time проверка ошибок
- ✅ Context-rich errors — подробная диагностика
- ✅ Currency safety — проверка совпадения валют
- ✅ Math safety — обёртка @polymarket/math
