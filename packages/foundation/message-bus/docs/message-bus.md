# @polymarket/message-bus — внутреннее устройство

> Публичный поведенческий контракт (гарантии, non-guarantees, error model) — в
> `../README.md`. Этот файл описывает внутренности текущей реализации и контрактом
> не является: будущие ревизии движка вправе менять всё, что здесь описано, пока
> проходят contract-тесты пакета.

## Почему пакет вообще существует

### Проблема

В системе нужно как минимум два независимых контура доставки сообщений
(application-события и внешние market-data сообщения) с одинаковой базовой
семантикой: FIFO-очередь, параллельный fan-out, critical/non-critical
обработчики, overflow/drain-limit защиты, Result-ошибки. Дублировать этот движок
в каждом контуре — значит дублировать и его баги (в старом Application EventBus
таким багом был sync-throw, обходивший fan-out).

### Решение

Один generic Foundation-примитив `MessageBus<TMessage extends TypedMessage>`,
который знает о сообщении только `type`. Контуры настраивают его политикой и
оборачивают своим API; сам движок не имеет причин меняться от эволюции
прикладных контрактов.

## Ключевые внутренние решения

### FifoMessageQueue: head-индекс вместо Array.shift()

`Array.shift()` — O(n) на каждый dequeue (сдвиг всех элементов), недопустимо для
high-frequency потока. Вместо этого:

#### Алгоритм шагами

1. `enqueue(item)` — `push` в backing array (amortized O(1)).
2. `dequeue()`:
   - если `_head >= _items.length` — очередь пуста, вернуть `undefined`;
   - взять `_items[_head]`, записать в слот `undefined` (освободить ссылку для
     GC — прочитанный prefix не должен удерживать сообщения), инкрементировать
     `_head`;
   - вызвать `_maybeCompact()`.
3. `_maybeCompact()` — отрезать consumed prefix (`slice(_head)`), когда
   `_head >= 1024` И `_head >= половины` backing array. Первое условие не даёт
   дёргать `slice` на маленьких очередях, второе амортизирует стоимость: между
   compaction'ами выполняется не меньше dequeue-операций, чем стоит сам `slice`,
   поэтому суммарно — amortized O(1) на операцию, а память не растёт бесконечно.
4. `clear()` — пересоздать backing array (используется drain-limit защитой).

Очередь — внутренняя деталь (`src/queue/`), из корня пакета не экспортируется:
публичный API пакета не должен фиксировать конкретную структуру данных.

### Один активный drain: `_activeDrain`, зарегистрированный до старта

Единственный источник истины об активном drain — поле
`_activeDrain: Promise<Result<...>>`. `_startDrain()` использует deferred-паттерн:

1. создаётся promise итогового Result (с внешними `resolve`/`reject`);
2. он **сначала** присваивается в `_activeDrain`;
3. и только затем вызывается `_runDrain()`.

Порядок принципиален. `_runDrain()` выполняется синхронно до первого await — он
успевает извлечь первое сообщение и синхронно запустить префиксы его
обработчиков. Обработчик в этом самом раннем синхронном участке уже может
вызвать `publish()` (должен получить enqueue-`Ok`, не второй drain) или
`drain()`/`close()` (должны присоединиться к активному drain). Ранняя версия
присваивала `_activeDrain` после запуска `_runDrain()` — в этом синхронном окне
`drain()`/`close()` запускали **второй (nested) drain**, ломая FIFO и инвариант
«один активный drain» (зафиксировано regression-тестами в
`MessageBus.lifecycle.test.ts`). Отдельного boolean-флага (`_dispatching`) нет
намеренно — два поля могли бы рассинхронизироваться; `getStats().dispatching`
выводится из `_activeDrain !== undefined`.

По завершении `_runDrain()` поле очищается **до** settle promise — все
присоединившиеся caller'ы возобновляются с уже чистым состоянием. Rejection
`_runDrain()` (нарушение внутреннего инварианта — баг) пропагируется наружу
rejection-ом, не маскируется под operational-Result.

Владелец drain — вызов, запустивший `_startDrain()` (publish/publishAll на idle,
drain(), close()); он и присоединившиеся через `_activeDrain` получают
терминальный Result; конкурентные публикации получают enqueue-`Ok`.

### Ошибки конструируются в точке возникновения

Старый Application EventBus конвертировал throw в typed-ошибки на публичной
границе и вынужден был угадывать происхождение по `instanceof` (что до M-000
неверно классифицировало `QueueOverflowError`, брошенную обработчиком). Здесь
классификация не нужна вовсе:

- `MessageBusOverflowError` — создаётся на capacity-check в
  `publish()`/`publishAll()` (`_rejectOverflow()`);
- `MessageBusCriticalHandlerError` — создаётся в `_dispatchMessage()` сразу после
  `allSettled`, где известны `message.type` и raw reason;
- `MessageBusDrainLimitError` — создаётся внутри `_runDrain()` при срабатывании
  guard;
- `MessageBusClosedError` — создаётся на closed-check.

Внутренние методы возвращают `Result`/ошибку значением, а не бросают —
`_runDrain()` в принципе не имеет throw-путей. Неожиданное исключение (баг)
пропагирует rejected promise-ом и сознательно не оборачивается.

### Sync-throw нормализация

`_dispatchMessage()` оборачивает вызов обработчика в async-замыкание
(`async (entry) => { await entry.handler(message); }`): синхронный throw
становится rejection в `allSettled` наравне с async-ошибкой, siblings стартуют
всегда. Это прямой перенос фикса M-000.

### Snapshot подписчиков

`[...entries]` до запуска обработчиков: отписка во время fan-out не исключает
обработчик из текущего сообщения, подписка — не добавляет. Порядок snapshot
(insertion order Set) используется для детерминированного выбора канонической
critical-ошибки, но НЕ является публичной гарантией порядка выполнения.

### Observer isolation

Каждое уведомление — через `_notifyObserver(fn)` с try/catch: telemetry-hook не
может повлиять на Result, очередь или доставку. Логгера в пакете нет — интеграция
с logger/metrics происходит на стороне потребителя через observer.

## Карта файлов

| Файл | Ответственность |
|---|---|
| `TypedMessage.ts` | generic-граница (`{ type: string }`) |
| `MessageEnvelope.ts` | опциональный конверт `{ type, payload, metadata? }` |
| `MessageHandler.ts` | тип обработчика (sync/async) |
| `IMessageBus.ts` | публичный порт |
| `MessageBus.ts` | движок: очередь, drain ownership, fan-out, lifecycle |
| `MessageBusPolicy.ts` | policy shape, default, helper, валидация |
| `MessageBusStats.ts` | снимок диагностики |
| `MessageBusObserver.ts` | best-effort observer контракт |
| `errors.ts` | typed-ошибки с literal `code` |
| `queue/FifoMessageQueue.ts` | внутренняя FIFO-очередь |

## Тесты

8 сьютов (`__tests__/`): queue (FIFO/compaction/100k), delivery (routing,
параллельный fan-out, FIFO между сообщениями), failures (non-critical/critical,
fake-bus-error из обработчика, overflow, drain-limit, observer isolation),
reentrancy (reentrant/конкурентные публикации, mutation during dispatch),
lifecycle (`drain`/`close`/recovery), stats (счётчики), types (compile-time
narrowing, flat+envelope), policy (defaults/валидация). Тесты проверяют только
observable-поведение — внутренние структуры не фиксируются.
