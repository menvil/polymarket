# @polymarket/collection-coordinator

> **⚠️ LEGACY BEHAVIOR ORACLE — DELETE AFTER COLLECTOR QUALIFICATION**
>
> Пакет НЕ является частью canonical collector runtime. Он сам владел
> физическими ресурсами рынка (`prepareSelected`, `subscribeMarket`,
> `subscribeCryptoPrices`, `subscribeChainlinkTwap`, собственный ref-count
> RTDS), а после Collector-cutover физическим ресурсом владеет ОДИН
> компонент — `PolymarketSubscriptionController`; жизненный цикл начатой
> записи ведёт `PolymarketCollectionLifecycle` (`@polymarket/collector`).
>
> Проверенная ПОВЕДЕНЧЕСКАЯ политика (ACTIVE/FINALIZING, cutoff на
> истечении, сужение RTDS до settlement-потока, boundary grace, seal,
> порядок shutdown) перенесена в canonical lifecycle; DTO финализации
> header-а живут в `@polymarket/collector` и реэкспортируются отсюда.
>
> Правила обращения до удаления: новых runtime-зависимостей на пакет не
> создавать (проверяется structural-тестом границы в
> `@polymarket/collector`), использовать только как оракул поведения при
> верификации нового контура. Пакет НЕ компилируется на `phase-3` начиная
> с canonical V2 Discovery (PR #77) — это известное состояние, а не
> регрессия этого этапа.

Координатор collection sessions (N-003): превращает выбранный Market
Discovery V2 рынок в failure-safe ACTIVE-сессию записи — регистрация в
recorder СТРОГО ДО открытия realtime-подписок, shared/ref-counted
RTDS-фиды, транзакционное открытие с полным rollback и graceful shutdown.

## 1. Место в архитектуре

```text
CONTROL PLANE                                DATA PLANE

Gamma (официальный SDK)
  ↓ listMarkets / fetchEvent
Market Discovery V2 (@polymarket/polymarket-v2)
  ↓ selected market
MarketCollectionCoordinator (этот пакет)
  ├── 1. ExternalMessageRecorder.registerMarket   ◄───────────┐
  ├── 2. PolymarketSource.subscribeMarket ──► ExternalMessage │
  └── 3. shared RTDS feeds ──► PolymarketSource               │
                                     ↓                        │
                              ExternalMessageBus ─────────────┘
```

Source и Recorder друг о друге не знают — координатор единственный, кто
видит обоих. Координатор НЕ владеет общим bus (не публикует, не drain-ит,
не закрывает), НЕ вызывает `source.close()`/`recorder.close()` — lifecycle
разделяемых компонентов принадлежит composition root.

## 2. Транзакция открытия (recorder FIRST)

```text
1. sync-резервация OPENING (до первого await)   ← идемпотентность
2. discovery.prepareSelected(candidate)          ← fetchEvent выбранного
3. eligibility re-check: expiry + lead time
4. recorder.registerMarket(...)                  ← routing ДО первого события
5. source.subscribeMarket(allTokenIds)
6. acquire RTDS feeds (shared, ref-counted)
7. commit ACTIVE
```

Первые WS-события могут прийти сразу после подписки — recorder-first
гарантирует, что маршрутизация уже существует (инвариант закреплён
интеграционным тестом `first-message-not-lost.test.ts` с реальными
bus + recorder).

Любой отказ шагов 5-6 откатывает всё открытое: подписки закрываются,
RTDS-refs освобождаются, recording снимается `finalizeMarket('SHUTDOWN')`
(storage удаляет incomplete-файл), резервация освобождается — рынок можно
ретраить. Zombie-состояний не остаётся.

## 3. Слоты и идемпотентность

- `maxMarkets` учитывает `ACTIVE + OPENING` — конкурентные открытия не
  превышают лимит;
- двойное открытие одного рынка невозможно: резервация синхронная;
- lead-time правило (parity с legacy): рынок открывается минимум за
  `minTimeToStartMs` (2 мин) до начала события; точное время — из
  `eventStartsAt` выбранного рынка, fallback-оценка —
  `expiresAt - fallbackMarketDurationMs` (15 мин). Отклонение постоянно
  (время до старта монотонно убывает), память чистится по candidate cache.

## 3a. Терминальный отказ source

`PolymarketSource.hasFailed` — терминальное состояние (отклонение bus /
падение SDK-итератора): source сам закрывает все свои handles, и
«ACTIVE»-сессии координатора мертвы. `fillSlots()` выполняет
health-reconciliation: замечает `hasFailed`, сносит все сессии штатным
`closeSession(..., 'SHUTDOWN')` (recording снят, RTDS-refs и capacity
освобождены; повторный `close()` уже закрытых handles идемпотентен по
контракту Source) и блокирует новые открытия. Composition root после
этого заменяет отказавший shared source (и координатор поверх него) —
runtime-состояние уже чистое.

## 4. Shared RTDS

Source-подписки ≠ recorder-routing:

- координатор ref-count-ит НИЖЕЛЕЖАЩИЕ source-подписки: один
  `(topic, symbol)` открывается в SDK один раз на все рынки, закрывается
  на последнем release;
- fan-out одного фида в файлы нескольких рынков — существующая
  ответственность Recorder-а (передаётся `rtdsFeeds` в регистрации);
  второй routing-механизм не строится.

## 4a. FINALIZING (N-004)

Expiry-переход отделён от архива: `beginFinalization(marketId)` — identity-safe
`ACTIVE → FINALIZING` ДО первого await → `recorder.sealMarket` (routing снят,
payload заморожен, header writable) → закрытие market-подписки → release
RTDS-refs → immutable `FinalizingMarketSession {marketId, recordingStartedAt,
selected}`. FINALIZING **не занимает** capacity (слот освобождается сразу при
expiry — parity legacy), но **блокирует** повторное открытие того же рынка.
Архив (`finalizeMarket(EXPIRED)`) выполняет `@polymarket/market-finalizer`
после enrichment/timeout и снимает сессию `completeFinalization(marketId)`
(удаляется ТОЛЬКО FINALIZING). `closeSession(SHUTDOWN)` FINALIZING-сессии не
трогает.

## 5. Порядок shutdown контура

```typescript
await finalizer.close();    // FINALIZING → EXPIRED best-known архивы (N-004)
await coordinator.close();  // ACTIVE/OPENING → SHUTDOWN (FINALIZING здесь уже нет)
await source.close();       // остановить продьюсера
await bus.drain();          // доставить оставшиеся наблюдения
await recorder.close();     // отписка + закрытие storage
await bus.close();          // владелец bus — composition root
```

## 6. Scope (что пакет сознательно НЕ делает)

- Gamma polling/enrichment после expiry — `@polymarket/market-finalizer`
  (координатор владеет только session/realtime lifecycle);
- Semantic Adapter / OrderBook / Trade / Application-интеграция;
- CEX-миграция, Reader/replay, legacy cutover (старый `apps/collect-data`
  остаётся нетронутым behavior oracle).

## 7. Live smoke

Полная автоматическая цепочка DISCOVER → SELECT → REGISTER → SUBSCRIBE →
RECORD против публичных endpoints (без credentials), затем graceful
shutdown с проверкой SHUTDOWN-семантики артефактов:

```bash
npm run build   # из корня repo
npx tsx packages/infrastructure/collection-coordinator/scripts/smoke.ts
```

Подробности архитектуры — `docs/collection-coordination.md`.

## 8. Тесты

```bash
npm test          # typecheck тестов + jest
npm run build     # tsc -b (с project references)
npm run lint:all  # eslint src + __tests__
```
