# Руководство по использованию Result Pattern в @polymarket/time

## Вопрос

> Если мы используем Result railway pattern, стоит ли применять похожую методику по работе с ошибками в модуле time, или нет смысла, если у нас нет ошибок которые кидает код?

## Ответ: НЕТ, не стоит

### Текущая реализация НЕ нуждается в Result

Операции в модуле `@polymarket/time` используют **fail-fast подход** с exceptions:

```typescript
interface IClock {
  now(): Date; // ✅ Всегда возвращает Date (never fails)
}

class PaperClock {
  constructor(date: Date);       // ⚠️ Throws если Invalid Date
  setTime(date: Date): void;     // ⚠️ Throws если Invalid Date
  tick(ms: number): void;        // ⚠️ Throws если не finite или приведет к Invalid Date
}

class ReplayClock {
  constructor(date: Date);       // ⚠️ Throws если Invalid Date
  update(date: Date): void;      // ⚠️ Throws если Invalid Date
}
```

**Почему не нужен Result:**

1. ✅ Валидация есть, но throw используется для programming errors
2. ✅ Invalid Date - это bug в коде вызывающей стороны, не ожидаемая ошибка
3. ✅ TypeScript защищает на уровне типов (Date тип)
4. ✅ В production эти ошибки не должны случаться
5. ✅ Fail-fast лучше для отладки чем Result для таких случаев

### ❌ Пример избыточного использования Result

```typescript
// ПЛОХО - Result избыточен для programming errors
class PaperClock {
  now(): Result<Date, never> {  // Избыточно - never fails
    return Ok(this.currentTimestamp);
  }

  tick(ms: number): Result<void, InvalidDateError> {  // Избыточно - это bug, не ожидаемая ошибка
    if (!Number.isFinite(ms)) {
      return Err(new InvalidDateError('ms must be finite'));
    }
    this.currentTimestamp = new Date(this.currentTimestamp.getTime() + ms);
    return Ok(undefined);
  }
}

// Использование становится сложнее без пользы
const timeResult = clock.now();
if (timeResult.ok) { // Всегда true!
  const time = timeResult.value;
}
```

**Проблемы:**

- Усложняет API без причины
- `Result<T, never>` показывает что ошибок не бывает
- Пользователи должны обрабатывать Result даже когда он всегда Ok
- Снижает удобство использования

### ✅ Текущая реализация правильная

```typescript
// ХОРОШО - простой и понятный API
class PaperClock {
  now(): Date {
    return this.currentTimestamp;
  }

  tick(ms: number): void {
    this.currentTimestamp = new Date(this.currentTimestamp.getTime() + ms);
  }
}

// Использование простое и понятное
const time = clock.now(); // Просто Date
clock.tick(1000); // Просто void
```

## Когда Result НУЖЕН

### ✅ Правило: используйте Result когда операция может упасть

Result имеет смысл **ТОЛЬКО** для операций, которые могут завершиться с ошибкой:

### 1. Парсинг пользовательского ввода

```typescript
/**
 * ✅ ПРАВИЛЬНО - парсинг может упасть
 */
function parseISODate(str: string): Result<Date, DateParseError> {
  const date = new Date(str);

  if (isNaN(date.getTime())) {
    return Err(new DateParseError(str, 'Invalid ISO date'));
  }

  return Ok(date);
}

// Использование
const result = parseISODate(userInput);

if (result.ok) {
  const clock = new PaperClock(result.value);
} else {
  console.error('Parse error:', result.error.message);
}
```

### 2. Валидация бизнес-правил

```typescript
/**
 * ✅ ПРАВИЛЬНО - валидация может нарушиться
 */
function validateTimestampRange(
  ms: number,
  min: number,
  max: number
): Result<Date, RangeError> {
  if (ms < min || ms > max) {
    return Err(new RangeError(`Timestamp ${ms} out of range [${min}, ${max}]`));
  }

  return Ok(new Date(ms));
}
```

### 3. Конвертация с проверками

```typescript
/**
 * ✅ ПРАВИЛЬНО - конвертация с валидацией
 */
function fromUnixTimestamp(ms: number): Result<Date, ValidationError> {
  const MIN = 0; // 1970-01-01
  const MAX = 4102444800000; // 2100-01-01

  if (ms < MIN || ms > MAX) {
    return Err(new ValidationError(`Invalid timestamp: ${ms}`));
  }

  return Ok(new Date(ms));
}
```

## Сравнительная таблица

| Операция | Может упасть? | Использовать Result? | Пример |
|----------|---------------|----------------------|--------|
| `clock.now()` | ❌ Нет | ❌ НЕТ | `now(): Date` |
| `clock.tick(ms)` | ❌ Нет | ❌ НЕТ | `tick(ms: number): void` |
| `clock.setTime(date)` | ❌ Нет | ❌ НЕТ | `setTime(date: Date): void` |
| `parseDate(str)` | ✅ Да | ✅ ДА | `parseDate(str: string): Result<Date, ParseError>` |
| `validateRange(date)` | ✅ Да | ✅ ДА | `validateRange(...): Result<Date, RangeError>` |
| `fromTimestamp(ms)` | ✅ Да | ✅ ДА | `fromTimestamp(ms: number): Result<Date, ValidationError>` |

## Рекомендации

### Для модуля @polymarket/time

1. **НЕ добавляйте Result** в текущие классы:
   - `IClock`, `LiveClock`, `PaperClock`, `ReplayClock`
   - Все их методы всегда успешны

2. **Используйте Result** если добавите новые функции:
   - Парсинг строк → `parseISODate(): Result<Date, ParseError>`
   - Валидация диапазонов → `validateRange(): Result<Date, RangeError>`
   - Конвертация с проверками → `fromUnixTimestamp(): Result<Date, ValidationError>`

3. **Примеры где Result уместен:**
   - См. файл `src/parsing.example.ts` (пример для справки)

### Общее правило для всех модулей

```
Используй Result ⟺ Операция может упасть
```

**Проверочные вопросы:**

1. ❓ Может ли операция завершиться с ошибкой?
   - ✅ Да → используй Result
   - ❌ Нет → НЕ используй Result

2. ❓ Есть ли валидация входных данных?
   - ✅ Да → используй Result
   - ❌ Нет → НЕ используй Result

3. ❓ Может ли нарушиться бизнес-правило?
   - ✅ Да → используй Result
   - ❌ Нет → НЕ используй Result

## Примеры из практики

### ❌ Избыточное использование Result

```typescript
// ПЛОХО - операции всегда успешны
class Math {
  add(a: number, b: number): Result<number, never> {
    return Ok(a + b); // Зачем Result если никогда не Err?
  }
}

// ПЛОХО - getter всегда успешен
class User {
  getName(): Result<string, never> {
    return Ok(this.name); // Зачем Result?
  }
}
```

### ✅ Правильное использование Result

```typescript
// ХОРОШО - парсинг может упасть
class User {
  static fromJSON(json: string): Result<User, ParseError> {
    try {
      const data = JSON.parse(json);
      return Ok(new User(data));
    } catch (e) {
      return Err(new ParseError('Invalid JSON'));
    }
  }
}

// ХОРОШО - валидация может нарушиться
class Money {
  static create(amount: number, currency: string): Result<Money, ValidationError> {
    if (amount < 0) {
      return Err(new ValidationError('Amount cannot be negative'));
    }
    return Ok(new Money(amount, currency));
  }
}
```

## Заключение

**Для модуля @polymarket/time:**

- ✅ Текущая реализация **правильная** - Result НЕ нужен
- ✅ Все операции всегда успешны
- ✅ API простой и понятный
- ❌ НЕ усложняйте без причины

**Общий принцип:**

> Result - это инструмент для **явного** представления ошибок в типах.
> Используйте его только когда ошибки **возможны**.
> Не используйте когда операция **всегда** успешна.

**Золотое правило:**

```
Result<T, never> = признак что Result избыточен
```

Если тип ошибки `never`, значит Result не нужен - просто возвращайте `T`.
