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
    TradeMapper.ts  # fromPolymarketLastTradeEvent, fromParsedTrade, toSnapshot, fromSnapshot
```

## Интерфейс TradeParams

```typescript
interface TradeParams {
  readonly id: VenueTradeId;       // Уникальный ID на venue
  readonly venueId: VenueId;       // Биржа (POLYMARKET)
  readonly marketId: string;       // ID рынка
  readonly tokenId: AssetId;       // ID outcome токена
  readonly price: OutcomePrice;           // Цена сделки
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
- `{market}_{assetId}_{timestamp}_{price}_{size}` если нет (composite key — price/size
  добавлены для снижения вероятности коллизий одновременных трейдов)

Генерация `VenueTradeId` и `venueId` вынесена в общие приватные хелперы
(`_buildVenueTradeId`, `_buildPolymarketVenueId`) — переиспользуются `fromParsedTrade`
(см. ниже), формула не дублируется между методами.

### fromParsedTrade (Этап 2 плана миграции)

Строит `Trade` из уже распакованных VO — точка врезки для `MarketDataStore`'s
обработчика `TRADE_RECEIVED` (`@polymarket/market-state`), который получает
`TradeReceivedEvent` из `@polymarket/event-bus` с уже готовыми
`instrumentId`/`price`/`size`/`side`/`timestamp`. В отличие от
`fromPolymarketLastTradeEvent` (парсит сырые JSON-строки, защищается от
произвольного untyped-входа), этот метод принимает VO напрямую — сериализовать их
обратно в строки ради повторного парсинга было бы архитектурно задом наперёд.

```typescript
import { TradeMapper } from '@polymarket/trade';

const result = TradeMapper.fromParsedTrade({
  instrumentId: event.instrumentId,   // InstrumentId (branded)
  marketId: '0xb9ed6ed97ce9146ef1a01278d5fc0f8bd04050a69f0a5568a66075b3c0c6b2c3',
  price: event.price,                 // OutcomePrice VO
  size: event.size,                   // Quantity VO
  side: event.side,                   // Side ('BUY' | 'SELL')
  timestamp: event.timestamp,         // Timestamp VO
});

if (result.ok) {
  const trade = result.value;
}
```

`instrumentId` парсится в `tokenId: AssetId` через `parseAssetId()` — для сырого
numeric CTF token ID (формат Polymarket `asset_id`) даёт вариант
`POLYMARKET_CTF_TOKEN`. `price`/`size` — уже валидные VO-инстансы (VO-конструктор
не даёт создать невалидный экземпляр), повторная проверка положительности здесь не
нужна.

`transaction_hash` недоступен нигде в цепочке поставки данных для `TRADE_RECEIVED`
(ни в live WS DTO, ни в backtest replay) — `VenueTradeId` в этом методе **всегда**
строится по composite-формуле, ветка с txHash недостижима на практике.

**Индексация построенных Trade**: `MarketDataStore` пишет каждый успешно
построенный `Trade` в `TradeIndexCollector` (`@polymarket/market-state`) — индекс
по `VenueTradeId`, backed by `RollingWindow<Trade>`. Единый источник рыночных
Trade для будущего `ExecutionLinker` (Этап 7). Если `MarketDataStore` ещё не знает
`marketId` для инструмента (нет предшествующего `BOOK_UPDATED`/`BOOK_DEPTH`) —
`Trade` для этого события не строится вообще (лог + пропуск), мэппер не вызывается
с пустым `marketId`.

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
  console.log(trade.getNotional().toNumber()); // ≈3.4589 (0.44 × 7.861135)
  console.log(trade.isBuy()); // true
}
```

## Связь с Fill

`Fill` может опционально ссылаться на Trade через `venueTradeId`:

```
Fill.venueTradeId?: VenueTradeId → Trade.id
```

Связка устанавливается в application layer через `ExecutionLinker` (Этап 7 плана
миграции, ещё не построен). Это позволяет:

- Обогащать Fill рыночным контекстом
- Не создавать жёстких зависимостей между доменными сущностями

### ⚠️ Известное ограничение: пространства значений Trade.id и Fill.venueTradeId не пересекаются

`transaction_hash` недоступен нигде в реальной цепочке поставки данных Polymarket —
ни для `Trade` (`fromParsedTrade`/`fromPolymarketLastTradeEvent`, см. выше), ни для
`Fill` (`FillMapper.ts`: `venueTradeId` устанавливается как bare `transaction_hash`
из `raw['transaction_hash']` либо `undefined` — **без composite-фолбэка**, в отличие
от `Trade.id`).

Следствие: для реального трафика `Trade.id` **всегда** составной ключ
(`marketId_assetId_ts_price_size`), а `Fill.venueTradeId` — **всегда** либо bare
хэш транзакции, либо `undefined`. Точный lookup `Trade` по `Fill.venueTradeId`
(`Map<VenueTradeId, Trade>.get(fill.venueTradeId)`) **структурно никогда не
совпадёт** для реальных данных — это не "иногда не находит, потому что рыночный
Trade ещё не долетел до public tape" (это ожидаемо и не проблема сама по себе), а
гарантированное несовпадение всегда, независимо от тайминга.

Это не баг, внесённый Этапом 2 — существующее свойство уже смёрженного
`TradeMapper`/`FillMapper` кода, которое Этап 2 впервые делает не-inert (до этого
оба маппера были мёртвым кодом, друг с другом не взаимодействовавшим). Будущий
`ExecutionLinker` (Этап 7) должен с самого начала проектировать fuzzy/windowed
matching (`tokenId` + price + size + временное окно), а не точный lookup по ключу —
иначе связка Fill↔Trade не сработает никогда для реального трафика.
