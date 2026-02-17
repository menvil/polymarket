# ID Errors

Ошибки для работы с идентификаторами аккаунтов в торговой системе Polymarket.

## Обзор

ID Errors представляют проблемы валидации и структурные ошибки при создании и разборе идентификаторов:

- **Валидация полей** - проверка корректности строковых полей (userId, subaccount name)
- **Структурные ограничения** - защита от превышения лимитов вложенности

Эти ошибки возникают на уровне создания domain objects (factory layer), до бизнес-логики.

Все ID errors имеют:

- **Статический код:** `ErrorClass.code` (для удобства)
- **Предназначение:** Result pattern (ошибки валидации входных данных)

---

## Каталог ошибок

| Код | Класс | Severity | Когда использовать | Документация |
|-----|-------|----------|--------------------|--------------|
| `INVALID_ACCOUNT_ID` | AccountIdValidationError | `low` | Невалидный userId или имя субаккаунта | [→](./account-id-validation.md) |
| `ACCOUNT_ID_DEPTH_EXCEEDED` | AccountIdDepthError | `medium` | Превышен лимит вложенности SUBACCOUNT | [→](./account-id-depth.md) |
| `INVALID_ASSET_ID` | AssetIdValidationError | `low` | Невалидные поля при создании AssetId (outcomeKey, protocolId, chainId, conditionId) | — |

---

## Общие паттерны использования

### 1. AccountIdValidationError (валидация полей)

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { AccountIdValidationError } from '@polymarket/errors';
import type { AccountId } from '@polymarket/ids';

function createVenueAccount(
  venueId: string,
  userId: string
): Result<AccountId, AccountIdValidationError> {
  if (!userId || userId.length === 0) {
    return Err(new AccountIdValidationError(
      (ctx) => `Invalid ${ctx.field}: ${ctx.reason} (value: "${ctx.value}")`,
      {
        code: AccountIdValidationError.code,
        context: { field: 'userId', value: userId, reason: 'empty string' }
      }
    ));
  }

  return Ok({ kind: 'VENUE', venueId, userId });
}

// Использование
const result = createVenueAccount('POLYMARKET', 'user_123');

result.match({
  ok: (account) => console.log('Account created:', account),
  err: (error) => console.error('Validation failed:', error.message),
});
```

### 2. AssetIdValidationError (невалидные поля AssetId)

```typescript
import { Result } from '@polymarket/result';
import { AssetIdValidationError } from '@polymarket/errors';
import { AssetIdHelpers, BinaryOutcome, type AssetId } from '@polymarket/ids';

// fromOutcomeToken возвращает Result — никогда не бросает
const result = AssetIdHelpers.fromOutcomeToken(conditionRef, BinaryOutcome.UP);

if (!result.ok) {
  const error = result.error; // AssetIdValidationError
  console.error(`Asset validation failed [${error.context?.field}]:`, error.message);
  // error.context?.field: 'outcomeKey' | 'protocolId' | 'chainId' | 'conditionId'
  // error.context?.value: невалидное значение (строка)
} else {
  const token: AssetId = result.value;
}
```

### 3. AccountIdDepthError (лимит вложенности)

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { AccountIdDepthError } from '@polymarket/errors';
import type { AccountId } from '@polymarket/ids';

const MAX_DEPTH = 5;

function createSubaccount(
  base: AccountId,
  name: string
): Result<AccountId, AccountIdDepthError> {
  const currentDepth = getSubaccountDepth(base);

  if (currentDepth >= MAX_DEPTH) {
    return Err(new AccountIdDepthError(
      (ctx) => `Subaccount depth limit exceeded during ${ctx.operation}: current=${ctx.currentDepth}, max=${ctx.maxDepth}`,
      {
        code: AccountIdDepthError.code,
        context: { currentDepth, maxDepth: MAX_DEPTH, operation: 'create' }
      }
    ));
  }

  return Ok({ kind: 'SUBACCOUNT', base, name });
}
```

---

## Архитектура

### ID Errors vs Math Errors vs Value Objects Errors

**ID Errors (factory layer):**

- Создание и валидация идентификаторов
- Структурные ограничения (глубина, длина, формат)
- Используются в `@polymarket/ids` пакете
- **Result pattern** (ошибки входных данных)

**Math Errors (core layer):**

- Чистые математические операции
- Только математическая валидность (finite, positive, non-zero)
- **Always throw** (математические невозможности)

**Value Objects Errors (domain layer):**

- Бизнес-валидация (диапазоны, форматы)
- Создание domain objects (Price, Quantity, Money)
- **Result pattern** (бизнес-правила)

---

## Severity Guidelines

| Ошибка | Severity | Обоснование |
|--------|----------|-------------|
| `AccountIdValidationError` | `low` | Проблема входных данных, пользователь может исправить |
| `AccountIdDepthError` | `medium` | Некорректное использование API, требует внимания разработчика |
| `AssetIdValidationError` | `low` | Невалидное поле при создании AssetId — проблема входных данных |

---

## Best Practices

### Когда использовать ID Errors

✅ **Используйте AccountIdValidationError:**

- При невалидном userId (пустой, слишком длинный, содержит запрещённые символы)
- При невалидном имени субаккаунта
- В factory функциях создания AccountId

✅ **Используйте AccountIdDepthError:**

- При превышении максимальной глубины вложенности субаккаунтов
- В factory функции `accountIdForSubaccount`

✅ **Используйте AssetIdValidationError:**

- При невалидном `outcomeKey` (не-строка, содержит ':', слишком длинный)
- При невалидном `protocolId` (не соответствует формату `[A-Z_][A-Z0-9_]{0,31}`)
- При невалидном `chainId` (ноль, отрицательный, не целое число)
- При невалидном `conditionId` (не 0x + 64 hex символа)
- В `AssetIdHelpers.fromOutcomeToken()`

### Context Guidelines

Всегда включайте в context:

```typescript
// AccountIdValidationError
{
  field: 'userId' | 'name',  // имя невалидного поля
  value: string,              // невалидное значение
  reason: string              // причина невалидности
}

// AccountIdDepthError
{
  currentDepth: number,       // текущая глубина
  maxDepth: number,           // максимально допустимая
  operation: string           // операция ('create' | 'serialize')
}

// AssetIdValidationError
{
  field: 'outcomeKey' | 'protocolId' | 'chainId' | 'conditionId',  // поле с ошибкой
  value: string,  // невалидное значение (приведено к строке)
}
```

---

## См. также

- [Обработка ошибок](../error-handling.md) - Best practices для error handling
- [Math Errors](../math/README.md) - Математические ошибки
- [Value Objects Errors](../value-objects/README.md) - Ошибки бизнес-валидации
- [Главная документация](../README.md) - Обзор всей системы ошибок
