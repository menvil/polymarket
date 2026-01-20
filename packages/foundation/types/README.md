# @polymarket/types

Фундаментальные типы для Polymarket trading system. Railway-Oriented Programming через Result<T, E>.

## ✨ Ключевые особенности

- ✅ **Zero dependencies** - никаких зависимостей в production
- ✅ **Type-safe обработка ошибок** - компилятор заставляет обрабатывать ошибки
- ✅ **Railway-Oriented Programming** - элегантная композиция операций
- ✅ **Функциональный подход** - immutable, composable, предсказуемо
- ✅ **Plain objects** - легкая сериализация через JSON.stringify
- ✅ **100% покрытие тестами** - все функции полностью протестированы

## 📦 Установка

```bash
npm install @polymarket/types
```

## 🚀 Быстрый старт

Пакет предоставляет **три стиля использования** - выбирайте тот, который вам удобнее!

### Стиль 1: Функциональный (Plain Objects)

Идеален для сериализации, tree-shaking и функционального подхода.

```typescript
import { Result, Ok, Err, map, flatMap } from '@polymarket/types';

function divide(a: number, b: number): Result<number, string> {
  if (b === 0) {
    return Err('Деление на ноль');
  }
  return Ok(a / b);
}

const result = divide(10, 2);

if (result.ok) {
  console.log('Результат:', result.value); // 5
} else {
  console.error('Ошибка:', result.error);
}

// Композиция через функции
const doubled = map(result, x => x * 2);
const chained = flatMap(divide(10, 2), x => divide(x, 5));
```

### Стиль 2: OOP (Method Chaining)

Идеален для читабельных цепочек операций.

```typescript
import { OkChain, ErrChain } from '@polymarket/types';

// Элегантная цепочка методов
const result = OkChain(10)
  .map(x => x / 2)      // 5
  .map(x => x * 3)      // 15
  .map(x => x + 1)      // 16
  .unwrapOr(0);         // 16

console.log('Результат:', result); // 16

// Обработка ошибок
const safe = OkChain(10)
  .flatMap(x => x > 0 ? OkChain(x) : ErrChain('Отрицательное число'))
  .map(x => Math.sqrt(x))
  .match({
    ok: value => `Успех: ${value}`,
    err: error => `Ошибка: ${error}`
  });
```

### Стиль 3: Async (AsyncResultChain)

Идеален для асинхронных операций с Result.

```typescript
import { AsyncResult } from '@polymarket/types';

// Async операции с автоматической обработкой ошибок
async function fetchUser(id: number) {
  const user = await AsyncResult.from(getUserFromAPI(id))
    .mapAsync(async user => enrichUserData(user))
    .flatMapAsync(async user => validateUser(user))
    .map(user => ({ ...user, normalized: true }))
    .unwrapOr({ id: 0, name: 'Guest' });

  return user;
}

// Короткий синтаксис с R alias
import { R } from '@polymarket/types';

const result = await R.from(fetchData())
  .map(data => processData(data))
  .unwrapOr(defaultValue);
```

### Гибридный подход

Оба стиля полностью совместимы!

```typescript
import { Ok, Err, OkChain, toChain } from '@polymarket/types';

// Функция возвращает plain object
function divide(a: number, b: number): Result<number, string> {
  if (b === 0) return Err('Деление на ноль');
  return Ok(a / b);
}

// Используем с method chaining
const result = toChain(divide(10, 2))
  .map(x => x * 2)
  .map(x => x + 1)
  .unwrap(); // 11

// Или создаём chain и конвертируем в plain object
const chain = OkChain(42).map(x => x * 2);
const plain = chain.toResult(); // { ok: true, value: 84 }
```

### Использование с @polymarket/errors

```typescript
import { Result, Ok, Err } from '@polymarket/types';
import { InvalidPriceError } from '@polymarket/errors';

function createPrice(value: number): Result<number, InvalidPriceError> {
  if (value < 0.01 || value > 0.99) {
    return Err(new InvalidPriceError(value));
  }
  return Ok(value);
}

const priceResult = createPrice(0.65);

if (priceResult.ok) {
  console.log('Цена:', priceResult.value);
} else {
  console.error('Ошибка:', priceResult.error.message);
  console.error('Контекст:', priceResult.error.context);
}
```

## 📖 API

### Result<T, E>

Основной тип, представляющий либо успех (Ok), либо ошибку (Err).

```typescript
type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

### Ok(value)

Создает успешный Result.

```typescript
const result = Ok(42);
// result: { ok: true, value: 42 }
```

### Err(error)

Создает Result с ошибкой.

```typescript
const result = Err('Что-то пошло не так');
// result: { ok: false, error: 'Что-то пошло не так' }
```

### isOk(result)

Type guard для проверки успешного Result.

```typescript
const result = Ok(42);

if (isOk(result)) {
  console.log(result.value); // TypeScript знает что это Ok
}
```

### isErr(result)

Type guard для проверки Result с ошибкой.

```typescript
const result = Err('error');

if (isErr(result)) {
  console.error(result.error); // TypeScript знает что это Err
}
```

### map(result, fn)

Трансформирует значение внутри Ok. Пропускает Err.

```typescript
const result = Ok(5);
const doubled = map(result, x => x * 2);
// doubled: Ok(10)

const error = Err('упс');
const mapped = map(error, x => x * 2);
// mapped: Err('упс') - fn не вызывается
```

### flatMap(result, fn)

Цепочка операций, возвращающих Result (monadic bind).

```typescript
const divide = (a: number, b: number): Result<number, string> =>
  b === 0 ? Err('Деление на ноль') : Ok(a / b);

const result = flatMap(
  divide(10, 2),     // Ok(5)
  x => divide(x, 0)  // Err('Деление на ноль')
);
// result: Err('Деление на ноль')
```

### mapErr(result, fn)

Трансформирует ошибку внутри Err. Пропускает Ok.

```typescript
const result = Err({ code: 404, message: 'Не найдено' });
const mapped = mapErr(result, err => err.message);
// mapped: Err('Не найдено')
```

### combine(results)

Объединяет массив Results в Result массива.

```typescript
const results = [Ok(1), Ok(2), Ok(3)];
const combined = combine(results);
// combined: Ok([1, 2, 3])

const withError = [Ok(1), Err('упс'), Ok(3)];
const failed = combine(withError);
// failed: Err('упс')
```

### unwrap(result)

Извлекает значение из Ok. **Небезопасно** - выбрасывает исключение если Err.

```typescript
const result = Ok(42);
const value = unwrap(result); // 42

const error = Err('упс');
const value = unwrap(error); // выбрасывает Error
```

### unwrapOr(result, defaultValue)

Извлекает значение из Ok или возвращает значение по умолчанию.

```typescript
const result = Err('упс');
const value = unwrapOr(result, 42); // 42

const success = Ok(10);
const value = unwrapOr(success, 42); // 10
```

## 🔗 ResultChain API (Method Chaining)

Для удобства работы с цепочками методов доступен OOP-стиль через `ResultChain`.

### OkChain(value)

Создает ResultChain с успешным значением.

```typescript
const result = OkChain(42);
// поддерживает method chaining
```

### ErrChain(error)

Создает ResultChain с ошибкой.

```typescript
const result = ErrChain('Ошибка');
```

### toChain(result)

Конвертирует plain object Result в ResultChain.

```typescript
const plain = Ok(42);
const chain = toChain(plain);
```

### .map(fn)

Трансформирует значение с method chaining.

```typescript
const result = OkChain(5)
  .map(x => x * 2)
  .map(x => x + 1);
// result.unwrap() === 11
```

### .flatMap(fn)

Цепочка Result-возвращающих операций.

```typescript
const divide = (a: number, b: number): Result<number, string> =>
  b === 0 ? Err('Деление на ноль') : Ok(a / b);

const result = OkChain(10)
  .flatMap(x => divide(x, 2))
  .flatMap(x => divide(x, 5));
// result.unwrap() === 1
```

### .flatMapChain(fn)

Цепочка операций с ResultChain.

```typescript
const result = OkChain(10)
  .flatMapChain(x => OkChain(x * 2))
  .flatMapChain(x => OkChain(x + 1));
// result.unwrap() === 21
```

### .mapErr(fn)

Трансформирует ошибку.

```typescript
const result = ErrChain({ code: 404, message: 'Не найдено' })
  .mapErr(err => err.message);
// result.unwrapErr() === 'Не найдено'
```

### .tap(fn) / .tapErr(fn)

Выполняет side effects без изменения значения.

```typescript
const result = OkChain(42)
  .tap(value => console.log('Значение:', value))
  .map(x => x * 2);

const error = ErrChain('error')
  .tapErr(err => console.error('Ошибка:', err));
```

### .match({ ok, err })

Pattern matching для Result.

```typescript
const message = OkChain(42).match({
  ok: value => `Успех: ${value}`,
  err: error => `Ошибка: ${error}`
});
// message === 'Успех: 42'
```

### .toResult()

Конвертирует обратно в plain object Result.

```typescript
const chain = OkChain(42).map(x => x * 2);
const plain = chain.toResult();
// plain: { ok: true, value: 84 }
```

### .unwrap() / .unwrapOr(default) / .unwrapErr()

Извлечение значений (аналогично функциям).

```typescript
OkChain(42).unwrap(); // 42
ErrChain('error').unwrapOr(0); // 0
ErrChain('error').unwrapErr(); // 'error'
```

### .isOk() / .isErr()

Проверка типа Result.

```typescript
OkChain(42).isOk(); // true
ErrChain('error').isErr(); // true
```

### R alias (короткий синтаксис)

Короткие алиасы для быстрого создания ResultChain.

```typescript
import { R } from '@polymarket/types';

// Вместо OkChain(42)
const result = R.ok(42);

// Вместо ErrChain('error')
const error = R.err('error');

// Вместо toChain(result)
const chain = R.from(Ok(42));
```

### .and(other)

Возвращает `other` если текущий Result успешный, иначе первую ошибку.

```typescript
const result = OkChain(2)
  .and(Ok(3))
  .unwrap(); // 3

const error = ErrChain('first error')
  .and(Ok(5))
  .unwrapErr(); // 'first error'
```

### .or(other)

Возвращает текущий Result если он успешный, иначе `other`.

```typescript
const result = OkChain(10)
  .or(Ok(20))
  .unwrap(); // 10

const fallback = ErrChain('error')
  .or(Ok(42))
  .unwrap(); // 42
```

### .flatten()

Разворачивает вложенные Result<Result<T, E>, E> в Result<T, E>.

```typescript
const nested = OkChain(Ok(42));
const flattened = nested.flatten().unwrap(); // 42

const nestedErr = OkChain(Err('inner error'));
const result = nestedErr.flatten().unwrapErr(); // 'inner error'
```

### .expect(message)

Извлекает значение с кастомным сообщением об ошибке.

```typescript
const value = OkChain(42).expect('Should have value'); // 42

// Выбрасывает Error с сообщением: "Should have value: error"
ErrChain('error').expect('Should have value');
```

### .expectErr(message)

Извлекает ошибку с кастомным сообщением.

```typescript
const error = ErrChain('oops').expectErr('Should have error'); // 'oops'

// Выбрасывает Error с сообщением: "Should have error: expected Err but got Ok(42)"
OkChain(42).expectErr('Should have error');
```

### .andThen(fn) / .orElse(fn)

Rust-style алиасы для flatMap и recover.

```typescript
// andThen - то же что flatMap
const divide = (a: number, b: number): Result<number, string> =>
  b === 0 ? Err('Division by zero') : Ok(a / b);

const result = OkChain(10)
  .andThen(x => divide(x, 2))
  .andThen(x => divide(x, 5))
  .unwrap(); // 1

// orElse - восстановление после ошибки
const recovered = ErrChain('error')
  .orElse(err => Ok(0))
  .unwrap(); // 0
```

### Helper функции

#### fromPromise(promise, onError)

Конвертирует Promise в Result, ловя rejections.

```typescript
import { fromPromise } from '@polymarket/types';

const result = await fromPromise(
  fetch('/api/user'),
  (err) => `Network error: ${err}`
);

if (result.ok) {
  console.log(result.value);
} else {
  console.error(result.error); // "Network error: ..."
}
```

#### fromNullable(value, error)

Конвертирует nullable значение в Result.

```typescript
import { fromNullable } from '@polymarket/types';

const result = fromNullable(maybeUser, 'User not found');

if (result.ok) {
  console.log(result.value); // User exists
} else {
  console.error(result.error); // "User not found"
}
```

#### fromThrowable(fn, onError)

Оборачивает функцию с exceptions в Result-возвращающую функцию.

```typescript
import { fromThrowable } from '@polymarket/types';

const safeParseJSON = fromThrowable(
  JSON.parse,
  (err) => `Invalid JSON: ${err}`
);

const result = safeParseJSON('{"valid": true}');
if (result.ok) {
  console.log(result.value); // { valid: true }
}

const invalid = safeParseJSON('not json');
if (!invalid.ok) {
  console.error(invalid.error); // "Invalid JSON: ..."
}
```

## 🔗 AsyncResultChain API (Async Operations)

Для работы с асинхронными операциями используйте `AsyncResultChain`.

### AsyncResult.from(promise)

Создает AsyncResultChain из Promise<Result<T, E>>.

```typescript
import { AsyncResult } from '@polymarket/types';

const result = await AsyncResult.from(fetchUser('123'))
  .mapAsync(user => enrichUserData(user))
  .unwrap();
```

### AsyncResult.ok(promise)

Создает AsyncResultChain из Promise<T>.

```typescript
const result = await AsyncResult.ok(Promise.resolve(42))
  .map(x => x * 2)
  .unwrap(); // 84
```

### AsyncResult.err(error)

Создает AsyncResultChain с ошибкой.

```typescript
const error = await AsyncResult.err('error')
  .unwrapErr(); // 'error'
```

### .mapAsync(fn) / .map(fn)

Трансформирует значение (async или sync).

```typescript
const result = await AsyncResult.ok(Promise.resolve(5))
  .mapAsync(async x => x * 2)  // async transform
  .map(x => x + 1)               // sync transform
  .unwrap(); // 11
```

### .flatMapAsync(fn) / .flatMap(fn)

Цепочка async/sync Result-возвращающих операций.

```typescript
const fetchUser = async (id: number): Promise<Result<User, string>> => {
  // ...
};

const result = await AsyncResult.ok(Promise.resolve(123))
  .flatMapAsync(fetchUser)
  .flatMap(user => validateUser(user))
  .unwrap();
```

### .andThen(fn)

Rust-style алиас для flatMapAsync.

```typescript
const result = await AsyncResult.ok(Promise.resolve(123))
  .andThen(fetchUser)
  .andThen(validateUser)
  .unwrap();
```

### .orElseAsync(fn) / .orElse(fn)

Восстановление после ошибки (async или sync).

```typescript
const result = await AsyncResult.from(fetchUser(0))
  .orElseAsync(async err => {
    return Ok({ id: 0, name: 'Guest' });
  })
  .unwrap();
```

### .tap(fn) / .tapErr(fn)

Side effects для async операций.

```typescript
await AsyncResult.ok(Promise.resolve(42))
  .tap(value => console.log('Value:', value))
  .tapErr(err => console.error('Error:', err));
```

### .match({ ok, err })

Pattern matching для async Result.

```typescript
const message = await AsyncResult.ok(Promise.resolve(42)).match({
  ok: value => `Success: ${value}`,
  err: error => `Error: ${error}`
});
```

### .unwrap() / .unwrapOr() / .unwrapErr()

Извлечение значений из async Result.

```typescript
const value = await AsyncResult.ok(Promise.resolve(42)).unwrap(); // 42
const fallback = await AsyncResult.err('error').unwrapOr(0); // 0
const error = await AsyncResult.err('error').unwrapErr(); // 'error'
```

### .expect(message) / .expectErr(message)

Кастомные сообщения для async Result.

```typescript
const value = await AsyncResult.ok(Promise.resolve(42))
  .expect('Should be ok'); // 42

await AsyncResult.err('oops')
  .expect('Should be ok'); // Throws: "Should be ok: oops"
```

## 💡 Примеры использования

### Обработка ошибок без exceptions

```typescript
import { Result, Ok, Err, flatMap } from '@polymarket/types';

interface User {
  id: string;
  balance: number;
}

function getUser(id: string): Result<User, string> {
  if (id === 'invalid') {
    return Err('Пользователь не найден');
  }
  return Ok({ id, balance: 100 });
}

function checkBalance(user: User, amount: number): Result<User, string> {
  if (user.balance < amount) {
    return Err('Недостаточно средств');
  }
  return Ok(user);
}

function deductBalance(user: User, amount: number): Result<User, string> {
  return Ok({ ...user, balance: user.balance - amount });
}

// Композиция операций
const result = flatMap(
  flatMap(
    getUser('user-1'),
    user => checkBalance(user, 50)
  ),
  user => deductBalance(user, 50)
);

if (result.ok) {
  console.log('Новый баланс:', result.value.balance);
} else {
  console.error('Ошибка:', result.error);
}
```

### Railway-Oriented Programming

```typescript
// Все операции возвращают Result
// Если любая операция упадет, цепочка останавливается автоматически

// Важно: flatMap принимает ровно 2 аргумента: (result, fn)
// Для композиции нескольких операций используйте вложенные вызовы или chaining

// Вариант 1: Функциональный подход с явными шагами
const step1 = validatePrice(price); // Result<Price, InvalidPriceError>
const step2 = flatMap(
  step1,
  validatedPrice => validateQuantity(qty, validatedPrice) // Result<Quantity, InvalidQuantityError>
);
const step3 = flatMap(
  step2,
  validatedQty => checkMarket(marketId, validatedQty) // Result<Market, MarketError>
);
const orderResult1 = flatMap(
  step3,
  validatedMarket => placeOrder(validatedMarket) // Result<Order, OrderError>
);

// Вариант 2: Вложенные flatMap (компактный функциональный стиль)
const orderResult1b = flatMap(
  flatMap(
    flatMap(
      validatePrice(price),
      validatedPrice => validateQuantity(qty, validatedPrice)
    ),
    validatedQty => checkMarket(marketId, validatedQty)
  ),
  validatedMarket => placeOrder(validatedMarket)
);

// Вариант 3: Method chaining (рекомендуется, наиболее читабельно)
const orderResult2 = toChain(validatePrice(price))
  .flatMap(validatedPrice => validateQuantity(qty, validatedPrice))
  .flatMap(validatedQty => checkMarket(marketId, validatedQty))
  .flatMap(validatedMarket => placeOrder(validatedMarket))
  .toResult();

// Одна проверка в конце (используем любой из вариантов)
if (orderResult1.ok) {
  console.log('Ордер размещен:', orderResult1.value.id);
} else {
  // TypeScript знает все возможные типы ошибок
  const error = orderResult1.error;

  if (error instanceof InvalidPriceError) {
    console.log('Некорректная цена:', error.context);
  } else if (error instanceof MarketError) {
    console.log('Ошибка рынка:', error.message);
  }
  // ... обработка других ошибок
}
```

### Type-Safe обработка ошибок

```typescript
import { Result, Ok, Err } from '@polymarket/types';
import {
  UserNotFoundError,
  InsufficientFundsError,
  MarketClosedError
} from '@polymarket/errors';

// TypeScript знает ВСЕ возможные ошибки
function placeOrder(): Result<
  Order,
  | UserNotFoundError
  | InsufficientFundsError
  | MarketClosedError
> {
  // ...
}

const result = await placeOrder();

if (!result.ok) {
  // Exhaustive checking - компилятор гарантирует что все случаи обработаны
  const error = result.error;

  if (error instanceof UserNotFoundError) {
    return { code: 404, message: 'Пользователь не найден' };
  } else if (error instanceof InsufficientFundsError) {
    return { code: 400, message: 'Недостаточно средств' };
  } else if (error instanceof MarketClosedError) {
    return { code: 400, message: 'Рынок закрыт' };
  }

  // TypeScript знает что все случаи обработаны
}
```

## 🎯 Зачем Result<T, E>?

### Проблема: Исключения невидимы

```typescript
// ❌ Какие ошибки может выбросить? TypeScript не знает!
async function getUser(id: string): Promise<User> {
  // Может выбросить: UserNotFoundError, DatabaseError, NetworkError...
  // Но TypeScript не помогает!
}

// Легко забыть try/catch
const user = await getUser('123'); // Может упасть!
```

### Решение: Ошибки в типах

```typescript
// ✅ Все ошибки видны в типе
function getUser(id: string): Result<User, UserNotFoundError> {
  // ...
}

const result = await getUser('123');

// ❌ Забыли проверить? TypeScript ОШИБКА!
console.log(result.value);
//               ^^^^^ Property 'value' does not exist

// ✅ Правильно - сначала проверка
if (result.ok) {
  console.log(result.value); // TypeScript знает что это безопасно
}
```

## 📊 Сравнение подходов

| Аспект | try/catch | null/undefined | **Result<T, E>** |
|--------|-----------|----------------|------------------|
| **Явность** | ❌ Скрыто | ⚠️ Неясно | ✅ В типах |
| **Композиция** | ❌ Нет | ❌ Нет | ✅ map/flatMap |
| **Type safety** | ❌ Нет | ⚠️ Частично | ✅ Полная |
| **Контекст ошибки** | ✅ Есть | ❌ Нет | ✅ Есть |
| **Помощь компилятора** | ❌ Нет | ⚠️ Null checks | ✅ Да |
| **Short-circuit** | ✅ throw | ❌ Вручную | ✅ Автоматически |

## 🧪 Тестирование

```bash
npm test
```

Пакет включает полный набор тестов, покрывающих все функции и edge cases.

## 🏗️ Архитектура

```
@polymarket/types                      # Layer 0 (Foundation)
    ↓ используется в
@polymarket/value-objects              # Layer 1 (Domain Primitives)
@polymarket/entities                   # Layer 2 (Domain Core)
    ↓ используются в
Application Layer                      # Layer 3
```

## 📝 Best Practices

### 1. Используйте Result для ожидаемых ошибок

```typescript
// ✅ Хорошо - валидация может упасть (ожидаемо)
function validatePrice(price: number): Result<Price, ValidationError> {
  // ...
}

// ❌ Плохо - программные ошибки должны выбрасывать исключения
function getArrayElement(arr: number[], index: number): Result<number, Error> {
  // Не используйте Result для out-of-bounds - это баг!
}
```

### 2. Предпочитайте pattern matching вместо unwrap

```typescript
// ✅ Хорошо - безопасно
if (result.ok) {
  console.log(result.value);
} else {
  console.error(result.error);
}

// ❌ Избегайте - может выбросить исключение
const value = unwrap(result);
```

### 3. Используйте map/flatMap для композиции

```typescript
// ✅ Хорошо - чистая композиция
const result = flatMap(
  getUser(id),
  user => checkBalance(user, amount)
);

// ❌ Избегайте - вложенные проверки
const userResult = getUser(id);
if (userResult.ok) {
  const balanceResult = checkBalance(userResult.value, amount);
  if (balanceResult.ok) {
    // ...
  }
}
```

## 📄 License

MIT

## 🤝 Связанные пакеты

- `@polymarket/errors` - Типы ошибок для trading системы
- `@polymarket/value-objects` - Domain value objects использующие Result
- `@polymarket/entities` - Domain entities использующие Result