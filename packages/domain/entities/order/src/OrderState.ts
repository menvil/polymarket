/**
 * Типы данных Order — только структуры, ноль логики
 *
 * @remarks
 * OrderState — внутреннее представление агрегата (value objects).
 * OrderSnapshot — внешний формат для персистентности и синхронизации с биржей.
 * CreateOrderParams — параметры для создания новой заявки (status всегда PENDING).
 * FillData (входной параметр applyFill) — общий контракт из `@polymarket/fill`.
 */

import type { Price, Quantity, Side, Timestamp } from '@polymarket/value-objects';
import type { AccountId, AssetId, FillId, OrderId, StrategyId } from '@polymarket/ids';

// ─── Status ──────────────────────────────────────────────────────

/** Статус заявки в жизненном цикле — от создания до терминального состояния. */
export type OrderStatus =
  | 'PENDING'
  | 'OPEN'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED';

/** Статусы из которых заявка больше не изменится */
export const TERMINAL_STATUSES = new Set<OrderStatus>([
  'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED',
]);

/** Статусы в которых заявка может принять fill */
export const FILLABLE_STATUSES = new Set<OrderStatus>([
  'OPEN', 'PARTIALLY_FILLED',
]);

/** Внутреннее состояние исполнений заявки */
export interface FillState {
  readonly filledSize: Quantity;
  readonly averagePrice: Price | undefined;
  readonly fillIds: readonly FillId[];
}

// ─── Order state ──────────────────────────────────────────────────

/** Внутренние данные агрегата — использует value objects */
export interface OrderState {
  readonly id: OrderId;
  readonly asset: AssetId;
  readonly side: Side;
  readonly price: Price;
  readonly size: Quantity;
  readonly status: OrderStatus;
  readonly timestamp: Timestamp;
  readonly fill: FillState;
  readonly reason?: string;
  readonly strategyId?: StrategyId;
  /**
   * ID аккаунта-владельца заявки (опционально).
   *
   * @remarks
   * Используется execution-слоем для ownership-проверки перед CANCEL:
   * стратегия не должна отменять ордера чужого аккаунта. Optional для
   * обратной совместимости со старыми снапшотами/recovery-путями.
   */
  readonly accountId?: AccountId;
}

// ─── External contracts ───────────────────────────────────────────

/**
 * Параметры создания новой заявки.
 * Статус всегда PENDING, fill всегда пустой.
 */
export interface CreateOrderParams {
  readonly id: OrderId;
  readonly asset: AssetId;
  readonly side: Side;
  readonly price: Price;
  readonly size: Quantity;
  readonly timestamp: Timestamp;
  readonly strategyId?: StrategyId;
  /** ID аккаунта-владельца заявки (для ownership-проверок execution-слоя) */
  readonly accountId?: AccountId;
}

/**
 * Снэпшот заявки — примитивы.
 *
 * Используется для:
 * - Персистентности (БД, кэш)
 * - Синхронизации с биржей (режим reconciliation)
 * - Round-trip сериализации
 */
export interface OrderSnapshot {
  readonly id: string;
  readonly asset: string;
  readonly side: string;
  readonly price: number;
  readonly size: number;
  readonly status: string;
  readonly timestamp: string;
  readonly filledSize: number;
  readonly averagePrice?: number;
  readonly fillIds: readonly string[];
  readonly reason?: string;
  readonly strategyId?: string;
  /** Сериализованный AccountId владельца (см. `accountIdToString`) */
  readonly accountId?: string;
}
