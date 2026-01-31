# Core Layer — Price Value Object

> Базовый иммутабельный value object с инвариантами

## Обзор

Core Layer содержит базовую реализацию `Price` — иммутабельного value object для представления цены на рынках предсказаний Polymarket.

**Ключевые принципы:**
- Иммутабельность — все операции возвращают новые экземпляры
- Инварианты — значение всегда finite и в диапазоне [0.0001, 0.9999]
- Типизированные исключения — `PriceInvariantViolation`
- Polymarket-aligned — MIN_PRICE (0.0001) служит базовым тиком

---

## Price

### Инварианты

`Price` гарантирует четыре инварианта:

1. **Not NaN** — значение не может быть `NaN`
2. **Finite** — значение должно быть finite (не `Infinity`, не `-Infinity`)
3. **Min bound** — значение должно быть >= `MIN_PRICE` (0.0001)
4. **Max bound** — значение должно быть <= `MAX_PRICE` (0.9999)

При нарушении любого инварианта кидается `PriceInvariantViolation`.

**Примечание:** Проверка `MIN_PRICE` автоматически исключает отрицательные значения, так как MIN_PRICE = 0.0001 > 0.

### Создание

#### `Price.of(value)`

Создаёт Price из number/string/Decimal.

**Оптимизация:** Если `value` уже `Decimal`, используется без повторного парсинга (zero-copy).

```typescript
const price1 = Price.of(0.5);
const price2 = Price.of("0.65");
const price3 = Price.of(new Decimal(0.5)); // Без повторного парсинга!

// Throws PriceInvariantViolation
try {
  const invalid1 = Price.of(1.5);  // Выше MAX_PRICE
} catch (e) {
  console.log(e.message);  // "Price 1.5 exceeds maximum 0.9999"
}

try {
  const invalid2 = Price.of(0.00001);  // Ниже MIN_PRICE
} catch (e) {
  console.log(e.message);  // "Price 0.00001 is below minimum 0.0001"
}

try {
  const invalid3 = Price.of(NaN);  // Not a number
} catch (e) {
  console.log(e.message);  // "Price cannot be NaN"
}
```

#### `Price.fromDecimal(decimal)`

Создаёт Price из Decimal без повторного парсинга (zero-copy оптимизация).

```typescript
const decimal = new Decimal(0.5);
const price = Price.fromDecimal(decimal);

// price.value() === decimal (тот же объект!)
```

**Использование:** Когда у вас уже есть Decimal и не нужно повторно парсить.

### Константы

#### Статические константы

```typescript
Price.min()   // Price со значением 0.0001 (MIN_PRICE)
Price.max()   // Price со значением 0.9999 (MAX_PRICE)
Price.half()  // Price со значением 0.5 (HALF_PRICE)
```

**Пример:**

```typescript
const midPrice = Price.half();
console.log(midPrice.toNumber());  // 0.5

if (price.equals(Price.min())) {
  console.log('Minimum price');
}

if (price.equals(Price.max())) {
  console.log('Maximum price');
}
```

#### Internal константы (для Rules/Facade)

```typescript
Price.minValue()  // Decimal константа 0.0001
Price.maxValue()  // Decimal константа 0.9999
```

**⚠️ Внимание:** Эти методы возвращают shared Decimal константы. **Decimal неизменяемый (immutable)** — все операции (plus, minus и т.д.) возвращают новые экземпляры, оригинал не меняется. Price также неизменяемый.

**Использование:** Только внутри пакета (Rules/Facade) для проверок.

```typescript
// ✅ Правильно (в Rules) - сравнение
if (tickSize.greaterThan(Price.maxValue())) {
  return Err(...);
}

// ✅ Тоже правильно - операции создают новый Decimal
const result = Price.minValue().plus(1);  // Безопасно, возвращает новый экземпляр
```

---

## API Методы

### `value(): Decimal`

Возвращает внутреннее Decimal значение.

```typescript
const price = Price.of(0.65);
const decimal: Decimal = price.value();
console.log(decimal.toString());  // "0.65"
```

### `toNumber(): number`

Конвертирует в number (может потерять точность).

```typescript
const price = Price.of("0.6543");
const num: number = price.toNumber();  // 0.6543

// ⚠️ Lossy для очень точных чисел
const precise = Price.of("0.123456789012345");
console.log(precise.toNumber());  // Может потерять точность!
```

**Когда использовать:** Только для UI/display, не для вычислений.

### `equals(other: Price): boolean`

Сравнивает два Price на строгое равенство.

```typescript
const price1 = Price.of(0.5);
const price2 = Price.of("0.5");
const price3 = Price.of(0.6);

price1.equals(price2);  // true
price1.equals(price3);  // false
```

**Примечание:** Это **строгое** равенство по `Decimal.equals()`. Для approximate equality можно реализовать вспомогательную функцию сравнения с допустимой погрешностью при необходимости.

### `isMin(): boolean`

Проверяет что цена равна минимальной (0.0001).

```typescript
Price.min().isMin();         // true
Price.of(0.0001).isMin();    // true
Price.of(0.5).isMin();       // false
```

### `isMax(): boolean`

Проверяет что цена равна максимальной (0.9999).

```typescript
Price.max().isMax();         // true
Price.of(0.9999).isMax();    // true
Price.of(0.5).isMax();       // false
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
const minPrice = Price.min();
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
const maxPrice = Price.max();
console.log(maxPrice.toNumber());  // 0.9999

// Complement минимальной цены
const minComplement = new Decimal(1).minus(Price.minValue());
console.log(minComplement.toString());  // "0.9999" (= MAX_PRICE)
```

### HALF_PRICE = 0.5

Средняя цена (50/50 probability).

**Семантика:**
- Нейтральная цена (equal probability)
- Часто используется как starting point

**Примеры:**

```typescript
const halfPrice = Price.half();
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
  Price.of(NaN);
} catch (e) {
  console.log(e instanceof PriceInvariantViolation);  // true
  console.log(e.message);  // "Price invariant violation: Price cannot be NaN"
}
```

**Почему:** NaN нарушает математические операции и сравнения.

---

### 2. Must be Finite

```typescript
try {
  Price.of(Infinity);
} catch (e) {
  console.log(e.message);  // "Price invariant violation: Price must be finite"
}

try {
  Price.of(-Infinity);
} catch (e) {
  console.log(e.message);  // "Price invariant violation: Price must be finite"
}
```

**Почему:** Infinite значения не имеют смысла для цены.

---

### 3. Must be >= MIN_PRICE (0.0001)

```typescript
try {
  Price.of(0);  // Ноль ниже MIN_PRICE
} catch (e) {
  console.log(e.message);  // "Price invariant violation: Price 0 is below minimum 0.0001"
}

try {
  Price.of(0.00009);  // Ниже MIN_PRICE
} catch (e) {
  console.log(e.message);  // "Price invariant violation: Price 0.00009 is below minimum 0.0001"
}

try {
  Price.of(-0.5);  // Отрицательное значение
} catch (e) {
  console.log(e.message);  // "Price invariant violation: Price -0.5 is below minimum 0.0001"
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
  Price.of(1);  // Единица выше MAX_PRICE
} catch (e) {
  console.log(e.message);  // "Price invariant violation: Price 1 exceeds maximum 0.9999"
}

try {
  Price.of(1.5);  // Выше MAX_PRICE
} catch (e) {
  console.log(e.message);  // "Price invariant violation: Price 1.5 exceeds maximum 0.9999"
}
```

**Почему:**
- Единица означает "гарантированный исход" (нет uncertainty)
- Максимальная uncertainty: 99.99%
- Оставляет место для противоположного исхода (min 0.01%)

---

## Сравнение с другими Value Objects

### Price vs Percentage

| Аспект | Price | Percentage |
|--------|-------|------------|
| Диапазон | [0.0001, 0.9999] | [0, 100] или [0, 1] |
| Семантика | Вероятность исхода | Процентная ставка |
| Базовый тик | 0.0001 (фиксированный) | Любой |
| Complement | 1 - price | Не применимо |
| Кратность тику | Обязательна (Polymarket) | Опционально |

### Price vs Decimal

| Аспект | Price | Decimal |
|--------|-------|---------|
| Инварианты | Да (4 проверки) | Нет |
| Диапазон | [0.0001, 0.9999] | Любой |
| Иммутабельность | Да | Да |
| Domain семантика | Да (цена исхода) | Нет (generic число) |

---

## Оптимизации

### Zero-copy в fromDecimal()

```typescript
// ❌ С парсингом (медленно)
const decimal = new Decimal(0.5);
const price1 = Price.of(decimal);  // парсит decimal → new Decimal()

// ✅ Без парсинга (быстро)
const decimal = new Decimal(0.5);
const price2 = Price.fromDecimal(decimal);  // использует decimal напрямую

// Проверка
price2.value() === decimal;  // true (тот же объект!)
```

**Когда использовать:**
- В Facade, когда уже получили Decimal из Math layer
- В Rules, если результат валидации Decimal
- Для производительности в hot paths

---

## Примеры использования

### Создание с валидацией

```typescript
function createPriceFromUser(input: string): Price {
  try {
    return Price.of(input);
  } catch (e) {
    if (e instanceof PriceInvariantViolation) {
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

**⚠️ Примечание:** В production коде используйте `PriceService.create()` вместо прямого `Price.of()`.

---

### Сравнение цен

```typescript
const bidPrice = Price.of(0.64);
const askPrice = Price.of(0.66);

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
let currentPrice = Price.half();  // 0.5

// Проверка экстремальных значений
if (currentPrice.equals(Price.min())) {
  console.log('Price at floor');
} else if (currentPrice.equals(Price.max())) {
  console.log('Price at ceiling');
}

// Использование в вычислениях (через Facade!)
import { PriceService } from './facade/PriceService.js';

const complementResult = PriceService.complement(Price.min());
if (complementResult.ok) {
  console.log(complementResult.value.equals(Price.max()));  // true
}
```

---

## Тестирование

### Unit тесты для инвариантов

```typescript
import { describe, it, expect } from '@jest/globals';
import { Price, PriceInvariantViolation } from './Price.js';

describe('Price invariants', () => {
  it('должен принять валидное значение', () => {
    expect(() => Price.of(0.5)).not.toThrow();
  });

  it('должен отклонить NaN', () => {
    expect(() => Price.of(NaN)).toThrow(PriceInvariantViolation);
  });

  it('должен отклонить Infinity', () => {
    expect(() => Price.of(Infinity)).toThrow(PriceInvariantViolation);
  });

  it('должен отклонить значение ниже MIN', () => {
    expect(() => Price.of(0.00001)).toThrow(PriceInvariantViolation);
  });

  it('должен отклонить значение выше MAX', () => {
    expect(() => Price.of(1.5)).toThrow(PriceInvariantViolation);
  });
});
```

---

## Best Practices

### ✅ DO: Используйте Facade для создания

```typescript
// ✅ Хорошо
import { PriceService } from './facade/PriceService.js';

const result = PriceService.create(userInput);
if (!result.ok) {
  // Обработка ошибки
}
```

### ❌ DON'T: Не используйте Price.of() в production

```typescript
// ❌ Плохо (может бросить исключение)
const price = Price.of(userInput);
```

---

### ✅ DO: Используйте fromDecimal() для оптимизации

```typescript
// ✅ Хорошо (zero-copy)
const decimal = calculateSomething();  // returns Decimal
const price = Price.fromDecimal(decimal);
```

### ❌ DON'T: Не парсите повторно

```typescript
// ❌ Плохо (двойной парсинг)
const decimal = new Decimal(0.5);
const price = Price.of(decimal);  // парсит снова!
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

Core Layer для Price обеспечивает:

1. **Гарантию инвариантов** — только валидные цены могут существовать
2. **Иммутабельность** — безопасность в concurrent окружении
3. **Type safety** — compile-time проверки
4. **Polymarket-aligned семантика** — диапазон и базовый тик
5. **Performance** — zero-copy оптимизации

Используйте `PriceService` для создания и операций в production коде!
