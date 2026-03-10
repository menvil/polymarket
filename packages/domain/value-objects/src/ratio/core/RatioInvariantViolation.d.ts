/**
 * Исключение при нарушении инвариантов Ratio
 *
 * @remarks
 * Бросается только Core слоем (Ratio.of())
 * Facade слой (RatioService) ловит и оборачивает в InvalidRatioError
 */
import { RatioErrorReason } from '../errors/RatioErrorReason.js';
export declare class RatioInvariantViolation extends Error {
    readonly reason: RatioErrorReason;
    constructor(message: string, reason: RatioErrorReason);
}
//# sourceMappingURL=RatioInvariantViolation.d.ts.map