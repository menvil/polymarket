# Стили работы с Result<T, E>

В проекте используется пакет `@polymarket/result`, который поддерживает **два полностью совместимых стиля** работы с Result.

## 📌 Важно: Оба стиля правильные!

Выбор стиля — это вопрос предпочтений и контекста использования. Оба подхода:
- ✅ Type-safe
- ✅ Полностью поддерживаются
- ✅ Совместимы друг с другом
- ✅ Документированы в `@polymarket/result`

## 1️⃣ Функциональный стиль (Plain Objects)

**Используется в value-objects пакете.**

### Характеристики
- Result — это **простой объект** (discriminated union)
- Доступ через **поля**: `result.ok`, `result.value`, `result.error`
- Операции через **функции**: `unwrap(result)`, `map(result, fn)`

### Преимущества
- ✅ Легкая сериализация (`JSON.stringify` работает из коробки)
- ✅ Tree-shaking (неиспользуемые функции удаляются)
- ✅ Меньше накладных расходов
- ✅ Функциональный подход

### Примеры

```typescript
import { Result, Ok, Err, unwrap, map, flatMap } from '@polymarket/result';
import { Balance } from '@polymarket/value-objects';

// Value objects возвращают plain Result
const result = Balance.fromAmount(1000, 'USDC');
// result: Result<Balance, InvalidMoneyError>

// ✅ Проверка через поле .ok
if (result.ok) {
  const balance = result.value;  // Доступ к полю
  console.log(balance.getAmount());
} else {
  const error = result.error;    // Доступ к полю
  console.error(error.message);
}

// ✅ Использование функции unwrap
const balance = unwrap(Balance.fromAmount(1000, 'USDC'));

// ✅ Композиция через функции
const doubled = map(result, balance => {
  // Работа с балансом
  return balance;
});

const chained = flatMap(result, balance =>
  balance.add(unwrap(Balance.fromAmount(500, 'USDC')))
);
```

### Когда использовать
- ✅ В value objects (Money, Percentage, Balance)
- ✅ Когда нужна сериализация
- ✅ Для функционального стиля кода
- ✅ Когда важен минимальный bundle size

## 2️⃣ OOP стиль (Method Chaining)

**Доступен через `OkChain`, `ErrChain`, `toChain`.**

### Характеристики
- ResultChain — это **объект с методами**
- Доступ через **методы**: `.isOk()`, `.unwrap()`, `.map()`
- Цепочки операций: `.map().flatMap().unwrap()`

### Преимущества
- ✅ Читабельные цепочки операций
- ✅ Привычный OOP подход
- ✅ Удобный fluent API

### Примеры

```typescript
import { OkChain, ErrChain, toChain, unwrap } from '@polymarket/result';
import { Balance } from '@polymarket/value-objects';

// Создание chain напрямую
const result = OkChain(42)
  .map(x => x * 2)
  .map(x => x + 1)
  .unwrap(); // 85

// Конвертация plain Result в chain
const balance = toChain(Balance.fromValue(1000, 'USDC'))
  .flatMap(b => b.add(unwrap(Balance.fromValue(500, 'USDC'))))
  .map(b => b.getAmount())
  .unwrapOr(0); // 1500

// Проверка через методы
const chain = OkChain(10);
if (chain.isOk()) {  // ✅ Метод
  console.log(chain.unwrap());  // ✅ Метод
}
```

### Когда использовать
- ✅ Для длинных цепочек операций
- ✅ Когда предпочитаете OOP стиль
- ✅ Для более читабельного кода
- ✅ В application layer

## 3️⃣ Гибридный подход (Рекомендуется!)

**Миксуйте стили по необходимости.**

### Концепция
- Value objects возвращают **plain objects**
- В application layer конвертируем в **chain** когда нужно
- Используем `toChain()` для конвертации

### Примеры

```typescript
import { toChain, unwrap } from '@polymarket/result';
import { Balance, Money, Percentage } from '@polymarket/value-objects';

// 1. Value objects возвращают plain Result
const balanceResult = Balance.fromAmount(1000, 'USDC');
const feeResult = Percentage.fromNumber(2.5);

// 2. Простые случаи — функциональный стиль
if (balanceResult.ok && feeResult.ok) {
  const balance = balanceResult.value;
  const fee = feeResult.value;
  // ...
}

// 3. Сложные цепочки — конвертируем в chain
const finalAmount = toChain(balanceResult)
  .flatMap(balance => {
    return toChain(feeResult)
      .flatMap(fee => {
        const feeAmount = fee.of(balance.getAmount());
        return Money.fromAmount(
          balance.getAmount() - feeAmount.toNumber()
        );
      });
  })
  .unwrapOr(unwrap(Money.fromAmount(0)));

// 4. Или используем unwrap для краткости
const balance = unwrap(balanceResult);
const fee = unwrap(feeResult);
const feeAmount = fee.of(balance.getAmount());
const final = unwrap(Money.fromAmount(
  balance.getAmount() - feeAmount.toNumber()
));
```

## ❌ Типичные ошибки

### Ошибка 1: Смешивание стилей

```typescript
// ❌ НЕПРАВИЛЬНО
const result = Ok(42);  // Plain object
result.unwrap();        // ❌ У plain object НЕТ методов!

// ✅ ПРАВИЛЬНО - используйте один стиль
const result = Ok(42);
unwrap(result);  // ✅ Функция для plain object

// ✅ ИЛИ используйте другой стиль
const result = OkChain(42);
result.unwrap();  // ✅ Метод для chain
```

### Ошибка 2: Забыли toChain при конвертации

```typescript
// ❌ НЕПРАВИЛЬНО
const result = Balance.fromAmount(1000, 'USDC');  // Plain object
result.map(b => b.getAmount());  // ❌ НЕТ метода .map()

// ✅ ПРАВИЛЬНО - конвертируем в chain
const amount = toChain(result)
  .map(b => b.getAmount())
  .unwrapOr(0);

// ✅ ИЛИ используйте функциональный стиль
const amount = map(result, b => b.getAmount());
```

## 📊 Сравнение стилей

| Аспект | Функциональный | OOP |
|--------|----------------|-----|
| **Тип** | Plain object | Class instance |
| **Проверка** | `result.ok` | `result.isOk()` |
| **Доступ к значению** | `result.value` | `result.unwrap()` |
| **Доступ к ошибке** | `result.error` | `result.unwrapErr()` |
| **Извлечение** | `unwrap(result)` | `result.unwrap()` |
| **Map** | `map(result, fn)` | `result.map(fn)` |
| **FlatMap** | `flatMap(result, fn)` | `result.flatMap(fn)` |
| **Сериализация** | ✅ Прямая | ⚠️ Через `.toResult()` |
| **Tree-shaking** | ✅ Отлично | ⚠️ Хуже |
| **Читабельность цепочек** | ⚠️ Вложенность | ✅ Fluent API |

## 🎯 Рекомендации по выбору стиля

### Используйте функциональный стиль когда:
- ✅ Создаёте value objects или entities
- ✅ Нужна сериализация в JSON
- ✅ Важен размер bundle
- ✅ Предпочитаете функциональное программирование
- ✅ Простые операции (1-2 шага)

### Используйте OOP стиль когда:
- ✅ Длинные цепочки операций (3+ шагов)
- ✅ В application layer
- ✅ Предпочитаете метод chaining
- ✅ Работаете с асинхронными операциями (`AsyncResultChain`)

### Используйте гибридный подход когда:
- ✅ Value objects возвращают plain, но нужны цепочки
- ✅ Хотите гибкости
- ✅ Разные части кода используют разные стили

## 📝 Best Practices

### 1. Будьте последовательны в одном модуле

```typescript
// ✅ Хорошо - один стиль в модуле
export class UserService {
  getUser(id: string): Result<User, UserNotFoundError> {
    // ...
  }

  validateUser(user: User): Result<User, ValidationError> {
    // ...
  }

  // Все методы используют функциональный стиль
}
```

### 2. Используйте toChain для конвертации

```typescript
// ✅ Хорошо - явная конвертация
const result = someValueObject.create();  // Plain Result
const processed = toChain(result)
  .map(...)
  .flatMap(...)
  .toResult();  // Обратно в plain если нужно
```

### 3. Документируйте выбранный стиль

```typescript
/**
 * Создаёт баланс пользователя
 *
 * @returns Plain Result object (функциональный стиль)
 */
export function createBalance(): Result<Balance, Error> {
  return Balance.fromAmount(0, 'USDC');
}
```

## 🔗 Дополнительные ресурсы

- **[@polymarket/result README](../../foundation/result/README.md)** - полная документация
- **[Railway-Oriented Programming](https://fsharpforfunandprofit.com/rop/)** - концепция
- **[TypeScript Discriminated Unions](https://www.typescriptlang.org/docs/handbook/typescript-in-5-minutes-func.html#discriminated-unions)** - как работают plain Results

## 💡 Итог

**Оба стиля правильные и поддерживаются!**

- 🎯 В value-objects используется **функциональный стиль**
- 🔄 Можно легко **конвертировать** между стилями через `toChain()`
- ✅ Выбирайте стиль под **ваши нужды**
- 🤝 **Миксуйте** стили когда это улучшает код

Главное — понимать разницу и не смешивать стили в одном выражении!