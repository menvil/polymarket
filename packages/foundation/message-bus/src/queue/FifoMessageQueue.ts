/**
 * FIFO-очередь с amortized O(1) enqueue/dequeue — без `Array.shift()` на hot path.
 *
 * @remarks
 * Внутренняя деталь реализации MessageBus (не входит в публичный API пакета).
 *
 * ### Устройство
 * Backing array + head-индекс: `dequeue()` не сдвигает элементы (как это делает
 * `Array.shift()` за O(n)), а продвигает `_head` и освобождает прочитанный слот
 * (`undefined`), чтобы обработанные сообщения не удерживались от GC.
 *
 * ### Compaction
 * Прочитанный prefix периодически отрезается: когда `_head` достиг порога
 * {@link COMPACTION_MIN_HEAD} и составляет не менее половины backing array,
 * массив пересоздаётся через `slice(_head)`. Стоимость compaction O(size)
 * амортизируется по O(1) на операцию, а память не растёт бесконечно при
 * длительном потоке сообщений.
 *
 * Это НЕ универсальная collection-библиотека: ровно та FIFO-семантика, которая
 * нужна движку доставки. Очередь не предназначена для хранения `undefined`
 * как значения (используется как маркер освобождённого слота).
 */

/** Минимальный consumed prefix, при котором рассматривается compaction. */
const COMPACTION_MIN_HEAD = 1024;

/**
 * Bounded-неограниченная FIFO-очередь (лимиты применяет вызывающий — MessageBus).
 *
 * @typeParam T - Тип элементов; `undefined` в качестве элемента не поддерживается
 *
 * @example
 * ```typescript
 * const queue = new FifoMessageQueue<string>();
 * queue.enqueue('a');
 * queue.enqueueMany(['b', 'c']);
 * queue.dequeue(); // 'a'
 * queue.size;      // 2
 * ```
 */
export class FifoMessageQueue<T> {
  private _items: Array<T | undefined> = [];
  private _head = 0;

  /** Количество ожидающих элементов. */
  public get size(): number {
    return this._items.length - this._head;
  }

  /**
   * Добавляет элемент в хвост очереди.
   *
   * @param item - Элемент
   */
  public enqueue(item: T): void {
    this._items.push(item);
  }

  /**
   * Добавляет элементы в хвост очереди с сохранением их порядка.
   *
   * @param items - Элементы (порядок массива = порядок извлечения)
   *
   * @remarks
   * Поэлементный `push` вместо spread — spread ограничен максимальным числом
   * аргументов вызова и опасен для больших batch'ей.
   */
  public enqueueMany(items: readonly T[]): void {
    for (const item of items) {
      this._items.push(item);
    }
  }

  /**
   * Извлекает элемент из головы очереди.
   *
   * @returns Головной элемент, либо `undefined` если очередь пуста
   */
  public dequeue(): T | undefined {
    if (this._head >= this._items.length) {
      return undefined;
    }
    const item = this._items[this._head] as T;
    // Освобождаем слот — прочитанный элемент не должен удерживаться от GC
    this._items[this._head] = undefined;
    this._head++;
    this._maybeCompact();
    return item;
  }

  /** Полностью очищает очередь и backing array. */
  public clear(): void {
    this._items = [];
    this._head = 0;
  }

  /**
   * Отрезает прочитанный prefix, когда он достаточно велик.
   *
   * @remarks
   * Условие двойное: prefix ≥ {@link COMPACTION_MIN_HEAD} (не дёргать `slice` на
   * маленьких очередях) И prefix ≥ половины backing array (амортизация O(1):
   * между compaction'ами происходит не меньше операций, чем стоит сам `slice`).
   */
  private _maybeCompact(): void {
    if (this._head >= COMPACTION_MIN_HEAD && this._head * 2 >= this._items.length) {
      this._items = this._items.slice(this._head);
      this._head = 0;
    }
  }
}
