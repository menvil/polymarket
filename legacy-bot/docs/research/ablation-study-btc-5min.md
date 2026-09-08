# Ablation Study: AS Strategy Features on BTC 5-min Markets

## Дата исследования: 2026-03-27

## Цель

Определить вклад каждой фичи AS стратегии в общий результат. Baseline = zone55 конфиг со всеми фичами. Для каждой фичи создаётся конфиг с её отключением и сравнивается с baseline.

## Данные

- **Актив**: Bitcoin Up/Down (5-минутные рынки)
- **Day1**: 69 рынков (March 22 afternoon)
- **Day2**: 254 рынков (March 22 evening)
- **Day4**: 173 рынков (March 23 evening + March 24)
- **Day5**: 207 рынков (March 24 evening + March 25)
- Day3 пропущен — нет BTC в 5min-snapshots-day3 (только ETH/SOL/XRP)
- **Всего**: 703 BTC рынка

## Baseline конфиг (zone55)

```json
{
  "gamma": 0.05, "qMax": 5, "orderSize": 5,
  "ewmaAlpha": 0.3, "minTradesForMid": 5, "warmupSec": 10,
  "regimeWindow": 15, "regimeTrendThreshold": 2, "regimeRangeThreshold": 1,
  "regimeTrendSpreadMult": 10.0, "regimeRangeSpreadMult": 0.6,
  "jumpThreshold": 2, "jumpWidenFactor": 2.5, "jumpCooldownTrades": 3,
  "dynGammaSlope": 1.0, "imbalanceSpreadFactor": 0.5,
  "ofiWindow": 10, "ofiWeight": 0.5, "ofiSkipThreshold": 0.2,
  "aasConsecutiveThreshold": 3, "trailDistanceCents": 0,
  "minBidZoneCents": 55, "maxBidZoneCents": 73,
  "dynSizeAlpha": 1.0, "dynSizeMinRatio": 0.3, "dynSizeMaxRatio": 2.0
}
```

## Результаты: отключение одной фичи

| Config | Что отключено | Day1 | Day2 | Day4 | Day5 | SUM | Δ vs baseline |
|--------|--------------|------|------|------|------|-----|---------------|
| **abl-baseline** | **ничего** | **-3.7** | **+7.7** | **+2.1** | **-30.5** | **-24.5** | **0** |
| abl-no-dyngamma | dynGammaSlope=0 | -1.9 | +9.9 | +2.0 | -22.2 | -12.2 | **+12.3** |
| abl-no-regime | regimeWindow=0 | +0.8 | -6.0 | -1.0 | -10.9 | -17.2 | **+7.3** |
| abl-no-jump | jumpThreshold=0 | -3.6 | +9.9 | +0.4 | -25.6 | -18.9 | **+5.6** |
| abl-no-imbal | imbalanceSpreadFactor=0 | -4.0 | +5.5 | -0.1 | -23.5 | -22.1 | +2.4 |
| abl-no-aas | aasConsecutiveThreshold=0 | -3.5 | +9.4 | +0.9 | -29.4 | -22.5 | +2.0 |
| abl-no-ofi-aas | ofiWeight=0, aas=0 | -5.7 | +9.2 | +3.9 | -31.8 | -24.3 | +0.2 |
| abl-no-ofi | ofiWeight=0 | -6.2 | +7.9 | +3.4 | -32.0 | -26.8 | -2.3 |
| abl-no-dynsize | dynSizeAlpha=0 | -3.4 | +4.0 | -1.1 | -26.4 | -27.0 | -2.5 |
| abl-no-warmup | warmupSec=0 | -4.0 | +4.2 | +2.1 | -32.3 | -29.9 | **-5.4** |
| abl-no-ofiskip | ofiSkipThreshold=0 | -6.5 | -21.2 | +4.4 | -29.4 | -52.7 | **-28.2** |
| abl-no-zone | minBidZone=1,maxBid=99 | -5.4 | -33.8 | -25.2 | -35.3 | -99.6 | **-75.1** |

## Результаты: комбинации

| Config | Что включено | Day1 | Day2 | Day4 | Day5 | SUM |
|--------|-------------|------|------|------|------|-----|
| **zone-only** | zone + warmup + base AS | **-1.9** | **-0.9** | **+5.0** | **-1.7** | **+0.4** |
| no-bad3 | всё минус regime/jump/dyngamma | +0.8 | -6.0 | +2.0 | -10.7 | -13.8 |
| zone-ofiskip | zone+warmup+ofiskip | +0.6 | -4.0 | +1.5 | -12.3 | -14.2 |
| no-bad5 | всё минус 5 вредных | +0.6 | -3.7 | +1.8 | -13.7 | -14.9 |
| **baseline** | **всё** | **-3.7** | **+7.7** | **+2.1** | **-30.5** | **-24.5** |

## Классификация фич

### Критически важные (убрать = сильно хуже)

- **Zone filter (55-73¢)**: -75.1 USDC без него. Ограничивает покупки зоной с лучшим breakeven ratio.
- **OFI skip (threshold=0.2)**: -28.2 USDC без него. Пропускает тики с сильным OFI-сигналом против нас.

### Полезные (убрать = чуть хуже)

- **Warmup (10s)**: -5.4 USDC без него. Не торгуем пока EWMA нестабильна.
- **Dynamic sizing**: -2.5 USDC без него. Адаптирует размер ордера к цене.

### Нейтральные

- **OFI weight**: -2.3 USDC (слабый эффект)
- **AAS**: +2.0 USDC (слабо вредит)
- **Imbalance spread**: +2.4 USDC (слабо вредит)

### Вредные (убрать = лучше)

- **dynGamma (slope=1.0)**: +12.3 USDC без него. Расширяет спред при позиции → хуже fills.
- **Regime detection**: +7.3 USDC без него. Trend/range множители спреда неточные.
- **Jump widen**: +5.6 USDC без него. Расширение спреда после скачка избыточно.

### Парадокс OFI skip

OFI skip критически помогает в одиночном тесте (-28.2), но когда включаем его В КОМБО с zone-only, результат падает с +0.4 до -14.2. Это значит:

- OFI skip помогает когда есть "шумные" фичи (regime/jump/dyngamma) — он компенсирует их вред
- Когда шум убран (zone-only), OFI skip становится вредным — он пропускает хорошие трейды

## Главный вывод

**Минимальный конфиг = лучший результат (+0.4 USDC на 703 рынках):**

```json
{
  "gamma": 0.05, "qMax": 5, "orderSize": 5,
  "ewmaAlpha": 0.3, "minTradesForMid": 5, "warmupSec": 10,
  "minBidZoneCents": 55, "maxBidZoneCents": 73
}
```

Все остальные параметры = 0 (отключены). Простота побеждает сложность.

### Стабильность по дням

zone-only: Day1=-1.9, Day2=-0.9, Day4=+5.0, Day5=-1.7 — **все дни ±5 USDC**, нет катастрофических провалов. Сравним с baseline: Day5=-30.5 (провал из-за regime/jump/dyngamma amplification).

## Следующие шаги

1. Тонкая настройка zone boundaries (55-73 vs 50-75 vs 60-70)
2. Тестирование на других активах (ETH, SOL, XRP)
3. Комбинация с prob-table veto (zone-only + veto)
4. Увеличение sample size для статистической значимости
