# Fill Entity

## Что такое Fill

`Fill` — запись об исполнении нашего конкретного ордера на торговой площадке. Представляет факт того, что наш ордер был (частично) исполнен.

Используется для:

- Расчёта позиций (position tracking)
- Расчёта PnL
- Учёта комиссий
- Аллокации по стратегиям

## Чем Fill НЕ является

Fill **НЕ** является рыночным принтом (market tape). Для аналитики рынка используется `Trade`.

## Пакет

```
packages/domain/entities/fill/
```

Экспортируется как `@polymarket/fill` (только для внутреннего использования через project references).

## Структура

```
src/
  Fill.ts                      # Основная сущность
  FillSnapshot.ts              # Плоское DTO для хранения
  index.ts
  value-objects/
    Liquidity.ts               # 'MAKER' | 'TAKER'
  mappers/
    FillMapper.ts              # fromPolymarketOrderExecutionEvent, toSnapshot, fromSnapshot
```

## Интерфейс FillParams

```typescript
interface FillParams {
  readonly id: FillId;              // Уникальный ID исполнения
  readonly orderId: OrderId;        // ID ордера — ОБЯЗАТЕЛЕН
  readonly accountId: AccountId;    // ID аккаунта
  readonly venueId: VenueId;        // Биржа (POLYMARKET)
  readonly marketId: string;        // ID рынка
  readonly tokenId: AssetId;        // ID outcome токена
  readonly price: Price;            // Цена исполнения
  readonly size: Quantity;          // Объём исполнения
  readonly side: Side;              // BUY | SELL
  readonly timestamp: Timestamp;    // Время исполнения
  readonly fee: Fee;                // Комиссия (>= 0)
  readonly liquidity?: Liquidity;   // MAKER | TAKER — опционально
  readonly venueTradeId?: VenueTradeId;  // Связка с Trade — опционально
}
```

### Ключевое свойство: orderId обязателен

`orderId` в Fill всегда обязателен. Нет orderId — нет Fill. Это фундаментальное отличие от старой модели (где Trade.orderId мог быть `undefined`).

## Инварианты

`Fill.create()` проверяет:

1. `id` не пустой
2. `orderId` обязателен и не пустой
3. `accountId` не пустой
4. `venueId` не пустой
5. `marketId` не пустая строка
6. `tokenId` присутствует
7. `size > 0`
8. `price > 0`
9. `timestamp` присутствует
10. `fee` присутствует (`fee.amount >= 0` гарантируется инвариантом Fee VO)

## Методы

```typescript
// Вычисления
getNotional(): Decimal    // price × size

// Предикаты
isBuy(): boolean          // side === 'BUY'
isSell(): boolean         // side === 'SELL'
isMaker(): boolean        // liquidity === 'MAKER'
isTaker(): boolean        // liquidity === 'TAKER'
hasFee(): boolean         // fee.amount > 0

// Сериализация
toSnapshot(): FillSnapshot
toString(): string
```

## Liquidity Value Object

```typescript
export type Liquidity = 'MAKER' | 'TAKER';
export const ALL_LIQUIDITY: readonly Liquidity[] = ['MAKER', 'TAKER'];
export function isValidLiquidity(v: unknown): v is Liquidity;
```

Опциональное поле: не всегда известно из API (неизвестное значение → `undefined`).

## FillMapper

### fromPolymarketOrderExecutionEvent

Парсит событие исполнения ордера Polymarket:

```typescript
// Входной формат:
{
  fill_id: string,             // ID исполнения
  order_id: string,            // ID ордера
  account_id: string,          // wallet:0x...
  market: string,              // market ID
  asset_id: string,            // JSON-сериализованный AssetId
  price: string,               // цена
  size: string,                // объём
  side: string,                // 'BUY' | 'SELL'
  timestamp: string,           // unix timestamp в секундах
  fee_amount: string,          // размер комиссии
  liquidity?: string,          // 'MAKER' | 'TAKER' | другое
  transaction_hash?: string    // хэш транзакции
}
```

### toSnapshot / fromSnapshot

Round-trip сериализация через `FillSnapshot` (плоские примитивы).

## Пример использования

```typescript
import { FillMapper } from '@polymarket/fill';

const result = FillMapper.fromPolymarketOrderExecutionEvent({
  fill_id: 'fill-123',
  order_id: 'order-456',
  account_id: 'wallet:0x1234...',
  market: '0xmarket123',
  asset_id: JSON.stringify({ type: 'OUTCOME_TOKEN', ... }),
  price: '0.65',
  size: '50',
  side: 'BUY',
  timestamp: '1700000000',
  fee_amount: '0.01',
  liquidity: 'MAKER',
  transaction_hash: '0xabc...'
});

if (result.ok) {
  const fill = result.value;
  console.log(fill.getNotional().toNumber()); // 32.5
  console.log(fill.isMaker()); // true
  console.log(fill.hasFee()); // true
}
```

## Связь с Order

Fill применяется к Order через `Order.applyFill(fill: FillForOrder)`.

```
Order.applyFill(fill) → FILL_APPLIED → OrderFSM → handleFillApplied
  → OrderFill.addFill() → обновить filledSize + averagePrice
  → обновить OrderStatus (PARTIALLY_FILLED | FILLED)
```

## Связь с Trade

Fill может опционально ссылаться на Trade через `venueTradeId`:

```
Fill.venueTradeId?: VenueTradeId → Trade.id
```

Связка устанавливается в application layer через `ExecutionLinker`. Fill является **источником истины** для расчётов позиций — Trade лишь предоставляет рыночный контекст.
