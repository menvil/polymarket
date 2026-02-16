# Facade Layer — PriceService API

> Единая точка входа для всех операций с Price

## Обзор

`PriceService` — это фасад, который предоставляет type-safe API для работы с Price через `Result<T, E>`.

**Все методы возвращают `Result<T, InvalidPriceError>`** (где T - Price или void для проверочных методов).

PriceService НИКОГДА не бросает исключения. Все ошибки возвращаются через Result с InvalidPriceError, который содержит в context детальную информацию о причине ошибки.

---

## Facade Error Contract

Все ошибки из `PriceService` содержат стандартный контекст:

```typescript
interface InvalidPriceErrorContext {
  op?: string;  // Название операции: 'create', 'complement', 'divide', etc.
  field?: string;  // Поле с ошибкой: 'price', 'tickSize', etc.

  // Входные данные
  value?: string;
  price?: string;
  price1?: string;
  price2?: string;
  divisor?: string;
  factor?: string;
  tickSize?: string;
  mode?: 'nearest' | 'floor' | 'ceil';

  // Причина ошибки
  reason?: string;  // 'not_aligned', 'is_nan', 'is_zero', 'not_positive', etc.

  // Для math exceptions
  cause?: {
    name: string;     // 'ArithmeticOverflowError', etc.
    message: string;
  };
}
```

**Пример использования:**

```typescript
const result = PriceService.divide(price, 0);
if (!result.ok) {
  console.log(result.error.context?.op);       // 'divide'
  console.log(result.error.context?.divisor);  // '0'
  console.log(result.error.context?.reason);   // 'is_zero'
}
```

---

## API Методы

### Создание

#### `create(value: number | string | Decimal)`

Создаёт Price с валидацией инвариантов.

**Сигнатура:**

```typescript
create(value: number | string | Decimal): Result<Price, InvalidPriceError>
```

**Инварианты проверяются автоматически:**

- finite (не NaN, не Infinity)
- диапазон [0.0001, 0.9999]

**Оптимизация:** Если `value` уже `Decimal`, Price.of() использует его напрямую без повторного парсинга (zero-copy).

**Примеры:**

```typescript
// Успех
const result = PriceService.create(0.5);
if (result.ok) {
  const price: Price = result.value;
  console.log(price.toNumber());  // 0.5
}

// Ошибка: ниже минимума
const tooLowResult = PriceService.create(0.00001);
if (!tooLowResult.ok) {
  console.log(tooLowResult.error.context?.op);     // 'create'
  console.log(tooLowResult.error.context?.value);  // '0.00001'
}

// Ошибка: выше максимума
const tooHighResult = PriceService.create(1.5);
if (!tooHighResult.ok) {
  console.log(tooHighResult.error.context?.value); // '1.5'
}

// Ошибка: NaN
const nanResult = PriceService.create(NaN);
if (!nanResult.ok) {
  console.log(nanResult.error.message);  // "Invalid Decimal argument ..."
}
```

---

### Арифметика

#### `multiply(price: Price, factor: number | string | Decimal)`

Умножает цену на коэффициент.

**Сигнатура:**

```typescript
multiply(
  price: Price,
  factor: number | string | Decimal
): Result<Price, InvalidPriceError>
```

**Алгоритм:**

1. Парсинг factor в Decimal (try/catch для parse errors)
2. Валидация factor через `ValidateFactorForPriceMultiplication` (isNaN, isFinite, isNegative)
3. Умножение через `multiplyDecimal()` из @polymarket/math
4. Создание Price из результата

**Обработка ошибок:**

- Ошибки парсинга factor → `InvalidPriceError` (reason в context)
- Невалидный factor (через rule) → `InvalidPriceError` (reason в context)
- Результат вне диапазона Price → `InvalidPriceError` (reason в context)

**Примеры:**

```typescript
import Decimal from 'decimal.js';
import { Price } from '../core/Price.js';

// Создаём цену (в реальном коде используйте PriceService.create)
const price = Price.of(new Decimal(0.3));

// Успех
const result = PriceService.multiply(price, 2);
if (result.ok) {
  console.log(result.value.toNumber());  // 0.6
}

// Успех: дробный множитель
const price2 = Price.of(new Decimal(0.6));
const result2 = PriceService.multiply(price2, 0.5);
if (result2.ok) {
  console.log(result2.value.toNumber());  // 0.3
}

// Ошибка: невалидный factor (NaN)
const nanResult = PriceService.multiply(price, NaN);
if (!nanResult.ok) {
  console.log(nanResult.error.context?.op);         // 'multiply'
  console.log(nanResult.error.context?.raw?.field); // 'factor'
  console.log(nanResult.error.context?.raw?.value); // 'NaN'
  console.log(nanResult.error.context?.reason);     // PriceErrorReason.NAN
}

// Ошибка: результат выходит за диапазон
const price3 = Price.of(new Decimal(0.5));
const overflowResult = PriceService.multiply(price3, 2);
if (!overflowResult.ok) {
  // 0.5 * 2 = 1.0 > MAX_PRICE (0.9999)
  console.log(overflowResult.error.context?.op);  // 'multiply'
}
```

---

#### `divide(price: Price, divisor: number | string | Decimal)`

Делит цену на делитель.

**Сигнатура:**

```typescript
divide(
  price: Price,
  divisor: number | string | Decimal
): Result<Price, InvalidPriceError>
```

**Алгоритм:**

1. Парсинг divisor в Decimal (try/catch для parse errors)
2. Валидация divisor через `ValidateDivisorForPriceDivision` (isNaN, isFinite, isZero, isNegative)
3. Деление через `divideDecimal()` из @polymarket/math
4. Создание Price из результата

**Обработка ошибок:**

- Ошибки парсинга divisor → `InvalidPriceError` (reason в context)
- Невалидный divisor (через rule: NaN, Infinity, Zero) → `InvalidPriceError` (reason в context)
- `ArithmeticOverflowError` из divideDecimal → `InvalidPriceError` с причиной в context.cause
- Неожиданные ошибки → `InvalidPriceError` с полным контекстом
- Результат вне диапазона Price → `InvalidPriceError` (reason в context)

**Примеры:**

```typescript
const price = Price.of(new Decimal(0.6));

// Успех
const result = PriceService.divide(price, 2);
if (result.ok) {
  console.log(result.value.toNumber());  // 0.3
}

// Ошибка: деление на ноль
const zeroResult = PriceService.divide(price, 0);
if (!zeroResult.ok) {
  console.log(zeroResult.error.context?.op);       // 'divide'
  console.log(zeroResult.error.context?.divisor);  // '0'
  console.log(zeroResult.error.context?.reason);   // 'is_zero'
}

// Ошибка: невалидный divisor (NaN)
const nanResult = PriceService.divide(price, NaN);
if (!nanResult.ok) {
  console.log(nanResult.error.context?.reason);  // 'is_nan'
}

// Ошибка: результат выходит за диапазон
const underflowResult = PriceService.divide(Price.MIN, 2);
if (!underflowResult.ok) {
  // 0.0001 / 2 = 0.00005 < MIN_PRICE
  console.log(underflowResult.error.context?.op);  // 'divide'
}
```

---

### Polymarket-специфичные операции

#### `complement(price: Price)`

Вычисляет дополнение до 1 (complement = 1 - price).

**Сигнатура:**

```typescript
complement(price: Price): Result<Price, InvalidPriceError>
```

**Семантика:** Для YES/NO рынков, если YES цена = 0.65, то NO цена = complement(0.65) = 0.35.

**Примеры:**

```typescript
const yesPrice = Price.of(new Decimal(0.65));

const noResult = PriceService.complement(yesPrice);
if (noResult.ok) {
  console.log(noResult.value.toNumber());  // 0.35
}

// Симметричность
const halfPrice = Price.HALF;
const compResult = PriceService.complement(halfPrice);
if (compResult.ok) {
  console.log(compResult.value.equals(halfPrice));  // true (0.5 = 1 - 0.5)
}

// Граничные случаи
const minCompResult = PriceService.complement(Price.MIN);
if (minCompResult.ok) {
  console.log(minCompResult.value.toNumber());  // 0.9999 (= MAX_PRICE)
}

const maxCompResult = PriceService.complement(Price.MAX);
if (maxCompResult.ok) {
  console.log(maxCompResult.value.toNumber());  // 0.0001 (= MIN_PRICE)
}
```

---

#### `average(price1: Price, price2: Price)`

Вычисляет среднее двух цен (mid price).

**Сигнатура:**

```typescript
average(price1: Price, price2: Price): Result<Price, InvalidPriceError>
```

**Семантика:** Вычисляет mid price между bid и ask.

**Примеры:**

```typescript
const bidPrice = Price.of(new Decimal(0.64));
const askPrice = Price.of(new Decimal(0.66));

const midResult = PriceService.average(bidPrice, askPrice);
if (midResult.ok) {
  console.log(midResult.value.toNumber());  // 0.65
}

// Граничные случаи
const extremeResult = PriceService.average(Price.MIN, Price.MAX);
if (extremeResult.ok) {
  console.log(extremeResult.value.toNumber());  // ~0.5
}

// Одинаковые цены
const sameResult = PriceService.average(Price.HALF, Price.HALF);
if (sameResult.ok) {
  console.log(sameResult.value.equals(Price.HALF));  // true
}
```

---

### Округление и выравнивание

#### `roundToMarketTick(price, tickSize, mode?)`

Округляет цену к market tick с заданным режимом.

**Сигнатура:**

```typescript
roundToMarketTick(
  price: Price,
  tickSize: number | string | Decimal,
  mode: 'nearest' | 'floor' | 'ceil' = 'nearest'
): Result<Price, InvalidPriceError>
```

**Режимы округления:**

- `'nearest'` — к ближайшему тику (по умолчанию, используется `ROUND_HALF_UP`)
- `'floor'` — вниз (используй для bid price)
- `'ceil'` — вверх (используй для ask price)

**КРИТИЧНО:** tickSize **ДОЛЖЕН быть кратен** базовому тику (0.0001). Используется `ValidateTickSizeMultipleOfBaseTick`.

**Алгоритм:**

1. Валидация tickSize через `ValidateTickSizeMultipleOfBaseTick` (проверка кратности базовому тику)
2. Выбор направления округления (nearest/floor/ceil)
3. Округление через @polymarket/math функции (roundToTick/floorToTick/ceilToTick)
4. Создание Price из округлённого значения

**Обработка ошибок:**

- Невалидный tickSize → `InvalidPriceError` (reason в context)
- tickSize не кратен 0.0001 → `InvalidPriceError` (reason в context)
- `ArithmeticOverflowError` из math → `InvalidPriceError` с причиной в context.cause
- Неожиданные ошибки → `InvalidPriceError` с полным контекстом
- Результат вне диапазона → `InvalidPriceError`

**КОНТРАКТ:** Результат **ДОЛЖЕН** проходить `ValidateAligned.check()`.

**Примеры:**

```typescript
const calculated = Price.of(new Decimal(0.6543));

// Округление к ближайшему (по умолчанию)
const nearestResult = PriceService.roundToMarketTick(calculated, 0.01);
if (nearestResult.ok) {
  console.log(nearestResult.value.toNumber());  // 0.65
}

// Округление вниз (для bid)
const floorResult = PriceService.roundToMarketTick(calculated, 0.01, 'floor');
if (floorResult.ok) {
  console.log(floorResult.value.toNumber());  // 0.65
}

// Округление вверх (для ask)
const ceilResult = PriceService.roundToMarketTick(calculated, 0.01, 'ceil');
if (ceilResult.ok) {
  console.log(ceilResult.value.toNumber());  // 0.66
}

// Разные tick sizes (все кратны 0.0001)
const p = Price.of(new Decimal(0.12345));

const tick1 = PriceService.roundToMarketTick(p, 0.001);
if (tick1.ok) {
  console.log(tick1.value.toNumber());  // 0.123
}

const tick2 = PriceService.roundToMarketTick(p, 0.01);
if (tick2.ok) {
  console.log(tick2.value.toNumber());  // 0.12
}

const tick3 = PriceService.roundToMarketTick(p, 0.1);
if (tick3.ok) {
  console.log(tick3.value.toNumber());  // 0.1
}

// Ошибка: tickSize не кратен базовому тику
const invalidTickResult = PriceService.roundToMarketTick(p, 0.003);
if (!invalidTickResult.ok) {
  console.log(invalidTickResult.error.context?.field);   // 'tickSize'
  console.log(invalidTickResult.error.context?.reason);  // 'not_multiple_of_base_tick'
}

// Ошибка: невалидный tickSize
const negativeTickResult = PriceService.roundToMarketTick(p, -0.01);
if (!negativeTickResult.ok) {
  console.log(negativeTickResult.error.context?.field);   // 'tickSize'
  console.log(negativeTickResult.error.context?.reason);  // 'not_positive'
}
```

---

#### `ensureAlignedToMarketTick(price, tickSize)`

Проверяет что цена кратна tickSize (уже aligned).

**Сигнатура:**

```typescript
ensureAlignedToMarketTick(
  price: Price,
  tickSize: number | string | Decimal
): Result<void, InvalidPriceError>
```

**КРИТИЧНО:** tickSize **ДОЛЖЕН быть кратен** базовому тику (0.0001). Используется `ValidateAligned`, который внутри использует `ValidateTickSizeMultipleOfBaseTick`.

**Семантика:**

- Проверяет что price УЖЕ кратен tickSize
- Для округления используй `roundToMarketTick()`
- Используется для валидации после округления или для проверки входящих данных

**Примеры:**

```typescript
const price = Price.of(new Decimal(0.5));

// Успех: aligned
const result1 = PriceService.ensureAlignedToMarketTick(price, 0.01);
if (result1.ok) {
  console.log('Price aligned to 0.01');  // 0.5 % 0.01 === 0
}

const result2 = PriceService.ensureAlignedToMarketTick(price, 0.1);
if (result2.ok) {
  console.log('Price aligned to 0.1');  // 0.5 % 0.1 === 0
}

// Ошибка: не aligned
const misalignedResult = PriceService.ensureAlignedToMarketTick(price, 0.3);
if (!misalignedResult.ok) {
  console.log(misalignedResult.error.context?.field);   // 'price'
  console.log(misalignedResult.error.context?.reason);  // 'not_aligned'
  console.log(misalignedResult.error.context?.price);   // '0.5'
  console.log(misalignedResult.error.context?.tickSize); // '0.3'
}

// Валидация после округления
const calculated = Price.of(new Decimal(0.6543));
const roundedResult = PriceService.roundToMarketTick(calculated, 0.01);

if (roundedResult.ok) {
  const rounded = roundedResult.value;

  // Проверяем контракт: результат должен быть aligned
  const alignResult = PriceService.ensureAlignedToMarketTick(rounded, 0.01);
  console.log(alignResult.ok);  // true (гарантировано контрактом)
}
```

---

### Применение относительного изменения (markup/markdown)

#### `applyRelativeChange(price, ratio, tickSize, options?)`

Применяет относительное изменение (markup/markdown) к цене.

**Сигнатура:**

```typescript
applyRelativeChange(
  price: Price,
  ratio: Ratio,
  tickSize: number | string | Decimal,
  options?: { roundingMode?: 'nearest' | 'floor' | 'ceil' }
): Result<Price, InvalidPriceError>
```

**Семантика:**

Вычисляет новую цену как: `price * (1 + ratio)`

- **Markup +2%**: `price * 1.02`
- **Markdown -5%**: `price * 0.95`

**Округление к тику:**

Результат округляется с учётом режима:

- `nearest` (по умолчанию): к ближайшему тику
- `floor`: вниз — используй для агрессивных bid quotes
- `ceil`: вверх — используй для агрессивных ask quotes

**Валидация:**

- Ratio может быть отрицательным (для markdown)
- Результат должен оставаться в диапазоне [MIN_PRICE, MAX_PRICE]
- Результат должен быть кратен tickSize после округления

**Примеры:**

```typescript
import { PriceService, RatioService } from '@polymarket/value-objects';

// Markup +2%
const price = Price.of(new Decimal(0.50));
const markupResult = RatioService.fromPercent(2);
if (!markupResult.ok) return;

const result = PriceService.applyRelativeChange(price, markupResult.value, 0.01);
if (result.ok) {
  console.log(result.value.toNumber());  // 0.51 (0.50 * 1.02 = 0.51)
}

// Markdown -5%
const markdownResult = RatioService.fromPercent(-5);
if (!markdownResult.ok) return;

const result2 = PriceService.applyRelativeChange(price, markdownResult.value, 0.01);
if (result2.ok) {
  console.log(result2.value.toNumber());  // 0.48 (0.50 * 0.95 = 0.475 → round to 0.48)
}

// С округлением вниз (для bid)
const result3 = PriceService.applyRelativeChange(
  price, markupResult.value, 0.01, { roundingMode: 'floor' }
);

// С округлением вверх (для ask)
const result4 = PriceService.applyRelativeChange(
  price, markupResult.value, 0.01, { roundingMode: 'ceil' }
);

// Ошибка: результат выходит за диапазон
const extremeMarkup = RatioService.fromPercent(200); // +200%
if (!extremeMarkup.ok) return;

const errorResult = PriceService.applyRelativeChange(
  Price.of(new Decimal(0.5)), extremeMarkup.value, 0.01
);
if (!errorResult.ok) {
  // 0.5 * 3 = 1.5 > MAX_PRICE (0.9999)
  console.log(errorResult.error.context?.op);  // 'applyRelativeChange'
}
```

---

## Error Handling Patterns

### Базовая обработка

```typescript
const result = PriceService.create(userInput);

if (!result.ok) {
  console.error(`Failed to create price: ${result.error.message}`);
  console.error(`Context:`, result.error.context);
  return;
}

const price = result.value;
// Используй price
```

### Специфичная обработка

```typescript
const result = PriceService.divide(price, divisor);

if (!result.ok) {
  const ctx = result.error.context;

  if (ctx?.reason === 'is_zero') {
    console.error('Cannot divide by zero');
  } else if (ctx?.reason === 'is_nan') {
    console.error('Divisor is NaN');
  } else if (ctx?.op === 'divide' && ctx?.cause) {
    console.error(`Math error: ${ctx.cause.message}`);
  } else {
    console.error(`Unknown error: ${result.error.message}`);
  }

  return;
}

const quotient = result.value;
```

### Композиция операций

```typescript
function calculateMidPrice(
  bidPrice: Price,
  askPrice: Price,
  tickSize: Decimal
): Result<Price, InvalidPriceError> {
  // 1. Вычисляем среднее
  const midResult = PriceService.average(bidPrice, askPrice);
  if (!midResult.ok) {
    return midResult;
  }

  const mid = midResult.value;

  // 2. Округляем к тику
  const roundedResult = PriceService.roundToMarketTick(mid, tickSize);
  if (!roundedResult.ok) {
    return roundedResult;
  }

  return roundedResult;
}
```

### Early return pattern

```typescript
function processPrices(
  yesPrice: string,
  tickSize: Decimal
): Result<{ yes: Price; no: Price }, InvalidPriceError> {
  // Создаём YES цену
  const yesResult = PriceService.create(yesPrice);
  if (!yesResult.ok) return yesResult;

  const yes = yesResult.value;

  // Округляем к тику
  const roundedYesResult = PriceService.roundToMarketTick(yes, tickSize);
  if (!roundedYesResult.ok) return roundedYesResult;

  const roundedYes = roundedYesResult.value;

  // Вычисляем NO цену
  const noResult = PriceService.complement(roundedYes);
  if (!noResult.ok) return noResult;

  const no = noResult.value;

  return Ok({ yes: roundedYes, no });
}
```

---

## Best Practices

### ✅ DO: Всегда проверяйте Result

```typescript
// ✅ Хорошо
const result = PriceService.create(value);
if (!result.ok) {
  // Обработка ошибки
  return;
}
const price = result.value;
```

### ❌ DON'T: Не игнорируйте ошибки

```typescript
// ❌ Плохо
const result = PriceService.create(value);
const price = result.value;  // TypeScript error! result может быть Err
```

---

### ✅ DO: Используйте semantic операции

```typescript
// ✅ Хорошо (читаемо)
const noPrice = PriceService.complement(yesPrice);
const midPrice = PriceService.average(bid, ask);
```

### ❌ DON'T: Не используйте generic арифметику для domain операций

```typescript
import Decimal from 'decimal.js';
import { PriceService, Price } from '@polymarket/value-objects/price';

// ❌ Плохо (неясное намерение - вместо complement используется умножение)
const yesPrice = Price.of(new Decimal(0.6));
const factor = 1 / yesPrice.toNumber() - 1;  // Сложный расчёт вместо complement
const noPrice = PriceService.multiply(yesPrice, factor);
```

---

### ✅ DO: Используйте правильный режим округления

```typescript
// ✅ Хорошо
const bid = PriceService.roundToMarketTick(calculated, tickSize, 'floor');  // Вниз для bid
const ask = PriceService.roundToMarketTick(calculated, tickSize, 'ceil');   // Вверх для ask
const mid = PriceService.roundToMarketTick(calculated, tickSize, 'nearest'); // К ближайшему для mid
```

---

### ✅ DO: Валидируйте tick size кратность

```typescript
// ✅ Хорошо (roundToMarketTick делает это автоматически)
const result = PriceService.roundToMarketTick(price, 0.01);  // 0.01 кратен 0.0001 ✓

// ❌ Будет ошибка
const badResult = PriceService.roundToMarketTick(price, 0.003);  // НЕ кратен 0.0001
```

---

### ✅ DO: Проверяйте alignment после округления

```typescript
// ✅ Хорошо
const roundedResult = PriceService.roundToMarketTick(price, tickSize);
if (roundedResult.ok) {
  const rounded = roundedResult.value;

  // Контракт гарантирует это, но можно проверить
  const alignResult = PriceService.ensureAlignedToMarketTick(rounded, tickSize);
  console.assert(alignResult.ok, 'Contract violation!');
}
```

---

## Performance Tips

### 1. Zero-copy оптимизация

```typescript
// ✅ Быстро (если у вас уже есть Decimal)
const decimal = calculateSomething();  // returns Decimal
const result = PriceService.create(decimal);  // Zero-copy: использует Decimal напрямую
```

### 2. Избегайте повторных проверок

```typescript
// ❌ Медленно
for (const value of values) {
  const result = PriceService.create(value);
  if (!result.ok) continue;
  // ...
}

// ✅ Быстрее (batch валидация)
const validPrices = values
  .map(v => PriceService.create(v))
  .filter(r => r.ok)
  .map(r => r.value);
```

### 3. Переиспользуйте константы

```typescript
// ✅ Хорошо (переиспользуем)
const half = Price.HALF;
const min = Price.MIN;
const max = Price.MAX;

for (const price of prices) {
  if (price.equals(half)) {
    // ...
  }
}

// ❌ Плохо (создаём каждый раз)
for (const price of prices) {
  if (price.equals(Price.HALF)) {  // Price.HALF вызывается в цикле!
    // ...
  }
}
```

---

## Заключение

`PriceService` обеспечивает:

1. **Type-safe API** через Result<T, E>
2. **Единый Error Contract** для всех операций
3. **Polymarket-aligned семантику** (complement, average, базовый тик)
4. **Композиционность** операций
5. **Performance** через zero-copy и правильные абстракции

Используйте PriceService как единую точку входа для всех операций с Price!
