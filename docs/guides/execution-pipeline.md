# Execution Pipeline

## Overview

Execution Pipeline - это координированный поток выполнения ордеров от создания intent до размещения на бирже.

**Архитектура**: Order Intent → Normalize → Validate → Execute → Result

## Компоненты

### 1. ExecutionService (Координатор)

**Путь**: `src/application/execution/ExecutionService.ts`

**Ответственность**: Координирует весь execution pipeline (НЕ принимает решений)

**Алгоритм**:
1. Получить ValidationContext (HTTP: market constraints, balance, position)
2. Нормализовать order intent (округление по ticks)
3. Валидировать normalized order (size, price, balance, position limits)
4. Разместить ордер через gateway (HTTP к бирже)
5. Вернуть результат (Ok, REJECTED, или FAILED)

**Пример**:
```typescript
const executionService = new ExecutionService(
  intentNormalizer,
  validationPipeline,
  contextProvider,
  tradingGateway,
  logger
);

// Strategy создает order intent (может быть НЕ normalized)
const orderIntent = Order.create({
  id: generateId(),
  tokenId: 'token-yes',
  side: 'BUY',
  price: Price.fromNumber(0.567),  // Будет rounded → 0.57
  size: Quantity.fromNumber(100.123), // Будет rounded → 100.12
  status: 'PENDING',
  timestamp: new Date(),
});

const result = await executionService.placeOrder(orderIntent);

if (result.ok) {
  console.log('Order placed:', result.value.id);
} else if (result.error.kind === 'REJECTED') {
  // Локальная ошибка validation (intent был неправильный)
  console.error('Validation failed:', result.error.error.type);
} else if (result.error.kind === 'FAILED') {
  // Биржа отказала или network error
  console.error('Exchange error:', result.error.error.type);
}
```

### 2. IntentNormalizer (Чистая функция)

**Путь**: `src/application/execution/IntentNormalizer.ts`

**Ответственность**: Округляет size и price по market constraints (NO IO)

**Алгоритм**:
- Округление size по `sizeTick` (banker's rounding)
- Округление price по `priceTick` (banker's rounding)
- Возвращает NormalizationResult с diff (если был normalized)

**Пример**:
```typescript
const normalizer = new IntentNormalizer();

const result = normalizer.normalize(orderIntent, marketConstraints);

if (result.wasNormalized) {
  console.log('Original:', result.diff.originalSize, result.diff.originalPrice);
  console.log('Normalized:', result.diff.normalizedSize, result.diff.normalizedPrice);
}
```

### 3. ValidationPipeline (Чистая функция)

**Путь**: `src/application/execution/ValidationPipeline.ts`

**Ответственность**: Валидирует order (NO IO)

**Проверки**:
1. Size constraints (minOrderSize ≤ size ≤ maxOrderSize)
2. Price constraints (minPrice ≤ price ≤ maxPrice)
3. Balance check (достаточно ли USDC для BUY или tokens для SELL)
4. Position limits (не превышает ли позиция MAX_NET_POSITION)

**Пример**:
```typescript
const pipeline = new ValidationPipeline(logger);

const result = pipeline.validate(normalizedOrder, validationContext);

if (!result.ok) {
  console.error('Validation failed:', result.error.type);
  // ValidationError types:
  // - INVALID_SIZE: size вне допустимого диапазона
  // - INVALID_PRICE: price вне допустимого диапазона
  // - INSUFFICIENT_BALANCE: не хватает USDC или tokens
  // - POSITION_LIMIT_EXCEEDED: превышен лимит позиции
}
```

### 4. ValidationContextProvider (IO слой)

**Путь**: `src/application/execution/ValidationContextProvider.ts`

**Ответственность**: Получает ValidationContext (делает HTTP)

**Источники данных**:
- `MarketConstraintsPolicy`: minOrderSize, maxOrderSize, sizeTick (HTTP или cache)
- `IBalanceProvider`: доступный USDC баланс (HTTP)
- `IPositionProvider`: текущая позиция и лимит (HTTP)

**Пример**:
```typescript
const contextProvider = new ValidationContextProvider(
  marketConstraintsPolicy,
  balanceProvider,
  positionProvider,
  logger
);

// Делает 3 параллельных HTTP запроса
const context = await contextProvider.getContext(tokenId);

// context: {
//   balance: 1000.50,
//   marketConstraints: { minOrderSize: 10, maxOrderSize: 1000, sizeTick: 0.01, priceTick: 0.01 },
//   positionState: { currentPosition: 0, positionLimit: 5000 },
//   timestamp: Date
// }
```

### 5. PolymarketTradingGateway (HTTP слой)

**Путь**: `src/infrastructure/exchange/gateways/PolymarketTradingGateway.ts`

**Ответственность**: Тупой gateway к бирже (НЕТ decisions)

**Методы**:
- `placeOrder(order)`: Domain Order → API params → HTTP POST → Domain Order
- `cancelOrder(orderId)`: HTTP DELETE
- `getOpenOrders(tokenId?)`: HTTP GET → Domain Order[]

**Пример**:
```typescript
const gateway = new PolymarketTradingGateway(clobClient, logger);

const result = await gateway.placeOrder(normalizedOrder);

if (!result.ok) {
  // ExchangeError types:
  // - RATE_LIMITED: HTTP 429
  // - AUTH_FAILED: HTTP 401/403
  // - MARKET_CLOSED: market неактивен
  // - ORDER_NOT_FOUND: HTTP 404
  // - SERVER_ERROR: HTTP 5xx
  // - NETWORK_ERROR: timeout, connection refused
  // - FATAL: неизвестная ошибка
}
```

## Error Handling

### Два типа ошибок

#### ValidationError (REJECTED)
**Когда**: Локальная ошибка ДО HTTP запроса
**Значение**: "Стратегия ошиблась" (intent был неправильный)
**Типы**:
- `INVALID_SIZE`: size вне допустимого диапазона
- `INVALID_PRICE`: price вне допустимого диапазона
- `INSUFFICIENT_BALANCE`: не хватает баланса
- `POSITION_LIMIT_EXCEEDED`: превышен лимит позиции

**Реакция стратегии**: Исправить параметры, НЕ retry

#### ExchangeError (FAILED)
**Когда**: Ошибка ОТ биржи или network layer ПОСЛЕ HTTP запроса
**Значение**: "Мир сломан" (биржа/сеть не работает)
**Типы**:
- `RATE_LIMITED`: биржа throttle, подождать retryAfter секунд
- `AUTH_FAILED`: неправильные credentials
- `MARKET_CLOSED`: market неактивен
- `ORDER_NOT_FOUND`: ордер не найден (уже отменён/исполнен)
- `SERVER_ERROR`: временная проблема биржи (retry с backoff)
- `NETWORK_ERROR`: timeout, connection refused
- `FATAL`: неизвестная ошибка (требует manual investigation)

**Реакция стратегии**: Retry (для RATE_LIMITED, SERVER_ERROR, NETWORK_ERROR) или переключиться на другую биржу

### Пример обработки

```typescript
const result = await executionService.placeOrder(orderIntent);

if (!result.ok) {
  if (result.error.kind === 'REJECTED') {
    // ValidationError - локальная ошибка
    const error = result.error.error;

    if (error.type === 'INSUFFICIENT_BALANCE') {
      console.log(`Need ${error.required} USDC, but only ${error.available} available`);
      // НЕ retry - исправить стратегию
    }
  } else if (result.error.kind === 'FAILED') {
    // ExchangeError - внешняя ошибка
    const error = result.error.error;

    if (error.type === 'RATE_LIMITED') {
      console.log(`Rate limited, retry after ${error.retryAfter}s`);
      await sleep(error.retryAfter * 1000);
      // Retry
    } else if (error.type === 'FATAL') {
      console.error('Fatal error, stop strategy');
      strategy.stop();
      alertDeveloper(error);
    }
  }
}
```

## Dependency Injection

Все компоненты зарегистрированы в DI container (`src/bootstrap/dependency-injection/providers.ts`):

```typescript
// Pure functions (stateless)
container.registerSingleton('intentNormalizer', () => new IntentNormalizer());
container.registerSingleton('validationPipeline', () => new ValidationPipeline(logger));

// IO providers
container.registerSingleton('balanceProvider', () =>
  new BalanceProvider(balanceClient, logger)
);
container.registerSingleton('positionProvider', () =>
  new PositionProvider(positionClient, logger, MAX_NET_POSITION)
);

// Context provider
container.registerSingleton('validationContextProvider', () =>
  new ValidationContextProvider(
    marketConstraintsPolicy,
    balanceProvider,
    positionProvider,
    logger
  )
);

// Gateway
container.registerSingleton('tradingGateway', () =>
  new PolymarketTradingGateway(clobClient, logger)
);

// Координатор
container.registerSingleton('executionService', () =>
  new ExecutionService(
    intentNormalizer,
    validationPipeline,
    contextProvider,
    tradingGateway,
    logger
  )
);
```

## Архитектурные решения

### Почему ExecutionService НЕ принимает решений?

**Проблема**: Если ExecutionService содержит retry logic, throttling, или multi-exchange routing, он становится нетестируемым и негибким.

**Решение**: ExecutionService - это координатор (orchestrator), а не decision maker.

**Что НЕ в ExecutionService**:
- ❌ Retry strategies (это upstream responsibility - DecisionLayer)
- ❌ Multi-exchange routing (это upstream)
- ❌ Throttling/batching (это upstream)
- ❌ Circuit breaker (это upstream)

**Что ЕСТЬ в ExecutionService**:
- ✅ Координация pipeline (normalize → validate → execute)
- ✅ Преобразование между слоями (Domain ↔ Infrastructure)
- ✅ Логирование execution flow
- ✅ Возврат PlaceOrderResult (Ok, REJECTED, FAILED)

### Почему ValidationPipeline отделён от ValidationContextProvider?

**Проблема**: Если ValidationPipeline делает HTTP запросы, его невозможно протестировать как чистую функцию.

**Решение**: Разделить на:
- **ValidationPipeline**: чистая функция (детерминированная, NO IO)
- **ValidationContextProvider**: IO слой (HTTP, async state)

**Преимущества**:
- ValidationPipeline легко тестировать (без mocks)
- Легко заменить источник данных (backtest, simulation)
- Детерминированное поведение (одинаковый input → одинаковый output)

### Почему нормализация происходит ДО validation?

**Проблема**: Если валидировать ненормализованный order, validation может ложно отклонить валидный intent.

**Пример**:
- Intent: size = 100.123, sizeTick = 0.01, minOrderSize = 10
- Ненормализованный: 100.123 (не кратно 0.01) → validation failed ❌
- Normalized: 100.12 (кратно 0.01) → validation passed ✅

**Решение**: Normalize → Validate → Execute

## Тестирование

### Unit тесты

**Чистые функции** (NO mocks):
```typescript
// IntentNormalizer
test('should round size to sizeTick', () => {
  const result = normalizer.normalize(orderIntent, { sizeTick: 0.01 });
  expect(result.order.size.value).toBe(100.12);
});

// ValidationPipeline
test('should reject insufficient balance', () => {
  const context = { balance: 40, marketConstraints, positionState };
  const result = pipeline.validate(order, context);
  expect(result.error.type).toBe('INSUFFICIENT_BALANCE');
});
```

### Integration тесты

**С mocks для IO**:
```typescript
test('should execute full pipeline', async () => {
  // Mock gateway
  mockGateway.placeOrderFn.mockResolvedValue(Ok(placedOrder));

  const result = await executionService.placeOrder(orderIntent);

  expect(result.ok).toBe(true);
  expect(mockGateway.placeOrderFn).toHaveBeenCalledWith(normalizedOrder);
});
```

## Дальнейшая работа

### Что дальше?

1. **Decision Layer** (выше ExecutionService):
   - RetryPolicy: retry strategies с exponential backoff
   - ThrottlingPolicy: rate limiting для избежания 429
   - ExchangeRouter: multi-exchange routing
   - CircuitBreaker: fail-fast при проблемах с биржей

2. **Backtest поддержка**:
   - BacktestValidationContextProvider: исторические данные вместо HTTP
   - BacktestGateway: симуляция вместо реальных ордеров

3. **Monitoring**:
   - Metrics: успешность ордеров, latency, rejection rate
   - Alerts: FATAL errors, high rejection rate, circuit breaker открыт

## Резюме

**Execution Pipeline** = Детерминированный, тестируемый, расширяемый поток выполнения ордеров.

**Ключевые принципы**:
- Separation of Concerns (IO отделено от pure functions)
- Railway-oriented Programming (Result<T, E> для явного error handling)
- No Business Logic в coordinators (decision logic выше ExecutionService)
- Dependency Injection (легко заменить implementation)
- Type Safety (ValidationError vs ExchangeError на уровне типов)

---

📌 **Все TSDoc комментарии актуальны и синхронизированы с кодом** (обновлено: {{ DATE }})
