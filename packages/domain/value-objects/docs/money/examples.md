# Money — Примеры использования

> Практические примеры для типичных сценариев

## Содержание

1. [Базовые операции](#базовые-операции)
2. [Управление балансом](#управление-балансом)
3. [Вычисление комиссий](#вычисление-комиссий)
4. [Profit & Loss (P&L)](#profit--loss-pl)
5. [Сериализация](#сериализация)
6. [Форматирование](#форматирование)
7. [Error Handling](#error-handling)

---

## Базовые операции

### Создание Money из пользовательского ввода

```typescript
import { MoneyService } from '@polymarket/value-objects/money';

function processDeposit(userInput: string) {
  // Пользователь вводит сумму депозита
  const result = MoneyService.create(userInput);

  if (!result.ok) {
    // Показываем понятную ошибку
    if (result.error.context?.reason === 'INVALID_FORMAT') {
      return { error: 'Please enter a valid number' };
    }
    if (result.error.context?.reason === 'EXCEEDS_MAX_AMOUNT') {
      return { error: 'Amount is too large' };
    }
    return { error: 'Invalid amount' };
  }

  const depositAmount = result.value;
  return { success: true, amount: depositAmount };
}

// Использование
const deposit = processDeposit("100.50");
if (deposit.success) {
  console.log(`Deposit: $${deposit.amount.amount()}`);
}
```

---

## Управление балансом

### Проверка достаточности средств

```typescript
import { Money } from '@polymarket/value-objects/money';

function canAfford(balance: Money, price: Money): boolean {
  // Балансы должны быть в одной валюте
  if (!balance.hasSameCurrency(price)) {
    throw new Error('Currency mismatch');
  }

  // Сравниваем как Decimal (точно)
  return balance.amount().greaterThanOrEqualTo(price.amount());
}

const userBalance = Money.of(1000, 'USDC');
const orderCost = Money.of(150, 'USDC');

if (canAfford(userBalance, orderCost)) {
  console.log('Sufficient funds');
} else {
  console.log('Insufficient funds');
}
```

### Обновление баланса после сделки

```typescript
import { MoneyService, Money } from '@polymarket/value-objects/money';

interface TradeResult {
  newBalance: Money;
  spent: Money;
}

function executeTrade(
  currentBalance: Money,
  tradeAmount: Money
): TradeResult | { error: string } {
  // Проверка валют
  if (!currentBalance.hasSameCurrency(tradeAmount)) {
    return { error: 'Currency mismatch' };
  }

  // Проверка достаточности средств
  if (currentBalance.amount().lessThan(tradeAmount.amount())) {
    return { error: 'Insufficient funds' };
  }

  // Вычисляем новый баланс
  const result = MoneyService.subtract(currentBalance, tradeAmount);

  if (!result.ok) {
    return { error: result.error.message };
  }

  return {
    newBalance: result.value,
    spent: tradeAmount
  };
}

// Использование
const balance = Money.of(1000, 'USDC');
const trade = Money.of(150.50, 'USDC');

const tradeResult = executeTrade(balance, trade);
if ('error' in tradeResult) {
  console.error(tradeResult.error);
} else {
  console.log(`New balance: $${tradeResult.newBalance.amount()}`);
  console.log(`Spent: $${tradeResult.spent.amount()}`);
}
```

### Накопление нескольких транзакций

```typescript
import { MoneyService, Money } from '@polymarket/value-objects/money';

function calculateTotalSpent(transactions: Money[]): Money | { error: string } {
  if (transactions.length === 0) {
    return Money.ZERO_USDC;
  }

  // Проверяем что все транзакции в одной валюте
  const currency = transactions[0].currency();
  if (!transactions.every(t => t.currency() === currency)) {
    return { error: 'All transactions must be in the same currency' };
  }

  // Накапливаем сумму
  let total = Money.zero(currency);

  for (const transaction of transactions) {
    const result = MoneyService.add(total, transaction);
    if (!result.ok) {
      return { error: `Failed to add transaction: ${result.error.message}` };
    }
    total = result.value;
  }

  return total;
}

// Использование
const transactions = [
  Money.of(100, 'USDC'),
  Money.of(50.50, 'USDC'),
  Money.of(25.75, 'USDC')
];

const total = calculateTotalSpent(transactions);
if ('error' in total) {
  console.error(total.error);
} else {
  console.log(`Total spent: $${total.amount()}`);  // $176.25
}
```

---

## Вычисление комиссий

### Процентная комиссия

```typescript
import { MoneyService, Money } from '@polymarket/value-objects/money';

function calculateFee(amount: Money, feePercent: number): Money | { error: string } {
  // Процент в десятичную дробь (0.5% = 0.005)
  const feeRate = (feePercent / 100).toString();

  const result = MoneyService.multiply(amount, feeRate);

  if (!result.ok) {
    return { error: `Fee calculation failed: ${result.error.message}` };
  }

  return result.value;
}

// Использование
const orderAmount = Money.of(1000, 'USDC');
const fee = calculateFee(orderAmount, 0.2);  // 0.2% fee

if ('error' in fee) {
  console.error(fee.error);
} else {
  console.log(`Fee: $${fee.amount()}`);  // $2.00
}
```

### Сумма с комиссией

```typescript
function calculateTotalWithFee(
  baseAmount: Money,
  feePercent: number
): Money | { error: string } {
  const fee = calculateFee(baseAmount, feePercent);
  if ('error' in fee) {
    return fee;
  }

  const result = MoneyService.add(baseAmount, fee);
  if (!result.ok) {
    return { error: `Failed to calculate total: ${result.error.message}` };
  }

  return result.value;
}

// Использование
const orderCost = Money.of(1000, 'USDC');
const totalWithFee = calculateTotalWithFee(orderCost, 0.2);

if ('error' in totalWithFee) {
  console.error(totalWithFee.error);
} else {
  console.log(`Total (with fee): $${totalWithFee.amount()}`);  // $1002.00
}
```

---

## Profit & Loss (P&L)

### Вычисление прибыли

```typescript
import { MoneyService, Money } from '@polymarket/value-objects/money';

function calculateProfit(
  sellPrice: Money,
  buyPrice: Money
): Money | { error: string } {
  // P&L = Sell - Buy
  const result = MoneyService.subtract(sellPrice, buyPrice);

  if (!result.ok) {
    return { error: `Failed to calculate profit: ${result.error.message}` };
  }

  return result.value;
}

// Использование
const bought = Money.of(950, 'USDC');
const sold = Money.of(1100, 'USDC');

const profit = calculateProfit(sold, bought);
if ('error' in profit) {
  console.error(profit.error);
} else {
  const amount = profit.amount().toNumber();
  if (amount > 0) {
    console.log(`Profit: +$${amount}`);  // +$150
  } else if (amount < 0) {
    console.log(`Loss: -$${Math.abs(amount)}`);
  } else {
    console.log('Break even');
  }
}
```

### Процент прибыли (ROI)

```typescript
import { MoneyService, Money } from '@polymarket/value-objects/money';
import Decimal from 'decimal.js';

function calculateROI(
  profit: Money,
  initialInvestment: Money
): Decimal | { error: string } {
  if (initialInvestment.amount().isZero()) {
    return { error: 'Cannot calculate ROI with zero investment' };
  }

  // ROI = (Profit / Investment) * 100
  const result = MoneyService.divide(profit, initialInvestment.amount());

  if (!result.ok) {
    return { error: `Failed to calculate ROI: ${result.error.message}` };
  }

  // Умножаем на 100 для процентов
  const roi = result.value.amount().times(100);
  return roi;
}

// Использование
const invested = Money.of(1000, 'USDC');
const currentValue = Money.of(1150, 'USDC');

const profitResult = MoneyService.subtract(currentValue, invested);
if (profitResult.ok) {
  const roi = calculateROI(profitResult.value, invested);
  if ('error' in roi) {
    console.error(roi.error);
  } else {
    console.log(`ROI: ${roi.toFixed(2)}%`);  // ROI: 15.00%
  }
}
```

---

## Сериализация

### API Request/Response

```typescript
import { MoneyService, MoneySerializer } from '@polymarket/value-objects/money';

// Отправка на сервер
function createOrder(amount: Money) {
  const payload = {
    orderId: "123",
    amount: MoneySerializer.toJSON(amount)
  };

  // payload = {
  //   orderId: "123",
  //   amount: { amount: "100.50", currency: "USDC" }
  // }

  return fetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

// Получение с сервера
async function getBalance(userId: string): Promise<Money | { error: string }> {
  const response = await fetch(`/api/balance/${userId}`);
  const data = await response.json();

  // data.balance = { amount: "1234.56", currency: "USDC" }
  const result = MoneySerializer.fromJSON(data.balance);

  if (!result.ok) {
    return { error: `Failed to parse balance: ${result.error.message}` };
  }

  return result.value;
}
```

---

## Форматирование

### Отображение для пользователя

```typescript
import { Money, MoneyFormatter } from '@polymarket/value-objects/money';

function formatBalance(balance: Money): string {
  // Для детального отображения (2 знака)
  return MoneyFormatter.toFixed(balance, 2);
}

function formatCurrency(amount: Money, showCurrency = true): string {
  // С символом валюты
  return MoneyFormatter.toCurrency(amount, showCurrency);
}

function formatCompact(amount: Money): string {
  // Компактный формат (K, M, B)
  return MoneyFormatter.toCompact(amount);
}

// Использование
const balance = Money.of(1234.567, 'USDC');

console.log(formatBalance(balance));           // "1234.57"
console.log(formatCurrency(balance));          // "$1234.57 USDC"
console.log(formatCurrency(balance, false));   // "$1234.57"

const large = Money.of(1500000, 'USDC');
console.log(formatCompact(large));             // "$1.5M"
```

---

## Error Handling

### Обработка всех типов ошибок

```typescript
import { MoneyService } from '@polymarket/value-objects/money';
import { InvalidMoneyError } from '@polymarket/errors';

function safeAdd(a: Money, b: Money): Money | null {
  const result = MoneyService.add(a, b);

  if (!result.ok) {
    const { reason, expected, actual } = result.error.context || {};

    if (reason === 'CURRENCY_MISMATCH') {
      console.error(`Currency mismatch: ${expected} vs ${actual}`);
    } else if (reason === 'EXCEEDS_MAX_AMOUNT') {
      console.error(`Arithmetic overflow: ${reason}`);
    } else {
      console.error(`Error: ${result.error.message}`);
    }
    return null;
  }

  return result.value;
}

function safeCreate(value: string): Money | null {
  const result = MoneyService.create(value);

  if (!result.ok) {
    const reason = result.error.context?.reason;

    switch (reason) {
      case 'INVALID_FORMAT':
        console.error('Invalid number format');
        break;
      case 'EXCEEDS_MAX_AMOUNT':
        console.error('Amount exceeds maximum (1e15)');
        break;
      case 'NON_FINITE':
        console.error('Amount must be finite');
        break;
      case 'NAN':
        console.error('Amount is NaN');
        break;
      default:
        console.error(result.error.message);
    }
    return null;
  }

  return result.value;
}
```

---

## Заключение

Money Value Object покрывает все типичные сценарии:
- ✅ Управление балансами
- ✅ Вычисление комиссий
- ✅ P&L и ROI
- ✅ Сериализация для API
- ✅ Форматирование для UI
- ✅ Явная обработка ошибок

Все операции type-safe и никогда не бросают исключения благодаря Result<T, E>.
