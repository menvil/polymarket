# Core Layer — OutcomePrice Value Object

> Базовый иммутабельный value object с инвариантами

## Обзор

Core Layer содержит базовую реализацию `OutcomePrice` — иммутабельного value object для представления цены на рынках предсказаний Polymarket.

**Ключевые принципы:**

- Иммутабельность — все операции возвращают новые экземпляры
- Инварианты — значение всегда finite и в диапазоне [0.0001, 0.9999]
- Типизированные исключения — `OutcomePriceInvariantViolation`
- Polymarket-aligned — MIN_PRICE (0.0001) служит базовым тиком

---

## OutcomePrice

### Инварианты

`OutcomePrice` гарантирует четыре инварианта:

1. **Not NaN** — значение не может быть `NaN`
2. **Finite** — значение должно быть finite (не `Infinity`, не `-Infinity`)
3. **Min bound** — значение должно быть >= `MIN_PRICE` (0.0001)
4. **Max bound** — значение должно быть <= `MAX_PRICE` (0.9999)

При нарушении любого инварианта кидается `OutcomePriceInvariantViolation`.

**Примечание:** Проверка `MIN_PRICE` автоматически исключает отрицательные значения, так как MIN_PRICE = 0.0001 > 0.

### Создание

#### `OutcomePrice.of(value)`

Создаёт OutcomePrice из Decimal.

**ВНИМАНИЕ:** Это метод для внутреннего использования в Core/Facade. В публичном коде используйте `OutcomePriceService.create()`.

```typescript
import Decimal from 'decimal.js';

const price1 = OutcomePrice.of(new Decimal(0.5));
const price2 = OutcomePrice.of(new Decimal('0.65'));

// Throws OutcomePriceInvariantViolation
try {
  const invalid1 = OutcomePrice.of(new Decimal(1.5));  // Выше MAX_PRICE
} catch (e) {
  console.log(e.message);  // "OutcomePrice 1.5 exceeds maximum 0.9999"
}

try {
  const invalid2 = OutcomePrice.of(new Decimal(0.00001));  // Ниже MIN_PRICE
} catch (e) {
  console.log(e.message);  // "OutcomePrice 0.00001 is below minimum 0.0001"
}

try {
  const invalid3 = OutcomePrice.of(new Decimal(NaN));  // Not a number
} catch (e) {
  console.log(e.message);  // "OutcomePrice cannot be NaN"
}
```

### Константы

#### Статические константы

```typescript
OutcomePrice.MIN   // OutcomePrice со значением 0.0001 (MIN_PRICE)
OutcomePrice.MAX   // OutcomePrice со значением 0.9999 (MAX_PRICE)
OutcomePrice.HALF  // OutcomePrice со значением 0.5 (HALF_PRICE)
```

**Пример:**

```typescript
const midPrice = OutcomePrice.HALF;
console.log(midPrice.toNumber());  // 0.5

if (price.equals(OutcomePrice.MIN)) {
  console.log('Minimum price');
}

if (price.equals(OutcomePrice.MAX)) {
  console.log('Maximum price');
}
```

#### Internal константы (для Rules/Facade)

```typescript
OutcomePrice.MIN.value()  // Decimal константа 0.0001
OutcomePrice.MAX.value()  // Decimal константа 0.9999
```

**⚠️ Внимание:** Эти методы возвращают shared Decimal константы. **Decimal неизменяемый (immutable)** — все операции (plus, minus и т.д.) возвращают новые экземпляры, оригинал не меняется. OutcomePrice также неизменяемый.

**Использование:** Только внутри пакета (Rules/Facade) для проверок.

```typescript
// ✅ Правильно (в Rules) - сравнение
if (tickSize.greaterThan(OutcomePrice.MAX.value())) {
  return Err(...);
}

// ✅ Тоже правильно - операции создают новый Decimal
const result = OutcomePrice.MIN.value().plus(1);  // Безопасно, возвращает новый экземпляр
```

---

## API Методы

### `value(): Decimal`

Возвращает внутреннее Decimal значение.

```typescript
const price = OutcomePrice.of(new Decimal(0.65));
const decimal: Decimal = price.value();
console.log(decimal.toString());  // "0.65"
```

### `toNumber(): number`

Конвертирует в number (может потерять точность).

```typescript
const price = OutcomePrice.of(new Decimal("0.6543"));
const num: number = price.toNumber();  // 0.6543

// ⚠️ Lossy для очень точных чисел
const precise = OutcomePrice.of(new Decimal("0.123456789012345"));
console.log(precise.toNumber());  // Может потерять точность!
```

**Когда использовать:** Только для UI/display, не для вычислений.

### `equals(other: OutcomePrice): boolean`

Сравнивает два OutcomePrice на строгое равенство.

```typescript
const price1 = OutcomePrice.of(new Decimal(0.5));
const price2 = OutcomePrice.of(new Decimal("0.5"));
const price3 = OutcomePrice.of(new Decimal(0.6));

price1.equals(price2);  // true
price1.equals(price3);  // false
```

**Примечание:** Это **строгое** равенство по `Decimal.equals()`. Для approximate equality можно реализовать вспомогательную функцию сравнения с допустимой погрешностью при необходимости.

### `isZero(): boolean`

Проверяет что цена равна нулю. Всегда возвращает `false`, т.к. минимальная цена 0.0001.

**Добавлено для единообразия API** с Quantity и Money.

```typescript
OutcomePrice.of(new Decimal(0.5)).isZero();     // false (всегда)
OutcomePrice.MIN.isZero();         // false (всегда)
OutcomePrice.MAX.isZero();         // false (всегда)
```

### `isMin(): boolean`

Проверяет что цена равна минимальной (0.0001).

```typescript
OutcomePrice.MIN.isMin();         // true
OutcomePrice.of(new Decimal(0.0001)).isMin();    // true
OutcomePrice.of(new Decimal(0.5)).isMin();       // false
```

### `isMax(): boolean`

Проверяет что цена равна максимальной (0.9999).

```typescript
OutcomePrice.MAX.isMax();         // true
OutcomePrice.of(new Decimal(0.9999)).isMax();    // true
OutcomePrice.of(new Decimal(0.5)).isMax();       // false
```

---

## Константы диапазона

### MIN_PRICE = 0.0001

Минимальная цена служит **базовым тиком** Polymarket.

**Семантика:**

- Минимальная probability: 0.01%
- Все tick sizes должны быть кратны этому значению
- Предотвращает деление на ноль в расчётах odds

**Примеры:**

```typescript
const minPrice = OutcomePrice.MIN;
console.log(minPrice.toNumber());  // 0.0001

// Валидные tick sizes (кратны MIN_PRICE)
0.0001  // 1x базовый тик
0.0002  // 2x базовый тик
0.001   // 10x базовый тик
0.01    // 100x базовый тик

// Невалидные tick sizes (НЕ кратны MIN_PRICE)
0.00015 // не кратен
0.003   // не кратен
```

### MAX_PRICE = 0.9999

Максимальная цена на рынке предсказаний.

**Семантика:**

- Максимальная probability: 99.99%
- Всегда есть uncertainty (не может быть 100%)
- Оставляет место для противоположного исхода

**Примеры:**

```typescript
const maxPrice = OutcomePrice.MAX;
console.log(maxPrice.toNumber());  // 0.9999

// Complement минимальной цены
const minComplement = new Decimal(1).minus(OutcomePrice.MIN.value());
console.log(minComplement.toString());  // "0.9999" (= MAX_PRICE)
```

### HALF_PRICE = 0.5

Средняя цена (50/50 probability).

**Семантика:**

- Нейтральная цена (equal probability)
- Часто используется как starting point

**Примеры:**

```typescript
const halfPrice = OutcomePrice.HALF;
console.log(halfPrice.toNumber());  // 0.5

// Complement половинной цены
const halfComplement = new Decimal(1).minus(halfPrice.value());
console.log(halfComplement.toString());  // "0.5" (симметрично!)
```

---

## Инварианты в деталях

### 1. Not NaN

```typescript
try {
  OutcomePrice.of(new Decimal(NaN));
} catch (e) {
  console.log(e instanceof OutcomePriceInvariantViolation);  // true
  console.log(e.message);  // "OutcomePrice invariant violation: OutcomePrice cannot be NaN"
}
```

**Почему:** NaN нарушает математические операции и сравнения.

---

### 2. Must be Finite

```typescript
try {
  OutcomePrice.of(new Decimal(Infinity));
} catch (e) {
  console.log(e.message);  // "OutcomePrice invariant violation: OutcomePrice must be finite"
}

try {
  OutcomePrice.of(new Decimal(-Infinity));
} catch (e) {
  console.log(e.message);  // "OutcomePrice invariant violation: OutcomePrice must be finite"
}
```

**Почему:** Infinite значения не имеют смысла для цены.

---

### 3. Must be >= MIN_PRICE (0.0001)

```typescript
try {
  OutcomePrice.of(new Decimal(0));  // Ноль ниже MIN_PRICE
} catch (e) {
  console.log(e.message);  // "OutcomePrice invariant violation: OutcomePrice 0 is below minimum 0.0001"
}

try {
  OutcomePrice.of(new Decimal(0.00009));  // Ниже MIN_PRICE
} catch (e) {
  console.log(e.message);  // "OutcomePrice invariant violation: OutcomePrice 0.00009 is below minimum 0.0001"
}

try {
  OutcomePrice.of(new Decimal(-0.5));  // Отрицательное значение
} catch (e) {
  console.log(e.message);  // "OutcomePrice invariant violation: OutcomePrice -0.5 is below minimum 0.0001"
}
```

**Почему:**

- Ноль означает "невозможный исход" (нет смысла торговать)
- Отрицательные цены не имеют смысла
- Минимальная uncertainty: 0.01%

---

### 4. Must be <= MAX_PRICE (0.9999)

```typescript
try {
  OutcomePrice.of(new Decimal(1));  // Единица выше MAX_PRICE
} catch (e) {
  console.log(e.message);  // "OutcomePrice invariant violation: OutcomePrice 1 exceeds maximum 0.9999"
}

try {
  OutcomePrice.of(new Decimal(1.5));  // Выше MAX_PRICE
} catch (e) {
  console.log(e.message);  // "OutcomePrice invariant violation: OutcomePrice 1.5 exceeds maximum 0.9999"
}
```

**Почему:**

- Единица означает "гарантированный исход" (нет uncertainty)
- Максимальная uncertainty: 99.99%
- Оставляет место для противоположного исхода (min 0.01%)

---

## Сравнение с другими Value Objects

### OutcomePrice vs Percentage

| Аспект | OutcomePrice | Percentage |
| ------ | ----- | ---------- |
| Диапазон | [0.0001, 0.9999] | [0, 100] или [0, 1] |
| Семантика | Вероятность исхода | Процентная ставка |
| Базовый тик | 0.0001 (фиксированный) | Любой |
| Complement | 1 - price | Не применимо |
| Кратность тику | Обязательна (Polymarket) | Опционально |

### OutcomePrice vs Decimal

| Аспект | OutcomePrice | Decimal |
| ------ | ----- | ------- |
| Инварианты | Да (4 проверки) | Нет |
| Диапазон | [0.0001, 0.9999] | Любой |
| Иммутабельность | Да | Да |
| Domain семантика | Да (цена исхода) | Нет (generic число) |

---

## Примеры использования

### Создание с валидацией

```typescript
function createPriceFromUser(input: string): OutcomePrice {
  try {
    return OutcomePrice.of(new Decimal(input));
  } catch (e) {
    if (e instanceof OutcomePriceInvariantViolation) {
      throw new Error(`Invalid price: ${e.message}`);
    }
    throw e;
  }
}

// ✅ Валидно
const price1 = createPriceFromUser("0.65");

// ❌ Throws Error
const price2 = createPriceFromUser("1.5");  // "Invalid price: ..."
```

**⚠️ Примечание:** В production коде используйте `OutcomePriceService.create()` вместо прямого `OutcomePrice.of()`.

---

### Сравнение цен

```typescript
const bidPrice = OutcomePrice.of(new Decimal(0.64));
const askPrice = OutcomePrice.of(new Decimal(0.66));

if (bidPrice.equals(askPrice)) {
  console.log('Spread is zero');
} else {
  console.log('Spread exists');
}

// Проверка границ
if (bidPrice.isMin()) {
  console.log('Bid at minimum');
}

if (askPrice.isMax()) {
  console.log('Ask at maximum');
}
```

---

### Работа с константами

```typescript
// Инициализация с нейтральной ценой
let currentPrice = OutcomePrice.HALF;  // 0.5

// Проверка экстремальных значений
if (currentPrice.equals(OutcomePrice.MIN)) {
  console.log('OutcomePrice at floor');
} else if (currentPrice.equals(OutcomePrice.MAX)) {
  console.log('OutcomePrice at ceiling');
}

// Использование в вычислениях (через Facade!)
import { OutcomePriceService } from './facade/OutcomePriceService.js';

const complementResult = OutcomePriceService.complement(OutcomePrice.MIN);
if (complementResult.ok) {
  console.log(complementResult.value.equals(OutcomePrice.MAX));  // true
}
```

---

## Тестирование

### Unit тесты для инвариантов

```typescript
import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { OutcomePrice, OutcomePriceInvariantViolation } from './OutcomePrice.js';

describe('OutcomePrice invariants', () => {
  it('должен принять валидное значение', () => {
    expect(() => OutcomePrice.of(new Decimal(0.5))).not.toThrow();
  });

  it('должен отклонить NaN', () => {
    expect(() => OutcomePrice.of(new Decimal(NaN))).toThrow(OutcomePriceInvariantViolation);
  });

  it('должен отклонить Infinity', () => {
    expect(() => OutcomePrice.of(new Decimal(Infinity))).toThrow(OutcomePriceInvariantViolation);
  });

  it('должен отклонить значение ниже MIN', () => {
    expect(() => OutcomePrice.of(new Decimal(0.00001))).toThrow(OutcomePriceInvariantViolation);
  });

  it('должен отклонить значение выше MAX', () => {
    expect(() => OutcomePrice.of(new Decimal(1.5))).toThrow(OutcomePriceInvariantViolation);
  });
});
```

---

## Best Practices

### ✅ DO: Используйте Facade для создания

```typescript
// ✅ Хорошо
import { OutcomePriceService } from './facade/OutcomePriceService.js';

const result = OutcomePriceService.create(userInput);
if (!result.ok) {
  // Обработка ошибки
}
```

### ❌ DON'T: Не используйте OutcomePrice.of() в production

```typescript
import Decimal from 'decimal.js';
import { OutcomePrice } from '@polymarket/value-objects/outcome-price';

// ❌ Плохо (может бросить исключение если значение невалидно)
const userDecimal = new Decimal(userInput); // может бросить при парсинге
const price = OutcomePrice.of(userDecimal); // может бросить при валидации инвариантов
```

---

### ✅ DO: Проверяйте границы через isMin/isMax

```typescript
// ✅ Хорошо (читаемо)
if (price.isMin()) {
  // ...
}
```

### ❌ DON'T: Не сравнивайте через toNumber

```typescript
// ❌ Плохо (может потерять точность)
if (price.toNumber() === 0.0001) {
  // ...
}
```

---

## Заключение

Core Layer для OutcomePrice обеспечивает:

1. **Гарантию инвариантов** — только валидные цены могут существовать
2. **Иммутабельность** — безопасность в concurrent окружении
3. **Type safety** — compile-time проверки
4. **Polymarket-aligned семантика** — диапазон и базовый тик
5. **Performance** — zero-copy оптимизации

Используйте `OutcomePriceService` для создания и операций в production коде!
