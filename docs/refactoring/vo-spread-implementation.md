# Spread Value Object: Детальный план рефакторинга

## Метаданные

- **Value Object:** Spread
- **Текущий файл:** `packages/domain/value-objects/src/Spread.ts` (719 lines)
- **Сложность:** Medium (bid-ask pair с математикой)
- **Зависимости:** `@polymarket/math`, `@polymarket/errors`, `@polymarket/result`, Price VO
- **Приоритет:** 🟡 СРЕДНИЙ (market-making, liquidity analysis)

---

## Специфика Spread

### Характеристики

**Назначение:** Представляет bid-ask spread на рынках предсказаний.

**Состав:**
- `bid: Price` - максимальная цена покупки
- `ask: Price` - минимальная цена продажи

**Вычисления:**
- **Width (ширина):** `ask - bid` - абсолютная ширина спреда
- **Midpoint (середина):** `(bid + ask) / 2` - справедливая цена
- **Width Percentage:** `(width / midpoint) * 100` - относительная ширина

**Операции:**
- `tighten(amount)` - сужение спреда (bid ↑, ask ↓)
- `widen(amount)` - расширение спреда (bid ↓, ask ↑)
- `shift(amount)` - сдвиг спреда (bid и ask одинаково)

### Инварианты (Core Layer)

1. ✅ `bid.value() <= ask.value()` - bid не может быть больше ask
2. ✅ `bid` и `ask` являются валидными Price объектами

### Бизнес-правила (контекстуальные)

1. 🔶 `width >= MIN_WIDTH` (минимальная ширина для ликвидности)
2. 🔶 `width <= MAX_WIDTH` (максимальная ширина для нормального рынка)
3. 🔶 `widthPercentage <= MAX_PERCENTAGE` (для волатильных рынков)

---

## Текущее состояние vs Целевое

### Проблемы текущей реализации

1. **Монолитная структура**: Всё в одном классе (719 строк)
2. **Serialization в Core**: `toJSON()`, `toString()`, `toObject()` должны быть в Adapters
3. **Нет Policy Layer**: Отсутствуют контекстуальные правила (нормальный/волатильный рынок)
4. **Нет Rules Layer**: Нет атомарных business rules для валидации ширины

### Целевая архитектура

```
packages/domain/value-objects/
└── spread/
    ├── core/
    │   ├── Spread.ts                    # Core VO (только инварианты)
    │   └── __tests__/
    │       └── Spread.test.ts           # 30 тестов
    ├── rules/
    │   ├── ValidateBidAsk.ts            # bid <= ask
    │   ├── ValidateMinWidth.ts          # width >= min
    │   ├── ValidateMaxWidth.ts          # width <= max
    │   └── __tests__/
    │       └── rules.test.ts            # 18 тестов
    ├── policies/
    │   ├── NormalMarketSpreadPolicy.ts  # для нормального рынка
    │   ├── VolatileMarketSpreadPolicy.ts # для волатильного рынка
    │   └── __tests__/
    │       └── policies.test.ts         # 15 тестов
    ├── facade/
    │   ├── SpreadService.ts             # Orchestration
    │   └── __tests__/
    │       └── SpreadService.test.ts    # 25 тестов
    ├── adapters/
    │   ├── SpreadSerializer.ts          # JSON serialization
    │   ├── SpreadFormatter.ts           # Display formatting
    │   └── __tests__/
    │       └── adapters.test.ts         # 12 тестов
    └── index.ts
```

---

## Core Layer

### Файл: `core/Spread.ts`

```typescript
import Decimal from 'decimal.js';
import { Price } from '@polymarket/value-objects/price';

/**
 * Spread - неизменяемый Value Object для bid-ask spread
 *
 * @remarks
 * **Инварианты (проверяются при создании):**
 * - bid <= ask (bid не может превышать ask)
 * - bid и ask являются валидными Price объектами
 *
 * **Не проверяется в Core:**
 * - Минимальная/максимальная ширина (проверяется в Rules/Policy)
 * - Контекстуальные ограничения рынка (проверяется в Policy)
 *
 * **Вычисления:**
 * - Width: ask - bid
 * - Midpoint: (bid + ask) / 2
 * - Width Percentage: (width / midpoint) * 100
 *
 * @example
 * ```typescript
 * // Создание через static factory
 * const bid = Price.of(new Decimal(0.48));
 * const ask = Price.of(new Decimal(0.52));
 * const spread = Spread.of(bid, ask);
 *
 * // Вычисления
 * spread.width();            // Decimal(0.04)
 * spread.midpoint();         // Price(0.50)
 * spread.widthPercentage();  // Decimal(8)
 * ```
 */
export class Spread {
  /**
   * Epsilon для сравнения с нулём
   */
  private static readonly EPSILON = new Decimal(0.0001);

  /**
   * Private constructor - используйте static factory methods
   *
   * @param b - Bid price
   * @param a - Ask price
   * @throws SpreadInvariantViolation если bid > ask
   */
  private constructor(
    private readonly b: Price,
    private readonly a: Price
  ) {
    // Инвариант: bid <= ask
    if (b.value().greaterThan(a.value())) {
      throw new SpreadInvariantViolation(
        `Bid ${b.value()} cannot be greater than ask ${a.value()}`
      );
    }
  }

  /**
   * Создать Spread из Price объектов
   *
   * @param bid - Bid price
   * @param ask - Ask price
   * @returns Новый Spread
   * @throws SpreadInvariantViolation если bid > ask
   *
   * @remarks
   * Этот метод НЕ возвращает Result, т.к. используется для
   * создания после валидации в Service layer.
   *
   * @example
   * ```typescript
   * const bid = Price.of(new Decimal(0.48));
   * const ask = Price.of(new Decimal(0.52));
   * const spread = Spread.of(bid, ask);
   * ```
   */
  public static of(bid: Price, ask: Price): Spread {
    return new Spread(bid, ask);
  }

  /**
   * Создать spread с нулевой шириной
   *
   * @param price - Цена для bid и ask
   * @returns Spread с нулевой шириной
   *
   * @remarks
   * Spread с нулевой шириной означает идеально ликвидный рынок
   * где цены bid и ask совпадают.
   */
  public static zero(price: Price): Spread {
    return new Spread(price, price);
  }

  // ============================================================================
  // Getters
  // ============================================================================

  /**
   * Получить bid price
   *
   * @returns Bid price
   */
  public bid(): Price {
    return this.b;
  }

  /**
   * Получить ask price
   *
   * @returns Ask price
   */
  public ask(): Price {
    return this.a;
  }

  /**
   * Вычислить ширину спреда
   *
   * @returns Width как Decimal (ask - bid)
   *
   * @remarks
   * Ширина представляет стоимость ликвидности.
   * Узкие спреды = более ликвидные рынки.
   *
   * @example
   * ```typescript
   * const spread = Spread.of(
   *   Price.of(new Decimal(0.48)),
   *   Price.of(new Decimal(0.52))
   * );
   * spread.width(); // Decimal(0.04)
   * ```
   */
  public width(): Decimal {
    return this.a.value().minus(this.b.value());
  }

  /**
   * Вычислить midpoint (среднюю цену)
   *
   * @returns Midpoint как Price
   *
   * @remarks
   * Midpoint = (bid + ask) / 2
   * Представляет теоретическую справедливую цену.
   *
   * @example
   * ```typescript
   * const spread = Spread.of(
   *   Price.of(new Decimal(0.48)),
   *   Price.of(new Decimal(0.52))
   * );
   * spread.midpoint(); // Price(0.50)
   * ```
   */
  public midpoint(): Price {
    const midValue = this.b
      .value()
      .plus(this.a.value())
      .dividedBy(2);

    // Midpoint всегда валиден если bid и ask валидны
    return Price.of(midValue);
  }

  /**
   * Вычислить ширину спреда в процентах
   *
   * @returns Width percentage как Decimal
   *
   * @remarks
   * Percentage = (width / midpoint) * 100
   * Нормализует спред для сравнения на разных уровнях цен.
   *
   * @example
   * ```typescript
   * const spread = Spread.of(
   *   Price.of(new Decimal(0.48)),
   *   Price.of(new Decimal(0.52))
   * );
   * spread.widthPercentage(); // Decimal(8)
   * // Расчёт: (0.04 / 0.50) * 100 = 8%
   * ```
   */
  public widthPercentage(): Decimal {
    const mid = this.midpoint().value();

    // Защита от деления на ноль
    if (mid.equals(0)) {
      return new Decimal(0);
    }

    return this.width().dividedBy(mid).times(100);
  }

  // ============================================================================
  // Comparison (Value Object требование)
  // ============================================================================

  /**
   * Проверить равенство спредов
   *
   * @param other - Другой Spread
   * @returns true если bid и ask равны
   *
   * @example
   * ```typescript
   * const s1 = Spread.of(Price.of(new Decimal(0.48)), Price.of(new Decimal(0.52)));
   * const s2 = Spread.of(Price.of(new Decimal(0.48)), Price.of(new Decimal(0.52)));
   * s1.equals(s2); // true
   * ```
   */
  public equals(other: Spread): boolean {
    return this.b.equals(other.b, new Decimal(0)) && this.a.equals(other.a, new Decimal(0));
  }

  // ============================================================================
  // Utility Checks
  // ============================================================================

  /**
   * Проверить является ли ширина нулевой
   *
   * @returns true если ширина < EPSILON
   *
   * @remarks
   * Spread с нулевой шириной означает bid = ask (идеальная ликвидность).
   */
  public isZeroWidth(): boolean {
    return this.width().abs().lessThan(Spread.EPSILON);
  }

  /**
   * Проверить содержит ли spread цену
   *
   * @param price - Цена для проверки
   * @returns true если bid <= price <= ask
   *
   * @example
   * ```typescript
   * const spread = Spread.of(Price.of(new Decimal(0.48)), Price.of(new Decimal(0.52)));
   * spread.contains(Price.of(new Decimal(0.50))); // true
   * spread.contains(Price.of(new Decimal(0.55))); // false
   * ```
   */
  public contains(price: Price): boolean {
    const priceValue = price.value();
    return !priceValue.lessThan(this.b.value()) && !priceValue.greaterThan(this.a.value());
  }
}

/**
 * Ошибка нарушения инварианта Spread
 *
 * @remarks
 * Выбрасывается из private constructor когда bid > ask.
 * Клиентский код НЕ должен ловить эту ошибку - она означает программную ошибку.
 */
export class SpreadInvariantViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpreadInvariantViolation';
  }
}
```

**Размер:** ~250 строк (вместо 719)

**Что убрали:**
- Factory methods (`create`, `fromNumbers`, `fromJSON`) → переносим в Service
- Операции (`tighten`, `widen`, `shift`) → переносим в Service
- Сериализация (`toJSON`, `toString`, `toObject`) → переносим в Adapters
- Валидации ширины → переносим в Rules/Policy

---

## Rules Layer

### 1. Файл: `rules/ValidateBidAsk.ts`

```typescript
import { type Result, Ok, Err } from '@polymarket/result';
import { InvalidSpreadError } from '@polymarket/errors';
import { Price } from '@polymarket/value-objects/price';

/**
 * Валидация: bid должен быть <= ask
 *
 * @remarks
 * Atomic business rule для проверки корректности bid-ask пары.
 *
 * **Правило:**
 * - Bid — максимальная цена покупки
 * - Ask — минимальная цена продажи
 * - Bid не может превышать Ask (иначе кросс рынка)
 *
 * @example
 * ```typescript
 * const bid = Price.of(new Decimal(0.48));
 * const ask = Price.of(new Decimal(0.52));
 * const result = ValidateBidAsk.check(bid, ask);
 * // result.ok === true
 *
 * const invalidBid = Price.of(new Decimal(0.60));
 * const invalidResult = ValidateBidAsk.check(invalidBid, ask);
 * // invalidResult.ok === false
 * ```
 */
export class ValidateBidAsk {
  /**
   * Проверить что bid <= ask
   *
   * @param bid - Bid price
   * @param ask - Ask price
   * @returns Ok если валидны, Err если bid > ask
   */
  public static check(bid: Price, ask: Price): Result<void, InvalidSpreadError> {
    if (bid.value().greaterThan(ask.value())) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Invalid bid-ask: bid ${ctx.bid} cannot be greater than ask ${ctx.ask}`,
          {
            code: InvalidSpreadError.code,
            context: {
              bid: bid.value().toString(),
              ask: ask.value().toString(),
              constraint: 'bid-ask-order'
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

### 2. Файл: `rules/ValidateMinWidth.ts`

```typescript
import { type Result, Ok, Err } from '@polymarket/result';
import { InvalidSpreadError } from '@polymarket/errors';
import Decimal from 'decimal.js';

/**
 * Валидация: ширина спреда должна быть >= минимума
 *
 * @remarks
 * Atomic business rule для проверки минимальной ширины спреда.
 *
 * **Применение:**
 * - Обеспечение минимальной ликвидности
 * - Предотвращение слишком узких спредов
 * - Market-making rules
 *
 * @example
 * ```typescript
 * const width = new Decimal(0.01);
 * const minWidth = new Decimal(0.005);
 * const result = ValidateMinWidth.check(width, minWidth);
 * // result.ok === true
 * ```
 */
export class ValidateMinWidth {
  /**
   * Проверить что ширина >= минимума
   *
   * @param width - Ширина спреда
   * @param minWidth - Минимальная допустимая ширина
   * @returns Ok если >= минимума, Err если меньше
   */
  public static check(
    width: Decimal,
    minWidth: Decimal
  ): Result<void, InvalidSpreadError> {
    if (width.lessThan(minWidth)) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Spread width ${ctx.width} is less than minimum ${ctx.minWidth}`,
          {
            code: InvalidSpreadError.code,
            context: {
              width: width.toString(),
              minWidth: minWidth.toString(),
              constraint: 'min-width'
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

### 3. Файл: `rules/ValidateMaxWidth.ts`

```typescript
import { type Result, Ok, Err } from '@polymarket/result';
import { InvalidSpreadError } from '@polymarket/errors';
import Decimal from 'decimal.js';

/**
 * Валидация: ширина спреда должна быть <= максимума
 *
 * @remarks
 * Atomic business rule для проверки максимальной ширины спреда.
 *
 * **Применение:**
 * - Обнаружение неликвидных рынков
 * - Предупреждение о широких спредах
 * - Risk management
 *
 * @example
 * ```typescript
 * const width = new Decimal(0.05);
 * const maxWidth = new Decimal(0.10);
 * const result = ValidateMaxWidth.check(width, maxWidth);
 * // result.ok === true
 * ```
 */
export class ValidateMaxWidth {
  /**
   * Проверить что ширина <= максимума
   *
   * @param width - Ширина спреда
   * @param maxWidth - Максимальная допустимая ширина
   * @returns Ok если <= максимума, Err если больше
   */
  public static check(
    width: Decimal,
    maxWidth: Decimal
  ): Result<void, InvalidSpreadError> {
    if (width.greaterThan(maxWidth)) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Spread width ${ctx.width} exceeds maximum ${ctx.maxWidth}`,
          {
            code: InvalidSpreadError.code,
            context: {
              width: width.toString(),
              maxWidth: maxWidth.toString(),
              constraint: 'max-width'
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

### 4. Файл: `rules/index.ts`

```typescript
export { ValidateBidAsk } from './ValidateBidAsk.js';
export { ValidateMinWidth } from './ValidateMinWidth.js';
export { ValidateMaxWidth } from './ValidateMaxWidth.js';
```

---

## Policy Layer

### 1. Файл: `policies/NormalMarketSpreadPolicy.ts`

```typescript
import { type Result, Ok } from '@polymarket/result';
import { InvalidSpreadError } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { ValidateBidAsk } from '../rules/ValidateBidAsk.js';
import { ValidateMinWidth } from '../rules/ValidateMinWidth.js';
import { ValidateMaxWidth } from '../rules/ValidateMaxWidth.js';
import { Price } from '@polymarket/value-objects/price';

/**
 * Policy для валидации спредов на нормальном рынке
 *
 * @remarks
 * Комбинирует business rules для контекста нормального рынка:
 * 1. Bid <= Ask
 * 2. Width >= 0.001 (минимум для ликвидности)
 * 3. Width <= 0.05 (максимум для нормального рынка)
 *
 * **Нормальный рынок:**
 * - Стабильная ликвидность
 * - Низкая волатильность
 * - Узкие спреды (0.1% - 5%)
 *
 * @example
 * ```typescript
 * const bid = Price.of(new Decimal(0.48));
 * const ask = Price.of(new Decimal(0.52));
 * const result = NormalMarketSpreadPolicy.validate(bid, ask);
 * if (result.ok) {
 *   console.log('Spread is valid for normal market');
 * }
 * ```
 */
export class NormalMarketSpreadPolicy {
  /**
   * Минимальная ширина для нормального рынка (0.001 = 0.1%)
   */
  private static readonly MIN_WIDTH = new Decimal(0.001);

  /**
   * Максимальная ширина для нормального рынка (0.05 = 5%)
   */
  private static readonly MAX_WIDTH = new Decimal(0.05);

  /**
   * Валидировать spread для нормального рынка
   *
   * @param bid - Bid price
   * @param ask - Ask price
   * @returns Ok если валиден, Err с описанием проблемы
   *
   * @remarks
   * Проверки:
   * - Bid <= Ask
   * - Width >= 0.001 (MIN_WIDTH)
   * - Width <= 0.05 (MAX_WIDTH)
   */
  public static validate(
    bid: Price,
    ask: Price
  ): Result<void, InvalidSpreadError> {
    // Rule 1: Bid <= Ask
    const bidAskResult = ValidateBidAsk.check(bid, ask);
    if (!bidAskResult.ok) {
      return bidAskResult;
    }

    // Вычисляем ширину
    const width = ask.value().minus(bid.value());

    // Rule 2: Min width
    const minWidthResult = ValidateMinWidth.check(width, NormalMarketSpreadPolicy.MIN_WIDTH);
    if (!minWidthResult.ok) {
      return minWidthResult;
    }

    // Rule 3: Max width
    const maxWidthResult = ValidateMaxWidth.check(width, NormalMarketSpreadPolicy.MAX_WIDTH);
    if (!maxWidthResult.ok) {
      return maxWidthResult;
    }

    return Ok(undefined);
  }
}
```

### 2. Файл: `policies/VolatileMarketSpreadPolicy.ts`

```typescript
import { type Result, Ok } from '@polymarket/result';
import { InvalidSpreadError } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { ValidateBidAsk } from '../rules/ValidateBidAsk.js';
import { ValidateMinWidth } from '../rules/ValidateMinWidth.js';
import { ValidateMaxWidth } from '../rules/ValidateMaxWidth.js';
import { Price } from '@polymarket/value-objects/price';

/**
 * Policy для валидации спредов на волатильном рынке
 *
 * @remarks
 * Комбинирует business rules для контекста волатильного рынка:
 * 1. Bid <= Ask
 * 2. Width >= 0.001 (минимум)
 * 3. Width <= 0.20 (максимум для волатильного рынка)
 *
 * **Волатильный рынок:**
 * - Высокая неопределённость
 * - Быстрые изменения цен
 * - Широкие спреды допустимы (до 20%)
 *
 * @example
 * ```typescript
 * const bid = Price.of(new Decimal(0.40));
 * const ask = Price.of(new Decimal(0.60));
 * const result = VolatileMarketSpreadPolicy.validate(bid, ask);
 * if (result.ok) {
 *   console.log('Spread is valid for volatile market');
 * }
 * ```
 */
export class VolatileMarketSpreadPolicy {
  /**
   * Минимальная ширина (0.001)
   */
  private static readonly MIN_WIDTH = new Decimal(0.001);

  /**
   * Максимальная ширина для волатильного рынка (0.20 = 20%)
   */
  private static readonly MAX_WIDTH = new Decimal(0.20);

  /**
   * Валидировать spread для волатильного рынка
   *
   * @param bid - Bid price
   * @param ask - Ask price
   * @returns Ok если валиден, Err с описанием проблемы
   *
   * @remarks
   * Проверки:
   * - Bid <= Ask
   * - Width >= 0.001 (MIN_WIDTH)
   * - Width <= 0.20 (MAX_WIDTH)
   */
  public static validate(
    bid: Price,
    ask: Price
  ): Result<void, InvalidSpreadError> {
    // Rule 1: Bid <= Ask
    const bidAskResult = ValidateBidAsk.check(bid, ask);
    if (!bidAskResult.ok) {
      return bidAskResult;
    }

    // Вычисляем ширину
    const width = ask.value().minus(bid.value());

    // Rule 2: Min width
    const minWidthResult = ValidateMinWidth.check(width, VolatileMarketSpreadPolicy.MIN_WIDTH);
    if (!minWidthResult.ok) {
      return minWidthResult;
    }

    // Rule 3: Max width
    const maxWidthResult = ValidateMaxWidth.check(width, VolatileMarketSpreadPolicy.MAX_WIDTH);
    if (!maxWidthResult.ok) {
      return maxWidthResult;
    }

    return Ok(undefined);
  }
}
```

### 3. Файл: `policies/index.ts`

```typescript
export { NormalMarketSpreadPolicy } from './NormalMarketSpreadPolicy.js';
export { VolatileMarketSpreadPolicy } from './VolatileMarketSpreadPolicy.js';
```

---

## Facade Layer

### Файл: `facade/SpreadService.ts`

```typescript
import { type Result, Ok, Err } from '@polymarket/result';
import { InvalidSpreadError, InvalidPriceError } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { Price, PriceService } from '@polymarket/value-objects/price';
import { Spread } from '../core/Spread.js';
import { ValidateBidAsk } from '../rules/ValidateBidAsk.js';

/**
 * SpreadService - Facade для работы со Spread
 *
 * @remarks
 * Централизованная точка входа для всех операций со спредами.
 *
 * **Предоставляет:**
 * - Factory methods для создания Spread
 * - Операции tighten/widen/shift с Result error handling
 * - Вычисления метрик спреда
 *
 * **Railway-Oriented Programming:**
 * Все fallible операции возвращают Result<T, E>.
 *
 * @example
 * ```typescript
 * import { SpreadService } from '@polymarket/value-objects/spread';
 * import { unwrap } from '@polymarket/result';
 *
 * // Создание spread
 * const bid = unwrap(PriceService.create(new Decimal(0.48)));
 * const ask = unwrap(PriceService.create(new Decimal(0.52)));
 * const spread = unwrap(SpreadService.create(bid, ask));
 *
 * // Метрики
 * console.log(spread.width()); // Decimal(0.04)
 * console.log(spread.midpoint().value()); // Decimal(0.50)
 *
 * // Операции
 * const tightened = unwrap(SpreadService.tighten(spread, new Decimal(0.01)));
 * ```
 */
export class SpreadService {
  // ============================================================================
  // Factory Methods
  // ============================================================================

  /**
   * Создать Spread из Price объектов
   *
   * @param bid - Bid price
   * @param ask - Ask price
   * @returns Result со Spread или InvalidSpreadError
   *
   * @remarks
   * Валидирует что bid <= ask перед созданием.
   *
   * @example
   * ```typescript
   * const bid = unwrap(PriceService.create(new Decimal(0.48)));
   * const ask = unwrap(PriceService.create(new Decimal(0.52)));
   * const result = SpreadService.create(bid, ask);
   * if (result.ok) {
   *   console.log(result.value.width());
   * }
   * ```
   */
  public static create(bid: Price, ask: Price): Result<Spread, InvalidSpreadError> {
    // Валидация через Rule
    const validationResult = ValidateBidAsk.check(bid, ask);
    if (!validationResult.ok) {
      return Err(validationResult.error);
    }

    try {
      return Ok(Spread.of(bid, ask));
    } catch (error) {
      if (error instanceof Error) {
        return Err(
          new InvalidSpreadError(
            error.message,
            {
              code: InvalidSpreadError.code,
              context: {
                bid: bid.value().toString(),
                ask: ask.value().toString(),
                error: error.message
              }
            }
          )
        );
      }
      throw error;
    }
  }

  /**
   * Создать Spread из числовых значений
   *
   * @param bidValue - Значение bid
   * @param askValue - Значение ask
   * @returns Result со Spread или InvalidPriceError/InvalidSpreadError
   *
   * @example
   * ```typescript
   * const result = SpreadService.fromValues(0.48, 0.52);
   * const spread = unwrap(result);
   * ```
   */
  public static fromValues(
    bidValue: number | Decimal,
    askValue: number | Decimal
  ): Result<Spread, InvalidPriceError | InvalidSpreadError> {
    // Создаём Price объекты
    const bidDecimal = bidValue instanceof Decimal ? bidValue : new Decimal(bidValue);
    const askDecimal = askValue instanceof Decimal ? askValue : new Decimal(askValue);

    const bidResult = PriceService.create(bidDecimal);
    if (!bidResult.ok) {
      return bidResult;
    }

    const askResult = PriceService.create(askDecimal);
    if (!askResult.ok) {
      return askResult;
    }

    return SpreadService.create(bidResult.value, askResult.value);
  }

  /**
   * Создать spread с нулевой шириной
   *
   * @param price - Цена для bid и ask
   * @returns Spread с нулевой шириной
   *
   * @example
   * ```typescript
   * const price = unwrap(PriceService.create(new Decimal(0.50)));
   * const spread = SpreadService.zero(price);
   * console.log(spread.width().toNumber()); // 0
   * ```
   */
  public static zero(price: Price): Spread {
    return Spread.zero(price);
  }

  // ============================================================================
  // Operations
  // ============================================================================

  /**
   * Сузить spread (bid ↑, ask ↓)
   *
   * @param spread - Исходный spread
   * @param amount - Величина сужения
   * @returns Result с новым Spread или InvalidSpreadError
   *
   * @remarks
   * Сдвигает bid вверх и ask вниз на указанную величину.
   * Если amount > width/2, сужает до нулевой ширины.
   *
   * @example
   * ```typescript
   * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
   * const tightened = SpreadService.tighten(spread, new Decimal(0.01));
   * if (tightened.ok) {
   *   console.log(tightened.value.bid().value()); // 0.49
   *   console.log(tightened.value.ask().value()); // 0.51
   * }
   * ```
   */
  public static tighten(
    spread: Spread,
    amount: Decimal
  ): Result<Spread, InvalidSpreadError | InvalidPriceError> {
    // Валидация amount
    if (!amount.isFinite()) {
      return Err(
        new InvalidSpreadError(
          'Tighten amount must be finite',
          {
            code: InvalidSpreadError.code,
            context: { amount: amount.toString() }
          }
        )
      );
    }

    if (amount.isNegative()) {
      return Err(
        new InvalidSpreadError(
          'Tighten amount cannot be negative',
          {
            code: InvalidSpreadError.code,
            context: { amount: amount.toString() }
          }
        )
      );
    }

    // Ограничиваем amount до halfWidth
    const halfWidth = spread.width().dividedBy(2);
    const actualAmount = amount.lessThanOrEqualTo(halfWidth) ? amount : halfWidth;

    // Новые цены
    const newBidResult = PriceService.add(spread.bid(), actualAmount);
    if (!newBidResult.ok) {
      return Err(
        new InvalidSpreadError(
          `Failed to adjust bid: ${newBidResult.error.message}`,
          { context: { error: newBidResult.error.message } }
        )
      );
    }

    const newAskResult = PriceService.subtract(spread.ask(), actualAmount);
    if (!newAskResult.ok) {
      return Err(
        new InvalidSpreadError(
          `Failed to adjust ask: ${newAskResult.error.message}`,
          { context: { error: newAskResult.error.message } }
        )
      );
    }

    return SpreadService.create(newBidResult.value, newAskResult.value);
  }

  /**
   * Расширить spread (bid ↓, ask ↑)
   *
   * @param spread - Исходный spread
   * @param amount - Величина расширения
   * @returns Result с новым Spread или InvalidSpreadError
   *
   * @remarks
   * Сдвигает bid вниз и ask вверх на указанную величину.
   * Соблюдает границы цен [MIN_PRICE, MAX_PRICE].
   *
   * @example
   * ```typescript
   * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
   * const widened = SpreadService.widen(spread, new Decimal(0.02));
   * if (widened.ok) {
   *   console.log(widened.value.bid().value()); // 0.46
   *   console.log(widened.value.ask().value()); // 0.54
   * }
   * ```
   */
  public static widen(
    spread: Spread,
    amount: Decimal
  ): Result<Spread, InvalidSpreadError | InvalidPriceError> {
    // Валидация amount
    if (!amount.isFinite()) {
      return Err(
        new InvalidSpreadError(
          'Widen amount must be finite',
          {
            code: InvalidSpreadError.code,
            context: { amount: amount.toString() }
          }
        )
      );
    }

    if (amount.isNegative()) {
      return Err(
        new InvalidSpreadError(
          'Widen amount cannot be negative',
          {
            code: InvalidSpreadError.code,
            context: { amount: amount.toString() }
          }
        )
      );
    }

    // Новые цены
    const newBidResult = PriceService.subtract(spread.bid(), amount);
    if (!newBidResult.ok) {
      return Err(
        new InvalidSpreadError(
          `Failed to adjust bid: ${newBidResult.error.message}`,
          { context: { error: newBidResult.error.message } }
        )
      );
    }

    const newAskResult = PriceService.add(spread.ask(), amount);
    if (!newAskResult.ok) {
      return Err(
        new InvalidSpreadError(
          `Failed to adjust ask: ${newAskResult.error.message}`,
          { context: { error: newAskResult.error.message } }
        )
      );
    }

    return SpreadService.create(newBidResult.value, newAskResult.value);
  }

  /**
   * Сдвинуть spread вверх или вниз
   *
   * @param spread - Исходный spread
   * @param amount - Величина сдвига (+ вверх, - вниз)
   * @returns Result с новым Spread или InvalidSpreadError
   *
   * @remarks
   * Сдвигает bid и ask на одинаковую величину.
   * Ширина спреда сохраняется.
   * Соблюдает границы цен.
   *
   * @example
   * ```typescript
   * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
   * const shifted = SpreadService.shift(spread, new Decimal(0.05));
   * if (shifted.ok) {
   *   console.log(shifted.value.bid().value()); // 0.53
   *   console.log(shifted.value.ask().value()); // 0.57
   *   console.log(shifted.value.width()); // 0.04 (unchanged)
   * }
   * ```
   */
  public static shift(
    spread: Spread,
    amount: Decimal
  ): Result<Spread, InvalidSpreadError | InvalidPriceError> {
    // Валидация amount
    if (!amount.isFinite()) {
      return Err(
        new InvalidSpreadError(
          'Shift amount must be finite',
          {
            code: InvalidSpreadError.code,
            context: { amount: amount.toString() }
          }
        )
      );
    }

    // Простой подход: сдвигаем обе цены
    const newBidResult = PriceService.add(spread.bid(), amount);
    if (!newBidResult.ok) {
      return Err(
        new InvalidSpreadError(
          `Failed to shift bid: ${newBidResult.error.message}`,
          { context: { error: newBidResult.error.message } }
        )
      );
    }

    const newAskResult = PriceService.add(spread.ask(), amount);
    if (!newAskResult.ok) {
      return Err(
        new InvalidSpreadError(
          `Failed to shift ask: ${newAskResult.error.message}`,
          { context: { error: newAskResult.error.message } }
        )
      );
    }

    return SpreadService.create(newBidResult.value, newAskResult.value);
  }
}
```

**Размер:** ~400 строк

---

## Adapters Layer

### 1. Файл: `adapters/SpreadSerializer.ts`

```typescript
import { type Result, Ok, Err } from '@polymarket/result';
import { InvalidSpreadError } from '@polymarket/errors';
import { Spread } from '../core/Spread.js';
import { SpreadService } from '../facade/SpreadService.js';

/**
 * DTO для сериализации Spread
 */
export interface SpreadDTO {
  /**
   * Bid price
   */
  bid: number;

  /**
   * Ask price
   */
  ask: number;
}

/**
 * Сериализатор для Spread
 *
 * @remarks
 * Отвечает за преобразование между Spread и JSON.
 * Отделяет технические детали сериализации от domain логики.
 *
 * @example
 * ```typescript
 * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
 *
 * // Serialize
 * const dto = SpreadSerializer.toDTO(spread);
 * console.log(dto); // { bid: 0.48, ask: 0.52 }
 *
 * // Deserialize
 * const result = SpreadSerializer.fromDTO(dto);
 * if (result.ok) {
 *   console.log(result.value.width());
 * }
 * ```
 */
export class SpreadSerializer {
  /**
   * Сериализовать Spread в DTO
   *
   * @param spread - Spread для сериализации
   * @returns DTO объект
   */
  public static toDTO(spread: Spread): SpreadDTO {
    return {
      bid: spread.bid().value().toNumber(),
      ask: spread.ask().value().toNumber(),
    };
  }

  /**
   * Десериализовать Spread из DTO
   *
   * @param dto - DTO объект
   * @returns Result со Spread или InvalidSpreadError
   */
  public static fromDTO(dto: SpreadDTO): Result<Spread, InvalidSpreadError> {
    return SpreadService.fromValues(dto.bid, dto.ask);
  }

  /**
   * Сериализовать в JSON строку
   *
   * @param spread - Spread для сериализации
   * @returns JSON строка
   */
  public static toJSON(spread: Spread): string {
    return JSON.stringify(SpreadSerializer.toDTO(spread));
  }

  /**
   * Десериализовать из JSON строки
   *
   * @param json - JSON строка
   * @returns Result со Spread или InvalidSpreadError
   */
  public static fromJSON(json: string): Result<Spread, InvalidSpreadError> {
    try {
      const dto = JSON.parse(json) as SpreadDTO;
      return SpreadSerializer.fromDTO(dto);
    } catch (error) {
      return Err(
        new InvalidSpreadError(
          `Invalid JSON: ${error}`,
          {
            code: InvalidSpreadError.code,
            context: { json, error: String(error) }
          }
        )
      );
    }
  }
}
```

### 2. Файл: `adapters/SpreadFormatter.ts`

```typescript
import { Spread } from '../core/Spread.js';

/**
 * Опции форматирования для Spread
 */
export interface SpreadFormatOptions {
  /**
   * Количество десятичных знаков (по умолчанию 4)
   */
  decimals?: number;

  /**
   * Показать width в скобках (по умолчанию true)
   */
  showWidth?: boolean;

  /**
   * Показать midpoint (по умолчанию false)
   */
  showMidpoint?: boolean;
}

/**
 * Форматтер для Spread
 *
 * @remarks
 * Отвечает за представление Spread в виде строк для UI.
 * Отделяет технические детали форматирования от domain логики.
 *
 * @example
 * ```typescript
 * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
 *
 * // Стандартное форматирование
 * SpreadFormatter.format(spread); // "0.4800-0.5200 (0.0400)"
 *
 * // Без ширины
 * SpreadFormatter.format(spread, { showWidth: false }); // "0.4800-0.5200"
 *
 * // С midpoint
 * SpreadFormatter.format(spread, { showMidpoint: true });
 * // "0.4800-0.5200 (0.0400, mid: 0.5000)"
 * ```
 */
export class SpreadFormatter {
  /**
   * Форматировать Spread в строку
   *
   * @param spread - Spread для форматирования
   * @param options - Опции форматирования
   * @returns Отформатированная строка
   */
  public static format(spread: Spread, options: SpreadFormatOptions = {}): string {
    const { decimals = 4, showWidth = true, showMidpoint = false } = options;

    const bidStr = spread.bid().value().toFixed(decimals);
    const askStr = spread.ask().value().toFixed(decimals);
    let result = `${bidStr}-${askStr}`;

    if (showWidth || showMidpoint) {
      const parts: string[] = [];

      if (showWidth) {
        const widthStr = spread.width().toFixed(decimals);
        parts.push(widthStr);
      }

      if (showMidpoint) {
        const midStr = spread.midpoint().value().toFixed(decimals);
        parts.push(`mid: ${midStr}`);
      }

      result += ` (${parts.join(', ')})`;
    }

    return result;
  }

  /**
   * Форматировать как простую строку bid-ask
   *
   * @param spread - Spread для форматирования
   * @param decimals - Количество десятичных знаков
   * @returns Строка вида "0.4800-0.5200"
   */
  public static toBidAskString(spread: Spread, decimals: number = 4): string {
    return SpreadFormatter.format(spread, { decimals, showWidth: false });
  }

  /**
   * Форматировать с деталями (width + midpoint)
   *
   * @param spread - Spread для форматирования
   * @param decimals - Количество десятичных знаков
   * @returns Строка вида "0.4800-0.5200 (0.0400, mid: 0.5000)"
   */
  public static toDetailedString(spread: Spread, decimals: number = 4): string {
    return SpreadFormatter.format(spread, { decimals, showWidth: true, showMidpoint: true });
  }

  /**
   * Форматировать в объект
   *
   * @param spread - Spread для форматирования
   * @returns Объект с bid, ask, width, midpoint
   *
   * @example
   * ```typescript
   * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
   * const obj = SpreadFormatter.toObject(spread);
   * // { bid: 0.48, ask: 0.52, width: 0.04, midpoint: 0.50 }
   * ```
   */
  public static toObject(spread: Spread): {
    bid: number;
    ask: number;
    width: number;
    midpoint: number;
  } {
    return {
      bid: spread.bid().value().toNumber(),
      ask: spread.ask().value().toNumber(),
      width: spread.width().toNumber(),
      midpoint: spread.midpoint().value().toNumber(),
    };
  }
}
```

### 3. Файл: `adapters/index.ts`

```typescript
export { SpreadSerializer, type SpreadDTO } from './SpreadSerializer.js';
export { SpreadFormatter, type SpreadFormatOptions } from './SpreadFormatter.js';
```

---

## Index Exports

### Файл: `spread/index.ts`

```typescript
// Core
export { Spread, SpreadInvariantViolation } from './core/Spread.js';

// Rules
export {
  ValidateBidAsk,
  ValidateMinWidth,
  ValidateMaxWidth,
} from './rules/index.js';

// Policies
export {
  NormalMarketSpreadPolicy,
  VolatileMarketSpreadPolicy,
} from './policies/index.js';

// Facade
export { SpreadService } from './facade/SpreadService.js';

// Adapters
export {
  SpreadSerializer,
  type SpreadDTO,
  SpreadFormatter,
  type SpreadFormatOptions,
} from './adapters/index.js';
```

---

## Детальный план по фазам

| Фаза | Описание | Файлы | Время |
|------|----------|-------|-------|
| **0** | Подготовка структуры | Создать директории | 10 мин |
| **1** | Core Layer | `core/Spread.ts` + tests | 40 мин |
| **2** | Rules Layer | `rules/*.ts` + tests | 40 мин |
| **3** | Policy Layer | `policies/*.ts` + tests | 35 мин |
| **4** | Facade Layer | `facade/SpreadService.ts` + tests | 50 мин |
| **5** | Adapters Layer | `adapters/*.ts` + tests | 30 мин |
| **6** | Index exports | `index.ts` | 5 мин |
| **7** | Integration тесты | `__tests__/integration/*.test.ts` | 30 мин |
| **8** | Документация | `README.md` | 15 мин |
| **9** | Package exports | Обновить package.json | 5 мин |
| **Итого** | | | **~4 часа** |

---

## План тестирования

| Слой | Unit Tests | Описание |
|------|------------|----------|
| **Core** | 30 | Инварианты, константы, getters, comparison, utility checks |
| **Rules** | 18 | Каждое правило со всеми edge cases |
| **Policy** | 15 | Комбинации rules для нормального/волатильного рынка |
| **Facade** | 25 | Factory methods, операции (tighten/widen/shift), Result handling |
| **Adapters** | 12 | Serialization, formatting |
| **Integration** | 20 | Полные сценарии (market-making, liquidity analysis) |
| **TOTAL** | **120** | |

---

## Миграция

### До (текущий код)

```typescript
import { Spread } from '@polymarket/value-objects';

// Создание
const spread = Spread.create(bid, ask);
const spread2 = Spread.fromNumbers(0.48, 0.52);

// Операции
const tightened = spread.tighten(0.01);
const widened = spread.widen(0.02);

// Сериализация
const json = spread.toJSON();
const str = spread.toString();
```

### После (новая архитектура)

```typescript
import {
  SpreadService,
  NormalMarketSpreadPolicy,
  SpreadSerializer,
  SpreadFormatter,
} from '@polymarket/value-objects/spread';
import { unwrap } from '@polymarket/result';

// Создание через Service
const spread = unwrap(SpreadService.create(bid, ask));
const spread2 = unwrap(SpreadService.fromValues(0.48, 0.52));

// Валидация через Policy
const validation = NormalMarketSpreadPolicy.validate(bid, ask);
if (validation.ok) {
  const spread = unwrap(SpreadService.create(bid, ask));
}

// Операции через Service
const tightened = unwrap(SpreadService.tighten(spread, new Decimal(0.01)));
const widened = unwrap(SpreadService.widen(spread, new Decimal(0.02)));

// Сериализация через Adapter
const dto = SpreadSerializer.toDTO(spread);
const json = SpreadSerializer.toJSON(spread);

// Форматирование через Adapter
const str = SpreadFormatter.format(spread);
const detailed = SpreadFormatter.toDetailedString(spread);
```

---

## Ожидаемый результат

После выполнения плана:

1. ✅ **Layered Architecture** - чистое разделение по слоям
2. ✅ **Result Pattern** - везде где может быть ошибка
3. ✅ **Testability** - 120 тестов с высоким coverage
4. ✅ **Type Safety** - явный error handling через Result
5. ✅ **Separation** - technical concerns отделены от domain
6. ✅ **Policies** - контекстуальная валидация для разных рынков
7. ✅ **Documentation** - TSDoc для каждого public метода

---

**Конец плана для Spread**
