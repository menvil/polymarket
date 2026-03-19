# Стратегии торгового бота

> Дата: 2026-03-17

## Обзор

Все стратегии реализуют `IStrategy` через `BaseStrategy<TSnapshot, TAction>` с pipeline:
1. `gather(snapshot)` → типизированные данные
2. `decide(data, reasons)` → domain-specific actions
3. `toIntents(actions)` → `StrategyIntent[]`

## Доступные стратегии

### DumbStrategy

**Назначение:** Smoke-тестирование всей цепочки: tick → intent → execution → fill → portfolio → tick.

**Алгоритм:**
```
Нет позиции + нет ордеров      → ENTER: BUY @ (bestAsk - buyOffset)
Нет позиции + есть BUY ордер:
  дрейф >= repriceThresholdBps  → REPRICE: CANCEL старый + BUY @ новой цене
  дрейф < threshold             → HOLD (ждём)
Есть позиция + нет SELL ордера  → EXIT: SELL @ (entryPrice + profitMargin)
Есть позиция + есть SELL ордер  → HOLD (ждём)
```

**Расчёт дрейфа:**
```
newTargetPrice = bestAsk_now - buyOffset
drift_bps      = |newTargetPrice - orderPrice| / orderPrice × 10 000
```
Если `bestAsk` не изменился → `drift = 0`. Если `bestAsk` ушёл вверх на 0.03 → `drift = 0.03/orderPrice × 10 000`.

**Конфигурация:**
| Параметр | Тип | По умолчанию | Описание |
|----------|-----|-------------|----------|
| `orderSize` | `Decimal` | `5` | Размер ордера (в токенах) |
| `buyOffset` | `Decimal` | `0.02` | Отступ ниже bestAsk для лимитки |
| `profitMargin` | `Decimal` | `0.05` | Наценка на SELL от средней цены входа |
| `repriceThresholdBps` | `number` | `50` | Порог дрейфа для перестановки (базисные пункты) |

**Пример потока:**
```
bestAsk=0.50 → BUY лимитка @ 0.48 (offset=0.02)
bestAsk=0.55 → newTarget=0.53, drift=(0.53-0.48)/0.48×10000=1042 bps > 50 → REPRICE @ 0.53
BUY исполнился @ 0.53 → позиция open
→ SELL @ 0.53+0.05 = 0.58
SELL исполнился → начинаем сначала
```

**Пример создания:**
```typescript
const dumb = new DumbStrategy({
  orderSize: new Decimal('5'),
  buyOffset: new Decimal('0.02'),
  profitMargin: new Decimal('0.05'),
  repriceThresholdBps: 50,
});
```

### SimpleMarketMaker

**Назначение:** Котирование bid/ask вокруг mid-price.

**Алгоритм:**
```
timeToExpiry < exitThreshold → CANCEL_ALL + SELL позицию
spread < minSpread           → CANCEL_ALL
нет bid/ask                  → HOLD
нормальный режим             → BUY (mid - offset) + SELL (mid + offset)
```

**Конфигурация:**
| Параметр | Тип | По умолчанию | Описание |
|----------|-----|-------------|----------|
| `spreadOffset` | `Decimal` | `0.02` | Отступ от mid для bid/ask |
| `minSpread` | `Decimal` | `0.01` | Минимальный спред для котирования |
| `orderSize` | `Decimal` | `10` | Размер каждого ордера |
| `exitThresholdMs` | `number` | `60000` | Порог экспирации для выхода (ms) |

### MomentumStrategy

**Назначение:** Следование за моментумом через анализ соотношения BUY/SELL в ленте сделок.

**Алгоритм:**
```
buyRatio > entryThreshold + нет позиции → BUY по bestAsk
buyRatio < exitThreshold + есть позиция → SELL по bestBid
иначе                                   → HOLD
```

**buyRatio** = сумма объёмов BUY / сумма всех объёмов (из TradeTape).

**Конфигурация:**
| Параметр | Тип | По умолчанию | Описание |
|----------|-----|-------------|----------|
| `entryThreshold` | `Decimal` | `0.65` | Порог buyRatio для входа |
| `exitThreshold` | `Decimal` | `0.40` | Порог buyRatio для выхода |
| `orderSize` | `Decimal` | `5` | Размер ордера |

## Запуск через apps/bot

### Переменные окружения

| Переменная | Обязательная | По умолчанию | Описание |
|-----------|-------------|-------------|----------|
| `TOKEN_ID` | ✅ | — | ID токена (outcome token, instrumentId) |
| `MARKET_ID` | ✅ | — | ID рынка (condition_id) |
| `STRATEGY` | ❌ | `market-maker` | Тип стратегии: `dumb` / `market-maker` / `momentum` |
| `ACCOUNT_ID` | ❌ | `venue:POLYMARKET:dev-account` | ID аккаунта |
| `INITIAL_BALANCE` | ❌ | `1000` | Начальный баланс USDC |
| `EXPIRATION_MS` | ❌ | `now + 24h` | Время экспирации рынка (epoch ms) |

### Команды запуска

```bash
cd apps/bot

# DumbStrategy — проверка всей цепочки
TOKEN_ID="0xabc123" MARKET_ID="0xdef456" STRATEGY=dumb \
  node --loader ts-node/esm src/main.ts

# SimpleMarketMaker
TOKEN_ID="0xabc123" MARKET_ID="0xdef456" STRATEGY=market-maker \
  INITIAL_BALANCE=5000 \
  node --loader ts-node/esm src/main.ts

# MomentumStrategy
TOKEN_ID="0xabc123" MARKET_ID="0xdef456" STRATEGY=momentum \
  node --loader ts-node/esm src/main.ts
```

### Запуск тестов

```bash
cd apps/bot
npx jest                      # все тесты
npx jest DumbStrategy         # только DumbStrategy
npx jest --coverage           # с покрытием
```

### Graceful shutdown

Бот ловит `SIGINT` (Ctrl+C) и `SIGTERM`:
1. `scheduler.unregister(strategy.id)` → `strategy.stop()` → `CANCEL_ALL`
2. Останавливает MarketDataStore и OrderEventBridge

## Фабрика стратегий

```typescript
import { createStrategy, DEFAULT_DUMB_CONFIG } from './strategyFactory.js';

const strategy = createStrategy({ type: 'dumb', params: DEFAULT_DUMB_CONFIG });
scheduler.register({ strategy, instrumentId, asset, accountId, market });
```

## Как создать свою стратегию

1. Определить `TSnapshot` (данные) и `TAction` (действия)
2. Наследовать `BaseStrategy<TSnapshot, TAction>`
3. Реализовать `gather()`, `decide()`, `toIntents()`
4. Добавить в `strategyFactory.ts`

```typescript
class MyStrategy extends BaseStrategy<MyData, MyAction> {
  readonly id = 'my-strategy-1';
  readonly name = 'MyStrategy';

  protected gather(snapshot: StrategySnapshot): MyData | undefined {
    // Извлечь нужные данные из snapshot
  }

  protected decide(data: MyData, reasons: ReadonlySet<TriggerReason>): MyAction[] {
    // Чистая логика: данные → решения
  }

  protected toIntents(actions: MyAction[]): StrategyIntent[] {
    // Конвертировать в PLACE / CANCEL / CANCEL_ALL
  }
}
```
