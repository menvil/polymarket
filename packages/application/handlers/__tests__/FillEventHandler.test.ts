import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Err, Ok, type Result } from '@polymarket/result';
import { FillEventHandler } from '../src/FillEventHandler.js';
import type { IEventBus } from '@polymarket/event-bus';
import type { IClock } from '@polymarket/time';
import type { ILogger } from '@polymarket/logger';
import type { AccountId, MarketId } from '@polymarket/ids';
import { accountIdFromWallet, parseWalletAddress, unsafeRunId } from '@polymarket/ids';
import {
  FillMapper,
  calculatePolymarketTakerFeeWithRate,
  findFillFactDifference,
  type Fill,
  type PolymarketTakerFeeRateResolver,
} from '@polymarket/fill';
import type { Timestamp } from '@polymarket/timestamp';
import { MessageMetadataGenerator } from '@polymarket/messages';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): ILogger {
  return {
    trace: jest.fn() as ILogger['trace'],
    debug: jest.fn() as ILogger['debug'],
    info: jest.fn() as ILogger['info'],
    warn: jest.fn() as ILogger['warn'],
    error: jest.fn() as ILogger['error'],
    fatal: jest.fn() as ILogger['fatal'],
    child: jest.fn() as ILogger['child'],
  };
}

function makeEventBus(): IEventBus {
  return {
    publish: jest.fn<IEventBus['publish']>().mockResolvedValue(Ok(undefined)),
    publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(Ok(undefined)),
    publishConfirmed: jest.fn<IEventBus['publishConfirmed']>().mockResolvedValue(Ok(undefined)),
    subscribe: jest.fn() as IEventBus['subscribe'],
  };
}

/**
 * Настоящий canonical AccountId: `findFillFactDifference` сравнивает и аккаунт,
 * а строка-заглушка не разбирается как AccountId.
 */
const ACCOUNT_ID: AccountId = (() => {
  const wallet = parseWalletAddress('0x1234567890abcdef1234567890abcdef12345678');
  if (!wallet) throw new Error('Test setup: invalid wallet address');
  return accountIdFromWallet(wallet);
})();

/** Рынок фикстур — condition id исполнения (`raw.market`). */
const MARKET = 'market-abc';

/** Crypto-ставка taker-комиссии (`POLYMARKET_CRYPTO_TAKER_FEE_RATE`). */
const CRYPTO_TAKER_FEE_RATE = 0.07;

/**
 * Резолвер ставки taker-комиссии со счётчиком вызовов.
 *
 * @remarks
 * Рынок без записи — отказ, как у настоящего `PolymarketStaticTakerFeeRateResolver`.
 */
class FakeTakerFeeRates implements PolymarketTakerFeeRateResolver {
  /** Рынки, для которых запрашивалась ставка, в порядке запросов */
  public readonly calls: string[] = [];
  /** Ответ по рынку */
  public readonly rates = new Map<string, Result<number, Error>>([[MARKET, Ok(CRYPTO_TAKER_FEE_RATE)]]);

  /** {@inheritDoc PolymarketTakerFeeRateResolver.getTakerFeeRate} */
  public getTakerFeeRate(marketId: MarketId): Result<number, Error> {
    this.calls.push(String(marketId));
    return this.rates.get(String(marketId)) ?? Err(new Error(`taker fee rate is unknown for market ${marketId}`));
  }
}

// Минимальный валидный raw payload из Polymarket WS user-channel (формат TAKER-события)
function makeValidRaw(): Record<string, unknown> {
  return {
    id: 'fill-001',
    taker_order_id: 'order-999',
    trader_side: 'TAKER',        // 'TAKER' | 'MAKER', не сторона сделки
    market: MARKET,              // condition id: по нему FillMapper → marketId, резолвер → ставка
    asset_id: '12345',           // числовой ERC1155 tokenId — parseAssetId принимает /^\d+$/
    side: 'BUY',                 // сторона ТЕЙКЕРА: 'BUY' | 'SELL'
    price: '0.65',
    size: '100',
    fee_rate_bps: '0',           // диагностика: комиссию TAKER задаёт резолвер по market
    status: 'MATCHED',
    match_time: '1672290700',    // Unix секунды: момент исполнения → Fill.timestamp
    timestamp: '1672290701',     // время СООБЩЕНИЯ: в Fill.timestamp не попадает никогда
    transaction_hash: '0xdeadbeef',
    maker_orders: [],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FillEventHandler', () => {
  let eventBus: IEventBus;
  let clock: IClock;
  let logger: ILogger;
  let takerFeeRates: FakeTakerFeeRates;
  let handler: FillEventHandler;

  beforeEach(() => {
    eventBus = makeEventBus();
    clock = { now: jest.fn<() => Date>().mockReturnValue(new Date('2024-01-01T00:00:00.000Z')) };
    logger = makeLogger();
    takerFeeRates = new FakeTakerFeeRates();
    handler = new FillEventHandler(
      eventBus,
      new MessageMetadataGenerator({ clock, runId: unsafeRunId('testrun1') }),
      clock,
      logger,
      takerFeeRates,
    );
  });

  // ── MATCHED → немедленная публикация ──────────────────────────────────────

  it('MATCHED: парсит fill и публикует FILL_RECEIVED немедленно', async () => {
    const raw = makeValidRaw(); // status: 'MATCHED'
    const mapResult = FillMapper.fromPolymarketTradeEvent(raw, ACCOUNT_ID);
    expect(mapResult.ok).toBe(true);

    await handler.handle(raw, ACCOUNT_ID);

    expect(eventBus.publish).toHaveBeenCalledTimes(1);
    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'FILL_RECEIVED',
        payload: expect.objectContaining({
          fill: expect.objectContaining({ id: 'fill-001' }),
        }),
        metadata: expect.objectContaining({ sequence: expect.any(Number) }),
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Fill published on MATCHED (early processing)',
      expect.any(Object),
    );
  });

  // ── MINED → no-op (fill уже обработан при MATCHED) ──────────────────────

  it('MINED после MATCHED: логирует debug, НЕ публикует повторно', async () => {
    await handler.handle(makeValidRaw(), ACCOUNT_ID);
    expect(eventBus.publish).toHaveBeenCalledTimes(1); // MATCHED опубликовал

    (eventBus.publish as ReturnType<typeof jest.fn>).mockClear();

    await handler.handle({ id: 'fill-001', status: 'MINED' }, ACCOUNT_ID);

    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      'Fill MINED — already processed at MATCHED, waiting for CONFIRMED',
      expect.objectContaining({ rawId: 'fill-001' }),
    );
  });

  // ── CONFIRMED после MATCHED → публикует FILL_CONFIRMED ──────────────────

  it('MATCHED → MINED → CONFIRMED: публикует FILL_RECEIVED + FILL_CONFIRMED', async () => {
    await handler.handle(makeValidRaw(), ACCOUNT_ID);
    await handler.handle({ id: 'fill-001', status: 'MINED' }, ACCOUNT_ID);
    await handler.handle({ id: 'fill-001', status: 'CONFIRMED' }, ACCOUNT_ID);

    expect(eventBus.publish).toHaveBeenCalledTimes(2);
    expect(eventBus.publish).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ type: 'FILL_RECEIVED' }),
    );
    expect(eventBus.publish).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ type: 'FILL_CONFIRMED' }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'Fill CONFIRMED — on-chain finality, FILL_CONFIRMED published',
      expect.objectContaining({ rawId: 'fill-001' }),
    );
  });

  it('CONFIRMED после MATCHED: публикует FILL_CONFIRMED (не FILL_RECEIVED)', async () => {
    await handler.handle(makeValidRaw(), ACCOUNT_ID);
    expect(eventBus.publish).toHaveBeenCalledTimes(1);

    (eventBus.publish as ReturnType<typeof jest.fn>).mockClear();
    await handler.handle({ id: 'fill-001', status: 'CONFIRMED' }, ACCOUNT_ID);

    expect(eventBus.publish).toHaveBeenCalledTimes(1);
    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'FILL_CONFIRMED' }),
    );
  });

  // ── CONFIRMED без MATCHED → fallback публикация ──────────────────────────

  it('CONFIRMED без предшествующего MATCHED (рестарт бота): парсит fallback и публикует', async () => {
    const raw = { ...makeValidRaw(), status: 'CONFIRMED' };
    await handler.handle(raw, ACCOUNT_ID);

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'FILL_RECEIVED' }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Fill CONFIRMED without prior MATCHED — fallback publish',
      expect.objectContaining({ rawId: 'fill-001' }),
    );
  });

  // ── Дедупликация: MATCHED → CONFIRMED → CONFIRMED ───────────────────────

  it('MATCHED → CONFIRMED → CONFIRMED: публикует FILL_RECEIVED + FILL_CONFIRMED, второй CONFIRMED — fallback', async () => {
    await handler.handle(makeValidRaw(), ACCOUNT_ID);
    // Первый CONFIRMED → FILL_CONFIRMED (fills в кеше)
    await handler.handle({ id: 'fill-001', status: 'CONFIRMED' }, ACCOUNT_ID);
    // Второй CONFIRMED → rawId в publishedRawIds → FILL_CONFIRMED (но _pendingFills уже удалён → нет fills)
    await handler.handle({ ...makeValidRaw(), status: 'CONFIRMED' }, ACCOUNT_ID);

    // 1: FILL_RECEIVED (MATCHED), 2: FILL_CONFIRMED (1st CONFIRMED), 3: нет fills → нет publish
    expect(eventBus.publish).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenCalledWith(
      'Fill CONFIRMED — on-chain finality, FILL_CONFIRMED published',
      expect.objectContaining({ rawId: 'fill-001' }),
    );
  });

  // ── Ошибки парсинга ──────────────────────────────────────────────────────

  it('логирует error и не публикует при невалидном raw (MATCHED)', async () => {
    const raw = { id: 'bad-fill', status: 'MATCHED' }; // невалидный payload

    const mapResult = FillMapper.fromPolymarketTradeEvent(raw, ACCOUNT_ID);
    expect(mapResult.ok).toBe(false);

    await handler.handle(raw, ACCOUNT_ID);

    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to parse fill event',
      expect.any(Object),
    );
  });

  // ── MINED без MATCHED ───────────────────────────────────────────────────

  it('MINED без предшествующего MATCHED: debug-лог, НЕ публикует', async () => {
    const raw = { ...makeValidRaw(), status: 'MINED' };
    await handler.handle(raw, ACCOUNT_ID);

    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      'Fill MINED — already processed at MATCHED, waiting for CONFIRMED',
      expect.any(Object),
    );
  });

  it('MINED без кеша и с невалидным payload: debug-лог, НЕ пытается парсить', async () => {
    await handler.handle({ id: 'fill-001', status: 'MINED' }, ACCOUNT_ID);

    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      'Fill MINED — already processed at MATCHED, waiting for CONFIRMED',
      expect.any(Object),
    );
  });

  // ── RETRYING ────────────────────────────────────────────────────────────

  it('игнорирует fill со статусом RETRYING', async () => {
    const raw = { ...makeValidRaw(), status: 'RETRYING' };

    await handler.handle(raw, ACCOUNT_ID);

    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  // ── FAILED ──────────────────────────────────────────────────────────────

  it('публикует FILL_FAILED при статусе FAILED', async () => {
    const raw = { ...makeValidRaw(), status: 'FAILED' };

    await handler.handle(raw, ACCOUNT_ID);

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'FILL_FAILED',
        payload: expect.objectContaining({
          fillId: 'fill-001',
          orderId: 'order-999',
        }),
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Fill failed event published',
      expect.any(Object),
    );
  });

  it('MATCHED → FAILED: публикует FILL_FAILED с кэшированными fills для отката', async () => {
    // MATCHED → parse & publish & cache
    await handler.handle(makeValidRaw(), ACCOUNT_ID);
    expect(eventBus.publish).toHaveBeenCalledTimes(1);

    // FAILED → достаёт fills из кеша, прикрепляет к событию
    await handler.handle({ ...makeValidRaw(), status: 'FAILED' }, ACCOUNT_ID);

    expect(eventBus.publish).toHaveBeenCalledTimes(2);
    const failedCall = (eventBus.publish as ReturnType<typeof jest.fn>).mock.calls[1][0];
    expect(failedCall.type).toBe('FILL_FAILED');
    expect(failedCall.payload.fills).toBeDefined();
    expect(failedCall.payload.fills.length).toBeGreaterThan(0);
  });

  // ── Граничные случаи для rawId и orderId ──────────────────────────────

  it('логирует rawId из raw["id"] при ошибке парсинга', async () => {
    const raw = { id: 'fill-bad-123', status: 'MATCHED' };

    const mapResult = FillMapper.fromPolymarketTradeEvent(raw, ACCOUNT_ID);
    expect(mapResult.ok).toBe(false);

    await handler.handle(raw, ACCOUNT_ID);

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to parse fill event',
      expect.objectContaining({ rawId: 'fill-bad-123' }),
    );
  });

  it('использует "unknown" как rawId если raw["id"] не строка', async () => {
    const raw = { id: 42, status: 'MATCHED' }; // id не строка

    const mapResult = FillMapper.fromPolymarketTradeEvent(raw, ACCOUNT_ID);
    expect(mapResult.ok).toBe(false);

    await handler.handle(raw, ACCOUNT_ID);

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to parse fill event',
      expect.objectContaining({ rawId: 'unknown' }),
    );
  });

  it('FAILED с пустым id — логирует warn и не публикует FILL_FAILED', async () => {
    // asFillId('') возвращает undefined → ранний возврат без публикации
    await handler.handle({ id: '', status: 'FAILED', taker_order_id: 'order-999' }, ACCOUNT_ID);

    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed fill has unparseable fillId, skipping FILL_FAILED event',
      expect.any(Object),
    );
  });

  it('FAILED с taker_order_id не строкой (число) — warn, нет публикации', async () => {
    await handler.handle({ id: 'fill-001', status: 'FAILED', taker_order_id: 123 }, ACCOUNT_ID);

    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed fill has unparseable orderId, skipping FILL_FAILED event',
      expect.any(Object),
    );
  });

  it('FAILED с пустым taker_order_id — логирует warn и не публикует FILL_FAILED', async () => {
    await handler.handle({ id: 'fill-001', status: 'FAILED', taker_order_id: '' }, ACCOUNT_ID);

    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed fill has unparseable orderId, skipping FILL_FAILED event',
      expect.any(Object),
    );
  });

  it('статус не строка — трактуется как UNKNOWN, trace-лог, нет публикации', async () => {
    await handler.handle({ status: 42 }, ACCOUNT_ID);

    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(logger.trace).toHaveBeenCalledWith(
      'Fill event ignored (non-primary status)',
      expect.objectContaining({ status: 'UNKNOWN' }),
    );
  });

  // ── Невалидный clock ───────────────────────────────────────────────────

  it('MATCHED: не публикует если TimestampService не может создать timestamp', async () => {
    const badClock: IClock = {
      now: jest.fn<() => Date>().mockReturnValue(new Date('invalid')),
    };
    const handlerBadClock = new FillEventHandler(
      eventBus,
      new MessageMetadataGenerator({ clock: badClock, runId: unsafeRunId('testrun1') }),
      badClock,
      logger,
      takerFeeRates,
    );

    await handlerBadClock.handle(makeValidRaw(), ACCOUNT_ID);

    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to create receivedAt timestamp',
      expect.any(Object),
    );
  });

  it('FAILED: не публикует FILL_FAILED если clock возвращает невалидную дату', async () => {
    const badClock: IClock = {
      now: jest.fn<() => Date>().mockReturnValue(new Date('invalid')),
    };
    const handlerBadClock = new FillEventHandler(
      eventBus,
      new MessageMetadataGenerator({ clock: badClock, runId: unsafeRunId('testrun1') }),
      badClock,
      logger,
      takerFeeRates,
    );

    await handlerBadClock.handle(
      { id: 'fill-001', status: 'FAILED', taker_order_id: 'order-999' },
      ACCOUNT_ID,
    );

    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to create receivedAt timestamp for failed fill',
      expect.any(Object),
    );
  });

  // ── Факт исполнения: время — match_time/matchtime, комиссия TAKER — резолвер

  describe('факт исполнения: тот же, что у REST (время — match_time/matchtime, комиссия — резолвер)', () => {
    /** Payload-ы опубликованных событий данного типа, в порядке публикации. */
    function published(type: string): Array<Record<string, unknown>> {
      const calls = (eventBus.publish as ReturnType<typeof jest.fn>).mock.calls as Array<[{ type: string; payload: Record<string, unknown> }]>;
      return calls.filter(([event]) => event.type === type).map(([event]) => event.payload);
    }

    /** Fill-ы опубликованных FILL_RECEIVED. */
    function receivedFills(): Fill[] {
      return published('FILL_RECEIVED').map((payload) => payload['fill'] as Fill);
    }

    /** Комиссия исполнения в USDC числом. */
    function feeOf(fill: Fill): number {
      return fill.fee.quantity.amount().value().toNumber();
    }

    /** Обработчик с собственными шиной и резолвером — для сравнения прогонов. */
    function freshHandler(rates: FakeTakerFeeRates = new FakeTakerFeeRates()) {
      const bus = makeEventBus();
      const own = new FillEventHandler(
        bus,
        new MessageMetadataGenerator({ clock, runId: unsafeRunId('testrun1') }),
        clock,
        makeLogger(),
        rates,
      );
      const fills = (): Fill[] =>
        ((bus.publish as ReturnType<typeof jest.fn>).mock.calls as Array<[{ type: string; payload: { fill: Fill } }]>)
          .filter(([event]) => event.type === 'FILL_RECEIVED')
          .map(([event]) => event.payload.fill);
      return { handler: own, fills, rates };
    }

    /**
     * MAKER-событие с нашими заявками (по owner UUID) и одной чужой.
     *
     * @param ourOrders - Сколько наших maker-заявок в сделке (1 или 2)
     */
    function makeMakerRaw(ourOrders: 1 | 2): Record<string, unknown> {
      const ours = [
        { order_id: 'our-maker-1', asset_id: '12345', side: 'BUY', price: '0.65', matched_amount: '40', owner: 'our-owner' },
        { order_id: 'our-maker-2', asset_id: '12345', side: 'BUY', price: '0.64', matched_amount: '60', owner: 'our-owner' },
      ].slice(0, ourOrders);
      return {
        id: 'fill-maker',
        taker_order_id: 'other-taker-order',
        trader_side: 'MAKER',
        market: MARKET,
        asset_id: '12345',
        side: 'SELL',
        price: '0.65',
        size: '100',
        fee_rate_bps: '1000',
        status: 'MATCHED',
        owner: 'our-owner',
        match_time: '1672290700',
        timestamp: '1672290701',
        transaction_hash: '0xdeadbeef',
        maker_orders: [
          ...ours,
          { order_id: 'other-maker', asset_id: '12345', side: 'BUY', price: '0.65', matched_amount: '5', owner: 'other-owner' },
        ],
      };
    }

    it('TAKER MATCHED при fee_rate_bps "0": комиссия по ставке резолвера рынка, резолвер спрошен один раз по raw.market', async () => {
      await handler.handle({ ...makeValidRaw(), fee_rate_bps: '0' }, ACCOUNT_ID);

      const [fill] = receivedFills();
      expect(fill).toBeDefined();
      expect(fill!.fee.isZero()).toBe(false);
      expect(fill!.fee.equals(calculatePolymarketTakerFeeWithRate(fill!.size, fill!.price, CRYPTO_TAKER_FEE_RATE))).toBe(true);
      // 100 × 0.07 × 0.65 × 0.35 = 1.5925
      expect(feeOf(fill!)).toBeCloseTo(1.5925, 8);
      expect(takerFeeRates.calls).toEqual([MARKET]);
    });

    it('fee_rate_bps "0", "1000" и "250" при одной ставке резолвера → один и тот же TAKER-факт', async () => {
      const fills = await Promise.all(['0', '1000', '250'].map(async (feeRateBps) => {
        const run = freshHandler();
        await run.handler.handle({ ...makeValidRaw(), fee_rate_bps: feeRateBps }, ACCOUNT_ID);
        const [fill] = run.fills();
        if (fill === undefined) throw new Error(`no FILL_RECEIVED for fee_rate_bps ${feeRateBps}`);
        return fill;
      }));

      expect(fills.map(feeOf)).toEqual([1.5925, 1.5925, 1.5925]);
      for (const fill of fills.slice(1)) expect(findFillFactDifference(fills[0]!, fill)).toBeUndefined();
    });

    it.each<[string, 1 | 2, string[]]>([
      ['одна наша maker-заявка', 1, ['fill-maker']],
      ['несколько наших maker-заявок', 2, ['fill-maker:our-maker-1', 'fill-maker:our-maker-2']],
    ])('MAKER (%s): резолвер не вызывается, комиссия 0 — даже при fee_rate_bps "1000"', async (_label, ourOrders, expectedIds) => {
      // Ставки рынка нет вовсе: если бы MAKER её спросил — отказ и ни одного fill.
      takerFeeRates.rates.clear();

      await handler.handle(makeMakerRaw(ourOrders), ACCOUNT_ID);

      const fills = receivedFills();
      expect(fills.map((fill) => String(fill.id))).toEqual(expectedIds);
      for (const fill of fills) expect(fill.fee.isZero()).toBe(true);
      expect(takerFeeRates.calls).toEqual([]);
    });

    it('отказ резолвера → нет FILL_RECEIVED, нет закешированного fill, ошибка в лог; на fee_rate_bps не откатывается', async () => {
      takerFeeRates.rates.set(MARKET, Err(new Error('taker fee rate is unknown for market market-abc')));

      await handler.handle({ ...makeValidRaw(), fee_rate_bps: '1000' }, ACCOUNT_ID);

      expect(eventBus.publish).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to parse fill event',
        expect.objectContaining({ rawId: 'fill-001', error: expect.stringContaining('taker fee rate is unknown') }),
      );
      expect(takerFeeRates.calls).toEqual([MARKET]);

      // Ничего не закешировано: FAILED того же трейда уходит без fills для отката.
      await handler.handle({ ...makeValidRaw(), status: 'FAILED' }, ACCOUNT_ID);
      const [failed] = published('FILL_FAILED');
      expect(failed).toBeDefined();
      expect(failed!['fills']).toBeUndefined();
    });

    it.each<[string, unknown]>([
      ['пустой', ''],
      ['не строка', 42],
      ['отсутствует', undefined],
    ])('TAKER с невалидным market (%s) → отказ разбора, резолвер не вызывается', async (_label, market) => {
      await handler.handle({ ...makeValidRaw(), market }, ACCOUNT_ID);

      expect(eventBus.publish).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith('Failed to parse fill event', expect.any(Object));
      expect(takerFeeRates.calls).toEqual([]);
    });

    it.each([Number.NaN, -0.01])('невалидная ставка резолвера %p → отказ разбора, нет FILL_RECEIVED', async (rate) => {
      takerFeeRates.rates.set(MARKET, Ok(rate));

      await handler.handle(makeValidRaw(), ACCOUNT_ID);

      expect(eventBus.publish).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith('Failed to parse fill event', expect.any(Object));
    });

    it('CONFIRMED-fallback (MATCHED пропущен) берёт ту же ставку резолвера, что и MATCHED', async () => {
      const matched = freshHandler();
      await matched.handler.handle({ ...makeValidRaw(), fee_rate_bps: '0' }, ACCOUNT_ID);

      await handler.handle({ ...makeValidRaw(), status: 'CONFIRMED', fee_rate_bps: '0' }, ACCOUNT_ID);

      const [fallback] = receivedFills();
      const [viaMatched] = matched.fills();
      expect(fallback).toBeDefined();
      expect(feeOf(fallback!)).toBeCloseTo(1.5925, 8);
      expect(findFillFactDifference(viaMatched!, fallback!)).toBeUndefined();
      expect(takerFeeRates.calls).toEqual([MARKET]);
    });

    it('CONFIRMED-fallback при отказе резолвера → нет FILL_RECEIVED', async () => {
      takerFeeRates.rates.clear();

      await handler.handle({ ...makeValidRaw(), status: 'CONFIRMED' }, ACCOUNT_ID);

      expect(eventBus.publish).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to parse fill event',
        expect.objectContaining({ status: 'CONFIRMED', error: expect.stringContaining('taker fee rate is unknown') }),
      );
    });

    it('MATCHED → CONFIRMED: CONFIRMED берёт закешированный fill, ставка не запрашивается повторно', async () => {
      await handler.handle(makeValidRaw(), ACCOUNT_ID);
      await handler.handle({ ...makeValidRaw(), status: 'CONFIRMED' }, ACCOUNT_ID);

      expect(published('FILL_RECEIVED')).toHaveLength(1);
      expect(published('FILL_CONFIRMED')).toHaveLength(1);
      expect(takerFeeRates.calls).toEqual([MARKET]);
    });

    it('Fill.timestamp = match_time исполнения, а receivedAt = clock.now(); timestamp сообщения (+30 с) не участвует', async () => {
      const T = 1672290700;
      await handler.handle({ ...makeValidRaw(), match_time: String(T), timestamp: String(T + 30) }, ACCOUNT_ID);

      const [payload] = published('FILL_RECEIVED');
      expect((payload!['fill'] as Fill).timestamp.toNumber()).toBe(T * 1000);
      expect((payload!['receivedAt'] as Timestamp).toNumber()).toBe(new Date('2024-01-01T00:00:00.000Z').getTime());
    });

    // ── Время исполнения: match_time → legacy matchtime; без них — отказ ──

    /** WS-событие без `match_time`: время исполнения только в legacy `matchtime`. */
    function withLegacyMatchTime(raw: Record<string, unknown>, matchtime: unknown): Record<string, unknown> {
      const { match_time: _matchTime, ...rest } = raw;
      return { ...rest, matchtime };
    }

    it('MATCHED: match_time нет, matchtime T, timestamp T + 30 с → FILL_RECEIVED, Fill.timestamp = T', async () => {
      const T = 1672290700;
      await handler.handle(withLegacyMatchTime({ ...makeValidRaw(), timestamp: String(T + 30) }, String(T)), ACCOUNT_ID);

      const [fill] = receivedFills();
      expect(fill).toBeDefined();
      expect(fill!.timestamp.toNumber()).toBe(T * 1000);
    });

    it.each<[string, Record<string, unknown>]>([
      ['оба отсутствуют', { match_time: undefined, matchtime: undefined }],
      ['оба null', { match_time: null, matchtime: null }],
    ])('MATCHED без времени исполнения (%s) при валидном timestamp → нет FILL_RECEIVED, нет кеша, ошибка в лог', async (_label, executionTime) => {
      await handler.handle({ ...makeValidRaw(), ...executionTime, timestamp: '1672290730' }, ACCOUNT_ID);

      expect(eventBus.publish).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to parse fill event',
        expect.objectContaining({ rawId: 'fill-001', error: expect.stringContaining('missing venue execution time') }),
      );
      // Отказ до FillMapper и до резолвера.
      expect(takerFeeRates.calls).toEqual([]);

      // Ничего не закешировано: FAILED того же трейда уходит без fills для отката.
      await handler.handle({ ...makeValidRaw(), status: 'FAILED' }, ACCOUNT_ID);
      const [failed] = published('FILL_FAILED');
      expect(failed).toBeDefined();
      expect(failed!['fills']).toBeUndefined();
    });

    it('MAKER без времени исполнения → тоже отказ: правило не зависит от стороны', async () => {
      const { match_time: _matchTime, ...maker } = makeMakerRaw(1);

      await handler.handle(maker, ACCOUNT_ID);

      expect(eventBus.publish).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to parse fill event',
        expect.objectContaining({ error: expect.stringContaining('missing venue execution time') }),
      );
    });

    it('match_time нет, matchtime невалиден → отказ, на валидный timestamp не откатывается', async () => {
      await handler.handle(withLegacyMatchTime({ ...makeValidRaw(), timestamp: '1672290730' }, 'garbage'), ACCOUNT_ID);

      expect(eventBus.publish).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to parse fill event',
        expect.objectContaining({ error: expect.stringContaining('matchtime') }),
      );
    });

    it('CONFIRMED-fallback: matchtime T, timestamp T + 30 с → fallback-fill с Fill.timestamp = T', async () => {
      const T = 1672290700;
      await handler.handle(
        withLegacyMatchTime({ ...makeValidRaw(), status: 'CONFIRMED', timestamp: String(T + 30) }, String(T)),
        ACCOUNT_ID,
      );

      const [fallback] = receivedFills();
      expect(fallback).toBeDefined();
      expect(fallback!.timestamp.toNumber()).toBe(T * 1000);
    });

    it('CONFIRMED-fallback без match_time и matchtime → нет FILL_RECEIVED', async () => {
      const { match_time: _matchTime, ...confirmed } = makeValidRaw();

      await handler.handle({ ...confirmed, status: 'CONFIRMED', timestamp: '1672290730' }, ACCOUNT_ID);

      expect(eventBus.publish).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to parse fill event',
        expect.objectContaining({ status: 'CONFIRMED', error: expect.stringContaining('missing venue execution time') }),
      );
    });

    it.each<[string, () => Record<string, unknown>]>([
      ['TAKER', () => ({ ...makeValidRaw(), fee_rate_bps: '0' })],
      ['MAKER', () => makeMakerRaw(1)],
    ])('acceptance (WS-звено, %s): legacy matchtime T + timestamp T + 30 с = REST-форма той же сделки', async (_label, make) => {
      // Реальная форма user-channel: только legacy matchtime, сообщение на 30 с
      // позже исполнения. REST-форма — matchedAt → match_time (мс), без
      // timestamp и fee_rate_bps. Второе звено (настоящий REST-конвертер) — в
      // polymarket-v2/__tests__/polymarketAccountMapping.test.ts.
      const T = 1672290700;
      const ws = withLegacyMatchTime({ ...make(), timestamp: String(T + 30) }, String(T));
      const { timestamp: _messageTime, fee_rate_bps: _feeRateBps, matchtime: _legacy, ...withoutMessageFields } = ws;
      const restShaped = { ...withoutMessageFields, match_time: String(T * 1000) };

      await handler.handle(ws, ACCOUNT_ID);
      const wsFills = receivedFills();
      const options = ws['trader_side'] === 'TAKER' ? { takerFeeRate: CRYPTO_TAKER_FEE_RATE } : {};
      const viaRestShape = FillMapper.allFromPolymarketTradeEvent(restShaped, ACCOUNT_ID, options);
      if (!viaRestShape.ok) throw viaRestShape.error;
      const restFills = viaRestShape.value.map(({ fill }) => fill);

      expect(wsFills).toHaveLength(1);
      expect(wsFills.map((fill) => String(fill.id))).toEqual(restFills.map((fill) => String(fill.id)));
      expect(findFillFactDifference(wsFills[0]!, restFills[0]!)).toBeUndefined();
      expect(wsFills[0]!.timestamp.toNumber()).toBe(T * 1000);
    });

    it('acceptance (WS-звено): опубликованный fill = FillMapper со ставкой того же резолвера и с REST-формой той же сделки', async () => {
      // Одно TAKER-исполнение. WS: сообщение на 30 с позже исполнения,
      // fee_rate_bps "0". REST-форма — то, во что polymarketClobTradeToFillMapperInput
      // переводит ClobTrade: matchedAt → match_time (мс), без timestamp и feeRateBps.
      // Второе звено (настоящий REST-конвертер + тот же резолвер) — в
      // polymarket-v2/__tests__/polymarketAccountMapping.test.ts.
      const T = 1672290700;
      const ws = { ...makeValidRaw(), match_time: String(T), timestamp: String(T + 30), fee_rate_bps: '0' };
      const { timestamp: _messageTime, fee_rate_bps: _feeRateBps, ...withoutMessageFields } = ws;
      const restShaped = { ...withoutMessageFields, match_time: String(T * 1000) };

      await handler.handle(ws, ACCOUNT_ID);
      const [wsFill] = receivedFills();
      const rate = takerFeeRates.getTakerFeeRate(MARKET as MarketId);
      if (!rate.ok) throw rate.error;
      const viaRestShape = FillMapper.allFromPolymarketTradeEvent(restShaped, ACCOUNT_ID, { takerFeeRate: rate.value });
      if (!viaRestShape.ok) throw viaRestShape.error;
      const [restFill] = viaRestShape.value.map(({ fill }) => fill);

      expect(String(wsFill!.id)).toBe(String(restFill!.id));
      expect(findFillFactDifference(wsFill!, restFill!)).toBeUndefined();
    });
  });
});
