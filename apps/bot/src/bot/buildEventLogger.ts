/**
 * Единое логирование торговых событий (paper / backtest / live).
 *
 * @remarks
 * Все три режима используют одну функцию `subscribeToOrderEvents` для
 * вывода событий ордеров и рыночных данных. Это гарантирует одинаковый
 * формат вывода независимо от режима работы.
 *
 * ### Подписки:
 * - `ORDER_CREATED`          — INFO, ордер выставлен
 * - `ORDER_PARTIALLY_FILLED` — INFO, частичное исполнение
 * - `ORDER_FILLED`           — INFO, полное исполнение
 * - `ORDER_CANCELLED`        — INFO, ордер отменён
 * - `BOOK_UPDATED`           — INFO каждые N тиков (настраивается)
 * - `TRADE_RECEIVED`         — INFO каждый трейд из ленты
 *
 * @example
 * ```typescript
 * // Paper mode
 * subscribeToOrderEvents(eventBus, logger, { bookLogEvery: 10 });
 *
 * // Backtest mode (реже — тысячи событий в секунду)
 * subscribeToOrderEvents(eventBus, logger, { bookLogEvery: 100 });
 * ```
 */

import type { IEventBus } from '@polymarket/event-bus';
import type { ILogger } from '@polymarket/logger';

/**
 * Снимок портфеля после исполнения fill для вывода в лог.
 *
 * @remarks
 * Колбэк предоставляется из main.ts — buildEventLogger не зависит от IPortfolioStore.
 */
export interface PortfolioSnapshot {
  /** Количество токенов в позиции */
  readonly tokenQty: string;
  /** Средняя цена входа (undefined если позиции нет) */
  readonly avgEntry: string | undefined;
  /** Свободный баланс USDC */
  readonly usdc: string;
  /** Зарезервированный баланс USDC (под открытые ордера) */
  readonly reserved: string;
}

/** Параметры подписки на торговые события */
export interface EventLoggerOptions {
  /**
   * Логировать каждый N-й тик книги заявок.
   * @defaultValue 10
   */
  readonly bookLogEvery?: number;
  /**
   * Логировать ли тики книги заявок (BOOK_UPDATED).
   * @defaultValue true
   */
  readonly logBook?: boolean;
  /**
   * Логировать ли трейды из ленты.
   * @defaultValue true
   */
  readonly logTrades?: boolean;
  /**
   * Колбэк для получения снимка портфеля после каждого fill.
   * Вызывается синхронно после ORDER_FILLED / ORDER_PARTIALLY_FILLED.
   * Если не задан — баланс в логах не выводится.
   */
  readonly getPortfolioSnapshot?: () => PortfolioSnapshot | undefined;
  /**
   * Колбэк для определения типа токена: 'UP', 'DOWN' или undefined.
   * Получает tokenId строку из event.asset.
   */
  readonly getTokenLabel?: (asset: unknown) => string | undefined;
}

/**
 * Подписывается на торговые события и логирует их единообразно.
 *
 * @param eventBus - Шина событий
 * @param logger - Логгер
 * @param options - Параметры частоты вывода
 * @returns Функция отписки (вызовите при shutdown)
 */
export function subscribeToOrderEvents(
  eventBus: IEventBus,
  logger: ILogger,
  options: EventLoggerOptions = {},
): () => void {
  const bookLogEvery = options.bookLogEvery ?? 10;
  const logBook = options.logBook ?? true;
  const logTrades = options.logTrades ?? true;

  let bookCount = 0;

  const unsubBook = eventBus.subscribe('BOOK_UPDATED', (event) => {
    bookCount++;
    if (logBook && bookCount % bookLogEvery === 0) {
      const { bestBid, bestAsk } = event.topOfBook;
      logger.info('Book tick', {
        n: bookCount,
        bid: bestBid ? bestBid.value().toFixed(4) : null,
        ask: bestAsk ? bestAsk.value().toFixed(4) : null,
      });
    }
  });

  const unsubTrade = logTrades
    ? eventBus.subscribe('TRADE_RECEIVED', (event) => {
        logger.info('Tape trade', {
          side: event.side,
          size: event.size.value().toFixed(2),
          price: event.price.value().toFixed(4),
        });
      })
    : () => {};

  const unsubCreated = eventBus.subscribe('ORDER_CREATED', (event) => {
    const snap = options.getPortfolioSnapshot?.();
    const tokenLabel = options.getTokenLabel?.(event.asset);
    logger.info('>>> Order placed', {
      side: event.side,
      ...(tokenLabel && { token: tokenLabel }),
      size: event.size.value().toFixed(2),
      price: event.price.value().toFixed(4),
      notional: event.price.value().times(event.size.value()).toFixed(2),
      ...(snap && {
        usdcFree: snap.usdc,
        usdcReserved: snap.reserved,
        tokenQty: snap.tokenQty,
      }),
    });
  });

  const unsubPartial = eventBus.subscribe('ORDER_PARTIALLY_FILLED', (event) => {
    const snap = options.getPortfolioSnapshot?.();
    logger.info('>>> Partial fill', {
      side: event.fill.side,
      filled: event.fill.size.value().toFixed(2),
      price: event.fill.price.value().toFixed(4),
      remaining: event.remainingSize.value().toFixed(2),
      ...(snap && {
        tokenQty: snap.tokenQty,
        avgEntry: snap.avgEntry,
        usdcFree: snap.usdc,
        usdcReserved: snap.reserved,
      }),
    });
  });

  const unsubFilled = eventBus.subscribe('ORDER_FILLED', (event) => {
    const snap = options.getPortfolioSnapshot?.();
    logger.info('>>> Order filled', {
      side: event.fill.side,
      size: event.fill.size.value().toFixed(2),
      price: event.fill.price.value().toFixed(4),
      ...(snap && {
        tokenQty: snap.tokenQty,
        avgEntry: snap.avgEntry,
        usdcFree: snap.usdc,
        usdcReserved: snap.reserved,
      }),
    });
  });

  return () => {
    unsubBook();
    unsubTrade();
    unsubCreated();
    unsubPartial();
    unsubFilled();
  };
}
