/**
 * Тесты маппинга venue cancel response → CancelOrderResult.
 *
 * @remarks
 * Проверяет самую рискованную часть PolymarketExchangeClientAdapter.cancelOrder():
 * классификацию `not_canceled[orderId]` в структурированный CancelOrderResult.status.
 * Все тексты причин — реальные/правдоподобные ответы Polymarket CLOB API.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { PolymarketExchangeClientAdapter } from '../adapters/PolymarketExchangeClientAdapter.js';
import type { PolymarketExecutionAdapter } from '../rest/adapters/PolymarketExecutionAdapter.js';
import type { CancelOrderExecutionResponse } from '../ports/IExecutionAdapter.js';
import type { ILogger } from '@polymarket/logger';
import { asOrderId } from '@polymarket/ids';

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

function makeExecutionAdapter(
  cancelOrderImpl: (orderId: string) => Promise<CancelOrderExecutionResponse>,
): PolymarketExecutionAdapter {
  return {
    cancelOrder: jest.fn(cancelOrderImpl),
  } as unknown as PolymarketExecutionAdapter;
}

function makeAdapter(
  cancelOrderImpl: (orderId: string) => Promise<CancelOrderExecutionResponse>,
): PolymarketExchangeClientAdapter {
  return new PolymarketExchangeClientAdapter(
    makeExecutionAdapter(cancelOrderImpl),
    makeLogger(),
  );
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
