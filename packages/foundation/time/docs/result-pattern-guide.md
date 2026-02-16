# Руководство по использованию Result Pattern в @polymarket/time

## Вопрос

> Если мы используем Result railway pattern, стоит ли применять похожую методику по работе с ошибками в модуле time, или нет смысла, если у нас нет ошибок которые кидает код?

## Ответ: НЕТ, не стоит

### Текущая реализация НЕ нуждается в Result

Модуль `@polymarket/time` использует **fail-fast подход** с exceptions для валидации входных данных:

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

### Два типа ошибок

| Тип ошибки | Когда используем | Паттерн |
| ---------- | ---------------- | ------- |
| **Programming error** | Invalid Date передан в конструктор/setter | `throw new Error()` |
| **Expected business failure** | Парсинг user input может не удаться | `Result<T, E>` |

**Почему не нужен Result:**

1. ✅ Валидация есть, но throw используется для **programming errors**
2. ✅ Invalid Date - это **bug в коде** вызывающей стороны, не ожидаемая бизнес-ошибка
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
    // Возвращает копию для предотвращения мутации
    return new Date(this.currentTimestamp);
  }

  tick(ms: number): void {
    // Валидация только для programming errors
    if (!Number.isFinite(ms)) {
      throw new Error('ms must be finite');
    }
    this.currentTimestamp = new Date(this.currentTimestamp.getTime() + ms);
  }
}

// Использование простое и понятное
const time = clock.now(); // Просто Date (копия)
clock.tick(1000); // Просто void (throws при invalid input)
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
| -------- | ------------- | -------------------- | ------ |
| `clock.now()` | ❌ Нет | ❌ НЕТ | `now(): Date` |
| `clock.tick(ms)` | ⚠️ Только programming errors | ❌ НЕТ | `tick(ms: number): void` |
| `clock.setTime(date)` | ⚠️ Только programming errors | ❌ НЕТ | `setTime(date: Date): void` |
| `parseDate(str)` | ✅ Да, ожидаемые ошибки | ✅ ДА | `parseDate(str: string): Result<Date, ParseError>` |
| `validateRange(date)` | ✅ Да, ожидаемые ошибки | ✅ ДА | `validateRange(...): Result<Date, RangeError>` |
| `fromTimestamp(ms)` | ✅ Да, ожидаемые ошибки | ✅ ДА | `fromTimestamp(ms: number): Result<Date, ValidationError>` |

**Примечание:** "Может упасть?" означает **ожидаемую бизнес-ошибку** при валидном использовании API.

Методы `tick/setTime/update` **бросают исключения** при **programming errors** (Invalid Date, non-finite numbers) -
это нарушение контракта типов, которое должно быть исправлено в коде вызывающей стороны.
Такие ошибки **не являются** ожидаемыми бизнес-ошибками и **не требуют** Result pattern.

TypeScript защищает на уровне типов, но runtime валидация обеспечивает fail-fast для отладки.

## Рекомендации

### Для модуля @polymarket/time

1. **НЕ добавляйте Result** в текущие классы:
   - `IClock`, `LiveClock`, `PaperClock`, `ReplayClock`
   - Их методы успешны при валидном input (TypeScript гарантирует типы)
   - Throws только при programming errors (Invalid Date, non-finite), не при expected failures

2. **Используйте Result** если добавите новые функции:
   - Парсинг строк → `parseISODate(): Result<Date, ParseError>`
   - Валидация диапазонов → `validateRange(): Result<Date, RangeError>`
   - Конвертация с проверками → `fromUnixTimestamp(): Result<Date, ValidationError>`

3. **Примеры где Result уместен:**
   - См. файл `src/parsing.example.ts` (пример для справки)

### Общее правило для всех модулей

```text
Используй Result ⟺ Операция может упасть
```

**Проверочные вопросы:**

1. ❓ Может ли операция завершиться с **ожидаемой бизнес-ошибкой**?
   - ✅ Да → используй Result
   - ❌ Нет → НЕ используй Result

2. ❓ Есть ли валидация **пользовательских данных** или **внешнего ввода**?
   - ✅ Да → используй Result
   - ❌ Нет (только валидация контракта типов) → используй throw для programming errors

3. ❓ Может ли нарушиться бизнес-правило при **валидном использовании API**?
   - ✅ Да → используй Result
   - ❌ Нет (только programming errors) → НЕ используй Result

**Важное различие:**
- ✅ Result: парсинг `parseDate(userInput)` - пользователь может ввести что угодно
- ❌ Result: валидация `setTime(date)` - TypeScript гарантирует тип, Invalid Date = bug в коде

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
- ✅ Операции успешны при валидном input (TypeScript гарантирует типы)
- ✅ Programming errors (Invalid Date, non-finite) бросают исключения для fail-fast
- ✅ API простой и понятный
- ❌ НЕ усложняйте без причины

**Общий принцип:**

> Result - это инструмент для **явного** представления ошибок в типах.
> Используйте его только когда ошибки **возможны**.
> Не используйте когда операция **всегда** успешна.

**Золотое правило:**

```text
Result<T, never> = признак что Result избыточен
```

Если тип ошибки `never`, значит Result не нужен - просто возвращайте `T`.
