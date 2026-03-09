# Facade Layer — SideService API

> Единая точка входа для всех операций с Side

## Обзор

`SideService` — статический класс, предоставляющий type-safe API для работы с Side через `Result<Side, InvalidSideError>`.

**Контракт "Never Throw":** методы парсинга (`fromString`, `fromUnknown`) ГАРАНТИРОВАННО возвращают `Result` и НИКОГДА не бросают исключений. Утилиты (`opposite`, `canMatch`, `equals`, `isValid`, `getAllValues`) возвращают значения напрямую и безопасны по контракту.

---

## Структура контекста ошибки

Все ошибки из `SideService` содержат контекст следующей структуры:

```typescript
import { SideErrorReason } from '@polymarket/value-objects';

interface InvalidSideErrorContext {
  // Всегда присутствует (добавляется wrapOp)
  op: string;        // 'fromString' | 'fromUnknown'
  opChain?: string[]; // цепочка вложенных операций (для трассировки)

  // При INVALID_TYPE (не строка)
  value?: unknown;   // исходное значение
  type?: string;     // typeof value: 'number' | 'boolean' | 'object' | ...
  actualTag?: string; // Object.prototype.toString: '[object Null]' | '[object Array]' | ...

  // При INVALID_VALUE (строка, но не в ALL_SIDES)
  value?: string;           // переданная строка
  expectedValues?: string[]; // [...ALL_SIDES] — допустимые значения

  // Всегда при ошибке
  reason: SideErrorReason; // INVALID_TYPE | INVALID_VALUE
}
```

**Зачем `actualTag`:** `typeof` возвращает `'object'` для `null`, массивов и объектов. `Object.prototype.toString.call(value)` даёт точный тег для диагностики.

---

## SideErrorReason

```typescript
// src/side/errors/SideErrorReason.ts
export enum SideErrorReason {
  INVALID_VALUE = 'INVALID_VALUE',
  INVALID_TYPE  = 'INVALID_TYPE',
}
```

### INVALID_VALUE

Возникает когда значение **является строкой**, но не входит в `ALL_SIDES` (`['BUY', 'SELL']`).

**Примеры:**

```typescript
SideService.fromString('buy');     // lowercase — INVALID_VALUE
SideService.fromString('Sell');    // title case — INVALID_VALUE
SideService.fromString('INVALID'); // отсутствует в ALL_SIDES — INVALID_VALUE
SideService.fromString('');        // пустая строка — INVALID_VALUE
SideService.fromString('BUY ');    // пробел в конце — INVALID_VALUE
```

**Контекст ошибки:**

```typescript
{
  op: 'fromString',
  value: 'buy',
  expectedValues: ['BUY', 'SELL'],
  reason: SideErrorReason.INVALID_VALUE
}
```

### INVALID_TYPE

Возникает при **любом** методе парсинга когда runtime-значение не является строкой. Включает вызовы через `as any` (TypeScript type erasure).

**Примеры:**

```typescript
SideService.fromUnknown(null);          // [object Null]    — INVALID_TYPE
SideService.fromUnknown(undefined);     // [object Undefined] — INVALID_TYPE
SideService.fromUnknown(123);           // [object Number]  — INVALID_TYPE
SideService.fromUnknown([]);            // [object Array]   — INVALID_TYPE
SideService.fromString(42 as any);      // [object Number]  — INVALID_TYPE (!)
SideService.fromString(null as any);    // [object Null]    — INVALID_TYPE (!)
```

**Контекст ошибки:**

```typescript
{
  op: 'fromUnknown',
  value: null,
  type: 'object',
  actualTag: '[object Null]',
  reason: SideErrorReason.INVALID_TYPE
}
```

---

## API: SideService

### `fromString(value: string): Result<Side, InvalidSideError>`

Создаёт Side из строки с валидацией. Case-sensitive.

**Параметры:**

| Параметр | Тип | Описание |
|---|---|---|
| `value` | `string` | Строковое значение для парсинга |

**Возвращает:** `Result<Side, InvalidSideError>`

**Причины ошибок:**

- `INVALID_TYPE` — если `value` не строка в runtime (вызов через `as any`)
- `INVALID_VALUE` — если строка не входит в `ALL_SIDES`

**Пример:**

```typescript
// Успех
const result = SideService.fromString('BUY');
if (result.ok) {
  const side: Side = result.value; // 'BUY'
  console.log(side); // 'BUY'
}

// Ошибка — lowercase
const err1 = SideService.fromString('buy');
if (!err1.ok) {
  console.log(err1.error.context?.reason);         // 'INVALID_VALUE'
  console.log(err1.error.context?.value);          // 'buy'
  console.log(err1.error.context?.expectedValues); // ['BUY', 'SELL']
  console.log(err1.error.message);
  // "Invalid side value: buy. Expected BUY or SELL"
}

// Ошибка — не строка через as any
const err2 = SideService.fromString(42 as any);
if (!err2.ok) {
  console.log(err2.error.context?.reason);    // 'INVALID_TYPE'
  console.log(err2.error.context?.actualTag); // '[object Number]'
  console.log(err2.error.message);
  // "Invalid side: must be string, got [object Number]"
}
```

---

### `fromUnknown(value: unknown): Result<Side, InvalidSideError>`

Универсальный метод для парсинга из любого источника: API-ответ, БД, пользовательский ввод.

**Параметры:**

| Параметр | Тип | Описание |
|---|---|---|
| `value` | `unknown` | Любое значение для проверки |

**Возвращает:** `Result<Side, InvalidSideError>`

**Причины ошибок:**

- `INVALID_TYPE` — если `value` не строка
- `INVALID_VALUE` — если строка не входит в `ALL_SIDES`

**Пример:**

```typescript
// Успех — string и валидный Side
const r1 = SideService.fromUnknown('SELL');
if (r1.ok) {
  const side: Side = r1.value; // 'SELL'
}

// Ошибка — null
const r2 = SideService.fromUnknown(null);
if (!r2.ok) {
  console.log(r2.error.context?.reason);    // 'INVALID_TYPE'
  console.log(r2.error.context?.type);      // 'object'
  console.log(r2.error.context?.actualTag); // '[object Null]'
}

// Ошибка — массив
const r3 = SideService.fromUnknown(['BUY']);
if (!r3.ok) {
  console.log(r3.error.context?.actualTag); // '[object Array]'
  console.log(r3.error.context?.reason);    // 'INVALID_TYPE'
}

// Ошибка — строка, но не Side
const r4 = SideService.fromUnknown('LONG');
if (!r4.ok) {
  console.log(r4.error.context?.reason);         // 'INVALID_VALUE'
  console.log(r4.error.context?.expectedValues); // ['BUY', 'SELL']
}
```

---

### `isValid(value: unknown): value is Side`

Type guard — быстрая проверка без создания объекта `Result`.

**Параметры:**

| Параметр | Тип | Описание |
|---|---|---|
| `value` | `unknown` | Любое значение для проверки |

**Возвращает:** `value is Side` — boolean, также сужает тип в `if`-блоке

**Никогда не бросает.** Использует `SIDE_SET` для O(1) lookup.

**Пример:**

```typescript
const raw: unknown = getFromConfig();

if (SideService.isValid(raw)) {
  // raw имеет тип Side в этом блоке
  const opposite = SideService.opposite(raw); // TypeScript доволен
}

SideService.isValid('BUY');   // true
SideService.isValid('SELL');  // true
SideService.isValid('buy');   // false — case-sensitive
SideService.isValid(null);    // false — не строка
SideService.isValid(42);      // false — не строка
```

---

### `opposite(side: Side): Side`

Возвращает противоположную сторону.

**Параметры:**

| Параметр | Тип | Описание |
|---|---|---|
| `side` | `Side` | Исходная сторона |

**Возвращает:** `Side` — противоположное значение

**Pure function, никогда не бросает.**

| Вход | Результат |
|---|---|
| `'BUY'` | `'SELL'` |
| `'SELL'` | `'BUY'` |

**Пример:**

```typescript
SideService.opposite('BUY');  // 'SELL'
SideService.opposite('SELL'); // 'BUY'

// Хеджирование: открываем противоположную позицию
const hedgeSide = SideService.opposite(originalOrder.side);
```

---

### `canMatch(side1: Side, side2: Side): boolean`

Проверяет совместимость двух сторон для исполнения в order book.

**Параметры:**

| Параметр | Тип | Описание |
|---|---|---|
| `side1` | `Side` | Первая сторона |
| `side2` | `Side` | Вторая сторона |

**Возвращает:** `boolean` — `true` если стороны могут исполниться (противоположные)

**Pure function, никогда не бросает.** Match возможен только если стороны разные.

| side1 | side2 | Результат |
|---|---|---|
| `'BUY'` | `'SELL'` | `true` |
| `'SELL'` | `'BUY'` | `true` |
| `'BUY'` | `'BUY'` | `false` |
| `'SELL'` | `'SELL'` | `false` |

**Пример:**

```typescript
SideService.canMatch('BUY', 'SELL');  // true
SideService.canMatch('BUY', 'BUY');   // false

// Проверка перед применением трейда
if (SideService.canMatch(order.side, incomingOrder.side)) {
  applyMatch(order, incomingOrder);
}
```

---

### `equals(a: Side, b: Side): boolean`

Сравнивает две стороны на равенство.

**Параметры:**

| Параметр | Тип | Описание |
|---|---|---|
| `a` | `Side` | Первая сторона |
| `b` | `Side` | Вторая сторона |

**Возвращает:** `boolean`

**Pure function, никогда не бросает.** Для Side это `===`, но метод обеспечивает единообразие API.

**Пример:**

```typescript
SideService.equals('BUY', 'BUY');   // true
SideService.equals('BUY', 'SELL');  // false

// Проверка направления ордера
if (SideService.equals(order.side, 'BUY')) {
  updateBuyPositions(order);
}
```

---

### `getAllValues(): readonly Side[]`

Возвращает все валидные значения Side.

**Возвращает:** `readonly Side[]` — замороженный массив `['BUY', 'SELL']`

**Никогда не бросает.** Возвращает ссылку на `ALL_SIDES` — единственный источник правды.

**Пример:**

```typescript
const allSides = SideService.getAllValues(); // ['BUY', 'SELL']

// UI dropdown
const options = SideService.getAllValues().map(side => ({
  value: side,
  label: SideFormatter.toDisplay(side),
}));
// [{ value: 'BUY', label: 'Buy' }, { value: 'SELL', label: 'Sell' }]

// Итерация по всем сторонам
for (const side of SideService.getAllValues()) {
  console.log(side); // 'BUY', затем 'SELL'
}
```

---

## API: SideSerializer

Предоставляет методы для сериализации/десериализации Side в/из JSON. Делегирует парсинг в `SideService`.

### `toJSON(side: Side): string`

Сериализует Side в JSON-представление. Для Side это identity function — Side уже является строкой.

**Параметры:**

| Параметр | Тип | Описание |
|---|---|---|
| `side` | `Side` | Валидный Side для сериализации |

**Возвращает:** `string` — то же значение (`'BUY'` или `'SELL'`)

**Никогда не бросает.**

**Пример:**

```typescript
const json = SideSerializer.toJSON('BUY');   // 'BUY'
const json2 = SideSerializer.toJSON('SELL'); // 'SELL'

// Сериализация в JSON-объект
const orderJson = {
  id: order.id,
  side: SideSerializer.toJSON(order.side), // 'BUY'
  price: order.price,
};
JSON.stringify(orderJson); // '{"id":"...","side":"BUY","price":"..."}'
```

---

### `fromJSON(json: string): Result<Side, InvalidSideError>`

Десериализует Side из JSON-строки. Делегирует в `SideService.fromString()`.

**Параметры:**

| Параметр | Тип | Описание |
|---|---|---|
| `json` | `string` | JSON-строка для парсинга |

**Возвращает:** `Result<Side, InvalidSideError>`

**Причины ошибок:** те же, что у `SideService.fromString()` (`INVALID_TYPE`, `INVALID_VALUE`).

**Пример:**

```typescript
const r1 = SideSerializer.fromJSON('BUY');
if (r1.ok) {
  console.log(r1.value); // 'BUY'
}

const r2 = SideSerializer.fromJSON('INVALID');
if (!r2.ok) {
  console.log(r2.error.context?.reason); // 'INVALID_VALUE'
}

// Десериализация поля из API-ответа
const apiResponse: Record<string, string> = JSON.parse(rawResponse);
const sideResult = SideSerializer.fromJSON(apiResponse.side);
```

---

### `fromUnknown(json: unknown): Result<Side, InvalidSideError>`

Десериализует Side из unknown значения — для парсинга JSON.parse()-результатов. Делегирует в `SideService.fromUnknown()`.

**Параметры:**

| Параметр | Тип | Описание |
|---|---|---|
| `json` | `unknown` | Любое значение из JSON.parse() |

**Возвращает:** `Result<Side, InvalidSideError>`

**Причины ошибок:** те же, что у `SideService.fromUnknown()` (`INVALID_TYPE`, `INVALID_VALUE`).

**Пример:**

```typescript
// Парсинг полного JSON-объекта
const parsed: unknown = JSON.parse('{"side":"SELL","price":"0.65"}');
const obj = parsed as { side: unknown };

const result = SideSerializer.fromUnknown(obj.side);
if (result.ok) {
  const side: Side = result.value; // Type-safe
}

// Защита от null
const nullResult = SideSerializer.fromUnknown(null);
if (!nullResult.ok) {
  console.log(nullResult.error.context?.reason); // 'INVALID_TYPE'
}
```

---

## API: SideFormatter

Методы форматирования Side для различных контекстов отображения. Все методы принимают валидный `Side` и возвращают `string`. Никогда не бросают.

> **Архитектурная заметка:** `toEmoji`, `toColor`, `toHexColor` — UI-представление, размещены в domain/value-objects по историческим причинам. В будущем рекомендуется вынести в отдельный presentation-layer пакет.

---

### `toDisplay(side: Side): string`

Title Case для UI-отображения.

| Вход | Результат |
|---|---|
| `'BUY'` | `'Buy'` |
| `'SELL'` | `'Sell'` |

```typescript
SideFormatter.toDisplay('BUY');  // 'Buy'
SideFormatter.toDisplay('SELL'); // 'Sell'
```

---

### `toUpperCase(side: Side): string`

Identity function — Side уже в uppercase. Полезен для единообразия API.

| Вход | Результат |
|---|---|
| `'BUY'` | `'BUY'` |
| `'SELL'` | `'SELL'` |

```typescript
SideFormatter.toUpperCase('BUY');  // 'BUY'
SideFormatter.toUpperCase('SELL'); // 'SELL'
```

---

### `toLowerCase(side: Side): Lowercase<Side>`

Возвращает строго типизированный lowercase вариант.

**Возвращает:** `Lowercase<Side>` — `'buy'` или `'sell'`

| Вход | Результат |
|---|---|
| `'BUY'` | `'buy'` |
| `'SELL'` | `'sell'` |

```typescript
SideFormatter.toLowerCase('BUY');  // 'buy'
SideFormatter.toLowerCase('SELL'); // 'sell'
```

---

### `toEmoji(side: Side): string`

Визуальный индикатор для UI.

| Вход | Результат | Смысл |
|---|---|---|
| `'BUY'` | `'🟢'` | Зелёный круг — покупка, рост |
| `'SELL'` | `'🔴'` | Красный круг — продажа, падение |

```typescript
SideFormatter.toEmoji('BUY');  // '🟢'
SideFormatter.toEmoji('SELL'); // '🔴'
```

---

### `toColor(side: Side): 'green' | 'red'`

CSS color string для UI. Возвращает строго типизированный union.

| Вход | Результат |
|---|---|
| `'BUY'` | `'green'` |
| `'SELL'` | `'red'` |

```typescript
SideFormatter.toColor('BUY');  // 'green'
SideFormatter.toColor('SELL'); // 'red'
```

---

### `toHexColor(side: Side): string`

Точный hex-код для CSS-in-JS и styled-components.

| Вход | Результат | Источник |
|---|---|---|
| `'BUY'` | `'#22c55e'` | Tailwind green-500 |
| `'SELL'` | `'#ef4444'` | Tailwind red-500 |

```typescript
SideFormatter.toHexColor('BUY');  // '#22c55e'
SideFormatter.toHexColor('SELL'); // '#ef4444'
```

---

### `toLogString(side: Side): string`

Форматирует Side для вывода в логи — включает эмодзи для визуального разделения.

| Вход | Результат |
|---|---|
| `'BUY'` | `'🟢 BUY'` |
| `'SELL'` | `'🔴 SELL'` |

```typescript
SideFormatter.toLogString('BUY');  // '🟢 BUY'
SideFormatter.toLogString('SELL'); // '🔴 SELL'

logger.info(`Order executed: ${SideFormatter.toLogString(order.side)}`);
// → "Order executed: 🟢 BUY"
```

---

### `withSize(side: Side, size: number): string`

Форматирует Side вместе с размером позиции.

**Параметры:**

| Параметр | Тип | Описание |
|---|---|---|
| `side` | `Side` | Направление |
| `size` | `number` | Размер заявки/сделки |

**Возвращает:** `string` — `'{Display} {size}'`

| Вход | Результат |
|---|---|
| `('BUY', 100)` | `'Buy 100'` |
| `('SELL', 50)` | `'Sell 50'` |

```typescript
SideFormatter.withSize('BUY', 100);  // 'Buy 100'
SideFormatter.withSize('SELL', 50);  // 'Sell 50'
```

---

## Обработка ошибок

### Exhaustive switch по reason

```typescript
import { SideService, SideErrorReason } from '@polymarket/value-objects';

const result = SideService.fromUnknown(rawValue);

if (!result.ok) {
  const ctx = result.error.context;

  switch (ctx?.reason) {
    case SideErrorReason.INVALID_TYPE:
      // Не строка — ошибка источника данных
      console.error(`Expected string, got ${ctx.actualTag}`);
      break;
    case SideErrorReason.INVALID_VALUE:
      // Строка, но не Side — ошибка значения
      console.error(`Unknown side: "${ctx.value}". Valid: ${ctx.expectedValues?.join(', ')}`);
      break;
    default:
      // Fallback для непредвиденных значений reason.
      // Примечание: TypeScript не проверяет exhaustiveness при наличии default и optional chaining.
      // Для exhaustive-проверки сначала введите guard: if (!ctx) { ... } else { switch (ctx.reason) { ... } }
      // Тогда можно добавить: const _exhaustive: never = ctx.reason; (без ?.reason).
      console.error(result.error.message);
  }
}
```

### Проверка конкретной ошибки

```typescript
if (!result.ok && result.error.context?.reason === SideErrorReason.INVALID_TYPE) {
  const { actualTag, op } = result.error.context;
  logger.error('Type mismatch in side parsing', { op, actualTag });
}
```

### Использование context для диагностики

```typescript
if (!result.ok) {
  const ctx = result.error.context;
  console.log('Op:', ctx?.op);            // 'fromUnknown'
  console.log('Reason:', ctx?.reason);    // 'INVALID_VALUE'
  console.log('Value:', ctx?.value);      // 'buy'
  console.log('Expected:', ctx?.expectedValues); // ['BUY', 'SELL']
}
```
