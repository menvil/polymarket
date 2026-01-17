/**
 * SequencedEventBus - EventBus для воспроизведения (синхронный, с валидацией sequenceNumber, детерминированный)
 *
 * @remarks
 * Только для REPLAY (НЕ для production)
 *
 * Гарантии:
 * - sequenceNumber ВАЛИДИРУЕТСЯ (события ДОЛЖНЫ публиковаться в порядке возрастания)
 * - Синхронный (БЕЗ setImmediate, handlers вызываются синхронно)
 * - Детерминированный (replay всегда воспроизводится одинаково)
 * - sequenceNumber ОБЯЗАТЕЛЕН (если envelope без sequenceNumber → ошибка)
 * - Нарушение порядка ОТКЛОНЯЕТСЯ (если sequenceNumber <= последнего → ошибка)
 * - Reentrancy БЛОКИРУЕТСЯ (publish() из handler → ошибка, предотвращает stack overflow)
 *
 * КОНТРАКТ: Вызывающий ДОЛЖЕН публиковать события в строго возрастающем порядке sequenceNumber.
 * Если событие приходит с sequenceNumber <= последнего доставленного, выбрасывается ошибка.
 *
 * REENTRANCY: Handlers НЕ МОГУТ вызывать publish() (нарушает детерминизм replay).
 *
 * Отличия от ProductionEventBus (InMemoryEventBus):
 * - ProductionEventBus: асинхронный, FIFO, sequenceNumber игнорируется
 * - ReplayEventBus: синхронный, сортированный, sequenceNumber обязателен
 *
 * @example
 * ```typescript
 * const replayBus = new SequencedEventBus();
 *
 * // Подписка на события
 * replayBus.subscribe('OrderAccepted', (envelope) => {
 *   console.log('Ордер принят:', envelope.payload.orderId);
 * });
 *
 * // Публикация событий с sequenceNumber
 * const envelope1: ReplayEnvelope<OrderAccepted> = {
 *   id: '1',
 *   type: 'OrderAccepted',
 *   payload: { type: 'OrderAccepted', orderId: '123', side: 'BUY', marketId: 'abc', price: 100, size: 10 },
 *   timestamp: new Date(),
 *   executionContext: { environment: 'REPLAY', accountId: 'backtest-xyz' },
 *   sequenceNumber: 42, // ОБЯЗАТЕЛЕН для replay
 * };
 *
 * replayBus.publish(envelope1); // Доставляется синхронно
 * ```
 */
import type { IEventBus, EventHandler } from './IEventBus.js';
import type { EventEnvelope } from './EventEnvelope.js';

/**
 * Реализация SequencedEventBus
 *
 * @remarks
 * Для replay с детерминированным порядком.
 *
 * ВАЖНО: Вызывающий ДОЛЖЕН публиковать события в порядке возрастания sequenceNumber.
 * Если событие публикуется с sequenceNumber <= lastDeliveredSequence, выбрасывается ошибка.
 */
export class SequencedEventBus implements IEventBus {
  private readonly handlers: Map<string, EventHandler[]> = new Map();
  private readonly allHandlers: EventHandler[] = [];

  /** Последний доставленный sequenceNumber (для валидации порядка) */
  private lastDeliveredSequence: number = -1;

  /** Флаг для защиты от reentrancy (true если идёт доставка события) */
  private isDelivering: boolean = false;

  /**
   * Публикует событие в envelope (синхронно, sequenceNumber обязателен, порядок валидируется)
   *
   * @param envelope - EventEnvelope (ДОЛЖЕН содержать sequenceNumber > lastDelivered)
   *
   * @remarks
   * Валидация:
   * - Reentrancy БЛОКИРУЕТСЯ (publish() из handler → ошибка)
   * - sequenceNumber ОБЯЗАТЕЛЕН (undefined → ошибка)
   * - sequenceNumber > lastDeliveredSequence (нарушение порядка → ошибка)
   * - Доставка СИНХРОННАЯ (БЕЗ setImmediate)
   * - Детерминированный replay
   *
   * Защита от reentrancy:
   * - Handlers НЕ МОГУТ вызывать publish() (нарушает детерминизм replay)
   * - Попытка publish() из handler выбрасывает ошибку
   * - Защищает от stack overflow при вложенных publish()
   *
   * @throws {Error} Если publish() вызван из handler (reentrancy)
   * @throws {Error} Если sequenceNumber отсутствует
   * @throws {Error} Если sequenceNumber <= lastDeliveredSequence (нарушение порядка)
   *
   * @example
   * ```typescript
   * // События ДОЛЖНЫ публиковаться в порядке возрастания sequenceNumber
   * replayBus.publish({ sequenceNumber: 1, ... }); // OK
   * replayBus.publish({ sequenceNumber: 2, ... }); // OK
   * replayBus.publish({ sequenceNumber: 1, ... }); // ОШИБКА: нарушение порядка
   *
   * // Reentrancy запрещена
   * replayBus.subscribe('EventA', () => {
   *   replayBus.publish({ sequenceNumber: 2, ... }); // ОШИБКА: reentrancy
   * });
   * ```
   */
  public publish<E = any>(envelope: EventEnvelope<E>): void {
    // Защита от reentrancy: запрет publish() из handler во время доставки
    // Гарантирует детерминированный replay (handlers НЕ ДОЛЖНЫ публиковать новые события)
    if (this.isDelivering) {
      throw new Error(
        `[SequencedEventBus] Обнаружен reentrancy: publish() вызван из handler. ` +
        `Handlers НЕ ДОЛЖНЫ публиковать новые события во время replay (нарушает детерминизм). ` +
        `(envelope: ${envelope.id}, type: ${envelope.type})`
      );
    }

    // sequenceNumber ОБЯЗАТЕЛЕН для replay
    if (envelope.sequenceNumber === undefined) {
      throw new Error(`[SequencedEventBus] sequenceNumber обязателен для envelope ${envelope.id} (type: ${envelope.type})`);
    }

    // Валидация строгого порядка: sequenceNumber должен быть > lastDeliveredSequence
    // Гарантирует детерминированный replay (события обрабатываются в порядке sequence)
    if (envelope.sequenceNumber <= this.lastDeliveredSequence) {
      throw new Error(
        `[SequencedEventBus] Нарушение порядка: sequenceNumber ${envelope.sequenceNumber} <= последний доставленный ${this.lastDeliveredSequence}. ` +
        `События должны публиковаться в строго возрастающем порядке sequenceNumber. (envelope: ${envelope.id}, type: ${envelope.type})`
      );
    }

    // Синхронная доставка с защитой от reentrancy
    this.isDelivering = true;
    try {
      this.deliverEvent(envelope);
      // Обновляем последний доставленный sequence ПОСЛЕ успешной доставки
      // Если handler выбросит ошибку, sequence не будет помечен как доставленный
      this.lastDeliveredSequence = envelope.sequenceNumber;
    } finally {
      this.isDelivering = false;
    }
  }

  /**
   * Подписаться на события определённого типа
   *
   * @param eventName - Имя события (envelope.type)
   * @param handler - Функция-обработчик
   * @returns Функция отписки
   *
   * @example
   * ```typescript
   * const unsubscribe = replayBus.subscribe('OrderAccepted', (envelope) => {
   *   console.log('Ордер принят:', envelope.payload.orderId);
   * });
   *
   * // Позже: отписка
   * unsubscribe();
   * ```
   */
  public subscribe(eventName: string, handler: EventHandler): () => void {
    if (!this.handlers.has(eventName)) {
      this.handlers.set(eventName, []);
    }

    const handlers = this.handlers.get(eventName)!;
    handlers.push(handler);

    // Возвращаем функцию отписки
    return () => {
      const index = handlers.indexOf(handler);
      if (index !== -1) {
        handlers.splice(index, 1);
      }
    };
  }

  /**
   * Подписаться на все события
   *
   * @param handler - Функция-обработчик
   * @returns Функция отписки
   *
   * @example
   * ```typescript
   * const unsubscribe = replayBus.subscribeAll((envelope) => {
   *   console.log('Событие:', envelope.type, 'seq:', envelope.sequenceNumber);
   * });
   * ```
   */
  public subscribeAll(handler: EventHandler): () => void {
    this.allHandlers.push(handler);

    // Возвращаем функцию отписки
    return () => {
      const index = this.allHandlers.indexOf(handler);
      if (index !== -1) {
        this.allHandlers.splice(index, 1);
      }
    };
  }

  /**
   * Получить количество подписчиков на событие
   *
   * @param eventName - Имя события
   * @returns Количество подписчиков
   */
  public getSubscriberCount(eventName: string): number {
    return this.handlers.get(eventName)?.length || 0;
  }

  /**
   * Получить общее количество подписчиков на все события
   *
   * @returns Количество подписчиков на все события
   */
  public getAllSubscriberCount(): number {
    return this.allHandlers.length;
  }

  /**
   * Получить последний доставленный sequenceNumber
   *
   * @returns Последний доставленный sequenceNumber (-1 если ещё ничего не доставлено)
   *
   * @remarks
   * Полезно для диагностики и проверки состояния replay.
   */
  public getLastDeliveredSequence(): number {
    return this.lastDeliveredSequence;
  }

  /**
   * Доставляет событие подписчикам (синхронно)
   *
   * @param envelope - EventEnvelope для доставки
   *
   * @remarks
   * Синхронная доставка (для детерминированного replay)
   * - БЕЗ try/catch (для детерминизма - ошибка должна прервать replay)
   * - Порядок: специфичные handlers → handlers на все события
   */
  private deliverEvent(envelope: EventEnvelope<any>): void {
    const eventName = envelope.type;

    // Доставка специфичным handlers
    const specificHandlers = this.handlers.get(eventName);
    if (specificHandlers) {
      for (const handler of specificHandlers) {
        // Синхронно (БЕЗ try/catch для детерминизма)
        handler(envelope);
      }
    }

    // Доставка handlers на все события
    for (const handler of this.allHandlers) {
      handler(envelope);
    }
  }

  /**
   * Очищает все подписки и сбрасывает состояние (для тестов)
   *
   * @remarks
   * Используется в тестах для cleanup между тестами.
   * Сбрасывает lastDeliveredSequence в -1 и isDelivering в false.
   */
  public clear(): void {
    this.handlers.clear();
    this.allHandlers.length = 0;
    this.lastDeliveredSequence = -1;
    this.isDelivering = false;
  }
}