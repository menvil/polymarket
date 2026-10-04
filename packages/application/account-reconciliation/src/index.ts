/**
 * `@polymarket/account-reconciliation` — authoritative-сверка торгового аккаунта.
 *
 * @remarks
 * Получает authoritative-состояние аккаунта от внешнего источника, сравнивает
 * его с локальным `AccountHotState` и при расхождении корректирует локальное
 * состояние через ТУ ЖЕ canonical-шину:
 *
 * ```text
 * authoritative account source      IAccountReconciliationSource
 *         ↓
 * AccountReconciler                 один проход: снимок + expectedAccountVersion
 *         ↓
 * TRADING_ACCOUNT_RECONCILED
 *         ↓
 * IEventBus
 *         ↓
 * AccountStateProjector             единственный писатель, CAS + одна мутация
 *         ↓
 * AccountHotState
 * ```
 *
 * Прямых мутаций `AccountHotState`, третьей шины и отдельного reconciliation
 * bus нет: сверка видит состояние только через read-only view.
 *
 * ### Что входит
 *
 * - {@link IAccountReconciliationSource} — узкий порт источника, только
 *   canonical `Portfolio`/`Order`/`Fill`;
 * - {@link AccountReconciler} — один проход сверки;
 * - {@link AccountReconciliationCoordinator} — per-account single-flight с
 *   coalescing, свежий проход при конфликте версий, health;
 * - типизированные ошибки с `failureCode`;
 * - {@link IAccountVenueStateSource} и `Authoritative*State` — target
 *   production-граница: authoritative ТЕКУЩЕЕ состояние аккаунта на площадке
 *   в пределах текущего торгового контура (account-wide collateral и живые
 *   заявки, балансы активов scope, свежий хвост сделок). Сверка его
 *   пока НЕ вызывает: она работает через transitional
 *   `IAccountReconciliationSource`, а переход — отдельный миграционный шаг.
 *
 * ### Чего нет
 *
 * Адаптера Polymarket, HTTP, таймеров и каденций, startup wiring,
 * персистентного health. Пакет от инфраструктуры не зависит.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * const reconciler = AccountReconciler.create({
 *   source,
 *   eventBus,
 *   accountState: projector.state(),
 *   metadata,
 * });
 * const coordinator = AccountReconciliationCoordinator.create({ reconciler, clock });
 *
 * await coordinator.request(venueId, accountId, 'STARTUP');
 * coordinator.health().get(venueId, accountId).status; // → 'READY'
 * ```
 */
export type { IAccountReconciliationSource } from './IAccountReconciliationSource.js';
export type { IAccountVenueStateSource } from './IAccountVenueStateSource.js';
export type {
  AccountVenueStateScope,
  AuthoritativeAccountState,
  AuthoritativeAssetBalance,
  AuthoritativeFillMetadata,
  AuthoritativeFillState,
  AuthoritativeOpenOrderState,
  AuthoritativeOpenOrderStatus,
  AuthoritativeOrderState,
  AuthoritativeOrderStatus,
  AuthoritativeOutcomeAssetId,
} from './AuthoritativeAccountState.js';
export {
  AccountReconciler,
  type AccountReconcilerDependencies,
  type AccountReconciliationPass,
  type AccountReconciliationPassResult,
} from './AccountReconciler.js';
export {
  AccountReconciliationCoordinator,
  DEFAULT_MAX_CONSECUTIVE_VERSION_CONFLICTS,
  type AccountReconciliationCoordinatorOptions,
} from './AccountReconciliationCoordinator.js';
export type {
  AccountReconciliationHealth,
  AccountReconciliationHealthStatus,
  AccountReconciliationHealthView,
} from './health.js';
export type { AccountReconciliationTrigger } from './trigger.js';
export {
  AccountReconciliationPublishError,
  AccountReconciliationSourceError,
  AccountReconciliationUnresolvedOrderError,
  AccountReconciliationValidationError,
  type AccountReconciliationError,
  type AccountReconciliationFailure,
  type AccountReconciliationFailureCode,
  type AccountReconciliationSourceOperation,
  type AccountVenueStateSourceOperation,
  type AccountReconciliationValidationReason,
} from './errors.js';
/**
 * Конфликт версий определён в `@polymarket/account-state` (CAS проверяет
 * состояние) и реэкспортируется, чтобы потребитель сверки мог распознать его
 * по классу, не завися от пакета состояния напрямую.
 */
export { AccountReconciliationVersionConflictError } from '@polymarket/account-state';
