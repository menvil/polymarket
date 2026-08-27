/**
 * Исключение при нарушении инвариантов AssetPrice.
 *
 * @remarks
 * Бросается только Core-слоем (`AssetPrice.of()`).
 * Facade-слой (`AssetPriceService`) ловит и оборачивает в
 * `InvalidAssetPriceError`, сохраняя типизированную `reason`.
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
import { AssetPriceErrorReason } from '../errors/AssetPriceErrorReason.js';

export class AssetPriceInvariantViolation extends Error {
  /** Стабильный маркер для `isCoreInvariantViolation` (см. докблок модуля). */
  public readonly kind = 'INVARIANT_VIOLATION';

  public readonly reason: AssetPriceErrorReason;

  constructor(message: string, reason: AssetPriceErrorReason) {
    super(message);
    this.name = 'AssetPriceInvariantViolation';
    this.reason = reason;
    Object.setPrototypeOf(this, AssetPriceInvariantViolation.prototype);
  }
}
