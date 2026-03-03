/**
 * Тесты для OrderFSM — центральный dispatcher FSM transitions
 */

import { Price, Quantity, Timestamp } from '@polymarket/value-objects';
import {
  asOrderId,
  asFillId,
  parseConditionId,
  parseOutcomeKey,
  KnownChainIds,
  KnownOnChainProtocols,
} from '@polymarket/ids';
import type { AssetId } from '@polymarket/ids';
import Decimal from 'decimal.js';
import { OrderFSM } from '../../../src/transitions/OrderFSM';
import { OrderFill } from '../../../src/value-objects/OrderFill';
import type { OrderData } from '../../../src/transitions/handlers';
import type { OrderChange } from '../../../src/types/OrderChange';

// ──────────────── Фикстуры ────────────────

const ASSET: AssetId = {
  type: 'OUTCOME_TOKEN',
  conditionRef: {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: KnownChainIds.POLYGON,
    conditionId: parseConditionId('0x' + 'a'.repeat(64))!,
  },
  outcomeKey: parseOutcomeKey('YES')!,
};

const ORDER_ID = asOrderId('order-fsm-1')!;
const FILL_ID = asFillId('fill-fsm-1')!;

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error((r as any).error?.message ?? String((r as any).error));
  return (r as { ok: true; value: T }).value;
}

function makeOrder(status: OrderData['status']): OrderData {
  return {
    id: ORDER_ID,
    asset: ASSET,
    side: 'BUY',
    price: Price.of(new Decimal('0.65')),
    size: Quantity.of(new Decimal('100')),
    status,
    timestamp: Timestamp.now(),
    fill: OrderFill.empty(),
  };
}

// ──────────────── Диспатч ────────────────

describe('OrderFSM.apply()', () => {
  describe('ACCEPTED', () => {
    it('вызывает handleAccepted: PENDING → OPEN', () => {
      const change: OrderChange = { type: 'ACCEPTED' };
      expect(unwrap(OrderFSM.apply(makeOrder('PENDING'), change)).status).toBe('OPEN');
    });

    it('передаёт ошибку handleAccepted для неверного статуса', () => {
      const change: OrderChange = { type: 'ACCEPTED' };
      expect(OrderFSM.apply(makeOrder('OPEN'), change).ok).toBe(false);
    });
  });

  describe('REJECTED', () => {
    it('вызывает handleRejected: PENDING → REJECTED', () => {
      const change: OrderChange = { type: 'REJECTED', reason: 'Bad price' };
      const data = unwrap(OrderFSM.apply(makeOrder('PENDING'), change));
      expect(data.status).toBe('REJECTED');
      expect(data.reason).toBe('Bad price');
    });

    it('передаёт ошибку handleRejected для неверного статуса', () => {
      const change: OrderChange = { type: 'REJECTED', reason: 'Bad price' };
      expect(OrderFSM.apply(makeOrder('OPEN'), change).ok).toBe(false);
    });
  });

  describe('CANCELLED', () => {
    it('вызывает handleCancelled: OPEN → CANCELED', () => {
      const change: OrderChange = { type: 'CANCELLED', reason: 'User request' };
      const data = unwrap(OrderFSM.apply(makeOrder('OPEN'), change));
      expect(data.status).toBe('CANCELED');
      expect(data.reason).toBe('User request');
    });

    it('PARTIALLY_FILLED → CANCELED', () => {
      const change: OrderChange = { type: 'CANCELLED', reason: 'Strategy stopped' };
      expect(unwrap(OrderFSM.apply(makeOrder('PARTIALLY_FILLED'), change)).status).toBe('CANCELED');
    });

    it('передаёт ошибку для неверного статуса', () => {
      const change: OrderChange = { type: 'CANCELLED', reason: 'reason' };
      expect(OrderFSM.apply(makeOrder('PENDING'), change).ok).toBe(false);
    });
  });

  describe('EXPIRED', () => {
    it('вызывает handleExpired: OPEN → EXPIRED', () => {
      const change: OrderChange = { type: 'EXPIRED' };
      expect(unwrap(OrderFSM.apply(makeOrder('OPEN'), change)).status).toBe('EXPIRED');
    });

    it('PARTIALLY_FILLED → EXPIRED', () => {
      const change: OrderChange = { type: 'EXPIRED' };
      expect(unwrap(OrderFSM.apply(makeOrder('PARTIALLY_FILLED'), change)).status).toBe('EXPIRED');
    });

    it('передаёт ошибку для неверного статуса', () => {
      const change: OrderChange = { type: 'EXPIRED' };
      expect(OrderFSM.apply(makeOrder('FILLED'), change).ok).toBe(false);
    });
  });

  describe('FILL_APPLIED', () => {
    it('вызывает handleFillApplied: OPEN → PARTIALLY_FILLED', () => {
      const change: OrderChange = {
        type: 'FILL_APPLIED',
        fill: {
          id: FILL_ID,
          orderId: ORDER_ID,
          asset: ASSET,
          side: 'BUY',
          size: Quantity.of(new Decimal('30')),
          price: Price.of(new Decimal('0.65')),
        },
      };
      const data = unwrap(OrderFSM.apply(makeOrder('OPEN'), change));
      expect(data.status).toBe('PARTIALLY_FILLED');
    });

    it('передаёт ошибку для неверного статуса', () => {
      const change: OrderChange = {
        type: 'FILL_APPLIED',
        fill: {
          id: FILL_ID,
          orderId: ORDER_ID,
          asset: ASSET,
          side: 'BUY',
          size: Quantity.of(new Decimal('30')),
          price: Price.of(new Decimal('0.65')),
        },
      };
      expect(OrderFSM.apply(makeOrder('PENDING'), change).ok).toBe(false);
    });
  });
});
