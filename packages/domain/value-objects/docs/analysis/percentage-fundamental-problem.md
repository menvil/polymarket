# Процент - фундаментальная проблема add/subtract

**Дата:** 2026-02-03
**Критичность:** ВЫСОКАЯ
**Проблема:** Процент - это ОТНОШЕНИЕ, не абсолютное значение

---

## 🎯 Суть проблемы (от пользователя)

> "Процент это доля от числа!!!! Это не просто значение как quantity. Это применяется - когда ты списываешь 2% комиссии, ты делаешь это ОТ ЧИСЛА - от цены, либо от штук, либо от еще чего-то."

**Пользователь прав на 100%!**

---

## 🔍 Фундаментальная разница

### Quantity (абсолютное значение)

```typescript
const q1 = Quantity.of(10);  // 10 штук
const q2 = Quantity.of(5);   // 5 штук
const total = add(q1, q2);   // 15 штук ✅

// Имеет смысл: 10 яблок + 5 яблок = 15 яблок
```

### Money (абсолютное значение)

```typescript
const m1 = Money.of(100);  // $100
const m2 = Money.of(50);   // $50
const total = add(m1, m2); // $150 ✅

// Имеет смысл: $100 + $50 = $150
```

### Percentage (ОТНОСИТЕЛЬНОЕ значение!)

```typescript
const p1 = Percentage.of(2);  // 2% от ЧЕГО???
const p2 = Percentage.of(3);  // 3% от ЧЕГО???
const total = add(p1, p2);    // 5% от ЧЕГО??? ❌

// НЕ имеет смысла без базы!
```

---

## 💡 Процент - это функция, не значение

### Правильное понимание

Процент - это **функция от базы**:

```typescript
// Процент - это трансформация:
type Percentage = (base: number) => number

const fee2percent = (base) => base * 0.02;
const fee3percent = (base) => base * 0.03;

// Применение:
fee2percent(1000);  // 20
fee3percent(1000);  // 30
```

### В коде

```typescript
// ✅ Правильно - процент ПРИМЕНЯЕТСЯ:
const fee = Percentage.of(2);        // 2%
const amount = Money.of(1000);       // $1000
const feeAmount = fee.applyTo(amount);  // $20

// ❌ Неправильно - процент САМ ПО СЕБЕ:
const fee1 = Percentage.of(2);  // 2% от ???
const fee2 = Percentage.of(3);  // 3% от ???
const total = add(fee1, fee2);  // 5% от ??? - НЕТ СМЫСЛА!
```

---

## 🤔 Но как же "2% + 3% = 5%" в комиссиях?

### Кажется что имеет смысл

```typescript
const makerFee = Percentage.of(2);   // 2%
const takerFee = Percentage.of(3);   // 3%
const totalFee = add(makerFee, takerFee);  // 5%
```

### Но на самом деле это shorthand для

```typescript
// Полная запись:
const tradeAmount = Money.of(1000);

// Применяем каждый процент к ОДНОЙ базе:
const makerFeeAmount = makerFee.applyTo(tradeAmount);  // $20 (2% от $1000)
const takerFeeAmount = takerFee.applyTo(tradeAmount);  // $30 (3% от $1000)

// Складываем РЕЗУЛЬТАТЫ:
const totalFeeAmount = Money.add(makerFeeAmount, takerFeeAmount);  // $50

// Это эквивалентно:
const totalFeePercent = 0.02 + 0.03;  // 0.05 (5%)
const totalFeeAmount = tradeAmount * totalFeePercent;  // $50
```

**Ключ:** Оба процента применяются к **ОДНОЙ И ТОЙ ЖЕ базе**.

---

## ✅ Когда add() работает (технически)

### Условие: Одна база для всех процентов

```typescript
// Дано: base = X
// P1 применяется к X → P1 * X
// P2 применяется к X → P2 * X
// Сумма: (P1 * X) + (P2 * X) = (P1 + P2) * X

// Поэтому:
add(P1, P2) = P1 + P2  // Работает, если база одна!
```

**Примеры:**

- Комиссии к одной сделке: ✅
- Налоги к одному доходу: ✅
- Spreads (как разница): ✅

---

## ❌ Когда add() НЕ работает

### Условие: Разные базы

```typescript
// Последовательные скидки:
const price = 100;
const afterDiscount1 = price - (price * 0.20);  // 80 (база: 100)
const afterDiscount2 = afterDiscount1 - (afterDiscount1 * 0.30);  // 56 (база: 80!)

// База ИЗМЕНИЛАСЬ! Нельзя просто сложить проценты.
```

### Проблема

```typescript
// НЕ работает:
add(Percentage.of(20), Percentage.of(30)) = Percentage.of(50)  // ❌

// Правильно:
const p1 = 1 - 0.20;  // 0.80
const p2 = 1 - 0.30;  // 0.70
const combined = p1 * p2;  // 0.56
const totalDiscount = 1 - combined;  // 0.44 (44%, не 50%!)
```

---

## 🎯 Фундаментальная проблема в дизайне

### Что я сделал неправильно

Я рассматривал `Percentage` как **значение** (like Quantity):

```typescript
class Percentage {
  private readonly value: Decimal;  // ❌ Это НЕ самостоятельное значение!

  add(other: Percentage): Percentage {
    return new Percentage(this.value + other.value);  // ❌ Математически, но не семантически!
  }
}
```

### Что должно быть

Процент - это **трансформация**:

```typescript
class Percentage {
  private readonly ratio: Decimal;  // 0.02 для 2%

  // ✅ Основная операция - ПРИМЕНЕНИЕ:
  applyTo(base: Decimal): Decimal {
    return base.times(this.ratio);
  }

  // ❌ add/subtract семантически сомнительны:
  // add(other: Percentage): Percentage  // ???
}
```

---

## 📊 Сравнение архитектур

### Текущая (Value-based)

```typescript
// Percentage как значение:
const p1 = Percentage.of(2);  // "2%" как значение
const p2 = Percentage.of(3);  // "3%" как значение
const p3 = add(p1, p2);       // "5%" как значение ❌

// Применение:
p3.applyTo(1000);  // 50
```

**Проблема:** Процент существует "сам по себе" без базы.

---

### Альтернатива 1: Function-based

```typescript
// Percentage как функция:
type Percentage = (base: Decimal) => Decimal;

const fee2 = (base) => base.times(0.02);
const fee3 = (base) => base.times(0.03);

// Применение:
fee2(new Decimal(1000));  // 20
fee3(new Decimal(1000));  // 30

// Композиция:
const totalFee = (base) => fee2(base).plus(fee3(base));
totalFee(new Decimal(1000));  // 50
```

**Плюсы:**

- ✅ Процент всегда применяется к базе
- ✅ Невозможно "сложить проценты" без базы

**Минусы:**

- ❌ Нет типа Percentage (просто функция)
- ❌ Сложно для validation
- ❌ Не Value Object

---

### Альтернатива 2: Percentage без add/subtract

```typescript
class Percentage {
  private readonly ratio: Decimal;

  // ✅ Основное:
  applyTo(base: Decimal): Decimal { ... }

  // ✅ Допустимо:
  multiply(factor: Decimal): Percentage { ... }  // 2% * 3 = 6%
  divide(divisor: Decimal): Percentage { ... }   // 6% / 2 = 3%

  // ❌ Убрать:
  // add(other: Percentage): Percentage
  // subtract(other: Percentage): Percentage
}
```

**Плюсы:**

- ✅ Убирает семантически сомнительные операции
- ✅ Фокус на applyTo()

**Минусы:**

- ❌ Неудобно для валидных случаев (total fees)
- ❌ Breaking change

---

### Альтернатива 3: Явная база (Context-aware)

```typescript
class PercentageOfBase {
  private readonly percentage: Percentage;
  private readonly base: Decimal;

  amount(): Decimal {
    return this.base.times(this.percentage.ratio);
  }

  // Можно безопасно складывать:
  add(other: PercentageOfBase): PercentageOfBase {
    if (!this.base.equals(other.base)) {
      throw new Error('Cannot add percentages with different bases');
    }
    return new PercentageOfBase(
      Percentage.of(this.percentage.value().plus(other.percentage.value())),
      this.base
    );
  }
}
```

**Плюсы:**

- ✅ База всегда привязана
- ✅ Защита от неправильного сложения

**Минусы:**

- ❌ Сложность
- ❌ Большая архитектура

---

## 🎯 Что делать?

### Вариант 1: Оставить как есть (Pragmatic)

**Обоснование:**

- add() работает для основного use case (fees с одной базой)
- Breaking change дорого
- Можно решить документацией

**Действия:**

- ⚠️ Жирный WARNING в документации
- ⚠️ JSDoc с примерами неправильного использования
- ⚠️ Объяснить что процент - это отношение

**Плюсы:**

- ✅ Не ломает код
- ✅ Покрывает реальный use case

**Минусы:**

- ❌ Семантически некорректно
- ❌ Полагается на дисциплину разработчика

---

### Вариант 2: Deprecate add/subtract (Correct)

**Обоснование:**

- Процент - это отношение, не абсолютное значение
- add/subtract семантически сомнительны
- Лучше убрать чем давать неправильный инструмент

**Действия:**

- Mark as `@deprecated` с migration guide
- В следующей major version удалить
- Показать альтернативы:

```typescript
// Было:
const total = PercentageService.add(makerFee, takerFee);

// Стало (явно показываем что складываем):
const totalRatio = makerFee.value().plus(takerFee.value());
const total = Percentage.of(totalRatio);

// Или еще лучше (складываем результаты):
const tradeAmount = Money.of(1000);
const makerFeeAmount = makerFee.applyTo(tradeAmount);
const takerFeeAmount = takerFee.applyTo(tradeAmount);
const totalFeeAmount = Money.add(makerFeeAmount, takerFeeAmount);
```

**Плюсы:**

- ✅ Семантически корректно
- ✅ Фокус на applyTo()
- ✅ Явная бизнес-логика

**Минусы:**

- ❌ Breaking change
- ❌ Больше кода для simple cases

---

### Вариант 3: Переименовать (Clarity)

```typescript
// Было:
add(p1, p2)

// Стало:
combineForSameBase(p1, p2)  // Явно: для одной базы
addRatios(p1, p2)           // Явно: складываем ratios
```

**Плюсы:**

- ✅ Ясная семантика
- ✅ Самодокументирующийся

**Минусы:**

- ❌ Breaking change
- ❌ Verbose

---

## 💭 Мое обновленное мнение

### Я был неправ

В первом анализе я написал:
> "add() валиден для fees - они аддитивны"

**Но пользователь указал на фундаментальную проблему:**

- Процент - это НЕ значение
- Процент - это ОТНОШЕНИЕ к базе
- add() семантически некорректен без явной базы

### Правильный подход

**Процент должен в первую очередь ПРИМЕНЯТЬСЯ, а не складываться.**

```typescript
// ✅ Процент как трансформация:
const fee = Percentage.of(2);
const amount = Money.of(1000);
const feeAmount = fee.applyTo(amount);

// ❌ Процент как значение:
const total = add(fee1, fee2);  // От чего???
```

### Рекомендация

**Вариант 2 (Deprecate) - правильно, но радикально.**

Для текущего проекта:

1. **Сейчас:** Warning в документации + JSDoc
2. **Next version:** Deprecate add/subtract
3. **Major version:** Удалить add/subtract

---

## 📚 Ключевой урок

### Value Object ≠ Просто число

Value Objects моделируют **domain concepts**:

- **Money:** абсолютная стоимость → можно складывать ✅
- **Quantity:** абсолютное количество → можно складывать ✅
- **Price:** цена за единицу → сложение спорно ⚠️
- **Percentage:** ОТНОШЕНИЕ к базе → сложение некорректно ❌

### Процент особенный

```typescript
// Money и Quantity - скаляры:
scalar + scalar = scalar  ✅

// Percentage - функция:
(base => result) + (base => result) = ???  ❌
```

**Процент всегда относителен к чему-то.**

---

## ✅ Action Items

- [ ] Добавить КРИТИЧЕСКИЙ WARNING в документацию
- [ ] Обновить JSDoc с объяснением что процент - отношение
- [ ] Показать examples неправильного использования
- [ ] Рассмотреть deprecation в будущем
- [ ] Review других Value Objects (Price.add тоже спорно!)

---

**Автор:** Claude Code (с критикой от пользователя)
**Дата:** 2026-02-03
**Статус:** Фундаментальная проблема выявлена
**Благодарность:** Пользователю за указание на суть процента! 🙏
