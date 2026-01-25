# Price Value Object

## Описание

**Price** — value object представляющий цену на рынках предсказаний.

### Характеристики

- **Immutable (Неизменяемый)**: все операции возвращают новый экземпляр
- **Type-safe**: используется Result<T, E> для явной обработки ошибок
- **Валидируемый**: диапазон [0.0001, 0.9999] (граничные значения рынков предсказаний)
- **Tick-aware**: поддержка округления до размера тика (tick size)
- **Ограниченный**: автоматическое ограничение (clamping) при операциях

### Диапазон цен

```typescript
Минимум: 0.0001 (0.01%)
Максимум: 0.9999 (99.99%)
```

**Почему такой диапазон?**

- Рынки предсказаний работают с вероятностями [0, 1]
- Граничные значения 0 и 1 исключены (нет смысла торговать событием с вероятностью 0% или 100%)
- Расширение до 0.0001/0.9999 позволяет обрабатывать edge-case цены

## Стили использования Result API

Result API поддерживает два стиля: **функциональный** и **OOP**. Оба полностью совместимы.

### Функциональный стиль (рекомендуется в документации)

```typescript
import { unwrap } from '@polymarket/result';

// Проверка через property
const result = Price.fromValue(0.5);
if (result.ok) {
  const price = result.value;  // Price
} else {
  const error = result.error;  // InvalidPriceError
}

// Unwrap helper
const price = unwrap(Price.fromValue(0.5));
```

### OOP стиль (альтернатива)

```typescript
import { OkChain } from '@polymarket/result';

// Проверка через метод
const result = Price.fromValue(0.5);
if (result.isOk()) {
  const price = result.unwrap();  // Price
} else {
  const error = result.unwrapErr();  // InvalidPriceError
}

// OkChain helper
const price = OkChain(Price.fromValue(0.5));

// Можно смешивать подходы
if (result.ok) {  // functional
  const price = result.unwrap();  // OOP
}
```

**Выбор стиля — дело вкуса**. TypeScript type narrowing работает лучше с `.ok`, поэтому в примерах ниже используется функциональный стиль. Вы можете использовать любой.

## Factory Methods

### `fromValue(value: number | string | Decimal): Result<Price, InvalidPriceError>`

Создаёт Price из числа, строки или Decimal с валидацией.

```typescript
import { unwrap } from '@polymarket/result';
import Decimal from 'decimal.js';

// Из числа
const result = Price.fromValue(0.65);
if (result.ok) {
  const price = result.value;
  console.log(price.value); // 0.65
} else {
  console.error(result.error.message);
}

// Используя unwrap для краткости
const price = unwrap(Price.fromValue(0.65));

// Из строки (парсинг)
const priceFromStr = unwrap(Price.fromValue('0.6547'));
console.log(priceFromStr.value); // 0.6547

// Из Decimal (для высокой точности)
const priceFromDecimal = unwrap(Price.fromValue(new Decimal('0.5234')));

// Edge cases поддерживаются
const lowPrice = unwrap(Price.fromValue(0.0001));  // Min
const highPrice = unwrap(Price.fromValue(0.9999)); // Max

// Невалидные значения возвращают Err
const invalid1 = Price.fromValue(-0.5);    // Error: отрицательная цена
const invalid2 = Price.fromValue(1.0);     // Error: выше максимума
const invalid3 = Price.fromValue(NaN);     // Error: не число
const invalid4 = Price.fromValue(Infinity); // Error: не конечное число
const invalid5 = Price.fromValue('not a number'); // Error: невалидная строка
```

## Операции округления

### `toTick(tickSize?: number): Result<Price, InvalidPriceError>`

Округляет цену до ближайшего tick size (размера тика).

```typescript
const price = unwrap(Price.fromValue(0.5234));

// Округление к ближайшему тику
const rounded = unwrap(price.toTick(0.01));
console.log(rounded.value); // 0.52

// Округление к tick size по умолчанию (0.0001)
const defaultRounded = unwrap(price.toTick());
console.log(defaultRounded.value); // 0.5234
```

### `floorToTick(tickSize?: number): Result<Price, InvalidPriceError>`

Округляет цену **вниз** до tick size.

```typescript
const price = unwrap(Price.fromValue(0.5239));

const floored = unwrap(price.floorToTick(0.01));
console.log(floored.value); // 0.52 (округлено вниз)
```

### `ceilToTick(tickSize?: number): Result<Price, InvalidPriceError>`

Округляет цену **вверх** до tick size.

```typescript
const price = unwrap(Price.fromValue(0.5231));

const ceiled = unwrap(price.ceilToTick(0.01));
console.log(ceiled.value); // 0.53 (округлено вверх)
```

## Арифметические операции

### `add(amount: number): Result<Price, InvalidPriceError>`

Прибавляет к цене. Результат ограничен MAX_PRICE (0.9999).

```typescript
const price = unwrap(Price.fromValue(0.65));

// Успешное сложение
const result = price.add(0.05);
if (result.ok) {
  console.log(result.value.value); // 0.70
}

// Автоматическое ограничение при превышении максимума
const nearMax = unwrap(Price.fromValue(0.98));
const clampedResult = nearMax.add(0.05);
const clamped = unwrap(clampedResult);
console.log(clamped.value); // 0.9999 (зажато в MAX_PRICE)

// Обработка ошибок через Result
const negativeResult = price.add(-0.1);
if (!negativeResult.ok) {
  console.error(negativeResult.error.message); // Invalid amount -0.1: must be non-negative
}

const nanResult = price.add(NaN);
if (!nanResult.ok) {
  console.error(nanResult.error.message); // Invalid amount NaN: must be a finite number
}
```

### `subtract(amount: number): Result<Price, InvalidPriceError>`

Вычитает из цены. Результат ограничен MIN_PRICE (0.0001).

```typescript
const price = unwrap(Price.fromValue(0.65));

const decreased = unwrap(price.subtract(0.05));
console.log(decreased.value); // 0.60

// Автоматическое ограничение при превышении минимума
const nearMin = unwrap(Price.fromValue(0.002));
const clamped = unwrap(nearMin.subtract(0.002));
console.log(clamped.value); // 0.0001 (зажато в MIN_PRICE)
```

### `multiply(factor: number): Result<Price, InvalidPriceError>`

Умножает цену на коэффициент. Результат ограничен [MIN_PRICE, MAX_PRICE].

```typescript
const price = unwrap(Price.fromValue(0.5));

// 0.5 * 2 = 1.0, но это превышает MAX_PRICE (0.9999), поэтому зажимается
const doubled = unwrap(price.multiply(2));
console.log(doubled.value); // 0.9999 (зажато в MAX_PRICE)

// Другой пример зажатия
const high = unwrap(Price.fromValue(0.99));
const overflow = unwrap(high.multiply(2));
console.log(overflow.value); // 0.9999 (зажато)
```

## Сравнение

### `isGreaterThan(other: Price): boolean`

Проверяет больше ли текущая цена чем другая.

```typescript
const p1 = unwrap(Price.fromValue(0.65));
const p2 = unwrap(Price.fromValue(0.60));

console.log(p1.isGreaterThan(p2)); // true
console.log(p2.isGreaterThan(p1)); // false
```

### `isLessThan(other: Price): boolean`

Проверяет меньше ли текущая цена чем другая.

```typescript
const p1 = unwrap(Price.fromValue(0.60));
const p2 = unwrap(Price.fromValue(0.65));

console.log(p1.isLessThan(p2)); // true
console.log(p2.isLessThan(p1)); // false
```

### `equals(other: Price): boolean`

Проверяет равенство цен (с учётом epsilon для floating-point сравнения).

```typescript
const p1 = unwrap(Price.fromValue(0.65));
const p2 = unwrap(Price.fromValue(0.65));
const p3 = unwrap(Price.fromValue(0.60));

console.log(p1.equals(p2)); // true
console.log(p1.equals(p3)); // false

// Floating-point epsilon (0.0000001)
const p4 = unwrap(Price.fromValue(0.5));
const p5 = unwrap(Price.fromValue(0.5 + 1e-8));
console.log(p4.equals(p5)); // true (в пределах epsilon)
```

## Утилиты

### `toString(decimals?: number): string`

Преобразует цену в строку с заданным количеством десятичных знаков.

```typescript
const price = unwrap(Price.fromValue(0.5234));

console.log(price.toString());   // "0.5234" (default: 4 decimals)
console.log(price.toString(2));  // "0.52"
console.log(price.toString(6));  // "0.523400"
```

### `toPercentage(): string`

Преобразует цену в процентную строку.

```typescript
const price = unwrap(Price.fromValue(0.5234));
console.log(price.toPercentage()); // "52.34%"

const low = unwrap(Price.fromValue(0.0001));
console.log(low.toPercentage()); // "0.01%"

const high = unwrap(Price.fromValue(0.9999));
console.log(high.toPercentage()); // "99.99%"
```

### Статические геттеры

```typescript
// Получить минимальную цену
console.log(Price.minPrice); // 0.0001

// Получить максимальную цену
console.log(Price.maxPrice); // 0.9999
```

### `isValid(value: number): boolean`

Статический метод для проверки валидности значения цены.

```typescript
// Валидные цены
console.log(Price.isValid(0.5));    // true
console.log(Price.isValid(0.0001)); // true
console.log(Price.isValid(0.9999)); // true

// Невалидные цены
console.log(Price.isValid(-0.5));   // false
console.log(Price.isValid(0));      // false
console.log(Price.isValid(1.0));    // false
console.log(Price.isValid(NaN));    // false
console.log(Price.isValid(Infinity)); // false
```

## Примеры использования

### 1. Обработка котировок с рынка

```typescript
import { unwrap } from '@polymarket/result';
import { Price } from '@polymarket/value-objects';

function processMarketQuote(bidStr: string, askStr: string, tickSize: number) {
  // Парсинг цен из строк
  const bid = unwrap(Price.fromValue(bidStr));
  const ask = unwrap(Price.fromValue(askStr));

  // Округление к tick size
  const roundedBid = unwrap(bid.floorToTick(tickSize));
  const roundedAsk = unwrap(ask.ceilToTick(tickSize));

  return {
    bid: roundedBid,
    ask: roundedAsk,
    spread: roundedAsk.value - roundedBid.value,
    midpoint: (roundedBid.value + roundedAsk.value) / 2
  };
}

// Использование
const quote = processMarketQuote('0.6473', '0.6528', 0.01);
console.log(`Bid: ${quote.bid.toPercentage()}`);     // "64.00%"
console.log(`Ask: ${quote.ask.toPercentage()}`);     // "66.00%"
console.log(`Spread: ${quote.spread * 100}%`);       // "2%"
console.log(`Mid: ${quote.midpoint * 100}%`);        // "65%"
```

### 2. Расчёт скорректированных цен для маркет-мейкинга

```typescript
import { unwrap } from '@polymarket/result';
import { Price } from '@polymarket/value-objects';

function adjustPricesForInventory(
  midPrice: Price,
  inventory: number, // положительный = long, отрицательный = short
  spreadHalfWidth: number = 0.01
): { bid: Price; ask: Price } {
  // Skew adjustment на основе inventory
  const skew = inventory * 0.0001; // 1 basis point per unit

  // Bid и ask с корректировкой
  const bidBase = unwrap(midPrice.subtract(spreadHalfWidth));
  const bid = unwrap(bidBase.add(skew));

  const askBase = unwrap(midPrice.add(spreadHalfWidth));
  const ask = unwrap(askBase.add(skew));

  return { bid, ask };
}

// Использование
const midPrice = unwrap(Price.fromValue(0.65));

// Neutral inventory
const neutral = adjustPricesForInventory(midPrice, 0);
console.log(`Neutral: ${neutral.bid.value} / ${neutral.ask.value}`);
// "0.64 / 0.66"

// Long inventory (+100 units) -> shift prices up to discourage buys
const long = adjustPricesForInventory(midPrice, 100);
console.log(`Long: ${long.bid.value} / ${long.ask.value}`);
// "0.6500 / 0.6700" (shifted up by 0.01)

// Short inventory (-100 units) -> shift prices down to encourage buys
const short = adjustPricesForInventory(midPrice, -100);
console.log(`Short: ${short.bid.value} / ${short.ask.value}`);
// "0.6300 / 0.6500" (shifted down by 0.01)
```

### 3. Проверка crossing ордеров (самоисполнение)

```typescript
import { unwrap } from '@polymarket/result';
import { Price } from '@polymarket/value-objects';

function wouldOrderCross(
  orderPrice: Price,
  orderSide: 'BUY' | 'SELL',
  marketBid: Price,
  marketAsk: Price
): boolean {
  if (orderSide === 'BUY') {
    // Buy order crosses если его цена >= рыночного ask
    return orderPrice.isGreaterThan(marketAsk) || orderPrice.equals(marketAsk);
  } else {
    // Sell order crosses если его цена <= рыночного bid
    return orderPrice.isLessThan(marketBid) || orderPrice.equals(marketBid);
  }
}

// Использование
const marketBid = unwrap(Price.fromValue(0.64));
const marketAsk = unwrap(Price.fromValue(0.66));

// Buy order выше market ask -> crosses
const buyOrder = unwrap(Price.fromValue(0.67));
console.log(wouldOrderCross(buyOrder, 'BUY', marketBid, marketAsk)); // true

// Sell order ниже market bid -> crosses
const sellOrder = unwrap(Price.fromValue(0.63));
console.log(wouldOrderCross(sellOrder, 'SELL', marketBid, marketAsk)); // true

// Buy order между spread -> НЕ crosses
const passiveBuy = unwrap(Price.fromValue(0.65));
console.log(wouldOrderCross(passiveBuy, 'BUY', marketBid, marketAsk)); // false
```

### 4. Вычисление edge price для лимитных ордеров

```typescript
import { unwrap } from '@polymarket/result';
import { Price } from '@polymarket/value-objects';

/**
 * Вычисляет edge price для лимит ордера с учётом:
 * - Текущей mid price
 * - Максимального slippage
 * - Tick size для округления
 */
function calculateEdgePrice(
  midPrice: Price,
  side: 'BUY' | 'SELL',
  maxSlippageBps: number, // basis points (1 bps = 0.01%)
  tickSize: number
): Price {
  const slippage = maxSlippageBps / 10000; // Convert bps to decimal

  let edgePrice: Price;
  if (side === 'BUY') {
    // Buy: mid + slippage, округлить вниз
    const adjusted = unwrap(midPrice.add(slippage));
    edgePrice = unwrap(adjusted.floorToTick(tickSize));
  } else {
    // Sell: mid - slippage, округлить вверх
    const adjusted = unwrap(midPrice.subtract(slippage));
    edgePrice = unwrap(adjusted.ceilToTick(tickSize));
  }

  return edgePrice;
}

// Использование
const midPrice = unwrap(Price.fromValue(0.6547));
const tickSize = 0.01;

// Buy с max slippage 200 bps (2%)
const buyEdge = calculateEdgePrice(midPrice, 'BUY', 200, tickSize);
console.log(`Buy edge: ${buyEdge.toPercentage()}`); // "67.00%"

// Sell с max slippage 200 bps (2%)
const sellEdge = calculateEdgePrice(midPrice, 'SELL', 200, tickSize);
console.log(`Sell edge: ${sellEdge.toPercentage()}`); // "64.00%"
```

## Best Practices

### ✅ DO

```typescript
// ✅ Используйте Result для безопасного создания
const result = Price.fromValue(userInput);
if (result.ok) {
  const price = result.value;
  // work with price
} else {
  console.error('Invalid price:', result.error.message);
}

// ✅ Используйте unwrap когда уверены в валидности
const price = unwrap(Price.fromValue(0.65));

// ✅ Округляйте к tick size перед отправкой ордеров
const rounded = unwrap(price.floorToTick(marketTickSize));

// ✅ Используйте методы сравнения вместо прямого доступа к .value
if (bidPrice.isLessThan(askPrice)) {
  // valid spread
}

// ✅ Учитывайте автоматическое ограничение (clamping)
const adjustedResult = price.add(0.5); // может быть зажато в MAX_PRICE
const adjusted = unwrap(adjustedResult);
```

### ❌ DON'T

```typescript
// ❌ НЕ игнорируйте Result
const price = Price.fromValue(userInput); // Type error!

// ❌ НЕ создавайте Price напрямую через конструктор
const price = new Price(0.65); // Constructor is private!

// ❌ НЕ изменяйте существующий Price
price.value = 0.70; // Error: readonly property

// ❌ НЕ сравнивайте цены через === на floating-point значениях
if (price1.value === price2.value) {} // Может дать false positive!
// Используйте:
if (price1.equals(price2)) {} // ✅ Правильно

// ❌ НЕ забывайте про автоматическое ограничение
const price = unwrap(Price.fromValue(0.99));
const doubled = price.multiply(2);
// doubled.value = 0.9999, НЕ 1.98!
```

## Архитектурные решения

### Почему диапазон [0.0001, 0.9999]?

1. **Рынки предсказаний**: цены представляют вероятности событий
2. **Нет смысла в 0% и 100%**: нельзя торговать событием с известным исходом
3. **Edge cases**: расширенный диапазон позволяет обрабатывать экстремальные цены

### Почему автоматическое ограничение (clamping)?

1. **Безопасность**: предотвращает выход цен за валидный диапазон
2. **Удобство**: не нужно вручную проверять границы после каждой операции
3. **Предсказуемость**: операции никогда не падают из-за переполнения

### Почему tick size awareness?

1. **Реальность рынков**: биржи имеют минимальный шаг цены (tick size)
2. **Корректность ордеров**: ордера должны быть округлены к tick size
3. **Гибкость**: поддержка разных tick sizes для разных рынков

## TypeScript Types

```typescript
type PriceValue = number; // [0.0001, 0.9999]

interface PriceOperations {
  // Округление
  toTick(tickSize?: number): Price;
  floorToTick(tickSize?: number): Result<Price, InvalidPriceError>;
  ceilToTick(tickSize?: number): Result<Price, InvalidPriceError>;

  // Арифметика
  add(amount: number): Result<Price, InvalidPriceError>;
  subtract(amount: number): Result<Price, InvalidPriceError>;
  multiply(factor: number): Result<Price, InvalidPriceError>;

  // Сравнение
  isGreaterThan(other: Price): boolean;
  isLessThan(other: Price): boolean;
  equals(other: Price): boolean;

  // Утилиты
  toString(decimals?: number): string;
  toPercentage(): string;
}
```

## Связь с другими Value Objects

- **Spread**: использует два Price (bid и ask) для представления спреда
- **Quote**: использует Price для bid/ask цен в котировке
- **Money**: Price — это безразмерная величина [0, 1], Money — денежная сумма с валютой
- **Percentage**: Price можно представить как процент (умножить на 100)

## См. также

- [Money](./money.md) - денежные суммы с валютой
- [Percentage](./percentage.md) - процентные значения
- [Spread](./spread.md) - bid-ask spread
- [Quote](./quote.md) - котировки маркет-мейкера
- [Result<T, E>](../../foundation/result/README.md) - обработка ошибок
