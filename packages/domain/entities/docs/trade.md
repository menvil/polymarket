# Trade Entity

## Описание

**Trade** — это immutable entity, представляющая исполненную сделку на рынке предсказаний Polymarket.

Trade записывает факт совершённой сделки: кто, что, по какой цене, в каком объёме и когда купил или продал.

## Основные характеристики

- **Immutable** — все свойства `readonly`, изменения создают новый экземпляр
- **Result pattern** — factory методы возвращают `Result<T, E>`
- **Identity** — сравнение по ID (transaction hash)
- **Сериализация** — поддержка JSON для хранения и передачи

## Свойства

```typescript
class Trade {
  readonly id: string;                    // Уникальный ID (transaction hash)
  readonly marketId: string;               // ID рынка
  readonly tokenId: string;                // ID outcome токена
  readonly price: Price;                   // Цена исполнения
  readonly size: Quantity;                 // Размер сделки
  readonly side: TradeSide;                // Сторона: 'BUY' | 'SELL'
  readonly timestamp: Date;                // Timestamp исполнения
  readonly transactionHash: string;        // Хеш транзакции в блокчейне
  readonly orderId?: string;               // ID нашего ордера (опционально)
}
```

### TradeSide

```typescript
type TradeSide = 'BUY' | 'SELL';
```

- **BUY** — taker купил (aggressive buyer, покупательское давление)
- **SELL** — taker продал (aggressive seller, продавательское давление)

## Factory методы

### Trade.create()

Создаёт Trade с полной валидацией всех параметров.

```typescript
public static create(params: TradeParams): Result<Trade, TradeValidationError>
```

**Параметры:**

```typescript
interface TradeParams {
  id: string;
  marketId: string;
  tokenId: string;
  price: Price;
  size: Quantity;
  side: TradeSide;
  timestamp: Date;
  transactionHash: string;
  orderId?: string;
}
```

**Валидация:**
- ID не пустой
- MarketId не пустой
- TokenId не пустой
- Size положительный
- Side корректный ('BUY' или 'SELL')
- Timestamp валидный
- TransactionHash не пустой

**Пример:**

```typescript
const priceResult = Price.fromValue(0.65);
const sizeResult = Quantity.fromValue(100);

if (!priceResult.ok || !sizeResult.ok) {
  console.error('Invalid price or size');
  return;
}

const result = Trade.create({
  id: '0x1234abcd...',
  marketId: 'market-123',
  tokenId: 'token-up-456',
  price: priceResult.value,
  size: sizeResult.value,
  side: 'BUY',
  timestamp: new Date(),
  transactionHash: '0x1234abcd...'
});

if (result.ok) {
  const trade = result.value;
  console.log(`Trade created: ${trade.id}`);
  console.log(`Notional: ${trade.getNotional()}`);
} else {
  console.error('Validation failed:', result.error.message);
  console.log('Context:', result.error.context);
}
```

### Trade.fromValue()

Создаёт Trade из внешних данных (Polymarket API, WebSocket и т.д.).

```typescript
public static fromValue(data: Record<string, unknown>): Result<Trade, TradeValidationError>
```

**Формат данных Polymarket API:**

```json
{
  "market": "0xb9ed6ed...",
  "asset_id": "62305814...",
  "price": "0.44",
  "size": "4.090908",
  "side": "BUY",
  "timestamp": "1767463213145",
  "event_type": "last_trade_price",
  "transaction_hash": "0x0b5f0c77..."
}
```

**Автоматически преобразует:**
- `market` → `marketId`
- `asset_id` → `tokenId`
- `price` (string/number) → Price value object
- `size` (string/number) → Quantity value object
- `timestamp` (milliseconds) → Date
- `transaction_hash` → ID (уникальный, без дублирования)

**Пример:**

```typescript
// WebSocket событие от Polymarket
const event = {
  market: 'market-123',
  asset_id: 'token-up-456',
  price: '0.65',
  size: '100.5',
  side: 'BUY',
  timestamp: '1767463213145',
  transaction_hash: '0x1234abcd...'
};

const result = Trade.fromValue(event);

if (result.ok) {
  const trade = result.value;
  console.log(`Trade: ${trade.side} ${trade.size.value} @ ${trade.price.value}`);
  console.log(`Market: ${trade.marketId}`);
  console.log(`Token: ${trade.tokenId}`);
} else {
  console.error('Invalid trade data:', result.error.message);
}
```

### Trade.fromJSON()

Десериализует Trade из JSON объекта.

```typescript
public static fromJSON(json: unknown): Result<Trade, TradeValidationError>
```

**Ожидаемый формат:**

```json
{
  "id": "0x1234...",
  "marketId": "market-123",
  "tokenId": "token-up-456",
  "price": 0.65,
  "size": 100,
  "side": "BUY",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "transactionHash": "0x1234...",
  "orderId": "order-1"
}
```

**Пример:**

```typescript
const json = {
  id: '0x1234...',
  marketId: 'market-123',
  tokenId: 'token-up-456',
  price: 0.65,
  size: 100,
  side: 'BUY',
  timestamp: '2024-01-15T10:30:00.000Z',
  transactionHash: '0x1234...'
};

const result = Trade.fromJSON(json);

if (result.ok) {
  const trade = result.value;
  console.log(`Trade loaded: ${trade.id}`);
}
```

## Методы

### getNotional()

Вычисляет notional value сделки (price × size).

```typescript
public getNotional(): number
```

**Возвращает:** Notional value в USDC (number)

**Пример:**

```typescript
const trade = Trade.create({...}).value;
const notional = trade.getNotional();
console.log(notional); // 65.0 (для price=0.65, size=100)
```

**Используется для:**
- Расчёта объёмов торговли
- Анализа ликвидности
- Вычисления комиссий

### getNotionalDecimal()

Вычисляет notional value с высокой точностью (Decimal.js).

```typescript
public getNotionalDecimal(): Decimal
```

**Возвращает:** Notional value как Decimal

**Зачем нужен?**
- Избегает ошибок округления floating-point арифметики
- Гарантирует точность до 20 знаков после запятой
- Критично для финансовых расчётов (комиссии, PnL, налоги)

**Пример:**

```typescript
const trade = Trade.create({...}).value;
const notionalDecimal = trade.getNotionalDecimal();

console.log(notionalDecimal.toString()); // "65.00"
console.log(notionalDecimal.toFixed(4)); // "65.0000"

// Точные финансовые расчёты
const fee = notionalDecimal.mul(0.001); // 0.1% комиссия
console.log(fee.toString()); // "0.065"
```

**Рекомендуется использовать вместо getNotional() для:**
- Расчёта комиссий без потери точности
- Бухгалтерских операций
- Анализа PnL (profit and loss)
- Налоговых расчётов

### getAgeMs()

Получает возраст сделки в миллисекундах.

```typescript
public getAgeMs(): number
```

**Возвращает:** Время с момента исполнения в мс

**Пример:**

```typescript
const ageMs = trade.getAgeMs();
console.log(ageMs); // 15000 (15 секунд назад)
```

### isRecent()

Проверяет, является ли сделка недавней.

```typescript
public isRecent(maxAgeMs: number = 60000): boolean
```

**Параметры:**
- `maxAgeMs` — максимальный возраст в мс (по умолчанию 60000 = 1 минута)

**Пример:**

```typescript
// Проверка за последние 30 секунд
if (trade.isRecent(30000)) {
  console.log('Recent trade');
}

// По умолчанию за последнюю минуту
if (trade.isRecent()) {
  console.log('Trade happened in last minute');
}
```

### isBuy() / isSell()

Предикаты для проверки стороны сделки.

```typescript
public isBuy(): boolean
public isSell(): boolean
```

**Пример:**

```typescript
if (trade.isBuy()) {
  console.log('Buying pressure');
  buyVolume += trade.getNotional();
}

if (trade.isSell()) {
  console.log('Selling pressure');
  sellVolume += trade.getNotional();
}
```

### compareByTime()

Сравнивает сделки по времени.

```typescript
public compareByTime(other: Trade): number
```

**Возвращает:**
- Отрицательное если эта сделка раньше
- Положительное если позже
- 0 если одновременно

**Пример:**

```typescript
const trades = [trade1, trade2, trade3];

// Сортировка по возрастанию (старые → новые)
trades.sort((a, b) => a.compareByTime(b));

// Сортировка по убыванию (новые → старые)
trades.sort((a, b) => b.compareByTime(a));
```

### toJSON()

Сериализует Trade в JSON объект.

```typescript
public toJSON(): Record<string, unknown>
```

**Возвращает:**

```json
{
  "id": "0x1234...",
  "marketId": "market-123",
  "tokenId": "token-up-456",
  "price": 0.65,
  "size": 100,
  "side": "BUY",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "transactionHash": "0x1234...",
  "notional": 65.0,
  "orderId": "order-1"
}
```

**Пример:**

```typescript
const json = trade.toJSON();
const jsonString = JSON.stringify(json, null, 2);
console.log(jsonString);
```

### toString()

Конвертирует в строковое представление.

```typescript
public toString(): string
```

**Пример:**

```typescript
console.log(trade.toString());
// "Trade[0x1234...]: BUY 100.00 @ 0.6500 (2024-01-15T10:30:00.000Z)"
```

## Примеры использования

### Загрузка сделок из WebSocket

```typescript
import { Trade } from '@polymarket/entities';
import { TradeValidationError } from '@polymarket/errors';

ws.on('last_trade_price', (event: any) => {
  const result = Trade.fromValue(event);

  if (result.ok) {
    const trade = result.value;

    // Обновление UI
    updateTradeHistory(trade);

    // Аналитика
    if (trade.isRecent(5000)) { // За последние 5 секунд
      const notional = trade.getNotionalDecimal();
      console.log(`Recent ${trade.side}: ${notional.toString()} USDC`);
    }
  } else if (TradeValidationError.is(result.error)) {
    console.error('Invalid trade data:', result.error.message);
    console.log('Field:', result.error.context?.field);
  }
});
```

### Расчёт VWAP (Volume-Weighted Average Price)

```typescript
function calculateVWAP(trades: Trade[]): number {
  let totalNotional = new Decimal(0);
  let totalVolume = new Decimal(0);

  for (const trade of trades) {
    const notional = trade.getNotionalDecimal();
    totalNotional = totalNotional.plus(notional);
    totalVolume = totalVolume.plus(trade.size.value);
  }

  if (totalVolume.isZero()) {
    return 0;
  }

  return totalNotional.dividedBy(totalVolume).toNumber();
}

// Использование
const recentTrades = trades.filter(t => t.isRecent(300000)); // 5 минут
const vwap = calculateVWAP(recentTrades);
console.log(`VWAP: ${vwap.toFixed(4)}`);
```

### Анализ buying/selling pressure

```typescript
function analyzePressure(trades: Trade[], timeWindowMs: number = 60000) {
  const recentTrades = trades.filter(t => t.isRecent(timeWindowMs));

  let buyVolume = new Decimal(0);
  let sellVolume = new Decimal(0);

  for (const trade of recentTrades) {
    const notional = trade.getNotionalDecimal();

    if (trade.isBuy()) {
      buyVolume = buyVolume.plus(notional);
    } else {
      sellVolume = sellVolume.plus(notional);
    }
  }

  const totalVolume = buyVolume.plus(sellVolume);

  if (totalVolume.isZero()) {
    return { pressure: 0, buyRatio: 0.5, sellRatio: 0.5 };
  }

  const buyRatio = buyVolume.dividedBy(totalVolume).toNumber();
  const sellRatio = sellVolume.dividedBy(totalVolume).toNumber();
  const pressure = buyRatio - sellRatio; // -1 (сильное продавательское) до +1 (сильное покупательское)

  return { pressure, buyRatio, sellRatio };
}

// Использование
const analysis = analyzePressure(trades, 300000); // За 5 минут
console.log(`Pressure: ${(analysis.pressure * 100).toFixed(1)}%`);
console.log(`Buy: ${(analysis.buyRatio * 100).toFixed(1)}%`);
console.log(`Sell: ${(analysis.sellRatio * 100).toFixed(1)}%`);
```

### Построение графика объёмов

```typescript
function buildVolumeChart(trades: Trade[], intervalMs: number = 60000) {
  // Группируем сделки по временным интервалам
  const intervals = new Map<number, { buy: Decimal; sell: Decimal }>();

  for (const trade of trades) {
    const intervalStart = Math.floor(trade.timestamp.getTime() / intervalMs) * intervalMs;

    if (!intervals.has(intervalStart)) {
      intervals.set(intervalStart, { buy: new Decimal(0), sell: new Decimal(0) });
    }

    const interval = intervals.get(intervalStart)!;
    const notional = trade.getNotionalDecimal();

    if (trade.isBuy()) {
      interval.buy = interval.buy.plus(notional);
    } else {
      interval.sell = interval.sell.plus(notional);
    }
  }

  // Конвертируем в массив для графика
  return Array.from(intervals.entries())
    .map(([timestamp, { buy, sell }]) => ({
      timestamp: new Date(timestamp),
      buyVolume: buy.toNumber(),
      sellVolume: sell.toNumber(),
      totalVolume: buy.plus(sell).toNumber()
    }))
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

// Использование
const chart = buildVolumeChart(trades, 60000); // 1-минутные интервалы
chart.forEach(bar => {
  console.log(`${bar.timestamp.toISOString()}: Buy=${bar.buyVolume} Sell=${bar.sellVolume}`);
});
```

### Сохранение истории сделок

```typescript
async function saveTrades(trades: Trade[]) {
  const serialized = trades.map(t => t.toJSON());

  // Сохранение в БД
  await db.trades.insertMany(serialized);

  console.log(`Saved ${trades.length} trades`);
}

async function loadTrades(marketId: string): Promise<Trade[]> {
  const records = await db.trades.find({ marketId });

  const trades: Trade[] = [];

  for (const record of records) {
    const result = Trade.fromJSON(record);

    if (result.ok) {
      trades.push(result.value);
    } else {
      console.error(`Failed to load trade ${record.id}:`, result.error.message);
    }
  }

  return trades;
}
```

## Денормализация tokenId

Trade хранит `tokenId` напрямую, хотя его можно получить через `marketId`.

**Зачем?**
- **Производительность** — быстрая фильтрация сделок по токену без JOIN с Market
- **Упрощение запросов** — не нужно загружать Market для фильтрации
- **Оптимизация БД** — индекс по tokenId для быстрого поиска

**Пример:**

```typescript
// Быстрая фильтрация без загрузки Market
const upTokenTrades = trades.filter(t => t.tokenId === 'token-up-456');

// Vs медленный вариант с загрузкой Market
const upTokenTrades = trades.filter(t => {
  const market = loadMarket(t.marketId); // Медленно!
  return market.outcomeTokens[0].id === 'token-up-456';
});
```

## Best Practices

### ✅ DO

```typescript
// ✅ Всегда проверяй Result
const result = Trade.fromValue(data);
if (result.ok) {
  const trade = result.value;
}

// ✅ Используй getNotionalDecimal() для финансовых расчётов
const fee = trade.getNotionalDecimal().mul(0.001);

// ✅ Валидируй данные из внешних источников
const result = Trade.fromValue(apiData);
if (!result.ok) {
  logger.error('Invalid trade data', result.error);
}

// ✅ Используй предикаты для читаемости
if (trade.isBuy()) {
  buyVolume += trade.getNotional();
}
```

### ❌ DON'T

```typescript
// ❌ Не игнорируй ошибки валидации
const trade = Trade.fromValue(data).value!; // Может упасть!

// ❌ Не используй getNotional() для точных расчётов
const fee = trade.getNotional() * 0.001; // Потеря точности!

// ❌ Не создавай Trade вручную
const trade = new Trade(params); // Ошибка компиляции

// ❌ Не сравнивай через ===
if (trade1 === trade2) { // Всегда false
  // Даже если это та же сделка!
}

// ✅ Сравнивай по ID
if (trade1.id === trade2.id) {
  console.log('Same trade');
}
```

## Связанные концепции

- **[Order Entity](./order.md)** — ордер, который может привести к Trade
- **[Market Entity](./market.md)** — рынок, на котором происходит Trade
- **[Price Value Object](../../value-objects/docs/price.md)** — цена исполнения
- **[Quantity Value Object](../../value-objects/docs/quantity.md)** — объём сделки
- **[TradeValidationError](../../foundation/errors/docs/entities/TradeValidationError.md)** — ошибки валидации

## См. также

- [Entity Pattern](https://martinfowler.com/bliki/EvansClassification.html)
- [Result Pattern](../../result/docs/README.md)
- [Error Handling Guide](../../foundation/errors/docs/README.md)
