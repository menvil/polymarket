# Exit Policy Table — трёхуровневый fallback для fairCents

## Проблема

Основная 6D exit-policy таблица (side, entry, current, tau, **delta**, regime) покрывает
только ~13% возможных комбинаций. Когда позиция уходит в глубокий минус (BTC падает
$150–200 от страйка), delta попадает в редко наблюдаемый бакет и зона не найдена.

Последствие: `fairCents = null` → `_riskBudgetExitPlan()` возвращает `null` → весь
риск-бюджет отключён, позиция может удерживаться до 0–3¢.

## Решение: трёхуровневый fallback

```
Уровень 1 (6D):  основная таблица — side, entry, current, tau, delta, regime
                 ↓ зона не найдена или n < minSamples
Уровень 2 (4D):  fallback таблица (noDelta: true) — side, entry, current, tau, regime
                 покрытие ~90%, т.к. delta исключена
                 ↓ и там не найдено
Уровень 3:       conservative fair = currentBidCents
                 holdEdge = 0, drawdown всё равно давит к выходу
```

### Почему уровень 3 не блокирует риск-бюджет

При `fairCents = currentBidCents`:

- `holdEdgeCents = fairCents - currentBidCents = 0`
- Нет HoldEdge-бонуса → `stateRisk` не снижается
- `drawdownRisk = clamp(drawdownCents × 1.4, 0, 28)` работает в полную силу
- `targetExposurePct = tolerance(70) - stateRisk` → при глубоком минусе → 0%

## Сборка fallback-таблицы

```bash
npx tsx scripts/build-exit-policy-table.ts \
  --snapshots ../collect-data/snapshots/2026-04-16,...,2026-04-30 \
  --asset bitcoin \
  --out tables/exit-policy-5min-cll-apr-nodelta.json \
  --entry-min 40 --entry-max 85 --entry-step 5 \
  --current-step 5 --tau-step 20 \
  --min-n 10 --min-hold-edge-cents 3 --exit-edge-cents 1 \
  --no-delta
```

Флаг `--no-delta` записывает `"noDelta": true` в мета таблицы, и `ExitPolicyTable`
автоматически строит 5-частный ключ `side:entry:current:tau:regime`.

## Конфигурация

```json
{
  "strategyParams": {
    "exitPolicyTablePath": "./tables/exit-policy-5min-cll-apr.json",
    "exitPolicyFallbackTablePath": "./tables/exit-policy-5min-cll-apr-nodelta.json",
    "exitPolicyMinSamples": 5,
    "exitPolicySkipUnknown": true
  }
}
```

## Алгоритм в коде

`CexLeadLagRiskBudgetStrategy._riskBudgetFairCents()`:

1. Если основная таблица и `data.exitPolicyZone` найдена (n ≥ minSamples) → возвращает `winRate × 100`.
2. Если fallback таблица задана → повторяет lookup с тем же `exitPolicyLookupInput`, но в noDelta-таблице.
3. Если fallback тоже не найден, но `exitPolicyFallbackTable` задан → возвращает `currentBidCents`.
4. Если ни одна таблица не задана → возвращает `null` (риск-бюджет отключён).

Уровень 3 активен только когда fallback таблица **задана** (opt-in), чтобы не менять
поведение конфигураций без fallback.
