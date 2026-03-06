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
7. `timestamp` присутствует (числовая валидация делегирована `Timestamp` VO / `TimestampService`)

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
// Реальный пример события last_trade_price из Polymarket API:
{
  market: "0xb9ed6ed97ce9146ef1a01278d5fc0f8bd04050a69f0a5568a66075b3c0c6b2c3",
  asset_id: "62305814799875783974460176688386847666394972778903073967664089920408777315323",
  price: "0.44",
  size: "7.861135",
  fee_rate_bps: "0",
  side: "BUY",
  timestamp: "1767463212903",
  event_type: "last_trade_price",
  transaction_hash: "0x989369fbc370b9384be69c36876e25170f25d87a83ef1413cbf7ca6913533f21"
}
```

**asset_id**: числовой CTF token ID из Polymarket API (большое целое число в виде строки).
Маппер создаёт `AssetId` типа `POLYMARKET_CTF_TOKEN`.

**timestamp**: API Polymarket может возвращать как секунды (10 цифр), так и миллисекунды (13 цифр).
Маппер автоматически определяет формат: если значение < 1e12 — считает секундами и умножает × 1000.

**Защита от невалидного raw**: если `raw` не является объектом (null, массив, примитив) — возвращает `Err`.

VenueTradeId генерируется как:
- `{txHash}_{timestamp}` если есть transaction_hash
- `{market}_{assetId}_{timestamp}` если нет

### toSnapshot / fromSnapshot

Round-trip сериализация через `TradeSnapshot` (плоские примитивы):

```typescript
interface TradeSnapshot {
  id: string;
  venueId: string;
  marketId: string;
  tokenId: string;
  price: number;        // Decimal.toNumber() — возможна потеря точности (IEEE 754)
  size: number;         // Decimal.toNumber() — возможна потеря точности (IEEE 754)
  aggressorSide?: 'BUY' | 'SELL';
  timestampMs: number;
  txHash?: string;
}
```

> **Точность**: поля `price` и `size` сериализуются через `Decimal.toNumber()`.
> Для значений в диапазоне Polymarket (price ∈ [0.0001, 0.9999], size — разумные объёмы) потери на практике нет,
> но для экстремальных дробных значений возможна погрешность IEEE 754 double.

## Пример использования

```typescript
import { TradeMapper } from '@polymarket/trade';

// asset_id — числовой CTF token ID из Polymarket API
// timestamp — миллисекунды (маппер поддерживает и секунды, и мс: автоопределение по порогу 1e12)
const result = TradeMapper.fromPolymarketLastTradeEvent({
  market: '0xb9ed6ed97ce9146ef1a01278d5fc0f8bd04050a69f0a5568a66075b3c0c6b2c3',
  asset_id: '62305814799875783974460176688386847666394972778903073967664089920408777315323',
  price: '0.44',
  size: '7.861135',
  side: 'BUY',
  timestamp: '1767463212903',
  transaction_hash: '0x989369fbc370b9384be69c36876e25170f25d87a83ef1413cbf7ca6913533f21'
});

if (result.ok) {
  const trade = result.value;
  console.log(trade.getNotional().toNumber()); // 3.46 (0.44 × 7.861135)
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
