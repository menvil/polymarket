# AccountIdValidationError

Ошибка валидации поля AccountId (userId или имя субаккаунта) в торговой системе Polymarket.

## Описание

Возвращается при попытке создать AccountId с невалидным строковым полем. Валидация обеспечивает корректность round-trip сериализации: `create → serialize → parse`.

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_ACCOUNT_ID` |
| **Severity** | `low` |
| **Класс** | `AccountIdValidationError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | IDs |

## Правила валидации

Поля `userId` и `name` считаются невалидными если:

| Условие | Reason | Пример |
|---------|--------|--------|
| Пустая строка | `'empty string'` | `''` |
| Длина > 256 символов | `'exceeds 256 characters'` | `'x'.repeat(300)` |
| Control characters (U+0000..U+001F, U+007F..U+009F) | `'invalid format'` | `'user\x00name'` |

## Когда использовать

- При валидации `userId` при создании VENUE account
- При валидации `name` при создании SUBACCOUNT
- В factory функциях: `accountIdFromVenue()`, `accountIdForSubaccount()`
- При парсинге пользовательского ввода идентификаторов

## Импорт

```typescript
import { AccountIdValidationError } from '@polymarket/errors';

// Для примеров с Result<T,E> также понадобятся:
import { Result, Ok, Err } from '@polymarket/result';
```

---

## Примеры использования

### 1. Базовое использование (Result pattern)

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { AccountIdValidationError } from '@polymarket/errors';

function validateUserId(
  userId: string
): Result<string, AccountIdValidationError> {
  if (userId.length === 0) {
    return Err(new AccountIdValidationError(
      (ctx) => `Invalid ${ctx.field}: ${ctx.reason} (value: "${ctx.value}")`,
      {
        code: AccountIdValidationError.code,
        context: { field: 'userId', value: userId, reason: 'empty string' }
      }
    ));
  }

  if (userId.length > 256) {
    return Err(new AccountIdValidationError(
      (ctx) => `Invalid ${ctx.field}: ${ctx.reason} (value: "${ctx.value}")`,
      {
        code: AccountIdValidationError.code,
        context: { field: 'userId', value: userId, reason: 'exceeds 256 characters' }
      }
    ));
  }

  return Ok(userId);
}

// Использование
const result = validateUserId('user_123');

if (result.ok) {
  console.log('Valid userId:', result.value);
} else {
  console.error('Validation failed:', result.error.message);
  console.error('Context:', result.error.context);
  // { field: 'userId', value: '', reason: 'empty string' }
}
```

### 2. В factory функции accountIdFromVenue

```typescript
import { Ok, Err } from '@polymarket/result';
import { AccountIdValidationError } from '@polymarket/errors';
import type { VenueId } from '@polymarket/ids';
import type { AccountId } from '@polymarket/ids';

function accountIdFromVenue(
  venueId: VenueId,
  userId: string
): Result<AccountId, AccountIdValidationError> {
  if (!isValidStringField(userId)) {
    let reason = 'invalid format';
    if (userId.length === 0) {
      reason = 'empty string';
    } else if (userId.length > 256) {
      reason = 'exceeds 256 characters';
    }

    return Err(new AccountIdValidationError(
      (ctx) => `Invalid ${ctx.field}: ${ctx.reason} (value: "${ctx.value}")`,
      {
        code: AccountIdValidationError.code,
        context: { field: 'userId', value: userId, reason }
      }
    ));
  }

  return Ok({ kind: 'VENUE', venueId, userId });
}

// Использование
const result = accountIdFromVenue('POLYMARKET', 'user:with:colons');

if (result.ok) {
  console.log('Account:', result.value);
} else {
  const error = result.error;
  console.error('Error:', error.message);
  // "Invalid userId: invalid format (value: "user:with:colons")"
}
```

### 3. В factory функции accountIdForSubaccount

```typescript
import { Ok, Err } from '@polymarket/result';
import { AccountIdDepthError, AccountIdValidationError } from '@polymarket/errors';

function accountIdForSubaccount(
  base: AccountId,
  name: string
): Result<AccountId, AccountIdDepthError | AccountIdValidationError> {
  // Сначала валидация имени...
  if (!isValidStringField(name)) {
    let reason = 'invalid format';
    if (name.length === 0) {
      reason = 'empty string';
    } else if (name.length > 256) {
      reason = 'exceeds 256 characters';
    }

    return Err(new AccountIdValidationError(
      (ctx) => `Invalid ${ctx.field}: ${ctx.reason} (value: "${ctx.value}")`,
      {
        code: AccountIdValidationError.code,
        context: { field: 'name', value: name, reason }
      }
    ));
  }

  // Затем проверка глубины...
  const currentDepth = getSubaccountDepth(base);
  if (currentDepth >= MAX_SUBACCOUNT_DEPTH) {
    return Err(new AccountIdDepthError(/* ... */));
  }

  return Ok({ kind: 'SUBACCOUNT', base, name });
}

// Использование
const wallet = accountIdFromWallet(parseWalletAddress('0x1234...')!);

// Невалидное имя субаккаунта
const result = accountIdForSubaccount(wallet, '');

if (!result.ok) {
  const error = result.error;

  if (AccountIdValidationError.is(error)) {
    console.error('Name validation failed:', error.context);
    // { field: 'name', value: '', reason: 'empty string' }
  }
}
```

### 4. Обработка по reason

```typescript
import { AccountIdValidationError } from '@polymarket/errors';

function handleAccountError(error: AccountIdValidationError): string {
  const field = error.context?.field as string;
  const reason = error.context?.reason as string;

  if (reason === 'empty string') {
    return `${field} cannot be empty`;
  }

  if (reason === 'exceeds 256 characters') {
    return `${field} is too long (max 256 characters)`;
  }

  return `${field} contains invalid characters`;
}

// Использование в UI
const result = accountIdFromVenue('POLYMARKET', '');

if (!result.ok) {
  const userMessage = handleAccountError(result.error);
  showFieldError('userId', userMessage);
  // "userId cannot be empty"
}
```

---

## Edge Cases

### Граничные значения

```typescript
// Допустимые значения
validateUserId('a');              // ✅ минимальная длина
validateUserId('x'.repeat(256)); // ✅ максимальная длина
validateUserId('user_123');      // ✅ типичный userId
validateUserId('user-name');     // ✅ дефис допустим
validateUserId('user name');     // ✅ пробел допустим (не control char)

// Недопустимые значения
validateUserId('');              // ❌ пустая строка
validateUserId('x'.repeat(257)); // ❌ превышает 256 символов
validateUserId('user\x00name'); // ❌ null character (U+0000)
validateUserId('user\tname');   // ❌ tab character (U+0009)
validateUserId('user\nname');   // ❌ newline (U+000A)
```

### Escaping символов в serialization

AccountId поддерживает специальные символы (включая `:` и `\`) через escaping при сериализации — это НЕ ошибка валидации:

```typescript
// Двоеточие в userId — допустимо (будет escaped при serialization)
const result = accountIdFromVenue('POLYMARKET', 'user:with:colons');
// ✅ Ok — создаёт VENUE account

if (result.ok) {
  console.log(accountIdToString(result.value));
  // → 'venue:POLYMARKET:user\:with\:colons' (escaped)
}
```

### type guard `.is()`

```typescript
import { AccountIdValidationError, AccountIdDepthError, TradingError } from '@polymarket/errors';

function processError(error: unknown): void {
  if (AccountIdValidationError.is(error)) {
    // TypeScript знает: error is AccountIdValidationError
    console.log('Validation error:', error.context?.field);
  } else if (AccountIdDepthError.is(error)) {
    console.log('Depth error:', error.context?.currentDepth);
  } else if (TradingError.is(error)) {
    console.log('Other trading error:', error.message);
  }
}
```

---

## Связанные ошибки

- [AccountIdDepthError](./account-id-depth.md) - превышение лимита вложенности субаккаунтов

## См. также

- [ID Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
