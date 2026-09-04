# Collector Cutover — сборщик как independent consumer шины

## Зачем это сделано

До этого этапа сборщик данных ВЛАДЕЛ источниками: `apps/collect-data`
создавал `PolymarketSource`/`CexSource`, открывал и закрывал подписки, а
`MarketCollectionCoordinator` регистрировал рынки в recorder ДО открытия
подписки (recorder-first). Сбор был склеен с транспортом.

Одновременно ветка `phase-3` уже содержала готовый общий control-plane
(`PolymarketControlRuntime`, `PolymarketSubscriptionController`,
`CexSubscriptionController`), который управляет физическими подписками под
claim-ами владельцев. Старый коллектор его не использовал — и, после
canonical-discovery рефактора (PR #77/#78), перестал даже компилироваться:
координатор звал исчезнувшие `findCandidates`/`prepareSelected`.

Cutover разрывает владение: **источники существуют независимо от сборщика, а
сборщик становится обычным владельцем claim-ов (`collector:raw`) и обычным
подписчиком общей `ExternalMessageBus`.**

## Целевой контур

```text
MarketDiscovery → MarketUniverse
       │                ▲
       │      collector demand (collector:raw + PolymarketPolicy + acquireLimit)
       ▼                │
PolymarketControlRuntime.runOnce()
       ▼
PolymarketSubscriptionController → PolymarketSource ──┐
                                                      │
collector CEX demand (collector:raw:<exchange> + CexPolicy)
       ▼                                              │
CexSubscriptionController → CexSource generations ────┤
                                                      ▼
                                             ExternalMessageBus
                                               ├── Collector (recorder + gate)
                                               ├── PolymarketSemanticAdapter
                                               └── CexSemanticAdapter
```

Collector — **sibling** consumer, а не gate перед семантикой: если он
отключён/сломан/не хочет рынок, семантические адаптеры всё равно получают
сообщения.

## Где исчезло прямое владение источниками

| Что раньше делал коллектор | Теперь |
| --- | --- |
| `new PolymarketSource` + открытие/закрытие подписок | PM source принадлежит контуру, подписки открывает `PolymarketSubscriptionController` под `collector:raw` |
| `new CexSource` на биржу | `CexSubscriptionController` создаёт/закрывает поколения через фабрику |
| `MarketCollectionCoordinator` (recorder-first регистрация) | удалён из композиции; допуск рынка к записи — `PolymarketCollectionGate` по canonical universe + policy |
| `subscribe`/`prepareMarket`/`watchOrderBook`/`watchTrades` | ни одного прямого вызова из коллектора (структурный тест) |
| `MarketFinalizer`/`PolymarketTwapObservations` | убраны из композиции (finalization — следующий этап) |

`apps/collect-data` больше не зависит от `@polymarket/collection-coordinator`
и `@polymarket/market-finalizer`.

## Как сохраняется первое raw-сообщение

Физические подписки открывает control-plane, и recorder не знает заранее,
какой рынок и когда пришлёт первое наблюдение. Поэтому у
`ExternalMessageRecorder` появился опциональный `sessionProvider`:

```text
POLYMARKET_MARKET (market = X)
   → активная сессия X? ──YES──► писать напрямую (policy НЕ пересчитывается)
   → NO → sessionProvider(X) == gate.admit(X)
              MarketUniverse.get(POLYMARKET, X) → нет → игнор (unknown)
              policy подошла на market.startsAt? → нет → игнор (uninteresting)
              → registration → registerMarket → записать ЭТО ЖЕ первое сообщение
```

Провайдер вызывается СИНХРОННО внутри обработчика того же сообщения — между
созданием сессии и записью нет `await` и нет «начнём со следующего». Именно
это делает первое наблюдение, инициировавшее сессию, записанным, а не
потерянным. Для уже активной сессии провайдер не вызывается — policy решает
«начинать ли сбор», а не рвёт начатый lifecycle на каждом сообщении.

Registration строится из canonical `Market` (без vendor `prepareMarket`):
canonical header `headerVersion: 2`, tokenIds из `outcomes`, **без `startsAt`**
(запись с первого наблюдения — опорный `book`-снапшот) и **без `rtdsFeeds`**
(RTDS — следующий этап, см. ниже).

## Различие Polymarket и CEX (НЕ унифицировано)

| | Polymarket | CEX |
| --- | --- | --- |
| приобретение | только ДО `startsAt` | пока есть текущий demand |
| исчезновение из плана | ≠ release (acquisition ≠ retention) | claim снимается |
| desired state | demand ≠ полный desired | demands авторитетны |
| policy оценивается на | `market.startsAt` | `now` |

CEX-интерес выражается по ОДНОМУ владельцу на биржу
(`collector:raw:<exchange>`): одна `CexPolicy` не может нести разные списки
символов разных бирж без декартова произведения, а CEX-контроллер запрещает
дубликат `ownerKey` и всё равно агрегирует claim-ы в общие пулы.

## Что осознанно отложено на следующий этап (lifecycle)

Этот этап узкий: минимальное состояние сессии (в recorder), запись CLOB-
событий рынка и CEX orderbook/trades. НЕ входит и отложено с обоснованием:

- **RTDS-запись (spot + settlement TWAP).** Фиды разделяемы между рынками
  актива; без expiry/seal запись шла бы в датасет истёкшего рынка бесконечно.
  CLOB-события так не текут — прекращаются с истечением рынка сами.
- **Терминальное состояние сессии / expiry / seal / finalization / release
  claim.** В этой фазе seal/finalize не вызываются, поэтому позднее наблюдение
  не может ре-допустить закрытый рынок; накопление claim-ов и сессий — принятое
  состояние минимальной фазы.
- **Vendor-данные для финализации** (`SelectedPolymarketMarket`) — canonical
  registration их не несёт; способ их получения решит lifecycle-этап.
- **Допуск по claim-состоянию** вместо повторной policy-оценки на разделяемой
  подписке.

## Replay/backtest независимы

Recorder пишет source-native `message.payload` в JSONL (`source → bus →
recorder`). Replay читает JSONL → Reader → тот же bus → те же semantic
адаптеры. `@polymarket/backtesting` НЕ импортирует ни коллектор, ни recorder —
бэктест не поднимает Collector и live-контроллеры (структурный тест
`contour-boundary.test.ts`, критерий I).

## Проверки и ссылки

- Пакет: `packages/infrastructure/collector` (`PolymarketCollectionGate`,
  `COLLECTOR_RAW_OWNER_KEY`), acceptance-тесты A–I.
- Recorder-провайдер: `packages/infrastructure/persistence/external-message-recorder`.
- Композиция: `apps/collect-data/src/runtime/createDataCollector.ts`.
- Предыдущий этап: `docs/guides/data-collector-v2-cutover.md`.
