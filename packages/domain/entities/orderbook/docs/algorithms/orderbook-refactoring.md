# Рефакторинг Orderbook Package

## Проблемы оригинального кода (24 ошибки TypeScript)

### 1. Неправильные базовые классы ошибок

**Проблема:** `OrderbookInvalidError` расширял `BaseError<typeof ORDERBOOK_INVALID_ERROR_CODE>` — такого класса не существует в `@polymarket/errors`.

**Решение:** Заменён на `TradingError` с явным `code` в опциях конструктора:

```typescript
// ДО (не компилировалось)
export class OrderbookInvalidError extends BaseError<typeof ORDERBOOK_INVALID_ERROR_CODE> {}

// ПОСЛЕ
export class OrderbookInvalidError extends TradingError {
  public override readonly severity = 'high' as const;
  constructor(message, options?) {
    super(message, { ...options, code: ORDERBOOK_INVALID_ERROR_CODE });
  }
}
```

### 2. Несуществующий `OrderbookValidationError` из `@polymarket/errors`

**Проблема:** `OrderbookNormalizer` и `OrderbookSerializer` импортировали `OrderbookValidationError` из `@polymarket/errors`, но этот класс там не существовал.

**Решение:** Создан sub-path `@polymarket/errors/orderbook` с этим классом:

```typescript
// packages/foundation/errors/src/orderbook/OrderbookValidationError.ts
export class OrderbookValidationError extends TradingError {
  public override readonly severity = 'low' as const;
}
```

Добавлен экспорт в `package.json`:
```json
"./orderbook": {
  "types": "./dist/orderbook/index.d.ts",
  "import": "./dist/orderbook/index.js"
}
```

### 3. Устаревший CJS `require()` вместо ESM `import`

**Проблема:** `Orderbook.ts` использовал `require('@polymarket/value-objects')` в ESM модуле — несовместимо.

**Решение:** Все импорты заменены на статические ESM:

```typescript
// ДО
const { Spread: SpreadVO } = require('@polymarket/value-objects');
const spreadResult = SpreadVO.create(bid, ask);

// ПОСЛЕ
import { SpreadService } from '@polymarket/value-objects';
const spreadResult = SpreadService.create(bid, ask);
```

### 4. `.value` как свойство вместо `.value()` метода

**Проблема:** `Price.value`, `Quantity.value` — это МЕТОДЫ, не свойства. Обращение без скобок возвращало саму функцию.

**Решение:** Везде заменено на `.value().toNumber()` или `.value()`:

```typescript
// ДО
const total = levels.reduce((sum, l) => sum + l.quantity.value, 0);

// ПОСЛЕ
const total = levels.reduce((sum, l) => sum.plus(l.quantity.value()), new Decimal(0));
```

### 5. `Price.fromValue()` / `Quantity.fromValue()` — несуществующие API

**Проблема:** Эти методы были заменены на Result-based фабрики.

**Решение:**
- `Price.fromValue(x)` → `PriceService.create(x)` → `Result<Price, InvalidPriceError>`
- `Quantity.fromValue(x)` → `QuantityService.create(x)` → `Result<Quantity, InvalidQuantityError>`

### 6. `Quantity.zero()` → `Quantity.ZERO`

**Проблема:** Метода `Quantity.zero()` нет, есть статическое свойство `Quantity.ZERO`.

### 7. `AssetId` — объектный тип, не строка

**Проблема:** `Orderbook.asset: AssetId` — в `@polymarket/ids` `AssetId` является объектным типом (не branded string). Прямая операция `tokenId as AssetId` TS не принял.

**Решение:** Изменён тип `asset: InstrumentId` (branded string) в контексте market-data, где tokenId — непрозрачный строковый идентификатор.

## Архитектурные улучшения

### Timestamp VO вместо number

**Было:**
```typescript
readonly venueTimestamp?: number; // unix timestamp ms
readonly receivedAt: number;
```

**Стало:**
```typescript
readonly venueTimestamp?: Timestamp;
readonly receivedAt: Timestamp;
```

**Преимущества:**
- Явный тип вместо raw number
- Метод `.toNumber()` для сериализации
- `.now()` для создания текущего timestamp
- Единообразие с остальной системой (Fill, Order)

Конвертация в `fromNormalized()`:
```typescript
const receivedAt = Timestamp.of(new Decimal(normalized.receivedAt));
const venueTimestamp = normalized.venueTimestamp !== undefined
  ? Timestamp.of(new Decimal(normalized.venueTimestamp))
  : undefined;
```

### `@polymarket/errors/orderbook` sub-path

**Расположение:** `packages/foundation/errors/src/orderbook/`

**Экспортирует:**
- `OrderbookValidationError` — низкая severity (ошибки входных данных)

**Использование:**
```typescript
import { OrderbookValidationError } from '@polymarket/errors/orderbook';
```

### Decimal-арифметика в `getTotalVolume()`

**Было:**
```typescript
const total = relevantBids.reduce(
  (sum, level) => sum + level.quantity.value, // number + property
  0
);
```

**Стало:**
```typescript
const total = relevantBids.reduce(
  (sum, level) => sum.plus(level.quantity.value()), // Decimal.plus(Decimal)
  new Decimal(0)
);
```

Точность вычислений гарантируется Decimal.js.

## Тесты

- **82 теста**, все проходят
- Покрытие: `OrderbookLevel`, `Orderbook`, `OrderbookNormalizer`, `OrderbookSerializer`
- Jest moduleNameMapper добавлен для всех workspace пакетов

## Итог

| Категория | Кол-во исправлений |
|-----------|------------------|
| Неправильные базовые классы | 1 |
| Несуществующие импорты | 2 |
| CJS require() в ESM | 4 |
| `.value` как свойство | 10+ |
| Несуществующие API (`fromValue`, `zero`) | 5 |
| Несовместимые типы (`AssetId`) | 2 |
| **Итого** | **24+** |
