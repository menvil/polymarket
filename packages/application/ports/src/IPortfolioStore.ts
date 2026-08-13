/**
 * Порт: хранилище Portfolio агрегата с CAS-защитой от гонки состояний.
 *
 * @remarks
 * ### Почему нужен CAS (Compare-And-Swap):
 * ProcessFillUseCase и CancelOrderUseCase могут работать concurrently:
 * ```
 * ProcessFill: читает Portfolio v1 → ...await... → пытается сохранить v2
 * CancelOrder: читает Portfolio v1 → ...await... → пытается сохранить v2
 * ```
 * Без CAS один из них молча перезапишет изменения другого.
 *
 * ### Как работает:
 * `save()` проверяет: `version в store === expectedVersion?`
 * - Если да → сохраняет и увеличивает версию
 * - Если нет → возвращает `VersionConflictError` → caller делает re-read и retry
 *
 * @example
 * ```typescript
 * const portfolio = store.get(accountId);
 * const expectedVersion = portfolio?.version ?? 0;
 * // ... мутация portfolio ...
 * const result = store.save(updatedPortfolio, expectedVersion);
 * if (!result.ok) {
 *   // VersionConflictError — повторить операцию
 * }
 * ```
 */
import type { Portfolio } from '@polymarket/portfolio';
import type { AccountId } from '@polymarket/ids';
import type { Result } from '@polymarket/result';
import type { VersionConflictError } from './VersionConflictError.js';

/** Порт CAS-хранилища Portfolio — см. описание модуля выше. */
export interface IPortfolioStore {
  /**
   * Возвращает Portfolio по ID аккаунта или undefined.
   *
   * @param accountId - ID аккаунта
   * @returns Portfolio агрегат или undefined
   */
  get(accountId: AccountId): Portfolio | undefined;

  /**
   * Сохраняет Portfolio с CAS-проверкой версии.
   *
   * @param portfolio - Обновлённый Portfolio для сохранения
   * @param expectedVersion - Версия, прочитанная при последнем get()
   * @returns Ok(void) при успехе, Err(VersionConflictError) при конфликте версий
   *
   * @remarks
   * При конфликте caller должен перечитать Portfolio и повторить операцию.
   */
  save(portfolio: Portfolio, expectedVersion: number): Result<void, VersionConflictError>;

  /**
   * Возвращает текущую версию Portfolio для заданного аккаунта.
   *
   * @remarks
   * ОБЯЗАТЕЛЬНЫЙ метод (не опциональный). CAS в `save()` не работает без
   * актуальной версии: `PortfolioService` читает `getVersion()` перед мутацией
   * и передаёт её как `expectedVersion` в `save()`. Раньше метод был опциональным
   * с фолбэком `?? 0` на стороне `PortfolioService` — это давало ложное чувство
   * защиты: если store не реализует версионирование, `expectedVersion` всегда
   * был бы 0, и CAS-проверка молча переставала защищать от concurrent-перезаписи
   * (или наоборот — каждый второй `save()` бился бы в постоянный false-conflict,
   * если store всё же трекает версии внутри себя). Обязательность поля заставляет
   * каждую реализацию `IPortfolioStore` явно решить вопрос версионирования.
   *
   * @param accountId - ID аккаунта
   * @returns Текущая версия (0 если Portfolio не сохранён)
   */
  getVersion(accountId: AccountId): number;
}
