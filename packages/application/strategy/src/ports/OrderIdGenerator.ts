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
 * Invariant-ошибка: рантайм произвёл значение, не проходящее `asOrderId()`.
 *
 * @remarks
 * Означает нарушение инварианта адаптера (например, `randomUUID()` начал
 * возвращать что-то помимо RFC4122 UUID) — не ожидаемый в норме путь.
 */
export class OrderIdGeneratorInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderIdGeneratorInvariantError';
  }
}

/**
 * Ошибка конфигурации генератора Order ID (например, невалидный prefix).
 */
export class OrderIdGeneratorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderIdGeneratorConfigError';
  }
}

/**
 * Production-адаптер: UUID v4.
 *
 * @remarks
 * `asOrderId(randomUUID())` всегда валиден (непустая строка без control-символов)
 * — но мы НЕ полагаемся на это молча через non-null assertion: нарушение
 * инварианта (гипотетическая порча `randomUUID()`) бросает явную ошибку
 * вместо сокрытия `undefined` за `!`.
 */
export class UuidOrderIdGenerator implements IOrderIdGenerator {
  public next(): OrderId {
    const raw = randomUUID();
    const id = asOrderId(raw);
    if (id === undefined) {
      throw new OrderIdGeneratorInvariantError(
        `UuidOrderIdGenerator: randomUUID() produced a value rejected by asOrderId(): "${raw}"`,
      );
    }
    return id;
  }
}

/**
 * Детерминированный адаптер: монотонная последовательность `{prefix}-{n}`.
 *
 * @remarks
 * Для replay/backtest: повтор одного replay с одинаковыми входами даёт
 * одинаковую последовательность order ID.
 *
 * Prefix валидируется в constructor (fail-fast конфигурация): пустая строка,
 * whitespace-only и control characters бросают {@link OrderIdGeneratorConfigError}
 * вместо того чтобы молча породить невалидные ID через скрытый non-null
 * assertion в {@link SequentialOrderIdGenerator.next}.
 *
 * @example
 * ```typescript
 * const gen = new SequentialOrderIdGenerator('replay');
 * gen.next(); // 'replay-1'
 * ```
 *
 * @throws {OrderIdGeneratorConfigError} Если `prefix` пуст, состоит только из
 *   пробелов, содержит control characters, либо результирующий `{prefix}-1`
 *   не проходит `asOrderId()`
 */
export class SequentialOrderIdGenerator implements IOrderIdGenerator {
  private _counter = 0;

  /**
   * @param _prefix - Префикс ID (по умолчанию 'order')
   */
  constructor(private readonly _prefix: string = 'order') {
    if (this._prefix.trim().length === 0) {
      throw new OrderIdGeneratorConfigError(
        `SequentialOrderIdGenerator: prefix must be non-empty and not whitespace-only, got ${JSON.stringify(this._prefix)}`,
      );
    }
    // Проверяем именно результирующий ID (а не сырой prefix): control chars,
    // избыточная длина и прочие нарушения asOrderId()-контракта ловятся здесь
    // один раз, а не на каждом вызове next().
    if (asOrderId(`${this._prefix}-1`) === undefined) {
      throw new OrderIdGeneratorConfigError(
        `SequentialOrderIdGenerator: prefix ${JSON.stringify(this._prefix)} produces an invalid OrderId`,
      );
    }
  }

  public next(): OrderId {
    this._counter += 1;
    const id = asOrderId(`${this._prefix}-${this._counter}`);
    if (id === undefined) {
      // Не должно произойти — prefix уже провалидирован в constructor —
      // но next() не молчит за `!`, если инвариант всё же нарушен.
      throw new OrderIdGeneratorInvariantError(
        `SequentialOrderIdGenerator: generated id "${this._prefix}-${this._counter}" rejected by asOrderId()`,
      );
    }
    return id;
  }
}
