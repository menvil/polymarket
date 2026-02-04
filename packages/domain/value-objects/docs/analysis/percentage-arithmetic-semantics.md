# Percentage Arithmetic: Семантическая проблема add/subtract

**Дата:** 2026-02-03
**Вопрос:** Имеет ли смысл `add(25%, 35%) = 60%`?
**Статус:** Critical Analysis

---

## 🤔 Вопрос пользователя

> "Как ты можешь сложить 25% и 35%? В чем смысл этой операции?"

**Короткий ответ:** Зависит от контекста. Иногда имеет смысл, иногда нет.

---

## ✅ Когда add/subtract ИМЕЕТ смысл

### 1. Суммирование комиссий (Fees)

```typescript
const makerFee = Percentage.of(2);   // 2%
const takerFee = Percentage.of(3);   // 3%
const totalFee = add(makerFee, takerFee);  // 5% ✅

// Применение к сделке:
const tradeAmount = new Decimal(1000);  // $1000
const feeAmount = totalFee.applyTo(tradeAmount);  // $50
```

**Почему имеет смысл:**
- Комиссии **аддитивны** - они независимо вычитаются из суммы
- Maker fee 2% + Taker fee 3% = Total fee 5%
- Реальный use case в Polymarket trading

**Примеры:**
- Exchange fees: maker + taker + network
- Transaction costs: base + premium + insurance
- Service charges: processing + handling + expedite

---

### 2. Суммирование налогов (Taxes)

```typescript
const federalTax = Percentage.of(3);  // 3%
const stateTax = Percentage.of(2);    // 2%
const totalTax = add(federalTax, stateTax);  // 5% ✅

const income = new Decimal(100000);
const totalTaxAmount = totalTax.applyTo(income);  // $5000
```

**Почему имеет смысл:**
- Налоги накладываются **независимо**
- Federal 3% + State 2% = Total 5%

---

### 3. Разница процентов (Spreads)

```typescript
const askPercent = Percentage.of(52);  // 52%
const bidPercent = Percentage.of(48);  // 48%
const spread = subtract(askPercent, bidPercent);  // 4% ✅
```

**Почему имеет смысл:**
- Spread - это **разница** между двумя процентами
- Ask 52% - Bid 48% = Spread 4%
- Реальный use case в market making

---

### 4. Накопление margins/markups

```typescript
const baseMargin = Percentage.of(10);      // 10%
const seasonalMarkup = Percentage.of(5);   // 5%
const totalMargin = add(baseMargin, seasonalMarkup);  // 15% ✅
```

**Почему имеет смысл:**
- Margins добавляются **последовательно**
- Base 10% + Seasonal 5% = Total 15%

---

## ❌ Когда add/subtract НЕ ИМЕЕТ смысла

### 1. Последовательные скидки (Sequential Discounts)

```typescript
const discount1 = Percentage.of(20);  // 20%
const discount2 = Percentage.of(30);  // 30%
const totalDiscount = add(discount1, discount2);  // 50% ❌ НЕПРАВИЛЬНО!

// Правильный расчет:
const price = new Decimal(100);
const afterDiscount1 = price.minus(discount1.applyTo(price));  // 80
const afterDiscount2 = afterDiscount1.minus(discount2.applyTo(afterDiscount1));  // 56
const actualDiscount = Percentage.of(44);  // 44%, не 50%!
```

**Почему НЕ имеет смысл:**
- Скидки **мультипликативны**, не аддитивны
- 20% скидка, затем 30% скидка = 44% общая скидка, не 50%
- Математика: `(1 - 0.20) × (1 - 0.30) = 0.56` → 44% скидка

---

### 2. Compound growth rates

```typescript
const growth1 = Percentage.of(10);  // +10%
const growth2 = Percentage.of(20);  // +20%
const totalGrowth = add(growth1, growth2);  // 30% ❌ НЕПРАВИЛЬНО!

// Правильный расчет:
const value = new Decimal(100);
const afterGrowth1 = value.times(1.10);  // 110
const afterGrowth2 = afterGrowth1.times(1.20);  // 132
const actualGrowth = Percentage.of(32);  // 32%, не 30%!
```

**Почему НЕ имеет смысл:**
- Рост **компаундится**
- +10%, затем +20% = +32% общий рост, не +30%
- Математика: `1.10 × 1.20 = 1.32` → 32% рост

---

### 3. Процентные ставки (Interest Rates)

```typescript
const rate1 = Percentage.of(5);  // 5% годовых
const rate2 = Percentage.of(3);  // 3% годовых
const totalRate = add(rate1, rate2);  // 8% ❌ СМОТРЯ КАК

// Зависит от модели:
// Простой процент (simple interest): 5% + 3% = 8% ✅
// Сложный процент (compound interest): (1.05 × 1.03) - 1 = 8.15% ❌
```

**Почему сложно:**
- Зависит от модели начисления процентов
- Simple interest: аддитивно
- Compound interest: мультипликативно

---

## 📊 Сравнение с другими Value Objects

### Money
```typescript
Money.add(100$, 50$) = 150$  // ✅ ВСЕГДА имеет смысл
Money.subtract(100$, 30$) = 70$  // ✅ ВСЕГДА имеет смысл
```
**Вывод:** Деньги всегда аддитивны.

### Quantity
```typescript
Quantity.add(10, 5) = 15  // ✅ ВСЕГДА имеет смысл
Quantity.subtract(10, 3) = 7  // ✅ ВСЕГДА имеет смысл
```
**Вывод:** Количество всегда аддитивно.

### Price
```typescript
Price.add(0.5, 0.3) = 0.8  // ❓ ЗАВИСИТ
Price.subtract(0.5, 0.2) = 0.3  // ❓ ЗАВИСИТ
```
**Вопрос:** Когда складываешь цены?
- Средняя цена: (price1 + price2) / 2 ✅
- Суммарная стоимость: price × quantity, не price + price ❌
**Вывод:** Price.add тоже семантически спорная операция!

### Percentage
```typescript
Percentage.add(25%, 35%) = 60%  // ❓ ЗАВИСИТ ОТ КОНТЕКСТА
Percentage.subtract(60%, 25%) = 35%  // ❓ ЗАВИСИТ ОТ КОНТЕКСТА
```
**Вывод:** Зависит от того, что проценты представляют.

---

## 🔍 Что я реализовал

### Текущая реализация

```typescript
// PercentageService.ts
public static add(
  a: Percentage,
  b: Percentage
): Result<Percentage, InvalidPercentageError> {
  return wrapOp(
    'add',
    { a: a.value().toString(), b: b.value().toString() },
    () => {
      const sum = addDecimal(a.value(), b.value());  // Простое сложение
      return this.createFromDecimal(sum, 'add', {});
    },
    'percentage',
    InvalidPercentageError
  );
}
```

**Что делает:**
- Простое арифметическое сложение: `a + b`
- Не учитывает семантику (fees vs discounts vs growth)

### Документированный use case

```typescript
// ValidateTotalFee.ts - строки 33-40
const makerFee = Percentage.of(3);   // 3%
const takerFee = Percentage.of(4);   // 4%
const totalFee = PercentageService.add(makerFee, takerFee);  // 7%
// ✅ Это корректно для fees
```

**Что задокументировано:**
- Use case: суммирование комиссий (fees)
- Валидация через ValidateTotalFee (max 10%)
- Применение к трейдам через applyTo()

---

## ⚠️ Проблемы текущей реализации

### 1. Отсутствие семантических ограничений

```typescript
// Ничто не мешает неправильному использованию:
const discount1 = Percentage.of(20);
const discount2 = Percentage.of(30);
const wrongTotal = PercentageService.add(discount1, discount2);  // 50%
// ❌ Математически неверно для последовательных скидок!
```

**Проблема:** API не защищает от семантических ошибок.

### 2. Нет предупреждений в документации

**Что есть:**
- ✅ Примеры с fees (правильное использование)

**Чего нет:**
- ❌ Предупреждение о неправильных use cases
- ❌ Объяснение когда НЕ использовать
- ❌ Альтернативы для compound operations

### 3. Не ясно из названия метода

```typescript
// Неясно что делает:
add(discount1, discount2)  // Simple addition или compound?
```

**Проблема:** Название `add` не отражает семантику (simple vs compound).

---

## 🎯 Возможные решения

### Решение 1: Оставить как есть + Документировать ограничения

**Pros:**
- ✅ Простота API
- ✅ Покрывает основной use case (fees)
- ✅ Не ломает существующий код

**Cons:**
- ❌ Возможны семантические ошибки
- ❌ Требует понимания от разработчика

**Реализация:**
```markdown
## ⚠️ Warning: Semantic Context Matters

`add()` performs **simple arithmetic addition**.

✅ Correct for:
- Fees: maker 2% + taker 3% = total 5%
- Taxes: federal 3% + state 2% = total 5%
- Spreads: ask 52% - bid 48% = spread 4%

❌ INCORRECT for:
- Sequential discounts: 20% then 30% ≠ 50% (use compound calculation)
- Compound growth: +10% then +20% ≠ +30% (use multiplicative)
```

---

### Решение 2: Переименовать методы для ясности

```typescript
// Было:
add(a, b)         // Unclear

// Стало:
addSimple(a, b)   // Explicit: simple arithmetic
addFees(a, b)     // Explicit: for fees
```

**Pros:**
- ✅ Ясная семантика
- ✅ Самодокументирующийся код

**Cons:**
- ❌ Breaking change
- ❌ Verbose API

---

### Решение 3: Добавить compound операции

```typescript
// Для аддитивных процентов:
addSimple(a, b)        // 20% + 30% = 50%

// Для мультипликативных:
addCompound(a, b)      // (1+0.20)×(1+0.30) - 1 = 56%
subtractCompound(a, b) // (1-0.20)×(1-0.30) - 1 = 44%
```

**Pros:**
- ✅ Покрывает оба use cases
- ✅ Явная семантика

**Cons:**
- ❌ Усложнение API
- ❌ Больше методов

---

### Решение 4: Убрать add/subtract вообще

```typescript
// Убрать сомнительные операции:
// - add()
// - subtract()

// Оставить только clear semantics:
// - multiply(p, factor)  ✅ Ясно
// - divide(p, divisor)   ✅ Ясно
// - applyTo(p, value)    ✅ Ясно
```

**Pros:**
- ✅ Убирает семантическую неясность
- ✅ Forced to think about context

**Cons:**
- ❌ Breaking change
- ❌ Неудобно для валидных use cases (fees)

---

## 📋 Мое мнение

### Рекомендация: **Решение 1 (Документировать + Warning)**

**Почему:**

1. **add() валиден для основного use case**
   - Fees в Polymarket - это **основной** use case
   - Simple addition корректен для fees
   - Не стоит усложнять ради edge cases

2. **Семантические проблемы решаются образованием**
   - Добавить warning в документацию
   - Объяснить когда use/не use
   - Примеры правильного и неправильного использования

3. **Consistency с другими модулями**
   - Money имеет add/subtract
   - Quantity имеет add/subtract
   - Price имеет add/subtract (тоже спорно!)
   - Percentage должен быть consistent

4. **Pragmatic approach**
   - Breaking changes дорого
   - Edge cases можно решить документацией
   - Основной use case работает правильно

### Что нужно сделать

#### 1. Обновить документацию

Добавить в `docs/percentage/facade.md`:

```markdown
## ⚠️ Semantic Warning: add() and subtract()

### When to use

✅ **Additive percentages** (independent application):
- Fees: `maker 2% + taker 3% = total 5%`
- Taxes: `federal 3% + state 2% = total 5%`
- Spreads: `ask 52% - bid 48% = spread 4%`

### When NOT to use

❌ **Multiplicative percentages** (sequential application):
- Sequential discounts: `20% then 30% ≠ 50%` (actual: 44%)
- Compound growth: `+10% then +20% ≠ +30%` (actual: 32%)

For compound operations, calculate manually:
\`\`\`typescript
// Wrong:
const total = add(discount1, discount2);

// Right:
const afterFirst = value.times(1 - discount1.toDecimal());
const afterSecond = afterFirst.times(1 - discount2.toDecimal());
\`\`\`
```

#### 2. Добавить JSDoc warning

```typescript
/**
 * Складывает два процента (simple arithmetic addition)
 *
 * @remarks
 * ⚠️ WARNING: This performs SIMPLE addition (a + b).
 *
 * Valid for ADDITIVE percentages:
 * - Fees: maker 2% + taker 3% = 5%
 * - Taxes: federal 3% + state 2% = 5%
 *
 * INVALID for MULTIPLICATIVE percentages:
 * - Sequential discounts (use compound calculation)
 * - Compound growth rates (use multiplication)
 *
 * @example
 * ```typescript
 * // ✅ Correct (fees are additive):
 * const total = PercentageService.add(
 *   Percentage.of(2),  // maker fee
 *   Percentage.of(3)   // taker fee
 * );  // 5%
 *
 * // ❌ Wrong (discounts are multiplicative):
 * const discount = PercentageService.add(
 *   Percentage.of(20),
 *   Percentage.of(30)
 * );  // 50% - INCORRECT! Should be 44%
 * ```
 */
```

---

## 🎓 Lessons Learned

### 1. Value Objects ≠ Pure Math

Value objects представляют **domain concepts**, не просто числа.
- Money.add() - деньги аддитивны ✅
- Percentage.add() - зависит от контекста ⚠️

### 2. Семантика важнее синтаксиса

API должен отражать **business logic**, не только математику.
- `25% + 35%` математически = 60%
- Но business meaning зависит от context

### 3. Документация критична

Когда операция **context-dependent**, документация обязательна.
- Explain когда use
- Warn когда не use
- Show examples (both correct and incorrect)

---

## ✅ Action Items

- [ ] Обновить `docs/percentage/facade.md` с warning
- [ ] Добавить JSDoc warning к add/subtract методам
- [ ] Добавить examples в `docs/percentage/examples.md`:
  - ✅ Correct use (fees)
  - ❌ Incorrect use (sequential discounts)
  - 💡 Alternative (compound calculation)
- [ ] Review Price.add() - та же проблема?

---

**Автор:** Claude Code
**Дата:** 2026-02-03
**Статус:** Analysis Complete
**Решение:** Document + Warning (no breaking changes)
