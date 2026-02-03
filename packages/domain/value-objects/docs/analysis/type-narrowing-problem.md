# TypeScript Type Narrowing Problem в Value Objects

**Дата:** 2026-02-02
**Проблема:** Discriminated union narrowing с `!result.ok` не работает в TypeScript

---

## 🚨 Критическая проблема

**ВСЕ четыре модуля имеют ошибки компиляции TypeScript!**

```bash
# Money
❌ 5 errors in MoneyService.ts
src/money/facade/MoneyService.ts(97,63): error TS2339:
  Property 'error' does not exist on type 'Result<Decimal, InvalidMoneyError>'.

# Price
❌ 5 errors in PriceService.ts
src/price/facade/PriceService.ts(101,53): error TS2339:
  Property 'error' does not exist on type 'Result<Decimal, InvalidPriceError>'.

# Quantity
❌ 5 errors in QuantityService.ts
src/quantity/facade/QuantityService.ts(71,53): error TS2339:
  Property 'error' does not exist on type 'Result<Decimal, InvalidQuantityError>'.

# Percentage
✅ 0 errors - ИСПОЛЬЗУЕТ isErr()
```

---

## 🔍 Детальное сравнение

### Result Type Definition

```typescript
// @polymarket/result
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const isErr = <T, E>(
  result: Result<T, E>
): result is { ok: false; error: E } =>
  result.ok === false;
```

---

### Money/Price/Quantity (НЕ РАБОТАЕТ)

**MoneyService.ts:93-98**
```typescript
const decimalResult = toDecimal(
  'value',
  value,
  MoneyErrorReason.INVALID_FORMAT,
  InvalidMoneyError
);

// ❌ TypeScript НЕ МОЖЕТ сузить тип!
if (!decimalResult.ok) {
  // ⚠️ ERROR: Property 'error' does not exist on type
  //          'Result<Decimal, InvalidMoneyError>'
  // ⚠️ TypeScript видит: { ok: true; value: Decimal } | { ok: false; error: E }
  // ⚠️ НЕ понимает, что в этой ветке ok === false
  return Err(rewrap('create', { currency }, decimalResult.error, InvalidMoneyError));
  //                                         ^^^^^^^^^^^^^^^^^
  //                                         ❌ Ошибка компиляции!
}

// ✅ Здесь TypeScript ПРАВИЛЬНО видит value
return this.createFromDecimal(decimalResult.value, currency, 'create', {});
//                             ^^^^^^^^^^^^^^^^^^^^^
//                             ✅ Работает (ok === true branch)
```

**Что происходит:**
1. TypeScript видит `!decimalResult.ok`
2. НЕ понимает, что это означает `ok === false`
3. НЕ сужает тип Result до `{ ok: false; error: E }`
4. Считает, что `error` может не существовать
5. **ОШИБКА КОМПИЛЯЦИИ**

---

### Percentage (РАБОТАЕТ)

**PercentageService.ts:99-110**
```typescript
const decimalResult = toDecimal(
  'value',
  value,
  PercentageErrorReason.INVALID_FORMAT,
  InvalidPercentageError
);

// ✅ TypeScript ПРАВИЛЬНО сужает тип!
if (isErr(decimalResult)) {
  // ✅ TypeScript ЗНАЕТ: result is { ok: false; error: InvalidPercentageError }
  // ✅ Type guard явно указывает тип
  return Err(rewrap('create', {}, decimalResult.error, InvalidPercentageError));
  //                              ^^^^^^^^^^^^^^^^^^^^^
  //                              ✅ Нет ошибки! TypeScript знает тип
}

// ✅ Здесь TypeScript ПРАВИЛЬНО видит value
return this.createFromDecimal(decimalResult.value, 'create', {});
//                             ^^^^^^^^^^^^^^^^^^^^^
//                             ✅ Работает (ok === true branch)
```

**Что происходит:**
1. TypeScript видит `isErr(decimalResult)`
2. Находит определение type guard: `result is { ok: false; error: E }`
3. **СУЖАЕТ тип** до `{ ok: false; error: InvalidPercentageError }`
4. **ЗНАЕТ**, что `error` существует и имеет тип `InvalidPercentageError`
5. **НЕТ ОШИБКИ КОМПИЛЯЦИИ**

---

## 📊 Сравнительная таблица

| Аспект | Money/Price/Quantity | Percentage |
|--------|---------------------|------------|
| **Паттерн** | `if (!result.ok)` | `if (isErr(result))` |
| **Type Guard** | ❌ Нет | ✅ `result is { ok: false; error: E }` |
| **Type Narrowing** | ❌ НЕ работает | ✅ Работает |
| **Ошибки компиляции** | ❌ 5+ ошибок | ✅ 0 ошибок |
| **Access to .error** | ❌ TypeScript ругается | ✅ TypeScript понимает |
| **Access to .value** | ✅ Работает в else | ✅ Работает в else |
| **Runtime behavior** | ✅ Работает (JS не строгий) | ✅ Работает |
| **Type Safety** | ❌ Только runtime | ✅ Compile-time + runtime |

---

## 🤔 Почему Money/Price/Quantity "работают" с ошибками?

### JavaScript Runtime

```javascript
// После компиляции в JavaScript (игнорируя ошибки TS):

const decimalResult = toDecimal(...);

// JavaScript НЕ заботится о типах
if (!decimalResult.ok) {
  // ✅ В runtime decimalResult.error существует
  // ✅ JavaScript просто обращается к свойству
  return Err(rewrap('create', {}, decimalResult.error, InvalidMoneyError));
}
```

**Вывод:** Код **работает в runtime**, но **ломается на этапе компиляции TypeScript**.

### Как компилируется?

```bash
# Вероятно, используются флаги компиляции:
tsc --noEmit false  # Игнорировать ошибки типов
# ИЛИ
tsc --skipLibCheck  # Пропустить проверку библиотек
# ИЛИ
# Просто игнорируют ошибки и компилируют anyway
```

---

## 🔧 Решения проблемы

### Решение 1: isErr() Type Guard (✅ Используется в Percentage)

```typescript
import { isErr } from '@polymarket/result';

const result = someOperation();

if (isErr(result)) {
  // ✅ TypeScript ЗНАЕТ тип
  console.error(result.error);
}
```

**Плюсы:**
- ✅ Полный type safety
- ✅ Нет ошибок компиляции
- ✅ Явное указание намерения

**Минусы:**
- ⚠️ Требует import isErr
- ⚠️ Inconsistency с существующим кодом

---

### Решение 2: result.ok === false (альтернатива)

```typescript
const result = someOperation();

// Работает, но verbose
if (result.ok === false) {
  // ✅ TypeScript может сузить тип
  console.error(result.error);
}
```

**Плюсы:**
- ✅ Работает в TypeScript
- ✅ Не требует imports

**Минусы:**
- ⚠️ Verbose (`=== false` вместо `!`)
- ⚠️ Менее идиоматично

---

### Решение 3: Обновить TypeScript (не протестировано)

```json
// package.json
{
  "devDependencies": {
    "typescript": "^5.5.0" // Может быть исправлено в новых версиях
  }
}
```

**Плюсы:**
- ✅ Может решить проблему глобально

**Минусы:**
- ⚠️ Требует тестирования всей кодебазы
- ⚠️ Может сломать другие части

---

## 📈 Визуализация проблемы

### Type Narrowing Flow

```
Начало:
  result: Result<T, E>
     ↓
     ├─ ok: true  → { value: T }
     └─ ok: false → { error: E }

Money/Price/Quantity:
  if (!result.ok) ❌
     ↓
  TypeScript: "Не понимаю, что это значит"
     ↓
  result: Result<T, E> (не сужен!)
     ↓
  result.error ❌ Error: Property 'error' does not exist

Percentage:
  if (isErr(result)) ✅
     ↓
  TypeScript: "Вижу type guard!"
     ↓
  result: { ok: false; error: E } (сужен!)
     ↓
  result.error ✅ Тип известен: E
```

---

## 🎯 Практические примеры

### Пример 1: Создание Value Object

**Money (НЕ компилируется):**
```typescript
export class MoneyService {
  public static create(
    value: number | string | Decimal,
    currency: SupportedCurrency = 'USDC'
  ): Result<Money, InvalidMoneyError> {
    const decimalResult = toDecimal('value', value, MoneyErrorReason.INVALID_FORMAT, InvalidMoneyError);

    if (!decimalResult.ok) {
      // ❌ ERROR: Property 'error' does not exist
      return Err(rewrap('create', { currency }, decimalResult.error, InvalidMoneyError));
      //                                         ^^^^^^^^^^^^^^^^^^
    }

    return this.createFromDecimal(decimalResult.value, currency, 'create', {});
  }
}
```

**Percentage (компилируется):**
```typescript
export class PercentageService {
  public static create(
    value: number | string | Decimal
  ): Result<Percentage, InvalidPercentageError> {
    const decimalResult = toDecimal('value', value, PercentageErrorReason.INVALID_FORMAT, InvalidPercentageError);

    if (isErr(decimalResult)) {
      // ✅ NO ERROR: TypeScript знает тип
      return Err(rewrap('create', {}, decimalResult.error, InvalidPercentageError));
      //                              ^^^^^^^^^^^^^^^^^^^^^
    }

    return this.createFromDecimal(decimalResult.value, 'create', {});
  }
}
```

---

### Пример 2: Математические операции

**Money (НЕ компилируется):**
```typescript
public static multiply(
  money: Money,
  factor: number | string | Decimal
): Result<Money, InvalidMoneyError> {
  const factorResult = toDecimal('factor', factor, MoneyErrorReason.INVALID_FORMAT, InvalidMoneyError);

  if (!factorResult.ok) {
    // ❌ ERROR: Property 'error' does not exist
    return Err(rewrap('multiply', { value: money.amount().toString(), factor: String(factor) }, factorResult.error, InvalidMoneyError));
    //                                                                                          ^^^^^^^^^^^^^^^^^^^
  }

  // ... остальной код
}
```

**Percentage (компилируется):**
```typescript
public static multiply(
  pct: Percentage,
  factor: number | string | Decimal
): Result<Percentage, InvalidPercentageError> {
  const factorResult = toDecimal('factor', factor, PercentageErrorReason.INVALID_FORMAT, InvalidPercentageError);

  if (isErr(factorResult)) {
    // ✅ NO ERROR: TypeScript знает тип
    return Err(rewrap('multiply', { value: pct.value().toString(), factor: String(factor) }, factorResult.error, InvalidPercentageError));
    //                                                                                        ^^^^^^^^^^^^^^^^^^^^
  }

  // ... остальной код
}
```

---

## 🏆 Почему Percentage лучше?

### 1. Compile-Time Safety

```typescript
// Money/Price/Quantity
// ❌ Ошибки компиляции игнорируются
// ⚠️ Проблемы обнаруживаются только в runtime

// Percentage
// ✅ Ошибки ловятся на этапе компиляции
// ✅ TypeScript проверяет корректность кода
```

### 2. IDE Support

```typescript
// Money/Price/Quantity
if (!result.ok) {
  result.error  // ❌ IDE показывает ошибку
  //     ^^^^^ Property 'error' does not exist
}

// Percentage
if (isErr(result)) {
  result.error  // ✅ IDE показывает правильный тип
  //     ^^^^^ (property) error: InvalidPercentageError
}
```

### 3. Refactoring Safety

```typescript
// Money/Price/Quantity
// ❌ При рефакторинге можно сломать код
// ❌ TypeScript не предупредит

// Percentage
// ✅ TypeScript гарантирует корректность
// ✅ Рефакторинг безопасен
```

---

## 📋 Рекомендации

### Для Percentage (текущее состояние)

✅ **СОХРАНИТЬ** использование `isErr()`
- Единственный модуль без ошибок компиляции
- Reference implementation для type safety
- Лучшая IDE поддержка

### Для Money/Price/Quantity (требуется исправление)

🔴 **КРИТИЧНО:** Исправить type narrowing проблему

**Вариант 1 (рекомендуется):** Использовать `isErr()`
```typescript
// Заменить во всех Service файлах
- if (!result.ok) {
+ if (isErr(result)) {
```

**Вариант 2:** Использовать `=== false`
```typescript
// Более verbose, но работает
- if (!result.ok) {
+ if (result.ok === false) {
```

---

## 🎓 Выводы

1. **Проблема реальна:** Все модули кроме Percentage НЕ компилируются
2. **Runtime работает:** JavaScript игнорирует типы, код выполняется
3. **Type safety нарушен:** TypeScript не может проверить корректность
4. **Percentage правильный:** Использование `isErr()` - best practice
5. **Требуется исправление:** Money/Price/Quantity нужно рефакторить

---

## 🔗 Ссылки

- TypeScript Handbook: [Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)
- TypeScript Handbook: [Type Guards](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#using-type-predicates)
- Result Type: `/packages/foundation/result/src/result.ts`
- isErr Implementation: line 108

---

**Дата:** 2026-02-02
**Версия:** 1.0
**Статус:** Critical Issue Identified
