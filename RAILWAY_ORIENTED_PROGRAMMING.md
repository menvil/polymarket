# Railway-Oriented Programming (ROP) и Result<T, E>

## 🚂 Что такое Railway-Oriented Programming?

**Railway-Oriented Programming** - это паттерн обработки ошибок, где поток выполнения представляется как **железная дорога с двумя путями**:

```
Success Track (зеленый путь):  ──────────────────────────────►
                                 ok   →   ok   →   ok   →  ok

Error Track (красный путь):    ──────────────────────────────►
                                err  →  err  →  err  →  err
```

**Ключевая идея:** Как только происходит ошибка, мы переходим на "красный путь" и все последующие операции автоматически пропускаются.

**Автор:** Scott Wlaschin (F# for Fun and Profit)

---

## 🎯 Проблема: Traditional Error Handling

### Подход 1: Try/Catch (Императивный)

```typescript
// ❌ Проблемы:
// 1. Скрытые исключения (не видны в сигнатуре)
// 2. Глубокая вложенность try/catch
// 3. Легко забыть обработать ошибку
// 4. Нет композиции операций

async function placeOrder(userId: string, marketId: string, amount: number) {
  try {
    // Получаем пользователя
    const user = await getUser(userId);
    if (!user) {
      throw new Error('User not found');
    }

    try {
      // Проверяем баланс
      const balance = await getBalance(user.id);
      if (balance < amount) {
        throw new Error('Insufficient funds');
      }

      try {
        // Получаем рынок
        const market = await getMarket(marketId);
        if (!market) {
          throw new Error('Market not found');
        }

        if (!market.isActive) {
          throw new Error('Market closed');
        }

        try {
          // Размещаем ордер
          const order = await createOrder(user.id, market.id, amount);
          return order;
        } catch (error) {
          console.error('Failed to create order:', error);
          throw error;
        }
      } catch (error) {
        console.error('Market error:', error);
        throw error;
      }
    } catch (error) {
      console.error('Balance error:', error);
      throw error;
    }
  } catch (error) {
    console.error('User error:', error);
    throw error;
  }
}

// Вызов - не видно какие ошибки могут быть
const order = await placeOrder('user-1', 'market-1', 100);
// ❌ TypeScript не заставляет обработать ошибки!
```

**Проблемы:**
- 😱 "Pyramid of Doom" - вложенность try/catch
- 🤷 Ошибки не видны в типах - компилятор не помогает
- 🐛 Легко забыть обработать ошибку
- 💥 Исключения "взрывают" поток выполнения
- 🚫 Нет композиции - трудно переиспользовать

---

### Подход 2: Nullable (null/undefined)

```typescript
// ❌ Проблемы:
// 1. Потеря информации об ошибке
// 2. Нет контекста - почему null?
// 3. null checks everywhere

async function placeOrder(userId: string, marketId: string, amount: number): Promise<Order | null> {
  const user = await getUser(userId);
  if (!user) return null; // Почему null? User не найден? Ошибка БД?

  const balance = await getBalance(user.id);
  if (!balance || balance < amount) return null; // Что именно не так?

  const market = await getMarket(marketId);
  if (!market) return null;
  if (!market.isActive) return null;

  const order = await createOrder(user.id, market.id, amount);
  return order;
}

// Использование
const order = await placeOrder('user-1', 'market-1', 100);
if (order === null) {
  // ❌ Не знаем что пошло не так!
  console.log('Failed... but why?');
}
```

**Проблемы:**
- 🤷 Потеря информации - почему null?
- 🚫 Нет контекста ошибки
- 💔 Множество null checks

---

## ✅ Решение: Result<T, E> Type

**Result<T, E>** - это тип, который явно представляет **либо успех, либо ошибку**:

```typescript
type Result<T, E> = Ok<T> | Err<E>
```

**Где:**
- `T` - тип успешного результата
- `E` - тип ошибки

**Визуализация:**
```
Result<User, UserNotFoundError>
   │
   ├─ Ok<User>                  ← успех, содержит User
   │     { ok: true, value: User }
   │
   └─ Err<UserNotFoundError>    ← ошибка, содержит Error
         { ok: false, error: UserNotFoundError }
```

---

## 📦 Реализация Result<T, E>

### Базовые типы

```typescript
/**
 * Result type - либо успех, либо ошибка
 *
 * @remarks
 * Функциональный подход к обработке ошибок.
 * Вместо throw/catch - явный возврат результата.
 *
 * @example
 * ```typescript
 * function divide(a: number, b: number): Result<number, string> {
 *   if (b === 0) {
 *     return Result.err('Division by zero');
 *   }
 *   return Result.ok(a / b);
 * }
 * ```
 */
export type Result<T, E> = Ok<T> | Err<E>;

/**
 * Успешный результат
 */
export class Ok<T> {
  public readonly ok: true = true;
  public readonly value: T;

  constructor(value: T) {
    this.value = value;
  }

  public isOk(): this is Ok<T> {
    return true;
  }

  public isErr(): this is never {
    return false;
  }
}

/**
 * Результат с ошибкой
 */
export class Err<E> {
  public readonly ok: false = false;
  public readonly error: E;

  constructor(error: E) {
    this.error = error;
  }

  public isOk(): this is never {
    return false;
  }

  public isErr(): this is Err<E> {
    return true;
  }
}

/**
 * Фабрика для создания Result
 */
export const Result = {
  ok<T>(value: T): Result<T, never> {
    return new Ok(value);
  },

  err<E>(error: E): Result<never, E> {
    return new Err(error);
  },
};
```

---

## 🚂 Railway-Oriented: Композиция операций

### map() - преобразование значения

```typescript
export class Ok<T> {
  /**
   * Применяет функцию к значению (если Ok)
   *
   * @remarks
   * Если Result - Ok, применяет функцию к value.
   * Если Result - Err, пропускает операцию (остается на "красном пути").
   *
   * @example
   * ```typescript
   * const result = Result.ok(5)
   *   .map(x => x * 2)     // Ok(10)
   *   .map(x => x + 1);    // Ok(11)
   *
   * const error = Result.err('error')
   *   .map(x => x * 2)     // Err('error') - функция не вызывается!
   *   .map(x => x + 1);    // Err('error')
   * ```
   */
  public map<U>(fn: (value: T) => U): Result<U, never> {
    return new Ok(fn(this.value));
  }
}

export class Err<E> {
  /**
   * Для Err - map ничего не делает
   * Просто возвращает ошибку дальше ("красный путь")
   */
  public map<U>(_fn: (value: never) => U): Result<U, E> {
    return this as unknown as Err<E>;
  }
}
```

**Визуализация map:**
```
Ok(5) ─map(x => x * 2)→ Ok(10) ─map(x => x + 1)→ Ok(11)  ✅

Err(e) ─map(x => x * 2)→ Err(e) ─map(x => x + 1)→ Err(e)  ⚠️
       (функция не вызывается)
```

---

### flatMap() - цепочка операций (monadic bind)

```typescript
export class Ok<T> {
  /**
   * Применяет функцию, которая возвращает Result
   *
   * @remarks
   * Используется для композиции операций, которые могут упасть.
   * Автоматически "склеивает" вложенные Result.
   *
   * Без flatMap:  Result<Result<T, E>, E>  ❌ (вложенность)
   * С flatMap:    Result<T, E>             ✅ (плоский)
   *
   * @example
   * ```typescript
   * function getUser(id: string): Result<User, Error> { ... }
   * function getOrders(user: User): Result<Order[], Error> { ... }
   *
   * const result = getUser('123')
   *   .flatMap(user => getOrders(user));
   * // Result<Order[], Error>  ✅
   * ```
   */
  public flatMap<U, F>(fn: (value: T) => Result<U, F>): Result<U, F> {
    return fn(this.value);
  }
}

export class Err<E> {
  /**
   * Для Err - flatMap пропускает операцию
   */
  public flatMap<U, F>(_fn: (value: never) => Result<U, F>): Result<U, E> {
    return this as unknown as Err<E>;
  }
}
```

**Визуализация flatMap:**
```
Ok(user) ─flatMap(getOrders)→ Ok(orders)  ✅
                 (успех)

Ok(user) ─flatMap(getOrders)→ Err(error)  ⚠️ переходим на красный путь
                 (ошибка внутри)

Err(e) ─flatMap(getOrders)→ Err(e)  ⚠️ уже на красном пути, пропускаем
       (функция не вызывается)
```

---

### unwrapOr() - извлечение значения с fallback

```typescript
export class Ok<T> {
  /**
   * Извлекает значение или возвращает fallback
   */
  public unwrapOr<U>(_fallback: U): T {
    return this.value;
  }
}

export class Err<E> {
  /**
   * Для ошибки возвращает fallback
   */
  public unwrapOr<U>(fallback: U): U {
    return fallback;
  }
}
```

**Пример:**
```typescript
const result1 = Result.ok(42);
console.log(result1.unwrapOr(0)); // 42

const result2 = Result.err('error');
console.log(result2.unwrapOr(0)); // 0
```

---

## 🎯 Пример: placeOrder с Railway-Oriented

### До: Imperative (try/catch)

```typescript
// ❌ Сложно, вложенность, неявные ошибки
async function placeOrder(userId: string, marketId: string, amount: number) {
  try {
    const user = await getUser(userId);
    if (!user) throw new Error('User not found');

    try {
      const balance = await getBalance(user.id);
      if (balance < amount) throw new Error('Insufficient funds');

      try {
        const market = await getMarket(marketId);
        if (!market) throw new Error('Market not found');
        if (!market.isActive) throw new Error('Market closed');

        return await createOrder(user.id, market.id, amount);
      } catch (error) {
        throw error;
      }
    } catch (error) {
      throw error;
    }
  } catch (error) {
    throw error;
  }
}
```

---

### После: Railway-Oriented (Result)

```typescript
// ✅ Плоский код, явные ошибки, композиция
import { Result } from '@polymarket/types';
import {
  UserNotFoundError,
  InsufficientFundsError,
  MarketNotFoundError,
  MarketClosedError
} from '@polymarket/errors';

/**
 * Получает пользователя
 *
 * @returns Result с User или ошибкой
 */
async function getUser(userId: string): Promise<Result<User, UserNotFoundError>> {
  const user = await database.findUser(userId);
  if (!user) {
    return Result.err(new UserNotFoundError(userId));
  }
  return Result.ok(user);
}

/**
 * Проверяет баланс
 */
async function checkBalance(
  user: User,
  amount: number
): Promise<Result<User, InsufficientFundsError>> {
  const balance = await database.getBalance(user.id);
  if (balance < amount) {
    return Result.err(new InsufficientFundsError(amount, balance));
  }
  return Result.ok(user); // Возвращаем user дальше по цепочке
}

/**
 * Получает активный рынок
 */
async function getActiveMarket(
  marketId: string
): Promise<Result<Market, MarketNotFoundError | MarketClosedError>> {
  const market = await database.findMarket(marketId);
  if (!market) {
    return Result.err(new MarketNotFoundError(marketId));
  }
  if (!market.isActive) {
    return Result.err(new MarketClosedError(marketId, market.closedAt));
  }
  return Result.ok(market);
}

/**
 * Создаёт ордер
 */
async function createOrder(
  user: User,
  market: Market,
  amount: number
): Promise<Result<Order, TradingError>> {
  try {
    const order = await database.createOrder({
      userId: user.id,
      marketId: market.id,
      amount,
    });
    return Result.ok(order);
  } catch (error) {
    return Result.err(ErrorFactory.wrap(error));
  }
}

/**
 * Размещает ордер (Railway-Oriented)
 *
 * @remarks
 * Композиция операций через flatMap.
 * Каждый шаг может упасть - автоматически переключаемся на "красный путь".
 *
 * @returns Result с Order или любой из возможных ошибок
 */
async function placeOrder(
  userId: string,
  marketId: string,
  amount: number
): Promise<Result<
  Order,
  | UserNotFoundError
  | InsufficientFundsError
  | MarketNotFoundError
  | MarketClosedError
  | TradingError
>> {
  // 1. Получаем пользователя
  const userResult = await getUser(userId);

  // 2. Проверяем баланс
  const balanceResult = await userResult.flatMap(user =>
    checkBalance(user, amount)
  );

  // 3. Получаем рынок
  const marketResult = await getActiveMarket(marketId);

  // 4. Если всё OK - создаём ордер
  // Комбинируем user и market
  if (balanceResult.isErr()) return balanceResult;
  if (marketResult.isErr()) return marketResult;

  const user = balanceResult.value;
  const market = marketResult.value;

  return await createOrder(user, market, amount);
}

// ✅ Использование - типобезопасно!
const result = await placeOrder('user-1', 'market-1', 100);

if (result.isOk()) {
  console.log('Order created:', result.value.id);
} else {
  // TypeScript знает все возможные типы ошибок!
  const error = result.error;

  if (error instanceof InsufficientFundsError) {
    console.log(`Need ${error.getShortfall()} more USDC`);
  } else if (error instanceof MarketClosedError) {
    console.log(`Market closed at ${error.closedAt}`);
  } else if (error instanceof UserNotFoundError) {
    console.log(`User not found`);
  } else {
    console.log(`Error: ${error.message}`);
  }
}
```

---

## 🔥 Продвинутая композиция: pipe()

Для еще более красивого кода можно создать helper `pipe`:

```typescript
/**
 * Pipe helper для чистой композиции
 *
 * @example
 * ```typescript
 * const result = await pipe(
 *   await getUser('user-1'),
 *   user => checkBalance(user, 100),
 *   user => getActiveMarket('market-1').map(market => ({ user, market })),
 *   ({ user, market }) => createOrder(user, market, 100)
 * );
 * ```
 */
export async function pipe<T, E>(
  initial: Result<T, E>,
  ...fns: Array<(value: any) => Result<any, any> | Promise<Result<any, any>>>
): Promise<Result<any, any>> {
  let current = initial;

  for (const fn of fns) {
    if (current.isErr()) {
      return current; // Short-circuit on error
    }
    current = await fn(current.value);
  }

  return current;
}
```

**Использование pipe:**
```typescript
async function placeOrder(
  userId: string,
  marketId: string,
  amount: number
): Promise<Result<Order, TradingError>> {
  return pipe(
    await getUser(userId),
    user => checkBalance(user, amount),
    async user => {
      const market = await getActiveMarket(marketId);
      if (market.isErr()) return market;
      return Result.ok({ user, market: market.value });
    },
    ({ user, market }) => createOrder(user, market, amount)
  );
}
```

---

## 📊 Сравнение подходов

| Аспект | try/catch | null/undefined | **Result<T, E>** |
|--------|-----------|----------------|------------------|
| **Явность** | ❌ Скрыто | ⚠️ Неясно | ✅ Явно в типах |
| **Композиция** | ❌ Нет | ❌ Нет | ✅ map/flatMap |
| **Type safety** | ❌ Нет | ⚠️ Частично | ✅ Полная |
| **Контекст ошибки** | ✅ Есть | ❌ Нет | ✅ Есть |
| **Компилятор помогает** | ❌ Нет | ⚠️ Null checks | ✅ Да |
| **Short-circuit** | ✅ throw | ❌ Вручную | ✅ Автоматически |

---

## 🎯 Преимущества Railway-Oriented

### 1. **Явность в типах**
```typescript
// ✅ Сразу видно все возможные ошибки
function placeOrder(): Result<
  Order,
  | UserNotFoundError
  | InsufficientFundsError
  | MarketClosedError
> {
  // ...
}

// ❌ Не видно какие ошибки могут быть
function placeOrder(): Promise<Order> {
  // Может бросить что угодно!
}
```

### 2. **Композиция операций**
```typescript
// ✅ Цепочка операций - красиво!
const result = await getUser('user-1')
  .flatMap(user => checkBalance(user, 100))
  .flatMap(user => createOrder(user, 'market-1', 100));

// ❌ Вложенность try/catch
try {
  const user = await getUser('user-1');
  try {
    await checkBalance(user, 100);
    try {
      await createOrder(user, 'market-1', 100);
    } catch (e3) { }
  } catch (e2) { }
} catch (e1) { }
```

### 3. **Компилятор заставляет обработать**
```typescript
const result = await placeOrder('user-1', 'market-1', 100);

// ❌ Забыли обработать - TypeScript ERROR!
console.log(result.value);
//               ^^^^^ Property 'value' does not exist on type 'Result<Order, Error>'

// ✅ Правильно - проверили тип
if (result.isOk()) {
  console.log(result.value); // ✅ OK
}
```

### 4. **Short-circuit автоматически**
```typescript
// Если getUser упал - все последующие операции пропускаются!
const result = await getUser('user-1')        // Err
  .flatMap(user => checkBalance(user, 100))   // Пропущено
  .flatMap(user => getMarket('market-1'))     // Пропущено
  .flatMap(user => createOrder(user, 100));   // Пропущено
// result = Err (от getUser)
```

---

## 🔗 Связь с @polymarket/errors

### Интеграция Result + TradingError

```typescript
// @polymarket/types/src/result/Result.ts
export type Result<T, E extends Error> = Ok<T> | Err<E>;

// @polymarket/errors используется как E
import { TradingError } from '@polymarket/errors';

function doSomething(): Result<User, TradingError> {
  // ...
}
```

### Result.fromPromise - обертка для async/await

```typescript
/**
 * Оборачивает Promise в Result
 *
 * @remarks
 * Конвертирует Promise rejection в Err.
 * Удобно для работы с существующим async/await кодом.
 *
 * @example
 * ```typescript
 * const result = await Result.fromPromise(
 *   fetch('/api/user/123')
 * );
 *
 * if (result.isOk()) {
 *   console.log(result.value); // Response
 * } else {
 *   console.error(result.error); // Error
 * }
 * ```
 */
export async function fromPromise<T>(
  promise: Promise<T>
): Promise<Result<T, Error>> {
  try {
    const value = await promise;
    return Result.ok(value);
  } catch (error) {
    if (error instanceof Error) {
      return Result.err(error);
    }
    return Result.err(new Error(String(error)));
  }
}
```

---

## 🏗️ Пакеты Foundation: Взаимодействие

```
@polymarket/types (Result<T, E>)
    ↑ используется в
@polymarket/errors (TradingError)
    ↑ используются вместе в
@polymarket/value-objects, @polymarket/entities
```

**Пример использования вместе:**
```typescript
import { Result } from '@polymarket/types';
import { InvalidPriceError } from '@polymarket/errors';
import { Price } from '@polymarket/value-objects';

/**
 * Создаёт Price с валидацией (Railway-Oriented)
 */
function createPrice(value: number): Result<Price, InvalidPriceError> {
  if (value < 0.01 || value > 0.99) {
    return Result.err(new InvalidPriceError(value));
  }
  return Result.ok(Price.fromNumber(value));
}

// Использование
const priceResult = createPrice(0.65);

if (priceResult.isOk()) {
  const price = priceResult.value; // Price
  console.log(price.toString());
} else {
  const error = priceResult.error; // InvalidPriceError
  console.error(error.message);
}
```

---

## 📚 Дополнительные материалы

### Статьи
- [Railway Oriented Programming](https://fsharpforfunandprofit.com/rop/) - Scott Wlaschin (F#)
- [Result type в Rust](https://doc.rust-lang.org/std/result/)
- [Either type в Scala](https://www.scala-lang.org/api/2.13.0/scala/util/Either.html)

### Библиотеки
- [neverthrow](https://github.com/supermacro/neverthrow) - Result для TypeScript
- [ts-results](https://github.com/vultix/ts-results) - Result с Ok/Err
- [oxide.ts](https://github.com/traverse1984/oxide.ts) - Rust-like Result/Option

---

## ✅ Итого: Почему Result<T, E>?

1. **Явность** - все ошибки видны в типах
2. **Type safety** - компилятор заставляет обрабатывать ошибки
3. **Композиция** - легко комбинировать операции (map/flatMap)
4. **Railway tracks** - автоматический short-circuit при ошибке
5. **Нет исключений** - предсказуемый поток выполнения
6. **Функциональный подход** - immutable, pure functions

**Для Polymarket trading system это означает:**
- ✅ Безопасная обработка ошибок в критичных операциях (ордера, позиции)
- ✅ Явные типы ошибок в API
- ✅ Композиция бизнес-логики
- ✅ Меньше багов в продакшене

---

## 🎯 В нашем плане

Result<T, E> будет в пакете **@polymarket/types** (Foundation Layer 1):

```
packages/foundation/types/
├── src/
│   ├── result/
│   │   ├── Result.ts              ← Result<T, E>
│   │   ├── ResultHelpers.ts       ← pipe, fromPromise
│   │   └── index.ts
│   └── index.ts
```

Использование с **@polymarket/errors**:
```typescript
import { Result } from '@polymarket/types';
import { TradingError } from '@polymarket/errors';

type OrderResult = Result<Order, TradingError>;
```

Готовы реализовывать? 🚀
