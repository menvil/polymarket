import { type Result, Err } from '@polymarket/result';
import { InvalidSpreadError, ErrorSource } from '@polymarket/errors';
import { Spread } from '../core/Spread.js';
import { SpreadService } from '../facade/SpreadService.js';
import { SpreadErrorReason } from '../core/SpreadErrorReason.js';

/**
 * DTO для сериализации Spread
 */
export interface SpreadDTO {
  /**
   * Bid price
   */
  bid: number;

  /**
   * Ask price
   */
  ask: number;
}

/**
 * Сериализатор для Spread
 *
 * @remarks
 * Отвечает за преобразование между Spread и JSON.
 * Отделяет технические детали сериализации от domain логики.
 *
 * @example
 * ```typescript
 * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
 *
 * // Serialize
 * const dto = SpreadSerializer.toDTO(spread);
 * console.log(dto); // { bid: 0.48, ask: 0.52 }
 *
 * // Deserialize
 * const result = SpreadSerializer.fromDTO(dto);
 * if (result.ok) {
 *   console.log(result.value.width());
 * }
 * ```
 */
export class SpreadSerializer {
  private static readonly SERVICE_NAME = 'SpreadSerializer';
  /**
   * Сериализовать Spread в DTO
   *
   * @param spread - Spread для сериализации
   * @returns DTO объект
   */
  public static toDTO(spread: Spread): SpreadDTO {
    return {
      bid: spread.bid().value().toNumber(),
      ask: spread.ask().value().toNumber(),
    };
  }

  /**
   * Десериализовать Spread из DTO
   *
   * @param dto - DTO объект
   * @returns Result со Spread или InvalidSpreadError
   */
  public static fromDTO(dto: SpreadDTO): Result<Spread, InvalidSpreadError> {
    // Валидация DTO структуры
    if (typeof dto !== 'object' || dto === null) {
      return Err(
        new InvalidSpreadError(
          'DTO must be an object',
          {
            context: {
              source: ErrorSource.PARSING,
              service: SpreadSerializer.SERVICE_NAME,
              op: 'fromDTO',
              dto: String(dto),
              reason: SpreadErrorReason.INVALID_DTO
            }
          }
        )
      );
    }

    if (typeof dto.bid !== 'number' || typeof dto.ask !== 'number') {
      return Err(
        new InvalidSpreadError(
          'DTO must have bid and ask as numbers',
          {
            context: {
              source: ErrorSource.PARSING,
              service: SpreadSerializer.SERVICE_NAME,
              op: 'fromDTO',
              dto: JSON.stringify(dto),
              reason: SpreadErrorReason.INVALID_DTO
            }
          }
        )
      );
    }

    return SpreadService.fromValues(dto.bid, dto.ask);
  }

  /**
   * Сериализовать в JSON строку
   *
   * @param spread - Spread для сериализации
   * @returns JSON строка
   */
  public static toJSON(spread: Spread): string {
    return JSON.stringify(SpreadSerializer.toDTO(spread));
  }

  /**
   * Десериализовать из JSON строки
   *
   * @param json - JSON строка
   * @returns Result со Spread или InvalidSpreadError
   */
  public static fromJSON(json: string): Result<Spread, InvalidSpreadError> {
    try {
      const dto = JSON.parse(json) as SpreadDTO;
      return SpreadSerializer.fromDTO(dto);
    } catch (error) {
      return Err(
        new InvalidSpreadError(
          `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          {
            context: {
              source: ErrorSource.PARSING,
              service: SpreadSerializer.SERVICE_NAME,
              op: 'fromJSON',
              json,
              error: error instanceof Error ? error.message : String(error),
              reason: SpreadErrorReason.INVALID_JSON
            }
          }
        )
      );
    }
  }
}
