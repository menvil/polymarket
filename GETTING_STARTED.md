# 🚀 Getting Started with Polymarket MM Bot v3

## ✅ Проект успешно настроен!

Базовая структура создана по DDD архитектуре. Все зависимости установлены и работают.

## 📋 Что уже сделано

### 1. Структура проекта
- ✅ DDD архитектура (Domain, Application, Infrastructure, Bootstrap)
- ✅ Модульная система с четким разделением ответственности
- ✅ TypeScript с строгими типами и ESM модулями
- ✅ Поддержка hot-reload для разработки

### 2. Конфигурация
- ✅ TradingConfig - все параметры торговли из CONFIG
- ✅ EnvConfig - переменные окружения
- ✅ ConfigLoader - единая точка доступа к конфигу

### 3. Dependency Injection
- ✅ Легковесный DI контейнер
- ✅ Поддержка singleton и transient сервисов
- ✅ Система providers для регистрации

### 4. Документация
- ✅ Все модули с TSDoc комментариями
- ✅ @param, @returns, @throws, @example, @remarks

## 🎯 Команды для запуска

```bash
# Development режим с hot-reload
npm run dev

# Development с отладчиком
npm run dev:inspect

# Проверка типов
npm run type-check

# Запуск тестов
npm test

# Build для production
npm run build

# Production запуск
npm start
```

## 🔥 Горячая перезагрузка работает!

При изменении любого `.ts` файла приложение автоматически перезапустится:

```bash
npm run dev
# Измените любой файл в src/ - приложение перезапустится
```

## 📝 Следующие шаги

### 1. Начните рефакторинг монолитного кода

Ваш файл `polymarket-mm-bot-v3.js` (3600+ строк) нужно разбить на модули:

#### Доменный слой (Domain)
```typescript
// Value Objects
src/domain/value-objects/Price.ts
src/domain/value-objects/Quantity.ts
src/domain/value-objects/Money.ts
src/domain/value-objects/Spread.ts

// Entities
src/domain/entities/Order.ts
src/domain/entities/Position.ts
src/domain/entities/Market.ts
src/domain/entities/Portfolio.ts

// Domain Services
src/domain/services/pricing/FairValueService.ts
src/domain/services/pricing/MicropriceCalculator.ts
src/domain/services/risk/RiskAssessmentService.ts
src/domain/services/inventory/PositionTracker.ts

// Strategies
src/domain/strategies/TwoSidedMarketMaker.ts
src/domain/strategies/InventorySkewStrategy.ts
src/domain/strategies/UnwindStrategy.ts
```

#### Application слой
```typescript
// Commands
src/application/usecases/commands/PlaceOrderCommand.ts
src/application/usecases/commands/CancelOrderCommand.ts

// Handlers
src/application/usecases/handlers/PlaceOrderHandler.ts
src/application/usecases/handlers/QuoteGenerationHandler.ts

// Orchestrators
src/application/orchestrators/MainTradingOrchestrator.ts
```

#### Infrastructure слой
```typescript
// Exchange adapters
src/infrastructure/exchange/adapters/PolymarketRestAdapter.ts
src/infrastructure/exchange/adapters/PolymarketWsAdapter.ts

// Logging
src/infrastructure/logging/ConsoleLogger.ts
src/infrastructure/logging/FileLogger.ts

// UI
src/infrastructure/ui/implementations/BlessedTradingUI.ts
```

### 2. Пример миграции функции

**Было (монолит):**
```javascript
function calculateFairValue(orderbook) {
  const mid = (orderbook.bestBid + orderbook.bestAsk) / 2;
  // ... 100 строк кода
  return fairValue;
}
```

**Стало (DDD):**
```typescript
// src/domain/services/pricing/FairValueService.ts
export class FairValueService {
  /**
   * Calculates fair value for a token
   * 
   * @param orderbook - Current orderbook snapshot
   * @returns Fair value price
   * 
   * @remarks
   * Algorithm:
   * 1. Calculate mid price
   * 2. Calculate microprice (weighted by depth)
   * 3. Apply EMA smoothing
   * 4. Combine with configured weights
   */
  calculateFairValue(orderbook: OrderBook): Price {
    // Implementation
  }
}
```

### 3. Приоритет миграции (рекомендуемый порядок)

1. **Value Objects** (Price, Quantity, Money) - базовые типы
2. **Entities** (Order, Position, Market) - бизнес-сущности
3. **Domain Services** (FairValue, RiskAssessment) - логика
4. **Strategies** (MarketMaking, Unwind) - стратегии
5. **Application Handlers** (PlaceOrder, CancelOrder) - use cases
6. **Infrastructure** (Exchange, Logging, UI) - адаптеры

### 4. Пример рефакторинга одной функции

Давайте начнем с малого - перенесем функцию `calculateFairValue`:

```bash
# 1. Создайте файл
touch src/domain/services/pricing/FairValueService.ts

# 2. Добавьте типы
touch src/shared/types/trading.ts

# 3. Создайте Value Object для Price
touch src/domain/value-objects/Price.ts

# 4. Напишите unit-тест
touch tests/unit/domain/services/pricing/FairValueService.test.ts
```

### 5. Интеграция с существующим кодом

Вы можете постепенно мигрировать, используя оба подхода одновременно:

```typescript
// В старом коде
import { FairValueService } from './src/domain/services/pricing/FairValueService.js';

const fairValueService = new FairValueService(config);
const fairValue = fairValueService.calculate(orderbook);
```

## 🧪 Тестирование

Создавайте тесты параллельно с кодом:

```typescript
// tests/unit/domain/services/pricing/FairValueService.test.ts
import { FairValueService } from '@domain/services/pricing/FairValueService';

describe('FairValueService', () => {
  it('should calculate fair value correctly', () => {
    const service = new FairValueService();
    const result = service.calculate(mockOrderbook);
    expect(result.value).toBe(0.5);
  });
});
```

## 📚 Полезные ресурсы

- TypeScript ESM: https://nodejs.org/api/esm.html
- DDD в TypeScript: https://khalilstemmler.com/articles/categories/domain-driven-design/
- Testing с Jest: https://jestjs.io/docs/getting-started

## 🆘 Помощь

Если нужна помощь с рефакторингом конкретной части кода, дайте знать!

---

**Готово к работе! 🎉**

Начните с малого - выберите одну простую функцию и мигрируйте её в новую архитектуру.
Постепенно перенесете весь код, тестируя каждый шаг.
