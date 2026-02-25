# Trade Entity

## Что такое Trade

`Trade` — рыночный принт (market tape). Представляет факт совершения сделки на рынке, независимо от того, участвовали ли мы в ней. Используется для:

- Рыночной аналитики (VWAP, объёмы, momentum)
- Order book pressure анализа
- Генерации торговых сигналов
- Синхронизации рыночного состояния

## Чем Trade НЕ является

Trade **НЕ** является исполнением нашего ордера. Для записи о том, что наш конкретный ордер был (частично) исполнен, используется `Fill`.

## Пакет

```
packages/domain/entities/trade/
```

Экспортируется как `@polymarket/trade` (только для внутреннего использования через project references).

## Структура

```
src/
  Trade.ts          # Основная сущность
  TradeSnapshot.ts  # Плоское DTO для хранения/логов
  index.ts
  mappers/
    TradeMapper.ts  # fromPolymarketLastTradeEvent, toSnapshot, fromSnapshot
```

## Интерфейс TradeParams

```typescript
interface TradeParams {
  readonly id: VenueTradeId;       // Уникальный ID на venue
  readonly venueId: VenueId;       // Биржа (POLYMARKET)
  readonly marketId: string;       // ID рынка
  readonly tokenId: AssetId;       // ID outcome токена
  readonly price: Price;           // Цена сделки
  readonly size: Quantity;         // Объём сделки
  readonly aggressorSide?: Side;   // Инициатор (BUY/SELL) — опционально
  readonly timestamp: Timestamp;   // Время сделки
  readonly txHash?: TxHash;        // Хэш транзакции блокчейна
}
```

## Инварианты

`Trade.create()` проверяет:

1. `id` не пустой
2. `venueId` не пустой
3. `marketId` не пустой
4. `tokenId` присутствует
5. `price > 0`
6. `size > 0`
7. `timestamp` присутствует (epoch ms > 0)

`aggressorSide` и `txHash` опциональны — не всегда известны из API.

## Методы

```typescript
// Вычисления
getNotional(): Decimal          // price × size

// Предикаты
isBuy(): boolean                // aggressorSide === 'BUY'
isSell(): boolean               // aggressorSide === 'SELL'
compareByTime(other: Trade): number  // сравнение по timestamp

// Сериализация
toSnapshot(): TradeSnapshot
toString(): string
```

## TradeMapper

### fromPolymarketLastTradeEvent

Парсит входящее событие Polymarket:

```typescript
// Входной формат:
{
  market: string,           // market ID
  asset_id: string,         // JSON-сериализованный AssetId
  price: string,            // цена как строка
  size: string,             // объём как строка
  side: string,             // 'BUY' | 'SELL'
  timestamp: string,        // unix timestamp в секундах
  transaction_hash?: string // хэш транзакции
}
```

VenueTradeId генерируется как:
- `{txHash}_{timestamp}` если есть transaction_hash
- `{market}_{assetId}_{timestamp}` если нет

### toSnapshot / fromSnapshot

Round-trip сериализация через `TradeSnapshot` (плоские примитивы).

## Пример использования

```typescript
import { TradeMapper } from '@polymarket/trade';

const result = TradeMapper.fromPolymarketLastTradeEvent({
  market: '0xmarket123',
  asset_id: JSON.stringify({ type: 'OUTCOME_TOKEN', ... }),
  price: '0.65',
  size: '100',
  side: 'BUY',
  timestamp: '1700000000',
  transaction_hash: '0xabc...'
});

if (result.ok) {
  const trade = result.value;
  console.log(trade.getNotional().toNumber()); // 65
  console.log(trade.isBuy()); // true
}
```

## Связь с Fill

`Fill` может опционально ссылаться на Trade через `venueTradeId`:

```
Fill.venueTradeId?: VenueTradeId → Trade.id
```

Связка устанавливается в application layer через `ExecutionLinker`. Это позволяет:
- Обогащать Fill рыночным контекстом
- Не создавать жёстких зависимостей между доменными сущностями
