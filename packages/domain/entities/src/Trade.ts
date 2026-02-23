/**
 * Trade entity - исполненная сделка
 *
 * @remarks
 * Представляет исполненную сделку на рынке.
 * Immutable entity для хранения истории сделок.
 *
 * **Денормализация:** Trade хранит tokenId напрямую (дублирование данных)
 * вместо ссылки только на marketId. Это оптимизация для производительности -
 * позволяет быстро фильтровать сделки по токену без JOIN с Market.
 *
 * **Алгоритм:**
 * 1. Хранит детали сделки: цена, количество, сторона, время
 * 2. Вычисляет notional value (цена × количество)
 * 3. Предоставляет методы для анализа сделок
 *
 * **Использование:**
 * - Запись истории исполненных ордеров
 * - Анализ рыночной активности
 * - Расчёт VWAP (volume-weighted average price)
 * - Построение графиков объёмов
 * - Определение направления рынка (buying/selling pressure)
 *
 * @example
 * ```typescript
 * const result = Trade.create({
 *   id: 'trade-1',
 *   marketId: 'market-123',
 *   tokenId: 'token-up-456',
 *   price: Price.fromValue(0.65),
 *   size: Quantity.fromValue(100),
 *   side: 'BUY',
 *   timestamp: new Date(),
 *   transactionHash: '0x1234...'
 * });
 *
 * if (result.ok) {
 *   const trade = result.value;
 *   console.log(`Trade: ${trade.side} ${trade.size.value} @ ${trade.price.value}`);
 *   console.log(`Notional: ${trade.getNotional()}`);
 * }
 * ```
 */
import { Price, Quantity, Money, type Side } from '@polymarket/value-objects';
import { TradeValidationError } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';
import Decimal from 'decimal.js';

/**
 * Параметры для создания Trade
 *
 * @remarks
 * Все поля кроме orderId, fee, reasonCode, metadata обязательны.
 * - orderId: опциональный - может быть null если сделка не принадлежит нашей системе
 * - fee: опциональная комиссия за сделку (default = 0 USDC)
 * - reasonCode: код причины возникновения трейда
 * - metadata: дополнительные данные
 */
export interface TradeParams {
  /** Уникальный ID сделки */
  readonly id: string;
  /** ID рынка */
  readonly marketId: string;
  /** ID outcome токена (денормализация для быстрого поиска по токену) */
  readonly tokenId: string;
  /** Цена исполнения */
  readonly price: Price;
  /** Размер сделки (количество токенов) */
  readonly size: Quantity;
  /** Сторона сделки (BUY или SELL) */
  readonly side: Side;
  /** Timestamp исполнения */
  readonly timestamp: Date;
  /** Хеш транзакции в блокчейне */
  readonly transactionHash: string;
  /** ID нашего ордера (если это наша сделка) */
  readonly orderId?: string;
  /** Комиссия за сделку в USDC (опционально, по умолчанию 0) */
  readonly fee?: Money;
  /**
   * Код причины возникновения трейда
   *
   * Примеры:
   * - "match_on_book" - обычный матч на бирже
   * - "reconciliation" - корректировочный трейд для синхронизации
   * - "manual" - ручной трейд
   * - "paper_trading" - paper trading simulation
   * - "backtest" - backtest simulation
   */
  readonly reasonCode?: string;
  /** Дополнительные метаданные (напр. taker_order_id, maker_order_ids из Polymarket) */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Trade entity
 *
 * @remarks
 * Immutable entity представляющая исполненную сделку.
 * Все свойства readonly для обеспечения неизменяемости.
 */
export class Trade {
  /** Уникальный ID сделки */
  public readonly id: string;

  /** ID рынка */
  public readonly marketId: string;

  /** ID outcome токена */
  public readonly tokenId: string;

  /** Цена исполнения */
  public readonly price: Price;

  /** Размер сделки (quantity переименован в size для соответствия Polymarket API) */
  public readonly size: Quantity;

  /** Сторона сделки (BUY или SELL) */
  public readonly side: Side;

  /** Timestamp исполнения */
  public readonly timestamp: Date;

  /** Хеш транзакции в блокчейне */
  public readonly transactionHash: string;

  /** ID нашего ордера (если это наша сделка) */
  public readonly orderId?: string;

  /** Комиссия за сделку */
  public readonly fee: Money;

  /** Код причины возникновения трейда */
  public readonly reasonCode?: string;

  /** Дополнительные метаданные */
  public readonly metadata?: Record<string, unknown>;

  /**
   * Приватный конструктор
   *
   * @param params - Параметры сделки
   *
   * @remarks
   * Конструктор приватный для использования только через factory методы.
   * Используйте Trade.create() или Trade.fromValue().
   */
  private constructor(params: TradeParams) {
    this.id = params.id;
    this.marketId = params.marketId;
    this.tokenId = params.tokenId;
    this.price = params.price;
    this.size = params.size;
    this.side = params.side;
    this.timestamp = params.timestamp;
    this.transactionHash = params.transactionHash;
    this.orderId = params.orderId;
    this.fee = params.fee ?? Money.zero('USDC');  // default 0 USDC
    this.reasonCode = params.reasonCode;
    this.metadata = params.metadata;
  }

  /**
   * Создаёт новый Trade с валидацией
   *
   * @param params - Параметры сделки
   * @returns Result<Trade, TradeValidationError> - Ok(trade) или Err(error)
   *
   * @remarks
   * Factory метод с полной валидацией всех параметров.
   *
   * **Валидирует:**
   * 1. ID не пустой
   * 2. MarketId не пустой
   * 3. TokenId не пустой
   * 4. Size положительный
   * 5. Side корректный ('BUY' или 'SELL')
   * 6. Timestamp валидный
   * 7. TransactionHash не пустой
   *
   * Если все валидации пройдены, возвращает Ok(Trade).
   * При ошибке валидации возвращает Err(TradeValidationError).
   *
   * @example
   * ```typescript
   * const result = Trade.create({
   *   id: 'trade-1',
   *   marketId: 'market-123',
   *   tokenId: 'token-up-456',
   *   price: Price.fromValue(0.65),
   *   size: Quantity.fromValue(100),
   *   side: 'BUY',
   *   timestamp: new Date(),
   *   transactionHash: '0x1234...',
   *   orderId: 'order-1'
   * });
   *
   * if (result.ok) {
   *   const trade = result.value;
   *   console.log(`Trade created: ${trade.id}`);
   * } else {
   *   console.error('Validation failed:', result.error.message);
   * }
   * ```
   */
  public static create(params: TradeParams): Result<Trade, TradeValidationError> {
    // Валидация ID
    if (!params.id || typeof params.id !== 'string' || params.id.trim() === '') {
      return Err(
        new TradeValidationError('Trade ID must be a non-empty string', {
          context: { field: 'id', value: params.id }
        })
      );
    }

    // Валидация marketId
    if (!params.marketId || typeof params.marketId !== 'string' || params.marketId.trim() === '') {
      return Err(
        new TradeValidationError('Market ID must be a non-empty string', {
          context: { field: 'marketId', tradeId: params.id, value: params.marketId }
        })
      );
    }

    // Валидация tokenId
    if (!params.tokenId || typeof params.tokenId !== 'string' || params.tokenId.trim() === '') {
      return Err(
        new TradeValidationError('Token ID must be a non-empty string', {
          context: { field: 'tokenId', tradeId: params.id, value: params.tokenId }
        })
      );
    }

    // Валидация size положительный
    if (!params.size.isPositive()) {
      return Err(
        new TradeValidationError('Trade size must be positive', {
          context: { field: 'size', tradeId: params.id, value: params.size.value }
        })
      );
    }

    // Валидация side
    if (params.side !== 'BUY' && params.side !== 'SELL') {
      return Err(
        new TradeValidationError(`Invalid trade side: ${params.side}`, {
          context: {
            field: 'side',
            tradeId: params.id,
            value: params.side,
            validValues: ['BUY', 'SELL']
          }
        })
      );
    }

    // Валидация timestamp
    if (!(params.timestamp instanceof Date) || isNaN(params.timestamp.getTime())) {
      return Err(
        new TradeValidationError('Invalid timestamp', {
          context: { field: 'timestamp', tradeId: params.id, value: params.timestamp }
        })
      );
    }

    // Валидация transactionHash
    if (
      !params.transactionHash ||
      typeof params.transactionHash !== 'string' ||
      params.transactionHash.trim() === ''
    ) {
      return Err(
        new TradeValidationError('Transaction hash must be a non-empty string', {
          context: { field: 'transactionHash', tradeId: params.id, value: params.transactionHash }
        })
      );
    }

    // Создаём Trade instance
    return Ok(new Trade(params));
  }

  /**
   * Создаёт Trade из внешних данных (API, WebSocket и т.д.)
   *
   * @param data - Данные сделки из внешнего источника
   * @returns Result<Trade, TradeValidationError> - Ok(trade) или Err(error)
   *
   * @remarks
   * Парсит данные из внешнего источника (Polymarket API, WebSocket и т.д.) и создаёт Trade entity.
   *
   * **Формат события Polymarket:**
   * ```json
   * {
   *   "market": "0xb9ed6ed...",
   *   "asset_id": "62305814...",
   *   "price": "0.44",
   *   "size": "4.090908",
   *   "side": "BUY",
   *   "timestamp": "1767463213145",
   *   "event_type": "last_trade_price",
   *   "transaction_hash": "0x0b5f0c77..."
   * }
   * ```
   *
   * Автоматически преобразует:
   * - `market` → `marketId`
   * - `asset_id` → `tokenId` (outcome token ID)
   * - `price` (string) → Price value object
   * - `size` (string) → Quantity value object
   * - `timestamp` (milliseconds string) → Date
   * - Генерирует уникальный `id` из `transaction_hash` + `timestamp`
   *
   * @example
   * ```typescript
   * const data = {
   *   market: 'market-123',
   *   asset_id: 'token-up-456',
   *   price: '0.65',
   *   size: '100.5',
   *   side: 'BUY',
   *   timestamp: '1767463213145',
   *   transaction_hash: '0x1234abcd...'
   * };
   *
   * const result = Trade.fromValue(data);
   * if (result.ok) {
   *   const trade = result.value;
   *   console.log(`Trade: ${trade.side} ${trade.size.value} @ ${trade.price.value}`);
   * }
   * ```
   */
  public static fromValue(
    data: Record<string, unknown>
  ): Result<Trade, TradeValidationError> {
    // Валидация что data это объект
    if (typeof data !== 'object' || data === null) {
      return Err(
        new TradeValidationError('Data must be an object', {
          context: { value: data }
        })
      );
    }

    // Парсинг price
    const priceResult = Price.fromValue(data.price as string | number);
    if (!priceResult.ok) {
      return Err(
        new TradeValidationError(`Invalid price: ${priceResult.error.message}`, {
          context: { value: data.price }
        })
      );
    }

    // Парсинг size
    const sizeResult = Quantity.fromValue(data.size as string | number);
    if (!sizeResult.ok) {
      return Err(
        new TradeValidationError(`Invalid size: ${sizeResult.error.message}`, {
          context: { value: data.size }
        })
      );
    }

    // Парсинг timestamp
    let timestamp: Date;
    try {
      const timestampMs =
        typeof data.timestamp === 'string'
          ? parseInt(data.timestamp, 10)
          : (data.timestamp as number);
      timestamp = new Date(timestampMs);
      if (isNaN(timestamp.getTime())) {
        throw new Error('Invalid date');
      }
    } catch (error) {
      return Err(
        new TradeValidationError(
          `Invalid timestamp: ${error instanceof Error ? error.message : 'unknown error'}`,
          {
            context: { value: data.timestamp }
          }
        )
      );
    }

    // Используем transaction_hash как ID (он уже уникальный)
    const id = data.transaction_hash as string;

    // Создаём Trade через create() для полной валидации
    return Trade.create({
      id,
      marketId: data.market as string,
      tokenId: data.asset_id as string,
      price: priceResult.value,
      size: sizeResult.value,
      side: (data.side as string).toUpperCase() as Side,
      timestamp,
      transactionHash: data.transaction_hash as string
    });
  }

  /**
   * Вычисляет notional value сделки
   *
   * @returns Notional value (цена × размер)
   *
   * @remarks
   * Notional = Price × Size
   *
   * Представляет общую стоимость сделки в USDC.
   *
   * **Используется для:**
   * - Расчёта объёмов торговли
   * - Анализа ликвидности
   * - Вычисления комиссий
   *
   * **Пример:**
   * - Price: 0.65
   * - Size: 100
   * - Notional: 65.00 USDC
   *
   * @example
   * ```typescript
   * const result = Trade.create({
   *   id: 'trade-1',
   *   marketId: 'market-123',
   *   tokenId: 'token-up-456',
   *   price: Price.fromValue(0.65),
   *   size: Quantity.fromValue(100),
   *   side: 'BUY',
   *   timestamp: new Date(),
   *   transactionHash: '0x1234...'
   * });
   *
   * if (result.ok) {
   *   const notional = result.value.getNotional();
   *   console.log(notional); // 65.0
   * }
   * ```
   */
  public getNotional(): number {
    return this.price.value * this.size.value;
  }

  /**
   * Вычисляет notional value сделки с высокой точностью
   *
   * @returns Notional value как Decimal (цена × размер)
   *
   * @remarks
   * Использует Decimal.js для точных финансовых вычислений без потери точности.
   * Рекомендуется использовать этот метод вместо getNotional() для финансовых расчётов.
   *
   * **Notional = Price × Size**
   *
   * **Зачем нужен Decimal?**
   * - Избегает ошибок округления floating-point арифметики
   * - Гарантирует точность до 20 знаков после запятой
   * - Критично для финансовых расчётов (комиссии, PnL, налоги)
   *
   * **Используется для:**
   * - Точного расчёта объёмов торговли
   * - Вычисления комиссий без потери точности
   * - Анализа PnL (profit and loss)
   * - Бухгалтерских операций
   *
   * @example
   * ```typescript
   * const result = Trade.create({
   *   id: 'trade-1',
   *   marketId: 'market-123',
   *   tokenId: 'token-up-456',
   *   price: Price.fromValue(0.65),
   *   size: Quantity.fromValue(100),
   *   side: 'BUY',
   *   timestamp: new Date(),
   *   transactionHash: '0x1234...'
   * });
   *
   * if (result.ok) {
   *   const notionalDecimal = result.value.getNotionalDecimal();
   *   console.log(notionalDecimal.toString()); // "65.00"
   *   console.log(notionalDecimal.toFixed(4)); // "65.0000"
   *
   *   // Для финансовых расчётов с высокой точностью
   *   const fee = notionalDecimal.mul(0.001); // 0.1% комиссия
   *   console.log(fee.toString()); // "0.065"
   * }
   * ```
   */
  public getNotionalDecimal(): Decimal {
    return new Decimal(this.price.value).mul(this.size.value);
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
   * Сериализует Trade в JSON объект
   *
   * @returns JSON представление сделки
   *
   * @remarks
   * Преобразует все поля в JSON-совместимый формат:
   * - Date → ISO string
   * - Price/Quantity → number values
   * - Включает вычисляемые поля: notional
   *
   * Используется для:
   * - Сохранения состояния в storage
   * - Передачи через API
   * - Логирования
   *
   * @example
   * ```typescript
   * const json = trade.toJSON();
   * console.log(JSON.stringify(json, null, 2));
   * // {
   * //   "id": "trade-1",
   * //   "marketId": "market-123",
   * //   "tokenId": "token-yes-456",
   * //   "price": 0.65,
   * //   "size": 100,
   * //   "side": "BUY",
   * //   "timestamp": "2024-01-15T10:30:00.000Z",
   * //   "transactionHash": "0x1234...",
   * //   "notional": 65.0,
   * //   "orderId": "order-1"
   * // }
   * ```
   */
  public toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      marketId: this.marketId,
      tokenId: this.tokenId,
      price: this.price.value,
      size: this.size.value,
      side: this.side,
      timestamp: this.timestamp.toISOString(),
      transactionHash: this.transactionHash,
      orderId: this.orderId,
      fee: this.fee.getAmount(),
      feeCurrency: this.fee.getCurrency(),
      reasonCode: this.reasonCode,
      metadata: this.metadata,
      notional: this.getNotional()
    };
  }

  /**
   * Десериализует Trade из JSON объекта
   *
   * @param json - JSON представление сделки
   * @returns Result<Trade, TradeValidationError> - Ok(trade) или Err(error)
   *
   * @remarks
   * Парсит JSON и создаёт Trade instance через create().
   * Выполняет полную валидацию всех полей.
   *
   * **Ожидаемый формат JSON:**
   * - id: string
   * - marketId: string
   * - tokenId: string
   * - price: number
   * - size: number
   * - side: 'BUY' | 'SELL'
   * - timestamp: ISO date string
   * - transactionHash: string
   * - orderId?: string (optional)
   *
   * @example
   * ```typescript
   * const json = {
   *   id: 'trade-1',
   *   marketId: 'market-123',
   *   tokenId: 'token-up-456',
   *   price: 0.65,
   *   size: 100,
   *   side: 'BUY',
   *   timestamp: '2024-01-15T10:30:00.000Z',
   *   transactionHash: '0x1234...'
   * };
   *
   * const result = Trade.fromJSON(json);
   * if (result.ok) {
   *   const trade = result.value;
   *   console.log(`Trade: ${trade.id}`);
   * }
   * ```
   */
  public static fromJSON(json: unknown): Result<Trade, TradeValidationError> {
    // Проверка что json это объект
    if (typeof json !== 'object' || json === null) {
      return Err(
        new TradeValidationError('JSON must be an object', {
          context: { value: json }
        })
      );
    }

    const obj = json as Record<string, unknown>;

    // Парсинг price
    const priceResult = Price.fromValue(obj.price as number);
    if (!priceResult.ok) {
      return Err(
        new TradeValidationError(`Invalid price: ${priceResult.error.message}`, {
          context: { field: 'price', value: obj.price }
        })
      );
    }

    // Парсинг size
    const sizeResult = Quantity.fromValue(obj.size as number);
    if (!sizeResult.ok) {
      return Err(
        new TradeValidationError(`Invalid size: ${sizeResult.error.message}`, {
          context: { field: 'size', value: obj.size }
        })
      );
    }

    // Парсинг timestamp
    let timestamp: Date;
    try {
      if (typeof obj.timestamp !== 'string') {
        throw new Error('timestamp must be a string');
      }
      timestamp = new Date(obj.timestamp);
      if (isNaN(timestamp.getTime())) {
        throw new Error('Invalid date format');
      }
    } catch (error) {
      return Err(
        new TradeValidationError(
          `Invalid timestamp: ${error instanceof Error ? error.message : 'unknown error'}`,
          {
            context: { field: 'timestamp', value: obj.timestamp }
          }
        )
      );
    }

    // Парсинг fee (опционально)
    let fee: Money | undefined;
    if (obj.fee !== undefined && obj.fee !== null) {
      const feeAmount = typeof obj.fee === 'number' ? obj.fee : Number(obj.fee);
      const feeCurrency = (typeof obj.feeCurrency === 'string' ? obj.feeCurrency : 'USDC') as 'USDC';
      const feeResult = Money.fromValue(feeAmount, feeCurrency);
      if (!feeResult.ok) {
        return Err(
          new TradeValidationError(`Invalid fee: ${feeResult.error.message}`, {
            context: { field: 'fee', value: obj.fee }
          })
        );
      }
      fee = feeResult.value;
    }

    // Парсинг reasonCode (опционально)
    const reasonCode = typeof obj.reasonCode === 'string' ? obj.reasonCode : undefined;

    // Парсинг metadata (опционально)
    const metadata =
      typeof obj.metadata === 'object' && obj.metadata !== null
        ? (obj.metadata as Record<string, unknown>)
        : undefined;

    // Создаём Trade через create() для полной валидации
    return Trade.create({
      id: obj.id as string,
      marketId: obj.marketId as string,
      tokenId: obj.tokenId as string,
      price: priceResult.value,
      size: sizeResult.value,
      side: obj.side as Side,
      timestamp,
      transactionHash: obj.transactionHash as string,
      orderId: obj.orderId as string | undefined,
      fee,
      reasonCode,
      metadata
    });
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
    return `Trade[${this.id}]: ${this.side} ${this.size.toString()} @ ${this.price.toString()} (${this.timestamp.toISOString()})`;
  }
}
