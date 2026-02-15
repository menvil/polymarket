# План: Добавление Ratio операций в QuantityService

## Контекст

QuantityService нуждается в методах для работы с относительными изменениями (проценты, коэффициенты) используя Ratio VO.

**Цель:** Добавить type-safe операции с процентами вместо raw numbers.

---

## Use Cases

### 1. **Portion - вычисление части количества**

```typescript
// Взять 25% от позиции
const position = Quantity.of(new Decimal(1000));
const portion25 = RatioService.fromPercent(25).value;
const result = QuantityService.portion(position, portion25);
// 1000 * 0.25 = 250
```

**Где использовать:**
- Partial close позиции (закрыть 50% позиции)
- Расчёт комиссий (комиссия = amount * feeRate)
- Risk management (max position = balance * maxPositionRatio)

### 2. **IncreaseBy - увеличение на процент с округлением**

```typescript
// Увеличить на 10% с округлением к stepSize
const qty = Quantity.of(new Decimal(100));
const increase = RatioService.fromPercent(10).value;
const stepSize = new Decimal(1); // минимальный шаг

const result = QuantityService.increaseBy(qty, increase, stepSize);
// 100 * 1.10 = 110 → round to step 1 → 110
```

**Где использовать:**
- Увеличение ордера на X%
- DCA (dollar-cost averaging) стратегии
- Position sizing с учётом минимального лота

### 3. **Scale - масштабирование (опционально)**

```typescript
// Увеличить позицию в 2 раза
const result = QuantityService.scale(qty, 2);
// qty * 2
```

**Где использовать:**
- Doubling down стратегии
- Leverage adjustments
- Portfolio rebalancing

---

## Архитектурные решения

### 1. **Ratio как параметр vs Decimal**

**Решение:** Принимать **Ratio** напрямую (не `Ratio | number | string`)

**Обоснование:**
- Ratio уже валидирован (через RatioService.fromPercent/fromDecimal)
- Явная семантика (это процент/коэффициент, а не просто число)
- Type safety на уровне API

**Альтернатива:** Принимать `Decimal | number | string` и парсить через RatioService
- ❌ Усложняет API
- ❌ Теряется явная семантика

### 2. **StepSize округление**

**Решение:** Использовать существующий паттерн из `roundToStep()`

**Режимы:**
- `ROUND_HALF_UP` (по умолчанию) - к ближайшему
- `ROUND_DOWN` - вниз (conservative для покупок)
- `ROUND_UP` - вверх (conservative для продаж)

### 3. **scale() vs multiply()**

**Решение:** **НЕ добавлять** `scale()` как отдельный метод

**Обоснование:**
- `multiply()` уже делает то же самое
- Не хотим дублировать функциональность
- Если нужна явная семантика - добавить в документацию `multiply()`

**Документация:**
```typescript
/**
 * @example
 * // Масштабирование (увеличение в 2 раза)
 * const doubled = QuantityService.multiply(qty, 2);
 */
```

---

## Реализация

### Phase 1: portion() ✅ TODO

**Сигнатура:**
```typescript
public static portion(
  quantity: Quantity,
  rate: Ratio
): Result<Quantity, InvalidQuantityError>
```

**Алгоритм:**
1. Вычислить: `value = quantity * rate.toDecimal()`
2. Создать Quantity через `this.create(value)`
3. Wrap в wrapOp для error handling

**Примеры:**
```typescript
// Взять 30% от позиции
const position = Quantity.of(new Decimal(1000));
const rate = RatioService.fromPercent(30).value;
const result = QuantityService.portion(position, rate);
// → 300

// Комиссия 0.2%
const amount = Quantity.of(new Decimal(50000));
const feeRate = RatioService.fromPercent(0.2).value;
const fee = QuantityService.portion(amount, feeRate);
// → 100
```

**Валидация:**
- Quantity уже валиден (non-negative, finite)
- Ratio уже валидирован (через RatioService)
- Result может быть > исходного qty если rate > 1 (это OK)

**Тесты:**
- ✅ Happy path: 25% от 1000 = 250
- ✅ Edge: 0% (rate = 0) → 0
- ✅ Edge: 100% (rate = 1) → исходное qty
- ✅ Edge: > 100% (rate = 1.5) → 1.5x qty
- ✅ Precision: очень малый rate (0.001%)
- ✅ wrapOp error handling

---

### Phase 2: increaseBy() ✅ TODO

**Сигнатура:**
```typescript
public static increaseBy(
  quantity: Quantity,
  delta: Ratio,
  stepSize: Decimal | number | string,
  options?: { roundingMode?: Decimal.Rounding }
): Result<Quantity, InvalidQuantityError>
```

**Алгоритм:**
1. Парсинг stepSize через toDecimal
2. Валидация stepSize через ValidateStepSizeForQuantity
3. Вычислить: `newValue = quantity * delta.onePlus()`
4. Округлить к stepSize: `roundToTick(newValue, stepSize, roundingMode)`
5. Создать Quantity через `this.create(rounded)`

**Примеры:**
```typescript
// Увеличить на 10% с округлением
const qty = Quantity.of(new Decimal(95));
const delta = RatioService.fromPercent(10).value;
const result = QuantityService.increaseBy(qty, delta, 1);
// 95 * 1.10 = 104.5 → round to 105

// Уменьшить на 5% (negative delta)
const decrease = RatioService.fromPercent(-5).value;
const result2 = QuantityService.increaseBy(qty, decrease, 1);
// 95 * 0.95 = 90.25 → round to 90

// С округлением вниз (conservative)
const result3 = QuantityService.increaseBy(
  qty, delta, 1, { roundingMode: Decimal.ROUND_DOWN }
);
// 95 * 1.10 = 104.5 → floor to 104
```

**Опции:**
```typescript
interface IncreaseByOptions {
  roundingMode?: Decimal.Rounding;  // default: ROUND_HALF_UP
}
```

**Валидация:**
- stepSize должен быть > 0 (через ValidateStepSizeForQuantity)
- delta может быть отрицательным (для decrease)
- Результат должен быть non-negative (проверится в Quantity.of)

**Edge cases:**
- delta = 0 → qty остаётся неизменным (после округления к step)
- delta < -100% → результат отрицательный → InvalidQuantityError
- stepSize > qty → может округлиться к 0 → InvalidQuantityError

**Тесты:**
- ✅ Happy path: increase 10%
- ✅ Decrease: -5%
- ✅ Zero delta: 0% (no change)
- ✅ Rounding modes: HALF_UP, DOWN, UP
- ✅ Edge: delta = -100% → qty = 0 (граничный случай)
- ✅ Error: delta < -100% → negative result → Err
- ✅ StepSize alignment
- ✅ Invalid stepSize → Err
- ✅ wrapOp error handling

---

## Сравнение методов

| Метод | Формула | StepSize | Use Case |
|-------|---------|----------|----------|
| **portion** | `qty * rate` | ❌ Нет | Взять % от позиции, комиссии |
| **increaseBy** | `qty * (1 + delta)` → round | ✅ Да | Увеличить/уменьшить на % с округлением |
| **multiply** | `qty * factor` | ❌ Нет | Общее умножение, масштабирование |

---

## Roadmap

### Immediate (Phase 1)
1. ✅ Добавить import Ratio в QuantityService.ts
2. ✅ Реализовать `portion(qty, rate)`
3. ✅ Тесты для portion (~8 тестов)
4. ✅ Документация с примерами

### Short-term (Phase 2)
5. ✅ Реализовать `increaseBy(qty, delta, stepSize, options?)`
6. ✅ Тесты для increaseBy (~12 тестов)
7. ✅ Документация с примерами
8. ✅ Обновить RATIO_USAGE_PLAN.md

### Optional (Future)
- Рассмотреть `decreaseBy()` как синоним для `increaseBy(qty, -delta, ...)`
  - **Решение:** НЕ добавлять, используй `increaseBy` с negative delta
- Добавить примеры в integration tests

---

## Примеры использования

### Risk Management
```typescript
// Ограничить позицию до 25% баланса
const balance = Quantity.of(new Decimal(10000));
const maxPositionRatio = RatioService.fromPercent(25).value;
const maxPosition = QuantityService.portion(balance, maxPositionRatio);
// → 2500
```

### Fee Calculation
```typescript
// Вычислить комиссию 0.2%
const orderSize = Quantity.of(new Decimal(100000));
const feeRate = RatioService.fromPercent(0.2).value;
const fee = QuantityService.portion(orderSize, feeRate);
// → 200
```

### Position Sizing
```typescript
// Увеличить позицию на 20% с минимальным лотом 0.1
const currentPosition = Quantity.of(new Decimal(15.3));
const increase = RatioService.fromPercent(20).value;
const newPosition = QuantityService.increaseBy(
  currentPosition,
  increase,
  0.1,
  { roundingMode: Decimal.ROUND_DOWN } // conservative
);
// 15.3 * 1.20 = 18.36 → floor to 18.3
```

### DCA Strategy
```typescript
// Увеличивать размер ордера на 10% каждый раз
const baseSize = Quantity.of(new Decimal(100));
const increment = RatioService.fromPercent(10).value;

const order1 = baseSize; // 100
const order2 = QuantityService.increaseBy(order1, increment, 1).value; // 110
const order3 = QuantityService.increaseBy(order2, increment, 1).value; // 121
```

---

## Альтернативные подходы (отклонены)

### ❌ Принимать number вместо Ratio
```typescript
// ПЛОХО: неявная семантика
QuantityService.portion(qty, 0.25) // Это 25% или 0.25%?

// ХОРОШО: явная семантика
const rate = RatioService.fromPercent(25);
QuantityService.portion(qty, rate.value)
```

### ❌ Добавить decreaseBy() как отдельный метод
```typescript
// ПЛОХО: дублирование
QuantityService.decreaseBy(qty, delta, stepSize)

// ХОРОШО: используй increaseBy с отрицательным delta
const decrease = RatioService.fromPercent(-5);
QuantityService.increaseBy(qty, decrease.value, stepSize)
```

### ❌ Добавить scale() как алиас multiply()
```typescript
// ПЛОХО: дублирование API
QuantityService.scale(qty, 2)

// ХОРОШО: используй multiply() с явной документацией
QuantityService.multiply(qty, 2) // масштабирование в 2 раза
```

---

## Миграция существующего кода

### BEFORE: Raw numbers
```typescript
// ❌ Неявная семантика
const fee = quantity.value().mul(0.002); // 0.2% или 0.002%?
const newQty = quantity.value().mul(1.10); // увеличение на 10%
```

### AFTER: Ratio-based
```typescript
// ✅ Явная семантика
const feeRate = RatioService.fromPercent(0.2).value;
const fee = QuantityService.portion(quantity, feeRate);

const increase = RatioService.fromPercent(10).value;
const newQty = QuantityService.increaseBy(quantity, increase, stepSize);
```

---

## Следующие шаги

1. **Реализовать portion()** (HIGH PRIORITY)
   - Простой метод, базовая функциональность
   - Нужен для fee calculations

2. **Реализовать increaseBy()** (HIGH PRIORITY)
   - Более сложный (stepSize + rounding)
   - Нужен для position sizing

3. **Обновить документацию** (MEDIUM)
   - Добавить примеры в RATIO_USAGE_PLAN.md
   - Обновить architecture docs

4. **Integration tests** (LOW)
   - Примеры end-to-end сценариев
   - Risk management workflows

---

## Тестовое покрытие

### portion() - ~8 тестов
- Happy path: 25% от 1000
- Edge: 0%, 100%, > 100%
- Precision: очень малый rate
- Error handling

### increaseBy() - ~12 тестов
- Happy path: increase +10%
- Decrease: -5%
- Zero delta
- Rounding modes (3 теста)
- Edge: -100% (boundary)
- Error: < -100% (negative result)
- StepSize validation
- Invalid inputs

**Total:** ~20 новых тестов

---

## Заключение

**Ключевые решения:**
- ✅ Принимать Ratio напрямую (type safety)
- ✅ Использовать onePlus() для increaseBy
- ✅ НЕ добавлять scale() (используй multiply)
- ✅ НЕ добавлять decreaseBy() (используй increaseBy с negative)

**Следующий шаг:** Реализовать `portion()` как базовую операцию.
