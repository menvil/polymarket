/**
 * Тесты для handlers.ts — чистые функции FSM transitions
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
import {
  handleAccepted,
  handleRejected,
  handleCancelled,
  handleExpired,
  handleFillApplied,
} from '../../../src/transitions/handlers';
import type { OrderData } from '../../../src/transitions/handlers';
import { OrderFill } from '../../../src/value-objects/OrderFill';
import type { FillForOrder } from '../../../src/types/OrderChange';

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

const OTHER_ASSET: AssetId = { ...ASSET, outcomeKey: parseOutcomeKey('NO')! };

const ORDER_ID = asOrderId('order-1')!;
const FILL_ID_1 = asFillId('fill-1')!;
const FILL_ID_2 = asFillId('fill-2')!;

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: unknown }, ctx = ''): T {
  if (!r.ok) {
    const msg = (r as { ok: false; error: unknown }).error instanceof Error
      ? ((r as any).error as Error).message
      : String((r as any).error);
    throw new Error(`unwrap failed${ctx ? ` (${ctx})` : ''}: ${msg}`);
  }
  return (r as { ok: true; value: T }).value;
}

/** Создаёт валидный OrderData в заданном статусе */
function makeOrder(
  status: OrderData['status'],
  overrides?: Partial<OrderData>
): OrderData {
  return {
    id: ORDER_ID,
    asset: ASSET,
    side: 'BUY',
    price: Price.of(new Decimal('0.65')),
    size: Quantity.of(new Decimal('100')),
    status,
    timestamp: Timestamp.now(),
    fill: OrderFill.empty(),
    ...overrides,
  };
}

/** Создаёт валидный FillForOrder */
function makeFill(overrides?: Partial<FillForOrder>): FillForOrder {
  return {
    id: FILL_ID_1,
    orderId: ORDER_ID,
    asset: ASSET,
    side: 'BUY',
    size: Quantity.of(new Decimal('30')),
    price: Price.of(new Decimal('0.65')),
    ...overrides,
  };
}

// ──────────────── handleAccepted ────────────────

describe('handleAccepted()', () => {
  it('PENDING → OPEN', () => {
    const result = handleAccepted(makeOrder('PENDING'));
    const data = unwrap(result);
    expect(data.status).toBe('OPEN');
  });

  it('сохраняет все остальные поля неизменными', () => {
    const order = makeOrder('PENDING');
    const data = unwrap(handleAccepted(order));
    expect(data.id).toBe(order.id);
    expect(data.price).toBe(order.price);
    expect(data.size).toBe(order.size);
    expect(data.asset).toBe(order.asset);
  });

  it.each(['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'] as const)(
    'возвращает Err для статуса %s',
    (status) => expect(handleAccepted(makeOrder(status)).ok).toBe(false)
  );

  it('сообщение ошибки содержит текущий статус', () => {
    const result = handleAccepted(makeOrder('OPEN'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('OPEN');
    }
  });
});

// ──────────────── handleRejected ────────────────

describe('handleRejected()', () => {
  it('PENDING → REJECTED с причиной', () => {
    const result = handleRejected(makeOrder('PENDING'), 'Insufficient funds');
    const data = unwrap(result);
    expect(data.status).toBe('REJECTED');
    expect(data.reason).toBe('Insufficient funds');
  });

  it.each(['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'] as const)(
    'возвращает Err для статуса %s',
    (status) => expect(handleRejected(makeOrder(status), 'reason').ok).toBe(false)
  );
});

// ──────────────── handleCancelled ────────────────

describe('handleCancelled()', () => {
  it('OPEN → CANCELED с причиной', () => {
    const result = handleCancelled(makeOrder('OPEN'), 'User request');
    const data = unwrap(result);
    expect(data.status).toBe('CANCELED');
    expect(data.reason).toBe('User request');
  });

  it('PARTIALLY_FILLED → CANCELED', () => {
    const result = handleCancelled(makeOrder('PARTIALLY_FILLED'), 'Strategy stopped');
    expect(unwrap(result).status).toBe('CANCELED');
  });

  it.each(['PENDING', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'] as const)(
    'возвращает Err для статуса %s',
    (status) => expect(handleCancelled(makeOrder(status), 'reason').ok).toBe(false)
  );
});

// ──────────────── handleExpired ────────────────

describe('handleExpired()', () => {
  it('OPEN → EXPIRED', () => {
    expect(unwrap(handleExpired(makeOrder('OPEN'))).status).toBe('EXPIRED');
  });

  it('PARTIALLY_FILLED → EXPIRED', () => {
    expect(unwrap(handleExpired(makeOrder('PARTIALLY_FILLED'))).status).toBe('EXPIRED');
  });

  it.each(['PENDING', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'] as const)(
    'возвращает Err для статуса %s',
    (status) => expect(handleExpired(makeOrder(status)).ok).toBe(false)
  );
});

// ──────────────── handleFillApplied ────────────────

describe('handleFillApplied()', () => {
  describe('успешное применение', () => {
    it('OPEN → PARTIALLY_FILLED при частичном исполнении', () => {
      const fill = makeFill({ size: Quantity.of(new Decimal('30')) });
      const data = unwrap(handleFillApplied(makeOrder('OPEN'), fill));
      expect(data.status).toBe('PARTIALLY_FILLED');
      expect(data.fill.getFilledSize().value().toNumber()).toBe(30);
    });

    it('OPEN → FILLED при полном исполнении', () => {
      const fill = makeFill({ size: Quantity.of(new Decimal('100')) });
      const data = unwrap(handleFillApplied(makeOrder('OPEN'), fill));
      expect(data.status).toBe('FILLED');
      expect(data.fill.getFilledSize().value().toNumber()).toBe(100);
    });

    it('PARTIALLY_FILLED → FILLED при завершающем fill', () => {
      const partialFill = unwrap(OrderFill.create(
        Quantity.of(new Decimal('70')),
        Price.of(new Decimal('0.65')),
        [FILL_ID_1],
        Quantity.of(new Decimal('100'))
      ));
      const order = makeOrder('PARTIALLY_FILLED', { fill: partialFill });
      const fill = makeFill({ id: FILL_ID_2, size: Quantity.of(new Decimal('30')) });
      const data = unwrap(handleFillApplied(order, fill));
      expect(data.status).toBe('FILLED');
    });

    it('обновляет fill с правильным средним ценой', () => {
      const fill = makeFill({
        size: Quantity.of(new Decimal('50')),
        price: Price.of(new Decimal('0.70')),
      });
      const data = unwrap(handleFillApplied(makeOrder('OPEN'), fill));
      expect(data.fill.getAverageFillPrice()?.value().toNumber()).toBe(0.70);
    });
  });

  describe('ошибки валидации', () => {
    it.each(['PENDING', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'] as const)(
      'возвращает Err для статуса %s',
      (status) => expect(handleFillApplied(makeOrder(status), makeFill()).ok).toBe(false)
    );

    it('возвращает Err если asset не совпадает', () => {
      const fill = makeFill({ asset: OTHER_ASSET });
      expect(handleFillApplied(makeOrder('OPEN'), fill).ok).toBe(false);
    });

    it('возвращает Err если side не совпадает', () => {
      const fill = makeFill({ side: 'SELL' });
      expect(handleFillApplied(makeOrder('OPEN'), fill).ok).toBe(false);
    });

    it('возвращает Err если orderId не совпадает', () => {
      const fill = makeFill({ orderId: asOrderId('other-order')! });
      expect(handleFillApplied(makeOrder('OPEN'), fill).ok).toBe(false);
    });

    it('возвращает Err если fillSize превышает размер заявки', () => {
      const fill = makeFill({ size: Quantity.of(new Decimal('150')) });
      expect(handleFillApplied(makeOrder('OPEN'), fill).ok).toBe(false);
    });

    it('возвращает Err при дублирующемся fillId', () => {
      const order = makeOrder('OPEN');
      const fill1 = makeFill({ id: FILL_ID_1, size: Quantity.of(new Decimal('30')) });
      const partialOrder = unwrap(handleFillApplied(order, fill1));

      // Второй fill с тем же ID
      const fill2 = makeFill({ id: FILL_ID_1, size: Quantity.of(new Decimal('20')) });
      expect(handleFillApplied(partialOrder, fill2).ok).toBe(false);
    });
  });

  describe('накопление fills', () => {
    it('корректно накапливает несколько fills', () => {
      let order = makeOrder('OPEN');

      const fill1 = makeFill({ id: FILL_ID_1, size: Quantity.of(new Decimal('40')) });
      order = unwrap(handleFillApplied(order, fill1));
      expect(order.fill.getFilledSize().value().toNumber()).toBe(40);

      const fill2 = makeFill({ id: FILL_ID_2, size: Quantity.of(new Decimal('60')) });
      order = unwrap(handleFillApplied(order, fill2));
      expect(order.fill.getFilledSize().value().toNumber()).toBe(100);
      expect(order.status).toBe('FILLED');
    });
  });
});
