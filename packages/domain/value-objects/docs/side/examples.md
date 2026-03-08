# Примеры использования Side

## Order Matching — совместимость сторон

```typescript
import { SideService, SideFormatter } from '@polymarket/value-objects';
import type { Side } from '@polymarket/value-objects';

interface Order {
  id: string;
  side: Side;
  price: number;
  size: number;
}

// Проверка совместимости двух ордеров перед исполнением
function tryMatch(maker: Order, taker: Order): boolean {
  // Match возможен только при противоположных сторонах
  if (!SideService.canMatch(maker.side, taker.side)) {
    console.info(
      `No match: ${SideFormatter.toLogString(maker.side)} cannot match ${SideFormatter.toLogString(taker.side)}`
    );
    return false;
  }

  console.info(
    `Match found: ${SideFormatter.toLogString(maker.side)} ↔ ${SideFormatter.toLogString(taker.side)}`
    // → "Match found: 🟢 BUY ↔ 🔴 SELL"
  );
  return true;
}

const buyOrder: Order  = { id: '1', side: 'BUY',  price: 0.65, size: 100 };
const sellOrder: Order = { id: '2', side: 'SELL', price: 0.65, size: 100 };
const buyOrder2: Order = { id: '3', side: 'BUY',  price: 0.65, size: 50  };

tryMatch(buyOrder, sellOrder);  // true — BUY ↔ SELL
tryMatch(buyOrder, buyOrder2);  // false — BUY ↔ BUY (нет match)

// Получение противоположной стороны для хеджирования
const hedgeSide = SideService.opposite(buyOrder.side); // 'SELL'
console.log(`Hedge side: ${SideFormatter.toDisplay(hedgeSide)}`); // "Hedge side: Sell"
```

---

## Парсинг из API / БД (unknown input)

```typescript
import { SideService, SideSerializer } from '@polymarket/value-objects';
import type { Side } from '@polymarket/value-objects';

// Типичный API-ответ
interface ApiOrderResponse {
  order_id: string;
  side: unknown;      // unknown — нет гарантий типа из внешнего источника
  price: unknown;
  size: unknown;
}

function parseOrderFromApi(raw: ApiOrderResponse): Side | null {
  const result = SideService.fromUnknown(raw.side);

  if (!result.ok) {
    console.error(`Failed to parse side from API: ${result.error.message}`);
    // → "Invalid side: must be string, got [object Null]"
    // → "Invalid side value: long. Expected BUY or SELL"
    return null;
  }

  return result.value; // 'BUY' | 'SELL'
}

// Использование
const apiResponse: ApiOrderResponse = {
  order_id: 'abc-123',
  side: 'BUY',
  price: '0.65',
  size: '100',
};

const side = parseOrderFromApi(apiResponse); // 'BUY'

// Парсинг из JSON.parse()
const rawJson = '{"side":"SELL","price":"0.65"}';
const parsed: unknown = JSON.parse(rawJson);
const obj = parsed as { side: unknown };

const sideResult = SideSerializer.fromUnknown(obj.side);
if (sideResult.ok) {
  const side: Side = sideResult.value; // 'SELL'
  console.log(`Parsed side: ${side}`);
}

// Десериализация из БД (строка известного типа)
function parseSideFromDb(dbValue: string): Side | null {
  const result = SideSerializer.fromJSON(dbValue);
  return result.ok ? result.value : null;
}
```

---

## Обработка ошибок — switch по reason

```typescript
import { SideService, SideErrorReason } from '@polymarket/value-objects';
import type { Side } from '@polymarket/value-objects';

function parseSideStrict(input: unknown): Side {
  const result = SideService.fromUnknown(input);

  if (result.ok) {
    return result.value;
  }

  const ctx = result.error.context;

  // Exhaustive switch — TypeScript предупредит о пропущенных case
  switch (ctx?.reason) {
    case SideErrorReason.INVALID_TYPE:
      // Не строка — ошибка источника данных или протокола
      throw new Error(
        `Side must be a string, received ${ctx.actualTag} (op: ${ctx.op})`
        // "Side must be a string, received [object Null] (op: fromUnknown)"
      );

    case SideErrorReason.INVALID_VALUE:
      // Строка, но не в допустимом наборе
      throw new Error(
        `Unknown side value: "${ctx.value}". Allowed: ${ctx.expectedValues?.join(', ')}`
        // "Unknown side value: "long". Allowed: BUY, SELL"
      );

    default:
      // Неожиданный reason — отладочная информация
      throw new Error(`Unexpected side error: ${result.error.message}`);
  }
}

// Практический пример: разная реакция на тип ошибки
function handleSideError(input: unknown): void {
  const result = SideService.fromUnknown(input);
  if (result.ok) return;

  if (result.error.context?.reason === SideErrorReason.INVALID_TYPE) {
    // Системная ошибка — логируем с высоким приоритетом
    logger.error('Protocol violation: side field must be string', {
      actualTag: result.error.context.actualTag,
      op: result.error.context.op,
    });
  } else {
    // Пользовательская ошибка — показываем сообщение
    showValidationError(`Неверное значение стороны: "${result.error.context?.value}"`);
  }
}
```

---

## getAllValues — UI dropdown

```typescript
import { SideService, SideFormatter } from '@polymarket/value-objects';
import type { Side } from '@polymarket/value-objects';

// Генерация опций для select/dropdown
function buildSideOptions(): Array<{ value: Side; label: string; color: string }> {
  return SideService.getAllValues().map(side => ({
    value: side,                            // 'BUY' | 'SELL'
    label: SideFormatter.toDisplay(side),   // 'Buy' | 'Sell'
    color: SideFormatter.toColor(side),     // 'green' | 'red'
  }));
}

// Результат:
// [
//   { value: 'BUY',  label: 'Buy',  color: 'green' },
//   { value: 'SELL', label: 'Sell', color: 'red'   },
// ]

// React-компонент (упрощённо)
function SideSelect({ value, onChange }: { value: Side; onChange: (s: Side) => void }) {
  const options = buildSideOptions();

  return (
    // select с options из getAllValues()
    options.map(opt => (
      // <option key={opt.value} value={opt.value} style={{ color: opt.color }}>
      //   {opt.label}
      // </option>
    ))
  );
}

// Итерация для статистики по сторонам
const sideStats: Record<Side, number> = {} as Record<Side, number>;

for (const side of SideService.getAllValues()) {
  sideStats[side] = 0; // инициализация нулями
}

// Подсчёт ордеров по сторонам
orders.forEach(order => {
  sideStats[order.side]++;
});

console.log(sideStats); // { BUY: 42, SELL: 38 }
```

---

## Грязные runtime-входы (as any) — INVALID_TYPE и INVALID_VALUE

```typescript
import { SideService, SideErrorReason } from '@polymarket/value-objects';

// Демонстрация runtime type guard в fromString
// TypeScript позволяет вызвать fromString только со string,
// но `as any` обходит compile-time проверку

// Случай 1: число через as any → INVALID_TYPE
const r1 = SideService.fromString(123 as any);
if (!r1.ok) {
  console.log(r1.error.context?.reason);    // 'INVALID_TYPE'
  console.log(r1.error.context?.type);      // 'number'
  console.log(r1.error.context?.actualTag); // '[object Number]'
  console.log(r1.error.context?.op);        // 'fromString'
}

// Случай 2: null через as any → INVALID_TYPE
const r2 = SideService.fromString(null as any);
if (!r2.ok) {
  console.log(r2.error.context?.reason);    // 'INVALID_TYPE'
  console.log(r2.error.context?.actualTag); // '[object Null]'
}

// Случай 3: объект через as any → INVALID_TYPE
const r3 = SideService.fromString({ side: 'BUY' } as any);
if (!r3.ok) {
  console.log(r3.error.context?.reason);    // 'INVALID_TYPE'
  console.log(r3.error.context?.actualTag); // '[object Object]'
}

// Случай 4: массив через as any → INVALID_TYPE
const r4 = SideService.fromString(['BUY'] as any);
if (!r4.ok) {
  console.log(r4.error.context?.reason);    // 'INVALID_TYPE'
  console.log(r4.error.context?.actualTag); // '[object Array]'
}

// Случай 5: строка, но неверная → INVALID_VALUE (не INVALID_TYPE)
const r5 = SideService.fromString('buy' as any); // as any, но всё равно строка
if (!r5.ok) {
  console.log(r5.error.context?.reason);         // 'INVALID_VALUE' (!)
  console.log(r5.error.context?.value);          // 'buy'
  console.log(r5.error.context?.expectedValues); // ['BUY', 'SELL']
}

// Консистентность: fromUnknown даёт тот же reason для тех же типов
const fromU1 = SideService.fromUnknown(123);
const fromS1 = SideService.fromString(123 as any);
console.log(fromU1.ok === false && fromS1.ok === false); // true
console.log(
  !fromU1.ok && !fromS1.ok &&
  fromU1.error.context?.reason === fromS1.error.context?.reason
); // true — оба INVALID_TYPE

// Практический сценарий: внешний SDK с нетипизированным ответом
interface UntypedSdkOrder {
  side: any; // SDK использует any
  price: any;
}

function parseSdkOrder(order: UntypedSdkOrder) {
  const sideResult = SideService.fromUnknown(order.side);

  if (!sideResult.ok) {
    const ctx = sideResult.error.context;
    // Различаем ошибки: тип vs значение
    if (ctx?.reason === SideErrorReason.INVALID_TYPE) {
      throw new TypeError(
        `SDK returned non-string side: ${ctx.actualTag}`
      );
    } else {
      throw new RangeError(
        `SDK returned unknown side: "${ctx?.value}"`
      );
    }
  }

  return sideResult.value;
}
```

---

## Форматирование для различных контекстов

```typescript
import { SideFormatter } from '@polymarket/value-objects';
import type { Side } from '@polymarket/value-objects';

const side: Side = 'BUY';

// Все форматы одного значения
console.log(SideFormatter.toDisplay(side));   // 'Buy'
console.log(SideFormatter.toUpperCase(side)); // 'BUY'
console.log(SideFormatter.toLowerCase(side)); // 'buy'
console.log(SideFormatter.toEmoji(side));     // '🟢'
console.log(SideFormatter.toColor(side));     // 'green'
console.log(SideFormatter.toHexColor(side));  // '#22c55e'
console.log(SideFormatter.toLogString(side)); // '🟢 BUY'
console.log(SideFormatter.withSize(side, 100)); // 'Buy 100'

// Форматирование в логах
function logOrderExecution(side: Side, price: number, size: number): void {
  console.log(
    `Order executed: ${SideFormatter.toLogString(side)} @ ${price} x ${size}`
  );
  // → "Order executed: 🟢 BUY @ 0.65 x 100"
  // → "Order executed: 🔴 SELL @ 0.72 x 50"
}

// CSS-in-JS стилизация
function getOrderStyle(side: Side) {
  return {
    color: SideFormatter.toHexColor(side),       // '#22c55e' или '#ef4444'
    label: SideFormatter.toDisplay(side),         // 'Buy' или 'Sell'
    icon: SideFormatter.toEmoji(side),            // '🟢' или '🔴'
  };
}

// Сериализация для API
import { SideSerializer } from '@polymarket/value-objects';

const orderPayload = {
  side: SideSerializer.toJSON(side), // 'BUY' — identity, но явно через API
  price: '0.65',
};
```
