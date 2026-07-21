/**
 * Тесты PolymarketExchangeClientAdapter.getTrades() — маппинг user fills.
 *
 * @remarks
 * Регрессия для P0-находок (см. docs/architecture/reservation-journal-safety.md):
 * - Маппинг делегирован `mapUserFillToVenueTradeSnapshots` (переиспользует
 *   `FillMapper.allFromPolymarketTradeEvent` — тот же маппер, что и WS путь):
 *   `maker_orders[]` фильтруется по владению (`owner` UUID / `maker_address`),
 *   ЧУЖИЕ maker-ордера в результат НЕ попадают; fillId — bare tradeId при
 *   ОДНОМ своём ордере в trade, составной `{tradeId}:{orderId}` при нескольких
 *   (та же схема, что WS — исключает fillId-коллизию между путями).
 * - On-chain статус (`TRADE_STATUS_*` префикс) нормализуется, а не хардкодится.
 * - Без `_userTradesClient` — `Err` (полноту гарантировать нельзя), НЕ
 *   молчаливо неполный `Ok` через legacy `getFilledOrders`.
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
const OUR_OWNER_UUID = 'owner-uuid-ours';
const OUR_MAKER_ADDRESS = '0xOURADDRESS000000000000000000000000000001';
const FOREIGN_OWNER_UUID = 'owner-uuid-someone-else';
const FOREIGN_MAKER_ADDRESS = '0xFOREIGNADDRESS0000000000000000000000002';

function makeUserTradesClient(fills: UserFillResponse[]): PolymarketUserTradesRestClient {
  return {
    getUserFills: jest.fn(async () => fills),
  } as unknown as PolymarketUserTradesRestClient;
}

function makeAdapter(
  userTradesClient: PolymarketUserTradesRestClient | undefined,
  makerAddress: string | undefined = OUR_MAKER_ADDRESS,
): PolymarketExchangeClientAdapter {
  const executionAdapter = {
    cancelOrder: jest.fn(),
    postOrder: jest.fn(),
    getFilledOrders: jest.fn(async () => []),
  } as unknown as PolymarketExecutionAdapter;
  return new PolymarketExchangeClientAdapter(executionAdapter, makeLogger(), userTradesClient, undefined, makerAddress);
}

function makeMakerFill(overrides: Partial<UserFillResponse> = {}): UserFillResponse {
  return {
    id: 'trade-1',
    trader_side: 'MAKER',
    owner: OUR_OWNER_UUID,
    market: 'market-1',
    asset_id: '123456',
    side: 'BUY',
    price: '0.65',
    size: '150',
    match_time: '1775457709',
    status: 'TRADE_STATUS_CONFIRMED',
    maker_orders: [
      { order_id: 'maker-order-a', matched_amount: '100', price: '0.65', asset_id: '123456', side: 'BUY', owner: OUR_OWNER_UUID },
    ],
    ...overrides,
  } as UserFillResponse;
}

describe('PolymarketExchangeClientAdapter.getTrades — maker ownership filtering (unified with WS FillMapper)', () => {
  it('единственный СВОЙ maker order (owner match) → bare fillId = tradeId', async () => {
    const adapter = makeAdapter(makeUserTradesClient([makeMakerFill()]));
    const result = await adapter.getTrades(ACCOUNT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(String(result.value[0].fillId)).toBe('trade-1');
    expect(String(result.value[0].orderId)).toBe('maker-order-a');
    expect(result.value[0].size.value().toString()).toBe('100');
  });

  it('единственный СВОЙ maker order (maker_address match, cross-outcome — owner чужой) → bare fillId', async () => {
    const fill = makeMakerFill({
      owner: FOREIGN_OWNER_UUID, // top-level owner — тейкера/другого участника
      maker_orders: [
        { order_id: 'maker-order-a', matched_amount: '100', price: '0.65', asset_id: '123456', side: 'BUY', maker_address: OUR_MAKER_ADDRESS },
      ],
    } as Partial<UserFillResponse>);
    const adapter = makeAdapter(makeUserTradesClient([fill]));
    const result = await adapter.getTrades(ACCOUNT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(String(result.value[0].fillId)).toBe('trade-1');
    expect(String(result.value[0].orderId)).toBe('maker-order-a');
  });

  it('ДВА своих maker order в одном trade → составной fillId для каждого, без коллизии', async () => {
    const fill = makeMakerFill({
      maker_orders: [
        { order_id: 'maker-order-a', matched_amount: '100', price: '0.65', asset_id: '123456', side: 'BUY', owner: OUR_OWNER_UUID },
        { order_id: 'maker-order-b', matched_amount: '50', price: '0.65', asset_id: '123456', side: 'BUY', owner: OUR_OWNER_UUID },
      ],
    });
    const adapter = makeAdapter(makeUserTradesClient([fill]));
    const result = await adapter.getTrades(ACCOUNT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    const [first, second] = result.value;
    expect(String(first.fillId)).toBe('trade-1:maker-order-a');
    expect(String(second.fillId)).toBe('trade-1:maker-order-b');
    expect(String(first.fillId)).not.toBe(String(second.fillId));
  });

  it('P0 регрессия: чужой maker order в maker_orders[] НЕ попадает в результат (не наш trade, даже если рядом есть наш)', async () => {
    const fill = makeMakerFill({
      maker_orders: [
        { order_id: 'maker-order-ours', matched_amount: '100', price: '0.65', asset_id: '123456', side: 'BUY', owner: OUR_OWNER_UUID },
        { order_id: 'maker-order-foreign', matched_amount: '999', price: '0.65', asset_id: '123456', side: 'BUY', owner: FOREIGN_OWNER_UUID, maker_address: FOREIGN_MAKER_ADDRESS },
      ],
    });
    const adapter = makeAdapter(makeUserTradesClient([fill]));
    const result = await adapter.getTrades(ACCOUNT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(String(result.value[0].orderId)).toBe('maker-order-ours');
    expect(result.value.some((s) => String(s.orderId) === 'maker-order-foreign')).toBe(false);
  });

  it('P0 регрессия: trade целиком без наших maker_orders (все чужие) → исключён полностью (0 результатов, НЕ 500 ошибка)', async () => {
    // Top-level owner остаётся OUR_OWNER_UUID (как реально было бы в ответе
    // L2-аутентифицированного /data/trades), но ЭТА конкретная maker_orders[]
    // запись принадлежит другому участнику матча (ни owner, ни maker_address
    // не совпадают) — именно это должно исключить её, а не top-level owner.
    const fill = makeMakerFill({
      maker_orders: [
        { order_id: 'maker-order-foreign', matched_amount: '999', price: '0.65', asset_id: '123456', side: 'BUY', owner: FOREIGN_OWNER_UUID, maker_address: FOREIGN_MAKER_ADDRESS },
      ],
    } as Partial<UserFillResponse>);
    const adapter = makeAdapter(makeUserTradesClient([fill]));
    const result = await adapter.getTrades(ACCOUNT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  it('MAKER trade без maker_orders (пустой массив) — исключён, без crash', async () => {
    const adapter = makeAdapter(makeUserTradesClient([makeMakerFill({ maker_orders: [] })]));
    const result = await adapter.getTrades(ACCOUNT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  it('TAKER trade маппится в один snapshot через taker_order_id (владение не проверяется — L2 auth уже наш trade)', async () => {
    const takerFill: UserFillResponse = {
      id: 'trade-2',
      trader_side: 'TAKER',
      taker_order_id: 'taker-order-x',
      market: 'market-1',
      asset_id: '123456',
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
      asset_id: '123456',
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
      asset_id: '123456',
      side: 'BUY',
      price: '0.5',
      size: '10',
      match_time: '1775457900',
    } as UserFillResponse;
    const adapter = makeAdapter(makeUserTradesClient([takerFill]));
    const result = await adapter.getTrades(ACCOUNT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0].status).toBeUndefined();
  });
});

describe('PolymarketExchangeClientAdapter.getTrades — completeness contract', () => {
  it('без _userTradesClient → Err (полноту гарантировать нельзя, НЕ молчаливый partial Ok)', async () => {
    const adapter = makeAdapter(undefined);
    const result = await adapter.getTrades(ACCOUNT_ID);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/no L2-authenticated user trades client/i);
  });

  it('requireCursor: true передаётся в getUserFills (schema drift становится Err выше по цепочке)', async () => {
    const userTradesClient = makeUserTradesClient([]);
    const adapter = makeAdapter(userTradesClient);
    await adapter.getTrades(ACCOUNT_ID);

    expect(userTradesClient.getUserFills).toHaveBeenCalledWith(
      expect.objectContaining({ requireCursor: true }),
    );
  });
});
