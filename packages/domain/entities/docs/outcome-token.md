# OutcomeToken Entity

> Токен исхода бинарного рынка предсказаний

## Описание

**OutcomeToken** представляет один из двух возможных исходов бинарного рынка предсказаний. Каждый токен имеет уникальный идентификатор, привязан к конкретному рынку и имеет позицию (индекс) 0 или 1.

## Почему Entity, а не Value Object?

OutcomeToken является **Entity** потому что:

- ✅ Имеет уникальную идентичность (`id`)
- ✅ Привязан к конкретному рынку (`marketId`)
- ✅ Позиция в рынке важна для бизнес-логики (`outcomeIndex`)
- ✅ Сравнение по идентичности, а не по значению

## Lifecycle

- Создается вместе с Market (как часть aggregate)
- Существует пока существует Market
- Не может быть создан отдельно от Market

## Aggregate Root

Market является aggregate root, OutcomeToken - часть aggregate. Поэтому OutcomeToken создается только через `Market.create()` и использует внутренний метод `createTrusted()` без валидации (валидация на уровне Market).

## Структура

```typescript
export class OutcomeToken {
  /** Уникальный идентификатор токена (asset_id) */
  public readonly id: string;

  /** ID рынка к которому принадлежит токен */
  public readonly marketId: string;

  /** Индекс исхода (0 или 1) */
  public readonly outcomeIndex: OutcomeIndex;

  /** Человеко-читаемое название исхода */
  public readonly name: string;
}

export type OutcomeIndex = 0 | 1;
```

## Использование

### Получение OutcomeToken из Market

OutcomeToken не создается напрямую. Используйте методы Market:

```typescript
import { Market } from '@polymarket/entities';

// 1. Создайте рынок
const marketResult = Market.create({
  id: 'market-123',
  slug: 'btc-100k-2024',
  question: 'Will BTC reach $100k in 2024?',
  outcomeNames: ['Up', 'Down'],
  outcomeTokenIds: ['token-up-456', 'token-down-789'],
  expirationDate: new Date('2024-12-31T23:59:59Z'),
  status: 'ACTIVE'
});

if (!marketResult.ok) {
  console.error('Market validation failed:', marketResult.error);
  return;
}

const market = marketResult.value;

// 2. Получите outcome токен по индексу
const upToken = market.getOutcomeToken(0);
console.log(upToken.name); // "Up"
console.log(upToken.outcomeIndex); // 0

const downToken = market.getOutcomeToken(1);
console.log(downToken.name); // "Down"
console.log(downToken.outcomeIndex); // 1
```

### Поиск OutcomeToken по ID

```typescript
const market = marketResult.value;

// Найти outcome token по ID
const outcomeToken = market.getOutcomeTokenById('token-up-456');

if (outcomeToken) {
  console.log(outcomeToken.name); // "Up"
  console.log(outcomeToken.marketId); // "market-123"
}
```

### Получение индекса по ID токена

```typescript
const market = marketResult.value;

// Получить индекс outcome по token ID
const index = market.getOutcomeIndexByTokenId('token-up-456');

if (index !== null) {
  console.log(index); // 0
  console.log(market.getOutcomeToken(index).name); // "Up"
}
```

## Методы

### equals()

Проверяет равенство токенов по идентичности (по ID).

```typescript
const token1 = market.getOutcomeToken(0);
const token2 = market.getOutcomeToken(0);
const token3 = market.getOutcomeToken(1);

console.log(token1.equals(token2)); // true (один и тот же токен)
console.log(token1.equals(token3)); // false (разные токены)
```

**Важно:** Сравнение по **идентичности** (Entity), а не по значению (Value Object).

### toString()

Возвращает строковое представление токена.

```typescript
const token = market.getOutcomeToken(0);
console.log(token.toString());
// Output: "OutcomeToken[token-up-456]: Up (index: 0, market: market-123)"
```

## Связь с Trade

OutcomeToken используется в Trade entity для идентификации токена сделки.

```typescript
import { Trade } from '@polymarket/entities';
import { Price, Quantity } from '@polymarket/value-objects';

const market = marketResult.value;
const upToken = market.getOutcomeToken(0);

// Создаём сделку на Up токен
const tradeResult = Trade.create({
  id: 'trade-1',
  marketId: market.id,
  tokenId: upToken.id, // ← Ссылка на outcome token
  price: Price.fromValue(0.65).value,
  size: Quantity.fromValue(100).value,
  side: 'BUY',
  timestamp: new Date(),
  transactionHash: '0x1234...'
});

if (tradeResult.ok) {
  const trade = tradeResult.value;

  // Можем получить outcome token обратно из market
  const outcomeToken = market.getOutcomeTokenById(trade.tokenId);
  console.log(outcomeToken?.name); // "Up"
}
```

## Denormalization

Trade entity хранит `tokenId` напрямую (дублирование данных) вместо ссылки только на `marketId`. Это **оптимизация для производительности** - позволяет быстро фильтровать сделки по токену без JOIN с Market.

```typescript
// Быстрая фильтрация сделок по outcome token
const upTrades = allTrades.filter(t => t.tokenId === upToken.id);

// Без denormalization потребовался бы JOIN:
// const upTrades = allTrades.filter(t => {
//   const market = findMarketById(t.marketId);
//   return market.getOutcomeToken(0).id === upToken.id;
// });
```

## Бизнес-правила

1. **Бинарный рынок**: Всегда ровно 2 outcome токена (индексы 0 и 1)
2. **Уникальность**: Каждый outcome token имеет уникальный ID
3. **Привязка к рынку**: Каждый token принадлежит ровно одному рынку
4. **Immutability**: Все поля readonly, изменения невозможны
5. **Aggregate boundary**: Создаются и управляются только через Market

## Примеры use cases

### Use case 1: Проверка выигрышного исхода

```typescript
const market = marketResult.value;

// Разрешаем рынок
const resolveResult = market.resolve(0); // Up wins

if (resolveResult.ok) {
  const resolvedMarket = resolveResult.value;

  // Получаем выигравший токен
  const winningToken = resolvedMarket.getResolvedOutcomeToken();

  if (winningToken) {
    console.log(`Winner: ${winningToken.name}`); // "Winner: Up"
    console.log(`Token ID: ${winningToken.id}`); // "Token ID: token-up-456"
  }
}
```

### Use case 2: Фильтрация сделок по исходу

```typescript
const market = marketResult.value;
const upToken = market.getOutcomeToken(0);

// Получаем все сделки на Up
const upTrades = allTrades.filter(trade =>
  trade.tokenId === upToken.id
);

console.log(`Total Up trades: ${upTrades.length}`);
console.log(`Total Up volume: ${upTrades.reduce((sum, t) => sum + t.getNotional(), 0)}`);
```

### Use case 3: Парсинг Polymarket события

```typescript
// Событие из Polymarket WebSocket
const polymarketEvent = {
  market: 'market-123',
  asset_id: 'token-up-456',
  price: '0.65',
  size: '100',
  side: 'BUY',
  timestamp: '1705315800000',
  transaction_hash: '0x1234...'
};

// Парсим сделку
const tradeResult = Trade.fromValue(polymarketEvent);

if (tradeResult.ok) {
  const trade = tradeResult.value;

  // Находим outcome token в нашем market
  const outcomeToken = market.getOutcomeTokenById(trade.tokenId);

  if (outcomeToken) {
    console.log(`Trade on: ${outcomeToken.name}`); // "Trade on: Up"
    console.log(`Outcome index: ${outcomeToken.outcomeIndex}`); // 0
  }
}
```

## Типы

```typescript
/**
 * Индекс исхода в бинарном рынке
 */
export type OutcomeIndex = 0 | 1;

/**
 * Параметры для создания OutcomeToken (internal use only)
 */
export interface OutcomeTokenProps {
  readonly id: string;
  readonly marketId: string;
  readonly outcomeIndex: OutcomeIndex;
  readonly name: string;
}
```

## Внутренний API (Internal)

### createTrusted()

⚠️ **Не используйте напрямую!** Этот метод предназначен только для внутреннего использования Market aggregate.

```typescript
// ❌ НЕ ДЕЛАЙТЕ ТАК:
const token = OutcomeToken.createTrusted({
  id: 'token-up',
  marketId: 'market-123',
  outcomeIndex: 0,
  name: 'Up'
});

// ✅ ПРАВИЛЬНО - создавайте через Market:
const market = Market.create({
  id: 'market-123',
  outcomeNames: ['Up', 'Down'],
  // ... другие параметры
});
const token = market.value.getOutcomeToken(0);
```

## Связанные сущности

- **Market** - aggregate root, владеет outcomeTokens
- **Trade** - ссылается на outcomeToken через `tokenId`

## Архитектурные паттерны

### Aggregate Pattern

Market является aggregate root, OutcomeToken - часть aggregate.

```
Market (Aggregate Root)
  ├── OutcomeToken[0] (Part of aggregate)
  └── OutcomeToken[1] (Part of aggregate)

Trade (Separate Aggregate)
  └── tokenId (Reference by ID)
```

### Reference by ID Pattern

Trade ссылается на OutcomeToken через ID, а не объект:

```typescript
// ✅ ПРАВИЛЬНО - reference by ID
class Trade {
  public readonly tokenId: string; // Reference by ID
}

// ❌ НЕ ТАК - reference by object
class Trade {
  public readonly token: OutcomeToken; // Cross-aggregate object reference
}
```

**Почему?** Это DDD best practice для loosely coupled aggregates.

## См. также

- [Market entity](./README.md#-market---рынок-предсказаний)
- [Trade entity](./README.md#-trade---исполненная-сделка)
- [Architecture Guide](../../value-objects/docs/architecture.md)
