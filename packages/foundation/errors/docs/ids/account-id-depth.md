# AccountIdDepthError

Ошибка превышения лимита вложенности субаккаунта в торговой системе Polymarket.

## Описание

Возвращается при попытке создать AccountId с глубиной вложенности SUBACCOUNT, превышающей максимально допустимую (`MAX_SUBACCOUNT_DEPTH = 5`). Защищает от stack overflow при рекурсивной обработке глубоко вложенных структур.

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `ACCOUNT_ID_DEPTH_EXCEEDED` |
| **Severity** | `medium` |
| **Класс** | `AccountIdDepthError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | IDs |

## Семантика глубины

| Глубина | Описание | Допустимо? |
|---------|----------|------------|
| 0 | Базовый аккаунт (WALLET или VENUE) | ✅ |
| 1 | Один уровень SUBACCOUNT | ✅ |
| 2..5 | Вложенные субаккаунты | ✅ |
| 6+ | Превышение MAX_SUBACCOUNT_DEPTH | ❌ |

## Когда использовать

- При попытке создать SUBACCOUNT когда `currentDepth >= MAX_SUBACCOUNT_DEPTH`
- В factory функции `accountIdForSubaccount()`
- При валидации глубины цепочки субаккаунтов

## Импорт

```typescript
import { AccountIdDepthError } from '@polymarket/errors';

// Для примеров с Result<T,E> также понадобятся:
import { Result, Ok, Err } from '@polymarket/result';
```

---

## Примеры использования

### 1. Базовое использование (Result pattern)

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { AccountIdDepthError, AccountIdValidationError } from '@polymarket/errors';

const MAX_SUBACCOUNT_DEPTH = 5;

function accountIdForSubaccount(
  base: AccountId,
  name: string
): Result<AccountId, AccountIdDepthError | AccountIdValidationError> {
  const currentDepth = getSubaccountDepth(base);

  if (currentDepth >= MAX_SUBACCOUNT_DEPTH) {
    return Err(new AccountIdDepthError(
      (ctx) => `Subaccount depth limit exceeded during ${ctx.operation}: current=${ctx.currentDepth}, max=${ctx.maxDepth}`,
      {
        context: {
          currentDepth,
          maxDepth: MAX_SUBACCOUNT_DEPTH,
          operation: 'create'
        }
      }
    ));
  }

  return Ok({ kind: 'SUBACCOUNT', base, name });
}

// Использование
const wallet = accountIdFromWallet(parseWalletAddress('0x1234...')!);
const sub1 = accountIdForSubaccount(wallet, 'level1').unwrap();
const sub2 = accountIdForSubaccount(sub1, 'level2').unwrap();
const sub3 = accountIdForSubaccount(sub2, 'level3').unwrap();
const sub4 = accountIdForSubaccount(sub3, 'level4').unwrap();
const sub5 = accountIdForSubaccount(sub4, 'level5').unwrap();

// Попытка создать 6-й уровень
const result = accountIdForSubaccount(sub5, 'tooDeep');

if (!result.ok) {
  const error = result.error;
  if (AccountIdDepthError.is(error)) {
    console.error('Depth exceeded:', error.message);
    // "Subaccount depth limit exceeded during create: current=5, max=5"
    console.error('Context:', error.context);
    // { currentDepth: 5, maxDepth: 5, operation: 'create' }
  }
}
```

### 2. Обработка с fallback

```typescript
import { AccountIdDepthError, AccountIdValidationError } from '@polymarket/errors';

async function addSubaccount(
  base: AccountId,
  name: string
): Promise<void> {
  const result = accountIdForSubaccount(base, name);

  if (result.ok) {
    await saveAccount(result.value);
    return;
  }

  const error = result.error;

  if (AccountIdDepthError.is(error)) {
    const maxDepth = error.context?.maxDepth as number;

    // Логируем предупреждение и отказываем пользователю
    logger.warn('Subaccount depth limit reached', {
      error: error.toJSON(),
      accountId: accountIdToString(base),
    });

    throw new UserFacingError(
      `Cannot create subaccount: maximum nesting depth (${maxDepth}) reached`
    );
  }

  if (AccountIdValidationError.is(error)) {
    throw new UserFacingError(`Invalid subaccount name: ${error.context?.reason}`);
  }

  throw error;
}
```

### 3. Проверка глубины перед созданием

```typescript
import { AccountIdDepthError } from '@polymarket/errors';

const MAX_DEPTH = 5;

/**
 * Проверить допустима ли текущая глубина
 */
function checkDepthLimit(
  base: AccountId,
  maxDepth: number = MAX_DEPTH
): Result<number, AccountIdDepthError> {
  const currentDepth = getSubaccountDepth(base);

  if (currentDepth >= maxDepth) {
    return Err(new AccountIdDepthError(
      (ctx) => `Cannot add subaccount: depth ${ctx.currentDepth} exceeds limit ${ctx.maxDepth}`,
      {
        context: { currentDepth, maxDepth, operation: 'create' }
      }
    ));
  }

  return Ok(currentDepth);
}

// Использование в UI
function renderAddSubaccountButton(account: AccountId): boolean {
  const depthResult = checkDepthLimit(account);
  return depthResult.ok; // показываем кнопку только если глубина позволяет
}
```

### 4. Type guard `.is()`

```typescript
import { AccountIdDepthError, AccountIdValidationError } from '@polymarket/errors';

function handleSubaccountError(
  error: AccountIdDepthError | AccountIdValidationError
): string {
  if (AccountIdDepthError.is(error)) {
    const current = error.context?.currentDepth as number;
    const max = error.context?.maxDepth as number;
    return `Subaccount nesting limit reached (${current}/${max})`;
  }

  if (AccountIdValidationError.is(error)) {
    const field = error.context?.field as string;
    const reason = error.context?.reason as string;
    return `Invalid ${field}: ${reason}`;
  }

  return 'Unknown account error';
}
```

---

## Edge Cases

### Создание допустимой максимальной глубины

```typescript
const wallet = accountIdFromWallet(parseWalletAddress('0x...')!);

// depth=0: базовый аккаунт
// depth=1..5: допустимо
const sub5 = [1, 2, 3, 4, 5].reduce(
  (acc, i) => accountIdForSubaccount(acc, `level${i}`).unwrap(),
  wallet as AccountId
);

// depth=5: последний допустимый
console.log(getSubaccountDepth(sub5)); // → 5

// depth=6: ошибка
const result = accountIdForSubaccount(sub5, 'tooDeep');
console.log(result.ok); // → false
console.log(AccountIdDepthError.is(result.error)); // → true
```

### Проверка граничного значения

```typescript
// currentDepth === maxDepth → ошибка (условие >=)
// currentDepth === maxDepth - 1 → допустимо

const sub4 = buildSubaccountChain(wallet, 4); // depth=4

const valid = accountIdForSubaccount(sub4, 'level5'); // depth станет 5
console.log(valid.ok); // → true (5 <= 5 допустимо)

const invalid = accountIdForSubaccount(valid.unwrap(), 'level6'); // depth стал бы 6
console.log(invalid.ok); // → false (6 > 5)
```

### Кастомный лимит глубины

Используйте опцию `maxDepth` при необходимости более строгих ограничений:

```typescript
// parseAccountId поддерживает опциональный maxDepth для парсинга
const parsed = parseAccountId('sub:sub:sub:wallet:0x...', { maxDepth: 2 });
// → undefined (превышает кастомный лимит)
```

---

## Связанные ошибки

- [AccountIdValidationError](./account-id-validation.md) - невалидные строковые поля AccountId

## См. также

- [ID Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
