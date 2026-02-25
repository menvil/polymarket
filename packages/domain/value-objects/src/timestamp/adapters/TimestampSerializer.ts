/**
 * Serializer для Timestamp
 *
 * @remarks
 * Преобразует Timestamp в/из JSON (epoch milliseconds as number).
 *
 * @example
 * ```typescript
 * import { TimestampSerializer } from '@polymarket/value-objects';
 *
 * const ts = Timestamp.now();
 * const json = TimestampSerializer.toJSON(ts); // number (epoch ms)
 *
 * const result = TimestampSerializer.fromJSON(json);
 * if (result.ok) {
 *   console.log(result.value.toISO());
 * }
 * ```
 */

import { Result, Ok } from '@polymarket/result';
import { ValidationError, wrapOp } from '@polymarket/errors';
import { Timestamp } from '../core/Timestamp.js';
import { TimestampService } from '../facade/TimestampService.js';
import { TimestampErrorReason } from '../errors/TimestampErrorReason.js';

export class TimestampSerializer {
  /**
   * Сериализовать Timestamp в JSON (epoch milliseconds)
   *
   * @param timestamp - Timestamp для сериализации
   * @returns Epoch milliseconds как number
   *
   * @example
   * ```typescript
   * const ts = Timestamp.now();
   * const json = TimestampSerializer.toJSON(ts);
   * console.log(json); // 1705318200000
   * ```
   */
  public static toJSON(timestamp: Timestamp): number {
    return timestamp.toNumber();
  }

  /**
   * Десериализовать Timestamp из JSON (epoch milliseconds)
   *
   * @param json - Epoch milliseconds как number
   * @returns Result<Timestamp, ValidationError>
   *
   * @example
   * ```typescript
   * const result = TimestampSerializer.fromJSON(1609459200000);
   * if (result.ok) {
   *   console.log(result.value.toISO()); // "2021-01-01T00:00:00.000Z"
   * }
   * ```
   */
  public static fromJSON(json: number): Result<Timestamp, ValidationError> {
    // Делегируем в TimestampService для валидации и создания
    return TimestampService.fromEpochMs(json);
  }

  /**
   * Десериализовать Timestamp из unknown (с проверкой типа)
   *
   * @param json - Значение unknown (должно быть number)
   * @returns Result<Timestamp, ValidationError>
   *
   * @remarks
   * Проверяет что json является number перед десериализацией.
   * Используется для парсинга JSON из ненадёжных источников.
   *
   * @example
   * ```typescript
   * const parsed: unknown = JSON.parse('{"timestamp": 1609459200000}');
   * const result = TimestampSerializer.fromUnknown((parsed as any).timestamp);
   * if (result.ok) {
   *   console.log(result.value.toISO());
   * }
   * ```
   */
  public static fromUnknown(json: unknown): Result<Timestamp, ValidationError> {
    return wrapOp(
      'TimestampSerializer',
      'fromUnknown',
      { value: json, type: typeof json },
      () => {
        if (typeof json !== 'number') {
          throw new ValidationError('Timestamp must be number', {
            context: {
              field: 'timestamp',
              value: json,
              type: typeof json,
              reason: TimestampErrorReason.NOT_FINITE,
            },
          });
        }

        // Используем TimestampService для валидации
        const result = TimestampService.fromEpochMs(json);
        if (!result.ok) {
          throw result.error;
        }
        return Ok(result.value);
      },
      ValidationError
    );
  }
}
