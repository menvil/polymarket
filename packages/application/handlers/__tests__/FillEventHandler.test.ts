import { describe, it, expect, jest, beforeEach } from '@jest/globals';
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
    publish: jest.fn<IEventBus['publish']>().mockResolvedValue(undefined),
    publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(undefined),
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

  it('MATCHED: кеширует fill, НЕ публикует FILL_RECEIVED', async () => {
    const raw = makeValidRaw(); // status: 'MATCHED'
    const mapResult = FillMapper.fromPolymarketTradeEvent(raw, ACCOUNT_ID);
    expect(mapResult.ok).toBe(true);

    await handler.handle(raw, ACCOUNT_ID);

    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      'Fill cached, waiting for on-chain confirmation',
      expect.any(Object),
    );
  });

  it('MINED после MATCHED: публикует FILL_RECEIVED из кеша', async () => {
    // Шаг 1: MATCHED → кешируем
    await handler.handle(makeValidRaw(), ACCOUNT_ID);
    expect(eventBus.publish).not.toHaveBeenCalled();

    // Шаг 2: MINED → достаём из кеша и публикуем
    await handler.handle({ id: 'fill-001', status: 'MINED' }, ACCOUNT_ID);

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'FILL_RECEIVED',
        fill: expect.objectContaining({ id: 'fill-001' }),
        receivedAt: expect.any(Object),
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Fill event published',
      expect.objectContaining({ status: 'MINED' }),
    );
  });

  it('CONFIRMED после MATCHED: публикует FILL_RECEIVED из кеша', async () => {
    await handler.handle(makeValidRaw(), ACCOUNT_ID);
    await handler.handle({ id: 'fill-001', status: 'CONFIRMED' }, ACCOUNT_ID);

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'FILL_RECEIVED',
        fill: expect.objectContaining({ id: 'fill-001' }),
      }),
    );
  });

  it('MINED + CONFIRMED: публикует дважды — второй раз парсит из raw (ProcessFillUseCase идемпотентен)', async () => {
    await handler.handle(makeValidRaw(), ACCOUNT_ID);
    await handler.handle({ id: 'fill-001', status: 'MINED' }, ACCOUNT_ID);
    // CONFIRMED без кеша, но с полным payload — fallback парсинг
    await handler.handle({ ...makeValidRaw(), status: 'CONFIRMED' }, ACCOUNT_ID);

    expect(eventBus.publish).toHaveBeenCalledTimes(2);
  });

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

  it('MINED без кеша и с полным payload: парсит fallback и публикует', async () => {
    const raw = { ...makeValidRaw(), status: 'MINED' };
    await handler.handle(raw, ACCOUNT_ID);

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'FILL_RECEIVED' }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'Fill not in cache, parsing from on-chain event directly',
      expect.objectContaining({ status: 'MINED' }),
    );
  });

  it('CONFIRMED без кеша и с полным payload: парсит fallback и публикует', async () => {
    const raw = { ...makeValidRaw(), status: 'CONFIRMED' };
    await handler.handle(raw, ACCOUNT_ID);

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'FILL_RECEIVED' }),
    );
  });

  it('MINED без кеша и с невалидным payload: логирует ошибку, не публикует', async () => {
    await handler.handle({ id: 'fill-001', status: 'MINED' }, ACCOUNT_ID);

    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to parse fill event',
      expect.objectContaining({ status: 'MINED' }),
    );
  });

  it('игнорирует fill со статусом RETRYING', async () => {
    const raw = { ...makeValidRaw(), status: 'RETRYING' };

    await handler.handle(raw, ACCOUNT_ID);

    expect(eventBus.publish).not.toHaveBeenCalled();
  });

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

  it('MINED: не публикует если TimestampService не может создать timestamp', async () => {
    // Симулируем невалидный clock — возвращает Invalid Date
    const badClock: IClock = {
      now: jest.fn<() => Date>().mockReturnValue(new Date('invalid')),
    };
    const handlerBadClock = new FillEventHandler(eventBus, badClock, logger);

    const raw = makeValidRaw();
    // MATCHED парсится без clock (clock используется только при публикации)
    await handlerBadClock.handle(raw, ACCOUNT_ID);
    expect(eventBus.publish).not.toHaveBeenCalled();

    // MINED → пытаемся опубликовать, но clock невалидный → ошибка
    await handlerBadClock.handle({ id: 'fill-001', status: 'MINED' }, ACCOUNT_ID);

    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to create receivedAt timestamp',
      expect.any(Object),
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

  it('FAILED с taker_order_id не строкой (число) — rawOrderId становится "", warn, нет публикации', async () => {
    // typeof 123 !== 'string' → rawOrderId = '' → asOrderId('') = undefined → warn
    await handler.handle({ id: 'fill-001', status: 'FAILED', taker_order_id: 123 }, ACCOUNT_ID);

    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed fill has unparseable orderId, skipping FILL_FAILED event',
      expect.any(Object),
    );
  });

  it('FAILED с пустым taker_order_id — логирует warn и не публикует FILL_FAILED', async () => {
    // asOrderId('') возвращает undefined → ранний возврат без публикации
    await handler.handle({ id: 'fill-001', status: 'FAILED', taker_order_id: '' }, ACCOUNT_ID);

    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed fill has unparseable orderId, skipping FILL_FAILED event',
      expect.any(Object),
    );
  });

  it('статус не строка — трактуется как UNKNOWN, trace-лог, нет публикации', async () => {
    // typeof raw['status'] !== 'string' → status = 'UNKNOWN' → не в FILL_CREATE_STATUSES
    await handler.handle({ status: 42 }, ACCOUNT_ID);

    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(logger.trace).toHaveBeenCalledWith(
      'Fill event ignored (non-primary status)',
      expect.objectContaining({ status: 'UNKNOWN' }),
    );
  });

  it('FAILED: не публикует FILL_FAILED если clock возвращает невалидную дату', async () => {
    const badClock: IClock = {
      now: jest.fn<() => Date>().mockReturnValue(new Date('invalid')),
    };
    const handlerBadClock = new FillEventHandler(eventBus, badClock, logger);

    // id и taker_order_id валидны, но clock невалидный → TimestampService.fromDate fail
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
