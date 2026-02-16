# Архитектура TokenBalance

TokenBalance реализован по паттерну **Throws+Facade** с 4 слоями.

## Слои

### 1. Core Layer (`src/token-balance/core/`)

**Назначение:** Иммутабельный value object с инвариантами.

**Файлы:**

- `TokenBalance.ts` — основной класс
- `TokenBalanceInvariantViolation.ts` — исключение при нарушении инвариантов

**Характеристики:**

- ✅ Throws исключения при нарушении инвариантов
- ✅ Иммутабельность через `readonly` поля
- ✅ Query методы (total, isZero, hasReserved, reservedPercentage, hasSameToken)
- ✅ Helper (withZeroReserved)

**Инварианты:**

```typescript
// TokenBalance.ts
private constructor(
  private readonly _token: OutcomeToken,
  private readonly _available: Quantity,
  private readonly _reserved: Quantity,
  private readonly _accountId: AccountId,
  private readonly _venueId: VenueId
) {
  // Инвариант 0a: Not NaN (defense-in-depth, Quantity уже проверяет)
  if (_available.value().isNaN() || _reserved.value().isNaN()) {
    throw new TokenBalanceInvariantViolation(
      'TokenBalance amounts cannot be NaN',
      TokenBalanceErrorReason.NAN
    );
  }

  // Инвариант 0b: Must be finite (defense-in-depth, Quantity уже проверяет)
  if (!_available.value().isFinite() || !_reserved.value().isFinite()) {
    throw new TokenBalanceInvariantViolation(
      'TokenBalance amounts must be finite',
      TokenBalanceErrorReason.NON_FINITE
    );
  }

  // Инвариант 1: available >= 0
  if (_available.value().isNegative()) {
    throw new TokenBalanceInvariantViolation(
      'Available amount cannot be negative',
      TokenBalanceErrorReason.NEGATIVE_AVAILABLE
    );
  }

  // Инвариант 2: reserved >= 0
  if (_reserved.value().isNegative()) {
    throw new TokenBalanceInvariantViolation(
      'Reserved amount cannot be negative',
      TokenBalanceErrorReason.NEGATIVE_RESERVED
    );
  }

  // Инвариант 3: token, accountId, venueId валидны
  // Проверяется в of() через null checks и instanceof
}
```

### 2. Rules Layer (`src/token-balance/rules/`)

**Назначение:** Бизнес-правила валидации операций.

**Файлы:**

- `ValidateReserveAmount.ts` — проверка резервирования
- `ValidateReleaseAmount.ts` — проверка освобождения
- `ValidateTokenMatch.ts` — проверка токенов

**Характеристики:**

- ✅ Возвращают `Result<void, InvalidTokenBalanceError>`
- ✅ Используют типизированные `TokenBalanceErrorReason`
- ✅ Содержат бизнес-логику проверок

**Пример:**

```typescript
// ValidateReserveAmount.ts
export class ValidateReserveAmount {
  public static check(
    reserveQty: Quantity,
    available: Quantity
  ): Result<void, InvalidTokenBalanceError> {
    const op = 'ValidateReserveAmount.check';
    const ctx: Record<string, unknown> = {
      reserveQty: reserveQty.value().toString(),
      available: available.value().toString()
    };

    // Проверка 1: finite
    if (!reserveQty.value().isFinite()) {
      return Err(new InvalidTokenBalanceError(
        'Reserve quantity must be finite',
        {
          context: {
            op,
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            requested: reserveQty.value().toString()
          },
          source: ErrorSource.RULE_VALIDATION
        }
      ));
    }

    // Проверка 2: положительное количество
    if (reserveQty.value().lte(0)) {
      return Err(new InvalidTokenBalanceError(
        'Reserve quantity must be positive',
        {
          context: {
            op,
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            requested: reserveQty.value().toString()
          },
          source: ErrorSource.RULE_VALIDATION
        }
      ));
    }

    // Проверка 3: достаточно токенов
    if (reserveQty.value().greaterThan(available.value())) {
      return Err(new InvalidTokenBalanceError(
        'Insufficient available quantity',
        {
          context: {
            op,
            reason: TokenBalanceErrorReason.INSUFFICIENT_AVAILABLE,
            requested: reserveQty.value().toString(),
            available: available.value().toString()
          },
          source: ErrorSource.RULE_VALIDATION
        }
      ));
    }

    return Ok(undefined);
  }
}
```

### 3. Facade Layer (`src/token-balance/facade/`)

**Назначение:** Публичный API с контрактом **Never Throw**.

**Файлы:**

- `TokenBalanceService.ts` — единая точка входа

**Характеристики:**

- ✅ Все методы возвращают `Result<TokenBalance, InvalidTokenBalanceError>`
- ✅ Ловит `TokenBalanceInvariantViolation` → мапит в `InvalidTokenBalanceError`
- ✅ Оркестрирует Rules + Core
- ✅ Использует QuantityService для арифметики

**Операции:**

```typescript
export class TokenBalanceService {
  // Создание
  public static create(
    token: OutcomeToken,
    available: Quantity,
    reserved: Quantity,
    accountId: AccountId,
    venueId: VenueId
  ): Result<TokenBalance, InvalidTokenBalanceError>

  // Создание с нулевым reserved
  public static createWithZeroReserved(
    token: OutcomeToken,
    available: Quantity,
    accountId: AccountId,
    venueId: VenueId
  ): Result<TokenBalance, InvalidTokenBalanceError>

  // Резервирование: available - qty, reserved + qty
  public static reserve(
    balance: TokenBalance,
    qty: Quantity
  ): Result<TokenBalance, InvalidTokenBalanceError>

  // Размораживание: available + qty, reserved - qty (total без изменений)
  public static unfreezeReserved(
    balance: TokenBalance,
    qty: Quantity
  ): Result<TokenBalance, InvalidTokenBalanceError>

  // Списание: available без изменений, reserved - qty (total уменьшается)
  public static consumeReserved(
    balance: TokenBalance,
    qty: Quantity
  ): Result<TokenBalance, InvalidTokenBalanceError>

  // Обновление доступных токенов
  public static updateAvailable(
    balance: TokenBalance,
    newAvailable: Quantity
  ): Result<TokenBalance, InvalidTokenBalanceError>

  // Проверка возможности резервирования
  public static canReserve(
    balance: TokenBalance,
    qty: Quantity
  ): boolean

  // Сравнение балансов (strict equality)
  public static equals(
    balance1: TokenBalance,
    balance2: TokenBalance
  ): boolean

  // Проверка на нулевой баланс
  public static isZero(balance: TokenBalance): boolean

  // Проверка на положительный баланс
  public static isPositive(balance: TokenBalance): boolean
}
```

**Алгоритм обработки ошибок:**

```typescript
public static create(
  token: OutcomeToken,
  available: Quantity,
  reserved: Quantity,
  accountId: AccountId,
  venueId: VenueId
): Result<TokenBalance, InvalidTokenBalanceError> {
  const op = 'create';
  const ctx: Record<string, unknown> = {
    available: available.value().toString(),
    reserved: reserved.value().toString(),
    accountId,
    venueId
  };

  return wrapOp(SERVICE_NAME, op, ctx, () => {
    // Может throw TokenBalanceInvariantViolation
    const balance = TokenBalance.of(token, available, reserved, accountId, venueId);
    return Ok(balance);
  }, InvalidTokenBalanceError);
}
```

### 4. Adapters Layer (`src/token-balance/adapters/`)

**Назначение:** Преобразование данных.

**Файлы:**

- `TokenBalanceSerializer.ts` — JSON ↔ TokenBalance
- `TokenBalanceFormatter.ts` — TokenBalance → строки для UI

**TokenBalanceSerializer:**

```typescript
export class TokenBalanceSerializer {
  // JSON → TokenBalance
  public static fromJSON(json: unknown): Result<TokenBalance, InvalidTokenBalanceError>

  // TokenBalance → JSON
  public static toJSON(balance: TokenBalance): TokenBalanceJSON
}

// Формат JSON
type TokenBalanceJSON = {
  token: OutcomeTokenJSON;
  available: string;  // Decimal as string для precision
  reserved: string;   // Decimal as string для precision
  accountId: string;
  venueId: VenueId;
};
```

**TokenBalanceFormatter:**

```typescript
export class TokenBalanceFormatter {
  // "Available: X, Reserved: Y, Total: Z (P% reserved) [OUTCOME]"
  public static toSummary(
    balance: TokenBalance,
    decimals?: number
  ): string

  // "Avail: X | Res: Y | Total: Z [OUTCOME]"
  public static toCompact(balance: TokenBalance, decimals?: number): string

  // "TokenBalance(available: X, reserved: Y, total: Z, token: OUTCOME, account: ..., venue: ...)"
  public static toDebugString(balance: TokenBalance): string

  // Вспомогательные методы
  public static toAvailableString(balance: TokenBalance, decimals?: number): string
  public static toReservedString(balance: TokenBalance, decimals?: number): string
  public static toTotalString(balance: TokenBalance, decimals?: number): string
  public static toPercentageString(balance: TokenBalance, decimals?: number): string
}
```

## Типизированные ошибки

```typescript
// src/token-balance/errors/TokenBalanceErrorReason.ts
export enum TokenBalanceErrorReason {
  INVALID_TOKEN = 'INVALID_TOKEN',                   // невалидный OutcomeToken
  INVALID_AMOUNT = 'INVALID_AMOUNT',                 // невалидное количество
  INVALID_INPUT = 'INVALID_INPUT',                   // невалидный входной параметр
  INVALID_FORMAT = 'INVALID_FORMAT',                 // ошибка парсинга
  INVALID_OPERATION = 'INVALID_OPERATION',           // невалидная операция

  NEGATIVE_AVAILABLE = 'NEGATIVE_AVAILABLE',         // available < 0
  NEGATIVE_RESERVED = 'NEGATIVE_RESERVED',           // reserved < 0
  INSUFFICIENT_AVAILABLE = 'INSUFFICIENT_AVAILABLE', // qty > available
  INSUFFICIENT_RESERVED = 'INSUFFICIENT_RESERVED',   // qty > reserved
  TOKEN_MISMATCH = 'TOKEN_MISMATCH',                 // токены не совпадают
  ACCOUNT_MISMATCH = 'ACCOUNT_MISMATCH',             // аккаунты не совпадают
  VENUE_MISMATCH = 'VENUE_MISMATCH',                 // venues не совпадают
  NAN = 'NAN',                                       // количество NaN
  NON_FINITE = 'NON_FINITE'                          // количество Infinity
}
```

## Композиция с Quantity и OutcomeToken

TokenBalance построен на базе Quantity и OutcomeToken и делегирует QuantityService для арифметических операций в TokenBalanceService:

**total() - прямой расчёт через Decimal (Core Layer):**

```typescript
// TokenBalance.total() - безопасно благодаря инвариантам
public total(): Quantity {
  // Прямое вычисление через Decimal (не нужен QuantityService)
  const totalDecimal = this._available.value().plus(this._reserved.value());

  // Безопасно потому что:
  // - Оба значения >= 0 (инварианты TokenBalance)
  // - Оба значения finite и not NaN (инварианты TokenBalance)
  return Quantity.of(totalDecimal);
}
```

**Арифметика в TokenBalanceService (Facade Layer):**

```typescript
// Внутри TokenBalanceService - делегируем QuantityService
private static addQuantity(a: Quantity, b: Quantity): Result<Quantity, InvalidTokenBalanceError> {
  const result = QuantityService.add(a, b);
  if (isErr(result)) {
    return Err(new InvalidTokenBalanceError(result.error.message, {
      context: {
        ...result.error.context,
        reason: TokenBalanceErrorReason.INVALID_AMOUNT
      }
    }));
  }
  return Ok(result.value);
}
```

## Диаграмма потока данных

```text
User Code
   │
   │ TokenBalanceService.reserve(balance, qty)
   ▼
┌──────────────────────────────────────────┐
│ TokenBalanceService (Facade)             │
│ 1. ValidateReserveAmount.check()         │
│ 2. QuantityService.subtract(avail, qty)  │
│ 3. QuantityService.add(reserved, qty)    │
│ 4. TokenBalance.of(token, newAv, newRes) │
│ 5. Catch → Result                        │
└──────────────────────────────────────────┘
   │
   ▼
Result<TokenBalance, InvalidTokenBalanceError>
```

## Преимущества архитектуры

1. ✅ **Разделение ответственности** — каждый слой решает свою задачу
2. ✅ **Тестируемость** — слои тестируются независимо
3. ✅ **Расширяемость** — легко добавить новые Rules или Adapters
4. ✅ **Type Safety** — полная типизация ошибок через enum
5. ✅ **Never Throw** — Facade гарантирует отсутствие исключений
6. ✅ **Иммутабельность** — Core защищает инварианты
7. ✅ **Token Identity** — баланс привязан к конкретному токену исхода
