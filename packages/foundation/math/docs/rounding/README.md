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
  roundingMode?: Decimal.Rounding
): Decimal
```

**Алгоритм:**
1. Делим `value / tickSize` → получаем количество тиков
2. Округляем до целого количества тиков используя `roundingMode`
3. Умножаем обратно на `tickSize`

**Важно:** Алгоритм полностью на Decimal API без конвертации в number.

### Варианты функции

#### 1. `roundToTick(value, tickSize, mode?)` - default ROUND_HALF_UP

Стандартное округление: 0.5 всегда вверх.

```typescript
roundToTick(new Decimal(10.567), new Decimal(0.01)); // 10.57
roundToTick(new Decimal(10.565), new Decimal(0.01)); // 10.57 (.5 вверх)
roundToTick(new Decimal(10.564), new Decimal(0.01)); // 10.56
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

Throws `InvalidTickSizeError` если:
- `tickSize <= 0`
- `tickSize` не конечное число (NaN, Infinity)

```typescript
roundToTick(new Decimal(10), new Decimal(0));        // throws InvalidTickSizeError
roundToTick(new Decimal(10), new Decimal(-0.01));    // throws InvalidTickSizeError
roundToTick(new Decimal(10), new Decimal(NaN));      // throws InvalidTickSizeError
roundToTick(new Decimal(10), new Decimal(Infinity)); // throws InvalidTickSizeError
```

---

## roundToPrecision

Округляет значение до указанного количества десятичных знаков.

```typescript
function roundToPrecision(
  value: Decimal,
  decimalPlaces: number,
  roundingMode?: Decimal.Rounding
): Decimal
```

**Обёртка над** `value.toDecimalPlaces()` для единообразного API.

### Примеры

```typescript
// Округление до 2 знаков (центы)
roundToPrecision(new Decimal('10.567'), 2); // 10.57
roundToPrecision(new Decimal('10.564'), 2); // 10.56
roundToPrecision(new Decimal('10.565'), 2); // 10.57 (.5 вверх)

// Округление до целого
roundToPrecision(new Decimal('10.5'), 0); // 11

// Округление до 1 знака
roundToPrecision(new Decimal('10.567'), 1); // 10.6

// С разными режимами
roundToPrecision(new Decimal('10.567'), 2, Decimal.ROUND_DOWN); // 10.56
roundToPrecision(new Decimal('10.561'), 2, Decimal.ROUND_UP);   // 10.57

// Работает с большими числами
roundToPrecision(new Decimal('999999999999.567'), 2); // 999999999999.57
```

---

## Режимы округления

### ROUND_HALF_UP (default)

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

const rounded = roundToTick(price, centTick);
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

const rounded = roundToPrecision(percentage, 2);
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

const rounded = roundToTick(price, tick);
// 0.1235
```

---

## Best Practices

### 1. Используйте правильный режим для контекста

```typescript
// ❌ Плохо: всегда ROUND_HALF_UP
const rounded = roundToTick(price, tick);

// ✅ Хорошо: режим зависит от контекста
const buyPrice = floorToTick(price, tick);  // Выгоднее покупателю
const sellPrice = ceilToTick(price, tick);  // Выгоднее продавцу
```

### 2. Всегда проверяйте tick size перед использованием

```typescript
// ❌ Плохо: можем получить InvalidTickSizeError
const rounded = roundToTick(value, userInputTick);

// ✅ Хорошо: валидируем tick заранее
if (!userInputTick.isFinite() || userInputTick.lessThanOrEqualTo(0)) {
  throw new Error('Invalid tick size');
}
const rounded = roundToTick(value, userInputTick);
```

### 3. Для финансов используйте roundToTick, не roundToPrecision

```typescript
// ❌ Плохо: roundToPrecision не учитывает tick size
const price = roundToPrecision(new Decimal('10.567'), 2); // 10.57

// ✅ Хорошо: roundToTick гарантирует кратность тику
const price = roundToTick(new Decimal('10.567'), marketTickSize);
```

### 4. Минимизируйте количество округлений

```typescript
// ❌ Плохо: округляем на каждом шаге
const step1 = roundToTick(a, tick);
const step2 = roundToTick(b, tick);
const result = roundToTick(step1.plus(step2), tick);

// ✅ Хорошо: округляем только финальный результат
const result = roundToTick(a.plus(b), tick);
```

---

## Связанные модули

- [Decimal Operations](../decimal/README.md) - Арифметические операции
- [Validation](../validation/README.md) - Валидация чисел
