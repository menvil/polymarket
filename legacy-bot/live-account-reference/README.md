# live-account-reference — приватный контур удалённого live-рантайма

> **LEGACY REFERENCE ONLY**
>
> Do not import from production code.
> Not built.
> Not expected to compile against current repository.

Не workspace-пакет, не build target, не lint target, не runtime-зависимость.
Код здесь ссылается на удалённые пакеты и **не скомпилируется** — он оставлен
как текст для чтения.

## Зачем это сохранено

Новый приватный контур торгового аккаунта пишется заново:
[`@polymarket/account-state`](../../packages/application/account-state/README.md)
уже есть, account reconciler и execution — следующие MR.

Переписывание кода не воспроизводит две вещи:

- **какие именно поля Polymarket отдаёт** в user-channel WS и в приватных REST
  и как их приводить к домену (маппинг остатков, статусов, maker-исполнений);
- **какие проверки в этих маппингах оказались нужны в бою** — они выглядят как
  случайные `if`, пока не знаешь, какой инцидент их породил.

Именно это здесь и лежит. Архитектура — нет: композиция старого рантайма
новому контуру не подходит и воспроизводиться не будет.

## Что сохранено и откуда

Пути внутри `live-account-reference/` **повторяют исходные** пути в
репозитории — провенанс читается прямо из дерева каталогов. Тот же источник
продублирован в шапке каждого `.ts`.

### Из `apps/bot`, коммит `415c5ec804a7beca9f15f13125d47566388bc9a9`

| файл | что это |
| --- | --- |
| `apps/bot/src/bot/buildLiveInfra.ts` | композиция live-режима: порядок создания клиента площадки, провайдера баланса, startup use-cases и user-channel WS |

Коммит — merge PR #89 (`legacy-cleanup-collection-coordinator`), последнее
состояние `apps/bot` перед удалением приложения.

### Из `@polymarket/exchange`, коммит `df8d974cba2b4a019b7fc410d5e790b37fbd2f29`

Это **родитель** коммита `dd4990de40401041ad1e8e0e701340151deb1d9b`
(«refactor(legacy): удалить `@polymarket/exchange` — последний V1-адаптер
площадки»), то есть последнее состояние пакета до удаления.

| файл | что это |
| --- | --- |
| `.../polymarket/adapters/PolymarketExchangeClientAdapter.ts` | реализация `IExchangeClient`: постановка/отмена заявок, `getOpenOrders`, `getTrades`, `getBalance` |
| `.../polymarket/adapters/UserEventFeedAdapter.ts` | user-channel WS: приватные исполнения и обновления заявок, реакция на reconnect |
| `.../polymarket/adapters/mapUserFillsToVenueTrades.ts` | приведение user-fills WS к venue-trade контракту |
| `.../polymarket/rest/adapters/PolymarketExecutionAdapter.ts` | execution поверх REST: подпись, сборка ордера, классификация ответов |
| `.../polymarket/rest/clients/PolymarketBalanceRestClient.ts` | authoritative остаток USDC |
| `.../polymarket/rest/clients/PolymarketOrderRestClient.ts` | приватные заявки: постановка, отмена, открытые заявки |
| `.../polymarket/rest/clients/PolymarketUserTradesRestClient.ts` | приватные сделки: пагинация, maker/taker-разбор |
| `.../polymarket/rest/providers/PolymarketBalanceProvider.ts` | провайдер текущего баланса поверх REST-клиента |
| `.../polymarket/rest/mappers/PolymarketBalanceMapper.ts` | вендорский ответ баланса → домен |
| `.../polymarket/rest/mappers/PolymarketOrderMapper.ts` | вендорский ответ заявки → домен |

### Чего здесь намеренно НЕТ

Из удалённого пакета (~18 000 строк) сохранены только account/execution-файлы.
Не перенесены и переноситься не будут:

```text
market discovery         PolymarketMarketDiscoveryAdapter, MarketCatalog
market-data WS           PolymarketWsAdapter, RtdsWebSocketClient, orderbook
market-data REST         orderbook/trades/prices клиенты
DNS override, стабы, unrelated ports
```

Всё это уже переписано в V2-контуре (`@polymarket/polymarket-v2`,
`@polymarket/collector`) и как справка не нужно.

## Что старый live-рантайм делал

Историческое поведение, восстановленное по коду. **Это НЕ новый контракт и НЕ
обязательные будущие интервалы.**

### Fast path

```text
private WS (/ws/user)
    → UserEventFeedAdapter
    → fills / order updates
    → немедленная локальная обработка
```

Отдельное WS-соединение под user channel: Polymarket принимает только одно
subscription-сообщение на соединение, поэтому market-data и приватный канал
физически разведены.

### Safety net

```text
startup:
    инициализация баланса   (InitializePortfolioUseCase)
    → сверка заявок          (orderReconciler.reconcile)
    → старт user WS

периодически:
    сверка исполнений через REST   ~ каждые 5 с
    discovery неизвестных отправок ~ каждые 30 с
    authoritative баланс           ~ каждые 60 с

при reconnect WS:
    сверка заявок (тот же orderReconciler.reconcile)
```

Значения взяты из `apps/bot/src/main.ts` того же коммита
(`RECONCILE_INTERVAL_MS = 5_000`, `UNKNOWN_SUBMISSIONS_INTERVAL_MS = 30_000`,
`BALANCE_SYNC_INTERVAL_MS = 60_000`).

Полезно не число, а форма: **WS — основной путь, REST — authoritative сверка**,
и сверка заявок запускается не только по таймеру, но и на каждый reconnect.

### Расхождение в самой legacy-документации

Докблок `buildLiveInfra.ts` утверждает, что `ReconcileTradesUseCase`
вызывается «каждые 60 сек». В `main.ts` того же коммита он вызывается **каждые
5 секунд**, а 60 секунд — период синхронизации баланса. Комментарий разошёлся с
кодом; при чтении верить коду.

## Как это относится к новому контуру

Будущий account reconciler использует эти файлы **только** как справочный
материал по вендорским контрактам и как перечень боевых граничных случаев.

Архитектура другая:

```text
БЫЛО                              БУДЕТ
reconciler мутирует Portfolio     reconciler публикует canonical событие
напрямую через use-case           ↓
                                  ТА ЖЕ IEventBus
                                  ↓
                                  AccountStateProjector → AccountHotState
```

`AccountStateProjector` — единственный писатель приватного состояния, и
reconciler **никогда** не будет мутировать его напрямую.

Каденции станут конфигурируемыми, а не зашитыми константами. Широкий
`IExchangeClient` из этих файлов новым V2-контрактом не объявляется: ожидаемое
разделение — `IOrderExecutionVenue` (`submitOrder`, `cancelOrder`) и
`IAccountReconciliationSource` (`getBalance`, `getOpenOrders`, `getTrades`), —
но решается это в своём MR, а не здесь.
