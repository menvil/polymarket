# Foundation Packages: Независимые базовые пакеты

## 1️⃣ Альтернативы названию "Value Object"

### Варианты:

| Название | Плюсы | Минусы | Оценка |
|----------|-------|---------|---------|
| **value-objects** | ✅ Классический DDD термин<br>✅ Всем понятно что это<br>✅ Точно описывает назначение | ❌ Длинное название<br>❌ Может быть сложно для новичков | ⭐⭐⭐⭐⭐ |
| **values** | ✅ Короче<br>✅ Проще<br>✅ Понятно | ❌ Менее специфично<br>❌ Может путаться с "значениями" в общем смысле | ⭐⭐⭐⭐ |
| **primitives** | ✅ Четко показывает "базовые блоки"<br>✅ Короткое | ❌ В программировании "primitive" = int/string/bool<br>❌ Может вводить в заблуждение | ⭐⭐⭐ |
| **domain-values** | ✅ Явно указывает на domain<br>✅ Точное | ❌ Слишком длинное<br>❌ Избыточное (и так в domain/) | ⭐⭐ |
| **immutables** | ✅ Описывает главное свойство | ❌ Entities тоже immutable<br>❌ Не показывает отсутствие identity | ⭐⭐ |
| **types** | ✅ Короткое | ❌ Путается с TypeScript types<br>❌ Слишком общее | ⭐ |

### ✅ Рекомендация: **Оставить `value-objects`**

**Почему:**
- Это стандартный термин DDD
- Явно показывает, что у объектов нет identity
- Все в команде будут понимать одинаково
- Легко найти информацию в интернете

**Альтернатива (если хочется короче):** `values`

---

## 2️⃣ Начинать с независимых пакетов - ОТЛИЧНАЯ идея! ✅

### Стратегия "снизу вверх"

```
Layer 0: Foundation (независимые)
├── @polymarket/errors         deps: []
├── @polymarket/types          deps: []
└── @polymarket/constants      deps: []

Layer 1: Domain Primitives
├── @polymarket/value-objects  deps: [errors, types]
└── @polymarket/events         deps: [types]

Layer 2: Domain Core
├── @polymarket/entities       deps: [value-objects, errors, types]
└── @polymarket/aggregates     deps: [entities, value-objects]

Layer 3: Domain Logic
├── @polymarket/services       deps: [entities, aggregates, value-objects]
└── @polymarket/state-machines deps: [entities, types]
```

### Порядок разработки

**Фаза 1: Foundation (День 1)** ← Начать отсюда!
1. `@polymarket/errors` - все ошибки
2. `@polymarket/types` - Result<T,E>, Maybe<T>, и т.д.
3. `@polymarket/constants` - константы (если нужны)

**Фаза 2: Domain Primitives (День 2)**
4. `@polymarket/value-objects` - Price, Quantity, Money
5. `@polymarket/events` - Domain events

**Фаза 3: Domain Core (День 3-4)**
6. `@polymarket/entities` - Market, Order, Trade, etc.
7. `@polymarket/aggregates` - Portfolio, Position

**Фаза 4: Domain Logic (День 5-6)**
8. `@polymarket/services` - Business logic
9. `@polymarket/state-machines` - FSM

**Преимущества подхода "снизу вверх":**
- ✅ Каждый пакет можно собрать и протестировать независимо
- ✅ Нет циклических зависимостей
- ✅ Быстрая обратная связь (сразу видно что работает)
- ✅ Можно параллелить разработку (если команда)

---

## 3️⃣ Структура пакета `errors` если их много

### Сколько ошибок бывает?

Для типичного trading domain:
- **Market errors:** 3-5 типов
- **Order errors:** 5-8 типов
- **Position errors:** 3-5 типов
- **Portfolio errors:** 2-4 типа
- **Trading errors:** 3-5 типов
- **Validation errors:** 5-10 типов

**Итого:** ~20-40 типов ошибок

### Варианты структуры

#### Вариант 1: Плоская структура (если < 10 ошибок)
```
packages/errors/
├── package.json
├── src/
│   ├── TradingError.ts              # Базовая ошибка
│   ├── MarketNotFoundError.ts
│   ├── MarketClosedError.ts
│   ├── OrderValidationError.ts
│   ├── InsufficientFundsError.ts
│   ├── InsufficientPositionError.ts
│   ├── LotNotFoundError.ts
│   └── index.ts                     # export * from './...'
└── __tests__/
    └── errors.test.ts
```

**Плюсы:**
- ✅ Простая структура
- ✅ Легко найти любую ошибку
- ✅ Один import для всех ошибок

**Минусы:**
- ❌ При росте > 10 файлов становится неудобно
- ❌ Нет логической группировки

---

#### Вариант 2: Группировка по domain сущностям (10-40 ошибок) ⭐ РЕКОМЕНДУЮ

```
packages/errors/
├── package.json
├── src/
│   ├── base/
│   │   ├── TradingError.ts          # Базовая ошибка (все наследуются)
│   │   └── ErrorCode.ts             # Enum с кодами ошибок
│   │
│   ├── market/
│   │   ├── MarketNotFoundError.ts
│   │   ├── MarketClosedError.ts
│   │   ├── MarketExpiredError.ts
│   │   └── index.ts
│   │
│   ├── order/
│   │   ├── OrderValidationError.ts
│   │   ├── OrderNotFoundError.ts
│   │   ├── InsufficientFundsError.ts
│   │   ├── InvalidPriceError.ts
│   │   └── index.ts
│   │
│   ├── position/
│   │   ├── InsufficientPositionError.ts
│   │   ├── InsufficientLotQuantityError.ts
│   │   ├── LotNotFoundError.ts
│   │   └── index.ts
│   │
│   ├── portfolio/
│   │   ├── DuplicatePositionError.ts
│   │   ├── PositionNotFoundError.ts
│   │   └── index.ts
│   │
│   └── index.ts                      # Экспортирует всё
│
└── __tests__/
    ├── market/
    ├── order/
    └── position/
```

**index.ts (root):**
```typescript
// Экспортируем базовые
export * from './base/TradingError.js';
export * from './base/ErrorCode.js';

// Экспортируем все категории
export * from './market/index.js';
export * from './order/index.js';
export * from './position/index.js';
export * from './portfolio/index.js';
```

**Использование:**
```typescript
// Можно импортировать всё разом
import { MarketNotFoundError, OrderValidationError } from '@polymarket/errors';

// Или по категориям
import { MarketNotFoundError } from '@polymarket/errors/market';
import { OrderValidationError } from '@polymarket/errors/order';
```

**Плюсы:**
- ✅ Логическая группировка
- ✅ Легко найти ошибки определенной категории
- ✅ Масштабируется до 100+ ошибок
- ✅ Можно импортировать только нужную категорию

**Минусы:**
- ❌ Чуть сложнее структура

---

#### Вариант 3: По типам ошибок (если нужна кросс-доменная группировка)

```
packages/errors/
├── src/
│   ├── validation/               # Все ошибки валидации
│   │   ├── OrderValidationError.ts
│   │   ├── MarketValidationError.ts
│   │   └── index.ts
│   │
│   ├── not-found/                # Все "не найдено"
│   │   ├── MarketNotFoundError.ts
│   │   ├── OrderNotFoundError.ts
│   │   └── index.ts
│   │
│   ├── insufficient/             # Все "недостаточно"
│   │   ├── InsufficientFundsError.ts
│   │   ├── InsufficientPositionError.ts
│   │   └── index.ts
│   │
│   └── index.ts
```

**Плюсы:**
- ✅ Группировка по типу проблемы
- ✅ Полезно для обработки ошибок по категориям

**Минусы:**
- ❌ Менее интуитивно для поиска
- ❌ Не соответствует domain структуре

---

### ✅ Рекомендация: Начать с Варианта 1, потом перейти на Вариант 2

**Этапы:**
1. **Старт:** Вариант 1 (плоская структура) - пока < 10 ошибок
2. **Рост:** При достижении 10-15 ошибок → рефакторинг на Вариант 2
3. **Масштабирование:** Вариант 2 выдержит до 100+ ошибок

---

## 4️⃣ `errors` как отдельный пакет - ДА! ✅

### Package structure

```
packages/errors/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── base/
│   │   ├── TradingError.ts
│   │   └── ErrorCode.ts
│   ├── market/
│   │   └── ...
│   ├── order/
│   │   └── ...
│   └── index.ts
└── __tests__/
    └── ...
```

### package.json

```json
{
  "name": "@polymarket/errors",
  "version": "1.0.0",
  "description": "Domain errors - foundation layer, zero dependencies",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./market": {
      "import": "./dist/market/index.js",
      "types": "./dist/market/index.d.ts"
    },
    "./order": {
      "import": "./dist/order/index.js",
      "types": "./dist/order/index.d.ts"
    },
    "./position": {
      "import": "./dist/position/index.js",
      "types": "./dist/position/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest",
    "test:coverage": "vitest --coverage",
    "lint": "eslint src/**/*.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {},
  "devDependencies": {
    "typescript": "^5.3.0",
    "vitest": "^1.0.0",
    "@vitest/coverage-v8": "^1.0.0",
    "eslint": "^8.0.0"
  },
  "keywords": ["errors", "domain", "trading", "foundation"],
  "license": "MIT"
}
```

**Критично:** `"dependencies": {}` - нет зависимостей!

### Почему errors - отдельный пакет?

1. **Foundation layer (Layer 0)**
   ```
   Layer 2: entities → зависит от errors
   Layer 1: value-objects → зависит от errors
   Layer 0: errors → не зависит ни от чего ✅
   ```

2. **Переиспользование**
   - Domain слой использует
   - Application слой использует
   - Infrastructure слой использует
   - Presentation слой использует
   - Все используют одни и те же ошибки!

3. **Быстрая сборка**
   ```bash
   pnpm --filter @polymarket/errors build
   # Собирается за 1-2 секунды (нет зависимостей)
   ```

4. **Изоляция**
   - Изменения в errors не требуют пересборки других пакетов
   - Можно выпустить новую версию errors независимо

5. **Тестирование**
   ```bash
   pnpm --filter @polymarket/errors test
   # Тесты работают без других пакетов
   ```

---

## 📦 Полная структура Foundation пакетов

### Layer 0: Foundation (независимые, без зависимостей)

```
packages/
├── errors/                          # @polymarket/errors
│   ├── package.json                 # deps: []
│   ├── src/
│   │   ├── base/
│   │   │   ├── TradingError.ts
│   │   │   └── ErrorCode.ts
│   │   ├── market/
│   │   │   ├── MarketNotFoundError.ts
│   │   │   ├── MarketClosedError.ts
│   │   │   └── index.ts
│   │   ├── order/
│   │   │   ├── OrderValidationError.ts
│   │   │   ├── InsufficientFundsError.ts
│   │   │   └── index.ts
│   │   ├── position/
│   │   │   ├── InsufficientPositionError.ts
│   │   │   ├── LotNotFoundError.ts
│   │   │   └── index.ts
│   │   └── index.ts
│   └── __tests__/
│
├── types/                           # @polymarket/types
│   ├── package.json                 # deps: []
│   ├── src/
│   │   ├── Result.ts                # Result<T, E>
│   │   ├── Maybe.ts                 # Maybe<T>
│   │   ├── AsyncResult.ts           # Promise<Result<T, E>>
│   │   └── index.ts
│   └── __tests__/
│
└── constants/                       # @polymarket/constants (опционально)
    ├── package.json                 # deps: []
    ├── src/
    │   ├── limits.ts                # MIN_PRICE, MAX_PRICE, etc.
    │   ├── status.ts                # Status enums
    │   └── index.ts
    └── __tests__/
```

---

## 🚀 План рефакторинга: Начать с Foundation

### Фаза 1: Создать foundation пакеты (День 1) ← НАЧАТЬ ОТСЮДА

#### Шаг 1.1: Создать @polymarket/errors (2 часа)

```bash
# Создать структуру
mkdir -p packages/errors/src/{base,market,order,position,portfolio}
mkdir -p packages/errors/__tests__

# Создать package.json
cat > packages/errors/package.json << 'EOF'
{
  "name": "@polymarket/errors",
  "version": "1.0.0",
  "description": "Domain errors - foundation layer",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest"
  },
  "dependencies": {},
  "devDependencies": {
    "typescript": "^5.3.0",
    "vitest": "^1.0.0"
  }
}
EOF

# Создать tsconfig.json
cat > packages/errors/tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "declaration": true,
    "declarationMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["__tests__", "dist", "node_modules"]
}
EOF
```

**Создать базовые ошибки:**

`packages/errors/src/base/TradingError.ts`:
```typescript
/**
 * Базовая ошибка торговой системы
 *
 * @remarks
 * Все domain ошибки наследуются от TradingError.
 * Содержит код ошибки для программной обработки.
 */
export class TradingError extends Error {
  /**
   * Создаёт TradingError
   *
   * @param message - Человекочитаемое сообщение
   * @param code - Код ошибки для программной обработки
   */
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'TradingError';
    // Сохраняем правильный stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}
```

`packages/errors/src/base/ErrorCode.ts`:
```typescript
/**
 * Коды ошибок торговой системы
 *
 * @remarks
 * Используйте эти константы вместо magic strings.
 */
export const ErrorCode = {
  // Market errors
  MARKET_NOT_FOUND: 'MARKET_NOT_FOUND',
  MARKET_CLOSED: 'MARKET_CLOSED',
  MARKET_EXPIRED: 'MARKET_EXPIRED',

  // Order errors
  ORDER_VALIDATION_ERROR: 'ORDER_VALIDATION_ERROR',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  INVALID_PRICE: 'INVALID_PRICE',

  // Position errors
  INSUFFICIENT_POSITION: 'INSUFFICIENT_POSITION',
  INSUFFICIENT_LOT_QUANTITY: 'INSUFFICIENT_LOT_QUANTITY',
  LOT_NOT_FOUND: 'LOT_NOT_FOUND',

  // Portfolio errors
  DUPLICATE_POSITION: 'DUPLICATE_POSITION',
  POSITION_NOT_FOUND: 'POSITION_NOT_FOUND',
} as const;

export type ErrorCodeType = typeof ErrorCode[keyof typeof ErrorCode];
```

**Создать domain-specific ошибки:**

`packages/errors/src/market/MarketNotFoundError.ts`:
```typescript
import { TradingError } from '../base/TradingError.js';
import { ErrorCode } from '../base/ErrorCode.js';

/**
 * Ошибка "рынок не найден"
 *
 * @remarks
 * Выбрасывается когда запрошенный рынок не существует в системе.
 */
export class MarketNotFoundError extends TradingError {
  constructor(public readonly marketId: string) {
    super(
      `Market not found: ${marketId}`,
      ErrorCode.MARKET_NOT_FOUND
    );
    this.name = 'MarketNotFoundError';
  }
}
```

**И так далее для всех ошибок...**

#### Шаг 1.2: Создать @polymarket/types (1 час)

`packages/types/src/Result.ts`:
```typescript
/**
 * Result<T, E> type для обработки ошибок без exceptions
 *
 * @remarks
 * Railway-oriented programming pattern.
 * Вместо try/catch используем Result.
 *
 * @example
 * ```typescript
 * function divide(a: number, b: number): Result<number, string> {
 *   if (b === 0) {
 *     return Err('Division by zero');
 *   }
 *   return Ok(a / b);
 * }
 *
 * const result = divide(10, 2);
 * if (result.ok) {
 *   console.log(result.value); // 5
 * } else {
 *   console.error(result.error);
 * }
 * ```
 */
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/**
 * Создаёт успешный Result
 */
export function Ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * Создаёт неуспешный Result
 */
export function Err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Проверяет является ли Result успешным
 */
export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

/**
 * Проверяет является ли Result неуспешным
 */
export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}
```

#### Шаг 1.3: Собрать и протестировать (30 минут)

```bash
# Собрать errors
cd packages/errors
pnpm install
pnpm build
pnpm test

# Собрать types
cd ../types
pnpm install
pnpm build
pnpm test
```

#### Шаг 1.4: Обновить imports в entities (30 минут)

```bash
# Заменить все imports
find packages/domain/entities -name "*.ts" -exec sed -i '' \
  's|../../shared/errors/TradingError|@polymarket/errors|g' {} \;

find packages/domain/entities -name "*.ts" -exec sed -i '' \
  's|../../shared/types/Result|@polymarket/types|g' {} \;
```

---

## ✅ Критерии успеха Фазы 1

1. **Пакеты собираются**
   ```bash
   pnpm --filter @polymarket/errors build ✅
   pnpm --filter @polymarket/types build ✅
   ```

2. **Тесты проходят**
   ```bash
   pnpm --filter @polymarket/errors test ✅
   pnpm --filter @polymarket/types test ✅
   ```

3. **Нет зависимостей**
   ```bash
   # В package.json:
   "dependencies": {} ✅
   ```

4. **Entities могут импортировать**
   ```typescript
   import { MarketNotFoundError } from '@polymarket/errors';
   import { Result, Ok, Err } from '@polymarket/types';
   // ✅ Работает
   ```

---

## 📊 Итоговая структура после Фазы 1

```
packages/
├── errors/                    # ✅ Создан, собран, протестирован
│   ├── package.json           # deps: []
│   ├── dist/                  # ✅ Compiled
│   └── src/
│       ├── base/
│       ├── market/
│       ├── order/
│       └── index.ts
│
├── types/                     # ✅ Создан, собран, протестирован
│   ├── package.json           # deps: []
│   ├── dist/                  # ✅ Compiled
│   └── src/
│       ├── Result.ts
│       └── index.ts
│
└── domain/
    ├── entities/              # ✅ Imports исправлены
    │   ├── Market.ts          # import from @polymarket/errors ✅
    │   ├── Order.ts           # import from @polymarket/types ✅
    │   └── ...
    └── value-objects/
        └── ...
```

---

## 🚀 Готов начать с Фазы 1?

Предлагаю:
1. Создать `@polymarket/errors` с группировкой по domain (market/, order/, position/)
2. Создать `@polymarket/types` с Result<T, E>
3. Собрать и протестировать оба пакета
4. Исправить imports в entities

Это займёт ~4 часа и даст нам **надёжный foundation** для всего остального.

Начинаем?
