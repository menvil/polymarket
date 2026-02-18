# RatioService API Reference

Детальная документация публичного API для создания Ratio.

## Содержание

- [Обзор](#обзор)
- [Never Throw Contract](#never-throw-contract)
- [Factory Methods](#factory-methods)
  - [fromDecimal()](#fromdecimal)
  - [fromPercent()](#frompercent)
  - [fromBps()](#frombps)
- [Validation Options](#validation-options)
- [Utility Methods](#utility-methods)
- [Error Handling](#error-handling)
- [Best Practices](#best-practices)

## Обзор

`RatioService` - это Facade слой для безопасного создания Ratio value objects.

**Ключевые характеристики:**

- ✅ **Never Throw Contract**: все методы возвращают `Result<T, E>`, никогда не бросают исключения
- ✅ **Type-Safe Errors**: типизированные ошибки через `InvalidRatioError` с `RatioErrorReason`
- ✅ **Multiple Formats**: поддержка decimal, percent, basis points
- ✅ **Optional Validation**: `ensureGteMinusOne` для domain-specific правил
- ✅ **Consistent API**: все методы следуют единому паттерну

**Основной интерфейс:**

```typescript
// Import
import { RatioService } from '@polymarket/value-objects';

// Factory methods
RatioService.fromDecimal(value, options?)   // из дроби
RatioService.fromPercent(percent, options?) // из процента
RatioService.fromBps(bps, options?)         // из basis points

// Utility
RatioService.equals(a, b) // сравнение двух Ratio
```

## Never Throw Contract

**ГАРАНТИЯ:** Все методы RatioService НИКОГДА не бросают исключения.

```typescript
// ✅ ВСЕ методы возвращают Result
const result = RatioService.fromPercent(2);

// Type-safe обработка
if (result.ok) {
  const ratio = result.value; // Type: Ratio
} else {
  const error = result.error; // Type: InvalidRatioError
  console.error(error.message);
  console.error(error.context?.reason); // RatioErrorReason enum
}
```

**Контраст с Core слоем:**

```typescript
// ❌ Core слой БРОСАЕТ исключения
try {
  const ratio = Ratio.of(value); // может бросить RatioInvariantViolation
} catch (error) {
  // ...
}

// ✅ Facade слой возвращает Result
const result = RatioService.fromDecimal(value); // всегда Result, никогда throw
```

## Factory Methods

### `fromDecimal()`

```typescript
public static fromDecimal(
  value: number | string | Decimal,
  options?: RatioCreateOptions
): Result<Ratio, InvalidRatioError>
```

**Описание:**
Создать Ratio из дроби (fraction).

**Параметры:**

- `value: number | string | Decimal` - Дробь: `0.02` для 2%, `0.5` для 50%
- `options?: RatioCreateOptions` - Опции валидации (см. [Validation Options](#validation-options))

**Возвращает:**

- `Ok(Ratio)` - успешно создан Ratio
- `Err(InvalidRatioError)` - ошибка валидации с typed context

**Примеры:**

#### Базовое использование

```typescript
import { RatioService } from '@polymarket/value-objects';

// Из number
const r1 = RatioService.fromDecimal(0.02);
if (r1.ok) {
  console.log(r1.value.toDecimal().toString()); // "0.02"
}

// Из string
const r2 = RatioService.fromDecimal("0.5");
if (r2.ok) {
  console.log(r2.value.toDecimal().toString()); // "0.5"
}

// Из Decimal
import Decimal from 'decimal.js';
const r3 = RatioService.fromDecimal(new Decimal("0.125"));
if (r3.ok) {
  console.log(r3.value.toDecimal().toString()); // "0.125"
}
```

#### С валидацией ensureGteMinusOne

```typescript
// ✅ Корректное значение >= -1
const validRatio = RatioService.fromDecimal(-0.5, { ensureGteMinusOne: true });
if (validRatio.ok) {
  const amount = new Decimal(100);
  const result = amount.mul(validRatio.value.onePlus()); // 100 * 0.5 = 50
  console.log(result.toString()); // "50"
}

// ❌ Некорректное значение < -1
const invalidRatio = RatioService.fromDecimal(-1.5, { ensureGteMinusOne: true });
if (!invalidRatio.ok) {
  console.error(invalidRatio.error.message);
  console.error(invalidRatio.error.context?.reason); // LESS_THAN_MINUS_ONE
}
```

#### Обработка ошибок

```typescript
// NaN
const nanResult = RatioService.fromDecimal(NaN);
if (!nanResult.ok) {
  console.error(nanResult.error.context?.reason); // RatioErrorReason.NAN
}

// Infinity
const infResult = RatioService.fromDecimal(Infinity);
if (!infResult.ok) {
  console.error(infResult.error.context?.reason); // RatioErrorReason.NON_FINITE
}

// Невалидная строка
const invalidResult = RatioService.fromDecimal("not-a-number");
if (!invalidResult.ok) {
  console.error(invalidResult.error.context?.reason); // RatioErrorReason.INVALID_FORMAT
}
```

#### Когда использовать fromDecimal()

Используйте `fromDecimal()` когда:

- ✅ У вас уже есть дробь (`0.02`, `0.5`, `1.0`)
- ✅ Значение из математического вычисления
- ✅ Хотите явно указать, что это дробь

```typescript
// Расчет: (newPrice - oldPrice) / oldPrice
const priceChange = newPrice.minus(oldPrice).div(oldPrice);
const changeRatio = RatioService.fromDecimal(priceChange);
```

### `fromPercent()`

```typescript
public static fromPercent(
  percent: number | string | Decimal,
  options?: RatioCreateOptions
): Result<Ratio, InvalidRatioError>
```

**Описание:**
Создать Ratio из процента (2 для 2%).

**Параметры:**

- `percent: number | string | Decimal` - Процент: `2` для 2%, `50` для 50%
- `options?: RatioCreateOptions` - Опции валидации

**Возвращает:**

- `Ok(Ratio)` - успешно создан Ratio (значение будет `percent / 100`)
- `Err(InvalidRatioError)` - ошибка валидации

**Конверсия:**

```typescript
percent → fraction = percent / 100

2% → 0.02
50% → 0.5
100% → 1.0
-20% → -0.2
```

**Примеры:**

#### Базовое использование

```typescript
// 2%
const r1 = RatioService.fromPercent(2);
if (r1.ok) {
  console.log(r1.value.toDecimal().toString()); // "0.02"
}

// 50%
const r2 = RatioService.fromPercent(50);
if (r2.ok) {
  console.log(r2.value.toDecimal().toString()); // "0.5"
}

// 100%
const r3 = RatioService.fromPercent(100);
if (r3.ok) {
  console.log(r3.value.toDecimal().toString()); // "1"
  console.log(r3.value.equals(Ratio.ONE)); // true
}
```

#### Отрицательные проценты (discount)

```typescript
// -20% discount
const discountResult = RatioService.fromPercent(-20);
if (discountResult.ok) {
  const discount = discountResult.value;
  console.log(discount.toDecimal().toString()); // "-0.2"

  // Применить: amount * (1 + (-0.2)) = amount * 0.8
  const amount = new Decimal(100);
  const afterDiscount = amount.mul(discount.onePlus());
  console.log(afterDiscount.toString()); // "80"
}
```

#### Markup >100%

```typescript
// 200% markup (утроить цену)
const markupResult = RatioService.fromPercent(200);
if (markupResult.ok) {
  const markup = markupResult.value;
  console.log(markup.toDecimal().toString()); // "2"

  // Применить: price * (1 + 2) = price * 3
  const price = new Decimal(100);
  const newPrice = price.mul(markup.onePlus());
  console.log(newPrice.toString()); // "300"
}
```

#### С валидацией

```typescript
// ✅ Корректный discount
const validDiscount = RatioService.fromPercent(-50, { ensureGteMinusOne: true });
// OK: -50% => -0.5, и -0.5 >= -1

// ❌ Некорректный discount
const invalidDiscount = RatioService.fromPercent(-150, { ensureGteMinusOne: true });
// Err: -150% => -1.5, и -1.5 < -1
if (!invalidDiscount.ok) {
  console.error(invalidDiscount.error.context?.reason); // LESS_THAN_MINUS_ONE
}
```

#### Когда использовать fromPercent()

Используйте `fromPercent()` когда:

- ✅ Пользовательский ввод в процентах
- ✅ Конфигурация/настройки (fee: 2%)
- ✅ Отображение в UI (2%, 50%, 100%)
- ✅ Бизнес-логика оперирует процентами

```typescript
// Пример: fee из конфигурации
const config = { transactionFeePercent: 2.5 };
const feeResult = RatioService.fromPercent(config.transactionFeePercent);
```

### `fromBps()`

```typescript
public static fromBps(
  bps: number | string | Decimal,
  options?: RatioCreateOptions
): Result<Ratio, InvalidRatioError>
```

**Описание:**
Создать Ratio из basis points (200 для 2%).

**Параметры:**

- `bps: number | string | Decimal` - Basis points: `200` для 2%, `100` для 1%
- `options?: RatioCreateOptions` - Опции валидации

**Возвращает:**

- `Ok(Ratio)` - успешно создан Ratio (значение будет `bps / 10000`)
- `Err(InvalidRatioError)` - ошибка валидации

**Конверсия:**

```typescript
bps → fraction = bps / 10000

1 bps → 0.0001 (0.01%)
100 bps → 0.01 (1%)
200 bps → 0.02 (2%)
10000 bps → 1.0 (100%)
```

**Справка:** 1 basis point (bps) = 0.01% = 0.0001 (дробь)

**Примеры:**

#### Базовое использование

```typescript
// 200 bps = 2%
const r1 = RatioService.fromBps(200);
if (r1.ok) {
  console.log(r1.value.toDecimal().toString()); // "0.02"
}

// 1 bps = 0.01%
const r2 = RatioService.fromBps(1);
if (r2.ok) {
  console.log(r2.value.toDecimal().toString()); // "0.0001"
}

// 10000 bps = 100%
const r3 = RatioService.fromBps(10000);
if (r3.ok) {
  console.log(r3.value.toDecimal().toString()); // "1"
  console.log(r3.value.equals(Ratio.ONE)); // true
}
```

#### Финансовые rates

```typescript
// Spread 50 bps
const spreadResult = RatioService.fromBps(50);
if (spreadResult.ok) {
  const spread = spreadResult.value;
  console.log(spread.toDecimal().toString()); // "0.005" (0.5%)

  // Применить spread к цене
  const midPrice = new Decimal(100);
  const ask = midPrice.mul(spread.onePlus()); // 100 * 1.005 = 100.5
  console.log(ask.toString()); // "100.5"
}
```

#### Отрицательные bps

```typescript
// -50 bps (negative spread)
const negSpreadResult = RatioService.fromBps(-50);
if (negSpreadResult.ok) {
  const negSpread = negSpreadResult.value;
  console.log(negSpread.toDecimal().toString()); // "-0.005"

  const midPrice = new Decimal(100);
  const bid = midPrice.mul(negSpread.onePlus()); // 100 * 0.995 = 99.5
  console.log(bid.toString()); // "99.5"
}
```

#### Когда использовать fromBps()

Используйте `fromBps()` когда:

- ✅ Финансовые инструменты (rates, spreads, yields)
- ✅ Высокоточные коэффициенты
- ✅ Данные из trading APIs (часто используют bps)
- ✅ Малые изменения (< 1%)

```typescript
// Пример: bond yield
const bondYieldBps = 325; // 3.25%
const yieldResult = RatioService.fromBps(bondYieldBps);
if (yieldResult.ok) {
  console.log(`Yield: ${yieldResult.value.toDecimal().mul(100)}%`); // "3.25%"
}
```

## Validation Options

### `RatioCreateOptions`

```typescript
interface RatioCreateOptions {
  ensureGteMinusOne?: boolean; // валидировать ratio >= -1
  ensureLteOne?: boolean;      // валидировать ratio <= 1
}
```

### `ensureGteMinusOne`

**Описание:**
Проверить, что `ratio >= -1`.

**Зачем:** Защита от бессмысленных операций.

**Проблема:**

```typescript
// Если ratio < -1, то операция (1 + ratio) даст отрицательный результат
const amount = new Decimal(100);
const ratio = -1.5; // -150%
const result = amount.mul(new Decimal(1).plus(ratio)); // 100 * (1 + (-1.5)) = 100 * (-0.5) = -50
// ❌ Отрицательная сумма! Бессмысленно для amount/price
```

**Решение:**

```typescript
const ratioResult = RatioService.fromPercent(-150, { ensureGteMinusOne: true });
if (!ratioResult.ok) {
  // Ошибка: ratio < -1 приведет к отрицательному результату
  console.error(ratioResult.error.context?.reason); // LESS_THAN_MINUS_ONE
}
```

**Когда использовать:**

#### ✅ Используйте ensureGteMinusOne

Для операций типа `amount * (1 + ratio)`:

```typescript
// Markup/Discount применяемый к amount
const markupResult = RatioService.fromPercent(10, { ensureGteMinusOne: true });

// Price adjustment
const adjustmentResult = RatioService.fromDecimal(-0.2, { ensureGteMinusOne: true });

// Fee/Tax (обычно положительные, но может быть refund)
const feeResult = RatioService.fromPercent(2, { ensureGteMinusOne: true });
```

#### ❌ НЕ используйте ensureGteMinusOne

Для других операций:

```typescript
// Просто процент от суммы (не применяется (1 + ratio))
const commissionResult = RatioService.fromPercent(2); // amount * 0.02 - OK без валидации

// Доля портфеля (может быть любой)
const allocationResult = RatioService.fromDecimal(0.35); // 35% портфеля - OK

// Change rate (может быть < -1 теоретически)
const changeResult = RatioService.fromPercent(-200); // -200% change - OK (полная потеря + еще)
```

**Граничные случаи:**

```typescript
// ratio = -1 (граница) - OK
const boundaryResult = RatioService.fromPercent(-100, { ensureGteMinusOne: true });
if (boundaryResult.ok) {
  const amount = new Decimal(100);
  const result = amount.mul(boundaryResult.value.onePlus()); // 100 * (1 + (-1)) = 0
  console.log(result.toString()); // "0" - корректно
}

// ratio = -1.0001 (чуть меньше) - Err
const belowBoundaryResult = RatioService.fromDecimal(-1.0001, { ensureGteMinusOne: true });
if (!belowBoundaryResult.ok) {
  console.error('Invalid: would result in negative amount');
}
```

---

### `ensureLteOne`

**Описание:**
Проверить, что `ratio <= 1`.

**Зачем:** Защита от бессмысленных операций типа `(1 - ratio)`.

**Проблема:**

```typescript
// Если ratio > 1, то операция (1 - ratio) даст отрицательный результат
const amount = new Decimal(100);
const ratio = 1.5; // 150%
const result = amount.mul(new Decimal(1).minus(ratio)); // 100 * (1 - 1.5) = 100 * (-0.5) = -50
// ❌ Отрицательная сумма! Бессмысленно для amount/price
```

**Решение:**

```typescript
const ratioResult = RatioService.fromPercent(150, { ensureLteOne: true });
if (!ratioResult.ok) {
  // Ошибка: ratio > 1 приведет к отрицательному результату
  console.error(ratioResult.error.context?.reason); // GREATER_THAN_ONE
}
```

**Когда использовать:**

#### ✅ Используйте ensureLteOne

Для операций типа `amount * (1 - ratio)`:

```typescript
// Discount применяемый к amount
const discountResult = RatioService.fromPercent(15, { ensureLteOne: true });
if (discountResult.ok) {
  const amount = new Decimal(100);
  const discounted = amount.mul(discountResult.value.oneMinus()); // 100 * 0.85 = 85
}

// Fee deduction
const feeResult = RatioService.fromPercent(2.5, { ensureLteOne: true });
if (feeResult.ok) {
  const gross = new Decimal(1000);
  const net = gross.mul(feeResult.value.oneMinus()); // 1000 * 0.975 = 975
}
```

#### ❌ НЕ используйте ensureLteOne

Для операций где ratio > 1 допустим:

```typescript
// ❌ Markup может быть > 100%
const markupResult = RatioService.fromPercent(200, { ensureLteOne: true });
// Err! Но markup 200% вполне допустим для (1 + ratio) операций

// ✅ Правильно - используйте ensureGteMinusOne вместо ensureLteOne
const markupResult = RatioService.fromPercent(200, { ensureGteMinusOne: true });
if (markupResult.ok) {
  const cost = new Decimal(100);
  const price = cost.mul(markupResult.value.onePlus()); // 100 * 3 = 300 ✅
}
```

**Граничный случай:**

```typescript
// ratio = 1.0 (ровно граница) - Ok
const boundaryResult = RatioService.fromDecimal(1.0, { ensureLteOne: true });
if (boundaryResult.ok) {
  const amount = new Decimal(100);
  const result = amount.mul(boundaryResult.value.oneMinus());
  console.log(result.toString()); // "0" - корректно
}

// ratio = 1.0001 (чуть больше) - Err
const aboveBoundaryResult = RatioService.fromDecimal(1.0001, { ensureLteOne: true });
if (!aboveBoundaryResult.ok) {
  console.error('Invalid: would result in negative amount');
}
```

---

## Utility Methods

### `equals()`

```typescript
public static equals(a: Ratio, b: Ratio): boolean
```

**Описание:**
Проверить равенство двух Ratio.

**Параметры:**

- `a: Ratio` - Первый Ratio
- `b: Ratio` - Второй Ratio

**Возвращает:**

- `boolean` - `true` если значения равны, `false` если различны

**Never Throw Contract:**
Гарантированно не бросает исключений. Если `a` или `b` равны null/undefined, возвращает `false`.

**Примеры:**

```typescript
// Сравнение разных форматов
const r1 = RatioService.fromPercent(2);
const r2 = RatioService.fromDecimal(0.02);
const r3 = RatioService.fromBps(200);

if (r1.ok && r2.ok && r3.ok) {
  const eq1 = RatioService.equals(r1.value, r2.value);
  console.log(eq1); // true

  const eq2 = RatioService.equals(r2.value, r3.value);
  console.log(eq2); // true
}

// Сравнение с константой
const zeroResult = RatioService.fromDecimal(0);
if (zeroResult.ok) {
  const isZero = RatioService.equals(zeroResult.value, Ratio.ZERO);
  console.log(isZero); // true
}

// Never throws
RatioService.equals(null as any, Ratio.ZERO); // false (не бросает)
```

**Альтернатива:**
Можно использовать метод `.equals()` на самом Ratio:

```typescript
if (r1.ok && r2.ok) {
  console.log(r1.value.equals(r2.value)); // Эквивалентно RatioService.equals()
}
```

## Error Handling

### Error Structure

Все ошибки от RatioService имеют структурированный контекст:

```typescript
interface InvalidRatioError {
  message: string;
  context?: {
    source: ErrorSource;         // PARSING | CORE_INVARIANT | RULE_VALIDATION
    op: string;                  // 'fromPercent' | 'fromDecimal' | 'fromBps'
    service: string;             // 'RatioService'
    reason: RatioErrorReason;    // Typed enum (см. ниже)
    ratioValue?: string;         // Значение, вызвавшее ошибку
    raw?: {                      // Сырые входные данные
      field: string;             // Имя поля ('percent', 'bps', 'decimal')
      value: string;             // Исходное значение
    };
  };
}
```

### RatioErrorReason

```typescript
enum RatioErrorReason {
  NAN = 'NAN',                           // Значение NaN
  NON_FINITE = 'NON_FINITE',             // Значение Infinity/-Infinity
  INVALID_FORMAT = 'INVALID_FORMAT',     // Невалидная строка/число
  LESS_THAN_MINUS_ONE = 'LESS_THAN_MINUS_ONE', // ratio < -1 (с ensureGteMinusOne)
  GREATER_THAN_ONE = 'GREATER_THAN_ONE', // ratio > 1 (с ensureLteOne)
  DECIMAL_ERROR = 'DECIMAL_ERROR'        // Ошибка Decimal.js
}
```

### Error Handling Patterns

#### Pattern 1: Early Return

```typescript
const ratioResult = RatioService.fromPercent(userInput);
if (!ratioResult.ok) {
  console.error('Invalid ratio:', ratioResult.error.message);
  return; // или throw, или другая обработка
}

// Продолжаем с ratioResult.value
const ratio = ratioResult.value;
```

#### Pattern 2: Exhaustive Error Checking

```typescript
const result = RatioService.fromDecimal(value, { ensureGteMinusOne: true });

if (!result.ok) {
  const { reason } = result.error.context ?? {};

  switch (reason) {
    case RatioErrorReason.NAN:
      console.error('Value is NaN');
      break;
    case RatioErrorReason.NON_FINITE:
      console.error('Value is Infinity');
      break;
    case RatioErrorReason.LESS_THAN_MINUS_ONE:
      console.error('Ratio must be >= -1 for this operation');
      break;
    case RatioErrorReason.GREATER_THAN_ONE:
      console.error('Ratio must be <= 1 for this operation');
      break;
    case RatioErrorReason.INVALID_FORMAT:
      console.error('Invalid input format');
      break;
    default:
      console.error('Unexpected error');
  }
}
```

#### Pattern 3: Mapping to Domain Errors

```typescript
function createFeeRatio(feePercent: number): Result<Ratio, DomainError> {
  const ratioResult = RatioService.fromPercent(feePercent, { ensureGteMinusOne: true });

  if (!ratioResult.ok) {
    // Преобразовать InvalidRatioError в DomainError
    return Err(new InvalidFeeError(
      `Fee ${feePercent}% is invalid`,
      { originalError: ratioResult.error }
    ));
  }

  return Ok(ratioResult.value);
}
```

#### Pattern 4: Fallback to Default

```typescript
function getRatioOrDefault(input: unknown): Ratio {
  const result = RatioService.fromDecimal(input);

  if (result.ok) {
    return result.value;
  } else {
    console.warn('Invalid ratio, using ZERO:', result.error.message);
    return Ratio.ZERO;
  }
}
```

## Best Practices

### 1. Всегда используйте RatioService для создания

```typescript
// ✅ ПРАВИЛЬНО
const ratioResult = RatioService.fromPercent(2);

// ❌ НЕПРАВИЛЬНО: не используйте Ratio.of() напрямую
const ratio = Ratio.of(new Decimal(0.02)); // @internal API!
```

**Почему:**

- Семантическая ясность (`fromPercent(2)` vs `of(0.02)` - что это?)
- Type-safe errors через Result
- Опциональная валидация (ensureGteMinusOne)

### 2. Выбирайте правильный factory method

```typescript
// ✅ Данные в процентах → fromPercent()
const config = { feePercent: 2.5 };
const fee = RatioService.fromPercent(config.feePercent);

// ✅ Данные в bps → fromBps()
const spread = RatioService.fromBps(50);

// ✅ Результат вычислений → fromDecimal()
const changeRatio = newValue.minus(oldValue).div(oldValue);
const change = RatioService.fromDecimal(changeRatio);
```

### 3. Используйте ensureGteMinusOne для операций (1 + ratio)

```typescript
// ✅ С валидацией для amount * (1 + ratio)
const adjustmentResult = RatioService.fromPercent(userInput, { ensureGteMinusOne: true });

// ✅ Без валидации для amount * ratio
const commissionResult = RatioService.fromPercent(2); // просто процент от суммы
```

### 4. Обрабатывайте ошибки явно

```typescript
// ✅ ПРАВИЛЬНО: проверяем result.ok
const result = RatioService.fromPercent(input);
if (!result.ok) {
  // обработка ошибки
  return;
}
const ratio = result.value;

// ❌ НЕПРАВИЛЬНО: игнорирование ошибок
const ratio = RatioService.fromPercent(input).value; // может быть undefined!
```

### 5. Документируйте семантику в коде

```typescript
// ✅ Ясная семантика через имя метода
const feeRatio = RatioService.fromPercent(2); // 2% fee

// ❌ Неясная семантика
const ratio = RatioService.fromDecimal(0.02); // Это fee? discount? что?
```

### 6. Используйте константы где уместно

```typescript
// ✅ Используйте константы вместо создания
const noFee = Ratio.ZERO; // вместо RatioService.fromPercent(0)
const doubleAmount = Ratio.ONE; // вместо RatioService.fromPercent(100)

// ✅ Создавайте новые Ratio только для динамических значений
const dynamicFee = RatioService.fromPercent(config.feePercent);
```

## Примеры полных workflow

### Workflow 1: User Input → Validation → Calculation

```typescript
function applyDiscount(
  price: Decimal,
  discountPercent: number
): Result<Decimal, InvalidRatioError> {
  // Создать Ratio из пользовательского ввода
  const discountResult = RatioService.fromPercent(discountPercent, {
    ensureLteOne: true
  });

  if (!discountResult.ok) {
    return Err(discountResult.error);
  }

  // Применить discount: price * (1 - discount)
  const finalPrice = price.mul(discountResult.value.oneMinus());
  return Ok(finalPrice);
}

// Usage
const result = applyDiscount(new Decimal(100), 20);
if (result.ok) {
  console.log(`Final price: ${result.value}`); // "80"
}
```

### Workflow 2: Configuration → Service → Domain Logic

```typescript
interface TradingConfig {
  makerFeePercent: number;
  takerFeePercent: number;
  maxSlippageBps: number;
}

class TradingService {
  private makerFee: Ratio;
  private takerFee: Ratio;
  private maxSlippage: Ratio;

  constructor(config: TradingConfig) {
    // Инициализация из конфигурации
    const makerResult = RatioService.fromPercent(config.makerFeePercent);
    const takerResult = RatioService.fromPercent(config.takerFeePercent);
    const slippageResult = RatioService.fromBps(config.maxSlippageBps);

    if (!makerResult.ok || !takerResult.ok || !slippageResult.ok) {
      throw new Error('Invalid trading configuration');
    }

    this.makerFee = makerResult.value;
    this.takerFee = takerResult.value;
    this.maxSlippage = slippageResult.value;
  }

  calculateMakerFee(amount: Decimal): Decimal {
    return amount.mul(this.makerFee.toDecimal());
  }

  calculateTakerFee(amount: Decimal): Decimal {
    return amount.mul(this.takerFee.toDecimal());
  }

  getMaxSlippagePrice(basePrice: Decimal): Decimal {
    return basePrice.mul(this.maxSlippage.onePlus());
  }
}
```

### Workflow 3: API Response → Parse → Display

```typescript
interface ApiPriceData {
  price: string;
  change24hPercent: string;
}

async function fetchAndDisplayPrice(symbol: string) {
  const data: ApiPriceData = await fetchPriceApi(symbol);

  // Parse change ratio
  const changeResult = RatioService.fromPercent(data.change24hPercent);

  if (!changeResult.ok) {
    console.error('Invalid change data:', changeResult.error);
    return;
  }

  const change = changeResult.value;

  // Format для отображения
  const changePercent = change.toDecimal().mul(100);
  const direction = change.isPositive() ? '📈' : change.isNegative() ? '📉' : '➡️';

  console.log(`${symbol}: $${data.price} ${direction} ${changePercent.toFixed(2)}%`);
}
```

## Следующие шаги

- [Core API Reference](./core.md) - детальная документация Ratio class
- [Adapters](./adapters.md) - RatioFormatter и RatioSerializer
- [Examples](./examples.md) - больше примеров использования
