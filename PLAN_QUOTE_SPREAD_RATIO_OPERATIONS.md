# План: Ratio Operations для Quote и Spread

## Обзор

Добавить операции с Ratio для Quote и Spread value objects:
- **Метрики**: getMidPrice, getSpreadWidth, getSpreadRatio
- **Трансформации**: shiftByRatio, widenByRatio, tightenByRatio, skewByRatio
- **Sizes**: scaleSizesByRatio (только для Quote)
- **Core методы**: spreadAbs(), spreadRatio()

**Принцип разделения:**
- Что относится к **spread** (bid/ask prices) → **SpreadService**
- Что относится к **quote** (prices + sizes) → **QuoteService** (делегирует в SpreadService)

---

## Архитектурная целостность

**Layered Architecture:**
```
Core (value objects)
  ↓ зависимость
Facade (services)
  ↓ зависимость
Adapters (parsers, formatters)
```

**Правила:**
- ✅ Core бросает исключения, НЕ возвращает Result
- ✅ Facade возвращает Result, ловит исключения Core
- ✅ Core НЕ знает о Facade (запрещена обратная зависимость)
- ✅ НЕ плодим алиасы без веской причины
- ✅ Используем существующие методы (DRY)

**Проверка:**
- Spread Core: НЕ меняется (используем существующий `width()`)
- Quote Core: НЕ меняется (используем `quote.spread().width()`)
- Все новые методы: только в Facade (SpreadService, QuoteService)

---

## Фазы реализации

### Phase 1: Extend Error Reasons

#### 1.1. SpreadErrorReason

**Файл:** `src/spread/errors/SpreadErrorReason.ts`

**Добавить:**
```typescript
export enum SpreadErrorReason {
  // ... existing reasons ...

  // Ratio operations
  NOT_TWO_SIDED = 'NOT_TWO_SIDED',
  MID_UNAVAILABLE = 'MID_UNAVAILABLE',
  INVALID_RATIO = 'INVALID_RATIO',
  NEGATIVE_RATIO_NOT_ALLOWED = 'NEGATIVE_RATIO_NOT_ALLOWED',
  RATIO_OUT_OF_BOUNDS = 'RATIO_OUT_OF_BOUNDS',
}
```

**Семантика:**
- `NOT_TWO_SIDED` — операция требует two-sided spread, но spread one-sided
- `MID_UNAVAILABLE` — midpoint не может быть вычислен (bid=ask=0 или теоретически)
- `INVALID_RATIO` — передан невалидный Ratio
- `NEGATIVE_RATIO_NOT_ALLOWED` — для операций widen/tighten ratio должен быть >= 0
- `RATIO_OUT_OF_BOUNDS` — после применения ratio операции результат выходит за границы Price

#### 1.2. QuoteErrorReason

**Файл:** `src/quote/errors/QuoteErrorReason.ts`

**Добавить те же reasons** (Quote делегирует в Spread, но нужны свои reasons для context):
```typescript
export enum QuoteErrorReason {
  // ... existing reasons ...

  // Ratio operations
  NOT_TWO_SIDED = 'NOT_TWO_SIDED',
  MID_UNAVAILABLE = 'MID_UNAVAILABLE',
  INVALID_RATIO = 'INVALID_RATIO',
  NEGATIVE_RATIO_NOT_ALLOWED = 'NEGATIVE_RATIO_NOT_ALLOWED',
  RATIO_OUT_OF_BOUNDS = 'RATIO_OUT_OF_BOUNDS',

  // Size operations
  INVALID_SIZE_FACTOR = 'INVALID_SIZE_FACTOR',
}
```

---

### Phase 2: SpreadService Metrics

**Файл:** `src/spread/facade/SpreadService.ts`

#### 2.1. getMidPrice(spread): Result<Price, InvalidSpreadError>

**Уже существует!** Проверить что возвращает NOT_TWO_SIDED для one-sided spread.

#### 2.2. getSpreadWidth(spread): Result<Decimal, InvalidSpreadError>

```typescript
/**
 * Вычисляет абсолютную ширину spread
 *
 * @param spread - Spread для анализа
 * @returns Result с Decimal (width = ask - bid)
 *
 * @remarks
 * Простая утилита для явного получения width через Result API.
 * Всегда успешна (т.к. bid <= ask инвариант).
 *
 * @example
 * ```typescript
 * const spread = Spread.of(Price.of(0.48), Price.of(0.52));
 * const widthResult = SpreadService.getSpreadWidth(spread);
 *
 * if (widthResult.ok) {
 *   console.log(widthResult.value.toString()); // "0.04"
 * }
 * ```
 */
public static getSpreadWidth(
  spread: Spread
): Result<Decimal, InvalidSpreadError> {
  return wrapOp(
    SpreadService.SERVICE_NAME,
    'getSpreadWidth',
    { bid: spread.bid().value(), ask: spread.ask().value() },
    () => {
      const width = spread.width();
      return Ok(width);
    },
    InvalidSpreadError
  );
}
```

#### 2.3. getSpreadRatio(spread): Result<Ratio, InvalidSpreadError>

```typescript
/**
 * Вычисляет относительный spread (width / midpoint)
 *
 * @param spread - Spread для анализа
 * @returns Result с Ratio или InvalidSpreadError
 *
 * @remarks
 * **Формула:** spreadRatio = width / midpoint
 *
 * **Use cases:**
 * - Скоринг качества котировки (меньше = лучше ликвидность)
 * - Нормализация спреда для сравнения рынков
 * - Оценка transaction costs
 *
 * **Процесс:**
 * 1. Вычисляем midpoint через getMidPrice(spread)
 * 2. width / mid
 * 3. Создаем Ratio.of(result)
 *
 * **Возможные ошибки:**
 * - MID_UNAVAILABLE — если midpoint = 0 (теоретически для Price это невозможно, но защита)
 *
 * @example
 * ```typescript
 * const spread = Spread.of(Price.of(0.48), Price.of(0.52));
 * const ratioResult = SpreadService.getSpreadRatio(spread);
 *
 * if (ratioResult.ok) {
 *   console.log(ratioResult.value.toDecimal().toString()); // "0.08" (8%)
 *   console.log(ratioResult.value.toPercent());             // 8%
 * }
 * ```
 */
public static getSpreadRatio(
  spread: Spread
): Result<Ratio, InvalidSpreadError> {
  return wrapOp(
    SpreadService.SERVICE_NAME,
    'getSpreadRatio',
    { bid: spread.bid().value(), ask: spread.ask().value() },
    () => {
      // 1. Get midpoint
      const midResult = SpreadService.getMidPrice(spread);
      if (isErr(midResult)) {
        throw new InvalidSpreadError(
          () => 'Cannot compute spread ratio: midpoint unavailable',
          {
            context: {
              source: ErrorSource.SERVICE_CALL,
              reason: SpreadErrorReason.MID_UNAVAILABLE,
              bid: spread.bid().value(),
              ask: spread.ask().value(),
            },
          }
        );
      }

      const mid = midResult.value.value();

      // 2. Check for zero midpoint (теоретически невозможно для Price, но защита)
      if (mid.isZero()) {
        throw new InvalidSpreadError(
          () => 'Cannot compute spread ratio: midpoint is zero',
          {
            context: {
              source: ErrorSource.SERVICE_CALL,
              reason: SpreadErrorReason.MID_UNAVAILABLE,
              bid: spread.bid().value(),
              ask: spread.ask().value(),
            },
          }
        );
      }

      // 3. width / mid
      const width = spread.width();
      const ratioValue = width.dividedBy(mid);

      // 4. Create Ratio
      const ratio = Ratio.of(ratioValue);

      return Ok(ratio);
    },
    InvalidSpreadError
  );
}
```

---

### Phase 3: SpreadService Relative Transformations

**Файл:** `src/spread/facade/SpreadService.ts`

#### 4.1. shiftByRatio(spread, shiftRatio): Result<Spread, InvalidSpreadError>

```typescript
/**
 * Сдвигает spread на долю от midpoint
 *
 * @param spread - Исходный spread
 * @param shiftRatio - Доля для сдвига (Ratio), положительная = вверх, отрицательная = вниз
 * @returns Result с новым Spread или InvalidSpreadError
 *
 * @remarks
 * **Семантика:** "Сдвинуть котировку на X% от midpoint"
 *
 * **Формула:**
 * 1. mid = (bid + ask) / 2
 * 2. shiftAbs = mid * shiftRatio
 * 3. shift(spread, shiftAbs)
 *
 * **Use cases:**
 * - Market making: сдвиг котировки на 5% вверх при росте volatility
 * - Risk adjustment: сдвиг на -2% при большой позиции
 *
 * **Процесс:**
 * 1. Вычисляем midpoint через getMidPrice(spread)
 * 2. shiftAbs = mid * shiftRatio.toDecimal()
 * 3. Вызываем существующий shift(spread, shiftAbs)
 *
 * **Возможные ошибки:**
 * - MID_UNAVAILABLE — если spread не two-sided
 * - RATIO_OUT_OF_BOUNDS — если после сдвига bid/ask выходят за границы Price [0.0001, 0.9999]
 *
 * @example
 * ```typescript
 * const spread = Spread.of(Price.of(0.48), Price.of(0.52));
 * const shiftRatio = Ratio.of(new Decimal(0.05)); // 5% вверх
 *
 * const result = SpreadService.shiftByRatio(spread, shiftRatio);
 * if (result.ok) {
 *   // mid = 0.50, shiftAbs = 0.50 * 0.05 = 0.025
 *   console.log(result.value.bid().value()); // 0.505
 *   console.log(result.value.ask().value()); // 0.545
 * }
 * ```
 */
public static shiftByRatio(
  spread: Spread,
  shiftRatio: Ratio
): Result<Spread, InvalidSpreadError> {
  return wrapOp(
    SpreadService.SERVICE_NAME,
    'shiftByRatio',
    {
      bid: spread.bid().value(),
      ask: spread.ask().value(),
      shiftRatio: shiftRatio.toDecimal().toString()
    },
    () => {
      // 1. Get midpoint
      const midResult = SpreadService.getMidPrice(spread);
      if (isErr(midResult)) {
        throw new InvalidSpreadError(
          (ctx) => `Cannot shift by ratio: ${ctx.midError}`,
          {
            context: {
              source: ErrorSource.SERVICE_CALL,
              reason: SpreadErrorReason.MID_UNAVAILABLE,
              bid: spread.bid().value(),
              ask: spread.ask().value(),
              midError: midResult.error.message,
            },
          }
        );
      }

      const mid = midResult.value.value();

      // 2. Calculate absolute shift
      const shiftAbs = mid.times(shiftRatio.toDecimal());

      // 3. Call existing shift()
      const shiftResult = SpreadService.shift(spread, shiftAbs);
      if (isErr(shiftResult)) {
        throw new InvalidSpreadError(
          (ctx) => `Shift by ratio failed: ${ctx.shiftError}`,
          {
            context: {
              source: ErrorSource.SERVICE_CALL,
              reason: SpreadErrorReason.RATIO_OUT_OF_BOUNDS,
              bid: spread.bid().value(),
              ask: spread.ask().value(),
              shiftRatio: shiftRatio.toDecimal().toString(),
              shiftAbs: shiftAbs.toString(),
              shiftError: shiftResult.error.message,
            },
          }
        );
      }

      return Ok(shiftResult.value);
    },
    InvalidSpreadError
  );
}
```

#### 4.2. widenByRatio(spread, deltaWidthRatio): Result<Spread, InvalidSpreadError>

```typescript
/**
 * Расширяет spread на долю от midpoint
 *
 * @param spread - Исходный spread
 * @param deltaWidthRatio - Доля для расширения (Ratio), должен быть >= 0
 * @returns Result с новым Spread или InvalidSpreadError
 *
 * @remarks
 * **Семантика:** "Расширить spread на X% от midpoint"
 *
 * **Формула:**
 * 1. mid = (bid + ask) / 2
 * 2. deltaWidthAbs = mid * deltaWidthRatio
 * 3. amountAbs = deltaWidthAbs / 2
 * 4. newBid = bid - amountAbs
 * 5. newAsk = ask + amountAbs
 *
 * **Реализация через skew:**
 * - skew(spread, -amountAbs, +amountAbs)
 *
 * **Use cases:**
 * - Market making: расширение spread на 2% при низкой ликвидности
 * - Risk management: расширение spread на 5% при высокой volatility
 *
 * **Процесс:**
 * 1. Проверяем deltaWidthRatio >= 0
 * 2. Вычисляем midpoint через getMidPrice(spread)
 * 3. deltaWidthAbs = mid * deltaWidthRatio.toDecimal()
 * 4. amountAbs = deltaWidthAbs / 2
 * 5. Вызываем skew(spread, -amountAbs, +amountAbs)
 *
 * **Возможные ошибки:**
 * - NEGATIVE_RATIO_NOT_ALLOWED — если deltaWidthRatio < 0
 * - MID_UNAVAILABLE — если spread не two-sided
 * - RATIO_OUT_OF_BOUNDS — если после расширения bid/ask выходят за границы Price
 *
 * @example
 * ```typescript
 * const spread = Spread.of(Price.of(0.48), Price.of(0.52));
 * const deltaRatio = Ratio.of(new Decimal(0.02)); // 2% от mid
 *
 * const result = SpreadService.widenByRatio(spread, deltaRatio);
 * if (result.ok) {
 *   // mid = 0.50, deltaAbs = 0.01, amountAbs = 0.005
 *   console.log(result.value.bid().value()); // 0.475
 *   console.log(result.value.ask().value()); // 0.525
 * }
 * ```
 */
public static widenByRatio(
  spread: Spread,
  deltaWidthRatio: Ratio
): Result<Spread, InvalidSpreadError> {
  return wrapOp(
    SpreadService.SERVICE_NAME,
    'widenByRatio',
    {
      bid: spread.bid().value(),
      ask: spread.ask().value(),
      deltaWidthRatio: deltaWidthRatio.toDecimal().toString()
    },
    () => {
      // 1. Validate deltaWidthRatio >= 0
      if (deltaWidthRatio.toDecimal().isNegative()) {
        throw new InvalidSpreadError(
          () => 'Delta width ratio must be non-negative for widen operation',
          {
            context: {
              source: ErrorSource.SERVICE_CALL,
              reason: SpreadErrorReason.NEGATIVE_RATIO_NOT_ALLOWED,
              deltaWidthRatio: deltaWidthRatio.toDecimal().toString(),
            },
          }
        );
      }

      // 2. Get midpoint
      const midResult = SpreadService.getMidPrice(spread);
      if (isErr(midResult)) {
        throw new InvalidSpreadError(
          (ctx) => `Cannot widen by ratio: ${ctx.midError}`,
          {
            context: {
              source: ErrorSource.SERVICE_CALL,
              reason: SpreadErrorReason.MID_UNAVAILABLE,
              bid: spread.bid().value(),
              ask: spread.ask().value(),
              midError: midResult.error.message,
            },
          }
        );
      }

      const mid = midResult.value.value();

      // 3. Calculate absolute delta width and amount
      const deltaWidthAbs = mid.times(deltaWidthRatio.toDecimal());
      const amountAbs = deltaWidthAbs.dividedBy(2);

      // 4. Widen via skew: bid -= amountAbs, ask += amountAbs
      const skewResult = SpreadService.skew(spread, amountAbs.negated(), amountAbs);
      if (isErr(skewResult)) {
        throw new InvalidSpreadError(
          (ctx) => `Widen by ratio failed: ${ctx.skewError}`,
          {
            context: {
              source: ErrorSource.SERVICE_CALL,
              reason: SpreadErrorReason.RATIO_OUT_OF_BOUNDS,
              bid: spread.bid().value(),
              ask: spread.ask().value(),
              deltaWidthRatio: deltaWidthRatio.toDecimal().toString(),
              deltaWidthAbs: deltaWidthAbs.toString(),
              amountAbs: amountAbs.toString(),
              skewError: skewResult.error.message,
            },
          }
        );
      }

      return Ok(skewResult.value);
    },
    InvalidSpreadError
  );
}
```

#### 4.3. tightenByRatio(spread, deltaWidthRatio): Result<Spread, InvalidSpreadError>

```typescript
/**
 * Сужает spread на долю от midpoint
 *
 * @param spread - Исходный spread
 * @param deltaWidthRatio - Доля для сужения (Ratio), должен быть >= 0
 * @returns Result с новым Spread или InvalidSpreadError
 *
 * @remarks
 * **Семантика:** "Сузить spread на X% от midpoint"
 *
 * **Формула:**
 * 1. mid = (bid + ask) / 2
 * 2. deltaWidthAbs = mid * deltaWidthRatio
 * 3. amountAbs = deltaWidthAbs / 2
 * 4. Clamp: amountAbs = min(amountAbs, currentWidth/2) (чтобы не пересечь bid/ask)
 * 5. newBid = bid + amountAbs
 * 6. newAsk = ask - amountAbs
 *
 * **Реализация через tighten:**
 * - Вызываем существующий tighten(spread, amountAbs) который уже делает clamp
 *
 * **Use cases:**
 * - Market making: сужение spread на 1% при высокой ликвидности
 * - Competitive pricing: сужение spread на 0.5% чтобы быть внутри рынка
 *
 * **Процесс:**
 * 1. Проверяем deltaWidthRatio >= 0
 * 2. Вычисляем midpoint через getMidPrice(spread)
 * 3. deltaWidthAbs = mid * deltaWidthRatio.toDecimal()
 * 4. amountAbs = deltaWidthAbs / 2
 * 5. Вызываем существующий tighten(spread, amountAbs) (он делает clamp)
 *
 * **Возможные ошибки:**
 * - NEGATIVE_RATIO_NOT_ALLOWED — если deltaWidthRatio < 0
 * - MID_UNAVAILABLE — если spread не two-sided
 * - RATIO_OUT_OF_BOUNDS — если после сужения bid/ask выходят за границы Price
 *
 * @example
 * ```typescript
 * const spread = Spread.of(Price.of(0.48), Price.of(0.52));
 * const deltaRatio = Ratio.of(new Decimal(0.02)); // 2% от mid
 *
 * const result = SpreadService.tightenByRatio(spread, deltaRatio);
 * if (result.ok) {
 *   // mid = 0.50, deltaAbs = 0.01, amountAbs = 0.005
 *   console.log(result.value.bid().value()); // 0.485
 *   console.log(result.value.ask().value()); // 0.515
 * }
 * ```
 */
public static tightenByRatio(
  spread: Spread,
  deltaWidthRatio: Ratio
): Result<Spread, InvalidSpreadError> {
  return wrapOp(
    SpreadService.SERVICE_NAME,
    'tightenByRatio',
    {
      bid: spread.bid().value(),
      ask: spread.ask().value(),
      deltaWidthRatio: deltaWidthRatio.toDecimal().toString()
    },
    () => {
      // 1. Validate deltaWidthRatio >= 0
      if (deltaWidthRatio.toDecimal().isNegative()) {
        throw new InvalidSpreadError(
          () => 'Delta width ratio must be non-negative for tighten operation',
          {
            context: {
              source: ErrorSource.SERVICE_CALL,
              reason: SpreadErrorReason.NEGATIVE_RATIO_NOT_ALLOWED,
              deltaWidthRatio: deltaWidthRatio.toDecimal().toString(),
            },
          }
        );
      }

      // 2. Get midpoint
      const midResult = SpreadService.getMidPrice(spread);
      if (isErr(midResult)) {
        throw new InvalidSpreadError(
          (ctx) => `Cannot tighten by ratio: ${ctx.midError}`,
          {
            context: {
              source: ErrorSource.SERVICE_CALL,
              reason: SpreadErrorReason.MID_UNAVAILABLE,
              bid: spread.bid().value(),
              ask: spread.ask().value(),
              midError: midResult.error.message,
            },
          }
        );
      }

      const mid = midResult.value.value();

      // 3. Calculate absolute delta width and amount
      const deltaWidthAbs = mid.times(deltaWidthRatio.toDecimal());
      const amountAbs = deltaWidthAbs.dividedBy(2);

      // 4. Tighten (existing method already does clamp)
      const tightenResult = SpreadService.tighten(spread, amountAbs);
      if (isErr(tightenResult)) {
        throw new InvalidSpreadError(
          (ctx) => `Tighten by ratio failed: ${ctx.tightenError}`,
          {
            context: {
              source: ErrorSource.SERVICE_CALL,
              reason: SpreadErrorReason.RATIO_OUT_OF_BOUNDS,
              bid: spread.bid().value(),
              ask: spread.ask().value(),
              deltaWidthRatio: deltaWidthRatio.toDecimal().toString(),
              deltaWidthAbs: deltaWidthAbs.toString(),
              amountAbs: amountAbs.toString(),
              tightenError: tightenResult.error.message,
            },
          }
        );
      }

      return Ok(tightenResult.value);
    },
    InvalidSpreadError
  );
}
```

#### 4.4. skewByRatio(spread, bidRatio, askRatio): Result<Spread, InvalidSpreadError>

```typescript
/**
 * Наклоняет spread на доли от midpoint
 *
 * @param spread - Исходный spread
 * @param bidRatio - Доля для изменения bid (Ratio), положительная = вверх
 * @param askRatio - Доля для изменения ask (Ratio), положительная = вверх
 * @returns Result с новым Spread или InvalidSpreadError
 *
 * @remarks
 * **Семантика:** "Наклонить spread на X% и Y% от midpoint"
 *
 * **Формула:**
 * 1. mid = (bid + ask) / 2
 * 2. bidAdjAbs = mid * bidRatio
 * 3. askAdjAbs = mid * askRatio
 * 4. newBid = bid + bidAdjAbs
 * 5. newAsk = ask + askAdjAbs
 *
 * **Реализация через skew:**
 * - skew(spread, bidAdjAbs, askAdjAbs)
 *
 * **Use cases:**
 * - Inventory skew: bidRatio=+2%, askRatio=-1% (сдвиг вверх с наклоном)
 * - Asymmetric adjustment: bidRatio=+1%, askRatio=+3% (расширение с наклоном вверх)
 *
 * **Процесс:**
 * 1. Вычисляем midpoint через getMidPrice(spread)
 * 2. bidAdjAbs = mid * bidRatio.toDecimal()
 * 3. askAdjAbs = mid * askRatio.toDecimal()
 * 4. Вызываем существующий skew(spread, bidAdjAbs, askAdjAbs)
 *
 * **Возможные ошибки:**
 * - MID_UNAVAILABLE — если spread не two-sided
 * - RATIO_OUT_OF_BOUNDS — если после skew bid/ask выходят за границы Price или bid > ask
 *
 * @example
 * ```typescript
 * const spread = Spread.of(Price.of(0.48), Price.of(0.52));
 * const bidRatio = Ratio.of(new Decimal(0.02));  // +2% от mid
 * const askRatio = Ratio.of(new Decimal(-0.01)); // -1% от mid
 *
 * const result = SpreadService.skewByRatio(spread, bidRatio, askRatio);
 * if (result.ok) {
 *   // mid = 0.50, bidAdj = 0.01, askAdj = -0.005
 *   console.log(result.value.bid().value()); // 0.49
 *   console.log(result.value.ask().value()); // 0.515
 * }
 * ```
 */
public static skewByRatio(
  spread: Spread,
  bidRatio: Ratio,
  askRatio: Ratio
): Result<Spread, InvalidSpreadError> {
  return wrapOp(
    SpreadService.SERVICE_NAME,
    'skewByRatio',
    {
      bid: spread.bid().value(),
      ask: spread.ask().value(),
      bidRatio: bidRatio.toDecimal().toString(),
      askRatio: askRatio.toDecimal().toString()
    },
    () => {
      // 1. Get midpoint
      const midResult = SpreadService.getMidPrice(spread);
      if (isErr(midResult)) {
        throw new InvalidSpreadError(
          (ctx) => `Cannot skew by ratio: ${ctx.midError}`,
          {
            context: {
              source: ErrorSource.SERVICE_CALL,
              reason: SpreadErrorReason.MID_UNAVAILABLE,
              bid: spread.bid().value(),
              ask: spread.ask().value(),
              midError: midResult.error.message,
            },
          }
        );
      }

      const mid = midResult.value.value();

      // 2. Calculate absolute adjustments
      const bidAdjAbs = mid.times(bidRatio.toDecimal());
      const askAdjAbs = mid.times(askRatio.toDecimal());

      // 3. Skew
      const skewResult = SpreadService.skew(spread, bidAdjAbs, askAdjAbs);
      if (isErr(skewResult)) {
        throw new InvalidSpreadError(
          (ctx) => `Skew by ratio failed: ${ctx.skewError}`,
          {
            context: {
              source: ErrorSource.SERVICE_CALL,
              reason: SpreadErrorReason.RATIO_OUT_OF_BOUNDS,
              bid: spread.bid().value(),
              ask: spread.ask().value(),
              bidRatio: bidRatio.toDecimal().toString(),
              askRatio: askRatio.toDecimal().toString(),
              bidAdjAbs: bidAdjAbs.toString(),
              askAdjAbs: askAdjAbs.toString(),
              skewError: skewResult.error.message,
            },
          }
        );
      }

      return Ok(skewResult.value);
    },
    InvalidSpreadError
  );
}
```

---

### Phase 4: QuoteService Metrics (Delegation)

**Файл:** `src/quote/facade/QuoteService.ts`

#### 6.1. getMidPrice(quote): Result<Price, InvalidQuoteError>

```typescript
/**
 * Вычисляет midpoint quote
 *
 * @param quote - Quote для анализа
 * @returns Result с Price (midpoint) или InvalidQuoteError
 *
 * @remarks
 * Делегирует в SpreadService.getMidPrice(quote.spread()).
 * Переупаковывает SpreadError в QuoteError.
 *
 * **Возможные ошибки:**
 * - NOT_TWO_SIDED — если quote не two-sided
 *
 * @example
 * ```typescript
 * const quote = QuoteService.create(...);
 * const midResult = QuoteService.getMidPrice(quote);
 *
 * if (midResult.ok) {
 *   console.log(midResult.value.value().toString()); // "0.50"
 * }
 * ```
 */
public static getMidPrice(
  quote: Quote
): Result<Price, InvalidQuoteError> {
  return wrapOp(
    QuoteService.SERVICE_NAME,
    'getMidPrice',
    { bidPrice: quote.bidPrice().value(), askPrice: quote.askPrice().value() },
    () => {
      // Delegate to SpreadService
      const spreadMidResult = SpreadService.getMidPrice(quote.spread());

      if (isErr(spreadMidResult)) {
        // Re-wrap SpreadError as QuoteError
        throw new InvalidQuoteError(
          (ctx) => `Cannot get mid price: ${ctx.spreadError}`,
          {
            context: {
              source: ErrorSource.SERVICE_CALL,
              reason: QuoteErrorReason.NOT_TWO_SIDED,
              bidPrice: quote.bidPrice().value(),
              askPrice: quote.askPrice().value(),
              spreadError: spreadMidResult.error.message,
            },
          }
        );
      }

      return Ok(spreadMidResult.value);
    },
    InvalidQuoteError
  );
}
```

#### 6.2. getSpreadRatio(quote): Result<Ratio, InvalidQuoteError>

```typescript
/**
 * Вычисляет относительный spread quote (width / midpoint)
 *
 * @param quote - Quote для анализа
 * @returns Result с Ratio или InvalidQuoteError
 *
 * @remarks
 * Делегирует в SpreadService.getSpreadRatio(quote.spread()).
 *
 * **Возможные ошибки:**
 * - NOT_TWO_SIDED — если quote не two-sided
 * - MID_UNAVAILABLE — если midpoint = 0
 *
 * @example
 * ```typescript
 * const quote = QuoteService.create(...);
 * const ratioResult = QuoteService.getSpreadRatio(quote);
 *
 * if (ratioResult.ok) {
 *   console.log(ratioResult.value.toPercent()); // "8%"
 * }
 * ```
 */
public static getSpreadRatio(
  quote: Quote
): Result<Ratio, InvalidQuoteError> {
  return wrapOp(
    QuoteService.SERVICE_NAME,
    'getSpreadRatio',
    { bidPrice: quote.bidPrice().value(), askPrice: quote.askPrice().value() },
    () => {
      // Delegate to SpreadService
      const spreadRatioResult = SpreadService.getSpreadRatio(quote.spread());

      if (isErr(spreadRatioResult)) {
        // Re-wrap SpreadError as QuoteError
        throw new InvalidQuoteError(
          (ctx) => `Cannot get spread ratio: ${ctx.spreadError}`,
          {
            context: {
              source: ErrorSource.SERVICE_CALL,
              reason: QuoteErrorReason.MID_UNAVAILABLE,
              bidPrice: quote.bidPrice().value(),
              askPrice: quote.askPrice().value(),
              spreadError: spreadRatioResult.error.message,
            },
          }
        );
      }

      return Ok(spreadRatioResult.value);
    },
    InvalidQuoteError
  );
}
```

---

### Phase 5: QuoteService Transformations (Delegation + Sizes)

**Файл:** `src/quote/facade/QuoteService.ts`

#### 7.1. shiftByRatio(quote, shiftRatio): Result<Quote, InvalidQuoteError>

```typescript
/**
 * Сдвигает quote на долю от midpoint (цены меняются, sizes сохраняются)
 *
 * @param quote - Исходный quote
 * @param shiftRatio - Доля для сдвига (Ratio)
 * @returns Result с новым Quote или InvalidQuoteError
 *
 * @remarks
 * Делегирует spread операцию в SpreadService.shiftByRatio,
 * пересоздает Quote с новым spread и теми же sizes.
 *
 * **Процесс:**
 * 1. newSpread = SpreadService.shiftByRatio(quote.spread(), shiftRatio)
 * 2. Quote.of(newSpread, quote.bidSize(), quote.askSize(), ...)
 *
 * @example
 * ```typescript
 * const quote = QuoteService.create(...);
 * const shiftRatio = Ratio.of(new Decimal(0.05)); // 5% вверх
 *
 * const result = QuoteService.shiftByRatio(quote, shiftRatio);
 * if (result.ok) {
 *   console.log(result.value.bidPrice().value()); // shifted bid
 *   console.log(result.value.bidSize().toNumber()); // same size
 * }
 * ```
 */
public static shiftByRatio(
  quote: Quote,
  shiftRatio: Ratio
): Result<Quote, InvalidQuoteError> {
  return wrapOp(
    QuoteService.SERVICE_NAME,
    'shiftByRatio',
    {
      bidPrice: quote.bidPrice().value(),
      askPrice: quote.askPrice().value(),
      shiftRatio: shiftRatio.toDecimal().toString()
    },
    () => {
      // 1. Shift spread
      const newSpreadResult = SpreadService.shiftByRatio(quote.spread(), shiftRatio);

      if (isErr(newSpreadResult)) {
        throw new InvalidQuoteError(
          (ctx) => `Cannot shift quote by ratio: ${ctx.spreadError}`,
          {
            context: {
              source: ErrorSource.SERVICE_CALL,
              reason: QuoteErrorReason.RATIO_OUT_OF_BOUNDS,
              bidPrice: quote.bidPrice().value(),
              askPrice: quote.askPrice().value(),
              shiftRatio: shiftRatio.toDecimal().toString(),
              spreadError: newSpreadResult.error.message,
            },
          }
        );
      }

      // 2. Create new Quote with new spread, same sizes
      const newQuote = Quote.of(
        newSpreadResult.value,
        quote.bidSize(),
        quote.askSize(),
        quote.marketDataSourceId(),
        quote.instrumentId()
      );

      return Ok(newQuote);
    },
    InvalidQuoteError
  );
}
```

#### 7.2-7.4. widenByRatio, tightenByRatio, skewByRatio

Аналогично shiftByRatio - делегируют в SpreadService, пересоздают Quote с новым spread.

#### 7.5. scaleSizesByRatio(quote, sizeFactor): Result<Quote, InvalidQuoteError>

```typescript
/**
 * Масштабирует sizes quote на factor (цены сохраняются)
 *
 * @param quote - Исходный quote
 * @param sizeFactor - Factor для масштабирования sizes (Ratio), должен быть > 0
 * @returns Result с новым Quote или InvalidQuoteError
 *
 * @remarks
 * **⚠️ UNSAFE: Не применяет venue-specific stepSize/minSize/maxSize.**
 *
 * **Семантика:** "Масштабировать размеры на X%"
 *
 * **Use cases:**
 * - Risk management: shrink sizes на 50% при большой позиции
 * - Scaling: увеличить sizes на 200% при высокой confidence
 *
 * **Процесс:**
 * 1. Validate sizeFactor > 0
 * 2. newBidSize = QuantityService.multiply(quote.bidSize(), sizeFactor.toDecimal())
 * 3. newAskSize = QuantityService.multiply(quote.askSize(), sizeFactor.toDecimal())
 * 4. Quote.of(quote.spread(), newBidSize, newAskSize, ...)
 *
 * **Возможные ошибки:**
 * - INVALID_SIZE_FACTOR — если sizeFactor <= 0
 * - INVALID_FORMAT — если результат не валиден для Quantity
 *
 * @example
 * ```typescript
 * const quote = QuoteService.create(...); // bidSize=100, askSize=100
 * const factor = Ratio.of(new Decimal(0.5)); // 50%
 *
 * const result = QuoteService.scaleSizesByRatio(quote, factor);
 * if (result.ok) {
 *   console.log(result.value.bidSize().toNumber()); // 50
 *   console.log(result.value.askSize().toNumber()); // 50
 *   console.log(result.value.bidPrice().value()); // same price
 * }
 * ```
 */
public static scaleSizesByRatio(
  quote: Quote,
  sizeFactor: Ratio
): Result<Quote, InvalidQuoteError> {
  return wrapOp(
    QuoteService.SERVICE_NAME,
    'scaleSizesByRatio',
    {
      bidSize: quote.bidSize().toNumber(),
      askSize: quote.askSize().toNumber(),
      sizeFactor: sizeFactor.toDecimal().toString()
    },
    () => {
      // 1. Validate sizeFactor > 0
      if (sizeFactor.toDecimal().lessThanOrEqualTo(0)) {
        throw new InvalidQuoteError(
          () => 'Size factor must be positive',
          {
            context: {
              source: ErrorSource.SERVICE_CALL,
              reason: QuoteErrorReason.INVALID_SIZE_FACTOR,
              sizeFactor: sizeFactor.toDecimal().toString(),
            },
          }
        );
      }

      // 2. Scale bid size
      const newBidSizeResult = QuantityService.multiply(
        quote.bidSize(),
        sizeFactor.toDecimal()
      );

      if (isErr(newBidSizeResult)) {
        throw new InvalidQuoteError(
          (ctx) => `Cannot scale bid size: ${ctx.quantityError}`,
          {
            context: {
              source: ErrorSource.SERVICE_CALL,
              reason: QuoteErrorReason.INVALID_FORMAT,
              bidSize: quote.bidSize().toNumber(),
              sizeFactor: sizeFactor.toDecimal().toString(),
              quantityError: newBidSizeResult.error.message,
            },
          }
        );
      }

      // 3. Scale ask size
      const newAskSizeResult = QuantityService.multiply(
        quote.askSize(),
        sizeFactor.toDecimal()
      );

      if (isErr(newAskSizeResult)) {
        throw new InvalidQuoteError(
          (ctx) => `Cannot scale ask size: ${ctx.quantityError}`,
          {
            context: {
              source: ErrorSource.SERVICE_CALL,
              reason: QuoteErrorReason.INVALID_FORMAT,
              askSize: quote.askSize().toNumber(),
              sizeFactor: sizeFactor.toDecimal().toString(),
              quantityError: newAskSizeResult.error.message,
            },
          }
        );
      }

      // 4. Create new Quote with same spread, new sizes
      const newQuote = Quote.of(
        quote.spread(),
        newBidSizeResult.value,
        newAskSizeResult.value,
        quote.marketDataSourceId(),
        quote.instrumentId()
      );

      return Ok(newQuote);
    },
    InvalidQuoteError
  );
}
```

---

### Phase 6: Tests

#### 6.1. SpreadService Ratio Tests

**Файл:** `src/spread/__tests__/SpreadService.ratio.test.ts`

Тесты (минимум 30):
- getSpreadRatio: normal cases, edge cases (zero mid)
- shiftByRatio: positive/negative, edge cases
- widenByRatio: normal, negative ratio error, large ratio
- tightenByRatio: normal, clamp to width/2, negative ratio error
- skewByRatio: symmetric/asymmetric, bid>ask error

#### 6.2. QuoteService Ratio Tests

**Файл:** `src/quote/__tests__/QuoteService.ratio.test.ts`

Тесты (минимум 35):
- getMidPrice, getSpreadRatio (delegation)
- shiftByRatio, widenByRatio, tightenByRatio, skewByRatio (delegation + Quote recreation)
- scaleSizesByRatio: normal, factor validation, edge cases

---

### Phase 7: Documentation

#### 9.1. Update Spread Documentation

**Файлы:**
- `docs/spread/README.md` — добавить примеры Ratio operations
- `docs/spread/facade.md` — документировать новые методы

#### 9.2. Update Quote Documentation

**Файлы:**
- `docs/quote/README.md` — добавить примеры Ratio operations
- `docs/quote/facade.md` — документировать новые методы

#### 9.3. Update Main README

**Файл:** `docs/README.md`

Обновить секции про Spread и Quote с упоминанием Ratio operations.

---

## Итоговая структура

### Spread Core
- **Без изменений** — используем существующий `width()` ✅

### SpreadService новые методы (6):
1. `getSpreadWidth(spread): Result<Decimal, ...>` — Result обертка для `spread.width()`
2. `getSpreadRatio(spread): Result<Ratio, ...>` — вычисление width / mid
3. `shiftByRatio(spread, ratio): Result<Spread, ...>` — сдвиг на % от mid
4. `widenByRatio(spread, ratio): Result<Spread, ...>` — расширение на % от mid
5. `tightenByRatio(spread, ratio): Result<Spread, ...>` — сужение на % от mid
6. `skewByRatio(spread, bidRatio, askRatio): Result<Spread, ...>` — наклон на % от mid

### Quote Core
- **Без изменений** — используем `quote.spread().width()` ✅

### QuoteService новые методы (7):
1. `getMidPrice(quote): Result<Price, ...>` — делегирует в SpreadService
2. `getSpreadRatio(quote): Result<Ratio, ...>` — делегирует в SpreadService
3. `shiftByRatio(quote, ratio): Result<Quote, ...>` — делегирует + sizes
4. `widenByRatio(quote, ratio): Result<Quote, ...>` — делегирует + sizes
5. `tightenByRatio(quote, ratio): Result<Quote, ...>` — делегирует + sizes
6. `skewByRatio(quote, bidRatio, askRatio): Result<Quote, ...>` — делегирует + sizes
7. `scaleSizesByRatio(quote, factor): Result<Quote, ...>` — масштабирование sizes (только Quote)

**Всего:** 13 новых методов (только Facade) + тесты + документация

**Архитектурная целостность:** ✅
- Core не меняется (нет алиасов, нет ссылок на Facade)
- Все новые методы только в Facade
- DRY: используем существующие методы (`width()`, `shift()`, `tighten()`, `skew()`)

---

## Порядок реализации

1. **Phase 1** — Error reasons (быстро, foundation)
2. **Phase 2** — SpreadService metrics (foundation для transformations)
3. **Phase 3** — SpreadService transformations (основная логика)
4. **Phase 4** — QuoteService metrics (delegation)
5. **Phase 5** — QuoteService transformations (delegation + scaleSizes)
6. **Phase 6** — Tests (все фазы)
7. **Phase 7** — Documentation

Каждая фаза — отдельный коммит.

**Изменения от исходного плана:**
- ❌ Убрали Phase 2 (Spread Core) — нет изменений в Core
- ❌ Убрали Phase 5 (Quote Core) — нет изменений в Core
- ✅ Все новые методы только в Facade (архитектурная целостность)
- ✅ Используем существующие методы (DRY, нет алиасов)

---

## Вопросы / Решения

1. **PriceDelta = Decimal** ✅
2. **scaleSizesByRatio** — реализовываем ✅
3. **Spread operations** — в SpreadService ✅
4. **Quote operations** — делегируют в SpreadService + работают с sizes ✅
5. **getMidPrice уже существует в SpreadService?** — проверить и переиспользовать
