# План реализации @polymarket/errors

## 📋 Обзор

**Цель:** Создать foundation пакет для централизованной обработки ошибок в polymarket trading system.

**Расположение:** `packages/foundation/errors/`

**Зависимости:** Нет (zero dependencies - это foundation слой)

---

## 🎯 Принципы и требования

### Архитектурные принципы
1. **Zero dependencies** - пакет не зависит от других внутренних пакетов
2. **Immutability** - все ошибки неизменяемы после создания
3. **Serializable** - ошибки можно сериализовать в JSON для API/логов
4. **Type-safe** - полная типизация TypeScript
5. **Stack traces** - поддержка stack traces для отладки
6. **Structured** - структурированные данные (code, timestamp, context)

### Функциональные требования
1. Базовый класс `TradingError` для всех ошибок системы
2. Специализированные базовые классы: `DomainError`, `ValidationError`, `NotFoundError`
3. Domain-специфичные ошибки для market, order, position
4. Централизованные коды ошибок (`ErrorCode` enum)
5. Фабрика для удобного создания ошибок (`ErrorFactory`)
6. Сериализация/десериализация ошибок
7. 100% покрытие тестами

### Нефункциональные требования
1. Документация TSDoc на русском для всех публичных API
2. Примеры использования в JSDoc
3. README.md с руководством
4. Экспорт всех типов через barrel exports

---

## 📁 Структура пакета

```
packages/foundation/errors/
├── package.json                      # Конфигурация пакета
├── tsconfig.json                     # TypeScript конфигурация
├── tsconfig.build.json              # Build конфигурация
├── jest.config.ts                   # Jest конфигурация
├── README.md                         # Документация пакета
├── src/
│   ├── base/                         # Базовые классы ошибок
│   │   ├── TradingError.ts           # Корневой класс всех ошибок
│   │   ├── DomainError.ts            # Базовая domain ошибка
│   │   ├── ValidationError.ts        # Ошибка валидации
│   │   ├── NotFoundError.ts          # Ошибка "не найдено"
│   │   ├── ErrorCode.ts              # Enum кодов ошибок
│   │   └── index.ts                  # Barrel export
│   │
│   ├── domain/                       # Domain-специфичные ошибки
│   │   ├── market/
│   │   │   ├── MarketNotFoundError.ts
│   │   │   ├── MarketClosedError.ts
│   │   │   ├── MarketExpiredError.ts
│   │   │   ├── InvalidMarketStateError.ts
│   │   │   └── index.ts
│   │   │
│   │   ├── order/
│   │   │   ├── OrderNotFoundError.ts
│   │   │   ├── OrderValidationError.ts
│   │   │   ├── InsufficientFundsError.ts
│   │   │   ├── OrderAlreadyCancelledError.ts
│   │   │   ├── OrderAlreadyFilledError.ts
│   │   │   ├── InvalidOrderSideError.ts
│   │   │   ├── InvalidOrderTypeError.ts
│   │   │   └── index.ts
│   │   │
│   │   ├── position/
│   │   │   ├── PositionNotFoundError.ts
│   │   │   ├── InsufficientPositionError.ts
│   │   │   ├── InsufficientLotQuantityError.ts
│   │   │   └── index.ts
│   │   │
│   │   ├── price/
│   │   │   ├── InvalidPriceError.ts
│   │   │   ├── PriceOutOfRangeError.ts
│   │   │   └── index.ts
│   │   │
│   │   ├── quantity/
│   │   │   ├── InvalidQuantityError.ts
│   │   │   ├── QuantityTooSmallError.ts
│   │   │   ├── QuantityTooLargeError.ts
│   │   │   └── index.ts
│   │   │
│   │   └── index.ts
│   │
│   ├── factories/
│   │   ├── ErrorFactory.ts           # Фабрика для создания ошибок
│   │   └── index.ts
│   │
│   ├── serialization/
│   │   ├── ErrorSerializer.ts        # Сериализация в JSON
│   │   ├── ErrorParser.ts            # Парсинг из JSON
│   │   └── index.ts
│   │
│   ├── utils/
│   │   ├── isError.ts                # Type guards
│   │   ├── formatError.ts            # Форматирование для вывода
│   │   └── index.ts
│   │
│   └── index.ts                      # Главный barrel export
│
├── __tests__/                        # Тесты
│   ├── unit/
│   │   ├── base/
│   │   │   ├── TradingError.test.ts
│   │   │   ├── DomainError.test.ts
│   │   │   ├── ValidationError.test.ts
│   │   │   ├── NotFoundError.test.ts
│   │   │   └── ErrorCode.test.ts
│   │   │
│   │   ├── domain/
│   │   │   ├── market/
│   │   │   │   └── MarketNotFoundError.test.ts
│   │   │   ├── order/
│   │   │   │   ├── InsufficientFundsError.test.ts
│   │   │   │   └── OrderValidationError.test.ts
│   │   │   └── position/
│   │   │       └── InsufficientPositionError.test.ts
│   │   │
│   │   ├── factories/
│   │   │   └── ErrorFactory.test.ts
│   │   │
│   │   └── serialization/
│   │       ├── ErrorSerializer.test.ts
│   │       └── ErrorParser.test.ts
│   │
│   ├── integration/
│   │   └── error-flow.test.ts
│   │
│   └── setup.ts                      # Test setup
│
└── dist/                             # Build output (git ignored)
    ├── index.js
    ├── index.d.ts
    └── ...
```

---

## 🚀 Пошаговый план реализации

### Фаза 1: Инициализация пакета (Setup)

#### Шаг 1.1: Создать структуру папок
```bash
mkdir -p packages/foundation/errors/{src/{base,domain/{market,order,position,price,quantity},factories,serialization,utils},__tests__/unit/{base,domain/{market,order,position},factories,serialization}}
```

**Результат:** Созданы все необходимые директории

---

#### Шаг 1.2: Создать package.json

**Файл:** `packages/foundation/errors/package.json`

**Содержимое:**
```json
{
  "name": "@polymarket/errors",
  "version": "0.1.0",
  "description": "Foundation error handling package for Polymarket trading system",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./base": {
      "types": "./dist/base/index.d.ts",
      "import": "./dist/base/index.js"
    },
    "./domain": {
      "types": "./dist/domain/index.d.ts",
      "import": "./dist/domain/index.js"
    }
  },
  "files": [
    "dist",
    "README.md"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "build:watch": "tsc -p tsconfig.build.json --watch",
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage",
    "lint": "eslint src --ext .ts",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "keywords": [
    "errors",
    "error-handling",
    "trading",
    "polymarket",
    "foundation"
  ],
  "author": "",
  "license": "MIT",
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/jest": "^29.5.0",
    "typescript": "^5.3.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.0",
    "@jest/globals": "^29.7.0",
    "eslint": "^8.0.0",
    "@typescript-eslint/eslint-plugin": "^6.0.0",
    "@typescript-eslint/parser": "^6.0.0"
  },
  "dependencies": {},
  "publishConfig": {
    "access": "restricted"
  }
}
```

**Ключевые моменты:**
- ✅ Zero dependencies (только devDependencies)
- ✅ ESM модули (`"type": "module"`)
- ✅ Экспорты через `exports` поле (modern Node.js)
- ✅ Скрипты для build, test, lint

---

#### Шаг 1.3: Создать tsconfig.json

**Файл:** `packages/foundation/errors/tsconfig.json`

**Содержимое:**
```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "target": "ES2022",
    "lib": ["ES2022"],
    "moduleResolution": "bundler",
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "__tests__"]
}
```

---

#### Шаг 1.4: Создать tsconfig.build.json

**Файл:** `packages/foundation/errors/tsconfig.build.json`

**Содержимое:**
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "sourceMap": true,
    "declaration": true,
    "declarationMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts", "**/__tests__/**"]
}
```

---

#### Шаг 1.5: Создать jest.config.ts

**Файл:** `packages/foundation/errors/jest.config.ts`

**Содержимое:**
```typescript
import type { Config } from 'jest';

const config: Config = {
  displayName: '@polymarket/errors',
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/__tests__'],
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/?(*.)+(spec|test).ts'
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90,
    },
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
      },
    }],
  },
};

export default config;
```

**Ключевые настройки:**
- ✅ `ts-jest` preset для TypeScript
- ✅ Покрытие > 90% для всех метрик
- ✅ Тесты в `__tests__/` и `*.test.ts`
- ✅ Исключаем `index.ts` (barrel exports) из покрытия

---

### Фаза 2: Реализация базовых классов ошибок

#### Шаг 2.1: ErrorCode enum

**Файл:** `packages/foundation/errors/src/base/ErrorCode.ts`

**Приоритет:** Высокий (все остальные ошибки зависят от кодов)

**Задача:**
1. Создать enum `ErrorCode` со всеми кодами ошибок
2. Группировать по категориям (GENERAL, MARKET, ORDER, POSITION, PRICE, QUANTITY)
3. Создать `ErrorMetadata` с userMessage, httpStatus, severity
4. Экспортировать helper функции для работы с кодами

**Содержимое:** (см. детальный код в следующем сообщении)

**Валидация:**
- ✅ Все коды уникальны
- ✅ Есть метаданные для каждого кода
- ✅ TSDoc комментарии на русском

---

#### Шаг 2.2: TradingError (корневой класс)

**Файл:** `packages/foundation/errors/src/base/TradingError.ts`

**Приоритет:** Критический (базовый класс для всех ошибок)

**Задача:**
1. Создать класс `TradingError extends Error`
2. Добавить поля: `code`, `timestamp`, `context`
3. Реализовать методы: `toJSON()`, `toString()`, `static isTradingError()`
4. Поддержка V8 stack traces (`Error.captureStackTrace`)
5. TSDoc документация с примерами

**Валидация:**
- ✅ Stack trace корректный
- ✅ Сериализация в JSON работает
- ✅ instanceof проверка работает

---

#### Шаг 2.3: DomainError

**Файл:** `packages/foundation/errors/src/base/DomainError.ts`

**Приоритет:** Высокий

**Задача:**
1. Создать класс `DomainError extends TradingError`
2. Специализация для domain логики
3. TSDoc с объяснением когда использовать

**Валидация:**
- ✅ Наследуется от TradingError
- ✅ Работают все методы родителя

---

#### Шаг 2.4: ValidationError

**Файл:** `packages/foundation/errors/src/base/ValidationError.ts`

**Приоритет:** Высокий

**Задача:**
1. Создать класс `ValidationError extends TradingError`
2. Добавить поля: `field`, `value`, `errors` (для множественных ошибок)
3. Реализовать статические методы:
   - `forField(field, value, message)` - создание для одного поля
   - `aggregate(errors)` - создание из массива ошибок
4. Переопределить `toJSON()` для включения field/value

**Валидация:**
- ✅ Одиночная ошибка валидации
- ✅ Множественные ошибки (aggregate)
- ✅ Сериализация включает field/value

---

#### Шаг 2.5: NotFoundError

**Файл:** `packages/foundation/errors/src/base/NotFoundError.ts`

**Приоритет:** Средний

**Задача:**
1. Создать класс `NotFoundError extends DomainError`
2. Добавить поля: `entityType`, `entityId`
3. Автогенерация сообщения: `{entityType} with ID "{entityId}" not found`
4. Использование ErrorCode.NOT_FOUND

**Валидация:**
- ✅ Сообщение формируется корректно
- ✅ entityType и entityId сохраняются

---

#### Шаг 2.6: Barrel export для base/

**Файл:** `packages/foundation/errors/src/base/index.ts`

**Содержимое:**
```typescript
export * from './TradingError.js';
export * from './DomainError.js';
export * from './ValidationError.js';
export * from './NotFoundError.js';
export * from './ErrorCode.js';
```

---

### Фаза 3: Domain-специфичные ошибки

#### Шаг 3.1: Market errors

**Файлы:**
- `src/domain/market/MarketNotFoundError.ts`
- `src/domain/market/MarketClosedError.ts`
- `src/domain/market/MarketExpiredError.ts`
- `src/domain/market/InvalidMarketStateError.ts`
- `src/domain/market/index.ts`

**Пример: MarketClosedError**
```typescript
import { DomainError } from '../../base/DomainError.js';
import { ErrorCode } from '../../base/ErrorCode.js';

export class MarketClosedError extends DomainError {
  public readonly marketId: string;
  public readonly closedAt: Date;

  constructor(marketId: string, closedAt: Date) {
    super(
      `Market ${marketId} is closed (closed at ${closedAt.toISOString()})`,
      ErrorCode.MARKET_CLOSED,
      { marketId, closedAt: closedAt.toISOString() }
    );
    this.marketId = marketId;
    this.closedAt = closedAt;
  }
}
```

**Валидация для каждой ошибки:**
- ✅ Наследуется от правильного базового класса
- ✅ Использует правильный ErrorCode
- ✅ Сообщение информативное
- ✅ Все domain данные сохраняются

---

#### Шаг 3.2: Order errors

**Файлы:**
- `src/domain/order/OrderNotFoundError.ts`
- `src/domain/order/OrderValidationError.ts`
- `src/domain/order/InsufficientFundsError.ts`
- `src/domain/order/OrderAlreadyCancelledError.ts`
- `src/domain/order/OrderAlreadyFilledError.ts`
- `src/domain/order/InvalidOrderSideError.ts`
- `src/domain/order/InvalidOrderTypeError.ts`
- `src/domain/order/index.ts`

**Приоритет:** InsufficientFundsError - высокий (часто используется)

**Пример: InsufficientFundsError**
```typescript
import { DomainError } from '../../base/DomainError.js';
import { ErrorCode } from '../../base/ErrorCode.js';

export class InsufficientFundsError extends DomainError {
  public readonly required: number;
  public readonly available: number;

  constructor(required: number, available: number) {
    super(
      `Insufficient funds: required ${required} USDC, available ${available} USDC`,
      ErrorCode.INSUFFICIENT_FUNDS,
      { required, available }
    );
    this.required = required;
    this.available = available;
  }

  public getShortfall(): number {
    return this.required - this.available;
  }
}
```

---

#### Шаг 3.3: Position errors

**Файлы:**
- `src/domain/position/PositionNotFoundError.ts`
- `src/domain/position/InsufficientPositionError.ts`
- `src/domain/position/InsufficientLotQuantityError.ts`
- `src/domain/position/index.ts`

---

#### Шаг 3.4: Price errors

**Файлы:**
- `src/domain/price/InvalidPriceError.ts`
- `src/domain/price/PriceOutOfRangeError.ts`
- `src/domain/price/index.ts`

---

#### Шаг 3.5: Quantity errors

**Файлы:**
- `src/domain/quantity/InvalidQuantityError.ts`
- `src/domain/quantity/QuantityTooSmallError.ts`
- `src/domain/quantity/QuantityTooLargeError.ts`
- `src/domain/quantity/index.ts`

---

#### Шаг 3.6: Barrel export для domain/

**Файл:** `packages/foundation/errors/src/domain/index.ts`

```typescript
export * from './market/index.js';
export * from './order/index.js';
export * from './position/index.js';
export * from './price/index.js';
export * from './quantity/index.js';
```

---

### Фаза 4: ErrorFactory

#### Шаг 4.1: Реализовать ErrorFactory

**Файл:** `packages/foundation/errors/src/factories/ErrorFactory.ts`

**Задача:**
1. Создать класс `ErrorFactory` с статическими методами
2. Методы для каждого типа ошибок:
   - `notFound(entityType, entityId)`
   - `validation(field, value, message)`
   - `insufficientFunds(required, available)`
   - `marketClosed(marketId, closedAt)`
   - и т.д.
3. Специальный метод `wrap(error)` - оборачивает unknown error в TradingError
4. TSDoc с примерами

**Пример:**
```typescript
export class ErrorFactory {
  public static notFound(entityType: string, entityId: string): NotFoundError {
    return new NotFoundError(entityType, entityId);
  }

  public static validation(
    field: string,
    value: unknown,
    message: string
  ): ValidationError {
    return ValidationError.forField(field, value, message);
  }

  public static wrap(error: unknown): TradingError {
    if (TradingError.isTradingError(error)) {
      return error;
    }
    if (error instanceof Error) {
      return new TradingError(
        error.message,
        ErrorCode.UNKNOWN_ERROR,
        { originalError: error.name }
      );
    }
    return new TradingError(
      'Unknown error occurred',
      ErrorCode.UNKNOWN_ERROR,
      { error }
    );
  }
}
```

**Валидация:**
- ✅ Все методы возвращают правильные типы
- ✅ wrap() корректно обрабатывает разные типы ошибок

---

### Фаза 5: Сериализация

#### Шаг 5.1: ErrorSerializer

**Файл:** `packages/foundation/errors/src/serialization/ErrorSerializer.ts`

**Задача:**
1. Функция `serializeError(error)` - конвертирует TradingError в plain object
2. Поддержка nested errors (ValidationError.errors)
3. Опциональное включение stack trace

**Пример:**
```typescript
export interface SerializedError {
  name: string;
  message: string;
  code: string;
  timestamp: string;
  context?: Record<string, unknown>;
  stack?: string;
}

export function serializeError(
  error: TradingError,
  includeStack = false
): SerializedError {
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    timestamp: error.timestamp.toISOString(),
    context: error.context,
    ...(includeStack && { stack: error.stack }),
  };
}
```

---

#### Шаг 5.2: ErrorParser

**Файл:** `packages/foundation/errors/src/serialization/ErrorParser.ts`

**Задача:**
1. Функция `parseError(serialized)` - восстанавливает TradingError из JSON
2. Восстановление правильного класса на основе code
3. Fallback к TradingError если класс неизвестен

---

### Фаза 6: Утилиты

#### Шаг 6.1: Type guards

**Файл:** `packages/foundation/errors/src/utils/isError.ts`

**Содержимое:**
```typescript
export function isTradingError(error: unknown): error is TradingError {
  return error instanceof TradingError;
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}

export function isNotFoundError(error: unknown): error is NotFoundError {
  return error instanceof NotFoundError;
}
```

---

#### Шаг 6.2: formatError

**Файл:** `packages/foundation/errors/src/utils/formatError.ts`

**Задача:**
Функция для форматирования ошибки в читаемый вид для логов/консоли

---

### Фаза 7: Главный export

#### Шаг 7.1: Создать index.ts

**Файл:** `packages/foundation/errors/src/index.ts`

**Содержимое:**
```typescript
// Base errors
export * from './base/index.js';

// Domain errors
export * from './domain/index.js';

// Factories
export * from './factories/index.js';

// Serialization
export * from './serialization/index.js';

// Utils
export * from './utils/index.js';
```

---

### Фаза 8: Тесты

#### Шаг 8.1: Тесты базовых классов

**Файлы:**
- `__tests__/unit/base/TradingError.test.ts`
- `__tests__/unit/base/ValidationError.test.ts`
- `__tests__/unit/base/NotFoundError.test.ts`

**Пример теста для TradingError:**
```typescript
import { describe, it, expect } from '@jest/globals';
import { TradingError, ErrorCode } from '../../../src/base/index.js';

describe('TradingError', () => {
  it('should create error with message and code', () => {
    const error = new TradingError('Test error', ErrorCode.UNKNOWN_ERROR);

    expect(error.message).toBe('Test error');
    expect(error.code).toBe(ErrorCode.UNKNOWN_ERROR);
    expect(error.timestamp).toBeInstanceOf(Date);
  });

  it('should include context', () => {
    const context = { userId: '123', action: 'trade' };
    const error = new TradingError('Test', ErrorCode.UNKNOWN_ERROR, context);

    expect(error.context).toEqual(context);
  });

  it('should serialize to JSON', () => {
    const error = new TradingError('Test', ErrorCode.UNKNOWN_ERROR);
    const json = error.toJSON();

    expect(json).toHaveProperty('name');
    expect(json).toHaveProperty('message');
    expect(json).toHaveProperty('code');
    expect(json).toHaveProperty('timestamp');
  });

  it('should have stack trace', () => {
    const error = new TradingError('Test', ErrorCode.UNKNOWN_ERROR);

    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('TradingError');
  });

  it('should identify TradingError instances', () => {
    const error = new TradingError('Test', ErrorCode.UNKNOWN_ERROR);
    const regularError = new Error('Regular');

    expect(TradingError.isTradingError(error)).toBe(true);
    expect(TradingError.isTradingError(regularError)).toBe(false);
  });
});
```

**Покрытие тестами:**
- ✅ Создание ошибки
- ✅ Поля инициализируются корректно
- ✅ Сериализация в JSON
- ✅ Stack trace
- ✅ Type guards

---

#### Шаг 8.2: Тесты domain ошибок

Создать минимум 1 тест для каждой domain ошибки.

**Приоритетные:**
- InsufficientFundsError (с тестом метода getShortfall())
- ValidationError (aggregate)
- MarketClosedError

---

#### Шаг 8.3: Тесты ErrorFactory

**Файл:** `__tests__/unit/factories/ErrorFactory.test.ts`

**Покрытие:**
- ✅ Все factory методы создают правильные типы
- ✅ wrap() корректно обрабатывает:
  - TradingError (возвращает как есть)
  - Error (оборачивает)
  - unknown (оборачивает)

---

#### Шаг 8.4: Integration тест

**Файл:** `__tests__/integration/error-flow.test.ts`

**Сценарий:**
1. Создать ошибку через factory
2. Сериализовать в JSON
3. Парсить обратно
4. Проверить что все поля сохранились

---

### Фаза 9: Документация

#### Шаг 9.1: README.md

**Файл:** `packages/foundation/errors/README.md`

**Содержимое:**
```markdown
# @polymarket/errors

Foundation пакет для централизованной обработки ошибок в Polymarket trading system.

## Установка

```bash
pnpm add @polymarket/errors
```

## Использование

### Базовые ошибки

```typescript
import { TradingError, ErrorCode } from '@polymarket/errors';

throw new TradingError('Something went wrong', ErrorCode.UNKNOWN_ERROR);
```

### Domain ошибки

```typescript
import { MarketClosedError, InsufficientFundsError } from '@polymarket/errors';

// Market закрыт
throw new MarketClosedError('market-123', new Date());

// Недостаточно средств
throw new InsufficientFundsError(100, 50); // требуется 100, доступно 50
```

### ErrorFactory

```typescript
import { ErrorFactory } from '@polymarket/errors';

// Удобное создание ошибок
throw ErrorFactory.notFound('Market', 'market-123');
throw ErrorFactory.validation('price', -1, 'Price must be positive');
```

### Обработка ошибок

```typescript
try {
  await placeOrder(order);
} catch (error) {
  if (error instanceof InsufficientFundsError) {
    console.log(`Need ${error.getShortfall()} more USDC`);
  } else if (TradingError.isTradingError(error)) {
    console.log(`Error ${error.code}: ${error.message}`);
  }
}
```

### Сериализация

```typescript
import { serializeError } from '@polymarket/errors';

const error = new MarketClosedError('market-123', new Date());
const json = serializeError(error, true); // включить stack trace
console.log(JSON.stringify(json));
```

## Архитектура

### Иерархия ошибок

```
Error (native)
  └─ TradingError
      ├─ DomainError
      │   ├─ MarketClosedError
      │   ├─ InsufficientFundsError
      │   └─ ...
      ├─ ValidationError
      └─ NotFoundError
```

### Коды ошибок

Все ошибки имеют уникальный код из enum `ErrorCode`:
- `MARKET_NOT_FOUND`
- `INSUFFICIENT_FUNDS`
- `VALIDATION_ERROR`
- и т.д.

## Документация

- [Полная документация](./DOCUMENTATION.md)
- [Руководство по архитектуре](./ARCHITECTURE.md)
- [Примеры использования](./EXAMPLES.md)
- [Руководство по миграции](./MIGRATION_GUIDE.md)

## Тесты

```bash
pnpm test              # Запуск тестов
pnpm test:coverage     # С покрытием
```

## Лицензия

MIT
```

---

#### Шаг 9.2: DOCUMENTATION.md (Полная документация)

**Файл:** `packages/foundation/errors/DOCUMENTATION.md`

**Содержимое:**

```markdown
# @polymarket/errors - Полная документация

## Содержание

1. [Введение](#введение)
2. [Архитектура](#архитектура)
3. [Базовые классы](#базовые-классы)
4. [Domain ошибки](#domain-ошибки)
5. [ErrorFactory](#errorfactory)
6. [Сериализация](#сериализация)
7. [Best Practices](#best-practices)
8. [FAQ](#faq)

---

## Введение

`@polymarket/errors` - это foundation пакет для структурированной обработки ошибок в Polymarket trading system.

### Зачем нужен этот пакет?

**Проблемы традиционного подхода:**
- ❌ Ошибки не типизированы (любой может бросить что угодно)
- ❌ Нет структуры (простые строки или generic Error)
- ❌ Сложно обрабатывать разные типы ошибок
- ❌ Нет контекста (что пошло не так?)
- ❌ Нет кодов ошибок для API

**Решение:**
- ✅ Типизированные ошибки (TypeScript помогает)
- ✅ Структурированные данные (code, timestamp, context)
- ✅ Иерархия ошибок (легко обрабатывать)
- ✅ Контекст ошибки (все данные для отладки)
- ✅ Коды ошибок для API/UI

---

## Архитектура

### Иерархия классов

```
Error (native JS)
  │
  └─ TradingError (корневой класс)
      │
      ├─ DomainError (для domain логики)
      │   │
      │   ├─ MarketNotFoundError
      │   ├─ MarketClosedError
      │   ├─ InsufficientFundsError
      │   ├─ OrderNotFoundError
      │   └─ ...
      │
      ├─ ValidationError (для валидации)
      │   │
      │   ├─ OrderValidationError
      │   ├─ InvalidPriceError
      │   └─ ...
      │
      └─ NotFoundError (для "не найдено")
```

### Структура данных ошибки

Каждая ошибка содержит:

```typescript
{
  name: string;              // Имя класса (например, "InsufficientFundsError")
  message: string;           // Человекочитаемое сообщение
  code: string;              // Уникальный код (например, "INSUFFICIENT_FUNDS")
  timestamp: Date;           // Когда произошла ошибка
  context?: Record<string, unknown>;  // Дополнительный контекст
  stack?: string;            // Stack trace для отладки
}
```

### Коды ошибок

Все коды определены в enum `ErrorCode`:

```typescript
export enum ErrorCode {
  // General
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',

  // Market
  MARKET_NOT_FOUND = 'MARKET_NOT_FOUND',
  MARKET_CLOSED = 'MARKET_CLOSED',
  MARKET_EXPIRED = 'MARKET_EXPIRED',

  // Order
  ORDER_NOT_FOUND = 'ORDER_NOT_FOUND',
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  ORDER_ALREADY_CANCELLED = 'ORDER_ALREADY_CANCELLED',

  // ... и т.д.
}
```

---

## Базовые классы

### TradingError

**Корневой класс всех ошибок в системе.**

```typescript
export class TradingError extends Error {
  public readonly code: string;
  public readonly timestamp: Date;
  public readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    context?: Record<string, unknown>
  );

  // Методы
  public toJSON(): Record<string, unknown>;
  public static isTradingError(error: unknown): error is TradingError;
}
```

**Пример использования:**

```typescript
import { TradingError, ErrorCode } from '@polymarket/errors';

// Создание
throw new TradingError(
  'Something went wrong',
  ErrorCode.UNKNOWN_ERROR,
  { userId: '123', action: 'trade' }
);

// Проверка типа
try {
  // ... код
} catch (error) {
  if (TradingError.isTradingError(error)) {
    console.log(`Error code: ${error.code}`);
    console.log(`Context:`, error.context);
  }
}

// Сериализация
const error = new TradingError('Test', ErrorCode.UNKNOWN_ERROR);
const json = error.toJSON();
console.log(JSON.stringify(json));
```

---

### DomainError

**Базовый класс для domain логики.**

```typescript
export class DomainError extends TradingError {
  constructor(
    message: string,
    code: string,
    context?: Record<string, unknown>
  );
}
```

**Когда использовать:**
- ✅ Нарушение бизнес-правил
- ✅ Domain инварианты нарушены
- ✅ Ошибки, понятные бизнесу

**Когда НЕ использовать:**
- ❌ Технические ошибки (network, database)
- ❌ Infrastructure ошибки
- ❌ Проблемы валидации input

**Пример:**

```typescript
// Бизнес-правило: нельзя торговать на закрытом рынке
throw new MarketClosedError('market-123', new Date());

// Бизнес-правило: недостаточно средств
throw new InsufficientFundsError(100, 50);
```

---

### ValidationError

**Ошибка валидации данных.**

```typescript
export class ValidationError extends TradingError {
  public readonly field?: string;
  public readonly value?: unknown;
  public readonly errors?: ValidationError[];

  constructor(
    message: string,
    field?: string,
    value?: unknown,
    errors?: ValidationError[]
  );

  // Статические методы
  public static forField(
    field: string,
    value: unknown,
    message: string
  ): ValidationError;

  public static aggregate(
    errors: ValidationError[]
  ): ValidationError;
}
```

**Использование:**

```typescript
import { ValidationError } from '@polymarket/errors';

// Одна ошибка валидации
throw ValidationError.forField(
  'price',
  -1,
  'Price must be positive'
);

// Множественные ошибки
const errors = [
  ValidationError.forField('price', -1, 'must be positive'),
  ValidationError.forField('quantity', 0, 'must be greater than 0')
];
throw ValidationError.aggregate(errors);

// Обработка
try {
  validateOrder(order);
} catch (error) {
  if (error instanceof ValidationError) {
    if (error.errors) {
      // Множественные ошибки
      error.errors.forEach(e => {
        console.log(`${e.field}: ${e.message}`);
      });
    } else {
      // Одна ошибка
      console.log(`${error.field}: ${error.message}`);
    }
  }
}
```

---

### NotFoundError

**Ошибка "не найдено".**

```typescript
export class NotFoundError extends DomainError {
  public readonly entityType: string;
  public readonly entityId: string;

  constructor(entityType: string, entityId: string);
}
```

**Использование:**

```typescript
import { NotFoundError } from '@polymarket/errors';

// Создание
throw new NotFoundError('Market', 'market-123');
// Сообщение: "Market with ID "market-123" not found"

// Обработка
try {
  const market = await getMarket(id);
} catch (error) {
  if (error instanceof NotFoundError) {
    console.log(`${error.entityType} not found: ${error.entityId}`);
  }
}
```

---

## Domain ошибки

### Market Errors

#### MarketNotFoundError

```typescript
export class MarketNotFoundError extends NotFoundError {
  constructor(marketId: string);
}

// Использование
throw new MarketNotFoundError('market-123');
```

#### MarketClosedError

```typescript
export class MarketClosedError extends DomainError {
  public readonly marketId: string;
  public readonly closedAt: Date;

  constructor(marketId: string, closedAt: Date);
}

// Использование
throw new MarketClosedError('market-123', new Date('2024-01-15'));

// Обработка
if (error instanceof MarketClosedError) {
  console.log(`Market closed at ${error.closedAt.toISOString()}`);
}
```

---

### Order Errors

#### InsufficientFundsError

```typescript
export class InsufficientFundsError extends DomainError {
  public readonly required: number;
  public readonly available: number;

  constructor(required: number, available: number);

  // Дополнительный метод
  public getShortfall(): number;
}

// Использование
const required = 100;  // USDC
const available = 50;  // USDC
throw new InsufficientFundsError(required, available);

// Обработка
if (error instanceof InsufficientFundsError) {
  const need = error.getShortfall();
  console.log(`You need ${need} more USDC`);
}
```

#### OrderValidationError

```typescript
export class OrderValidationError extends ValidationError {
  constructor(field: string, value: unknown, message: string);
}

// Использование
throw new OrderValidationError(
  'price',
  -1,
  'Price must be between 0.01 and 0.99'
);
```

---

### Position Errors

#### InsufficientPositionError

```typescript
export class InsufficientPositionError extends DomainError {
  public readonly requested: number;
  public readonly available: number;

  constructor(requested: number, available: number);
}

// Использование
throw new InsufficientPositionError(100, 50);
```

---

## ErrorFactory

**Фабрика для удобного создания ошибок.**

### Методы

```typescript
export class ErrorFactory {
  // Not Found
  public static notFound(
    entityType: string,
    entityId: string
  ): NotFoundError;

  // Validation
  public static validation(
    field: string,
    value: unknown,
    message: string
  ): ValidationError;

  // Insufficient Funds
  public static insufficientFunds(
    required: number,
    available: number
  ): InsufficientFundsError;

  // Market Closed
  public static marketClosed(
    marketId: string,
    closedAt: Date
  ): MarketClosedError;

  // Wrap unknown error
  public static wrap(error: unknown): TradingError;
}
```

### Использование

```typescript
import { ErrorFactory } from '@polymarket/errors';

// Not Found
throw ErrorFactory.notFound('Market', 'market-123');

// Validation
throw ErrorFactory.validation('price', -1, 'Price must be positive');

// Insufficient Funds
throw ErrorFactory.insufficientFunds(100, 50);

// Wrap unknown error
try {
  JSON.parse('invalid');
} catch (error) {
  throw ErrorFactory.wrap(error);
  // Конвертирует в TradingError с кодом UNKNOWN_ERROR
}
```

### Зачем нужен ErrorFactory?

1. ✅ Единое место для создания ошибок
2. ✅ Короткий синтаксис
3. ✅ Можно добавить логирование/метрики
4. ✅ Централизованная обработка

---

## Сериализация

### serializeError

```typescript
export interface SerializedError {
  name: string;
  message: string;
  code: string;
  timestamp: string;
  context?: Record<string, unknown>;
  stack?: string;
}

export function serializeError(
  error: TradingError,
  includeStack?: boolean
): SerializedError;
```

**Использование:**

```typescript
import { serializeError } from '@polymarket/errors';

const error = new InsufficientFundsError(100, 50);

// Без stack trace
const json1 = serializeError(error);
console.log(JSON.stringify(json1));
// {
//   "name": "InsufficientFundsError",
//   "message": "Insufficient funds: required 100 USDC, available 50 USDC",
//   "code": "INSUFFICIENT_FUNDS",
//   "timestamp": "2024-01-15T10:30:00.000Z",
//   "context": { "required": 100, "available": 50 }
// }

// Со stack trace (для debugging)
const json2 = serializeError(error, true);
console.log(json2.stack); // полный stack trace
```

**Когда использовать:**
- ✅ API responses
- ✅ Логирование
- ✅ Передача ошибок через network
- ✅ Сохранение в БД

---

## Best Practices

### 1. Всегда используйте типизированные ошибки

```typescript
// ❌ Плохо
throw new Error('Market not found');

// ✅ Хорошо
throw new MarketNotFoundError('market-123');
```

### 2. Используйте ErrorFactory

```typescript
// ❌ Можно, но многословно
throw new NotFoundError('Market', 'market-123');

// ✅ Лучше
throw ErrorFactory.notFound('Market', 'market-123');
```

### 3. Добавляйте контекст

```typescript
// ❌ Мало информации
throw new TradingError('Order failed', ErrorCode.UNKNOWN_ERROR);

// ✅ Полный контекст
throw new TradingError(
  'Order failed',
  ErrorCode.UNKNOWN_ERROR,
  {
    userId: user.id,
    marketId: market.id,
    amount: amount,
    reason: 'Insufficient liquidity'
  }
);
```

### 4. Обрабатывайте специфичные ошибки первыми

```typescript
try {
  await placeOrder(order);
} catch (error) {
  // Сначала специфичные
  if (error instanceof InsufficientFundsError) {
    console.log(`Need ${error.getShortfall()} more USDC`);
  } else if (error instanceof MarketClosedError) {
    console.log(`Market closed at ${error.closedAt}`);
  }
  // Потом общие
  else if (error instanceof DomainError) {
    console.log(`Domain error: ${error.message}`);
  } else if (TradingError.isTradingError(error)) {
    console.log(`Trading error: ${error.code}`);
  }
  // Последний catch-all
  else {
    console.error('Unknown error:', error);
  }
}
```

### 5. Логируйте с контекстом

```typescript
import { serializeError } from '@polymarket/errors';

try {
  await placeOrder(order);
} catch (error) {
  if (TradingError.isTradingError(error)) {
    // Логируем полную структуру
    logger.error('Order placement failed', {
      error: serializeError(error, true),
      userId: user.id,
      orderId: order.id
    });
  }
}
```

### 6. Не используйте domain ошибки для технических проблем

```typescript
// ❌ Неправильно - это технические ошибки
throw new DomainError('Database connection failed', 'DB_ERROR');
throw new DomainError('Network timeout', 'NETWORK_ERROR');

// ✅ Правильно - domain ошибки для бизнес-правил
throw new MarketClosedError('market-123', new Date());
throw new InsufficientFundsError(100, 50);
```

---

## FAQ

### Q: Когда использовать DomainError vs ValidationError?

**A:**
- **ValidationError** - проблемы с входными данными (некорректный формат, отсутствующие поля)
- **DomainError** - нарушение бизнес-правил (рынок закрыт, недостаточно средств)

```typescript
// ValidationError - input некорректен
throw ValidationError.forField('price', 'abc', 'must be a number');

// DomainError - бизнес-правило нарушено
throw new InsufficientFundsError(100, 50);
```

### Q: Как обрабатывать множественные ошибки валидации?

**A:** Используйте `ValidationError.aggregate()`:

```typescript
const errors: ValidationError[] = [];

if (price < 0.01) {
  errors.push(ValidationError.forField('price', price, 'too low'));
}
if (quantity <= 0) {
  errors.push(ValidationError.forField('quantity', quantity, 'must be positive'));
}

if (errors.length > 0) {
  throw ValidationError.aggregate(errors);
}
```

### Q: Как добавить свою domain ошибку?

**A:** Создайте новый файл, наследуйте от `DomainError`:

```typescript
// src/domain/market/LiquidityTooLowError.ts
import { DomainError } from '../../base/DomainError.js';
import { ErrorCode } from '../../base/ErrorCode.js';

export class LiquidityTooLowError extends DomainError {
  public readonly marketId: string;
  public readonly requiredLiquidity: number;
  public readonly availableLiquidity: number;

  constructor(
    marketId: string,
    required: number,
    available: number
  ) {
    super(
      `Insufficient liquidity in market ${marketId}: required ${required}, available ${available}`,
      ErrorCode.INSUFFICIENT_LIQUIDITY,
      { marketId, required, available }
    );
    this.marketId = marketId;
    this.requiredLiquidity = required;
    this.availableLiquidity = available;
  }
}
```

Не забудьте:
1. Добавить код в `ErrorCode` enum
2. Экспортировать в `index.ts`
3. Добавить в `ErrorFactory` (опционально)
4. Написать тесты

### Q: Нужно ли оборачивать все external ошибки?

**A:** Да, на границах системы:

```typescript
// На границе с external API
try {
  await externalAPI.fetchData();
} catch (error) {
  throw ErrorFactory.wrap(error);
}

// Внутри domain - используйте typed errors
function placeOrder() {
  if (balance < amount) {
    throw new InsufficientFundsError(amount, balance);
  }
}
```

---

## Заключение

`@polymarket/errors` предоставляет:
- ✅ Типизированные ошибки
- ✅ Структурированные данные
- ✅ Удобную обработку
- ✅ Полный контекст
- ✅ API-friendly сериализация

**Next steps:**
- Изучите [примеры](./EXAMPLES.md)
- Ознакомьтесь с [архитектурой](./ARCHITECTURE.md)
- Прочитайте [руководство по миграции](./MIGRATION_GUIDE.md)
```

---

#### Шаг 9.3: EXAMPLES.md (Примеры использования)

**Файл:** `packages/foundation/errors/EXAMPLES.md`

**Содержимое:** (Будет содержать реальные примеры использования в различных сценариях)

---

#### Шаг 9.4: ARCHITECTURE.md (Архитектурные решения)

**Файл:** `packages/foundation/errors/ARCHITECTURE.md`

**Содержимое:** (Будет объяснять архитектурные решения, dependency graph, интеграция с другими пакетами)

---

#### Шаг 9.5: MIGRATION_GUIDE.md (Руководство по миграции)

**Файл:** `packages/foundation/errors/MIGRATION_GUIDE.md`

**Содержимое:** (Руководство по миграции существующего кода на использование @polymarket/errors)

---

### Фаза 10: Build и валидация

#### Шаг 10.1: Сборка пакета

```bash
cd packages/foundation/errors
pnpm install
pnpm build
```

**Проверка:**
- ✅ `dist/` создана
- ✅ `dist/index.js` существует
- ✅ `dist/index.d.ts` существует
- ✅ Все типы экспортируются

---

#### Шаг 10.2: Запуск тестов

```bash
pnpm test
```

**Требования:**
- ✅ Все тесты проходят
- ✅ Покрытие > 90%
- ✅ Нет пропущенных тестов

---

#### Шаг 10.3: Typecheck

```bash
pnpm typecheck
```

**Требования:**
- ✅ Нет ошибок TypeScript
- ✅ Все типы экспортируются корректно

---

#### Шаг 10.4: Lint

```bash
pnpm lint
```

**Требования:**
- ✅ Нет ошибок линтера
- ✅ Код соответствует стилю

---

## 📊 Чеклист готовности

### Структура
- [ ] Создана структура папок
- [ ] package.json настроен
- [ ] tsconfig.json настроен
- [ ] tsconfig.build.json настроен
- [ ] jest.config.ts настроен
- [ ] README.md написан

### Базовые классы
- [ ] TradingError реализован
- [ ] DomainError реализован
- [ ] ValidationError реализован
- [ ] NotFoundError реализован
- [ ] ErrorCode enum создан

### Domain ошибки
- [ ] Market errors (4 ошибки)
- [ ] Order errors (7 ошибок)
- [ ] Position errors (3 ошибки)
- [ ] Price errors (2 ошибки)
- [ ] Quantity errors (3 ошибки)

### Утилиты
- [ ] ErrorFactory реализован
- [ ] ErrorSerializer реализован
- [ ] ErrorParser реализован
- [ ] Type guards реализованы

### Тесты
- [ ] Тесты базовых классов (5 файлов)
- [ ] Тесты domain ошибок (10+ файлов)
- [ ] Тесты ErrorFactory
- [ ] Тесты сериализации
- [ ] Integration тест
- [ ] Покрытие > 90%

### Документация
- [ ] TSDoc для всех публичных API
- [ ] Примеры в JSDoc
- [ ] README.md
- [ ] Комментарии на русском

### Build
- [ ] `pnpm build` успешна
- [ ] `pnpm test` все тесты проходят
- [ ] `pnpm typecheck` без ошибок
- [ ] `pnpm lint` без ошибок
- [ ] dist/ содержит корректные файлы

---

## 🎯 Критерии приемки

1. **Функциональность:**
   - ✅ Все ошибки создаются и работают
   - ✅ Сериализация/десериализация работает
   - ✅ ErrorFactory создаёт все типы ошибок
   - ✅ Type guards работают корректно

2. **Качество кода:**
   - ✅ TypeScript strict mode без ошибок
   - ✅ 100% покрытие тестами public API
   - ✅ Нет any типов
   - ✅ Все функции имеют TSDoc

3. **Документация:**
   - ✅ README актуален
   - ✅ Примеры работают
   - ✅ API понятно из документации

4. **Производительность:**
   - ✅ Создание ошибки < 1ms
   - ✅ Нет утечек памяти
   - ✅ Zero dependencies

---

## 🔄 Порядок реализации (приоритезация)

### День 1 - Фундамент
1. ✅ Фаза 1: Инициализация (Setup)
2. ✅ Фаза 2.1: ErrorCode enum
3. ✅ Фаза 2.2: TradingError
4. ✅ Фаза 2.3-2.5: Остальные базовые классы
5. ✅ Тесты базовых классов

### День 2 - Domain ошибки
6. ✅ Фаза 3.1: Market errors
7. ✅ Фаза 3.2: Order errors (приоритет: InsufficientFundsError)
8. ✅ Фаза 3.3-3.5: Position/Price/Quantity errors
9. ✅ Тесты domain ошибок (минимум ключевых)

### День 3 - Утилиты и документация
10. ✅ Фаза 4: ErrorFactory
11. ✅ Фаза 5: Сериализация
12. ✅ Фаза 6: Утилиты
13. ✅ Фаза 7: Главный export
14. ✅ Фаза 8: Оставшиеся тесты
15. ✅ Фаза 9: Документация
16. ✅ Фаза 10: Build и валидация

---

## 🚀 Готов начать реализацию?

Предлагаю начать с **Фазы 1: Инициализация**.

Создать:
1. Структуру папок
2. package.json
3. tsconfig.json
4. tsconfig.build.json

Начинаем?
