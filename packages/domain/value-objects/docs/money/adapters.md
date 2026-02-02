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
const money = Money.of(123.456, 'USDC');
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

// ❌ Бизнес-ошибки (из Money.fromDecimal)
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
public static toFixed(money: Money, decimals: number = 2): string
```

**Параметры:**

- `decimals` — количество знаков после запятой (default: 2)

**Примеры:**

```typescript
const money = Money.of(100.5, 'USDC');

MoneyFormatter.toFixed(money);      // "100.50"
MoneyFormatter.toFixed(money, 0);   // "101" (rounded)
MoneyFormatter.toFixed(money, 4);   // "100.5000"
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
): string
```

**Параметры:**

- `showCurrency` — показывать код валюты (default: true)
- `decimals` — количество знаков (default: 2)

**Примеры:**

```typescript
const money = Money.of(100.5, 'USDC');

MoneyFormatter.toCurrency(money);           // "$100.50 USDC"
MoneyFormatter.toCurrency(money, false);    // "$100.50"
MoneyFormatter.toCurrency(money, true, 4);  // "$100.5000 USDC"
```

---

#### `toCompact(money, decimals?)`

Компактный формат с суффиксами (K, M, B).

**Сигнатура:**

```typescript
public static toCompact(money: Money, decimals: number = 1): string
```

**Параметры:**

- `decimals` — количество знаков после запятой (default: 1)

**Суффиксы:**

- < 1000: нет суффикса
- >= 1000: K (тысячи)
- >= 1000000: M (миллионы)
- >= 1000000000: B (миллиарды)

**Примеры:**

```typescript
MoneyFormatter.toCompact(Money.of(999));       // "$999.0"
MoneyFormatter.toCompact(Money.of(1500));      // "$1.5K"
MoneyFormatter.toCompact(Money.of(2300000));   // "$2.3M"
MoneyFormatter.toCompact(Money.of(1e9));       // "$1.0B"

// С разными decimals
MoneyFormatter.toCompact(Money.of(1234), 2);   // "$1.23K"
```

---

## Примеры

### Сериализация для API

```typescript
import { Money, MoneySerializer } from '@polymarket/value-objects/money';

// Отправка на сервер
const balance = Money.of(1234.56, 'USDC');
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
  console.log(`Balance: $${money.amount()}`);
}
```

### Форматирование для UI

```typescript
import { Money, MoneyFormatter } from '@polymarket/value-objects/money';

const balance = Money.of(1234567.89, 'USDC');

// Детальное отображение (для таблиц)
console.log(MoneyFormatter.toFixed(balance, 2));
// "1234567.89"

// С символом валюты (для форм)
console.log(MoneyFormatter.toCurrency(balance));
// "$1234567.89 USDC"

// Компактное (для dashboard)
console.log(MoneyFormatter.toCompact(balance));
// "$1.2M"

// Различные варианты
const small = Money.of(99.99, 'USDC');
const medium = Money.of(1500, 'USDC');
const large = Money.of(2500000, 'USDC');

console.log(MoneyFormatter.toCompact(small));   // "$100.0"
console.log(MoneyFormatter.toCompact(medium));  // "$1.5K"
console.log(MoneyFormatter.toCompact(large));   // "$2.5M"
```

### Граница системы (API validation)

```typescript
import { MoneySerializer } from '@polymarket/value-objects/money';

// Валидация входных данных от API
function parseApiBalance(data: unknown) {
  const result = MoneySerializer.fromJSON(data);

  if (!result.ok) {
    const kind = result.error.context?.kind;

    if (kind === 'invalid_json') {
      // Структурная ошибка
      console.error('Invalid JSON structure');
    } else {
      // Бизнес-ошибка (из Money.fromDecimal)
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
  console.log(`Balance: ${MoneyFormatter.toCurrency(balance)}`);
}
```

---

## Заключение

Adapters Layer:

- ✅ MoneySerializer — граница системы с валидацией unknown
- ✅ MoneyFormatter — читаемое форматирование для UI
- ✅ Точность через string в JSON
- ✅ Типизированные ошибки через Result
