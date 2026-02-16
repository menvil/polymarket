# Примеры использования

## Быстрый старт

### Установка

```bash
npm install @polymarket/time
```

### Базовое использование

```typescript
import { LiveClock, PaperClock, ReplayClock } from '@polymarket/time';

// Production - реальное время
const liveClock = new LiveClock();
console.log(liveClock.now()); // Текущее системное время

// Testing - управляемое время
const paperClock = new PaperClock(new Date('2024-01-01'));
console.log(paperClock.now()); // 2024-01-01T00:00:00.000Z
paperClock.tick(5000); // +5 секунд
console.log(paperClock.now()); // 2024-01-01T00:00:05.000Z

// Replay - время из событий
const replayClock = new ReplayClock(new Date(0));
replayClock.update(new Date('2024-01-01T10:00:00Z'));
console.log(replayClock.now()); // 2024-01-01T10:00:00.000Z
```

## Production: LiveClock

### Пример 1: Торговая стратегия

```typescript
import type { IClock } from '@polymarket/time';
import { LiveClock } from '@polymarket/time';

interface Order {
  id: string;
  price: number;
  quantity: number;
  placedAt: Date;
}

class TradingStrategy {
  private orders: Order[] = [];

  constructor(private readonly clock: IClock) {}

  placeOrder(price: number, quantity: number): Order {
    const order: Order = {
      id: this.generateOrderId(),
      price,
      quantity,
      placedAt: this.clock.now(), // ✅ Время через DI
    };

    this.orders.push(order);
    return order;
  }

  private generateOrderId(): string {
    return `order-${Date.now()}-${Math.random()}`;
  }

  getOrders(): Order[] {
    return this.orders;
  }
}

// Production использование
const strategy = new TradingStrategy(new LiveClock());

const order1 = strategy.placeOrder(0.65, 100);
console.log('Order placed at:', order1.placedAt);
// Order placed at: 2024-01-15T10:30:45.123Z (реальное время)
```

### Пример 2: Логирование с временными метками

```typescript
import { LiveClock, type IClock } from '@polymarket/time';

class Logger {
  constructor(private readonly clock: IClock) {}

  log(message: string): void {
    const timestamp = this.clock.now();
    console.log(`[${timestamp.toISOString()}] ${message}`);
  }
}

const logger = new Logger(new LiveClock());
logger.log('Application started');
// [2024-01-15T10:30:45.123Z] Application started
```

## Testing: PaperClock

### Пример 1: Unit-тесты с контролируемым временем

```typescript
import { describe, it, expect } from '@jest/globals';
import { PaperClock } from '@polymarket/time';

describe('TradingStrategy', () => {
  it('должен размещать ордера с правильными временными метками', () => {
    // Создать clock с фиксированным временем
    const clock = new PaperClock(new Date('2024-01-01T00:00:00.000Z'));
    const strategy = new TradingStrategy(clock);

    // Разместить первый ордер
    const order1 = strategy.placeOrder(0.65, 100);
    expect(order1.placedAt).toEqual(new Date('2024-01-01T00:00:00.000Z'));

    // Продвинуть время на 5 секунд
    clock.tick(5000);

    // Разместить второй ордер
    const order2 = strategy.placeOrder(0.70, 200);
    expect(order2.placedAt).toEqual(new Date('2024-01-01T00:00:05.000Z'));

    // Проверить интервал между ордерами
    const interval = order2.placedAt.getTime() - order1.placedAt.getTime();
    expect(interval).toBe(5000);
  });

  it('должен правильно обрабатывать таймауты', () => {
    const clock = new PaperClock(new Date('2024-01-01T00:00:00.000Z'));

    // Определения интерфейсов для примера
    interface IClock {
      now(): Date;
    }

    interface Order {
      id: string;
      price: number;
      quantity: number;
      placedAt: Date;
    }

    class OrderWithTimeout {
      private orderCounter = 0;

      constructor(private readonly clock: IClock) {}

      placeOrder(price: number, quantity: number): Order {
        return {
          id: `order-${++this.orderCounter}`,
          price,
          quantity,
          placedAt: this.clock.now(),
        };
      }

      placeOrderWithTimeout(timeoutMs: number): {
        order: Order;
        expiresAt: Date;
      } {
        const order = this.placeOrder(0.65, 100);
        const expiresAt = new Date(
          this.clock.now().getTime() + timeoutMs
        );

        return { order, expiresAt };
      }
    }

    const service = new OrderWithTimeout(clock);
    const { order, expiresAt } = service.placeOrderWithTimeout(60000); // 1 минута

    expect(order.placedAt).toEqual(new Date('2024-01-01T00:00:00.000Z'));
    expect(expiresAt).toEqual(new Date('2024-01-01T00:01:00.000Z'));
  });
});
```

### Пример 2: Интеграционные тесты

```typescript
import { PaperClock } from '@polymarket/time';

describe('Order Lifecycle', () => {
  it('должен обрабатывать полный жизненный цикл ордера', () => {
    const clock = new PaperClock(new Date('2024-01-01T00:00:00.000Z'));
    const orderService = new OrderService(clock);

    // t=0: Разместить ордер
    const orderId = orderService.placeOrder(0.65, 100);
    expect(orderService.getOrderStatus(orderId)).toBe('PENDING');

    // t=1s: Частичное исполнение
    clock.tick(1000);
    orderService.partialFill(orderId, 50);
    expect(orderService.getOrderStatus(orderId)).toBe('PARTIAL');

    // t=2s: Полное исполнение
    clock.tick(1000);
    orderService.completeFill(orderId);
    expect(orderService.getOrderStatus(orderId)).toBe('FILLED');

    // Проверить временные метки
    const order = orderService.getOrder(orderId);
    expect(order.placedAt).toEqual(new Date('2024-01-01T00:00:00.000Z'));
    expect(order.partialFilledAt).toEqual(
      new Date('2024-01-01T00:00:01.000Z')
    );
    expect(order.filledAt).toEqual(new Date('2024-01-01T00:00:02.000Z'));
  });
});
```

### Пример 3: Тестирование rate limiting

```typescript
import type { IClock } from '@polymarket/time';
import { PaperClock } from '@polymarket/time';

class RateLimiter {
  private requests: Date[] = [];

  constructor(
    private readonly clock: IClock,
    private readonly maxRequests: number,
    private readonly windowMs: number
  ) {}

  canMakeRequest(): boolean {
    const now = this.clock.now();
    const windowStart = now.getTime() - this.windowMs;

    // Удалить старые запросы
    this.requests = this.requests.filter(
      (time) => time.getTime() > windowStart
    );

    return this.requests.length < this.maxRequests;
  }

  recordRequest(): void {
    this.requests.push(this.clock.now());
  }
}

describe('RateLimiter', () => {
  it('должен ограничивать количество запросов в окне', () => {
    const clock = new PaperClock(new Date('2024-01-01T00:00:00.000Z'));
    const limiter = new RateLimiter(clock, 3, 10000); // 3 запроса за 10 секунд

    // Первые 3 запроса должны пройти
    expect(limiter.canMakeRequest()).toBe(true);
    limiter.recordRequest();

    expect(limiter.canMakeRequest()).toBe(true);
    limiter.recordRequest();

    expect(limiter.canMakeRequest()).toBe(true);
    limiter.recordRequest();

    // 4-й запрос должен быть заблокирован
    expect(limiter.canMakeRequest()).toBe(false);

    // Продвинуть время на 11 секунд
    clock.tick(11000);

    // Теперь можно делать новые запросы
    expect(limiter.canMakeRequest()).toBe(true);
  });
});
```

## Replay: ReplayClock

### Пример 1: Воспроизведение исторических событий

```typescript
import { ReplayClock } from '@polymarket/time';

interface MarketEvent {
  type: 'ORDER_PLACED' | 'ORDER_FILLED' | 'ORDER_CANCELLED';
  timestamp: Date;
  orderId: string;
  data: unknown;
}

class EventReplaySystem {
  private telemetry: Array<{ event: string; timestamp: Date }> = [];

  constructor(
    private readonly clock: ReplayClock,
    private readonly strategy: TradingStrategy
  ) {}

  replay(events: MarketEvent[]): void {
    events.forEach((event) => {
      // 1. Обновить clock из события
      this.clock.update(event.timestamp);

      // 2. Обработать событие
      this.strategy.onMarketEvent(event);

      // 3. Записать telemetry с детерминированным временем
      this.telemetry.push({
        event: event.type,
        timestamp: this.clock.now(), // === event.timestamp
      });
    });
  }

  getTelemetry(): Array<{ event: string; timestamp: Date }> {
    return this.telemetry;
  }
}

// Использование
const historicalEvents: MarketEvent[] = [
  {
    type: 'ORDER_PLACED',
    timestamp: new Date('2024-01-01T10:00:00.000Z'),
    orderId: 'order-1',
    data: { price: 0.65, quantity: 100 },
  },
  {
    type: 'ORDER_FILLED',
    timestamp: new Date('2024-01-01T10:00:01.500Z'),
    orderId: 'order-1',
    data: { fillPrice: 0.65, fillQuantity: 100 },
  },
  {
    type: 'ORDER_PLACED',
    timestamp: new Date('2024-01-01T10:00:03.000Z'),
    orderId: 'order-2',
    data: { price: 0.70, quantity: 200 },
  },
];

const clock = new ReplayClock(new Date(0));
const strategy = new TradingStrategy(clock);
const replaySystem = new EventReplaySystem(clock, strategy);

// Первое воспроизведение
replaySystem.replay(historicalEvents);
const telemetry1 = replaySystem.getTelemetry();

// Второе воспроизведение (для проверки детерминизма)
replaySystem.replay(historicalEvents);
const telemetry2 = replaySystem.getTelemetry();

// Telemetry идентична (bit-for-bit)
// Сравнение по значению (не по ссылке, т.к. now() возвращает новый объект)
console.log(
  telemetry1[0].timestamp.getTime() === telemetry2[0].timestamp.getTime()
); // true
```

### Пример 2: Анализ стратегии на исторических данных

```typescript
import { ReplayClock } from '@polymarket/time';

interface BacktestResult {
  totalOrders: number;
  profitLoss: number;
  timeline: Array<{
    timestamp: Date;
    action: string;
    balance: number;
  }>;
}

class StrategyBacktester {
  constructor(
    private readonly clock: ReplayClock,
    private readonly strategy: TradingStrategy
  ) {}

  backtest(marketData: MarketEvent[]): BacktestResult {
    let balance = 10000; // Начальный баланс
    const timeline: BacktestResult['timeline'] = [];
    let totalOrders = 0;

    marketData.forEach((event) => {
      // Обновить время из исторических данных
      this.clock.update(event.timestamp);

      // Обработать событие стратегией
      const decision = this.strategy.onMarketEvent(event);

      if (decision.action === 'BUY' || decision.action === 'SELL') {
        totalOrders++;
        balance += decision.profitLoss;

        timeline.push({
          timestamp: this.clock.now(),
          action: decision.action,
          balance,
        });
      }
    });

    return {
      totalOrders,
      profitLoss: balance - 10000,
      timeline,
    };
  }
}

// Использование
const clock = new ReplayClock(new Date(0));
const strategy = new TradingStrategy(clock);
const backtester = new StrategyBacktester(clock, strategy);

// Загрузить исторические данные
const marketData = loadHistoricalData('2024-01-01', '2024-01-31');

// Запустить бэктест
const result = backtester.backtest(marketData);

console.log('Total orders:', result.totalOrders);
console.log('Profit/Loss:', result.profitLoss);
console.log('Timeline:', result.timeline);
```

### Пример 3: Детерминированное логирование

```typescript
import type { IClock } from '@polymarket/time';
import { ReplayClock } from '@polymarket/time';

class DeterministicLogger {
  private logs: Array<{ timestamp: Date; level: string; message: string }> =
    [];

  constructor(private readonly clock: IClock) {}

  info(message: string): void {
    this.logs.push({
      timestamp: this.clock.now(),
      level: 'INFO',
      message,
    });
  }

  error(message: string): void {
    this.logs.push({
      timestamp: this.clock.now(),
      level: 'ERROR',
      message,
    });
  }

  getLogs(): Array<{ timestamp: Date; level: string; message: string }> {
    return this.logs;
  }
}

// Воспроизведение с детерминированным логированием
const clock = new ReplayClock(new Date(0));
const logger = new DeterministicLogger(clock);

events.forEach((event) => {
  clock.update(event.timestamp);

  if (event.type === 'ERROR') {
    logger.error(`Error processing event: ${event.id}`);
  } else {
    logger.info(`Processed event: ${event.id}`);
  }
});

// Logs будут иметь точно такие же timestamps при повторном воспроизведении
const logs = logger.getLogs();
```

## Переключение между режимами

### Пример: Конфигурируемый сервис

```typescript
import type { IClock } from '@polymarket/time';
import { LiveClock, PaperClock, ReplayClock } from '@polymarket/time';

type Mode = 'LIVE' | 'PAPER' | 'REPLAY';

class ConfigurableStrategyRunner {
  private clock: IClock;
  private strategy: TradingStrategy;

  constructor(mode: Mode) {
    this.clock = this.createClock(mode);
    this.strategy = new TradingStrategy(this.clock);
  }

  private createClock(mode: Mode): IClock {
    switch (mode) {
      case 'LIVE':
        return new LiveClock();
      case 'PAPER':
        return new PaperClock(new Date());
      case 'REPLAY':
        return new ReplayClock(new Date(0));
    }
  }

  getClock(): IClock {
    return this.clock;
  }

  getStrategy(): TradingStrategy {
    return this.strategy;
  }
}

// Production
const liveRunner = new ConfigurableStrategyRunner('LIVE');

// Testing
const paperRunner = new ConfigurableStrategyRunner('PAPER');

// Analysis
const replayRunner = new ConfigurableStrategyRunner('REPLAY');
```

## Best Practices

### ✅ Правильно

```typescript
// 1. Всегда используйте IClock через DI
class Service {
  constructor(private readonly clock: IClock) {}

  doSomething(): void {
    const now = this.clock.now(); // ✅
  }
}

// 2. Обновляйте ReplayClock ПЕРЕД обработкой
events.forEach((event) => {
  replayClock.update(event.timestamp); // ✅ Сначала обновить
  processEvent(event);
});

// 3. Используйте PaperClock в тестах
it('test', () => {
  const clock = new PaperClock(new Date('2024-01-01')); // ✅
  const service = new Service(clock);
});
```

### ❌ Неправильно

```typescript
// 1. НЕ создавайте Date напрямую в бизнес-логике
class Service {
  doSomething(): void {
    const now = new Date(); // ❌ Недетерминировано
  }
}

// 2. НЕ обновляйте ReplayClock после обработки
events.forEach((event) => {
  processEvent(event); // ❌ Время еще не обновлено!
  replayClock.update(event.timestamp);
});

// 3. НЕ используйте LiveClock в тестах
it('test', () => {
  const clock = new LiveClock(); // ❌ Недетерминировано
});
```
