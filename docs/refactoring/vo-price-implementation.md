# Price Value Object: План рефакторинга и имплементации

## Метаданные

- **Value Object:** Price
- **Текущий файл:** `packages/domain/value-objects/src/Price.ts` (492 lines)
- **Сложность:** Medium (диапазон [0.0001, 0.9999], округление до тиков)
- **Зависимости:** `@polymarket/math`, `@polymarket/errors`, `@polymarket/result`

---

## Оглавление

1. [Специфика Price](#специфика-price)
2. [Целевая архитектура](#целевая-архитектура)
3. [Детальный план по фазам](#детальный-план-по-фазам)
4. [План тестирования](#план-тестирования)
5. [План документации](#план-документации)
6. [Миграция](#миграция)

---

## Специфика Price

### Характеристики

**Назначение:** Представляет цену на рынках предсказаний.

**Диапазон:** `[0.0001, 0.9999]`
- MIN_PRICE = 0.0001 (0.01%)
- MAX_PRICE = 0.9999 (99.99%)

**Tick Size:** `0.0001` (1 базисный пункт)

**Константы:**
```typescript
Price.MIN  = 0.0001
Price.MAX  = 0.9999
Price.HALF = 0.5
```

### Текущие операции

1. **Создание:**
   - `fromValue(value)` - из number/string/Decimal
   - `fromNumber(n)` - из number
   - `fromString(s)` - из string
   - `fromDecimal(d)` - из Decimal

2. **Математика:**
   - `complement()` - 1 - price
   - `average(other)` - средняя цена
   - `multiply(n)` - умножение на коэффициент
   - `divide(n)` - деление

3. **Округление:**
   - `toTick(tickSize)` - округление до тика
   - `floor()`, `ceil()`, `round()` - округление

4. **Сравнение:**
   - `equals(other)` - равенство
   - `lessThan(other)`, `greaterThan(other)` - сравнения

5. **Сериализация:**
   - `toJSON()` - { value: number }
   - `toString()` - string representation

### Инварианты

**Всегда должно быть true:**
1. ✅ `0.0001 <= price <= 0.9999`
2. ✅ `isFinite(price)`
3. ✅ `!isNaN(price)`

### Бизнес-правила (контекстуальные)

**Зависят от контекста:**
1. 🔶 Округление до конкретного tickSize (может быть не 0.0001)
2. 🔶 Проверка что price подходит для конкретного рынка
3. 🔶 Проверка spread между bid/ask

---

## Целевая архитектура

### Структура директорий

```
packages/domain/value-objects/src/price/
 ├─ core/
 │   ├─ Price.ts                    ← Core VO (только инварианты)
 │   └─ index.ts
 │
 ├─ rules/
 │   ├─ ValidateTickSize.ts         ← Правило: tickSize валидный
 │   ├─ ValidateSpread.ts           ← Правило: spread корректный
 │   └─ index.ts
 │
 ├─ policy/
 │   ├─ MarketPricePolicy.ts        ← Политика для рыночных цен
 │   └─ index.ts
 │
 ├─ facade/
 │   ├─ PriceService.ts             ← Главный фасад
 │   └─ index.ts
 │
 ├─ adapters/
 │   ├─ PriceSerializer.ts          ← JSON сериализация
 │   ├─ PriceFormatter.ts           ← String formatting
 │   └─ index.ts
 │
 └─ index.ts                        ← Главный экспорт
```

### Слои и ответственность

#### **Core Layer** (`core/Price.ts`)

**Ответственность:** Только инварианты существования.

```typescript
export class Price {
  private constructor(private readonly v: Decimal) {
    // Инварианты существования
    if (!v.isFinite()) throw new PriceInvariantViolation('must be finite');
    if (v.lessThan(0.0001)) throw new PriceInvariantViolation('must be >= 0.0001');
    if (v.greaterThan(0.9999)) throw new PriceInvariantViolation('must be <= 0.9999');
  }

  public static of(value: number | string | Decimal): Price {
    const decimal = value instanceof Decimal ? value : new Decimal(value);
    return new Price(decimal);
  }

  public value(): Decimal { return this.v; }
  public toNumber(): number { return this.v.toNumber(); }

  // ТОЛЬКО equality (строгое требование VO)
  public equals(other: Price, epsilon: Decimal = new Decimal(0.0001)): boolean {
    return this.v.minus(other.v).abs().lessThan(epsilon);
  }

  // Математические свойства
  public isMin(): boolean {
    return this.v.equals(0.0001);
  }

  public isMax(): boolean {
    return this.v.equals(0.9999);
  }
}
```

**Что можно:**
- Проверка инвариантов
- Equality comparison
- Геттеры для Decimal/number

**Что нельзя:**
- Математику (используй `@polymarket/math`)
- Бизнес-правила (используй Rules)
- Сериализацию (используй Adapters)

---

#### **Math Layer** (из `@polymarket/math`)

**Используем готовые функции:**

```typescript
import {
  multiplyDecimal,
  divideDecimal,
  addDecimal,
  subtractDecimal,
  roundToTick
} from '@polymarket/math';
```

**Примеры:**
```typescript
// Дополнение (complement): 1 - price
const one = new Decimal(1);
const complement = subtractDecimal(one, price.value());

// Среднее
const sum = addDecimal(price1.value(), price2.value());
const avgValue = divideDecimal(sum, new Decimal(2));

// Умножение
const multiplied = multiplyDecimal(price.value(), new Decimal(2));

// Округление до тика
const rounded = roundToTick(price.value(), new Decimal(0.0001));
```

---

#### **Rules Layer**

**Файл:** `rules/ValidateTickSize.ts`

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidTickSizeError } from '@polymarket/errors';
import Decimal from 'decimal.js';

/**
 * Правило: TickSize должен быть валидным
 *
 * @remarks
 * Атомарное бизнес-правило.
 * Проверяет что tickSize:
 * - Положительный
 * - Конечный
 * - Не больше чем диапазон цены (0.9998)
 *
 * @example
 * ```typescript
 * const result = ValidateTickSize.check(new Decimal(0.01));
 * if (!result.ok) {
 *   console.error(result.error); // InvalidTickSizeError
 * }
 * ```
 */
export class ValidateTickSize {
  public static check(tickSize: Decimal): Result<void, InvalidTickSizeError> {
    if (!tickSize.isFinite() || tickSize.lessThanOrEqualTo(0)) {
      return Err(
        new InvalidTickSizeError(
          (ctx) => `Tick size must be positive and finite, got ${ctx.tickSize}`,
          {
            code: InvalidTickSizeError.code,
            context: { tickSize: tickSize.toString() }
          }
        )
      );
    }

    // TickSize не должен быть больше диапазона
    if (tickSize.greaterThan(0.9998)) {
      return Err(
        new InvalidTickSizeError(
          (ctx) => `Tick size ${ctx.tickSize} is too large for price range [0.0001, 0.9999]`,
          {
            code: InvalidTickSizeError.code,
            context: { tickSize: tickSize.toString(), maxAllowed: '0.9998' }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

**Файл:** `rules/ValidateSpread.ts`

```typescript
/**
 * Правило: Spread между ценами должен быть валидным
 */
export class ValidateSpread {
  public static check(
    bidPrice: Decimal,
    askPrice: Decimal,
    minSpread: Decimal
  ): Result<void, InvalidSpreadError> {
    // Ask должен быть >= Bid
    if (askPrice.lessThan(bidPrice)) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Ask price ${ctx.ask} must be >= bid price ${ctx.bid}`,
          {
            code: InvalidSpreadError.code,
            context: {
              bid: bidPrice.toString(),
              ask: askPrice.toString()
            }
          }
        )
      );
    }

    // Spread должен быть >= minSpread
    const spread = askPrice.minus(bidPrice);
    if (spread.lessThan(minSpread)) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Spread ${ctx.spread} is less than minimum ${ctx.minSpread}`,
          {
            code: InvalidSpreadError.code,
            context: {
              spread: spread.toString(),
              minSpread: minSpread.toString(),
              bid: bidPrice.toString(),
              ask: askPrice.toString()
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

---

#### **Policy Layer**

**Файл:** `policy/MarketPricePolicy.ts`

```typescript
/**
 * Политика для рыночных цен
 *
 * @remarks
 * Комбинирует правила для конкретного сценария.
 * Проверяет что цена подходит для использования на рынке.
 */
export class MarketPricePolicy {
  /**
   * Проверяет цену для размещения на рынке
   *
   * @param price - Цена
   * @param tickSize - Размер тика рынка
   * @returns Result<void, Error>
   */
  public static validateForMarket(
    price: Decimal,
    tickSize: Decimal
  ): Result<void, InvalidTickSizeError | InvalidPriceError> {
    // 1. Проверяем tickSize
    const tickResult = ValidateTickSize.check(tickSize);
    if (!tickResult.ok) {
      return tickResult;
    }

    // 2. Проверяем что цена кратна tickSize
    const divided = price.dividedBy(tickSize);
    const rounded = divided.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    const remainder = divided.minus(rounded).abs();

    if (remainder.greaterThan(0.0000001)) {
      return Err(
        new InvalidPriceError(
          (ctx) => `Price ${ctx.price} is not aligned to tick size ${ctx.tickSize}`,
          {
            code: InvalidPriceError.code,
            context: {
              price: price.toString(),
              tickSize: tickSize.toString(),
              remainder: remainder.toString()
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

---

#### **Facade Layer**

**Файл:** `facade/PriceService.ts`

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { Price } from '../core/Price.js';
import { InvalidPriceError } from '@polymarket/errors';
import {
  multiplyDecimal,
  divideDecimal,
  addDecimal,
  subtractDecimal,
  roundToTick
} from '@polymarket/math';
import { MarketPricePolicy } from '../policy/MarketPricePolicy.js';
import Decimal from 'decimal.js';

/**
 * Фасад для работы с Price
 *
 * @remarks
 * Единая точка входа для всех операций с ценами.
 * Оркестрирует Core + Math + Rules + Policy.
 */
export class PriceService {
  /**
   * Создаёт Price из значения
   */
  public static create(value: number | string | Decimal): Result<Price, InvalidPriceError> {
    try {
      const price = Price.of(value);
      return Ok(price);
    } catch (error) {
      if (error instanceof Error) {
        return Err(
          new InvalidPriceError(error.message, {
            code: InvalidPriceError.code,
            context: { value: String(value) }
          })
        );
      }
      throw error;
    }
  }

  /**
   * Вычисляет дополнение (1 - price)
   */
  public static complement(price: Price): Price {
    const one = new Decimal(1);
    const complementValue = subtractDecimal(one, price.value());
    return Price.of(complementValue);
  }

  /**
   * Вычисляет среднюю цену
   */
  public static average(price1: Price, price2: Price): Price {
    const sum = addDecimal(price1.value(), price2.value());
    const avgValue = divideDecimal(sum, new Decimal(2));
    return Price.of(avgValue);
  }

  /**
   * Умножает цену на коэффициент
   */
  public static multiply(
    price: Price,
    factor: number | Decimal
  ): Result<Price, InvalidPriceError> {
    const factorDecimal = factor instanceof Decimal ? factor : new Decimal(factor);
    const result = multiplyDecimal(price.value(), factorDecimal);

    return this.create(result);
  }

  /**
   * Делит цену на делитель
   */
  public static divide(
    price: Price,
    divisor: number | Decimal
  ): Result<Price, InvalidPriceError> {
    const divisorDecimal = divisor instanceof Decimal ? divisor : new Decimal(divisor);
    const result = divideDecimal(price.value(), divisorDecimal);

    return this.create(result);
  }

  /**
   * Округляет до тика с проверкой политики
   */
  public static roundToMarketTick(
    price: Price,
    tickSize: Decimal
  ): Result<Price, InvalidPriceError | InvalidTickSizeError> {
    // Проверяем политику
    const policyResult = MarketPricePolicy.validateForMarket(price.value(), tickSize);
    if (!policyResult.ok) {
      return Err(policyResult.error);
    }

    // Округляем
    const rounded = roundToTick(price.value(), tickSize);
    return this.create(rounded);
  }
}
```

---

#### **Adapters Layer**

**Файл:** `adapters/PriceSerializer.ts`

```typescript
/**
 * Сериализация Price в/из JSON
 */
export class PriceSerializer {
  public static toJSON(price: Price): { value: number } {
    return { value: price.toNumber() };
  }

  public static fromJSON(json: { value: number }): Result<Price, InvalidPriceError> {
    return PriceService.create(json.value);
  }
}
```

**Файл:** `adapters/PriceFormatter.ts`

```typescript
/**
 * Форматирование Price в строки
 */
export class PriceFormatter {
  public static toString(price: Price, decimals: number = 4): string {
    return price.value().toFixed(decimals);
  }

  public static toPercentage(price: Price): string {
    const percent = price.value().times(100);
    return `${percent.toFixed(2)}%`;
  }

  public static toDebugString(price: Price): string {
    return `Price(${price.value().toString()})`;
  }
}
```

---

## Детальный план по фазам

### Фаза 0: Подготовка (15 минут)

**Цель:** Создать структуру директорий.

**Команды:**
```bash
cd packages/domain/value-objects/src
mkdir -p price/core
mkdir -p price/rules
mkdir -p price/policy
mkdir -p price/facade
mkdir -p price/adapters
```

**Результат:**
- ✅ Структура директорий создана
- ✅ Готово к началу реализации

---

### Фаза 1: Core Layer (20 минут)

**Файлы:**
- `price/core/Price.ts` - Core VO
- `price/core/index.ts` - Экспорты

**Реализация Price.ts:**
```typescript
import Decimal from 'decimal.js';

/**
 * PriceInvariantViolation - нарушение инварианта Price
 */
export class PriceInvariantViolation extends Error {
  constructor(message: string) {
    super(`Price invariant violation: ${message}`);
    this.name = 'PriceInvariantViolation';
  }
}

/**
 * Core Price Value Object
 *
 * @remarks
 * Содержит ТОЛЬКО инварианты существования:
 * - Диапазон [0.0001, 0.9999]
 * - Конечное значение
 * - Equality comparison
 */
export class Price {
  private static readonly MIN_PRICE = new Decimal(0.0001);
  private static readonly MAX_PRICE = new Decimal(0.9999);

  private constructor(private readonly v: Decimal) {
    // Инвариант 1: Must be finite
    if (!v.isFinite()) {
      throw new PriceInvariantViolation('must be finite');
    }

    // Инвариант 2: Must be >= 0.0001
    if (v.lessThan(Price.MIN_PRICE)) {
      throw new PriceInvariantViolation(`must be >= ${Price.MIN_PRICE.toString()}`);
    }

    // Инвариант 3: Must be <= 0.9999
    if (v.greaterThan(Price.MAX_PRICE)) {
      throw new PriceInvariantViolation(`must be <= ${Price.MAX_PRICE.toString()}`);
    }
  }

  /**
   * Создаёт Price из Decimal/number/string
   */
  public static of(value: number | string | Decimal): Price {
    // Оптимизация: если уже Decimal, не пересоздаём
    const decimal = value instanceof Decimal ? value : new Decimal(value);
    return new Price(decimal);
  }

  /**
   * Константы
   */
  public static readonly MIN = new Price(Price.MIN_PRICE);
  public static readonly MAX = new Price(Price.MAX_PRICE);
  public static readonly HALF = new Price(new Decimal(0.5));

  /**
   * Возвращает Decimal значение
   */
  public value(): Decimal {
    return this.v;
  }

  /**
   * Возвращает number значение
   */
  public toNumber(): number {
    return this.v.toNumber();
  }

  /**
   * Проверяет равенство с другой ценой
   */
  public equals(other: Price, epsilon: Decimal = new Decimal(0.0001)): boolean {
    return this.v.minus(other.v).abs().lessThan(epsilon);
  }

  /**
   * Проверяет что это минимальная цена
   */
  public isMin(): boolean {
    return this.v.equals(Price.MIN_PRICE);
  }

  /**
   * Проверяет что это максимальная цена
   */
  public isMax(): boolean {
    return this.v.equals(Price.MAX_PRICE);
  }
}
```

**Тесты:** `__tests__/unit/price/core/Price.test.ts` (~20 тестов)

---

### Фаза 2: Rules Layer (30 минут)

**Файлы:**
- `price/rules/ValidateTickSize.ts`
- `price/rules/ValidateSpread.ts`
- `price/rules/index.ts`

**Тесты:** `__tests__/unit/price/rules/*.test.ts` (~15 тестов)

---

### Фаза 3: Policy Layer (20 минут)

**Файлы:**
- `price/policy/MarketPricePolicy.ts`
- `price/policy/index.ts`

**Тесты:** `__tests__/unit/price/policy/*.test.ts` (~10 тестов)

---

### Фаза 4: Facade Layer (40 минут)

**Файлы:**
- `price/facade/PriceService.ts` - Главный фасад
- `price/facade/index.ts`

**Тесты:** `__tests__/unit/price/facade/*.test.ts` (~25 тестов)

---

### Фаза 5: Adapters Layer (15 минут)

**Файлы:**
- `price/adapters/PriceSerializer.ts`
- `price/adapters/PriceFormatter.ts`
- `price/adapters/index.ts`

**Тесты:** `__tests__/unit/price/adapters/*.test.ts` (~10 тестов)

---

### Фаза 6: Главный index.ts (10 минут)

**Файл:** `price/index.ts`

```typescript
// Core
export { Price, PriceInvariantViolation } from './core/index.js';

// Facade (главная точка входа)
export { PriceService } from './facade/index.js';

// Adapters
export { PriceSerializer, PriceFormatter } from './adapters/index.js';

// Rules (для advanced use cases)
export { ValidateTickSize, ValidateSpread } from './rules/index.js';

// Policy (для advanced use cases)
export { MarketPricePolicy } from './policy/index.js';
```

---

### Фаза 7: Integration тесты (30 минут)

**Файл:** `__tests__/integration/price/PriceWorkflow.integration.test.ts`

**Сценарии:**
1. Создание → округление → валидация
2. Complement → average → сравнение
3. Multiply → divide → проверка диапазона
4. Сериализация → десериализация
5. Форматирование в разных форматах

---

### Фаза 8: Обновить package.json exports (5 минут)

**Файл:** `packages/domain/value-objects/package.json`

```json
{
  "exports": {
    "./price": {
      "types": "./dist/price/index.d.ts",
      "import": "./dist/price/index.js"
    },
    "./price/core": {
      "types": "./dist/price/core/index.d.ts",
      "import": "./dist/price/core/index.js"
    }
  }
}
```

---

## План тестирования

### Суммарная статистика

| Слой | Unit тестов | Integration |
|------|-------------|-------------|
| Core | 20 | - |
| Rules | 15 | - |
| Policy | 10 | - |
| Facade | 25 | - |
| Adapters | 10 | - |
| **Integration** | - | 15 |
| **Итого** | **80** | **15** |
| **ВСЕГО** | **95 тестов** | |

### Coverage Target

- **Branches:** 100%
- **Functions:** 100%
- **Lines:** 100%
- **Statements:** 100%

---

## План документации

### Файлы документации

1. **`price/README.md`** - Обзор архитектуры Price
2. **`price/docs/architecture.md`** - Детали слоёв
3. **`price/docs/migration-guide.md`** - Гайд по миграции
4. **`price/docs/examples.md`** - Примеры использования

---

## Миграция

### Breaking Changes

**API Changes:**
```typescript
// Было:
const price = Price.fromValue(0.5);

// Стало:
const price = PriceService.create(0.5);
```

### Миграционный скрипт

```bash
# Автоматическая замена импортов
find packages -name "*.ts" -exec sed -i '' 's/import { Price } from/import { PriceService } from/g' {} \;
```

---

## Timeline

| Фаза | Время |
|------|-------|
| 0. Подготовка | 15 мин |
| 1. Core | 20 мин |
| 2. Rules | 30 мин |
| 3. Policy | 20 мин |
| 4. Facade | 40 мин |
| 5. Adapters | 15 мин |
| 6. Index | 10 мин |
| 7. Integration | 30 мин |
| 8. Exports | 5 мин |
| **Итого** | **~3 часа** |

---

**Конец плана для Price**
