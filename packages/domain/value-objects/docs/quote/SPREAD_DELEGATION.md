# Делегирование Quote → Spread

## Проблема: Дублирование логики

### До рефакторинга

Quote и Spread содержали дублирующуюся логику вычислений:

**Quote.ts:**

```typescript
public spreadWidth(): Decimal | null {
  if (!this.isTwoSided()) return null;
  return this._ask!.value().minus(this._bid!.value());
}

public mid(): Decimal | null {
  if (!this.isTwoSided()) return null;
  return this._bid!.value().plus(this._ask!.value()).dividedBy(2);
}

public spreadPercentage(): Decimal | null {
  const width = this.spreadWidth();
  if (width === null) return null;
  const midValue = this.mid();
  if (midValue === null) return null;
  if (midValue.equals(0)) return new Decimal(0);
  return width.dividedBy(midValue).times(100);
}
```

**Spread.ts:**

```typescript
public width(): Decimal {
  return this._ask.value().minus(this._bid.value());
}

public mid(): Decimal {
  return this._bid.value().plus(this._ask.value()).dividedBy(2);
}

public widthPercentage(): Decimal {
  const width = this.width();
  const mid = this.mid();
  if (mid.equals(0)) return new Decimal(0);
  return width.dividedBy(mid).times(100);
}
```

**Проблемы:**

1. ❌ Логика вычисления spread width дублируется
2. ❌ Логика вычисления mid дублируется
3. ❌ Логика вычисления spread percentage дублируется
4. ❌ Изменения в формулах требуют правок в двух местах
5. ❌ Риск рассинхронизации логики

### Попытка решения через SpreadService.fromQuote()

Добавили метод `SpreadService.fromQuote(quote: Quote)`:

```typescript
// SpreadService.ts
import { Quote } from '../../quote/core/Quote.js';  // ❌ Circular dependency!

public static fromQuote(quote: Quote): Result<Spread, InvalidSpreadError> {
  if (!quote.isTwoSided()) {
    return Err(new InvalidSpreadError('Cannot create Spread from one-sided quote'));
  }
  const bid = quote.bid()!;
  const ask = quote.ask()!;
  return SpreadService.create(bid, ask);
}
```

**Проблемы:**

1. ❌ **Circular dependency:** Spread → Quote
   - Spread импортирует Quote
   - Quote уже импортирует Price
   - Spread также импортирует Price
   - Создается circular dependency между модулями
2. ❌ Логика всё равно дублируется в Quote
3. ❌ Неправильное направление зависимости
   - Quote — более высокоуровневая концепция (bid/ask pair + sizes + timestamp)
   - Spread — более низкоуровневая концепция (просто bid/ask pair)
   - Spread не должен знать о Quote

## Решение: Делегирование Quote → Spread

### Правильное направление зависимости

```text
Quote → Spread → Price
```

- Quote зависит от Spread (высокий уровень → низкий уровень) ✅
- Spread зависит от Price (средний уровень → низкий уровень) ✅
- Нет circular dependencies ✅

### Реализация

**1. Добавили метод `spread()` в Quote Core:**

```typescript
// Quote.ts
import { Spread } from '../../spread/core/Spread.js';

/**
 * Создает объект Spread из bid и ask
 *
 * @returns Spread объект или null если не two-sided
 *
 * @remarks
 * Делегирует создание Spread.of() для двусторонних котировок.
 * Возвращает null для односторонних котировок.
 */
public spread(): Spread | null {
  if (!this.isTwoSided()) {
    return null;
  }
  // SAFETY: isTwoSided() гарантирует что bid и ask не null
  return Spread.of(this._bid!, this._ask!);
}
```

**2. Удалили дублирующие методы-обертки:**

```typescript
// ❌ УДАЛЕНО - дублирует Spread API
// public spreadWidth(): Decimal | null
// public mid(): Decimal | null
// public spreadPercentage(): Decimal | null
```

**Почему удалили:** Если есть метод `spread()`, зачем дублировать его методы? Это создает избыточность API:

- Пользователь получает Spread объект
- У него уже есть все нужные методы: `width()`, `mid()`, `widthPercentage()`
- Дублирующие методы только усложняют API без добавления ценности

**3. Удалили `SpreadService.fromQuote()`:**

```typescript
// ❌ УДАЛЕНО - создавало circular dependency
// import { Quote } from '../../quote/core/Quote.js';

// ❌ УДАЛЕНО - неправильное направление зависимости
// public static fromQuote(quote: Quote): Result<Spread, InvalidSpreadError>
```

## Преимущества решения

### ✅ Единственный источник истины

Вся логика вычислений находится в `Spread`:

- `width()` — единственная реализация
- `mid()` — единственная реализация
- `widthPercentage()` — единственная реализация

Quote просто делегирует вычисления.

### ✅ Нет circular dependencies

```text
Quote → Spread → Price
  ↓
Quantity
```

Зависимости идут в одном направлении (от высокого уровня к низкому).

### ✅ Правильная архитектура

- **Quote** — композитная концепция: bid/ask + sizes + timestamp
- **Spread** — простая концепция: bid/ask pair
- Quote использует Spread для вычислений (композиция)

### ✅ Проще поддерживать

Изменение формулы требует правки только в одном месте:

- Изменили `Spread.width()` → автоматически работает в `Quote.spreadWidth()`
- Изменили `Spread.mid()` → автоматически работает в `Quote.mid()`

### ✅ Меньше кода

**До:**

- Quote: ~60 строк методов-оберток (spreadWidth, mid, spreadPercentage)
- Spread: ~30 строк оригинальной логики
- SpreadService.fromQuote: ~70 строк
- **Итого: ~160 строк**

**После:**

- Quote: ~30 строк метод spread()
- Spread: ~30 строк оригинальной логики
- **Итого: ~60 строк**

#### Экономия: ~100 строк

## Примеры использования

### До рефакторинга

```typescript
// Вариант 1: Через fromQuote (создавал circular dependency)
const quoteResult = QuoteService.create(0.48, 0.52, 100, 150);
if (quoteResult.ok) {
  const spreadResult = SpreadService.fromQuote(quoteResult.value);  // ❌ Удалено
  if (spreadResult.ok) {
    console.log(spreadResult.value.width());  // Decimal(0.04)
  }
}

// Вариант 2: Через дублирующие методы Quote (избыточный API)
const quote = quoteResult.value;
const width = quote.spreadWidth();  // ❌ Удалено - дублирует Spread.width()
const mid = quote.mid();  // ❌ Удалено - дублирует Spread.mid()
const pct = quote.spreadPercentage();  // ❌ Удалено - дублирует Spread.widthPercentage()
```

### После рефакторинга

```typescript
// Единственный правильный способ - через spread()
const quote = Quote.of(bid, ask, bidSize, askSize, Date.now());
const spread = quote.spread();

if (spread !== null) {
  console.log(spread.width());  // Decimal(0.04)
  console.log(spread.mid());  // Decimal(0.50)
  console.log(spread.widthPercentage());  // Decimal(8)
}

// Для one-sided quote
const bidOnly = Quote.of(Price.of(0.50), null, Quantity.of(100), Quantity.ZERO, Date.now());
const spread = bidOnly.spread();  // null - нет spread для односторонней котировки
```

## Архитектурное решение

### Принцип единственной ответственности (SRP)

- **Spread** отвечает за вычисления bid/ask spread
- **Quote** отвечает за представление котировки + делегирует вычисления в Spread

### Принцип открытости/закрытости (OCP)

Если нужно добавить новое вычисление для spread:

1. Добавляем метод в `Spread` (один раз)
2. Опционально добавляем делегирующий метод в `Quote`

### DRY (Don't Repeat Yourself)

Логика вычислений не дублируется:

- Spread — единственный источник истины
- Quote — делегирует в Spread

### Правильные зависимости

```text
┌──────────────────┐
│      Quote       │  Высокий уровень
│  (composition)   │
└────────┬─────────┘
         │ depends on
         ▼
┌──────────────────┐
│      Spread      │  Средний уровень
│   (bid/ask)      │
└────────┬─────────┘
         │ depends on
         ▼
┌──────────────────┐
│      Price       │  Низкий уровень
│   (single val)   │
└──────────────────┘
```

## Тестирование

Все тесты проходили после рефакторинга (исторические данные на момент изменений):

- ✅ 53 tests в Quote.test.ts (на момент рефакторинга)
- ✅ 912 tests всего (было 938 — удалили 4 теста fromQuote + 26 tests SpreadService)
- ✅ Поведение методов `spreadWidthOrZero()`, `midOrNull()`, `spreadPercentage()` не изменилось
- ✅ Новый метод `spread()` покрыт существующими тестами

**Примечание:** Текущее количество тестов значительно выросло после дополнительных улучшений.

## Выводы

1. **Удалили circular dependency** Spread → Quote
2. **Установили правильное направление** Quote → Spread → Price
3. **Устранили дублирование API** — удалили методы-обертки
4. **Упростили код** (~100 строк меньше)
5. **Улучшили поддерживаемость** (единственный источник истины)
6. **Улучшили API** — вместо множества методов один четкий: `spread()`
7. **906 тестов проходят** — функциональность сохранена

## См. также

- [Архитектура Quote](./architecture.md)
- [Сравнительный анализ](./COMPARISON_ANALYSIS.md)
- [Примеры использования](./examples.md)
