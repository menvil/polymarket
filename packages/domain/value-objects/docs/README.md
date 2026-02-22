# @polymarket/value-objects

> Неизменяемые value objects для доменной модели торговой системы Polymarket

![Tests](https://img.shields.io/badge/tests-passing-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)
![License](https://img.shields.io/badge/license-MIT-blue)

## Описание

Пакет содержит типобезопасные value objects для представления доменных концепций в торговой системе. Все value objects реализованы по принципам **Domain-Driven Design** с использованием **Railway-Oriented Programming** для обработки ошибок.

## Основные принципы

- ✅ **Неизменяемость** — все операции возвращают новые экземпляры
- ✅ **Валидация при создании** — невозможно создать невалидный объект
- ✅ **Type-safe ошибки** — `Result<T, E>` для явной обработки ошибок
- ✅ **Высокая точность** — `decimal.js` для финансовых расчётов
- ✅ **Rich domain model** — методы для бизнес-операций

## Value Objects

### 💰 [Money](./money.md)

Денежные суммы с высокой точностью вычислений.

```typescript
import { MoneyService } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';

const money = unwrap(MoneyService.create(100, 'USDC')); // 100 USDC
const doubled = unwrap(MoneyService.multiply(money, 2));  // 200 USDC
console.log(doubled.value().toString());             // "200"
```

**Особенности:**

- Использует `decimal.js` для точных вычислений
- Поддержка отрицательных значений (PnL)
- Railway-Oriented Programming через `Result<T, E>`
- **ВСЕ арифметические методы возвращают `Result<T, E>`**
- В текущей версии: только USDC

**[→ Подробная документация](./money.md)**

---

### 📊 [Percentage](./percentage.md)

Процентные значения для комиссий, прибыли, изменений.

```typescript
import { Percentage } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';

const fee = unwrap(Percentage.fromValue(2.5));     // 2.5%
const gain = unwrap(Percentage.fromDecimal(0.15)); // 15%
const total = unwrap(fee.add(gain));                // 17.5% (Result)

const orderValue = 1000;
const feeAmount = fee.of(orderValue); // Decimal(25)
```

**Особенности:**

- Поддержка отрицательных процентов (для PnL)
- Точные вычисления с `decimal.js`
- Базисные пункты (bp)
- Диапазон: [-1,000,000%, +1,000,000%]
- **ВСЕ арифметические методы возвращают `Result<T, E>`**

**[→ Подробная документация](./percentage.md)**

---

### 💵 [Balance](./balance.md)

Баланс счёта пользователя (только неотрицательные значения).

```typescript
import { Balance } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';

const balance = unwrap(Balance.fromValue(1000, 'USDC'));

// Проверка достаточности средств
if (balance.hasEnough(500)) {
  console.log('Sufficient funds'); // ✅
}

// Операции с балансом (возвращают Result)
const deposit = unwrap(Balance.fromValue(200, 'USDC'));
const newBalance = unwrap(balance.add(deposit));  // Result!
console.log(newBalance.toString()); // "1200 USDC"
```

**Особенности:**

- Всегда неотрицательный (отклоняет отрицательные значения)
- Метод `hasEnough()` для проверки достаточности средств
- Операции только с одинаковой валютой
- Отличие от Money: Balance — для счетов, Money — универсальный

**[→ Подробная документация](./balance.md)**

---

### 💹 Price

Цена на рынке предсказаний Polymarket.

```typescript
import { Price } from '@polymarket/value-objects';
import { Percentage } from '@polymarket/value-objects';

const price = Price.fromValue(0.55); // 55% вероятность
price.match({
  ok: (p) => {
    console.log(p.value);             // 0.55
    console.log(p.toPercentage());    // "55.00%"
  },
  err: (error) => console.error(error)
});
```

**Диапазон:** [0.0001, 0.9999]

---

### 🔢 Quantity

Количество акций на рынке.

```typescript
import { Quantity } from '@polymarket/value-objects';

const qty = Quantity.fromValue(100);
qty.match({
  ok: (q) => console.log(q.getValue()), // 100
  err: (error) => console.error(error)
});
```

---

### 📦 [AssetQuantity](./asset-quantity/README.md)

Количество актива (USDC или outcome token).

```typescript
import { AssetQuantityService } from '@polymarket/value-objects/asset-quantity';
import { Ratio } from '@polymarket/value-objects/ratio';
import { BinaryOutcome } from '@polymarket/ids';
import Decimal from 'decimal.js';

// Создание USDC quantity
const usdcResult = AssetQuantityService.createUsdc(100);
if (usdcResult.ok) {
  console.log(usdcResult.value.amount().toNumber());  // 100
  console.log(usdcResult.value.isCurrency());         // true
}

// Создание outcome token quantity
const tokenResult = AssetQuantityService.createOutcomeToken(
  conditionRef,
  BinaryOutcome.UP,
  50
);

// Операции с Ratio: portion (доля актива)
const orderQty = AssetQuantityService.createUsdc(1000);
if (orderQty.ok) {
  // Fee calculation: 2% от 1000 USDC
  const feeRate = Ratio.of(new Decimal(0.02));
  const feeResult = AssetQuantityService.portion(orderQty.value, feeRate);

  if (feeResult.ok) {
    console.log(feeResult.value.amount().toNumber()); // 20 USDC (2% fee)
  }
}
```

**Особенности:**

- Комбинирует AssetId (currency/token) + Quantity
- Railway-Oriented Programming через `Result<T, E>`
- Операция `portion()` для вычисления доли (fee calculation, allocation, partial fills)
- Defensive copy для гарантии иммутабельности
- Never Throw Contract в Facade layer

**[→ Подробная документация](./asset-quantity/README.md)**

---

### 📈 Quote

Котировка с ценой покупки (bid) и продажи (ask).

```typescript
import { QuoteService, QuoteFormatter } from '@polymarket/value-objects/quote';
import { KnownMarketDataSources, asInstrumentId } from '@polymarket/ids';

const result = QuoteService.create(
  0.54,  // bid price
  0.56,  // ask price
  100,   // bid size
  150,   // ask size
  KnownMarketDataSources.POLYMARKET_WS,
  asInstrumentId('ETH-USD')!
);

if (!result.ok) {
  console.error(result.error.message);
  // Handle error properly - do not use return in module scope
  throw new Error(result.error.message);
}

const quote = result.value;
console.log(quote.spreadWidthOrZero().toNumber());      // 0.02
console.log(quote.midOrNull()?.toNumber());             // 0.55
console.log(QuoteFormatter.toDisplay(quote));
// "0.5400 @ 100.00 / 0.5600 @ 150.00"
```

---

### 📉 [Spread](./spread/README.md)

Спред между ценами покупки и продажи (bid-ask spread).

```typescript
import { SpreadService, SpreadFormatter } from '@polymarket/value-objects';

// Создание из чисел
const result = SpreadService.fromValues(0.48, 0.52);
if (!result.ok) {
  throw new Error(result.error.message);
}

const spread = result.value;

console.log(spread.bid().toNumber());       // 0.48
console.log(spread.ask().toNumber());       // 0.52
console.log(spread.width().toNumber());     // 0.04
console.log(spread.mid().toNumber());  // 0.50
console.log(spread.widthRatio().toDecimal().times(100).toNumber()); // 8

// Форматирование
console.log(SpreadFormatter.format(spread));
// "0.4800-0.5200 (0.0400)"

// Операции: сужение, расширение, сдвиг
const tighterResult = SpreadService.tighten(spread, 0.01);
const widerResult = SpreadService.widen(spread, 0.02);
const shiftedResult = SpreadService.shift(spread, 0.10);
```

**Особенности:**

- Railway-Oriented Programming через `Result<T, E>`
- Инвариант: bid ≤ ask (гарантирован на уровне типов)
- Операции: tighten (сужение), widen (расширение), shift (сдвиг)
- Интеграция с Price для Polymarket [0.0001, 0.9999]
- Сериализация/форматирование для API и UI

**[→ Подробная документация](./spread/README.md)**

## Установка

```bash
npm install @polymarket/value-objects
```

## Быстрый старт

### Базовое использование

```typescript
import { MoneyService, Percentage } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';

// Создание Money
const balance = unwrap(MoneyService.create(1000, 'USDC')); // 1000 USDC

// Расчёт комиссии
const feeRate = unwrap(Percentage.fromValue(0.25)); // 0.25%
const feeAmount = feeRate.of(balance.value());

console.log(`Комиссия: ${feeAmount.toNumber()} USDC`); // "Комиссия: 2.5 USDC"

// Вычитание комиссии
const fee = unwrap(MoneyService.create(feeAmount, 'USDC'));
const netBalance = unwrap(MoneyService.subtract(balance, fee));

console.log(netBalance.value().toString()); // "997.5"
```

### Railway-Oriented Programming

```typescript
import { MoneyService } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';

// Обработка через match
const result = MoneyService.create(100, 'USDC');

result.match({
  ok: (money) => {
    console.log(`Success: ${money.value().toString()}`);
  },
  err: (error) => {
    console.error(`Error: ${error.message}`);
  }
});

// Цепочка операций
const m1Result = MoneyService.create(100, 'USDC');
if (!m1Result.ok) return;
const m1 = m1Result.value;

const m2Result = MoneyService.multiply(m1, 2);
if (!m2Result.ok) return;
const m2 = m2Result.value;

const m3 = unwrap(MoneyService.create(50, 'USDC'));
const finalResult = MoneyService.add(m2, m3);

finalResult.match({
  ok: (money) => console.log(money.value().toNumber()), // 250
  err: (error) => console.error(error)
});
```

### Решение проблемы floating point

```typescript
import { MoneyService, Percentage } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';

// ❌ Проблема с обычным number
const wrong = 0.1 + 0.2; // 0.30000000000000004

// ✅ Решение с Money
const m1 = unwrap(MoneyService.create('0.1', 'USDC'));
const m2 = unwrap(MoneyService.create('0.2', 'USDC'));
const correct = unwrap(MoneyService.add(m1, m2));

console.log(correct.value().toString()); // "0.3" - точно!

// ✅ Решение с Percentage
const p1 = unwrap(Percentage.fromDecimal(0.1));
const p2 = unwrap(Percentage.fromDecimal(0.2));
const sum = unwrap(p1.add(p2));

console.log(sum.toDecimal().toString()); // "0.3" - точно!
```

### PnL (Profit & Loss) расчёты

```typescript
import { MoneyService } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';

const cost = unwrap(MoneyService.create(100, 'USDC'));
const revenue = unwrap(MoneyService.create(85, 'USDC'));

const pnl = unwrap(MoneyService.subtract(revenue, cost));

if (pnl.isNegative()) {
  console.log(`Убыток: ${pnl.value().abs().toString()}`);
  // "Убыток: 15"
} else {
  console.log(`Прибыль: ${pnl.value().toString()}`);
}
```

## Документация

### Подробные гайды

- 💰 **[Money](./money.md)** — денежные суммы с высокой точностью
- 📊 **[Percentage](./percentage.md)** — процентные значения для комиссий и расчётов
- 💵 **[Balance](./balance.md)** — балансы счетов пользователей
- 📦 **[AssetQuantity](./asset-quantity/README.md)** — количество актива с операциями Ratio

### Архитектурные документы

- 🎨 **[Result Styles](./result-styles.md)** — стили работы с Result, архитектурное правило когда возвращать Result

## Особенности

### Неизменяемость (Immutability)

Все value objects неизменяемы — операции возвращают новые экземпляры:

```typescript
const m1 = unwrap(MoneyService.create(100, 'USDC'));
const m2 = unwrap(MoneyService.multiply(m1, 2));

console.log(m1.value().toNumber()); // 100 (оригинал не изменён)
console.log(m2.value().toNumber()); // 200 (новый объект)
```

### Валидация при создании

Невозможно создать невалидный value object:

```typescript
const invalid = MoneyService.create(NaN, 'USDC');

invalid.match({
  ok: (money) => console.log(money),
  err: (error) => {
    // InvalidMoneyError: "Amount cannot be NaN"
    console.error(error.message);
  }
});
```

### Type-safe ошибки

Все ошибки типизированы и содержат контекст:

```typescript
import { MoneyService, CurrencyMismatchError } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';

const m1 = unwrap(MoneyService.create(100, 'USDC'));
const m2 = unwrap(MoneyService.create(1, 'BTC')); // Если BTC добавлен

const result = MoneyService.add(m1, m2);

result.match({
  ok: (money) => console.log(money),
  err: (error) => {
    if (error instanceof CurrencyMismatchError) {
      console.error(error.code);    // "CURRENCY_MISMATCH"
      console.error(error.context); // { expected: 'USDC', actual: 'BTC' }
    }
  }
});
```

### Высокая точность с Decimal.js

Точные финансовые вычисления без проблем floating point:

```typescript
const price = unwrap(MoneyService.create('0.123456789012345', 'USDC'));
const quantity = new Decimal('1000000');

const total = unwrap(MoneyService.multiply(price, quantity));
console.log(total.value().toString());
// "123456.789012345" - вся точность сохранена
```

## Зависимости

- **[@polymarket/result](../result)** — Result type для Railway-Oriented Programming
- **[@polymarket/errors](../errors)** — типизированные ошибки валидации
- **[decimal.js](https://mikemcl.github.io/decimal.js/)** — точные вычисления с произвольной точностью

## Разработка

### Команды

```bash
# Сборка
npm run build

# Тесты
npm test

# Тесты с покрытием
npm run test:coverage

# Линтинг
npm run lint
npm run lint:fix

# Type checking
npm run typecheck

# Очистка
npm run clean
```

### Структура проекта

```text
packages/domain/value-objects/
├── src/
│   ├── price/             # Price value object
│   ├── quantity/          # Quantity value object
│   ├── quote/             # Quote value object
│   ├── spread/            # Spread value object
│   ├── ratio/             # Ratio value object
│   ├── outcome-token/     # OutcomeToken value object
│   ├── token-balance/     # TokenBalance value object
│   └── index.ts           # Barrel exports
├── __tests__/
│   └── unit/
│       ├── price/
│       ├── quantity/
│       ├── quote/
│       ├── spread/
│       ├── ratio/
│       ├── outcome-token/
│       └── token-balance/
├── docs/
│   ├── price/             # Price документация
│   ├── quantity/          # Quantity документация
│   ├── quote/             # Quote документация
│   ├── spread/            # Spread документация
│   ├── ratio/             # Ratio документация
│   ├── outcome-token/     # OutcomeToken документация
│   ├── token-balance/     # TokenBalance документация
│   └── README.md          # Этот файл
└── README.md              # Пакетный README
```

### Тесты

```bash
# Все тесты
npm test

# Конкретный файл
npm test -- Money.test.ts

# С покрытием
npm run test:coverage

# В watch режиме
npm run test:watch
```

**Статистика тестов:**

- Все тесты passing ✅
- Высокое покрытие кода
- Comprehensive test suites для всех value objects

## Примеры использования

### Торговые операции

```typescript
import { MoneyService, Percentage, Price, Quantity } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';

// Параметры ордера
const price = unwrap(Price.fromValue(0.55));
const quantity = unwrap(Quantity.fromValue(100));
const feeRate = unwrap(Percentage.fromValue(0.25)); // 0.25%

// Расчёт стоимости
const priceDecimal = price.value();
const qtyDecimal = quantity.value();
const orderValue = priceDecimal.times(qtyDecimal); // 55

// Создание Money для расчётов
const orderAmount = unwrap(MoneyService.create(orderValue, 'USDC'));

// Расчёт комиссии
const feeAmount = feeRate.of(orderAmount.value());
const fee = unwrap(MoneyService.create(feeAmount, 'USDC'));

// Итоговая сумма
const total = unwrap(MoneyService.add(orderAmount, fee));

console.log(`Стоимость ордера: ${orderAmount.value().toString()}`); // "55"
console.log(`Комиссия: ${fee.value().toString()}`);                // "0.1375"
console.log(`Итого: ${total.value().toString()}`);                  // "55.1375"
```

### Анализ портфеля

```typescript
import { MoneyService, Percentage } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';

const positions = [
  { symbol: 'YES-TRUMP', value: unwrap(MoneyService.create(1000, 'USDC')) },
  { symbol: 'NO-TRUMP', value: unwrap(MoneyService.create(500, 'USDC')) },
  { symbol: 'YES-BIDEN', value: unwrap(MoneyService.create(750, 'USDC')) },
];

// Расчёт общего портфеля
const totalValue = positions.reduce(
  (acc, pos) => unwrap(MoneyService.add(acc, pos.value)),
  unwrap(MoneyService.create(0, 'USDC'))
);

console.log(`Общая стоимость портфеля: ${totalValue.value().toString()}`);
// "Общая стоимость портфеля: 2250"

// Расчёт доли каждой позиции
positions.forEach(pos => {
  const totalDecimal = totalValue.value();
  const posDecimal = pos.value.value();
  const shareDecimal = posDecimal.dividedBy(totalDecimal);

  const share = unwrap(Percentage.fromDecimal(shareDecimal));
  console.log(`${pos.symbol}: ${share.toString()}`);
});
// "YES-TRUMP: 44.44%"
// "NO-TRUMP: 22.22%"
// "YES-BIDEN: 33.33%"
```

## Best Practices

### ✅ DO: Используйте Result для обработки ошибок

```typescript
const result = MoneyService.create(value, 'USDC');

result.match({
  ok: (money) => processMoney(money),
  err: (error) => handleError(error)
});
```

### ✅ DO: Используйте unwrap() когда уверены

```typescript
import { unwrap } from '@polymarket/result';

const money = unwrap(MoneyService.create(100, 'USDC')); // OK для константных значений
```

### ✅ DO: Используйте строки для высокой точности

```typescript
// ✅ ХОРОШО
const precise = unwrap(MoneyService.create('100.123456789012345', 'USDC'));

// ❌ ПЛОХО
const imprecise = unwrap(MoneyService.create(100.123456789012345, 'USDC'));
```

### ❌ DON'T: Не игнорируйте ошибки

```typescript
// ❌ ПЛОХО
const money = MoneyService.create(value, 'USDC'); // Result игнорируется

// ✅ ХОРОШО
const result = MoneyService.create(value, 'USDC');
if (!result.ok) {
  throw result.error;
}
```

## Миграция

### Со старой версии Percentage

См. **[PERCENTAGE_REFACTORING.md](./PERCENTAGE_REFACTORING.md)** для подробного migration guide.

**Основные изменения:**

- Exceptions → Result<T, E>
- Number → Decimal.js
- Silent clamping → Explicit errors
- Только [0, 100%] → Поддержка отрицательных

## Лицензия

MIT

## Связанные пакеты

- [@polymarket/result](../result) — Result type
- [@polymarket/errors](../errors) — Типизированные ошибки
- [@polymarket/domain](../domain) — Доменные сущности

## Поддержка

- **Документация:** [docs/](./docs/)
- **Issues:** [GitHub Issues](https://github.com/menvil/polymarket/issues)
- **Tests:** All passing ✅
