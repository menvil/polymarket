/**
 * Trade entity
 *
 * @remarks
 * Представляет исполненную сделку на рынке.
 * Immutable entity для хранения истории сделок.
 *
 * Алгоритм:
 * 1. Хранит детали сделки: цена, количество, сторона, время
 * 2. Вычисляет notional value (цена × количество)
 * 3. Предоставляет методы для анализа сделок
 *
 * Использование:
 * - Запись истории исполненных ордеров
 * - Анализ рыночной активности
 * - Расчёт VWAP (volume-weighted average price)
 * - Построение графиков объёмов
 * - Определение направления рынка (buying/selling pressure)
 *
 * @example
 * ```typescript
 * const trade = Trade.create({
 *   id: 'trade-1',
 *   marketId: 'market-123',
 *   price: Price.fromNumber(0.65),
 *   quantity: Quantity.fromNumber(100),
 *   side: 'BUY',
 *   timestamp: new Date()
 * });
 *
 * console.log(`Trade: ${trade.side} ${trade.quantity.value} @ ${trade.price.value}`);
 * console.log(`Notional: ${trade.getNotional()}`);
 * console.log(`Age: ${trade.getAgeMs()}ms`);
 * ```
 */
import { Price } from '../../../../../polymarket-v4/src/domain/value-objects/Price';
import { Quantity } from '../../../../../polymarket-v4/src/domain/value-objects/Quantity';
import { TradingError } from '../../../../../polymarket-v4/src/shared/errors/TradingError';

/**
 * Trade side type
 *
 * @remarks
 * - BUY: покупка (taker купил)
 * - SELL: продажа (taker продал)
 * - null: направление неизвестно (Polymarket не предоставил информацию)
 */
export type TradeSide = 'BUY' | 'SELL' | null;

/**
 * Trade creation parameters
 */
export interface TradeParams {
  id: string;
  marketId: string;
  price: Price;
  quantity: Quantity;
  side: TradeSide;
  timestamp: Date;
  orderId?: string;
  makerOrderId?: string;
  takerOrderId?: string;
}

/**
 * Ошибка валидации сделки
 *
 * @remarks
 * Выбрасывается при попытке создать сделку с невалидными параметрами.
 */
export class TradeValidationError extends TradingError {
  constructor(message: string, public readonly field?: string) {
    super(message, 'TRADE_VALIDATION_ERROR');
  }
}

/**
 * Trade entity
 *
 * @remarks
 * Immutable entity representing an executed trade.
 */
export class Trade {
  public readonly id: string;
  public readonly marketId: string;
  public readonly price: Price;
  public readonly quantity: Quantity;
  public readonly side: TradeSide;
  public readonly timestamp: Date;
  public readonly orderId?: string;
  public readonly makerOrderId?: string;
  public readonly takerOrderId?: string;

  /**
   * Создаёт новый Trade
   *
   * @param params - Параметры сделки
   *
   * @remarks
   * Private constructor - используйте статический метод create().
   */
  private constructor(params: TradeParams) {
    this.id = params.id;
    this.marketId = params.marketId;
    this.price = params.price;
    this.quantity = params.quantity;
    this.side = params.side;
    this.timestamp = params.timestamp;
    this.orderId = params.orderId;
    this.makerOrderId = params.makerOrderId;
    this.takerOrderId = params.takerOrderId;
  }

  /**
   * Создаёт новый Trade с валидацией
   *
   * @param params - Параметры сделки
   * @returns Новый Trade instance
   * @throws {TradeValidationError} Если валидация не прошла
   *
   * @remarks
   * Factory method с полной валидацией всех параметров.
   *
   * Валидирует:
   * 1. ID не пустой
   * 2. MarketId не пустой
   * 3. Quantity положительная
   * 4. Side корректный ('BUY' или 'SELL')
   * 5. Timestamp валидный
   *
   * @example
   * ```typescript
   * const trade = Trade.create({
   *   id: 'trade-1',
   *   marketId: 'market-123',
   *   price: Price.fromNumber(0.65),
   *   quantity: Quantity.fromNumber(100),
   *   side: 'BUY',
   *   timestamp: new Date(),
   *   orderId: 'order-1'
   * });
   * ```
   */
  public static create(params: TradeParams): Trade {
    const trade = new Trade(params);
    trade.validate();
    return trade;
  }

  /**
   * Валидирует сделку
   *
   * @throws {TradeValidationError} Если валидация не прошла
   *
   * @remarks
   * Проверяет все бизнес-правила:
   * 1. ID должен быть непустой строкой
   * 2. MarketId должен быть непустой строкой
   * 3. Quantity должна быть положительной
   * 4. Side должен быть 'BUY' или 'SELL'
   * 5. Timestamp должен быть валидной датой
   *
   * @example
   * ```typescript
   * try {
   *   trade.validate();
   * } catch (error) {
   *   if (error instanceof TradeValidationError) {
   *     console.error(`Validation failed: ${error.message}`);
   *   }
   * }
   * ```
   */
  public validate(): void {
    // Validate ID
    if (!this.id || typeof this.id !== 'string' || this.id.trim().length === 0) {
      throw new TradeValidationError('Trade ID must be a non-empty string', 'id');
    }

    // Validate marketId
    if (!this.marketId || typeof this.marketId !== 'string' || this.marketId.trim().length === 0) {
      throw new TradeValidationError('Market ID must be a non-empty string', 'marketId');
    }

    // Validate quantity is positive
    if (!this.quantity.isPositive()) {
      throw new TradeValidationError('Trade quantity must be positive', 'quantity');
    }

    // Validate side (allow null for unknown direction)
    if (this.side !== 'BUY' && this.side !== 'SELL' && this.side !== null) {
      throw new TradeValidationError(`Invalid trade side: ${this.side}`, 'side');
    }

    // Validate timestamp
    if (!(this.timestamp instanceof Date) || isNaN(this.timestamp.getTime())) {
      throw new TradeValidationError('Invalid timestamp', 'timestamp');
    }
  }

  /**
   * Вычисляет notional value сделки
   *
   * @returns Notional value (цена × количество)
   *
   * @remarks
   * Notional = Price × Quantity
   *
   * Представляет общую стоимость сделки в USDC.
   * Используется для:
   * - Расчёта объёмов торговли
   * - Анализа ликвидности
   * - Вычисления комиссий
   *
   * Пример:
   * - Price: 0.65
   * - Quantity: 100
   * - Notional: 65.00 USDC
   *
   * @example
   * ```typescript
   * const trade = Trade.create({
   *   id: 'trade-1',
   *   marketId: 'market-123',
   *   price: Price.fromNumber(0.65),
   *   quantity: Quantity.fromNumber(100),
   *   side: 'BUY',
   *   timestamp: new Date()
   * });
   *
   * const notional = trade.getNotional();
   * console.log(notional); // 65.0
   * ```
   */
  public getNotional(): number {
    return this.price.value * this.quantity.value;
  }

  /**
   * Получает возраст сделки в миллисекундах
   *
   * @returns Возраст в мс с момента timestamp
   *
   * @remarks
   * Вычисляет время, прошедшее с момента исполнения сделки.
   * Используется для фильтрации старых сделок.
   *
   * @example
   * ```typescript
   * const ageMs = trade.getAgeMs();
   * if (ageMs < 60000) {
   *   console.log('Recent trade (less than 1 minute old)');
   * }
   * ```
   */
  public getAgeMs(): number {
    return Date.now() - this.timestamp.getTime();
  }

  /**
   * Проверяет, является ли сделка недавней
   *
   * @param maxAgeMs - Максимальный возраст в мс (по умолчанию 60000 = 1 минута)
   * @returns True если сделка произошла не позже maxAgeMs назад
   *
   * @remarks
   * Удобный метод для фильтрации недавних сделок.
   * Используется в анализе краткосрочного давления на рынок.
   *
   * @example
   * ```typescript
   * // Проверяем сделки за последние 30 секунд
   * if (trade.isRecent(30000)) {
   *   console.log('This is a recent trade');
   * }
   *
   * // По умолчанию проверяет за последнюю минуту
   * if (trade.isRecent()) {
   *   console.log('Trade happened in last minute');
   * }
   * ```
   */
  public isRecent(maxAgeMs: number = 60000): boolean {
    return this.getAgeMs() <= maxAgeMs;
  }

  /**
   * Проверяет, является ли сделка покупкой
   *
   * @returns True если side === 'BUY'
   *
   * @remarks
   * BUY сделка означает, что taker купил (aggressive buyer).
   * Увеличивает покупательское давление на рынок.
   *
   * @example
   * ```typescript
   * if (trade.isBuy()) {
   *   console.log('Buying pressure');
   * }
   * ```
   */
  public isBuy(): boolean {
    return this.side === 'BUY';
  }

  /**
   * Проверяет, является ли сделка продажей
   *
   * @returns True если side === 'SELL'
   *
   * @remarks
   * SELL сделка означает, что taker продал (aggressive seller).
   * Увеличивает продавательское давление на рынок.
   *
   * @example
   * ```typescript
   * if (trade.isSell()) {
   *   console.log('Selling pressure');
   * }
   * ```
   */
  public isSell(): boolean {
    return this.side === 'SELL';
  }

  /**
   * Сравнивает сделки по времени
   *
   * @param other - Другая сделка для сравнения
   * @returns Отрицательное если эта сделка раньше, положительное если позже, 0 если одновременно
   *
   * @remarks
   * Используется для сортировки сделок по времени.
   * Возвращает результат в формате, совместимом с Array.sort().
   *
   * @example
   * ```typescript
   * const trades = [trade1, trade2, trade3];
   *
   * // Сортировка по возрастанию (старые → новые)
   * trades.sort((a, b) => a.compareByTime(b));
   *
   * // Сортировка по убыванию (новые → старые)
   * trades.sort((a, b) => b.compareByTime(a));
   * ```
   */
  public compareByTime(other: Trade): number {
    return this.timestamp.getTime() - other.timestamp.getTime();
  }

  /**
   * Конвертирует в строковое представление
   *
   * @returns Строковое представление сделки
   *
   * @example
   * ```typescript
   * console.log(trade.toString());
   * // "Trade[trade-1]: BUY 100.00 @ 0.6500 (2024-01-15T10:30:00.000Z)"
   * ```
   */
  public toString(): string {
    return `Trade[${this.id}]: ${this.side} ${this.quantity.toString()} @ ${this.price.toString()} (${this.timestamp.toISOString()})`;
  }

  /**
   * Конвертирует в объект
   *
   * @returns Объектное представление сделки
   *
   * @remarks
   * Полезно для сериализации, логирования и API ответов.
   *
   * @example
   * ```typescript
   * const obj = trade.toObject();
   * console.log(JSON.stringify(obj, null, 2));
   * ```
   */
  public toObject() {
    return {
      id: this.id,
      marketId: this.marketId,
      price: this.price.value,
      quantity: this.quantity.value,
      side: this.side,
      timestamp: this.timestamp.toISOString(),
      notional: this.getNotional(),
      ageMs: this.getAgeMs(),
      orderId: this.orderId,
      makerOrderId: this.makerOrderId,
      takerOrderId: this.takerOrderId,
    };
  }

  /**
   * Конвертирует в JSON
   *
   * @returns JSON представление сделки
   *
   * @example
   * ```typescript
   * const json = trade.toJSON();
   * console.log(JSON.stringify(json, null, 2));
   * ```
   */
  public toJSON(): Record<string, unknown> {
    return this.toObject();
  }
}
