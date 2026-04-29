# Стратегии бота Polymarket

## Обзор

Бот торгует на бинарных крипто-рынках Polymarket (Bitcoin Up/Down) с таймфреймами 5 и 15 минут. Рынки создаются по Chainlink oracle: в начале фиксируется strike price (priceToBeat), в конце — settlement по текущей цене.

---

## Сводная таблица результатов (15-мин, 4 дня, ~338 рынков)

| Стратегия | PnL (total) | WR | Fills | OOS прибыльный? | Статус |
|-----------|-------------|-----|-------|-----------------|--------|
| **AdaptiveEntry** (auto UP/DOWN) | **+18.73** | 79.8% | 114 | 3/4 дня | **Лучшая** |
| **SelectiveEntry** (UP only) | **+13.75** | 69.1% | 81 | 4/4 дня | Стабильная |
| Avellaneda-Stoikov MM | -174 | ~45% | ~2000 | Нет | Не работает |
| CryptoProbStrategy | -90 (OOS) | ~55% | ~500 | Нет | Overfit |

---

## Работающие стратегии

### PairedCexCrowdStrategy

**Файл**: `src/strategies/PairedCexCrowdStrategy.ts`
**Документация**: [paired-cex-crowd.md](paired-cex-crowd.md)

Pair-aware развитие `calibrated-crowd-cex`: использует `UP/DOWN` как связанную пару,
реагирует на `no-fill` как на сигнал, умеет opportunistic switch на opposite side и
ищет `paired lock` через покупку комплементарного токена при выгодном payout spread.

### 1. AdaptiveEntryStrategy (рекомендуется)

**Файл**: `src/strategies/AdaptiveEntryStrategy.ts`
**Документация**: [adaptive-entry.md](adaptive-entry.md)

Momentum-based стратегия. На отметке 50% времени рынка принимает одноразовое решение: купить UP или DOWN (auto-selection) или пропустить. Выбирает токен с большим EWMA rise. Hold до settlement.

**Ключевые результаты (15-мин)**:
- +18.73 USDC на 252 рынках, 79.8% WR
- 3/4 дней прибыльные (btc1: -5.45, btc2: +13.71, btc4: +1.87, btc5: +8.60)
- Auto-selection: один конфиг на рынок, стратегия сама выбирает UP или DOWN

**На 5-мин**: не работает стабильно (+2.72 total, 1/4 дней прибыльный).

### 2. SelectiveEntryStrategy

**Файл**: `src/strategies/SelectiveEntryStrategy.ts`
**Документация**: [selective-entry.md](selective-entry.md)

Buy-and-hold на основе zone filter (55-68¢) и delta% (0.03-0.12%). Проверяет на каждом тике, входит при прохождении всех фильтров. Hold до settlement.

**Ключевые результаты (15-мин)**:
- +13.75 USDC на 252 рынках, 69.1% WR
- 4/4 дней прибыльные — самая стабильная
- Зависит от Chainlink delta% (требует crypto price данные)

### 3. CalibratedCrowdStrategy

**Файл**: `src/strategies/calibrated-crowd/CalibratedCrowdStrategy.ts`
**Конфиг**: `configs/cc-paper-5min.json`
**Таблица**: `tables/edge-table-5min-v9-loose.json`
**Исследование хвостов**: [calibrated-crowd-tail-zones-apr23-27.md](../research/calibrated-crowd-tail-zones-apr23-27.md)

Maker-first стратегия на основе 3D edge-таблицы `(delta, tau, regime)`. На каждом тике
вычисляет `delta = chainlink − strike` ($), `tau` (секунды до экспирации) и `regime`
(slope BTC $/min → up / flat / down), ищет зону в таблице и входит если `zone.signal`
и `zone.weights.composite ≥ minComposite`.

#### Текущая таблица: edge-table-5min-v9-loose.json

| Параметр | Значение |
|---|---|
| Тренировочный период | Apr 6–25 2026 (1510 рынков) |
| OOS holdout | Apr 26–27 2026 (288 рынков) |
| Зон в таблице | 355 (57 actionable: 27 BUY + 30 SELL) |
| OOS WR | 60.4% (217 сделок) |
| OOS total PnL | +42.67 USDC (на 100 USDC капитале) |
| Bucketing | deltaStep=10$, tauStep=30s, no crowd |
| Режим калибровки | `--legacy-fill --loose-ci` (unconditional pHat) |

**Топ сигналы по composite**:

| Действие | Delta | Tau | Regime | n | OOS | Composite |
|---|---|---|---|---|---|---|
| BUY | +$30 | 150–180s | up | 219 | ✓ | 0.998 |
| SELL | -$10 | 210–240s | up | 155 | ✓ | 0.655 |
| SELL | -$40 | 0–30s | flat | 130 | ✓ | 0.505 |
| BUY | +$10 | 60–90s | up | 162 | ✓ | 0.489 |
| SELL | +$30 | 210–240s | up | 141 | ✓ | 0.464 |

**Экономическая логика**:
- BUY в `up` + короткий tau (30–90s): crowd недооценивает краткосрочный momentum
- SELL в `up` + длинный tau (180–270s): crowd чрезмерно оптимистичен при сильном росте
- SELL в `down` + средний tau: crowd не верит в продолжение снижения

#### История таблиц

| Файл | Описание | Причина устаревания |
|---|---|---|
| `edge-table-5min.json` | fill-sim strict | 0 BUY-зон из-за adverse selection в fill-sim |
| `edge-table-5min-delta-regime.json` | observation-weighted | n раздут 100-1000x, fake signals |
| `edge-table-5min-v9-loose.json` | **текущая** market-weighted legacy-fill | — |

#### Постмортем 2026-04-21 (obs-weighted → −$16.67)

Observation-weighted калибровка считала каждый тик как независимый сэмпл → n раздут в
100–1000x → 221 BUY-зоны с composite ≥ 0.3 → все оказались шумом. Переход на
`market-weighted + --legacy-fill` даёт честную оценку: 57 зон, OOS подтверждённые.

#### Tail-zone experiment (Apr 23-27 2026, relaxed gate)

Отдельно проверили гипотезу, что при сильно ослабленном gate `minComposite=0.05`
стратегия начинает ловить не средние системные зоны, а редкие хвостовые mispricing-состояния.

Эксперимент считался через `scripts/backtest-calibrated-crowd.ts` с таблицей
`tables/edge-table-5min-market-weighted-train-through-20260420.json` на днях
`2026-04-23` ... `2026-04-27`.

| Дата | Сделки | Hold PnL | Tau-only PnL | Regime-flip PnL | Full-risk PnL |
|:--|--:|--:|--:|--:|--:|
| 2026-04-23 | 28 | +29.46 | -2.23 | -2.23 | +6.64 |
| 2026-04-24 | 20 | +45.11 | +8.71 | +8.71 | +1.96 |
| 2026-04-25 | 39 | -1.78 | +4.79 | +4.79 | +10.10 |
| 2026-04-26 | 20 | +18.27 | +23.09 | +23.09 | +21.14 |
| 2026-04-27 | 10 | -20.04 | +0.86 | +0.86 | +5.18 |
| **Итого** | **117** | **+71.02** | **+35.22** | **+35.22** | **+45.02** |

Как читать эти итоги:

- это сумма пяти независимых дневных backtest’ов
- каждый день стартовал заново с капиталом `1000`
- это не один непрерывный compounded-run

Ключевые наблюдения:

- при `minComposite=0.3` на `2026-04-23` не было ни одного входа
- при `minComposite=0.05` стратегия начинает торговать заметные хвосты
- все входы в этих прогонах пришли из `down` regime
- `hold` дал лучший total PnL, но `full-risk` оказался ровнее по дням

Для воспроизводимости добавлены config-профили:

- `configs/cc-backtest-apr23-27-mc005-hold.json`
- `configs/cc-backtest-apr23-27-mc005-tau-only.json`
- `configs/cc-backtest-apr23-27-mc005-regime-flip.json`
- `configs/cc-backtest-apr23-27-mc005-full-risk.json`

---

## Не работающие стратегии (reference)

### Avellaneda-Stoikov MM
**Файл**: `src/strategies/AvellanedaStoikovStrategy.ts`

Market making с динамическими спредами. Сильная adverse selection на 5-мин рынках уничтожает PnL. Множество параметров (~40+), все overfit. Ablation study показал: zone filter 55-73¢ делает breakeven, но не больше.

### CryptoProbStrategy
**Файл**: `src/strategies/CryptoProbStrategy.ts`

Directional торговля на основе P(UP) из empirical probability table. Overfit на train (btc1: +10 USDC), OOS catastrophic (-90 USDC). 150 ячеек prob table = слишком много степеней свободы.

### ProbTableStrategy
**Файл**: `src/strategies/ProbTableStrategy.ts`

Ранняя версия CryptoProbStrategy с other entry/exit logic. Те же проблемы с overfit.

---

## Ключевые выводы из исследования

1. **Hold до settlement > активная торговля** — exit logic, trail stops, market making на коротких рынках ухудшают результаты
2. **Zone filter 55-73¢** — единственный устойчивый фильтр, делает любую стратегию breakeven+
3. **15-мин рынки >> 5-мин** — больше momentum persistence, лучше signal-to-noise
4. **Минимум параметров** — 6 параметров (AdaptiveEntry) лучше 40+ (AS MM)
5. **Auto-selection** — один конфиг на рынок лучше двух отдельных запусков UP/DOWN
6. **EWMA trade tape > order book mid** — спреды в book часто 1¢/99¢, mid = 50¢ всегда

---

## Запуск бэктеста

```bash
cd apps/bot

# AdaptiveEntry (рекомендуется)
MODE=backtest CONFIG=configs/ae-auto-btc2-backtest.json npx tsx src/main.ts

# SelectiveEntry
MODE=backtest CONFIG=configs/sel-baseline-btc2-backtest.json npx tsx src/main.ts
```
