# Миграция на новый Price Value Object

> Руководство по миграции со старого Price на новый архитектурный подход

## Обзор

Новый Price модуль построен на архитектуре **Throws+Facade** с чётким разделением на 4 слоя. Это руководство поможет мигрировать существующий код безопасно и постепенно.

**Ключевые изменения:**
- Все операции теперь возвращают `Result<T, E>` вместо бросания исключений
- Единая точка входа через `PriceService`
- Polymarket-aligned правила (базовый тик 0.0001, кратность tick sizes)
- Специализированные ошибки (`InvalidPriceError`, `InvalidOperandError`, `InvalidDivisorError`, `InvalidTickSizeError`)

---

## Содержание

1. [Backward Compatibility](#backward-compatibility)
2. [Основные изменения](#основные-изменения)
3. [Пошаговая миграция](#пошаговая-миграция)
4. [Примеры миграции](#примеры-миграции)
5. [Типичные проблемы](#типичные-проблемы)
6. [Чеклист миграции](#чеклист-миграции)

---

## Backward Compatibility

### Что продолжает работать

Старый `Price.ts` остаётся в кодовой базе для backward compatibility:

```typescript
// Старый код продолжит работать
import { Price } from '@polymarket/value-objects';

const price = new Price(0.5);  // Работает
```

### Что НЕ работает автоматически

Новый `PriceService` — это отдельный модуль:

```typescript
// Новый код требует явного импорта
import { PriceService } from '@polymarket/value-objects/price';

const result = PriceService.create(0.5);  // Новый API
```

**Рекомендация:** Постепенно мигрируйте код на новый API, старый останется для совместимости.

---

## Основные изменения

### 1. Создание Price

#### Важно: Price.of() vs PriceService.create()

Новый API предоставляет два способа создания Price:

- **`Price.of(value)`** — для **известных валидных литералов и констант**
  - Бросает исключение при невалидном значении
  - Используй **только** для:
    - Литералов в коде: `0.5`, `0.25`
    - Константных методов: `Price.min()`, `Price.max()`, `Price.half()`
    - Гарантированно валидных значений на этапе компиляции
  - Пример: `const half = Price.of(0.5);` ✅ безопасно (литерал)

- **`PriceService.create(value)`** — для **runtime/user-supplied значений**
  - Возвращает `Result<Price, InvalidPriceError>` (никогда не бросает)
  - Используй **всегда** для:
    - Данных из API/базы данных
    - Пользовательского ввода
    - Результатов вычислений
    - Любых значений, которые могут быть невалидными
  - Пример: `const result = PriceService.create(userInput);` ✅ безопасно (runtime)

**Правило:** Литералы/константы → `Price.of()` | Runtime/user-supplied → `PriceService.create()`

---

#### Было (старый способ)

```typescript
import { Price } from '@polymarket/value-objects';

try {
  const price = new Price(0.5);
} catch (error) {
  console.error('Invalid price:', error);
}
```

**Проблемы:**
- Может бросить исключение
- Легко забыть обработать ошибку
- Нет type-safety на compile time

#### Стало (новый способ)

```typescript
import { PriceService } from '@polymarket/value-objects/price';

const result = PriceService.create(0.5);

if (!result.ok) {
  console.error('Invalid price:', result.error.message);
  return;
}

const price = result.value;
```

**Преимущества:**
- Не бросает исключения (всегда возвращает Result)
- Заставляет проверить `result.ok` через компилятор
- Обеспечивает type-safety на compile time

---

### 2. Арифметические операции

#### Было

```typescript
// Старый Price ИМЕЛ базовые методы (add, subtract, multiply),
// но они БРОСАЛИ исключения вместо возврата Result<T, E>:

const price1 = new Price(0.5);
const price2 = new Price(0.3);

try {
  const sum = price1.add(price2);  // Может бросить!
} catch (error) {
  console.error('Addition failed:', error);
}

// Или приходилось работать напрямую с Decimal:
const sum = price1.value.plus(price2.value);  // Decimal
const sumPrice = new Price(sum.toNumber());   // Тоже может бросить!
```

**Проблемы:**
- Методы бросают исключения вместо Result contract
- Нет domain-level операций (complement, average, roundToMarketTick)
- Легко забыть обработать ошибку в try/catch

#### Стало

```typescript
import { PriceService, Price } from '@polymarket/value-objects/price';

// Price.of() безопасен для известных валидных литералов
const price1 = Price.of(0.5);  // ✅ литерал, гарантированно валиден
const price2 = Price.of(0.3);  // ✅ литерал, гарантированно валиден

// Вместо прямого сложения используй average для получения средней цены
const result = PriceService.average(price1, price2);

if (!result.ok) {
  console.error('Average calculation failed:', result.error);
  return;
}

const avgPrice = result.value;  // 0.4
```

**Доступные операции:**
- `multiply()` — умножение на коэффициент
- `divide()` — деление на делитель
- `complement()` — дополнение (1 - price)
- `average()` — среднее двух цен

---

### 3. Округление к тику

#### Было

```typescript
// Старый Price НЕ ИМЕЛ методов округления
// Приходилось делать вручную:

import Decimal from 'decimal.js';

const price = new Price(0.6543);
const tickSize = 0.01;

const rounded = price.value
  .div(tickSize)
  .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
  .mul(tickSize);

const roundedPrice = new Price(rounded.toNumber());  // Может бросить!
```

#### Стало

```typescript
import { PriceService, Price } from '@polymarket/value-objects/price';

const price = Price.of(0.6543);  // ✅ литерал, безопасно
const tickSize = 0.01;

const result = PriceService.roundToMarketTick(price, tickSize, 'nearest');

if (!result.ok) {
  console.error('Rounding failed:', result.error);
  return;
}

const rounded = result.value;
```

**Новые режимы округления:**
- `'nearest'` — к ближайшему (по умолчанию)
- `'floor'` — вниз (для bid)
- `'ceil'` — вверх (для ask)

---

### 4. Валидация tick size

#### Было

```typescript
// Никакой валидации кратности базовому тику
// Можно было использовать любой tickSize:

const tickSize = 0.003;  // НЕ кратен 0.0001 - но старый код не проверял!
```

#### Стало

```typescript
import { PriceService } from '@polymarket/value-objects/price';

const price = Price.of(0.65);  // ✅ литерал, безопасно
const tickSize = 0.003;  // НЕ кратен 0.0001

const result = PriceService.roundToMarketTick(price, tickSize);

if (!result.ok) {
  console.error(result.error.context?.reason);  // 'not_multiple_of_base_tick'
}
```

**КРИТИЧНО:** Новый API требует чтобы tickSize был кратен базовому тику (0.0001).

---

## Пошаговая миграция

### Шаг 1: Установка зависимостей

Убедитесь что у вас установлены все необходимые пакеты:

```json
{
  "dependencies": {
    "@polymarket/value-objects": "^0.1.0",
    "@polymarket/result": "^0.1.0",
    "@polymarket/errors": "^0.1.0",
    "@polymarket/math": "^0.1.0",
    "decimal.js": "^10.4.3"
  }
}
```

---

### Шаг 2: Добавление новых импортов

Добавьте импорты нового API рядом со старыми:

```typescript
// Старые импорты (оставляем для backward compatibility)
import { Price as OldPrice } from '@polymarket/value-objects';

// Новые импорты
import {
  Price,
  PriceService,
  PriceSerializer,
  PriceFormatter
} from '@polymarket/value-objects/price';
```

---

### Шаг 3: Миграция создания Price

Замените прямое создание через `new Price()` на `PriceService.create()`:

#### Было

```typescript
function createPrice(value: number): OldPrice | null {
  try {
    return new OldPrice(value);
  } catch (error) {
    console.error('Invalid price:', error);
    return null;
  }
}
```

#### Стало

```typescript
import { PriceService, Price } from '@polymarket/value-objects/price';
import { Result } from '@polymarket/result';
import type { InvalidPriceError } from '@polymarket/errors';

function createPrice(value: number): Result<Price, InvalidPriceError> {
  return PriceService.create(value);
}

// Использование
const result = createPrice(0.65);

if (!result.ok) {
  console.error('Invalid price:', result.error.message);
  return;
}

const price = result.value;
```

---

### Шаг 4: Миграция вычислений

Замените ручные вычисления с Decimal на методы PriceService:

#### Было

```typescript
// Вычисление NO цены из YES цены
const yesPrice = new OldPrice(0.65);
const noValue = new Decimal(1).minus(yesPrice.value);
const noPrice = new OldPrice(noValue.toNumber());  // Может бросить!
```

#### Стало

```typescript
import { PriceService, Price } from '@polymarket/value-objects/price';

const yesPrice = Price.of(0.65);  // ✅ литерал, безопасно
const noResult = PriceService.complement(yesPrice);

if (!noResult.ok) {
  console.error('Failed to calculate NO price:', noResult.error);
  return;
}

const noPrice = noResult.value;
```

---

### Шаг 5: Миграция округления

Замените ручное округление на `roundToMarketTick()`:

#### Было

```typescript
import Decimal from 'decimal.js';

const price = new OldPrice(0.6543);
const tickSize = new Decimal(0.01);

const rounded = price.value
  .div(tickSize)
  .toDecimalPlaces(0, Decimal.ROUND_DOWN)  // Floor
  .mul(tickSize);

const roundedPrice = new OldPrice(rounded.toNumber());
```

#### Стало

```typescript
import { PriceService, Price } from '@polymarket/value-objects/price';

const price = Price.of(0.6543);  // ✅ литерал, безопасно
const result = PriceService.roundToMarketTick(price, 0.01, 'floor');

if (!result.ok) {
  console.error('Rounding failed:', result.error);
  return;
}

const roundedPrice = result.value;
```

---

### Шаг 6: Обновление сериализации

Замените ручную сериализацию на `PriceSerializer`:

#### Было

```typescript
// Сериализация
const price = new OldPrice(0.65);
const json = {
  value: price.value.toString()
};

// Десериализация
const parsed = new OldPrice(parseFloat(json.value));  // Может бросить!
```

#### Стало

```typescript
import { PriceSerializer, Price } from '@polymarket/value-objects/price';

// Сериализация
const price = Price.of(0.65);  // ✅ литерал, безопасно
const json = PriceSerializer.toJSON(price);  // { value: "0.65" }

// Десериализация
const result = PriceSerializer.fromJSON(json);

if (!result.ok) {
  console.error('Failed to parse price:', result.error);
  return;
}

const parsed = result.value;
```

---

## Примеры миграции

### Пример 1: Обработка пользовательского ввода

#### Было

```typescript
function handleUserInput(input: string): OldPrice | null {
  try {
    const value = parseFloat(input);
    return new OldPrice(value);
  } catch (error) {
    alert(`Invalid price: ${error.message}`);
    return null;
  }
}
```

#### Стало

```typescript
import { PriceService, Price } from '@polymarket/value-objects/price';

function handleUserInput(input: string): Price | null {
  const result = PriceService.create(input);

  if (!result.ok) {
    const ctx = result.error.context;

    if (ctx?.value) {
      const numValue = parseFloat(ctx.value);

      if (numValue < 0.0001) {
        alert(`Минимальная цена: 0.0001 (0.01%)`);
      } else if (numValue > 0.9999) {
        alert(`Максимальная цена: 0.9999 (99.99%)`);
      } else {
        alert(`Невалидная цена: ${result.error.message}`);
      }
    } else {
      alert(`Невалидный формат: ${result.error.message}`);
    }

    return null;
  }

  return result.value;
}
```

---

### Пример 2: Вычисление mid price

#### Было

```typescript
function calculateMidPrice(
  bidPrice: OldPrice,
  askPrice: OldPrice
): OldPrice | null {
  try {
    const midValue = bidPrice.value.plus(askPrice.value).div(2);
    return new OldPrice(midValue.toNumber());
  } catch (error) {
    console.error('Failed to calculate mid price:', error);
    return null;
  }
}
```

#### Стало

```typescript
import { PriceService, Price } from '@polymarket/value-objects/price';

function calculateMidPrice(
  bidPrice: Price,
  askPrice: Price
): Price | null {
  const result = PriceService.average(bidPrice, askPrice);

  if (!result.ok) {
    console.error('Failed to calculate mid price:', result.error);
    return null;
  }

  return result.value;
}
```

---

### Пример 3: Размещение ордера

#### Было

```typescript
interface Order {
  price: OldPrice;
  size: number;
  side: 'buy' | 'sell';
}

function placeOrder(
  rawPrice: number,
  size: number,
  side: 'buy' | 'sell',
  tickSize: number
): Order | null {
  try {
    // Создаём цену
    const price = new OldPrice(rawPrice);

    // Округляем к тику вручную
    const roundingMode = side === 'buy' ? Decimal.ROUND_DOWN : Decimal.ROUND_UP;

    const rounded = price.value
      .div(tickSize)
      .toDecimalPlaces(0, roundingMode)
      .mul(tickSize);

    const roundedPrice = new OldPrice(rounded.toNumber());

    return {
      price: roundedPrice,
      size,
      side
    };
  } catch (error) {
    console.error('Failed to place order:', error);
    return null;
  }
}
```

#### Стало

```typescript
import { PriceService, Price } from '@polymarket/value-objects/price';

interface Order {
  price: Price;
  size: number;
  side: 'buy' | 'sell';
}

function placeOrder(
  rawPrice: number,
  size: number,
  side: 'buy' | 'sell',
  tickSize: number
): Order | null {
  // Создаём цену
  const priceResult = PriceService.create(rawPrice);
  if (!priceResult.ok) {
    console.error('Invalid price:', priceResult.error);
    return null;
  }

  const price = priceResult.value;

  // Округляем к тику
  const mode = side === 'buy' ? 'floor' : 'ceil';
  const roundedResult = PriceService.roundToMarketTick(price, tickSize, mode);

  if (!roundedResult.ok) {
    console.error('Rounding failed:', roundedResult.error);
    return null;
  }

  const roundedPrice = roundedResult.value;

  return {
    price: roundedPrice,
    size,
    side
  };
}
```

---

## Типичные проблемы

### Проблема 1: tickSize не кратен базовому тику

#### Симптом

```typescript
const result = PriceService.roundToMarketTick(price, 0.003);
// result.ok === false
// result.error.context.reason === 'not_multiple_of_base_tick'
```

#### Решение

Используйте только tick sizes кратные 0.0001:

```typescript
// ✅ Валидные tick sizes
const validTicks = [0.0001, 0.0002, 0.001, 0.01, 0.1];

// ❌ Невалидные tick sizes
const invalidTicks = [0.00015, 0.003, 0.015];
```

---

### Проблема 2: Забыли проверить Result

#### Симптом

```typescript
const result = PriceService.create(value);
const price = result.value;  // TypeScript error!
// Property 'value' does not exist on type 'Err<InvalidPriceError>'
```

#### Решение

Всегда проверяйте `result.ok`:

```typescript
const result = PriceService.create(value);

if (!result.ok) {
  // Обработка ошибки
  return;
}

const price = result.value;  // ✅ Type-safe!
```

---

### Проблема 3: Прямое использование Price.of()

#### Симптом

```typescript
const price = Price.of(userInput);  // Может бросить исключение!
```

#### Решение

Используйте `PriceService.create()` для безопасного создания:

```typescript
const result = PriceService.create(userInput);

if (!result.ok) {
  // Обработка ошибки
  return;
}

const price = result.value;
```

**Примечание:** `Price.of()` предназначен **только для известных валидных литералов и констант** (например, `0.5`, `Price.min()`, константы в коде). Для любых runtime/user-supplied значений (API данные, пользовательский ввод, вычисления) **всегда используй `PriceService.create()`**, который возвращает `Result<Price, InvalidPriceError>` и никогда не бросает исключения.

---

### Проблема 4: Потеря точности через toNumber()

#### Симптом

```typescript
const price = Price.of(0.123456789012345);
const num = price.toNumber();  // Может потерять точность!
```

#### Решение

Используйте `value()` для вычислений и `PriceSerializer` для сериализации:

```typescript
// ✅ Для вычислений
const decimal = price.value();  // Decimal

// ✅ Для сериализации
const json = PriceSerializer.toJSON(price);  // { value: "0.123456789012345" }

// ❌ Для UI (только для отображения!)
const display = price.toNumber();  // 0.123456789012345
```

---

## Чеклист миграции

### Подготовка

- [ ] Установлены все зависимости (@polymarket/value-objects, @polymarket/result, @polymarket/errors, @polymarket/math)
- [ ] Добавлены новые импорты в код
- [ ] Настроен TypeScript для strict mode

### Миграция кода

- [ ] Заменено создание через `new Price()` на `PriceService.create()`
- [ ] Заменены ручные вычисления на методы PriceService
- [ ] Заменено ручное округление на `roundToMarketTick()`
- [ ] Обновлена сериализация на `PriceSerializer`
- [ ] Обновлено форматирование на `PriceFormatter`

### Валидация

- [ ] Все tick sizes кратны 0.0001
- [ ] Все операции возвращают `Result<T, E>`
- [ ] Все Results проверяются через `if (!result.ok)`
- [ ] Нет прямых вызовов `Price.of()` с runtime/user-supplied данных в production (использование для литералов/констант допускается)

### Тестирование

- [ ] Unit тесты обновлены под новый API
- [ ] Integration тесты проходят
- [ ] Проверена обработка ошибок
- [ ] Проверена производительность

### Документация

- [ ] Обновлены комментарии в коде
- [ ] Обновлена документация API
- [ ] Обновлены примеры использования

---

## Заключение

Миграция на новый Price модуль обеспечивает:

1. **Type-safe обработку ошибок** через Result<T, E>
2. **Явное управление ошибками** без try/catch
3. **Polymarket-aligned правила** (базовый тик, кратность)
4. **Semantic операции** (complement, average)
5. **Единый API** через PriceService

Следуйте этому руководству для плавной миграции существующего кода!
