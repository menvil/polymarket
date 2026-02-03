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

- **Сериализации** — конвертация Spread в JSON/DTO
- **Десериализации** — создание Spread из JSON/DTO
- **Форматирования** — отображение для UI

**Файлы:**

- `SpreadSerializer.ts` — JSON/DTO конвертация
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

### `toDTO(spread)`

Конвертирует Spread в простой DTO объект.

```typescript
toDTO(spread: Spread): SpreadDTO
```

**Возвращает:**

```typescript
interface SpreadDTO {
  bid: number;
  ask: number;
}
```

**Пример:**

```typescript
const spreadResult = SpreadService.fromValues(0.48, 0.52);
if (spreadResult.ok) {
  const dto = SpreadSerializer.toDTO(spreadResult.value);
  console.log(dto);
  // { bid: 0.48, ask: 0.52 }
}
```

**Примечание:** Точная сериализация, без потери точности для стандартных цен.

---

### `fromDTO(dto)`

Создаёт Spread из DTO объекта.

```typescript
fromDTO(dto: unknown): Result<Spread, InvalidSpreadError>
```

**Параметры:**

- `dto: unknown` — любой объект (валидируется)

**Возвращает:**

- `Ok(Spread)` — если DTO валиден
- `Err(InvalidSpreadError)` — если DTO невалиден

**Валидация:**

- DTO должен быть объектом
- Должны присутствовать поля `bid` и `ask`
- Оба поля должны быть числами
- Значения должны быть валидными ценами

**Пример:**

```typescript
const dto = { bid: 0.48, ask: 0.52 };
const result = SpreadSerializer.fromDTO(dto);

if (result.ok) {
  const spread = result.value;
  console.log(spread.midpoint().toNumber());  // 0.50
}
```

**Обработка ошибок:**

```typescript
const invalidDTO = { bid: 'invalid', ask: 0.52 };
const result = SpreadSerializer.fromDTO(invalidDTO);

if (!result.ok) {
  console.log(result.error.context?.reason);
  // SpreadErrorReason.INVALID_DTO
}
```

---

### `toJSON(spread)`

Конвертирует Spread в JSON строку.

```typescript
toJSON(spread: Spread): string
```

**Пример:**

```typescript
const spreadResult = SpreadService.fromValues(0.48, 0.52);
if (spreadResult.ok) {
  const json = SpreadSerializer.toJSON(spreadResult.value);
  console.log(json);
  // '{"bid":0.48,"ask":0.52}'
}
```

---

### `fromJSON(json)`

Создаёт Spread из JSON строки.

```typescript
fromJSON(json: string): Result<Spread, InvalidSpreadError>
```

**Параметры:**

- `json: string` — JSON строка

**Возвращает:**

- `Ok(Spread)` — если JSON валиден
- `Err(InvalidSpreadError)` — если JSON невалиден

**Пример:**

```typescript
const json = '{"bid":0.48,"ask":0.52}';
const result = SpreadSerializer.fromJSON(json);

if (result.ok) {
  const spread = result.value;
  console.log(spread.width().toNumber());  // 0.04
}
```

**Обработка ошибок:**

```typescript
const invalidJSON = 'invalid json';
const result = SpreadSerializer.fromJSON(invalidJSON);

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

// toJSON -> fromJSON
const json = SpreadSerializer.toJSON(original);
const restored = SpreadSerializer.fromJSON(json).value;
console.log(original.equals(restored));  // true

// toDTO -> fromDTO
const dto = SpreadSerializer.toDTO(original);
const restored2 = SpreadSerializer.fromDTO(dto).value;
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
  bid: number;
  ask: number;
  width: number;
  midpoint: number;
}
```

**Пример:**

```typescript
const spread = SpreadService.fromValues(0.48, 0.52).value;
const obj = SpreadFormatter.toObject(spread);

console.log(obj);
// {
//   bid: 0.48,
//   ask: 0.52,
//   width: 0.04,
//   midpoint: 0.50
// }
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

function parseAPIResponse(data: APISpread): Result<Spread, InvalidSpreadError> {
  return SpreadSerializer.fromDTO(data);
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
    const dto = SpreadSerializer.toDTO(spread);
    await db.spreads.upsert({
      id,
      bid: dto.bid,
      ask: dto.ask
    });
  }
  
  async load(id: string): Promise<Result<Spread, InvalidSpreadError>> {
    const row = await db.spreads.findOne({ id });
    if (!row) {
      return Err(new InvalidSpreadError('Spread not found'));
    }
    return SpreadSerializer.fromDTO(row);
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
  const result = SpreadSerializer.fromDTO(message.spread);
  
  if (!result.ok) {
    console.error('Invalid spread update:', result.error.message);
    return;
  }
  
  const spread = result.value;
  
  // Отправляем в UI
  ui.updateMarket(message.marketId, {
    display: SpreadFormatter.format(spread, { decimals: 4 }),
    widthBps: (spread.widthPercentage() * 100).toFixed(0),
    midPrice: spread.midpoint().toNumber()
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
  
  const widthBps = spread.widthPercentage() * 100;
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
// Используйте Serializer для внешних данных
const result = SpreadSerializer.fromDTO(apiData);
if (result.ok) {
  useSpread(result.value);
}

// Используйте Formatter для отображения
const display = SpreadFormatter.format(spread, { decimals: 4 });

// Проверяйте результаты десериализации
const jsonResult = SpreadSerializer.fromJSON(json);
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
  const dtos = spreads.map(s => SpreadSerializer.toDTO(s));
  return JSON.stringify(dtos);
}

function deserializeBatch(json: string): Result<Spread[], InvalidSpreadError>[] {
  try {
    const dtos = JSON.parse(json);
    return dtos.map((dto: unknown) => SpreadSerializer.fromDTO(dto));
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
