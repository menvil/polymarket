# SignedQuantity: Примеры использования

Практические примеры работы с SignedQuantity в различных сценариях.

## Содержание

- [Базовые операции](#базовые-операции)
- [Trading сценарии](#trading-сценарии)
- [Account Management](#account-management)
- [Форматирование для UI](#форматирование-для-ui)
- [Сериализация](#сериализация)
- [Паттерны обработки ошибок](#паттерны-обработки-ошибок)

## Базовые операции

### Создание и валидация

```typescript
import { SignedQuantityService } from '@polymarket/value-objects/signed-quantity';
import { isErr } from '@polymarket/result';

// ✅ Валидные значения
const positive = SignedQuantityService.create(100);
const negative = SignedQuantityService.create(-50);
const zero = SignedQuantityService.create(0);
const decimal = SignedQuantityService.create('123.456');

// ❌ Невалидные значения
const nan = SignedQuantityService.create(NaN);
const infinity = SignedQuantityService.create(Infinity);
const invalid = SignedQuantityService.create('not-a-number');

if (isErr(nan)) {
  console.error(nan.error.context?.reason); // 'NAN'
}
```

### Арифметика

```typescript
const aResult = SignedQuantityService.create(100);
const bResult = SignedQuantityService.create(-30);

if (aResult.ok && bResult.ok) {
  const a = aResult.value;
  const b = bResult.value;

  // Сложение
  const sum = SignedQuantityService.add(a, b);
  if (sum.ok) {
    console.log(sum.value.toNumber()); // 70
  }

  // Вычитание (может быть отрицательным!)
  const diff = SignedQuantityService.subtract(a, b);
  if (diff.ok) {
    console.log(diff.value.toNumber()); // 130
  }

  // Умножение на отрицательный фактор
  const scaled = SignedQuantityService.multiply(a, -0.5);
  if (scaled.ok) {
    console.log(scaled.value.toNumber()); // -50
  }

  // Деление
  const divided = SignedQuantityService.divide(a, 2);
  if (divided.ok) {
    console.log(divided.value.toNumber()); // 50
  }
}
```

### Операции со знаком

```typescript
const qtyResult = SignedQuantityService.create(-75);
if (qtyResult.ok) {
  const qty = qtyResult.value;

  // Проверки знака
  console.log(qty.isPositive()); // false
  console.log(qty.isNegative()); // true
  console.log(qty.isZero());     // false
  console.log(qty.sign());       // -1

  // Абсолютное значение
  const abs = SignedQuantityService.abs(qty);
  if (abs.ok) {
    console.log(abs.value.toNumber()); // 75
  }

  // Инверсия знака
  const negated = SignedQuantityService.negate(qty);
  if (negated.ok) {
    console.log(negated.value.toNumber()); // 75
  }
}
```

## Trading сценарии

### Position Delta Tracking

```typescript
interface Trade {
  side: 'buy' | 'sell';
  quantity: number;
}

function calculateNetPosition(trades: Trade[]): SignedQuantity | null {
  let position = SignedQuantity.ZERO;

  for (const trade of trades) {
    const qty = SignedQuantityService.create(
      trade.side === 'buy' ? trade.quantity : -trade.quantity
    );

    if (!qty.ok) {
      console.error('Invalid trade quantity', qty.error);
      return null;
    }

    const result = SignedQuantityService.add(position, qty.value);
    if (!result.ok) {
      console.error('Failed to add position', result.error);
      return null;
    }

    position = result.value;
  }

  return position;
}

// Использование
const trades: Trade[] = [
  { side: 'buy', quantity: 100 },
  { side: 'sell', quantity: 30 },
  { side: 'buy', quantity: 50 },
  { side: 'sell', quantity: 20 }
];

const netPosition = calculateNetPosition(trades);
if (netPosition) {
  console.log(`Net position: ${netPosition.toNumber()}`); // 100
}
```

### Position Reversal Detection

```typescript
function detectPositionReversal(
  currentPosition: SignedQuantity,
  newTrade: SignedQuantity
): { reversed: boolean; newPosition: SignedQuantity } | null {
  const result = SignedQuantityService.add(currentPosition, newTrade);

  if (!result.ok) {
    return null;
  }

  const newPosition = result.value;

  // Разворот произошёл если знак изменился (и не на ноль)
  const reversed =
    !currentPosition.isZero() &&
    !newPosition.isZero() &&
    currentPosition.sign() !== newPosition.sign();

  return { reversed, newPosition };
}

// Использование
const longPositionResult = SignedQuantityService.create(100);
const shortTradeResult = SignedQuantityService.create(-200);

if (longPositionResult.ok && shortTradeResult.ok) {
  const longPosition = longPositionResult.value;
  const shortTrade = shortTradeResult.value;

  const result = detectPositionReversal(longPosition, shortTrade);
  if (result) {
    console.log(`Reversed: ${result.reversed}`); // true
    console.log(`New position: ${result.newPosition.toNumber()}`); // -100
  }
}
```

### P&L Calculation

```typescript
interface Position {
  quantity: SignedQuantity;
  entryPrice: number;
}

function calculatePnL(
  position: Position,
  currentPrice: number
): SignedQuantity | null {
  // P&L = quantity * (currentPrice - entryPrice)
  const priceDelta = currentPrice - position.entryPrice;

  const result = SignedQuantityService.multiply(
    position.quantity,
    priceDelta
  );

  return result.ok ? result.value : null;
}

// Использование
const longQtyResult = SignedQuantityService.create(100);
if (longQtyResult.ok) {
  const longPosition: Position = {
    quantity: longQtyResult.value,
    entryPrice: 50
  };

  const pnl = calculatePnL(longPosition, 55);
  if (pnl) {
    console.log(`P&L: $${pnl.toNumber()}`); // 500
  }
}

// Short position P&L
const shortQtyResult = SignedQuantityService.create(-100);
if (shortQtyResult.ok) {
  const shortPosition: Position = {
    quantity: shortQtyResult.value,
    entryPrice: 50
  };

  const pnl2 = calculatePnL(shortPosition, 55);
  if (pnl2) {
    console.log(`P&L: $${pnl2.toNumber()}`); // -500 (убыток на шорте)
  }
}
```

### Partial Close Position

```typescript
function partialClosePosition(
  position: SignedQuantity,
  closePercentage: number
): SignedQuantity | null {
  // Закрываем X% позиции
  const closeFactor = -(closePercentage / 100);

  const closeQty = SignedQuantityService.multiply(position, closeFactor);
  if (!closeQty.ok) {
    return null;
  }

  const result = SignedQuantityService.add(position, closeQty.value);
  return result.ok ? result.value : null;
}

// Использование
const positionResult = SignedQuantityService.create(1000);
if (positionResult.ok) {
  const position = positionResult.value;

  // Закрываем 50% позиции
  const remaining = partialClosePosition(position, 50);
  if (remaining) {
    console.log(`Remaining: ${remaining.toNumber()}`); // 500
  }
}
```

## Account Management

### Balance Changes Tracking

```typescript
enum TransactionType {
  DEPOSIT = 'deposit',
  WITHDRAWAL = 'withdrawal',
  FEE = 'fee',
  PROFIT = 'profit',
  LOSS = 'loss'
}

interface Transaction {
  type: TransactionType;
  amount: number; // всегда положительное
}

function applyTransaction(
  balance: SignedQuantity,
  transaction: Transaction
): SignedQuantity | null {
  // Определяем знак на основе типа транзакции
  const sign = [TransactionType.DEPOSIT, TransactionType.PROFIT].includes(transaction.type) ? 1 : -1;

  const change = SignedQuantityService.create(sign * transaction.amount);
  if (!change.ok) {
    return null;
  }

  const result = SignedQuantityService.add(balance, change.value);
  return result.ok ? result.value : null;
}

// Использование
let balance = SignedQuantity.ZERO;

const transactions: Transaction[] = [
  { type: TransactionType.DEPOSIT, amount: 10000 },
  { type: TransactionType.FEE, amount: 50 },
  { type: TransactionType.PROFIT, amount: 500 },
  { type: TransactionType.WITHDRAWAL, amount: 2000 }
];

for (const tx of transactions) {
  const newBalance = applyTransaction(balance, tx);
  if (newBalance) {
    balance = newBalance;
  }
}

console.log(`Final balance: $${balance.toNumber()}`); // 8450
```

### Margin Calculation

```typescript
function calculateMarginRequirement(
  position: SignedQuantity,
  price: number,
  marginRate: number
): number | null {
  // Margin = |position * price| * marginRate
  const abs = SignedQuantityService.abs(position);
  if (!abs.ok) {
    return null;
  }

  return abs.value.toNumber() * price * marginRate;
}

// Использование
const positionResult = SignedQuantityService.create(-100); // Short 100
if (positionResult.ok) {
  const position = positionResult.value;
  const margin = calculateMarginRequirement(position, 50, 0.25);
  console.log(`Margin required: $${margin}`); // 1250
}
```

## Форматирование для UI

### Различные форматы

```typescript
import { SignedQuantityFormatter } from '@polymarket/value-objects/signed-quantity';

const profitResult = SignedQuantityService.create(1250.5);
const lossResult = SignedQuantityService.create(-750.25);

if (profitResult.ok && lossResult.ok) {
  const profit = profitResult.value;
  const loss = lossResult.value;

  // Стандартный формат
  const std1 = SignedQuantityFormatter.toString(profit, 2);
  if (std1.ok) {
    console.log(std1.value); // "+1250.50"
  }

  // Без знака плюс
  const std2 = SignedQuantityFormatter.toString(profit, 2, { showPlusSign: false });
  if (std2.ok) {
    console.log(std2.value); // "1250.50"
  }

  // Компактный формат
  console.log(SignedQuantityFormatter.toCompactString(profit)); // "+1250.5"
  console.log(SignedQuantityFormatter.toCompactString(loss));   // "-750.25"

  // Финансовый формат (negative in parentheses)
  const fin1 = SignedQuantityFormatter.toFinancialString(profit, 2);
  const fin2 = SignedQuantityFormatter.toFinancialString(loss, 2);
  if (fin1.ok && fin2.ok) {
    console.log(fin1.value); // "1250.50"
    console.log(fin2.value); // "(750.25)"
  }

  // Debug формат
  console.log(SignedQuantityFormatter.toDebugString(profit)); // "SignedQuantity(+1250.5)"
}
```

### Дисплейный формат с K/M

```typescript
const smallResult = SignedQuantityService.create(500);
const mediumResult = SignedQuantityService.create(15000);
const largeResult = SignedQuantityService.create(2500000);

if (smallResult.ok && mediumResult.ok && largeResult.ok) {
  const small = smallResult.value;
  const medium = mediumResult.value;
  const large = largeResult.value;

  console.log(SignedQuantityFormatter.toDisplayString(small));   // "+500.00"
  console.log(SignedQuantityFormatter.toDisplayString(medium));  // "+15.00K"
  console.log(SignedQuantityFormatter.toDisplayString(large));   // "+2.50M"

  // Без знака плюс
  console.log(SignedQuantityFormatter.toDisplayString(medium, { showPlusSign: false })); // "15.00K"
}
```

### P&L для UI

```typescript
import { SignedQuantityFormatter } from '@polymarket/value-objects/signed-quantity';

function renderPnL(pnl: SignedQuantity): string {
  const formatted = SignedQuantityFormatter.toPnLString(pnl, 2);

  if (!formatted.ok) {
    return 'Error';
  }

  const { value, indicator } = formatted.value;

  // В React можно использовать indicator для стилизации:
  // <span className={indicator === 'profit' ? 'text-green' : 'text-red'}>
  //   {value}
  // </span>

  const color = indicator === 'profit' ? '🟢' : indicator === 'loss' ? '🔴' : '⚪';
  return `${color} ${value}`;
}

// Использование
const profitResult = SignedQuantityService.create(1250);
const lossResult = SignedQuantityService.create(-750);

if (profitResult.ok && lossResult.ok) {
  const profit = profitResult.value;
  const loss = lossResult.value;
  const breakEven = SignedQuantity.ZERO;

  console.log(renderPnL(profit));     // "🟢 +1250.00"
  console.log(renderPnL(loss));       // "🔴 -750.00"
  console.log(renderPnL(breakEven));  // "⚪ 0.00"
}
```

## Сериализация

### JSON Round-trip

```typescript
import { SignedQuantitySerializer } from '@polymarket/value-objects/signed-quantity';

// Сериализация
const qtyResult = SignedQuantityService.create(-123.456);
if (qtyResult.ok) {
  const qty = qtyResult.value;
  const json = SignedQuantitySerializer.toJSON(qty);

  console.log(json); // { value: "-123.456" }

  // Сохранение в API/DB
  const jsonString = JSON.stringify(json);

  // Десериализация
  const parsed = JSON.parse(jsonString);
  const result = SignedQuantitySerializer.fromJSON(parsed);

  if (result.ok) {
    console.log(result.value.toNumber()); // -123.456
    console.log(result.value.equals(qty)); // true
  }
}
```

### API Response Handling

```typescript
interface PositionResponse {
  assetId: string;
  quantity: unknown; // JSON из API
}

function parsePosition(response: PositionResponse): SignedQuantity | null {
  const result = SignedQuantitySerializer.fromJSON(response.quantity);

  if (!result.ok) {
    console.error('Invalid position quantity', result.error);
    return null;
  }

  return result.value;
}

// Использование
const apiResponse: PositionResponse = {
  assetId: 'BTC-USD',
  quantity: { value: "-5.5" } // Short 5.5 BTC
};

const position = parsePosition(apiResponse);
if (position) {
  console.log(`Position: ${position.toNumber()} BTC`);
}
```

### State Persistence

```typescript
interface AccountState {
  balance: SignedQuantity;
  positions: Map<string, SignedQuantity>;
}

// Сериализация состояния
function serializeState(state: AccountState): string {
  const json = {
    balance: SignedQuantitySerializer.toJSON(state.balance),
    positions: Array.from(state.positions.entries()).map(([asset, qty]) => ({
      asset,
      quantity: SignedQuantitySerializer.toJSON(qty)
    }))
  };

  return JSON.stringify(json);
}

// Десериализация состояния
function deserializeState(data: string): AccountState | null {
  const json = JSON.parse(data);

  // Десериализация balance
  const balanceResult = SignedQuantitySerializer.fromJSON(json.balance);
  if (!balanceResult.ok) {
    return null;
  }

  // Десериализация positions
  const positions = new Map<string, SignedQuantity>();
  for (const { asset, quantity } of json.positions) {
    const qtyResult = SignedQuantitySerializer.fromJSON(quantity);
    if (!qtyResult.ok) {
      return null;
    }
    positions.set(asset, qtyResult.value);
  }

  return {
    balance: balanceResult.value,
    positions
  };
}
```

## Паттерны обработки ошибок

### Явная обработка

```typescript
import { isErr, isOk } from '@polymarket/result';

const result = SignedQuantityService.create(input);

if (isErr(result)) {
  // Детальная информация об ошибке
  console.error('Operation:', result.error.context?.op);
  console.error('Reason:', result.error.context?.reason);
  console.error('Message:', result.error.message);
  return;
}

// TypeScript знает что result.ok === true
const qty = result.value;
```

### Propagation через Result

```typescript
import { Ok } from '@polymarket/result';

function calculateNetPnL(
  positions: SignedQuantity[],
  pnls: SignedQuantity[]
): Result<SignedQuantity, InvalidSignedQuantityError> {
  let total = SignedQuantity.ZERO;

  for (const pnl of pnls) {
    const result = SignedQuantityService.add(total, pnl);
    if (!result.ok) {
      // Прокидываем ошибку выше
      return result;
    }
    total = result.value;
  }

  return Ok(total);
}
```

### Helper для unwrap

```typescript
// ⚠️ Используй ТОЛЬКО когда уверен что не будет ошибки
function expectOk<T, E extends Error>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`Unexpected error: ${result.error.message}`);
  }
  return result.value;
}

// Использование
const qty = expectOk(SignedQuantityService.create(100));
```

### Error Recovery

```typescript
function safeAdd(
  a: SignedQuantity,
  b: SignedQuantity,
  fallback: SignedQuantity = SignedQuantity.ZERO
): SignedQuantity {
  const result = SignedQuantityService.add(a, b);
  return result.ok ? result.value : fallback;
}

// Использование
const sum = safeAdd(qty1, qty2, SignedQuantity.ZERO);
```

### Валидация с context

```typescript
import { SignedQuantityErrorReason } from '@polymarket/value-objects/signed-quantity';

function validateQuantity(input: unknown): string | null {
  if (typeof input !== 'number' && typeof input !== 'string') {
    return 'Input must be a number or string';
  }

  const result = SignedQuantityService.create(input);

  if (!result.ok) {
    const reason = result.error.context?.reason;

    switch (reason) {
      case SignedQuantityErrorReason.NAN:
        return 'Value must be a valid number';
      case SignedQuantityErrorReason.NON_FINITE:
        return 'Value must be finite (not Infinity)';
      case SignedQuantityErrorReason.INVALID_FORMAT:
        return 'Invalid number format';
      default:
        return 'Invalid quantity';
    }
  }

  return null; // валидно
}

// Использование в форме
const error = validateQuantity(userInput);
if (error) {
  showError(error);
}
```

## См. также

- [README.md](../README.md) — основная документация
- [architecture.md](./architecture.md) — архитектурные решения
- [facade.md](./facade.md) — детали SignedQuantityService
