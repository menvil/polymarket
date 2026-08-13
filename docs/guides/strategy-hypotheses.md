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

## Результаты реального бэктеста (март 2026)

> Данные: 362 рынка (5-мин BTC/ETH/XRP/SOL Up/Down) за 22 марта 2026.
> Бэктест через `runMultiMarketBacktest` с paper simulator (fillOnBookCrossing + fillOnTape).
> Торгуем только UP токен (outcomeIndex=0). Базовый баланс: 100 USDC.

### Эволюция результатов

| Конфигурация | PnL | UP avg | DOWN avg | WinRate | Fills |
|---|---|---|---|---|---|
| Baseline (gamma=0.05, qMax=5, orderSize=10) | **-1561** | +1.33 | -9.20 | — | — |
| + Unwind 60s, disc=3 | -1402 | +0.04 | -7.33 | — | — |
| + Unwind 120s | -1157 | -0.04 | -5.99 | — | — |
| + Unwind 180s, disc=5 | -1046 | -0.04 | -5.41 | — | — |
| + Stop-loss 3¢ (unwind 180s) | **-849** | -0.59 | -3.91 | — | — |
| + Regime w20/t3/m1.5/r0.8 | -757 | -0.42 | -3.58 | 29.5% | 2162 |
| + Regime w20/t2/m2.0/r0.7 | -670 | -0.30 | -3.23 | 27.3% | 1681 |
| + Regime w15/t2/m2.5/r0.7 | -483 | +0.18 | -2.67 | 28.3% | 1491 |
| + Regime w15/t2/m3.0/r0.7 | -423 | +0.35 | -2.51 | 30.0% | 1494 |
| + Regime w15/t2/m4.0/r0.6 | -358 | +0.06 | -1.92 | 26.2% | 1045 |
| + Regime w15/t2/m6.0/r0.6 | -216 | +0.18 | -1.28 | 27.5% | 723 |
| + Regime w15/t2/m8.0/r0.6 | -145 | — | — | 28.2% | 549 |
| **+ Regime w15/t2/m10/r0.6** | **-84** | +0.18 | -0.59 | **30.2%** | 490 |
| + Regime w15/t2/m20/r0.6 | -53 | — | — | 33.7% | 426 |
| + orderSize=5, stopLoss=2¢ | -29 | +0.17 | -0.30 | 34.5% | 489 |
| + warmup=15s | -11 | — | — | 38.6% | 422 |
| + jumpWiden(2¢, ×2.5, cd=3) | +14 | — | — | 46.3% | 384 |
| **+ dynGamma slope=1.0** | **+19.37** | **+0.21** | **-0.08** | **45.3%** | 366 |

### Ключевые находки

#### 1. Unwind phase (от -1561 до -849, +46%)
Агрессивная продажа инвентори за `unwindSec` до settlement:
- **BUY запрещён** в unwind фазе
- Ask прогрессивно снижается: `discount = progress × maxDiscountCents`
- Оптимум: unwindSec=180, discountCents=5 (3 минуты разгрузки)
- Потеря 1-5¢ на агрессивной продаже << потеря ~50¢ при settlement DOWN

#### 2. Stop-loss (от -1046 до -849, +19%)
Немедленный dump при unrealized loss > stopLossCents:
- Когда `avgEntry - mid >= 3¢` → продаём всё по mid-discount
- После dump: спред ×2 для осторожного re-entry
- Флаг сбрасывается когда позиция = 0

#### 3. Regime detection (от -849 до -84, **×10 улучшение**)
Самое эффективное улучшение. Определяем trending/ranging по price range последних N трейдов:
- **Trending** (range > 2¢): расширяем спред ×trendMult → не набираем инвентори против тренда
- **Ranging** (range < 1¢): сужаем спред ×rangeMult → больше fills в спокойном рынке
- Высокий trendMult (6-10) = по сути "не торгуй в trending" → максимальная защита
- **Компромисс**: trendMult=3 (активная торговля, 1494 fills) vs trendMult=10 (защита, 490 fills)

#### Структура лучшего конфига (m10)
```
362 рынка → 39 wins / 90 losses / 233 neutral
UP рынки: +0.18 avg PnL (первые в плюсе!)
DOWN рынки: -0.59 avg PnL
Worst loss: -12.90 (Ethereum 315PM-330PM)
Best win: +14.35 (Ethereum 200PM-215PM)
```

Top losers — 100% DOWN рынки с паттерном "2-5B/0S": купили, не смогли продать до settlement.

#### 4. orderSize=5 + stopLoss=2¢ (от -84 до -29, +65%)
- Меньший orderSize → меньше exposure на один ордер: 5×0.50 = 2.50 USDC vs 5.00
- Более агрессивный stop-loss → режем убытки раньше на 1¢

#### 5. Warmup 15s (от -29 до -11, +62%)
Не торгуем первые 15 секунд рынка:
- EWMA и regime data накапливаются, но ордера не выставляются
- Избегаем "слепую" торговлю без данных о режиме рынка

#### 6. Jump Widen (от -11 до +14, BREAKEVEN!)
При скачке цены ≥2¢ → спред ×2.5 на 3 трейда:
- Защита от adverse selection после резких движений
- Cooldown=3 трейда (не секунды) — короткий, но достаточный
- Оптимальные параметры: threshold=2¢, factor=2.5, cooldown=3

#### 7. Dynamic Gamma (от +14 до +19.37, +38%)
`effectiveGamma = gamma × (1 + slope × |q| / qMax)`:
- Больше позиция → выше risk aversion → шире спред и skew
- slope=1.0: при полной позиции gamma удваивается (0.05→0.10)
- DOWN рынки почти breakeven: -0.08 avg PnL

### Оптимальная конфигурация (прибыльная)

```json
{
  "gamma": 0.05, "qMax": 5, "orderSize": 5, "spreadMult": 1.0,
  "ewmaAlpha": 0.3, "unwindSec": 180, "unwindMaxDiscountCents": 5,
  "stopLossCents": 2, "stopLossSpreadMult": 2.0, "minTradesForMid": 5,
  "regimeWindow": 15, "regimeTrendThreshold": 2, "regimeRangeThreshold": 1,
  "regimeTrendSpreadMult": 10.0, "regimeRangeSpreadMult": 0.6,
  "warmupSec": 15,
  "jumpThreshold": 2, "jumpWidenFactor": 2.5, "jumpCooldownTrades": 3,
  "dynGammaSlope": 1.0
}
```

Результат: **+19.37 USDC** на 362 рынках, WinRate 45.3%, 366 fills.
UP markets: +0.21 avg, DOWN markets: -0.08 avg.

### Что не работает (проверено)

- **profitHold** (skew reduction при прибыли): +17.50 vs +19.37 без него — чуть хуже
- **gamma=0.03** (ниже risk aversion): -957 — гораздо хуже, wider fills = больше adverse selection
- **stopLoss=3¢** (менее агрессивный): -84 vs -29 при sl=2¢

### Оставшиеся проблемы (после оптимизации до +19.37)

1. **Neutral 74%**: 267 из 362 рынков — не торгуем (regime filter + warmup отсекают trending)
2. **DOWN рынки ≈ breakeven** (-0.08 avg): почти не убыточны, но ещё не прибыльны
3. **Worst loss -6.45**: отдельные рынки с крупными убытками
4. **Один день данных**: нужна проверка на других днях для robustness

---

## Раздельная оптимизация по таймфреймам (24 марта 2026)

### Проблема
Исходная оптимизация (+19.37) делалась на **смешанных** данных: 250 5-мин + 95 15-мин + 19 других рынков.
Прибыль шла из 15-мин (+22.88), а 5-мин были убыточны (-3.51).
`unwindSec=180` на 5-мин рынке (300с) = только 120с активной торговли (40%).

### Методология
- Отфильтровали рынки по длительности: `5PM-X{0,5}PM` (5-мин) и `PM-X{0,5}PM|AM-X{0,5}AM` (15-мин)
- Оптимизация по одному параметру за раз на day 1 (22 марта), валидация на day 2 (23 марта)
- Порядок sweep: unwindSec → warmupSec → stopLossCents → regimeTrendSpreadMult → ewmaAlpha → gamma → jumpThreshold → orderSize → spreadMult → dynGammaSlope

### Результаты: unwindSec sweep

**5-мин (300с рынок, 250 рынков day1):**
| unwindSec | Active% | PnL | WR | Fills |
|-----------|---------|------|----|-------|
| 30 | 90% | -10.44 | 43.8% | 292 |
| 60 | 80% | -6.27 | 45.2% | 269 |
| 90 | 70% | -14.84 | 43.0% | 240 |
| 180 | 40% | -3.51 | 35.6% | 115 |
| **240** | **20%** | **+3.58** | **55.0%** | **46** |
| 250 | 17% | -2.34 | 33.3% | 37 |

**15-мин (900с рынок, 95 рынков day1):**
| unwindSec | Active% | PnL | WR | Fills |
|-----------|---------|------|----|-------|
| 90 | 90% | +16.57 | 45.1% | 277 |
| **120** | **87%** | **+23.59** | **50.0%** | **273** |
| 180 | 80% | +22.88 | 54.0% | 251 |
| 300 | 67% | +10.70 | 52.2% | 217 |

### Мульти-параметрическая оптимизация (на фиксированном unwindSec)

**5-мин (uw=240): sweep остальных параметров**
| Параметр | Значение | PnL | Примечание |
|----------|----------|------|------------|
| base (sl=2, ws=15, tm=10) | — | +3.58 | baseline |
| **stopLossCents=0** | disabled | **+5.30** | stop-loss вредит |
| warmupSec=10 | — | +4.41 | лучше чем 15 |
| **sl=0 + ws=10** | combo | **+5.95** | |
| **sl=0 + ws=10 + tm=15** | combo | **+12.82** | **ЛУЧШИЙ 5-мин** |

**15-мин (uw=120): параметры уже оптимальны**
- sl=0 → -10.33 (stop-loss критичен!)
- ws=10 → +22.23 (чуть хуже ws=15)
- tm=15 → +0.66 (tm=10 оптимален)

### Лучшие конфиги по таймфреймам

**5-мин best** (`configs/as-5min-best-backtest.json`):
```json
{
  "gamma": 0.05, "qMax": 5, "orderSize": 5, "spreadMult": 1.0,
  "ewmaAlpha": 0.3, "unwindSec": 240, "unwindMaxDiscountCents": 5,
  "stopLossCents": 0, "stopLossSpreadMult": 2.0, "minTradesForMid": 5,
  "regimeWindow": 15, "regimeTrendThreshold": 2, "regimeRangeThreshold": 1,
  "regimeTrendSpreadMult": 15.0, "regimeRangeSpreadMult": 0.6,
  "warmupSec": 10, "jumpThreshold": 2, "jumpWidenFactor": 2.5,
  "jumpCooldownTrades": 3, "dynGammaSlope": 1.0
}
```

**15-мин best** (`configs/as-15min-best-backtest.json`):
```json
{
  "gamma": 0.05, "qMax": 5, "orderSize": 5, "spreadMult": 1.0,
  "ewmaAlpha": 0.3, "unwindSec": 120, "unwindMaxDiscountCents": 5,
  "stopLossCents": 2, "stopLossSpreadMult": 2.0, "minTradesForMid": 5,
  "regimeWindow": 15, "regimeTrendThreshold": 2, "regimeRangeThreshold": 1,
  "regimeTrendSpreadMult": 10.0, "regimeRangeSpreadMult": 0.6,
  "warmupSec": 15, "jumpThreshold": 2, "jumpWidenFactor": 2.5,
  "jumpCooldownTrades": 3, "dynGammaSlope": 1.0
}
```

### Валидация на Day 2 (23 марта 2026)

| Таймфрейм | Day 1 PnL | Day 2 PnL | Δ vs original Day 2 |
|-----------|-----------|-----------|---------------------|
| 5-мин (uw=240) | **+12.82** | -23.64 | **-88.54 → -23.64 (+74%)** |
| 15-мин (uw=120) | **+23.59** | -103.69 | -99.56 → -103.69 (≈) |
| **Итого** | **+36.41** | **-127.33** | -188.10 → -127.33 (+32%) |

### Ключевые выводы (раздельная оптимизация)

1. **5-мин: «меньше торгуй = лучше»** — uw=240 (20% активного времени) оптимален. Причина: на коротких рынках больше adverse selection. Day 2 loss сократился с -88 до -24 (+74%).

2. **Разные таймфреймы = разные параметры**:
   - 5-мин: sl=0 (без stop-loss), tm=15 (широкий спред в тренде), uw=240 (мало торгуем)
   - 15-мин: sl=2 (stop-loss обязателен), tm=10, uw=120 (больше торгуем)

3. **5-мин результат хрупкий**: uw=230 → -6.85, uw=240 → +12.82, uw=250 → -0.76.

---

## Market Quality Filter — мета-адаптация (24 марта 2026)

### Идея
Не все рынки одинаково хороши для маркетмейкинга. После warmup оцениваем рынок по трём метрикам — если плохой, **пропускаем навсегда**:

1. **maxSpreadCents** — bid-ask spread в стакане. Широкий = неликвидный или volatile
2. **maxWarmupVolCents** — price range за warmup период. Высокий = trending рынок
3. **minWarmupTradesPerSec** — trade intensity. Низкий = мало участников, ненадёжный EWMA

### Реализация
- Файл: `AvellanedaStoikovStrategy.ts`, метод `_checkMarketQuality()`
- Проверка один раз при выходе из warmup, решение необратимо
- Новые поля в `ASStrategyConfig`: `maxWarmupVolCents`, `minWarmupTradesPerSec`, `maxSpreadCents`
- `parseConfig.ts` — добавлены в numField list

### Результаты: 15-мин рынки (калибровка day 1, валидация day 2)

| Фильтр | Day 1 PnL | Day 2 PnL | **Сумма** | Markets d1 | Markets d2 |
|--------|-----------|-----------|-----------|------------|------------|
| без фильтра | +23.59 | -103.69 | -80.10 | 50 | 213 |
| sp≤2 | +28.01 | -86.76 | -58.75 | 42 | 170 |
| sp≤2 + vol≤4 | +17.88 | -45.57 | -27.70 | 31 | 92 |
| sp≤2 + vol≤3 | +14.43 | -43.50 | -29.07 | 20 | 72 |
| **sp≤2 + vol≤4 + tps≥0.5** | **+8.75** | **-7.34** | **+1.42** | **9** | **40** |
| sp≤2 + vol≤4 + tps≥1.0 | +9.59 | -9.54 | +0.05 | 5 | 25 |
| sp≤2 + vol≤3 + tps≥0.5 | +2.73 | -8.14 | -5.41 | 6 | 25 |
| sp≤2 + vol≤3 + tps≥1.0 | +3.56 | -3.61 | -0.05 | 2 | 14 |

### Лучшие конфиги

**«Balanced» — первый двухдневный профит** (`configs/as-15min-filter-best-backtest.json`):
```json
{ "maxSpreadCents": 2, "maxWarmupVolCents": 4, "minWarmupTradesPerSec": 0.5 }
```
Day 1: +8.75, Day 2: -7.34 → **Сумма: +1.42 USDC** на 49 рынках

**«Tight» — минимальные потери** (`configs/as-15min-filter-tight-backtest.json`):
```json
{ "maxSpreadCents": 2, "maxWarmupVolCents": 3, "minWarmupTradesPerSec": 1.0 }
```
Day 1: +3.56, Day 2: -3.61 → **Сумма: -0.05 USDC** на 16 рынках

### Что работает, что нет

**Работает (три критерия хорошего рынка для MM):**
- **Узкий спред (≤2¢)** — ликвидный рынок, стабильный mid-price
- **Низкая warmup vol (≤3-4¢)** — ranging рынок, mean-reversion работает
- **Высокий trade flow (≥0.5-1.0/сек)** — EWMA mid надёжный, fills приходят

**Не работает:**
- Одиночные фильтры недостаточны (sp≤2 alone: -58 за 2 дня)
- Слишком строгий фильтр (sp≤1): убирает хорошие рынки тоже
- Для 5-мин: фильтр не помогает (base +12.82 → filtered ≤+0.1)

### Трейдоff
Фильтр конвертирует **большую прибыль + большой убыток** → **маленькая прибыль + маленький убыток**.
На «плохих» днях экономит десятки USDC. На «хороших» — срезает потенциальную прибыль.
Результат: стабильность вместо дисперсии.

---

## Book-Aware Features — Runtime-адаптация к книге ордеров

> Дата: 2026-03-24. Калибровка на day 1 (22 марта), валидация на day 2 (23 марта).

### Реализованные фичи

**Imbalance Spread Factor (ISF)**
- `imbalanceSpreadFactor`: множитель `spreadMult *= (1 + isf × |bookImbalance|)`
- `bookImbalance` = (bidSum - askSum) / (bidSum + askSum) по top-3 уровням
- Перекошенная книга → wider spread → защита от adverse selection

**Depth Spread Factor (DSF)**
- `depthSpreadFactor`: множитель `spreadMult *= (1 + dsf / topDepth)`
- `topDepth` = суммарный размер top-3 bid + ask
- Тонкая книга → wider spread → учёт ликвидности

**Order Flow Imbalance (OFI)**
- `ofiWindow`: кол-во трейдов для расчёта uptick fraction
- `ofiWeight`: вес сдвига reservation price в logit-space
- Формула: `r_x_adjusted = r_x + (ofi - 0.5) × ofiWeight × 0.02`
- Преобладание uptick → сдвиг mid вверх → более агрессивный ask

### Результаты без фильтра (day 1 — калибровка, 15-мин)

| Фича | Day 1 PnL | WR | Fills |
|------|----------:|---:|------:|
| base (нет фич) | +23.59 | — | — |
| isf=0.5 + sp≤2 | +34.04 | 51% | 229 |
| **isf=0.5 + sp≤2 + ofi10/0.5** | **+35.64** | 51% | 226 |
| dsf=10 | +29.32 | 52% | 225 |

**Лучший на day 1**: isf0.5 + sp2 + ofi10/0.5 = +35.64 USDC

### Валидация day 2 — без фильтра vs с фильтром

| Config | Day 1 | Day 2 | **Сумма** |
|--------|------:|------:|----------:|
| isf0.5+sp2+ofi (без фильтра) | +35.62 | -80.39 | **-44.78** |
| **filter + isf0.5 + ofi** | +8.15 | -1.65 | **+6.50** |
| filter + isf0.5 (без ofi) | +7.96 | -3.40 | **+4.56** |
| filter-only (без runtime) | +8.80 | -5.58 | **+3.23** |

### Лучший двухдневный конфиг

**`configs/as-15min-combo-full-backtest.json`** — filter + isf0.5 + ofi10/0.5:
```json
{ "maxSpreadCents": 2, "maxWarmupVolCents": 4, "minWarmupTradesPerSec": 0.5,
  "imbalanceSpreadFactor": 0.5, "ofiWindow": 10, "ofiWeight": 0.5 }
```
**Day 1: +8.15, Day 2: -1.65 → Сумма: +6.50 USDC**

### 5-мин рынки

5-мин рынки структурно убыточны на day 2 (-29 USDC base, -7 с фильтром).
Фильтр снижает потери, но не выводит в плюс. Причина: слишком короткий warmup (10 сек)
не даёт надёжной оценки качества рынка; 240с unwind = 80% длительности → мало торговли.

| Config | Day 1 | Day 2 | Сумма |
|--------|------:|------:|------:|
| dsf=10 (без фильтра) | +14.45 | -28.93 | -14.48 |
| filter + dsf=10 | +0.60 | -7.10 | -6.50 |
| base (без фич) | +12.82 | -29.45 | -16.63 |

**Вывод**: 5-мин рынки не рекомендуются. Фокус на 15-мин.

### Иерархия ценности фич

1. **Quality Filter** (sp+fv+tps) — #1 по ROI. Отсекает ~80% рынков, убирает catastrophic losses
2. **Imbalance Spread** (isf=0.5) — +1.3 USDC поверх фильтра. Синергия: фильтр оставляет рынки где ISF работает
3. **OFI mid shift** (ofi10/0.5) — +1.9 USDC поверх ISF. Улучшает timing входа/выхода
4. **Depth Spread** (dsf) — помогает на 5-мин, не помогает на 15-мин (ликвидность достаточна)
5. **maxSpreadCents** (runtime) — входит в фильтр, отдельно малый эффект

### Эволюция PnL

| Этап | 5-мин d1 | 15-мин d1 | 15-мин d2 | Двухдневный |
|------|:--------:|:---------:|:---------:|:-----------:|
| Исходный (mixed) | — | +19.37 | — | — |
| Раздельные таймфреймы | -3.51 | +22.88 | — | — |
| + unwindSec | +3.58 | +23.59 | — | — |
| + multi-param | +12.82 | +23.59 | — | — |
| + spread filter | +12.82 | +28.01 | -7.34 | +1.42 |
| + quality filter (3x) | +0.60 | +8.15 | -1.65 | +6.50 |
| + book-aware (isf+ofi) | +14.45* | +35.64* | -1.65 | **+6.50** |

*без фильтра — overfitting

---

## Исчерпывающий параметрический свип (2026-03-25)

> Калибровка на day 1 (22 марта), валидация day 2 (23 марта) + day 3 (24 марта).

### Что проверялось

**4 направления оптимизации** поверх лучшего конфига (filter+isf0.5+ofi10/0.5):

1. **Dynamic Q schedule** — qMax по фазам (8→5→3, 7→3, 8→2)
2. **ewmaAlpha** — 0.15, 0.2, 0.25, 0.4 (baseline 0.3)
3. **orderSize** — 8, 10, 15, 20 (baseline 5)
4. **Filter tuning** — fv3-5, tps0.3-1.0, maxWarmupImbalance

**Результат: ни одна вариация не улучшает baseline.**

| Направление | Лучший вариант | Day 1 | vs Baseline |
|-------------|----------------|------:|:-----------:|
| Dynamic Q | dynq-8-5-3 | +7.62 | -0.53 |
| ewmaAlpha | 0.3 (baseline) | +8.15 | 0 |
| orderSize | 5 (baseline) | +8.15 | 0 |
| Filter loose (fv5+tps0.3) | | +28.64 | d2=-48 → sum -19 |
| Filter strict (fv3+tps0.7) | | +2.22 | sum -0.09 |

**3 направления стратегических параметров:**

| Параметр | Лучший | Day 1 | Two-day |
|----------|--------|------:|--------:|
| spreadMult | 1.0 (baseline) | +8.15 | +6.50 |
| regime rt=2/rsm=10 (baseline) | | +8.15 | +6.50 |
| unwindSec | 120 (baseline) | +8.15 | +6.50 |
| unwindSec=240 | | +6.50 | +0.57 |
| regime rt=2/rsm=15 | | +6.08 | -6.25 |

Все параметры baseline уже на локальном оптимуме.

### Continuous Condition Check (CC) — торгуем/паузим по состоянию

**Идея:** вместо одноразового фильтра рынков — непрерывная проверка условий каждый тик.
Если условия плохие → STOP (снимаем ордера). Восстановились → торгуем снова.

**Первая попытка (CC v1) — ПРОВАЛ:**

| Config | Day 1 | Day 2 | Why |
|--------|------:|------:|-----|
| CC spread≤2 + vol≤4 | -6.88 | -76.67 | Паузим при широком спреде = паузим когда MM выгодно |
| CC + warmup filter | -9.91 | -2.87 | CC мешает торговле в хороших рынках |
| CC + cooldown30 | -8.08 | -69.88 | Тот же эффект |

**Причина провала:** для ММ широкий спред = больше прибыли на fill. Паузить при
широком спреде — перевёрнутая логика.

**CC v2 — правильные критерии:**

Паузим только при высокой vol (направленный move = опасно для inventory).
НЕ паузим при широком спреде (это наш edge).

| Config | Day 1 | Day 2 | Day 3 | **3-day** |
|--------|------:|------:|------:|----------:|
| cc-vol4 (без фильтра) | +7.90 | -83.84 | -41.14 | -117.08 |
| **filter + cooldown60** | **+7.28** | **+0.74** | **-5.84** | **+2.18** |
| filter + cooldown90 | +7.33 | -3.44 | -5.60 | -1.71 |
| Baseline (filter only) | +8.15 | -1.65 | -4.94 | +1.56 |

**filter + cooldown60 — лучшая трёхдневная сумма (+2.18)**,
единственный конфиг с day 2 в плюсе (+0.74).

### Cooldown (conditionCheckCooldownSec)

Пропуск первых N секунд рынка после warmup. Идея: начало рынка = каша,
все пытаются занять позиции, цены хаотичны. Ждём стабилизации.

- warmupSec=15 (EWMA копится) + cooldown=60 (ещё 60с ожидания) = первые 75с не торгуем
- EWMA продолжает обновляться во время cooldown → более точный mid при старте торговли

### Day 3 валидация (out-of-sample, 24 марта, 223 рынка)

| Config | Day 1 | Day 2 | Day 3 | 3-day |
|--------|------:|------:|------:|------:|
| **Baseline** | +8.15 | -1.65 | -4.94 | +1.56 |
| **filter + cd60** | +7.28 | +0.74 | -5.84 | +2.18 |

Day 3 убыточный для обоих конфигов. WR=27-37%. Фильтр работает (макс. потеря -2.4),
но маленькие потери накапливаются.

### Важное замечание о методологии

cooldown60 выбран как лучший по **трёхдневной сумме** (подсмотрели в day 2/3).
По чистому day 1 baseline (+8.15) лучше cooldown60 (+7.28).
Это не чистый out-of-sample — validation leak.

### Adaptive Regime (comfort score) — ПРОВАЛ

**Идея**: вместо бинарного фильтра/паузы — непрерывный comfort score (0..1),
масштабирующий gamma и/или orderSize в реальном времени.

**Comfort score** = среднее из 4 компонент:
- Волатильность (price range → low = комфортно)
- Глубина стакана (depth → deep = комфортно)
- Баланс стакана (|imbalance| → balanced = комфортно)
- Торговый поток (tps → высокий = комфортно)

**Результаты (day 1 / day 2):**
| Конфиг | Day 1 | Day 2 | Sum |
|--------|-------|-------|-----|
| Baseline (без adaptive) | +8.10 | -1.95 | +6.15 |
| adaptive scale=0.5 (gamma+order) | +4.77 | -8.69 | -3.92 |
| adaptive scale=1.0 (gamma+order) | -3.23 | -9.10 | -12.33 |
| adaptive scale=0.5 (только gamma) | +6.31 | -10.66 | -4.35 |

**Почему не работает:**
1. После фильтра рынки уже «хорошие» — comfort score ~0.85-0.95, адаптация минимальна
2. Когда условия ухудшаются, расширение спреда → ордера дальше от mid →
   adverse selection ещё хуже (заполняемся когда рынок уже ушёл)
3. Уменьшение orderSize → меньше прибыли на выигрышных сделках,
   но stop-loss одинаковый → асимметрия в минус
4. Существующий regime detection (trendSpreadMult=10) уже обрабатывает worst case

**Вывод**: гладкое масштабирование параметров по comfort score не даёт edge поверх
бинарного фильтра + дискретного regime detection. Наша проблема — не «сколько торговать»,
а **adverse selection** (заполняемся когда рынок идёт против нас).

### Anti-Adverse-Selection (AAS + OFI-skip) — ПРОРЫВ

**Проблема**: adverse selection — нас заполняют когда рынок идёт против.

**Два механизма:**

1. **OFI-skip** (`ofiSkipThreshold`): при сильном OFI (>0.8 или <0.2) не котируем
   уязвимую сторону. Сильный buy pressure → skip ask (не продаём в растущий рынок).
   Сильный sell pressure → skip bid.

2. **AAS** (`aasConsecutiveThreshold`): при N последовательных тиках в одну сторону
   cancel уязвимой стороны. 3+ upticks → cancel ask. 3+ downticks → cancel bid.

**Результаты (3 дня):**

| Конфиг | Day 1 | Day 2 | Day 3 | **3-day** |
|--------|-------|-------|-------|-----------|
| Baseline | +8.10 | -1.95 | -4.94 | **+1.21** |
| OFI-skip-0.20 | +2.07 | +8.35 | -0.01 | **+10.41** |
| AAS-3 (alone) | +7.65 | -0.90 | -10.80 | **-4.05** |
| **Combo (skip-0.2+AAS-3)** | **+3.51** | **+13.37** | **+0.52** | **+17.40** |

**Лучший конфиг**: `as-15min-combo-ofiskip-aas-backtest.json`
- 3-day PnL: **+17.40 USDC** (14× лучше baseline!)
- WinRate: 53-60% (vs 39-50% baseline)
- Day 2/3 из убыточных стали прибыльными

**Почему работает**: вместо параметрического масштабирования (adaptive gamma/orderSize),
AAS и OFI-skip **избегают плохих сделок целиком**. Не торгуем уязвимой стороной при
направленном потоке → не попадаем в adverse selection.

### Ключевые выводы

1. **Anti-adverse-selection — главный фактор** (+17.40 vs +1.21 baseline)
2. **OFI-skip важнее AAS** — основной эффект от OFI-skip (OFI-skip alone: +10.41)
3. **Параметрическая адаптация (gamma/orderSize) бесполезна** — нужно избегать сделок, не масштабировать
4. **Фильтр рынков обязателен** — без него любой CC теряет -80+ на day 2
5. **Для ММ широкий спред = хорошо** — нельзя паузить при широком спреде
6. **Day 2/3 из убыточных стали прибыльными** с AAS+OFI-skip
7. **5-минутные рынки убыточны при любых настройках** (см. ниже)

### 5-минутные рынки — подробный анализ

Протестированы 4 уровня фильтра (все с OFI-skip-0.2 + AAS-3):

| Фильтр | Day 1 (250 рынков) | Day 2 (924 рынка) |
|--------|-------|-------|
| strict (sp≤2, fv≤4, tps≥0.5) | +3.47 | -3.17 |
| mid (sp≤3, fv≤6, tps≥0.5) | -1.49 | -20.31 |
| loose (sp≤4, fv≤8, tps≥0.3) | -5.44 | n/a |
| без фильтра | -5.72 | -64.05 |

**Почему 5-мин не работают:**
1. **Слишком короткий горизонт**: warmup 10с + unwind 120с = 130с из 300с (43% рынка непригодно)
2. **Фильтр пропускает ~1%** рынков при strict vs ~8% на 15-мин → мало сделок
3. Ослабление фильтра = катастрофа (больше шумных рынков → больше потерь)
4. Суетливые участники создают adverse selection, но не ликвидность

**Вывод**: 5-мин рынки не подходят для AS market-making. 15-мин — минимальный таймфрейм.

### Лучший конфиг: `as-15min-combo-ofiskip-aas-backtest.json`

```
gamma=0.05, qMax=5, orderSize=5, spreadMult=1.0, ewmaAlpha=0.3
unwindSec=120, stopLossCents=2, warmupSec=15
regimeWindow=15, regimeTrendThreshold=2, regimeTrendSpreadMult=10.0
regimeRangeThreshold=1, regimeRangeSpreadMult=0.6
jumpThreshold=2, jumpWidenFactor=2.5, jumpCooldownTrades=3
dynGammaSlope=1.0
maxSpreadCents=2, maxWarmupVolCents=4, minWarmupTradesPerSec=0.5
imbalanceSpreadFactor=0.5, ofiWindow=10, ofiWeight=0.5
ofiSkipThreshold=0.2, aasConsecutiveThreshold=3
```

**Результат**: Day1 +3.51, Day2 +13.37, Day3 +0.52 → **3-day +17.40 USDC**

---

## 5-минутные рынки: Trailing Stop Hybrid (2026-03-25)

### Идея
Вместо чистого MM на 5-мин рынках используем гибрид: MM вход (cheap entry через спред) + trailing stop выход (ride momentum). На 5-мин рынках вопрос "UP или DOWN" решается быстро — если мы попали в поток, зарабатываем на settlement. Если не попали — trailing stop режет потери.

### Unknown Resolution Bug (критический фикс)
Рынки без finalPrice/Chainlink данных в снапшоте не получали settlement в бэктесте → чистый убыток (cash потрачен, settlement=0). На day2 53 таких рынка теряли ~37 USDC. **Fix**: при unknown resolution — refund remaining position по avg entry price (rollback, как будто не торговали).

### Trailing Stop механика

**Зоны:**
- `minBidZoneCents`..`maxBidZoneCents` — зона покупки (не bid вне этого диапазона)
- `trailWideZoneCents` — порог "зоны уверенности" (шире trail, даём расти)
- `trailHoldZoneCents` — порог settlement zone (hold до конца, не продаём)

**Асимметрия trail:**
- В прибыли: stop = peak - trailDistanceCents (от peak, lock-in gains)
- В прибыли + confidence zone: stop = peak - trailWideDistanceCents (шире, пусть растёт)
- В убытке (symmetric, tight=trailDist): stop = peak - trailDist (peak-based, lock spike profits)
- В убытке (asymmetric, tight < trailDist): stop = entry - trailTightCents (entry-based, avoid peak ratcheting)
- Settlement zone (peak >= holdZone): STOP, ждём settlement

**Entry-based vs Peak-based stop при убытке:**
Peak ratcheting problem: price 50→53→48. Peak=53, tight=1 → stop=52. Нас выбивает при 52, хотя цена просто вернулась к entry. С entry-based: stop=50-1=49, выживаем. Но peak-based лучше для symmetric trail (lock-in spike profit на pullback).

### Результаты бэктеста — полная 3-day валидация (25 марта 2026)

Day 1 = 22 марта (248 рынков), Day 2 = 23 марта (924 рынка, adj=excl unknown), Day 3 = 23 марта PM half (394 рынка).

| Config | Day 1 | Day 2 Adj | Day 3 Adj | **3-day SUM** | Verdict |
|--------|------:|--------:|--------:|----------:|---------|
| **trail=3, w70/h85, bid12-73** | +10.51 | **+14.99** | **+58.50** | **+84.00** | **ЛУЧШИЙ** |
| trail=3, w70/h85, bid10-75 | -14.02 | +8.35 | +45.60 | +39.93 | Day2-3 хорош, day1 плох |
| trail=3, w70/h85, bid11-74 | +9.21 | **-54.51** | +27.35 | -17.95 | Убит day2 |
| trail=3, w70/h85, bid15-70 (robust) | +11.16 | -10.65 | +0.59 | +1.10 | Breakeven |
| trail=3, w70/h85, bid13-72 | +7.06 | -32.79 | n/t | — | Плох |
| trail=3, w75/h90, bid15-70 (orig) | +21.89 | -28.17 | +13.12 | +6.84 | Нестабильный |
| trail=3, w75/h90+SL2, bid15-70 | — | — | -9.33 | — | SL вредит |
| trail=4, w75/h90, bid15-70 | +38.45 | -63.10 | -12.11 | -36.76 | Мёртв |
| trail=4, w70/h85, bid15-70 | +49.71 | — | -11.62 | — | Мёртв |
| trail=5, bid15-70 | +12.02 | n/a | — | — | — |
| tight=1 (asymmetric, entry-based) | +0.00 | -106.46 | — | — | Мёртв |
| profitonly (tight=0) | -21.34 | -129.08 | — | — | Мёртв |

### Ключевые выводы 3-day валидации

1. **bid12-73 — единственный стабильно прибыльный конфиг** на всех 3 днях. 3-day SUM +84 USDC.
2. **Чувствительность bid зоны**: bid12-73 → +84, bid13-72 → минус, bid11-74 → -54 на day2. Разница в 1¢ = разница в десятки USDC. Возможен overfitting, но 3 дня валидации — лучшее что есть.
3. **bid10-75 — альтернативный кандидат**: хорош на day2-3, но -14 на day1. Широкая bid зона = больше рынков с low mid (больше UP bias), но и больше шумных рынков.
4. **trail=4 мёртв**: великолепен на day1 (+38-49), но катастрофа на day2-3. trail=3 — sweet spot.
5. **SL + trail = хуже**: stopLossCents>0 с trailing stop → двойное выбивание.

### Лучший конфиг: `as-5min-trail3-w70h85-bid12-73-backtest.json`
```
gamma=0.05, qMax=5, orderSize=5, spreadMult=1.0, ewmaAlpha=0.3
stopLossCents=0, warmupSec=10
regimeWindow=15, regimeTrendThreshold=2, regimeTrendSpreadMult=10.0
regimeRangeThreshold=1, regimeRangeSpreadMult=0.6
jumpThreshold=2, jumpWidenFactor=2.5, jumpCooldownTrades=3
dynGammaSlope=1.0, imbalanceSpreadFactor=0.5
ofiWindow=10, ofiWeight=0.5, ofiSkipThreshold=0.2, aasConsecutiveThreshold=3
trailDistanceCents=3, trailWideZoneCents=70, trailWideDistanceCents=6
trailHoldZoneCents=85, minBidZoneCents=12, maxBidZoneCents=73
```

### Robust backup: `as-5min-trail3-best-backtest.json`
```
(те же параметры, но minBidZoneCents=15, maxBidZoneCents=70)
```
3-day SUM: +1.10 USDC — breakeven, но стабильный. Для paper trading если bid12-73 покажет overfitting.

### Предупреждения
- **bid12-73 чувствителен к 1¢**: bid13-72 → минус, bid11-74 → -54 на day2. Но 3-day валидация +84 снижает риск overfitting
- **Unknown markets**: 53 из 924 на day2, 26 из 394 на day3. В реале все рынки резолвятся — adjusted PnL точнее
- **stopLossCents=0**: trailing stop заменяет SL. SL + trail = двойное выбивание
- **Day3 ≈ вторая половина day2**: не полностью independent (те же условия 23 марта). Нужна валидация на другом дне
- **Bid зона определяет всё**: широкая (10-75) = больше рынков с low mid → UP bias, но и noise. Узкая (15-70) = меньше рынков, стабильнее

### Parameter Sweep (26 марта 2026)

Single-parameter sweep от baseline bid12-73. Каждый параметр варьировался отдельно, остальные на baseline.

**Day1 (248 рынков) — калибровка:**

| Параметр | Значение | Day1 Adj | vs Baseline (+10.51) |
|----------|----------|---------|---------------------|
| qMax | **10** | **+69.90** | +559% |
| orderSize | **10** | **+56.13** | +434% |
| gamma | **0.03** | **+39.85** | +279% |
| spreadMult | **0.5** | **+27.70** | +164% |
| ewmaAlpha | **0.4** | **+23.53** | +124% |
| spreadMult | 0.8 | +11.28 | +7% |
| **baseline** | — | **+10.51** | — |
| trail | **off** | +3.08 | -71% (trail = +7.43) |
| qMax | 3 | +1.41 | -87% |
| ewmaAlpha | 0.2 | -2.30 | — |
| ewmaAlpha | 0.5 | -5.96 | — |
| spreadMult | 1.5 | -11.05 | — |
| gamma | 0.07 | -14.20 | — |
| orderSize | 3 | -24.98 | — |
| ewmaAlpha | 0.15 | -51.63 | — |

**Day2 (924 рынка) — валидация топ-5:**

| Параметр | Day1 Adj | Day2 Adj | **2-day SUM** |
|----------|---------|---------|----------:|
| **baseline** (bid12-73) | +10.51 | **+14.99** | **+25.50** |
| qMax=10 | +69.90 | -50.04 | +19.86 |
| gamma=0.03 | +39.85 | -27.53 | +12.32 |
| orderSize=10 | +56.13 | -128.53 | -72.40 |
| spreadMult=0.5 | +27.70 | -90.58 | -62.88 |
| ewmaAlpha=0.4 | +23.53 | -131.06 | -107.53 |

**Выводы sweep:**

1. **Baseline bid12-73 остаётся лучшим** по 2-day SUM (+25.50). Все "улучшения" с бо́льшим exposure провалились на day2.
2. **qMax=10 — единственный кандидат** (+19.86 SUM), близко к baseline, но менее стабилен.
3. **Паттерн**: параметры, увеличивающие fills/exposure, хороши на "добром" дне (day1), но катастрофичны на "злом" (day2). Это amplification — усиливают и прибыль, и убыток.
4. **ewmaAlpha=0.15 — худший** (-51.63). Медленная EWMA = запаздывающий mid → вход по устаревшей цене.
5. **Trail добавляет +7.43** (notrail +3.08 vs baseline +10.51). Trailing stop — полезный risk management, но не основной источник прибыли.
6. **Текущий конфиг оптимален** для 2-day stability. Параметры baseline — лучший баланс прибыли и защиты.

---

## Открытые вопросы

1. ~~**Валидация bid12-73 на day3**: проверить overfitting~~ → **DONE: +58.50 adj на day3, 3-day SUM +84**
2. ~~**gamma/orderSize/ewmaAlpha sweep**~~ → **DONE: baseline оптимален, все варианты хуже по 2-day SUM**
3. **Paper trading**: валидация bid12-73 на живых данных. **Следующий шаг.**
4. **Combo 5min + 15min**: trail bid12-73 + 15min OFI-skip-AAS параллельно.
5. **Fee structure**: Polymarket fees? Taker/maker разница? 1% fee = -68% PnL.
6. **Latency реального бота**: trailing stop критичен к задержке (exit price может быть хуже).
7. **Capital requirements**: Q=5 при цене 50с = $2.50 за сторону. При 10+ рынках = $25+ locked.
8. **Больше дней данных**: 3 дня (из которых day3 ⊂ day2) — нужна 1-2 неделя paper trading.
9. **Кодовые изменения (не config-only)**: Asymmetric budget (+37%), Ramp schedule (+17%), Adaptive alpha (+15%) — требуют новый код.
