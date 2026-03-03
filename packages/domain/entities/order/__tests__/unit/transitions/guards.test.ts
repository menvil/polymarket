/**
 * Тесты для guards.ts — предикаты переходов FSM
 */

import { Quantity } from '@polymarket/value-objects';
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
import {
  canAccept,
  canReject,
  canCancel,
  canExpire,
  canApplyFill,
  canAcceptFillDetailed,
  requiresReason,
} from '../../../src/transitions/guards';
import type { FillValidationParams } from '../../../src/transitions/guards';
import type { OrderStatus } from '../../../src/value-objects/OrderStatus';

// ──────────────── Фикстуры ────────────────

const ASSET_YES: AssetId = {
  type: 'OUTCOME_TOKEN',
  conditionRef: {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: KnownChainIds.POLYGON,
    conditionId: parseConditionId('0x' + 'a'.repeat(64))!,
  },
  outcomeKey: parseOutcomeKey('YES')!,
};

const ASSET_NO: AssetId = {
  ...ASSET_YES,
  outcomeKey: parseOutcomeKey('NO')!,
};

const ORDER_ID = asOrderId('order-1')!;
const FILL_ID = asFillId('fill-1')!;
const SIZE_100 = Quantity.of(new Decimal('100'));
const SIZE_30 = Quantity.of(new Decimal('30'));
const ALL_STATUSES: OrderStatus[] = [
  'PENDING', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED',
];
const TERMINAL: OrderStatus[] = ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'];

/** Базовые валидные параметры для canAcceptFillDetailed */
function makeParams(overrides?: Partial<FillValidationParams>): FillValidationParams {
  return {
    orderStatus: 'OPEN',
    orderAsset: ASSET_YES,
    orderSide: 'BUY',
    orderId: ORDER_ID,
    remainingSize: SIZE_100,
    existingFillIds: [],
    fillAsset: ASSET_YES,
    fillSide: 'BUY',
    fillOrderId: ORDER_ID,
    fillSize: SIZE_30,
    fillId: FILL_ID,
    ...overrides,
  };
}

// ──────────────── canAccept ────────────────

describe('canAccept()', () => {
  it('возвращает true только для PENDING', () => {
    expect(canAccept('PENDING')).toBe(true);
  });

  it.each(ALL_STATUSES.filter(s => s !== 'PENDING'))(
    'возвращает false для %s',
    (status) => expect(canAccept(status)).toBe(false)
  );
});

// ──────────────── canReject ────────────────

describe('canReject()', () => {
  it('возвращает true только для PENDING', () => {
    expect(canReject('PENDING')).toBe(true);
  });

  it.each(ALL_STATUSES.filter(s => s !== 'PENDING'))(
    'возвращает false для %s',
    (status) => expect(canReject(status)).toBe(false)
  );
});

// ──────────────── canCancel ────────────────

describe('canCancel()', () => {
  it('возвращает true для OPEN', () => {
    expect(canCancel('OPEN')).toBe(true);
  });

  it('возвращает true для PARTIALLY_FILLED', () => {
    expect(canCancel('PARTIALLY_FILLED')).toBe(true);
  });

  it.each(['PENDING', ...TERMINAL] as OrderStatus[])(
    'возвращает false для %s',
    (status) => expect(canCancel(status)).toBe(false)
  );
});

// ──────────────── canExpire ────────────────

describe('canExpire()', () => {
  it('возвращает true для OPEN', () => {
    expect(canExpire('OPEN')).toBe(true);
  });

  it('возвращает true для PARTIALLY_FILLED', () => {
    expect(canExpire('PARTIALLY_FILLED')).toBe(true);
  });

  it.each(['PENDING', ...TERMINAL] as OrderStatus[])(
    'возвращает false для %s',
    (status) => expect(canExpire(status)).toBe(false)
  );
});

// ──────────────── canApplyFill ────────────────

describe('canApplyFill()', () => {
  it('возвращает true для OPEN', () => {
    expect(canApplyFill('OPEN')).toBe(true);
  });

  it('возвращает true для PARTIALLY_FILLED', () => {
    expect(canApplyFill('PARTIALLY_FILLED')).toBe(true);
  });

  it.each(['PENDING', ...TERMINAL] as OrderStatus[])(
    'возвращает false для %s',
    (status) => expect(canApplyFill(status)).toBe(false)
  );
});

// ──────────────── requiresReason ────────────────

describe('requiresReason()', () => {
  it('возвращает true только для REJECTED', () => {
    expect(requiresReason('REJECTED')).toBe(true);
  });

  it.each(ALL_STATUSES.filter(s => s !== 'REJECTED'))(
    'возвращает false для %s',
    (status) => expect(requiresReason(status)).toBe(false)
  );
});

// ──────────────── canAcceptFillDetailed ────────────────

describe('canAcceptFillDetailed()', () => {
  describe('happy path', () => {
    it('возвращает true при всех валидных параметрах (OPEN)', () => {
      expect(canAcceptFillDetailed(makeParams())).toBe(true);
    });

    it('возвращает true при статусе PARTIALLY_FILLED', () => {
      expect(canAcceptFillDetailed(makeParams({ orderStatus: 'PARTIALLY_FILLED' }))).toBe(true);
    });

    it('возвращает true когда fillSize === remainingSize (полное исполнение)', () => {
      expect(canAcceptFillDetailed(makeParams({
        fillSize: SIZE_100,
        remainingSize: SIZE_100,
      }))).toBe(true);
    });
  });

  describe('невалидный статус', () => {
    it.each(['PENDING', ...TERMINAL] as OrderStatus[])(
      'возвращает false для статуса %s',
      (status) => expect(canAcceptFillDetailed(makeParams({ orderStatus: status }))).toBe(false)
    );
  });

  describe('несовпадение asset', () => {
    it('возвращает false если fillAsset !== orderAsset', () => {
      expect(canAcceptFillDetailed(makeParams({ fillAsset: ASSET_NO }))).toBe(false);
    });
  });

  describe('несовпадение side', () => {
    it('возвращает false если fillSide !== orderSide', () => {
      expect(canAcceptFillDetailed(makeParams({ fillSide: 'SELL' }))).toBe(false);
    });
  });

  describe('несовпадение orderId', () => {
    it('возвращает false если fillOrderId !== orderId', () => {
      expect(canAcceptFillDetailed(makeParams({
        fillOrderId: asOrderId('other-order')!,
      }))).toBe(false);
    });
  });

  describe('размер fill', () => {
    it('возвращает false если fillSize > remainingSize', () => {
      expect(canAcceptFillDetailed(makeParams({
        fillSize: SIZE_100,
        remainingSize: SIZE_30,
      }))).toBe(false);
    });
  });

  describe('дубликаты fillId', () => {
    it('возвращает false если fillId уже есть в existingFillIds', () => {
      expect(canAcceptFillDetailed(makeParams({
        existingFillIds: [FILL_ID],
      }))).toBe(false);
    });

    it('возвращает true для другого fillId не в existingFillIds', () => {
      expect(canAcceptFillDetailed(makeParams({
        existingFillIds: [asFillId('other-fill')!],
      }))).toBe(true);
    });
  });
});
