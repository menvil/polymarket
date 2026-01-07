# Market Rotation Manager

> **⚠️ DEPRECATED**
>
> `MarketRotationManager` устарел и заменён на `MultiMarketTrader`.
>
> **Причина:** MarketRotationManager поддерживает только ОДИН активный маркет.
> Для одновременной торговли на нескольких маркетах используйте `MultiMarketTrader`.
>
> **См.:** [Multi-Market Trading](./multi-market-trading.md)
>
> Этот документ сохранён для справки.

---

## Обзор

**MarketRotationManager** - компонент для непрерывного сканирования маркетов и автоматического переключения на следующий маркет при истечении текущего.

**Файл**: `src/application/services/MarketRotationManager.ts`

## Архитектура

```
┌─────────────────────────────────────────────────────┐
│                 MarketRotationManager               │
│  ┌───────────────┐    ┌────────────────────────┐   │
│  │ ScanLoop      │───▶│ candidates: Market[]   │   │
│  │ (30s pause)   │    │ currentMarket: Market  │   │
│  └───────────────┘    └────────────────────────┘   │
│          │                       │                  │
│          ▼                       ▼                  │
│  ┌───────────────┐    ┌────────────────────────┐   │
│  │ MarketDiscovery│   │ switchToNextMarket()   │   │
│  │ Service        │   │ - stop orchestrator    │   │
│  └───────────────┘    │ - select next market   │   │
│                       │ - reinitialize         │   │
│                       │ - start orchestrator   │   │
│                       └────────────────────────┘   │
│          │                                          │
│          ▼                                          │
│  ┌───────────────┐                                  │
│  │ ExpiryCheck   │ ─── каждую секунду проверяет    │
│  │ (1s interval) │     isExpired() на текущем      │
│  └───────────────┘     маркете                      │
└─────────────────────────────────────────────────────┘
```

## Алгоритм работы

### 1. Scan Loop (непрерывное сканирование)

```
LOOP:
  1. Вызвать marketDiscovery.findBestMarket()
  2. Обновить this.candidates = result.candidates
  3. Логировать: "Scan complete: found N candidates"
  4. Ждать 30 секунд (MARKET_SCAN_PAUSE_MS)
  5. GOTO LOOP
```

### 2. Expiry Check (проверка истечения)

```
Каждую 1 секунду (MARKET_EXPIRY_CHECK_INTERVAL_MS):
  1. Проверить currentMarket.isExpired()
  2. Если маркет истёк:
     - Логировать: "Market expired, switching to next..."
     - Вызвать switchToNextMarket()
  3. Иначе - продолжать торговать на текущем маркете
```

**ВАЖНО**: Переключение происходит **ТОЛЬКО после истечения** маркета, не заранее!

### 3. Switch to Next Market

```
1. Остановить торговлю: orchestrator.stop()
2. Выбрать следующий маркет из candidates (исключая текущий/истёкший)
3. Если нет кандидатов:
   - Запустить экстренное сканирование (без ожидания 30 сек)
   - Если всё равно нет - ошибка, ждать и повторять
4. Создать новый Market entity
5. Переинициализировать: orchestrator.initialize(newMarket)
6. Запустить: orchestrator.start()
7. Обновить this.currentMarket
8. Логировать: "Switched to market: {question}"
```

## Конфигурация

### Переменные окружения (.env)

```bash
# Market Rotation Configuration
# Пауза между сканированиями (после завершения предыдущего)
MARKET_SCAN_PAUSE_MS=30000      # 30 секунд (по умолчанию)

# Интервал проверки истечения маркета
MARKET_EXPIRY_CHECK_INTERVAL_MS=1000   # 1 секунда (по умолчанию)
```

### Интерфейс конфигурации

```typescript
interface MarketRotationConfig {
  /** Пауза между сканированиями (мс) */
  scanPauseMs: number;

  /** Интервал проверки истечения маркета (мс) */
  expiryCheckIntervalMs: number;
}
```

## Использование

### Базовый пример

```typescript
import { MarketRotationManager } from './application/services/MarketRotationManager';
import { MarketDiscoveryService } from './domain/services/market-discovery';
import { MainTradingOrchestrator } from './application/orchestrators/MainTradingOrchestrator';

// Создание компонентов
const marketDiscovery = new MarketDiscoveryService(apiClient, config, logger);
const orchestrator = container.resolve<MainTradingOrchestrator>('orchestrator');

// Создание MarketRotationManager
const rotationManager = new MarketRotationManager(
  marketDiscovery,
  orchestrator,
  logger,
  {
    scanPauseMs: 30000,           // 30 секунд пауза между сканами
    expiryCheckIntervalMs: 1000,  // Проверка каждую секунду
  }
);

// Запуск с начальным маркетом
await rotationManager.start(initialMarket, initialBalance);

// Graceful shutdown
process.on('SIGINT', async () => {
  await rotationManager.stop();
  process.exit(0);
});
```

### Интеграция в main.ts

```typescript
// В bootstrap функции

// 1. Найти начальный маркет
const discoveryResult = await marketDiscovery.findBestMarket();
const tradingMarket = Market.create({
  id: selectedMarket.conditionId,
  question: selectedMarket.question,
  // ...
});

// 2. Создать rotation manager
rotationManager = new MarketRotationManager(
  marketDiscovery,
  orchestrator,
  logger,
  {
    scanPauseMs: env.MARKET_SCAN_PAUSE_MS,
    expiryCheckIntervalMs: env.MARKET_EXPIRY_CHECK_INTERVAL_MS,
  }
);

// 3. Запустить с ротацией
await rotationManager.start(tradingMarket, initialBalance);

// 4. Graceful shutdown
async function shutdown(): Promise<void> {
  if (rotationManager) {
    await rotationManager.stop();
  }
}
```

## API

### Методы

```typescript
class MarketRotationManager {
  /**
   * Запускает MarketRotationManager
   *
   * @param initialMarket - Начальный маркет для торговли
   * @param initialBalance - Начальный баланс
   */
  async start(initialMarket: Market, initialBalance: Money): Promise<void>;

  /**
   * Останавливает MarketRotationManager
   * - Останавливает scan loop
   * - Останавливает expiry check
   * - Останавливает orchestrator
   */
  async stop(): Promise<void>;

  /**
   * Возвращает текущий маркет
   */
  getCurrentMarket(): Market | null;

  /**
   * Возвращает список кандидатов (копию)
   */
  getCandidates(): MarketCandidate[];
}
```

## Логирование

```
[INFO] Starting MarketRotationManager
[INFO] MarketRotationManager started (market: "Bitcoin Up or Down...", expiresAt: 2025-12-28T20:15:00Z)

[DEBUG] Starting market scan...
[INFO] Market scan complete (totalFetched: 450, totalFiltered: 33, candidatesCount: 5, bestMarket: "...")

[DEBUG] Time to market expiry (secondsLeft: 60, minutesLeft: 1)

[WARN] Current market has expired! (market: "...", expiredAt: 2025-12-28T20:15:00Z)
[INFO] Switching to next market...
[INFO] Successfully switched to new market (market: "...", expiresAt: ..., timeToExpiry: "15m30s")

[WARN] No candidates available, performing emergency scan...
[ERROR] No valid markets found after emergency scan!

[INFO] Stopping MarketRotationManager
[INFO] MarketRotationManager stopped
```

## Диаграмма состояний

```
┌─────────────┐
│   STOPPED   │
└──────┬──────┘
       │ start()
       ▼
┌─────────────┐     isExpired()     ┌─────────────┐
│   RUNNING   │ ───────────────────▶│  SWITCHING  │
│             │                     │             │
│ - scan loop │                     │ - stop orch │
│ - expiry    │◀────────────────────│ - select    │
│   check     │    switch complete  │ - start     │
└──────┬──────┘                     └─────────────┘
       │ stop()
       ▼
┌─────────────┐
│   STOPPED   │
└─────────────┘
```

## Особенности реализации

### 1. Защита от параллельного переключения

```typescript
private isSwitching = false;

private async switchToNextMarket(): Promise<void> {
  if (this.isSwitching) {
    this.logger.warn('Already switching markets, skipping...');
    return;
  }

  this.isSwitching = true;
  try {
    // ... логика переключения
  } finally {
    this.isSwitching = false;
  }
}
```

### 2. Рекурсивный retry при отсутствии маркетов

```typescript
if (!nextCandidate) {
  this.logger.error('No valid markets found after emergency scan!');
  await this.sleep(30000);  // Ждём 30 секунд
  this.isSwitching = false;
  return this.switchToNextMarket();  // Рекурсивный retry
}
```

### 3. Выбор следующего маркета

```typescript
private selectNextMarket(): MarketCandidate | null {
  const now = Date.now();

  // Исключаем текущий маркет и уже истёкшие
  const validCandidates = this.candidates.filter((c) => {
    if (this.currentMarketCandidate &&
        c.conditionId === this.currentMarketCandidate.conditionId) {
      return false;  // Исключаем текущий
    }
    if (c.endDate.getTime() <= now) {
      return false;  // Исключаем истёкшие
    }
    return true;
  });

  // Первый кандидат (уже отсортирован по времени)
  return validCandidates[0] || null;
}
```

## Связь с другими компонентами

```
┌─────────────────────────────────────────────────────────────┐
│                         main.ts                              │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              MarketRotationManager                   │   │
│  │                                                      │   │
│  │  ┌──────────────────┐   ┌────────────────────────┐  │   │
│  │  │MarketDiscovery   │   │MainTradingOrchestrator │  │   │
│  │  │Service           │   │                        │  │   │
│  │  │                  │   │  - initialize()        │  │   │
│  │  │  - findBestMarket│   │  - start()             │  │   │
│  │  │                  │   │  - stop()              │  │   │
│  │  └──────────────────┘   └────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                    EnvConfig                         │   │
│  │  - MARKET_SCAN_PAUSE_MS                              │   │
│  │  - MARKET_EXPIRY_CHECK_INTERVAL_MS                   │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Тестирование

```typescript
describe('MarketRotationManager', () => {
  it('should start with initial market', async () => {
    const manager = new MarketRotationManager(
      mockDiscovery, mockOrchestrator, mockLogger, config
    );

    await manager.start(mockMarket, mockBalance);

    expect(mockOrchestrator.initialize).toHaveBeenCalledWith(mockMarket, mockBalance);
    expect(mockOrchestrator.start).toHaveBeenCalled();
    expect(manager.getCurrentMarket()).toBe(mockMarket);
  });

  it('should switch when market expires', async () => {
    // ... тест на переключение
  });

  it('should perform emergency scan when no candidates', async () => {
    // ... тест на экстренное сканирование
  });
});
```

## Заключение

**MarketRotationManager** обеспечивает:

- ✅ Непрерывное сканирование маркетов в фоне
- ✅ Автоматическое переключение при истечении маркета
- ✅ Экстренное сканирование при отсутствии кандидатов
- ✅ Graceful shutdown
- ✅ Настройка через .env

Компонент является ключевым для автономной работы бота без ручного вмешательства при смене маркетов.