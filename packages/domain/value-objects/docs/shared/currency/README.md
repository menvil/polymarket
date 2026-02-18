# SupportedCurrency - Single Source of Truth

**SupportedCurrency** — единый источник истины для всех поддерживаемых валют в системе.

## ⚠️ Важное изменение

**SupportedCurrency перемещён в `@polymarket/ids`** (foundation layer).

- **Было**: `packages/domain/value-objects/src/shared/currency/SupportedCurrencies.ts`
- **Стало**: `packages/foundation/ids/src/core/Currency.ts`

**Обоснование**: `SupportedCurrency` - это foundation primitive (как `ChainId`, `ProtocolId`), а не domain logic. Правильная dependency direction: domain → foundation.

## Описание

Модуль `@polymarket/ids/src/core/Currency.ts` определяет все валюты, которые поддерживаются в системе.

**Ключевая особенность:** При добавлении новой валюты достаточно изменить ОДИН файл, и:

- ✅ `Money.ZERO` автоматически создаст singleton для новой валюты
- ✅ `Balance.ZERO` автоматически создаст singleton для новой валюты
- ✅ TypeScript типы автоматически обновятся
- ✅ Все проверки валидности валюты будут работать автоматически

## Структура

```typescript
// @polymarket/ids/src/core/Currency.ts
export const SUPPORTED_CURRENCIES = ['USDC'] as const;
export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];

export const KnownCurrencies = {
  USDC: 'USDC' as SupportedCurrency,
} as const;

export function isSupportedCurrency(value: string): value is SupportedCurrency;
```

## Использование

### Текущие валюты

```typescript
import { SUPPORTED_CURRENCIES, type SupportedCurrency, KnownCurrencies } from '@polymarket/ids';

// Массив всех валют
console.log(SUPPORTED_CURRENCIES); // ['USDC']

// Константы
const usdc = KnownCurrencies.USDC; // 'USDC' as SupportedCurrency

// Тип валюты (автоматически выводится из массива)
const currency: SupportedCurrency = 'USDC'; // ✅ OK
const invalid: SupportedCurrency = 'EUR';   // ❌ TypeScript error
```

### Проверка валидности

```typescript
import { isSupportedCurrency } from '@polymarket/ids';

const input = getUserInput(); // string

if (isSupportedCurrency(input)) {
  // TypeScript знает: input is SupportedCurrency
  const money = Money.of(100, input);
} else {
  throw new Error(`Unsupported currency: ${input}`);
}
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

### В AssetId

```typescript
import { AssetIdHelpers, KnownCurrencies } from '@polymarket/ids';

// USDC asset
const usdcAsset = AssetIdHelpers.USDC;

// Custom currency (если добавлена в SUPPORTED_CURRENCIES)
const customAsset = AssetIdHelpers.fromCurrency(KnownCurrencies.USDC);
```

## Добавление новой валюты

### Шаг 1: Добавьте валюту в массив

```typescript
// @polymarket/ids/src/core/Currency.ts
export const SUPPORTED_CURRENCIES = ['USDC', 'USDT'] as const;
//                                            ^^^^^^ добавили USDT
export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];

export const KnownCurrencies = {
  USDC: 'USDC' as SupportedCurrency,
  USDT: 'USDT' as SupportedCurrency,  // ← добавили константу
} as const;
```

### Шаг 2: Пересоберите @polymarket/ids

```bash
cd packages/foundation/ids
npm run build
```

### Шаг 3: Всё работает автоматически

```typescript
// Money автоматически поддерживает USDT
const usdtMoney = Money.of(100, 'USDT'); // ✅ OK
const zeroUsdt = Money.ZERO.USDT;        // ✅ Singleton создан автоматически

// Balance автоматически поддерживает USDT
const usdtBalance = Balance.ZERO.USDT;   // ✅ Singleton создан автоматически

// AssetId автоматически поддерживает USDT
const usdtAsset = AssetIdHelpers.fromCurrency('USDT'); // ✅ OK

// TypeScript типы обновлены
const currency: SupportedCurrency = 'USDT'; // ✅ OK
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
import { SUPPORTED_CURRENCIES, type SupportedCurrency } from '@polymarket/ids';

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
// Currency.ts (@polymarket/ids)
// SupportedCurrency тип автоматически выводится
const SUPPORTED_CURRENCIES = ['USDC', 'USDT'] as const;
type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];
// type SupportedCurrency = 'USDC' | 'USDT' ✅ автоматически
```

## Примеры использования

### Пример 1: Итерация по всем валютам

```typescript
import { SUPPORTED_CURRENCIES } from '@polymarket/ids';
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
import { isSupportedCurrency, type SupportedCurrency } from '@polymarket/ids';
import { Money } from '@polymarket/value-objects/money';

function parseCurrency(input: string): SupportedCurrency | null {
  const upper = input.toUpperCase();
  return isSupportedCurrency(upper) ? upper : null;
}

const currency = parseCurrency('usdc');
if (currency) {
  const money = Money.of(100, currency); // ✅ Type-safe
}
```

### Пример 3: Exhaustive checking

```typescript
import { type SupportedCurrency } from '@polymarket/ids';

function getCurrencySymbol(currency: SupportedCurrency): string {
  switch (currency) {
    case 'USDC':
      return '$';
    // Если добавить USDT в SUPPORTED_CURRENCIES,
    // TypeScript потребует добавить case 'USDT'
    default:
      // exhaustive check
      const _exhaustive: never = currency;
      throw new Error(`Unknown currency: ${_exhaustive}`);
  }
}
```

## Связанные модули

### Foundation Layer

- **@polymarket/ids** — определяет SupportedCurrency, KnownCurrencies, isSupportedCurrency
- **AssetId** — использует SupportedCurrency для currency assets

### Domain Layer

- **Money** — использует SupportedCurrency для валидации и ZERO singleton
- **Balance** — использует SupportedCurrency для валидации и ZERO singleton
- **MoneyService** — использует SupportedCurrency в сигнатурах методов

## Принципы

- ✅ **Single Source of Truth** — одна точка определения валют
- ✅ **Foundation Layer** — примитивы в foundation, не в domain
- ✅ **Type Safety** — автоматический вывод типов
- ✅ **Immutability** — const assertion для неизменяемости
- ✅ **Auto-generation** — автоматическое создание singletons
- ✅ **Extensibility** — легко добавить новую валюту

## Архитектурное решение

### Проблема

До рефакторинга:

- SupportedCurrency находился в value-objects (domain layer)
- Нарушение dependency direction (foundation должен быть независим от domain)
- Дублирование константов валют в нескольких местах

### Решение

После рефакторинга:

```typescript
// ✅ SupportedCurrency в foundation layer (@polymarket/ids)
// packages/foundation/ids/src/core/Currency.ts
export const SUPPORTED_CURRENCIES = ['USDC'] as const;
export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];

export const KnownCurrencies = {
  USDC: 'USDC' as SupportedCurrency,
} as const;

export function isSupportedCurrency(value: string): value is SupportedCurrency;

// ✅ Money импортирует из foundation
// packages/domain/value-objects/src/money/core/Money.ts
import { SUPPORTED_CURRENCIES, type SupportedCurrency } from '@polymarket/ids';

// ✅ AssetId использует SupportedCurrency
// packages/foundation/ids/src/core/AssetId.ts
export type AssetId =
  | { readonly type: 'CURRENCY'; readonly currency: SupportedCurrency; }
  | { readonly type: 'OUTCOME_TOKEN'; ... };
```

### Преимущества

1. **Правильная dependency direction** — domain → foundation (не наоборот)
2. **Унификация** — один источник истины для всех layers
3. **Type safety** — SupportedCurrency используется в AssetId, Money, Balance
4. **Масштабируемость** — добавление валюты в 1 месте
5. **Согласованность** — все packages используют одни и те же валюты

## История изменений

**Версия 2.0** (текущая):

- ✅ SupportedCurrency перемещён в @polymarket/ids (foundation layer)
- ✅ AssetId использует SupportedCurrency для type safety
- ✅ Добавлен helper isSupportedCurrency()
- ✅ Добавлены константы KnownCurrencies
- ✅ Правильная dependency direction: domain → foundation

**Версия 1.0** (legacy):

- Поддержка USDC
- SupportedCurrency в value-objects/shared/currency
- Автоматическая генерация Money.ZERO и Balance.ZERO
- Single source of truth pattern
