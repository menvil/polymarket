# Comparison: Ratio vs Percentage

Объяснение почему Percentage был удален и как Ratio решает проблемы.

## Содержание

- [TL;DR](#tldr)
- [Проблемы Percentage](#проблемы-percentage)
- [Решение: Ratio](#решение-ratio)
- [Ключевые отличия](#ключевые-отличия)
- [Migration Guide](#migration-guide)
- [Философия дизайна](#философия-дизайна)

## TL;DR

**Почему Percentage был удален:**

- Операции `add/subtract/multiply/divide` бессмысленны без контекста
- "Процент это доля ОТ ЧИСЛА" - требуется база для вычислений
- Standalone value object для процентов создавал ложные абстракции

**Что заменяет Percentage:**

- **Ratio** - минимальная абстракция для относительных величин
- Операции живут в целевых value objects (Money, Price, Quantity)
- Четкая семантика: ratio хранит дробь, а не процент

## Проблемы Percentage

### Проблема 1: Бессмысленные операции

```typescript
// ❌ Старый подход (Percentage value object)
const discount1 = Percentage.of(25); // 25%
const discount2 = Percentage.of(35); // 35%

// ⚠️ Что это значит?
const total = discount1.add(discount2); // 60%?
// 25% + 35% = 60%? Процентов чего? Как это применить?
```

**Проблема:** Сложение процентов не имеет математического смысла без базы:

- `price - 25%` затем `- 35%` от остатка ≠ `price - 60%`
- `100 - 25% = 75`, затем `75 - 35% = 48.75` (не 40!)

### Проблема 2: Неясная семантика операций

```typescript
// ❌ Что делает эта операция?
const result = percentage1.multiply(percentage2);
// 25% * 35% = 8.75%?
// Когда это имеет смысл в business logic?
```

**Проблема:** Операции между процентами редко имеют практический смысл:

- Умножение процентов: `(0.25) * (0.35) = 0.0875` (8.75%)
- Когда это используется в реальной жизни?

### Проблема 3: Смешивание concerns

```typescript
// ❌ Percentage пытается быть и value object, и calculator
class Percentage {
  add(other: Percentage): Percentage { ... }
  subtract(other: Percentage): Percentage { ... }
  applyTo(amount: Decimal): Decimal { ... }
  // Куча методов, но неясно когда использовать какой
}
```

**Проблема:** Single Responsibility нарушен:

- Value object должен хранить значение и проверять инварианты
- Бизнес-логика (как применять процент) должна быть в domain objects

### Проблема 4: "Процент это доля ОТ ЧИСЛА"

```typescript
// ❌ Процент без базы не имеет смысла
const discount = Percentage.of(20); // 20%

// Что это значит само по себе?
// 20% от чего? От какой базы?
// Процент - это ОТНОСИТЕЛЬНАЯ величина, требующая контекста
```

**Проблема:** Процент не существует в вакууме:

- 20% discount - от какой цены?
- 5% fee - от какой суммы?
- 10% tax - от какого amount?

## Решение: Ratio

### Решение 1: Минимальная абстракция

```typescript
// ✅ Ratio - минимальная обертка над Decimal
class Ratio {
  // Только хранение и проверка инвариантов
  toDecimal(): Decimal
  onePlus(): Decimal    // вспомогательный метод
  oneMinus(): Decimal   // вспомогательный метод
  equals(other): boolean
  // Нет add/subtract/multiply - это не нужно!
}
```

**Решение:** Ratio содержит только:

1. Хранение значения (fraction)
2. Проверка инвариантов (NaN, Infinity)
3. Вспомогательные методы для частых операций

### Решение 2: Операции в target objects

```typescript
// ✅ Операции живут в Money/Price/Quantity
class Money {
  addRate(ratio: Ratio): Money {
    // Четкая семантика: добавить процент к сумме
    // amount * (1 + ratio)
    return Money.of(this.amount.mul(ratio.onePlus()));
  }

  subtractRate(ratio: Ratio): Money {
    // Четкая семантика: вычесть процент из суммы
    // amount * (1 - ratio)
    return Money.of(this.amount.mul(ratio.oneMinus()));
  }

  take(ratio: Ratio): Money {
    // Четкая семантика: взять процент от суммы
    // amount * ratio
    return Money.of(this.amount.mul(ratio.toDecimal()));
  }
}
```

**Решение:** Каждая операция имеет явный смысл:

- `money.addRate(ratio)` - добавить процент к сумме (markup)
- `money.subtractRate(ratio)` - вычесть процент (discount/fee)
- `money.take(ratio)` - взять процент (commission)

### Решение 3: Четкая семантика создания

```typescript
// ✅ Factory methods с явной семантикой
RatioService.fromPercent(2)     // 2% → 0.02 (явно)
RatioService.fromDecimal(0.02)  // 0.02 fraction (явно)
RatioService.fromBps(200)       // 200 bps → 0.02 (явно)

// ❌ Старый подход был неясным
Percentage.of(2) // Это 2% или 200%? Неясно!
```

**Решение:** Семантика закодирована в имени метода:

- Нет двусмысленности что означает число
- Документация ясна: ratio хранит дробь

### Решение 4: Контекстные операции

```typescript
// ✅ Контекст определяет операцию
const price = new Decimal(100);
const discountRatio = RatioService.fromPercent(20).value;

// Price context: вычесть discount
const finalPrice = price.mul(discountRatio.oneMinus()); // 100 * 0.8 = 80

// Fee context: взять процент
const fee = price.mul(discountRatio.toDecimal()); // 100 * 0.2 = 20

// Tax context: добавить tax
const withTax = price.mul(discountRatio.onePlus()); // 100 * 1.2 = 120
```

**Решение:** Операция зависит от контекста использования:

- Тот же ratio (20%) имеет разный смысл в разных контекстах
- Семантика ясна из вызывающего кода

## Ключевые отличия

| Аспект | Percentage (удален) | Ratio (новый) |
|--------|-------------------|---------------|
| **Семантика** | Неясная (value object для процента?) | Четкая (relative value, дробь) |
| **Операции** | add/subtract/multiply (бессмысленно) | Минимум (только вспомогательные) |
| **Использование** | Standalone | В контексте целевого value object |
| **Арифметика** | В Percentage классе | В Money/Price/Quantity |
| **Factory** | `Percentage.of(2)` (неясно: 2% или 200%?) | `RatioService.fromPercent(2)` (явно: 2%) |
| **Хранение** | Процент (2 для 2%) | Дробь (0.02 для 2%) |
| **Абстракция** | Тяжелая (много методов) | Минимальная (только нужное) |
| **Design** | Value object пытается быть calculator | Value object = хранение + инварианты |

## Migration Guide

### Миграция 1: Создание

```typescript
// ❌ Старый код (Percentage)
const discount = Percentage.of(20); // Неясно: 20% или 2000%?

// ✅ Новый код (Ratio)
const discountResult = RatioService.fromPercent(20); // Явно: 20%
if (discountResult.ok) {
  const discount = discountResult.value;
}
```

### Миграция 2: Применение к amount

```typescript
// ❌ Старый код
const discount = Percentage.of(20);
const finalPrice = discount.applyTo(price); // Что делает applyTo?

// ✅ Новый код - явная семантика в целевом объекте
const discountResult = RatioService.fromPercent(20);
if (discountResult.ok) {
  // Вычесть discount: price * (1 - 0.2)
  const finalPrice = price.mul(discountResult.value.oneMinus());
}

// ✅ ИЛИ через Money value object (рекомендуется)
class Money {
  applyDiscount(ratio: Ratio): Money {
    return Money.of(this.amount.mul(ratio.oneMinus()));
  }
}

const money = Money.of(price);
const discounted = money.applyDiscount(discountResult.value);
```

### Миграция 3: Сложение процентов

```typescript
// ❌ Старый код (бессмысленно!)
const total = percentage1.add(percentage2);
// 25% + 35% = 60%? От чего?

// ✅ Новый код - последовательное применение
const amount = new Decimal(100);
const discount1Result = RatioService.fromPercent(25);
const discount2Result = RatioService.fromPercent(35);

if (discount1Result.ok && discount2Result.ok) {
  // Применить скидки последовательно
  let current = amount;
  current = current.mul(discount1Result.value.oneMinus()); // 100 → 75
  current = current.mul(discount2Result.value.oneMinus()); // 75 → 48.75
  // Итого: не 60%, а 51.25% скидка от исходной суммы
}
```

### Миграция 4: Форматирование

```typescript
// ❌ Старый код
const formatted = percentage.toString(); // "20%"?

// ✅ Новый код
import { RatioFormatter } from '@polymarket/value-objects';

const ratioResult = RatioService.fromPercent(20);
if (ratioResult.ok) {
  const formatted = RatioFormatter.toPercent(ratioResult.value, 2);
  if (formatted.ok) {
    console.log(formatted.value); // "20.00%"
  }
}
```

### Миграция 5: Сериализация

```typescript
// ❌ Старый код
const json = percentage.toJSON(); // { percent: 20 }?

// ✅ Новый код
import { RatioSerializer } from '@polymarket/value-objects';

const ratioResult = RatioService.fromPercent(20);
if (ratioResult.ok) {
  const json = RatioSerializer.toJSON(ratioResult.value);
  // { ratio: "0.2" } - decimal string для точности
}
```

## Философия дизайна

### Принцип 1: Минимальная абстракция

> "Value object должен содержать минимум логики, необходимой для поддержания инвариантов"

**Ratio:**

- ✅ Хранит значение (Decimal)
- ✅ Проверяет инварианты (NaN, Infinity)
- ✅ Предоставляет вспомогательные методы (onePlus, oneMinus)
- ❌ НЕ содержит бизнес-логику операций

### Принцип 2: Операции в контексте

> "Операции с процентами имеют смысл только в контексте конкретной величины"

**Правильно:**

```typescript
// ✅ Операция в контексте Money
class Money {
  applyFee(ratio: Ratio): Money {
    // Ясно: применить fee к money amount
    return Money.of(this.amount.mul(ratio.onePlus()));
  }
}
```

**Неправильно:**

```typescript
// ❌ Операция на Ratio (бессмысленно)
class Ratio {
  add(other: Ratio): Ratio {
    // Что значит сложить два ratio?
    return ...;
  }
}
```

### Принцип 3: Single Responsibility

> "Value object отвечает за хранение и валидацию, а НЕ за бизнес-логику"

**Разделение:**

- **Ratio (Core)** - хранение дроби, проверка инвариантов
- **RatioService (Facade)** - создание, валидация опций
- **Money/Price/Quantity** - бизнес-логика применения ratio

### Принцип 4: Явная семантика

> "Код должен читаться как текст, без двусмысленности"

**Сравнение:**

```typescript
// ❌ Неясно
Percentage.of(2)

// ✅ Ясно
RatioService.fromPercent(2)   // "2 процента"
RatioService.fromDecimal(0.02) // "дробь 0.02"
RatioService.fromBps(200)      // "200 basis points"
```

## Итоговые выводы

### Почему Ratio лучше Percentage

1. **Минимальная абстракция** - содержит только необходимое
2. **Операции в контексте** - бизнес-логика в целевых objects
3. **Четкая семантика** - явные factory methods
4. **Single Responsibility** - value object ≠ calculator
5. **Математическая корректность** - хранит дробь, не процент

### Когда использовать Ratio

✅ **Используйте Ratio когда:**

- Нужно представить относительную величину (коэффициент, долю)
- Процент применяется к конкретной сумме/цене
- Нужна type-safe работа с процентами
- Требуется точная арифметика

❌ **НЕ используйте Ratio для:**

- Операций между процентами (add, subtract)
- Standalone процентных вычислений
- Когда достаточно простого Decimal

### Рекомендации

1. **Всегда используйте RatioService** для создания Ratio
2. **Операции в target objects** (Money, Price, Quantity)
3. **Явная семантика** через правильные factory methods
4. **Документируйте контекст** использования ratio в коде

## Следующие шаги

- [Architecture](./architecture.md) - детальная архитектура Ratio
- [Core API](./core.md) - Ratio class reference
- [Facade API](./facade.md) - RatioService reference
- [Examples](./examples.md) - примеры использования
