/**
 * Порт генерации Order ID — детерминизм в replay/backtest.
 *
 * @remarks
 * ### Зачем:
 * Прямой `randomUUID()` в `ExecutionEngine` делал последовательность
 * clientOrderId недетерминированной: один и тот же replay давал разные ID.
 * Порт разделяет:
 * - production: {@link UuidOrderIdGenerator} (crypto randomUUID);
 * - replay/backtest/тесты: {@link SequentialOrderIdGenerator}
 *   (детерминированная монотонная последовательность).
 *
 * @example
 * ```typescript
 * const generator: IOrderIdGenerator = new SequentialOrderIdGenerator('bt');
 * generator.next(); // 'bt-1'
 * generator.next(); // 'bt-2'
 * ```
 */
import { randomUUID } from 'node:crypto';
import type { OrderId } from '@polymarket/ids';
import { asOrderId } from '@polymarket/ids';

/**
 * Порт генерации клиентских Order ID.
 */
export interface IOrderIdGenerator {
  /**
   * Возвращает следующий уникальный OrderId.
   *
   * @returns Новый OrderId (уникален в рамках процесса/replay)
   */
  next(): OrderId;
}

/**
 * Production-адаптер: UUID v4.
 *
 * @remarks
 * `asOrderId(randomUUID())` всегда валиден (непустая строка без control-символов).
 */
export class UuidOrderIdGenerator implements IOrderIdGenerator {
  public next(): OrderId {
    return asOrderId(randomUUID())!;
  }
}

/**
 * Детерминированный адаптер: монотонная последовательность `{prefix}-{n}`.
 *
 * @remarks
 * Для replay/backtest: повтор одного replay с одинаковыми входами даёт
 * одинаковую последовательность order ID.
 *
 * @example
 * ```typescript
 * const gen = new SequentialOrderIdGenerator('replay');
 * gen.next(); // 'replay-1'
 * ```
 */
export class SequentialOrderIdGenerator implements IOrderIdGenerator {
  private _counter = 0;

  /**
   * @param _prefix - Префикс ID (по умолчанию 'order')
   */
  constructor(private readonly _prefix: string = 'order') {}

  public next(): OrderId {
    this._counter += 1;
    return asOrderId(`${this._prefix}-${this._counter}`)!;
  }
}
