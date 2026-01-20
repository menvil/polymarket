# Архитектура: Errors, Shared Dependencies и Math пакет

## 1️⃣ Где должны лежать errors согласно архитектуре?

### Правило размещения errors

```
Ошибка должна лежать в пакете САМОГО НИЖНЕГО уровня,
который её использует
```

### Layer Architecture

```
Layer 4: Application            @polymarket/application
    ↓
Layer 3: Domain Services        @polymarket/domain-services
    ↓
Layer 2: Domain Core            @polymarket/entities, @polymarket/value-objects
    ↓
Layer 1: Foundation             @polymarket/errors, @polymarket/types, @polymarket/math
    ↓
Layer 0: External               TypeScript stdlib, Node.js
```

### Принцип размещения errors:

**Правило 1: Domain errors → Layer 1 (Foundation)**
```
@polymarket/errors/              ← Layer 1: Foundation
├── domain/                      ← Domain-специфичные ошибки
│   ├── market/
│   │   └── MarketNotFoundError.ts
│   ├── order/
│   │   └── OrderValidationError.ts
│   └── position/
│       └── InsufficientPositionError.ts
```

**Почему Layer 1?**
- ✅ Entities (Layer 2) нуждаются в domain errors
- ✅ Value Objects (Layer 2) нуждаются в domain errors
- ✅ Services (Layer 3) нуждаются в domain errors
- ✅ Application (Layer 4) нуждаются в domain errors

**Все слои используют domain errors → errors в Foundation!**

---

**Правило 2: Infrastructure errors → Infrastructure пакет**
```
@polymarket/infrastructure/
├── errors/
│   ├── DatabaseError.ts
│   ├── NetworkError.ts
│   └── APIError.ts
```

**Почему в Infrastructure?**
- ❌ Domain слой НЕ должен знать о Database/Network
- ✅ Infrastructure errors используются только в Infrastructure

---

**Правило 3: Application errors → Application пакет**
```
@polymarket/application/
├── errors/
│   ├── AuthenticationError.ts
│   ├── AuthorizationError.ts
│   └── ValidationError.ts
```

**Почему в Application?**
- ❌ Domain слой НЕ должен знать о Authentication
- ✅ Application errors используются только в Application

---

### Итоговая структура errors

```
packages/
├── errors/                              # @polymarket/errors (Layer 1: Foundation)
│   ├── package.json                     # deps: []
│   ├── src/
│   │   ├── base/
│   │   │   ├── TradingError.ts          # Базовая domain ошибка
│   │   │   └── ErrorCode.ts
│   │   │
│   │   ├── domain/                      # Domain-специфичные ошибки
│   │   │   ├── market/
│   │   │   │   ├── MarketNotFoundError.ts
│   │   │   │   ├── MarketClosedError.ts
│   │   │   │   └── index.ts
│   │   │   ├── order/
│   │   │   │   ├── OrderValidationError.ts
│   │   │   │   ├── InsufficientFundsError.ts
│   │   │   │   └── index.ts
│   │   │   └── position/
│   │   │       └── ...
│   │   │
│   │   └── index.ts                     # Export all
│   └── __tests__/
│
├── infrastructure/                      # Infrastructure слой
│   ├── package.json                     # deps: [@polymarket/errors]
│   └── src/
│       ├── errors/                      # Infrastructure ошибки
│       │   ├── DatabaseError.ts
│       │   └── NetworkError.ts
│       └── ...
│
└── application/                         # Application слой
    ├── package.json                     # deps: [@polymarket/errors, @polymarket/infrastructure]
    └── src/
        ├── errors/                      # Application ошибки
        │   ├── AuthenticationError.ts
        │   └── AuthorizationError.ts
        └── ...
```

---

## 2️⃣ Если error нужен в двух пакетах - это ошибка архитектуры?

### НЕТ! Это нормально ✅

**Принцип:** Если error нужен в двух пакетах, он должен быть в **общем Foundation пакете**.

### Примеры:

#### Пример 1: ValidationError нужен и в entities, и в application

```
Где используется ValidationError?
├── entities (Layer 2) - валидация domain правил
└── application (Layer 4) - валидация input

Решение: ValidationError → @polymarket/errors (Layer 1)
```

**Код:**
```typescript
// @polymarket/errors/src/base/ValidationError.ts
export class ValidationError extends TradingError {
  constructor(
    message: string,
    public readonly field?: string,
    public readonly value?: unknown
  ) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

// В @polymarket/entities (Layer 2)
import { ValidationError } from '@polymarket/errors';

class Order {
  validate() {
    if (this.price.value <= 0) {
      throw new ValidationError('Price must be positive', 'price', this.price.value);
    }
  }
}

// В @polymarket/application (Layer 4)
import { ValidationError } from '@polymarket/errors';

function validateOrderInput(input: CreateOrderDTO) {
  if (!input.tokenId) {
    throw new ValidationError('Token ID is required', 'tokenId');
  }
}
```

**Почему это OK?**
- ✅ Оба пакета зависят от @polymarket/errors (Foundation)
- ✅ Нет циклических зависимостей
- ✅ Ошибка определена один раз, используется везде

---

#### Пример 2: InsufficientFundsError нужен в Portfolio и Application

```
Где используется InsufficientFundsError?
├── entities/Portfolio (Layer 2) - domain логика резервирования
└── application/OrderService (Layer 4) - проверка перед созданием ордера

Решение: InsufficientFundsError → @polymarket/errors (Layer 1)
```

**Это НЕ ошибка архитектуры!** Это правильное переиспользование.

---

### ❌ Когда ЭТО ошибка архитектуры?

**Ошибка архитектуры:** Если error нужен в двух пакетах ОДНОГО уровня, и они зависят друг от друга.

#### Анти-паттерн: Циклическая зависимость

```
❌ ПЛОХО:

@polymarket/market-service (Layer 3)
    ↓ использует MarketError
@polymarket/order-service (Layer 3)
    ↓ использует MarketError
    ↓ зависит от
@polymarket/market-service

Результат: Циклическая зависимость!
```

**Решение:** Вынести MarketError в Foundation

```
✅ ХОРОШО:

@polymarket/errors (Layer 1)
    ↑
    ├─ @polymarket/market-service (Layer 3)
    └─ @polymarket/order-service (Layer 3)

Результат: Нет циклических зависимостей!
```

---

### Правило: Shared Dependencies

```
Если что-то нужно в N пакетах (N >= 2),
то это должно быть в пакете НИЖЕ всех этих N пакетов
```

**Графически:**
```
Layer 3: ServiceA, ServiceB    ← Оба нуждаются в ErrorX
    ↓
Layer 2: Entities              ← Тоже нуждается в ErrorX
    ↓
Layer 1: Errors                ← ErrorX живет здесь! ✅
```

---

## 3️⃣ Математический пакет (Decimals) - ОТЛИЧНАЯ идея! ✅

### Проблема floating point в финансах

```javascript
// ❌ ПРОБЛЕМА:
0.1 + 0.2  // 0.30000000000000004  (WTF?!)
0.7 - 0.6  // 0.09999999999999998  (Деньги пропали!)

// Trading пример:
let price = 0.1;
for (let i = 0; i < 10; i++) {
  price += 0.1;
}
console.log(price);  // 1.0999999999999999 (а не 1.1!)
```

**В финансовых системах это катастрофа!**

---

### Решение: @polymarket/math пакет

```
packages/math/                           # @polymarket/math
├── package.json                         # deps: [decimal.js или @polymarket/decimal]
├── src/
│   ├── Decimal.ts                       # Точная арифметика
│   ├── operations/
│   │   ├── add.ts
│   │   ├── subtract.ts
│   │   ├── multiply.ts
│   │   ├── divide.ts
│   │   └── round.ts
│   ├── constants.ts                     # MIN_PRICE, MAX_PRICE, PRECISION
│   ├── validators.ts                    # isValidPrice, isValidQuantity
│   └── index.ts
└── __tests__/
    └── Decimal.test.ts
```

---

### Архитектура math пакета

```
Layer 2: Value Objects          @polymarket/value-objects
├── Price.ts                    ← использует Decimal
├── Quantity.ts                 ← использует Decimal
└── Money.ts                    ← использует Decimal
    ↓ зависит от
Layer 1: Math                   @polymarket/math
└── Decimal.ts                  ← точная арифметика
    ↓ зависит от (опционально)
Layer 0: External
└── decimal.js (npm library)    ← можем использовать готовую библиотеку
```

---

### Реализация @polymarket/math

#### Вариант 1: Обертка над decimal.js (Рекомендуется)

**package.json:**
```json
{
  "name": "@polymarket/math",
  "version": "1.0.0",
  "description": "Precise decimal arithmetic for trading",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "dependencies": {
    "decimal.js": "^10.4.3"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "vitest": "^1.0.0"
  }
}
```

**src/Decimal.ts:**
```typescript
/**
 * @polymarket/math - Точная десятичная арифметика
 *
 * @remarks
 * Обертка над decimal.js для финансовых вычислений.
 * Все операции с ценами/количествами/деньгами ДОЛЖНЫ использовать Decimal.
 *
 * Почему НЕ native number:
 * - 0.1 + 0.2 !== 0.3 (floating point ошибка)
 * - В финансах это недопустимо!
 *
 * @example
 * ```typescript
 * const price1 = Decimal.from(0.1);
 * const price2 = Decimal.from(0.2);
 * const sum = price1.add(price2);
 * console.log(sum.toString()); // "0.3" ✅
 * ```
 */
import DecimalJS from 'decimal.js';

/**
 * Конфигурация точности для trading
 */
DecimalJS.set({
  precision: 20,           // 20 знаков точности
  rounding: DecimalJS.ROUND_HALF_UP,  // Математическое округление
  toExpNeg: -7,            // Не использовать exp для малых чисел
  toExpPos: 20,
});

/**
 * Decimal - обертка для точной десятичной арифметики
 *
 * @remarks
 * Неизменяемый (immutable) класс для финансовых вычислений.
 * Все операции возвращают новый экземпляр.
 */
export class Decimal {
  private readonly _value: DecimalJS;

  private constructor(value: DecimalJS) {
    this._value = value;
  }

  /**
   * Создаёт Decimal из number
   *
   * @param value - Число для конвертации
   * @returns Decimal с точным представлением
   *
   * @throws {Error} Если value невалидное (NaN, Infinity)
   *
   * @example
   * ```typescript
   * const price = Decimal.from(0.65);
   * console.log(price.toString()); // "0.65"
   * ```
   */
  public static from(value: number | string): Decimal {
    if (typeof value === 'number' && (!isFinite(value))) {
      throw new Error(`Invalid decimal value: ${value}`);
    }
    return new Decimal(new DecimalJS(value));
  }

  /**
   * Создаёт Decimal из строки
   *
   * @param value - Строковое представление числа
   * @returns Decimal
   *
   * @example
   * ```typescript
   * const price = Decimal.fromString("0.123456789");
   * ```
   */
  public static fromString(value: string): Decimal {
    return new Decimal(new DecimalJS(value));
  }

  /**
   * Создаёт нулевой Decimal
   */
  public static zero(): Decimal {
    return new Decimal(new DecimalJS(0));
  }

  /**
   * Создаёт единичный Decimal
   */
  public static one(): Decimal {
    return new Decimal(new DecimalJS(1));
  }

  /**
   * Сложение
   *
   * @param other - Число для сложения
   * @returns Новый Decimal (this + other)
   *
   * @example
   * ```typescript
   * const a = Decimal.from(0.1);
   * const b = Decimal.from(0.2);
   * const sum = a.add(b);
   * console.log(sum.toString()); // "0.3" ✅
   * ```
   */
  public add(other: Decimal | number): Decimal {
    const otherDecimal = other instanceof Decimal ? other._value : new DecimalJS(other);
    return new Decimal(this._value.plus(otherDecimal));
  }

  /**
   * Вычитание
   */
  public subtract(other: Decimal | number): Decimal {
    const otherDecimal = other instanceof Decimal ? other._value : new DecimalJS(other);
    return new Decimal(this._value.minus(otherDecimal));
  }

  /**
   * Умножение
   */
  public multiply(other: Decimal | number): Decimal {
    const otherDecimal = other instanceof Decimal ? other._value : new DecimalJS(other);
    return new Decimal(this._value.times(otherDecimal));
  }

  /**
   * Деление
   *
   * @throws {Error} Если делитель равен нулю
   */
  public divide(other: Decimal | number): Decimal {
    const otherDecimal = other instanceof Decimal ? other._value : new DecimalJS(other);
    if (otherDecimal.isZero()) {
      throw new Error('Division by zero');
    }
    return new Decimal(this._value.dividedBy(otherDecimal));
  }

  /**
   * Округление до N знаков
   *
   * @param decimalPlaces - Количество знаков после запятой
   * @returns Округлённый Decimal
   *
   * @example
   * ```typescript
   * const price = Decimal.from(0.123456);
   * const rounded = price.round(2);
   * console.log(rounded.toString()); // "0.12"
   * ```
   */
  public round(decimalPlaces: number): Decimal {
    return new Decimal(this._value.toDecimalPlaces(decimalPlaces));
  }

  /**
   * Абсолютное значение
   */
  public abs(): Decimal {
    return new Decimal(this._value.abs());
  }

  /**
   * Отрицание
   */
  public negate(): Decimal {
    return new Decimal(this._value.negated());
  }

  /**
   * Проверки
   */
  public isZero(): boolean {
    return this._value.isZero();
  }

  public isPositive(): boolean {
    return this._value.isPositive();
  }

  public isNegative(): boolean {
    return this._value.isNegative();
  }

  /**
   * Сравнения
   */
  public equals(other: Decimal | number): boolean {
    const otherDecimal = other instanceof Decimal ? other._value : new DecimalJS(other);
    return this._value.equals(otherDecimal);
  }

  public isGreaterThan(other: Decimal | number): boolean {
    const otherDecimal = other instanceof Decimal ? other._value : new DecimalJS(other);
    return this._value.greaterThan(otherDecimal);
  }

  public isLessThan(other: Decimal | number): boolean {
    const otherDecimal = other instanceof Decimal ? other._value : new DecimalJS(other);
    return this._value.lessThan(otherDecimal);
  }

  /**
   * Конвертация в number
   *
   * @remarks
   * ОСТОРОЖНО: Может потерять точность!
   * Используйте только для отображения или логирования.
   */
  public toNumber(): number {
    return this._value.toNumber();
  }

  /**
   * Конвертация в строку
   */
  public toString(): string {
    return this._value.toString();
  }

  /**
   * Конвертация в строку с фиксированным числом знаков
   */
  public toFixed(decimalPlaces: number): string {
    return this._value.toFixed(decimalPlaces);
  }
}
```

**src/constants.ts:**
```typescript
import { Decimal } from './Decimal.js';

/**
 * Константы для trading системы
 */
export const MathConstants = {
  // Price constraints (Polymarket: 0.01 - 0.99)
  MIN_PRICE: Decimal.from(0.01),
  MAX_PRICE: Decimal.from(0.99),

  // Quantity constraints
  MIN_QUANTITY: Decimal.from(0.01),
  MAX_QUANTITY: Decimal.from(1000000),

  // Precision
  PRICE_PRECISION: 4,      // 4 знака после запятой для цен
  QUANTITY_PRECISION: 2,   // 2 знака для количества
  MONEY_PRECISION: 6,      // 6 знаков для денег (USDC)

  // Rounding
  ROUNDING_MODE: 'HALF_UP' as const,
} as const;
```

**src/validators.ts:**
```typescript
import { Decimal } from './Decimal.js';
import { MathConstants } from './constants.js';

/**
 * Валидирует цену
 *
 * @param price - Цена для валидации
 * @returns True если цена в допустимом диапазоне
 */
export function isValidPrice(price: Decimal): boolean {
  return (
    price.isGreaterThan(MathConstants.MIN_PRICE) &&
    price.isLessThan(MathConstants.MAX_PRICE)
  );
}

/**
 * Валидирует количество
 */
export function isValidQuantity(quantity: Decimal): boolean {
  return (
    quantity.isGreaterThan(MathConstants.MIN_QUANTITY) &&
    quantity.isLessThan(MathConstants.MAX_QUANTITY)
  );
}

/**
 * Нормализует цену (округляет до PRICE_PRECISION)
 */
export function normalizePrice(price: Decimal): Decimal {
  return price.round(MathConstants.PRICE_PRECISION);
}

/**
 * Нормализует количество
 */
export function normalizeQuantity(quantity: Decimal): Decimal {
  return quantity.round(MathConstants.QUANTITY_PRECISION);
}
```

---

### Использование @polymarket/math в Value Objects

**Было (неточно):**
```typescript
// @polymarket/value-objects/src/Price.ts
export class Price {
  constructor(public readonly value: number) {}  // ❌ number!

  public multiply(quantity: number): number {
    return this.value * quantity;  // ❌ 0.1 * 0.2 = 0.020000000004
  }
}
```

**Стало (точно):**
```typescript
// @polymarket/value-objects/src/Price.ts
import { Decimal, isValidPrice, normalizePrice } from '@polymarket/math';

/**
 * Price Value Object
 *
 * @remarks
 * Представляет цену в prediction market (диапазон 0.01 - 0.99).
 * Использует Decimal для точных вычислений.
 */
export class Price {
  private readonly _value: Decimal;

  private constructor(value: Decimal) {
    this._value = value;
  }

  /**
   * Создаёт Price из number
   *
   * @throws {Error} Если цена вне допустимого диапазона
   */
  public static fromNumber(value: number): Price {
    const decimal = Decimal.from(value);
    const normalized = normalizePrice(decimal);

    if (!isValidPrice(normalized)) {
      throw new Error(`Price must be between 0.01 and 0.99, got ${value}`);
    }

    return new Price(normalized);
  }

  /**
   * Получает значение как Decimal
   */
  public get value(): Decimal {
    return this._value;
  }

  /**
   * Получает значение как number (для legacy кода)
   *
   * @remarks
   * ОСТОРОЖНО: Может потерять точность!
   */
  public toNumber(): number {
    return this._value.toNumber();
  }

  /**
   * Умножает цену на количество
   *
   * @returns Точный результат (Decimal)
   */
  public multiply(quantity: Decimal): Decimal {
    return this._value.multiply(quantity);
  }

  public toString(): string {
    return this._value.toFixed(4);
  }
}
```

---

## 📊 Итоговая архитектура Foundation слоя

```
packages/
├── errors/                              # Layer 1: Foundation
│   ├── package.json                     # deps: []
│   ├── src/
│   │   ├── base/
│   │   │   └── TradingError.ts
│   │   ├── domain/
│   │   │   ├── market/
│   │   │   ├── order/
│   │   │   └── position/
│   │   └── index.ts
│   └── __tests__/
│
├── types/                               # Layer 1: Foundation
│   ├── package.json                     # deps: []
│   ├── src/
│   │   ├── Result.ts
│   │   ├── Maybe.ts
│   │   └── index.ts
│   └── __tests__/
│
├── math/                                # Layer 1: Foundation
│   ├── package.json                     # deps: [decimal.js]
│   ├── src/
│   │   ├── Decimal.ts
│   │   ├── constants.ts
│   │   ├── validators.ts
│   │   └── index.ts
│   └── __tests__/
│       └── Decimal.test.ts
│
├── value-objects/                       # Layer 2: Domain Primitives
│   ├── package.json                     # deps: [@polymarket/math, @polymarket/errors]
│   ├── src/
│   │   ├── Price.ts                     # Использует Decimal
│   │   ├── Quantity.ts                  # Использует Decimal
│   │   ├── Money.ts                     # Использует Decimal
│   │   └── index.ts
│   └── __tests__/
│
└── entities/                            # Layer 3: Domain Core
    ├── package.json                     # deps: [@polymarket/value-objects, @polymarket/errors, @polymarket/types]
    └── src/
        ├── Market.ts
        └── Order.ts
```

---

## 🎯 Dependency Graph

```
Layer 3: Entities
├── depends on → value-objects
├── depends on → errors
└── depends on → types
    ↓
Layer 2: Value Objects
├── depends on → math
└── depends on → errors
    ↓
Layer 1: Foundation (независимые пакеты)
├── errors          deps: []
├── types           deps: []
└── math            deps: [decimal.js]
    ↓
Layer 0: External
└── decimal.js (npm)
```

**Правило:** Зависимости ТОЛЬКО сверху вниз, никогда снизу вверх!

---

## ✅ Критерии успеха

### 1. Errors в правильном месте
```bash
# Все domain errors в Foundation
packages/errors/src/domain/

# Entities импортируют из Foundation
import { MarketNotFoundError } from '@polymarket/errors';
✅ Работает
```

### 2. Нет циклических зависимостей
```bash
# Проверка
npx madge --circular packages/*/src/index.ts
# Должно вернуть: No circular dependencies found ✅
```

### 3. Math пакет работает точно
```typescript
const a = Decimal.from(0.1);
const b = Decimal.from(0.2);
const sum = a.add(b);
console.log(sum.toString()); // "0.3" ✅ (НЕ 0.30000000004)
```

### 4. Value Objects используют Decimal
```typescript
const price = Price.fromNumber(0.65);
const quantity = Quantity.fromNumber(100);
const total = price.multiply(quantity.value);
// total = Decimal("65.00") ✅ Точное значение
```

---

## 🚀 План внедрения

### Фаза 1: Создать foundation пакеты (День 1, 6 часов)

#### Шаг 1.1: @polymarket/errors (2 часа)
```bash
mkdir -p packages/errors/src/{base,domain/{market,order,position}}
# Создать TradingError, domain errors
pnpm --filter @polymarket/errors build
```

#### Шаг 1.2: @polymarket/types (1 час)
```bash
mkdir -p packages/types/src
# Создать Result<T,E>, Maybe<T>
pnpm --filter @polymarket/types build
```

#### Шаг 1.3: @polymarket/math (3 часа)
```bash
mkdir -p packages/math/src
# Создать Decimal, constants, validators
pnpm --filter @polymarket/math build
pnpm --filter @polymarket/math test
```

---

### Фаза 2: Мигрировать Value Objects на Decimal (День 2, 4 часа)

#### Шаг 2.1: Price → Decimal
```typescript
// Было: number
// Стало: Decimal
```

#### Шаг 2.2: Quantity → Decimal
#### Шаг 2.3: Money → Decimal

#### Шаг 2.4: Обновить тесты
```bash
pnpm --filter @polymarket/value-objects test
# Все тесты должны пройти ✅
```

---

### Фаза 3: Обновить Entities (День 3, 2 часа)

Обновить imports:
```typescript
// Было
import { Price } from '../value-objects/Price.js';
const notional = order.price.value * order.size.value;  // number math

// Стало
import { Price } from '@polymarket/value-objects';
const notional = order.price.value.multiply(order.size.value);  // Decimal math ✅
```

---

## 📈 Оценка времени

- **День 1 (6 часов):** Foundation пакеты (errors, types, math)
- **День 2 (4 часа):** Миграция Value Objects на Decimal
- **День 3 (2 часа):** Обновление Entities

**Итого:** ~3 дня (12 часов работы)

---

## 🎯 Ответы на вопросы

### 1. Где должны лежать errors?
**Ответ:** В `@polymarket/errors` (Layer 1: Foundation)
- Domain errors → `@polymarket/errors/domain/`
- Infrastructure errors → `@polymarket/infrastructure/errors/`
- Application errors → `@polymarket/application/errors/`

### 2. Error в двух пакетах - ошибка архитектуры?
**Ответ:** НЕТ! Это нормально ✅
- Error должен быть в Foundation (ниже обоих пакетов)
- Оба пакета импортируют из Foundation
- Нет циклических зависимостей

### 3. Нужен ли math пакет для Decimals?
**Ответ:** ДА! Обязательно! ✅
- Floating point в финансах = катастрофа
- `@polymarket/math` с Decimal - необходимость
- Все Value Objects должны использовать Decimal

---

## 🚀 Готов начать?

Предлагаю начать с создания трёх foundation пакетов:
1. `@polymarket/errors`
2. `@polymarket/types`
3. `@polymarket/math`

Начинаем?
