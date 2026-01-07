/**
 * TradeSideDetector - определение стороны сделки
 *
 * @remarks
 * Определяет сторону агрессивной сделки (BUY/SELL) с учётом:
 * 1. Пересечения спреда (crossing best bid/ask)
 * 2. Позиции относительно mid-price
 * 3. Направления последнего тика
 * 4. Time-to-next-fill
 * 5. Минимального объёма
 *
 * Алгоритм:
 * 1. Фильтруем мелкие сделки (< minAggressiveVolume)
 * 2. Если цена >= ask → BUY (агрессивная покупка)
 * 3. Если цена <= bid → SELL (агрессивная продажа)
 * 4. Внутри спреда:
 *    - Выше mid + spreadMin/2 → BUY
 *    - Ниже mid - spreadMin/2 → SELL
 * 5. Если всё ещё UNKNOWN, используем lastTickDirection
 * 6. Усиление по time-to-next-fill
 *
 * @example
 * ```typescript
 * const detector = new TradeSideDetector({ minAggressiveVolume: 5 });
 *
 * const side = detector.detect(0.65, 100, { bid: 0.64, ask: 0.66 });
 * // side = 'BUY' (цена выше mid)
 *
 * const side2 = detector.detect(0.66, 100, { bid: 0.64, ask: 0.66 });
 * // side2 = 'BUY' (цена = ask, пересёк спред)
 * ```
 */
import { ILogger } from '../../ports/ILogger.js';
import { TradeSide, BestPrices, TradeContext } from './types.js';

/**
 * Конфигурация TradeSideDetector
 */
export interface TradeSideDetectorConfig {
  /**
   * Минимальный объём для агрессивной сделки
   * @default 5
   */
  minAggressiveVolume: number;

  /**
   * Минимальный значимый спред для определения mid crossing
   * @default 0.0001
   */
  defaultSpreadMin: number;
}

/**
 * Default конфигурация
 */
export const DEFAULT_TRADE_SIDE_DETECTOR_CONFIG: TradeSideDetectorConfig = {
  minAggressiveVolume: 5,
  defaultSpreadMin: 0.0001,
};

/**
 * TradeSideDetector
 *
 * @remarks
 * Stateless сервис для определения стороны сделки.
 * Использует многоуровневую логику для максимальной точности.
 */
export class TradeSideDetector {
  private readonly config: TradeSideDetectorConfig;
  private readonly logger?: ILogger;

  /**
   * Создаёт TradeSideDetector
   *
   * @param config - Конфигурация (опционально)
   * @param logger - Логгер (опционально)
   *
   * @example
   * ```typescript
   * const detector = new TradeSideDetector();
   * const detectorWithConfig = new TradeSideDetector({ minAggressiveVolume: 10 });
   * ```
   */
  constructor(
    config: Partial<TradeSideDetectorConfig> = {},
    logger?: ILogger
  ) {
    this.config = { ...DEFAULT_TRADE_SIDE_DETECTOR_CONFIG, ...config };
    this.logger = logger?.child?.('TradeSideDetector') || logger;
  }

  /**
   * Определяет сторону сделки
   *
   * @param tradePrice - Цена сделки
   * @param tradeSize - Размер сделки
   * @param bestPrices - Лучшие bid/ask из стакана
   * @param context - Дополнительный контекст (опционально)
   * @returns TradeSide - BUY, SELL или UNKNOWN
   *
   * @remarks
   * Алгоритм определения:
   *
   * 1. **Фильтр по объёму**:
   *    ```
   *    if tradeSize < minAggressiveVolume → UNKNOWN
   *    ```
   *
   * 2. **Пересечение спреда** (самый надёжный сигнал):
   *    ```
   *    if tradePrice >= ask → BUY
   *    if tradePrice <= bid → SELL
   *    ```
   *
   * 3. **Позиция относительно mid**:
   *    ```
   *    mid = (bid + ask) / 2
   *    if tradePrice > mid + spreadMin/2 → BUY
   *    if tradePrice < mid - spreadMin/2 → SELL
   *    ```
   *
   * 4. **Направление тика** (fallback):
   *    ```
   *    if tradePrice > lastTickPrice → BUY
   *    if tradePrice < lastTickPrice → SELL
   *    ```
   *
   * 5. **Time-to-fill усиление**:
   *    ```
   *    if timeToNextFillMs < 200 → return side (подтверждённый)
   *    if timeToNextFillMs > 1000 → UNKNOWN (слабый сигнал)
   *    ```
   *
   * @example
   * ```typescript
   * const detector = new TradeSideDetector();
   *
   * // Агрессивная покупка (пересёк ask)
   * detector.detect(0.66, 100, { bid: 0.64, ask: 0.66 }); // BUY
   *
   * // Агрессивная продажа (пересёк bid)
   * detector.detect(0.64, 100, { bid: 0.64, ask: 0.66 }); // SELL
   *
   * // Выше mid - скорее покупка
   * detector.detect(0.655, 100, { bid: 0.64, ask: 0.66 }); // BUY
   *
   * // Мелкая сделка - игнорируем
   * detector.detect(0.65, 1, { bid: 0.64, ask: 0.66 }); // UNKNOWN
   * ```
   */
  public detect(
    tradePrice: number,
    tradeSize: number,
    bestPrices: BestPrices,
    context: TradeContext = {}
  ): TradeSide {
    const { bid, ask, spreadMin = this.config.defaultSpreadMin } = bestPrices;
    const {
      lastTickPrice,
      minAggressiveVolume = this.config.minAggressiveVolume,
      timeToNextFillMs,
    } = context;
    // Note: lastTickDirection from context is available for future enhancements

    // 1. Фильтруем слишком маленькие сделки
    if (tradeSize < minAggressiveVolume) {
      this.logger?.trace('[TradeSide] Trade too small', {
        tradeSize,
        minAggressiveVolume,
        result: 'UNKNOWN',
      });
      return 'UNKNOWN';
    }

    // 2. Пересечение спреда — агрессивная покупка/продажа
    if (tradePrice >= ask) {
      this.logger?.trace('[TradeSide] Crossed ask (aggressive BUY)', {
        tradePrice: tradePrice.toFixed(4),
        ask: ask.toFixed(4),
        tradeSize,
      });
      return 'BUY';
    }

    if (tradePrice <= bid) {
      this.logger?.trace('[TradeSide] Crossed bid (aggressive SELL)', {
        tradePrice: tradePrice.toFixed(4),
        bid: bid.toFixed(4),
        tradeSize,
      });
      return 'SELL';
    }

    // 3. Внутри спреда - определяем по mid
    const mid = (bid + ask) / 2;
    let side: TradeSide = 'UNKNOWN';

    if (tradePrice > mid + spreadMin / 2) {
      side = 'BUY';
    } else if (tradePrice < mid - spreadMin / 2) {
      side = 'SELL';
    }

    // 4. Усиление по последнему движению цены
    if (side === 'UNKNOWN' && lastTickPrice !== undefined) {
      if (tradePrice > lastTickPrice) {
        side = 'BUY';
      } else if (tradePrice < lastTickPrice) {
        side = 'SELL';
      }
    }

    // 5. Усиление по time-to-next-fill
    if (side !== 'UNKNOWN' && timeToNextFillMs !== undefined) {
      if (timeToNextFillMs < 200) {
        // Очень агрессивная сделка - подтверждаем
        this.logger?.trace('[TradeSide] Fast fill confirmed', {
          side,
          timeToNextFillMs,
          tradePrice: tradePrice.toFixed(4),
        });
        return side;
      }
      if (timeToNextFillMs > 1000) {
        // Слабый сигнал - не доверяем
        this.logger?.trace('[TradeSide] Slow fill - weak signal', {
          side,
          timeToNextFillMs,
          result: 'UNKNOWN',
        });
        return 'UNKNOWN';
      }
    }

    this.logger?.trace('[TradeSide] Detected', {
      side,
      tradePrice: tradePrice.toFixed(4),
      bid: bid.toFixed(4),
      ask: ask.toFixed(4),
      mid: mid.toFixed(4),
      tradeSize,
    });

    return side;
  }

  /**
   * Создаёт контекст для следующей сделки
   *
   * @param currentPrice - Текущая цена
   * @param previousPrice - Предыдущая цена (опционально)
   * @param timestamp - Timestamp текущей сделки
   * @returns TradeContext для использования в detect()
   *
   * @remarks
   * Helper метод для создания контекста между сделками.
   *
   * @example
   * ```typescript
   * const context = detector.createContext(0.65, 0.64, Date.now());
   * // context.lastTickPrice = 0.64
   * // context.lastTickDirection = 1 (цена выросла)
   * ```
   */
  public createContext(
    currentPrice: number,
    previousPrice?: number,
    timestamp?: number
  ): TradeContext {
    const context: TradeContext = {
      minAggressiveVolume: this.config.minAggressiveVolume,
    };

    if (previousPrice !== undefined) {
      context.lastTickPrice = previousPrice;
      if (currentPrice > previousPrice) {
        context.lastTickDirection = 1;
      } else if (currentPrice < previousPrice) {
        context.lastTickDirection = -1;
      }
    }

    if (timestamp !== undefined) {
      context.lastTradeTimestamp = timestamp;
    }

    return context;
  }
}
