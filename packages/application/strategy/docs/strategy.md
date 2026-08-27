# @polymarket/strategy

## Обзор

Reactive scheduling архитектура для торговых стратегий: state stores → dirty-flag →
`tick()` → `StrategyIntent[]` → исполнение.

| Компонент | Роль |
|---|---|
| `IStrategy` | Публичный контракт пользовательской стратегии (`initialize`/`dispose`/`tick`/`stop`/`getMetrics`) |
| `BaseStrategy` | Опциональный абстрактный класс — gather → decide → toIntents pipeline |
| `StrategyScheduler` | Ядро: event-driven очередь, throttle/heartbeat, 13-шаговый безопасный stop-flow |
| `ExecutionEngine` | Нормализация и исполнение `StrategyIntent[]` — dedupe, порядок, ownership, cancel-replace safety |
| `OrderEventBridge` | Мост между Order domain events (EventBus) и `StrategyScheduler` |
| `StrategySnapshot` | Readonly срез состояния, передаваемый в `tick()` |
| `StrategyIntent` | Декларативное намерение (`PLACE`/`CANCEL`/`CANCEL_ALL`) |

```typescript
import { StrategyScheduler, BaseStrategy } from '@polymarket/strategy';
import type { IStrategy, StrategySnapshot, TriggerReason, StrategyIntent } from '@polymarket/strategy';
import { unsafeStrategyId } from '@polymarket/ids';

class SimpleQuoter extends BaseStrategy<MyData, MyAction> {
  readonly id = unsafeStrategyId('simple-quoter-1');
  readonly name = 'SimpleQuoter';

  protected gather(snapshot: StrategySnapshot) { /* ... */ }
  protected decide(data: MyData, reasons: ReadonlySet<TriggerReason>) { /* ... */ }
  protected toIntents(actions: MyAction[]): StrategyIntent[] { /* ... */ }
}

const scheduler = new StrategyScheduler(deps);
scheduler.start();
await scheduler.register({ strategy: new SimpleQuoter(), instrumentId, asset, accountId, market });
```

## `CryptoAssetId` — первое реальное подключение (Этап 9)

`CryptoAssetId` (`@polymarket/ids/market-data`, построен в Этапе 8) был branded-ID типом
без единого реального потребителя. Этап 9 подключил его к внутреннему состоянию
`StrategyScheduler`:

- `normalizeCryptoAsset(symbolOrAsset)` — приватная функция, нормализующая сырой
  `cryptoSymbol` (например `'BTC/USD'`, `'BTCUSDT'`) в базовый актив (`'btc'`) —
  возвращает `CryptoAssetId | undefined` вместо `string | undefined`.
- `StrategyEntry.cryptoAsset: CryptoAssetId | undefined` — внутреннее поле реестра
  зарегистрированных стратегий.
- `_assetToStrategies: Map<CryptoAssetId, Set<string>>` — reverse-index для маршрутизации
  `CRYPTO_PRICE`/`CRYPTO_MARKET_DATA` событий к подписанным стратегиям.

Это подключение **полностью самодостаточно**: `StrategyRegistration.cryptoAsset?: string`
(публичное поле) сегодня не передаётся ни одним реальным вызывающим кодом ни в одном
`apps/bot/*`-файле — значение всегда выводится внутри `StrategyScheduler` через
`normalizeCryptoAsset(cryptoSymbol)`. Публичное поле осталось `string` (низко-
церемониальный сырой вход для гипотетических будущих вызывающих — тот же паттерн, что у
VO `create()`-фабрик: сырой вход снаружи, брендированный тип внутри).

На границе вызовов в `ICryptoMarketDataStore`/`ICryptoResolutionStore`/
`ICryptoSignalRegistry` (структурные интерфейсы, зеркалящие уже принятое в Этапе 8 решение
не подключать `CryptoAssetId` в реальные `CryptoMarketDataStore`/`CryptoResolutionStore`/
`CryptoSignalRegistry`) `CryptoAssetId` естественно присваивается в параметры типа
`string` — branded string остаётся assignable к базовому `string` без явного `String()`.

## `StrategyId` — реально подключён по всей цепочке (Этап 10b)

Этап 9 констатировал: `apps/bot/src/strategies/*` (23 конкретные реализации `IStrategy`)
блокируют конверсию `IStrategy.id`/`ExecutionContext.strategyId` на `StrategyId`, поскольку
все 23 файла независимо объявляют `public readonly id`. Этап 10b — стадия, которая владеет
этой директорией — довела конверсию до конца по всей цепочке:

- `IStrategy.id`/`ExecutionContext.strategyId`/`BaseStrategy`'s `abstract readonly id` →
  `StrategyId`.
- `StrategyScheduler`'s внутреннее состояние (`_entries`/`_dirty`/`_pendingRegistrations`/
  `_pendingDisposals`/`_queue`/`_queued`/`_deferredTimers` + routing-карт `Set`-значения,
  `unregister()`/`getMetrics()`/`onOrderChanged()`'s параметры, `StopStrategyError.strategyId`)
  — retyped на `StrategyId` **без единого внутреннего каста**: `StrategyId` структурно —
  branded `string`, любое значение, производное от `IStrategy.id`, автоматически типизируется
  верно; каста требует только ОБРАТНОЕ направление (сырой внешний `string` → `StrategyId`).
- Все 23 конкретных стратегии (`apps/bot/src/strategies/*`) — конструкторный параметр
  `strategyId`/`id` → `StrategyId`; 22 файла получили `unsafeStrategyId('литерал-по-
  умолчанию')` (компайл-тайм известная, безопасная строка) вместо строкового литерала;
  `CexCrowdNotAdverseStrategy.ts` не объявляет `id` сам, но имеет собственный default-
  параметр, форвардящийся в `super(...)` — тоже требовал правки, несмотря на отсутствие
  собственного `id`-поля.
- `apps/bot/src/strategyFactory.ts` — единственная точка валидации: `config.id` (сырой,
  `string | undefined`, граница `StrategyConfig` намеренно НЕ конвертируется) проверяется
  через `asStrategyId()` один раз, результат протягивается во все 23 `new XStrategy(...)`.
- `apps/bot/src/main.ts`/`MarketRotation.ts` — динамически вычисленные (`` `prefix-${n}` ``)
  id оборачиваются `unsafeStrategyId(...)` в точке конструирования (composition root,
  механическая правка).

### 5 портов остаются `string` — граница сместилась, не исчезла

Этап 1 отложил конверсию `strategyId` в 6 портов (`IOrderRepository`/`IOrderStateStore`/
`IStrategyCommitmentReader`/`IDecisionJournal`/`IExchangeClient`/`IOrderSubmissionRepository`).
Расследование Этапа 10b нашло точную причину: реальный источник хранимых значений — не эти
порты, а `Order`/`OrderState`/`OrderEvent` (`@polymarket/order`, отдельный пакет, вне
мандата этой миграции), чей собственный докблок называет `strategyId` частью explicit
event-replay/journal формата (`Order.fromEvents()`). Даже если бы порты сменили сигнатуру
на `StrategyId`, реально хранимое/сравниваемое поле осталось бы `string`. `IExchangeClient`
неожиданно оказался безопасен по другой причине: `strategyId` никогда не долетает до
реального исходящего HTTP-запроса — используется только для лога и in-process domain-события.

**Уточнение (Этап 10c):** `IDecisionJournal` вышел из этого списка — `DecisionEntry.
strategyId` брендирован как `StrategyId` в Этапе 10c (реальный источник для ЭТОГО поля —
`this.id: StrategyId` на самой стратегии, не `Order`/`OrderEvent` — конверсия оказалась
бесплатной на всех 44 сайтах конструирования). Остаются `string` 5 портов:
`IOrderRepository`/`IOrderStateStore`/`IStrategyCommitmentReader`/`IExchangeClient`/
`IOrderSubmissionRepository` — см. `@polymarket/ports`'s `docs/ports.md` за актуальным
списком и обоснованием.

### `OrderEventBridge` — граница валидации между типизированным и сырым миром

`OrderEventBridge` — единственное место, где сырой `Order`/`OrderEvent`-`strategyId` (`string`)
пересекает границу в типизированный `StrategyScheduler` (`StrategyId`). Оба read-сайта
(`ORDER_REJECTED`-handler, `_notifyScheduler()`) валидируют через `asStrategyId(...)` с тем
же graceful-skip на невалид/`undefined`, что уже было — см. `docs/architecture/
boundary-contract.md`, Решение 12, за обобщённым принципом.

## `eventStartMs` → `Timestamp` (Этап 10b)

`StrategyRegistration.eventStartMs`/`StrategyEntry.eventStartMs`/`StrategySnapshot.eventStartMs`
— все три `?: number` → `?: Timestamp`. Расследование нашло, что реальный периметр — 20 из
23 файлов (не 3, как предполагал Этап 9), с разными формами использования (только warmup-
гейт — 14 файлов; реальная duration-арифметика — 4 файла, включая `AvellanedaStoikovStrategy`
с 4 независимыми вычислениями; HTTP-граница + warmup — `BinanceProbMMStrategy`; только
presence-check — `OrderBookWallStrategy`). Форма конверсии — граница, не сквозная
`Timestamp`-арифметика: на "store"-сайте каждого файла — один `.toNumber()`-анврап в уже
существующее `number`-поле, вся последующая арифметика (гейты, `pctElapsed`-вычисления)
остаётся буквально без изменений.

**Критический механический риск, закрытый этим этапом**: ~19 сайтов проверяли
`eventStartMs` через truthy (`if (snapshot.eventStartMs)`), полагаясь на то, что `0` и
`undefined` — оба falsy для `number`. `Timestamp`-объект (даже оборачивающий 0) —
ВСЕГДА truthy. Каждый такой сайт переведён на явную проверку `!== undefined`/`===
undefined` — иначе гвард компилировался бы чисто, но молча переставал бы защищать.

`StrategySnapshot.cryptoPrice`-блок (`targetPrice`/`resolutionPrice`/`currentPrice`/
`chainlink.price`/`binance.price`) остаётся `number` НАВСЕГДА, не отложено — та же
крипто-спот-цена, несовместимая с `OutcomePrice` VO, что уже дважды подтверждена в этой миграции
(`cross-market`, Этап 4; `CryptoMarketDataStore`, Этап 8). `.tsMs` на `CryptoSignalResult`
(соседнее поле, всегда сравнивается с `nowMs`, который тоже остаётся `number`) — той же
причиной остаётся `number`. `apps/bot/src/strategyRouter.ts`'s собственное отдельное поле
`eventStartMs?: number` — структурно другой тип, не форсируется этой конверсией.

## `CryptoSignalResult.confidence` → `Ratio` (Этап 10b)

Единственное поле из `CryptoSignalResult`, реально сконвертированное в этом этапе.
`.quality`/`.asset` — ноль читателей (подтверждено исчерпывающим repo-wide grep), остаются
`number`/`string`. `.tsMs` — только diagnostic `nowMs - signal.tsMs`, тот же класс, что и
`nowMs` само. `.strength` ([0..10], magnitude, не вероятность) — решение Этапа 8 не
пересматривается. `CryptoSignalContext` — нерелевантен, не реэкспортируется этим пакетом и
не упоминается ни в одном файле `apps/bot/strategies/*`.

`Ratio` (core+facade) не имеет методов сравнения (`.gte`/`.lte` и т.п. не существуют) — любое
пороговое сравнение требует `.toNumber()` независимо от того, один или оба операнда — `Ratio`;
частичная конверсия (только `confidence`, `strength` остаётся `number`) поэтому не создаёт
неудобного смешения типов в одном и том же гейте (`CexLeadLagStrategy`/
`CexLeadLagExitPolicyStrategy`/`CexLeadLagRiskBudgetStrategy`) — просто один дополнительный
`.toNumber()`-вызов на операнд.

`getTokenBalanceAllowance` (`ITokenBalanceChecker`) не конвертирован вообще — не из-за
блокирующих потребителей (единственный реальный имплементер — `apps/bot/main.ts`,
composition root, дешёвая правка), а потому что результат используется ИСКЛЮЧИТЕЛЬНО для
диагностического лога, никогда не участвует в решении.

5 throw-сайтов (`placeTarget()`, `OrderIdGenerator`'s конструктор + `next()`) остаются
throw — три разных, по-отдельности обоснованных причины (config fail-fast на старте;
invariant-проверка над доверенным `randomUUID()`-выводом, а не внешним вводом; программная
ошибка, которую compile-time union уже предотвращает для корректно типизированного кода) —
подробности в плане миграции, Этап 9.

## Ссылки

- ADR: `docs/architecture/boundary-contract.md` (Решение 10 — частотный класс; Решение 11 —
  composition-root vs apps/bot/strategies; Решение 12 — валидация на мосту между
  типизированным и сырым мирами)
- План миграции, Этапы 9-10b: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`
- `@polymarket/market-state` — `docs/market-state.md` (источник `CryptoAssetId`,
  `CryptoMarketDataStore`/`CryptoResolutionStore`/`CryptoSignalRegistry`,
  `CryptoSignalResult.confidence`)
