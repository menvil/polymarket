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

**SpreadService** — это единственный публичный API для работы со спредами. Большинство методов:

- ✅ Возвращают `Result<T, InvalidSpreadError>` (где T может быть Spread, Price, Decimal или Ratio)
- ✅ Никогда не бросают исключений (Never Throw Contract)
- ✅ Перехватывают ошибки из Core и Rules слоёв
- ✅ Предоставляют rich error context

**Исключение:** `SpreadService.zero(price)` возвращает `Spread` напрямую (не `Result`), т.к. инвариант `bid === ask` выполнен автоматически и ошибка невозможна.

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
  console.log(result1.value.mid().toNumber());  // 0.50
}
```

**Ошибки:**

- Ошибки валидации Price (из PriceService) — невалидные значения bid или ask
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
  console.log(spread.mid().toNumber());  // 0.50
}
```

**Примечание:** Этот метод не возвращает Result, т.к. принимает валидный Price и инвариант bid ≤ ask автоматически выполнен.

---

### `fromMidAndWidthRatio(mid, widthRatio)`

Создаёт спред от midpoint и относительной ширины.

```typescript
fromMidAndWidthRatio(
  mid: Price | Decimal | number | string,
  widthRatio: Ratio | Decimal | number | string
): Result<Spread, InvalidSpreadError>
```

**Параметры:**

- `mid: Price | Decimal | number | string` — midpoint цена
- `widthRatio: Ratio | Decimal | number | string` — относительная ширина (должна быть ≥ 0)

**Возвращает:**

- `Ok(Spread)` — если оба значения валидны и результат в пределах [MIN_PRICE, MAX_PRICE]
- `Err(InvalidSpreadError)` — при любых ошибках

**Алгоритм:**

1. Parse mid to Price
2. Parse widthRatio to Ratio
3. Validate widthRatio ≥ 0
4. `widthAbs = mid * widthRatio`
5. `half = widthAbs / 2`
6. `bid = mid - half`
7. `ask = mid + half`
8. Create spread через `create(bid, ask)`

**Пример:**

```typescript
// Из объектов Price и Ratio
import { PriceService, SpreadService } from '@polymarket/value-objects';
import { Ratio } from '@polymarket/value-objects/ratio';

const mid = PriceService.create(0.50).value;
const widthRatio = Ratio.of(new Decimal(0.08)); // 8% ширина

const result = SpreadService.fromMidAndWidthRatio(mid, widthRatio);

if (result.ok) {
  const spread = result.value;
  console.log(spread.bid().toNumber());      // 0.48 (0.50 - 0.02)
  console.log(spread.ask().toNumber());      // 0.52 (0.50 + 0.02)
  console.log(spread.width().toNumber());    // 0.04 (0.50 * 0.08)
  console.log(spread.mid().toNumber()); // 0.50
}

// Из чисел
const result2 = SpreadService.fromMidAndWidthRatio(0.50, 0.08);

// Из строк
const result3 = SpreadService.fromMidAndWidthRatio('0.50', '0.08');

// Из Decimal
import Decimal from 'decimal.js';
const result4 = SpreadService.fromMidAndWidthRatio(
  new Decimal(0.50),
  new Decimal(0.08)
);
```

**Use case: Market Making**

```typescript
// Создать симметричный спред вокруг справедливой цены
const fairPrice = 0.50;
const desiredSpreadPercent = 0.04; // 4% spread относительно mid

const spreadResult = SpreadService.fromMidAndWidthRatio(
  fairPrice,
  desiredSpreadPercent
);

if (spreadResult.ok) {
  // Спред: 0.49-0.51 (ширина 4% от 0.50)
  console.log(`Quote: ${spreadResult.value.bid().toNumber()}-${spreadResult.value.ask().toNumber()}`);
}
```

**Валидация:**

- widthRatio должен быть ≥ 0 (отрицательная ширина запрещена)
- Результирующие bid/ask должны быть в пределах [0.0001, 0.9999]

**Ошибки:**

- `SpreadErrorReason.INVALID_FORMAT` — невалидный mid
- `SpreadErrorReason.INVALID_RATIO` — невалидный widthRatio (NaN, Infinity)
- `SpreadErrorReason.NEGATIVE_RATIO_NOT_ALLOWED` — widthRatio < 0
- `SpreadErrorReason.RATIO_OUT_OF_BOUNDS` — результат выходит за пределы Price

---

### `fromMidAndWidth(mid, width)`

Создаёт спред из midpoint и абсолютной ширины.

```typescript
fromMidAndWidth(
  mid: Decimal | number | string,
  width: Decimal | number | string
): Result<Spread, InvalidSpreadError>
```

**Параметры:**

- `mid: Decimal | number | string` — midpoint (середина между bid и ask)
- `width: Decimal | number | string` — абсолютная ширина спреда (≥ 0)

**Возвращает:**

- `Ok(Spread)` — если оба значения валидны и результат в пределах [MIN_PRICE, MAX_PRICE]
- `Err(InvalidSpreadError)` — при любых ошибках

**Алгоритм:**

1. Parse mid to Decimal
2. Parse width to Decimal
3. Validate width ≥ 0
4. `halfWidth = width / 2`
5. `bid = mid - halfWidth`
6. `ask = mid + halfWidth`
7. Create spread через `create(bid, ask)`

**Пример:**

```typescript
const result = SpreadService.fromMidAndWidth(0.50, 0.04);
if (result.ok) {
  const spread = result.value;
  console.log(spread.bid().toNumber());   // 0.48
  console.log(spread.ask().toNumber());   // 0.52
  console.log(spread.width().toNumber()); // 0.04
  console.log(spread.mid().toNumber());   // 0.50
}

// Из строк
const result2 = SpreadService.fromMidAndWidth('0.50', '0.04');

// Из Decimal
import Decimal from 'decimal.js';
const result3 = SpreadService.fromMidAndWidth(
  new Decimal(0.50),
  new Decimal(0.04)
);
```

**Ошибки:**

- `SpreadErrorReason.INVALID_FORMAT` — невалидный mid или width (NaN, Infinity)
- `SpreadErrorReason.INVALID_WIDTH` — width < 0
- `SpreadErrorReason.BID_GREATER_THAN_ASK` — результирующий bid > ask (не должно возникать при width ≥ 0)
- Ошибки валидации Price, если bid или ask выходят за пределы [0.0001, 0.9999]

---

### `fromMidAndWidthPercentage(mid, widthPercentage, options?)`

Создаёт спред из midpoint и ширины в процентах от mid.

```typescript
fromMidAndWidthPercentage(
  mid: Decimal | number | string,
  widthPercentage: Decimal | number | string,
  options?: { ensureLteOne?: boolean }
): Result<Spread, InvalidSpreadError>
```

**Параметры:**

- `mid: Decimal | number | string` — midpoint (середина между bid и ask)
- `widthPercentage: Decimal | number | string` — ширина в процентах от mid (например, 8 = 8%)
- `options.ensureLteOne` — если true, ширина не может превышать 100% (ratio ≤ 1)

**Возвращает:**

- `Ok(Spread)` — если оба значения валидны и результат в пределах [MIN_PRICE, MAX_PRICE]
- `Err(InvalidSpreadError)` — при любых ошибках

**Алгоритм:**

1. Parse mid to Decimal
2. Parse widthPercentage as Ratio (через RatioService.fromPercent)
3. `width = mid × (widthPercentage / 100)`
4. Delegate to `fromMidAndWidth(mid, width)`

**Пример:**

```typescript
// 8% от 0.50 = ширина 0.04
const result = SpreadService.fromMidAndWidthPercentage(0.50, 8);
if (result.ok) {
  const spread = result.value;
  console.log(spread.bid().toNumber());   // 0.48
  console.log(spread.ask().toNumber());   // 0.52
  console.log(spread.width().toNumber()); // 0.04
}

// С ограничением: ширина не более 100%
const result2 = SpreadService.fromMidAndWidthPercentage(0.50, 150, { ensureLteOne: true });
// isErr(result2) === true (widthPercentage > 100%)
```

**Ошибки:**

- `SpreadErrorReason.INVALID_FORMAT` — невалидный mid (NaN, Infinity)
- Ошибки RatioService — невалидный widthPercentage
- Ошибки валидации Price, если bid или ask выходят за пределы [0.0001, 0.9999]

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
    console.log(tighter.mid().toNumber());  // 0.50 (сохранён!)
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
    console.log(wider.mid().toNumber());  // 0.50 (сохранён!)
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

## Ratio Operations (Относительные операции)

### `getSpreadWidth(spread)`

Возвращает ширину spread как Decimal.

```typescript
getSpreadWidth(spread: Spread): Result<Decimal, InvalidSpreadError>
```

**Параметры:**

- `spread: Spread` — спред для анализа

**Возвращает:**

- `Ok(Decimal)` — ширина spread (ask - bid)
- Всегда успешно для валидного spread

**Пример:**

```typescript
const spread = SpreadService.fromValues(0.48, 0.52).value;
const widthResult = SpreadService.getSpreadWidth(spread);

if (widthResult.ok) {
  console.log(widthResult.value.toString());  // "0.04"
}
```

---

### `getSpreadRatio(spread)`

Вычисляет относительный spread (width / midpoint).

```typescript
getSpreadRatio(spread: Spread): Result<Ratio, InvalidSpreadError>
```

**Параметры:**

- `spread: Spread` — спред для анализа

**Возвращает:**

- `Ok(Ratio)` — относительный spread как Ratio
- `Err(InvalidSpreadError)` — если midpoint = 0

**Пример:**

```typescript
const spread = SpreadService.fromValues(0.48, 0.52).value;
const ratioResult = SpreadService.getSpreadRatio(spread);

if (ratioResult.ok) {
  const ratio = ratioResult.value;
  console.log(ratio.toDecimal().toString());  // "0.08" (8%)
  console.log(ratio.toDecimal().times(100).toNumber());  // 8
}
```

**Ошибки:**

- `SpreadErrorReason.MID_UNAVAILABLE` — если midpoint = 0

---

### `shiftByRatio(spread, shiftRatio)`

Сдвигает spread на процент от midpoint.

```typescript
shiftByRatio(
  spread: Spread,
  shiftRatio: Ratio
): Result<Spread, InvalidSpreadError>
```

**Логика:**

- `shiftAbs = midpoint * shiftRatio`
- Новый bid = текущий bid + shiftAbs
- Новый ask = текущий ask + shiftAbs

**Параметры:**

- `spread: Spread` — исходный спред
- `shiftRatio: Ratio` — доля для сдвига (может быть отрицательной)

**Возвращает:**

- `Ok(Spread)` — новый сдвинутый спред
- `Err(InvalidSpreadError)` — если результат выходит за пределы

**Пример:**

```typescript
import { Ratio } from '@polymarket/value-objects';

const spread = SpreadService.fromValues(0.48, 0.52).value;
// midpoint = 0.50

// Сдвиг вверх на 10% от mid
const shiftRatio = Ratio.of(new Decimal(0.10));
const result = SpreadService.shiftByRatio(spread, shiftRatio);

if (result.ok) {
  console.log(result.value.bid().toNumber());  // 0.53 (0.48 + 0.05)
  console.log(result.value.ask().toNumber());  // 0.57 (0.52 + 0.05)
  console.log(result.value.width().toNumber());  // 0.04 (сохранена!)
}
```

**Ошибки:**

- `SpreadErrorReason.MID_UNAVAILABLE` — если не удаётся вычислить midpoint
- `SpreadErrorReason.RATIO_OUT_OF_BOUNDS` — если результат выходит за пределы Price

---

### `widenByRatio(spread, deltaWidthRatio)`

Расширяет spread на процент от midpoint.

```typescript
widenByRatio(
  spread: Spread,
  deltaWidthRatio: Ratio
): Result<Spread, InvalidSpreadError>
```

**Логика:**

- `deltaWidthAbs = midpoint * deltaWidthRatio`
- `amountAbs = deltaWidthAbs / 2`
- Новый bid = текущий bid - amountAbs
- Новый ask = текущий ask + amountAbs

**Параметры:**

- `spread: Spread` — исходный спред
- `deltaWidthRatio: Ratio` — доля для расширения (должна быть ≥ 0)

**Возвращает:**

- `Ok(Spread)` — новый расширенный спред
- `Err(InvalidSpreadError)` — если ratio невалиден или результат выходит за пределы

**Пример:**

```typescript
const spread = SpreadService.fromValues(0.48, 0.52).value;
// midpoint = 0.50, width = 0.04

// Расширение на 10% от mid
const deltaRatio = Ratio.of(new Decimal(0.10));
const result = SpreadService.widenByRatio(spread, deltaRatio);

if (result.ok) {
  console.log(result.value.bid().toNumber());  // 0.455 (0.48 - 0.025)
  console.log(result.value.ask().toNumber());  // 0.545 (0.52 + 0.025)
  console.log(result.value.width().toNumber());  // 0.09 (0.04 + 0.05)
  console.log(result.value.mid().toNumber());  // 0.50 (сохранен!)
}
```

**Ошибки:**

- `SpreadErrorReason.NEGATIVE_RATIO_NOT_ALLOWED` — если deltaWidthRatio < 0
- `SpreadErrorReason.RATIO_OUT_OF_BOUNDS` — если результат выходит за пределы Price

---

### `tightenByRatio(spread, deltaWidthRatio)`

Сужает spread на процент от midpoint.

```typescript
tightenByRatio(
  spread: Spread,
  deltaWidthRatio: Ratio
): Result<Spread, InvalidSpreadError>
```

**Логика:**

- `deltaWidthAbs = midpoint * deltaWidthRatio`
- `amountAbs = deltaWidthAbs / 2` (делится на 2, так как `tighten` применяет amount к каждой стороне)
- Делегирует в `tighten(spread, amountAbs)`

**Параметры:**

- `spread: Spread` — исходный спред
- `deltaWidthRatio: Ratio` — доля для сужения (должна быть ≥ 0)

**Возвращает:**

- `Ok(Spread)` — новый суженный спред
- `Err(InvalidSpreadError)` — если ratio невалиден

**Пример:**

```typescript
const spread = SpreadService.fromValues(0.48, 0.52).value;
// midpoint = 0.50, width = 0.04

// Сужение на 4% от mid
const deltaRatio = Ratio.of(new Decimal(0.04));
const result = SpreadService.tightenByRatio(spread, deltaRatio);

if (result.ok) {
  console.log(result.value.bid().toNumber());  // 0.49 (0.48 + 0.01)
  console.log(result.value.ask().toNumber());  // 0.51 (0.52 - 0.01)
  console.log(result.value.width().toNumber());  // 0.02 (0.04 - 0.02)
  console.log(result.value.mid().toNumber());  // 0.50 (сохранен!)
}
```

**Ограничения:**

- Автоматически ограничивается до zero-width spread если deltaWidthAbs ≥ width (так как amountAbs = deltaWidthAbs / 2, а tighten обрезает при amountAbs ≥ halfWidth = width / 2)

**Ошибки:**

- `SpreadErrorReason.NEGATIVE_RATIO_NOT_ALLOWED` — если deltaWidthRatio < 0

---

### `skewByRatio(spread, bidRatio, askRatio)`

Наклоняет spread применяя разные проценты к bid и ask.

```typescript
skewByRatio(
  spread: Spread,
  bidRatio: Ratio,
  askRatio: Ratio
): Result<Spread, InvalidSpreadError>
```

**Логика:**

- `bidAdjAbs = midpoint * bidRatio`
- `askAdjAbs = midpoint * askRatio`
- Делегирует в `adjustBidAsk(spread, bidAdjAbs, askAdjAbs)`

**Параметры:**

- `spread: Spread` — исходный спред
- `bidRatio: Ratio` — доля для bid (может быть отрицательной)
- `askRatio: Ratio` — доля для ask (может быть отрицательной)

**Возвращает:**

- `Ok(Spread)` — новый наклоненный спред
- `Err(InvalidSpreadError)` — если результат невалиден или выходит за пределы

**Пример:**

```typescript
const spread = SpreadService.fromValues(0.48, 0.52).value;
// midpoint = 0.50

// Поднять bid на 4%, опустить ask на 2%
const bidRatio = Ratio.of(new Decimal(0.04));  // +4%
const askRatio = Ratio.of(new Decimal(-0.02)); // -2%

const result = SpreadService.skewByRatio(spread, bidRatio, askRatio);

if (result.ok) {
  console.log(result.value.bid().toNumber());  // 0.50 (0.48 + 0.02)
  console.log(result.value.ask().toNumber());  // 0.51 (0.52 - 0.01)
  console.log(result.value.width().toNumber());  // 0.01 (сузился)
  console.log(result.value.mid().toNumber());  // 0.505 (сдвинулся!)
}
```

**Use case:** Inventory adjustment — при excess long позиции поднимаем bid, опускаем ask для стимулирования продажи.

**Ошибки:**

- `SpreadErrorReason.BID_GREATER_THAN_ASK` — если новый bid > новый ask
- `SpreadErrorReason.RATIO_OUT_OF_BOUNDS` — если результат выходит за пределы Price

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
import { PriceService, SpreadService, SpreadFormatter } from '@polymarket/value-objects';

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
import { SpreadService, Spread, InvalidSpreadError } from '@polymarket/value-objects';
import type { Result } from '@polymarket/result';

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
  const volatilityAmount = widenedResult.value.width().times(volatilityFactor).toNumber();
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

// Используйте строгие сравнения через equals()
const spread1 = SpreadService.fromValues(0.48, 0.52).value;
const spread2 = SpreadService.fromValues(0.48, 0.52).value;
if (spread1.equals(spread2)) {
  // Точное совпадение
}

// В тестах используйте toBe(), не toBeCloseTo()
expect(spread.width().toNumber()).toBe(0.04);  // ✅ Строго
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

// ❌ Не используйте приближенные сравнения
expect(spread.width().toNumber()).toBeCloseTo(0.04, 10);  // НЕТ!
// Используйте строгие:
expect(spread.width().toNumber()).toBe(0.04);  // ДА!
```

---

## Дальнейшее чтение

- [Примеры использования](./examples.md) — реальные сценарии
- [Core Layer](./core.md) — детали Spread класса
- [Адаптеры](./adapters.md) — сериализация и форматирование
- [Архитектура](./architecture.md) — общий обзор архитектуры
