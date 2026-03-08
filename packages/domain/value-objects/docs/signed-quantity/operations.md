# SignedQuantity: Операции scale/portion/roundToStep/adjustBy

## Обзор

SignedQuantity поддерживает четыре специализированные операции для работы с масштабированием, процентными изменениями и округлением:

1. **scale(quantity, rate)** - Безопасное масштабирование с неотрицательным rate
2. **portion(quantity, rate)** - Гибкое вычисление части, разрешающее любой rate
3. **roundToStep(quantity, stepSize, roundingMode)** - Округление до шага
4. **adjustBy(quantity, delta, stepSize, options)** - Процентное изменение с округлением и контролем пересечения нуля

## 1. scale() - Безопасное масштабирование

### Назначение

Масштабирует SignedQuantity на неотрицательный rate для предотвращения случайной инверсии знака.

### Сигнатура

```typescript
public static scale(
  quantity: SignedQuantity,
  rate: Ratio
): Result<SignedQuantity, InvalidSignedQuantityError>
```

### Политика

- **Требует:** `rate >= 0` (проверяется через `ValidateFactorForSignedQuantityScale`)
- **Разрешает:** Сохранение знака (positive → positive, negative → negative)
- **Запрещает:** Инверсию знака (защита от случайного флипа позиции)

### Алгоритм

1. Извлечь `rate` как `Decimal` через `Ratio.toDecimal()`
2. Валидация `rate >= 0` и `isFinite` через `ValidateFactorForSignedQuantityScale`
3. Умножение `quantity * rate` через `multiplyDecimal()`
4. Создание `SignedQuantity` через `createFromDecimal()`

### Примеры использования

```typescript
import { SignedQuantityService } from '@polymarket/value-objects';
import { RatioService } from '@polymarket/value-objects';

// ✅ Масштабирование long позиции
const longPositionResult = SignedQuantityService.create(100);
const rate2xResult = RatioService.fromDecimal(2);

if (longPositionResult.ok && rate2xResult.ok) {
  const longPosition = longPositionResult.value;
  const rate2x = rate2xResult.value;

  const scaled = SignedQuantityService.scale(longPosition, rate2x);
  if (scaled.ok) {
    console.log(scaled.value.toNumber()); // 200
  }
}

// ✅ Масштабирование short позиции
const shortPositionResult = SignedQuantityService.create(-50);
const rate15xResult = RatioService.fromDecimal(1.5);

if (shortPositionResult.ok && rate15xResult.ok) {
  const shortPosition = shortPositionResult.value;
  const rate15x = rate15xResult.value;

  const scaledShort = SignedQuantityService.scale(shortPosition, rate15x);
  if (scaledShort.ok) {
    console.log(scaledShort.value.toNumber()); // -75
  }
}

// ❌ Negative rate - ошибка
const negRateResult = RatioService.fromDecimal(-1);
if (longPositionResult.ok && negRateResult.ok) {
  const longPosition = longPositionResult.value;
  const negRate = negRateResult.value;

  const error = SignedQuantityService.scale(longPosition, negRate);
  if (!error.ok) {
    console.log(error.error.context?.reason); // NEGATIVE_SCALE_FACTOR
  }
}
```

### Когда использовать

- **Leverage adjustments** (изменение плеча: 2x → 3x)
- **Position sizing** (безопасное увеличение/уменьшение позиции)
- **Risk scaling** (масштабирование риска пропорционально)

### Отличие от multiply()

| Операция | Rate | Инверсия знака |
|----------|------|----------------|
| `scale()` | `>= 0` | Запрещена |
| `multiply()` | Любой | Разрешена |

## 2. portion() - Вычисление части

### Назначение

Вычисляет часть SignedQuantity как `quantity * rate` без ограничений на знак rate.

### Сигнатура

```typescript
public static portion(
  quantity: SignedQuantity,
  rate: Ratio
): Result<SignedQuantity, InvalidSignedQuantityError>
```

### Политика

- **Разрешает:** Любой finite rate (включая отрицательный)
- **Разрешает:** Инверсию знака (flexible semantic)
- **Запрещает:** Non-finite rate (NaN, Infinity)

### Алгоритм

1. Извлечь `rate` как `Decimal` через `Ratio.toDecimal()`
2. Умножение `quantity * rate` через `multiplyDecimal()` (БЕЗ валидации знака)
3. Создание `SignedQuantity` через `createFromDecimal()`

### Примеры использования

```typescript
// ✅ Взять 25% от позиции
const positionResult = SignedQuantityService.create(100);
const rate25Result = RatioService.fromDecimal(0.25);

if (positionResult.ok && rate25Result.ok) {
  const position = positionResult.value;
  const rate25 = rate25Result.value;
  const portion = SignedQuantityService.portion(position, rate25);
  if (portion.ok) {
    console.log(portion.value.toNumber()); // 25
  }
}

// ✅ Negative rate - инверсия знака
const negRateResult = RatioService.fromDecimal(-0.5);
if (positionResult.ok && negRateResult.ok) {
  const position = positionResult.value;
  const negRate = negRateResult.value;
  const inverted = SignedQuantityService.portion(position, negRate);
  if (inverted.ok) {
    console.log(inverted.value.toNumber()); // -50
  }
}

// ✅ Вычисление P&L (может быть negative)
const costResult = SignedQuantityService.create(100);
const returnRateResult = RatioService.fromDecimal(-0.2); // -20% loss
if (costResult.ok && returnRateResult.ok) {
  const cost = costResult.value;
  const returnRate = returnRateResult.value;
  const pnl = SignedQuantityService.portion(cost, returnRate);
  if (pnl.ok) {
    console.log(pnl.value.toNumber()); // -20
  }
}
```

### Когда использовать

- **Partial close** (закрыть 50% позиции)
- **P&L calculations** (вычисление прибыли/убытка)
- **Fee calculations** (комиссия как % от позиции)
- **Любые вычисления, где rate может быть negative**

### Отличие от scale()

| Операция | Rate | Use case |
|----------|------|----------|
| `scale()` | `>= 0` | Безопасное увеличение/уменьшение позиции |
| `portion()` | Любой | Гибкие вычисления с возможностью инверсии |

## 3. roundToStep() - Округление до шага

### Назначение

Округляет SignedQuantity до ближайшего кратного `stepSize` с указанным режимом округления.

### Сигнатура

```typescript
public static roundToStep(
  quantity: SignedQuantity,
  stepSize: number | string | Decimal,
  roundingMode: Decimal.Rounding = Decimal.ROUND_HALF_UP
): Result<SignedQuantity, InvalidSignedQuantityError>
```

### Политика

- **Требует:** `stepSize > 0` и `isFinite` (проверяется через `ValidateStepSizeForSignedQuantity`)
- **Поддерживает:** Все режимы округления `Decimal.Rounding` (0-8)
- **Корректно обрабатывает:** Отрицательные значения согласно режиму округления

### Режимы округления

| Режим | Описание | Positive | Negative |
|-------|----------|----------|----------|
| `ROUND_HALF_UP` (default) | К ближайшему, .5 вверх | 10.565 → 10.57 | -10.565 → -10.57 |
| `ROUND_DOWN` | К нулю | 10.567 → 10.56 | -10.567 → -10.56 |
| `ROUND_UP` | От нуля | 10.561 → 10.57 | -10.561 → -10.57 |
| `ROUND_FLOOR` | К -Infinity | 10.567 → 10.56 | -10.561 → -10.57 |
| `ROUND_CEIL` | К +Infinity | 10.561 → 10.57 | -10.567 → -10.56 |

### Алгоритм

1. Парсинг `stepSize` в `Decimal` через `toDecimal()`
2. Валидация `stepSize > 0` и `isFinite` через `ValidateStepSizeForSignedQuantity`
3. Округление через `roundToTick(quantity.value(), stepSizeDec, roundingMode)`
4. Создание `SignedQuantity` через `createFromDecimal()`

### Примеры использования

```typescript
import Decimal from 'decimal.js';

// ✅ Округление positive - ROUND_HALF_UP (default)
const qtyResult = SignedQuantityService.create(10.567);
if (qtyResult.ok) {
  const qty = qtyResult.value;
  const rounded = SignedQuantityService.roundToStep(qty, 0.01);
  if (rounded.ok) {
    console.log(rounded.value.toNumber()); // 10.57
  }
}

// ✅ Округление negative - ROUND_HALF_UP
const negQtyResult = SignedQuantityService.create(-10.567);
if (negQtyResult.ok) {
  const negQty = negQtyResult.value;
  const roundedNeg = SignedQuantityService.roundToStep(negQty, 0.01);
  if (roundedNeg.ok) {
    console.log(roundedNeg.value.toNumber()); // -10.57
  }

  // ✅ ROUND_DOWN (к нулю) для negative
  const roundedDown = SignedQuantityService.roundToStep(negQty, 0.01, Decimal.ROUND_DOWN);
  if (roundedDown.ok) {
    console.log(roundedDown.value.toNumber()); // -10.56 (к нулю)
  }
}

// ✅ ROUND_FLOOR (к -Infinity) для negative
const floorQtyResult = SignedQuantityService.create(-10.561);
if (floorQtyResult.ok) {
  const roundedFloor = SignedQuantityService.roundToStep(floorQtyResult.value, 0.01, Decimal.ROUND_FLOOR);
  if (roundedFloor.ok) {
    console.log(roundedFloor.value.toNumber()); // -10.57 (к -Infinity)
  }
}

// ✅ Округление до больших шагов (lot size)
const sharesResult = SignedQuantityService.create(127);
if (sharesResult.ok) {
  const shares = sharesResult.value;
  const roundedToLots = SignedQuantityService.roundToStep(shares, 100);
  if (roundedToLots.ok) {
    console.log(roundedToLots.value.toNumber()); // 100 (ближайшее кратное 100)
  }
}
```

### Когда использовать

- **Order normalization** (округление до минимального лота)
- **Price-quantity alignment** (округление до tick size)
- **Partial close adjustments** (округление остатка позиции)

### Важно: Negative округление

⚠️ **ROUND_DOWN** для negative означает движение к нулю (уменьшает абсолютное значение):

- `ROUND_DOWN: -10.567 → -10.56` (к нулю)
- `ROUND_FLOOR: -10.567 → -10.57` (к -Infinity)

## 4. adjustBy() - Процентное изменение с контролем пересечения нуля

### Назначение

Применяет процентное изменение к SignedQuantity с округлением и контролем пересечения нуля.

### Сигнатура

```typescript
public static adjustBy(
  quantity: SignedQuantity,
  delta: Ratio,
  stepSize: number | string | Decimal,
  options?: {
    roundingMode?: Decimal.Rounding;
    allowCrossZero?: boolean;
  }
): Result<SignedQuantity, InvalidSignedQuantityError>
```

### Параметры

| Параметр | Тип | Default | Описание |
|----------|-----|---------|----------|
| `quantity` | `SignedQuantity` | - | Исходное количество |
| `delta` | `Ratio` | - | Процентное изменение (0.1 = +10%, -0.2 = -20%) |
| `stepSize` | `number\|string\|Decimal` | - | Размер шага для округления |
| `roundingMode` | `Decimal.Rounding` | `ROUND_HALF_UP` | Режим округления |
| `allowCrossZero` | `boolean` | `true` | Разрешить пересечение нуля |

### Политика allowCrossZero

#### allowCrossZero = true (default)

Разрешает смену знака (long → short или наоборот):

```typescript
const qtyResult = SignedQuantityService.create(100);
const deltaResult = RatioService.fromPercent(-150); // -150%

if (qtyResult.ok && deltaResult.ok) {
  const qty = qtyResult.value;
  const delta = deltaResult.value;

  const result = SignedQuantityService.adjustBy(qty, delta, 0.01);
  if (result.ok) {
    console.log(result.value.toNumber()); // -50 ✅ OK - пересечение разрешено
  }
}
```

#### allowCrossZero = false

Запрещает смену знака (защита от случайного флипа позиции):

```typescript
const qtyResult = SignedQuantityService.create(100);
const deltaResult = RatioService.fromPercent(-150); // -150%

if (qtyResult.ok && deltaResult.ok) {
  const qty = qtyResult.value;
  const delta = deltaResult.value;

  const result = SignedQuantityService.adjustBy(qty, delta, 0.01, { allowCrossZero: false });
  if (!result.ok) {
    console.log(result.error.context?.reason); // RESULT_CROSSES_ZERO ❌
  }
}
```

**Проверка при allowCrossZero = false:**

- Если `original === 0` && `result !== 0` → ошибка `CANNOT_ADJUST_ZERO`
- Если `original === 0` && `result === 0` → ✅ OK (delta = 0, идемпотентная операция)
- Если `sign(original) !== sign(result)` && `result !== 0` → ошибка `RESULT_CROSSES_ZERO`
- Если `result === 0` → ✅ OK (граничный случай: схлопывание до нуля разрешено)

### Алгоритм

1. Парсинг `stepSize` в `Decimal` через `toDecimal()`
2. Валидация `stepSize > 0` и `isFinite` через `ValidateStepSizeForSignedQuantity`
3. Вычисление `multiplier = delta.onePlus()` (1 + delta)
4. Умножение `quantity * multiplier` через `multiplyDecimal()`
5. Округление до `stepSize` через `roundToTick()`
6. Если `allowCrossZero = false`: валидация через `ValidateDeltaForAdjustByNoCrossZero`
7. Создание `SignedQuantity` через `createFromDecimal()`

### Примеры использования

```typescript
import Decimal from 'decimal.js';

const positionResult = SignedQuantityService.create(100);
const delta10Result = RatioService.fromPercent(10);
const delta20Result = RatioService.fromPercent(-20);
const delta5555Result = RatioService.fromPercent(5.555);
const delta150Result = RatioService.fromPercent(-150);
const delta100Result = RatioService.fromPercent(-100);

if (positionResult.ok && delta10Result.ok && delta20Result.ok &&
    delta5555Result.ok && delta150Result.ok && delta100Result.ok) {

  const position = positionResult.value;
  const delta10 = delta10Result.value;
  const delta20 = delta20Result.value;
  const delta5555 = delta5555Result.value;
  const delta150 = delta150Result.value;
  const delta100 = delta100Result.value;

  // ✅ Увеличение на 10%
  const increased = SignedQuantityService.adjustBy(position, delta10, 0.01);
  if (increased.ok) {
    console.log(increased.value.toNumber()); // 110
  }

  // ✅ Уменьшение на 20%
  const decreased = SignedQuantityService.adjustBy(position, delta20, 0.01);
  if (decreased.ok) {
    console.log(decreased.value.toNumber()); // 80
  }

  // ✅ Округление до stepSize
  const roundedResult = SignedQuantityService.adjustBy(position, delta5555, 0.01);
  if (roundedResult.ok) {
    console.log(roundedResult.value.toNumber()); // 105.56 (ROUND_HALF_UP)
  }

  // ✅ allowCrossZero = true (default) - разрешено пересечение
  const crossedZero = SignedQuantityService.adjustBy(position, delta150, 0.01);
  if (crossedZero.ok) {
    console.log(crossedZero.value.toNumber()); // -50 ✅
  }

  // ✅ Граничный случай: result === 0 допустим
  const exactZero = SignedQuantityService.adjustBy(position, delta100, 0.01, {
    allowCrossZero: false
  });
  if (exactZero.ok) {
    console.log(exactZero.value.toNumber()); // 0 ✅
  }

  // ❌ allowCrossZero = false - запрещено пересечение
  const errorResult = SignedQuantityService.adjustBy(position, delta150, 0.01, {
    allowCrossZero: false
  });
  if (!errorResult.ok) {
    console.log(errorResult.error.context?.reason); // RESULT_CROSSES_ZERO
  }

  // ✅ adjustBy(0, любой delta, ...) всегда возвращает 0 — даже при allowCrossZero = false
  // Причина: 0 * multiplier = 0 математически, результат всегда 0, check(0, 0) → OK
  const zeroResult = SignedQuantityService.create(0);
  if (zeroResult.ok) {
    const zero = zeroResult.value;
    const alwaysOk = SignedQuantityService.adjustBy(zero, delta10, 0.01, {
      allowCrossZero: false
    });
    if (alwaysOk.ok) {
      console.log(alwaysOk.value.toNumber()); // 0 ✅ (не CANNOT_ADJUST_ZERO!)
    }
  }
  // Примечание: CANNOT_ADJUST_ZERO — это защитная проверка в ValidateDeltaForAdjustByNoCrossZero
  // для сценария (original=0 && result≠0), который недостижим через adjustBy,
  // так как 0 * любой_множитель = 0 всегда.

  // ✅ 0 → 0 разрешено (delta = 0, идемпотентно)
  const deltaZeroResult = RatioService.fromPercent(0);
  if (zeroResult.ok && deltaZeroResult.ok) {
    const ok = SignedQuantityService.adjustBy(zeroResult.value, deltaZeroResult.value, 0.01, {
      allowCrossZero: false
    });
    if (ok.ok) {
      console.log(ok.value.toNumber()); // 0 ✅
    }
  }

  // ✅ Custom rounding mode
  const roundedDown = SignedQuantityService.adjustBy(position, delta5555, 0.01, {
    roundingMode: Decimal.ROUND_DOWN
  });
  if (roundedDown.ok) {
    console.log(roundedDown.value.toNumber()); // 105.55 (ROUND_DOWN)
  }
}
```

### Когда использовать

- **Stop-loss adjustments** (изменение SL на % от текущей цены)
- **Position rebalancing** (увеличить/уменьшить на % с защитой от флипа)
- **Profit taking** (закрыть X% позиции: используй negative delta)
- **Dynamic sizing** (изменение размера позиции на основе volatility)

### Use Cases: allowCrossZero

| Сценарий | allowCrossZero | Обоснование |
|----------|----------------|-------------|
| Profit taking (partial close) | `false` | Защита от случайного флипа long → short |
| Stop-loss adjustment | `false` | SL не должен переходить на другую сторону |
| Position rebalancing | `true` | Может потребоваться полный разворот позиции |
| Liquidation scenarios | `true` | Ликвидация может привести к овердрафту |

## Матрица операций

| Операция | Rate/Delta | Инверсия знака | Округление | Контроль пересечения | Use case |
|----------|------------|----------------|------------|----------------------|----------|
| `scale()` | `>= 0` | ❌ | ❌ | ❌ | Безопасное масштабирование |
| `portion()` | Любой | ✅ | ❌ | ❌ | Гибкие вычисления |
| `roundToStep()` | - | - | ✅ | ❌ | Нормализация к tick size |
| `adjustBy()` | Любой | Опционально | ✅ | ✅ | Процентное изменение с политикой |

## Error Handling

### Новые Error Reasons

```typescript
export enum SignedQuantityErrorReason {
  // ... существующие
  NEGATIVE_SCALE_FACTOR = 'NEGATIVE_SCALE_FACTOR',
  RESULT_CROSSES_ZERO = 'RESULT_CROSSES_ZERO',
  CANNOT_ADJUST_ZERO = 'CANNOT_ADJUST_ZERO'
}
```

### Контракт ошибок

Все методы возвращают `Result<SignedQuantity, InvalidSignedQuantityError>` с полным контекстом:

```typescript
if (isErr(result)) {
  const context = result.error.context;
  // context.op - название операции ('scale', 'portion', 'roundToStep', 'adjustBy')
  // context.quantity - входной quantity
  // context.rate / context.delta - коэффициент
  // context.stepSize - размер шага (для roundToStep, adjustBy)
  // context.roundingMode - режим округления (для roundToStep, adjustBy)
  // context.allowCrossZero - политика пересечения (для adjustBy)
  // context.reason - причина ошибки (enum)
}
```

## Архитектурные решения

### 1. scale() vs portion()

**Почему два метода для умножения?**

- **scale()**: Семантика "безопасное увеличение/уменьшение" → требует rate >= 0
- **portion()**: Семантика "взять часть" → разрешает любой rate, включая negative

Разные use cases требуют разной политики безопасности.

### 2. Domain-Specific Validation (ValidateStepSizeForSignedQuantity)

**Почему создали отдельное правило, а не переиспользовали ValidateStepSizeForQuantity?**

- **Domain Boundary**: SignedQuantity и Quantity — разные домены с разными error types
- **Error Context**: Ошибки должны быть `InvalidSignedQuantityError`, а не `InvalidQuantityError`
- **No Cross-Domain Dependencies**: Избегаем импортов validation rules между доменами
- Логика идентична (`stepSize > 0` и `isFinite`), но контракт ошибок специфичен для SignedQuantity

### 3. Политика allowCrossZero

**Почему default = true?**

- Большинство операций (rebalancing, liquidation) требуют гибкости
- Явный opt-in для строгой политики (`allowCrossZero: false`)
- Следует принципу "flexible by default, strict by choice"

### 4. adjustBy() объединяет multiply + roundToStep + validation

**Почему не отдельные вызовы?**

- Атомарность: все шаги выполняются вместе или fail
- Контекст ошибки содержит все параметры операции
- Упрощает клиентский код для частого паттерна "percent change + round"

## Performance Considerations

### Оптимизации

1. **ValidateFactorForSignedQuantityScale**: Ранняя валидация перед math операциями
2. **roundToTick**: Использует только Decimal API (без конвертации в number)
3. **delta.onePlus()**: Precomputed multiplier (1 + delta) для однократного умножения

### Benchmarks (не измерено, оценка)

- `scale()`: ~same as multiply (+ 1 validation check)
- `portion()`: ~same as multiply (no validation overhead)
- `roundToStep()`: ~roundToTick overhead (division + rounding)
- `adjustBy()`: ~multiply + roundToTick + optional validation

## Testing Strategy

### Coverage (212 tests)

- ✅ Unit tests для validation rules (ValidateFactorForSignedQuantityScale, ValidateDeltaForAdjustByNoCrossZero)
- ✅ Unit tests для каждого метода (happy path, error cases, edge cases)
- ✅ Integration scenarios (combined operations)
- ✅ Error contract verification (context fields present)

### Edge Cases Tested

- Zero inputs (quantity, rate, stepSize)
- Negative inputs (all combinations)
- Boundary values (result === 0 при allowCrossZero = false)
- Different rounding modes (ROUND_DOWN vs ROUND_FLOOR для negative)
- Invalid inputs (NaN, Infinity, negative stepSize)

## See Also

- [SignedQuantity Architecture](./architecture.md)
- [SignedQuantity Facade](./facade.md)
- [SignedQuantity Examples](./examples.md)
- [Quantity Operations](../quantity/operations.md) (для сравнения)
