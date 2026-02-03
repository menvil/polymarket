# Проблемы в реализации Value Objects - Краткая сводка

## 🔴 Критические проблемы

### 1. Money.value() vs Price/Quantity.value()

```typescript
const decimal = price.value();     // Price
const decimal = quantity.value();  // Quantity  
const decimal = money.value();    // Money ❌ РАЗНОЕ!
```

**Решение:** Переименовать `Money.value()` → `Money.value()`

### 2. Различия в проверке NaN/Finite

```typescript
// Price & Money - две проверки
if (v.isNaN()) throw NAN;
if (!v.isFinite()) throw NON_FINITE;

// Quantity - одна проверка (isFinite покрывает NaN)
if (!v.isFinite()) throw NON_FINITE;
```

**Решение:** Единый подход - явные проверки NaN и Finite везде

### 3. MoneyParseError vs InvariantViolation

```typescript
// Money различает
throw new MoneyParseError(...)        // Parse error
throw new MoneyInvariantViolation(...) // Invariant

// Price & Quantity не различают
```

**Решение:** Добавить ParseError в Price и Quantity

---

## 🟡 Средние проблемы

### 4. Дублирование в ErrorReason enums

```typescript
// Price
NEGATIVE_PRICE vs OUT_OF_RANGE_LOW      // Одно и то же!
EXCEEDS_MAX_PRICE vs OUT_OF_RANGE_HIGH  // Одно и то же!

// Quantity
NEGATIVE_QUANTITY vs NEGATIVE           // Два разных negative!
```

### 5. Разные подходы к константам

```typescript
Price.MIN           // Метод
Quantity.ZERO         // Static readonly
Money.ZERO.USDC       // Lazy getter
```

**Решение:** Везде static readonly

### 6. Неполнота методов сравнения

```typescript
// Quantity - полный набор
isLessThan(), isGreaterThan(), ...

// Price & Money - минимум
equals(), isMin()/isMax()
```

---

## 🟢 Минорные проблемы

1. Алиас `Money.toDecimal()` (убрать)
2. Разный порядок проверок инвариантов
3. `Price.MIN.value()/maxValue()` - лишние методы

---

## План действий (Приоритет 1)

1. ✅ **Переименовать Money.value() → value()**
2. ✅ **Унифицировать проверки инвариантов** (NaN → Finite → Domain)
3. ✅ **Добавить ParseError в Price/Quantity**

## Влияние

- **Breaking changes**: Money.value() переименование
- **Files affected**: ~50 файлов (Money*, тесты, документация)
- **Migration effort**: Средний (deprecated алиас на 1 релиз)
