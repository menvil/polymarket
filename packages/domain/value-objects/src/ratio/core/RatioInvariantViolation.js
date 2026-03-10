export class RatioInvariantViolation extends Error {
    reason;
    constructor(message, reason) {
        super(message);
        this.name = 'RatioInvariantViolation';
        this.reason = reason;
        Object.setPrototypeOf(this, RatioInvariantViolation.prototype);
    }
}
//# sourceMappingURL=RatioInvariantViolation.js.map