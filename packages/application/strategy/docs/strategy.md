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

class SimpleQuoter extends BaseStrategy<MyData, MyAction> {
  readonly id = 'simple-quoter-1';
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

## Что отложено на Этап 10 и почему

Расследование этого этапа установило общее правило: `apps/bot/main.ts` и
`apps/bot/src/bot/*.ts` (composition root) получают механические inline-правки в рамках
ЛЮБОГО этапа, чья сигнатура их затронула (уже прецедент — Этапы 4/6/7/8). Но
`apps/bot/src/strategies/*` (~20 конкретных реализаций `IStrategy`) содержат РЕАЛЬНУЮ
бизнес-логику каждой стратегии — ни один этап этой миграции не редактировал эту
директорию напрямую. Три пункта черновика Этапа 9 упёрлись именно в эту границу:

- **`IStrategy.id`/`ExecutionContext.strategyId` → `StrategyId`** (тип уже построен в
  Этапе 1) — все 20 конкретных стратегий независимо объявляют `public readonly id: string`,
  переопределяя `BaseStrategy`'s `abstract readonly id: string`. Конверсия сломала бы
  компиляцию всех 20 разом.
- **`StrategyRegistration.eventStartMs`/`StrategySnapshot.eventStartMs` → `Timestamp`** —
  3 файла (`SelectiveEntryStrategy`, `SmartEntryStrategy`, `CrowdDeviationStrategy`) делают
  реальную арифметику `expiresMs - eventStartMs`, не просто логируют значение.
- **`CryptoSignalResult`/`CryptoSignalContext`'s поля** (`tsMs`/`asset`/`quality`/
  `confidence`) — 6 файлов `apps/bot/strategies/*` читают их напрямую;
  `StrategySnapshot.ts` только реэкспортирует типы, не строит и не читает поля сама.

`StrategySnapshot.cryptoPrice`-блок (`targetPrice`/`resolutionPrice`/`currentPrice`/
`chainlink.price`/`binance.price`) остаётся `number` НАВСЕГДА, не отложено — та же
крипто-спот-цена, несовместимая с `Price` VO, что уже дважды подтверждена в этой миграции
(`cross-market`, Этап 4; `CryptoMarketDataStore`, Этап 8). Дополнительно: `StrategySnapshot`
целиком пересобирается на каждый tick — это делает даже `timestampMs`-поля хот-путными в
контексте конкретно этого снапшота.

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

- ADR: `docs/architecture/boundary-contract.md` (Решение 10 — частотный класс; Этап 9
  установил дополнительное правило "composition-root vs apps/bot/strategies")
- План миграции, Этап 9: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`
- `@polymarket/market-state` — `docs/market-state.md` (источник `CryptoAssetId`,
  `CryptoMarketDataStore`/`CryptoResolutionStore`/`CryptoSignalRegistry`)
