/**
 * TradeAccumulator - накопитель трейдов для стратегий
 *
 * @remarks
 * v5.3: Trade-based fill detection!
 *
 * Накапливает трейды по tokenId для определения fills.
 * Стратегия может проверить: прошли ли трейды по нашей цене?
 *
 * Алгоритм fill detection:
 * - BUY order @ 0.50: fill если прошли SELL трейды по <= 0.50
 * - SELL order @ 0.55: fill если прошли BUY трейды по >= 0.55
 *
 * Поддерживает partial fills на основе объёма трейдов.
 *
 * @example
 * ```typescript
 * const accumulator = new TradeAccumulator(60000); // 60 sec window
 *
 * // Добавление трейдов (из WebSocket)
 * accumulator.addTrade(tokenId, trade);
 *
 * // Проверка fill для BUY ордера
 * const fillVolume = accumulator.getFilledVolume(
 *   tokenId,
 *   0.50,    // order price
 *   'buy',   // order side
 *   5000     // check trades in last 5 seconds
 * );
 *
 * if (fillVolume >= orderSize) {
 *   // Order fully filled
 * }
 * ```
 */

import type { Trade } from '../../entities/Trade.js';

/**
 * TradeRecord - запись о трейде с временем добавления
 */
interface TradeRecord {
  trade: Trade;
  addedAt: number; // timestamp когда добавили
}

/**
 * ITradeAccumulator - интерфейс накопителя трейдов
 */
export interface ITradeAccumulator {
  /**
   * Добавить трейд в накопитель
   *
   * @param tokenId - Token ID
   * @param trade - Trade entity
   */
  addTrade(tokenId: string, trade: Trade): void;

  /**
   * Получить трейды за период
   *
   * @param tokenId - Token ID
   * @param windowMs - Временное окно в мс (по умолчанию 5000)
   * @returns Массив трейдов за указанный период
   */
  getRecentTrades(tokenId: string, windowMs?: number): Trade[];

  /**
   * Рассчитать объём который мог бы заполнить наш ордер
   *
   * @param tokenId - Token ID
   * @param orderPrice - Цена нашего ордера
   * @param orderSide - Сторона нашего ордера (buy/sell)
   * @param windowMs - Временное окно в мс
   * @returns Объём трейдов которые прошли по нашей цене или лучше
   *
   * @remarks
   * Логика:
   * - BUY order @ X: считаем SELL трейды (taker sells) по цене <= X
   * - SELL order @ X: считаем BUY трейды (taker buys) по цене >= X
   *
   * Почему так:
   * - Наш BUY ордер на бирже как MAKER (waiting to buy)
   * - Когда кто-то делает SELL как TAKER, он "бьёт" по нашему BUY
   * - Если SELL прошёл по цене <= нашей, значит наш ордер мог исполниться
   */
  getFilledVolume(
    tokenId: string,
    orderPrice: number,
    orderSide: 'buy' | 'sell',
    windowMs?: number
  ): number;

  /**
   * Очистить старые трейды
   *
   * @param maxAgeMs - Максимальный возраст трейда (по умолчанию = windowMs из конструктора)
   */
  cleanup(maxAgeMs?: number): void;

  /**
   * Очистить все трейды для токена
   *
   * @param tokenId - Token ID
   */
  clearToken(tokenId: string): void;
}

/**
 * TradeAccumulator - реализация накопителя трейдов
 */
export class TradeAccumulator implements ITradeAccumulator {
  private trades = new Map<string, TradeRecord[]>();
  private readonly defaultWindowMs: number;

  /**
   * @param defaultWindowMs - Временное окно по умолчанию (default: 60000 = 1 минута)
   */
  constructor(defaultWindowMs: number = 60000) {
    this.defaultWindowMs = defaultWindowMs;
  }

  addTrade(tokenId: string, trade: Trade): void {
    if (!this.trades.has(tokenId)) {
      this.trades.set(tokenId, []);
    }

    const records = this.trades.get(tokenId)!;
    records.push({
      trade,
      addedAt: Date.now(),
    });

    // Автоматически очищаем старые трейды (чтобы память не росла)
    if (records.length > 1000) {
      this.cleanup(this.defaultWindowMs);
    }
  }

  getRecentTrades(tokenId: string, windowMs: number = 5000): Trade[] {
    const records = this.trades.get(tokenId);
    if (!records) return [];

    const cutoff = Date.now() - windowMs;
    return records
      .filter((r) => r.addedAt >= cutoff)
      .map((r) => r.trade);
  }

  getFilledVolume(
    tokenId: string,
    orderPrice: number,
    orderSide: 'buy' | 'sell',
    windowMs: number = 5000
  ): number {
    const recentTrades = this.getRecentTrades(tokenId, windowMs);

    let filledVolume = 0;

    for (const trade of recentTrades) {
      const tradePrice = trade.price.value;
      const tradeSide = trade.side;

      if (orderSide === 'buy') {
        // Наш BUY ордер как MAKER ждёт на бирже
        // Он заполняется когда приходят SELL трейды (taker sells)
        // SELL трейд по цене <= нашей = наш ордер мог быть исполнен
        //
        // ВАЖНО: tradeSide может быть null (неизвестно)
        // В этом случае проверяем только цену
        if (tradeSide === 'SELL' || tradeSide === null) {
          if (tradePrice <= orderPrice) {
            filledVolume += trade.quantity.value;
          }
        }
      } else {
        // Наш SELL ордер как MAKER ждёт на бирже
        // Он заполняется когда приходят BUY трейды (taker buys)
        // BUY трейд по цене >= нашей = наш ордер мог быть исполнен
        if (tradeSide === 'BUY' || tradeSide === null) {
          if (tradePrice >= orderPrice) {
            filledVolume += trade.quantity.value;
          }
        }
      }
    }

    return filledVolume;
  }

  cleanup(maxAgeMs?: number): void {
    const cutoff = Date.now() - (maxAgeMs ?? this.defaultWindowMs);

    for (const [tokenId, records] of this.trades.entries()) {
      const filtered = records.filter((r) => r.addedAt >= cutoff);
      if (filtered.length === 0) {
        this.trades.delete(tokenId);
      } else {
        this.trades.set(tokenId, filtered);
      }
    }
  }

  clearToken(tokenId: string): void {
    this.trades.delete(tokenId);
  }
}
