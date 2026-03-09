# @polymarket/value-objects

> Неизменяемые value objects для доменной модели торговой системы Polymarket

![Tests](https://img.shields.io/badge/tests-201%20passing-brightgreen)
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
import { Money } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';

const money = unwrap(Money.fromValue(100)); // 100 USDC
const doubled = unwrap(money.multiply(2));  // 200 USDC
console.log(doubled.toString());             // "$200.00 USDC"
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
import { BinaryOutcome, KnownOnChainProtocols, KnownChainIds } from '@polymarket/ids';
import type { OnChainConditionRef, ConditionId } from '@polymarket/ids';
import Decimal from 'decimal.js';

// Создание USDC quantity
const usdcResult = AssetQuantityService.createUsdc(100);
if (usdcResult.ok) {
  console.log(usdcResult.value.amount().toNumber());  // 100
  console.log(usdcResult.value.isCurrency());         // true
}

// Создание outcome token quantity
const conditionRef: OnChainConditionRef = {
  kind: 'ONCHAIN',
  protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
  chainId: KnownChainIds.POLYGON,
  conditionId: '0x1234567890123456789012345678901234567890123456789012345678901234' as ConditionId,
};
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

### 💳 [Fee](./fee/README.md)

Комиссия (fee) в любом активе: Currency (USDC) или OutcomeToken.

```typescript
import { FeeService, FeeOperationErrorReason } from '@polymarket/value-objects';
import { AssetIdHelpers } from '@polymarket/ids';
import Decimal from 'decimal.js';

// Создание Fee (Result-based)
const result = FeeService.create(AssetIdHelpers.USDC, 0.10);
if (result.ok) {
  console.log(result.value.quantity.amount().toNumber()); // 0.1
}

// Сложение fees (Result-based, Never Throws)
const fee1Result = FeeService.create(AssetIdHelpers.USDC, '0.10');
const fee2Result = FeeService.create(AssetIdHelpers.USDC, '0.05');

if (fee1Result.ok && fee2Result.ok) {
  const addResult = FeeService.add(fee1Result.value, fee2Result.value);

  if (addResult.ok) {
    console.log(addResult.value.quantity.amount().toNumber()); // 0.15
  } else if (addResult.error.context?.reason === FeeOperationErrorReason.ASSET_MISMATCH) {
    console.error('Cannot add fees with different assets');
  }
}
```

**Особенности:**

- Wrapper над AssetQuantity со специализацией для комиссий
- Result-based API для create() и add() (Never Throws)
- Разделение ошибок: InvalidFeeError (validation) vs FeeOperationError (domain rules)
- Использует @polymarket/math для unified arithmetic semantics
- Инвариант: amount >= 0 (non-negative)

**[→ Подробная документация](./fee/README.md)**

---

### 📈 Quote

Котировка с ценой покупки (bid) и продажи (ask).

```typescript
import { Quote, Price } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';

const bid = unwrap(Price.fromValue(0.54));
const ask = unwrap(Price.fromValue(0.56));

const quote = Quote.create(bid, ask);
quote.match({
  ok: (q) => {
    console.log(q.getSpread().getValue()); // 0.02 (2%)
    console.log(q.getMidPrice().getValue()); // 0.55
  },
  err: (error) => console.error(error)
});
```

---

### 📉 [Spread](./spread/README.md)

Спред между ценами покупки и продажи (bid-ask spread).

```typescript
import { SpreadService, SpreadFormatter } from '@polymarket/value-objects';

// Создание из чисел
const result = SpreadService.fromValues(0.48, 0.52);
if (result.ok) {
  const spread = result.value;

  console.log(spread.bid().toNumber());       // 0.48
  console.log(spread.ask().toNumber());       // 0.52
  console.log(spread.width().toNumber());     // 0.04
  console.log(spread.midpoint().toNumber());  // 0.50
  console.log(spread.widthRatio().toNumber()); // 0.08 (8%)

  // Форматирование
  console.log(SpreadFormatter.format(spread));
  // "0.4800-0.5200 (0.0400)"
}

// Операции: сужение, расширение, сдвиг
const tighter = SpreadService.tighten(spread, 0.01);
const wider = SpreadService.widen(spread, 0.02);
const shifted = SpreadService.shift(spread, 0.10);
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
import { Money, Percentage } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';

// Создание Money
const balance = unwrap(Money.fromValue(1000)); // 1000 USDC

// Расчёт комиссии
const feeRate = unwrap(Percentage.fromValue(0.25)); // 0.25%
const feeAmount = feeRate.of(balance.getAmount());

console.log(`Комиссия: ${feeAmount.toNumber()} USDC`); // "Комиссия: 2.5 USDC"

// Вычитание комиссии
const fee = unwrap(Money.fromValue(feeAmount));
const netBalance = unwrap(balance.subtract(fee));

console.log(netBalance.toString()); // "$997.50 USDC"
```

### Railway-Oriented Programming

```typescript
import { Money } from '@polymarket/value-objects';

// Обработка через match
const result = Money.fromValue(100);

result.match({
  ok: (money) => {
    console.log(`Success: ${money.toString()}`);
  },
  err: (error) => {
    console.error(`Error: ${error.message}`);
  }
});

// Цепочка операций
const finalResult = Money.fromValue(100)
  .flatMap(m => m.multiply(2))
  .flatMap(m => Money.fromValue(50).flatMap(fifty => m.add(fifty)));

finalResult.match({
  ok: (money) => console.log(money.getAmount()), // 250
  err: (error) => console.error(error)
});
```

### Решение проблемы floating point

```typescript
import { Money, Percentage } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';

// ❌ Проблема с обычным number
const wrong = 0.1 + 0.2; // 0.30000000000000004

// ✅ Решение с Money
const m1 = unwrap(Money.fromValue('0.1'));
const m2 = unwrap(Money.fromValue('0.2'));
const correct = unwrap(m1.add(m2));

console.log(correct.toDecimal().toString()); // "0.3" - точно!

// ✅ Решение с Percentage
const p1 = unwrap(Percentage.fromDecimal(0.1));
const p2 = unwrap(Percentage.fromDecimal(0.2));
const sum = unwrap(p1.add(p2));

console.log(sum.toDecimal().toString()); // "0.3" - точно!
```

### PnL (Profit & Loss) расчёты

```typescript
import { Money } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';

const cost = unwrap(Money.fromValue(100));
const revenue = unwrap(Money.fromValue(85));

const pnl = unwrap(revenue.subtract(cost));

if (pnl.isNegative()) {
  console.log(`Убыток: ${pnl.abs().toString()}`);
  // "Убыток: $15.00 USDC"
} else {
  console.log(`Прибыль: ${pnl.toString()}`);
}
```

## Документация

### Подробные гайды

- 💰 **[Money](./money.md)** — денежные суммы с высокой точностью
- 📊 **[Percentage](./percentage.md)** — процентные значения для комиссий и расчётов
- 💵 **[Balance](./balance.md)** — балансы счетов пользователей
- 📦 **[AssetQuantity](./asset-quantity/README.md)** — количество актива с операциями Ratio
- 💳 **[Fee](./fee/README.md)** — комиссии в любом активе (Result-based API)
- ↕️ **[Side](./side/README.md)** — направление торговой операции (BUY/SELL)
- ⏱️ **[Timestamp](./timestamp/README.md)** — момент времени в epoch milliseconds
- ±️ **[SignedQuantity](./signed-quantity/README.md)** — знаковые количества для P&L и позиций

### Архитектурные документы

- 🎨 **[Result Styles](./result-styles.md)** — стили работы с Result, архитектурное правило когда возвращать Result

## Особенности

### Неизменяемость (Immutability)

Все value objects неизменяемы — операции возвращают новые экземпляры:

```typescript
const m1 = unwrap(Money.fromValue(100));
const m2 = unwrap(m1.multiply(2));

console.log(m1.getAmount()); // 100 (оригинал не изменён)
console.log(m2.getAmount()); // 200 (новый объект)
```

### Валидация при создании

Невозможно создать невалидный value object:

```typescript
const invalid = Money.fromValue(NaN);

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
const m1 = unwrap(Money.fromValue(100, 'USDC'));
// Примечание: в текущей версии Money поддерживает только 'USDC'.
// Пример ниже — иллюстрация CurrencyMismatchError для будущих валют.
const m2 = unwrap(Money.fromValue(1, 'BTC' as SupportedCurrency)); // гипотетически

const result = m1.add(m2);

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
const price = unwrap(Money.fromValue('0.123456789012345'));
const quantity = new Decimal('1000000');

const total = unwrap(price.multiply(quantity));
console.log(total.toDecimal().toString());
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
│   ├── asset-quantity/    # AssetQuantity value object
│   ├── balance/           # Balance value object
│   ├── fee/               # Fee value object
│   ├── money/             # Money value object
│   ├── outcome-token/     # OutcomeToken value object
│   ├── price/             # Price value object
│   ├── quantity/          # Quantity value object
│   ├── quote/             # Quote value object
│   ├── ratio/             # Ratio value object
│   ├── side/              # Side value object
│   ├── signed-quantity/   # SignedQuantity value object
│   ├── spread/            # Spread value object
│   ├── timestamp/         # Timestamp value object
│   ├── token-balance/     # TokenBalance value object
│   └── index.ts           # Barrel exports
├── docs/
│   ├── README.md          # Этот файл
│   ├── asset-quantity/    # AssetQuantity документация
│   ├── balance/           # Balance документация
│   ├── fee/               # Fee документация
│   ├── money/             # Money документация
│   ├── quote/             # Quote документация
│   ├── ratio/             # Ratio документация
│   ├── side/              # Side документация
│   ├── signed-quantity/   # SignedQuantity документация
│   ├── spread/            # Spread документация
│   ├── timestamp/         # Timestamp документация
│   ├── token-balance/     # TokenBalance документация
│   └── ...                # Документация для остальных VO
└── README.md              # Корневой README
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

**Статистика тестов (основные пакеты):**

- Money: 77 тестов ✅
- Balance: 29 тестов ✅
- Percentage: 95 тестов ✅
- Всего: 201+ тестов ✅

## Примеры использования

### Торговые операции

```typescript
import { Money, Percentage, Price, Quantity } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';

// Параметры ордера
const price = unwrap(Price.fromValue(0.55));
const quantity = unwrap(Quantity.fromValue(100));
const feeRate = unwrap(Percentage.fromValue(0.25)); // 0.25%

// Расчёт стоимости (используем Decimal.js для точности)
const priceDecimal = price.getValue();
const qtyDecimal = quantity.getValue();
const orderValue = priceDecimal.times(qtyDecimal); // 55

// Создание Money для расчётов
const orderAmount = unwrap(Money.fromValue(orderValue));

// Расчёт комиссии
const feeAmount = feeRate.of(orderAmount.getAmount());
const fee = unwrap(Money.fromValue(feeAmount));

// Итоговая сумма
const total = unwrap(orderAmount.add(fee));

console.log(`Стоимость ордера: ${orderAmount.toString()}`); // "$55.00 USDC"
console.log(`Комиссия: ${fee.toString()}`);                // "$0.14 USDC"
console.log(`Итого: ${total.toString()}`);                  // "$55.14 USDC"
```

### Анализ портфеля

```typescript
import { Money } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';

const positions = [
  { symbol: 'YES-TRUMP', value: unwrap(Money.fromValue(1000)) },
  { symbol: 'NO-TRUMP', value: unwrap(Money.fromValue(500)) },
  { symbol: 'YES-BIDEN', value: unwrap(Money.fromValue(750)) },
];

// Расчёт общего портфеля
const totalValue = positions.reduce(
  (acc, pos) => unwrap(acc.add(pos.value)),
  Money.zero()
);

console.log(`Общая стоимость портфеля: ${totalValue.toString()}`);
// "Общая стоимость портфеля: $2,250.00 USDC"

// Расчёт доли каждой позиции
positions.forEach(pos => {
  const totalDecimal = totalValue.toDecimal();
  const posDecimal = pos.value.toDecimal();
  const shareDecimal = posDecimal.dividedBy(totalDecimal); // дробь от 0 до 1

  const share = unwrap(Percentage.fromDecimal(shareDecimal)); // fromDecimal ожидает долю (0.4444 = 44.44%)
  console.log(`${pos.symbol}: ${share.toString()}`);
});
// "YES-TRUMP: 44.44%"
// "NO-TRUMP: 22.22%"
// "YES-BIDEN: 33.33%"
```

## Best Practices

### ✅ DO: Используйте Result для обработки ошибок

```typescript
const result = Money.fromValue(value);

result.match({
  ok: (money) => processMoney(money),
  err: (error) => handleError(error)
});
```

### ✅ DO: Используйте unwrap() когда уверены

```typescript
import { unwrap } from '@polymarket/result';

const money = unwrap(Money.fromValue(100)); // OK для константных значений
```

### ✅ DO: Используйте строки для высокой точности

```typescript
// ✅ ХОРОШО
const precise = unwrap(Money.fromValue('100.123456789012345'));

// ❌ ПЛОХО
const imprecise = unwrap(Money.fromValue(100.123456789012345));
```

### ❌ DON'T: Не игнорируйте ошибки

```typescript
// ❌ ПЛОХО
const money = Money.fromValue(value); // Result игнорируется

// ✅ ХОРОШО
const result = Money.fromValue(value);
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

- **Документация:** [docs/](.)
- **Issues:** [GitHub Issues](https://github.com/polymarket/trading-system/issues)
- **Tests:** 201/201 passing ✅ (Money: 77, Percentage: 95, Balance: 29)
