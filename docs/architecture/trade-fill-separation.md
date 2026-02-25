# Разделение Trade и Fill

## Проблема

Исторически в системе существовал один тип `Trade`, который смешивал две принципиально разные концепции:

1. **Рыночный принт** — факт того, что на рынке прошла сделка
2. **Исполнение нашего ордера** — факт того, что наш конкретный ордер был (частично) исполнен

Это приводило к:
- `orderId?: string` — поле стало опциональным, хотя для исполнения оно обязательно
- Смешение полей: `fee`, `reasonCode`, `metadata` (наши поля) рядом с рыночными данными
- `fromValue()` / `fromJSON()` — парсинг внешнего API прямо в entity
- `fee: Money.zero('USDC')` — валюта захардкожена

## Решение: Разделение на два чистых типа

### Trade (рыночный принт)

```
packages/domain/entities/trade/
```

**Для:** аналитики рынка, VWAP, pressure, сигналы.

**Ключевые поля:**
- `id: VenueTradeId` — ID на venue
- `venueId, marketId, tokenId` — идентификаторы рынка
- `price, size, aggressorSide?` — параметры сделки
- `txHash?` — хэш транзакции

**НЕТ:** `orderId`, `fee`, `reasonCode`, `metadata`

### Fill (исполнение нашего ордера)

```
packages/domain/entities/fill/
```

**Для:** позиций, PnL, комиссий, аллокации по стратегиям.

**Ключевые поля:**
- `id: FillId` — ID исполнения
- `orderId: OrderId` — **ОБЯЗАТЕЛЕН**, нет orderId — нет Fill
- `accountId, venueId, marketId, tokenId` — идентификаторы
- `price, size, side` — параметры исполнения
- `fee: Fee` — комиссия (asset-aware)
- `liquidity?: Liquidity` — MAKER | TAKER
- `venueTradeId?: VenueTradeId` — опциональная связка с Trade

## Правило: Fill как источник истины

**Fill является источником истины** для расчётов:
- Позиции рассчитываются из Fill, не из Trade
- PnL рассчитывается из Fill, не из Trade
- Комиссии учитываются через Fill.fee

Trade предоставляет рыночный контекст (например, средневзвешенную цену рынка в момент исполнения) через опциональную связку.

## Связка Trade ↔ Fill

```
Fill.venueTradeId?: VenueTradeId → Trade.id
```

Это **опциональная** связка, устанавливаемая в application layer:

```
domain/     Fill (orderId обязателен)
            Trade (нет orderId)

application/ ExecutionLinker.linkFillToTrade(fill, trades)
             → устанавливает fill.venueTradeId
```

Такая архитектура позволяет:
- Обрабатывать Fill даже когда Trade ещё не получен (latency)
- Не создавать жёстких зависимостей между доменными пакетами
- Fill может существовать без соответствующего Trade

## Влияние на Order entity

Order больше не знает о Trade. Вместо `applyTrade()` используется `applyFill()`:

```typescript
// Было:
order.applyTrade(trade);  // trade.orderId?: string

// Стало:
order.applyFill(fill);    // fill.orderId обязателен — явная проверка
```

Это улучшает инварианты:
- **Раньше:** `if (trade.orderId !== undefined && trade.orderId !== order.id)` — FIFO-like логика
- **Теперь:** `if (fill.orderId !== order.id)` — всегда проверяем

## Диаграмма зависимостей

```
foundation/ids:
  FillId, OrderId, VenueTradeId, TxHash

domain/entities/fill:
  Fill (FillId, orderId: OrderId, venueTradeId?: VenueTradeId)
  FillMapper

domain/entities/trade:
  Trade (id: VenueTradeId, txHash?: TxHash)
  TradeMapper

domain/entities/order:
  Order (applyFill: FillForOrder)
  OrderChange (FILL_APPLIED)
  OrderFill (addFill, getFillIds, hasFill)

application/:
  ExecutionLinker (linkFillToTrade)
```

## Фазы реализации

| Фаза | Описание | Статус |
|------|----------|--------|
| 0 | VenueTradeId, TxHash в @polymarket/ids | ✅ |
| 1 | @polymarket/trade entity | ✅ |
| 2 | @polymarket/fill entity | ✅ |
| 3 | Order entity: applyTrade → applyFill | ✅ |
| 4 | Документация | ✅ |
