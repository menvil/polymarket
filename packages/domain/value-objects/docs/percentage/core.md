# Core Layer — Percentage Value Object

> Базовый иммутабельный value object с инвариантами

## Обзор

Core Layer содержит базовую реализацию `Percentage` — иммутабельного value object для представления процентных значений.

**Ключевые принципы:**

- Иммутабельность — все операции возвращают новые экземпляры
- Инварианты — значение всегда finite и в диапазоне [-1e6, 1e6]
- Типизированные исключения — `PercentageInvariantViolation`
- Шкала 0-100 — 50 означает 50% (не 0.5)

---

## Percentage

### Инварианты

`Percentage` гарантирует четыре инварианта:

1. **Not NaN** — значение не может быть `NaN`
2. **Finite** — значение должно быть finite (не `Infinity`, не `-Infinity`)
3. **Min bound** — значение должно быть >= `MIN_PERCENTAGE` (-1e6)
4. **Max bound** — значение должно быть <= `MAX_PERCENTAGE` (1e6)

При нарушении любого инварианта кидается `PercentageInvariantViolation` с соответствующим reason.

### Создание

#### `Percentage.of(value)`

Создаёт Percentage из number/string/Decimal.

**Оптимизация:** Если `value` уже `Decimal`, используется без повторного парсинга (zero-copy).

```typescript
const pct1 = Percentage.of(50);
const pct2 = Percentage.of("25.5");
const pct3 = Percentage.of(new Decimal(50)); // Без повторного парсинга!

// Throws PercentageInvariantViolation
try {
  const invalid1 = Percentage.of(2000000);  // Выше MAX_PERCENTAGE
} catch (e) {
  console.log(e.message);  // "Percentage 2000000 exceeds maximum 1000000"
  console.log(e.reason);   // "OUT_OF_RANGE_HIGH"
}

try {
  const invalid2 = Percentage.of(-2000000);  // Ниже MIN_PERCENTAGE
} catch (e) {
  console.log(e.message);  // "Percentage -2000000 is below minimum -1000000"
  console.log(e.reason);   // "OUT_OF_RANGE_LOW"
}

try {
  const invalid3 = Percentage.of(NaN);  // Not a number
} catch (e) {
  console.log(e.message);  // "Percentage cannot be NaN"
  console.log(e.reason);   // "NAN"
}
```

#### `Percentage.fromDecimal(decimal)`

Создаёт Percentage из Decimal без повторного парсинга (zero-copy оптимизация).

```typescript
const decimal = new Decimal(50);
const pct = Percentage.fromDecimal(decimal);

// pct.value() === decimal (тот же объект!)
```

**Использование:** Когда у вас уже есть Decimal и не нужно повторно парсить.

### Константы

#### Статические константы

```typescript
Percentage.ZERO          // Percentage со значением 0%
Percentage.ONE_HUNDRED   // Percentage со значением 100%
```

**Пример:**

```typescript
const zero = Percentage.ZERO;
console.log(zero.toNumber());  // 0

const full = Percentage.ONE_HUNDRED;
console.log(full.toNumber());  // 100

if (pct.equals(Percentage.ZERO)) {
  console.log('Zero percentage');
}

if (pct.equals(Percentage.ONE_HUNDRED)) {
  console.log('One hundred percent');
}
```

#### Static factory methods

```typescript
Percentage.min()  // Percentage со значением -1e6
Percentage.max()  // Percentage со значением 1e6
```

**Примечание:** min/max используются редко, так как диапазон очень широкий.

---

## API Методы

### `value(): Decimal`

Возвращает внутреннее Decimal значение (шкала 0-100).

```typescript
const pct = Percentage.of(50);
const decimal: Decimal = pct.value();
console.log(decimal.toString());  // "50"
```

### `toNumber(): number`

Конвертирует в number (может потерять точность).

```typescript
const pct = Percentage.of("50.5");
const num: number = pct.toNumber();  // 50.5

// ⚠️ Lossy для очень точных чисел
const precise = Percentage.of("50.123456789012345");
console.log(precise.toNumber());  // Может потерять точность!
```

**Когда использовать:** Только для UI/display, не для вычислений.

### `toDecimal(): Decimal`

Конвертирует в десятичную дробь (шкала 0-1).

```typescript
const pct = Percentage.of(50);
const decimal = pct.toDecimal();
console.log(decimal.toString());  // "0.5"

const pct2 = Percentage.of(25);
const decimal2 = pct2.toDecimal();
console.log(decimal2.toString());  // "0.25"

const pct3 = Percentage.of(0.5);
const decimal3 = pct3.toDecimal();
console.log(decimal3.toString());  // "0.005" (0.5% = 0.005)
```

**Когда использовать:** Для применения процента к значению (multiply).

### `toBasisPoints(): Decimal`

Конвертирует в базисные пункты (1 bp = 0.01%).

```typescript
const pct = Percentage.of(50);
const bp = pct.toBasisPoints();
console.log(bp.toString());  // "5000"

const pct2 = Percentage.of(0.01);
const bp2 = pct2.toBasisPoints();
console.log(bp2.toString());  // "1"

const pct3 = Percentage.of(2.5);
const bp3 = pct3.toBasisPoints();
console.log(bp3.toString());  // "250"
```

**Когда использовать:** Для финансовых систем, где требуется высокая точность.

---

## Методы сравнения

### `equals(other: Percentage): boolean`

Сравнивает два Percentage на строгое равенство.

```typescript
const pct1 = Percentage.of(50);
const pct2 = Percentage.of("50");
const pct3 = Percentage.of(60);

pct1.equals(pct2);  // true
pct1.equals(pct3);  // false
```

**Примечание:** Это **строгое** равенство по `Decimal.equals()`.

### `isZero(): boolean`

Проверяет что процент равен нулю.

```typescript
Percentage.ZERO.isZero();     // true
Percentage.of(0).isZero();    // true
Percentage.of(50).isZero();   // false
```

### `isPositive(): boolean`

Проверяет что процент положительный (> 0).

```typescript
Percentage.of(50).isPositive();   // true
Percentage.ZERO.isPositive();     // false
Percentage.of(-10).isPositive();  // false
```

### `isNegative(): boolean`

Проверяет что процент отрицательный (< 0).

```typescript
Percentage.of(-10).isNegative();  // true
Percentage.ZERO.isNegative();     // false
Percentage.of(50).isNegative();   // false
```

### Методы сравнения (<, <=, >, >=)

```typescript
const pct1 = Percentage.of(25);
const pct2 = Percentage.of(50);

pct1.isLessThan(pct2);              // true
pct1.isLessThanOrEqual(pct1);       // true
pct2.isGreaterThan(pct1);           // true
pct2.isGreaterThanOrEqual(pct2);    // true
```

---

## Константы диапазона

### MIN_PERCENTAGE = -1e6

Минимальный процент: -1,000,000%

**Семантика:**

- Поддержка отрицательных процентов (PnL, изменения цен)
- Защита от overflow
- Достаточно для любых реальных расчётов

**Примеры:**

```typescript
const minPct = Percentage.min();
console.log(minPct.toNumber());  // -1000000

// Валидные отрицательные проценты
const pnl = Percentage.of(-25);       // -25% убыток
const decline = Percentage.of(-50);   // -50% падение цены
const loss = Percentage.of(-100);     // -100% полная потеря
```

### MAX_PERCENTAGE = 1e6

Максимальный процент: 1,000,000%

**Семантика:**

- Поддержка больших процентов (рост на 1000%)
- Защита от overflow
- Достаточно для любых реальных расчётов

**Примеры:**

```typescript
const maxPct = Percentage.max();
console.log(maxPct.toNumber());  // 1000000

// Валидные большие проценты
const growth = Percentage.of(250);    // 250% рост
const surge = Percentage.of(1000);    // 1000% (10x)
const boom = Percentage.of(10000);    // 10000% (100x)
```

---

## Инварианты в деталях

### 1. Not NaN

```typescript
try {
  Percentage.of(NaN);
} catch (e) {
  console.log(e instanceof PercentageInvariantViolation);  // true
  console.log(e.message);  // "Percentage cannot be NaN"
  console.log(e.reason);   // "NAN"
}
```

**Почему:** NaN нарушает математические операции и сравнения.

---

### 2. Must be Finite

```typescript
try {
  Percentage.of(Infinity);
} catch (e) {
  console.log(e.message);  // "Percentage must be finite"
  console.log(e.reason);   // "NON_FINITE"
}

try {
  Percentage.of(-Infinity);
} catch (e) {
  console.log(e.message);  // "Percentage must be finite"
  console.log(e.reason);   // "NON_FINITE"
}
```

**Почему:** Infinite значения не имеют смысла для процента.

---

### 3. Must be >= MIN_PERCENTAGE (-1e6)

```typescript
try {
  Percentage.of(-2000000);  // Ниже MIN_PERCENTAGE
} catch (e) {
  console.log(e.message);  // "Percentage -2000000 is below minimum -1000000"
  console.log(e.reason);   // "OUT_OF_RANGE_LOW"
}
```

**Почему:**

- Защита от overflow в вычислениях
- -1,000,000% достаточно для любых реальных сценариев

---

### 4. Must be <= MAX_PERCENTAGE (1e6)

```typescript
try {
  Percentage.of(2000000);  // Выше MAX_PERCENTAGE
} catch (e) {
  console.log(e.message);  // "Percentage 2000000 exceeds maximum 1000000"
  console.log(e.reason);   // "OUT_OF_RANGE_HIGH"
}
```

**Почему:**

- Защита от overflow в вычислениях
- 1,000,000% достаточно для любых реальных сценариев

---

## Сравнение с другими Value Objects

### Percentage vs Price

| Аспект | Percentage | Price |
| ------ | ---------- | ----- |
| Диапазон | [-1e6, 1e6] | [0.0001, 0.9999] |
| Шкала | 0-100 (50 = 50%) | 0-1 (0.5 = 50%) |
| Семантика | Процент | Вероятность исхода |
| Отрицательные | Да (PnL) | Нет |
| Проценты > 100% | Да (рост) | Нет |

### Percentage vs Decimal

| Аспект | Percentage | Decimal |
| ------ | ---------- | ------- |
| Инварианты | Да (4 проверки) | Нет |
| Диапазон | [-1e6, 1e6] | Любой |
| Иммутабельность | Да | Да |
| Domain семантика | Да (процент) | Нет (generic число) |

---

## Оптимизации

### Zero-copy в fromDecimal()

```typescript
// ❌ С парсингом (медленно)
const decimal = new Decimal(50);
const pct1 = Percentage.of(decimal);  // парсит decimal → new Decimal()

// ✅ Без парсинга (быстро)
const decimal = new Decimal(50);
const pct2 = Percentage.fromDecimal(decimal);  // использует decimal напрямую

// Проверка
pct2.value() === decimal;  // true (тот же объект!)
```

**Когда использовать:**

- В Facade, когда уже получили Decimal из Math layer
- В Rules, если результат валидации Decimal
- Для производительности в hot paths

---

## Примеры использования

### Создание с валидацией

```typescript
function createPercentageFromUser(input: string): Percentage {
  try {
    return Percentage.of(input);
  } catch (e) {
    if (e instanceof PercentageInvariantViolation) {
      throw new Error(`Invalid percentage: ${e.message}`);
    }
    throw e;
  }
}

// ✅ Валидно
const pct1 = createPercentageFromUser("50");

// ❌ Throws Error
const pct2 = createPercentageFromUser("2000000");  // "Invalid percentage: ..."
```

**⚠️ Примечание:** В production коде используйте `PercentageService.create()` вместо прямого `Percentage.of()`.

---

### Сравнение процентов

```typescript
const fee1 = Percentage.of(2.5);
const fee2 = Percentage.of(3.0);

if (fee1.equals(fee2)) {
  console.log('Same fee');
} else {
  console.log('Different fees');
}

// Проверка нуля
if (fee1.isZero()) {
  console.log('No fee');
}

// Проверка знака
if (fee1.isPositive()) {
  console.log('Positive fee');
}

// Сравнение
if (fee1.isLessThan(fee2)) {
  console.log('Fee1 is lower');
}
```

---

### Работа с константами

```typescript
// Инициализация с нулём
let discount = Percentage.ZERO;  // 0%

// Проверка 100%
const full = Percentage.ONE_HUNDRED;
if (full.equals(Percentage.of(100))) {
  console.log('Full percentage');
}

// Использование в вычислениях (через Facade!)
import { PercentageService } from './facade/PercentageService.js';

const result = PercentageService.add(Percentage.of(50), Percentage.of(25));
if (result.ok) {
  console.log(result.value.toNumber());  // 75
}
```

---

### Конвертация между представлениями

```typescript
const pct = Percentage.of(50);

// Процент (шкала 0-100)
console.log(pct.value());          // Decimal(50)
console.log(pct.toNumber());       // 50

// Десятичная дробь (шкала 0-1)
console.log(pct.toDecimal());      // Decimal(0.5)

// Базисные пункты (1 bp = 0.01%)
console.log(pct.toBasisPoints());  // Decimal(5000)

// Использование для расчётов
const amount = new Decimal(100);
const result = amount.times(pct.toDecimal());  // 100 * 0.5 = 50
```

---

## Тестирование

### Unit тесты для инвариантов

```typescript
import { describe, it, expect } from '@jest/globals';
import { Percentage, PercentageInvariantViolation } from './Percentage.js';

describe('Percentage invariants', () => {
  it('должен принять валидное значение', () => {
    expect(() => Percentage.of(50)).not.toThrow();
  });

  it('должен отклонить NaN', () => {
    expect(() => Percentage.of(NaN)).toThrow(PercentageInvariantViolation);
  });

  it('должен отклонить Infinity', () => {
    expect(() => Percentage.of(Infinity)).toThrow(PercentageInvariantViolation);
  });

  it('должен отклонить значение ниже MIN', () => {
    expect(() => Percentage.of(-2000000)).toThrow(PercentageInvariantViolation);
  });

  it('должен отклонить значение выше MAX', () => {
    expect(() => Percentage.of(2000000)).toThrow(PercentageInvariantViolation);
  });

  it('должен принять отрицательное значение в диапазоне', () => {
    expect(() => Percentage.of(-50)).not.toThrow();
  });

  it('должен принять значение > 100', () => {
    expect(() => Percentage.of(250)).not.toThrow();
  });
});
```

---

## Best Practices

### ✅ DO: Используйте Facade для создания

```typescript
// ✅ Хорошо
import { PercentageService } from './facade/PercentageService.js';

const result = PercentageService.create(userInput);
if (!result.ok) {
  // Обработка ошибки
}
```

### ❌ DON'T: Не используйте Percentage.of() в production

```typescript
// ❌ Плохо (может бросить исключение)
const pct = Percentage.of(userInput);
```

---

### ✅ DO: Используйте fromDecimal() для оптимизации

```typescript
// ✅ Хорошо (zero-copy)
const decimal = calculateSomething();  // returns Decimal
const pct = Percentage.fromDecimal(decimal);
```

### ❌ DON'T: Не парсите повторно

```typescript
// ❌ Плохо (двойной парсинг)
const decimal = new Decimal(50);
const pct = Percentage.of(decimal);  // парсит снова!
```

---

### ✅ DO: Используйте правильное представление

```typescript
// ✅ Хорошо (ясная семантика)
const pct1 = Percentage.of(50);                     // Для UI ввода
const pct2 = PercentageService.fromDecimalFraction(0.5);  // Для API
const pct3 = PercentageService.fromBasisPoints(5000);     // Для финансов
```

### ❌ DON'T: Не путайте шкалы

```typescript
// ❌ Плохо (неясно)
const pct = Percentage.of(0.5);  // Это 0.5% или 50%? (это 0.5%!)
```

---

### ✅ DO: Проверяйте знак через методы

```typescript
// ✅ Хорошо (читаемо)
if (pct.isZero()) { ... }
if (pct.isPositive()) { ... }
if (pct.isNegative()) { ... }
```

### ❌ DON'T: Не сравнивайте через toNumber

```typescript
// ❌ Плохо (может потерять точность)
if (pct.toNumber() === 0) { ... }
if (pct.toNumber() > 0) { ... }
```

---

## Заключение

Core Layer для Percentage обеспечивает:

1. **Гарантию инвариантов** — только валидные проценты могут существовать
2. **Иммутабельность** — безопасность в concurrent окружении
3. **Type safety** — compile-time проверки
4. **Гибкость** — поддержка отрицательных и больших процентов
5. **Performance** — zero-copy оптимизации
6. **Конвертация** — между тремя представлениями (процент, дробь, bp)

Используйте `PercentageService` для создания и операций в production коде!
