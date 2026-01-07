# Агрегаты и Порты (Aggregates & Ports)

## Обзор

**Агрегаты** — это кластеры доменных объектов, которые рассматриваются как единое целое для изменения данных. Каждый агрегат имеет **корневой объект** (aggregate root), через который происходят все изменения.

**Порты** — это интерфейсы, определяющие контракты для внешних зависимостей. Следуют принципу **Hexagonal Architecture** (Ports & Adapters).

---

## Агрегаты

### 1. TradingSession (корневой агрегат)

**Файл**: `src/domain/aggregates/TradingSession.ts`

#### Назначение

Корневой агрегат, управляющий всей торговой сессией. Все операции с ордерами и позициями **обязательно** проходят через этот агрегат.

#### Почему это корень?

1. **Граница консистентности**: Агрегат обеспечивает целостность всех связанных сущностей
2. **Единая точка входа**: Все изменения идут через корень
3. **Защита инвариантов**: Агрегат защищает бизнес-правила
4. **Транзакционная граница**: Агрегат = единица транзакции

#### Свойства

| Свойство | Тип | Описание |
|----------|-----|----------|
| `sessionId` | `string` | Уникальный идентификатор сессии |
| `market` | `Market` | Рынок для торговли |
| `portfolio` | `Portfolio` | Портфель (из entities) |
| `riskExposure` | `RiskExposure` | Управление рисками |
| `activeOrders` | `Map<string, Order>` | Активные ордера |
| `startTime` | `Date` | Время начала сессии |
| `lastUpdateTime` | `Date` | Последнее обновление |

#### Инварианты (защищаются агрегатом)

Инварианты — это правила, которые **всегда** должны быть истинными:

1. ✅ **Cash никогда не отрицательный**: `portfolio.cash >= 0`
2. ✅ **Резерв не превышает cash**: `portfolio.reservedCash <= portfolio.cash`
3. ✅ **Резерв соответствует BUY ордерам**: `sum(BUY orders notional) == portfolio.reservedCash`
4. ✅ **Нельзя разместить BUY без средств**: `order.notional <= portfolio.availableCash`
5. ✅ **Нельзя разместить SELL без позиции**: `order.size <= position.totalQuantity`
6. ✅ **Все ордера принадлежат рынку**: `order.tokenId in [market.yesTokenId, market.noTokenId]`
7. ✅ **Нельзя отменить исполненный ордер**: `order.status != 'FILLED'`

#### Методы

##### placeOrder(order: Order): TradingSession

Размещает ордер в сессии.

**Алгоритм:**
1. Валидирует, что рынок активен
2. Проверяет, что ордер принадлежит этому рынку
3. Для **BUY** ордера:
   - Проверяет достаточность средств
   - Резервирует cash: `orderCost = price × size`
4. Для **SELL** ордера:
   - Проверяет наличие позиции
5. Добавляет ордер в `activeOrders`
6. Валидирует все инварианты
7. Возвращает новый TradingSession

**Пример:**
```typescript
const session = TradingSession.create(market, Money.fromUSDC(1000));

const order = Order.create({
  id: 'order-1',
  tokenId: market.yesTokenId,
  side: 'BUY',
  price: Price.fromNumber(0.65),
  size: Quantity.fromNumber(100),
  status: 'PENDING',
  timestamp: new Date()
});

const updated = session.placeOrder(order);
// portfolio.reservedCash = 65 USDC
// activeOrders.size = 1
```

##### cancelOrder(orderId: string): TradingSession

Отменяет активный ордер.

**Алгоритм:**
1. Находит ордер в `activeOrders`
2. Проверяет, что `order.canCancel()` (только PENDING/OPEN)
3. Для **BUY** ордера:
   - Освобождает резерв: `releaseCash(orderCost)`
4. Удаляет ордер из `activeOrders`
5. Валидирует инварианты
6. Возвращает новый TradingSession

**Пример:**
```typescript
const updated = session.cancelOrder('order-1');
// portfolio.reservedCash = 0 (освобождено 65 USDC)
// activeOrders.size = 0
```

##### fillOrder(orderId, fillSize, fillPrice): TradingSession

Обрабатывает исполнение ордера.

**Алгоритм:**

**Для BUY:**
1. Находит ордер
2. Валидирует `fillSize <= remainingSize`
3. Освобождает полный резерв: `releaseCash(order.price × order.size)`
4. Списывает фактический cost: `deductCash(fillPrice × fillSize)`
5. Создаёт лот: `new PositionLot(...)`
6. Добавляет лот в позицию: `portfolio.addPosition(lot)`
7. Если ордер полностью исполнен: удаляет из `activeOrders`
8. Если частично: обновляет `filledSize`

**Для SELL:**
1. Зачисляет выручку: `addCash(fillPrice × fillSize)`
2. Удаляет из позиции (FIFO): `portfolio.removePosition(fillSize)`
3. Обновляет ордер

**Пример:**
```typescript
// BUY 100 @ 0.65 исполнился
const filled = session.fillOrder(
  'order-1',
  Quantity.fromNumber(100),
  Price.fromNumber(0.65)
);

// Результат:
// - cash: 1000 - 65 = 935 USDC
// - reservedCash: 0 USDC
// - position: 100 shares @ 0.65
// - activeOrders: пусто (полностью исполнен)
```

##### updateRisk(prices, timeToExpiry, limits): TradingSession

Обновляет состояние риска.

**Алгоритм:**
1. Вычисляет unrealized P&L из портфеля
2. Проверяет условие паники: `loss > threshold`
3. Проверяет лимиты позиций (net, gross)
4. Вычисляет urgency: функция времени и размера позиции
5. Обновляет `riskExposure`

**Пример:**
```typescript
const prices = new Map([[market.yesTokenId, Price.fromNumber(0.70)]]);
const limits = {
  maxNetPosition: 1000,
  maxGrossPosition: 2000,
  maxLossThreshold: Money.fromUSDC(100)
};

const withRisk = session.updateRisk(prices, 86400000, limits);
// riskExposure.status: 'NORMAL'
// riskExposure.urgency: 0.04
```

#### Почему Immutable?

Все методы возвращают **новый** TradingSession:

```typescript
// ❌ Плохо - мутация
session.activeOrders.set('order-1', order);

// ✅ Хорошо - новый экземпляр
const updated = session.placeOrder(order);
```

**Преимущества:**
- Thread-safety (безопасность в многопоточке)
- Легко отследить историю изменений
- Упрощает тестирование
- Предсказуемость (нет скрытых side effects)

---

### 2. RiskExposure

**Файл**: `src/domain/aggregates/RiskExposure.ts`

#### Назначение

Управляет состоянием риска торговой сессии.

#### Свойства

| Свойство | Тип | Описание |
|----------|-----|----------|
| `status` | `RiskStatus` | NORMAL, WARNING, PANIC |
| `mode` | `TradingMode` | QUOTE, INVENTORY, PANIC |
| `urgency` | `number` | 0-1 (насколько срочно закрыть позицию) |
| `netPosition` | `number` | Чистая позиция (YES - NO) |
| `grossPosition` | `number` | Валовая позиция (YES + NO) |

#### Методы

```typescript
// Создание
RiskExposure.create(): RiskExposure

// Проверка паники
shouldPanic(unrealizedPnL: Money, threshold: Money): boolean

// Проверка лимитов
checkLimits(portfolio: Portfolio, maxNet: number, maxGross: number): RiskExposure

// Вычисление urgency
calculateUrgency(timeToExpiry: number, position: number, maxPosition: number): number

// Обновление режима
updateMode(mode: TradingMode, reason: string): RiskExposure

// Обновление urgency
updateUrgency(urgency: number, reason: string): RiskExposure
```

#### Режимы торговли

| Режим | Описание | Действия |
|-------|----------|----------|
| **QUOTE** | Нормальная работа | Размещаем котировки на обе стороны |
| **INVENTORY** | Дисбаланс инвентаря | Скошенные котировки (закрываем позицию) |
| **PANIC** | Критическая ситуация | Агрессивно закрываем всё |

#### Статусы риска

| Статус | Условие | Действия |
|--------|---------|----------|
| **NORMAL** | Всё в норме | Обычная торговля |
| **WARNING** | Приближаемся к лимитам | Осторожнее с новыми позициями |
| **PANIC** | Превышены лимиты/убытки | Немедленное закрытие |

#### Urgency (срочность)

**Формула:**
```
urgency = f(timeToExpiry, positionSize)
```

**Факторы:**
- ⏰ Время до истечения рынка (меньше времени = выше urgency)
- 📊 Размер позиции (больше позиция = выше urgency)
- 💰 Размер убытка (больше убыток = выше urgency)

**Шкала:**
- `0.0`: Нет срочности
- `0.5`: Умеренная срочность
- `0.8`: Высокая срочность
- `1.0`: Критическая срочность (паника)

**Пример:**
```typescript
const risk = RiskExposure.create();

// Проверка паники
if (risk.shouldPanic(pnl, Money.fromUSDC(100))) {
  risk = risk.updateMode('PANIC', 'Loss exceeded threshold');
}

// Вычисление urgency
// 1 час до истечения, позиция 800 из максимум 1000
const urgency = risk.calculateUrgency(
  3600000,  // 1 hour in ms
  800,      // position size
  1000      // max position
);
// urgency ≈ 0.85 (высокая срочность)
```

---

## Порты (Ports)

Порты — это **интерфейсы**, определяющие контракты для внешних зависимостей. Следуют принципу **Dependency Inversion**:

```
┌─────────────┐
│   Domain    │ ← определяет интерфейсы (ports)
└─────────────┘
      ↑
      │ depends on (interface)
      │
┌─────────────┐
│Infrastructure│ ← реализует интерфейсы (adapters)
└─────────────┘
```

### 1. IExecutionAdapter

**Файл**: `src/domain/ports/IExecutionAdapter.ts`

**Last Updated**: January 2026 - разделён от IExchangeAdapter (см. [Execution-Portfolio Separation](../architecture/execution-portfolio-separation.md))

#### Назначение

Интерфейс для **order execution операций** (размещение, отмена, отслеживание ордеров).

**ТОЛЬКО execution**, НЕ балансы/позиции/orderbook (см. IPortfolioAdapter).

#### Методы

```typescript
interface IExecutionAdapter {
  // Размещение ордера
  placeOrder(order: Order): Promise<Order>;

  // Отмена ордера
  cancelOrder(orderId: string): Promise<void>;

  // Получение открытых ордеров
  getOpenOrders(tokenId?: string): Promise<Order[]>;

  // Подписка на обновления ордера
  subscribeToOrderUpdates(
    orderId: string,
    callback: (order: Order) => void
  ): () => void;
}
```

#### Пример реализации

```typescript
// infrastructure/exchange/adapters/execution/PolymarketExecutionAdapter.ts
class PolymarketExecutionAdapter implements IExecutionAdapter {
  constructor(
    private clobClient: CLOBClient,
    private marketConstraintsPolicy: MarketConstraintsPolicy,
    private balancePolicy: BalancePolicy,
    private eventBus: IEventBus,
    private userEventsFeed: UserEventsFeedService,
    private logger: ILogger
  ) {}

  async placeOrder(order: Order): Promise<Order> {
    // 1. Normalize size (min/max/tick)
    const normalized = await this.marketConstraintsPolicy.normalizeSize(
      order.tokenId,
      order.size,
      order.side
    );

    // 2. Validate balance
    await this.balancePolicy.checkBalance(
      order.side,
      normalized,
      order.price
    );

    // 3. Place order via CLOB
    const response = await this.clobClient.placeOrder({
      tokenID: order.tokenId,
      price: order.price.value,
      size: normalized.value,
      side: order.side
    });

    // 4. Publish OrderPlacedEvent
    this.eventBus.publish(new OrderPlacedEvent(order));

    return order.withExchangeId(response.orderID);
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.clobClient.cancelOrder({ orderId });

    // Publish OrderCancelledEvent
    this.eventBus.publish(new OrderCancelledEvent(orderId, 'User requested'));
  }

  // ... остальные методы
}
```

---

### 2. IPortfolioAdapter

**Файл**: `src/domain/ports/IPortfolioAdapter.ts`

**Created**: January 2026 - разделён от IExchangeAdapter (см. [Execution-Portfolio Separation](../architecture/execution-portfolio-separation.md))

#### Назначение

Интерфейс для **portfolio и market data операций** (балансы, позиции, orderbook).

**ТОЛЬКО queries**, НЕ order execution (см. IExecutionAdapter).

#### Методы

```typescript
interface IPortfolioAdapter {
  // Получение баланса USDC
  getBalance(): Promise<Money>;

  // Получение locked баланса
  getLockedBalance(): Promise<Money>;

  // Получение позиции
  getPosition(tokenId: string): Promise<Quantity>;

  // Получение всех позиций
  getAllPositions(): Promise<Array<{ tokenId: string; quantity: Quantity }>>;

  // Получение orderbook
  getOrderBook(marketId: string): Promise<Orderbook>;
}
```

#### Пример реализации

```typescript
// infrastructure/exchange/adapters/portfolio/PolymarketPortfolioAdapter.ts
class PolymarketPortfolioAdapter implements IPortfolioAdapter {
  constructor(
    private balanceClient: PolymarketBalanceRestClient,
    private positionClient: PolymarketPositionRestClient,
    private orderbookClient: PolymarketOrderbookRestClient,
    private logger: ILogger
  ) {}

  async getBalance(): Promise<Money> {
    const balances = await this.balanceClient.getBalances();
    const usdc = balances.find(b => b.asset === 'USDC');

    if (!usdc) {
      this.logger.warn('USDC balance not found');
      return Money.fromUSDC(0);
    }

    return Money.fromUSDC(parseFloat(usdc.available));
  }

  async getPosition(tokenId: string): Promise<Quantity> {
    const positions = await this.positionClient.getPositions();
    const position = positions.find(p => p.tokenId === tokenId);

    if (!position) {
      return Quantity.fromNumber(0);
    }

    return Quantity.fromNumber(parseFloat(position.size));
  }

  async getOrderBook(marketId: string): Promise<Orderbook> {
    const apiOrderbook = await this.orderbookClient.getOrderbook(marketId);
    return OrderbookMapper.toDomain(apiOrderbook);
  }

  // ... остальные методы
}
```

---

### 3. IExchangeAdapter (DEPRECATED)

**Файл**: `src/domain/ports/IExchangeAdapter.ts`

**Status**: ⚠️ **DEPRECATED** (January 2026)

**Замена**: Используйте `IExecutionAdapter` + `IPortfolioAdapter`

**Причина разделения**:
- Нарушение Single Responsibility Principle
- Сложное тестирование (мокать всё сразу)
- Невозможно подменить только execution или только portfolio

**Migration**:
```typescript
// Before
const adapter: IExchangeAdapter = ...;
await adapter.placeOrder(order);
const balance = await adapter.getBalance();

// After
const executionAdapter: IExecutionAdapter = ...;
const portfolioAdapter: IPortfolioAdapter = ...;

await executionAdapter.placeOrder(order);
const balance = await portfolioAdapter.getBalance();
```

См. [Execution-Portfolio Separation](../architecture/execution-portfolio-separation.md) для деталей.

---

### 4. IDiagnosticsService

**Файл**: `src/domain/ports/IDiagnosticsService.ts`

**Created**: January 2026 (см. [Execution-Portfolio Separation](../architecture/execution-portfolio-separation.md))

#### Назначение

Интерфейс для **centralized diagnostics и health checks** всей системы.

#### Методы

```typescript
interface IDiagnosticsService {
  /**
   * System health check
   *
   * @returns SystemHealth - статус + компоненты
   *
   * @remarks
   * Проверяет:
   * - EventBus (subscriber count)
   * - UserEventsFeedService (connection status)
   * - OrderRepository (read test)
   *
   * Статусы:
   * - 'healthy': Всё ОК
   * - 'degraded': Некритичные проблемы
   * - 'unhealthy': Критичные проблемы
   */
  getHealth(): Promise<SystemHealth>;

  /**
   * Full diagnostics snapshot
   *
   * @returns DiagnosticsSnapshot - health + metrics + state
   */
  getDiagnostics(): Promise<DiagnosticsSnapshot>;

  /**
   * Execution metrics (от MetricsProjector)
   *
   * @returns ExecutionMetrics - ordersPlaced, ordersFilled, fillRate
   */
  getExecutionMetrics(): Promise<ExecutionMetrics>;

  /**
   * State snapshot (OrderRepository stats)
   *
   * @returns StateSnapshot - totalOrders, ordersByStatus
   */
  getStateSnapshot(): Promise<StateSnapshot>;
}
```

#### Пример использования

```typescript
// application/monitoring/HealthCheckService.ts
class HealthCheckService {
  constructor(private diagnostics: IDiagnosticsService) {}

  async checkSystemHealth(): Promise<void> {
    const health = await this.diagnostics.getHealth();

    console.log(`Overall status: ${health.status}`);

    for (const component of health.components) {
      console.log(`${component.name}: ${component.status}`);
      if (component.message) {
        console.log(`  ${component.message}`);
      }
    }

    if (health.status === 'unhealthy') {
      // Alert ops team
      await this.alertOps('System unhealthy', health);
    }
  }

  async getMetrics(): Promise<void> {
    const metrics = await this.diagnostics.getExecutionMetrics();

    console.log(`Orders placed: ${metrics.ordersPlaced}`);
    console.log(`Orders filled: ${metrics.ordersFilled}`);
    console.log(`Fill rate: ${metrics.fillRate.toFixed(2)}`);
  }
}
```

#### Пример реализации

```typescript
// infrastructure/diagnostics/DiagnosticsService.ts
class DiagnosticsService implements IDiagnosticsService {
  constructor(
    private eventBus: IEventBus,
    private metricsProjector: MetricsProjector,
    private userEventsFeed: UserEventsFeedService,
    private orderRepository: IOrderRepository,
    private logger: ILogger
  ) {}

  async getHealth(): Promise<SystemHealth> {
    const components: ComponentHealth[] = [];

    // EventBus check
    components.push(this.checkEventBus());

    // UserEventsFeedService check
    components.push(this.checkUserEventsFeed());

    // OrderRepository check
    components.push(await this.checkOrderRepository());

    const overallStatus = this.calculateOverallStatus(components);

    return {
      status: overallStatus,
      components,
      timestamp: new Date()
    };
  }

  private checkEventBus(): ComponentHealth {
    const totalSubscribers = this.eventBus.getAllSubscriberCount();

    return {
      name: 'EventBus',
      status: totalSubscribers > 0 ? 'healthy' : 'degraded',
      message: `${totalSubscribers} subscribers active`,
      timestamp: new Date()
    };
  }

  // ... остальные методы
}
```

---

### 5. IOrderRepository

**Файл**: `src/domain/ports/IOrderRepository.ts`

#### Назначение

Интерфейс для хранения и извлечения ордеров.

#### Методы

```typescript
interface IOrderRepository {
  // CRUD операции
  save(order: Order): Promise<void>;
  update(order: Order): Promise<void>;
  delete(orderId: string): Promise<void>;
  
  // Поиск
  findById(orderId: string): Promise<Order | null>;
  findByMarket(marketId: string): Promise<Order[]>;
  findByStatus(status: OrderStatus): Promise<Order[]>;
  findByStatuses(statuses: OrderStatus[]): Promise<Order[]>;
  findAll(): Promise<Order[]>;
}
```

#### Пример реализации (in-memory)

```typescript
// infrastructure/repositories/InMemoryOrderRepository.ts
class InMemoryOrderRepository implements IOrderRepository {
  private orders = new Map<string, Order>();

  async save(order: Order): Promise<void> {
    if (this.orders.has(order.id)) {
      throw new Error(`Order ${order.id} already exists`);
    }
    this.orders.set(order.id, order);
  }

  async update(order: Order): Promise<void> {
    if (!this.orders.has(order.id)) {
      throw new Error(`Order ${order.id} not found`);
    }
    this.orders.set(order.id, order);
  }

  async findById(orderId: string): Promise<Order | null> {
    return this.orders.get(orderId) || null;
  }

  async findByStatus(status: OrderStatus): Promise<Order[]> {
    return Array.from(this.orders.values())
      .filter(order => order.status === status);
  }

  // ... остальные методы
}
```

---

### 3. IMarketDataFeed

**Файл**: `src/domain/ports/IMarketDataFeed.ts`

#### Назначение

Интерфейс для получения рыночных данных в реальном времени.

#### Методы

```typescript
interface IMarketDataFeed {
  // Snapshot
  getOrderbook(marketId: string): Promise<Orderbook>;
  
  // Подписки
  subscribeToOrderbook(marketId: string, callback: (ob: Orderbook) => void): void;
  subscribeToTrades(marketId: string, callback: (trade: Trade) => void): void;
  
  // Отписки
  unsubscribe(marketId: string): void;
  unsubscribeFromOrderbook(marketId: string): void;
  unsubscribeFromTrades(marketId: string): void;
  
  // Проверка
  isSubscribed(marketId: string): boolean;
}
```

#### Пример использования

```typescript
// application/MarketMaker.ts
class MarketMaker {
  constructor(private dataFeed: IMarketDataFeed) {}

  async start(marketId: string): Promise<void> {
    // Получаем снимок
    const orderbook = await this.dataFeed.getOrderbook(marketId);
    console.log('Initial orderbook:', orderbook.toString());

    // Подписываемся на обновления
    this.dataFeed.subscribeToOrderbook(marketId, (ob) => {
      console.log('Orderbook updated:', ob.toString());
      this.onOrderbookUpdate(ob);
    });

    this.dataFeed.subscribeToTrades(marketId, (trade) => {
      console.log('New trade:', trade.toString());
      this.onTradeReceived(trade);
    });
  }

  stop(marketId: string): void {
    this.dataFeed.unsubscribe(marketId);
  }
}
```

---

### 4. ILogger

**Файл**: `src/domain/ports/ILogger.ts`

#### Назначение

Интерфейс для логирования.

#### Методы

```typescript
interface ILogger {
  debug(message: string, metadata?: any): void;
  info(message: string, metadata?: any): void;
  warn(message: string, metadata?: any): void;
  error(message: string, metadata?: any): void;
  child?(context: string): ILogger;
}
```

#### Пример реализации (Winston)

```typescript
// infrastructure/logging/WinstonLogger.ts
import winston from 'winston';

class WinstonLogger implements ILogger {
  constructor(private logger: winston.Logger) {}

  debug(message: string, metadata?: any): void {
    this.logger.debug(message, metadata);
  }

  info(message: string, metadata?: any): void {
    this.logger.info(message, metadata);
  }

  warn(message: string, metadata?: any): void {
    this.logger.warn(message, metadata);
  }

  error(message: string, metadata?: any): void {
    this.logger.error(message, metadata);
  }

  child(context: string): ILogger {
    return new WinstonLogger(
      this.logger.child({ context })
    );
  }
}
```

#### Пример использования

```typescript
class MarketMaker {
  private logger: ILogger;

  constructor(logger: ILogger) {
    this.logger = logger.child?.('MarketMaker') || logger;
  }

  async placeQuotes(): Promise<void> {
    this.logger.info('Placing quotes');
    
    try {
      await this.exchangeAdapter.placeOrder(buyOrder);
      this.logger.info('Order placed', { orderId: buyOrder.id });
    } catch (error) {
      this.logger.error('Failed to place order', { error });
    }
  }
}
```

---

### 5. IConfigProvider

**Файл**: `src/domain/ports/IConfigProvider.ts`

#### Назначение

Интерфейс для доступа к конфигурации.

#### Методы

```typescript
interface IConfigProvider {
  get<T>(key: string): T | undefined;
  getOrThrow<T>(key: string): T;
  getOrDefault<T>(key: string, defaultValue: T): T;
  has(key: string): boolean;
  getAllKeys?(): string[];
}
```

#### Пример реализации (env vars)

```typescript
// infrastructure/config/EnvConfigProvider.ts
class EnvConfigProvider implements IConfigProvider {
  get<T>(key: string): T | undefined {
    const value = process.env[key];
    if (value === undefined) return undefined;
    
    // Пробуем распарсить JSON если это объект
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  }

  getOrThrow<T>(key: string): T {
    const value = this.get<T>(key);
    if (value === undefined) {
      throw new Error(`Required config key missing: ${key}`);
    }
    return value;
  }

  getOrDefault<T>(key: string, defaultValue: T): T {
    return this.get<T>(key) ?? defaultValue;
  }

  has(key: string): boolean {
    return process.env[key] !== undefined;
  }

  getAllKeys(): string[] {
    return Object.keys(process.env);
  }
}
```

#### Пример использования

```typescript
class BotBootstrap {
  constructor(private config: IConfigProvider) {}

  async start(): Promise<void> {
    // Обязательные параметры (выбросит ошибку если нет)
    const apiKey = this.config.getOrThrow<string>('POLYMARKET_API_KEY');
    const privateKey = this.config.getOrThrow<string>('PRIVATE_KEY');
    
    // Опциональные с defaults
    const maxPositionSize = this.config.getOrDefault('MAX_POSITION_SIZE', 1000);
    const logLevel = this.config.getOrDefault('LOG_LEVEL', 'info');
    
    // Опциональные (может быть undefined)
    const slackWebhook = this.config.get<string>('SLACK_WEBHOOK_URL');
    if (slackWebhook) {
      // Enable Slack notifications
    }
  }
}
```

---

## Архитектура: Hexagonal (Ports & Adapters)

```
                  ┌──────────────────────────┐
                  │                          │
                  │       Application        │
                  │    (Use Cases / DI)      │
                  │                          │
                  └────────────┬─────────────┘
                               │
                ┌──────────────┴──────────────┐
                │                             │
                │          Domain             │
                │   (Entities, Aggregates,    │
                │     Value Objects, Ports)   │
                │                             │
                └──────────────┬──────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
    ┌─────▼──────┐      ┌──────▼──────┐     ┌──────▼──────┐
    │            │      │             │     │             │
    │  Adapter   │      │   Adapter   │     │   Adapter   │
    │ (Exchange) │      │ (Database)  │     │  (Logger)   │
    │            │      │             │     │             │
    └────────────┘      └─────────────┘     └─────────────┘
   Infrastructure       Infrastructure     Infrastructure
```

**Принципы:**

1. **Domain не зависит от Infrastructure**
   - Domain определяет интерфейсы (ports)
   - Infrastructure реализует (adapters)

2. **Dependency Inversion**
   - Высокоуровневые модули не зависят от низкоуровневых
   - Оба зависят от абстракций

3. **Тестируемость**
   - Можно заменить реальные адаптеры на моки
   - Unit тесты не требуют внешних зависимостей

**Пример DI (Dependency Injection):**

```typescript
// application/bootstrap.ts
function bootstrap() {
  // Infrastructure layer
  const config = new EnvConfigProvider();
  const logger = new WinstonLogger(winston.createLogger({...}));
  const exchangeAdapter = new PolymarketAdapter(...);
  const orderRepo = new InMemoryOrderRepository();
  const dataFeed = new PolymarketDataFeed(...);

  // Application layer (inject dependencies)
  const marketMaker = new MarketMaker(
    exchangeAdapter,
    orderRepo,
    dataFeed,
    logger,
    config
  );

  return marketMaker;
}
```

---

## Best Practices

### 1. Работа с агрегатами

✅ **Всегда изменяйте через корень:**
```typescript
// ✅ Хорошо
const updated = session.placeOrder(order);

// ❌ Плохо - обход корня
session.portfolio.reserveCash(Money.fromUSDC(100));
```

✅ **Не храните ссылки на внутренние объекты:**
```typescript
// ❌ Плохо - мутация через ссылку
const portfolio = session.portfolio;
portfolio.cash = Money.fromUSDC(500); // Compile error (readonly)

// ✅ Хорошо - работа через корень
const updated = session.placeOrder(order);
```

✅ **Валидация инвариантов:**
```typescript
// Агрегат автоматически валидирует после каждой операции
try {
  const updated = session.placeOrder(order);
} catch (error) {
  if (error instanceof TradingSessionInvariantError) {
    console.error('Invariant violated:', error.message);
  }
}
```

### 2. Работа с портами

✅ **Зависимость от интерфейсов, не от реализаций:**
```typescript
// ✅ Хорошо
class MarketMaker {
  constructor(private logger: ILogger) {}
}

// ❌ Плохо
class MarketMaker {
  constructor(private logger: WinstonLogger) {}
}
```

✅ **Моки для тестирования:**
```typescript
// tests/unit/MarketMaker.test.ts
class MockLogger implements ILogger {
  logs: string[] = [];

  info(message: string): void {
    this.logs.push(message);
  }
  // ... остальные методы
}

describe('MarketMaker', () => {
  it('should log order placement', () => {
    const mockLogger = new MockLogger();
    const mm = new MarketMaker(mockLogger);
    
    mm.placeQuotes();
    
    expect(mockLogger.logs).toContain('Placing quotes');
  });
});
```

### 3. Транзакционные границы

Агрегат = единица транзакции:

```typescript
// ✅ Хорошо - одна операция, одна транзакция
async function placeAndFillOrder(
  session: TradingSession,
  order: Order
): Promise<TradingSession> {
  let updated = session.placeOrder(order);
  updated = await exchangeAdapter.placeOrder(order);
  updated = updated.fillOrder(order.id, order.size, order.price);
  return updated;
}
```

---

## Резюме

| Компонент | Ответственность | Расположение |
|-----------|----------------|--------------|
| **TradingSession** | Корневой агрегат, управление торговлей | `domain/aggregates/` |
| **RiskExposure** | Управление рисками | `domain/aggregates/` |
| **IExchangeAdapter** | Интерфейс биржи | `domain/ports/` |
| **IOrderRepository** | Интерфейс хранилища | `domain/ports/` |
| **IMarketDataFeed** | Интерфейс данных | `domain/ports/` |
| **ILogger** | Интерфейс логирования | `domain/ports/` |
| **IConfigProvider** | Интерфейс конфигурации | `domain/ports/` |

**Ключевые принципы:**
- ✅ Агрегаты защищают инварианты
- ✅ Все изменения через корень
- ✅ Immutability (неизменяемость)
- ✅ Порты определяют контракты
- ✅ Infrastructure реализует адаптеры
- ✅ Dependency Inversion
