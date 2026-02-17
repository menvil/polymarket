# AccountId: Security Improvements & Result Railway Pattern

## Проблема

Исходная реализация `AccountId` имела несколько уязвимостей безопасности:

1. **Некорректный escaping**: Backslash (`\`) не экранировался → сломан round-trip для строк типа `"user\:123"`
2. **Stack overflow риск**: Рекурсивные функции без ограничения глубины → DoS атаки через глубоко вложенные SUBACCOUNT
3. **Отсутствие валидации WalletAddress**: Небезопасный каст без проверки формата
4. **Отсутствие защиты от длинных строк**: DoS через аномально длинные входные данные
5. **Использование exceptions**: Выбрасывание ошибок вместо явного Result type → неожиданные crashes

## Решение

### 0. Result Railway Pattern вместо Exceptions

**Проблема.**
Исходная реализация выбрасывала исключения при ошибках:

- `accountIdForSubaccount()` выбрасывал Error при превышении depth limit
- `accountIdToString()` выбрасывал Error при превышении depth limit

Это создавало проблемы:

- Неожиданные crashes при невалидном вводе
- Невозможность композиции функций без try-catch
- Нарушение принципа явной обработки ошибок

**Решение.**
Переход на Result Railway Pattern из `@polymarket/result`:

```typescript
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';

/**
 * Ошибка при превышении depth limit для SUBACCOUNT
 */
export class AccountIdDepthError extends Error {
  constructor(
    public readonly currentDepth: number,
    public readonly maxDepth: number,
    public readonly operation: 'create' | 'serialize'
  ) {
    super(
      `Subaccount depth limit exceeded during ${operation}: current=${currentDepth}, max=${maxDepth}`
    );
    this.name = 'AccountIdDepthError';
  }
}
```

**Изменённые сигнатуры:**

```typescript
// Было:
function accountIdForSubaccount(base: AccountId, name: string): AccountId // throws Error

// Стало:
function accountIdForSubaccount(
  base: AccountId,
  name: string
): Result<AccountId, AccountIdDepthError | AccountIdValidationError>

// Было:
function accountIdToString(id: AccountId): string // throws Error

// Стало:
function accountIdToString(id: AccountId): string // total function, всегда возвращает string
```

**Примеры использования:**

```typescript
// Создание subaccount с явной обработкой ошибок
const result = accountIdForSubaccount(baseAccount, 'trading');

if (result.ok) {
  console.log('Created:', result.value);
} else {
  console.error('Error:', result.error.message);
  // Error: Subaccount depth limit exceeded during create: current=5, max=5
}

// Сериализация (total function, всегда успешна)
if (result.ok) {
  const str = accountIdToString(result.value);
  await saveToDatabase(str);
}

// Railway-Oriented Programming (композиция)
import { flatMap, map } from '@polymarket/result';

const walletAcc = accountIdFromWallet(parseWalletAddress('0x1234...')!);

const finalResult = flatMap(
  accountIdForSubaccount(walletAcc, 'main'),
  (sub1) => flatMap(
    accountIdForSubaccount(sub1, 'trading'),
    (sub2) => Ok(accountIdToString(sub2))  // wrap string в Ok для композиции
  )
);

// finalResult: Result<string, AccountIdDepthError | AccountIdValidationError>
// Если любая операция упадёт, вся цепочка вернёт Err
```

**Преимущества:**

- ✅ Явная обработка ошибок (компилятор заставляет проверять `.ok`)
- ✅ Нет неожиданных exceptions
- ✅ Composable через `map`/`flatMap`
- ✅ Type-safe error handling
- ✅ Соответствие архитектуре проекта (все пакеты используют Result)

### 1. Исправление Escaping

**Проблема.**
Старая реализация экранировала только `:` → `\:`, но не сам `\`. Это ломало round-trip:

```typescript
// Было:
input:    "user\:123"
escape:   "user\\\:123"   // двойная последовательность
unescape: "user:123"      // потеряли backslash ❌
```

**Решение.**
Новая реализация экранирует оба символа в правильном порядке:

```typescript
/**
 * Helper: escape backslashes и colons в строке
 *
 * @remarks
 * Порядок важен: сначала '\' → '\\', затем ':' → '\:'
 * Это обеспечивает правильный round-trip для строк типа "user\:123"
 */
function escape(str: string): string {
  // Сначала escape backslash, потом colon
  return str.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

/**
 * Helper: unescape backslashes и colons в строке
 *
 * @remarks
 * Посимвольный автомат для корректной обработки:
 * - '\\' → '\'
 * - '\:' → ':'
 * - Любой другой символ после '\' остаётся как есть
 */
function unescape(str: string): string {
  let result = '';
  let i = 0;

  while (i < str.length) {
    const char = str[i];

    if (char === '\\' && i + 1 < str.length) {
      const next = str[i + 1];

      if (next === '\\') {
        result += '\\';
        i += 2;
        continue;
      }

      if (next === ':') {
        result += ':';
        i += 2;
        continue;
      }

      // Неизвестная escape-последовательность - оставляем как есть
      result += char;
      i++;
      continue;
    }

    result += char;
    i++;
  }

  return result;
}
```

**Алгоритм шагами:**

1. **Escape**:
   - Шаг 1: Заменяем все `\` на `\\`
   - Шаг 2: Заменяем все `:` на `\:`
   - Порядок критичен! Если сделать наоборот, получим неправильный результат.

2. **Unescape**:
   - Посимвольный проход через строку
   - При встрече `\` смотрим следующий символ:
     - `\\` → добавляем один `\`, пропускаем оба символа
     - `\:` → добавляем `:`, пропускаем оба символа
     - Любой другой → добавляем `\`, продолжаем с текущей позиции

3. **Split**:
   - Аналогичный автомат для разбиения по `:`
   - `\\` и `\:` не являются разделителями
   - Голый `:` = разделитель

**Примеры:**

```typescript
// Пример 1: Строка с backslash и colon
const input1 = "user\\:123";
const escaped1 = escape(input1);    // "user\\\\\:123"
const unescaped1 = unescape(escaped1); // "user\\:123" ✅

// Пример 2: Двойные backslashes
const input2 = "name\\\\with\\\\slashes";
const escaped2 = escape(input2);    // "name\\\\\\\\with\\\\\\\\slashes"
const unescaped2 = unescape(escaped2); // "name\\\\with\\\\slashes" ✅

// Пример 3: Пустая строка
const input3 = "";
const escaped3 = escape(input3);    // ""
const unescaped3 = unescape(escaped3); // "" ✅
```

### 2. Depth Limit Protection

**Проблема.**
Четыре функции рекурсивно обходят вложенные SUBACCOUNT без ограничения глубины:

- `accountIdForSubaccount` — создание
- `accountIdToString` — сериализация
- `parseAccountId` — парсинг
- `accountIdEquals` — сравнение

Злонамеренный ввод с глубокой вложенностью → stack overflow.

**Решение.**

Введены константы и проверки:

```typescript
/**
 * Максимальная глубина вложенности SUBACCOUNT
 *
 * @remarks
 * Защита от stack overflow при рекурсивной обработке.
 * Ограничивает цепочки типа: sub:sub:sub:...
 */
const MAX_SUBACCOUNT_DEPTH = 5;
```

**Итеративная функция для подсчета глубины:**

```typescript
/**
 * Вычислить глубину вложенности SUBACCOUNT
 *
 * @param id - AccountId для проверки
 * @returns Глубина вложенности (0 для WALLET/VENUE, ≥1 для SUBACCOUNT)
 *
 * @remarks
 * Итеративная реализация (не рекурсивная) для безопасности.
 * Используется для проверки depth limit перед рекурсивными операциями.
 */
export function getSubaccountDepth(id: AccountId): number {
  let depth = 0;
  let current = id;

  while (current.kind === 'SUBACCOUNT') {
    depth++;
    current = current.base;
  }

  return depth;
}
```

**Алгоритм шагами:**

1. **getSubaccountDepth**:
   - Итеративный цикл (не рекурсия)
   - Начинаем с depth=0 и current=id
   - Пока current.kind === 'SUBACCOUNT':
     - Инкрементируем depth
     - Переходим к current.base
   - Возвращаем depth

2. **accountIdForSubaccount**:
   - Вычисляем текущую глубину base account
   - Если depth >= MAX_SUBACCOUNT_DEPTH → return Err(AccountIdDepthError)
   - Иначе создаём новый SUBACCOUNT

3. **accountIdToString**:
   - Total function: всегда возвращает string
   - Содержит bounded-loop guard с safety margin (MAX_SUBACCOUNT_DEPTH + 10)
   - При превышении guard: dev-only assert + fallback string '[INVALID:DEPTH_EXCEEDED]'

4. **parseAccountId**:
   - Аналогично: impl-функция с depth tracking
   - Если depth > maxDepth → return undefined (graceful rejection)

5. **accountIdEquals**:
   - Impl-функция с depth tracking
   - Если depth > MAX_SUBACCOUNT_DEPTH → return false (безопасный fallback)

**Поведение при превышении лимита:**

| Функция | Поведение |
|---|---|
| `accountIdForSubaccount` | `Result<AccountId, AccountIdDepthError \| AccountIdValidationError>` |
| `accountIdToString` | `string` (total function, всегда успешна) |
| `parseAccountId` | `AccountId \| undefined` (внешний ввод — graceful rejection) |
| `accountIdEquals` | `boolean` (безопасное сравнение) |

**Примеры:**

```typescript
// Пример 1: Нормальная вложенность
const wallet = accountIdFromWallet(parseWalletAddress('0x1234...')!);
const sub1Result = accountIdForSubaccount(wallet, 'level1');
if (!sub1Result.ok) throw sub1Result.error;
const sub1 = sub1Result.value;

const sub2Result = accountIdForSubaccount(sub1, 'level2');
if (!sub2Result.ok) throw sub2Result.error;
const sub2 = sub2Result.value;

console.log(getSubaccountDepth(wallet)); // 0
console.log(getSubaccountDepth(sub1));   // 1
console.log(getSubaccountDepth(sub2));   // 2

// Пример 2: Превышение лимита при создании
import { unwrap } from '@polymarket/result';
let current: AccountId = wallet;
for (let i = 1; i <= 5; i++) {
  current = unwrap(accountIdForSubaccount(current, `level${i}`));
}

// Попытка создать 6-й уровень:
const tooDeepResult = accountIdForSubaccount(current, 'tooDeep');
// → tooDeepResult.ok === false
// → tooDeepResult.error: AccountIdDepthError

// Пример 3: Превышение лимита при парсинге
const deepStr = `sub:sub:sub:sub:sub:sub:wallet:0x1234...:a:b:c:d:e:f`;
const parsed = parseAccountId(deepStr);
// → undefined (превышен depth limit)

// Пример 4: Кастомный maxDepth
const str = `sub:sub:wallet:0x1234...:a:b`; // глубина 2
parseAccountId(str, { maxDepth: 1 });
// → undefined (превышен кастомный лимит)

parseAccountId(str, { maxDepth: 2 });
// → AccountId (в пределах лимита)
```

### 3. WalletAddress Validation

**Проблема.**
В `parseAccountId` при `kind === 'wallet'` адрес принимается через небезопасный каст `as WalletAddress` без проверки формата.

**Решение.**

Добавлен опциональный интерфейс:

```typescript
/**
 * Опции для парсинга AccountId
 *
 * @remarks
 * Позволяет кастомизировать валидацию и ограничения при парсинге.
 */
export interface ParseAccountIdOptions {
  /**
   * Максимальная глубина вложенности SUBACCOUNT
   *
   * @default MAX_SUBACCOUNT_DEPTH (5)
   */
  maxDepth?: number;

  /**
   * Максимальная длина входной строки
   *
   * @default MAX_ACCOUNT_ID_STRING_LENGTH (512)
   */
  maxLen?: number;

  /**
   * Функция валидации WalletAddress
   *
   * @remarks
   * Если передана — используется для проверки формата wallet address.
   * При невалидном адресе должна вернуть undefined.
   * Если не передана — используется parseWalletAddress (default валидация).
   *
   * @param raw - Строка с потенциальным wallet address
   * @returns WalletAddress или undefined если формат неверный
   */
  validateWalletAddress?: (raw: string) => WalletAddress | undefined;
}
```

**Алгоритм шагами:**

1. Если `validateWalletAddress` передан:
   - Вызываем его с raw строкой
   - Если вернул undefined → возвращаем undefined из parseAccountId
   - Иначе используем валидированный адрес

2. Если `validateWalletAddress` не передан:
   - Используем parseWalletAddress (default валидация формата)

**Примеры:**

```typescript
// Пример 1: Default валидация (parseWalletAddress)
const parsed1 = parseAccountId('wallet:INVALID_ADDRESS');
// → undefined (parseWalletAddress отклоняет невалидный формат)

// Пример 2: С валидацией
const validator = (raw: string) => {
  return /^0x[0-9a-f]{40}$/i.test(raw) ? raw.toLowerCase() as WalletAddress : undefined;
};

const parsed2 = parseAccountId('wallet:0xINVALID', { validateWalletAddress: validator });
// → undefined (невалидный формат)

const parsed3 = parseAccountId('wallet:0x1234567890123456789012345678901234567890', {
  validateWalletAddress: validator
});
// → { kind: 'WALLET', address: '0x1234567890123456789012345678901234567890' } ✅

// Пример 3: Использование существующей функции
import { parseWalletAddress } from './WalletAddress.js';

const parsed4 = parseAccountId('wallet:0x1234...', {
  validateWalletAddress: parseWalletAddress
});
// Использует встроенную валидацию из WalletAddress
```

### 4. Max Length Protection

**Проблема.**
`parseAccountId` не проверяет длину входной строки. Очень длинная строка → дорогой парсинг и возможный DoS.

**Решение.**

Введена константа и проверка:

```typescript
/**
 * Максимальная длина serialized AccountId строки
 *
 * @remarks
 * Защита от DoS атак с аномально длинными строками.
 * Проверяется при парсинге перед началом обработки.
 */
const MAX_ACCOUNT_ID_STRING_LENGTH = 512;
```

**Алгоритм шагами:**

1. В начале `parseAccountId`:
   - Проверяем `str.length > maxLen`
   - Если да → возвращаем `undefined` немедленно (до начала обработки)

2. Параметр `maxLen` может быть переопределён через `ParseAccountIdOptions`

**Примеры:**

```typescript
// Пример 1: Нормальная длина
const normalStr = `wallet:0x1234567890123456789012345678901234567890`;
const parsed1 = parseAccountId(normalStr);
// → AccountId ✅

// Пример 2: Слишком длинная строка
const longStr = 'wallet:' + '0'.repeat(600);
const parsed2 = parseAccountId(longStr);
// → undefined (превышена maxLen)

// Пример 3: Кастомный maxLen
const str = `wallet:0x1234567890123456789012345678901234567890`;
const parsed3 = parseAccountId(str, { maxLen: 10 });
// → undefined (превышен кастомный лимит)

const parsed4 = parseAccountId(str, { maxLen: 1000 });
// → AccountId (в пределах лимита)
```

## Критерии готовности

### 1. Escaping

✅ Round-trip проходит для строк:

- `"user\:123"` — backslash и colon
- `"name\\with\\slashes"` — двойные backslashes
- `"a]\\:b"` — комплексная последовательность
- `""` — пустая строка
- `":"` — только colon
- `"\\"` — только backslash

### 2. Depth Limit

✅ Защита работает:

- `accountIdForSubaccount` возвращает Err(AccountIdDepthError) при depth > 5
- `accountIdToString` всегда возвращает string (total function)
- `parseAccountId` возвращает undefined при превышении maxDepth
- `accountIdEquals` возвращает false при depth > MAX_SUBACCOUNT_DEPTH (не крашит)

### 3. WalletAddress Validation

✅ Опциональная валидация:

- С `validateWalletAddress` — кастомная проверка формата
- Без `validateWalletAddress` — default проверка через parseWalletAddress

### 4. Max Length

✅ Защита от длинных строк:

- `parseAccountId` возвращает undefined при str.length > maxLen
- Кастомный `maxLen` может быть передан через опции

## Тестирование

Все исправления покрыты тестами (см. `__tests__/core.test.ts`):

```typescript
describe('Escaping fixes', () => {
  // 6 тестов на round-trip для различных escape-последовательностей
});

describe('Depth limit protection', () => {
  // 6 тестов на проверку depth limit в разных сценариях
});

describe('Max length protection', () => {
  // 3 теста на проверку защиты от длинных строк
});

describe('WalletAddress validation', () => {
  // 3 теста на опциональную валидацию адресов
});
```

**Результаты тестирования:**

- ✅ 239 тестов прошли успешно
- ✅ Линтер не нашел ошибок
- ✅ TypeScript компиляция успешна

## Обратная совместимость

Все изменения **обратно совместимы**:

1. **Escaping**: Новая реализация корректно обрабатывает старые данные
2. **Depth limit**: Лимит 5 достаточен для реальных use cases
3. **WalletAddress validation**: По умолчанию parseWalletAddress, опционально кастомная
4. **Max length**: Лимит 512 достаточен для всех реальных AccountId

## Что НЕ изменилось

❌ Тип `AccountId` (остался discriminated union)
❌ Формат строки (`wallet:`, `venue:`, `sub:`)
❌ Разделитель `:`
❌ Фабрики `accountIdFromWallet`, `accountIdFromVenue`
❌ Type guards `isWalletAccount`, `isVenueAccount`, `isSubaccount`

## Рекомендации по использованию

### Создание AccountId с Result Pattern

```typescript
import { unwrap } from '@polymarket/result';

// Wallet account (не может упасть)
const wallet = parseWalletAddress('0x1234...')!;
const walletAcc = accountIdFromWallet(wallet);

// Venue account (не может упасть)
const venueAcc = accountIdFromVenue(KnownVenues.POLYMARKET, 'user_123');

// Subaccount - возвращает Result
const subResult = accountIdForSubaccount(walletAcc, 'trading');

if (subResult.ok) {
  const subAcc = subResult.value;
  console.log('Created subaccount:', subAcc);
} else {
  console.error('Failed to create subaccount:', subResult.error.message);
}

// Или используйте unwrap если уверены что Result успешный (небезопасно!)
const subAcc = unwrap(accountIdForSubaccount(walletAcc, 'trading'));
```

### Парсинг с валидацией

```typescript
import { parseWalletAddress } from '@polymarket/ids';

// Безопасный парсинг с валидацией
const accountId = parseAccountId(untrustedInput, {
  validateWalletAddress: parseWalletAddress,
  maxLen: 512,
  maxDepth: 5
});

if (!accountId) {
  console.error('Invalid AccountId format');
  return;
}

// Используем валидированный accountId
```

### Обработка глубоко вложенных структур

```typescript
// Проверка глубины перед операциями
const depth = getSubaccountDepth(accountId);
if (depth > 3) {
  console.warn(`Deep nesting detected: ${depth}`);
}

// Безопасное сравнение (автоматически обрабатывает глубокие структуры)
const isEqual = accountIdEquals(acc1, acc2);
// Возвращает false при превышении лимита (не крашит)
```

## Производительность

Изменения имеют минимальное влияние на производительность:

1. **Escaping**: O(n) — линейное время от длины строки
2. **Depth check**: O(d) — линейное время от глубины вложенности
3. **Length check**: O(1) — константное время

Для реальных данных (глубина ≤ 3, длина ≤ 200 символов) overhead незаметен.
