# @polymarket/collector — политика допуска и владелец `collector:raw`

## Почему это сделано так

До cutover recording-сессию рынка создавал `MarketCollectionCoordinator` ДО
открытия подписки (recorder-first): координатор владел источником, знал набор
рынков заранее и регистрировал их в recorder до первого события. Это связывало
сбор с владением источниками: коллектор создавал `PolymarketSource`/`CexSource`,
открывал подписки и закрывал транспорт.

Cutover разрывает эту связь. Источники существуют физически независимо от
коллектора; их подписками управляет общий control-plane
(`PolymarketControlRuntime` / `CexSubscriptionController`). Коллектор становится
обычным владельцем claim-ов (`collector:raw`) и обычным подписчиком общей шины.
Появляется новый вопрос, которого раньше не было: **как решить, записывать ли
рынок, если recorder видит его первое наблюдение, а заранее список рынков ему
никто не отдал.** На него отвечает `PolymarketCollectionGate`.

## Алгоритм допуска

```text
POLYMARKET_MARKET (payload.market = X)
        ↓  (в recorder)
активная сессия X есть?
   ├── ДА  → писать напрямую, policy НЕ пересчитывать
   └── НЕТ → sessionProvider(X) == gate.admit(X):
                asMarketId(X)                      → невалиден → игнор
                universe.get(POLYMARKET, marketId) → нет       → игнор (unknown)
                filter.matches(entry, policy, market.startsAt) → нет → игнор (policy)
                → registration → recorder.registerMarket → записать ЭТО ЖЕ сообщение
```

### Шаги

1. **Активная сессия important сначала.** Recorder держит карту сессий. Если
   сессия рынка уже есть, запись идёт напрямую; провайдер (а значит и policy)
   не вызывается вовсе. Так policy решает вопрос «НАЧИНАТЬ ли сбор», а не рвёт
   уже начатый lifecycle на каждом сообщении.
2. **Парсинг identity.** `payload.market` — это conditionId рынка, он же
   canonical `MarketId`. Непарсируемое значение — защитный игнор.
3. **Lookup в canonical universe.** Рынок, которого нет в текущем
   `MarketUniverse`, коллектору неизвестен — игнор. Это же отсекает чужой
   трафик разделяемых подписок.
4. **Owner policy на `market.startsAt`.** Тот же момент, что у планировщика
   подписок при приобретении. Согласует «записывать ли» с «подписываться ли».
5. **Сборка registration** из canonical `Market`: canonical header
   (`headerVersion: 2`), tokenIds из `outcomes`. Без `startsAt` (запись с
   первого наблюдения — опорный снапшот стакана) и без `rtdsFeeds` (RTDS —
   следующий этап).

## Почему первое сообщение не теряется

Провайдер вызывается СИНХРОННО внутри обработчика того же сообщения; между
`registerMarket` и записью нет `await`. Поэтому событие, которое инициировало
создание сессии, проходит через неё немедленно (одна запись, не ноль). Это
прямой инвариант, а не следствие порядка подписчиков на шине.

## Почему policy на `startsAt`, а не на `now`

Первое наблюдение книги приходит уже ПОСЛЕ старта торгов. Если оценивать
policy на `now`, рынок с полуоткрытым окном policy (`effectiveUntil`) мог бы
«внезапно» перестать подходить ровно тогда, когда начал присылать данные, —
хотя control-plane законно приобрёл его до старта. Оценка на `startsAt`
повторяет решение планировщика: приобрели → значит и записываем.

## Что делает recorder, а что gate

| Ответственность | Владелец |
| --- | --- |
| подписка на шину, запись, RTDS fan-out, CEX-окна, seal/finalize | `ExternalMessageRecorder` |
| «начинать ли собирать этот рынок» (universe + policy) | `PolymarketCollectionGate` |
| физические подписки под `collector:raw` | shared control-plane |

Gate не подписывается на шину и не пишет на диск. Он — чистая политика,
которую recorder дёргает функцией при отсутствии сессии. Поэтому граница
recorder-а не расширяется (он по-прежнему не знает про `MarketUniverse`/policy),
а коллектор остаётся sibling-consumer, а не gate перед семантикой.

## Пример кода

```typescript
const gate = new PolymarketCollectionGate({ universe, policy: pmPolicy, logger });
const recorder = new ExternalMessageRecorder({
  bus,
  storage: polymarketStorage,
  logger,
  cex: { bus, storage: cexStorage },
  sessionProvider: gate.sessionProvider(),
});
recorder.start();
```

## Границы и что отложено

Границы (E/I) закреплены `contour-boundary.test.ts`: src не импортирует
source-классы/транспорт (`polymarket-v2`/`cex-v2` НЕТ в allow-list — registration
строится из canonical `Market`, без vendor-деривации фидов); replay-контур и
recorder не зависят от коллектора.

Отложено на следующий этап (полный lifecycle) — осознанно:

- **RTDS-запись** (spot + settlement TWAP): разделяемые фиды без expiry/seal
  дописывались бы в датасет истёкшего рынка. Регистрирует их этап с expiry/seal.
- **Терминальное состояние сессии**: без seal/finalize (в этой фазе не
  вызываются) позднее наблюдение не может ре-допустить закрытый рынок; набор
  терминальных ключей введёт lifecycle-этап.
- **Vendor-данные финализации** (`SelectedPolymarketMarket`): canonical
  registration их не несёт; как их получит финализатор — решает lifecycle-этап.
- **Допуск по claim-состоянию** control-plane вместо повторной policy-оценки.
- **expiry → FINALIZING → settlement grace → resolution/fallback → seal →
  release claim**, замена отказавшего источника.
