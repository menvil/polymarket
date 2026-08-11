import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Ok } from '@polymarket/result';
import { FillEventHandler } from '../src/FillEventHandler.js';
import type { IEventBus } from '@polymarket/event-bus';
import type { IClock } from '@polymarket/time';
import type { ILogger } from '@polymarket/logger';
import type { AccountId } from '@polymarket/ids';
import { FillMapper } from '@polymarket/fill';

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
    subscribe: jest.fn() as IEventBus['subscribe'],
  };
}

const ACCOUNT_ID = 'venue:POLYMARKET:0xabc' as unknown as AccountId;

// Минимальный валидный raw payload из Polymarket WS user-channel (формат TAKER-события)
function makeValidRaw(): Record<string, unknown> {
  return {
    id: 'fill-001',
    taker_order_id: 'order-999',
    trader_side: 'TAKER',        // 'TAKER' | 'MAKER', не сторона сделки
    market: 'market-abc',        // обязателен для asMarketId()
    asset_id: '12345',           // числовой ERC1155 tokenId — parseAssetId принимает /^\d+$/
    side: 'BUY',                 // сторона ТЕЙКЕРА: 'BUY' | 'SELL'
    price: '0.65',
    size: '100',
    fee_rate_bps: '0',
    status: 'MATCHED',
    timestamp: '1672290701',     // Unix секунды; FillMapper использует 'timestamp', не 'match_time'
    transaction_hash: '0xdeadbeef',
    maker_orders: [],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FillEventHandler', () => {
  let eventBus: IEventBus;
  let clock: IClock;
  let logger: ILogger;
  let handler: FillEventHandler;

  beforeEach(() => {
    eventBus = makeEventBus();
    clock = { now: jest.fn<() => Date>().mockReturnValue(new Date('2024-01-01T00:00:00.000Z')) };
    logger = makeLogger();
    handler = new FillEventHandler(eventBus, clock, logger);
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
        fill: expect.objectContaining({ id: 'fill-001' }),
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
        fillId: 'fill-001',
        orderId: 'order-999',
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
    expect(failedCall.fills).toBeDefined();
    expect(failedCall.fills.length).toBeGreaterThan(0);
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
    const handlerBadClock = new FillEventHandler(eventBus, badClock, logger);

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
    const handlerBadClock = new FillEventHandler(eventBus, badClock, logger);

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
});
