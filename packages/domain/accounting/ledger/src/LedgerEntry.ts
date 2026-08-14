/**
 * LedgerEntry — неизменяемая запись в бухгалтерской книге
 *
 * @remarks
 * LedgerEntry — это атомарное изменение баланса актива в результате исполнения.
 *
 * ### Архитектура:
 * Ledger — это append-only источник истины.
 * Portfolio и Position — это проекции (projections) над Ledger.
 *
 * ### Связь с Fill:
 * Каждый Fill разворачивается в 2-3 LedgerEntry через FillLedgerAdapter:
 *
 * ```
 * Fill: BUY YES 10 @ 0.62, fee 0.02 USDC
 *   │
 *   ▼
 * LedgerEntry: POSITION_DELTA  YES   balanceDelta.amount=+10.00
 * LedgerEntry: CASH_DELTA      USDC  balanceDelta.amount=-6.20
 * LedgerEntry: FEE_DEBIT       USDC  balanceDelta.amount=-0.02
 * ```
 *
 * ### Семантика balanceDelta.amount:
 * - Положительный (+) — актив зачислен (credit)
 * - Отрицательный (-) — актив списан (debit)
 *
 * ### Инварианты:
 * 1. balanceDelta.amount != 0 (нет нулевых записей)
 * 2. Тип FEE_DEBIT → amount < 0 (комиссия всегда расход)
 *
 * ### Replay:
 * P&L и позиции вычисляются через replay LedgerEntry по accountId и assetId.
 * Это делает систему устойчивой к out-of-order events и gaps.
 *
 * @example
 * ```typescript
 * // После BUY YES 10 @ 0.62:
 * const result = LedgerEntry.create({
 *   fillId: asFillId('fill-123')!,
 *   accountId: myAccountId,
 *   balanceDelta: { asset: upTokenId, amount: new Decimal('+10') },
 *   type: 'POSITION_DELTA',
 *   timestamp: fillTimestamp,
 * });
 * if (result.ok) {
 *   console.log(result.value.balanceDelta.amount.toNumber()); // 10
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import type { FillId, AccountId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/timestamp';
import type { AssetDelta } from '@polymarket/fill';
import type { LedgerEntryType } from './LedgerEntryType.js';

/**
 * Параметры создания LedgerEntry
 *
 * @remarks
 * Используется в LedgerEntry.create() фабричном методе.
 */
export interface LedgerEntryParams {
  /** ID исполнения, породившего эту запись */
  readonly fillId: FillId;
  /** ID аккаунта, которому принадлежит изменение */
  readonly accountId: AccountId;
  /**
   * Знаковое изменение баланса актива
   * - (+) credit: актив зачислен
   * - (-) debit: актив списан
   */
  readonly balanceDelta: AssetDelta;
  /** Тип экономической операции */
  readonly type: LedgerEntryType;
  /** Время исполнения (из Fill) */
  readonly timestamp: Timestamp;
}

/**
 * LedgerEntry — неизменяемая запись в бухгалтерской книге
 *
 * @remarks
 * Класс с инвариантами. Создаётся через статический фабричный метод create().
 * Все поля readonly — запись создаётся один раз и не изменяется.
 */
export class LedgerEntry {
  /** ID исполнения, породившего эту запись */
  public readonly fillId: FillId;
  /** ID аккаунта, которому принадлежит изменение */
  public readonly accountId: AccountId;
  /**
   * Знаковое изменение баланса актива
   * - (+) credit: актив зачислен
   * - (-) debit: актив списан
   */
  public readonly balanceDelta: AssetDelta;
  /** Тип экономической операции */
  public readonly type: LedgerEntryType;
  /** Время исполнения (из Fill) */
  public readonly timestamp: Timestamp;

  /**
   * Приватный конструктор (используйте LedgerEntry.create())
   */
  private constructor(params: LedgerEntryParams) {
    this.fillId = params.fillId;
    this.accountId = params.accountId;
    this.balanceDelta = params.balanceDelta;
    this.type = params.type;
    this.timestamp = params.timestamp;
  }

  /**
   * Создаёт LedgerEntry с валидацией инвариантов
   *
   * @param params - Параметры записи
   * @returns Result<LedgerEntry, ValidationError>
   *
   * @remarks
   * ### Инварианты:
   * 1. balanceDelta.amount != 0 — нет смысла в нулевых записях
   * 2. Тип FEE_DEBIT → balanceDelta.amount < 0 (комиссия всегда расход)
   *
   * @example
   * ```typescript
   * const result = LedgerEntry.create({
   *   fillId: asFillId('fill-123')!,
   *   accountId: myAccountId,
   *   balanceDelta: { asset: upTokenId, amount: new Decimal('+10') },
   *   type: 'POSITION_DELTA',
   *   timestamp: fillTimestamp,
   * });
   * if (result.ok) {
   *   const entry = result.value;
   * }
   * ```
   */
  public static create(params: LedgerEntryParams): Result<LedgerEntry, ValidationError> {
    // Инвариант 1: amount != 0 — нулевые записи не имеют смысла
    if (params.balanceDelta.amount.isZero()) {
      return Err(
        new ValidationError('LedgerEntry balanceDelta.amount must not be zero', {
          context: { type: params.type, fillId: params.fillId },
        })
      );
    }

    // Инвариант 2: FEE_DEBIT → amount < 0 (комиссия всегда расход)
    if (params.type === 'FEE_DEBIT' && !params.balanceDelta.amount.isNegative()) {
      return Err(
        new ValidationError('LedgerEntry of type FEE_DEBIT must have negative balanceDelta.amount', {
          context: { type: params.type, amount: params.balanceDelta.amount.toNumber() },
        })
      );
    }

    return Ok(new LedgerEntry(params));
  }
}
