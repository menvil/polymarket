# Live Arb Execution: GTC + двухфазный reconcile

## Проблема

FAK-ордера требуют точного совпадения ликвидности в момент получения запроса биржей.
При параллельном размещении двух ног HTTP-запросы приходят с задержкой ~100-500ms между собой.
За это время стакан может измениться, и одна нога FAK убивается без fill.

Дополнительно: Polymarket REST API задерживает появление fills на 1-3 секунды.
С окном reconcile 750ms это означает что snapshotReport часто видит 0 fills для одной ноги,
хотя обе фактически исполнились — и запускает ненужный repair.

## Решение

### 1. GTC вместо FAK для основных ордеров

GTC-ордера живут до явной отмены. Алгоритм:

1. Разместить обе ноги (GTC)
2. Подождать `executionReconcileDelayMs` (2500ms)
3. Явно отменить оба ордера: заполненные игнорируют cancel, незаполненные снимаются
4. Reconcile fills из REST

### 2. Ранний выход через WS matched-события

Вместо слепого ожидания `executionReconcileDelayMs` (2500ms) подписываемся на `FILL_RECEIVED` события на `eventBus`.

```
waitForOrdersMatchedOrTimeout([easyOrderId, hardOrderId], reconcileDelayMs)
  → Выходим как только оба fill пришли через WS (часто < 500ms)
  → Или ждём полные 2500ms если WS тормозит / fill не пришёл
```

Это же применяется для repair и unwind FAK-ордеров — ожидание `rebalanceOrderId` / `unwindOrderId`.

Выгода: в нормальных условиях цикл исполнения сокращается с ~2500ms до ~200-500ms.

### 3. Двойной reconcile перед repair

```
Reconcile #1 → snapshotReport
  → если balanced: done ✓
  → если imbalanced:
      Reconcile #2 (ловим поздние WS-fills)
      → снова snapshotReport
      → если balanced: done ✓
      → иначе: repair
```

Второй reconcile устраняет ложные срабатывания repair когда оба fill пришли,
но один не попал в первое 2500ms окно.

### 3. Repair по актуальной TOB-цене

При переходе в repair plan-цена (из момента обнаружения сигнала) уже устарела.
Repair ставит FAK по текущему `marketDataStore.getTopOfBook(missingLeg).bestAsk`.

```typescript
const missingLegTob = marketDataStore.getTopOfBook(rebalanceLeg.instrumentId);
const rebalancePrice: Price = missingLegTob?.bestAsk ?? plan.fallbackPrice;
```

### 4. Инкрементальный подсчёт fills в repair-фазе

Проблема: если поздний WS-fill оригинального ордера пришёл во время repair-окна,
`snapshotReport` (который считает от `beforeHardQty = 0`) показывает originalFill + repairFill = 2x.
Это вызывает ложный unwind 1x единиц.

Решение: фиксировать `repairBaseQty` прямо перед размещением repair-ордера:

```typescript
const repairBaseEasyQty = qtyOf(easyLeg.instrumentId);
const repairBaseHardQty = qtyOf(hardLeg.instrumentId);
// ... place repair order ...
const repairEasyFill = qtyOf(easyLeg.instrumentId) - repairBaseEasyQty;
const totalEasyFilled = report.easyFilledSize + repairEasyFill;
```

### 5. additionalInstrumentIds включает Down-токены

```typescript
additionalInstrumentIds: [easyIId, hardDownIId, ...(easyDownIId ? [easyDownIId] : [])],
```

Без этого WS-обновления стакана Down-токенов не триггерят тики стратегии.
Книга easy Down / hard Down читалась из marketDataStore только при апдейте Up-книги —
с потенциальным отставанием.

## Полный flow после fix

```
place(easyGTC) + place(hardGTC)   ← параллельно
    если один не поставился: cancel другой → REJECTED
waitForOrdersMatchedOrTimeout([easy, hard], 2500ms)   ← выходим раньше если оба WS matched
cancel(easy) + cancel(hard)       ← GTC: filled=no-op, open=cancelled
reconcile #1
snapshotReport
    → balanced → return ✓
    → NO_FILL  → return (оба не заполнились)
reconcile #2                       ← NEW: ловим поздние fills
snapshotReport
    → balanced → return ✓
    → imbalanced:
        rebalancePrice = currentTOB.bestAsk
        repairBase = current qty snapshot    ← NEW: anti-double-count
        place(missingLeg, FAK, rebalancePrice)
        waitForOrdersMatchedOrTimeout([repairOrderId], 2500ms)
        cancel(repair)
        reconcile
        incremental snapshotReport           ← NEW: report.fills + repairFills
            → balanced → return REBALANCED ✓
        unwindLeg SELL FAK at 0.01           ← market sell = best bid
        waitForOrdersMatchedOrTimeout([unwindOrderId], 2500ms)
        cancel(unwind)
        reconcile
        → return UNWOUND
```

## Конфигурация

```json
{
  "strategyParams": {
    "executionOrderType": "GTC",
    "executionReconcileDelayMs": 2500,
    "executionRepairDelayMs": 2500
  }
}
```
