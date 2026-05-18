# Order Book Wall Strategy

## Идея

Стратегия использует анализ глубины стакана CEX-биржи (Binance/Coinbase/OKX) для прогнозирования направления движения цены на Polymarket.

**Два ключевых сценария:**
- **Пробой (Breakout)**: стенка в стакане (уровень с аномальным объёмом) активно поглощается трейдами → цена пробивает уровень → Polymarket отреагирует следом.
- **Отбой (Rejection)**: цена подходит к стенке, трейды останавливаются → стенка держится → цена откатывает назад.

---

## Архитектура

```
StrategySnapshot (cryptoVenueHistory)
    │
    ▼
WallDetector            ← stateless, детектирует стенки в текущем снапшоте книги
    │
    ▼
ConsumptionTracker      ← stateful, хранит историю стенок и объём трейдов по ним
    │
    ▼
WallSignalComputer      ← stateless, классифицирует сигнал
    │
    ▼
OrderBookWallStrategy   ← BaseStrategy, BUY/SELL/HOLD решения
    │
    ▼
StrategyIntent[] → ExecutionEngine
```

---

## Алгоритм пошагово

### Шаг 1: WallDetector — обнаружение стенок

1. Берём текущий снапшот стакана (`CexBookTick.bids` / `.asks`).
2. Вычисляем `mid = (bestBid + bestAsk) / 2`.
3. Разбиваем уровни на **бэнды** шириной `bandSizePct × mid`.
4. Суммируем объём в каждом бэнде.
5. Находим **выбросы**: бэнды с объёмом > `mean × wallThresholdFactor` И >= `minWallSize`.
6. Возвращаем список `DetectedWall[]`.

**Важно**: размер уровней в CEX-данных — в базовой валюте (BTC для BTC-USD).
Параметр `bandSizePct` должен быть очень маленьким (0.00005), чтобы каждый уровень
попал в свой бэнд (реальная книга имеет ~50 уровней в диапазоне $25).

```
Пример: Coinbase BTC $80 000, band = 0.005% = $4
50 уровней в диапазоне $79 999 — $80 024
Крупный уровень 1.1 BTC при среднем 0.115 BTC → ratio 9.54× → СТЕНКА BID
```

### Шаг 2: ConsumptionTracker — отслеживание поглощения

Для каждой стенки хранится:
- `initialSize` — объём при первом обнаружении
- `currentSize` — объём на последнем тике
- `tradeVolumeInWindow` — объём трейдов в скользящем окне `consumptionWindowMs`
- `recentTradeVolume` — объём трейдов в коротком окне `recentWindowMs` (для детекции замедления)

**absorptionRatio** = `(initialSize - currentSize) / initialSize`
- 0.0 = стенка нетронута
- 1.0 = стенка полностью поглощена

**Защита от spoofing:** Стенка не учитывается пока её возраст < `minWallAgeMs`.

### Шаг 3: WallSignalComputer — классификация (Rejection-first)

Основная стратегия — **отбой (rejection)**. BREAKOUT используется только для выхода.

**Условия сигнала REJECTION** (все три одновременно):
1. **Wall intact**: `absorptionRatio < rejectionMaxAbsorption` (стенка цела на 80%+)
2. **Price tested**: `tradeVolumeInWindow >= minWallTestVolume` (цена тестировала уровень)
3. **Flow decelerated**: `recentRate < historicRate × flowDecelerationFactor` (поток упал)

```
historicRate = tradeVolumeInWindow / windowMs      (BTC/ms за полное окно)
recentRate   = recentTradeVolume / recentWindowMs  (BTC/ms за короткое окно)
```

| Сигнал | Условие | Интерпретация |
|--------|---------|---------------|
| `REJECTION_DOWN` | BID-стенка держится + поток упал | Поддержка устояла → цена вверх → BUY UP |
| `REJECTION_UP` | ASK-стенка держится + поток упал | Сопротивление устояло → цена вниз → BUY DOWN |
| `BREAKOUT_DOWN` | BID-стенка: absorptionRatio >= 0.5 | Поддержка пробита → цена вниз (сигнал выхода для UP) |
| `BREAKOUT_UP` | ASK-стенка: absorptionRatio >= 0.5 | Сопротивление пробито → цена вверх (сигнал выхода для DOWN) |
| `NEUTRAL` | Нет чёткого сигнала | Ждём |

**Сила сигнала** = `wallPower × intactScore × decelerationScore`
- `wallPower = clamp(densityFactor / 10, 0, 1)`
- `intactScore = 1 - absorptionRatio / rejectionMaxAbsorption`
- `decelerationScore = clamp(1 - flowRatio / flowDecelerationFactor, 0, 1)`

### Шаг 4: OrderBookWallStrategy — торговые решения

**BUY** (вход):
- Нет открытой позиции, нет in-flight fills, кулдаун после выхода прошёл (20 сек)
- UP: сигнал = `REJECTION_DOWN`; DOWN: сигнал = `REJECTION_UP`
- `strength >= minSignalStrength`
- `fairCents - midCents >= minEdgeCents`
- `availableUsdc >= orderSize`
- Цена входа = GBM fair value (binaryUpProbability)

**SELL** (выход по 3 причинам):
1. **Стоп-лосс**: `ewmaMid < entryPrice - stopLossCents` и нет открытого SELL
2. **Тайм-аут**: позиция держится > `holdMaxMs` и нет открытого SELL
3. **Разворот**: противоположный сигнал (BREAKOUT_DOWN или REJECTION_UP для UP-стороны)

**Защита от дублирования SELL**: `hasOpenSell` предотвращает двойные ордера на продажу.
Размер SELL = `positionQty` (не `availableTokenQty`, которое может быть 0 пока токены locked).
**Кулдаун после выхода**: 20 секунд без новых BUY — защита от немедленного реентри.

---

## Данные CEX

### Глубина стакана по биржам

| Биржа | Уровней | Диапазон | Пригодность |
|-------|---------|----------|-------------|
| Binance | 10 | ~$25 | Недостаточно (все в 1 бэнде) |
| Coinbase | 50 | ~$25 | **Рекомендована** (max/mean = 9.5×) |
| OKX | 10 | ~$25 | Недостаточно |

Coinbase предпочтительна: 50 уровней дают достаточную глубину для статистической детекции.

### Формат файлов (сайдкары)

```
data/live-recordings-cll/cex/2026-05-04/coinbase/
  coinbase_BTC-USD_spot_2026-May-04_100PM-105PM_ET.jsonl.gz
```

Формат события:
```json
{"t":"ob","ts":1777914000072,"bids":[[price,size],...],"asks":[[price,size],...]}
{"t":"trade","ts":1777914001234,"price":80015.5,"size":0.01,"side":"buy"}
```

---

## Конфигурация

```json
{
  "strategyParams": {
    "side": "up",                    // "up" или "down"
    "orderSize": 5,                  // токенов на ордер
    "venue": "coinbase",             // CEX-биржа (coinbase рекомендована — 50 уровней)
    "lookbackMs": 60000,             // окно истории стакана (мс)
    "bandSizePct": 0.00005,          // ширина бэнда (0.005% — очень маленькая для CEX-книги)
    "wallThresholdFactor": 2.0,      // минимум ×mean для стенки
    "minWallSize": 0.3,              // минимальный объём стенки в BTC
    "minWallAgeMs": 3000,            // минимальный возраст стенки (мс)
    "consumptionWindowMs": 30000,    // полное окно трекинга трейдов (мс)
    "recentWindowMs": 8000,          // короткое окно для детекции замедления (мс)
    "rejectionMaxAbsorption": 0.2,   // стенка должна быть > 80% целой
    "minWallTestVolume": 0.05,       // мин. объём трейдов в зоне стенки (BTC)
    "flowDecelerationFactor": 0.4,   // recentRate / historicRate < 0.4 → замедление
    "minSignalStrength": 0.3,        // минимальная сила сигнала [0..1]
    "minEdgeCents": 0,               // минимальный edge: fairCents - midCents (центы)
    "holdMaxMs": 240000,             // максимальное время удержания (4 мин)
    "stopLossCents": 5,              // стоп-лосс в центах
    "sigmaAnnual": 0.6               // волатильность для GBM fair-value
  }
}
```

---

## Результаты бэктеста (2026-05-04, первый прогон)

**Файл**: `configs/obw-btc-2026-05-04.json`
**Рынки**: 64 Bitcoin Up or Down (Coinbase venue, 0.005% bands)

| Метрика | Значение |
|---------|---------|
| Wins | 7 |
| Losses | 26 |
| Neutral (0 trades) | 31 |
| Win rate | 21.2% |
| Total PnL | -28.69 USDC |
| Total fills | 175 |
| Total cycles | 75 |
| CEX book events | 473,897 |
| CEX trade events | 64,709 |

**Проблемы v1:**
1. Сигнал срабатывает слишком часто (до 12 BUY за 5 мин)
2. Absorption-сигнал шумный с shallow order book (50 уровней в $25 диапазоне)
3. Часть рынков не торгуется (нет Chainlink цены или нет CEX данных)
4. `minSignalStrength = 0.3` слишком низкий — нужен более строгий фильтр

---

## Запуск (paper mode)

```bash
MODE=paper STRATEGY=order-book-wall CONFIG=configs/obw-paper.json npm start
```

## Запуск бэктеста

```bash
MODE=backtest CONFIG=configs/obw-btc-2026-05-04.json npm start
```

---

## Файлы

| Файл | Роль |
|------|------|
| `strategies/order-book-wall/types.ts` | Все типы: конфиг, стенки, сигналы, данные |
| `strategies/order-book-wall/WallDetector.ts` | Stateless детектор стенок |
| `strategies/order-book-wall/ConsumptionTracker.ts` | Stateful трекер поглощения |
| `strategies/order-book-wall/WallSignalComputer.ts` | Классификатор сигнала |
| `strategies/order-book-wall/OrderBookWallStrategy.ts` | Главный класс стратегии |
| `configs/obw-paper.json` | Конфиг для paper-тестирования |
| `configs/obw-btc-2026-05-04.json` | Конфиг для бэктеста (May 04 2026) |

---

## Известные ограничения и следующие шаги

1. **Shallow order book**: Binance и OKX дают только 10 уровней — для детекции нужен Coinbase (50 уровней). Альтернатива: использовать USD notional (price × size) как размер бэнда.
2. **Signal quality**: absorption-сигнал шумный; нужен фильтр по скорости поглощения и устойчивости стенки.
3. **Too many trades**: поднять `minSignalStrength` до 0.5–0.6 и добавить `maxTradesPerMarket = 3`.
4. **Multi-venue агрегация**: сейчас одна биржа — можно использовать консенсус нескольких.
5. **USD notional**: переработать `WallDetector` на notional (price × size) для унификации параметра `minWallSize`.
