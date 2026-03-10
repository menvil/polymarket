/**
 * Ledger — in-memory бухгалтерская книга (append-only)
 *
 * @remarks
 * Ledger — это append-only хранилище LedgerEntry записей и единственный
 * источник истины (single source of truth) для учёта балансов.
 *
 * ### Архитектура:
 * ```
 * Fill (исполнение)
 *   │
 *   ▼  FillLedgerAdapter
 * LedgerEntry[] (атомарные записи)
 *   │
 *   ▼  Ledger.append()
 * Ledger (in-memory хранилище)
 *   │
 *   ▼  getBalance / getAllBalances / replay
 * Portfolio / Position / PnL (проекции)
 * ```
 *
 * ### Принципы:
 * - append-only: записи только добавляются, никогда не удаляются
 * - In-memory: Ledger — доменный объект без зависимостей от инфраструктуры
 * - Repository — задача инфраструктурного слоя (персистентность)
 * - Projection: Portfolio и Position вычисляются через replay
 *
 * ### Replay:
 * replay() возвращает записи отсортированные по timestamp — удобно для
 * пошагового воспроизведения истории аккаунта.
 *
 * @example
 * ```typescript
 * const ledger = new Ledger();
 *
 * // Добавить записи из Fill
 * const entries = FillLedgerAdapter.toLedgerEntries(fill);
 * ledger.append(entries);
 *
 * // Получить баланс USDC по аккаунту
 * const usdcBalance = ledger.getBalance(accountId, AssetIdHelpers.USDC);
 * console.log(usdcBalance.toNumber()); // -32.52 (после BUY)
 *
 * // Получить все балансы
 * const balances = ledger.getAllBalances(accountId);
 * // Map { 'CURRENCY:USDC' => -32.52, 'OUTCOME_TOKEN:...' => +50 }
 * ```
 */

import type { AccountId, AssetId } from '@polymarket/ids';
import { accountIdToString, assetIdToString } from '@polymarket/ids';
import Decimal from 'decimal.js';
import { LedgerEntry } from './LedgerEntry.js';

/**
 * Фильтр для getEntries()
 *
 * @remarks
 * Оба поля опциональны. Если не указаны — возвращаются все записи.
 */
export interface LedgerFilter {
  /** Фильтровать по аккаунту */
  readonly accountId?: AccountId;
  /** Фильтровать по активу */
  readonly asset?: AssetId;
}

/**
 * Ledger — in-memory бухгалтерская книга (append-only)
 *
 * @remarks
 * Domain-layer объект. Не знает о персистентности.
 * Для хранения используйте LedgerRepository (infrastructure layer).
 */
export class Ledger {
  private readonly _entries: LedgerEntry[] = [];

  /**
   * Добавляет записи в Ledger (append-only)
   *
   * @param entries - Массив записей для добавления
   *
   * @remarks
   * Записи добавляются в порядке передачи. Для правильной хронологии
   * используйте replay() который сортирует по timestamp.
   *
   * @example
   * ```typescript
   * const entries = FillLedgerAdapter.toLedgerEntries(fill);
   * ledger.append(entries);
   * ```
   */
  public append(entries: LedgerEntry[]): void {
    for (const entry of entries) {
      this._entries.push(entry);
    }
  }

  /**
   * Возвращает записи с опциональной фильтрацией
   *
   * @param filter - Опциональный фильтр по accountId и/или asset
   * @returns Readonly массив записей
   *
   * @remarks
   * Возвращает записи в порядке добавления (не сортированные).
   * Для хронологического порядка используйте replay().
   *
   * @example
   * ```typescript
   * // Все записи
   * const all = ledger.getEntries();
   *
   * // По аккаунту
   * const byAccount = ledger.getEntries({ accountId });
   *
   * // По аккаунту и активу
   * const byAccountAndAsset = ledger.getEntries({ accountId, asset: AssetIdHelpers.USDC });
   * ```
   */
  public getEntries(filter?: LedgerFilter): readonly LedgerEntry[] {
    // Возвращаем копию чтобы внешний код не мог мутировать внутренний массив
    let result: readonly LedgerEntry[] = [...this._entries];

    if (filter?.accountId !== undefined) {
      const accountStr = accountIdToString(filter.accountId);
      result = result.filter(
        (e) => accountIdToString(e.accountId) === accountStr
      );
    }

    if (filter?.asset !== undefined) {
      const assetStr = assetIdToString(filter.asset);
      result = result.filter(
        (e) => assetIdToString(e.balanceDelta.asset) === assetStr
      );
    }

    return result;
  }

  /**
   * Вычисляет текущий баланс актива для аккаунта
   *
   * @param accountId - ID аккаунта
   * @param asset - ID актива
   * @returns Знаковый баланс (Decimal)
   *
   * @remarks
   * Баланс = сумма всех balanceDelta.amount по данному аккаунту и активу.
   * - Положительный → актив присутствует на балансе
   * - Отрицательный → технически невозможно при корректных Fill (долг)
   * - Нулевой → позиция/баланс закрыты
   *
   * @example
   * ```typescript
   * // После BUY UP 10 @ 0.62, fee 0.02 USDC:
   * const usdcBalance = ledger.getBalance(accountId, AssetIdHelpers.USDC);
   * console.log(usdcBalance.toNumber()); // -6.22
   * const upBalance = ledger.getBalance(accountId, upTokenId);
   * console.log(upBalance.toNumber()); // 10
   * ```
   */
  public getBalance(accountId: AccountId, asset: AssetId): Decimal {
    return this.getEntries({ accountId, asset }).reduce(
      (acc, e) => acc.plus(e.balanceDelta.amount.value()),
      new Decimal(0)
    );
  }

  /**
   * Вычисляет все балансы аккаунта по всем активам
   *
   * @param accountId - ID аккаунта
   * @returns Map с ключом = assetIdToString(asset) и значением = баланс (Decimal)
   *
   * @remarks
   * Включает все активы с ненулевым балансом.
   * Ключ — строковое представление AssetId (например "CURRENCY:USDC").
   * Благодаря инварианту LedgerEntry (amount != 0), суммы всегда ненулевые
   * пока их не скомпенсируют обратные операции.
   *
   * @example
   * ```typescript
   * const balances = ledger.getAllBalances(accountId);
   * for (const [assetStr, balance] of balances) {
   *   console.log(assetStr, balance.toNumber());
   * }
   * ```
   */
  public getAllBalances(accountId: AccountId): Map<string, Decimal> {
    const entries = this.getEntries({ accountId });
    const balances = new Map<string, Decimal>();

    for (const entry of entries) {
      const key = assetIdToString(entry.balanceDelta.asset);
      const current = balances.get(key) ?? new Decimal(0);
      balances.set(key, current.plus(entry.balanceDelta.amount.value()));
    }

    // Фильтруем нулевые балансы — могут появиться при взаимной компенсации дебета/кредита
    for (const [key, balance] of balances) {
      if (balance.isZero()) balances.delete(key);
    }

    return balances;
  }

  /**
   * Возвращает записи аккаунта отсортированные по timestamp (хронологически)
   *
   * @param accountId - ID аккаунта
   * @returns Readonly массив записей в хронологическом порядке
   *
   * @remarks
   * Удобен для пошагового воспроизведения истории исполнений аккаунта.
   * При одинаковом timestamp сохраняется исходный порядок добавления (stable sort).
   *
   * @example
   * ```typescript
   * const history = ledger.replay(accountId);
   * for (const entry of history) {
   *   console.log(entry.timestamp.toNumber(), entry.type, entry.balanceDelta.amount.toNumber());
   * }
   * ```
   */
  public replay(accountId: AccountId): readonly LedgerEntry[] {
    return [...this.getEntries({ accountId })].sort(
      (a, b) => a.timestamp.toNumber() - b.timestamp.toNumber()
    );
  }
}
