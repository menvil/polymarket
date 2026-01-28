# @polymarket/math

Чистые математические операции с Decimal.js для торговой системы Polymarket.

## Описание

Пакет `@polymarket/math` предоставляет низкоуровневые математические функции для работы с высокоточными десятичными числами используя [Decimal.js](https://mikemcl.github.io/decimal.js/).

**Уровень архитектуры:** Core Layer (чистые функции без бизнес-логики)

## Установка

```bash
npm install @polymarket/math
```

## Ключевые особенности

- ✅ **Высокая точность** - использует Decimal.js для точных вычислений
- ✅ **Чистые функции** - без побочных эффектов, легко тестировать
- ✅ **Throw на невозможности** - выбрасывает ошибки при математических невозможностях (NaN, Infinity, деление на ноль)
- ✅ **Type-safe** - полная типобезопасность с TypeScript
- ✅ **100% покрытие тестами** - все функции покрыты unit и integration тестами
- ✅ **Минимальные зависимости** - только decimal.js и @polymarket/errors

## Модули

### Decimal Operations (`@polymarket/math/decimal`)

Базовые арифметические операции с Decimal:
- ✅ `addDecimal(a, b)` - сложение ([docs](./docs/decimal/add.md))
- ✅ `subtractDecimal(a, b)` - вычитание ([docs](./docs/decimal/subtract.md))
- ✅ `multiplyDecimal(a, b)` - умножение ([docs](./docs/decimal/multiply.md))
- ✅ `divideDecimal(a, b)` - деление ([docs](./docs/decimal/divide.md))
- ✅ `averageDecimal(a, b)` - среднее значение ([docs](./docs/decimal/average.md))
- ✅ `compareDecimal(a, b)` и другие операции сравнения
- ✅ `roundDecimal(value)`, `floorDecimal`, `ceilDecimal`, `truncDecimal` - округление

### Rounding Operations (`@polymarket/math/rounding`)

Операции округления:
- `roundToTickSize(value, tickSize)` - округление к tick size
- `roundToDecimalPlaces(value, places)` - округление к количеству знаков
- `floorToTickSize(value, tickSize)` - округление вниз к tick size
- `ceilToTickSize(value, tickSize)` - округление вверх к tick size

### Validation (`@polymarket/math/validation`)

Валидация чисел:
- `isFiniteDecimal(value)` - проверка что число конечное
- `isPositiveDecimal(value)` - проверка что число положительное
- `isNonNegativeDecimal(value)` - проверка что число неотрицательное

## Быстрый старт

```typescript
import Decimal from 'decimal.js';
import { divideDecimal, roundToTickSize } from '@polymarket/math';

// Деление с проверкой делителя
const result = divideDecimal(
  new Decimal('100'),
  new Decimal('3')
);
console.log(result.toString()); // "33.333333333333333333"

// Округление к tick size
const rounded = roundToTickSize(
  new Decimal('10.567'),
  new Decimal('0.01')
);
console.log(rounded.toString()); // "10.57"
```

## Обработка ошибок

Все функции **выбрасывают ошибки** из `@polymarket/errors` при математических невозможностях:

```typescript
import { divideDecimal } from '@polymarket/math';
import { InvalidDivisorError, DivisionByZeroError } from '@polymarket/errors';

try {
  const result = divideDecimal(
    new Decimal('100'),
    new Decimal('NaN')
  );
} catch (error) {
  if (InvalidDivisorError.is(error)) {
    console.error('Invalid divisor:', error.context);
  }
}
```

**Типы ошибок:**
- `InvalidDivisorError` - делитель не является конечным числом (NaN, Infinity)
- `DivisionByZeroError` - деление на ноль
- `InvalidTickSizeError` - tick size не является положительным конечным числом
- `ArithmeticOverflowError` - результат операции вышел за пределы

## Разработка

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
npm run lint:fix

# Проверка типов
npm run typecheck
```

## Архитектура

```text
@polymarket/math/
├── src/
│   ├── decimal/          # Базовые операции
│   ├── rounding/         # Округление
│   ├── validation/       # Валидация
│   └── index.ts
├── __tests__/
│   ├── unit/
│   │   ├── decimal/
│   │   ├── rounding/
│   │   └── validation/
│   ├── integration/
│   └── helpers/
└── docs/
```

## Философия дизайна

### Core Layer - Чистые функции

Все функции в `@polymarket/math` - это **чистые функции**:
- Нет побочных эффектов
- Один и тот же вход всегда даёт один и тот же выход
- Не зависят от внешнего состояния
- Легко тестируются и композируются

### Throw vs Result

В этом пакете используется **throw** для ошибок, потому что:
- Математические невозможности (деление на NaN) - это **исключительные ситуации**
- Они не являются частью нормального flow программы
- Бизнес-логика обрабатывается на уровне Value Objects (там используется Result)

### Разделение ответственности

- **@polymarket/math** (Core) - чистые математические операции, throw на невозможности
- **@polymarket/value-objects** (Domain) - бизнес-валидация, Result для бизнес-правил
- **@polymarket/errors** (Foundation) - типы ошибок для всей системы

## Связанные пакеты

- [@polymarket/errors](../errors/) - Система обработки ошибок
- [@polymarket/result](../result/) - Result type для Railway-Oriented Programming
- [decimal.js](https://mikemcl.github.io/decimal.js/) - Библиотека для высокоточных вычислений

## Лицензия

MIT
