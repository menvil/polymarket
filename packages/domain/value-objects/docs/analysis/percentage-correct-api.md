# Percentage: Правильный минимальный API

**Дата:** 2026-02-03
**Проблема:** Текущий API перегружен ненужными методами
**Решение:** Минималистичный API с фокусом на применение к базе

---

## ❌ Что ЛИШНЕЕ в текущем API

### 1. add/subtract процентов

```typescript
// ❌ ЛИШНЕЕ:
PercentageService.add(Percentage.of(2), Percentage.of(3));  // 5%

// ✅ ПРОСТО:
const total = Percentage.of(2 + 3);  // 5%
```

**Почему лишнее:**

- Процент - это отношение, не абсолютное значение
- Сложение чисел проще чем сложение объектов
- Семантически некорректно без привязки к базе

---

### 2. multiply/divide процентов

```typescript
// ❌ ЛИШНЕЕ:
const doubled = Percentage.of(2).multiply(2);  // 4%

// ✅ ПРОСТО:
const doubled = Percentage.of(2 * 2);  // 4%
```

**Почему лишнее:**

- Нет реального domain use case
- Умножение чисел проще чем умножение объектов
- Overcomplicated для простой операции

---

## ✅ Что НУЖНО в API

### Основные операции на базе

```typescript
class Percentage {
  private readonly ratio: Decimal;  // 0.02 для 2%

  // 1. Вычислить процент ОТ числа
  of(base: Decimal): Decimal {
    return base.times(this.ratio);
    // 2% от 1000 = 20
  }

  // 2. Добавить процент К числу
  addTo(base: Decimal): Decimal {
    return base.plus(this.of(base));
    // 1000 + 2% = 1000 + 20 = 1020
  }

  // 3. Вычесть процент ОТ числа
  subtractFrom(base: Decimal): Decimal {
    return base.minus(this.of(base));
    // 1000 - 2% = 1000 - 20 = 980
  }
}
```

---

## 📊 Примеры использования

### Пример 1: Markup (Наценка)

```typescript
const cost = new Decimal(1000);        // Себестоимость
const markup = Percentage.of(20);      // 20% наценка

const price = markup.addTo(cost);      // 1200
// cost + 20% = 1000 + 200 = 1200
```

### Пример 2: Discount (Скидка)

```typescript
const price = new Decimal(1000);       // Цена
const discount = Percentage.of(15);    // 15% скидка

const finalPrice = discount.subtractFrom(price);  // 850
// price - 15% = 1000 - 150 = 850
```

### Пример 3: Fee (Комиссия)

```typescript
const tradeAmount = new Decimal(1000);
const takerFee = Percentage.of(3);     // 3% комиссия

const feeAmount = takerFee.of(tradeAmount);  // 30
const netAmount = tradeAmount.minus(feeAmount);  // 970

// Или короче:
const netAmount = takerFee.subtractFrom(tradeAmount);  // 970
```

### Пример 4: Total Fee (Сумма комиссий)

```typescript
const tradeAmount = new Decimal(1000);

// Складываем ЧИСЛА, не проценты:
const makerFeePercent = 0.3;
const takerFeePercent = 2;
const totalFeePercent = makerFeePercent + takerFeePercent;  // 2.3

// Создаем Percentage и применяем:
const totalFee = Percentage.of(totalFeePercent);
const feeAmount = totalFee.of(tradeAmount);  // 23
```

### Пример 5: Tax (Налог)

```typescript
const income = new Decimal(100000);
const incomeTax = Percentage.of(13);   // 13% подоходный

const taxAmount = incomeTax.of(income);         // 13000
const netIncome = incomeTax.subtractFrom(income);  // 87000
```

### Пример 6: Reverse VAT (Извлечь НДС из суммы)

```typescript
const totalWithVAT = new Decimal(1200);  // Сумма с НДС
const vatRate = Percentage.of(20);       // НДС 20%

// НДС уже включен, нужно извлечь:
// total = base * (1 + rate)
// base = total / (1 + rate)
const base = totalWithVAT.dividedBy(new Decimal(1).plus(vatRate.toDecimal()));
// 1200 / 1.20 = 1000

const vatAmount = totalWithVAT.minus(base);  // 200
```

---

## 🔧 Полный минимальный API

```typescript
class Percentage {
  private readonly value: Decimal;  // 2 для 2%

  // ===== Factory Methods =====

  static of(value: number | string | Decimal): Percentage;
  static fromDecimal(decimal: Decimal): Percentage;  // 0.02 → 2%
  static fromBasisPoints(bp: number): Percentage;     // 200 bp → 2%

  // ===== Core Operations (на базе) =====

  // Вычислить процент от числа:
  of(base: Decimal): Decimal;
  // Alias для clarity:
  applyTo(base: Decimal): Decimal;  // То же что of()

  // Добавить процент к числу:
  addTo(base: Decimal): Decimal;

  // Вычесть процент от числа:
  subtractFrom(base: Decimal): Decimal;

  // ===== Conversions =====

  value(): Decimal;           // 2 для 2%
  toNumber(): number;         // 2 для 2%
  toDecimal(): Decimal;       // 0.02 для 2%
  toBasisPoints(): number;    // 200 для 2%

  // ===== Comparison =====

  equals(other: Percentage): boolean;
  isLessThan(other: Percentage): boolean;
  isGreaterThan(other: Percentage): boolean;
  isLessThanOrEqual(other: Percentage): boolean;
  isGreaterThanOrEqual(other: Percentage): boolean;
  isZero(): boolean;
  isNegative(): boolean;
  isPositive(): boolean;

  // ===== Constants =====

  static ZERO: Percentage;
  static ONE_HUNDRED: Percentage;
  static min(): Percentage;  // -100%
  static max(): Percentage;  // 100%
}
```

---

## ❌ Что УБРАТЬ

### Из Service

```typescript
// Убрать:
PercentageService.add(a, b);
PercentageService.subtract(a, b);
PercentageService.multiply(p, factor);
PercentageService.divide(p, divisor);
```

**Причины:**

- add/subtract: складывай числа, не объекты
- multiply/divide: нет реального use case

### Оставить в Service

```typescript
// Оставить только:
PercentageService.create(value);              // Factory
PercentageService.fromDecimal(decimal);       // Factory
PercentageService.fromBasisPoints(bp);        // Factory
```

**Все операции на базе** - в Core (методы экземпляра):

```typescript
percentage.of(base);
percentage.addTo(base);
percentage.subtractFrom(base);
```

---

## 🎯 Migration Guide

### Было: add/subtract процентов

```typescript
// ❌ Было:
const totalFee = PercentageService.add(
  Percentage.of(0.3),
  Percentage.of(2)
);

// ✅ Стало:
const totalFeeValue = 0.3 + 2;  // Просто сложи числа!
const totalFee = Percentage.of(totalFeeValue);
```

### Было: multiply/divide

```typescript
// ❌ Было:
const doubled = PercentageService.multiply(
  Percentage.of(2),
  2
);

// ✅ Стало:
const doubled = Percentage.of(2 * 2);  // Просто умножь число!
```

### Новое: addTo/subtractFrom

```typescript
// ❌ Было (неудобно):
const discount = Percentage.of(10);
const price = new Decimal(1000);
const discountAmount = discount.applyTo(price);
const finalPrice = price.minus(discountAmount);

// ✅ Стало:
const discount = Percentage.of(10);
const finalPrice = discount.subtractFrom(new Decimal(1000));
```

---

## 📋 Implementation Plan

### Phase 1: Добавить новые методы

```typescript
// В Percentage core:
public addTo(base: Decimal): Decimal {
  return base.plus(this.value().dividedBy(100).times(base));
}

public subtractFrom(base: Decimal): Decimal {
  return base.minus(this.value().dividedBy(100).times(base));
}

// Rename applyTo → of (более семантично):
public of(base: Decimal): Decimal {
  return this.value().dividedBy(100).times(base);
}

// Оставить applyTo как alias:
public applyTo(base: Decimal): Decimal {
  return this.of(base);
}
```

### Phase 2: Deprecate старые методы

```typescript
/**
 * @deprecated Use simple arithmetic instead: Percentage.of(a + b)
 */
public static add(a: Percentage, b: Percentage): Result<Percentage, InvalidPercentageError> {
  // ...
}

/**
 * @deprecated Use simple arithmetic instead: Percentage.of(p * factor)
 */
public static multiply(p: Percentage, factor: number): Result<Percentage, InvalidPercentageError> {
  // ...
}
```

### Phase 3: Update documentation

- Обновить все примеры на новый API
- Добавить migration guide
- Показать правильные паттерны

### Phase 4: Remove (major version)

- Удалить add/subtract/multiply/divide из Service
- Оставить только минимальный API

---

## 💡 Почему это лучше

### 1. Простота

```typescript
// Старый способ (overcomplicated):
const total = PercentageService.add(
  Percentage.of(2),
  Percentage.of(3)
);

// Новый способ (simple):
const total = Percentage.of(2 + 3);
```

### 2. Семантика

```typescript
// Старый (неясно):
applyTo(base);  // Что делает?

// Новый (явно):
of(base);           // Процент ОТ числа
addTo(base);        // Добавить К числу
subtractFrom(base); // Вычесть ОТ числа
```

### 3. Меньше кода

```typescript
// Старый (много кода):
const discountAmount = discount.applyTo(price);
const finalPrice = price.minus(discountAmount);

// Новый (лаконично):
const finalPrice = discount.subtractFrom(price);
```

### 4. Фокус на применении

**Процент всегда применяется К базе** - это главное!

---

## ✅ Checklist

- [ ] Добавить `addTo()` в Percentage core
- [ ] Добавить `subtractFrom()` в Percentage core
- [ ] Добавить `of()` как alias для `applyTo()`
- [ ] Deprecate `add/subtract/multiply/divide` в Service
- [ ] Обновить документацию
- [ ] Обновить примеры
- [ ] Написать migration guide
- [ ] Спланировать removal в major version

---

**Автор:** Claude Code
**Дата:** 2026-02-03
**Статус:** Correct Minimal API Designed
