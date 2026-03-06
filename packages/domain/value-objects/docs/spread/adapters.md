# Spread Adapters

> Сериализация, десериализация и форматирование

## Содержание

1. [Обзор](#обзор)
2. [SpreadSerializer](#spreadserializer)
3. [SpreadFormatter](#spreadformatter)
4. [Примеры использования](#примеры-использования)

---

## Обзор

Adapters слой предоставляет утилиты для:

- **Сериализации** — конвертация Spread в JSON объекты и строки
- **Десериализации** — создание Spread из JSON объектов и строк
- **Форматирования** — отображение для UI

**Файлы:**

- `SpreadSerializer.ts` — JSON конвертация (объекты и строки)
- `SpreadFormatter.ts` — форматирование для отображения

---

## SpreadSerializer

### Импорт

```typescript
import { SpreadSerializer } from '@polymarket/value-objects';
// или
import { SpreadSerializer } from '@polymarket/value-objects/spread';
```

---

### `toJSON(spread)`

Конвертирует Spread в JSON объект.

```typescript
toJSON(spread: Spread): SpreadJSON
```

**Возвращает:**

```typescript
interface SpreadJSON {
  bid: number;
  ask: number;
}
```

**Пример:**

```typescript
const spreadResult = SpreadService.fromValues(0.48, 0.52);
if (spreadResult.ok) {
  const json = SpreadSerializer.toJSON(spreadResult.value);
  console.log(json);
  // { bid: 0.48, ask: 0.52 }
}
```

**Примечание:** Возвращает объект (не строку). Для получения JSON строки используйте `toJSONString()`.

---

### `fromJSON(json)`

Создаёт Spread из JSON объекта (с полной runtime валидацией).

```typescript
fromJSON(json: unknown): Result<Spread, InvalidSpreadError>
```

**Параметры:**

- `json: unknown` — любой объект (валидируется на runtime)

**Возвращает:**

- `Ok(Spread)` — если JSON объект валиден
- `Err(InvalidSpreadError)` — если JSON объект невалиден

**Валидация:**

- JSON должен быть объектом (не null)
- Должны присутствовать поля `bid` и `ask`
- Оба поля должны быть numbers
- Значения должны быть валидными ценами

**Пример:**

```typescript
const json = { bid: 0.48, ask: 0.52 };
const result = SpreadSerializer.fromJSON(json);

if (result.ok) {
  const spread = result.value;
  console.log(spread.mid());  // Decimal(0.50)
}
```

**Обработка ошибок:**

```typescript
const invalidJSON = { bid: 'invalid', ask: 0.52 };
const result = SpreadSerializer.fromJSON(invalidJSON);

if (!result.ok) {
  console.log(result.error.context?.reason);
  // SpreadErrorReason.INVALID_DTO
}
```

**Примечание:** Принимает объект (не строку). Для парсинга JSON строки используйте `fromJSONString()`.

---

### `toJSONString(spread)`

Конвертирует Spread в JSON строку.

```typescript
toJSONString(spread: Spread): string
```

**Пример:**

```typescript
const spreadResult = SpreadService.fromValues(0.48, 0.52);
if (spreadResult.ok) {
  const jsonString = SpreadSerializer.toJSONString(spreadResult.value);
  console.log(jsonString);
  // '{"bid":0.48,"ask":0.52}'
}
```

---

### `fromJSONString(jsonString)`

Создаёт Spread из JSON строки.

```typescript
fromJSONString(jsonString: string): Result<Spread, InvalidSpreadError>
```

**Параметры:**

- `jsonString: string` — JSON строка

**Возвращает:**

- `Ok(Spread)` — если JSON строка валидна
- `Err(InvalidSpreadError)` — если JSON строка невалидна

**Пример:**

```typescript
const jsonString = '{"bid":0.48,"ask":0.52}';
const result = SpreadSerializer.fromJSONString(jsonString);

if (result.ok) {
  const spread = result.value;
  console.log(spread.width());  // Decimal(0.04)
}
```

**Обработка ошибок:**

```typescript
const invalidJSON = 'invalid json';
const result = SpreadSerializer.fromJSONString(invalidJSON);

if (!result.ok) {
  console.log(result.error.context?.reason);
  // SpreadErrorReason.INVALID_JSON
}
```

---

### Roundtrip Гарантия

Сериализация и десериализация обратимы (roundtrip):

```typescript
const original = SpreadService.fromValues(0.48, 0.52).value;

// toJSONString -> fromJSONString (через строки)
const jsonString = SpreadSerializer.toJSONString(original);
const restored1 = SpreadSerializer.fromJSONString(jsonString).value;
console.log(original.equals(restored1));  // true

// toJSON -> fromJSON (через объекты)
const json = SpreadSerializer.toJSON(original);
const restored2 = SpreadSerializer.fromJSON(json).value;
console.log(original.equals(restored2));  // true
```

---

## SpreadFormatter

### Импорт

```typescript
import { SpreadFormatter } from '@polymarket/value-objects';
```

---

### `format(spread, options)`

Форматирует спред с настраиваемыми опциями.

```typescript
format(spread: Spread, options?: FormatOptions): string
```

**Опции:**

```typescript
interface FormatOptions {
  decimals?: number;       // Количество десятичных знаков (default: 4)
  showWidth?: boolean;     // Показывать ширину спреда (default: true)
  showMidpoint?: boolean;  // Показывать midpoint (default: false)
}
```

**Примеры:**

```typescript
const spread = SpreadService.fromValues(0.48, 0.52).value;

// По умолчанию: bid-ask (width)
SpreadFormatter.format(spread);
// "0.4800-0.5200 (0.0400)"

// Без ширины
SpreadFormatter.format(spread, { showWidth: false });
// "0.4800-0.5200"

// С midpoint
SpreadFormatter.format(spread, { showMidpoint: true });
// "0.4800-0.5200 (0.0400, mid: 0.5000)"

// 2 десятичных знака
SpreadFormatter.format(spread, { decimals: 2 });
// "0.48-0.52 (0.04)"

// Все опции
SpreadFormatter.format(spread, {
  decimals: 3,
  showWidth: true,
  showMidpoint: true
});
// "0.480-0.520 (0.040, mid: 0.500)"
```

---

### `toBidAskString(spread, decimals)`

Простое форматирование как "bid-ask" (без ширины).

```typescript
toBidAskString(spread: Spread, decimals: number = 4): string
```

**Пример:**

```typescript
const spread = SpreadService.fromValues(0.48, 0.52).value;

SpreadFormatter.toBidAskString(spread);
// "0.4800-0.5200"

SpreadFormatter.toBidAskString(spread, 2);
// "0.48-0.52"
```

---

### `toDetailedString(spread, decimals)`

Форматирование с полными деталями (ширина + midpoint).

```typescript
toDetailedString(spread: Spread, decimals: number = 4): string
```

**Пример:**

```typescript
const spread = SpreadService.fromValues(0.48, 0.52).value;

SpreadFormatter.toDetailedString(spread);
// "0.4800-0.5200 (0.0400, mid: 0.5000)"

SpreadFormatter.toDetailedString(spread, 2);
// "0.48-0.52 (0.04, mid: 0.50)"
```

---

### `toObject(spread)`

Конвертирует Spread в объект со всеми полями.

```typescript
toObject(spread: Spread): SpreadObject
```

**Возвращает:**

```typescript
interface SpreadObject {
  bid: Decimal;
  ask: Decimal;
  width: Decimal;
  midpoint: Decimal;
}
```

**Пример:**

```typescript
const spread = SpreadService.fromValues(0.48, 0.52).value;
const obj = SpreadFormatter.toObject(spread);

console.log(obj);
// {
//   bid: Decimal(0.48),
//   ask: Decimal(0.52),
//   width: Decimal(0.04),
//   midpoint: Decimal(0.50)
// }

// Для получения numbers:
console.log(obj.bid.toNumber());  // 0.48
```

**Использование для таблиц:**

```typescript
const spreads = [
  SpreadService.fromValues(0.48, 0.52).value,
  SpreadService.fromValues(0.49, 0.51).value,
  SpreadService.fromValues(0.45, 0.55).value
];

console.table(spreads.map(s => SpreadFormatter.toObject(s)));
// ┌─────────┬──────┬──────┬───────┬──────────┐
// │ (index) │ bid  │ ask  │ width │ midpoint │
// ├─────────┼──────┼──────┼───────┼──────────┤
// │    0    │ 0.48 │ 0.52 │ 0.04  │   0.5    │
// │    1    │ 0.49 │ 0.51 │ 0.02  │   0.5    │
// │    2    │ 0.45 │ 0.55 │  0.1  │   0.5    │
// └─────────┴──────┴──────┴───────┴──────────┘
```

---

## Примеры использования

### API Response

```typescript
interface APISpread {
  bid: number;
  ask: number;
}

function parseAPIResponse(data: unknown): Result<Spread, InvalidSpreadError> {
  return SpreadSerializer.fromJSON(data);
}

// Использование
const apiData = { bid: 0.48, ask: 0.52 };
const result = parseAPIResponse(apiData);

if (result.ok) {
  console.log(SpreadFormatter.format(result.value));
  // "0.4800-0.5200 (0.0400)"
}
```

---

### Database Storage

```typescript
import { SpreadSerializer } from '@polymarket/value-objects';

class SpreadRepository {
  async save(id: string, spread: Spread): Promise<void> {
    const json = SpreadSerializer.toJSON(spread);
    await db.spreads.upsert({
      id,
      bid: json.bid,
      ask: json.ask
    });
  }

  async load(id: string): Promise<Result<Spread, InvalidSpreadError>> {
    const row = await db.spreads.findOne({ id });
    if (!row) {
      return Err(new InvalidSpreadError('Spread not found'));
    }
    return SpreadSerializer.fromJSON(row);
  }
}
```

---

### WebSocket Messages

```typescript
import { SpreadSerializer, SpreadFormatter } from '@polymarket/value-objects';

interface SpreadUpdate {
  marketId: string;
  spread: { bid: number; ask: number };
  timestamp: number;
}

function handleSpreadUpdate(message: SpreadUpdate) {
  const result = SpreadSerializer.fromJSON(message.spread);

  if (!result.ok) {
    console.error('Invalid spread update:', result.error.message);
    return;
  }

  const spread = result.value;

  // Отправляем в UI
  ui.updateMarket(message.marketId, {
    display: SpreadFormatter.format(spread, { decimals: 4 }),
    widthBps: spread.widthRatio().toDecimal().times(10000).toFixed(0),
    midPrice: spread.mid().toNumber()
  });
}
```

---

### CSV Export

```typescript
import { SpreadFormatter } from '@polymarket/value-objects';

function exportSpreadsToCSV(spreads: Array<{ marketId: string; spread: Spread }>) {
  const headers = ['Market ID', 'Bid', 'Ask', 'Width', 'Midpoint'];
  
  const rows = spreads.map(({ marketId, spread }) => {
    const obj = SpreadFormatter.toObject(spread);
    return [
      marketId,
      obj.bid.toFixed(4),
      obj.ask.toFixed(4),
      obj.width.toFixed(4),
      obj.midpoint.toFixed(4)
    ];
  });
  
  return [headers, ...rows]
    .map(row => row.join(','))
    .join('\n');
}

// Пример
const data = [
  { marketId: 'MARKET_1', spread: SpreadService.fromValues(0.48, 0.52).value },
  { marketId: 'MARKET_2', spread: SpreadService.fromValues(0.49, 0.51).value }
];

console.log(exportSpreadsToCSV(data));
// Market ID,Bid,Ask,Width,Midpoint
// MARKET_1,0.4800,0.5200,0.0400,0.5000
// MARKET_2,0.4900,0.5100,0.0200,0.5000
```

---

### React Component

```typescript
import React from 'react';
import { Spread, SpreadFormatter } from '@polymarket/value-objects';

interface SpreadBadgeProps {
  spread: Spread;
  variant?: 'compact' | 'detailed';
}

export const SpreadBadge: React.FC<SpreadBadgeProps> = ({ 
  spread, 
  variant = 'compact' 
}) => {
  const formatted = variant === 'detailed'
    ? SpreadFormatter.toDetailedString(spread, 4)
    : SpreadFormatter.toBidAskString(spread, 4);

  const widthBps = spread.widthRatio().toDecimal().times(10000).toNumber();
  const liquidityClass = 
    widthBps < 50 ? 'high-liquidity' :
    widthBps < 200 ? 'medium-liquidity' : 'low-liquidity';
  
  return (
    <span className={`spread-badge ${liquidityClass}`}>
      {formatted}
    </span>
  );
};
```

---

## Best Practices

### ✅ DO

```typescript
// Используйте Serializer для внешних данных (объекты)
const result = SpreadSerializer.fromJSON(apiData);
if (result.ok) {
  useSpread(result.value);
}

// Используйте Formatter для отображения
const display = SpreadFormatter.format(spread, { decimals: 4 });

// Проверяйте результаты десериализации
const jsonResult = SpreadSerializer.fromJSONString(jsonString);
if (!jsonResult.ok) {
  handleError(jsonResult.error);
}
```

### ❌ DON'T

```typescript
// ❌ Не создавайте объекты вручную
const fakeSpread = { _bid: bid, _ask: ask };  // ПЛОХО

// ❌ Не парсите JSON вручную
const obj = JSON.parse(json);
const spread = SpreadService.create(obj.bid, obj.ask);  // Нет валидации DTO!

// ❌ Не форматируйте вручную
const display = `${spread.bid()}-${spread.ask()}`;  // Нет контроля точности
```

---

## Производительность

### Кэширование форматированных строк

```typescript
const formatCache = new Map<Spread, string>();

function getCachedFormat(spread: Spread, decimals: number = 4): string {
  const existing = formatCache.get(spread);
  if (existing) return existing;
  
  const formatted = SpreadFormatter.format(spread, { decimals });
  formatCache.set(spread, formatted);
  
  return formatted;
}
```

### Batch сериализация

```typescript
function serializeBatch(spreads: Spread[]): string {
  const jsons = spreads.map(s => SpreadSerializer.toJSON(s));
  return JSON.stringify(jsons);
}

function deserializeBatch(jsonString: string): Result<Spread[], InvalidSpreadError>[] {
  try {
    const jsons = JSON.parse(jsonString);
    return jsons.map((json: unknown) => SpreadSerializer.fromJSON(json));
  } catch (error) {
    return [Err(new InvalidSpreadError('Invalid JSON array'))];
  }
}
```

---

## Дальнейшее чтение

- [Facade API](./facade.md) — как создавать Spread объекты
- [Примеры](./examples.md) — реальные сценарии использования
- [Core Layer](./core.md) — детали Spread класса
