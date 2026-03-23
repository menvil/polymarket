# Гипотезы стратегий для реализации

> Основано на анализе 10M+ трейдов, 8,742+ рынков BTC Up/Down (5-мин) и 46K+ рынков (15-мин),
> период: октябрь 2025 — январь 2026.
> Источник: `/Users/menvil/Projects/prediction-market-analysis/`

---

## Общие выводы исследования

### Что работает
- **Маркетмейкинг (Avellaneda-Stoikov)** — основной источник прибыли ($55-507/день)
- **Спред — главный источник PnL** (~145% от net), inventory loss — неизбежная цена бизнеса (~-45%)
- **Dynamic Q** (inventory limit по времени) — +24%
- **Profit hold** (снижение skew при нереализованной прибыли) — +2-13%
- **Price range vol** (max-min range для масштабирования спреда) — +8%
- **Lower gamma** (0.03 vs 0.05) — +12%
- **Momentum mid** (EWMA midprice) — +22%
- **Asymmetric budget** (imbalance-weighted taker allocation) — +37%
- **Adaptive alpha** (depth-scaled signal reliability) — +15%
- **Ramp** (time-based taker acceleration) — +17%
- **nLevels=3** (концентрированный imbalance signal) — +12%

### Что категорически НЕ работает
- Pressure bias → катастрофические потери (-37% до -100%)
- Unwind zones (выход за N минут до конца) → -$8 до -$29/день
- Cost floor (не продавать ниже себестоимости) → катастрофа (-$60/день)
- Cross-market trend / side prediction → -15% до -53%
- Realized vol вместо калиброванной sigma → хуже калибровки
- Kitchen sink (все 5+ сигналов вместе) → хуже чем selective combo из 3

### Критические предупреждения
1. **Latency доминирует PnL**: lat=0 → $125/день, lat=1 (200ms) → $55, lat=2 (400ms) → $31
2. **Edge нестабилен по месяцам**: октябрь -$4, ноябрь $17, декабрь $111, январь $164
3. **Adverse selection floor**: спред < 0.15 → убыточно (фундаментальное свойство рынка)
4. **Fee sensitivity**: 1% комиссия → -68% PnL, 2% → убыточно
5. **Queue position** — доминирующий bottleneck в реалистичной модели

---

## Полный каталог положительных конфигураций

### A. Направленные стратегии (3 конфигурации)

| # | Эксперимент | Конфигурация | $/день | Win rate | Статус |
|---|---|---|---|---|---|
| A1 | EXP-01: Low-price mean reversion | BUY 10-14c при sell-pressure ≤ -0.75, hold | $0.56 | ~50% | Хрупкая, низкий edge |
| A2 | EXP-02: Momentum scalp | BUY 75-94c, mfe ≤ 3, velocity 4-7, pressure [-0.4, +0.6] | **$8.77** | 91.3% дней | **Жизнеспособна** |
| A3 | EXP-03: Combined two-zone | Low (5-15c TP+3/SL-3) + High (70-94c hold), Up+Down | **$17.31** | 93.5% дней | **Лучшая направленная** |

### B. MM на 5-мин окне — базовые конфигурации (6 конфигураций)

| # | Эксперимент | Конфигурация | $/день | Sharpe | Losing days |
|---|---|---|---|---|---|
| B1 | EXP-09: Grid search (best absolute) | γ=0.05, Q=10, sp=0.5 | $54.21 | 20.9 | 8/93 |
| B2 | EXP-09: Grid search (best risk-adj) | γ=0.05, Q=3, sp=0.5 | $48.19 | 26.6 | 2/93 |
| B3 | EXP-11: Spread optimized | γ=0.05, Q=3, sp=0.20 | **$69.37** | 24.7 | 3/93 |
| B4 | EXP-11: Spread 0.25 | γ=0.05, Q=3, sp=0.25 | $68.79 | 25.3 | 3/93 |
| B5 | EXP-11: Spread 0.15 | γ=0.05, Q=3, sp=0.15 | $66.37 | 23.8 | 5/93 |
| B6 | EXP-11: Spread 0.10 | γ=0.05, Q=3, sp=0.10 | $56.78 | 22.1 | 10/93 |

### C. MM на 5-мин окне — одиночные улучшения (8 конфигураций)

| # | Эксперимент | Улучшение | $/день | Прирост | Статус |
|---|---|---|---|---|---|
| C1 | EXP-14: Dynamic Q | dyn 10→5→3, sp=0.20 | **$86.14** | +24% | **Основной** |
| C2 | EXP-19: Lower gamma | γ=0.03, Q=3, sp=0.20 | $77.45 | +12% | Работает |
| C3 | EXP-12: Profit hold | ph t=5 s=30, Q=3, sp=0.30 | $66.99 | +2% | Скромно |
| C4 | EXP-35: Price range vol | rangeVol N=10 t=0.3, dyn, γ=0.03, ph | $106.03 | +8% | Работает |
| C5 | EXP-16: Realized vol adjuster | vol window=10, clamp 0.7-1.5 | $72.00 | +4% | Маргинально |
| C6 | EXP-26: Daily vol filter | calm sp=0.15, vol sp=0.20 | $96.36 | +5% | Работает |
| C7 | EXP-42: Jump widen | threshold=5c, cooldown=5, widen=2x | $103.07 | +5% | Работает |
| C8 | EXP-14: Dynamic Q (Q=5 static) | Q=5 static | $84.12 | +21% | Работает |

### D. MM на 5-мин окне — комбинации (5 конфигураций)

| # | Эксперимент | Комбинация | $/день | Прирост vs baseline | Статус |
|---|---|---|---|---|---|
| D1 | EXP-18: dyn + ph | dyn 10→5→3, ph, sp=0.20 | $89.53 | +29% | Работает |
| D2 | EXP-26: dyn + γ=0.03 + ph + vol filter | Все 4 вместе | $96.36 | +39% | Работает |
| D3 | EXP-35: dyn + γ=0.03 + ph + rangeVol | sp=0.12 | $106.03 | +53% | Работает |
| D4 | EXP-39: **Momentum mid** | momMid N=3 α=0.2, dyn, γ=0.03, ph, sp=0.12 | **$119.75** | +73% | **Прорыв** |
| D5 | EXP-39: momMid (best abs) | momMid N=3 α=0.2, dyn, γ=0.03, ph, sp=0.08 | **$124.98** | +80% | **Рекорд 5-мин** |

### E. MM на 5-мин — с latency (реалистичные, 4 конфигурации)

| # | Latency | Конфигурация | $/день | vs lat=0 |
|---|---|---|---|---|
| E1 | lat=1 (200ms) | rangeVol 5/0.5, sp=0.20, dyn, γ=0.03, ph | **$55** | -56% |
| E2 | lat=1 | baseline Q=3, sp=1.00 | $45-55 | -35% |
| E3 | lat=2 (400ms) | rangeVol 10/0.3, sp=0.30, dyn, γ=0.03, ph | **$31** | -75% |
| E4 | lat=2 | baseline Q=3, sp=1.50 | $23-31 | -65% |

### F. MM на 15-мин — queue model базовые (7 конфигураций)

| # | Эксперимент | Конфигурация | $/день | Прирост | Статус |
|---|---|---|---|---|---|
| F1 | EXP-54: Queue baseline | Orderbook snapshots, queue position | $3.19 | — | Реалистичная база |
| F2 | EXP-55: Taker signal | taker alone | $6.60 | +107% | Работает |
| F3 | EXP-55: bookImbal + qAware | Combination | $11.23 | +252% | Синергия |
| F4 | EXP-55: All 5 signals | imb+qAware+taker+adaptSp+multiLvl | $12.73 | +299% | Best early |
| F5 | EXP-56: 15-мин iq+tkr Q10 max=15 | 15-min window | $61.56 | +384% vs 5min | **Прорыв** |
| F6 | EXP-56: 15-мин iq+tkr Q10 max=50 | Higher max takes | **$85.63** | — | Масштабируется |
| F7 | EXP-62: Adaptive alpha | depthScale=100 | $93.25 | +15% | Работает |

### G. MM на 15-мин — ramp и улучшения (6 конфигураций)

| # | Эксперимент | Конфигурация | $/день | Прирост | Статус |
|---|---|---|---|---|---|
| G1 | EXP-60: Ramp +5/min | base=5, rate=5, sp=0.50 | $94.73 | +17% | Работает |
| G2 | EXP-67: Ramp +10/min | base=5, rate=10, sp=0.80 | $122.19 | — | Работает |
| G3 | EXP-69: **Ramp + adaptAlpha** | ramp +10/min, depthScale=100, sp=0.80 | **$139.57** | super-additive | **Прорыв** |
| G4 | EXP-73: Ramp +15/min | base=5, rate=15, aAlpha, sp=0.80 | $161.63 | — | Работает |
| G5 | EXP-73: Ramp +20/min | base=5, rate=20, aAlpha, sp=0.80 | $170.20 | — | Работает |
| G6 | EXP-73: Ramp +25/min | base=5, rate=25, aAlpha, sp=0.80 | $175.25 | — | Diminishing |
| G7 | EXP-75: Sqrt ramp +10/min | sqrt shape instead of linear | $143.91 | +3% vs linear | Маргинально |

### H. MM на 15-мин — asymmetric budget (7 конфигураций)

| # | Эксперимент | Конфигурация | $/день | Прирост | Статус |
|---|---|---|---|---|---|
| H1 | EXP-81: **Asymmetric** | asym=1.0, R=10, aAlpha, sp=0.80 | **$191.21** | +37% | **Прорыв** |
| H2 | EXP-84: asym=0.3 | Factor sweep | $180.46 | — | Работает |
| H3 | EXP-84: asym=0.5 | | $184.40 | — | Работает |
| H4 | EXP-84: asym=0.7 | | $187.90 | — | Работает |
| H5 | EXP-84: asym=1.3 | | $193.69 | — | Работает |
| H6 | EXP-84: asym=1.5 | | $194.90 | — | Best absolute |
| H7 | EXP-89: EWMA speed 0.5 | Faster EWMA | $202.00 | +6% | Работает |

### I. MM на 15-мин — signal tuning (5 конфигураций)

| # | Эксперимент | Конфигурация | $/день | Прирост | Статус |
|---|---|---|---|---|---|
| I1 | EXP-87: **imb threshold 0.4** | imb=0.4 vs 0.6 baseline | **$218.88** | +14% | **Крупное улучшение** |
| I2 | EXP-90: **Q=15** | Q=15 + asym + signals | **$225.41** | +18% | **Рекорд ob7** |
| I3 | EXP-91: γ=0.05 | Higher gamma (better Sharpe 43.2) | $196.46 | +3% | Работает |
| I4 | EXP-92: **nLevels=3** | Fewer OB levels for imbalance | $213.45 | +12% | **Удивительно эффективно** |
| I5 | EXP-74: Base maxTakes=20 | Higher initial budget | $146.26 | +5% | Маргинально |

### J. MM на 15-мин — multi-param combos (6 конфигураций)

| # | Эксперимент | Конфигурация | $/день | Статус |
|---|---|---|---|---|
| J1 | EXP-95: Q15 + imb=0.4 | 2-param | $254.50 | Работает |
| J2 | EXP-95: Q15 + nLev=3 | 2-param | $241.49 | Работает |
| J3 | EXP-95: Q15 + ewma=0.5 | 2-param | $236.42 | Работает |
| J4 | EXP-95: Q15 + γ=0.05 | 2-param | $231.60 | Работает |
| J5 | EXP-97: **4-param best** | Q15 + imb=0.4 + ewma=0.5 + γ=0.05 | **$268.85** | **Best 4-param** |
| J6 | EXP-97: FULL 5-param | + nLev=3 (sub-additive!) | $258.04 | nLev=3 вредит в combo |

### K. MM на 15-мин — FULL combo + scaling (8 конфигураций)

| # | Эксперимент | Конфигурация | $/день | Sharpe | Losing days |
|---|---|---|---|---|---|
| K1 | EXP-99: FULL R=15 sp=0.80 | FULL combo | $280.35 | 40.7 | 0/8 |
| K2 | EXP-99: FULL R=20 sp=1.00 | | $297.66 | 38.6 | 0/8 |
| K3 | EXP-99: **FULL R=25 sp=1.00** | **Рекорд ob8** | **$303.62** | 36.1 | 0/8 |
| K4 | EXP-103: **Q=20 R=40 sp=1.00** | **Рекорд ob9** | **$355.41** | 32.9 | 0/8 |
| K5 | EXP-106: Q=25 R=50 | | $387.29 | 31.6 | — |
| K6 | EXP-107: Q=30 R=40 | | $413.96 | 33.6 | — |
| K7 | EXP-108: Q=40 R=50 | | $461.39 | 31.8 | — |
| K8 | EXP-108: Q=50 R=50 | | $492.46 | 31.0 | 0/8 |

### L. MM на 15-мин — advanced signals (5 конфигураций)

| # | Эксперимент | Конфигурация | $/день | Прирост | Статус |
|---|---|---|---|---|---|
| L1 | EXP-110: Dynamic gamma by inventory | slope=1.0 linear, Q=25 | $390.69 | +1% | Скромно |
| L2 | EXP-114: **Regime detection** | n=20, t=0.7, trend×1.5, range×0.8 | $393.27 | +1.6% | **Лучший индивидуальный** |
| L3 | EXP-113: Trade flow | w=15s, α=1.0 | $389.83 | +0.7% | Работает |
| L4 | EXP-117: **dG + tF + rG triple** | dynGamma + tradeFlow + regime | **$401.40** | +3.7% | **Super-additive** |
| L5 | EXP-117: dG + rG | 2-combo | $396.50 | +2.5% | Работает |

### M. MM на 15-мин — ultimate record (1 конфигурация)

| # | Эксперимент | Конфигурация | $/день | Sharpe | Losing days |
|---|---|---|---|---|---|
| M1 | EXP-120: **ALL-TIME RECORD** | Q=50, R=50, sp=1.00, dG+tF+rG combo | **$506.73** | 31.0 | **0/8** |

#### Scaling по Q (EXP-120, dG+tF+rG combo):
| Q | $/день | Marginal $/Q |
|---|---|---|
| 15 | $322.05 | — |
| 20 | $368.35 | $9.26/Q |
| 25 | $401.40 | $6.61/Q |
| 30 | $429.29 | $5.58/Q |
| 40 | $474.30 | $4.50/Q |
| 50 | $506.73 | $3.24/Q |

---

## Итого: 40+ конфигураций с положительным ROI

| Категория | Кол-во | Диапазон $/день | Лучшая |
|---|---|---|---|
| Направленные | 3 | $0.56 — $17.31 | Combined two-zone |
| MM 5-мин базовые | 6 | $48 — $69 | sp=0.20 |
| MM 5-мин улучшения | 8 | $67 — $106 | Price range vol |
| MM 5-мин комбинации | 5 | $90 — $125 | Momentum mid |
| MM 5-мин реалистичные | 4 | $23 — $55 | lat=1 rangeVol |
| MM 15-мин queue базовые | 7 | $3 — $94 | Adaptive alpha |
| MM 15-мин ramp | 7 | $95 — $175 | Ramp + adaptAlpha |
| MM 15-мин asymmetric | 7 | $180 — $202 | EWMA 0.5 |
| MM 15-мин signal tuning | 5 | $146 — $225 | Q=15 |
| MM 15-мин multi-param | 6 | $232 — $269 | 4-param combo |
| MM 15-мин FULL + scaling | 8 | $280 — $492 | Q=50 R=50 |
| MM 15-мин advanced signals | 5 | $390 — $401 | dG+tF+rG triple |
| **MM 15-мин ultimate** | **1** | **$507** | **Q=50 R=50 dG+tF+rG** |

---

## Рекорды по этапам эволюции

```
$0.56  → Low-price mean reversion (EXP-01)
$8.77  → Momentum scalp (EXP-02)
$17.31 → Combined directional (EXP-03)
$69    → Baseline MM sp=0.20 (EXP-11)
$86    → + Dynamic Q 10→5→3 (EXP-14)
$106   → + rangeVol + γ=0.03 + ph (EXP-35)
$125   → + Momentum mid (EXP-39) ← РЕКОРД 5-МИН
$140   → Queue model + ramp + adaptAlpha (EXP-69)
$191   → + Asymmetric budget (EXP-81)
$219   → + imb threshold 0.4 (EXP-87)
$225   → + Q=15 (EXP-90)
$269   → + 4-param combo (EXP-97)
$304   → + FULL + R=25 (EXP-99)
$355   → + Q=20 R=40 (EXP-103)
$401   → + dG+tF+rG selective combo (EXP-117)
$507   → + Q=50 R=50 (EXP-120) ← ALL-TIME RECORD
```

---

## Стратегия 1: Baseline Market Maker (Avellaneda-Stoikov)

### Приоритет: ВЫСОКИЙ — первая для реализации

### Гипотеза
Маркетмейкинг на бинарных крипто-рынках Polymarket (BTC Up/Down, 5-мин окно)
с калиброванными параметрами по модели Avellaneda-Stoikov даёт стабильную прибыль
за счёт спреда, несмотря на потери от inventory при settlement.

### Ожидаемая доходность
- **Идеальная (lat=0)**: $69/день (Q=3, sp=0.20, γ=0.05)
- **Реалистичная (lat=1)**: $45-55/день
- **Консервативная (lat=2)**: $23-31/день
- Sharpe: 24.7, убыточных дней: 3/93

### Модель

**Reservation price** (сколько мы думаем стоит актив):
```
r = s - q * γ * σ² * τ
```
- `s` — midprice (текущая mid)
- `q` — текущий inventory (+ = long, - = short)
- `γ` — risk aversion (0.03-0.05)
- `σ` — volatility (калибруется per minute bucket)
- `τ` — time to expiry (нормализованное)

**Optimal spread** (ширина котировок):
```
δ = γ * σ² * τ + (2/κ) * ln(1 + γ/κ)
```
- `κ` — market depth (из калибровки, logit-scale)

**Quotes**:
```
bid = r - δ/2 * spread_mult
ask = r + δ/2 * spread_mult
```

### Калиброванные параметры (5-мин окно)

| Bucket (мин от конца) | σ/sec | κ_logit | Jump premium |
|---|---|---|---|
| 0 (< 1 мин) | 0.350 | 3.000 | 0.100 |
| 1 (1-2 мин) | 0.235 | 3.593 | 0.074 |
| 2 (2-3 мин) | 0.139 | 4.737 | 0.026 |
| 3 (3-4 мин) | 0.112 | 5.370 | 0.015 |
| 4 (4-5 мин) | 0.099 | 5.874 | 0.012 |
| 5+ | 0.092 | 5.850 | 0.010 |

**Критично**: σ в последнюю минуту в 5.3x выше чем на 5-й. НЕ экстраполировать!

### Параметры конфигурации

```json
{
  "strategy": "avellaneda-stoikov",
  "strategyParams": {
    "gamma": 0.05,
    "maxInventory": 3,
    "spreadMult": 0.20,
    "sigmaSchedule": "calibrated_5m",
    "kappaSchedule": "calibrated_5m"
  }
}
```

### Реализация

1. **tick()** получает `snapshot.topOfBook` → вычисляет midprice
2. Определить minute bucket по `timeToExpiry`
3. Выбрать σ, κ из таблицы калибровки
4. Вычислить reservation price `r` и optimal spread `δ`
5. Квотировать bid/ask с учётом tick size (0.01)
6. Ограничить inventory: если `|q| >= maxQ` → квотировать только одну сторону
7. При fill → обновить inventory count
8. При settlement → inventory losses (неизбежные, ~-45% от спредового дохода)

### Метрики для мониторинга
- Spread earned vs inventory loss (должно быть ~3:1)
- Fill rate (слишком мало → спред широк, слишком много → adverse selection)
- Inventory distribution (не должен быть постоянно max)

---

## Стратегия 2: Enhanced Market Maker (с оптимизациями)

### Приоритет: ВЫСОКИЙ (после baseline)

### Гипотеза
Добавление проверенных улучшений к baseline AS модели увеличивает доходность на 50-80%.

### Ожидаемая доходность
- **Идеальная (lat=0)**: $120-125/день
- **Реалистичная (lat=1)**: $55-70/день

### Улучшения (все подтверждены бэктестом)

#### 2.1 Dynamic Q Schedule (+24%)
Менять max inventory по времени до экспирации:
```
mfe > 3 мин → Q = 10
mfe 2-3 мин → Q = 5
mfe < 2 мин → Q = 3
```

#### 2.2 Lower Gamma (+12%)
`γ = 0.03` вместо `0.05` — менее агрессивный skew, больше fills.

#### 2.3 Profit Hold (+2-13%)
Если unrealized PnL > 5 центов → снизить inventory skew (не спешить закрывать прибыльную позицию).
```
if (unrealizedPnl > 0.05) {
  skewMultiplier = 0.5; // снижаем skew вдвое
}
```

#### 2.4 Price Range Vol (+8%)
Масштабирование спреда на основе max-min range последних N трейдов:
```
range = max(last_N_prices) - min(last_N_prices)
if (range > threshold) spreadMult *= 1.3  // расширить спред при высокой vol
```
Оптимальные параметры: N=10, threshold=0.3

#### 2.5 Momentum Mid (+22%, НО чувствительна к latency)
EWMA midprice вместо raw mid:
```
ewma_mid = α * current_mid + (1-α) * prev_ewma
```
Параметры: window=3 trades, α=0.2
**Внимание**: при latency > 0 эффект снижается.

#### 2.6 Jump Widen (+5%)
При скачке цены > 5 центов → расширить спред в 2x на cooldown=5 trades.

### Параметры конфигурации

```json
{
  "strategy": "avellaneda-stoikov-enhanced",
  "strategyParams": {
    "gamma": 0.03,
    "maxInventory": 10,
    "spreadMult": 0.12,
    "dynamicQ": { "schedule": [10, 5, 3], "breakpoints": [3, 2] },
    "profitHold": { "threshold": 0.05, "skewReduction": 0.5 },
    "rangeVol": { "window": 10, "threshold": 0.3, "scaleFactor": 1.3 },
    "momentumMid": { "window": 3, "alpha": 0.2 },
    "jumpWiden": { "threshold": 0.05, "cooldown": 5, "factor": 2.0 }
  }
}
```

---

## Стратегия 3: Orderbook-Aware Market Maker

### Приоритет: СРЕДНИЙ (требует orderbook history)

### Гипотеза
Использование глубины стакана (orderbook snapshots) для адаптивного квотирования
даёт x3-4 к baseline MM за счёт лучшей оценки risk и более точного spread.

### Ожидаемая доходность
- **Бэктест**: $322-507/день (Q=15-50, lat=0)
- **Реалистичная оценка**: x2-3 от baseline → $100-200/день

### Сигналы (подтверждены бэктестом)

#### 3.1 Dynamic Gamma (dynGamma) — +1% standalone, super-additive в combo
Адаптивный γ на основе текущего состояния стакана:
```
gamma_effective = base_gamma * (1 + slope * |q| / qMax)
```
- slope = 1.0, linear mode
- Больше inventory → выше γ → шире спред → защита

#### 3.2 Trade Flow Signal (tradeFlow) — +0.7% standalone
Смещение mid на основе потока трейдов за последние N секунд:
```
flow = Σ(signed_volume, last 15s)
mid_adjusted = mid + α * flow
```
- window = 15s, α = 1.0
- Короткие окна лучше (15s > 30s > 60s)

#### 3.3 Regime Detection (regime) — +1.6% standalone, лучший индивидуальный
Переключение параметров на основе волатильности:
```
recent_prices = last 20 trades
trend = (last - first) / range
if (|trend| > 0.7) → trending regime: spread × 1.5
else → ranging regime: spread × 0.8
```

#### 3.4 Triple Combo (dG+tF+rG) — +3.7% super-additive
Три сигнала вместе дают больше чем сумма индивидуальных (+3.7% vs sum of ~3.3%).
**Важно**: Kitchen sink (все 5+ сигналов) хуже чем selective trio: $370 vs $401.

### Использование существующей инфраструктуры
- `snapshot.bookHistory` → `OrderBookHistory.getRecent(15_000)` для dynGamma
- `snapshot.tradeTape` → `TradeTape.getRecent(15_000)` для tradeFlow
- `ImbalanceCalculator.calculate(bids, asks, { type: 'WEIGHTED' })` для imbalance
- `TradeFlowCalculator.compute(trades)` для OFI

### Параметры конфигурации

```json
{
  "strategy": "avellaneda-stoikov-orderbook",
  "strategyParams": {
    "gamma": 0.05,
    "maxInventory": 25,
    "spreadMult": 1.0,
    "dynamicQ": { "schedule": [25, 15, 10], "breakpoints": [3, 2] },
    "dynGamma": { "sensitivity": 1.0, "mode": "linear" },
    "tradeFlow": { "windowSec": 15, "alpha": 1.0 },
    "regime": { "lookback": 20, "threshold": 0.7 }
  }
}
```

---

## Стратегия 4: Queue-Aware MM с Asymmetric Budget

### Приоритет: СРЕДНИЙ-ВЫСОКИЙ (наибольший потенциал)

### Гипотеза
Учёт позиции в очереди стакана + асимметричное распределение taker budget
по направлению imbalance даёт $200-500/день на 15-мин рынках.

### Ожидаемая доходность
- Q=15: $225/день → Q=50: $507/день
- Sharpe: 31-34, 0 убыточных дней в тесте

### Ключевые механизмы

#### 4.1 Taker Signal
Агрессивное исполнение (taker orders) когда сигнал сильный — вместо ожидания fill в очереди.

#### 4.2 Ramp Schedule (+17%)
Бюджет taker'ов растёт со временем рынка:
```
maxTakes = base + elapsed_minutes × rate
```
Оптимум: base=5, rate=10/min (linear ramp).

#### 4.3 Adaptive Alpha (+15%)
Вес imbalance сигнала масштабируется глубиной стакана:
```
effective_alpha = base_alpha * min(book_depth / depthScale, 1)
```
Глубже стакан → надёжнее сигнал.

#### 4.4 Asymmetric Budget (+37% — крупнейшее улучшение)
Taker budget распределяется по направлению imbalance:
```
effectiveMaxBuyTakes  = maxTakes × (1 + imbalance × asymFactor)
effectiveMaxSellTakes = maxTakes × (1 - imbalance × asymFactor)
```
- asymFactor = 1.0-1.3 (оптимум)
- Если стакан перекошен в пользу покупателей → больше buy takes, меньше sell takes

#### 4.5 Signal Tuning
- **imb threshold = 0.4** (vs 0.6): +14% — более агрессивный taker trigger
- **nLevels = 3** для imbalance: +12% — top-3 уровня стакана информативнее чем top-5
- **EWMA speed = 0.5**: +6% — быстрая реакция лучше

### Параметры конфигурации

```json
{
  "strategy": "queue-aware-mm",
  "strategyParams": {
    "gamma": 0.05,
    "maxInventory": 25,
    "spreadMult": 1.0,
    "ramp": { "base": 5, "perMinute": 10, "shape": "linear" },
    "adaptiveAlpha": { "depthScale": 100 },
    "asymmetric": { "factor": 1.0 },
    "imbalanceThreshold": 0.4,
    "nLevels": 3,
    "ewmaSpeed": 0.5,
    "dynGamma": { "sensitivity": 1.0 },
    "tradeFlow": { "windowSec": 15, "alpha": 1.0 },
    "regime": { "lookback": 20, "threshold": 0.7 }
  }
}
```

---

## Стратегия 5: Momentum Scalp (направленная)

### Приоритет: НИЗКИЙ (backup стратегия)

### Гипотеза
Покупка Up-токенов по 75-94с в последние 3 минуты при умеренном momentum
и контролируемом pressure даёт стабильную прибыль за счёт settlement.

### Ожидаемая доходность
- $8.77/день, 84/92 winning days (91.3%)
- Avg EV: +1.3c per trade

### Условия входа
```
price ∈ [0.75, 0.94]
minutes_from_end ≤ 3
velocity ∈ [4, 7] центов/30с (moderate momentum)
pressure_ratio ∈ [-0.4, +0.6] за 5с (не exhaustion)
```

### Условия выхода
- TP: +5 центов, timeout 60с
- SL: -5 центов
- Fallback: hold до settlement

### Ключевые наблюдения
- **Buy pressure на высоких ценах = подтверждение** (в отличие от низких цен, где это adverse selection)
- **Velocity > 8 = exhaustion** → не входить
- **Последняя минута**: 90-94c → 73.7% win rate, +2.39c EV

### Параметры конфигурации

```json
{
  "strategy": "momentum-scalp",
  "strategyParams": {
    "priceRange": [0.75, 0.94],
    "maxMinutesFromEnd": 3,
    "velocityRange": [4, 7],
    "pressureRange": [-0.4, 0.6],
    "takeProfitCents": 5,
    "stopLossCents": 5,
    "tpTimeoutSec": 60
  }
}
```

---

## Стратегия 6: Combined Two-Zone (направленная)

### Приоритет: НИЗКИЙ

### Гипотеза
Две независимые направленные стратегии одновременно на Up и Down токенах.

### Ожидаемая доходность
- $17.31/день, 6 losing days / 92

### Зоны
- **Low zone** (5-15c): TP+3/SL-3, скальпирование паники
- **High zone** (70-94c): Hold до settlement, momentum confirmation

---

## План реализации

### Фаза 1: Baseline AS Market Maker
1. Создать `AvellanedaStoikovStrategy` реализующий `IStrategy`
2. Калибровочные таблицы σ/κ per minute bucket
3. Inventory tracking (через `snapshot.portfolio`)
4. **Двустороннее квотирование** (bid + ask одновременно) — требует доработки ExecutionEngine
5. Бэктест на существующих snapshot файлах
6. Paper test на live данных

### Фаза 2: Enhanced MM
7. Dynamic Q schedule
8. Profit hold
9. Price range vol (через `snapshot.tradeTape`)
10. Momentum mid
11. Jump widen
12. A/B тестирование каждого улучшения отдельно

### Фаза 3: Orderbook-Aware MM
13. Dynamic gamma (через `snapshot.bookHistory` + `ImbalanceCalculator`)
14. Trade flow signal (через `TradeFlowCalculator`)
15. Regime detection
16. Selective triple combo (dG+tF+rG)
17. Paper testing с real-time данными

### Фаза 4: Queue-Aware MM
18. Taker signal logic
19. Ramp schedule
20. Adaptive alpha
21. Asymmetric budget
22. Signal tuning (imb=0.4, nLev=3, ewma=0.5)
23. Q scaling tests

### Фаза 5: Live
24. Latency measurement (реальный lat=?)
25. Fee calibration
26. Kill switch + daily PnL monitoring
27. Monthly edge stability check

---

## Открытые вопросы

1. **Двусторонние ордера**: текущий бот умеет только один ордер за раз (DumbStrategy). MM требует bid+ask одновременно. Нужна поддержка в ExecutionEngine.
2. **Inventory tracking**: нужен real-time count позиции (уже есть через `snapshot.portfolio`)
3. **Latency реального бота**: неизвестна. Нужно замерить roundtrip. Это #1 вопрос — от него зависит выбор конфигурации.
4. **Fee structure**: Polymarket fees? Taker/maker разница? 1% fee = -68% PnL.
5. **15-мин рынки vs 5-мин**: orderbook-aware стратегия тестировалась на 15-мин. Наш бот работает на обоих.
6. **Capital requirements**: Q=25 при цене 50с = $12.50 за сторону. При 2 рынках = $50 locked.
7. **Queue model**: бэктест использует queue simulation. Реальная очередь может отличаться.
8. **Monthly edge drift**: октябрь -$4 → январь $164. Нужен мониторинг edge stability.
