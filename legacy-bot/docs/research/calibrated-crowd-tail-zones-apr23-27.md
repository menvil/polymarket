# Calibrated Crowd Tail-Zone Experiment (Apr 23-27 2026)

Короткое исследование по гипотезе: если ослабить gate до `minComposite=0.05`,
то `CalibratedCrowd` начинает ловить не «средние» системные зоны, а редкие
хвостовые mispricing-состояния.

## Что именно проверяли

- Таблица: `tables/edge-table-5min-market-weighted-train-through-20260420.json`
- Актив: `bitcoin`
- Токен: `up`
- Период проверки: `2026-04-23` ... `2026-04-27`
- Параметры риска:
  - `minComposite=0.05`
  - `maxPositionFraction=0.1`
  - `initialCapital=1000`

Важно:

- Числа ниже получены не через `MODE=backtest`, а через быстрый CLI:
  `scripts/backtest-calibrated-crowd.ts`.
- Итоговый `PnL` — это сумма пяти независимых дневных прогонов.
- Каждый день стартовал заново с капиталом `1000`.
- Это не один непрерывный compounded equity curve.

## Команды

Пример шаблона:

```bash
node --import tsx scripts/backtest-calibrated-crowd.ts \
  --snapshots ../collect-data/snapshots/2026-04-23/polymarket \
  --table tables/edge-table-5min-market-weighted-train-through-20260420.json \
  --asset bitcoin \
  --token up \
  --min-composite 0.05 \
  --max-position-fraction 0.1 \
  --initial-capital 1000
```

Точно так же были прогнаны `2026-04-24`, `2026-04-25`, `2026-04-26`, `2026-04-27`.

## Политики выхода

- `hold` — держим позицию до resolution
- `tau-only` — выходим при `tau < 15s`
- `regime-flip` — как `tau-only`, плюс выход на flip режима
- `full-risk` — `tau-timeout + regime-flip + weight-drop + edge-closure`

## Результаты

| Дата | Сделки | Hold PnL | Tau-only PnL | Regime-flip PnL | Full-risk PnL |
|:--|--:|--:|--:|--:|--:|
| 2026-04-23 | 28 | +29.46 | -2.23 | -2.23 | +6.64 |
| 2026-04-24 | 20 | +45.11 | +8.71 | +8.71 | +1.96 |
| 2026-04-25 | 39 | -1.78 | +4.79 | +4.79 | +10.10 |
| 2026-04-26 | 20 | +18.27 | +23.09 | +23.09 | +21.14 |
| 2026-04-27 | 10 | -20.04 | +0.86 | +0.86 | +5.18 |
| **Итого** | **117** | **+71.02** | **+35.22** | **+35.22** | **+45.02** |

## Как читать итоговые числа

- `hold: +71.02` — сумма `totalPnL` по пяти отдельным дневным backtest’ам
- `tau-only: +35.22` — то же для policy с выходом по `tau-timeout`
- `regime-flip: +35.22` — сумма по policy с выходом при смене режима
- `full-risk: +45.02` — сумма по policy с полным набором защитных выходов

Это не значит, что одна непрерывная стратегия выросла с `1000` до `1071.02`.
Это значит, что если сложить результаты пяти отдельных дневных прогонов, получится
`+71.02`.

## Что получилось

- При production-like gate `minComposite=0.3` на `2026-04-23` не было ни одного входа.
- При `minComposite=0.05` стратегия начинает торговать.
- Все входы в этих прогонах пришли из `down` regime.
- `hold` дал лучший суммарный PnL, но неровный профиль по дням.
- `full-risk` уступил `hold` по total PnL, но оказался стабильнее по дням.
- `tau-only` и `regime-flip` на этом окне совпали по итоговой сумме.

## Интерпретация

Это согласуется с observation-level анализом хвостов:

- edge сидит не в «средней» зоне, а в экстремальных состояниях
- основная концентрация сигналов — в резком `down` regime
- слишком строгий `minComposite` душит такие хвостовые сигналы

## Связанные конфиги

Для воспроизводимости рядом добавлены config-профили:

- `configs/cc-backtest-apr23-27-mc005-hold.json`
- `configs/cc-backtest-apr23-27-mc005-tau-only.json`
- `configs/cc-backtest-apr23-27-mc005-regime-flip.json`
- `configs/cc-backtest-apr23-27-mc005-full-risk.json`

Они нужны как reference-конфиги для `MODE=backtest` / replay-режима стратегии.
Числа из таблицы выше всё равно были получены через `scripts/backtest-calibrated-crowd.ts`,
поэтому точное совпадение PnL между двумя путями не гарантируется: у них разный
уровень симуляции исполнения.
