/**
 * LedgerService — запись Fill в Ledger.
 *
 * @remarks
 * Тонкая обёртка над FillLedgerAdapter + Ledger для использования в use-cases.
 * Отвечает за преобразование Fill → LedgerEntry[] и добавление в Ledger.
 *
 * ### Архитектура:
 * ```
 * Fill → FillLedgerAdapter.toLedgerEntries() → LedgerEntry[] → Ledger.append()
 * ```
 *
 * LedgerService хранит Ledger как внутреннее состояние (in-memory).
 * Для персистентности Ledger должен быть сохранён через инфраструктурный слой.
 *
 * @example
 * ```typescript
 * const service = new LedgerService(logger);
 * service.recordFill(fill);
 * const balance = service.ledger.getBalance(accountId, AssetIdHelpers.USDC);
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import { FillLedgerAdapter, Ledger } from '@polymarket/ledger';
import type { Fill } from '@polymarket/fill';

/** Сервис записи Fill в Ledger */
export class LedgerService {
  private readonly _logger: ILogger;

  /** Внутренний Ledger (in-memory append-only книга) */
  public readonly ledger: Ledger;

  /** Множество уже записанных fill ID для предотвращения дублирования */
  private readonly _recordedFillIds = new Set<string>();

  /**
   * @param logger - Logger (дочерний контекст 'LedgerService' добавляется автоматически)
   * @param ledger - Опциональный начальный Ledger (по умолчанию создаётся новый)
   */
  constructor(
    logger: ILogger,
    ledger?: Ledger,
  ) {
    this._logger = logger.child({ component: 'LedgerService' });
    this.ledger = ledger ?? new Ledger();
  }

  /**
   * Записывает Fill в Ledger с проверкой идемпотентности.
   *
   * @param fill - Исполнение ордера для записи
   *
   * @remarks
   * Если Fill с таким ID уже был записан — логирует debug и возвращает без изменений.
   *
   * Использует FillLedgerAdapter.toLedgerEntries() для генерации записей:
   * - POSITION_DELTA: изменение позиции в токенах
   * - CASH_DELTA: изменение денежного баланса в USDC
   * - FEE_DEBIT: списание комиссии (только если fee > 0)
   */
  public recordFill(fill: Fill): void {
    const fillId = String(fill.id);
    if (this._recordedFillIds.has(fillId)) {
      this._logger.debug('Duplicate fill ignored in ledger', { fillId });
      return;
    }
    const entries = FillLedgerAdapter.toLedgerEntries(fill);
    this.ledger.append(entries);
    this._recordedFillIds.add(fillId);
    this._logger.debug('Fill recorded in ledger', {
      fillId,
      orderId: String(fill.orderId),
      entriesCount: entries.length,
    });
  }
}
