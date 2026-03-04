# Order — самодостаточный агрегат заявки

## Что такое Order

`Order` — неизменяемая доменная сущность, представляющая торговую заявку в системе предсказательных рынков Polymarket.

Пакет: `packages/domain/entities/order/`

**Самодостаточный модуль** — вся бизнес-логика заявки сосредоточена в одной папке, без зависимостей от других domain entities.

## Структура пакета

```
src/
├── Order.ts          — агрегат (все фабрики + команды + геттеры)
├── OrderState.ts     — типы (OrderStatus, FillState, FillData, OrderSnapshot, ...)
├── OrderEvents.ts    — domain events для режима replay
├── OrderErrors.ts    — OrderError
├── _fill.ts          — арифметика fills (приватный модуль)
├── index.ts          — публичный API
└── view/
    ├── OrderViewModel.ts     — сериализация для API/логирования
    ├── OrderDeserializer.ts  — десериализация из снэпшота
    └── index.ts
```

## Жизненный цикл

```
              accept()                applyFill()
  PENDING ──────────────► OPEN ◄──────────────────────────────┐
     │                     │                                  │
     │ reject()            │ applyFill()      applyFill()     │
     ▼                     ▼                  (partial)       │
  REJECTED          PARTIALLY_FILLED ─────────────────────────┘
                          │
             cancel() / expire()
              ▼            ▼
          CANCELED       EXPIRED

  Терминальные: FILLED, CANCELED, REJECTED, EXPIRED
  Fillable:     OPEN, PARTIALLY_FILLED
```

### Возможные переходы

| Из                      | Команда          | В                            |
|-------------------------|------------------|------------------------------|
| PENDING                 | accept()         | OPEN                         |
| PENDING                 | reject(reason)   | REJECTED                     |
| OPEN                    | applyFill(fill)  | PARTIALLY_FILLED или FILLED  |
| OPEN / PARTIALLY_FILLED | cancel(reason?)  | CANCELED                     |
| OPEN / PARTIALLY_FILLED | expire()         | EXPIRED                      |
| PARTIALLY_FILLED        | applyFill(fill)  | PARTIALLY_FILLED или FILLED  |

## Три режима использования

### 1. Нормальный поток (create + commands)

```typescript
// Создание — всегда PENDING
const result = Order.create({
  id: asOrderId('order-1')!,
  asset: myAsset,
  side: 'BUY',
  price: Price.of(new Decimal('0.65')),
  size: Quantity.of(new Decimal('100')),
  timestamp: Timestamp.now(),
});

if (result.ok) {
  const pending = result.value;

  // Биржа приняла
  const open = pending.accept(); // Result<Order, OrderError>

  // Исполнение
  const filled = open.value!.applyFill({
    id: fillId, orderId: pending.id, asset, side: 'BUY',
    size: Quantity.of(new Decimal('100')),
    price: Price.of(new Decimal('0.65')),
  });
}
```

### 2. Воспроизведение из лога событий (replay)

```typescript
const order = Order.fromEvents([
  { type: 'ORDER_CREATED', orderId, asset, side: 'BUY', price, size, timestamp },
  { type: 'ORDER_ACCEPTED', orderId },
  { type: 'FILL_APPLIED', orderId, fill: fillData },
]);

// order.status === 'FILLED'
```

### 3. Восстановление из снэпшота (reconciliation)

```typescript
const result = Order.fromSnapshot({
  id: 'order-1',
  asset: 'POLYMARKET_CTF:POLYGON:0xabc...:YES',
  side: 'BUY',
  price: 0.65,
  size: 100,
  status: 'PARTIALLY_FILLED',
  timestamp: '2024-01-01T00:00:00.000Z',
  filledSize: 60,
  averagePrice: 0.63,
  fillIds: ['fill-1', 'fill-2'],
});
```

## Публичный API

### Геттеры (identity)

| Геттер       | Тип              | Описание               |
|--------------|------------------|------------------------|
| `id`         | `OrderId`        | ID заявки              |
| `asset`      | `AssetId`        | Торгуемый актив        |
| `side`       | `'BUY' \| 'SELL'`| Сторона                |
| `price`      | `Price`          | Лимитная цена          |
| `size`       | `Quantity`       | Полный размер          |
| `status`     | `OrderStatus`    | Текущий статус         |
| `timestamp`  | `Timestamp`      | Время создания         |
| `reason`     | `string?`        | Причина отклонения     |
| `strategyId` | `string?`        | ID стратегии           |

### Геттеры (fill state)

| Геттер         | Тип                | Описание                  |
|----------------|--------------------|---------------------------|
| `filledSize`   | `Quantity`         | Исполненный объём         |
| `averagePrice` | `Price \| undefined`| VWAP, undefined если нет fills |
| `fillIds`      | `readonly FillId[]`| Список ID fills           |
| `tradeCount`   | `number`           | Количество fills          |

### Вычисляемые геттеры

| Геттер          | Тип       | Описание                     |
|-----------------|-----------|------------------------------|
| `remainingSize` | `Quantity`| size - filledSize            |
| `fillPercentage`| `Decimal` | filledSize / size × 100      |
| `notional`      | `Decimal` | price × size                 |
| `isTerminal`    | `boolean` | статус в TERMINAL_STATUSES   |
| `isFillable`    | `boolean` | статус в FILLABLE_STATUSES   |

### Предикаты

```typescript
order.isPending()        // status === 'PENDING'
order.isOpen()           // status === 'OPEN'
order.isFilled()         // status === 'FILLED'
order.isPartiallyFilled()// status === 'PARTIALLY_FILLED'
order.canCancel()        // OPEN || PARTIALLY_FILLED
order.canModify()        // не терминальный
```

### Команды (возвращают Result<Order, OrderError>)

```typescript
order.accept()                    // PENDING → OPEN
order.reject('reason')            // PENDING → REJECTED
order.cancel('reason?')           // OPEN|PARTIAL → CANCELED
order.expire()                    // OPEN|PARTIAL → EXPIRED
order.applyFill(fill: FillData)   // OPEN|PARTIAL → PARTIAL|FILLED
order.canAcceptFill(fill: FillData) // boolean (без применения)
```

### Сериализация

```typescript
order.toSnapshot(): OrderSnapshot  // плоский объект с примитивами
order.toString(): string           // "Order[id]: SIDE SIZE @ PRICE (STATUS)"
```

## Модуль _fill.ts (приватный)

Содержит арифметику fills. **Не экспортируется из index.ts.**

- `emptyFill()` — начальное состояние (filledSize=0, no VWAP)
- `addFill(state, fill, orderSize)` — добавить исполнение с валидацией
- `isFull(state, orderSize)` — заявка полностью исполнена
- `_vwap(...)` — взвешенная средняя цена (VWAP)

### Алгоритм VWAP

```
VWAP = (currentSize × currentAvg + newSize × newPrice) / (currentSize + newSize)
```

При первом fill: `VWAP = newPrice` (нет предыдущего среднего).

## Инварианты

1. **Создание всегда PENDING** — `create()` не принимает статус
2. **Неизменяемость** — все команды возвращают новый экземпляр
3. **Never Throw** — команды возвращают `Result<Order, OrderError>`, не бросают
4. **Fill dedup** — повторный fillId → ошибка
5. **Fill overflow** — fillSize > remainingSize → ошибка
6. **Terminal lock** — команды над терминальными статусами → ошибка

## Тестовое покрытие

| Файл                      | Тесты | Описание                          |
|---------------------------|-------|-----------------------------------|
| `unit/Order.test.ts`      | ~60   | create, fromSnapshot, fromEvents, FSM, computed |
| `unit/view/OrderView.test.ts` | ~35 | ViewModel, Deserializer, round-trip |
| `integration/OrderLifecycle.test.ts` | ~22 | End-to-end сценарии, VWAP, replay |

**Итого: 117 тестов**
