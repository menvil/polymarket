/**
 * Преобразования account plane: заявки, статусы сделок и — главное — ОДНА
 * canonical-идентичность исполнения для приватного WS и REST.
 *
 * @remarks
 * P0-регрессия: одна и та же сделка площадки, пришедшая приватным WS и
 * REST-ом (`listAccountTrades`), обязана дать один и тот же canonical `Fill`.
 * WS-событие здесь написано ВРУЧНУЮ в snake_case — так, как его отдаёт
 * user-channel и как его сегодня разбирает `FillEventHandler`; REST-сделка —
 * в camelCase-форме SDK. Общая между ними только сама сделка, а не код
 * построения фикстур: иначе тест проверял бы сам себя.
 *
 * REST-сделка несёт `feeRateBps: "0"` — так его реально отдаёт площадка.
 * Положительную ставку в REST-ответ не подставляем: комиссию тейкера
 * REST-путь берёт у резолвера ставки, а не из ответа.
 */
import { describe, expect, it } from '@jest/globals';
import { FillMapper, findFillFactDifference, type Fill, type TradeStatus } from '@polymarket/fill';
import { assetIdToString } from '@polymarket/ids';
import {
  mapPolymarketClobTrade,
  mapPolymarketOpenOrder,
  mapPolymarketOrderState,
  mapPolymarketTradeStatus,
  mergeAuthoritativeFills,
} from '../src/polymarketAccountMapping.js';
import { Ok } from '@polymarket/result';
import {
  ACCOUNT,
  CRYPTO_TAKER_FEE_RATE,
  FakeTakerFeeRates,
  MARKET_A,
  MATCHED_AT_SECONDS,
  NO_TOKEN_ID,
  OTHER_ADDRESS,
  OTHER_OWNER,
  OUR_ADDRESS,
  OUR_OWNER,
  TRADE_STATUS,
  YES_TOKEN_ID,
  clobTrade,
  openOrder,
  type ClobTradeOverrides,
} from './helpers/accountFixtures.js';

/**
 * Контекст нашего аккаунта для разбора сделок.
 *
 * @param takerFeeRates - Резолвер ставки (по умолчанию — crypto-ставка обоих рынков)
 * @returns Контекст `mapPolymarketClobTrade`
 */
function contextWith(takerFeeRates: FakeTakerFeeRates = new FakeTakerFeeRates()) {
  return { accountId: ACCOUNT, makerAddress: OUR_ADDRESS.toLowerCase(), takerFeeRates };
}

/** Контекст по умолчанию. */
const CONTEXT = contextWith();

describe('заявки: статус CLOB + sizeMatched → canonical', () => {
  it.each<[string, string, string, string]>([
    ['LIVE без исполнений', 'LIVE', '0', 'OPEN'],
    ['LIVE частично', 'LIVE', '4', 'PARTIALLY_FILLED'],
    ['MATCHED целиком', 'MATCHED', '10', 'FILLED'],
    ['CANCELED без исполнений', 'CANCELED', '0', 'CANCELED'],
    ['CANCELED после частичного', 'CANCELED', '4', 'CANCELED'],
    ['CANCELED_MARKET_RESOLVED', 'CANCELED_MARKET_RESOLVED', '4', 'CANCELED'],
  ])('%s → %s', (_label, status, sizeMatched, expected) => {
    const mapped = mapPolymarketOrderState(openOrder({ status, sizeMatched }));
    expect(mapped.ok && mapped.value.status).toBe(expected);
  });

  it.each<[string, Parameters<typeof openOrder>[0]]>([
    ['LIVE, но исполнена целиком', { status: 'LIVE', sizeMatched: '10' }],
    ['MATCHED, но не целиком', { status: 'MATCHED', sizeMatched: '4' }],
    ['CANCELED, но исполнена целиком', { status: 'CANCELED', sizeMatched: '10' }],
    ['INVALID — смысл не определён', { status: 'INVALID' }],
    ['статус в нижнем регистре', { status: 'live' }],
    ['DELAYED — статус размещения', { status: 'DELAYED' }],
    ['UNMATCHED — статус размещения', { status: 'UNMATCHED' }],
    ['пустой статус', { status: '' }],
    ['незнакомый статус', { status: 'PAUSED' }],
    ['исполнено больше объёма', { sizeMatched: '11' }],
    ['нулевой объём', { originalSize: '0' }],
    ['сторона в нижнем регистре', { side: 'buy' }],
    ['цена с экспонентой', { price: '4.2e-1' }],
    ['цена вне диапазона исхода', { price: '1.5' }],
    ['объём NaN', { originalSize: 'NaN' }],
    ['отрицательное исполнение', { sizeMatched: '-1' }],
    ['нечисловой token id', { tokenId: 'yes-token' }],
  ])('%s → Err', (_label, overrides) => {
    expect(mapPolymarketOrderState(openOrder(overrides)).ok).toBe(false);
  });

  it('ручная заявка без стратегических метаданных переводится полностью', () => {
    const mapped = mapPolymarketOrderState(openOrder({ id: '0xmanual', side: 'SELL', sizeMatched: '0' }));
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(Object.keys(mapped.value).sort()).toEqual(
      ['asset', 'filledSize', 'orderId', 'price', 'side', 'size', 'status'],
    );
    expect(mapped.value.orderId).toBe('0xmanual');
    expect(assetIdToString(mapped.value.asset)).toBe(`POLYMARKET_CTF_TOKEN:${YES_TOKEN_ID}`);
    expect(mapped.value.price.value().toString()).toBe('0.42');
  });

  it('список открытых принимает только LIVE: OPEN и PARTIALLY_FILLED', () => {
    const open = mapPolymarketOpenOrder(openOrder({ sizeMatched: '0' }));
    const partial = mapPolymarketOpenOrder(openOrder({ sizeMatched: '4' }));
    expect(open.ok && open.value.status).toBe('OPEN');
    expect(partial.ok && partial.value.status).toBe('PARTIALLY_FILLED');
  });

  it.each(['MATCHED', 'CANCELED', 'CANCELED_MARKET_RESOLVED', 'INVALID', 'PAUSED'])(
    'терминальный или незнакомый статус %s в списке открытых → Err, а не фильтр',
    (status) => {
      expect(mapPolymarketOpenOrder(openOrder({ status, sizeMatched: status === 'MATCHED' ? '10' : '0' })).ok).toBe(false);
    },
  );
});

describe('статус сделки: явная таблица, без угадывания', () => {
  it.each<[string, TradeStatus]>([
    [TRADE_STATUS.Matched, 'MATCHED'],
    [TRADE_STATUS.Mined, 'MINED'],
    [TRADE_STATUS.Confirmed, 'CONFIRMED'],
    [TRADE_STATUS.Retrying, 'RETRYING'],
    [TRADE_STATUS.Failed, 'FAILED'],
  ])('%s → %s', (raw, expected) => {
    expect(mapPolymarketTradeStatus(raw)).toEqual({ ok: true, value: expected });
  });

  it.each<[string, unknown]>([
    ['MATCHED_NOT_BROADCASTED — решения ещё нет', TRADE_STATUS.MatchedNotBroadcasted],
    ['без префикса', 'MATCHED'],
    ['пустой', ''],
    ['undefined', undefined],
    ['незнакомый', 'TRADE_STATUS_SETTLED'],
  ])('%s → Err', (_label, raw) => {
    expect(mapPolymarketTradeStatus(raw).ok).toBe(false);
  });

  it.each<[string, TradeStatus]>([
    [TRADE_STATUS.Matched, 'MATCHED'],
    [TRADE_STATUS.Mined, 'MINED'],
    [TRADE_STATUS.Confirmed, 'CONFIRMED'],
    [TRADE_STATUS.Retrying, 'RETRYING'],
    [TRADE_STATUS.Failed, 'FAILED'],
  ])('сделка со статусом %s сохраняется — включая нефинальные и FAILED', (status, expected) => {
    const fills = mapPolymarketClobTrade(clobTrade({ status }), CONTEXT);
    expect(fills.ok && fills.value.map((fill) => fill.metadata.tradeStatus)).toEqual([expected]);
  });

  it('сделка с MATCHED_NOT_BROADCASTED → Err, а не выброшена и не MATCHED', () => {
    expect(mapPolymarketClobTrade(clobTrade({ status: TRADE_STATUS.MatchedNotBroadcasted }), CONTEXT).ok).toBe(false);
  });
});

/**
 * Одна сделка площадки в двух формах: snake_case WS и camelCase REST.
 *
 * @remarks
 * `wsOwner` — owner верхнего уровня, как его присылает WS: наш ключ для
 * прямой сделки, ключ тейкера — для cross-outcome.
 */
interface Execution {
  readonly rest: ClobTradeOverrides;
  readonly ws: Record<string, unknown>;
}

/**
 * Наша TAKER-покупка 10 YES @ 0.57. WS несёт положительный `fee_rate_bps`,
 * REST — `"0"`, как его отдаёт площадка.
 */
const TAKER: Execution = {
  rest: {
    id: 'trade-taker',
    traderSide: 'TAKER',
    takerOrderId: '0xour-taker-order',
    tokenId: YES_TOKEN_ID,
    side: 'BUY',
    price: '0.57',
    size: '10',
    feeRateBps: '0',
    makerOrders: [
      { orderId: '0xother', tokenId: YES_TOKEN_ID, side: 'SELL', price: '0.57', matchedAmount: '10', makerAddress: OTHER_ADDRESS, owner: OTHER_OWNER },
    ],
  },
  ws: {
    event_type: 'trade',
    type: 'TRADE',
    id: 'trade-taker',
    taker_order_id: '0xour-taker-order',
    trader_side: 'TAKER',
    market: MARKET_A,
    asset_id: YES_TOKEN_ID,
    side: 'BUY',
    price: '0.57',
    size: '10',
    fee_rate_bps: '1000',
    status: 'MATCHED',
    owner: OUR_OWNER,
    maker_address: OUR_ADDRESS,
    maker_orders: [
      { order_id: '0xother', asset_id: YES_TOKEN_ID, side: 'SELL', price: '0.57', matched_amount: '10', maker_address: OTHER_ADDRESS, owner: OTHER_OWNER },
    ],
    match_time: String(MATCHED_AT_SECONDS),
    timestamp: String(MATCHED_AT_SECONDS),
    transaction_hash: '0xdeadbeef',
  },
};

/** Наша единственная maker-заявка BUY 5 YES @ 0.43 в прямой сделке. */
const SINGLE_MAKER: Execution = {
  rest: {
    id: 'trade-maker',
    traderSide: 'MAKER',
    takerOrderId: '0xother-taker',
    tokenId: YES_TOKEN_ID,
    side: 'SELL',
    price: '0.43',
    size: '8',
    makerOrders: [
      { orderId: '0xour-maker', tokenId: YES_TOKEN_ID, side: 'BUY', price: '0.43', matchedAmount: '5', makerAddress: OUR_ADDRESS, owner: OUR_OWNER },
      { orderId: '0xother-maker', tokenId: YES_TOKEN_ID, side: 'BUY', price: '0.43', matchedAmount: '3', makerAddress: OTHER_ADDRESS, owner: OTHER_OWNER },
    ],
  },
  ws: {
    event_type: 'trade',
    type: 'TRADE',
    id: 'trade-maker',
    taker_order_id: '0xother-taker',
    trader_side: 'MAKER',
    market: MARKET_A,
    asset_id: YES_TOKEN_ID,
    side: 'SELL',
    price: '0.43',
    size: '8',
    fee_rate_bps: '0',
    status: 'MATCHED',
    owner: OUR_OWNER,
    maker_address: OUR_ADDRESS,
    maker_orders: [
      { order_id: '0xour-maker', asset_id: YES_TOKEN_ID, side: 'BUY', price: '0.43', matched_amount: '5', maker_address: OUR_ADDRESS, owner: OUR_OWNER },
      { order_id: '0xother-maker', asset_id: YES_TOKEN_ID, side: 'BUY', price: '0.43', matched_amount: '3', maker_address: OTHER_ADDRESS, owner: OTHER_OWNER },
    ],
    match_time: String(MATCHED_AT_SECONDS),
    timestamp: String(MATCHED_AT_SECONDS),
    transaction_hash: '0xdeadbeef',
  },
};

/** Две наши maker-заявки в одной сделке. */
const MULTI_MAKER: Execution = {
  rest: {
    id: 'trade-multi',
    traderSide: 'MAKER',
    takerOrderId: '0xother-taker',
    tokenId: YES_TOKEN_ID,
    side: 'SELL',
    price: '0.43',
    size: '7',
    makerOrders: [
      { orderId: '0xour-1', tokenId: YES_TOKEN_ID, side: 'BUY', price: '0.43', matchedAmount: '4', makerAddress: OUR_ADDRESS, owner: OUR_OWNER },
      { orderId: '0xour-2', tokenId: YES_TOKEN_ID, side: 'BUY', price: '0.44', matchedAmount: '3', makerAddress: OUR_ADDRESS, owner: OUR_OWNER },
    ],
  },
  ws: {
    event_type: 'trade',
    type: 'TRADE',
    id: 'trade-multi',
    taker_order_id: '0xother-taker',
    trader_side: 'MAKER',
    market: MARKET_A,
    asset_id: YES_TOKEN_ID,
    side: 'SELL',
    price: '0.43',
    size: '7',
    fee_rate_bps: '0',
    status: 'MATCHED',
    owner: OUR_OWNER,
    maker_address: OUR_ADDRESS,
    maker_orders: [
      { order_id: '0xour-1', asset_id: YES_TOKEN_ID, side: 'BUY', price: '0.43', matched_amount: '4', maker_address: OUR_ADDRESS, owner: OUR_OWNER },
      { order_id: '0xour-2', asset_id: YES_TOKEN_ID, side: 'BUY', price: '0.44', matched_amount: '3', maker_address: OUR_ADDRESS, owner: OUR_OWNER },
    ],
    match_time: String(MATCHED_AT_SECONDS),
    timestamp: String(MATCHED_AT_SECONDS),
    transaction_hash: '0xdeadbeef',
  },
};

/**
 * Cross-outcome (mint): тейкер покупает YES @ 0.6, наша maker-заявка
 * покупает NO @ 0.4. Верхний уровень — тейкерский (YES, BUY, его owner).
 */
const CROSS_OUTCOME_MAKER: Execution = {
  rest: {
    id: 'trade-cross',
    traderSide: 'MAKER',
    owner: OTHER_OWNER,
    takerOrderId: '0xother-taker',
    tokenId: YES_TOKEN_ID,
    side: 'BUY',
    price: '0.6',
    size: '10',
    makerOrders: [
      { orderId: '0xour-no', tokenId: NO_TOKEN_ID, side: 'BUY', price: '0.4', matchedAmount: '10', makerAddress: OUR_ADDRESS, owner: OUR_OWNER, outcome: 'No' },
    ],
  },
  ws: {
    event_type: 'trade',
    type: 'TRADE',
    id: 'trade-cross',
    taker_order_id: '0xother-taker',
    trader_side: 'MAKER',
    market: MARKET_A,
    asset_id: YES_TOKEN_ID,
    side: 'BUY',
    price: '0.6',
    size: '10',
    fee_rate_bps: '0',
    status: 'MATCHED',
    owner: OTHER_OWNER,
    maker_address: OUR_ADDRESS,
    maker_orders: [
      { order_id: '0xour-no', asset_id: NO_TOKEN_ID, side: 'BUY', price: '0.4', matched_amount: '10', maker_address: OUR_ADDRESS, owner: OUR_OWNER, outcome: 'No' },
    ],
    match_time: String(MATCHED_AT_SECONDS),
    timestamp: String(MATCHED_AT_SECONDS),
    transaction_hash: '0xdeadbeef',
  },
};

/**
 * Исполнения одной сделки обоими путями.
 *
 * @param execution - Сделка в двух формах
 * @returns Исполнения WS-пути и REST-пути
 */
function bothPaths(execution: Execution): { ws: { fill: Fill; liquidity?: string }[]; rest: { fill: Fill; liquidity?: string }[] } {
  const ws = FillMapper.allFromPolymarketTradeEvent(execution.ws, ACCOUNT);
  if (!ws.ok) throw ws.error;
  const rest = mapPolymarketClobTrade(clobTrade(execution.rest), CONTEXT);
  if (!rest.ok) throw rest.error;
  return {
    ws: ws.value.map(({ fill, metadata }) => ({ fill, liquidity: metadata.liquidity })),
    rest: rest.value.map(({ fill, metadata }) => ({ fill, liquidity: metadata.liquidity })),
  };
}

/** Поля, которые сравниваются явно (плюс полный факт через findFillFactDifference). */
function identity(entry: { fill: Fill; liquidity?: string }) {
  const { fill } = entry;
  return {
    id: String(fill.id),
    orderId: String(fill.orderId),
    marketId: String(fill.marketId),
    tokenId: assetIdToString(fill.tokenId),
    side: fill.side,
    size: fill.size.value().toString(),
    price: fill.price.value().toString(),
    liquidity: entry.liquidity,
    timestamp: fill.timestamp.toNumber(),
  };
}

describe('P0: REST ClobTrade и приватный WS дают ОДИН canonical Fill', () => {
  it.each<[string, Execution, string[]]>([
    ['TAKER', TAKER, ['trade-taker']],
    ['один наш MAKER', SINGLE_MAKER, ['trade-maker']],
    ['несколько наших MAKER', MULTI_MAKER, ['trade-multi:0xour-1', 'trade-multi:0xour-2']],
    ['cross-outcome MAKER', CROSS_OUTCOME_MAKER, ['trade-cross']],
  ])('%s', (_label, execution, expectedIds) => {
    const { ws, rest } = bothPaths(execution);

    expect(rest.map((entry) => String(entry.fill.id))).toEqual(expectedIds);
    expect(rest.map(identity)).toEqual(ws.map(identity));
    // Полный факт — тем же canonical-сравнением, что применяет приватное состояние.
    for (const [index, entry] of rest.entries()) {
      expect(findFillFactDifference(ws[index]!.fill, entry.fill)).toBeUndefined();
    }
  });

  it('cross-outcome: наш токен, сторона, цена и объём — из нашей maker-записи, а не тейкерские', () => {
    const { rest } = bothPaths(CROSS_OUTCOME_MAKER);
    expect(rest.map(identity)).toEqual([
      expect.objectContaining({
        orderId: '0xour-no',
        tokenId: `POLYMARKET_CTF_TOKEN:${NO_TOKEN_ID}`,
        side: 'BUY',
        price: '0.4',
        size: '10',
        liquidity: 'MAKER',
      }),
    ]);
  });

  it('TAKER-комиссия считается одинаково обоими путями', () => {
    const { ws, rest } = bothPaths(TAKER);
    expect(rest[0]!.fill.fee.equals(ws[0]!.fill.fee)).toBe(true);
    expect(rest[0]!.fill.fee.isZero()).toBe(false);
  });

  it('время исполнения — match time: WS-путь обязан брать в timestamp именно его', () => {
    // Если WS-адаптер подставит время СООБЩЕНИЯ (более позднее), факт
    // разойдётся по timestamp — это требование к приватному WS-пути.
    const delayedWs = { ...TAKER.ws, timestamp: String(MATCHED_AT_SECONDS + 30) };
    const ws = FillMapper.allFromPolymarketTradeEvent(delayedWs, ACCOUNT);
    const rest = mapPolymarketClobTrade(clobTrade(TAKER.rest), CONTEXT);
    if (!ws.ok || !rest.ok) throw new Error('unexpected mapping failure');
    expect(findFillFactDifference(ws.value[0]!.fill, rest.value[0]!.fill)?.field).toBe('timestamp');
  });
});

/** Комиссия исполнения в USDC числом. */
function feeOf(fill: Fill): number {
  return fill.fee.quantity.amount().value().toNumber();
}

describe('комиссия TAKER: ставка от резолвера, а не из feeRateBps REST-ответа', () => {
  it('P0: WS fee_rate_bps > 0 и REST feeRateBps "0" + crypto-ставка резолвера → тот же FillId и тот же факт', () => {
    expect(TAKER.ws['fee_rate_bps']).toBe('1000');
    expect(clobTrade(TAKER.rest).feeRateBps).toBe('0');

    const ws = FillMapper.allFromPolymarketTradeEvent(TAKER.ws, ACCOUNT);
    const rest = mapPolymarketClobTrade(clobTrade(TAKER.rest), CONTEXT);
    if (!ws.ok || !rest.ok) throw new Error('unexpected mapping failure');

    expect(String(rest.value[0]!.fill.id)).toBe(String(ws.value[0]!.fill.id));
    expect(findFillFactDifference(ws.value[0]!.fill, rest.value[0]!.fill)).toBeUndefined();
  });

  it('TAKER-исполнение несёт комиссию по формуле size × rate × p × (1 − p)', () => {
    const rest = mapPolymarketClobTrade(clobTrade(TAKER.rest), CONTEXT);
    if (!rest.ok) throw rest.error;
    // 10 × 0.07 × 0.57 × 0.43 = 0.17157
    expect(feeOf(rest.value[0]!.fill)).toBeCloseTo(0.17157, 8);
  });

  it('feeRateBps ответа на комиссию не влияет: "0", "1000" и "250" дают одну и ту же комиссию', () => {
    const fees = ['0', '1000', '250'].map((feeRateBps) => {
      const rest = mapPolymarketClobTrade(clobTrade({ ...TAKER.rest, feeRateBps }), CONTEXT);
      if (!rest.ok) throw rest.error;
      return feeOf(rest.value[0]!.fill);
    });
    expect(new Set(fees).size).toBe(1);
    expect(fees[0]).toBeCloseTo(0.17157, 8);
  });

  it('комиссию задаёт ставка резолвера: другая ставка — другая комиссия, нулевая — без комиссии', () => {
    const rates = new FakeTakerFeeRates();
    rates.rates.set(String(MARKET_A).toLowerCase(), Ok(CRYPTO_TAKER_FEE_RATE / 2));
    const halved = mapPolymarketClobTrade(clobTrade(TAKER.rest), contextWith(rates));
    if (!halved.ok) throw halved.error;
    // 10 × 0.035 × 0.57 × 0.43 = 0.085785 → 0.08579 (5 знаков, half-up)
    expect(feeOf(halved.value[0]!.fill)).toBeCloseTo(0.08579, 8);

    rates.rates.set(String(MARKET_A).toLowerCase(), Ok(0));
    const free = mapPolymarketClobTrade(clobTrade(TAKER.rest), contextWith(rates));
    if (!free.ok) throw free.error;
    expect(free.value[0]!.fill.fee.isZero()).toBe(true);
  });

  it('ставка запрашивается по рынку TAKER-сделки', () => {
    const rates = new FakeTakerFeeRates();
    const rest = mapPolymarketClobTrade(clobTrade(TAKER.rest), contextWith(rates));
    expect(rest.ok).toBe(true);
    expect(rates.calls).toEqual([MARKET_A]);
  });

  it.each<[string, Execution]>([
    ['один наш MAKER', SINGLE_MAKER],
    ['несколько наших MAKER', MULTI_MAKER],
    ['cross-outcome MAKER', CROSS_OUTCOME_MAKER],
  ])('%s: комиссия ноль, ставка не запрашивается', (_label, execution) => {
    const rates = new FakeTakerFeeRates();
    const rest = mapPolymarketClobTrade(clobTrade(execution.rest), contextWith(rates));
    if (!rest.ok) throw rest.error;
    expect(rest.value.length).toBeGreaterThan(0);
    for (const { fill } of rest.value) expect(fill.fee.isZero()).toBe(true);
    expect(rates.calls).toEqual([]);
  });

  it('multi-maker сохраняет идентичность tradeId:orderId и при резолвере ставки', () => {
    const rest = mapPolymarketClobTrade(clobTrade(MULTI_MAKER.rest), CONTEXT);
    if (!rest.ok) throw rest.error;
    expect(rest.value.map(({ fill }) => String(fill.id))).toEqual(['trade-multi:0xour-1', 'trade-multi:0xour-2']);
  });

  it('отказ резолвера → Err сделки, а не нулевая комиссия', () => {
    const rates = new FakeTakerFeeRates();
    rates.rates.delete(String(MARKET_A).toLowerCase());
    const rest = mapPolymarketClobTrade(clobTrade(TAKER.rest), contextWith(rates));
    expect(rest.ok).toBe(false);
    if (!rest.ok) expect(rest.error.message).toContain('taker fee rate is unknown');
  });
});

describe('владение сделкой: только наш адрес, без отката на чужой верхний уровень', () => {
  it('MAKER-сделка без нашей maker-записи → Err, даже если owner верхнего уровня совпадает с чужой записью', () => {
    const trade = clobTrade({
      traderSide: 'MAKER',
      owner: OTHER_OWNER,
      makerOrders: [
        { orderId: '0xother', tokenId: YES_TOKEN_ID, side: 'BUY', price: '0.5', matchedAmount: '5', makerAddress: OTHER_ADDRESS, owner: OTHER_OWNER },
      ],
    });
    const fills = mapPolymarketClobTrade(trade, CONTEXT);
    expect(fills.ok).toBe(false);
  });

  it('адрес сравнивается без учёта регистра', () => {
    const fills = mapPolymarketClobTrade(clobTrade(SINGLE_MAKER.rest), {
      ...CONTEXT,
      makerAddress: OUR_ADDRESS.toUpperCase().replace('0X', '0x'),
    });
    expect(fills.ok && fills.value.map((fill) => String(fill.fill.orderId))).toEqual(['0xour-maker']);
  });

  it('TAKER-сделка, где наш адрес есть и среди maker-записей (self-match) → Err', () => {
    const trade = clobTrade({
      traderSide: 'TAKER',
      makerOrders: [
        { orderId: '0xour-resting', tokenId: YES_TOKEN_ID, side: 'SELL', price: '0.57', matchedAmount: '10', makerAddress: OUR_ADDRESS, owner: OUR_OWNER },
      ],
    });
    expect(mapPolymarketClobTrade(trade, CONTEXT).ok).toBe(false);
  });

  it('исполнения принадлежат настроенному аккаунту и площадке POLYMARKET', () => {
    const fills = mapPolymarketClobTrade(clobTrade(TAKER.rest), CONTEXT);
    expect(fills.ok).toBe(true);
    if (!fills.ok) return;
    expect(String(fills.value[0]!.fill.venueId)).toBe('POLYMARKET');
    expect(fills.value[0]!.fill.accountId).toEqual(ACCOUNT);
  });
});

describe('слияние повторов', () => {
  it('тот же факт и те же метаданные — одна запись', () => {
    const once = mapPolymarketClobTrade(clobTrade(TAKER.rest), CONTEXT);
    if (!once.ok) throw once.error;
    const merged = mergeAuthoritativeFills([...once.value, ...once.value]);
    expect(merged.ok && merged.value).toHaveLength(1);
  });

  it('тот же FillId с другим фактом → Err', () => {
    const first = mapPolymarketClobTrade(clobTrade(TAKER.rest), CONTEXT);
    const second = mapPolymarketClobTrade(clobTrade({ ...TAKER.rest, size: '11' }), CONTEXT);
    if (!first.ok || !second.ok) throw new Error('unexpected mapping failure');
    expect(mergeAuthoritativeFills([...first.value, ...second.value]).ok).toBe(false);
  });

  it('тот же факт с другим статусом площадки → Err (какой новее, отсюда не видно)', () => {
    const matched = mapPolymarketClobTrade(clobTrade(TAKER.rest), CONTEXT);
    const confirmed = mapPolymarketClobTrade(
      clobTrade({ ...TAKER.rest, status: TRADE_STATUS.Confirmed }),
      CONTEXT,
    );
    if (!matched.ok || !confirmed.ok) throw new Error('unexpected mapping failure');
    expect(mergeAuthoritativeFills([...matched.value, ...confirmed.value]).ok).toBe(false);
  });
});
