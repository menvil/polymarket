/**
 * Типы данных Order — только структуры, ноль логики
 *
 * @remarks
 * OrderState — внутреннее представление агрегата (value objects).
 * OrderSnapshot — внешний формат для персистентности и синхронизации с биржей.
 * CreateOrderParams — параметры для создания новой заявки (status всегда PENDING).
 * FillData — данные одного исполнения (входной параметр applyFill).
 */

import type { Price, Quantity, Side, Timestamp } from '@polymarket/value-objects';
import type { AssetId, FillId, OrderId } from '@polymarket/ids';

// ─── Status ──────────────────────────────────────────────────────

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

// ─── Fill data ────────────────────────────────────────────────────

/** Данные одного исполнения — параметр для Order.applyFill() и FillApplied event */
export interface FillData {
  readonly id: FillId;
  readonly orderId: OrderId;
  readonly asset: AssetId;
  readonly side: Side;
  readonly size: Quantity;
  readonly price: Price;
}

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
  readonly strategyId?: string;
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
  readonly strategyId?: string;
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
}
