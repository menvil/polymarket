# InvalidAssetQuantityError

Ошибка валидации количества актива (AssetQuantity value object).

## Описание

AssetQuantity представляет собой композитный value object, объединяющий:

- **AssetId** - идентификатор актива (токен, валюта)
- **amount** - количество этого актива

Валидация проверяет корректность обоих компонентов.

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_ASSET_QUANTITY` |
| **Severity** | `low` |
| **Класс** | `InvalidAssetQuantityError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Value Objects |

## Когда использовать

- Создание value object `AssetQuantity` из пользовательского ввода
- Валидация amount перед операциями с балансом
- Парсинг данных из API (wallet, balance, transfer)
- Проверка корректности AssetId и amount при создании транзакций

## Импорт

```typescript
import { InvalidAssetQuantityError } from '@polymarket/errors';

// Для примеров с Result<T,E>:
import { Result, Ok, Err } from '@polymarket/result';
```

---

## Примеры использования

### 1. Базовое использование (throw)

```typescript
import { InvalidAssetQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

class AssetQuantity {
  constructor(
    private readonly assetId: AssetId,
    private readonly amount: Decimal
  ) {
    if (!amount.isFinite() || amount.isNegative()) {
      throw new InvalidAssetQuantityError(
        (ctx) => `Invalid amount ${ctx.amount} for asset ${ctx.assetId}`,
        {
          code: InvalidAssetQuantityError.code,
          context: {
            assetId: assetId.toString(),
            amount: amount.toString(),
            reason: 'non-finite or negative'
          }
        }
      );
    }
  }
}

// Использование
try {
  const qty = new AssetQuantity(usdcId, new Decimal(-100));
} catch (error) {
  if (InvalidAssetQuantityError.is(error)) {
    console.error('Invalid asset quantity:', error.context);
  }
}
```

### 2. С Result<T,E> (рекомендуется)

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidAssetQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

class AssetQuantity {
  private constructor(
    private readonly assetId: AssetId,
    private readonly amount: Decimal
  ) {}

  static create(
    assetId: AssetId,
    amount: Decimal
  ): Result<AssetQuantity, InvalidAssetQuantityError> {
    if (!amount.isFinite()) {
      return Err(
        new InvalidAssetQuantityError(
          (ctx) => `Amount must be finite, got ${ctx.amount}`,
          {
            code: InvalidAssetQuantityError.code,
            context: {
              assetId: assetId.toString(),
              amount: amount.toString(),
              reason: 'non-finite'
            }
          }
        )
      );
    }

    if (amount.isNegative()) {
      return Err(
        new InvalidAssetQuantityError(
          (ctx) => `Amount cannot be negative: ${ctx.amount}`,
          {
            code: InvalidAssetQuantityError.code,
            context: {
              assetId: assetId.toString(),
              amount: amount.toString(),
              reason: 'negative'
            }
          }
        )
      );
    }

    return Ok(new AssetQuantity(assetId, amount));
  }

  getAssetId(): AssetId {
    return this.assetId;
  }

  getAmount(): Decimal {
    return this.amount;
  }
}

// Использование
const result = AssetQuantity.create(usdcId, new Decimal('100.50'));

if (result.ok) {
  console.log('Valid quantity:', result.value.getAmount().toString());
} else {
  console.error('Error:', result.error.message);
}
```

### 3. Валидация с нулевым количеством

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidAssetQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

class AssetQuantity {
  static create(
    assetId: AssetId,
    amount: Decimal,
    allowZero: boolean = false
  ): Result<AssetQuantity, InvalidAssetQuantityError> {
    if (!amount.isFinite()) {
      return Err(
        new InvalidAssetQuantityError(
          (ctx) => `Amount must be finite, got ${ctx.amount}`,
          {
            code: InvalidAssetQuantityError.code,
            context: { assetId: assetId.toString(), amount: amount.toString() }
          }
        )
      );
    }

    if (amount.isNegative()) {
      return Err(
        new InvalidAssetQuantityError(
          (ctx) => `Amount cannot be negative: ${ctx.amount}`,
          {
            code: InvalidAssetQuantityError.code,
            context: { assetId: assetId.toString(), amount: amount.toString() }
          }
        )
      );
    }

    if (!allowZero && amount.isZero()) {
      return Err(
        new InvalidAssetQuantityError(
          (ctx) => `Amount cannot be zero for asset ${ctx.assetId}`,
          {
            code: InvalidAssetQuantityError.code,
            context: {
              assetId: assetId.toString(),
              amount: '0',
              reason: 'zero-not-allowed'
            }
          }
        )
      );
    }

    return Ok(new AssetQuantity(assetId, amount));
  }
}

// Использование
AssetQuantity.create(usdcId, new Decimal('0'), false); // ❌ Err
AssetQuantity.create(usdcId, new Decimal('0'), true);  // ✅ Ok
```

### 4. Интеграция с AssetId

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidAssetQuantityError, InvalidAssetIdError } from '@polymarket/errors';
import Decimal from 'decimal.js';

// AssetId может быть невалидным сам по себе
type AssetIdError = InvalidAssetIdError;

class AssetQuantity {
  static fromRaw(
    assetIdStr: string,
    amountStr: string
  ): Result<AssetQuantity, InvalidAssetQuantityError | AssetIdError> {
    // Сначала валидируем AssetId
    const assetIdResult = AssetId.fromString(assetIdStr);
    if (!assetIdResult.ok) {
      return assetIdResult; // Прокидываем ошибку AssetId
    }

    // Парсим amount
    let amount: Decimal;
    try {
      amount = new Decimal(amountStr);
    } catch (error) {
      return Err(
        new InvalidAssetQuantityError(
          (ctx) => `Invalid amount format: ${ctx.amount}`,
          {
            code: InvalidAssetQuantityError.code,
            context: {
              assetId: assetIdStr,
              amount: amountStr,
              parseError: String(error)
            }
          }
        )
      );
    }

    // Валидируем quantity
    return AssetQuantity.create(assetIdResult.value, amount);
  }
}

// Использование
const result = AssetQuantity.fromRaw('USDC', '123.45');

if (result.ok) {
  console.log('Created:', result.value);
} else {
  if (InvalidAssetQuantityError.is(result.error)) {
    console.error('Invalid quantity:', result.error.context);
  } else {
    console.error('Invalid asset ID:', result.error.message);
  }
}
```

### 5. Операции с AssetQuantity

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidAssetQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

class AssetQuantity {
  add(other: AssetQuantity): Result<AssetQuantity, InvalidAssetQuantityError> {
    if (!this.assetId.equals(other.assetId)) {
      return Err(
        new InvalidAssetQuantityError(
          (ctx) => `Cannot add different assets: ${ctx.asset1} and ${ctx.asset2}`,
          {
            code: InvalidAssetQuantityError.code,
            context: {
              operation: 'add',
              asset1: this.assetId.toString(),
              asset2: other.assetId.toString()
            }
          }
        )
      );
    }

    const newAmount = this.amount.plus(other.amount);
    return AssetQuantity.create(this.assetId, newAmount);
  }

  subtract(
    other: AssetQuantity
  ): Result<AssetQuantity, InvalidAssetQuantityError> {
    if (!this.assetId.equals(other.assetId)) {
      return Err(
        new InvalidAssetQuantityError(
          (ctx) => `Cannot subtract different assets: ${ctx.asset1} and ${ctx.asset2}`,
          {
            code: InvalidAssetQuantityError.code,
            context: {
              operation: 'subtract',
              asset1: this.assetId.toString(),
              asset2: other.assetId.toString()
            }
          }
        )
      );
    }

    const newAmount = this.amount.minus(other.amount);

    if (newAmount.isNegative()) {
      return Err(
        new InvalidAssetQuantityError(
          (ctx) => `Subtraction would result in negative amount: ${ctx.result}`,
          {
            code: InvalidAssetQuantityError.code,
            context: {
              operation: 'subtract',
              minuend: this.amount.toString(),
              subtrahend: other.amount.toString(),
              result: newAmount.toString()
            }
          }
        )
      );
    }

    return AssetQuantity.create(this.assetId, newAmount);
  }
}
```

---

## Edge Cases

### Специальные значения

```typescript
// NaN
AssetQuantity.create(usdcId, new Decimal(NaN));      // ❌ Err (non-finite)

// Infinity
AssetQuantity.create(usdcId, new Decimal(Infinity)); // ❌ Err (non-finite)

// Отрицательные
AssetQuantity.create(usdcId, new Decimal(-1));       // ❌ Err (negative)

// Ноль (зависит от allowZero)
AssetQuantity.create(usdcId, new Decimal(0), false); // ❌ Err
AssetQuantity.create(usdcId, new Decimal(0), true);  // ✅ Ok

// Очень малые положительные
AssetQuantity.create(usdcId, new Decimal('1e-18')); // ✅ Ok
```

### Разные активы

```typescript
const usdcResult = AssetQuantity.create(usdcId, new Decimal('100'));
const ethResult = AssetQuantity.create(ethId, new Decimal('1'));

if (!usdcResult.ok || !ethResult.ok) {
  throw new Error('Failed to create asset quantities');
}

const usdc = usdcResult.value;
const eth = ethResult.value;

// Нельзя складывать разные активы
usdc.add(eth); // ❌ Err (different assets)

// Но можно работать с одним и тем же активом
const moreUsdcResult = AssetQuantity.create(usdcId, new Decimal('50'));
if (!moreUsdcResult.ok) {
  throw new Error('Failed to create more USDC');
}
usdc.add(moreUsdcResult.value); // ✅ Ok (150 USDC)
```

---

## Обработка ошибок

### По типу ошибки

```typescript
import { InvalidAssetQuantityError } from '@polymarket/errors';

const result = AssetQuantity.create(assetId, amount);

if (result.ok) {
  processQuantity(result.value);
} else {
  if (InvalidAssetQuantityError.is(result.error)) {
    const reason = result.error.context?.reason;
    if (reason === 'negative') {
      showError('Amount cannot be negative');
    } else if (reason === 'non-finite') {
      showError('Amount must be a valid number');
    } else if (reason === 'zero-not-allowed') {
      showError('Amount must be greater than zero');
    }
  }
}
```

### С логированием

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidAssetQuantityError } from '@polymarket/errors';

function createAssetQuantityWithLogging(
  assetId: AssetId,
  amount: Decimal
): Result<AssetQuantity, InvalidAssetQuantityError> {
  const result = AssetQuantity.create(assetId, amount);

  if (result.ok) {
    logger.debug('Asset quantity created', {
      assetId: assetId.toString(),
      amount: amount.toString()
    });
  } else {
    logger.error('Asset quantity validation failed', {
      error: result.error.toJSON(),
      assetId: assetId.toString(),
      amount: amount.toString()
    });
  }

  return result;
}
```

---

## Связанные ошибки

- [InvalidAmountError](./invalid-amount.md) - универсальная валидация чисел
- [InvalidBalanceError](./invalid-balance.md) - валидация балансов с available/reserved
- [CurrencyMismatchError](./currency-mismatch.md) - операции с разными валютами

## См. также

- [Value Objects Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
