# SpreadService (Facade API)

> Полное описание публичного API для работы со спредами

## Содержание

1. [Обзор](#обзор)
2. [Фабричные методы](#фабричные-методы)
3. [Операции со спредами](#операции-со-спредами)
4. [Обработка ошибок](#обработка-ошибок)
5. [Контракты](#контракты)

---

## Обзор

**SpreadService** — это единственный публичный API для работы со спредами. Все методы:

- ✅ Возвращают `Result<Spread, InvalidSpreadError>`
- ✅ Никогда не бросают исключений (Never Throw Contract)
- ✅ Перехватывают ошибки из Core и Rules слоёв
- ✅ Предоставляют rich error context

### Импорт

```typescript
import { SpreadService } from '@polymarket/value-objects';
// или
import { SpreadService } from '@polymarket/value-objects/spread';
```

---

## Фабричные методы

### `create(bid, ask)`

Создаёт спред из Price объектов.

```typescript
create(bid: Price, ask: Price): Result<Spread, InvalidSpreadError>
```

**Параметры:**

- `bid: Price` — цена покупки
- `ask: Price` — цена продажи

**Возвращает:**

- `Ok(Spread)` — если bid ≤ ask
- `Err(InvalidSpreadError)` — если bid > ask

**Пример:**

```typescript
import { PriceService, SpreadService } from '@polymarket/value-objects';

const bidResult = PriceService.create(0.48);
const askResult = PriceService.create(0.52);

if (bidResult.ok && askResult.ok) {
  const spreadResult = SpreadService.create(bidResult.value, askResult.value);
  
  if (spreadResult.ok) {
    const spread = spreadResult.value;
    console.log(spread.width().toNumber());  // 0.04
  }
}
```

**Ошибки:**

- `SpreadErrorReason.BID_GREATER_THAN_ASK` — если bid > ask

---

### `fromValues(bid, ask)`

Создаёт спред из чисел, строк или Decimal.

```typescript
fromValues(
  bid: number | string | Decimal,
  ask: number | string | Decimal
): Result<Spread, InvalidSpreadError>
```

**Параметры:**

- `bid: number | string | Decimal` — значение bid цены
- `ask: number | string | Decimal` — значение ask цены

**Возвращает:**

- `Ok(Spread)` — если оба значения валидны и bid ≤ ask
- `Err(InvalidSpreadError)` — при любых ошибках

**Пример:**

```typescript
// Из чисел
const result1 = SpreadService.fromValues(0.48, 0.52);

// Из строк
const result2 = SpreadService.fromValues('0.48', '0.52');

// Из Decimal
import Decimal from 'decimal.js';
const result3 = SpreadService.fromValues(
  new Decimal(0.48),
  new Decimal(0.52)
);

if (result1.ok) {
  console.log(result1.value.midpoint().toNumber());  // 0.50
}
```

**Ошибки:**

- `SpreadErrorReason.INVALID_BID` — невалидное значение bid
- `SpreadErrorReason.INVALID_ASK` — невалидное значение ask
- `SpreadErrorReason.BID_GREATER_THAN_ASK` — bid > ask

---

### `zero(price)`

Создаёт спред нулевой ширины (bid === ask).

```typescript
zero(price: Price): Spread
```

**Параметры:**

- `price: Price` — цена для bid и ask

**Возвращает:**

- `Spread` — с bid === ask (не Result, т.к. не может провалиться)

**Пример:**

```typescript
import { PriceService, SpreadService } from '@polymarket/value-objects';

const priceResult = PriceService.create(0.50);
if (priceResult.ok) {
  const spread = SpreadService.zero(priceResult.value);
  
  console.log(spread.isZeroWidth());  // true
  console.log(spread.width().toNumber());  // 0
  console.log(spread.midpoint().toNumber());  // 0.50
}
```

**Примечание:** Этот метод не возвращает Result, т.к. принимает валидный Price и инвариант bid ≤ ask автоматически выполнен.

---

## Операции со спредами

### `tighten(spread, amount)`

Сужает спред на заданную величину (симметрично относительно midpoint).

```typescript
tighten(
  spread: Spread,
  amount: number | Decimal
): Result<Spread, InvalidSpreadError>
```

**Логика:**

- Новый bid = текущий bid + amount
- Новый ask = текущий ask - amount
- Midpoint остаётся неизменным

**Параметры:**

- `spread: Spread` — исходный спред
- `amount: number | Decimal` — величина сужения (≥ 0)

**Возвращает:**

- `Ok(Spread)` — новый суженный спред
- `Err(InvalidSpreadError)` — если amount невалиден или результат выходит за пределы

**Пример:**

```typescript
const spreadResult = SpreadService.fromValues(0.48, 0.52);
if (spreadResult.ok) {
  const spread = spreadResult.value;
  
  // Сужение на 0.01
  const tighterResult = SpreadService.tighten(spread, 0.01);
  
  if (tighterResult.ok) {
    const tighter = tighterResult.value;
    console.log(tighter.bid().toNumber());  // 0.49
    console.log(tighter.ask().toNumber());  // 0.51
    console.log(tighter.width().toNumber());  // 0.02
    console.log(tighter.midpoint().toNumber());  // 0.50 (сохранён!)
  }
}
```

**Ограничения:**

- Если `amount > width / 2`, сужение ограничивается `width / 2` (результат — zero-width spread)
- amount должен быть ≥ 0 и конечным

**Ошибки:**

- `SpreadErrorReason.INVALID_AMOUNT` — amount < 0, Infinity, NaN
- `SpreadErrorReason.OPERATION_OUT_OF_BOUNDS` — результат выходит за пределы Price

---

### `widen(spread, amount)`

Расширяет спред на заданную величину (симметрично относительно midpoint).

```typescript
widen(
  spread: Spread,
  amount: number | Decimal
): Result<Spread, InvalidSpreadError>
```

**Логика:**

- Новый bid = текущий bid - amount
- Новый ask = текущий ask + amount
- Midpoint остаётся неизменным

**Параметры:**

- `spread: Spread` — исходный спред
- `amount: number | Decimal` — величина расширения (≥ 0)

**Возвращает:**

- `Ok(Spread)` — новый расширенный спред
- `Err(InvalidSpreadError)` — если amount невалиден или результат выходит за пределы

**Пример:**

```typescript
const spreadResult = SpreadService.fromValues(0.48, 0.52);
if (spreadResult.ok) {
  const spread = spreadResult.value;
  
  // Расширение на 0.02
  const widerResult = SpreadService.widen(spread, 0.02);
  
  if (widerResult.ok) {
    const wider = widerResult.value;
    console.log(wider.bid().toNumber());  // 0.46
    console.log(wider.ask().toNumber());  // 0.54
    console.log(wider.width().toNumber());  // 0.08
    console.log(wider.midpoint().toNumber());  // 0.50 (сохранён!)
  }
}
```

**Ограничения:**

- Новые bid/ask должны оставаться в пределах [0.0001, 0.9999]
- amount должен быть ≥ 0 и конечным

**Ошибки:**

- `SpreadErrorReason.INVALID_AMOUNT` — amount < 0, Infinity, NaN
- `SpreadErrorReason.OPERATION_OUT_OF_BOUNDS` — новый bid < MIN_PRICE или ask > MAX_PRICE

---

### `shift(spread, amount)`

Сдвигает весь спред на заданную величину (вверх или вниз).

```typescript
shift(
  spread: Spread,
  amount: number | Decimal
): Result<Spread, InvalidSpreadError>
```

**Логика:**

- Новый bid = текущий bid + amount
- Новый ask = текущий ask + amount
- Width остаётся неизменной

**Параметры:**

- `spread: Spread` — исходный спред
- `amount: number | Decimal` — величина сдвига (может быть отрицательной)

**Возвращает:**

- `Ok(Spread)` — новый сдвинутый спред
- `Err(InvalidSpreadError)` — если amount невалиден или результат выходит за пределы

**Пример:**

```typescript
const spreadResult = SpreadService.fromValues(0.48, 0.52);
if (spreadResult.ok) {
  const spread = spreadResult.value;
  
  // Сдвиг вверх на 0.10
  const shiftedUpResult = SpreadService.shift(spread, 0.10);
  if (shiftedUpResult.ok) {
    const shifted = shiftedUpResult.value;
    console.log(shifted.bid().toNumber());  // 0.58
    console.log(shifted.ask().toNumber());  // 0.62
    console.log(shifted.width().toNumber());  // 0.04 (сохранена!)
  }
  
  // Сдвиг вниз на 0.05
  const shiftedDownResult = SpreadService.shift(spread, -0.05);
  if (shiftedDownResult.ok) {
    const shifted = shiftedDownResult.value;
    console.log(shifted.bid().toNumber());  // 0.43
    console.log(shifted.ask().toNumber());  // 0.47
    console.log(shifted.width().toNumber());  // 0.04 (сохранена!)
  }
}
```

**Ограничения:**

- Новые bid/ask должны оставаться в пределах [0.0001, 0.9999]
- amount должен быть конечным

**Ошибки:**

- `SpreadErrorReason.INVALID_AMOUNT` — amount === Infinity, NaN
- `SpreadErrorReason.OPERATION_OUT_OF_BOUNDS` — новый bid < MIN_PRICE или ask > MAX_PRICE

---

## Обработка ошибок

### Error Context

Все ошибки содержат rich context:

```typescript
type InvalidSpreadErrorContext = {
  op?: string;           // Название операции ('create', 'tighten', etc.)
  bid?: string;          // Значение bid
  ask?: string;          // Значение ask
  spread?: string;       // Строковое представление спреда
  amount?: string;       // Значение amount для операций
  reason?: SpreadErrorReason;  // Типизированная причина ошибки
  cause?: unknown;       // Исходная ошибка (если есть)
  raw?: Record<string, unknown>;  // Сырые входные данные
};
```

### Примеры обработки

**Обработка ошибки bid > ask:**

```typescript
const result = SpreadService.fromValues(0.60, 0.50);

if (!result.ok) {
  const ctx = result.error.context;
  
  if (ctx?.reason === SpreadErrorReason.BID_GREATER_THAN_ASK) {
    console.error(`Bid ${ctx.bid} не может быть больше ask ${ctx.ask}`);
  }
}
```

**Обработка ошибки операции:**

```typescript
const spreadResult = SpreadService.fromValues(0.48, 0.52);
if (spreadResult.ok) {
  const result = SpreadService.widen(spreadResult.value, 0.50);
  
  if (!result.ok) {
    const ctx = result.error.context;
    
    if (ctx?.reason === SpreadErrorReason.OPERATION_OUT_OF_BOUNDS) {
      console.error(
        `Операция ${ctx.op} с amount ${ctx.amount} выводит спред за допустимые пределы`
      );
    }
  }
}
```

**Обработка невалидного amount:**

```typescript
const spreadResult = SpreadService.fromValues(0.48, 0.52);
if (spreadResult.ok) {
  const result = SpreadService.tighten(spreadResult.value, -0.01);
  
  if (!result.ok) {
    const ctx = result.error.context;
    
    if (ctx?.reason === SpreadErrorReason.INVALID_AMOUNT) {
      console.error(`Невалидное значение amount: ${ctx.amount}`);
      // "amount must be non-negative"
    }
  }
}
```

---

## Контракты

### Never Throw Contract

**Гарантия:** Все публичные методы SpreadService **никогда** не бросают исключений.

```typescript
// ✅ Всегда возвращает Result
const result = SpreadService.fromValues(anyValue, anyValue);
if (result.ok) {
  // работа со spread
} else {
  // обработка ошибки
}

// ❌ НЕТ try-catch для SpreadService
try {
  SpreadService.fromValues(...);  // не нужно
} catch (e) {
  // никогда не выполнится
}
```

**Исключение:** Только `zero(price)` не возвращает Result, т.к. не может провалиться.

### Иммутабельность

**Гарантия:** Все операции создают новые экземпляры Spread.

```typescript
const spread1 = SpreadService.fromValues(0.48, 0.52).value;
const spread2Result = SpreadService.tighten(spread1, 0.01);

if (spread2Result.ok) {
  const spread2 = spread2Result.value;
  
  // spread1 остался неизменным
  console.log(spread1.width().toNumber());  // 0.04
  
  // spread2 — новый объект
  console.log(spread2.width().toNumber());  // 0.02
  
  console.log(spread1 === spread2);  // false
}
```

### Type Safety

**Гарантия:** TypeScript не позволит забыть проверить Result.

```typescript
const result = SpreadService.fromValues(0.48, 0.52);

// ❌ TypeScript ошибка
const spread = result.value;  // Property 'value' does not exist on type 'Result'

// ✅ Правильно
if (result.ok) {
  const spread = result.value;  // TypeScript знает, что это Spread
} else {
  const error = result.error;   // TypeScript знает, что это InvalidSpreadError
}
```

---

## Интеграция с другими сервисами

### Использование с PriceService

```typescript
import { PriceService, SpreadService } from '@polymarket/value-objects';

// Создание цен с округлением к market tick
const bidResult = PriceService.create(0.4823);
const askResult = PriceService.create(0.5177);

if (bidResult.ok && askResult.ok) {
  // Округление к тику 0.01
  const roundedBidResult = PriceService.roundToMarketTick(bidResult.value, 0.01);
  const roundedAskResult = PriceService.roundToMarketTick(askResult.value, 0.01);
  
  if (roundedBidResult.ok && roundedAskResult.ok) {
    // Создание спреда из округлённых цен
    const spreadResult = SpreadService.create(
      roundedBidResult.value,
      roundedAskResult.value
    );
    
    if (spreadResult.ok) {
      console.log(SpreadFormatter.format(spreadResult.value));
      // "0.4800-0.5200 (0.0400)"
    }
  }
}
```

### Цепочка операций

```typescript
import { SpreadService } from '@polymarket/value-objects';

function adjustSpreadForVolatility(
  initialBid: number,
  initialAsk: number,
  volatilityFactor: number
): Result<Spread, InvalidSpreadError> {
  // 1. Создать начальный спред
  const spreadResult = SpreadService.fromValues(initialBid, initialAsk);
  if (!spreadResult.ok) return spreadResult;
  
  // 2. Расширить на базовую величину
  const widenedResult = SpreadService.widen(spreadResult.value, 0.02);
  if (!widenedResult.ok) return widenedResult;
  
  // 3. Дополнительно расширить пропорционально волатильности
  const volatilityAmount = widenedResult.value.width().mul(volatilityFactor).toNumber();
  return SpreadService.widen(widenedResult.value, volatilityAmount);
}

const result = adjustSpreadForVolatility(0.48, 0.52, 0.5);
if (result.ok) {
  console.log(result.value.width().toNumber());
}
```

---

## Best Practices

### ✅ DO

```typescript
// Всегда проверяйте Result
const result = SpreadService.fromValues(bid, ask);
if (result.ok) {
  useSpread(result.value);
} else {
  handleError(result.error);
}

// Используйте fromValues для простоты
const spread = SpreadService.fromValues(0.48, 0.52);

// Обрабатывайте специфичные ошибки через reason
if (!result.ok && result.error.context?.reason === SpreadErrorReason.BID_GREATER_THAN_ASK) {
  // специфичная обработка
}
```

### ❌ DON'T

```typescript
// ❌ Не игнорируйте ошибки
const spread = SpreadService.fromValues(bid, ask).value;  // может быть undefined!

// ❌ Не используйте try-catch
try {
  const spread = SpreadService.fromValues(bid, ask);
} catch (e) {
  // никогда не выполнится
}

// ❌ Не мутируйте Spread (нельзя, но не пытайтесь обойти через any)
const spread: any = SpreadService.fromValues(0.48, 0.52).value;
spread._bid = newBid;  // ОЧЕНЬ ПЛОХО
```

---

## Дальнейшее чтение

- [Примеры использования](./examples.md) — реальные сценарии
- [Core Layer](./core.md) — детали Spread класса
- [Адаптеры](./adapters.md) — сериализация и форматирование
- [Архитектура](./architecture.md) — общий обзор архитектуры
