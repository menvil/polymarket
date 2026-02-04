# Архитектура Balance

Balance реализован по паттерну **Throws+Facade** с 4 слоями.

## Слои

### 1. Core Layer (`src/balance/core/`)

**Назначение:** Иммутабельный value object с инвариантами.

**Файлы:**

- `Balance.ts` — основной класс
- `BalanceInvariantViolation.ts` — исключение при нарушении инвариантов

**Характеристики:**

- ✅ Throws исключения при нарушении инвариантов
- ✅ Иммутабельность через `readonly` поля
- ✅ Query методы (total, isZero, hasReserved, reservedPercentage, hasSameCurrency)
- ✅ Helpers (ZERO singleton, withZeroReserved)

**Инварианты:**

```typescript
// Balance.ts
private constructor(
  private readonly avail: Money,
  private readonly res: Money
) {
  // Инвариант 0a: Not NaN (defense-in-depth, Money уже проверяет)
  if (avail.value().isNaN() || res.value().isNaN()) {
    throw new BalanceInvariantViolation('Balance amounts cannot be NaN', {
      reason: BalanceErrorReason.NAN,
      available: avail.value().toString(),
      reserved: res.value().toString()
    });
  }

  // Инвариант 0b: Must be finite (defense-in-depth, Money уже проверяет)
  if (!avail.value().isFinite() || !res.value().isFinite()) {
    throw new BalanceInvariantViolation('Balance amounts must be finite', {
      reason: BalanceErrorReason.NON_FINITE,
      available: avail.value().toString(),
      reserved: res.value().toString()
    });
  }

  // Инвариант 1: available >= 0
  if (avail.value().isNegative()) {
    throw new BalanceInvariantViolation('Available amount cannot be negative', {
      reason: BalanceErrorReason.NEGATIVE_AVAILABLE,
      available: avail.value().toNumber()
    });
  }

  // Инвариант 2: reserved >= 0
  if (res.value().isNegative()) {
    throw new BalanceInvariantViolation('Reserved amount cannot be negative', {
      reason: BalanceErrorReason.NEGATIVE_RESERVED,
      reserved: res.value().toNumber()
    });
  }

  // Инвариант 3: same currency
  if (avail.currency() !== res.currency()) {
    throw new BalanceInvariantViolation('Available and reserved must have the same currency', {
      reason: BalanceErrorReason.CURRENCY_MISMATCH,
      availableCurrency: avail.currency(),
      reservedCurrency: res.currency()
    });
  }
}
```

### 2. Rules Layer (`src/balance/rules/`)

**Назначение:** Бизнес-правила валидации операций.

**Файлы:**

- `ValidateReserveAmount.ts` — проверка резервирования
- `ValidateReleaseAmount.ts` — проверка освобождения
- `ValidateCurrencyMatch.ts` — проверка валют

**Характеристики:**

- ✅ Возвращают `Result<void, InvalidBalanceError>`
- ✅ Используют типизированные `BalanceErrorReason`
- ✅ Содержат бизнес-логику проверок

**Пример:**

```typescript
// ValidateReserveAmount.ts
public static check(
  reserveAmount: Money,
  available: Money
): Result<void, InvalidBalanceError> {
  // Проверка 1: finite
  if (!reserveAmount.value().isFinite()) {
    return Err(new InvalidBalanceError('Reserve amount must be finite', {
      context: { reason: BalanceErrorReason.INVALID_FORMAT, ... }
    }));
  }

  // Проверка 2: положительная сумма
  if (reserveAmount.value().lte(0)) {
    return Err(new InvalidBalanceError('Reserve amount must be positive', {
      context: { reason: BalanceErrorReason.INVALID_FORMAT, ... }
    }));
  }

  // Проверка 3: достаточно средств
  if (reserveAmount.value().greaterThan(available.value())) {
    return Err(new InvalidBalanceError('Insufficient available funds', {
      context: { reason: BalanceErrorReason.INSUFFICIENT_FUNDS, ... }
    }));
  }

  return Ok(undefined);
}
```

### 3. Facade Layer (`src/balance/facade/`)

**Назначение:** Публичный API с контрактом **Never Throw**.

**Файлы:**

- `BalanceService.ts` — единая точка входа

**Характеристики:**

- ✅ Все методы возвращают `Result<Balance, InvalidBalanceError>`
- ✅ Ловит `BalanceInvariantViolation` → мапит в `InvalidBalanceError`
- ✅ Оркестрирует Rules + Core
- ✅ Использует MoneyService для арифметики

**Операции:**

```typescript
export class BalanceService {
  // Создание
  public static create(
    available: Money,
    reserved: Money
  ): Result<Balance, InvalidBalanceError>

  // Резервирование: available - amount, reserved + amount
  public static reserve(
    balance: Balance,
    amount: Money
  ): Result<Balance, InvalidBalanceError>

  // Размораживание: available + amount, reserved - amount (total без изменений)
  public static unfreezeReserved(
    balance: Balance,
    amount: Money
  ): Result<Balance, InvalidBalanceError>

  // Списание: available без изменений, reserved - amount (total уменьшается)
  public static consumeReserved(
    balance: Balance,
    amount: Money
  ): Result<Balance, InvalidBalanceError>

  // Обновление доступных средств
  public static updateAvailable(
    balance: Balance,
    newAvailable: Money
  ): Result<Balance, InvalidBalanceError>

  // Сравнение балансов (strict equality)
  public static equals(
    balance1: Balance,
    balance2: Balance
  ): Result<boolean, InvalidBalanceError>

  // Проверка достаточности средств
  public static canAfford(
    balance: Balance,
    amount: Money
  ): Result<boolean, InvalidBalanceError>
}
```

**Алгоритм обработки ошибок:**

```typescript
public static create(available: Money, reserved: Money): Result<Balance, InvalidBalanceError> {
  try {
    const balance = Balance.of(available, reserved); // может throw
    return Ok(balance);
  } catch (error) {
    if (error instanceof BalanceInvariantViolation) {
      // Мапим Core исключение → InvalidBalanceError
      return Err(new InvalidBalanceError(error.message, {
        context: {
          op: 'create',
          reason: error.reason as BalanceErrorReason,
          available: available.value().toNumber(),
          reserved: reserved.value().toNumber(),
          currency: available.currency()
        }
      }));
    }
    // Неожиданная ошибка
    return Err(unexpectedError('create', {...}, error, 'balance', InvalidBalanceError));
  }
}
```

### 4. Adapters Layer (`src/balance/adapters/`)

**Назначение:** Преобразование данных.

**Файлы:**

- `BalanceSerializer.ts` — JSON ↔ Balance
- `BalanceFormatter.ts` — Balance → строки для UI

**BalanceSerializer:**

```typescript
export class BalanceSerializer {
  // JSON → Balance
  public static fromJSON(json: unknown): Result<Balance, InvalidBalanceError>

  // Balance → JSON
  public static toJSON(balance: Balance): BalanceJSON
}

// Формат JSON
type BalanceJSON = {
  available: { amount: string; currency: string };
  reserved: { amount: string; currency: string };
};
```

**BalanceFormatter:**

```typescript
export class BalanceFormatter {
  // "Available: $X, Reserved: $Y, Total: $Z (P% reserved)"
  public static toSummary(balance: Balance, decimals?: number): string

  // "Avail: $X | Res: $Y | Total: $Z" (с K/M/B)
  public static toCompact(balance: Balance, decimals?: number): string

  // "Balance(available: X USDC, reserved: Y USDC, total: Z USDC)"
  public static toDebugString(balance: Balance): string

  // Вспомогательные методы
  public static toAvailableString(balance, showCurrency?, decimals?): string
  public static toReservedString(balance, showCurrency?, decimals?): string
  public static toTotalString(balance, showCurrency?, decimals?): string
  public static toPercentageString(balance, decimals?): string
}
```

## Типизированные ошибки

```typescript
// src/balance/errors/BalanceErrorReason.ts
export enum BalanceErrorReason {
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',       // недостаточно available
  INSUFFICIENT_RESERVED = 'INSUFFICIENT_RESERVED', // недостаточно reserved
  CURRENCY_MISMATCH = 'CURRENCY_MISMATCH',         // несовпадение валют
  NEGATIVE_AVAILABLE = 'NEGATIVE_AVAILABLE',       // available < 0
  NEGATIVE_RESERVED = 'NEGATIVE_RESERVED',         // reserved < 0
  NAN = 'NAN',                                     // amount является NaN
  NON_FINITE = 'NON_FINITE',                       // amount не является finite
  INVALID_FORMAT = 'INVALID_FORMAT',               // ошибка парсинга
  UNSUPPORTED_CURRENCY = 'UNSUPPORTED_CURRENCY'    // неподдерживаемая валюта
}
```

## Композиция с Money

Balance построен на базе Money и делегирует MoneyService для арифметических операций в BalanceService:

**total() - прямой расчёт через Decimal (Core Layer):**

```typescript
// Balance.total() - безопасно благодаря инвариантам
public total(): Money {
  // Прямое вычисление через Decimal (не нужен MoneyService)
  const totalAmount = this.avail.value().plus(this.res.value());

  // Безопасно потому что:
  // - Валюты гарантированно совпадают (инвариант Balance)
  // - Оба значения >= 0 (инварианты Balance)
  // - Оба значения finite и not NaN (инварианты Balance)
  return Money.fromDecimal(totalAmount, this.avail.currency());
}
```

**Арифметика в BalanceService (Facade Layer):**

```typescript
// Внутри BalanceService - делегируем MoneyService
private static addMoney(a: Money, b: Money): Result<Money, InvalidBalanceError> {
  const result = MoneyService.add(a, b);
  if (isErr(result)) {
    return Err(new InvalidBalanceError(result.error.message, {
      context: {
        ...result.error.context,
        reason: BalanceErrorReason.INVALID_FORMAT
      }
    }));
  }
  return Ok(result.value);
}
```

## Диаграмма потока данных

```
User Code
   │
   │ BalanceService.reserve(balance, amount)
   ▼
┌──────────────────────────────────────────┐
│ BalanceService (Facade)                  │
│ 1. ValidateCurrencyMatch.check()         │
│ 2. ValidateReserveAmount.check()         │
│ 3. MoneyService.subtract(available, amt) │
│ 4. MoneyService.add(reserved, amt)       │
│ 5. Balance.of(newAvail, newRes)          │
│ 6. Catch → Result                        │
└──────────────────────────────────────────┘
   │
   ▼
Result<Balance, InvalidBalanceError>
```

## Преимущества архитектуры

1. ✅ **Разделение ответственности** — каждый слой решает свою задачу
2. ✅ **Тестируемость** — слои тестируются независимо
3. ✅ **Расширяемость** — легко добавить новые Rules или Adapters
4. ✅ **Type Safety** — полная типизация ошибок через enum
5. ✅ **Never Throw** — Facade гарантирует отсутствие исключений
6. ✅ **Иммутабельность** — Core защищает инварианты
