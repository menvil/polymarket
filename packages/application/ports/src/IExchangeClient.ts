/**
 * Порт: клиент для взаимодействия с торговой площадкой.
 *
 * @remarks
 * Dependency Inversion — use-cases зависят от этого интерфейса,
 * а не от конкретной инфраструктурной реализации.
 *
 * Реализация: `PolymarketExchangeClientAdapter` в пакете `@polymarket/exchange`
 * (директория `packages/infrastructure/polymarket`, Phase 8). Для бектестов —
 * `MockExchangeClient` в `packages/infrastructure/backtesting`.
 *
 * Используется:
 * - PlaceOrderUseCase — `submitOrder()` → получить OrderId от биржи
 * - CancelOrderUseCase — `cancelOrder()` → отменить ордер на бирже
 * - ReconcileOrdersUseCase — `getOpenOrders()` → сверить открытые ордера
 * - ReconcileTradesUseCase — `getTrades()` → сверить исполнения
 */
import type Decimal from 'decimal.js';
import type { Result } from '@polymarket/result';
import type { OrderId, AssetId, AccountId, StrategyId } from '@polymarket/ids';
import type { Price, Quantity, Side, Timestamp } from '@polymarket/value-objects';
import { TradingError } from '@polymarket/errors';
import type { OpenOrderSnapshot } from './types/OpenOrderSnapshot.js';
import type { VenueTradeSnapshot } from './types/VenueTradeSnapshot.js';

/**
 * Ambiguity транспортной ошибки `submitOrder` — дошла ли отправка до venue.
 *
 * @remarks
 * - `DEFINITELY_NOT_SUBMITTED` — ошибка ДО отправки запроса на venue
 *   (local validation, preflight-проверка баланса и т.п.). Ордер точно не
 *   создан → безопасен чистый rollback резервации + Err.
 * - `MAY_HAVE_BEEN_SUBMITTED` — ошибка ПОСЛЕ отправки запроса (timeout,
 *   network drop, неоднозначный ответ API). Venue-ордер МОГ быть создан →
 *   вызывающий код обязан трактовать как ambiguous (UNKNOWN-like): best-effort
 *   rollback + reconciliation issue, БЕЗ создания обычного Order.
 */
export type SubmitAmbiguity = 'DEFINITELY_NOT_SUBMITTED' | 'MAY_HAVE_BEEN_SUBMITTED';

/**
 * Ошибка при взаимодействии с биржей.
 *
 * @remarks
 * Severity 'high' — требует немедленного внимания и обычно останавливает стратегию.
 *
 * `submitOutcome` — ТОЛЬКО для ошибок `submitOrder`: могла ли отправка дойти до
 * venue (см. `SubmitAmbiguity`). Если поле не задано, вызывающий код обязан
 * применять conservative default `MAY_HAVE_BEEN_SUBMITTED` (для live trading
 * безопаснее считать ордер потенциально созданным). Адаптеры должны явно
 * помечать pre-dispatch validation ошибки как `DEFINITELY_NOT_SUBMITTED`.
 */
export class ExchangeError extends TradingError {
  public readonly severity = 'high' as const;

  /** Только для submitOrder: ambiguity отправки (см. `SubmitAmbiguity`). */
  public readonly submitOutcome?: SubmitAmbiguity;

  /**
   * @param message - Сообщение ошибки
   * @param options - Опции: стандартные `code`/`context` (TradingError) плюс
   *   `submitOutcome` для классификации ambiguity отправки submitOrder
   */
  constructor(
    message: string,
    options?: {
      readonly code?: string;
      readonly context?: Record<string, unknown>;
      readonly submitOutcome?: SubmitAmbiguity;
    },
  ) {
    super(message, options);
    this.submitOutcome = options?.submitOutcome;
  }
}

// Re-export snapshot types для удобства импорта из @polymarket/ports
/** Реэкспорт снимка открытого ордера биржи (см. `types/OpenOrderSnapshot.ts`). */
export type { OpenOrderSnapshot } from './types/OpenOrderSnapshot.js';
/** Реэкспорт типов снимка исполненной сделки (см. `types/VenueTradeSnapshot.ts`). */
export type { VenueTradeSnapshot, VenueTradeStatus, FeeSnapshot } from './types/VenueTradeSnapshot.js';

/**
 * Параметры для размещения лимитного ордера.
 */
export interface SubmitOrderParams {
  /** Токен для торговли (UP/DOWN outcome token) */
  readonly asset: AssetId;
  /** Сторона сделки */
  readonly side: Side;
  /** Цена ордера */
  readonly price: Price;
  /** Объём ордера */
  readonly size: Quantity;
  /** true = post-only order; exchange must reject marketable order instead of matching it */
  readonly postOnly?: boolean;
  /**
   * Тип исполнения ордера на venue.
   *
   * @remarks
   * Polymarket CLOB поддерживает:
   * - GTC: rests until filled/cancelled
   * - GTD: rests until expiration
   * - FOK: fill fully immediately or cancel
   * - FAK: fill immediately available quantity and cancel the rest (IOC analogue)
   */
  readonly orderType?: 'GTC' | 'GTD' | 'FOK' | 'FAK';
  /** Клиентский ID ордера для идемпотентного retry (опционально) */
  readonly clientOrderId?: string;
  /** ID стратегии для трекинга (опционально) */
  readonly strategyId?: StrategyId;
}

/**
 * Структурированный бизнес-результат размещения ордера на бирже.
 *
 * @remarks
 * Возвращается внутри `Ok(...)` — `Err(ExchangeError)` зарезервирован только для
 * транспортных/API ошибок (сеть недоступна, аутентификация и т.п.). Все остальные
 * исходы venue — типизированный `status`, по которому переключается вызывающий код
 * (`PlaceOrderUseCase`), НЕ выводя семантику из отдельных boolean-флагов.
 *
 * `effectiveSize` — фактический size, реально отправленный на биржу (может отличаться
 * от `SubmitOrderParams.size`, если адаптер скорректировал его перед отправкой,
 * например SELL dust-adjustment по on-chain балансу). Вызывающий код обязан создавать
 * доменный `Order` с `effectiveSize`, а не с исходным `SubmitOrderParams.size`.
 *
 * - `OPEN` — ордер принят и стоит в стакане, ничего не исполнено
 *   (`remainingSize == effectiveSize`, `filledSize == 0`).
 * - `PARTIALLY_FILLED` — часть ордера исполнена мгновенно, остаток стоит в стакане
 *   (`0 < filledSize < effectiveSize`). Fill details ещё не известны на этом уровне —
 *   реальный `Fill` придёт через WS/reconciliation; здесь только факт частичного исполнения.
 * - `FILLED` — ордер исполнен (полностью или в объёме, который venue вернул как
 *   финальный) и больше не стоит в стакане (`remainingSize == 0`, `filledSize > 0`).
 *   НЕ содержит synthetic fill — только факт «исполнено», конкретные fills приходят
 *   отдельно через WS/reconciliation.
 * - `REJECTED` — venue явно отклонил/провалил ордер без создания live-ордера
 *   (нулевой fill, ничего не осталось в стакане).
 * - `UNKNOWN` — ответ venue не укладывается в безопасную модель (неизвестный статус,
 *   некорректные/противоречивые size-поля). Вызывающий код обязан считать ордер
 *   потенциально live и требовать ручной reconciliation — НЕ создавать обычный OPEN order.
 */
/**
 * Типизированная причина venue-отклонения ордера (REJECTED).
 *
 * @remarks
 * Классификация venue-специфичных текстов ошибок выполняется ИСКЛЮЧИТЕЛЬНО
 * в infrastructure adapter (единственное место, где парсинг сообщений venue
 * допустим). Application layer (`PlaceOrderUseCase`, `ExecutionEngine`)
 * переключается ТОЛЬКО по этому коду и НИКОГДА не парсит `reason`.
 *
 * - `POST_ONLY_WOULD_TAKE` — post-only ордер был бы исполнен немедленно
 *   (marketable) и потому отклонён. Benign-исход для quoting-стратегий.
 * - `INSUFFICIENT_TOKEN_BALANCE` — недостаточно токенов (SELL). Адаптер
 *   ОБЯЗАН заполнить `balance` (числовая metadata) — без неё автоматический
 *   dust-retry на стороне вызывающего кода запрещён.
 * - `INSUFFICIENT_ALLOWANCE` — не выставлен token allowance/approval.
 * - `OTHER` — venue отклонил по иной/нераспознанной причине.
 */
export type SubmitRejectionCode =
  | 'POST_ONLY_WOULD_TAKE'
  | 'INSUFFICIENT_TOKEN_BALANCE'
  | 'INSUFFICIENT_ALLOWANCE'
  | 'OTHER';

/**
 * Числовая metadata venue-отклонения по балансу (микроединицы, 1e6).
 *
 * @remarks
 * Заполняется адаптером ТОЛЬКО из авторитетного структурированного ответа
 * venue (не из свободного текста в application layer). Значения — Decimal
 * в микроединицах USDC/token (6 dp), как их возвращает Polymarket CLOB.
 */
export interface SubmitRejectionBalanceMetadata {
  /** Фактический on-chain баланс (микроединицы). */
  readonly onChainBalanceMicro: Decimal;
  /** Требуемый объём ордера (микроединицы). */
  readonly orderAmountMicro: Decimal;
}

/**
 * Структурированный результат размещения ордера на venue.
 *
 * @remarks
 * `OPEN`/`PARTIALLY_FILLED`/`FILLED` — успешные исходы (ордер принят, возможно уже
 * частично/полностью исполнен при размещении). `REJECTED` — venue отклонил ордер
 * (см. {@link SubmitRejectionCode}). `UNKNOWN` — сабмит ушёл, но подтверждение не
 * получено (например, timeout/сетевая ошибка) — ambiguous-исход, требует reconciliation
 * (см. `SubmitAmbiguity`).
 */
export type SubmitOrderResult =
  | {
      readonly status: 'OPEN';
      readonly orderId: OrderId;
      readonly effectiveSize: Quantity;
      readonly remainingSize: Quantity;
    }
  | {
      readonly status: 'PARTIALLY_FILLED';
      readonly orderId: OrderId;
      readonly effectiveSize: Quantity;
      readonly filledSize: Quantity;
      readonly remainingSize: Quantity;
    }
  | {
      readonly status: 'FILLED';
      readonly orderId: OrderId;
      readonly effectiveSize: Quantity;
      readonly filledSize: Quantity;
    }
  | {
      readonly status: 'REJECTED';
      readonly reason: string;
      /**
       * Типизированная причина отклонения (см. {@link SubmitRejectionCode}).
       * `undefined` — адаптер не смог классифицировать (эквивалент `OTHER`).
       */
      readonly rejectionCode?: SubmitRejectionCode;
      /**
       * Числовая metadata для `INSUFFICIENT_TOKEN_BALANCE`
       * (см. {@link SubmitRejectionBalanceMetadata}).
       */
      readonly balance?: SubmitRejectionBalanceMetadata;
    }
  | {
      readonly status: 'UNKNOWN';
      readonly reason: string;
      readonly orderId?: OrderId;
      readonly effectiveSize?: Quantity;
    };

/**
 * Структурированный результат venue-отмены ордера.
 *
 * @remarks
 * Возвращается внутри `Ok(...)` — это НЕ ошибка транспортного уровня, а бизнес-исход,
 * который venue вернул в ответ на запрос отмены. `Err(ExchangeError)` зарезервирован
 * только для транспортных/API/аутентификационных ошибок, где нормального venue outcome
 * нет вообще (например, сеть недоступна).
 *
 * Application layer (`CancelOrderUseCase`, `PlaceOrderUseCase`) переключается по `status`
 * и НЕ парсит текст `reason` — классификация venue-специфичных причин (например, строк
 * "matched", "already canceled") выполняется исключительно в infrastructure adapter.
 *
 * - `CANCELLED` — venue подтвердил отмену.
 * - `ALREADY_FILLED` — venue сообщил, что ордер уже matched/filled, отмена невозможна.
 * - `ALREADY_CANCELLED` — ордер уже был отменён на venue (идемпотентный исход).
 * - `NOT_FOUND` — venue не нашёл ордер (best-effort успех/кандидат на reconciliation).
 * - `UNKNOWN_RETRY_NEEDED` — venue ответил, но результат неоднозначен; нужен
 *   retry/reconciliation.
 */
export type CancelOrderResult =
  | { readonly status: 'CANCELLED' }
  | { readonly status: 'ALREADY_FILLED'; readonly reason?: string }
  | { readonly status: 'ALREADY_CANCELLED'; readonly reason?: string }
  | { readonly status: 'NOT_FOUND'; readonly reason?: string }
  | { readonly status: 'UNKNOWN_RETRY_NEEDED'; readonly reason: string };

/**
 * Порт: клиент торговой площадки.
 *
 * @example
 * ```typescript
 * const result = await exchangeClient.submitOrder({
 *   asset: tokenId,
 *   side: Side.BUY,
 *   price: Price.of(new Decimal('0.65')),
 *   size: Quantity.of(new Decimal('100')),
 * });
 * if (!result.ok) {
 *   logger.error('Failed to submit order', { error: result.error.message });
 *   return;
 * }
 * switch (result.value.status) {
 *   case 'OPEN':
 *     // Order.create() должен использовать effectiveSize, а не исходный params.size
 *     break;
 *   // ...
 * }
 * ```
 */
export interface IExchangeClient {
  /**
   * Размещает лимитный ордер на бирже.
   *
   * @param params - Параметры ордера
   * @returns Ok(SubmitOrderResult) с типизированным business-исходом; Err(ExchangeError)
   * только при транспортной/API ошибке
   *
   * @remarks
   * Business-исходы (OPEN/PARTIALLY_FILLED/FILLED/REJECTED/UNKNOWN) возвращаются через
   * `Ok(SubmitOrderResult)`. Адаптер не синтезирует fills — при частичном/полном
   * исполнении реальные `Fill` приходят отдельно через WS/reconciliation.
   */
  submitOrder(params: SubmitOrderParams): Promise<Result<SubmitOrderResult, ExchangeError>>;

  /**
   * Отменяет ордер на бирже.
   *
   * @param orderId - ID ордера для отмены
   * @returns Ok(CancelOrderResult) с бизнес-исходом отмены; Err(ExchangeError) только
   * при транспортной/API-ошибке, когда нормального venue outcome нет
   *
   * @remarks
   * Business-исходы (уже matched, уже cancelled, not found, неоднозначный ответ)
   * возвращаются через `Ok(CancelOrderResult)`, а НЕ через `Err`. Вызывающий код
   * не должен парсить текст venue-ошибок — эта классификация выполняется внутри
   * реализации адаптера (например, `PolymarketExchangeClientAdapter`).
   */
  cancelOrder(orderId: OrderId): Promise<Result<CancelOrderResult, ExchangeError>>;

  /**
   * Возвращает открытые ордера аккаунта от биржи.
   *
   * @param accountId - ID аккаунта
   * @returns Ok(OpenOrderSnapshot[]) при успехе, ExchangeError при ошибке
   *
   * @remarks
   * Используется `ReconcileOrdersUseCase` для сверки локальных открытых ордеров
   * с биржевыми. Возвращает только ордера в статусе OPEN/PARTIALLY_FILLED.
   */
  getOpenOrders(accountId: AccountId): Promise<Result<OpenOrderSnapshot[], ExchangeError>>;

  /**
   * Возвращает исполненные сделки аккаунта от биржи.
   *
   * @param accountId - ID аккаунта
   * @param since - Начальная временная метка (опционально; если не указана — возвращает все)
   * @returns Ok(VenueTradeSnapshot[]) при успехе, ExchangeError при ошибке
   *
   * @remarks
   * Используется `ReconcileTradesUseCase` для обнаружения пропущенных исполнений.
   * Параметр `since` позволяет ограничить выборку по времени.
   */
  /**
   * ### Контракт полноты (КРИТИЧЕН для settlement/reconciliation):
   * Вызывающие (`SettleTerminalOrdersUseCase`, `ReconcileTradesUseCase`)
   * трактуют `Ok([])` как authoritative «fills отсутствуют». Реализация обязана
   * обеспечивать: (1) достаточное временное окно/пагинацию, покрывающее все
   * незакрытые ордера; (2) включение partial И final fills; (3) минимальный
   * eventual-consistency лаг. Если полнота НЕ гарантируется (например, только
   * последние N fills первой страницы) — это ограничение обязано быть явно
   * задокументировано в адаптере, а вызывающие должны компенсировать grace
   * period-ом (см. `SettleTerminalOrdersUseCase.minSettleDelayMs`).
   * При невозможности дать полный ответ возвращать `Err`, НЕ пустой `Ok`.
   */
  getTrades(accountId: AccountId, since?: Timestamp): Promise<Result<VenueTradeSnapshot[], ExchangeError>>;
}
