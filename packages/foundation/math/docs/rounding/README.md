# Rounding Operations

Операции округления для Decimal значений с различными режимами.

## Содержание

- [roundToTick - Округление к tick size](#roundtotick)
- [roundToPrecision - Округление до N знаков](#roundtoprecision)
- [Режимы округления](#режимы-округления)
- [Примеры использования](#примеры-использования)

---

## roundToTick

Округляет значение до ближайшего кратного tick size.

### Базовая функция

```typescript
function roundToTick(
  value: Decimal,
  tickSize: Decimal,
  roundingMode: Decimal.Rounding
): Decimal
```

**Алгоритм:**

1. Делим `value / tickSize` → получаем количество тиков
2. Округляем до целого количества тиков используя `roundingMode`
3. Умножаем обратно на `tickSize`

**Важно:** Алгоритм полностью на Decimal API без конвертации в number.

**roundingMode обязателен** - explicit лучше implicit.

### Варианты функции

#### 1. `roundToTick(value, tickSize, mode)` - с явным режимом

Базовая функция с явным указанием режима округления.

```typescript
roundToTick(new Decimal(10.567), new Decimal(0.01), Decimal.ROUND_HALF_UP); // 10.57
roundToTick(new Decimal(10.565), new Decimal(0.01), Decimal.ROUND_HALF_UP); // 10.57 (.5 вверх)
roundToTick(new Decimal(10.564), new Decimal(0.01), Decimal.ROUND_HALF_UP); // 10.56
```

#### 2. `floorToTick(value, tickSize)` - ROUND_DOWN

Округление к нулю (для положительных вниз, для отрицательных вверх).

```typescript
floorToTick(new Decimal(10.567), new Decimal(0.01)); // 10.56
floorToTick(new Decimal(-10.567), new Decimal(0.01)); // -10.56 (к нулю!)
```

#### 3. `ceilToTick(value, tickSize)` - ROUND_UP

Округление от нуля (для положительных вверх, для отрицательных вниз).

```typescript
ceilToTick(new Decimal(10.561), new Decimal(0.01)); // 10.57
ceilToTick(new Decimal(-10.561), new Decimal(0.01)); // -10.57 (от нуля!)
```

#### 4. `mathFloorToTick(value, tickSize)` - ROUND_FLOOR

Математический floor - всегда к -Infinity.

```typescript
mathFloorToTick(new Decimal(10.567), new Decimal(0.01)); // 10.56
mathFloorToTick(new Decimal(-10.561), new Decimal(0.01)); // -10.57 (к -Infinity!)
```

#### 5. `mathCeilToTick(value, tickSize)` - ROUND_CEIL

Математический ceil - всегда к +Infinity.

```typescript
mathCeilToTick(new Decimal(10.561), new Decimal(0.01)); // 10.57
mathCeilToTick(new Decimal(-10.567), new Decimal(0.01)); // -10.56 (к +Infinity!)
```

### Разница между floor/ceil вариантами

Для **положительных** чисел:

- `floorToTick` = `mathFloorToTick` (оба вниз)
- `ceilToTick` = `mathCeilToTick` (оба вверх)

Для **отрицательных** чисел:

```typescript
const value = new Decimal(-10.567);
const tick = new Decimal(0.01);

floorToTick(value, tick);      // -10.56 (к нулю)
mathFloorToTick(value, tick);  // -10.57 (к -Infinity)

ceilToTick(value, tick);       // -10.57 (от нуля)
mathCeilToTick(value, tick);   // -10.56 (к +Infinity)
```

### Валидация

Throws `InvalidOperandError` если:

- `value` не конечное число (NaN, Infinity)

Throws `InvalidTickSizeError` если:

- `tickSize <= 0`
- `tickSize` не конечное число (NaN, Infinity)

Throws `InvalidRoundingModeError` если:

- `roundingMode` не integer
- `roundingMode` вне диапазона [0, 8]

Throws `ArithmeticOverflowError` если:

- Результат операции не конечное число (overflow при делении или умножении)

```typescript
// InvalidOperandError
roundToTick(new Decimal(NaN), new Decimal(0.01), Decimal.ROUND_HALF_UP);      // throws
roundToTick(new Decimal(Infinity), new Decimal(0.01), Decimal.ROUND_HALF_UP); // throws

// InvalidTickSizeError
roundToTick(new Decimal(10), new Decimal(0), Decimal.ROUND_HALF_UP);        // throws
roundToTick(new Decimal(10), new Decimal(-0.01), Decimal.ROUND_HALF_UP);    // throws
roundToTick(new Decimal(10), new Decimal(NaN), Decimal.ROUND_HALF_UP);      // throws
roundToTick(new Decimal(10), new Decimal(Infinity), Decimal.ROUND_HALF_UP); // throws

// InvalidRoundingModeError
roundToTick(new Decimal(10), new Decimal(0.01), -1 as Decimal.Rounding);    // throws
roundToTick(new Decimal(10), new Decimal(0.01), 9 as Decimal.Rounding);     // throws
roundToTick(new Decimal(10), new Decimal(0.01), 1.5 as Decimal.Rounding);   // throws
```

---

## roundToPrecision

Округляет значение до указанного количества десятичных знаков.

```typescript
function roundToPrecision(
  value: Decimal,
  decimalPlaces: number,
  roundingMode: Decimal.Rounding
): Decimal
```

**Обёртка над** `value.toDecimalPlaces()` для единообразного API.

**roundingMode обязателен** - explicit лучше implicit.

### Ограничения

- `decimalPlaces` должно быть в диапазоне `[0, 1e9]`
- Превышение максимума вызывает `InvalidDecimalPlacesError`
- Это ограничение библиотеки Decimal.js

### Валидация

Throws `InvalidOperandError` если:

- `value` не конечное число (NaN, Infinity)

Throws `InvalidDecimalPlacesError` если:

- `decimalPlaces < 0`
- `decimalPlaces` не integer
- `decimalPlaces` не конечное число (NaN, Infinity)
- `decimalPlaces > 1e9` (превышен максимум)

Throws `InvalidRoundingModeError` если:

- `roundingMode` не integer
- `roundingMode` вне диапазона [0, 8]

```typescript
// InvalidOperandError
roundToPrecision(new Decimal(NaN), 2, Decimal.ROUND_HALF_UP);     // throws

// InvalidDecimalPlacesError
roundToPrecision(new Decimal('10.567'), -1, Decimal.ROUND_HALF_UP);  // throws
roundToPrecision(new Decimal('10.567'), NaN, Decimal.ROUND_HALF_UP); // throws
roundToPrecision(new Decimal('10.567'), 1.5, Decimal.ROUND_HALF_UP); // throws
roundToPrecision(new Decimal('10.567'), 1e10, Decimal.ROUND_HALF_UP); // throws (превышен максимум)

// InvalidRoundingModeError
roundToPrecision(new Decimal('10.567'), 2, -1 as Decimal.Rounding);   // throws
roundToPrecision(new Decimal('10.567'), 2, 9 as Decimal.Rounding);    // throws
roundToPrecision(new Decimal('10.567'), 2, 1.5 as Decimal.Rounding);  // throws
```

### Примеры

```typescript
// Округление до 2 знаков (центы) - ROUND_HALF_UP
roundToPrecision(new Decimal('10.567'), 2, Decimal.ROUND_HALF_UP); // 10.57
roundToPrecision(new Decimal('10.564'), 2, Decimal.ROUND_HALF_UP); // 10.56
roundToPrecision(new Decimal('10.565'), 2, Decimal.ROUND_HALF_UP); // 10.57 (.5 вверх)

// Округление до целого
roundToPrecision(new Decimal('10.5'), 0, Decimal.ROUND_HALF_UP); // 11

// Округление до 1 знака
roundToPrecision(new Decimal('10.567'), 1, Decimal.ROUND_HALF_UP); // 10.6

// С разными режимами
roundToPrecision(new Decimal('10.567'), 2, Decimal.ROUND_DOWN); // 10.56
roundToPrecision(new Decimal('10.561'), 2, Decimal.ROUND_UP);   // 10.57

// Работает с большими числами
roundToPrecision(new Decimal('999999999999.567'), 2, Decimal.ROUND_HALF_UP); // 999999999999.57

// Работает с максимально допустимой точностью
roundToPrecision(new Decimal('10.567'), 1e9, Decimal.ROUND_HALF_UP); // 10.567
```

---

## Режимы округления

### ROUND_HALF_UP

Стандартное округление: 0.5 всегда вверх.

```typescript
// Положительные
2.4 → 2
2.5 → 3 ⬆️
2.6 → 3

// Отрицательные
-2.4 → -2
-2.5 → -3 ⬇️ (вверх по модулю)
-2.6 → -3
```

### ROUND_DOWN

Округление к нулю.

```typescript
// Положительные
2.9 → 2 (к нулю = вниз)

// Отрицательные
-2.9 → -2 (к нулю = вверх)
```

### ROUND_UP

Округление от нуля.

```typescript
// Положительные
2.1 → 3 (от нуля = вверх)

// Отрицательные
-2.1 → -3 (от нуля = вниз)
```

### ROUND_FLOOR

Математический floor - всегда к -Infinity.

```typescript
2.9 → 2   (к -∞ = вниз)
-2.1 → -3 (к -∞ = вниз)
```

### ROUND_CEIL

Математический ceil - всегда к +Infinity.

```typescript
2.1 → 3  (к +∞ = вверх)
-2.9 → -2 (к +∞ = вверх)
```

---

## Примеры использования

### Округление цены до центов

```typescript
import { roundToTick } from '@polymarket/math/rounding';
import Decimal from 'decimal.js';

const price = new Decimal('10.5678');
const centTick = new Decimal('0.01');

const rounded = roundToTick(price, centTick, Decimal.ROUND_HALF_UP);
// 10.57
```

### Округление количества до целых

```typescript
import { mathFloorToTick } from '@polymarket/math/rounding';
import Decimal from 'decimal.js';

const quantity = new Decimal('10.7');
const wholeTick = new Decimal(1);

const rounded = mathFloorToTick(quantity, wholeTick);
// 10 (всегда вниз для количества)
```

### Округление процента до 2 знаков

```typescript
import { roundToPrecision } from '@polymarket/math/rounding';
import Decimal from 'decimal.js';

const percentage = new Decimal('33.33333333');

const rounded = roundToPrecision(percentage, 2, Decimal.ROUND_HALF_UP);
// 33.33
```

### Сравнение режимов для биржевых цен

```typescript
const price = new Decimal('10.565');
const tick = new Decimal('0.01');

// Для BUY ордеров - округляем вниз (выгоднее покупателю)
const buyPrice = floorToTick(price, tick); // 10.56

// Для SELL ордеров - округляем вверх (выгоднее продавцу)
const sellPrice = ceilToTick(price, tick); // 10.57
```

### Работа с tick size 0.0001

```typescript
const price = new Decimal('0.12345');
const tick = new Decimal('0.0001');

const rounded = roundToTick(price, tick, Decimal.ROUND_HALF_UP);
// 0.1235
```

---

## Best Practices

### 1. Используйте правильный режим для контекста

```typescript
// ❌ Плохо: всегда один режим округления
const rounded = roundToTick(price, tick, Decimal.ROUND_HALF_UP);

// ✅ Хорошо: режим зависит от контекста
const buyPrice = floorToTick(price, tick);  // Выгоднее покупателю
const sellPrice = ceilToTick(price, tick);  // Выгоднее продавцу
```

### 2. Всегда проверяйте tick size перед использованием

```typescript
// ❌ Плохо: можем получить InvalidTickSizeError
const rounded = roundToTick(value, userInputTick, Decimal.ROUND_HALF_UP);

// ✅ Хорошо: валидируем tick заранее
if (!userInputTick.isFinite() || userInputTick.lessThanOrEqualTo(0)) {
  throw new Error('Invalid tick size');
}
const rounded = roundToTick(value, userInputTick, Decimal.ROUND_HALF_UP);
```

### 3. Для финансов используйте roundToTick, не roundToPrecision

```typescript
// ❌ Плохо: roundToPrecision не учитывает tick size
const price = roundToPrecision(new Decimal('10.567'), 2, Decimal.ROUND_HALF_UP); // 10.57

// ✅ Хорошо: roundToTick гарантирует кратность тику
const price = roundToTick(new Decimal('10.567'), marketTickSize, Decimal.ROUND_HALF_UP);
```

### 4. Минимизируйте количество округлений

```typescript
// ❌ Плохо: округляем на каждом шаге
const step1 = roundToTick(a, tick, Decimal.ROUND_HALF_UP);
const step2 = roundToTick(b, tick, Decimal.ROUND_HALF_UP);
const result = roundToTick(step1.plus(step2), tick, Decimal.ROUND_HALF_UP);

// ✅ Хорошо: округляем только финальный результат
const result = roundToTick(a.plus(b), tick, Decimal.ROUND_HALF_UP);
```

---

## Связанные модули

- [Decimal Operations](../decimal/README.md) - Арифметические операции
- [Validation](../validation/README.md) - Валидация чисел
