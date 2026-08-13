# Стратегии торгового бота

> Дата: 2026-03-23

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

**Конфигурация:**
| Параметр | Тип | По умолчанию | Описание |
|----------|-----|-------------|----------|
| `orderSize` | `Decimal` | `5` | Размер ордера в токенах |
| `buyOffsetPct` | `Decimal` | `10` | Отступ BUY от refPrice в % |
| `profitMarginPct` | `Decimal` | `5` | Наценка SELL в % |
| `repriceThreshold` | `Decimal` | `0.08` | Порог переставки в USDC |

### AvellanedaStoikovStrategy

**Назначение:** Маркет-мейкинг по модели Avellaneda-Stoikov с калиброванными параметрами из исследования на 10M трейдов Polymarket.

**Модель (logit-space):**
```
reservation_price: r_x = logit(mid) - (q/qMax) × γ × σ² × τ
optimal_spread:    δ = γ × σ² × τ + 2/κ + jump_premium
bid = sigmoid(r_x - δ/2) × 100
ask = sigmoid(r_x + δ/2) × 100
```

**Алгоритм:**
```
tradeCount < minTradesForMid → SKIP (EWMA ненадёжна)
tauSec < stagedStopSec (10s) → STOP: CANCEL_ALL
tauSec < stagedWideSec (30s) → spread × 3 (защита от экспирации)
in-flight fills              → SKIP (ждём подтверждения)
inventory at ±qMax           → не котируем перегруженную сторону
нормальный режим             → CANCEL_ALL + PLACE BUY(bid) + PLACE SELL(ask)
```

**Калибровка:**
- σ (волатильность), κ (order arrival), jump premium — per-minute-bucket
- Две таблицы: 5-минутные (6 бакетов) и 15-минутные (16 бакетов)
- Волатильность в последнюю минуту 3.8× выше чем за 5 минут до конца

**Конфигурация:**
| Параметр | Тип | По умолчанию | Описание |
|----------|-----|-------------|----------|
| `gamma` | `Decimal` | `0.05` | Risk aversion (выше → шире спреды) |
| `qMax` | `number` | `5` | Макс позиция в единицах orderSize |
| `orderSize` | `Decimal` | `10` | Размер одного ордера |
| `marketDuration` | `string` | `'5m'` | `'5m'` или `'15m'` — выбор калибровки |
| `spreadMult` | `Decimal` | `1.0` | Множитель спреда |
| `ewmaAlpha` | `number` | `0.3` | Alpha EWMA mid-price |
| `stagedWideSec` | `number` | `30` | 3× wide spread за N сек до экспирации |
| `stagedStopSec` | `number` | `10` | Полная остановка за N сек |
| `minTradesForMid` | `number` | `5` | Мин трейдов для расчёта EWMA |

**Пример конфига (JSON):**
```json
{
  "strategy": "avellaneda-stoikov",
  "strategyParams": {
    "gamma": 0.05,
    "qMax": 5,
    "orderSize": 10,
    "marketDuration": "5m"
  }
}
```

## Запуск

```bash
cd apps/bot

# Paper mode с discovery крипто-рынков
MODE=paper CONFIG=./configs/as-mm-paper-discovery.json npx tsx src/main.ts

# Backtest на собранных снапшотах
MODE=backtest CONFIG=./configs/as-mm-backtest.json npx tsx src/main.ts

# DumbStrategy для smoke-тестирования
MODE=paper CONFIG=./configs/dumb-paper-discovery.json npx tsx src/main.ts
```

## Фабрика стратегий

```typescript
import { createStrategy, DEFAULT_AS_CONFIG } from './strategyFactory.js';

const strategy = createStrategy({ type: 'avellaneda-stoikov', params: DEFAULT_AS_CONFIG });
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
