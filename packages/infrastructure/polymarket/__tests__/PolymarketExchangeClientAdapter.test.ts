/**
 * Тесты маппинга venue-ответов → CancelOrderResult / SubmitOrderResult.
 *
 * @remarks
 * Проверяет самую рискованную часть PolymarketExchangeClientAdapter:
 * - cancelOrder(): классификацию `not_canceled[orderId]` в CancelOrderResult.status.
 * - submitOrder(): классификацию OrderResponse (status + sizeRemaining) в SubmitOrderResult.status.
 * Все тексты причин — реальные/правдоподобные ответы Polymarket CLOB API.
 */
import { describe, it, expect, jest } from '@jest/globals';
// Тестовая фикстура строит Price/Quantity через VO-конструктор
// (Price.of(new Decimal(...))), см. docs/architecture/boundary-contract.md, Решение 1.
// __tests__/ исключён из scan-conventions.mjs's decimal-import-files.txt по дизайну
// скрипта, но само ESLint-правило такого исключения не имеет — этот сайт найден
// repo-wide lint-прогоном Этапа 11, не сканером.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import Decimal from 'decimal.js';
import { PolymarketExchangeClientAdapter } from '../adapters/PolymarketExchangeClientAdapter.js';
import type { PolymarketExecutionAdapter } from '../rest/adapters/PolymarketExecutionAdapter.js';
import type { CancelOrderExecutionResponse, OrderResponse } from '../ports/IExecutionAdapter.js';
import type { ILogger } from '@polymarket/logger';
import { asOrderId, asPolymarketCtfToken } from '@polymarket/ids';
import { Price, Quantity } from '@polymarket/value-objects';
import type { SubmitOrderParams } from '@polymarket/ports';

function makeLogger(): ILogger {
  return {
    trace: jest.fn() as ILogger['trace'],
    debug: jest.fn() as ILogger['debug'],
    info: jest.fn() as ILogger['info'],
    warn: jest.fn() as ILogger['warn'],
    error: jest.fn() as ILogger['error'],
    fatal: jest.fn() as ILogger['fatal'],
    child: jest.fn<ILogger['child']>().mockReturnThis() as ILogger['child'],
  };
}

const ORDER_ID = asOrderId('0xabc123')!;
const TEST_ASSET = asPolymarketCtfToken('123')!;

function makeExecutionAdapter(overrides: {
  cancelOrder?: (orderId: string) => Promise<CancelOrderExecutionResponse>;
  postOrder?: (params: unknown) => Promise<OrderResponse>;
}): PolymarketExecutionAdapter {
  return {
    cancelOrder: jest.fn(overrides.cancelOrder ?? (async () => ({ canceled: [], not_canceled: {} }))),
    postOrder: jest.fn(overrides.postOrder ?? (async () => {
      throw new Error('postOrder not stubbed');
    })),
  } as unknown as PolymarketExecutionAdapter;
}

function makeAdapter(
  cancelOrderImpl: (orderId: string) => Promise<CancelOrderExecutionResponse>,
): PolymarketExchangeClientAdapter {
  return new PolymarketExchangeClientAdapter(
    makeExecutionAdapter({ cancelOrder: cancelOrderImpl }),
    makeLogger(),
  );
}

function makeSubmitAdapter(
  postOrderImpl: (params: unknown) => Promise<OrderResponse>,
): PolymarketExchangeClientAdapter {
  return new PolymarketExchangeClientAdapter(
    makeExecutionAdapter({ postOrder: postOrderImpl }),
    makeLogger(),
  );
}

function makeSubmitParams(size = '100'): SubmitOrderParams {
  return {
    asset: TEST_ASSET,
    side: 'BUY',
    price: Price.of(new Decimal('0.65')),
    size: Quantity.of(new Decimal(size)),
  };
}

function makeOrderResponse(overrides: Partial<OrderResponse> = {}): OrderResponse {
  return {
    orderId: String(ORDER_ID),
    status: 'live',
    side: 'buy',
    price: 0.65,
    size: 100,
    sizeRemaining: 100,
    tokenId: '123',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('PolymarketExchangeClientAdapter.cancelOrder — mapping', () => {
  it('canceled: [orderId] → Ok({status: CANCELLED})', async () => {
    const adapter = makeAdapter(async () => ({ canceled: [String(ORDER_ID)], not_canceled: {} }));
    const result = await adapter.cancelOrder(ORDER_ID);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ status: 'CANCELLED' });
  });

  it("not_canceled reason \"matched orders can't be canceled\" → ALREADY_FILLED", async () => {
    const adapter = makeAdapter(async () => ({
      canceled: [],
      not_canceled: { [String(ORDER_ID)]: "matched orders can't be canceled" },
    }));
    const result = await adapter.cancelOrder(ORDER_ID);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('ALREADY_FILLED');
  });

  it('not_canceled reason "already canceled" → ALREADY_CANCELLED', async () => {
    const adapter = makeAdapter(async () => ({
      canceled: [],
      not_canceled: { [String(ORDER_ID)]: 'already canceled' },
    }));
    const result = await adapter.cancelOrder(ORDER_ID);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('ALREADY_CANCELLED');
  });

  it('not_canceled reason "order not found" → NOT_FOUND', async () => {
    const adapter = makeAdapter(async () => ({
      canceled: [],
      not_canceled: { [String(ORDER_ID)]: 'order not found' },
    }));
    const result = await adapter.cancelOrder(ORDER_ID);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('NOT_FOUND');
  });

  it('not_canceled reason "not canceled" → UNKNOWN_RETRY_NEEDED (НЕ ALREADY_CANCELLED)', async () => {
    const adapter = makeAdapter(async () => ({
      canceled: [],
      not_canceled: { [String(ORDER_ID)]: 'not canceled' },
    }));
    const result = await adapter.cancelOrder(ORDER_ID);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('UNKNOWN_RETRY_NEEDED');
  });

  it('not_canceled reason "could not be canceled" → UNKNOWN_RETRY_NEEDED (НЕ ALREADY_CANCELLED)', async () => {
    const adapter = makeAdapter(async () => ({
      canceled: [],
      not_canceled: { [String(ORDER_ID)]: 'could not be canceled' },
    }));
    const result = await adapter.cancelOrder(ORDER_ID);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('UNKNOWN_RETRY_NEEDED');
  });

  it('not_canceled reason "order not found, not canceled" → NOT_FOUND (НЕ ALREADY_CANCELLED)', async () => {
    const adapter = makeAdapter(async () => ({
      canceled: [],
      not_canceled: { [String(ORDER_ID)]: 'order not found, not canceled' },
    }));
    const result = await adapter.cancelOrder(ORDER_ID);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('NOT_FOUND');
  });

  it('пустой response (orderId отсутствует в canceled и not_canceled) → UNKNOWN_RETRY_NEEDED', async () => {
    const adapter = makeAdapter(async () => ({ canceled: [], not_canceled: {} }));
    const result = await adapter.cancelOrder(ORDER_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('UNKNOWN_RETRY_NEEDED');
      if (result.value.status === 'UNKNOWN_RETRY_NEEDED') {
        expect(result.value.reason).toMatch(/not present in canceled\/not_canceled/);
      }
    }
  });

  it('executionAdapter.cancelOrder бросает → Err(ExchangeError)', async () => {
    const adapter = makeAdapter(async () => {
      throw new Error('network timeout');
    });
    const result = await adapter.cancelOrder(ORDER_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/network timeout/);
  });
});

describe('PolymarketExchangeClientAdapter.submitOrder — mapping', () => {
  it('status live, sizeRemaining == effectiveSize → OPEN', async () => {
    const adapter = makeSubmitAdapter(async () => makeOrderResponse({ status: 'live', sizeRemaining: 100 }));
    const result = await adapter.submitOrder(makeSubmitParams('100'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('OPEN');
      if (result.value.status === 'OPEN') {
        expect(result.value.orderId).toBe(ORDER_ID);
        expect(result.value.remainingSize.value().toString()).toBe('100');
      }
    }
  });

  it.each(['open', 'unmatched', 'pending', 'delayed'])(
    'status %s, sizeRemaining == effectiveSize → OPEN',
    async (status) => {
      const adapter = makeSubmitAdapter(async () => makeOrderResponse({ status, sizeRemaining: 100 }));
      const result = await adapter.submitOrder(makeSubmitParams('100'));

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('OPEN');
    },
  );

  it.each(['matched', 'filled'])(
    'status %s, sizeRemaining == 0 → FILLED (без synthetic fills)',
    async (status) => {
      const adapter = makeSubmitAdapter(async () => makeOrderResponse({ status, sizeRemaining: 0 }));
      const result = await adapter.submitOrder(makeSubmitParams('100'));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('FILLED');
        if (result.value.status === 'FILLED') {
          expect(result.value.filledSize.value().toString()).toBe('100');
          expect(result.value).not.toHaveProperty('fills');
        }
      }
    },
  );

  it('sizeRemaining == 0 при статусе live (без явного matched/filled) → тоже FILLED', async () => {
    const adapter = makeSubmitAdapter(async () => makeOrderResponse({ status: 'live', sizeRemaining: 0 }));
    const result = await adapter.submitOrder(makeSubmitParams('100'));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('FILLED');
  });

  it('0 < sizeRemaining < effectiveSize → PARTIALLY_FILLED', async () => {
    const adapter = makeSubmitAdapter(async () => makeOrderResponse({ status: 'live', sizeRemaining: 40 }));
    const result = await adapter.submitOrder(makeSubmitParams('100'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('PARTIALLY_FILLED');
      if (result.value.status === 'PARTIALLY_FILLED') {
        expect(result.value.filledSize.value().toString()).toBe('60');
        expect(result.value.remainingSize.value().toString()).toBe('40');
      }
    }
  });

  it.each(['rejected', 'failed', 'cancelled', 'canceled'])(
    'status %s, sizeRemaining == effectiveSize (нулевой fill) → REJECTED',
    async (status) => {
      const adapter = makeSubmitAdapter(async () => makeOrderResponse({ status, sizeRemaining: 100 }));
      const result = await adapter.submitOrder(makeSubmitParams('100'));

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('REJECTED');
    },
  );

  it('терминальный статус (cancelled) без какого-либо fill → REJECTED', async () => {
    const adapter = makeSubmitAdapter(async () => makeOrderResponse({ status: 'cancelled', sizeRemaining: 100 }));
    const result = await adapter.submitOrder(makeSubmitParams('100'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('REJECTED');
      if (result.value.status === 'REJECTED') {
        expect(result.value.reason).toMatch(/cancelled/i);
      }
    }
  });

  it('терминальный статус (rejected) без fill → REJECTED', async () => {
    const adapter = makeSubmitAdapter(async () => makeOrderResponse({ status: 'rejected', sizeRemaining: 100 }));
    const result = await adapter.submitOrder(makeSubmitParams('100'));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('REJECTED');
  });

  it('терминальный статус (cancelled) с частичным fill → FILLED тем объёмом, что реально исполнился (FAK/IOC-подобный исход)', async () => {
    const adapter = makeSubmitAdapter(async () => makeOrderResponse({ status: 'cancelled', sizeRemaining: 40 }));
    const result = await adapter.submitOrder(makeSubmitParams('100'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('FILLED');
      if (result.value.status === 'FILLED') {
        expect(result.value.orderId).toBe(ORDER_ID);
        expect(result.value.filledSize.value().toString()).toBe('60');
      }
    }
  });

  it('невалидный orderId → Err(ExchangeError), submitOutcome=MAY_HAVE_BEEN_SUBMITTED (venue ответил)', async () => {
    const adapter = makeSubmitAdapter(async () => makeOrderResponse({ orderId: '' }));
    const result = await adapter.submitOrder(makeSubmitParams('100'));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/Invalid orderId/);
      expect(result.error.submitOutcome).toBe('MAY_HAVE_BEEN_SUBMITTED');
    }
  });

  it('postOrder бросает (network/timeout после отправки) → Err, submitOutcome=MAY_HAVE_BEEN_SUBMITTED', async () => {
    const adapter = makeSubmitAdapter(async () => {
      throw new Error('network timeout');
    });
    const result = await adapter.submitOrder(makeSubmitParams('100'));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/submitOrder failed/);
      // Ошибка ПОСЛЕ отправки — ордер мог создаться.
      expect(result.error.submitOutcome).toBe('MAY_HAVE_BEEN_SUBMITTED');
    }
  });

  it('sizeRemaining > effectiveSize → UNKNOWN (не OPEN)', async () => {
    const adapter = makeSubmitAdapter(async () => makeOrderResponse({ status: 'live', sizeRemaining: 150 }));
    const result = await adapter.submitOrder(makeSubmitParams('100'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('UNKNOWN');
      if (result.value.status === 'UNKNOWN') {
        expect(result.value.orderId).toBe(ORDER_ID);
        expect(result.value.reason).toMatch(/out of bounds/);
      }
    }
  });

  it('отрицательный sizeRemaining → UNKNOWN (не OPEN)', async () => {
    const adapter = makeSubmitAdapter(async () => makeOrderResponse({ status: 'live', sizeRemaining: -5 }));
    const result = await adapter.submitOrder(makeSubmitParams('100'));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('UNKNOWN');
  });

  it('неизвестный статус → UNKNOWN, даже если размеры выглядят как OPEN', async () => {
    const adapter = makeSubmitAdapter(async () => makeOrderResponse({ status: 'some-weird-status', sizeRemaining: 100 }));
    const result = await adapter.submitOrder(makeSubmitParams('100'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('UNKNOWN');
      if (result.value.status === 'UNKNOWN') {
        expect(result.value.reason).toMatch(/Unrecognized venue order status/);
      }
    }
  });

  it('executionAdapter.postOrder бросает → Err(ExchangeError)', async () => {
    const adapter = makeSubmitAdapter(async () => {
      throw new Error('network timeout');
    });
    const result = await adapter.submitOrder(makeSubmitParams('100'));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/network timeout/);
  });

  it('SELL preflight checkBalance отклоняет Promise → Err(DEFINITELY_NOT_SUBMITTED), postOrder НЕ вызывается', async () => {
    // Pre-dispatch failure: сетевая ошибка balance check ДО отправки на venue —
    // ордер точно не создан, PlaceOrderUseCase может безопасно retry-ить.
    const executionAdapter = makeExecutionAdapter({
      postOrder: async () => {
        throw new Error('postOrder must not be called');
      },
    });
    const balancePolicy = {
      checkBalance: jest.fn().mockImplementation(async () => {
        throw new Error('rpc connection reset');
      }),
    } as unknown as import('../rest/policies/PolymarketBalancePolicy.js').PolymarketBalancePolicy;
    const adapter = new PolymarketExchangeClientAdapter(
      executionAdapter,
      makeLogger(),
      undefined,
      balancePolicy,
    );

    const result = await adapter.submitOrder({ ...makeSubmitParams('100'), side: 'SELL' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.submitOutcome).toBe('DEFINITELY_NOT_SUBMITTED');
      expect(result.error.message).toMatch(/rpc connection reset/);
    }
    expect(executionAdapter.postOrder).not.toHaveBeenCalled();
  });
});
