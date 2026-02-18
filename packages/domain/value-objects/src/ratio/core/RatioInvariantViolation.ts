/**
 * Исключение при нарушении инвариантов Ratio
 *
 * @remarks
 * Бросается только Core слоем (Ratio.of())
 * Facade слой (RatioService) ловит и оборачивает в InvalidRatioError
 */
import { RatioErrorReason } from '../errors/RatioErrorReason.js';

export class RatioInvariantViolation extends Error {
  public readonly reason: RatioErrorReason;

  constructor(message: string, reason: RatioErrorReason) {
    super(message);
    this.name = 'RatioInvariantViolation';
    this.reason = reason;
    Object.setPrototypeOf(this, RatioInvariantViolation.prototype);
  }
}
