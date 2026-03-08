# InvalidSideError

Ошибка валидации стороны сделки в торговой системе Polymarket.

## Описание

Сторона сделки (Side) определяет направление ордера: покупка ('BUY') или продажа ('SELL'). Должна быть строго одним из этих двух значений в верхнем регистре.

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_SIDE` |
| **Severity** | `low` |
| **Класс** | `InvalidSideError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Value Objects |

## Когда использовать

- Создание value object `Side` из пользовательского ввода
- Валидация ордеров перед размещением
- Парсинг данных из API
- Валидация форм создания ордеров
- Проверка совместимости сторон при матчинге

## Импорт

```typescript
import { InvalidSideError } from '@polymarket/errors';

// Для примеров с Result<T,E>:
import { Result, Ok, Err } from '@polymarket/result';
```

---

## Примеры использования

### 1. Базовое использование

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidSideError } from '@polymarket/errors';

type Side = 'BUY' | 'SELL';

class SideService {
  static fromString(value: string): Result<Side, InvalidSideError> {
    if (value !== 'BUY' && value !== 'SELL') {
      return Err(
        new InvalidSideError(
          (ctx) => `Invalid side: "${ctx.value}". Expected BUY or SELL`,
          {
            context: { value, reason: 'INVALID_VALUE' }
          }
        )
      );
    }

    return Ok(value as Side);
  }

  static isValid(value: string): boolean {
    return value === 'BUY' || value === 'SELL';
  }
}

// Использование
const result = SideService.fromString('BUY');
// Ok('BUY')

const invalid = SideService.fromString('buy');
// Err(InvalidSideError) - неправильный регистр
```

### 2. Нормализация входных данных

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidSideError } from '@polymarket/errors';

class SideService {
  static fromStringNormalized(value: string): Result<Side, InvalidSideError> {
    const normalized = value.toUpperCase().trim();

    if (normalized !== 'BUY' && normalized !== 'SELL') {
      return Err(
        new InvalidSideError(
          (ctx) => `Invalid side: "${ctx.original}". Expected buy or sell`,
          {
            code: InvalidSideError.code,
            context: {
              original: value,
              normalized,
              reason: 'INVALID_VALUE'
            }
          }
        )
      );
    }

    return Ok(normalized as Side);
  }
}

// Использование
SideService.fromStringNormalized('buy');    // ✅ Ok('BUY')
SideService.fromStringNormalized('SELL');   // ✅ Ok('SELL')
SideService.fromStringNormalized(' Buy ');  // ✅ Ok('BUY')
SideService.fromStringNormalized('HOLD');   // ❌ Err(InvalidSideError)
```

### 3. Создание ордера с валидацией

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidSideError } from '@polymarket/errors';

interface Order {
  side: Side;
  quantity: number;
  price: number;
}

function createOrder(
  sideInput: string,
  quantity: number,
  price: number
): Result<Order, InvalidSideError> {
  const sideResult = SideService.fromString(sideInput);

  if (!sideResult.ok) {
    return sideResult;
  }

  return Ok({
    side: sideResult.value,
    quantity,
    price
  });
}

// Использование
const orderResult = createOrder('BUY', 100, 0.5);
// Ok({ side: 'BUY', quantity: 100, price: 0.5 })

const invalidResult = createOrder('SELL_LIMIT', 100, 0.5);
// Err(InvalidSideError)
```

### 4. Утилиты для работы с Side

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidSideError } from '@polymarket/errors';

class SideService {
  static opposite(side: Side): Side {
    return side === 'BUY' ? 'SELL' : 'BUY';
  }

  static canMatch(side1: Side, side2: Side): boolean {
    return side1 !== side2;
  }

  static equals(side1: Side, side2: Side): boolean {
    return side1 === side2;
  }
}

// Использование
const side = 'BUY' as Side;
SideService.opposite(side); // 'SELL'
SideService.canMatch('BUY', 'SELL'); // true
SideService.canMatch('BUY', 'BUY'); // false
```

### 5. Обработка в форме ордера

```typescript
import { InvalidSideError } from '@polymarket/errors';

function handleSideInput(input: string): void {
  const result = SideService.fromStringNormalized(input);

  if (result.ok) {
    setSide(result.value);
    clearError('side');

    // Обновляем UI на основе стороны
    if (result.value === 'BUY') {
      setButtonColor('green');
      setButtonText('Buy Shares');
    } else {
      setButtonColor('red');
      setButtonText('Sell Shares');
    }
  } else {
    if (InvalidSideError.is(result.error)) {
      showFieldError('side', 'Please select Buy or Sell');
    }
  }
}
```

---

## Edge Cases

### Допустимые значения

```typescript
// ✅ Только эти значения допустимы
SideService.fromString('BUY');  // ✅ Ok('BUY')
SideService.fromString('SELL'); // ✅ Ok('SELL')
```

### Недопустимые значения

```typescript
// ❌ Неправильный регистр
SideService.fromString('buy');   // ❌ Err(INVALID_VALUE)
SideService.fromString('sell');  // ❌ Err(INVALID_VALUE)
SideService.fromString('Buy');   // ❌ Err(INVALID_VALUE)
SideService.fromString('Sell');  // ❌ Err(INVALID_VALUE)

// ❌ Другие значения
SideService.fromString('HOLD');     // ❌ Err(INVALID_VALUE)
SideService.fromString('LONG');     // ❌ Err(INVALID_VALUE)
SideService.fromString('SHORT');    // ❌ Err(INVALID_VALUE)
SideService.fromString('BUYING');   // ❌ Err(INVALID_VALUE)
SideService.fromString('SELLING');  // ❌ Err(INVALID_VALUE)

// ❌ Пустая строка
SideService.fromString('');         // ❌ Err(INVALID_VALUE)

// ❌ С пробелами (без нормализации)
SideService.fromString(' BUY ');    // ❌ Err(INVALID_VALUE)
```

### С нормализацией

```typescript
// ✅ С нормализацией - допустимы разные регистры
SideService.fromStringNormalized('buy');    // ✅ Ok('BUY')
SideService.fromStringNormalized('SELL');   // ✅ Ok('SELL')
SideService.fromStringNormalized('Buy');    // ✅ Ok('BUY')
SideService.fromStringNormalized(' buy ');  // ✅ Ok('BUY')
```

---

## Обработка ошибок

### По типу ошибки

```typescript
import { InvalidSideError } from '@polymarket/errors';

const result = SideService.fromString(userInput);

if (result.ok) {
  processOrder(result.value);
} else {
  if (InvalidSideError.is(result.error)) {
    const value = result.error.context?.value as string;
    showUserMessage(`Invalid side: "${value}". Please select Buy or Sell`);
  }
}
```

### По коду ошибки

```typescript
import { InvalidSideError } from '@polymarket/errors';

const result = SideService.fromString(input);

if (result.ok) {
  submitOrder(result.value);
} else {
  if (result.error.code === InvalidSideError.code) {
    showError('Invalid order side', result.error.context);
  } else {
    showError('Unexpected error', result.error);
  }
}
```

### С логированием

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidSideError } from '@polymarket/errors';

function validateAndLogSide(
  value: string,
  orderId: string
): Result<Side, InvalidSideError> {
  const result = SideService.fromString(value);

  if (result.ok) {
    logger.info('Side validated', {
      orderId,
      side: result.value
    });
  } else {
    logger.error('Side validation failed', {
      orderId,
      error: result.error.toJSON(),
      input: value
    });
  }

  return result;
}
```

---

## Типобезопасность

### Type Guard

```typescript
function isSide(value: string): value is Side {
  return value === 'BUY' || value === 'SELL';
}

// Использование
const input: string = 'BUY';

if (isSide(input)) {
  // TypeScript знает что input это Side
  const side: Side = input;
}
```

### Exhaustiveness check

```typescript
function processSide(side: Side): string {
  switch (side) {
    case 'BUY':
      return 'Buying shares';
    case 'SELL':
      return 'Selling shares';
    default:
      // TypeScript гарантирует что мы обработали все случаи
      const _exhaustive: never = side;
      return _exhaustive;
  }
}
```

---

## Связанные ошибки

- [InvalidAmountError](./invalid-amount.md) - универсальная валидация

## См. также

- [Value Objects Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
