# Внешний контур доставки (M-004)

Разбор архитектуры `@polymarket/external-messages` + `@polymarket/external-message-bus`:
почему контур сделан именно так и где проходят его границы.

## Проблема

До M-004 у системы был ровно один semantic-контур сообщений — Application
`EventBus` поверх generic движка `MessageBus` (M-001/M-002). Сообщения внешних
источников (Polymarket WS, CEX, RTDS) попадали в систему без общей границы:
каждый транспорт сам решал, во что и когда превращать сырой frame, и делал это
непосредственно в момент приёма.

Из этого следовали три проблемы:

1. **некуда подписать Recorder** — «сырое наблюдение» нигде не существовало как
   объект первого класса, поэтому записывать было нечего;
2. **некуда подключить replay** — Reader не имел точки, в которую можно вернуть
   записанные наблюдения так, чтобы система обработала их тем же кодом;
3. **смешение ответственностей** — декодирование транспорта и semantic-перевод
   в `Orderbook`/`Trade` жили в одном месте, поэтому переиспользовать первое без
   второго было нельзя.

## Решение

Второй semantic delivery contour поверх ТОГО ЖЕ generic движка:

```text
                      MessageBus<T>
                     /             \
        Application EventBus     ExternalMessageBus
                 │                        │
          EventBusEvent             ExternalMessage
                 │                        │
        semantic internal           source-native
             events                 observations
```

Ключевое: разделяется **semantic meaning**, а не механика. Механика доставки
остаётся ровно одна.

## Целевой поток

```text
external transport
        ↓
source-specific decode / basic validation
        ↓
ExternalMessage                    ← новая граница M-004
        ↓
ExternalMessageBus                 ← новый контур M-004
        ↓
source-specific semantic adapter   ← M-005+
        ↓
internal semantic object / ApplicationEvent / Domain workflow
```

Конкретный будущий пример (M-005, в M-004 НЕ реализуется):

```text
Polymarket WS raw
        ↓
Polymarket transport
        ↓
PolymarketExternalMessage
        ↓
ExternalMessageBus
        ↓
Polymarket semantic adapter
        ↓
Orderbook / Trade
```

## Почему Infrastructure, а не Foundation

`ExternalMessage` — boundary-контракт **внешней инфраструктуры**: он существует
потому, что у нас есть транспорты, и описывает их наблюдения. Foundation
описывает универсальные системные примитивы (конверт, metadata, доставка) и не
должен знать, что у системы вообще есть внешний мир.

Проверяемое следствие: `packages/foundation/**` не имеет ни одной зависимости на
`external-*` (тест `contour-boundary.test.ts`, блок «Foundation не зависит от
Infrastructure»).

## Почему alias конверта, а не второй envelope

```typescript
export type ExternalMessage<TType extends string, TPayload, TMetadata extends MessageMetadata = MessageMetadata> =
  MessageEnvelope<TType, TPayload, TMetadata>;
```

Альтернатива — собственный `ExternalMessageEnvelope` со своими полями — была
отвергнута: два независимых определения структуры `{ type, payload, metadata }`
неизбежно разъезжаются, и тогда generic движок доставки перестаёт быть общим для
обоих контуров. Canonical owner структуры остаётся один — `@polymarket/messages`
(M-003).

По той же причине нет `ExternalMessageMetadata`: `source`, `channel`, `exchange`,
`marketId`, `tokenId`, `transport`, `connectionId`, `rawTopic` — это
semantic-данные конкретного источника, а не универсальные message-system
concerns. Их место — в typed payload. Поле попадёт в metadata только если будет
доказано, что оно универсально для ВСЕХ внешних сообщений.

## Почему композиция, а не наследование

```typescript
class ExternalMessageBus<TMessage extends AnyExternalMessage> {
  private readonly _bus: MessageBus<TMessage>;
}
```

`extends MessageBus` дал бы фасаду доступ к внутренностям движка и возможность
частично переопределить delivery-семантику — тогда «один движок доставки»
перестало бы быть правдой: у контуров разошлись бы гарантии порядка и ошибок.
Композиция оставляет ровно одного владельца механики.

Тот же аргумент действует и в обратную сторону: M-004 не потребовал ни одного
runtime-изменения в `packages/foundation/message-bus/**`. Если бы потребовал —
это был бы сигнал, что generic-контракт M-003 недостаточен, и правильным
действием было бы чинить контракт, а не движок.

## Почему lifecycle публичен

Application `EventBus` намеренно скрывает `drain()`/`close()`: Application-слой
не владеет lifecycle движка доставки, а `publishAll([])` исторически (M-000)
играет роль «kick»-а очереди.

Внешний контур — Infrastructure, и здесь lifecycle нужен по существу:

| Сценарий | Операция |
|---|---|
| transport reconnect | `drain()` — дообработать наблюдения до пересоздания соединения |
| graceful shutdown | `close()` — доставить остаток adapter-ам/Recorder-у |
| future Reader/replay | `drain()` после проигрывания файла |

Именно поэтому `drain()`/`close()` входят в публичный API — Reader (M-00x)
проектируется под них заранее.

## Почему ошибки не транслируются

`EventBus` переводит `MessageBus*Error` в `QueueOverflowError`/
`CriticalHandlerError`, потому что его публичный error-контракт зафиксирован
M-000 — раньше, чем появился движок, и обязан от него не зависеть.

У внешнего контура унаследованного контракта нет. Второй набор
классов-близнецов (`ExternalMessageBusPublishError` и т.п.) не дал бы ничего,
кроме дублирования и лишнего слоя перевода, поэтому наружу идут canonical
ошибки движка. Решение обратимо: если внешней инфраструктуре понадобятся
собственные semantic-ошибки, translation boundary добавляется отдельно.

## Границы контура

Что контур делает:

- маршрутизирует внешние сообщения по `type`;
- сохраняет FIFO-порядок и identity объекта;
- отдаёт lifecycle и operational-диагностику.

Чего контур не делает:

| Не делает | Кто делает | Когда |
|---|---|---|
| decode/validation сырого frame | transport источника | до `ExternalMessage` |
| генерацию metadata | producer через `MessageMetadataGenerator` | до `publish` |
| интерпретацию payload | semantic adapter | после доставки, M-005+ |
| построение `Orderbook`/`Trade` | semantic adapter | M-005+ |
| запись наблюдений | Recorder | отдельная фаза |
| воспроизведение наблюдений | Reader | отдельная фаза |

## Causality

Внешнее наблюдение, как правило, начинает causal chain — у него нет
сообщения-родителя внутри системы:

```typescript
// transport
const external = {
  type: 'POLYMARKET_BOOK',
  payload: decodePolymarketBook(frame),
  metadata: generator.nextRoot(),
};

// semantic adapter
const internal = {
  type: 'ORDERBOOK_UPDATED',
  payload: toOrderbook(external.payload),
  metadata: generator.nextChild(external.metadata),
};
```

```text
M1 ExternalMessage    messageId = M1, correlationId = M1, causationId = —
 ↓
M2 ApplicationEvent   messageId = M2, correlationId = M1, causationId = M1
```

`correlationId` — корень ВСЕЙ цепочки (не непосредственный parent),
`causationId` — стрелка ровно на один шаг назад. M-004 фиксирует этот contract
тестами (`ExternalMessageBus.causality.test.ts`); реальные adapters подключаются
в M-005+.

## Что покрыто тестами

| Файл | Что доказывает |
|---|---|
| `external-messages/__tests__/ExternalMessage.types.test.ts` | canonical-конверт обязателен; flat-формы, отсутствующие payload/metadata и лишние top-level поля отклоняются; `ExternalMessage` структурно совпадает с `MessageEnvelope`; `AnyExternalMessage` не даёт narrowing |
| `ExternalMessageBus.test.ts` | delegation: publish/publishAll FIFO/stats/lifecycle/disposer; identity сообщения; canonical ошибки без трансляции; композиция вместо наследования |
| `ExternalMessageBus.types.test.ts` | typed subscribe narrowing по каждому члену union; canonical-конверт на границе publish; `IExternalMessageBus` взаимозаменяем с `IMessageBus` |
| `ExternalMessageBus.causality.test.ts` | root/child causal chain; bus в causality не участвует |
| `contour-boundary.test.ts` | целевой dependency graph; Foundation не зависит от Infrastructure; изоляция контуров; отсутствие дублей technical types и второго envelope |

Поведенческий контракт самой доставки здесь НЕ переповторяется — он покрыт
exhaustive contract-suite движка (M-001, 86 тестов) и M-000 suite Application
EventBus (46 тестов), которые M-004 не менял.

## Что дальше

- **M-005 Polymarket** — `PolymarketExternalMessage` + semantic adapter;
- **M-006 CEX**, **M-007 RTDS**, **M-008 private/user channel**;
- **Recorder** — подписчик контура, пишет наблюдения as-is;
- **Reader/replay** — публикует записанные наблюдения обратно в контур.

До этих фаз union внешних сообщений намеренно пуст: искусственные
source-контракты «чтобы что-то было» не создаются.
