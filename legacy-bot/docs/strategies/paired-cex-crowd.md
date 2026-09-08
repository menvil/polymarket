# PairedCexCrowdStrategy

`PairedCexCrowdStrategy` торгует бинарную пару `UP/DOWN` как один связанный инструмент.
Она использует:

- crowd edge table `(delta, tau, crowd, regime)`
- CEX/Chainlink lead-lag signal
- Polymarket top-of-book обоих токенов
- trade tape обоих токенов
- информацию о собственных `fill` и `no-fill`

## Что стратегия делает

1. Строит базовый directional bias из `EdgeTable + CEX filter`.
2. Выбирает primary сторону входа (`UP` или `DOWN`) как и `calibrated-crowd`.
3. Если maker-BUY не исполняется, а рынок уходит без нас:
   `age >= noFillDecisionMs` и `drift >= noFillDriftCents`
   стратегия может снять исходный bias и переключиться на opposite side.
4. После fill сначала ищет `paired lock`:
   покупку комплементарного токена по ask, если это фиксирует payout spread
   после учёта fee buffer.
5. После закрытия позиции временно блокирует повторный вход в ту же сторону.

## Основные правила

### Entry

- warmup после открытия рынка
- зона из `EdgeTable` должна существовать
- `composite >= minComposite`
- CEX signal должен проходить `cexFilterMode`
- bid ставится maker-first: `bestBid + 1¢`, но не crossing

### No-fill reaction

Если активный `BUY` не исполнился и mid ушёл против него вверх:

- считаем `no-fill` информативным, а не нейтральным
- проверяем opposite side
- opposite side разрешается только если:
  - её edge положителен (`oppositeEntryMinEdge`)
  - CEX filter не возражает
  - tape imbalance opposite side не слишком directional (`oppositeMaxImbalance`)

### Exit

Порядок выхода:

1. `paired lock`, если можно зафиксировать payout spread
2. обычный signal-based / tau / regime exit из `CalibratedCrowd`
3. hedge-выход если основной токен ещё недоступен для продажи

### Fill-aware penalty

После закрытия позиции стратегия:

- штрафует повторный edge в ту же сторону (`fillAdversePenaltyCents`)
- включает cooldown на re-entry (`sameSideReentryCooldownMs`)

Это снижает повторные входы после adverse fill.

## Ключевые параметры

`cexBasisByVenue` намеренно не входит в стартовый paper-конфиг.
Для live/paper статический basis по venue считается плохой идеей:
он быстро дрейфует и превращает фильтр в источник ложной уверенности.

### Базовые crowd/CEX

- `edgeTablePath`
- `crowdGate`
- `relaxedEntrySide`
- `minComposite`
- `orderShares`
- `cexFilterMode`
- `cexSignalId`
- `cexThresholdBps`

### No-fill / switch

- `noFillDecisionMs`
- `noFillDriftCents`
- `oppositeEntryMinEdge`
- `oppositeMaxImbalance`

### Fill-aware / exit

- `fillAdversePenaltyCents`
- `sameSideReentryCooldownMs`
- `pairedLockMinProfitCents`
- `pairedLockFeeBufferCents`
- `exitMode`
- `exitOnSignalFlip`
- `exitOnSignalStale`

## Когда стратегия полезна

- directional maker-BUY часто не исполняется, когда сигнал прав
- fill сам по себе несёт adverse information
- есть доступ к обоим outcome tokens и их order books

## Ограничения текущей версии

- стратегия не держит одновременно два активных агрессивных entry-bid на `UP` и `DOWN`
- `paired lock` делается как taker-buy противоположного токена, если payout уже можно зафиксировать
- логика остаётся pair-aware wrapper поверх `CalibratedCrowd`, а не отдельным market-making engine

## Стартовый конфиг

Готовый пример:

- `apps/bot/configs/paired-cex-crowd-paper-5min.json`

Рекомендуемый первый запуск:

```bash
MODE=paper CONFIG=apps/bot/configs/paired-cex-crowd-paper-5min.json npx tsx apps/bot/src/main.ts
```
