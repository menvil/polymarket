# Fill Entity

## Что такое Fill

`Fill` — запись об исполнении нашего конкретного ордера на торговой площадке. Представляет факт того, что наш ордер был (частично) исполнен.

Используется для:

- Расчёта позиций (position tracking)
- Расчёта PnL
- Учёта комиссий
- Входной записи для Ledger layer

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
  Fill.ts                      # Основная сущность (Domain Record)
  FillSnapshot.ts              # Плоское DTO для хранения
  AssetDelta.ts                # Тип для знаковых изменений баланса
  ExecutionMetadata.ts         # Инфраструктурные метаданные
  index.ts
  value-objects/
    Liquidity.ts               # 'MAKER' | 'TAKER'
  mappers/
    FillMapper.ts              # fromPolymarketTradeEvent, toSnapshot, fromSnapshot
```

## Интерфейс FillParams

```typescript
interface FillParams {
  readonly id: FillId;                  // Уникальный ID исполнения (UUID из трейд-события)
  readonly orderId: OrderId;            // ID ордера — ОБЯЗАТЕЛЕН
  readonly accountId: AccountId;        // ID аккаунта
  readonly venueId: VenueId;            // Биржа (POLYMARKET)
  readonly marketId: string;            // ID рынка
  readonly tokenId: AssetId;            // ID outcome токена
  readonly settlementAssetId: AssetId;  // Расчётная валюта (USDC для Polymarket)
  readonly price: Price;                // Цена исполнения
  readonly size: Quantity;              // Объём исполнения
  readonly side: Side;                  // BUY | SELL
  readonly timestamp: Timestamp;        // Время исполнения
  readonly fee: Fee;                    // Комиссия (>= 0)
}
```

### Ключевые свойства

- `orderId` всегда обязателен. Нет orderId — нет Fill.
- `settlementAssetId` определяет расчётную валюту (USDC для Polymarket).
- `liquidity` и `venueTradeId` — инфраструктурные метаданные, вынесены в `ExecutionMetadata`.

## Инварианты

`Fill.create()` проверяет:

1. `marketId` не пустая строка
2. `size > 0`
3. Если fee ненулевая — `fee.asset === settlementAssetId` (fee в расчётной валюте)

Остальные поля валидируются своими типами (branded types + Value Objects).

## Методы — экономические расчёты

```typescript
// Signed изменения баланса (AssetDelta = { asset: AssetId; amount: Decimal })
getSignedQuantity(): AssetDelta   // { asset: tokenId, amount: ±size }   токен
getCashFlow(): AssetDelta         // { asset: USDC, amount: ∓(price×size) }
getFeeFlow(): AssetDelta          // { asset: USDC, amount: -feeAmount }
getNetCashFlow(): AssetDelta      // { asset: USDC, amount: cashFlow + feeFlow }

// Неотрицательная стоимость (AssetQuantity)
getNotional(): AssetQuantity      // { asset: USDC, amount: price×size }

// Предикаты
isBuy(): boolean                  // side === 'BUY'
isSell(): boolean                 // side === 'SELL'
hasFee(): boolean                 // fee.amount > 0
```

## AssetDelta

```typescript
interface AssetDelta {
  readonly asset: AssetId;
  readonly amount: Decimal;  // знаковый: + кредит, − дебет
}
```

Используется для расчётов в Ledger layer.

## ExecutionMetadata

```typescript
interface ExecutionMetadata {
  readonly venueTradeId?: VenueTradeId;  // хэш транзакции → сшивка с Trade
  readonly liquidity?: Liquidity;        // MAKER | TAKER
  readonly tradeStatus?: TradeStatus;    // MATCHED | MINED | CONFIRMED | RETRYING | FAILED
}
```

Содержит инфраструктурные данные, не влияющие на доменную экономику Fill.

## Liquidity Value Object

```typescript
export type Liquidity = 'MAKER' | 'TAKER';
export const ALL_LIQUIDITY: readonly Liquidity[] = ['MAKER', 'TAKER'];
export function isValidLiquidity(v: unknown): v is Liquidity;
```

## FillMapper

### fromPolymarketTradeEvent

Парсит trade событие из Polymarket user-channel WebSocket:

```typescript
FillMapper.fromPolymarketTradeEvent(
  raw: Record<string, unknown>,
  accountId: AccountId          // из сессионного контекста, не из события
): Result<{ fill: Fill; metadata: ExecutionMetadata }, ValidationError>
```

**Формат входного события** (Polymarket user-channel):
```json
{
  "id": "28c4d2eb-bbea-40e7-a9f0-b2fdb56b2c2e",
  "taker_order_id": "0x06bc63...",
  "market": "0xbd31dc8a...",
  "asset_id": "OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0x...:YES",
  "side": "BUY",
  "size": "10",
  "price": "0.57",
  "fee_rate_bps": "20",
  "status": "MATCHED",
  "owner": "9180014b-...",
  "timestamp": "1672290701",
  "trader_side": "TAKER",
  "transaction_hash": "0xabcdef...",
  "maker_orders": [{ "order_id": "0xff...", "matched_amount": "10", "price": "0.57", "owner": "uuid" }]
}
```

**Логика TAKER vs MAKER:**

| Поле | TAKER | MAKER |
|------|-------|-------|
| `orderId` | `taker_order_id` | `maker_orders[n].order_id` (по owner UUID) |
| `side` | `side` | инвертированный `side` |
| `size` | `size` | `maker_orders[n].matched_amount` |
| `price` | `price` | `maker_orders[n].price` |

**Расчёт комиссии:**
```
fee_amount = price × size × fee_rate_bps / 10000
```

**Маппинг в ExecutionMetadata:**
- `trader_side` → `liquidity` ('MAKER' | 'TAKER')
- `status` → `tradeStatus` ('MATCHED' | 'MINED' | 'CONFIRMED' | 'RETRYING' | 'FAILED')
- `transaction_hash` → `venueTradeId`

### toSnapshot / fromSnapshot

Round-trip сериализация через `FillSnapshot` (плоские примитивы).
`tradeStatus` сохраняется в снапшоте и восстанавливается.

## Пример использования

```typescript
import { FillMapper } from '@polymarket/fill';
import { parseAccountId } from '@polymarket/ids';

const accountId = parseAccountId('wallet:0x1234...')!;

const result = FillMapper.fromPolymarketTradeEvent({
  id: '28c4d2eb-bbea-40e7-a9f0-b2fdb56b2c2e',
  taker_order_id: '0x06bc63...',
  market: '0xbd31dc8a...',
  asset_id: 'OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0x...:YES',
  price: '0.65',
  size: '50',
  side: 'BUY',
  fee_rate_bps: '20',
  status: 'MATCHED',
  timestamp: '1700000000',
  trader_side: 'TAKER',
  transaction_hash: '0xabc...',
}, accountId);

if (result.ok) {
  const { fill, metadata } = result.value;
  console.log(fill.getCashFlow().amount.toNumber()); // -32.5
  console.log(fill.hasFee());                        // true (0.65*50*20/10000 = 0.065)
  console.log(metadata.liquidity);                   // 'TAKER'
  console.log(metadata.tradeStatus);                 // 'MATCHED'
}
```

## Связь с Ledger

Fill → `FillLedgerAdapter.toLedgerEntries(fill)` → `LedgerEntry[]` → `Ledger`

```
BUY без комиссии → 2 записи: POSITION_DELTA (+token), CASH_DELTA (-USDC)
BUY с комиссией  → 3 записи: POSITION_DELTA (+token), CASH_DELTA (-USDC), FEE_DEBIT (-USDC)
```

## Связь с Order

Fill применяется к Order через `Order.applyFill(fill: FillForOrder)`.

```
Order.applyFill(fill) → FILL_APPLIED → обновить filledSize + averagePrice
  → обновить OrderStatus (PARTIALLY_FILLED | FILLED)
```

## Связь с Trade

Fill может опционально ссылаться на Trade через `ExecutionMetadata.venueTradeId`:

```
metadata.venueTradeId → Trade.id (рыночный принт)
```

Связка устанавливается в application layer через `ExecutionLinker`. Fill является **источником истины** для расчётов позиций — Trade лишь предоставляет рыночный контекст.
