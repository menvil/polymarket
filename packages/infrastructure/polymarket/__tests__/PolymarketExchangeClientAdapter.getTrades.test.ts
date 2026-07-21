/**
 * Тесты PolymarketExchangeClientAdapter.getTrades() — маппинг user fills.
 *
 * @remarks
 * Регрессия для P0-находок (см. docs/architecture/reservation-journal-safety.md):
 * - MAKER trade с несколькими `maker_orders[]` разворачивается в несколько
 *   VenueTradeSnapshot с составными fillId (не коллизирует под одним ID).
 * - On-chain статус (`TRADE_STATUS_*` префикс) нормализуется, а не хардкодится.
 * - TAKER-путь (без `maker_orders`) не затронут регрессией.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { PolymarketExchangeClientAdapter } from '../adapters/PolymarketExchangeClientAdapter.js';
import type { PolymarketExecutionAdapter } from '../rest/adapters/PolymarketExecutionAdapter.js';
import type { PolymarketUserTradesRestClient, UserFillResponse } from '../rest/clients/PolymarketUserTradesRestClient.js';
import type { ILogger } from '@polymarket/logger';
import type { AccountId } from '@polymarket/ids';

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

const ACCOUNT_ID = 'acc-001' as unknown as AccountId;

function makeUserTradesClient(fills: UserFillResponse[]): PolymarketUserTradesRestClient {
  return {
    getUserFills: jest.fn(async () => fills),
  } as unknown as PolymarketUserTradesRestClient;
}

function makeAdapter(userTradesClient: PolymarketUserTradesRestClient): PolymarketExchangeClientAdapter {
  const executionAdapter = {
    cancelOrder: jest.fn(),
    postOrder: jest.fn(),
    getFilledOrders: jest.fn(async () => []),
  } as unknown as PolymarketExecutionAdapter;
  return new PolymarketExchangeClientAdapter(executionAdapter, makeLogger(), userTradesClient);
}

function makeMakerFill(overrides: Partial<UserFillResponse> = {}): UserFillResponse {
  return {
    id: 'trade-1',
    trader_side: 'MAKER',
    market: 'market-1',
    asset_id: 'asset-1',
    side: 'BUY',
    price: '0.65',
    size: '150',
    match_time: '1775457709',
    status: 'TRADE_STATUS_CONFIRMED',
    maker_orders: [
      { order_id: 'maker-order-a', matched_amount: '100', price: '0.65', asset_id: 'asset-1', side: 'BUY' },
      { order_id: 'maker-order-b', matched_amount: '50', price: '0.65', asset_id: 'asset-1', side: 'BUY' },
    ],
    ...overrides,
  } as UserFillResponse;
}

describe('PolymarketExchangeClientAdapter.getTrades — maker_orders unrolling', () => {
  it('разворачивает один MAKER trade с двумя maker_orders в два snapshot с разными fillId/orderId', async () => {
    const adapter = makeAdapter(makeUserTradesClient([makeMakerFill()]));
    const result = await adapter.getTrades(ACCOUNT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    const [first, second] = result.value;
    expect(String(first.fillId)).toBe('trade-1:maker-order-a');
    expect(String(first.orderId)).toBe('maker-order-a');
    expect(first.size.value().toString()).toBe('100');
    expect(String(second.fillId)).toBe('trade-1:maker-order-b');
    expect(String(second.orderId)).toBe('maker-order-b');
    expect(second.size.value().toString()).toBe('50');
    // fillId разных maker-ордеров одного trade НЕ коллизируют.
    expect(String(first.fillId)).not.toBe(String(second.fillId));
  });

  it('MAKER trade без maker_orders (legacy/пустой массив) не порождает snapshot без order_id', async () => {
    const adapter = makeAdapter(makeUserTradesClient([makeMakerFill({ maker_orders: [] })]));
    const result = await adapter.getTrades(ACCOUNT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Нет top-level maker_order_id в реальном API → order_id undefined → skip.
    expect(result.value).toHaveLength(0);
  });

  it('TAKER trade (без maker_orders) маппится в один snapshot через taker_order_id', async () => {
    const takerFill: UserFillResponse = {
      id: 'trade-2',
      trader_side: 'TAKER',
      taker_order_id: 'taker-order-x',
      market: 'market-1',
      asset_id: 'asset-1',
      side: 'SELL',
      price: '0.42',
      size: '20',
      match_time: '1775457800',
      status: 'TRADE_STATUS_CONFIRMED',
      fee_rate_bps: '200',
    } as UserFillResponse;
    const adapter = makeAdapter(makeUserTradesClient([takerFill]));
    const result = await adapter.getTrades(ACCOUNT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(String(result.value[0].fillId)).toBe('trade-2');
    expect(String(result.value[0].orderId)).toBe('taker-order-x');
  });
});

describe('PolymarketExchangeClientAdapter.getTrades — on-chain статус нормализация', () => {
  it.each([
    ['TRADE_STATUS_CONFIRMED', 'CONFIRMED'],
    ['TRADE_STATUS_MATCHED', 'MATCHED'],
    ['TRADE_STATUS_MINED', 'MINED'],
    ['TRADE_STATUS_RETRYING', 'RETRYING'],
    ['TRADE_STATUS_FAILED', 'FAILED'],
  ])('%s → %s (без хардкода CONFIRMED)', async (raw, expected) => {
    const takerFill: UserFillResponse = {
      id: 'trade-3',
      trader_side: 'TAKER',
      taker_order_id: 'taker-order-y',
      market: 'market-1',
      asset_id: 'asset-1',
      side: 'BUY',
      price: '0.5',
      size: '10',
      match_time: '1775457900',
      status: raw,
    } as UserFillResponse;
    const adapter = makeAdapter(makeUserTradesClient([takerFill]));
    const result = await adapter.getTrades(ACCOUNT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0].status).toBe(expected);
  });

  it('неизвестный/отсутствующий статус → undefined (не мешает обработке, трактуется как "не финализировано")', async () => {
    const takerFill: UserFillResponse = {
      id: 'trade-4',
      trader_side: 'TAKER',
      taker_order_id: 'taker-order-z',
      market: 'market-1',
      asset_id: 'asset-1',
      side: 'BUY',
      price: '0.5',
      size: '10',
      match_time: '1775457900',
    } as UserFillResponse;
    const adapter = makeAdapter(makeUserTradesClient([takerFill]));
    const result = await adapter.getTrades(ACCOUNT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0].status).toBeUndefined();
  });
});
