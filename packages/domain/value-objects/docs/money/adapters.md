# Money Adapters Layer

> Сериализация и форматирование Money

## Содержание

1. [Обзор](#обзор)
2. [MoneySerializer](#moneyserializer)
3. [MoneyFormatter](#moneyformatter)
4. [Примеры](#примеры)

---

## Обзор

Adapters Layer отвечает за:

- Сериализацию Money в/из JSON
- Форматирование Money для отображения
- Валидацию на границе системы (unknown → typed)

---

## MoneySerializer

### Назначение

Точная сериализация Money с сохранением precision через string.

### API

#### `toJSON(money)`

Сериализует Money в JSON объект.

**Сигнатура:**

```typescript
public static toJSON(money: Money): { amount: string; currency: string }
```

**Возвращает:** `{ amount: string, currency: string }`

**Пример:**

```typescript
const money = Money.of(new Decimal(123.456), 'USDC');
const json = MoneySerializer.toJSON(money);
// { amount: "123.456", currency: "USDC" }
```

---

#### `fromJSON(json)`

Десериализует Money из JSON с валидацией на границе.

**Сигнатура:**

```typescript
public static fromJSON(json: unknown): Result<Money, InvalidMoneyError>
```

**Валидация:**

1. json это объект (ни null, ни массив, ни примитив)
2. Есть поля amount и currency
3. amount это number или string
4. currency это string

**Делегирует:** `MoneyService.create(amount, currency as SupportedCurrency)` для создания

**Примеры:**

```typescript
// ✅ Валидный JSON
const result = MoneySerializer.fromJSON({
  amount: "123.45",
  currency: "USDC"
});

// ❌ Структурные ошибки
MoneySerializer.fromJSON(null);              // Err: expected object
MoneySerializer.fromJSON({ });               // Err: missing fields
MoneySerializer.fromJSON({ amount: 123 });   // Err: missing currency

// ❌ Бизнес-ошибки (из MoneyService.create)
MoneySerializer.fromJSON({
  amount: "1e16",    // > MAX_AMOUNT
  currency: "USDC"
});  // Err: EXCEEDS_MAX_AMOUNT
```

---

## MoneyFormatter

### Назначение

Форматирование Money для отображения пользователю.

### API

#### `toFixed(money, decimals?)`

Форматирует с фиксированным количеством знаков.

**Сигнатура:**

```typescript
public static toFixed(
  money: Money,
  decimals: number = 2
): Result<string, InvalidMoneyError>
```

**Параметры:**

- `decimals` — количество знаков после запятой (default: 2)

**Возвращает:** `Result<string, InvalidMoneyError>`

**Примеры:**

```typescript
const money = Money.of(new Decimal(100.5), 'USDC');

const result1 = MoneyFormatter.toFixed(money);
if (result1.ok) console.log(result1.value); // "100.50"

const result2 = MoneyFormatter.toFixed(money, 0);
if (result2.ok) console.log(result2.value); // "101" (rounded)

const result3 = MoneyFormatter.toFixed(money, 4);
if (result3.ok) console.log(result3.value); // "100.5000"
```

---

#### `toCurrency(money, showCurrency?, decimals?)`

Форматирует с символом валюты.

**Сигнатура:**

```typescript
public static toCurrency(
  money: Money,
  showCurrency: boolean = true,
  decimals: number = 2
): Result<string, InvalidMoneyError>
```

**Параметры:**

- `showCurrency` — показывать код валюты (default: true)
- `decimals` — количество знаков (default: 2)

**Возвращает:** `Result<string, InvalidMoneyError>`

**Примеры:**

```typescript
const money = Money.of(new Decimal(100.5), 'USDC');

const result1 = MoneyFormatter.toCurrency(money);
if (result1.ok) console.log(result1.value); // "$100.50 USDC"

const result2 = MoneyFormatter.toCurrency(money, false);
if (result2.ok) console.log(result2.value); // "$100.50"

const result3 = MoneyFormatter.toCurrency(money, true, 4);
if (result3.ok) console.log(result3.value); // "$100.5000 USDC"
```

---

#### `toCompact(money, decimals?)`

Компактный формат с суффиксами (K, M, B).

**Сигнатура:**

```typescript
public static toCompact(
  money: Money,
  decimals: number = 1
): Result<string, InvalidMoneyError>
```

**Параметры:**

- `decimals` — количество знаков после запятой (default: 1)

**Возвращает:** `Result<string, InvalidMoneyError>`

**Суффиксы:**

- < 1000: нет суффикса
- >= 1000: K (тысячи)
- >= 1000000: M (миллионы)
- >= 1000000000: B (миллиарды)

**Примеры:**

```typescript
const r1 = MoneyFormatter.toCompact(Money.of(new Decimal(999)));
if (r1.ok) console.log(r1.value); // "$999.0"

const r2 = MoneyFormatter.toCompact(Money.of(new Decimal(1500)));
if (r2.ok) console.log(r2.value); // "$1.5K"

const r3 = MoneyFormatter.toCompact(Money.of(new Decimal(2300000)));
if (r3.ok) console.log(r3.value); // "$2.3M"

const r4 = MoneyFormatter.toCompact(Money.of(new Decimal(1e9)));
if (r4.ok) console.log(r4.value); // "$1.0B"

// С разными decimals
const r5 = MoneyFormatter.toCompact(Money.of(new Decimal(1234)), 2);
if (r5.ok) console.log(r5.value); // "$1.23K"
```

---

## Примеры

### Сериализация для API

```typescript
import { Money, MoneySerializer } from '@polymarket/value-objects/money';

// Отправка на сервер
const balance = Money.of(new Decimal(1234.56), 'USDC');
const payload = {
  userId: "123",
  balance: MoneySerializer.toJSON(balance)
};

// payload = {
//   userId: "123",
//   balance: { amount: "1234.56", currency: "USDC" }
// }

fetch('/api/balance', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
});

// Получение с сервера
const response = await fetch('/api/balance/123');
const data = await response.json();

const result = MoneySerializer.fromJSON(data.balance);
if (result.ok) {
  const money = result.value;
  console.log(`Balance: $${money.value().toString()}`);
}
```

### Форматирование для UI

```typescript
import { Money, MoneyFormatter } from '@polymarket/value-objects/money';

const balance = Money.of(new Decimal(1234567.89), 'USDC');

// Детальное отображение (для таблиц)
const fixed = MoneyFormatter.toFixed(balance, 2);
if (fixed.ok) {
  console.log(fixed.value);  // "1234567.89"
}

// С символом валюты (для форм)
const currency = MoneyFormatter.toCurrency(balance);
if (currency.ok) {
  console.log(currency.value);  // "$1234567.89 USDC"
}

// Компактное (для dashboard)
const compact = MoneyFormatter.toCompact(balance);
if (compact.ok) {
  console.log(compact.value);  // "$1.2M"
}

// Различные варианты
const small = Money.of(new Decimal(99.99), 'USDC');
const medium = Money.of(new Decimal(1500), 'USDC');
const large = Money.of(new Decimal(2500000), 'USDC');

console.log(MoneyFormatter.toCompact(small));   // "$100.0"
console.log(MoneyFormatter.toCompact(medium));  // "$1.5K"
console.log(MoneyFormatter.toCompact(large));   // "$2.5M"
```

### Граница системы (API validation)

```typescript
import { MoneySerializer, MoneyFormatter } from '@polymarket/value-objects/money';
import { ErrorSource } from '@polymarket/errors';

// Валидация входных данных от API
function parseApiBalance(data: unknown) {
  const result = MoneySerializer.fromJSON(data);

  if (!result.ok) {
    const source = result.error.context?.source;

    if (source === ErrorSource.PARSING) {
      // Структурная ошибка (невалидный JSON)
      console.error('Invalid JSON structure');
    } else {
      // Бизнес-ошибка (из MoneyService.create)
      console.error('Invalid money value');
    }

    return null;
  }

  return result.value;
}

// Использование
const balance = parseApiBalance({
  amount: "1234.56",
  currency: "USDC"
});

if (balance) {
  const formatted = MoneyFormatter.toCurrency(balance);
  if (formatted.ok) {
    console.log(`Balance: ${formatted.value}`);
  }
}
```

---

## Заключение

Adapters Layer:

- ✅ MoneySerializer — граница системы с валидацией unknown
- ✅ MoneyFormatter — читаемое форматирование для UI
- ✅ Точность через string в JSON
- ✅ Типизированные ошибки через Result
