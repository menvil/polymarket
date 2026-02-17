# ADR: Контракт публичного API пакета `@polymarket/result`

**Статус:** Принято
**Дата:** 2026-02-17
**Авторы:** команда Polymarket Foundation

---

## Контекст

Пакет `@polymarket/result` реализует паттерн Railway-Oriented Programming (ROP)
для явной обработки ошибок без исключений. В процессе роста пакета накопились
противоречия:

- README обещал «никаких неожиданных исключений», но `unwrap` и `expect` бросают исключения
- `AsyncResultChain` использовал `error as E` (небезопасный type assertion)
- `fromPromise`/`fromNullable`/`fromThrowable` жили в `ResultChain`, а не в ядре
- Три конкурирующих API (FP / OOP / Async) без чёткой иерархии рекомендации
- Widen-варианты (`flatMapW`, `orElseW`) отсутствовали в FP API

Данный ADR фиксирует единый контракт как источник истины.

---

## Решения

### 1. Ядро = FP API (`result.ts`)

**Решение:** Все базовые операции с `Result<T, E>` живут в одном файле `result.ts`.

**Обоснование:** FP-функции (`map`, `flatMap`, `combine` и т.д.) максимально
tree-shakeable, не требуют инстанцирования классов, легко тестируются в isolation.

**Контракт:**

```
result.ts = единственный источник бизнес-логики Result
ResultChain.ts = тонкий OOP-адаптер поверх result.ts
AsyncResultChain.ts = тонкий async-адаптер поверх result.ts
unsafe.ts = явный модуль для операций, бросающих исключения
```

### 2. Политика безопасности API

| Метод / Функция         | Бросает исключение? | Где живёт        |
|-------------------------|---------------------|------------------|
| `Ok`, `Err`             | Никогда             | result.ts (ядро) |
| `isOk`, `isErr`         | Никогда             | result.ts (ядро) |
| `map`, `flatMap`        | Никогда¹            | result.ts (ядро) |
| `mapErr`                | Никогда¹            | result.ts (ядро) |
| `flatMapW`, `mapErrW`   | Никогда¹            | result.ts (ядро) |
| `orElseW`               | Никогда¹            | result.ts (ядро) |
| `match`                 | Никогда¹            | result.ts (ядро) |
| `combine`               | Никогда             | result.ts (ядро) |
| `tryCatch`              | Никогда²            | result.ts (ядро) |
| `tryAsync`              | Никогда²            | result.ts (ядро) |
| `fromPromise`           | Никогда²            | result.ts (ядро) |
| `fromNullable`          | Никогда             | result.ts (ядро) |
| `fromThrowable`         | Никогда²            | result.ts (ядро) |
| `unwrapOr`              | Никогда             | result.ts (ядро) |
| `unwrapOrElse`          | Никогда¹            | result.ts (ядро) |
| `unwrap`                | **Да** (unsafe)     | unsafe.ts        |
| `expectOk`              | **Да** (unsafe)     | unsafe.ts        |

> ¹ FP-функции (`unwrapOrElse`, `orElseW` и т.п.) сами не бросают. Если callback
> пользователя бросает — исключение propagate как есть (это задокументированное поведение;
> пользователь несёт ответственность за callback). Методы класса `AsyncResultChain`
> (transform-методы: `mapAsync`, `flatMapAsync`, `mapErr` и др.) ведут себя иначе:
> внутренние исключения из callback перехватываются и возвращаются как `Err(onError(e))`,
> т.е. Promise цепочки остаётся resolved и исключение не propagate.
>
> ² Функция перехватывает исключения/rejections из пользовательского кода
> и оборачивает их в `Err`.

### 3. Политика типа ошибки `E`

**Правило:** В safe-методах тип `E` **не расширяется** неявно через `error as E` в прикладном коде.

**Вместо этого:**
- Методы `AsyncResultChain` принимают опциональный `onError: (e: unknown) => E`
- Без `onError` по умолчанию применяется `(error) => error as E` — это безопасно только
  когда `E = unknown` (тип известен из контекста); в этом случае `E` честно отражает `unknown`
- Явный `onError` даёт полный контроль над нормализацией — рекомендуемый подход

**Widen-варианты (W-суффикс):**
- `flatMapW<U, F>(fn: (T) => Result<U, F>): Result<U, E | F>` — fn может вернуть
  другой тип ошибки, результирующий тип расширяется до `E | F`
- `mapErrW<T, E, F>(result, fn: (E) => F): Result<T, F>` — заменяет тип ошибки E на F
- `orElseW<T, E, F>(result, fn: (E) => Result<T, F>): Result<T, F>` — recovery
  с другим типом ошибки

### 4. Политика обработки exceptions/rejections

**AsyncResultChain — единое правило:**

| Метод                 | Бросает из callback  | Поведение              |
|-----------------------|----------------------|------------------------|
| `mapAsync`            | Да                   | → `Err(onError(e))`    |
| `flatMapAsync`        | Да                   | → `Err(onError(e))`    |
| `flatMap` (sync)      | Да                   | → `Err(onError(e))`    |
| `mapErrAsync`         | Да                   | → `Err(onError(e))`    |
| `mapErr` (sync)       | Да                   | → `Err(onError(e))`    |
| `orElseAsync`         | Да                   | → `Err(onError(e))`    |
| `orElse` (sync)       | Да                   | → `Err(onError(e))`    |
| `orAsyncLazy`         | Да                   | → `Err(onError(e))`    |
| `tap`                 | Да                   | → rejected Promise     |
| `tapErr`              | Да                   | → rejected Promise     |
| `match`               | Да                   | → rejected Promise     |

`tap`/`tapErr`/`match` — *side-effect методы*, их поведение при исключении
намеренно отличается: они не являются transform-методами и не должны
маскировать ошибки пользователя.

### 5. Структура экспортов

**Основной путь (рекомендован для новых пользователей):**
```typescript
import { Ok, Err, map, flatMap, combine, fromPromise } from '@polymarket/result';
```

**OOP-адаптер:**
```typescript
import { OkChain, ErrChain, toChain, R } from '@polymarket/result/chain';
```

**Async-адаптер:**
```typescript
import { AsyncResult, AsyncResultChain } from '@polymarket/result/async';
```

**Unsafe-операции (явно помечены):**
```typescript
import { unwrap, expectOk } from '@polymarket/result/unsafe';
```

### 6. Обратная совместимость

Для текущей версии (0.1.x) все API доступны через основной путь `@polymarket/result`
для backward compatibility. Начиная с 0.2.0 рекомендуется использовать subpath imports.

---

## Альтернативы, которые были отвергнуты

### А. Удалить OOP API полностью

**Отклонено:** OOP API (ResultChain) существенно улучшает читаемость сложных
цепочек и IDE autocomplete. Пользователи уже зависят от него.

### Б. Всегда ловить исключения в tap/tapErr

**Отклонено:** `tap` — side-effect метод. Исключение в нём означает баг
в логике пользователя (например, ошибка в логгере). Маскировать такие баги
через `Err` — опасно и нарушает принцип наименьшего удивления.

### В. E = unknown везде по умолчанию

**Отклонено:** Потеря типизации в цепочках, где тип ошибки точно известен.
Решение: сохранить строгую типизацию, добавить `onError` normalizer для границ.

---

## Последствия

**Позитивные:**
- Единый источник истины для контракта
- Пользователь видит чёткое разделение safe/unsafe
- `AsyncResultChain` стал предсказуемым: поведение задокументировано и протестировано
- Widen-варианты позволяют правильно работать с union-типами ошибок

**Негативные:**
- Небольшой breaking change: `fromPromise`/`fromNullable`/`fromThrowable`
  переехали из ResultChain в ядро (но re-exported для совместимости)
- `AsyncResultChain` требует указывать `onError` в местах, где тип ошибки строгий
