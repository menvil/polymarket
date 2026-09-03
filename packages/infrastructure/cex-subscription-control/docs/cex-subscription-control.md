# CexSubscriptionController — разделяемые физические CEX-потоки

## Проблема

К этому моменту в контуре были готовы обе части:

```text
CexPolicy  +  CexSource  +  ExternalMessageBus
```

Не было слоя между ними — того, который превращает НЕСКОЛЬКО owner-policy в
РАЗДЕЛЯЕМЫЕ физические потоки. Без него каждый владелец поднимал бы свой
`CexSource`, и на один и тот же `binance/spot/BTC/USDT` появлялось бы столько
CCXT-соединений, сколько нашлось желающих. Хуже того, шина получила бы
несколько записей одной routing identity — дубли, которые data-plane никак не
отличит от настоящих наблюдений.

## Решение

```text
              CEX CONTROL

runtime owner demands (ownerKey + CexPolicy)
        ↓
CexPolicy оценивается НА `now`
        ↓
logical claims
   owner + exchangeId + marketType + symbol + stream
        ↓
aggregate pools
   exchangeId + marketType + stream

binance|swap|ORDERBOOK   owners: A,B   symbols: BTC,ETH   depth: 50
binance|swap|TRADES      owners: A,C   symbols: BTC,XRP
        ↓
immutable CexSource generations
        ↓
ExternalMessageBus
```

Главный принцип ровно один:

> несколько владельцев одного CEX-ресурса делят физический поток, а не
> создают дубликаты.

## Публичный API

```typescript
class CexSubscriptionController {
  constructor(dependencies: CexSubscriptionControllerDependencies);

  get isClosed(): boolean;

  reconcile(
    demands: readonly CexSubscriptionDemand[],
    now: Timestamp,
  ): Promise<CexSubscriptionReconcileResult>;

  getStats(): CexSubscriptionControllerStats;
  listPools(): readonly CexSubscriptionPoolSnapshot[];
  listClaims(): readonly CexSubscriptionClaim[];
  close(): Promise<void>;
}
```

`now` приходит аргументом. Ни `Date.now()`, ни `new Date()`, ни `IClock`
внутри контроллера нет — это проверяется структурным тестом. Composition root
читает часы один раз на тик и передаёт один и тот же момент во все решения
этого тика.

## Почему CEX-спрос авторитетен, а Polymarket — нет

Это главное отличие от `PolymarketSubscriptionController`, и копировать тот
контур было бы ошибкой.

```text
Polymarket:  рынок имеет startsAt
             → приобрести надо ДО старта
             → после старта claim закреплён
             → исчезновение из плана ≠ release

CEX:         BTC/USDT — непрерывный поток
             → ни startsAt, ни expiry, ни rollover
             → нужен, пока есть текущий demand
             → demands = authoritative desired state
```

У площадки предсказаний «рынка нет в плане» означает «его уже поздно
ПРИОБРЕТАТЬ», а вовсе не «он больше не нужен»: рынок выпадает из плана ровно
в момент старта торгов — то есть тогда, когда подписка наконец начинает
приносить данные. Снять по этому признаку claim значило бы рвать подписку в
самый неподходящий момент. Отсюда инвариант PM-контура: ACQUISITION ≠
RETENTION.

У биржи никакого момента старта не существует. Поток `binance/spot/BTC/USDT`
одинаково пригоден в любую секунду, и единственная причина его держать — что
кто-то его СЕЙЧАС хочет. Поэтому здесь:

```text
владелец пропал из demands  → его claim-ы сняты
ресурс больше никому не нужен → физический поток закрыт
```

## Policy оценивается на `now`

```text
Polymarket: isPolicyEffectiveAt(policy, market.startsAt)
CEX:        isPolicyEffectiveAt(policy, now)
```

Вопрос разный: не «подойдёт ли policy, когда рынок начнётся», а «нужен ли
этому владельцу непрерывный поток прямо сейчас». Полуоткрытая семантика
`PolicyWindow` сохраняется целиком:

```text
BTC policy effectiveUntil 18:00 · XRP policy effectiveFrom 18:00

17:59:59.999 → BTC активна,   XRP неактивна
18:00:00.000 → BTC неактивна, XRP активна
```

Владелец, чья policy сейчас не действует, остаётся в `demands` (он есть в
`inactiveDemands` отчёта), но claim-ов не даёт.

## Две identity: логическая и физическая

```text
logical claim:  ownerKey + exchangeId + marketType + symbol + stream
physical pool:            exchangeId + marketType +          stream
```

Символ есть в claim-е и НЕТ в ключе пула. Это прямое следствие архитектуры
`CexSource`: он специально оптимизирован под «один CCXT Pro instance на поток
для всех символов одной биржи и типа рынка». Пул на владельца или пул на
символ ломал бы ровно ту оптимизацию, ради которой источник и написан.

Ключ пула детерминированный и не содержит владельцев:

```text
binance|swap|ORDERBOOK
binance|swap|TRADES
```

### Почему ORDERBOOK и TRADES — разные пулы

`CexSource` и так держит для них независимые transport-сессии. Разделение на
уровне контроллера даёт главное: смена набора символов стакана не заставляет
перезапускать поток сделок. Каждый пул материализуется источником, у которого
включён РОВНО один поток:

```typescript
// orderbook pool
{ exchangeId, marketType, symbols, watchOrderbook: true,  watchTrades: false, orderbookDepth }
// trades pool
{ exchangeId, marketType, symbols, watchOrderbook: false, watchTrades: true }
```

## Раскрытие policy и агрегация

Активная policy раскрывается декартовым произведением:

```text
exchangeIds × marketTypes × symbols
```

и на каждую комбинацию — по claim-у на каждый запрошенный поток. Никаких
выдуманных инструментов: `CexMarketUniverse`, `CexDiscovery` и `CexMarket` в
пакете нет и не появятся ради этой задачи — `CexPolicy` уже содержит точные
ресурсы.

### Символы

```text
symbols = union всех claim-ов пула, без дублей, ASC
```

Сортировка не косметика: спецификация обязана быть функцией МНОЖЕСТВА
claim-ов. Иначе `[B, A]` и `[A, B]` считались бы разными спецификациями, и
порядок элементов во входном массиве вызывал бы замену поколения на ровном
месте.

### Глубина стакана

```text
requested depth = MAX желаемых глубин всех claim-ов пула
```

```text
A: BTC depth 10 · B: BTC depth 50 · C: ETH depth 20
→ binance|swap|ORDERBOOK  symbols=[BTC, ETH]  depth = 50
```

Более глубокий поток удовлетворяет и того, кому хватает меньшей глубины:
потребитель возьмёт нужный ему срез сам. Альтернатива — поднять два источника
на один символ с разной глубиной — дала бы шине две записи одной routing
identity.

Глубина передаётся как ЗАПРОШЕННАЯ. Реальные ограничения биржи и
`normalizeOrderbookDepth()` остаются внутри `CexSource`; повторять его
whitelist здесь означало бы завести второй, который отстанет от первого.
Отсутствующая в policy глубина заменяется `DEFAULT_ORDERBOOK_DEPTH` из
`@polymarket/cex-v2`.

## Порядок прохода

```text
1. валидация ВСЕГО входа
2. оценка PolicyWindow на `now`
3. раскрытие активных policy в логические claim-ы
4. агрегация claim-ов в полный набор желаемых пулов
5. сравнение желаемых пулов с текущими физическими
6. и только теперь — физические переходы
7. фиксация логического снимка claim-ов
```

Менять состояние по ходу разбора одного владельца нельзя: это авторитетный
переход состояния целиком. Отсюда же запрет дубликата `ownerKey` в одном
входе — два спроса одного владельца не отвечают, какая policy каноническая, а
молчаливый выбор одного из них сделал бы результат зависящим от порядка
массива. Смена policy выражается ДВУМЯ проходами.

Пулы обходятся последовательно, в порядке `exchangeId → marketType → stream`.
`Promise.all` не используется намеренно: детерминированные логи, порядок
отчёта и простая изоляция отказов стоят дороже параллелизма нескольких
переходов, которые случаются далеко не каждый тик.

## Переходы пула

```text
желаем + текущий совпадает и здоров → переиспользовать (steady state)
желаем + текущий отличается/мёртв   → заменить поколение
желаем + текущего нет               → поднять
не желаем + текущий есть            → закрыть
```

«Совпадает» — это полное равенство спецификации: биржа, тип рынка, поток,
отсортированный набор символов и глубина. При совпадении не вызывается ни
`close()`, ни `start()`, номер поколения не меняется. Повторный проход с тем
же спросом физически идемпотентен.

«Мёртв» — это `hasFailed` либо `isClosed`. Такой источник желаемое состояние
не удовлетворяет, и притворяться, что пул активен, нельзя: он заменяется
новым поколением. Попытка ровно одна на проход — внутреннего retry-цикла нет,
следующий внешний тик попробует снова.

### Замена поколения: correctness > zero-gap

`CexSource` immutable: `addSymbol`/`removeSymbol`/`reconfigure` у него нет, и
добавлять их в этом MR запрещено. Значит смена спецификации — это новое
поколение. Порядок строгий:

```text
await old.close()              ← ПОДТВЕРЖДЁННЫЙ teardown транспорта
освободить identity пула
factory(new config)
new.start()
```

### Что значит «подтверждённый»

Это не фигура речи и не «остановка запрошена». `CexSource.close()` резолвится
только когда **ни один** `instance.close()` этого источника больше не
выполняется в фоне.

Различать два таймера обязательно:

```text
closeTimeoutMs        → сколько cleanup ОДНОЙ сессии держит supervised restart
                        (чтобы зависший vendor не подвесил перезапуск);
                        по истечении закрытие ПРОДОЛЖАЕТСЯ в фоне

CexSource.close()     → граница жизненного цикла владельца source;
                        ждёт фактического завершения всех таких закрытий,
                        таймаутом не ограничена
```

До исправления `close()` возвращал управление по истечении session-таймаута,
и инвариант «старое закрыто полностью» был **декларативным**: контроллер
поднимал поколение 2, пока CCXT поколения 1 ещё закрывал websocket-ы. Два
живых транспорта одной routing identity — ровно то, что запрещает главный
контракт пакета. Регрессия зафиксирована тестом на реальной композиции
(`__tests__/real-source-integration.test.ts`): без исправления в нём
одновременно существуют два инстанса.

### Identity не освобождается раньше подтверждения

Ключ пула остаётся занятым, пока teardown не подтверждён — включая случай,
когда `close()` **отказал**:

```text
teardown failure → проблема доступности пула,
                   но НЕ разрешение поднять дубль поверх живого транспорта
```

Поэтому при отказе закрытия замена не поднимается вовсе, поколение остаётся
за контроллером как барьер identity, а отказ уезжает в `failures`. Следующий
проход повторит закрытие и освободит пул только после успеха. Исключение —
`controller.close()`: там следующего поколения не будет, защищать нечего, и
запись освобождается в любом случае (контракт `physicalPools = 0`).

Обратный порядок («поднять новое, потом закрыть старое») дал бы окно, в
котором ОБА поколения публикуют `CEX_ORDERBOOK`/`CEX_TRADE` с одинаковой
routing identity. Такие дубли data-plane не отличает от настоящих
наблюдений — а вот пропуск он видит и переживает. Поэтому выбран честный
контракт:

```text
никогда не дублировать · допускается ограниченный разрыв
                         при ЯВНОЙ переконфигурации
```

Разрыв возникает не каждый тик, а только при добавлении/удалении символа или
изменении агрегированной глубины. Zero-gap handover (тегирование поколений в
сообщениях, дедуп, readiness-протокол, подавление двойной публикации) —
отдельная сложная задача; начинать с неё значило бы платить сложностью
раньше, чем доказана честная семантика.

## desired ≠ satisfied

Отказ транспорта НЕ стирает намерение владельца:

```text
A хочет BTC → start() бросил
→ claim A существует
→ пул желаем
→ физического пула нет
→ failure в отчёте
→ следующий reconcile попробует снова
```

Поэтому логический снимок claim-ов фиксируется всегда, а `getStats()`
различает `desiredPools` и `physicalPools`. Их расхождение — единственный
честный признак деградации транспорта. Называть claim-ы «активными
подписками» было бы прямой ложью: claim — это намерение и владение,
физический пул — его материализация.

То же верно для сорвавшейся замены: старое поколение закрыто, новое не
поднялось — желаемая спецификация уже НОВАЯ, и следующий проход поднимет
именно её, а не будет считать её «неизменившейся».

## Отказы транспорта — значения, дефекты вызывающего — исключения

```text
ValidationError:  контроллер закрыт · пустой ownerKey · дубликат владельца
                  · policy не CEX-вида · пустой символ · неизвестный тип
                  рынка · недопустимая глубина

result.failures:  фабрика бросила · start() бросил · источник родился
                  мёртвым · close() бросил
```

Вся валидация выполняется синхронно, в момент вызова, ДО постановки прохода в
очередь и до первого побочного эффекта. Метод при этом `async`: дефект входа
обязан приходить отклонённым промисом, а не синхронным throw.

Отказ одной биржи не мешает другой:

```text
binance/swap failed · kraken/spot succeeded
```

## Владение источниками

В отличие от Polymarket, где один общий `PolymarketSource` принадлежит
composition root, CEX-контроллер СОЗДАЁТ несколько immutable поколений через
фабрику — значит он же обязан их закрывать:

```typescript
type CexSubscriptionSourceFactory = (config: CexSourceConfig) => CexSubscriptionSource;

// production composition
const sourceFactory: CexSubscriptionSourceFactory = (config) =>
  new CexSource({ config, bus, metadataGenerator, logger });
```

`CexSubscriptionSource` — не новая vendor-абстракция, а structural-подмножество
существующего `CexSource`: реальный класс подходит под него без адаптера.
Контроллер не знает ни `ExternalMessageBus`, ни `MessageMetadataGenerator`, ни
CCXT — всё это захватывает фабрика. Шину и генератор metadata контроллер НЕ
закрывает: ими владеет composition root.

## Сериализация проходов

Два одновременных `reconcile()` не перестраивают пулы вперемешку: второй
начинается после полного commit первого, и итоговое состояние соответствует
ПОСЛЕДНЕМУ по порядку вызова. Отклонять второй вызов незачем — он не
конфликтует, он просто следующий.

Почему здесь это нужно, а у PM-контроллера — нет: `acquire(market)` работает с
независимыми ключами, а `reconcile()` перестраивает ГЛОБАЛЬНЫЙ авторитетный
снимок желаемого состояния.

`close()` блокирует новые проходы, дожидается идущего (включая источники,
которые он успел поднять), закрывает все пулы **подтверждённо** и очищает
логическое состояние. После его резолва не выполняется ни одного фонового
закрытия CCXT. Идемпотентен. Проход, стоявший в очереди на момент `close()`, отклоняется
`ValidationError` и источников не поднимает.

## Диагностика

```typescript
interface CexSubscriptionControllerStats {
  owners: number;          // владельцы хотя бы с одним claim-ом
  logicalClaims: number;
  desiredPools: number;    // сколько пулов ХОТЯТ
  physicalPools: number;   // сколько из них материализовано
  orderbookPools: number;
  tradePools: number;
  runningPools: number;
  failedPools: number;
  closed: boolean;
}
```

`listPools()` показывает ОБА уровня сразу: `ownerKeys` отвечают на вопрос «кто
этого хочет», `satisfied`/`running`/`failed`/`generation` — «есть ли это
физически» (`generation: 0` означает, что физического поколения сейчас нет).
`listClaims()` отдаёт намерение в детерминированном порядке. Vendor-объекты
(CCXT-инстансы, unified-модели) наружу не выходят вообще.

## Live smoke

```bash
npx tsx packages/infrastructure/cex-subscription-control/scripts/cex-subscription-control-smoke.ts
```

Четыре фазы против реальной публичной биржи (без credentials):

```text
1. baseline   A: BTC стакан+сделки → 2 пула, поколение 1, сообщения идут
2. sharing    +B на ТОТ ЖЕ ресурс  → пулов по-прежнему 2, поколения ТЕ ЖЕ
3. expansion  B добавляет ETH      → оба пула заменены, поколение 2, оба символа
4. shrink     A уходит, потом []   → пулы закрыты, physicalPools = 0
```

В отличие от Polymarket-смоука, где приобретается предстоящий рынок и тишина
законна, здесь число сообщений — КРИТЕРИЙ: поток биржи непрерывен, и его
отсутствие означает, что физического потока на самом деле нет.

### Результат прогона 2026-09-03, binance spot

```text
phase 1 — baseline
  opened=[binance|spot|ORDERBOOK, binance|spot|TRADES]   failures: none
  CEX_ORDERBOOK: 166   CEX_TRADE: 1247

phase 2 — sharing
  unchanged=[binance|spot|ORDERBOOK, binance|spot|TRADES]
  owners=[smoke:owner-a, smoke:owner-b]   gen=1 (не изменилось)

phase 3 — expansion
  replaced=[binance|spot|ORDERBOOK, binance|spot|TRADES]
  gen=2   symbols=[BTC/USDT, ETH/USDT]
  symbols observed: [BTC/USDT, ETH/USDT]

phase 4a — shrink (A уходит, spec не изменилась)
  unchanged=[binance|spot|ORDERBOOK, binance|spot|TRADES]   без замены

phase 4b — demands=[]
  closed=[binance|spot|ORDERBOOK, binance|spot|TRADES]
  desiredPools=0 physicalPools=0 logicalClaims=0 owners=0

exit code 0
```

## Почему нет `CexControlRuntime`

У Polymarket над контроллером есть проход: discovery → universe → planner →
acquire, и ему нужен свой пакет. У CEX ничего этого нет — ни discovery, ни
universe, ни планировщика, ни отбора кандидатов, ни rollover. `CexPolicy` уже
содержит точные ресурсы, выбирать не из чего.

`reconcile(demands, now)` и ЕСТЬ полный control-шаг CEX. Обёртка
`CexControlRuntime.runOnce()` вокруг него добавила бы имя, но не
ответственность. Composition root просто вызовет:

```typescript
await cexController.reconcile(currentCexDemands, now);
```

## Чего в пакете нет

- `CexMarketUniverse`, `CexDiscovery`, `CexMarket` — каталога CEX не
  существует, `CexPolicy` самодостаточна;
- знания о коллекторе, рекордере, стратегиях и семантических адаптерах —
  владельцы для контроллера непрозрачные строки;
- `ExternalMessageBus` и `MessageMetadataGenerator` — их захватывает фабрика;
- control-событий на шине (`CEX_SUBSCRIPTION_OPENED` и подобных) — прямая
  оркестрация, результат и логи;
- собственного таймера — каденцию задаёт composition root;
- изменений транспортной архитектуры `CexSource` (`RestartingTask`, backoff,
  stale-таймауты, плановый рестарт, multiplex, per-symbol fallback, REST
  fallback) — этот код доказан, контроллер живёт НАД ним.

## Следующий этап

Collector Cutover: `ExternalMessageBus → Collector` как независимый
потребитель. Коллектор перестаёт владеть PM/CEX-источниками — вместо этого
он становится обычным владельцем claim-ов (`collector:raw`) и обычным
подписчиком шины.
