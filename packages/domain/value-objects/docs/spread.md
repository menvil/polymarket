# Spread Value Object

## Описание

**Spread** — value object представляющий bid-ask spread на рынках предсказаний.

### Характеристики

- **Immutable (Неизменяемый)**: все операции возвращают новый экземпляр
- **Type-safe**: используется Result<T, E> для явной обработки ошибок
- **Валидируемый**: bid ≤ ask
- **Price-based**: оперирует с Price value objects
- **Rich operations**: tighten, widen, shift для маркет-мейкинга

### Что такое Spread?

Spread (спред) — это разница между ценой bid (покупка) и ask (продажа):

```text
Spread = Ask - Bid

Bid  ←─────── Spread Width ────────→  Ask
0.48                                  0.52
     ←─── 0.04 (4 cents) ────→
```

**На рынках предсказаний:**

- **Bid** — максимальная цена, которую покупатели готовы заплатить
- **Ask** — минимальная цена, по которой продавцы готовы продать
- **Spread Width** — стоимость ликвидности (чем уже, тем ликвиднее рынок)
- **Midpoint** — теоретическая "справедливая" цена: (bid + ask) / 2

## Factory Methods

### `create(bid: Price, ask: Price): Result<Spread, InvalidSpreadError>`

Создаёт Spread из цен bid и ask с валидацией.

```typescript
import { unwrap } from '@polymarket/result';
import { Price, Spread } from '@polymarket/value-objects';

// Создание валидного спреда
const bid = unwrap(Price.fromValue(0.48));
const ask = unwrap(Price.fromValue(0.52));

const result = Spread.create(bid, ask);
if (result.ok) {
  const spread = result.value;
  console.log(spread.width());      // 0.04
  console.log(spread.midpoint().value); // 0.5
} else {
  console.error(result.error.message);
}

// Или используя unwrap
const spread = unwrap(Spread.create(bid, ask));

// Невалидный спред (bid > ask)
const invalid = Spread.create(
  unwrap(Price.fromValue(0.6)),
  unwrap(Price.fromValue(0.5))
);
if (!invalid.ok) {
  console.error(invalid.error.message);
  // "Invalid spread: bid (0.6) must be <= ask (0.5)"
}
```

### `fromNumbers(bid: number, ask: number): Result<Spread, InvalidSpreadError | InvalidPriceError>`

Создаёт Spread из чисел (удобный shortcut).

Может вернуть ошибки:

- **InvalidPriceError** - если bid или ask выходят за допустимые границы [0.0001, 0.9999]
- **InvalidSpreadError** - если bid > ask

```typescript
import { unwrap } from '@polymarket/result';

// Создание из чисел
const result = Spread.fromNumbers(0.48, 0.52);
if (result.ok) {
  const spread = result.value;
  console.log(spread.width()); // 0.04
}

// Или используя unwrap
const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

// Ошибка если цены невалидны (за границами [0.0001, 0.9999])
const invalid1 = Spread.fromNumbers(1.5, 2.0);  // InvalidPriceError

// Ошибка если bid > ask
const invalid2 = Spread.fromNumbers(0.6, 0.5);  // InvalidSpreadError
```

### `zero(price: Price): Spread`

Создаёт спред с нулевой шириной (bid = ask).

```typescript
import { unwrap } from '@polymarket/result';

const price = unwrap(Price.fromValue(0.5));
const spread = Spread.zero(price);

console.log(spread.width());        // 0
console.log(spread.isZeroWidth());  // true
console.log(spread.bid.value);      // 0.5
console.log(spread.ask.value);      // 0.5
```

**Когда использовать:** Нулевой спред указывает на идеальную ликвидность на данном уровне цен.

## Метрики спреда

### `width(): number`

Вычисляет ширину спреда (ask - bid).

```typescript
const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

console.log(spread.width()); // 0.04 (4 cents)
```

**Интерпретация:**

- Узкий спред (< 0.02): ликвидный рынок
- Средний спред (0.02 - 0.05): нормальная ликвидность
- Широкий спред (> 0.05): низкая ликвидность или высокая неопределённость

### `widthPercentage(): number`

Вычисляет ширину спреда в процентах относительно midpoint.

```typescript
const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

const percentage = spread.widthPercentage();
console.log(percentage); // 8
// Расчёт: (0.04 / 0.5) * 100 = 8%

// Широкий спред
const wideSpread = unwrap(Spread.fromNumbers(0.01, 0.99));
console.log(wideSpread.widthPercentage()); // 196%
```

**Применение:** Нормализация спреда для сравнения на разных уровнях цен.

### `midpoint(): Price`

Вычисляет среднюю цену (справедливую цену).

```typescript
const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

const mid = spread.midpoint();
console.log(mid.value); // 0.5
console.log(mid.toPercentage()); // "50.00%"
```

**Применение:** Используется как референсная цена для аналитики и стратегий.

### `isZeroWidth(): boolean`

Проверяет, имеет ли спред нулевую ширину.

```typescript
const price = unwrap(Price.fromValue(0.5));
const zeroSpread = Spread.zero(price);

console.log(zeroSpread.isZeroWidth()); // true

const normalSpread = unwrap(Spread.fromNumbers(0.48, 0.52));
console.log(normalSpread.isZeroWidth()); // false
```

**Применение:** Обнаружение идеальной ликвидности или locked markets.

### `isWide(threshold?: number): boolean`

Проверяет, является ли спред широким.

```typescript
const spread = unwrap(Spread.fromNumbers(0.45, 0.55));

// Default threshold: 0.05 (5 cents)
console.log(spread.isWide()); // true (width = 0.10 > 0.05)

// Custom threshold
console.log(spread.isWide(0.15)); // false (width = 0.10 < 0.15)
console.log(spread.isWide(0.08)); // true (width = 0.10 > 0.08)
```

**Применение:** Определение низкой ликвидности или неактивных рынков.

## Операции со спредом

### `tighten(amount: number): Result<Spread, InvalidSpreadError>`

Сужает спред, сдвигая bid вверх и ask вниз.

```typescript
import { unwrap } from '@polymarket/result';

const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

const result = spread.tighten(0.01);
if (result.ok) {
  const tightened = result.value;
  console.log(tightened.bid.value);   // 0.49
  console.log(tightened.ask.value);   // 0.51
  console.log(tightened.width());     // 0.02
}

// Или используя unwrap
const tightened = unwrap(spread.tighten(0.01));

// Автоматическое ограничение до нулевой ширины
const maxTightened = unwrap(spread.tighten(0.1)); // More than half width
console.log(maxTightened.isZeroWidth()); // true
console.log(maxTightened.width());       // 0

// Обработка ошибок InvalidSpreadError
const invalidResult = spread.tighten(NaN);
if (!invalidResult.ok) {
  console.error(invalidResult.error.message); // InvalidSpreadError
}
```

**Применение:**

- Агрессивный маркет-мейкинг
- Улучшение fill rate
- Конкуренция за top of book

**Формула:**

```text
New Bid = Old Bid + amount
New Ask = Old Ask - amount
New Width = Old Width - 2 * amount
```

### `widen(amount: number): Result<Spread, InvalidSpreadError>`

Расширяет спред, сдвигая bid вниз и ask вверх.

```typescript
import { unwrap } from '@polymarket/result';

const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

const result = spread.widen(0.02);
if (result.ok) {
  const widened = result.value;
  console.log(widened.bid.value);  // 0.46
  console.log(widened.ask.value);  // 0.54
  console.log(widened.width());    // 0.08
}

// Или используя unwrap
const widened = unwrap(spread.widen(0.02));

// Соблюдает границы цен [0.0001, 0.9999]
const edgeSpread = unwrap(Spread.fromNumbers(0.001, 0.999));
const maxWidened = unwrap(edgeSpread.widen(0.1));
console.log(maxWidened.bid.value); // 0.0001 (clamped)
console.log(maxWidened.ask.value); // 0.9999 (clamped)

// Обработка ошибок InvalidSpreadError
const invalidWidenResult = spread.widen(Infinity);
if (!invalidWidenResult.ok) {
  console.error(invalidWidenResult.error.message); // InvalidSpreadError
}
```

**Применение:**

- Консервативный маркет-мейкинг
- Увеличение прибыли на spread
- Снижение риска adverse selection

**Формула:**

```text
New Bid = Old Bid - amount
New Ask = Old Ask + amount
New Width = Old Width + 2 * amount
```

### `shift(amount: number): Result<Spread, InvalidSpreadError>`

Сдвигает спред вверх или вниз, сохраняя ширину.

```typescript
import { unwrap } from '@polymarket/result';

const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

// Сдвиг вверх (positive amount)
const result = spread.shift(0.05);
if (result.ok) {
  const shiftedUp = result.value;
  console.log(shiftedUp.bid.value);  // 0.53
  console.log(shiftedUp.ask.value);  // 0.57
  console.log(shiftedUp.width());    // 0.04 (unchanged)
}

// Или используя unwrap
const shiftedDown = unwrap(spread.shift(-0.05));
console.log(shiftedDown.bid.value);  // 0.43
console.log(shiftedDown.ask.value);  // 0.47
console.log(shiftedDown.width());    // 0.04 (unchanged)

// Автоматическое ограничение на границах
const lowSpread = unwrap(Spread.fromNumbers(0.005, 0.045));
const clamped = unwrap(lowSpread.shift(-0.1));
console.log(clamped.bid.value);  // 0.0001 (clamped to MIN_PRICE)
console.log(clamped.width());    // ~0.04 (preserved)
```

**Применение:**

- Skewing based on inventory (inventory management)
- Tracking market mid-price movement
- Repositioning spread without changing width

**Формула:**

```text
New Bid = Old Bid + amount
New Ask = Old Ask + amount
Width = constant
```

## Проверки

### `isValid(bid: Price, ask: Price): boolean`

Статический метод для проверки валидности спреда.

```typescript
const bid = unwrap(Price.fromValue(0.48));
const ask = unwrap(Price.fromValue(0.52));

console.log(Spread.isValid(bid, ask)); // true

const invalidBid = unwrap(Price.fromValue(0.6));
const invalidAsk = unwrap(Price.fromValue(0.5));

console.log(Spread.isValid(invalidBid, invalidAsk)); // false (bid > ask)

// Равные цены валидны (zero-width spread)
const price = unwrap(Price.fromValue(0.5));
console.log(Spread.isValid(price, price)); // true
```

### `contains(price: Price): boolean`

Проверяет, находится ли цена внутри спреда.

```typescript
const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

const insidePrice = unwrap(Price.fromValue(0.5));
console.log(spread.contains(insidePrice)); // true

const outsidePrice = unwrap(Price.fromValue(0.6));
console.log(spread.contains(outsidePrice)); // false

// Границы включены
const bidPrice = unwrap(Price.fromValue(0.48));
const askPrice = unwrap(Price.fromValue(0.52));
console.log(spread.contains(bidPrice)); // true
console.log(spread.contains(askPrice)); // true
```

**Применение:** Проверка пересечения ордеров с рыночным спредом.

### `equals(other: Spread): boolean`

Проверяет равенство спредов.

```typescript
const s1 = unwrap(Spread.fromNumbers(0.48, 0.52));
const s2 = unwrap(Spread.fromNumbers(0.48, 0.52));
const s3 = unwrap(Spread.fromNumbers(0.49, 0.52));

console.log(s1.equals(s2)); // true
console.log(s1.equals(s3)); // false
```

## Утилиты

### `toString(): string`

Форматирует спред как строку.

```typescript
const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

console.log(spread.toString());
// "0.4800-0.5200 (0.0400)"
```

### `toObject(): { bid, ask, width, midpoint }`

Преобразует в объектное представление.

```typescript
const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

const obj = spread.toObject();
console.log(obj);
// {
//   bid: 0.48,
//   ask: 0.52,
//   width: 0.04,
//   midpoint: 0.5
// }
```

**Применение:** Сериализация, логирование, API responses.

## Примеры использования

### 1. Market-Making с динамическим спредом

```typescript
import { unwrap } from '@polymarket/result';
import { Spread } from '@polymarket/value-objects';

class MarketMaker {
  private baseSpread: Spread;

  constructor(
    private readonly fairPrice: number,
    private readonly baseWidth: number
  ) {
    this.baseSpread = unwrap(
      Spread.fromNumbers(
        fairPrice - baseWidth / 2,
        fairPrice + baseWidth / 2
      )
    );
  }

  // Корректировка спреда на основе inventory
  adjustForInventory(inventory: number, maxInventory: number): Spread {
    // inventory > 0 = long position (хотим продать)
    // inventory < 0 = short position (хотим купить)

    const inventoryRatio = inventory / maxInventory;

    // Skew amount: сдвиг спреда для балансировки inventory
    const skewAmount = inventoryRatio * 0.02; // 2 cents max skew

    // Сдвигаем спред: long position -> вниз (encourage sells)
    //                 short position -> вверх (encourage buys)
    return unwrap(this.baseSpread.shift(-skewAmount));
  }

  // Корректировка ширины на основе волатильности
  adjustForVolatility(volatility: number): Spread {
    // Высокая волатильность -> шире спред (больше риск)
    // Низкая волатильность -> уже спред (конкурентоспособность)

    const widthAdjustment = volatility * 0.01; // 1 cent per volatility unit

    if (volatility > 1.0) {
      return unwrap(this.baseSpread.widen(widthAdjustment));
    } else {
      return unwrap(this.baseSpread.tighten(widthAdjustment));
    }
  }

  // Итоговый спред с всеми корректировками
  getFinalQuote(inventory: number, maxInventory: number, volatility: number): Spread {
    // 1. Применяем inventory adjustment (shift)
    let spread = this.adjustForInventory(inventory, maxInventory);

    // 2. Применяем volatility adjustment (widen/tighten)
    const widthAdjustment = volatility * 0.01; // 1 cent per volatility unit
    if (volatility > 1.0) {
      spread = unwrap(spread.widen(widthAdjustment));
    } else if (volatility < 1.0) {
      spread = unwrap(spread.tighten(widthAdjustment));
    }

    // 3. Применяем minimum-width правило
    if (spread.widthPercentage() < 5) {
      spread = unwrap(spread.widen(0.01)); // Minimum 5% spread
    }

    return spread;
  }
}

// Использование
const mm = new MarketMaker(0.65, 0.04);

// Neutral inventory
const neutralQuote = mm.adjustForInventory(0, 100);
console.log(neutralQuote.toString());
// "0.6300-0.6700 (0.0400)"

// Long inventory (+50 units) -> shift down to encourage sells
const longQuote = mm.adjustForInventory(50, 100);
console.log(longQuote.toString());
// "0.6200-0.6600 (0.0400)" (shifted down)

// Short inventory (-50 units) -> shift up to encourage buys
const shortQuote = mm.adjustForInventory(-50, 100);
console.log(shortQuote.toString());
// "0.6400-0.6800 (0.0400)" (shifted up)
```

### 2. Анализ качества рынка

```typescript
import { unwrap } from '@polymarket/result';
import { Spread } from '@polymarket/value-objects';

interface MarketQuality {
  liquidity: 'excellent' | 'good' | 'fair' | 'poor';
  spreadWidth: number;
  spreadPercentage: number;
  recommendation: string;
}

function analyzeMarketQuality(spread: Spread): MarketQuality {
  const width = spread.width();
  const percentage = spread.widthPercentage();

  let liquidity: MarketQuality['liquidity'];
  let recommendation: string;

  if (width < 0.02) {
    liquidity = 'excellent';
    recommendation = 'Tight spread - excellent for trading. Low transaction cost.';
  } else if (width < 0.05) {
    liquidity = 'good';
    recommendation = 'Moderate spread - reasonable for trading.';
  } else if (width < 0.10) {
    liquidity = 'fair';
    recommendation = 'Wide spread - consider limit orders to avoid high costs.';
  } else {
    liquidity = 'poor';
    recommendation = 'Very wide spread - illiquid market. Trade with caution.';
  }

  return {
    liquidity,
    spreadWidth: width,
    spreadPercentage: percentage,
    recommendation
  };
}

// Использование
const tightSpread = unwrap(Spread.fromNumbers(0.64, 0.66));
console.log(analyzeMarketQuality(tightSpread));
// {
//   liquidity: 'excellent',
//   spreadWidth: 0.02,
//   spreadPercentage: 3.08,
//   recommendation: 'Tight spread - excellent for trading...'
// }

const wideSpread = unwrap(Spread.fromNumbers(0.4, 0.6));
console.log(analyzeMarketQuality(wideSpread));
// {
//   liquidity: 'poor',
//   spreadWidth: 0.2,
//   spreadPercentage: 40,
//   recommendation: 'Very wide spread - illiquid market...'
// }
```

### 3. Обнаружение crossing orders (арбитраж)

```typescript
import { unwrap } from '@polymarket/result';
import { Spread, Price } from '@polymarket/value-objects';

interface CrossingDetection {
  crosses: boolean;
  arbitrageOpportunity?: {
    type: 'buy' | 'sell';
    profit: number;
    action: string;
  };
}

function detectCrossing(
  ourSpread: Spread,
  marketSpread: Spread
): CrossingDetection {
  // Наш bid пересекает market ask -> можем купить дешевле чем продаём
  if (ourSpread.bid.isGreaterThan(marketSpread.ask) ||
      ourSpread.bid.equals(marketSpread.ask)) {
    return {
      crosses: true,
      arbitrageOpportunity: {
        type: 'buy',
        profit: ourSpread.bid.value - marketSpread.ask.value,
        action: `Buy at market ask ${marketSpread.ask.value}, sell at our bid ${ourSpread.bid.value}`
      }
    };
  }

  // Наш ask пересекает market bid -> можем продать дороже чем покупаем
  if (ourSpread.ask.isLessThan(marketSpread.bid) ||
      ourSpread.ask.equals(marketSpread.bid)) {
    return {
      crosses: true,
      arbitrageOpportunity: {
        type: 'sell',
        profit: marketSpread.bid.value - ourSpread.ask.value,
        action: `Sell at market bid ${marketSpread.bid.value}, buy at our ask ${ourSpread.ask.value}`
      }
    };
  }

  return { crosses: false };
}

// Использование
const marketSpread = unwrap(Spread.fromNumbers(0.64, 0.66));

// Наш спред внутри рынка - нормально
const insideSpread = unwrap(Spread.fromNumbers(0.645, 0.655));
console.log(detectCrossing(insideSpread, marketSpread));
// { crosses: false }

// Наш bid выше market ask - арбитраж!
const crossingBid = unwrap(Spread.fromNumbers(0.67, 0.69));
console.log(detectCrossing(crossingBid, marketSpread));
// {
//   crosses: true,
//   arbitrageOpportunity: {
//     type: 'buy',
//     profit: 0.01,
//     action: 'Buy at market ask 0.66, sell at our bid 0.67'
//   }
// }
```

### 4. Adaptive spread based on order flow

```typescript
import { unwrap } from '@polymarket/result';
import { Spread } from '@polymarket/value-objects';

interface OrderFlowMetrics {
  buyPressure: number;  // 0-1
  sellPressure: number; // 0-1
  imbalance: number;    // -1 to 1
}

function adjustSpreadForOrderFlow(
  baseSpread: Spread,
  metrics: OrderFlowMetrics
): Spread {
  // Imbalance: positive = more buyers, negative = more sellers
  const imbalance = metrics.imbalance;

  // Более покупателей -> сдвигаем вверх и расширяем ask
  // Более продавцов -> сдвигаем вниз и расширяем bid

  if (Math.abs(imbalance) < 0.1) {
    // Balanced flow - keep base spread
    return baseSpread;
  }

  // Calculate adjustments
  const shiftAmount = imbalance * 0.01; // Max 1 cent shift
  const widenAmount = Math.abs(imbalance) * 0.005; // Max 0.5 cent widen

  // Apply adjustments
  let adjusted = unwrap(baseSpread.shift(shiftAmount));
  adjusted = unwrap(adjusted.widen(widenAmount));

  return adjusted;
}

// Использование
const baseSpread = unwrap(Spread.fromNumbers(0.64, 0.66));

// Balanced flow
const balanced = adjustSpreadForOrderFlow(baseSpread, {
  buyPressure: 0.5,
  sellPressure: 0.5,
  imbalance: 0
});
console.log(balanced.toString());
// "0.6400-0.6600 (0.0200)" (unchanged)

// Strong buy pressure (imbalance = 0.5)
const buyHeavy = adjustSpreadForOrderFlow(baseSpread, {
  buyPressure: 0.8,
  sellPressure: 0.3,
  imbalance: 0.5
});
console.log(buyHeavy.toString());
// "0.6425-0.6625 (0.0200)" (shifted up + widened)

// Strong sell pressure (imbalance = -0.5)
const sellHeavy = adjustSpreadForOrderFlow(baseSpread, {
  buyPressure: 0.3,
  sellPressure: 0.8,
  imbalance: -0.5
});
console.log(sellHeavy.toString());
// "0.6375-0.6575 (0.0200)" (shifted down + widened)
```

## Best Practices

### ✅ DO

```typescript
// ✅ Используйте Result для создания
const result = Spread.fromNumbers(0.48, 0.52);
if (result.ok) {
  const spread = result.value;
}

// ✅ Используйте unwrap когда уверены в валидности
const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

// ✅ Проверяйте валидность перед созданием
if (Spread.isValid(bid, ask)) {
  const spread = unwrap(Spread.create(bid, ask));
}

// ✅ Используйте метрики для анализа
if (spread.isWide()) {
  console.warn('Low liquidity detected');
}

// ✅ Сохраняйте ширину при shift
const shifted = unwrap(spread.shift(0.05));
console.assert(shifted.width() === spread.width());
```

### ❌ DON'T

```typescript
// ❌ НЕ игнорируйте Result
const spread = Spread.create(bid, ask); // Type error!

// ❌ НЕ создавайте Spread напрямую
const spread = new Spread(bid, ask); // Constructor is private!

// ❌ НЕ изменяйте существующий Spread
spread.bid = newBid; // Error: readonly property

// ❌ НЕ забывайте про валидацию bid <= ask
const invalid = Spread.create(
  unwrap(Price.fromValue(0.6)),
  unwrap(Price.fromValue(0.5))
); // Вернёт Err!

// ❌ НЕ предполагайте что операции сохраняют ширину
const widened = spread.widen(0.01);
// widened.width() !== spread.width()
```

## Архитектурные решения

### Почему bid ≤ ask?

1. **Рыночная семантика**: bid — это цена покупки, ask — цена продажи
2. **Нет crossing**: если bid > ask, ордера исполнятся немедленно
3. **Валидность**: спред существует только когда есть gap между ценами

### Почему операции tighten/widen/shift?

1. **Market-making**: основные операции для управления котировками
2. **Inventory management**: корректировка спреда на основе позиции
3. **Risk management**: динамическое управление шириной спреда

### Почему immutability?

1. **Предсказуемость**: операции не изменяют существующий объект
2. **Thread-safety**: можно безопасно передавать между потоками
3. **Functional style**: композиция операций через цепочки

### Почему Price objects вместо numbers?

1. **Type-safety**: невозможно перепутать bid и ask
2. **Валидация**: цены уже провалидированы в диапазоне [0.0001, 0.9999]
3. **Operations**: можно использовать методы Price для сравнения

## TypeScript Types

```typescript
import { Result } from '@polymarket/result';
import { InvalidSpreadError } from '@polymarket/errors';

interface SpreadOperations {
  // Метрики
  width(): number;
  widthPercentage(): number;
  midpoint(): Price;
  isZeroWidth(): boolean;
  isWide(threshold?: number): boolean;

  // Операции
  tighten(amount: number): Result<Spread, InvalidSpreadError>;
  widen(amount: number): Result<Spread, InvalidSpreadError>;
  shift(amount: number): Result<Spread, InvalidSpreadError>;

  // Проверки
  contains(price: Price): boolean;
  equals(other: Spread): boolean;

  // Утилиты
  toString(): string;
  toObject(): {
    bid: number;
    ask: number;
    width: number;
    midpoint: number;
  };
}
```

## Связь с другими Value Objects

- **Price**: Spread состоит из двух Price (bid и ask)
- **Quote**: Quote содержит Price/Spread плюс Quantity (bidSize/askSize)
- **Money**: Spread × Quantity = Potential Profit (в денежном выражении)

## См. также

- [Price](./price.md) - цены на рынках предсказаний
- [Quote](./quote.md) - котировки с количествами
- [Quantity](./quantity.md) - количество акций
- [Result<T, E>](../../foundation/result/README.md) - обработка ошибок
