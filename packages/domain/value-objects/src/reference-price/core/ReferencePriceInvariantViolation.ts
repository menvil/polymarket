/**
 * Исключение при нарушении инвариантов ReferencePrice.
 *
 * @remarks
 * Бросается только Core-слоем (`ReferencePrice.of()`).
 * Facade-слой (`ReferencePriceService`) ловит и оборачивает в
 * `InvalidReferencePriceError`, сохраняя типизированную `reason`.
 *
 * ### Маркер `kind`
 *
 * `isCoreInvariantViolation` (`@polymarket/errors`) распознаёт нарушения
 * инвариантов двумя способами: по СТАБИЛЬНОМУ маркеру
 * `kind === 'INVARIANT_VIOLATION'` (рекомендуемый) и по списку имён классов
 * (существует «для обратной совместимости» — там перечислены VO, созданные
 * до появления маркера). Новый VO использует маркер: дописывать имя в
 * legacy-список означало бы расширять механизм, который сам себя объявил
 * устаревшим, и заставлять foundation знать про каждый новый доменный тип.
 */
import { ReferencePriceErrorReason } from '../errors/ReferencePriceErrorReason.js';

export class ReferencePriceInvariantViolation extends Error {
  /** Стабильный маркер для `isCoreInvariantViolation` (см. докблок модуля). */
  public readonly kind = 'INVARIANT_VIOLATION';

  public readonly reason: ReferencePriceErrorReason;

  constructor(message: string, reason: ReferencePriceErrorReason) {
    super(message);
    this.name = 'ReferencePriceInvariantViolation';
    this.reason = reason;
    Object.setPrototypeOf(this, ReferencePriceInvariantViolation.prototype);
  }
}
