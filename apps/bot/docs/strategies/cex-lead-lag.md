# CexLeadLagStrategy — Диагностика и логирование

## Архитектура выходов

### Активные триггеры выхода

| Триггер | Условие | Тип |
|---------|---------|-----|
| `HARD_STOP` | `tradeEwma < entryPrice − stopLossCents` | emergencyExit |
| `TRAILING_STOP` | `tradeEwma < trailingStopCents` | emergencyExit |
| `TAU_EXIT` | `tauSec < exitTauSec` | emergencyExit |

### Выключенные триггеры (намеренно закомментированы)

`ADVERSE_SIGNAL`, `SIGNAL_COLLAPSE`, `NEGATIVE_NET_EDGE` — выключены.
Стратегия **держит позицию до hard/trailing stop или tau**.

## Паттерн HOLD после BUY+SELL

### Почему стратегия логирует HOLD после размещения SELL

Когда SELL ордер выставлен, токены резервируются (`availableTokenQty = 0`).
Пока fill не придёт, `positionQty > 0` и `availableTokenQty = 0`:

```
_checkExitSignalFirst:
  shouldExit = true (TAU_EXIT или stop)
  availableTokenQty = 0  ← токены зарезервированы для SELL
  → лог HOLD(reason: SELL_IN_FLIGHT)
  → return undefined  (SELL не дублируется)
```

Это **нормальное поведение** — SELL ордер уже в рынке, дублировать не нужно.

В live режиме задержка SELL fill может составлять несколько секунд (WS latency +
on-chain confirmation). Все тики в этот период логируют `HOLD(SELL_IN_FLIGHT)`.

### Баг «зомби-ордер» и его исправление

**Проблема (исправлена 2026-05-12):** Если бот выставил SELL ордер под активным условием выхода,
а затем условие исчезло (стоп отступил, сигнал восстановился), `shouldExit` становился `false`.
Код возвращал `undefined` не проверив, что `availableTokenQty = 0` — SELL ордер оставался в рынке
как «зомби» и мог сыграться в самый неподходящий момент (например, на пути к 99¢ перед резолюцией UP).

**Пример:** 10:15 BTC UP market — SELL @ 55¢ висел 2:41 мин пока цена уходила до 14¢ и обратно.
Сыграли арбитражёры при 55¢ на пути к 99¢. Итог: -1.04 USDC вместо ~+6 USDC.

**Исправление:** В `_checkExitSignalFirst()` перед `return undefined` добавлена проверка зомби-ордера:

```typescript
if (!shouldExit) {
  if (!data.availableTokenQty.gt(0) && data.positionQty.gt(0)) {
    // Отменяем зомби — SELL выставлен ранее, но условие выхода уже не активно
    return { type: 'CANCEL' };  // rejectReason: 'STALE_SELL_ON_HOLD'
  }
  return undefined;
}
```

Исправление применено во всех трёх стратегиях: `CexLeadLagStrategy`, `CexLeadLagRiskBudgetStrategy`,
`CexLeadLagExitPolicyStrategy`.

### HOLD при нормальном удержании позиции

Пока позиция есть и ни один стоп не сработал — стратегия логирует:

```
HOLD(reason: POSITION_HELD_SIGNAL_FIRST)
  stopGuards:
    hardStopLevel: <entryPrice - stopLossCents>
    trailingStop:  <trailingStopCents>
    ewmaVsEntry:   <tradeEwma - entryPrice>  ← положительный = в прибыли
    ewmaVsTrailing: <tradeEwma - trailingStop>  ← положительный = выше стопа
    tauSec:        <секунды до экспирации>
  signalEdge:
    netExpectedEdgeCents, residualBps, signalPersistenceMs
  position:
    qty, entryPriceCents, peakPriceCents, pnlFromEntryCents
```

## SELL лог — структура

```
CexLeadLag: decision  action=SELL  (force=true)
  reason: HARD_STOP | TRAILING_STOP | TAU_EXIT
  ask: <цена продажи>
  size: <размер>
  emergencyExit: true/false
  exitConditions:
    hardStopHit: bool
    trailingStopHit: bool
    tauExit: bool
  stopLevels:
    entryPriceCents:    <цена входа>
    tradeEwmaCents:     <текущий EWMA>
    peakPriceCents:     <максимум с момента входа>
    trailingStopCents:  <уровень trailing stop>
    hardStopLevelCents: <entryPrice - stopLossCents>
    pnlFromEntryCents:  <ewma - entry>  ← +/- P&L
    pnlFromPeakCents:   <ewma - peak>   ← drawdown от пика
  signalEdge:
    residualBps, venueAgreement, netExpectedEdgeCents...
```

## Лог позиций после reconciliation

`PortfolioService.applyFill()` и `applyDirectFill()` логируют позицию
**после каждого fill** (как от WS, так и от REST reconciliation):

```
info: Position after fill
  accountId, fillId, instrumentId
  side: BUY | SELL
  positionQty: <текущий qty после fill>
  positionClosed: true/false
  avgEntryPrice: <средняя цена входа>
```

Это позволяет диагностировать live режим:
если `fills были` но `market summary` показывает `finalTokens: 0.00` —
ищи лог `Position after fill` для этого `instrumentId`, сравни timestamp с
market summary.

## Подсчёт циклов в Market Summary

### Проблема: direct fills не попадали в summary

**Симптом**: `=== Market summary ===` показывает неполное число циклов (buys < реального кол-ва).

**Причина**: fills на ордерах в terminal состоянии (CANCELLED/не найден) обрабатываются
через `applyDirectFill` в `ProcessFillUseCase`. При этом `ORDER_FILLED` / `ORDER_PARTIALLY_FILLED`
события НЕ публикуются → `MarketRotation.fillHistory` не пополняется.

**Типичный сценарий**:
1. Стратегия выставила BUY → отменила через REST (ордер → CANCELED локально)
2. Биржа уже MATCHED ордер → fill приходит по WS на CANCELED ордер
3. `ProcessFillUseCase` → `applyDirectFill` → портфель обновлён, но fill не виден в summary

**Решение** (реализовано):
- `ProcessFillUseCase` публикует `DIRECT_FILL_APPLIED` event после успешного `applyDirectFill`
- `MarketRotation` подписывается и накапливает в `slot.directPartialAccum` (по orderId)
- При закрытии рынка `_printMarketSummary` флашит `directPartialAccum` в `fillHistory`

---

## Аналитика сигналов и ордеров (Signal Analytics)

### Зачем

Для понимания качества торговых решений необходимо отвечать на вопросы:

- Какая цена была в момент выставления ордера? Насколько рынок ушёл пока ордер стоял?
- Какой slippage при исполнении (планировали vs. реально получили)?
- Сигнал появился — что произошло с ценой? Были ли правы при входе?
- Как часто сигнал появляется но вход блокируется другими условиями?

### Новые типы записей в journal

#### `signal_event` — жизненный цикл сигнала

Записывается при каждом переходе состояния сигнала:

| Поле | Тип | Описание |
|------|-----|----------|
| `event` | `SIGNAL_ON \| SIGNAL_OFF \| SIGNAL_ADVERSE` | Тип перехода |
| `midCents` | `number` | EWMA mid Polymarket (¢) в момент события |
| `residualBps` | `number` | Residual CEX vs Chainlink (bps) |
| `netExpectedEdgeCents` | `number` | Edge (¢) в момент события |
| `openOrderPriceCents` | `number?` | Цена открытого BUY-ордера (¢), если есть |
| `driftSinceOrderCents` | `number?` | mid_now − mid_at_placement: дрейф за время ордера |

```jsonl
{"t":"signal_event","event":"SIGNAL_ON","midCents":62.3,"residualBps":12.4,"netExpectedEdgeCents":3.1,...}
{"t":"signal_event","event":"SIGNAL_OFF","midCents":64.5,"openOrderPriceCents":61.0,"driftSinceOrderCents":1.8,...}
```

#### `cancel` — снятие ордера с контекстом

Записывается каждый раз при снятии BUY-ордера через `CANCEL_ALL`:

| Поле | Тип | Описание |
|------|-----|----------|
| `reason` | `string` | Причина: `STALE_CHAINLINK`, `NO_ENTRY`, `IN_FLIGHT_FILLS`, `REPRICE` |
| `orderPriceCents` | `number` | Цена ордера при выставлении (¢) |
| `midAtPlacementCents` | `number` | EWMA mid при выставлении (¢) |
| `midAtCancelCents` | `number` | EWMA mid при снятии (¢) |
| `driftCents` | `number` | midAtCancel − midAtPlacement: дрейф за время жизни ордера |
| `signalAtCancel` | `string` | Состояние сигнала: `favorable`, `adverse`, `flat`, `stale` |
| `netEdgeAtCancel` | `number` | Edge (¢) в момент снятия |

#### `fill` — расширен slippage

Поля `orderPriceCents` и `slippageCents` добавлены ко всем записям fill:

| Поле | Тип | Описание |
|------|-----|----------|
| `orderPriceCents` | `number?` | Плановая цена ордера (¢) |
| `slippageCents` | `number?` | fill_price − order_price (¢). BUY: отрицательный = улучшение |

### Пример сессии (NDJSON)

```jsonl
{"t":"signal_event","event":"SIGNAL_ON","midCents":62.3,"residualBps":12.4}
{"t":"order","side":"BUY","price":"0.6100","orderId":"0xabc"}
{"t":"cancel","reason":"REPRICE","orderPriceCents":61,"driftCents":0.2,"signalAtCancel":"favorable"}
{"t":"order","side":"BUY","price":"0.6200","orderId":"0xdef"}
{"t":"fill","price":"0.6200","orderPriceCents":62,"slippageCents":0}
{"t":"signal_event","event":"SIGNAL_OFF","midCents":64.5,"driftSinceOrderCents":2.3}
{"t":"decision","action":"SELL","state":{...}}
{"t":"fill","price":"0.6350","side":"SELL","orderPriceCents":63.5,"slippageCents":0}
```

### Offline-анализ

Из NDJSON-файлов можно восстановить полный цикл:

1. Открыть Python/pandas или jq
2. Сгруппировать по `orderId`
3. Join: `signal_event(ON)` → `order(BUY)` → `cancel?` → `fill?` → `signal_event(OFF)`
4. Ключевые метрики:
   - **drift**: `cancel.driftCents` — насколько рынок ушёл пока стоял ордер
   - **slippage**: `fill.slippageCents` — расхождение плановой и реальной цены
   - **signal accuracy**: `signal_event(OFF).midCents − order.price*100` — были ли правы
   - **signal hit rate**: кол-во `SIGNAL_ON` с последующим `order(BUY)` / общее кол-во `SIGNAL_ON`

---

### Потенциальная проблема с timing

**Симптом**: fills обработаны, но `=== Market summary ===` показывает `finalTokens: 0.00`

**Возможная причина**: market summary логируется до прихода WS fill event.
`ReconcileTradesUseCase` работает каждые 5 секунд — fill может прийти позже.

**Диагностика**: сравни timestamp `Position after fill` с timestamp `=== Market summary ===`.
Если summary раньше fill — timing issue, позиция была ненулевой, но summary её не увидел.
