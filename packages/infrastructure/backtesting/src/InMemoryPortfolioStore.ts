/**
 * InMemoryPortfolioStore — CAS-хранилище Portfolio в памяти для бектестирования.
 *
 * @remarks
 * Реализует интерфейс `IPortfolioStore` с поддержкой Compare-And-Swap (CAS).
 * Используется в `BacktestEngine` как замена Redis/Postgres хранилища.
 *
 * ### CAS-механизм:
 * Каждый Portfolio хранится вместе со счётчиком версии.
 * `save(portfolio, expectedVersion)` проверяет:
 * - Если текущая версия в store === expectedVersion → сохраняет, увеличивает версию на 1.
 * - Если версии не совпадают → возвращает `Err(VersionConflictError)`.
 *
 * В бектесте конкурентных write-конфликтов нет (single-threaded Node.js),
 * поэтому при вызове `save(portfolio, 0)` конфликт возникнет только при
 * явном нарушении протокола.
 *
 * @example
 * ```typescript
 * const store = new InMemoryPortfolioStore();
 *
 * // Первое сохранение: версия 0 (нет существующего)
 * const saveResult = store.save(portfolio, 0);
 * if (!saveResult.ok) {
 *   // VersionConflictError — unexpected в бектесте
 * }
 *
 * const portfolio = store.get(accountId);
 * ```
 */
import type { Portfolio } from '@polymarket/portfolio';
import type { AccountId } from '@polymarket/ids';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import type { IPortfolioStore } from '@polymarket/ports';
import { VersionConflictError } from '@polymarket/ports';

/**
 * Внутренняя запись хранилища: Portfolio + версия.
 */
interface PortfolioRecord {
  readonly portfolio: Portfolio;
  readonly version: number;
}

/**
 * In-memory реализация хранилища Portfolio с CAS-защитой.
 *
 * @remarks
 * Хранит записи в `Map<string, PortfolioRecord>`,
 * где ключ — строковое представление AccountId.
 */
export class InMemoryPortfolioStore implements IPortfolioStore {
  /** Внутреннее хранилище: accountId (строка) → {portfolio, version} */
  private readonly _store = new Map<string, PortfolioRecord>();

  /**
   * Возвращает Portfolio по ID аккаунта или undefined.
   *
   * @param accountId - ID аккаунта
   * @returns Portfolio агрегат или undefined если не найден
   *
   * @example
   * ```typescript
   * const portfolio = store.get(accountId);
   * if (!portfolio) {
   *   // Аккаунт ещё не инициализирован
   * }
   * ```
   */
  public get(accountId: AccountId): Portfolio | undefined {
    return this._store.get(String(accountId))?.portfolio;
  }

  /**
   * Сохраняет Portfolio с CAS-проверкой версии.
   *
   * @remarks
   * Алгоритм:
   * 1. Ищем запись по accountId в store.
   * 2. Определяем текущую версию: если записи нет — 0, иначе record.version.
   * 3. Сравниваем с expectedVersion.
   * 4. Если совпадают → сохраняем с версией (currentVersion + 1).
   * 5. Если нет → возвращаем Err(VersionConflictError).
   *
   * @param portfolio - Обновлённый Portfolio для сохранения
   * @param expectedVersion - Версия, прочитанная при последнем get()
   * @returns Ok(void) при успехе, Err(VersionConflictError) при конфликте версий
   *
   * @example
   * ```typescript
   * const result = store.save(updatedPortfolio, 0);
   * if (!result.ok) {
   *   // Конфликт версий — повторить операцию
   * }
   * ```
   */
  public save(
    portfolio: Portfolio,
    expectedVersion: number,
  ): Result<void, VersionConflictError> {
    const key = String(portfolio.accountId);
    const existing = this._store.get(key);
    const currentVersion = existing?.version ?? 0;

    if (currentVersion !== expectedVersion) {
      return Err(
        new VersionConflictError(key, expectedVersion, currentVersion),
      );
    }

    this._store.set(key, {
      portfolio,
      version: currentVersion + 1,
    });

    return Ok(undefined);
  }

  /**
   * Возвращает текущую версию Portfolio для заданного аккаунта.
   *
   * @remarks
   * Вспомогательный метод для тестовых assertions.
   * Если Portfolio не сохранён — возвращает 0 (начальная версия).
   *
   * @param accountId - ID аккаунта
   * @returns Текущая версия Portfolio
   *
   * @example
   * ```typescript
   * store.save(portfolio, 0);
   * expect(store.getVersion(accountId)).toBe(1);
   * ```
   */
  public getVersion(accountId: AccountId): number {
    return this._store.get(String(accountId))?.version ?? 0;
  }

  /**
   * Очищает хранилище.
   *
   * @remarks
   * Используется в тестах для сброса состояния между тестами.
   *
   * @example
   * ```typescript
   * beforeEach(() => store.clear());
   * ```
   */
  public clear(): void {
    this._store.clear();
  }
}
