# Application Layer - Use Cases

## Обзор

**Application Layer** координирует выполнение бизнес-операций, используя доменные объекты и внешние сервисы. Следует паттернам **CQRS** (Command Query Responsibility Segregation) и **Dependency Injection**.

```
┌─────────────────────────────────────────┐
│         Application Layer               │
│                                         │
│  ┌─────────────┐      ┌──────────────┐ │
│  │  Commands   │      │   Queries    │ │
│  │  (Write)    │      │   (Read)     │ │
│  └──────┬──────┘      └──────┬───────┘ │
│         │                    │         │
│    ┌────▼────────────────────▼────┐    │
│    │       Handlers               │    │
│    │  (Business Orchestration)    │    │
│    └────┬────────────────────┬────┘    │
│         │                    │         │
└─────────┼────────────────────┼─────────┘
          │                    │
     ┌────▼────────┐      ┌────▼─────────┐
     │   Domain    │      │ Infrastructure│
     │  (Entities) │      │   (Adapters)  │
     └─────────────┘      └───────────────┘
```

---

## CQRS Pattern

### Commands (Изменение состояния)

**Характеристики:**
- ✅ Изменяют состояние системы
- ✅ Возвращают результат операции (DTO)
- ✅ Могут вызывать внешние API
- ✅ Могут быть асинхронными

**Примеры:**
- `PlaceOrderCommand` - размещение ордера
- `CancelOrderCommand` - отмена ордера
- `ReconcilePortfolioCommand` - сверка портфеля с биржей

### Queries (Чтение данных)

**Характеристики:**
- ✅ Только читают данные
- ✅ Не изменяют состояние
- ✅ Могут кэшироваться
- ✅ Быстрые (без побочных эффектов)

**Примеры:**
- `GetPortfolioSnapshotQuery` - снапшот портфеля
- `GetRiskMetricsQuery` - метрики риска
- `GetOrderHistoryQuery` - история ордеров

---

## DTOs (Data Transfer Objects)

DTOs используются для передачи данных между слоями:

```typescript
// Domain Entity (с бизнес-логикой)
class Order {
  constructor(
    public readonly price: Price,  // Value Object
    public readonly size: Quantity // Value Object
  ) {}

  getNotional(): number {
    return this.price.value * this.size.value;
  }
}

// DTO (простой объект данных)
interface OrderDTO {
  price: number;      // примитив
  size: number;       // примитив
  notional: number;   // вычисленное значение
}
```

**Зачем нужны DTOs?**
1. **Сериализация**: Легко конвертируются в JSON для API
2. **Отделение слоёв**: Domain не утекает в API/UI
3. **Стабильный контракт**: API остаётся стабильным при изменении domain
4. **Производительность**: Можно выбрать только нужные поля

### OrderDTO

**Файл**: `src/application/dto/OrderDTO.ts`

```typescript
interface OrderDTO {
  id: string;
  marketId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  status: 'PENDING' | 'OPEN' | 'FILLED' | 'CANCELED' | 'REJECTED';
  filledSize?: number;
  averageFillPrice?: number;
  notional: number;           // вычисленное поле
  remainingSize: number;      // вычисленное поле
  fillPercentage: number;     // вычисленное поле
  timestamp: string;          // ISO date string
}
```

**Пример конвертации:**
```typescript
function toOrderDTO(order: Order): OrderDTO {
  return {
    id: order.id,
    marketId: order.tokenId,
    tokenId: order.tokenId,
    side: order.side,
    price: order.price.value,        // Value Object → primitive
    size: order.size.value,
    status: order.status,
    filledSize: order.filledSize?.value,
    averageFillPrice: order.averageFillPrice?.value,
    notional: order.getNotional(),   // вызываем метод
    remainingSize: order.getRemainingSize().value,
    fillPercentage: order.getFillPercentage(),
    timestamp: order.timestamp.toISOString(),
  };
}
```

### PositionDTO

**Файл**: `src/application/dto/PositionDTO.ts`

```typescript
interface PositionDTO {
  tokenId: string;
  side: 'YES' | 'NO';
  totalQuantity: number;
  averageEntryPrice: number;
  currentPrice?: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  costBasis: number;
  marketValue: number;
  lotCount: number;
  lots?: PositionLotDTO[];
}

interface PositionLotDTO {
  lotId: string;
  quantity: number;
  entryPrice: number;
  timestamp: string;
  costBasis: number;
  unrealizedPnL?: number;
}
```

### PortfolioDTO

**Файл**: `src/application/dto/PortfolioDTO.ts`

```typescript
interface PortfolioDTO {
  id: string;
  cash: number;
  reservedCash: number;
  availableCash: number;
  totalValue: number;
  totalUnrealizedPnL: number;
  totalUnrealizedPnLPercent: number;
  positionCount: number;
  positions: PositionDTO[];
  timestamp?: string;
}
```

---

## Commands

### 1. PlaceOrderCommand

**Назначение**: Размещение нового ордера на бирже.

**Файл**: `src/application/commands/PlaceOrderCommand.ts`

#### Command

```typescript
class PlaceOrderCommand {
  constructor(
    public readonly sessionId: string,
    public readonly marketId: string,
    public readonly tokenId: string,         // Полный token ID (YES или NO)
    public readonly side: 'BUY' | 'SELL',
    public readonly price: number,
    public readonly size: number
  ) {
    this.validate();
  }

  private validate(): void {
    if (!this.tokenId) {
      throw new Error('tokenId is required');
    }
    if (this.price <= 0 || this.price >= 1) {
      throw new Error('price must be between 0 and 1');
    }
    if (this.size <= 0) {
      throw new Error('size must be positive');
    }
  }
}
```

#### Handler

```typescript
class PlaceOrderHandler {
  constructor(
    private readonly orderRepository: IOrderRepository,
    private readonly exchangeAdapter: IExchangeAdapter,
    private readonly logger: ILogger,
    private readonly isSimulationMode: boolean = false
  ) {}

  async execute(command: PlaceOrderCommand): Promise<PlaceOrderResult> {
    // 1. Создаём Order entity
    const order = Order.create({
      id: `order-${command.tokenId}-${Date.now()}`,
      tokenId: command.tokenId,
      side: command.side,
      price: Price.fromNumber(command.price),
      size: Quantity.fromNumber(command.size),
      status: 'PENDING',
      timestamp: new Date(),
    });

    let finalOrder: Order;

    if (this.isSimulationMode) {
      // SIMULATION MODE: не отправляем на биржу
      finalOrder = order;
    } else {
      // LIVE MODE: отправляем на биржу
      finalOrder = await this.exchangeAdapter.placeOrder(order);
    }

    // 3. Сохраняем в репозиторий
    await this.orderRepository.save(finalOrder);

    // 4. Возвращаем результат
    return {
      order: finalOrder,
      dto: toOrderDTO(finalOrder),
      isSimulation: this.isSimulationMode,
    };
  }
}

interface PlaceOrderResult {
  order: Order;
  dto: OrderDTO;
  isSimulation: boolean;
}
```

#### Алгоритм

```
1. Валидация параметров команды
   └─ price in (0, 1)
   └─ size > 0

2. Создание Order entity
   └─ Генерация уникального ID
   └─ Конвертация примитивов в Value Objects
   └─ Валидация в конструкторе

3. Размещение на бирже
   └─ Вызов IExchangeAdapter.placeOrder()
   └─ Обновление статуса (PENDING → OPEN)
   └─ Получение биржевого ID

4. Сохранение в репозиторий
   └─ IOrderRepository.save()
   └─ Персистентность состояния

5. Возврат результата
   └─ Конвертация Order → OrderDTO
   └─ Возврат клиенту
```

#### Пример использования

```typescript
// Dependency Injection
const isSimulation = ConfigLoader.getInstance().isSimulationMode();
const handler = new PlaceOrderHandler(
  orderRepository,
  exchangeAdapter,
  logger,
  isSimulation
);

// Создание команды (с полным tokenId)
const command = new PlaceOrderCommand(
  'session-1',
  'market-123',
  '71321045551632615708317735895400923224842579209589653376822316449564082462848',
  'BUY',
  0.65,
  100
);

// Выполнение
try {
  const result = await handler.execute(command);
  console.log(`Order placed: ${result.order.id}`);
  console.log(`Simulation: ${result.isSimulation}`);
} catch (error) {
  if (error instanceof InsufficientFundsError) {
    console.error('Not enough cash');
  } else if (error instanceof ExchangeError) {
    console.error('Exchange API error:', error.message);
  }
}
```

---

### 2. CancelOrderCommand

**Назначение**: Отмена существующего ордера.

**Файл**: `src/application/commands/CancelOrderCommand.ts`

#### Command

```typescript
class CancelOrderCommand {
  constructor(
    public readonly sessionId: string,
    public readonly orderId: string
  ) {
    this.validate();
  }
}
```

#### Handler

```typescript
class CancelOrderHandler {
  constructor(
    private readonly orderRepository: IOrderRepository,
    private readonly exchangeAdapter: IExchangeAdapter,
    private readonly logger: ILogger,
    private readonly isSimulationMode: boolean = false
  ) {}

  async execute(command: CancelOrderCommand): Promise<void> {
    // 1. Находим ордер
    const order = await this.orderRepository.findById(command.orderId);
    if (!order) {
      throw new Error(`Order ${command.orderId} not found`);
    }

    // 2. Проверяем возможность отмены
    if (!order.canCancel()) {
      throw new Error(`Cannot cancel order with status ${order.status}`);
    }

    // 3. Отменяем на бирже (только в live mode)
    if (!this.isSimulationMode) {
      await this.exchangeAdapter.cancelOrder(command.orderId);
    }

    // 4. Обновляем статус
    const canceledOrder = order.withStatus('CANCELED');
    await this.orderRepository.update(canceledOrder);
  }
}
```

#### Алгоритм

```
1. Поиск ордера в репозитории
   └─ IOrderRepository.findById()
   └─ Ошибка если не найден

2. Валидация возможности отмены
   └─ order.canCancel()
   └─ Только PENDING/OPEN можно отменить

3. Отмена на бирже
   └─ IExchangeAdapter.cancelOrder()
   └─ Асинхронная операция

4. Обновление локального состояния
   └─ order.withStatus('CANCELED')
   └─ IOrderRepository.update()
```

---

### 3. ReconcilePortfolioCommand

**Назначение**: Сверка локального портфеля с состоянием на бирже.

**Файл**: `src/application/commands/ReconcilePortfolioCommand.ts`

#### Command

```typescript
class ReconcilePortfolioCommand {
  constructor(
    public readonly sessionId: string,
    public readonly autoCorrect: boolean = false
  ) {
    this.validate();
  }
}
```

#### Handler

```typescript
class ReconcilePortfolioHandler {
  constructor(
    private readonly orderRepository: IOrderRepository,
    private readonly exchangeAdapter: IExchangeAdapter,
    private readonly logger: ILogger
  ) {}

  async execute(
    command: ReconcilePortfolioCommand,
    session: TradingSession
  ): Promise<ReconcilePortfolioResult> {
    const discrepancies: Discrepancy[] = [];
    const reconciliationTime = new Date();

    // 1. Сверка баланса USDC
    const exchangeBalance = await this.exchangeAdapter.getBalance();
    const localCash = session.portfolio.cash.amount;
    const exchangeCash = exchangeBalance.amount;

    const cashDifference = Math.abs(exchangeCash - localCash);
    if (cashDifference > 0.01) {  // Порог: 0.01 USDC
      const cashDiscrepancy: Discrepancy = {
        type: 'CASH',
        field: 'cash',
        localValue: localCash,
        exchangeValue: exchangeCash,
        difference: exchangeCash - localCash,
        corrected: false,
      };

      if (command.autoCorrect) {
        session.portfolio = {
          ...session.portfolio,
          cash: Money.fromUSDC(exchangeCash),
        };
        cashDiscrepancy.corrected = true;
      }

      discrepancies.push(cashDiscrepancy);
    }

    // 2. Сверка позиций
    let positionsChecked = 0;
    for (const [tokenId, position] of session.portfolio.positions.entries()) {
      positionsChecked++;

      const [marketId, tokenType] = parseTokenId(tokenId);
      const exchangePosition = await this.exchangeAdapter.getPosition(
        marketId,
        tokenType
      );

      const localQuantity = position.totalQuantity.value;
      const exchangeQuantity = exchangePosition.value;

      const positionDifference = Math.abs(exchangeQuantity - localQuantity);
      if (positionDifference > 0.001) {  // Порог: 0.001 shares
        const positionDiscrepancy: Discrepancy = {
          type: 'POSITION',
          field: `position-${tokenId}`,
          localValue: localQuantity,
          exchangeValue: exchangeQuantity,
          difference: exchangeQuantity - localQuantity,
          corrected: false,
        };

        if (command.autoCorrect) {
          // В продакшн: создать adjustment lots
          // Обновить position через session.recordTrade()
        }

        discrepancies.push(positionDiscrepancy);
      }
    }

    // 3. Сверка ордеров
    const localOrders = await this.orderRepository.findByStatuses(['OPEN', 'PENDING']);
    let ordersChecked = localOrders.length;

    for (const order of localOrders) {
      // В продакшн: проверить статус ордера на бирже
      // Обнаружить fill'ы, которые не пришли через WebSocket
    }

    return {
      hasDiscrepancies: discrepancies.length > 0,
      discrepancies,
      reconciliationTime,
      localCash,
      exchangeCash,
      positionsChecked,
      ordersChecked,
    };
  }
}
```

#### Алгоритм

```
1. Сверка баланса
   └─ IExchangeAdapter.getBalance()
   └─ Сравнение с portfolio.cash
   └─ Если разница > 0.01 USDC:
      └─ Создать Discrepancy
      └─ Если autoCorrect = true:
         └─ Обновить portfolio.cash

2. Сверка позиций
   └─ Для каждой позиции в portfolio:
      └─ IExchangeAdapter.getPosition()
      └─ Сравнение quantity
      └─ Если разница > 0.001 shares:
         └─ Создать Discrepancy
         └─ Если autoCorrect = true:
            └─ Создать adjustment lots
            └─ Обновить position

3. Сверка ордеров
   └─ IOrderRepository.findByStatuses(['OPEN', 'PENDING'])
   └─ Для каждого ордера:
      └─ Проверить статус на бирже
      └─ Если статус отличается:
         └─ Создать Discrepancy
         └─ Если autoCorrect = true:
            └─ Обновить статус ордера

4. Возврат результата
   └─ ReconcilePortfolioResult с списком discrepancies
```

#### Типы расхождений

```typescript
export type DiscrepancyType = 'CASH' | 'POSITION' | 'ORDER';

export interface Discrepancy {
  type: DiscrepancyType;
  field: string;              // 'cash', 'position-token-123', 'order-0xabc'
  localValue: number;         // Локальное значение
  exchangeValue: number;      // Значение на бирже
  difference: number;         // exchange - local
  corrected: boolean;         // Исправлено ли автоматически
}
```

#### Пример использования

```typescript
// Dependency Injection
const handler = new ReconcilePortfolioHandler(
  orderRepository,
  exchangeAdapter,
  logger
);

// Только проверка, без исправления
const command1 = new ReconcilePortfolioCommand('session-1', false);
const result1 = await handler.execute(command1, tradingSession);

if (result1.hasDiscrepancies) {
  console.warn(`Found ${result1.discrepancies.length} discrepancies`);
  result1.discrepancies.forEach(d => {
    console.log(`${d.type} ${d.field}:`);
    console.log(`  Local: ${d.localValue}`);
    console.log(`  Exchange: ${d.exchangeValue}`);
    console.log(`  Difference: ${d.difference}`);
  });
} else {
  console.log('✓ Portfolio state matches exchange');
}

// Проверка и автоматическое исправление
const command2 = new ReconcilePortfolioCommand('session-1', true);
const result2 = await handler.execute(command2, tradingSession);

result2.discrepancies.forEach(d => {
  if (d.corrected) {
    console.log(`✓ Corrected ${d.type} ${d.field}`);
  } else {
    console.error(`✗ Failed to correct ${d.type} ${d.field}`);
  }
});
```

#### Когда запускать сверку

**Рекомендуемые сценарии:**

1. **Периодическая сверка** - каждые 5-10 минут
2. **После перезапуска бота** - восстановление состояния
3. **После обнаружения пропущенных событий** - WebSocket disconnect
4. **Перед критическими операциями** - перед риск-чеками
5. **После внешних операций** - пополнение/вывод средств

**autoCorrect = true** использовать только если:
- ✅ Расхождение небольшое (< 1% от портфеля)
- ✅ Известна причина расхождения
- ✅ Нет активных операций в момент сверки

**autoCorrect = false** использовать когда:
- ❌ Расхождение значительное
- ❌ Причина расхождения неизвестна
- ❌ Требуется ручное расследование

---

## Queries

### 1. GetPortfolioSnapshotQuery

**Назначение**: Получение текущего снапшота портфеля с P&L.

**Файл**: `src/application/queries/GetPortfolioSnapshotQuery.ts`

#### Query

```typescript
class GetPortfolioSnapshotQuery {
  constructor(
    public readonly sessionId: string,
    public readonly includePositionDetails: boolean = false
  ) {}
}
```

#### Handler

```typescript
class GetPortfolioSnapshotHandler {
  constructor(
    private readonly marketDataFeed: IMarketDataFeed,
    private readonly logger: ILogger
  ) {}

  async execute(
    query: GetPortfolioSnapshotQuery,
    session: TradingSession
  ): Promise<PortfolioDTO> {
    // 1. Получаем текущие цены для всех позиций
    const marketPrices = new Map<string, number>();
    
    for (const [tokenId] of session.portfolio.positions.entries()) {
      const orderbook = await this.marketDataFeed.getOrderbook(session.market.id);
      const midPrice = orderbook.getMidPrice();
      
      if (midPrice) {
        marketPrices.set(tokenId, midPrice.value);
      }
    }

    // 2. Конвертируем Portfolio → PortfolioDTO
    return toPortfolioDTO(session.portfolio, marketPrices);
  }
}
```

#### Алгоритм

```
1. Получение текущих рыночных цен
   └─ Для каждой позиции:
      └─ IMarketDataFeed.getOrderbook()
      └─ Вычисление midPrice
      └─ Сохранение в Map

2. Вычисление unrealized P&L
   └─ Для каждой позиции:
      └─ Position.calculateUnrealizedPnL(currentPrice)
      └─ Суммирование

3. Конвертация в DTO
   └─ toPortfolioDTO(portfolio, prices)
   └─ Вычисление агрегатов:
      └─ totalValue = cash + Σ(position values)
      └─ totalPnL = Σ(position P&Ls)

4. Возврат снапшота
```

#### Пример использования

```typescript
const handler = new GetPortfolioSnapshotHandler(marketDataFeed, logger);

const query = new GetPortfolioSnapshotQuery('session-1', true);
const snapshot = await handler.execute(query, session);

console.log(`Total Value: $${snapshot.totalValue.toFixed(2)}`);
console.log(`Unrealized P&L: $${snapshot.totalUnrealizedPnL.toFixed(2)}`);
console.log(`Positions: ${snapshot.positionCount}`);

snapshot.positions.forEach(pos => {
  console.log(`  ${pos.side} ${pos.totalQuantity} @ $${pos.averageEntryPrice}`);
  console.log(`    Current: $${pos.currentPrice}, P&L: $${pos.unrealizedPnL}`);
});
```

---

### 2. GetRiskMetricsQuery

**Назначение**: Получение метрик риска торговой сессии.

**Файл**: `src/application/queries/GetRiskMetricsQuery.ts`

#### RiskMetricsDTO

```typescript
interface RiskMetricsDTO {
  status: 'NORMAL' | 'WARNING' | 'PANIC';
  mode: 'QUOTE' | 'INVENTORY' | 'PANIC';
  urgency: number;                    // 0-1
  netPosition: number;
  grossPosition: number;
  unrealizedPnL: number;
  maxNetPosition: number;
  maxGrossPosition: number;
  maxLossThreshold: number;
  netPositionUtilization: number;     // %
  grossPositionUtilization: number;   // %
  timeToExpiry: number;               // ms
  timeToExpiryMinutes: number;
  statusReason?: string;
  recommendations: string[];
}
```

#### Handler

```typescript
class GetRiskMetricsHandler {
  async execute(
    query: GetRiskMetricsQuery,
    session: TradingSession
  ): Promise<RiskMetricsDTO> {
    const risk = session.riskExposure;
    const portfolio = session.portfolio;

    // Вычисляем utilization
    const netUtilization = (Math.abs(netPosition) / maxNetPosition) * 100;
    const grossUtilization = (grossPosition / maxGrossPosition) * 100;

    // Формируем рекомендации
    const recommendations: string[] = [];
    
    if (risk.status === 'PANIC') {
      recommendations.push('🚨 IMMEDIATE: Close all positions');
    } else if (risk.status === 'WARNING') {
      recommendations.push('⚠️ Reduce position size');
    }

    if (timeToExpiryMinutes < 60) {
      recommendations.push(`⏰ Market expires in ${timeToExpiryMinutes}m`);
    }

    return {
      status: risk.status,
      mode: risk.mode,
      urgency: risk.urgency,
      netPosition,
      grossPosition,
      unrealizedPnL,
      maxNetPosition,
      maxGrossPosition,
      maxLossThreshold,
      netPositionUtilization: netUtilization,
      grossPositionUtilization: grossUtilization,
      timeToExpiry: market.timeToExpiry(),
      timeToExpiryMinutes,
      statusReason: risk.statusReason,
      recommendations,
    };
  }
}
```

---

## Dependency Injection

Все handlers получают зависимости через конструктор:

```typescript
// Bootstrap / DI Container
class ApplicationBootstrap {
  private orderRepository: IOrderRepository;
  private exchangeAdapter: IExchangeAdapter;
  private marketDataFeed: IMarketDataFeed;
  private logger: ILogger;

  constructor() {
    // Infrastructure implementations
    this.logger = new WinstonLogger(...);
    this.orderRepository = new InMemoryOrderRepository();
    this.exchangeAdapter = new PolymarketAdapter(...);
    this.marketDataFeed = new PolymarketDataFeed(...);
  }

  createPlaceOrderHandler(): PlaceOrderHandler {
    return new PlaceOrderHandler(
      this.orderRepository,
      this.exchangeAdapter,
      this.logger
    );
  }

  createCancelOrderHandler(): CancelOrderHandler {
    return new CancelOrderHandler(
      this.orderRepository,
      this.exchangeAdapter,
      this.logger
    );
  }

  createGetPortfolioSnapshotHandler(): GetPortfolioSnapshotHandler {
    return new GetPortfolioSnapshotHandler(
      this.marketDataFeed,
      this.logger
    );
  }

  createGetRiskMetricsHandler(): GetRiskMetricsHandler {
    return new GetRiskMetricsHandler(this.logger);
  }
}
```

**Использование:**

```typescript
const bootstrap = new ApplicationBootstrap();

// Создаём handlers
const placeOrderHandler = bootstrap.createPlaceOrderHandler();
const cancelOrderHandler = bootstrap.createCancelOrderHandler();
const getPortfolioHandler = bootstrap.createGetPortfolioSnapshotHandler();
const getRiskHandler = bootstrap.createGetRiskMetricsHandler();

// Выполняем команды/запросы
const orderDTO = await placeOrderHandler.execute(placeOrderCommand);
await cancelOrderHandler.execute(cancelOrderCommand);
const portfolioDTO = await getPortfolioHandler.execute(snapshotQuery, session);
const riskDTO = await getRiskHandler.execute(riskQuery, session);
```

---

## Best Practices

### 1. Command Validation

✅ **Валидация в конструкторе команды:**
```typescript
class PlaceOrderCommand {
  constructor(public readonly price: number) {
    if (price <= 0 || price >= 1) {
      throw new Error('Invalid price');
    }
  }
}
```

### 2. Error Handling

✅ **Специфичные ошибки:**
```typescript
try {
  await handler.execute(command);
} catch (error) {
  if (error instanceof InsufficientFundsError) {
    // Специфичная обработка
  } else if (error instanceof ExchangeError) {
    // Другая обработка
  }
}
```

### 3. Logging

✅ **Логирование на всех этапах:**
```typescript
async execute(command: PlaceOrderCommand): Promise<OrderDTO> {
  this.logger.info('Executing PlaceOrderCommand', { command });
  
  try {
    // ... операция ...
    this.logger.info('Order placed successfully', { orderId });
    return orderDTO;
  } catch (error) {
    this.logger.error('Failed to place order', { error, command });
    throw error;
  }
}
```

### 4. DTOs vs Entities

❌ **Не возвращайте entities напрямую:**
```typescript
// ❌ Плохо
async execute(): Promise<Order> {
  return order; // утечка domain в API
}

// ✅ Хорошо
async execute(): Promise<OrderDTO> {
  return toOrderDTO(order);
}
```

---

## Резюме

| Компонент | Ответственность | Пример |
|-----------|----------------|--------|
| **Command** | Инкапсулирует параметры операции | `PlaceOrderCommand` |
| **Query** | Инкапсулирует параметры запроса | `GetPortfolioSnapshotQuery` |
| **Handler** | Оркестрирует бизнес-логику | `PlaceOrderHandler` |
| **DTO** | Передача данных между слоями | `OrderDTO` |

**Принципы:**
- ✅ CQRS: разделение команд и запросов
- ✅ Dependency Injection: все зависимости через конструктор
- ✅ Single Responsibility: один handler = одна операция
- ✅ DTOs для границ слоёв
- ✅ Логирование всех операций
- ✅ Специфичная обработка ошибок
