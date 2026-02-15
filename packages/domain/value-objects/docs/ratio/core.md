# Ratio Core API Reference

Детальная документация методов класса `Ratio`.

## Содержание

- [Обзор](#обзор)
- [Создание](#создание)
- [Методы доступа](#методы-доступа)
- [Вспомогательные методы](#вспомогательные-методы)
- [Методы сравнения](#методы-сравнения)
- [Константы](#константы)
- [Инварианты](#инварианты)

## Обзор

`Ratio` - Core слой value object для представления относительных величин (коэффициентов, долей).

**Ключевые характеристики:**

- ✅ Иммутабельный (все операции возвращают новые значения)
- ✅ Type-safe через Decimal.js
- ✅ Бросает `RatioInvariantViolation` при нарушении инвариантов
- ✅ Private конструктор
- ✅ Минимальная абстракция (только вспомогательные методы)

**⚠️ Важно:** Ratio хранит **дробь (fraction)**, не процент!

- `0.02` = 2% (дробь)
- `2.0` = 200% (дробь, НЕ 2%)
- `1.0` = 100%

## Создание

### `Ratio.of(value)` (Internal)

```typescript
public static of(value: Decimal): Ratio
```

**Описание:**
Создать Ratio из дроби (fraction).

**⚠️ НЕ ИСПОЛЬЗУЙТЕ НАПРЯМУЮ** - это внутренний API для `RatioService`!

**Почему не использовать `.of()` напрямую:**

1. **Непонятная семантика:** `Ratio.of(2)` это 200% или 2%? 🤔
2. **Нет валидации опций:** `ensureGteMinusOne` не проверяется
3. **Бросает исключения:** вместо type-safe Result

**Вместо этого используйте:**

```typescript
// ✅ ПРАВИЛЬНО: Используйте RatioService
RatioService.fromDecimal(0.02)  // явная дробь
RatioService.fromPercent(2)     // явный процент
RatioService.fromBps(200)       // явные basis points
```

**Параметры:**

- `value: Decimal` - Дробь: `0.02` для 2%, `0.5` для 50%

**Возвращает:**

- `Ratio` instance

**Бросает:**

- `RatioInvariantViolation` - если `value` NaN или не finite

**Пример (только для RatioService):**

```typescript
// Внутри RatioService.fromPercent()
const fraction = percent.div(100); // 2 → 0.02
const ratio = Ratio.of(fraction);  // OK - используется в Facade
```

## Методы доступа

### `toDecimal()`

```typescript
public toDecimal(): Decimal
```

**Описание:**
Получить значение как Decimal (fraction).

**Возвращает:**

- `Decimal` - дробь: `0.02` для 2%, `0.5` для 50%

**Примеры:**

```typescript
const ratioResult = RatioService.fromPercent(2); // 2%
if (ratioResult.ok) {
  const decimal = ratioResult.value.toDecimal();
  console.log(decimal.toString()); // "0.02"
}

// Использование в расчетах
const amount = new Decimal(1000);
const feeResult = RatioService.fromPercent(2); // 2% fee
if (feeResult.ok) {
  const fee = amount.mul(feeResult.value.toDecimal());
  console.log(fee.toString()); // "20"
}
```

**Когда использовать:**

- Для прямых вычислений: `amount * ratio.toDecimal()`
- Для взятия процента: `price * ratio.toDecimal()`
- Для получения доли: `total * ratio.toDecimal()`

### `toNumber()`

```typescript
public toNumber(): number
```

**Описание:**
Получить значение как number.

**⚠️ ВНИМАНИЕ: Lossy conversion!**

- Преобразование `Decimal → number` может потерять точность
- Используйте **только для отображения**, НЕ для вычислений

**Возвращает:**

- `number` - дробь: `0.02` для 2%

**Примеры:**

```typescript
const ratioResult = RatioService.fromPercent(2.5);
if (ratioResult.ok) {
  const num = ratioResult.value.toNumber();
  console.log(num); // 0.025
  console.log(typeof num); // "number"
}

// ✅ OK для отображения
const percentage = ratio.toNumber() * 100;
console.log(`${percentage}%`); // "2.5%"

// ❌ НЕ используйте для вычислений
const result = amount * ratio.toNumber(); // Может потерять точность!
```

**Когда использовать:**

- ✅ Отображение в UI
- ✅ Логирование
- ✅ JSON с ограниченной точностью
- ❌ НЕ использовать в математических вычислениях

## Вспомогательные методы

### `onePlus()`

```typescript
public onePlus(): Decimal
```

**Описание:**
Вычислить `(1 + ratio)` для compound operations.

**Возвращает:**

- `Decimal` - значение `(1 + ratio)`

**Когда использовать:**
Операции типа "добавить X процентов":

- `amount * (1 + ratio)` - добавить markup/discount
- `price * (1 + ratio)` - увеличить/уменьшить цену
- `value * (1 + rate)` - применить ставку

**Примеры:**

#### Пример 1: Добавить 10% markup

```typescript
const amount = new Decimal(100);
const markupResult = RatioService.fromPercent(10); // 10% markup

if (markupResult.ok) {
  const markup = markupResult.value;
  console.log(markup.onePlus().toString()); // "1.1"

  // Usage: amount * (1 + markup)
  const newAmount = amount.mul(markup.onePlus());
  console.log(newAmount.toString()); // "110"
}
```

#### Пример 2: Применить отрицательный discount

```typescript
const price = new Decimal(200);
const discountResult = RatioService.fromPercent(-20); // -20% discount

if (discountResult.ok) {
  const discount = discountResult.value;
  console.log(discount.onePlus().toString()); // "0.8"

  // Usage: price * (1 + discount) где discount < 0
  const finalPrice = price.mul(discount.onePlus());
  console.log(finalPrice.toString()); // "160"
}
```

#### Пример 3: Применить рост (rate)

```typescript
const initialValue = new Decimal(1000);
const growthResult = RatioService.fromPercent(15); // 15% growth

if (growthResult.ok) {
  const growth = growthResult.value;
  const finalValue = initialValue.mul(growth.onePlus());
  console.log(finalValue.toString()); // "1150"
}
```

**Математика:**

```typescript
ratio = 0.1  (10%)
onePlus() = 1 + 0.1 = 1.1
amount * onePlus() = 100 * 1.1 = 110
```

### `oneMinus()`

```typescript
public oneMinus(): Decimal
```

**Описание:**
Вычислить `(1 - ratio)` для subtraction operations.

**Возвращает:**

- `Decimal` - значение `(1 - ratio)`

**Когда использовать:**
Операции типа "вычесть X процентов":

- `amount * (1 - ratio)` - вычесть fee/tax/discount
- `price * (1 - ratio)` - взять процент (оставить остаток)
- `value * (1 - loss)` - применить потерю

**Примеры:**

#### Пример 1: Вычесть 2% fee

```typescript
const amount = new Decimal(100);
const feeResult = RatioService.fromPercent(2); // 2% fee

if (feeResult.ok) {
  const fee = feeResult.value;
  console.log(fee.oneMinus().toString()); // "0.98"

  // Usage: amount * (1 - fee) - оставить 98%
  const afterFee = amount.mul(fee.oneMinus());
  console.log(afterFee.toString()); // "98"
}
```

#### Пример 2: Применить 15% discount

```typescript
const price = new Decimal(200);
const discountResult = RatioService.fromPercent(15); // 15% discount

if (discountResult.ok) {
  const discount = discountResult.value;
  console.log(discount.oneMinus().toString()); // "0.85"

  // Usage: price * (1 - discount)
  const finalPrice = price.mul(discount.oneMinus());
  console.log(finalPrice.toString()); // "170"
}
```

#### Пример 3: Вычесть tax

```typescript
const gross = new Decimal(1000);
const taxResult = RatioService.fromPercent(20); // 20% tax

if (taxResult.ok) {
  const tax = taxResult.value;
  const net = gross.mul(tax.oneMinus());
  console.log(net.toString()); // "800" (остается после вычета налога)
}
```

#### Пример 4: Отрицательный ratio (редкий случай)

```typescript
const amount = new Decimal(100);
const negativeRatioResult = RatioService.fromPercent(-10); // -10%

if (negativeRatioResult.ok) {
  const ratio = negativeRatioResult.value;
  console.log(ratio.oneMinus().toString()); // "1.1"

  // 100 * (1 - (-0.1)) = 100 * 1.1 = 110
  const result = amount.mul(ratio.oneMinus());
  console.log(result.toString()); // "110"
}
```

**Математика:**

```typescript
ratio = 0.02  (2% fee)
oneMinus() = 1 - 0.02 = 0.98
amount * oneMinus() = 100 * 0.98 = 98
```

**Сравнение onePlus() vs oneMinus():**

| Операция | Метод | Формула | Пример |
| ---------- | ------- | --------- | -------- |
| Добавить 10% | `onePlus()` | `amount * (1 + 0.1)` | `100 * 1.1 = 110` |
| Вычесть 10% | `oneMinus()` | `amount * (1 - 0.1)` | `100 * 0.9 = 90` |
| Discount -20% | `onePlus()` | `price * (1 + (-0.2))` | `100 * 0.8 = 80` |
| Fee 2% | `oneMinus()` | `amount * (1 - 0.02)` | `100 * 0.98 = 98` |

## Методы сравнения

### `equals(other)`

```typescript
public equals(other: Ratio): boolean
```

**Описание:**
Проверить равенство с другим Ratio.

**Параметры:**

- `other: Ratio` - Другой Ratio для сравнения

**Возвращает:**

- `boolean` - `true` если значения равны

**Примеры:**

```typescript
const r1Result = RatioService.fromDecimal(0.02);
const r2Result = RatioService.fromPercent(2);
const r3Result = RatioService.fromBps(200);

if (r1Result.ok && r2Result.ok && r3Result.ok) {
  console.log(r1Result.value.equals(r2Result.value)); // true
  console.log(r2Result.value.equals(r3Result.value)); // true
  console.log(r1Result.value.equals(r3Result.value)); // true
}

// Разные значения
const r4Result = RatioService.fromPercent(3);
if (r1Result.ok && r4Result.ok) {
  console.log(r1Result.value.equals(r4Result.value)); // false
}
```

**Внутренняя реализация:**
Использует `Decimal.equals()` для точного сравнения.

### `isZero()`

```typescript
public isZero(): boolean
```

**Описание:**
Проверить, равно ли значение нулю.

**Возвращает:**

- `boolean` - `true` если `ratio === 0`

**Примеры:**

```typescript
const zeroResult = RatioService.fromDecimal(0);
if (zeroResult.ok) {
  console.log(zeroResult.value.isZero()); // true
}

const nonZeroResult = RatioService.fromPercent(0.01);
if (nonZeroResult.ok) {
  console.log(nonZeroResult.value.isZero()); // false
}

// Использование константы
console.log(Ratio.ZERO.isZero()); // true
```

**Когда использовать:**

- Проверка нулевой комиссии: `if (fee.isZero()) { /* no fee */ }`
- Проверка нулевого discount: `if (discount.isZero()) { /* no discount */ }`

### `isPositive()`

```typescript
public isPositive(): boolean
```

**Описание:**
Проверить, положительно ли значение.

**Возвращает:**

- `boolean` - `true` если `ratio > 0`

**Примеры:**

```typescript
const markupResult = RatioService.fromPercent(10);
if (markupResult.ok) {
  console.log(markupResult.value.isPositive()); // true
}

const zeroResult = RatioService.fromDecimal(0);
if (zeroResult.ok) {
  console.log(zeroResult.value.isPositive()); // false
}

const discountResult = RatioService.fromPercent(-10);
if (discountResult.ok) {
  console.log(discountResult.value.isPositive()); // false
}
```

**Когда использовать:**

- Проверка положительного markup: `if (markup.isPositive()) { /* increase */ }`
- Валидация: `if (!fee.isPositive() && !fee.isZero()) { /* invalid fee */ }`

### `isNegative()`

```typescript
public isNegative(): boolean
```

**Описание:**
Проверить, отрицательно ли значение.

**Возвращает:**

- `boolean` - `true` если `ratio < 0`

**Примеры:**

```typescript
const discountResult = RatioService.fromPercent(-20);
if (discountResult.ok) {
  console.log(discountResult.value.isNegative()); // true
}

const zeroResult = RatioService.fromDecimal(0);
if (zeroResult.ok) {
  console.log(zeroResult.value.isNegative()); // false
}

const markupResult = RatioService.fromPercent(10);
if (markupResult.ok) {
  console.log(markupResult.value.isNegative()); // false
}
```

**Когда использовать:**

- Проверка discount: `if (ratio.isNegative()) { /* это discount */ }`
- Логика применения: `if (ratio.isNegative()) { applyDiscount() } else { applyMarkup() }`

## Константы

### `Ratio.ZERO`

```typescript
public static readonly ZERO: Ratio
```

**Описание:**
Нулевой коэффициент (0%).

**Значение:** `0` (дробь)

**Примеры:**

```typescript
console.log(Ratio.ZERO.toDecimal().toString()); // "0"
console.log(Ratio.ZERO.isZero()); // true

// Использование в расчетах
const amount = new Decimal(100);
const result = amount.mul(Ratio.ZERO.onePlus()); // 100 * (1 + 0) = 100
console.log(result.toString()); // "100"

// Проверка на zero
const ratioResult = RatioService.fromPercent(0);
if (ratioResult.ok && ratioResult.value.equals(Ratio.ZERO)) {
  console.log('No change');
}
```

**Когда использовать:**

- Default значение: `const fee = options.fee ?? Ratio.ZERO;`
- Сравнение: `if (ratio.equals(Ratio.ZERO)) { /* no fee */ }`
- Тесты: `expect(calculatedRatio.equals(Ratio.ZERO)).toBe(true);`

### `Ratio.ONE`

```typescript
public static readonly ONE: Ratio
```

**Описание:**
Единичный коэффициент (100%).

**Значение:** `1` (дробь) = 100%

**Примеры:**

```typescript
console.log(Ratio.ONE.toDecimal().toString()); // "1"
console.log(Ratio.ONE.toNumber()); // 1

// Использование в расчетах
const amount = new Decimal(100);
const result = amount.mul(Ratio.ONE.onePlus()); // 100 * (1 + 1) = 200
console.log(result.toString()); // "200"

// Взять 100% (всё)
const total = new Decimal(500);
const all = total.mul(Ratio.ONE.toDecimal()); // 500 * 1 = 500
console.log(all.toString()); // "500"
```

**Когда использовать:**

- Взять всё: `amount.mul(Ratio.ONE.toDecimal())`
- 100% markup: `price.mul(Ratio.ONE.onePlus())` (удваивает)
- Сравнение: `if (ratio.equals(Ratio.ONE)) { /* 100% */ }`

## Инварианты

Ratio гарантирует следующие инварианты на уровне Core:

### 1. Значение не NaN

```typescript
// ❌ Бросает RatioInvariantViolation
Ratio.of(new Decimal(NaN));

// Error:
// RatioInvariantViolation: Ratio value cannot be NaN
// reason: RatioErrorReason.NAN
```

**Почему:** NaN не имеет математического смысла для коэффициента.

### 2. Значение конечно (finite)

```typescript
// ❌ Бросает RatioInvariantViolation
Ratio.of(new Decimal(Infinity));
Ratio.of(new Decimal(-Infinity));

// Error:
// RatioInvariantViolation: Ratio value must be finite
// reason: RatioErrorReason.NON_FINITE
```

**Почему:** Infinity не имеет смысла для относительной величины.

### НЕ-инварианты

Что **НЕ** проверяется на уровне Core:

#### 1. Минимальные/максимальные границы

```typescript
// ✅ OK - Core не проверяет границы
const veryLargeResult = RatioService.fromPercent(10000); // 10000% = 100 (дробь)
const veryNegativeResult = RatioService.fromPercent(-500); // -500% = -5 (дробь)
```

**Почему:** Границы зависят от domain context.

**Решение:** Используйте `ensureGteMinusOne` опцию в RatioService:

```typescript
// ✅ Валидация на уровне Rules
const discountResult = RatioService.fromPercent(-150, { ensureGteMinusOne: true });
// Err: ratio < -1 приведет к отрицательному результату
```

#### 2. Парсинг строк

```typescript
// ❌ Core не парсит строки
Ratio.of(new Decimal("2%")); // Decimal.js error!
```

**Решение:** Используйте RatioFormatter:

```typescript
const result = RatioFormatter.parse("2%");
if (result.ok) {
  const ratio = result.value; // Ratio
}
```

#### 3. Валидация precondition для операций

```typescript
// ❌ Core не проверяет контекст использования
const invalidDiscount = Ratio.of(new Decimal(-2)); // -200% - бессмысленный discount
```

**Решение:** Используйте Rules валидацию через RatioService:

```typescript
const result = RatioService.fromDecimal(-2, { ensureGteMinusOne: true });
// Err: -2 < -1 (приведет к отрицательному amount)
```

## Важно: Ratio не содержит арифметических операций

Ratio - это минимальная абстракция. Арифметические операции живут в целевых value objects:

```typescript
// ❌ НЕТ таких методов в Ratio
ratio.add(other)      // нет
ratio.subtract(other) // нет
ratio.multiply(value) // нет
ratio.divide(value)   // нет

// ✅ Операции живут в Money/Price/Quantity
Money.addRate(ratio: Ratio)          // добавить процент к сумме
Price.take(ratio: Ratio)             // взять процент от цены
Quantity.applyDiscount(ratio: Ratio) // применить скидку
```

**Почему:** Операции с процентами имеют смысл только в контексте конкретной величины. См. [Architecture](./architecture.md#почему-нет-арифметических-операций).

## Следующие шаги

- [Facade API Reference](./facade.md) - RatioService factory methods
- [Adapters](./adapters.md) - RatioFormatter и RatioSerializer
- [Examples](./examples.md) - примеры использования в реальных сценариях
