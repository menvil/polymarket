# Event Bus Errors

Ошибки для `@polymarket/event-bus` в торговой системе Polymarket.

## Обзор

Event Bus Errors представляют операционные состояния очереди событий — переполнение
под нагрузкой, а не ошибки входных данных. Возникают, когда `EventBus` физически не
может обработать/поставить в очередь события в текущий момент.

Все event-bus errors имеют:

- **Severity:** `high` (потерянные/непоставленные события — риск рассинхронизации
  состояния системы: пропущенный fill, необработанное обновление ордера)
- **Статический код:** `ErrorClass.code`
- **Предназначение:** сейчас — throw (`EventBus.publish/publishAll` throw-based, `@throws`
  в `IEventBus`); переход на `Result<void, QueueOverflowError>` запланирован отдельным
  этапом миграции (см. "Почему это сделано так?" ниже)

---

## Каталог ошибок

| Код | Класс | Когда использовать | Документация |
|-----|-------|---------------------|--------------|
| `QUEUE_OVERFLOW_ERROR` | `QueueOverflowError` | Очередь `EventBus` переполнена (`maxQueueSize`) либо упёрлась в `maxEventsPerDrain` при `_drainQueue()` | ниже |

## Почему это сделано так?

`QueueOverflowError` заведён в Этапе 1 плана миграции
(`/Users/menvil/.claude/plans/synthetic-swimming-heron.md`) как часть общего перехода
domain/application-кода на `Result<T, E>` вместо `throw`. Сам класс — чистое дополнение:
`EventBus.publish()`/`publishAll()` сегодня продолжают бросать голый `new Error(...)`
(`packages/application/event-bus/src/EventBus.ts:171,193`) — подключение
`QueueOverflowError` туда через `Result<void, QueueOverflowError>` запланировано отдельно
(Этап 6 того же плана, через deprecation-мост `publishOrThrow()`).

Наследует `TradingError` напрямую (не `ValidationError`) — переполнение очереди не
ошибка входных данных вызывающего кода, а операционное состояние системы под нагрузкой,
по аналогии с `PortfolioOperationError` (`packages/foundation/errors/src/portfolio/`).

## Пример кода (актуальный!)

```typescript
import { QueueOverflowError } from '@polymarket/errors/event-bus';

// packages/application/event-bus/src/EventBus.ts (целевой вид после Этапа 6)
if (this._queue.length + 1 > this._maxQueueSize) {
  return Err(
    new QueueOverflowError(
      `EventBus queue overflow (${this._maxQueueSize}): cannot enqueue ${event.type}`,
      { context: { maxQueueSize: this._maxQueueSize, eventType: event.type } },
    ),
  );
}
```
