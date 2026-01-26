# Market Entity

## Описание

**Market** — это immutable entity, представляющая рынок бинарных предсказаний на Polymarket.

Market — это **aggregate root** в терминах DDD, содержащий два OutcomeToken (исходы "Up" и "Down").

## Основные характеристики

- **Immutable** — все свойства `readonly`, изменения создают новый экземпляр
- **Result pattern** — factory методы возвращают `Result<T, E>`
- **Aggregate root** — содержит OutcomeToken entities
- **Lifecycle** — переходы между статусами ACTIVE → CLOSED → RESOLVED
- **Сериализация** — поддержка JSON для хранения и передачи

## Свойства

```typescript
class Market {
  readonly id: string;                          // Уникальный ID рынка
  readonly slug: string;                        // URL-friendly slug
  readonly question: string;                    // Вопрос рынка
  readonly outcomeTokens: [OutcomeToken, OutcomeToken]; // Два токена исходов
  readonly expirationDate: Date;                // Дата истечения
  readonly status: MarketStatus;                // Статус рынка
  readonly resolvedOutcomeIndex: OutcomeIndex | null; // Индекс выигравшего исхода
  readonly marketUrl: string;                   // URL на Polymarket (getter)
}
```

### MarketStatus

```typescript
type MarketStatus = 'ACTIVE' | 'CLOSED' | 'RESOLVED';
```

- **ACTIVE** — рынок активен, принимает ставки
- **CLOSED** — рынок закрыт, ставки не принимаются, ожидает разрешения
- **RESOLVED** — рынок разрешён, определён выигравший исход

### OutcomeIndex

```typescript
type OutcomeIndex = 0 | 1;
```

- **0** — первый исход (обычно "Up")
- **1** — второй исход (обычно "Down")

## Factory методы

### Market.create()

Создаёт Market с полной валидацией всех параметров.

```typescript
public static create(props: MarketProps): Result<Market, MarketValidationError>
```

**Параметры:**

```typescript
interface MarketProps {
  id: string;
  slug: string;
  question: string;
  outcomeNames: [string, string];
  outcomeTokenIds: [string, string];
  expirationDate: Date;
  status: MarketStatus;
  resolvedOutcomeIndex?: OutcomeIndex | null;
}
```

**Валидация:**
- ID не пустой
- Slug не пустой
- Question не пустой
- Ровно 2 outcome names (не пустые)
- Ровно 2 outcome token IDs (не пустые)
- Status корректный
- ExpirationDate валидный
- ResolvedOutcomeIndex соответствует статусу

**Пример:**

```typescript
import { Market } from '@polymarket/entities';

const result = Market.create({
  id: 'market-123',
  slug: 'btc-100k-2024',
  question: 'Will BTC reach $100k in 2024?',
  outcomeNames: ['Up', 'Down'],
  outcomeTokenIds: ['token-up-456', 'token-down-789'],
  expirationDate: new Date('2024-12-31'),
  status: 'ACTIVE'
});

if (result.ok) {
  const market = result.value;
  console.log(market.question);
  console.log(market.outcomeTokens[0].name); // "Up"
  console.log(market.outcomeTokens[1].name); // "Down"
  console.log(market.marketUrl); // "https://polymarket.com/market/btc-100k-2024"
} else {
  console.error('Validation failed:', result.error.message);
  console.log('Context:', result.error.context);
}
```

### Market.fromJSON()

Десериализует Market из JSON объекта.

```typescript
public static fromJSON(json: unknown): Result<Market, MarketValidationError>
```

**Ожидаемый формат:**

```json
{
  "id": "market-123",
  "slug": "btc-100k-2024",
  "question": "Will BTC reach $100k?",
  "outcomeTokens": [
    { "id": "token-up-456", "marketId": "market-123", "outcomeIndex": 0, "name": "Up" },
    { "id": "token-down-789", "marketId": "market-123", "outcomeIndex": 1, "name": "Down" }
  ],
  "expirationDate": "2024-12-31T23:59:59.000Z",
  "status": "ACTIVE",
  "resolvedOutcomeIndex": null
}
```

**Пример:**

```typescript
const json = {
  id: 'market-123',
  slug: 'btc-100k-2024',
  question: 'Will BTC reach $100k?',
  outcomeTokens: [
    { id: 'token-up-456', name: 'Up' },
    { id: 'token-down-789', name: 'Down' }
  ],
  expirationDate: '2024-12-31T23:59:59.000Z',
  status: 'ACTIVE'
};

const result = Market.fromJSON(json);

if (result.ok) {
  const market = result.value;
  console.log(`Market loaded: ${market.id}`);
}
```

## Lifecycle методы

Market проходит через lifecycle: **ACTIVE → CLOSED → RESOLVED**

### close()

Закрывает рынок (переводит в статус CLOSED).

```typescript
public close(): Result<Market, MarketValidationError>
```

**Возвращает:** `Result<Market, MarketValidationError>` — новый instance со статусом CLOSED

**Что происходит:**
- Статус меняется на 'CLOSED'
- `resolvedOutcomeIndex` устанавливается в `null` (ещё не разрешён)
- Рынок не принимает новые сделки

**Пример:**

```typescript
const activeMarket = Market.create({
  status: 'ACTIVE',
  // ...
}).value;

const result = activeMarket.close();

if (result.ok) {
  const closedMarket = result.value;
  console.log(closedMarket.status); // "CLOSED"
  console.log(closedMarket.canTrade()); // false
  console.log(closedMarket.resolvedOutcomeIndex); // null
}
```

### resolve()

Разрешает рынок с указанным исходом (переводит в статус RESOLVED).

```typescript
public resolve(outcomeIndex: OutcomeIndex): Result<Market, MarketValidationError>
```

**Параметры:**
- `outcomeIndex` — индекс выигравшего исхода (0 или 1)

**Валидация:**
- outcomeIndex должен быть 0 или 1

**Возвращает:** `Result<Market, MarketValidationError>` — новый instance со статусом RESOLVED

**Пример:**

```typescript
const closedMarket = activeMarket.close().value;
const result = closedMarket.resolve(0); // Outcome 0 wins ("Up")

if (result.ok) {
  const resolvedMarket = result.value;
  console.log(resolvedMarket.status); // "RESOLVED"
  console.log(resolvedMarket.resolvedOutcomeIndex); // 0
  console.log(resolvedMarket.getResolvedOutcomeToken()?.name); // "Up"
}
```

## Getter методы

### getOutcomeToken()

Получает outcome token по индексу.

```typescript
public getOutcomeToken(index: OutcomeIndex): OutcomeToken
```

**Пример:**

```typescript
const upToken = market.getOutcomeToken(0);
console.log(upToken.name); // "Up"

const downToken = market.getOutcomeToken(1);
console.log(downToken.name); // "Down"
```

### getResolvedOutcomeToken()

Получает выигравший outcome token (только для RESOLVED рынков).

```typescript
public getResolvedOutcomeToken(): OutcomeToken | null
```

**Возвращает:**
- `OutcomeToken` если рынок разрешён
- `null` если рынок не разрешён

**Пример:**

```typescript
const resolvedMarket = market.resolve(0).value;
const winner = resolvedMarket.getResolvedOutcomeToken();

if (winner) {
  console.log(`Winner: ${winner.name}`); // "Up"
  console.log(`Token ID: ${winner.id}`);
}
```

## Предикаты

### isActive()

Проверяет, является ли рынок активным.

```typescript
public isActive(): boolean
```

**Пример:**

```typescript
if (market.isActive()) {
  console.log('Market is accepting trades');
}
```

### isClosed()

Проверяет, закрыт ли рынок.

```typescript
public isClosed(): boolean
```

**Пример:**

```typescript
if (market.isClosed()) {
  console.log('Market is closed, waiting for resolution');
}
```

### isResolved()

Проверяет, разрешён ли рынок.

```typescript
public isResolved(): boolean
```

**Пример:**

```typescript
if (market.isResolved()) {
  const winner = market.getResolvedOutcomeToken();
  console.log(`Market resolved: ${winner?.name} wins`);
}
```

### isExpired()

Проверяет, истёк ли срок рынка.

```typescript
public isExpired(): boolean
```

**Пример:**

```typescript
if (market.isExpired()) {
  console.log('Market has expired');
}
```

### canTrade()

Проверяет, можно ли торговать на рынке.

```typescript
public canTrade(): boolean
```

**Возвращает:** `true` если рынок активен И не истёк

**Пример:**

```typescript
if (market.canTrade()) {
  // Place order
  placeOrder(market.id, order);
} else {
  console.log('Trading not allowed');
}
```

## Сериализация

### toJSON()

Сериализует Market в JSON объект.

```typescript
public toJSON(): Record<string, unknown>
```

**Возвращает:**

```json
{
  "id": "market-123",
  "slug": "btc-100k-2024",
  "question": "Will BTC reach $100k?",
  "outcomeTokens": [
    { "id": "token-up-456", "marketId": "market-123", "outcomeIndex": 0, "name": "Up" },
    { "id": "token-down-789", "marketId": "market-123", "outcomeIndex": 1, "name": "Down" }
  ],
  "expirationDate": "2024-12-31T23:59:59.000Z",
  "status": "ACTIVE",
  "resolvedOutcomeIndex": null
}
```

**Пример:**

```typescript
const json = market.toJSON();
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
console.log(market.toString());
// "Market[market-123]: Will BTC reach $100k? [Up/Down] (ACTIVE)"
```

## Примеры использования

### Создание рынка

```typescript
import { Market } from '@polymarket/entities';
import { MarketValidationError } from '@polymarket/errors';

function createMarket(data: {
  id: string;
  slug: string;
  question: string;
  expirationDate: Date;
}) {
  const result = Market.create({
    id: data.id,
    slug: data.slug,
    question: data.question,
    outcomeNames: ['Up', 'Down'],
    outcomeTokenIds: [`${data.id}-up`, `${data.id}-down`],
    expirationDate: data.expirationDate,
    status: 'ACTIVE'
  });

  if (result.ok) {
    return result.value;
  }

  if (MarketValidationError.is(result.error)) {
    console.error('Validation failed:', result.error.message);
    console.log('Field:', result.error.context?.field);
  }

  return null;
}
```

### Lifecycle управление

```typescript
async function resolveMarket(marketId: string, winningOutcome: 0 | 1) {
  // 1. Загружаем рынок
  const market = await loadMarket(marketId);

  if (!market.isActive()) {
    throw new Error('Market must be ACTIVE');
  }

  // 2. Закрываем рынок
  const closeResult = market.close();

  if (!closeResult.ok) {
    throw new Error(`Failed to close: ${closeResult.error.message}`);
  }

  const closedMarket = closeResult.value;

  // 3. Разрешаем рынок
  const resolveResult = closedMarket.resolve(winningOutcome);

  if (!resolveResult.ok) {
    throw new Error(`Failed to resolve: ${resolveResult.error.message}`);
  }

  const resolvedMarket = resolveResult.value;

  // 4. Сохраняем
  await saveMarket(resolvedMarket);

  // 5. Обработка выплат
  const winner = resolvedMarket.getResolvedOutcomeToken()!;
  console.log(`Market resolved: ${winner.name} wins`);

  return resolvedMarket;
}
```

### Проверка возможности торговли

```typescript
function canPlaceOrder(market: Market): boolean {
  // Проверка статуса
  if (!market.isActive()) {
    console.log('Market is not active');
    return false;
  }

  // Проверка истечения
  if (market.isExpired()) {
    console.log('Market has expired');
    return false;
  }

  // Совмещённая проверка
  if (!market.canTrade()) {
    console.log('Trading not allowed');
    return false;
  }

  return true;
}
```

### Получение информации о токенах

```typescript
function getTokenInfo(market: Market) {
  const upToken = market.getOutcomeToken(0);
  const downToken = market.getOutcomeToken(1);

  return {
    market: {
      id: market.id,
      question: market.question,
      status: market.status
    },
    tokens: {
      up: {
        id: upToken.id,
        name: upToken.name,
        index: upToken.outcomeIndex
      },
      down: {
        id: downToken.id,
        name: downToken.name,
        index: downToken.outcomeIndex
      }
    }
  };
}
```

### Отображение UI

```typescript
function renderMarket(market: Market) {
  const statusBadge = {
    ACTIVE: '🟢 Active',
    CLOSED: '🟡 Closed',
    RESOLVED: '🔵 Resolved'
  }[market.status];

  const info = {
    title: market.question,
    status: statusBadge,
    url: market.marketUrl,
    outcomes: market.outcomeTokens.map(t => ({
      name: t.name,
      id: t.id,
      index: t.outcomeIndex
    })),
    canTrade: market.canTrade(),
    expiresAt: market.expirationDate,
    isExpired: market.isExpired()
  };

  if (market.isResolved()) {
    const winner = market.getResolvedOutcomeToken();
    info.winner = winner?.name;
  }

  return info;
}
```

### Сохранение и загрузка

```typescript
async function saveMarket(market: Market) {
  const json = market.toJSON();
  await db.markets.updateOne(
    { id: market.id },
    { $set: json },
    { upsert: true }
  );
}

async function loadMarket(marketId: string): Promise<Market | null> {
  const record = await db.markets.findOne({ id: marketId });

  if (!record) {
    return null;
  }

  const result = Market.fromJSON(record);

  if (result.ok) {
    return result.value;
  }

  console.error(`Failed to load market ${marketId}:`, result.error.message);
  return null;
}
```

### Фильтрация рынков

```typescript
function filterMarkets(markets: Market[]) {
  return {
    active: markets.filter(m => m.isActive() && !m.isExpired()),
    trading: markets.filter(m => m.canTrade()),
    closed: markets.filter(m => m.isClosed()),
    resolved: markets.filter(m => m.isResolved()),
    expired: markets.filter(m => m.isExpired())
  };
}

// Использование
const marketsList = await loadAllMarkets();
const filtered = filterMarkets(marketsList);

console.log(`Active: ${filtered.active.length}`);
console.log(`Trading allowed: ${filtered.trading.length}`);
console.log(`Resolved: ${filtered.resolved.length}`);
```

## Aggregate Pattern

Market является **aggregate root** в DDD:

```typescript
// ✅ Правильно: создание через Market aggregate
const market = Market.create({
  outcomeNames: ['Up', 'Down'],
  outcomeTokenIds: ['token-up', 'token-down'],
  // ...
}).value;

const upToken = market.getOutcomeToken(0);

// ❌ Неправильно: создание OutcomeToken отдельно
const token = OutcomeToken.create({...}); // Нет такого метода!
```

**Почему?**
- OutcomeToken всегда принадлежит Market
- Валидация на уровне aggregate root
- Гарантия консистентности данных
- Упрощение API

## Best Practices

### ✅ DO

```typescript
// ✅ Всегда проверяй Result
const result = Market.create(props);
if (result.ok) {
  const market = result.value;
}

// ✅ Используй предикаты для читаемости
if (market.canTrade()) {
  placeOrder(market.id, order);
}

// ✅ Проверяй статус перед lifecycle операциями
if (market.isActive()) {
  const closeResult = market.close();
  // ...
}

// ✅ Обрабатывай Result от lifecycle методов
const result = market.close();
if (!result.ok) {
  console.error('Failed to close:', result.error.message);
}
```

### ❌ DON'T

```typescript
// ❌ Не игнорируй ошибки валидации
const market = Market.create(props).value!; // Может упасть!

// ❌ Не создавай Market вручную
const market = new Market(props); // Ошибка компиляции

// ❌ Не создавай OutcomeToken отдельно
const token = OutcomeToken.create({...}); // Нет такого метода

// ❌ Не игнорируй canTrade()
placeOrder(market.id, order); // Может быть закрыт или истёк!

// ✅ Проверяй canTrade()
if (market.canTrade()) {
  placeOrder(market.id, order);
}
```

## Связанные концепции

- **[OutcomeToken Entity](./outcome-token.md)** — токены исходов рынка
- **[Order Entity](./order.md)** — ордера на рынке
- **[Trade Entity](./trade.md)** — исполненные сделки на рынке
- **[MarketValidationError](../../foundation/errors/docs/entities/MarketValidationError.md)** — ошибки валидации

## См. также

- [Aggregate Pattern](https://martinfowler.com/bliki/DDD_Aggregate.html)
- [Entity Pattern](https://martinfowler.com/bliki/EvansClassification.html)
- [Result Pattern](../../result/docs/README.md)
- [Error Handling Guide](../../foundation/errors/docs/README.md)
