/**
 * Stub для ConstraintsObservationStore.
 *
 * @remarks
 * INTERNAL STUB — используется ErrorClassifier до реализации Phase 1 domain services.
 */

/** Тип нарушения ограничений рынка */
export interface ConstraintViolation {
  type: 'MIN_SIZE' | 'MAX_SIZE' | 'MIN_VALUE' | 'TICK_SIZE' | 'PRICE_TICK' | 'UNKNOWN';
  constraint: string;
  actual?: number;
  required?: number;
}
