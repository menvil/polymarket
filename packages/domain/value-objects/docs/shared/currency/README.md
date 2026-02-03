# SupportedCurrencies - Single Source of Truth

**SupportedCurrencies** — единый источник истины для всех поддерживаемых валют в системе.

## Описание

Модуль `src/shared/currency/SupportedCurrencies.ts` определяет все валюты, которые поддерживаются в value objects Money и Balance.

**Ключевая особенность:** При добавлении новой валюты достаточно изменить ОДИН файл, и:
- ✅ `Money.ZERO` автоматически создаст singleton для новой валюты
- ✅ `Balance.ZERO` автоматически создаст singleton для новой валюты
- ✅ TypeScript типы автоматически обновятся
- ✅ Все проверки валидности валюты будут работать автоматически

## Структура

```typescript
// src/shared/currency/SupportedCurrencies.ts
export const SUPPORTED_CURRENCIES = ['USDC'] as const;
export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];
```

## Использование

### Текущие валюты

```typescript
import { SUPPORTED_CURRENCIES, SupportedCurrency } from '@polymarket/value-objects/shared';

// Массив всех валют
console.log(SUPPORTED_CURRENCIES); // ['USDC']

// Тип валюты (автоматически выводится из массива)
const currency: SupportedCurrency = 'USDC'; // ✅ OK
const invalid: SupportedCurrency = 'EUR';   // ❌ TypeScript error
```

### Проверка валидности

```typescript
import { SUPPORTED_CURRENCIES } from '@polymarket/value-objects/shared';

function isValidCurrency(currency: string): currency is SupportedCurrency {
  return SUPPORTED_CURRENCIES.includes(currency as SupportedCurrency);
}

console.log(isValidCurrency('USDC')); // true
console.log(isValidCurrency('EUR'));  // false
```

### В Money и Balance

```typescript
import { Money } from '@polymarket/value-objects/money';
import { Balance } from '@polymarket/value-objects/balance';

// Money.ZERO автоматически генерируется для всех SUPPORTED_CURRENCIES
const zeroMoney = Money.ZERO.USDC;

// Balance.ZERO автоматически генерируется для всех SUPPORTED_CURRENCIES
const zeroBalance = Balance.ZERO.USDC;
```

## Добавление новой валюты

### Шаг 1: Добавьте валюту в массив

```typescript
// src/shared/currency/SupportedCurrencies.ts
export const SUPPORTED_CURRENCIES = ['USDC', 'EUR'] as const;
//                                             ^^^^^ добавили EUR
export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];
```

### Шаг 2: Всё работает автоматически!

```typescript
// Money автоматически поддерживает EUR
const euroMoney = Money.of(100, 'EUR'); // ✅ OK
const zeroEuro = Money.ZERO.EUR;        // ✅ Singleton создан автоматически

// Balance автоматически поддерживает EUR
const euroBalance = Balance.ZERO.EUR;   // ✅ Singleton создан автоматически

// TypeScript типы обновлены
const currency: SupportedCurrency = 'EUR'; // ✅ OK
```

### Что НЕ нужно делать

❌ **Не нужно** обновлять Money.ZERO вручную
❌ **Не нужно** обновлять Balance.ZERO вручную
❌ **Не нужно** обновлять TypeScript типы вручную
❌ **Не нужно** обновлять валидацию валют

Всё работает автоматически через:
- `Object.fromEntries()` для генерации Record
- `typeof ARRAY[number]` для вывода union типа
- `const assertion (as const)` для immutable массива

## Архитектура

### Singleton Pattern

```typescript
// Money.ts
import { SUPPORTED_CURRENCIES, SupportedCurrency } from '../../shared/currency/SupportedCurrencies';

public static readonly ZERO: Record<SupportedCurrency, Money> =
  Object.fromEntries(
    SUPPORTED_CURRENCIES.map(currency => [
      currency,
      Money.fromDecimal(new Decimal(0), currency)
    ])
  ) as Record<SupportedCurrency, Money>;
```

### Type Inference

```typescript
// SupportedCurrency тип автоматически выводится
const SUPPORTED_CURRENCIES = ['USDC', 'EUR'] as const;
type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];
// type SupportedCurrency = 'USDC' | 'EUR' ✅ автоматически
```

## Примеры использования

### Пример 1: Итерация по всем валютам

```typescript
import { SUPPORTED_CURRENCIES } from '@polymarket/value-objects/shared';
import { Money } from '@polymarket/value-objects/money';

// Создаём zero balance для всех валют
const zeroBalances = SUPPORTED_CURRENCIES.map(currency => ({
  currency,
  balance: Money.ZERO[currency]
}));

console.log(zeroBalances);
// [{ currency: 'USDC', balance: Money(0 USDC) }]
```

### Пример 2: Валидация входных данных

```typescript
import { SUPPORTED_CURRENCIES, SupportedCurrency } from '@polymarket/value-objects/shared';

function parseCurrency(input: string): SupportedCurrency | null {
  const upper = input.toUpperCase();
  return SUPPORTED_CURRENCIES.includes(upper as SupportedCurrency)
    ? (upper as SupportedCurrency)
    : null;
}

const currency = parseCurrency('usdc');
if (currency) {
  const money = Money.of(100, currency); // ✅ Type-safe
}
```

### Пример 3: Exhaustive checking

```typescript
import { SupportedCurrency } from '@polymarket/value-objects/shared';

function getCurrencySymbol(currency: SupportedCurrency): string {
  switch (currency) {
    case 'USDC':
      return '$';
    // Если добавить EUR в SUPPORTED_CURRENCIES,
    // TypeScript потребует добавить case 'EUR'
  }
}
```

## Связанные модули

- **Money** — использует SupportedCurrency для валидации и ZERO singleton
- **Balance** — использует SupportedCurrency для валидации и ZERO singleton
- **MoneyService** — использует SupportedCurrency в сигнатурах методов

## Принципы

- ✅ **Single Source of Truth** — одна точка определения валют
- ✅ **Type Safety** — автоматический вывод типов
- ✅ **Immutability** — const assertion для неизменяемости
- ✅ **Auto-generation** — автоматическое создание singletons
- ✅ **Extensibility** — легко добавить новую валюту

## Архитектурное решение

### Проблема

До рефакторинга:
- Каждый value object определял свои константы валют
- При добавлении валюты нужно было обновлять 3+ места
- Singleton создавались вручную для каждой валюты

### Решение

После рефакторинга:
```typescript
// ✅ Единый источник истины
export const SUPPORTED_CURRENCIES = ['USDC'] as const;

// ✅ Автоматическая генерация типов
export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];

// ✅ Автоматическая генерация singletons в Money/Balance
public static readonly ZERO: Record<SupportedCurrency, Money> =
  Object.fromEntries(
    SUPPORTED_CURRENCIES.map(currency => [currency, Money.fromDecimal(new Decimal(0), currency)])
  ) as Record<SupportedCurrency, Money>;
```

### Преимущества

1. **Масштабируемость** — добавление валюты в 1 строку вместо 10+
2. **Согласованность** — все value objects используют одни и те же валюты
3. **Type Safety** — TypeScript гарантирует покрытие всех валют
4. **DRY принцип** — нет дублирования кода
5. **Автоматизация** — генерация constans через map/fromEntries

## История изменений

**Версия 1.0** (текущая):
- Поддержка USDC
- Автоматическая генерация Money.ZERO и Balance.ZERO
- Single source of truth pattern
