/**
 * Порт: каталог инструментов для application layer.
 *
 * @remarks
 * `IMarketCatalog` — application-layer порт (Dependency Inversion).
 * Инфраструктурная реализация `PolymarketMarketCatalog` (@polymarket/exchange)
 * имплементирует этот интерфейс и заполняет каталог из REST API при старте.
 *
 * Строки из REST API (tick size, min order size) парсятся в domain VOs
 * на границе инфраструктуры — application layer уже работает с типизированными объектами.
 *
 * Используется:
 * - BookUpdateHandler — `catalog.get(tokenId)` → `InstrumentInfo.instrumentId`
 * - OrderRiskChecker — `catalog.get(tokenId)?.tickSize` (уже OutcomePrice, не string)
 * - PolymarketExchangeClientAdapter — маппинг параметров ордера
 */
import type { InstrumentId, MarketId } from '@polymarket/ids';
import type { Money, OutcomePrice, Quantity } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/timestamp';

/**
 * Метаданные торгового инструмента.
 *
 * @remarks
 * Заполняется из @polymarket/exchange при старте системы.
 * Все поля уже типизированы — не нужно парсить строки в application layer.
 */
export interface InstrumentInfo {
  /** ID токена (UP/DOWN outcome token) — типизированный branded type */
  readonly instrumentId: InstrumentId;
  /** ID рынка (condition_id в Polymarket API) */
  readonly marketId: MarketId;
  /** Минимальный шаг цены */
  readonly tickSize: OutcomePrice;
  /** Минимальный размер ордера в токенах */
  readonly minOrderSize: Quantity;
  /**
   * Минимальная стоимость ордера в USDC (price × size >= minOrderValue).
   * Polymarket требует >= $1 для BUY-ордеров.
   * Дефолт: Money.of(new Decimal('1'), 'USDC')
   *
   * @remarks
   * Money, а НЕ Quantity: это денежный notional (USDC), а не количество токенов.
   */
  readonly minOrderValue: Money;
  /** Активен ли рынок */
  readonly active: boolean;
  /** Время истечения рынка (используется ExpirationRemovalPolicy) */
  readonly expiresAt: Timestamp;
}

/**
 * Порт: каталог инструментов.
 *
 * @remarks
 * Расширенный интерфейс поддерживает как чтение (get/getAll/getByMarketId),
 * так и запись (register/remove/clear). Это позволяет MarketDiscoveryPublisher
 * динамически наполнять каталог при обнаружении рынков.
 *
 * @example
 * ```typescript
 * const info = catalog.get(tokenId);
 * if (!info) {
 *   throw new Error(`Unknown instrument: ${tokenId}`);
 * }
 * // info.tickSize уже OutcomePrice — не нужно парсить строку
 * riskChecker.validatePrice(price, info.tickSize);
 *
 * // Атомарная регистрация рынка (оба outcome-токена сразу):
 * catalog.registerMarket({ marketId, instruments: [yesInfo, noInfo] });
 *
 * // Удаление рынка целиком (все outcome-токены):
 * catalog.removeMarket(marketId);
 * ```
 */
export interface IMarketCatalog {
  /**
   * Возвращает метаданные инструмента по InstrumentId.
   *
   * @param instrumentId - ID токена (UP/DOWN outcome token)
   * @returns InstrumentInfo или undefined если инструмент неизвестен
   */
  get(instrumentId: InstrumentId): InstrumentInfo | undefined;

  /**
   * Возвращает метаданные ОДНОГО инструмента по MarketId (condition_id).
   *
   * @param marketId - ID рынка (condition_id в Polymarket API)
   * @returns InstrumentInfo или undefined если рынок неизвестен
   *
   * @deprecated Use getAnyInstrumentByMarketIdForMetadataOnly() for metadata-only cases
   * and getAllByMarketId() for market-wide logic.
   *
   * @remarks
   * ⚠️ Один market может иметь НЕСКОЛЬКО outcome-токенов (бинарный рынок
   * Polymarket — YES/NO, каждый со своим `instrumentId`, но одним `marketId`),
   * а этот метод возвращает только ПЕРВЫЙ зарегистрированный — из имени это
   * не видно, что делает его foot-gun для market-wide логики. Оставлен как
   * backward-compatible alias `getAnyInstrumentByMarketIdForMetadataOnly()`.
   */
  getByMarketId(marketId: MarketId): InstrumentInfo | undefined;

  /**
   * Возвращает ЛЮБОЙ (первый зарегистрированный) инструмент рынка —
   * ТОЛЬКО для metadata-only сценариев.
   *
   * @param marketId - ID рынка (condition_id в Polymarket API)
   * @returns InstrumentInfo или undefined если рынок неизвестен
   *
   * @remarks
   * Название намеренно длинное: допустимые кейсы — те, где достаточно любого
   * outcome-токена рынка (чтение `tickSize`/`minOrderSize`, metadata preview).
   * НЕ использовать для закрытия рынка, settlement, cancel-all, reconciliation
   * или поиска ордеров — там пропуск второго outcome-токена является багом,
   * используй `getAllByMarketId()`.
   */
  getAnyInstrumentByMarketIdForMetadataOnly(marketId: MarketId): InstrumentInfo | undefined;

  /**
   * Возвращает ВСЕ инструменты (outcome-токены) заданного MarketId.
   *
   * @param marketId - ID рынка (condition_id в Polymarket API)
   * @returns Readonly массив InstrumentInfo (пустой, если рынок неизвестен)
   *
   * @remarks
   * В отличие от `getByMarketId()` (первый инструмент), возвращает всех
   * outcome-токенов рынка. Обязателен для любого сценария, где пропуск
   * второго outcome-токена бинарного рынка (YES/NO) был бы багом —
   * например, `IOrderRepository.getByMarketId()` при закрытии рынка.
   */
  getAllByMarketId(marketId: MarketId): readonly InstrumentInfo[];

  /**
   * Возвращает все загруженные инструменты.
   *
   * @returns Readonly массив всех InstrumentInfo
   */
  getAll(): readonly InstrumentInfo[];

  /**
   * Регистрирует (или обновляет) инструмент в каталоге.
   *
   * @param instrument - Метаданные инструмента для регистрации
   *
   * @remarks
   * Если инструмент с таким instrumentId уже существует — перезаписывает его.
   * Вызывается MarketDiscoveryPublisher._discover() для наполнения каталога
   * из результатов IMarketDiscoveryService.findCandidates().
   *
   * @example
   * ```typescript
   * catalog.register({
   *   instrumentId,
   *   marketId,
   *   tickSize: OutcomePrice.of(new Decimal('0.01')),
   *   minOrderSize: Quantity.of(new Decimal('1')),
   *   active: true,
   * });
   * ```
   */
  register(instrument: InstrumentInfo): void;

  /**
   * Атомарно регистрирует (или обновляет) ВСЕ инструменты одного рынка.
   *
   * @param input - `{ marketId, instruments }` — все outcome-токены рынка
   * @throws {Error} Если `instruments` пуст — пустая регистрация рынка почти
   *   всегда bug вызывающего кода (потерян список токенов), молчаливый no-op
   *   замаскировал бы его
   * @throws {Error} Если хотя бы один instrument имеет
   *   `instrument.marketId !== input.marketId` — при этом НЕ регистрируется
   *   НИЧЕГО (validate-first, затем mutate: partial mutation исключена)
   *
   * @remarks
   * Предпочтительный способ регистрации бинарного рынка (YES/NO пачкой) —
   * в отличие от последовательных `register()` не создаёт окна, в котором
   * `getAllByMarketId()` видит рынок с частью outcome-токенов.
   * Уже существующие в каталоге инструменты этого рынка, не вошедшие в
   * `input.instruments`, НЕ удаляются (upsert, не replace).
   *
   * @example
   * ```typescript
   * catalog.registerMarket({
   *   marketId,
   *   instruments: [yesInstrumentInfo, noInstrumentInfo],
   * });
   * ```
   */
  registerMarket(input: {
    readonly marketId: MarketId;
    readonly instruments: readonly InstrumentInfo[];
  }): void;

  /**
   * Удаляет ВСЕ инструменты рынка из каталога.
   *
   * @param marketId - ID рынка
   *
   * @remarks
   * Безопасная альтернатива паре `getByMarketId()` + `remove()` при закрытии
   * рынка: удаляет все outcome-токены, а не только первый зарегистрированный.
   * Неизвестный marketId — no-op (не бросает).
   */
  removeMarket(marketId: MarketId): void;

  /**
   * Удаляет инструмент из каталога по InstrumentId.
   *
   * @param instrumentId - ID токена для удаления
   *
   * @remarks
   * Если инструмент не найден — no-op (не бросает ошибку).
   * Для закрытия рынка целиком используй `removeMarket(marketId)` —
   * он удаляет ВСЕ outcome-токены, а не один.
   *
   * @example
   * ```typescript
   * catalog.remove(instrumentId);
   * ```
   */
  remove(instrumentId: InstrumentId): void;

  /**
   * Удаляет все инструменты из каталога.
   *
   * @remarks
   * Используется при полном сбросе состояния системы
   * (например, перед перезагрузкой конфигурации рынков).
   *
   * @example
   * ```typescript
   * catalog.clear();
   * // После clear() catalog.getAll() возвращает []
   * ```
   */
  clear(): void;
}
