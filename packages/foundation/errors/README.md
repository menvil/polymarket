# @polymarket/errors

Минимальная и расширяемая система обработки ошибок для Polymarket trading system.

## ✨ Ключевые особенности

- ✅ **Zero dependencies** - никаких зависимостей в production
- ✅ **100% покрытие тестами** - все классы автоматически тестируются
- ✅ **Автоматические фичи** - `name`, `toJSON()`, `is()` работают автоматически
- ✅ **Динамические сообщения** - поддержка шаблонов с контекстом
- ✅ **Graceful error handling** - ошибки в template функциях не роняют программу
- ✅ **Минимальный boilerplate** - новый класс = 1 строка кода
- ✅ **Type-safe** - полная типобезопасность с TypeScript

## 📦 Установка

```bash
npm install @polymarket/errors
```

## 🚀 Быстрый старт

### 1. Использование существующих ошибок

```typescript
import { ValidationError } from '@polymarket/errors';

// Простое использование
throw new ValidationError('Invalid price');

// С контекстом
throw new ValidationError('Price must be positive', {
  context: { field: 'price', value: -10, min: 0 }
});

// Динамическое сообщение из контекста
throw new ValidationError(
  (ctx) => `${ctx.field.toUpperCase()} must be positive but current value is ${ctx.value}`,
  { context: { field: 'price', value: -10 } }
);
// Результат: "PRICE must be positive but current value is -10"
```

### 2. Создание своей ошибки

#### Вариант 1: Минимальный (1 строка!) 🎉

```typescript
// src/base/OrderNotFoundError.ts
import { TradingError } from '@polymarket/errors';

export class OrderNotFoundError extends TradingError {}
```

- Severity автоматически = `'medium'`
- Всё остальное работает из коробки!

#### Вариант 2: С переопределением severity (3 строки)

```typescript
// src/base/InsufficientFundsError.ts
import { TradingError } from '@polymarket/errors';

export class InsufficientFundsError extends TradingError {
  public readonly severity = 'high' as const;
}
```

**Что работает автоматически:**

- ✨ `constructor()` - наследуется
- ✨ `this.name` - устанавливается из имени класса
- ✨ `toJSON()` - наследуется
- ✨ `.is()` - type guard работает
- ✨ `instanceof` - работает
- ✨ Динамические сообщения - работают

### 3. Экспорт класса

```typescript
// src/base/index.ts
export * from './TradingError.js';
export * from './ValidationError.js';
export * from './InsufficientFundsError.js'; // ← добавьте эту строку для нового класса
```

**Всё! При запуске `npm test` автоматически запустятся 28 базовых тестов для вашего класса!** ✨

Никаких registry, никакой ручной регистрации! Тесты находят все классы автоматически через файловую систему.

## 📖 API

### ErrorSeverity

```typescript
type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';
```

- **low** - незначительные ошибки (валидация, некорректный ввод)
- **medium** - стандартные ошибки (недостаточно средств, лимиты)
- **high** - серьёзные ошибки (сеть, API)
- **critical** - критические ошибки (система, безопасность)

### TradingError (базовый класс)

```typescript
class TradingError extends Error {
  readonly severity: ErrorSeverity = 'medium';
  readonly timestamp: Date;
  readonly code?: string;
  readonly context?: Record<string, unknown>;
  readonly innerError?: Error;

  toJSON(): Record<string, unknown>;
  static is(error: unknown): error is TradingError;
}
```

**Свойства:**

- `severity` - уровень серьёзности ошибки (обязательно)
- `timestamp` - время возникновения ошибки
- `code` - опциональный код для детальной классификации
- `context` - дополнительные данные для отладки
- `innerError` - оригинальная ошибка (если ошибка возникла в template функции)

#### Конструктор

```typescript
constructor(
  message: string | ((context: Record<string, unknown>) => string),
  options?: {
    code?: string;
    context?: Record<string, unknown>;
  }
)
```

**Параметры:**

- `message` - статическая строка или функция-шаблон для динамических сообщений
- `options.code` - опциональный код для детальной классификации
- `options.context` - опциональный контекст с дополнительными данными

### Методы

#### `toJSON()`

Сериализует ошибку в plain object для логирования или API ответов.

```typescript
const error = new ValidationError('Invalid price', {
  code: 'PRICE_NEGATIVE',
  context: { field: 'price', value: -10 }
});

console.log(error.toJSON());
// {
//   name: 'ValidationError',
//   code: 'PRICE_NEGATIVE',
//   message: 'Invalid price',
//   severity: 'low',
//   timestamp: '2024-01-20T12:00:00.000Z',
//   context: { field: 'price', value: -10 }
// }
```

#### `static is()` (Type Guard)

Проверяет тип ошибки (альтернатива `instanceof`).

```typescript
try {
  await operation();
} catch (error) {
  // Вариант 1: static is() ✨
  if (ValidationError.is(error)) {
    console.log('Validation failed:', error.context);
  }

  // Вариант 2: instanceof (стандартно)
  if (error instanceof ValidationError) {
    console.log('Validation failed:', error.context);
  }
}
```

## 💡 Примеры использования

### Статические сообщения

```typescript
throw new ValidationError('Invalid value');
```

### С контекстом

```typescript
throw new ValidationError('Price must be positive', {
  context: { field: 'price', value: -10, min: 0 }
});
```

### С кодом и контекстом

```typescript
throw new ValidationError('Invalid range', {
  code: 'PRICE_OUT_OF_RANGE',
  context: { field: 'price', value: 150, min: 1, max: 100 }
});
```

### Динамические сообщения

```typescript
// Базовый шаблон
throw new ValidationError(
  (ctx) => `${ctx.field} must be positive but current value is ${ctx.value}`,
  { context: { field: 'price', value: -10 } }
);
// Результат: "price must be positive but current value is -10"

// С методами строк
throw new ValidationError(
  (ctx) => `${ctx.field.toUpperCase()} = ${ctx.value}`,
  { context: { field: 'price', value: -10 } }
);
// Результат: "PRICE = -10"

// Комплексный шаблон
throw new ValidationError(
  (ctx) => `Validation failed: ${ctx.field} = ${ctx.value} (expected: min=${ctx.min}, max=${ctx.max})`,
  {
    code: 'RANGE_ERROR',
    context: { field: 'quantity', value: 150, min: 1, max: 100 }
  }
);
// Результат: "Validation failed: quantity = 150 (expected: min=1, max=100)"
```

### Обработка ошибок

```typescript
import { ValidationError, TradingError } from '@polymarket/errors';

try {
  await placeOrder(order);
} catch (error) {
  // Специфичная обработка по типу
  if (ValidationError.is(error)) {
    console.error('Validation failed:', error.context);
    return { success: false, error: 'Invalid input' };
  }

  // Общая обработка
  if (error instanceof TradingError) {
    console.error('Trading error:', error.toJSON());
    return { success: false, error: error.message };
  }

  throw error; // Неизвестная ошибка
}
```

### Graceful обработка ошибок в template функциях

Если template функция выбрасывает ошибку, она обрабатывается gracefully:

```typescript
import { ValidationError } from '@polymarket/errors';

// Template функция с ошибкой
const error = new ValidationError(
  (ctx: any) => {
    // Ошибка доступа к несуществующему свойству
    return ctx.missingField.toUpperCase();
  },
  { context: { field: 'price', value: -10 } }
);

// Ошибка не прерывает выполнение программы!
console.log(error.message);
// "Message template function failed: Cannot read properties of undefined (reading 'toUpperCase')"

// Оригинальная ошибка сохранена для отладки
console.log(error.innerError?.message);
// "Cannot read properties of undefined (reading 'toUpperCase')"

// Context сохранён для отладки
console.log(error.context);
// { field: 'price', value: -10 }

// innerError включён в JSON для логирования
const json = error.toJSON();
// {
//   name: 'ValidationError',
//   message: 'Message template function failed: ...',
//   severity: 'low',
//   timestamp: '2024-01-20T12:00:00.000Z',
//   context: { field: 'price', value: -10 },
//   innerError: {
//     name: 'TypeError',
//     message: "Cannot read properties of undefined (reading 'toUpperCase')",
//     stack: '...'
//   }
// }
```

**Преимущества:**

- ✅ Программа не падает при ошибках в template
- ✅ Оригинальная ошибка сохраняется для отладки
- ✅ Context остаётся доступным
- ✅ Полная информация в логах через toJSON()

## 🧪 Тестирование

### Автоматические тесты

При создании нового класса ошибки тесты **автоматически** находят его и запускают 28 базовых тестов:

```bash
npm test
# ✨ Автоматически обнаружено 1 класс(ов) ошибок:
#    - ValidationError (severity: low)
#
# ✓ ValidationError (auto-discovered, severity: low) (28 tests)
```

**Как это работает?**

- Тест `auto-discovery.test.ts` рекурсивно сканирует директорию `src/` и находит все `.ts` файлы с классами, наследующими `TradingError`
- Автоматически импортирует их и генерирует тесты
- **Никаких registry или ручной регистрации не требуется!**

### Специфичные тесты

Для специфичных тестов создайте отдельный файл:

```typescript
// __tests__/unit/base/InsufficientFundsError.test.ts
import { describe, it, expect } from '@jest/globals';
import { testTradingError } from '../../helpers/sharedErrorTests';
import { InsufficientFundsError } from '../../../src/base/InsufficientFundsError';

describe('InsufficientFundsError', () => {
  // 28 базовых тестов автоматически
  testTradingError({
    ErrorClass: InsufficientFundsError,
    expectedName: 'InsufficientFundsError',
    expectedSeverity: 'high',
    testMessage: 'Not enough funds',
  });

  // Специфичные тесты
  describe('specific behavior', () => {
    it('должен работать с балансом в контексте', () => {
      const error = new InsufficientFundsError(
        (ctx) => `Insufficient funds: required ${ctx.required}, available ${ctx.available}`,
        { context: { required: 1000, available: 500 } }
      );

      expect(error.message).toBe('Insufficient funds: required 1000, available 500');
      expect(error.severity).toBe('high');
    });
  });
});
```

## 📊 Покрытие тестами

```bash
npm run test:coverage
```

Целевые показатели:

- **Statements:** 90%+
- **Branches:** 85%+
- **Functions:** 90%+
- **Lines:** 90%+

## 🏗️ Архитектура

```text
@polymarket/errors/
├── src/
│   ├── ErrorSource.ts                # Enum для классификации источника ошибки
│   ├── base/
│   │   ├── ITradingError.ts          # Интерфейс
│   │   ├── TradingError.ts           # Базовый класс
│   │   ├── ValidationError.ts        # Пример: ошибка валидации
│   │   └── index.ts
│   ├── math/
│   │   ├── InvalidOperandError.ts    # Ошибка невалидного операнда (NaN/Infinity)
│   │   ├── InvalidDecimalPlacesError.ts # Ошибка невалидного количества знаков
│   │   ├── InvalidDivisorError.ts    # Ошибка деления на NaN/Infinity
│   │   ├── InvalidTickSizeError.ts   # Ошибка невалидного tick size
│   │   └── index.ts
│   ├── value-objects/
│   │   ├── InvalidPriceError.ts      # Ошибки валидации value objects
│   │   ├── InvalidQuantityError.ts
│   │   └── ... (11 классов)
│   ├── utils/
│   │   └── errorUtils.ts             # Утилиты для обработки ошибок
│   └── index.ts
├── docs/
│   ├── README.md                     # Обзорная документация
│   ├── error-handling.md             # Best practices обработки
│   ├── error-utilities.md            # Документация по error utilities
│   ├── math/                         # Документация math ошибок
│   └── value-objects/                # Документация value objects ошибок
├── __tests__/
│   ├── helpers/
│   │   └── sharedErrorTests.ts       # Helper для тестов
│   └── unit/
│       ├── auto-discovery.test.ts    # Автоматическое обнаружение и тестирование
│       └── base/
│           ├── TradingError.test.ts
│           └── ValidationError.test.ts
└── package.json
```

## 🔧 Разработка

```bash
# Установка зависимостей
npm install

# Сборка
npm run build

# Тесты
npm test
npm run test:watch
npm run test:coverage

# Линтинг
npm run lint

# Проверка типов
npm run typecheck
```

## 📝 Best Practices

### 1. Naming Convention

- Имя класса должно заканчиваться на `Error`
- Используйте описательные имена: `InsufficientFundsError`, а не `FundsError`

### 2. Severity Guidelines

- **low** - пользователь может исправить (валидация, некорректный ввод)
- **medium** - требует внимания (бизнес-логика, лимиты)
- **high** - серьёзная проблема (сеть, внешние API)
- **critical** - система не может продолжить работу

### 3. Context Guidelines

- Включайте только **релевантные** данные
- Не включайте **чувствительные** данные (пароли, токены)
- Используйте **понятные** ключи

```typescript
// ✅ Хорошо
{
  field: 'price',
  value: -10,
  min: 0,
  max: 1000
}

// ❌ Плохо
{
  x: -10,
  y: 0,
  z: 1000,
  userPassword: '...',  // ❌ Секреты!
  entireDatabase: {...} // ❌ Слишком много!
}
```

### 4. Message Guidelines

- Используйте **понятные** сообщения для пользователей
- Включайте **релевантный** контекст
- Используйте **активный** залог

```typescript
// ✅ Хорошо
'Price must be positive'
'Connection to API failed'
'Insufficient funds for this order'

// ❌ Плохо
'Error' // Слишком общее
'price validation failed' // Пассивный залог
'The price you entered is not valid because it is negative' // Слишком длинное
```

## 🛠️ Error Handling Utilities

В дополнение к error классам, пакет предоставляет утилиты для обработки ошибок:

- **ErrorSource** - enum для классификации источника ошибки (parsing, core_invariant, rule_validation, math_operation, unexpected)
- **wrapOp()** - автоматическое оборачивание операций в try-catch с rewrap
- **rewrap()** - переупаковка ошибок с сохранением root-контекста (cause, reason, raw)
- **toDecimal()** - безопасная конвертация в Decimal с error handling
- **expectedMathError()** / **unexpectedError()** - создание ошибок с правильным source
- **currencyMismatchError()** - стандартизированные ошибки валют

См. [docs/error-utilities.md](./docs/error-utilities.md) для полной документации.

**Пример использования**:

```typescript
import { wrapOp, toDecimal, ErrorSource } from '@polymarket/errors';

// wrapOp автоматически обрабатывает Result.Err и exceptions
return wrapOp(
  'MoneyService',
  'create',
  { currency },
  () => {
    // toDecimal безопасно парсит с автоматическим ErrorSource.PARSING
    const amountResult = toDecimal(
      'amount',
      input,
      MoneyErrorReason.INVALID_FORMAT,
      InvalidMoneyError
    );
    if (isErr(amountResult)) {
      return amountResult;
    }

    // Core создание с автоматической обработкой invariant violations
    return Ok(Money.of(amountResult.value, currency));
  },
  InvalidMoneyError
);
```

## 📄 License

MIT

## 🤝 Contributing

При добавлении нового класса ошибки:

1. **Создайте класс** в `src/base/` или `src/value-objects/`

   ```typescript
   export class MyError extends TradingError {
     public readonly severity = 'high' as const;
   }
   ```

2. **Добавьте экспорт** в соответствующий `index.ts`

   ```typescript
   export * from './MyError.js';
   ```

3. **Запустите `npm test`** - базовые тесты найдут ваш класс и запустятся автоматически! ✨

4. **(Опционально)** Создайте специфичные тесты если нужна дополнительная логика

5. **Добавьте документацию** в `docs/[category]/[error-name].md`

**Никаких registry! Никакой ручной регистрации!** Всё работает через автоматическое обнаружение классов в файловой системе.
