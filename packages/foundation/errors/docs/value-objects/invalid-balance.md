# InvalidBalanceError

Ошибка валидации баланса (Balance value object).

## Описание

Balance представляет собой баланс аккаунта с двумя компонентами:

- **available** - доступные средства для использования
- **reserved** - зарезервированные средства (в открытых ордерах, залогах)

Также включает:

- **AccountId** - идентификатор аккаунта
- **VenueId** (опционально) - идентификатор торговой площадки

Валидация проверяет корректность всех компонентов и бизнес-правила.

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_BALANCE` |
| **Severity** | `low` |
| **Класс** | `InvalidBalanceError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Value Objects |

## Когда использовать

- Создание value object `Balance` из данных API
- Валидация available/reserved перед операциями (withdraw, place order)
- Проверка корректности баланса при обновлении из WebSocket
- Валидация AccountId и VenueId при создании баланса

## Импорт

```typescript
import { InvalidBalanceError } from '@polymarket/errors';

// Для примеров с Result<T,E>:
import { Result, Ok, Err } from '@polymarket/result';
```

---

## Примеры использования

### 1. Базовое использование (throw)

```typescript
import { InvalidBalanceError } from '@polymarket/errors';
import Decimal from 'decimal.js';

class Balance {
  constructor(
    private readonly accountId: AccountId,
    private readonly available: Decimal,
    private readonly reserved: Decimal,
    private readonly venueId?: VenueId
  ) {
    if (available.isNegative()) {
      throw new InvalidBalanceError(
        (ctx) => `Available balance cannot be negative: ${ctx.available}`,
        {
          code: InvalidBalanceError.code,
          context: {
            accountId: accountId.toString(),
            available: available.toString(),
            reserved: reserved.toString(),
            reason: 'negative-available'
          }
        }
      );
    }

    if (reserved.isNegative()) {
      throw new InvalidBalanceError(
        (ctx) => `Reserved balance cannot be negative: ${ctx.reserved}`,
        {
          code: InvalidBalanceError.code,
          context: {
            accountId: accountId.toString(),
            available: available.toString(),
            reserved: reserved.toString(),
            reason: 'negative-reserved'
          }
        }
      );
    }
  }
}

// Использование
try {
  const balance = new Balance(
    accountId,
    new Decimal('100'),
    new Decimal('-10') // ❌ Ошибка!
  );
} catch (error) {
  if (InvalidBalanceError.is(error)) {
    console.error('Invalid balance:', error.context);
  }
}
```

### 2. С Result<T,E> (рекомендуется)

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidBalanceError } from '@polymarket/errors';
import Decimal from 'decimal.js';

class Balance {
  private constructor(
    private readonly accountId: AccountId,
    private readonly available: Decimal,
    private readonly reserved: Decimal,
    private readonly venueId?: VenueId
  ) {}

  static create(
    accountId: AccountId,
    available: Decimal,
    reserved: Decimal,
    venueId?: VenueId
  ): Result<Balance, InvalidBalanceError> {
    // Проверка available
    if (!available.isFinite()) {
      return Err(
        new InvalidBalanceError(
          (ctx) => `Available must be finite, got ${ctx.available}`,
          {
            code: InvalidBalanceError.code,
            context: {
              accountId: accountId.toString(),
              available: available.toString(),
              reserved: reserved.toString(),
              reason: 'non-finite-available'
            }
          }
        )
      );
    }

    if (available.isNegative()) {
      return Err(
        new InvalidBalanceError(
          (ctx) => `Available cannot be negative: ${ctx.available}`,
          {
            code: InvalidBalanceError.code,
            context: {
              accountId: accountId.toString(),
              available: available.toString(),
              reserved: reserved.toString(),
              reason: 'negative-available'
            }
          }
        )
      );
    }

    // Проверка reserved
    if (!reserved.isFinite()) {
      return Err(
        new InvalidBalanceError(
          (ctx) => `Reserved must be finite, got ${ctx.reserved}`,
          {
            code: InvalidBalanceError.code,
            context: {
              accountId: accountId.toString(),
              available: available.toString(),
              reserved: reserved.toString(),
              reason: 'non-finite-reserved'
            }
          }
        )
      );
    }

    if (reserved.isNegative()) {
      return Err(
        new InvalidBalanceError(
          (ctx) => `Reserved cannot be negative: ${ctx.reserved}`,
          {
            code: InvalidBalanceError.code,
            context: {
              accountId: accountId.toString(),
              available: available.toString(),
              reserved: reserved.toString(),
              reason: 'negative-reserved'
            }
          }
        )
      );
    }

    return Ok(new Balance(accountId, available, reserved, venueId));
  }

  getAvailable(): Decimal {
    return this.available;
  }

  getReserved(): Decimal {
    return this.reserved;
  }

  getTotal(): Decimal {
    return this.available.plus(this.reserved);
  }

  getAccountId(): AccountId {
    return this.accountId;
  }
}

// Использование
const result = Balance.create(
  accountId,
  new Decimal('1000'),
  new Decimal('250')
);

if (result.ok) {
  console.log('Total balance:', result.value.getTotal().toString());
} else {
  console.error('Error:', result.error.message);
}
```

### 3. Операции с балансом

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidBalanceError } from '@polymarket/errors';
import Decimal from 'decimal.js';

class Balance {
  // ... create() method как выше

  reserve(amount: Decimal): Result<Balance, InvalidBalanceError> {
    if (amount.isNegative() || !amount.isFinite()) {
      return Err(
        new InvalidBalanceError(
          (ctx) => `Reserve amount must be finite and non-negative: ${ctx.amount}`,
          {
            code: InvalidBalanceError.code,
            context: {
              operation: 'reserve',
              amount: amount.toString(),
              available: this.available.toString(),
              reserved: this.reserved.toString()
            }
          }
        )
      );
    }

    if (amount.greaterThan(this.available)) {
      return Err(
        new InvalidBalanceError(
          (ctx) => `Insufficient available balance: need ${ctx.amount}, have ${ctx.available}`,
          {
            code: InvalidBalanceError.code,
            context: {
              operation: 'reserve',
              amount: amount.toString(),
              available: this.available.toString(),
              reserved: this.reserved.toString(),
              reason: 'insufficient-available'
            }
          }
        )
      );
    }

    const newAvailable = this.available.minus(amount);
    const newReserved = this.reserved.plus(amount);

    return Balance.create(
      this.accountId,
      newAvailable,
      newReserved,
      this.venueId
    );
  }

  release(amount: Decimal): Result<Balance, InvalidBalanceError> {
    if (amount.isNegative() || !amount.isFinite()) {
      return Err(
        new InvalidBalanceError(
          (ctx) => `Release amount must be finite and non-negative: ${ctx.amount}`,
          {
            code: InvalidBalanceError.code,
            context: {
              operation: 'release',
              amount: amount.toString(),
              available: this.available.toString(),
              reserved: this.reserved.toString()
            }
          }
        )
      );
    }

    if (amount.greaterThan(this.reserved)) {
      return Err(
        new InvalidBalanceError(
          (ctx) => `Insufficient reserved balance: need ${ctx.amount}, have ${ctx.reserved}`,
          {
            code: InvalidBalanceError.code,
            context: {
              operation: 'release',
              amount: amount.toString(),
              available: this.available.toString(),
              reserved: this.reserved.toString(),
              reason: 'insufficient-reserved'
            }
          }
        )
      );
    }

    const newAvailable = this.available.plus(amount);
    const newReserved = this.reserved.minus(amount);

    return Balance.create(
      this.accountId,
      newAvailable,
      newReserved,
      this.venueId
    );
  }

  withdraw(amount: Decimal): Result<Balance, InvalidBalanceError> {
    if (amount.isNegative() || !amount.isFinite()) {
      return Err(
        new InvalidBalanceError(
          (ctx) => `Withdraw amount must be finite and non-negative: ${ctx.amount}`,
          {
            code: InvalidBalanceError.code,
            context: {
              operation: 'withdraw',
              amount: amount.toString(),
              available: this.available.toString()
            }
          }
        )
      );
    }

    if (amount.greaterThan(this.available)) {
      return Err(
        new InvalidBalanceError(
          (ctx) => `Insufficient available balance for withdrawal: need ${ctx.amount}, have ${ctx.available}`,
          {
            code: InvalidBalanceError.code,
            context: {
              operation: 'withdraw',
              amount: amount.toString(),
              available: this.available.toString(),
              reserved: this.reserved.toString(),
              reason: 'insufficient-available'
            }
          }
        )
      );
    }

    const newAvailable = this.available.minus(amount);

    return Balance.create(
      this.accountId,
      newAvailable,
      this.reserved,
      this.venueId
    );
  }
}

// Использование
const balance = Balance.create(
  accountId,
  new Decimal('1000'),
  new Decimal('0')
).value;

// Резервируем средства под ордер
const afterReserve = balance.reserve(new Decimal('300'));
if (afterReserve.ok) {
  console.log('Reserved 300, available:', afterReserve.value.getAvailable());
  // Reserved 300, available: 700
}

// Пытаемся вывести больше, чем доступно
const afterWithdraw = balance.withdraw(new Decimal('2000'));
if (!afterWithdraw.ok) {
  console.error('Withdrawal failed:', afterWithdraw.error.context?.reason);
  // insufficient-available
}
```

### 4. Парсинг из API

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidBalanceError } from '@polymarket/errors';
import Decimal from 'decimal.js';

interface BalanceDTO {
  accountId: string;
  available: string;
  reserved: string;
  venueId?: string;
}

class Balance {
  static fromDTO(
    dto: BalanceDTO
  ): Result<Balance, InvalidBalanceError | InvalidAccountIdError | InvalidVenueIdError> {
    // Валидируем AccountId
    const accountIdResult = AccountId.fromString(dto.accountId);
    if (!accountIdResult.ok) {
      return accountIdResult;
    }

    // Парсим available
    let available: Decimal;
    try {
      available = new Decimal(dto.available);
    } catch (error) {
      return Err(
        new InvalidBalanceError(
          (ctx) => `Invalid available format: ${ctx.available}`,
          {
            code: InvalidBalanceError.code,
            context: {
              accountId: dto.accountId,
              available: dto.available,
              parseError: String(error)
            }
          }
        )
      );
    }

    // Парсим reserved
    let reserved: Decimal;
    try {
      reserved = new Decimal(dto.reserved);
    } catch (error) {
      return Err(
        new InvalidBalanceError(
          (ctx) => `Invalid reserved format: ${ctx.reserved}`,
          {
            code: InvalidBalanceError.code,
            context: {
              accountId: dto.accountId,
              reserved: dto.reserved,
              parseError: String(error)
            }
          }
        )
      );
    }

    // Валидируем VenueId (если есть)
    let venueId: VenueId | undefined;
    if (dto.venueId) {
      const venueIdResult = VenueId.fromString(dto.venueId);
      if (!venueIdResult.ok) {
        return venueIdResult;
      }
      venueId = venueIdResult.value;
    }

    return Balance.create(
      accountIdResult.value,
      available,
      reserved,
      venueId
    );
  }
}

// Использование
const dto: BalanceDTO = {
  accountId: 'acc_123',
  available: '1000.50',
  reserved: '250.00',
  venueId: 'polymarket'
};

const result = Balance.fromDTO(dto);

if (result.ok) {
  console.log('Balance loaded:', result.value.getTotal().toString());
} else {
  if (InvalidBalanceError.is(result.error)) {
    console.error('Invalid balance data:', result.error.context);
  } else {
    console.error('Invalid ID:', result.error.message);
  }
}
```

### 5. WebSocket обновления

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidBalanceError } from '@polymarket/errors';

interface BalanceUpdate {
  accountId: string;
  available: string;
  reserved: string;
  timestamp: number;
}

function handleBalanceUpdate(
  currentBalance: Balance,
  update: BalanceUpdate
): Result<Balance, InvalidBalanceError> {
  // Проверяем что обновление для того же аккаунта
  if (update.accountId !== currentBalance.getAccountId().toString()) {
    return Err(
      new InvalidBalanceError(
        (ctx) => `Balance update for wrong account: expected ${ctx.expected}, got ${ctx.actual}`,
        {
          code: InvalidBalanceError.code,
          context: {
            operation: 'update',
            expected: currentBalance.getAccountId().toString(),
            actual: update.accountId,
            reason: 'account-mismatch'
          }
        }
      )
    );
  }

  // Создаём новый баланс из обновления
  const available = new Decimal(update.available);
  const reserved = new Decimal(update.reserved);

  return Balance.create(
    currentBalance.getAccountId(),
    available,
    reserved,
    currentBalance.getVenueId()
  );
}
```

---

## Edge Cases

### Специальные значения

```typescript
// NaN
Balance.create(accountId, new Decimal(NaN), new Decimal('100'));
// ❌ Err (non-finite-available)

// Infinity
Balance.create(accountId, new Decimal(Infinity), new Decimal('0'));
// ❌ Err (non-finite-available)

// Отрицательные
Balance.create(accountId, new Decimal('-10'), new Decimal('100'));
// ❌ Err (negative-available)

Balance.create(accountId, new Decimal('100'), new Decimal('-10'));
// ❌ Err (negative-reserved)

// Ноль (допустимо)
Balance.create(accountId, new Decimal('0'), new Decimal('0'));
// ✅ Ok (пустой баланс)
```

### Операции с нулевым балансом

```typescript
const emptyBalance = Balance.create(
  accountId,
  new Decimal('0'),
  new Decimal('0')
).value;

// Резервирование из нулевого баланса
emptyBalance.reserve(new Decimal('100'));
// ❌ Err (insufficient-available)

// Вывод из нулевого баланса
emptyBalance.withdraw(new Decimal('1'));
// ❌ Err (insufficient-available)
```

---

## Обработка ошибок

### По причине ошибки

```typescript
import { InvalidBalanceError } from '@polymarket/errors';

const result = Balance.create(accountId, available, reserved);

if (result.ok) {
  processBalance(result.value);
} else {
  if (InvalidBalanceError.is(result.error)) {
    const reason = result.error.context?.reason;

    switch (reason) {
      case 'negative-available':
        showError('Available balance cannot be negative');
        break;
      case 'negative-reserved':
        showError('Reserved balance cannot be negative');
        break;
      case 'insufficient-available':
        showError('Insufficient available funds');
        break;
      case 'insufficient-reserved':
        showError('Insufficient reserved funds');
        break;
      default:
        showError('Invalid balance');
    }
  }
}
```

### С логированием операций

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidBalanceError } from '@polymarket/errors';

function reserveWithLogging(
  balance: Balance,
  amount: Decimal
): Result<Balance, InvalidBalanceError> {
  logger.info('Reserving balance', {
    accountId: balance.getAccountId().toString(),
    amount: amount.toString(),
    currentAvailable: balance.getAvailable().toString(),
    currentReserved: balance.getReserved().toString()
  });

  const result = balance.reserve(amount);

  if (result.ok) {
    logger.info('Balance reserved successfully', {
      newAvailable: result.value.getAvailable().toString(),
      newReserved: result.value.getReserved().toString()
    });
  } else {
    logger.error('Balance reservation failed', {
      error: result.error.toJSON(),
      amount: amount.toString()
    });
  }

  return result;
}
```

---

## Связанные ошибки

- [InvalidAssetQuantityError](./invalid-asset-quantity.md) - валидация количества актива
- [InvalidAmountError](./invalid-amount.md) - универсальная валидация чисел
- [InvalidMoneyError](./invalid-money.md) - валидация денежных сумм

## См. также

- [Value Objects Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
