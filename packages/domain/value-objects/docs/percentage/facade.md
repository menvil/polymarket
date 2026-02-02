# Facade Layer — PercentageService API

> Единая точка входа для всех операций с Percentage

## Обзор

`PercentageService` — это фасад, который предоставляет type-safe API для работы с Percentage через `Result<T, E>`.

**Все методы возвращают `Result<Percentage, InvalidPercentageError>`** (или `Result<Decimal, InvalidPercentageError>` для applyTo).

PercentageService НИКОГДА не бросает исключения. Все ошибки возвращаются через Result с InvalidPercentageError, который содержит в context детальную информацию о причине ошибки.

**Использует централизованный errorUtils:**
- `toDecimal()` — парсинг с generic типами
- `wrapOp()` — обработка операций
- `rewrap()` — обёртка ошибок с сохранением root-cause

---

## Facade Error Contract

Все ошибки из `PercentageService` содержат стандартный контекст:

```typescript
interface InvalidPercentageErrorContext {
  op?: string;  // Название операции: 'create', 'add', 'multiply', etc.

  // Входные данные
  value?: string;
  a?: string;
  b?: string;
  factor?: string;
  divisor?: string;
  percentage?: string;

  // Сырой ввод (для ошибок парсинга)
  raw?: {
    field: string;   // 'value', 'factor', 'divisor'
    value: string;   // сырое значение
  };

  // Причина ошибки (из PercentageErrorReason)
  reason?: string;

  // Для math exceptions
  cause?: {
    name: string;     // 'ArithmeticOverflowError', etc.
    message: string;
    stack?: string;
  };

  // Цепочка операций (для rewrap)
  opChain?: string[];
}
```

**Пример использования:**

```typescript
const result = PercentageService.divide(pct, 0);
if (!result.ok) {
  console.log(result.error.context?.op);       // 'divide'
  console.log(result.error.context?.divisor);  // '0'
  console.log(result.error.context?.reason);   // 'DIVISION_BY_ZERO'
}
```

---

## API Методы

### Создание

#### `create(value: number | string | Decimal)`

Создаёт Percentage с валидацией инвариантов (шкала 0-100).

**Сигнатура:**

```typescript
create(value: number | string | Decimal): Result<Percentage, InvalidPercentageError>
```

**Инварианты проверяются автоматически:**

- finite (не NaN, не Infinity)
- диапазон [-1e6, 1e6]

**Оптимизация:** Если `value` уже `Decimal`, используется `fromDecimal()` без повторного парсинга.

**Примеры:**

```typescript
// Успех
const result = PercentageService.create(50);
if (result.ok) {
  const pct: Percentage = result.value;
  console.log(pct.toNumber());  // 50
}

// Ошибка: ниже минимума
const tooLowResult = PercentageService.create(-2000000);
if (!tooLowResult.ok) {
  console.log(tooLowResult.error.context?.op);     // 'create'
  console.log(tooLowResult.error.context?.value);  // '-2000000'
  console.log(tooLowResult.error.context?.reason); // 'OUT_OF_RANGE_LOW'
}

// Ошибка: выше максимума
const tooHighResult = PercentageService.create(2000000);
if (!tooHighResult.ok) {
  console.log(tooHighResult.error.context?.reason); // 'OUT_OF_RANGE_HIGH'
}

// Ошибка: NaN
const nanResult = PercentageService.create(NaN);
if (!nanResult.ok) {
  console.log(nanResult.error.context?.reason);  // 'NAN'
}

// Ошибка: невалидный формат
const invalidResult = PercentageService.create("abc");
if (!invalidResult.ok) {
  console.log(invalidResult.error.context?.reason);       // 'INVALID_FORMAT'
  console.log(invalidResult.error.context?.raw?.field);   // 'value'
  console.log(invalidResult.error.context?.raw?.value);   // 'abc'
}
```

---

#### `fromDecimalFraction(decimal: number | string | Decimal)`

Создаёт Percentage из десятичной дроби (шкала 0-1).

**Сигнатура:**

```typescript
fromDecimalFraction(decimal: number | string | Decimal): Result<Percentage, InvalidPercentageError>
```

**Конвертация:** Умножает на 100 для перевода из шкалы 0-1 в шкалу 0-100.

**Примеры:**

```typescript
const result = PercentageService.fromDecimalFraction(0.5);
if (result.ok) {
  console.log(result.value.toNumber());  // 50
}

const result2 = PercentageService.fromDecimalFraction("0.25");
if (result2.ok) {
  console.log(result2.value.toNumber());  // 25
}

// Ошибка: невалидный формат
const invalidResult = PercentageService.fromDecimalFraction("abc");
if (!invalidResult.ok) {
  console.log(invalidResult.error.context?.op);     // 'fromDecimalFraction'
  console.log(invalidResult.error.context?.reason); // 'INVALID_FORMAT'
}
```

---

#### `fromBasisPoints(basisPoints: number | string | Decimal)`

Создаёт Percentage из базисных пунктов (100 bp = 1%).

**Сигнатура:**

```typescript
fromBasisPoints(basisPoints: number | string | Decimal): Result<Percentage, InvalidPercentageError>
```

**Конвертация:** Делит на 100 для перевода из bp в шкалу 0-100.

**Примеры:**

```typescript
const result = PercentageService.fromBasisPoints(5000);
if (result.ok) {
  console.log(result.value.toNumber());  // 50
}

const result2 = PercentageService.fromBasisPoints("250");
if (result2.ok) {
  console.log(result2.value.toNumber());  // 2.5
}

const result3 = PercentageService.fromBasisPoints(1);
if (result3.ok) {
  console.log(result3.value.toNumber());  // 0.01
}
```

---

### Арифметика

#### `add(a: Percentage, b: Percentage)`

Складывает два процента.

**Сигнатура:**

```typescript
add(a: Percentage, b: Percentage): Result<Percentage, InvalidPercentageError>
```

**Алгоритм:**

1. Операция через @polymarket/math (`addDecimal`)
2. Создание Percentage из результата (проверка инвариантов)
3. Обработка через `wrapOp` из errorUtils

**Примеры:**

```typescript
const pct1 = Percentage.of(25);
const pct2 = Percentage.of(30);

const result = PercentageService.add(pct1, pct2);
if (result.ok) {
  console.log(result.value.toNumber());  // 55
}

// Ошибка: результат выходит за диапазон
const large1 = Percentage.of(500000);
const large2 = Percentage.of(600000);
const overflowResult = PercentageService.add(large1, large2);
if (!overflowResult.ok) {
  // 500000 + 600000 = 1100000 > MAX_PERCENTAGE (1e6)
  console.log(overflowResult.error.context?.op);     // 'add'
  console.log(overflowResult.error.context?.reason); // 'OUT_OF_RANGE_HIGH'
}
```

---

#### `subtract(a: Percentage, b: Percentage)`

Вычитает один процент из другого.

**Сигнатура:**

```typescript
subtract(a: Percentage, b: Percentage): Result<Percentage, InvalidPercentageError>
```

**Алгоритм:**

1. Операция через @polymarket/math (`subtractDecimal`)
2. Создание Percentage из результата (проверка инвариантов)
3. Обработка через `wrapOp` из errorUtils

**Примеры:**

```typescript
const pct1 = Percentage.of(50);
const pct2 = Percentage.of(20);

const result = PercentageService.subtract(pct1, pct2);
if (result.ok) {
  console.log(result.value.toNumber());  // 30
}

// Отрицательный результат - валиден
const result2 = PercentageService.subtract(Percentage.of(25), Percentage.of(75));
if (result2.ok) {
  console.log(result2.value.toNumber());  // -50
}

// Ошибка: результат выходит за диапазон
const large1 = Percentage.of(-500000);
const large2 = Percentage.of(600000);
const underflowResult = PercentageService.subtract(large1, large2);
if (!underflowResult.ok) {
  // -500000 - 600000 = -1100000 < MIN_PERCENTAGE (-1e6)
  console.log(underflowResult.error.context?.reason); // 'OUT_OF_RANGE_LOW'
}
```

---

#### `multiply(pct: Percentage, factor: number | string | Decimal)`

Умножает процент на фактор.

**Сигнатура:**

```typescript
multiply(
  pct: Percentage,
  factor: number | string | Decimal
): Result<Percentage, InvalidPercentageError>
```

**Алгоритм:**

1. Парсинг factor через `toDecimal` из errorUtils
2. Умножение через `multiplyDecimal` из @polymarket/math
3. Создание Percentage из результата
4. Обработка через `wrapOp` из errorUtils

**Примеры:**

```typescript
const pct = Percentage.of(50);

// Успех
const result = PercentageService.multiply(pct, 2);
if (result.ok) {
  console.log(result.value.toNumber());  // 100
}

// Успех: дробный множитель
const result2 = PercentageService.multiply(Percentage.of(60), 0.5);
if (result2.ok) {
  console.log(result2.value.toNumber());  // 30
}

// Ошибка: невалидный формат factor
const invalidResult = PercentageService.multiply(pct, "abc");
if (!invalidResult.ok) {
  console.log(invalidResult.error.context?.op);         // 'multiply'
  console.log(invalidResult.error.context?.raw?.field); // 'factor'
  console.log(invalidResult.error.context?.raw?.value); // 'abc'
  console.log(invalidResult.error.context?.reason);     // 'INVALID_FORMAT'
}

// Ошибка: результат выходит за диапазон
const overflowResult = PercentageService.multiply(Percentage.of(500000), 3);
if (!overflowResult.ok) {
  // 500000 * 3 = 1500000 > MAX_PERCENTAGE
  console.log(overflowResult.error.context?.reason); // 'OUT_OF_RANGE_HIGH'
}
```

---

#### `divide(pct: Percentage, divisor: number | string | Decimal)`

Делит процент на делитель.

**Сигнатура:**

```typescript
divide(
  pct: Percentage,
  divisor: number | string | Decimal
): Result<Percentage, InvalidPercentageError>
```

**Алгоритм:**

1. Парсинг divisor через `toDecimal` из errorUtils
2. Деление через `divideDecimal` из @polymarket/math
3. Создание Percentage из результата
4. Обработка через `wrapOp` из errorUtils

**Обработка ошибок:**

- Ошибки парсинга divisor → InvalidPercentageError с reason: INVALID_FORMAT
- Деление на ноль → ArithmeticOverflowError из @polymarket/math → InvalidPercentageError с cause
- Результат вне диапазона → InvalidPercentageError с reason: OUT_OF_RANGE_*

**Примеры:**

```typescript
const pct = Percentage.of(100);

// Успех
const result = PercentageService.divide(pct, 2);
if (result.ok) {
  console.log(result.value.toNumber());  // 50
}

// Ошибка: деление на ноль
const zeroResult = PercentageService.divide(pct, 0);
if (!zeroResult.ok) {
  console.log(zeroResult.error.context?.op);       // 'divide'
  console.log(zeroResult.error.context?.divisor);  // '0'
  console.log(zeroResult.error.context?.cause?.name); // 'ArithmeticOverflowError'
}

// Ошибка: невалидный формат divisor
const invalidResult = PercentageService.divide(pct, "abc");
if (!invalidResult.ok) {
  console.log(invalidResult.error.context?.reason);     // 'INVALID_FORMAT'
  console.log(invalidResult.error.context?.raw?.field); // 'divisor'
}
```

---

### Специальные операции

#### `applyTo(pct: Percentage, value: Decimal)`

Применяет процент к значению.

**Сигнатура:**

```typescript
applyTo(pct: Percentage, value: Decimal): Result<Decimal, InvalidPercentageError>
```

**Семантика:** Вычисляет `value * (pct / 100)`.

**Возвращает Decimal**, не Percentage, так как результат — это значение, а не процент.

**Примеры:**

```typescript
const fee = Percentage.of(2.5);
const amount = new Decimal(100);

const result = PercentageService.applyTo(fee, amount);
if (result.ok) {
  console.log(result.value.toNumber());  // 2.5 (это сумма комиссии)
}

// Расчёт скидки
const discount = Percentage.of(10);
const price = new Decimal(200);

const discountAmountResult = PercentageService.applyTo(discount, price);
if (discountAmountResult.ok) {
  const discountAmount = discountAmountResult.value;  // Decimal(20)
  const finalPrice = price.minus(discountAmount);     // Decimal(180)
  console.log(finalPrice.toNumber());  // 180
}

// Расчёт прибыли
const returnPct = Percentage.of(25);
const investment = new Decimal(1000);

const profitResult = PercentageService.applyTo(returnPct, investment);
if (profitResult.ok) {
  const profit = profitResult.value;  // Decimal(250)
  console.log(profit.toNumber());  // 250
}
```

---

## Error Handling Patterns

### Базовая обработка

```typescript
const result = PercentageService.create(userInput);

if (!result.ok) {
  console.error(`Failed to create percentage: ${result.error.message}`);
  console.error(`Context:`, result.error.context);
  return;
}

const pct = result.value;
// Используй pct
```

### Специфичная обработка по reason

```typescript
const result = PercentageService.divide(pct, divisor);

if (!result.ok) {
  const ctx = result.error.context;

  switch (ctx?.reason) {
    case 'INVALID_FORMAT':
      console.error('Invalid input format');
      break;
    case 'OUT_OF_RANGE_HIGH':
      console.error('Result too high');
      break;
    case 'OUT_OF_RANGE_LOW':
      console.error('Result too low');
      break;
    default:
      if (ctx?.cause) {
        console.error(`Math error: ${ctx.cause.message}`);
      } else {
        console.error(`Unknown error: ${result.error.message}`);
      }
  }

  return;
}

const quotient = result.value;
```

### Композиция операций

```typescript
function calculateTotalFee(
  makerFee: Percentage,
  takerFee: Percentage
): Result<Percentage, InvalidPercentageError> {
  // 1. Складываем комиссии
  const totalFeeResult = PercentageService.add(makerFee, takerFee);
  if (!totalFeeResult.ok) {
    return totalFeeResult;
  }

  const totalFee = totalFeeResult.value;

  // 2. Валидируем общую комиссию
  const validateResult = ValidateTotalFee.check(totalFee);
  if (!validateResult.ok) {
    return validateResult;
  }

  return Ok(totalFee);
}
```

### Early return pattern

```typescript
function processFees(
  makerFeeInput: string,
  takerFeeInput: string
): Result<{ makerFee: Percentage; takerFee: Percentage; total: Percentage }, InvalidPercentageError> {
  // Создаём maker fee
  const makerResult = PercentageService.create(makerFeeInput);
  if (!makerResult.ok) return makerResult;

  const makerFee = makerResult.value;

  // Валидируем maker fee
  const validateMakerResult = ValidateFeeForTrading.check(makerFee);
  if (!validateMakerResult.ok) return validateMakerResult;

  // Создаём taker fee
  const takerResult = PercentageService.create(takerFeeInput);
  if (!takerResult.ok) return takerResult;

  const takerFee = takerResult.value;

  // Валидируем taker fee
  const validateTakerResult = ValidateFeeForTrading.check(takerFee);
  if (!validateTakerResult.ok) return validateTakerResult;

  // Вычисляем total
  const totalResult = PercentageService.add(makerFee, takerFee);
  if (!totalResult.ok) return totalResult;

  const total = totalResult.value;

  // Валидируем total
  const validateTotalResult = ValidateTotalFee.check(total);
  if (!validateTotalResult.ok) return validateTotalResult;

  return Ok({ makerFee, takerFee, total });
}
```

---

## Best Practices

### ✅ DO: Всегда проверяйте Result

```typescript
// ✅ Хорошо
const result = PercentageService.create(value);
if (!result.ok) {
  // Обработка ошибки
  return;
}
const pct = result.value;
```

### ❌ DON'T: Не игнорируйте ошибки

```typescript
// ❌ Плохо
const result = PercentageService.create(value);
const pct = result.value;  // TypeScript error! result может быть Err
```

---

### ✅ DO: Используйте правильный метод создания

```typescript
// ✅ Хорошо (ясная семантика)
const pct1 = PercentageService.create(50);                    // Ввод пользователя
const pct2 = PercentageService.fromDecimalFraction(0.5);     // API response
const pct3 = PercentageService.fromBasisPoints(5000);        // Финансовая система
```

### ❌ DON'T: Не путайте шкалы

```typescript
// ❌ Плохо (неясная семантика)
const pct = PercentageService.create(0.5);  // Это 0.5% или 50%? (это 0.5%!)
```

---

### ✅ DO: Обрабатывайте специфичные ошибки

```typescript
// ✅ Хорошо
if (!result.ok) {
  switch (result.error.context?.reason) {
    case 'INVALID_FORMAT':
      showUserError('Please enter a valid number');
      break;
    case 'OUT_OF_RANGE_HIGH':
      showUserError('Percentage too high');
      break;
    case 'OUT_OF_RANGE_LOW':
      showUserError('Percentage too low');
      break;
  }
}
```

---

### ✅ DO: Используйте applyTo для расчётов

```typescript
// ✅ Хорошо (ясная семантика)
const feeAmountResult = PercentageService.applyTo(feePct, amount);
```

### ❌ DON'T: Не делайте вручную

```typescript
// ❌ Плохо (может потерять точность)
const feeAmount = amount.toNumber() * (feePct.toNumber() / 100);
```

---

## Performance Tips

### 1. Zero-copy оптимизация

```typescript
// ✅ Быстро (если у вас уже есть Decimal)
const decimal = calculateSomething();  // returns Decimal
const result = PercentageService.create(decimal);  // Использует fromDecimal() внутри
```

### 2. Избегайте повторных проверок

```typescript
// ❌ Медленно
for (const value of values) {
  const result = PercentageService.create(value);
  if (!result.ok) continue;
  // ...
}

// ✅ Быстрее (batch обработка)
const validPercentages = values
  .map(v => PercentageService.create(v))
  .filter(r => r.ok)
  .map(r => r.value);
```

### 3. Переиспользуйте константы

```typescript
// ✅ Хорошо (переиспользуем)
const zero = Percentage.ZERO;
const full = Percentage.ONE_HUNDRED;

for (const pct of percentages) {
  if (pct.equals(zero)) {
    // ...
  }
}

// ❌ Плохо (создаём каждый раз)
for (const pct of percentages) {
  if (pct.equals(Percentage.ZERO)) {  // Percentage.ZERO вызывается в цикле!
    // ...
  }
}
```

---

## Заключение

`PercentageService` обеспечивает:

1. **Type-safe API** через Result<T, E>
2. **Единый Error Contract** для всех операций
3. **Централизованный errorUtils** (toDecimal, wrapOp, rewrap)
4. **Never Throw гарантию** — все ошибки через Result
5. **Композиционность** операций
6. **Performance** через zero-copy и правильные абстракции

Используйте PercentageService как единую точку входа для всех операций с Percentage!
