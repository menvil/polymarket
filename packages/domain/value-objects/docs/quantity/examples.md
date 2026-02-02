# Примеры использования Quantity Value Object

> Практические real-world примеры работы с Quantity в торговой системе

## Содержание

1. [Базовые операции](#базовые-операции)
2. [Создание ордеров](#создание-ордеров)
3. [Управление позициями](#управление-позициями)
4. [Округление и форматирование](#округление-и-форматирование)
5. [Batch-операции](#batch-операции)
6. [Сериализация для API](#сериализация-для-api)
7. [Error Handling](#error-handling)
8. [Advanced Patterns](#advanced-patterns)

---

## Базовые операции

### Создание Quantity

```typescript
import { QuantityService, Quantity, QuantityErrorReason } from '@polymarket/value-objects/quantity';

// Из number
const result1 = QuantityService.create(10);
if (result1.ok) {
  console.log(result1.value.value().toString()); // "10"
}

// Из string (для высокой точности)
const result2 = QuantityService.create("99999999999999999999.123456789");
if (result2.ok) {
  const qty = result2.value;
  console.log(qty.toNumber()); // Lossy для больших чисел
}

// Из Decimal (когда уже есть Decimal)
import Decimal from 'decimal.js';
const decimal = new Decimal("10.5");
const result3 = QuantityService.create(decimal);

// ❌ Ошибка: negative
const negResult = QuantityService.create(-1);
if (!negResult.ok) {
  console.log(negResult.error.context?.reason === QuantityErrorReason.NEGATIVE_QUANTITY); // true
  console.log(negResult.error.message); // "Quantity value cannot be negative"
}

// ❌ Ошибка: non-finite
const nanResult = QuantityService.create(NaN);
if (!nanResult.ok) {
  console.log(nanResult.error.context?.reason === QuantityErrorReason.NON_FINITE); // true
}
```

### Использование констант

```typescript
import { Quantity } from '@polymarket/value-objects/quantity';

// Переиспользуйте константы вместо создания новых экземпляров
const zero = Quantity.ZERO;
const one = Quantity.ONE;

// Пример: проверяем закрытую позицию
const position = Quantity.of(0);

// ✅ Хорошо: используем константу
if (position.equals(Quantity.ZERO)) {
  console.log('Position closed');
}

// ❌ Плохо: создаёт новый экземпляр каждый раз
if (position.equals(Quantity.of(0))) { ... }
```

### Арифметика

```typescript
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';

// Создаём Quantity через QuantityService.create()
const qty1Result = QuantityService.create(10);
const qty2Result = QuantityService.create(5);

if (!qty1Result.ok || !qty2Result.ok) {
  throw new Error('Failed to create quantities');
}

const qty1 = qty1Result.value;
const qty2 = qty2Result.value;

// Сложение
const sumResult = QuantityService.add(qty1, qty2);
if (sumResult.ok) {
  console.log(sumResult.value.value().toNumber()); // 15
}

// Вычитание
const diffResult = QuantityService.subtract(qty1, qty2);
if (diffResult.ok) {
  console.log(diffResult.value.value().toNumber()); // 5
}

// Умножение (number)
const multResult = QuantityService.multiply(qty1, 2);
if (multResult.ok) {
  console.log(multResult.value.value().toNumber()); // 20
}

// Умножение (string для высокой точности)
const multResult2 = QuantityService.multiply(qty1, "2.5");
if (multResult2.ok) {
  console.log(multResult2.value.value().toNumber()); // 25
}

// Деление (number)
const divResult = QuantityService.divide(qty1, 2);
if (divResult.ok) {
  console.log(divResult.value.value().toNumber()); // 5
}

// Деление (string)
const divResult2 = QuantityService.divide(qty1, "2.5");
if (divResult2.ok) {
  console.log(divResult2.value.value().toNumber()); // 4
}
```

---

## Создание ордеров

### Валидация ордера с minSize

```typescript
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';
import Decimal from 'decimal.js';

// Определение ValidationError (пользовательский класс ошибок)
class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// Предполагается что orderService доступен в контексте
// (например, внедрён через DI или импортирован)
interface OrderService {
  createOrder(params: { quantity: Quantity }): Promise<{ id: string }>;
}
declare const orderService: OrderService;

interface MarketConfig {
  minOrderSize: Decimal;
  stepSize: Decimal;
}

async function createOrder(
  userInput: string,
  marketConfig: MarketConfig
): Promise<{ orderId: string; quantity: Quantity }> {
  // Создаём quantity с валидацией инвариантов
  const quantityResult = QuantityService.create(userInput);

  if (!quantityResult.ok) {
    // Показываем пользователю понятную ошибку
    throw new ValidationError(
      `Invalid order quantity: ${quantityResult.error.message}`
    );
  }

  const orderQuantity = quantityResult.value;

  // Округляем к tick size
  const roundedResult = QuantityService.roundToStep(
    orderQuantity,
    marketConfig.stepSize
  );

  if (!roundedResult.ok) {
    throw new ValidationError(
      `Failed to round quantity: ${roundedResult.error.message}`
    );
  }

  const finalQuantity = roundedResult.value;

  // Проверяем минимальный размер ордера
  if (finalQuantity.value().lessThan(marketConfig.minOrderSize)) {
    throw new ValidationError(
      `Order quantity ${finalQuantity.value()} is below minOrderSize ${marketConfig.minOrderSize}`
    );
  }

  // Создаём ордер
  const order = await orderService.createOrder({
    quantity: finalQuantity,
    // ... другие параметры
  });

  return { orderId: order.id, quantity: finalQuantity };
}

// Использование
const marketConfig: MarketConfig = {
  minOrderSize: new Decimal(1),
  stepSize: new Decimal("0.01")
};

try {
  const order = await createOrder("10.567", marketConfig);
  console.log(`Order created: ${order.orderId}`);
  console.log(`Quantity: ${order.quantity.value()}`); // "10.57"
} catch (error) {
  console.error(error.message);
}
```

### Валидация множественных ордеров

```typescript
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

interface OrderInput {
  id: string;
  quantity: string;
}

interface ValidatedOrder {
  id: string;
  quantity: Quantity;
}

function validateOrders(
  inputs: OrderInput[]
): Result<ValidatedOrder[], InvalidQuantityError> {
  const validated: ValidatedOrder[] = [];

  for (const input of inputs) {
    const result = QuantityService.create(input.quantity);

    if (!result.ok) {
      // Возвращаем первую ошибку
      return Err(
        new InvalidQuantityError(
          `Order ${input.id} validation failed: ${result.error.message}`,
          {
            context: {
              ...result.error.context,
              orderId: input.id
            }
          }
        )
      );
    }

    validated.push({
      id: input.id,
      quantity: result.value
    });
  }

  return Ok(validated);
}

// Использование
const orders: OrderInput[] = [
  { id: "order-1", quantity: "10" },
  { id: "order-2", quantity: "5" },
  { id: "order-3", quantity: "-1" } // Невалидно: negative!
];

const result = validateOrders(orders);
if (!result.ok) {
  console.error(result.error.message); // "Order order-3 validation failed: ..."
  console.error(result.error.context?.reason); // "NEGATIVE"
} else {
  console.log(`Validated ${result.value.length} orders`);
}
```

---

## Управление позициями

### Частичное закрытие позиции

```typescript
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';

interface Position {
  marketId: string;
  quantity: Quantity;
}

function closePartialPosition(
  position: Position,
  closeAmount: Quantity
): Result<Position, InvalidQuantityError> {
  // Вычитаем closeAmount из текущей позиции
  const remainingResult = QuantityService.subtract(
    position.quantity,
    closeAmount
  );

  if (!remainingResult.ok) {
    // closeAmount больше текущей позиции
    return Err(
      new InvalidQuantityError(
        `Cannot close ${closeAmount.value()}: position is only ${position.quantity.value()}`,
        {
          context: {
            ...remainingResult.error.context,
            marketId: position.marketId
          }
        }
      )
    );
  }

  const remaining = remainingResult.value;

  // Результат уже валиден - Core гарантирует non-negative
  return Ok({
    marketId: position.marketId,
    quantity: remaining
  });
}

// Использование
const position: Position = {
  marketId: "market-123",
  quantity: Quantity.of(100)
};

// Закрываем 30
const result1 = closePartialPosition(position, Quantity.of(30));
if (result1.ok) {
  console.log(`Remaining: ${result1.value.quantity.value()}`); // "70"
}

// Пытаемся закрыть 150 (больше чем есть!)
const result2 = closePartialPosition(position, Quantity.of(150));
if (!result2.ok) {
  console.error(result2.error.message); // "Cannot close 150: position is only 100"
}
```

### Объединение позиций

```typescript
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';

interface Position {
  marketId: string;
  quantity: Quantity;
}

function mergePositions(positions: Position[]): Result<Quantity, InvalidQuantityError> {
  if (positions.length === 0) {
    return Ok(Quantity.ZERO);
  }

  let total = positions[0].quantity;

  for (let i = 1; i < positions.length; i++) {
    const addResult = QuantityService.add(total, positions[i].quantity);

    if (!addResult.ok) {
      return Err(
        new InvalidQuantityError(
          `Failed to merge positions: ${addResult.error.message}`,
          {
            context: addResult.error.context
          }
        )
      );
    }

    total = addResult.value;
  }

  return Ok(total);
}

// Использование
const positions: Position[] = [
  { marketId: "market-1", quantity: Quantity.of(10) },
  { marketId: "market-2", quantity: Quantity.of(20) },
  { marketId: "market-3", quantity: Quantity.of(30) }
];

const result = mergePositions(positions);
if (result.ok) {
  console.log(`Total position: ${result.value.value()}`); // "60"
}
```

### Вычисление PnL

```typescript
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

interface Trade {
  quantity: Quantity;
  price: Decimal;
}

interface PnL {
  quantity: Quantity;
  averagePrice: Decimal;
  totalCost: Decimal;
}

function calculatePnL(trades: Trade[]): Result<PnL, InvalidQuantityError> {
  if (trades.length === 0) {
    return Ok({
      quantity: Quantity.ZERO,
      averagePrice: new Decimal(0),
      totalCost: new Decimal(0)
    });
  }

  let totalQuantity = Quantity.ZERO;
  let totalCost = new Decimal(0);

  for (const trade of trades) {
    // Суммируем quantity
    const qtyResult = QuantityService.add(totalQuantity, trade.quantity);
    if (!qtyResult.ok) {
      return Err(qtyResult.error);
    }
    totalQuantity = qtyResult.value;

    // Суммируем cost
    const cost = trade.quantity.value().times(trade.price);
    totalCost = totalCost.plus(cost);
  }

  // Вычисляем средневзвешенную цену
  const averagePrice = totalQuantity.isZero()
    ? new Decimal(0)
    : totalCost.dividedBy(totalQuantity.value());

  return Ok({
    quantity: totalQuantity,
    averagePrice,
    totalCost
  });
}

// Использование
const trades: Trade[] = [
  { quantity: Quantity.of(10), price: new Decimal("0.5") },
  { quantity: Quantity.of(20), price: new Decimal("0.6") },
  { quantity: Quantity.of(30), price: new Decimal("0.55") }
];

const result = calculatePnL(trades);
if (result.ok) {
  const pnl = result.value;
  console.log(`Total quantity: ${pnl.quantity.value()}`); // "60"
  console.log(`Average price: ${pnl.averagePrice}`); // "0.558333..."
  console.log(`Total cost: ${pnl.totalCost}`); // "33.5"
}
```

---

## Округление и форматирование

### Округление к tick size

```typescript
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';
import Decimal from 'decimal.js';

// Различные режимы округления
const qty = Quantity.of("10.567");

// С number (простой вариант)
const rounded1 = QuantityService.roundToStep(qty, 0.01);
if (rounded1.ok) {
  console.log(rounded1.value.value().toString()); // "10.57"
}

// С string (рекомендуется для точности)
const rounded2 = QuantityService.roundToStep(qty, "0.01");
if (rounded2.ok) {
  console.log(rounded2.value.value().toString()); // "10.57"
}

// С Decimal
const stepSize = new Decimal("0.01");
const rounded3 = QuantityService.roundToStep(qty, stepSize);
if (rounded3.ok) {
  console.log(rounded3.value.value().toString()); // "10.57"
}

// ROUND_DOWN
const rounded4 = QuantityService.roundToStep(
  qty,
  "0.01",
  Decimal.ROUND_DOWN
);
if (rounded4.ok) {
  console.log(rounded4.value.value().toString()); // "10.56"
}

// ROUND_UP
const rounded5 = QuantityService.roundToStep(
  qty,
  "0.01",
  Decimal.ROUND_UP
);
if (rounded5.ok) {
  console.log(rounded5.value.value().toString()); // "10.57"
}

// ROUND_HALF_EVEN (banker's rounding)
const rounded6 = QuantityService.roundToStep(
  qty,
  stepSize,
  Decimal.ROUND_HALF_EVEN
);
if (rounded6.ok) {
  console.log(rounded6.value.value().toString()); // "10.57"
}
```

### Форматирование для UI

```typescript
import { Quantity, QuantityFormatter } from '@polymarket/value-objects/quantity';

// Различные форматы для отображения
const qty1 = Quantity.of(1500);
const qty2 = Quantity.of("10.567891");

// Для детального отображения
const formatted1 = QuantityFormatter.toString(qty1, 2);
if (formatted1.ok) console.log(formatted1.value); // "1500.00"

const formatted2 = QuantityFormatter.toString(qty2, 6);
if (formatted2.ok) console.log(formatted2.value); // "10.567891"

// Компактный формат (убирает лишние нули)
console.log(QuantityFormatter.toCompactString(qty1)); // "1500"
console.log(QuantityFormatter.toCompactString(qty2)); // "10.567891"

// Для dashboard (K/M суффиксы)
console.log(QuantityFormatter.toDisplayString(qty1)); // "1.50K"
console.log(QuantityFormatter.toDisplayString(Quantity.of(1500000))); // "1.50M"

// Для отладки
console.log(QuantityFormatter.toDebugString(qty1)); // "Quantity(1500)"
```

### Форматирование в таблице

```typescript
import { Quantity, QuantityFormatter } from '@polymarket/value-objects/quantity';

// Пример интерфейсов для демонстрации
interface Position {
  marketId: string;
  quantity: Quantity;
}

interface PositionRow {
  market: string;
  quantity: Quantity;
  displayQuantity: string;
}

function formatPositionsForTable(positions: Position[]): PositionRow[] {
  return positions.map(position => {
    const formattedResult = QuantityFormatter.toString(position.quantity, 2);
    return {
      market: position.marketId,
      quantity: position.quantity,
      // Используем 2 знака после запятой для UI
      displayQuantity: formattedResult.ok ? formattedResult.value : position.quantity.value().toString()
    };
  });
}

// Использование в React компоненте
function PositionsTable({ positions }: { positions: Position[] }) {
  const rows = formatPositionsForTable(positions);

  return (
    <table>
      <thead>
        <tr>
          <th>Market</th>
          <th>Quantity</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.market}>
            <td>{row.market}</td>
            <td>{row.displayQuantity}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

---

## Batch-операции

### Валидация множественных значений

```typescript
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';

function validateQuantities(
  values: string[]
): Result<Quantity[], InvalidQuantityError> {
  const quantities: Quantity[] = [];

  for (let i = 0; i < values.length; i++) {
    const result = QuantityService.create(values[i]);

    if (!result.ok) {
      // Возвращаем ошибку с индексом
      return Err(
        new InvalidQuantityError(
          `Validation failed at index ${i}: ${result.error.message}`,
          {
            context: {
              ...result.error.context,
              index: i
            }
          }
        )
      );
    }

    quantities.push(result.value);
  }

  return Ok(quantities);
}

// Использование
const inputs = ["10", "20.5", "-5", "30"]; // -5 невалидно!
const result = validateQuantities(inputs);

if (!result.ok) {
  console.error(result.error.message); // "Validation failed at index 2: ..."
  console.error(result.error.context?.index); // 2
} else {
  console.log(`Validated ${result.value.length} quantities`);
}
```

### Суммирование массива Quantity

```typescript
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';

function sumQuantities(
  quantities: Quantity[]
): Result<Quantity, InvalidQuantityError> {
  if (quantities.length === 0) {
    return Ok(Quantity.ZERO);
  }

  let total = quantities[0];

  for (let i = 1; i < quantities.length; i++) {
    const addResult = QuantityService.add(total, quantities[i]);

    if (!addResult.ok) {
      return Err(
        new InvalidQuantityError(
          `Failed to sum at index ${i}: ${addResult.error.message}`,
          {
            context: {
              ...addResult.error.context,
              index: i
            }
          }
        )
      );
    }

    total = addResult.value;
  }

  return Ok(total);
}

// Использование
const quantities = [
  Quantity.of(10),
  Quantity.of(20),
  Quantity.of(30)
];

const result = sumQuantities(quantities);
if (result.ok) {
  console.log(`Total: ${result.value.value()}`); // "60"
}
```

### Фильтрация и агрегация

```typescript
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

interface Trade {
  id: string;
  quantity: Quantity;
  price: Decimal;
}

function getTotalVolumeAbovePrice(
  trades: Trade[],
  minPrice: Decimal
): Result<Quantity, InvalidQuantityError> {
  // Фильтруем сделки
  const filtered = trades.filter(trade => trade.price.greaterThan(minPrice));

  if (filtered.length === 0) {
    return Ok(Quantity.ZERO);
  }

  // Суммируем quantities
  let total = filtered[0].quantity;

  for (let i = 1; i < filtered.length; i++) {
    const addResult = QuantityService.add(total, filtered[i].quantity);

    if (!addResult.ok) {
      return Err(addResult.error);
    }

    total = addResult.value;
  }

  return Ok(total);
}

// Использование
const trades: Trade[] = [
  { id: "1", quantity: Quantity.of(10), price: new Decimal("0.5") },
  { id: "2", quantity: Quantity.of(20), price: new Decimal("0.6") },
  { id: "3", quantity: Quantity.of(30), price: new Decimal("0.4") }
];

const result = getTotalVolumeAbovePrice(trades, new Decimal("0.45"));
if (result.ok) {
  console.log(`Total volume: ${result.value.value()}`); // "30" (trades 1 + 2)
}
```

---

## Сериализация для API

### Точная сериализация (string)

```typescript
import { Quantity, QuantitySerializer } from '@polymarket/value-objects/quantity';

// Для больших чисел или высокой точности
const qty = Quantity.of("99999999999999999999.123456789");

// Сериализация → JSON
const json = QuantitySerializer.toJSON(qty);
console.log(json); // { value: "99999999999999999999.123456789" }

// Отправляем на сервер
const payload = {
  orderId: "order-123",
  quantity: json
};

await fetch('/api/orders', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
});

// На сервере: десериализация
const result = QuantitySerializer.fromJSON(json);
if (result.ok) {
  const quantity = result.value;
  // Точность полностью сохранена!
  console.log(quantity.value().toString()); // "99999999999999999999.123456789"
}
```

### Lossy сериализация (number)

```typescript
import { Quantity, QuantityLossySerializer } from '@polymarket/value-objects/quantity';

// Для UI или когда точность не критична
const qty = Quantity.of("123.456789");

// Lossy сериализация → JSON
const jsonResult = QuantityLossySerializer.toJSON(qty);
if (jsonResult.ok) {
  console.log(jsonResult.value); // { value: 123.456789 }
}

// ⚠️ Внимание: lossy для больших чисел!
const bigQty = Quantity.of("99999999999999999999.123");
const bigJsonResult = QuantityLossySerializer.toJSON(bigQty);
if (bigJsonResult.ok) {
  console.log(bigJsonResult.value); // { value: 1e+20 } - потеря точности!
}
```

### Сериализация для хранения в БД

```typescript
import { QuantityService, Quantity, QuantitySerializer } from '@polymarket/value-objects/quantity';

interface OrderEntity {
  id: string;
  quantityValue: string; // Храним как string в БД
  createdAt: Date;
}

// Сохранение в БД
async function saveOrder(orderId: string, quantity: Quantity) {
  const entity: OrderEntity = {
    id: orderId,
    quantityValue: quantity.value().toString(), // Сохраняем как string
    createdAt: new Date()
  };

  await db.orders.insert(entity);
}

// Загрузка из БД
async function loadOrder(orderId: string): Promise<{ id: string; quantity: Quantity }> {
  const entity = await db.orders.findOne({ id: orderId });

  // Восстанавливаем Quantity из string
  const result = QuantityService.create(entity.quantityValue);

  if (!result.ok) {
    throw new Error(`Failed to deserialize quantity: ${result.error.message}`);
  }

  return {
    id: entity.id,
    quantity: result.value
  };
}
```

---

## Error Handling

### Централизованная обработка ошибок

```typescript
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';
import { InvalidQuantityError } from '@polymarket/errors';

function handleQuantityError(error: InvalidQuantityError): string {
  const ctx = error.context;

  // Проверяем операцию
  switch (ctx?.op) {
    case 'create':
      if (ctx.reason === 'NEGATIVE') {
        return 'Quantity cannot be negative';
      }
      if (ctx.reason === 'NON_FINITE') {
        return 'Quantity must be a valid number';
      }
      if (error.message.includes('minimum size')) {
        return `Minimum order size is ${ctx.minSize}`;
      }
      break;

    case 'subtract':
      return 'Insufficient quantity for this operation';

    case 'divide':
      if (ctx.cause?.name === 'DivisionByZeroError') {
        return 'Cannot divide by zero';
      }
      break;

    case 'multiply':
      if (ctx.reason === 'NEGATIVE') {
        return 'Cannot multiply by negative factor';
      }
      break;
  }

  // Fallback
  return error.message;
}

// Использование
const result = QuantityService.create(userInput);
if (!result.ok) {
  const userMessage = handleQuantityError(result.error);
  showErrorToUser(userMessage);

  // Логируем для отладки
  logger.error('Quantity operation failed', {
    op: result.error.context?.op,
    value: result.error.context?.value,
    reason: result.error.context?.reason
  });
}
```

### Retry с fallback

```typescript
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

async function createOrderWithRetry(
  quantity: string,
  maxRetries: number = 3
): Promise<Quantity> {
  let lastError: InvalidQuantityError | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = QuantityService.create(quantity);

    if (result.ok) {
      return result.value;
    }

    lastError = result.error;

    // Если ошибка валидации - не ретраим
    if (result.error.context?.reason === 'NEGATIVE' ||
        result.error.context?.reason === 'NON_FINITE') {
      throw result.error;
    }

    // Ждём перед повторной попыткой
    await sleep(attempt * 1000);
  }

  throw lastError || new Error('Failed to create order after retries');
}
```

### Graceful degradation

```typescript
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';

function getQuantityOrDefault(
  value: string,
  defaultValue: Quantity = Quantity.ZERO
): Quantity {
  const result = QuantityService.create(value);

  if (result.ok) {
    return result.value;
  }

  // Логируем ошибку но возвращаем default
  logger.warn('Failed to parse quantity, using default', {
    value,
    error: result.error.message,
    default: defaultValue.value().toString()
  });

  return defaultValue;
}

// Использование
const qty = getQuantityOrDefault(userInput, Quantity.ONE);
```

---

## Advanced Patterns

### Chain операций с early return

```typescript
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

function processTradeSequence(
  initialPosition: string,
  trades: Array<{ type: 'buy' | 'sell'; amount: string }>
): Result<Quantity, InvalidQuantityError> {
  // Создаём начальную позицию
  const initResult = QuantityService.create(initialPosition);
  if (!initResult.ok) return initResult;

  let position = initResult.value;

  // Обрабатываем сделки
  for (const trade of trades) {
    // Парсим amount
    const tradeResult = QuantityService.create(trade.amount);
    if (!tradeResult.ok) return tradeResult;

    const tradeQty = tradeResult.value;

    // Применяем сделку
    if (trade.type === 'buy') {
      const addResult = QuantityService.add(position, tradeQty);
      if (!addResult.ok) return addResult;
      position = addResult.value;
    } else {
      const subtractResult = QuantityService.subtract(position, tradeQty);
      if (!subtractResult.ok) return subtractResult;
      position = subtractResult.value;
    }
  }

  return Ok(position);
}

// Использование
const trades = [
  { type: 'buy' as const, amount: '10' },
  { type: 'buy' as const, amount: '20' },
  { type: 'sell' as const, amount: '15' }
];

const result = processTradeSequence('100', trades);
if (result.ok) {
  console.log(`Final position: ${result.value.value()}`); // "115"
}
```

### Builder паттерн для сложных операций

```typescript
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

class QuantityCalculator {
  private current: Result<Quantity, InvalidQuantityError>;

  constructor(initial: Quantity) {
    this.current = Ok(initial);
  }

  add(qty: Quantity): this {
    if (!this.current.ok) return this;

    this.current = QuantityService.add(this.current.value, qty);
    return this;
  }

  subtract(qty: Quantity): this {
    if (!this.current.ok) return this;

    this.current = QuantityService.subtract(this.current.value, qty);
    return this;
  }

  multiply(factor: number | Decimal): this {
    if (!this.current.ok) return this;

    this.current = QuantityService.multiply(this.current.value, factor);
    return this;
  }

  divide(divisor: number | Decimal): this {
    if (!this.current.ok) return this;

    this.current = QuantityService.divide(this.current.value, divisor);
    return this;
  }

  roundToStep(stepSize: Decimal): this {
    if (!this.current.ok) return this;

    this.current = QuantityService.roundToStep(this.current.value, stepSize);
    return this;
  }

  build(): Result<Quantity, InvalidQuantityError> {
    return this.current;
  }
}

// Использование
const result = new QuantityCalculator(Quantity.of(100))
  .add(Quantity.of(50))
  .multiply(2)
  .subtract(Quantity.of(100))
  .divide(5)
  .roundToStep(new Decimal("0.01"))
  .build();

if (result.ok) {
  console.log(`Result: ${result.value.value()}`); // "20.00"
}
```

### Мемоизация для производительности

```typescript
import { Quantity, QuantityFormatter } from '@polymarket/value-objects/quantity';

class MemoizedQuantityFormatter {
  private cache = new Map<string, string>();

  format(quantity: Quantity, decimals: number): string {
    const key = `${quantity.value().toString()}_${decimals}`;

    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }

    const formattedResult = QuantityFormatter.toString(quantity, decimals);
    const formatted = formattedResult.ok ? formattedResult.value : quantity.value().toString();
    this.cache.set(key, formatted);

    return formatted;
  }

  clear(): void {
    this.cache.clear();
  }
}

// Использование
const formatter = new MemoizedQuantityFormatter();

const qty = Quantity.of("123.456789");

// Первый вызов: форматирует
console.log(formatter.format(qty, 2)); // "123.46"

// Второй вызов: из кэша
console.log(formatter.format(qty, 2)); // "123.46" (instant)
```

---

## Заключение

Эти примеры демонстрируют различные паттерны использования Quantity в реальных сценариях:

1. **Создание и валидация** — всегда через `QuantityService`
2. **Арифметика** — с обработкой overflow/underflow
3. **Ордера** — с `minSize` и `stepSize`
4. **Позиции** — с частичным закрытием и объединением
5. **Форматирование** — для UI и API
6. **Batch операции** — с early return
7. **Error handling** — централизованный и graceful degradation
8. **Advanced patterns** — builder, memoization, retry

Все паттерны следуют принципу **explicit error handling** через `Result<T, E>`.
