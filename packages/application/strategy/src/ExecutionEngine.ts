/**
 * ExecutionEngine — исполняет StrategyIntent[] от стратегии.
 *
 * @remarks
 * ### Ответственности:
 * 1. **Валидация target-пары** — targetInstrumentId/targetAsset проверяются
 *    атомарно (fail-closed) ДО нормализации и любых venue-вызовов
 * 2. **Нормализация** — dedupe intents по effective instrument + side +
 *    точному Decimal-представлению цены + postOnly
 * 3. **Порядок** — CANCEL_ALL → CANCEL → PLACE
 * 4. **Ownership** — CANCEL разрешён только для ордеров ЭТОЙ стратегии и
 *    ЭТОГО аккаунта (authoritative lookup перед CancelOrderUseCase)
 * 5. **Cancel-replace safety** — PLACE выполняется ТОЛЬКО если каждый cancel
 *    batch-а завершился безопасно (CONFIRMED/TERMINAL_NOOP); любой
 *    PENDING/FAILED/exception блокирует ВСЕ PLACE текущего batch (fail-closed)
 * 6. **Валидация constraints** — reject-only (minOrderSize, minOrderValue,
 *    tickSize); отсутствие catalog entry для PLACE — fail-closed reject
 * 7. **Отчёт** — типизированный ExecutionReport с точными исходами intents
 *
 * ### Типизированные failure-коды:
 * Классификация ошибок размещения — ТОЛЬКО через
 * `getPlaceFailureCode`/`getPlaceFailureBalance` (@polymarket/use-cases).
 * Никакого парсинга `error.message` в execution-слое: benign post-only skip
 * требует точного кода `POST_ONLY_WOULD_TAKE`, SELL dust-retry — точного
 * `INSUFFICIENT_TOKEN_BALANCE` с числовой balance-metadata.
 *
 * ### Делегация:
 * - Risk check — внутри PlaceOrderUseCase (не дублируем)
 * - Balance reservation — внутри PlaceOrderUseCase
 * - Order state changes — внутри Use Cases
 *
 * @example
 * ```typescript
 * const engine = new ExecutionEngine(deps);
 *
 * const report = await engine.execute(ctx, [
 *   { type: 'CANCEL_ALL' },
 *   { type: 'PLACE', side: 'BUY', price, size },
 * ]);
 *
 * console.log(report.placed, report.cancelled, report.blockedByUnsafeCancel);
 * ```
 */
import Decimal from 'decimal.js';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { AccountId, AssetId, InstrumentId } from '@polymarket/ids';
import { accountIdToString, assetIdToInstrumentId } from '@polymarket/ids';
import { Quantity } from '@polymarket/value-objects';
import type { Side } from '@polymarket/value-objects';
import type { PlaceOrderUseCase, CancelOrderUseCase, PlaceFailureCode } from '@polymarket/use-cases';
import { getPlaceFailureCode, getPlaceFailureBalance } from '@polymarket/use-cases';
import type { IOrderRepository, IPortfolioStore, IMarketCatalog } from '@polymarket/ports';
import type { Order } from '@polymarket/order';
import type {
  StrategyIntent,
  PlaceIntent,
  CancelIntent,
} from './types/StrategyIntent.js';
import type { IOrderIdGenerator } from './ports/OrderIdGenerator.js';

// ── Публичные типы ─────────────────────────────────────────

/**
 * Провайдер баланса токена на бирже (CLOB).
 *
 * @remarks
 * Опциональная диагностика: при SELL rejection запрашивает реальный баланс
 * токена на CLOB, чтобы определить причину отклонения (settlement lag, allowance и т.д.).
 */
export interface ITokenBalanceChecker {
  /**
   * Возвращает баланс и allowance токена на CLOB.
   *
   * @param tokenId - ID токена (raw, например "888...")
   * @returns Объект с balance и allowance, или undefined при ошибке запроса
   */
  getTokenBalanceAllowance(tokenId: string): Promise<{ balance: number; allowance: number } | undefined>;
}

/**
 * Зависимости ExecutionEngine.
 */
export interface ExecutionEngineDeps {
  readonly placeOrderUseCase: PlaceOrderUseCase;
  readonly cancelOrderUseCase: CancelOrderUseCase;
  readonly orderRepo: IOrderRepository;
  readonly portfolioStore: IPortfolioStore;
  /** Каталог инструментов — для валидации constraints (reject-only, без коррекции) */
  readonly catalog: IMarketCatalog;
  /** Источник времени (IClock) — для cooldown-таймеров. В backtest используется ReplayClock. */
  readonly clock: IClock;
  /** Генератор клиентских Order ID (детерминированный в replay/backtest). */
  readonly orderIdGenerator: IOrderIdGenerator;
  readonly logger: ILogger;
  /** Опциональный: проверка баланса токена на CLOB при SELL rejection */
  readonly tokenBalanceChecker?: ITokenBalanceChecker;
}

/**
 * Контекст исполнения — привязка intents к конкретной стратегии и инструменту.
 */
export interface ExecutionContext {
  readonly strategyId: string;
  readonly accountId: AccountId;
  readonly instrumentId: InstrumentId;
  readonly asset: AssetId;
  /**
   * Инструменты, разрешённые регистрацией стратегии (string-ключи InstrumentId).
   *
   * @remarks
   * Primary + complementary + additional instruments. `PlaceIntent.targetInstrumentId`
   * вне этого набора — typed failure (fail-closed), venue не вызывается.
   */
  readonly allowedInstruments: ReadonlySet<string>;
}

/**
 * Провалидированная атомарная пара target instrument + asset.
 */
export interface EffectiveOrderTarget {
  readonly instrumentId: InstrumentId;
  readonly asset: AssetId;
}

/**
 * Типизированный результат исполнения CANCEL intent.
 *
 * @remarks
 * - `CONFIRMED` — venue подтвердил отмену (`CANCELLED`/`ALREADY_CANCELLED`):
 *   капитал освобождён, cancel успешен (только эти исходы инкрементируют
 *   `cancelled` и ставят post-cancel cooldown).
 * - `TERMINAL_NOOP` — ордер уже terminal НЕ отменой (`ALREADY_TERMINAL`:
 *   REJECTED/EXPIRED): отменять нечего; PLACE НЕ блокируется.
 * - `PENDING` — отмена НЕ подтверждена (`FILL_PENDING`/`ALREADY_FILLED`/
 *   `RECONCILIATION_REQUIRED`): блокирует ВСЕ PLACE текущего batch.
 * - `FAILED` — use case вернул Err, бросил, либо ownership-проверка
 *   отклонила cancel: блокирует ВСЕ PLACE текущего batch (fail-closed).
 */
export type CancelExecutionResult = 'CONFIRMED' | 'TERMINAL_NOOP' | 'PENDING' | 'FAILED';

/** Типизированный исход одного intent в отчёте. */
export type IntentOutcomeKind =
  | 'PLACED'
  | 'SKIPPED'
  | 'LOCAL_REJECTED'
  | 'BLOCKED_BY_UNSAFE_CANCEL'
  | 'FAILED'
  | 'CANCEL_CONFIRMED'
  | 'CANCEL_TERMINAL_NOOP'
  | 'CANCEL_PENDING'
  | 'CANCEL_FAILED';

/**
 * Типизированный исход одного intent.
 */
export interface IntentOutcome {
  readonly intent: StrategyIntent;
  readonly kind: IntentOutcomeKind;
  /** Точный typed failure-код (для FAILED place). */
  readonly failureCode?: PlaceFailureCode;
  /** Исходная ошибка (НЕ заменяется на synthetic `new Error(...)`). */
  readonly error?: Error;
  /** Человекочитаемая причина skip/reject/block (English). */
  readonly reason?: string;
}

/**
 * Отчёт об исполнении intents.
 *
 * @remarks
 * `skipped` — суммарный счётчик намеренно НЕ исполненных PLACE
 * (cooldown, benign post-only, local constraint reject, блокировка после
 * небезопасного cancel). Детализация — в `localRejected`,
 * `blockedByUnsafeCancel` и типизированных `outcomes`.
 */
export interface ExecutionReport {
  /** Количество успешно размещённых ордеров */
  readonly placed: number;
  /** Количество подтверждённо отменённых ордеров */
  readonly cancelled: number;
  /** Суммарно пропущенные размещения (см. remarks) */
  readonly skipped: number;
  /** Из них: отклонено локальной валидацией constraints/target (venue не вызывался) */
  readonly localRejected: number;
  /** Из них: заблокировано небезопасным cancel в этом же batch */
  readonly blockedByUnsafeCancel: number;
  /** Количество intents, завершившихся ошибкой */
  readonly failed: number;
  /** Ошибки при исполнении отдельных intents (исходные ошибки, не synthetic) */
  readonly errors: ReadonlyArray<{ intent: StrategyIntent; error: Error }>;
  /** Полные типизированные исходы всех intents */
  readonly outcomes: ReadonlyArray<IntentOutcome>;
}

// ── Внутренние типы ────────────────────────────────────────

/** Результат ownership/authoritative lookup + исполнения одного cancel. */
interface CancelAttempt {
  readonly intent: CancelIntent;
  readonly result: CancelExecutionResult;
  /** Исходная ошибка (для FAILED). */
  readonly error?: Error;
  /** Описание исхода (для отчёта/логов). */
  readonly reason?: string;
}

/** Внутренний исход попытки размещения. */
type PlaceAttempt =
  | { readonly kind: 'placed' }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'local_rejected'; readonly reason: string; readonly error: Error }
  | { readonly kind: 'failed'; readonly error: Error; readonly failureCode: PlaceFailureCode };

/** PLACE intent с провалидированным effective target. */
interface ResolvedPlace {
  readonly intent: PlaceIntent;
  readonly target: EffectiveOrderTarget;
}

/**
 * Ошибка локального отклонения intent (venue/use case не вызывались).
 */
export class LocalIntentRejectionError extends Error {
  /**
   * @param code - Типизированный код локального отклонения
   * @param message - Человекочитаемое описание (English)
   */
  constructor(
    public readonly code:
      | 'TARGET_PAIR_INCOMPLETE'
      | 'TARGET_UNKNOWN_INSTRUMENT'
      | 'TARGET_ASSET_MISMATCH'
      | 'TARGET_NOT_ALLOWED'
      | 'CATALOG_ENTRY_MISSING'
      | 'TICK_SIZE_VIOLATION'
      | 'NON_POSITIVE_ORDER'
      | 'MIN_ORDER_SIZE_VIOLATION'
      | 'MIN_ORDER_VALUE_VIOLATION'
      | 'CANCEL_OWNERSHIP_MISMATCH'
      | 'CANCEL_ORDER_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'LocalIntentRejectionError';
  }
}

// ── Реализация ─────────────────────────────────────────────

export class ExecutionEngine {
  private readonly _logger: ILogger;
  private _benignPostOnlyRejects = 0;
  private _sellDustRetryCount = 0;

  /**
   * Максимально допустимый дефицит для автоматического retry при SELL-rejection.
   *
   * @remarks
   * 1% — эвристика: типичный dust от settlement (0.01-0.1%) легко укладывается,
   * реальная нехватка токенов (ошибка позиции, отсутствие allowance) — нет.
   * Выше 1% — это скорее всего настоящий рассинхрон, retry только маскировал бы баг.
   */
  private static readonly _SELL_DUST_RETRY_MAX_DEFICIT = 0.01;

  /**
   * Cooldown per `${instrumentId}:${side}` после отклонения ордера биржей.
   * Ключ: `${instrumentId}:${side}`. Значение: timestamp последнего rejection (clock.now()).
   *
   * @remarks
   * Защищает от бесконечного retry-цикла когда биржа стабильно отклоняет ордер
   * (например, SELL с недостаточным allowance). Без этого cooldown каждое новое
   * рыночное событие триггерит стратегию → rejection → откат резервации →
   * следующий тик → снова rejection → 10+ RPS.
   */
  private readonly _exchangeRejectionCooldowns = new Map<string, number>();

  /** 5 секунд cooldown после отклонения биржей */
  private static readonly _EXCHANGE_REJECTION_COOLDOWN_MS = 5_000;

  /**
   * Cooldown per instrumentId после ПОДТВЕРЖДЁННОЙ отмены BUY-ордера.
   * Ключ: instrumentId ФАКТИЧЕСКИ отменённого Order. Значение: timestamp (clock.now()).
   *
   * @remarks
   * Защищает от cancel-and-replace race condition на Polymarket:
   * cancel на CLOB НЕ отменяет on-chain fill (MINT уже в пути).
   * Cooldown ставится ТОЛЬКО по данным отменённого Order
   * (`order.instrumentId`, `order.side === 'BUY'`) — НЕ по ctx.instrumentId:
   * отмена комплементарного ордера не должна блокировать primary инструмент,
   * отмена SELL не должна блокировать BUY.
   */
  private readonly _postCancelCooldowns = new Map<string, number>();

  /**
   * 3 секунды cooldown после cancel — ожидание MATCHED/MINED события.
   *
   * @remarks
   * Не ждём полный on-chain settlement (15-20с).
   * Если MATCHED/MINED приходит за 3с — matchedOnExchange блокирует стратегию
   * до CONFIRMED (отдельный механизм в StrategyScheduler).
   * Если за 3с ничего не пришло — ордер реально отменён, можно торговать.
   */
  private static readonly _POST_CANCEL_COOLDOWN_MS = 3_000;

  constructor(private readonly _deps: ExecutionEngineDeps) {
    this._logger = _deps.logger.child({ component: 'ExecutionEngine' });
  }

  /**
   * Сбрасывает post-cancel cooldown для инструмента.
   *
   * @param instrumentId - ID инструмента
   *
   * @remarks
   * Вызывается ТОЛЬКО при FILL_CONFIRMED (finality) — см.
   * `StrategyScheduler.onFillConfirmedForInstrument`. FILL_RECEIVED cooldown
   * НЕ снимает: до finality размещение поверх in-flight fill опасно.
   */
  public clearPostCancelCooldown(instrumentId: InstrumentId): void {
    const key = String(instrumentId);
    if (this._postCancelCooldowns.delete(key)) {
      this._logger.debug('ExecutionEngine: post-cancel cooldown cleared (fill confirmed)', {
        instrumentId: key,
      });
    }
  }

  /**
   * Сбрасывает exchange rejection cooldown для инструмента (обе стороны).
   *
   * @param instrumentId - ID инструмента
   *
   * @remarks
   * Вызывается при получении FILL_CONFIRMED — on-chain settlement завершён,
   * токены доступны для SELL. Без этого стратегия ждёт полные 5 секунд cooldown
   * даже после finality, теряя время на retry.
   */
  public clearExchangeRejectionCooldown(instrumentId: InstrumentId): void {
    const key = String(instrumentId);
    const buyKey = `${key}:BUY`;
    const sellKey = `${key}:SELL`;
    let cleared = false;

    if (this._exchangeRejectionCooldowns.delete(buyKey)) cleared = true;
    if (this._exchangeRejectionCooldowns.delete(sellKey)) cleared = true;

    if (cleared) {
      this._logger.debug('ExecutionEngine: exchange rejection cooldown cleared (fill confirmed)', {
        instrumentId: key,
      });
    }
  }

  public get stats(): { benignPostOnlyRejects: number; sellDustRetryCount: number } {
    return {
      benignPostOnlyRejects: this._benignPostOnlyRejects,
      sellDustRetryCount: this._sellDustRetryCount,
    };
  }

  /**
   * Нормализует и исполняет intents.
   *
   * @param ctx - Контекст: strategyId, accountId, instrumentId, asset, allowedInstruments
   * @param intents - Сырые intents от стратегии
   * @returns ExecutionReport с типизированными исходами
   *
   * @remarks
   * Порядок: validate targets → normalize → CANCEL_ALL → CANCEL → PLACE.
   * Cancels параллельно (Promise.allSettled), places последовательно (баланс).
   * ЛЮБОЙ небезопасный cancel (PENDING/FAILED/rejected Promise/exception)
   * блокирует ВСЕ PLACE текущего batch — и BUY, и SELL (fail-closed).
   */
  public async execute(
    ctx: ExecutionContext,
    intents: readonly StrategyIntent[],
  ): Promise<ExecutionReport> {
    let placed = 0;
    let cancelled = 0;
    let skipped = 0;
    let localRejected = 0;
    let blockedByUnsafeCancel = 0;
    let failed = 0;
    const errors: Array<{ intent: StrategyIntent; error: Error }> = [];
    const outcomes: IntentOutcome[] = [];

    // ── 0. Валидация target-пары КАЖДОГО PLACE (fail-closed, до dedupe) ──
    const resolvedPlaces: ResolvedPlace[] = [];
    let hasCancelAll = false;
    const cancelMap = new Map<string, CancelIntent>();

    for (const intent of intents) {
      switch (intent.type) {
        case 'CANCEL_ALL':
          hasCancelAll = true;
          break;
        case 'CANCEL':
          cancelMap.set(String(intent.orderId), intent);
          break;
        case 'PLACE': {
          const targetResult = this._resolveEffectiveTarget(ctx, intent);
          if (!targetResult.ok) {
            localRejected++;
            skipped++;
            errors.push({ intent, error: targetResult.error });
            outcomes.push({
              intent,
              kind: 'LOCAL_REJECTED',
              error: targetResult.error,
              reason: targetResult.error.message,
            });
            this._logger.warn('ExecutionEngine: PLACE rejected — invalid target pair', {
              strategyId: ctx.strategyId,
              side: intent.side,
              code: targetResult.error.code,
              error: targetResult.error.message,
            });
            break;
          }
          resolvedPlaces.push({ intent, target: targetResult.value });
          break;
        }
      }
    }

    // ── 1. Нормализация PLACE: dedupe по effective instrument + side +
    //       точному Decimal-представлению цены + postOnly (последний побеждает).
    const placeMap = new Map<string, ResolvedPlace>();
    for (const place of resolvedPlaces) {
      const key = [
        String(place.target.instrumentId),
        place.intent.side,
        place.intent.price.value().toString(),
        place.intent.postOnly === true ? 'po' : 'no',
      ].join('|');
      placeMap.set(key, place);
    }
    const places = [...placeMap.values()];

    // ── 2. CANCEL_ALL → разворачиваем в ордера ТЕКУЩЕЙ стратегии ─
    // getByStrategyId уже scoped по strategyId; дополнительная ownership-проверка
    // per-order выполняется в _executeCancel (authoritative lookup).
    const cancels: CancelIntent[] = hasCancelAll ? [] : [...cancelMap.values()];
    if (hasCancelAll) {
      const orders = await this._deps.orderRepo.getByStrategyId(ctx.strategyId);
      for (const order of orders) {
        cancels.push({ type: 'CANCEL', orderId: order.id });
      }
    }

    if (cancels.length === 0 && places.length === 0) {
      return { placed, cancelled, skipped, localRejected, blockedByUnsafeCancel, failed, errors, outcomes };
    }

    // ── 3. Cancels параллельно ──────────────────────────────
    // Fail-closed cancel-replace: PLACE разрешён ТОЛЬКО если КАЖДЫЙ cancel
    // завершился безопасно (CONFIRMED/TERMINAL_NOOP). PENDING, FAILED,
    // rejected Promise, exception, unknown result — блокируют все PLACE.
    let allCancelsSafeForReplace = true;
    const unsafeCancelReasons: string[] = [];

    if (cancels.length > 0) {
      const cancelResults = await Promise.allSettled(
        cancels.map((intent) => this._executeCancel(ctx, intent)),
      );

      for (let i = 0; i < cancelResults.length; i++) {
        const settled = cancelResults[i];
        const intent = cancels[i];

        if (settled.status === 'rejected') {
          const error = settled.reason instanceof Error
            ? settled.reason
            : new Error(String(settled.reason));
          allCancelsSafeForReplace = false;
          unsafeCancelReasons.push(`${String(intent.orderId)}: threw ${error.message}`);
          failed++;
          errors.push({ intent, error });
          outcomes.push({ intent, kind: 'CANCEL_FAILED', error, reason: 'cancel threw' });
          continue;
        }

        const attempt = settled.value;
        switch (attempt.result) {
          case 'CONFIRMED':
            cancelled++;
            outcomes.push({ intent, kind: 'CANCEL_CONFIRMED' });
            break;
          case 'TERMINAL_NOOP':
            outcomes.push({ intent, kind: 'CANCEL_TERMINAL_NOOP', reason: attempt.reason });
            break;
          case 'PENDING':
            allCancelsSafeForReplace = false;
            unsafeCancelReasons.push(`${String(intent.orderId)}: PENDING (${attempt.reason ?? 'unconfirmed'})`);
            outcomes.push({ intent, kind: 'CANCEL_PENDING', reason: attempt.reason });
            break;
          case 'FAILED': {
            const error = attempt.error ?? new Error(attempt.reason ?? 'Cancel failed');
            allCancelsSafeForReplace = false;
            unsafeCancelReasons.push(`${String(intent.orderId)}: FAILED (${error.message})`);
            failed++;
            errors.push({ intent, error });
            outcomes.push({ intent, kind: 'CANCEL_FAILED', error, reason: attempt.reason });
            break;
          }
          default: {
            // Неизвестный результат — fail-closed.
            const _exhaustive: never = attempt.result;
            allCancelsSafeForReplace = false;
            unsafeCancelReasons.push(`${String(intent.orderId)}: unknown result ${String(_exhaustive)}`);
            break;
          }
        }
      }
    }

    // ── 4. Places последовательно ───────────────────────────
    for (const place of places) {
      const intent = place.intent;

      if (!allCancelsSafeForReplace) {
        // Любой небезопасный cancel этого batch: размещение (BUY И SELL)
        // блокируется до подтверждения/реконсиляции — SELL не обходит блок.
        this._logger.warn('ExecutionEngine: PLACE blocked — unsafe cancel outcome in same execution batch', {
          strategyId: ctx.strategyId,
          instrumentId: String(place.target.instrumentId),
          side: intent.side,
          unsafeCancelOutcomes: unsafeCancelReasons,
        });
        skipped++;
        blockedByUnsafeCancel++;
        outcomes.push({
          intent,
          kind: 'BLOCKED_BY_UNSAFE_CANCEL',
          reason: `Unsafe cancel outcomes in batch: ${unsafeCancelReasons.join('; ')}`,
        });
        continue;
      }

      const attempt = await this._executePlace(ctx, intent, place.target);
      switch (attempt.kind) {
        case 'placed':
          placed++;
          outcomes.push({ intent, kind: 'PLACED' });
          break;
        case 'skipped':
          skipped++;
          outcomes.push({ intent, kind: 'SKIPPED', reason: attempt.reason });
          break;
        case 'local_rejected':
          skipped++;
          localRejected++;
          errors.push({ intent, error: attempt.error });
          outcomes.push({ intent, kind: 'LOCAL_REJECTED', error: attempt.error, reason: attempt.reason });
          break;
        case 'failed':
          failed++;
          errors.push({ intent, error: attempt.error });
          outcomes.push({ intent, kind: 'FAILED', error: attempt.error, failureCode: attempt.failureCode });
          break;
      }
    }

    return { placed, cancelled, skipped, localRejected, blockedByUnsafeCancel, failed, errors, outcomes };
  }

  // ── Target validation ────────────────────────────────────

  /**
   * Валидирует атомарную пару target instrument/asset и строит EffectiveOrderTarget.
   *
   * @param ctx - Контекст исполнения
   * @param intent - PLACE intent
   * @returns Ok(EffectiveOrderTarget) либо Err(LocalIntentRejectionError)
   *
   * @remarks
   * Fail-closed правила (venue/use case НЕ вызываются при нарушении):
   * 1. Заданы ОБА поля пары или НИ ОДНОГО (runtime-защита в дополнение к
   *    compile-time union — intents могут прийти из JS/`as`-кода).
   * 2. Target instrument существует в каталоге.
   * 3. `targetAsset` маппится ровно на target instrument
   *    (`assetIdToInstrumentId(asset) === instrumentId`).
   * 4. Target instrument разрешён текущей регистрацией стратегии.
   * Никаких независимых fallback `targetX ?? ctx.X` — сначала валидация
   * пары, затем единый EffectiveOrderTarget.
   */
  private _resolveEffectiveTarget(
    ctx: ExecutionContext,
    intent: PlaceIntent,
  ): { ok: true; value: EffectiveOrderTarget } | { ok: false; error: LocalIntentRejectionError } {
    const targetInstrumentId = intent.targetInstrumentId;
    const targetAsset = intent.targetAsset;

    if (targetInstrumentId === undefined && targetAsset === undefined) {
      return { ok: true, value: { instrumentId: ctx.instrumentId, asset: ctx.asset } };
    }

    if (targetInstrumentId === undefined || targetAsset === undefined) {
      return {
        ok: false,
        error: new LocalIntentRejectionError(
          'TARGET_PAIR_INCOMPLETE',
          `PLACE intent has incomplete target pair: targetInstrumentId=${String(targetInstrumentId)}, targetAsset=${targetAsset === undefined ? 'undefined' : 'set'} (both or neither required)`,
        ),
      };
    }

    if (!ctx.allowedInstruments.has(String(targetInstrumentId))) {
      return {
        ok: false,
        error: new LocalIntentRejectionError(
          'TARGET_NOT_ALLOWED',
          `PLACE target instrument ${String(targetInstrumentId)} is not allowed by strategy registration`,
        ),
      };
    }

    const info = this._deps.catalog.get(targetInstrumentId);
    if (!info) {
      return {
        ok: false,
        error: new LocalIntentRejectionError(
          'TARGET_UNKNOWN_INSTRUMENT',
          `PLACE target instrument ${String(targetInstrumentId)} is missing from catalog (fail-closed)`,
        ),
      };
    }

    const assetInstrument = assetIdToInstrumentId(targetAsset);
    if (assetInstrument === undefined || String(assetInstrument) !== String(targetInstrumentId)) {
      return {
        ok: false,
        error: new LocalIntentRejectionError(
          'TARGET_ASSET_MISMATCH',
          `PLACE targetAsset does not map to target instrument ${String(targetInstrumentId)}`,
        ),
      };
    }

    return { ok: true, value: { instrumentId: targetInstrumentId, asset: targetAsset } };
  }

  // ── Исполнение отдельных intents ─────────────────────────

  /**
   * Сравнение AccountId с защитой от legacy string-представлений.
   *
   * @param a - Первый AccountId
   * @param b - Второй AccountId
   * @returns true если идентификаторы указывают на один аккаунт
   */
  private static _sameAccount(a: AccountId, b: AccountId): boolean {
    const keyOf = (id: AccountId): string => {
      // Legacy/test-представление: AccountId может прийти строкой (см.
      // safeAssetId-паттерн в PlaceOrderUseCase) — сериализатор для неё
      // вернул бы одинаковый '[INVALID:...]' placeholder для РАЗНЫХ строк.
      if (typeof (id as unknown) === 'string') return String(id);
      try {
        return accountIdToString(id);
      } catch {
        return String(id);
      }
    };
    return keyOf(a) === keyOf(b);
  }

  /**
   * Исполняет CANCEL intent: ownership-проверка → CancelOrderUseCase → typed результат.
   *
   * @param ctx - Контекст исполнения
   * @param intent - CANCEL intent
   * @returns Типизированный {@link CancelAttempt}
   *
   * @remarks
   * ### Ownership (fail-closed, ДО use case):
   * Authoritative lookup ордера в репозитории. `CancelOrderUseCase` НЕ
   * вызывается, если:
   * - ордер не найден (владелец неизвестен);
   * - `order.strategyId !== ctx.strategyId` (чужая стратегия);
   * - `order.accountId` задан и не совпадает с `ctx.accountId` (чужой аккаунт).
   * Любой из этих случаев → `FAILED` → PLACE текущего batch блокируется.
   *
   * ### Post-cancel cooldown:
   * Ставится ТОЛЬКО при `CANCELLED`/`ALREADY_CANCELLED` И ТОЛЬКО для
   * risk-increasing BUY-ордера — на ФАКТИЧЕСКИЙ инструмент отменённого Order
   * (`assetIdToInstrumentId(order.asset)`), а не на ctx.instrumentId.
   */
  private async _executeCancel(ctx: ExecutionContext, intent: CancelIntent): Promise<CancelAttempt> {
    // ── Ownership: authoritative lookup ─────────────────────
    let order: Order | undefined;
    try {
      order = await this._deps.orderRepo.get(intent.orderId);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this._logger.warn('ExecutionEngine: cancel ownership lookup threw', {
        orderId: String(intent.orderId),
        strategyId: ctx.strategyId,
        error: error.message,
      });
      return { intent, result: 'FAILED', error, reason: 'ownership lookup threw' };
    }

    if (!order) {
      const error = new LocalIntentRejectionError(
        'CANCEL_ORDER_NOT_FOUND',
        `Cancel rejected — order ${String(intent.orderId)} not found (owner unknown)`,
      );
      this._logger.warn('ExecutionEngine: cancel rejected — order not found (owner unknown)', {
        orderId: String(intent.orderId),
        strategyId: ctx.strategyId,
      });
      return { intent, result: 'FAILED', error, reason: 'order not found' };
    }

    if (order.strategyId !== ctx.strategyId) {
      const error = new LocalIntentRejectionError(
        'CANCEL_OWNERSHIP_MISMATCH',
        `Cancel rejected — order ${String(intent.orderId)} belongs to strategy "${order.strategyId ?? 'unknown'}", not "${ctx.strategyId}"`,
      );
      this._logger.error('ExecutionEngine: cancel rejected — strategy ownership mismatch', {
        orderId: String(intent.orderId),
        strategyId: ctx.strategyId,
        orderStrategyId: order.strategyId,
      });
      return { intent, result: 'FAILED', error, reason: 'strategy ownership mismatch' };
    }

    if (order.accountId !== undefined && !ExecutionEngine._sameAccount(order.accountId, ctx.accountId)) {
      const error = new LocalIntentRejectionError(
        'CANCEL_OWNERSHIP_MISMATCH',
        `Cancel rejected — order ${String(intent.orderId)} belongs to a different account`,
      );
      this._logger.error('ExecutionEngine: cancel rejected — account ownership mismatch', {
        orderId: String(intent.orderId),
        strategyId: ctx.strategyId,
      });
      return { intent, result: 'FAILED', error, reason: 'account ownership mismatch' };
    }

    // Данные фактически отменяемого Order — для cooldown ПОСЛЕ use case.
    const cancelledInstrumentId = assetIdToInstrumentId(order.asset);
    const cancelledSide: Side = order.side;

    let result: Awaited<ReturnType<CancelOrderUseCase['execute']>>;
    try {
      result = await this._deps.cancelOrderUseCase.execute({
        orderId: intent.orderId,
        accountId: ctx.accountId,
        reason: `Strategy ${ctx.strategyId} requested cancel`,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this._logger.error('ExecutionEngine: cancel use case threw', {
        orderId: String(intent.orderId),
        strategyId: ctx.strategyId,
        error: error.message,
      });
      return { intent, result: 'FAILED', error, reason: 'cancel use case threw' };
    }

    if (!result.ok) {
      this._logger.warn('ExecutionEngine: cancel failed', {
        orderId: String(intent.orderId),
        strategyId: ctx.strategyId,
        error: result.error.message,
      });
      return { intent, result: 'FAILED', error: result.error, reason: result.error.message };
    }

    const outcome = result.value;
    if (
      outcome.status === 'FILL_PENDING' ||
      outcome.status === 'ALREADY_FILLED' ||
      outcome.status === 'RECONCILIATION_REQUIRED'
    ) {
      // Отмена НЕ подтверждена: ордер исполнен/matched (fill получен или в
      // пути) либо venue-исход неоднозначен. cancelled НЕ инкрементируется,
      // PLACE intents текущего batch будут заблокированы (см. execute()).
      this._logger.warn('ExecutionEngine: cancel not confirmed — blocking PLACE intents this cycle', {
        orderId: String(intent.orderId),
        strategyId: ctx.strategyId,
        outcome: outcome.status,
        ...(outcome.status === 'RECONCILIATION_REQUIRED' ? { reason: outcome.reason } : {}),
      });
      return { intent, result: 'PENDING', reason: outcome.status };
    }
    if (outcome.status === 'ALREADY_TERMINAL') {
      // REJECTED/EXPIRED: ордер умер сам — не отмена (без cooldown/cancelled++),
      // но и не блокировка (fill не ожидается).
      this._logger.info('ExecutionEngine: cancel no-op — order already terminal (not cancelled)', {
        orderId: String(intent.orderId),
        strategyId: ctx.strategyId,
        orderStatus: outcome.orderStatus,
      });
      return { intent, result: 'TERMINAL_NOOP', reason: `ALREADY_TERMINAL:${outcome.orderStatus}` };
    }

    // CANCELLED / ALREADY_CANCELLED — подтверждённая отмена.
    // Post-cancel cooldown: ТОЛЬКО для отменённого risk-increasing BUY и
    // ТОЛЬКО на фактический инструмент отменённого Order. Cancel на CLOB не
    // отменяет on-chain fill — MINT может быть уже в пути; без cooldown:
    // cancel → place(новый BUY) → fill(старый) приходит → двойная покупка.
    // Отмена SELL BUY-cooldown НЕ ставит (SELL-fill не увеличивает экспозицию
    // повторной покупкой), отмена комплементарного ордера primary не блокирует.
    if (cancelledSide === 'BUY' && cancelledInstrumentId !== undefined) {
      const instrumentKey = String(cancelledInstrumentId);
      this._postCancelCooldowns.set(instrumentKey, this._deps.clock.now().getTime());
      this._logger.info('ExecutionEngine: post-cancel cooldown set (cancelled BUY order)', {
        strategyId: ctx.strategyId,
        instrumentId: instrumentKey,
        orderId: String(intent.orderId),
        cooldownMs: ExecutionEngine._POST_CANCEL_COOLDOWN_MS,
      });
    }

    return { intent, result: 'CONFIRMED' };
  }

  /**
   * Исполняет PLACE intent для провалидированного effective target.
   *
   * @param ctx - Контекст исполнения
   * @param intent - PLACE intent
   * @param target - Провалидированная пара instrument/asset
   * @returns Типизированный {@link PlaceAttempt}
   *
   * @remarks
   * ### Валидация (reject-only, без коррекции):
   * - Fail-closed: отсутствие catalog entry → local reject (без catalog
   *   невозможно проверить minOrderSize/minOrderValue/tickSize)
   * - Reject если цена не кратна tickSize (Decimal-арифметика, без float `%`)
   * - Reject BUY если `size < minOrderSize` или `price × size < minOrderValue`
   *
   * ### Классификация ошибок:
   * ТОЛЬКО typed `PlaceFailureCode` (getPlaceFailureCode). Benign post-only
   * skip — только точный код `POST_ONLY_WOULD_TAKE`. SELL dust-retry — только
   * `INSUFFICIENT_TOKEN_BALANCE` (definite reject) + числовая balance-metadata.
   */
  private async _executePlace(
    ctx: ExecutionContext,
    intent: PlaceIntent,
    target: EffectiveOrderTarget,
  ): Promise<PlaceAttempt> {
    const nowForCooldown = this._deps.clock.now().getTime();
    const effectiveInstrumentId = target.instrumentId;
    const effectiveAsset = target.asset;
    const instrumentKey = String(effectiveInstrumentId);

    // ── Post-cancel cooldown ────────────────────────────────
    // Блокируем только новые BUY после подтверждённой отмены BUY. SELL-выходы
    // нельзя задерживать: hard stop / emergency exit должен пройти.
    const lastCancelMs = this._postCancelCooldowns.get(instrumentKey);
    if (
      intent.side === 'BUY' &&
      lastCancelMs !== undefined &&
      nowForCooldown - lastCancelMs < ExecutionEngine._POST_CANCEL_COOLDOWN_MS
    ) {
      this._logger.debug('ExecutionEngine: skip — post-cancel cooldown active', {
        strategyId: ctx.strategyId,
        instrumentId: instrumentKey,
        side: intent.side,
        cooldownRemainingMs: ExecutionEngine._POST_CANCEL_COOLDOWN_MS - (nowForCooldown - lastCancelMs),
      });
      return { kind: 'skipped', reason: 'post-cancel cooldown active' };
    }

    // ── Exchange rejection cooldown ──────────────────────────
    // SELL-выходы (SL/TP) исключаем из cooldown: стратегия сама контролирует
    // темп retry. Cooldown блокировал бы критические SELL на 5s.
    const rejectionKey = `${instrumentKey}:${intent.side}`;
    if (intent.side !== 'SELL') {
      const lastRejectedMs = this._exchangeRejectionCooldowns.get(rejectionKey);
      if (lastRejectedMs !== undefined && nowForCooldown - lastRejectedMs < ExecutionEngine._EXCHANGE_REJECTION_COOLDOWN_MS) {
        this._logger.info('ExecutionEngine: skip — exchange rejection cooldown active', {
          strategyId: ctx.strategyId,
          instrumentId: instrumentKey,
          side: intent.side,
          cooldownRemainingMs: ExecutionEngine._EXCHANGE_REJECTION_COOLDOWN_MS - (nowForCooldown - lastRejectedMs),
        });
        return { kind: 'skipped', reason: 'exchange rejection cooldown active' };
      }
    }

    const effectiveSize = intent.size;
    const effectivePrice = intent.price;

    if (!effectiveSize.value().gt(0) || !effectivePrice.value().gt(0)) {
      const error = new LocalIntentRejectionError(
        'NON_POSITIVE_ORDER',
        `Non-positive order price or size: price=${effectivePrice.toNumber()}, size=${effectiveSize.toNumber()}`,
      );
      this._logger.warn('ExecutionEngine: reject — non-positive order price or size', {
        strategyId: ctx.strategyId,
        instrumentId: instrumentKey,
        side: intent.side,
        price: effectivePrice.toNumber(),
        size: effectiveSize.toNumber(),
      });
      return { kind: 'local_rejected', reason: error.message, error };
    }

    // ── Fail-closed: catalog entry обязателен для PLACE ─────
    // Без catalog невозможно проверить instrument/asset mapping, minOrderSize,
    // minOrderValue, tickSize и разрешённость target — ордер НЕ отправляется.
    const info = this._deps.catalog.get(effectiveInstrumentId);
    if (!info) {
      const error = new LocalIntentRejectionError(
        'CATALOG_ENTRY_MISSING',
        `Catalog entry missing for instrument ${instrumentKey} — PLACE fail-closed`,
      );
      this._logger.warn('ExecutionEngine: reject — catalog entry missing (fail-closed)', {
        strategyId: ctx.strategyId,
        instrumentId: instrumentKey,
        side: intent.side,
      });
      return { kind: 'local_rejected', reason: error.message, error };
    }

    // ── Tick size: reject-only, Decimal-арифметика ──────────
    // Цену НЕ округляем и НЕ меняем молча — стратегия обязана прислать
    // цену, кратную tickSize (constraints доступны ей в snapshot).
    const tickSize = info.tickSize.value();
    if (tickSize.gt(0) && !effectivePrice.value().mod(tickSize).isZero()) {
      const error = new LocalIntentRejectionError(
        'TICK_SIZE_VIOLATION',
        `Price ${effectivePrice.value().toString()} is not a multiple of tickSize ${tickSize.toString()}`,
      );
      this._logger.warn('ExecutionEngine: reject — price violates tickSize (no silent rounding)', {
        strategyId: ctx.strategyId,
        instrumentId: instrumentKey,
        side: intent.side,
        price: effectivePrice.value().toString(),
        tickSize: tickSize.toString(),
      });
      return { kind: 'local_rejected', reason: error.message, error };
    }

    // 1. Reject BUY если size < minOrderSize.
    // SELL не блокируем по minOrderSize — Polymarket позволяет продать остаток
    // целиком даже если он меньше minOrderSize (после fee deduction и т.п.).
    if (intent.side === 'BUY' && effectiveSize.value().lt(info.minOrderSize.value())) {
      const error = new LocalIntentRejectionError(
        'MIN_ORDER_SIZE_VIOLATION',
        `BUY size ${effectiveSize.toNumber()} below minOrderSize ${info.minOrderSize.toNumber()}`,
      );
      this._logger.warn('ExecutionEngine: reject — size below minOrderSize (strategy must use constraints)', {
        strategyId: ctx.strategyId,
        instrumentId: instrumentKey,
        side: intent.side,
        size: effectiveSize.toNumber(),
        minOrderSize: info.minOrderSize.toNumber(),
      });
      return { kind: 'local_rejected', reason: error.message, error };
    }

    // 2. Reject BUY если orderValue < minOrderValue (Money, денежный notional)
    if (intent.side === 'BUY' && info.minOrderValue.value().gt(0)) {
      const orderValue = intent.price.value().mul(effectiveSize.value());
      if (orderValue.lt(info.minOrderValue.value())) {
        const error = new LocalIntentRejectionError(
          'MIN_ORDER_VALUE_VIOLATION',
          `BUY order value ${orderValue.toNumber()} below minOrderValue ${info.minOrderValue.toNumber()}`,
        );
        this._logger.warn('ExecutionEngine: reject — order value below minOrderValue (strategy must use constraints)', {
          strategyId: ctx.strategyId,
          instrumentId: instrumentKey,
          price: intent.price.toNumber(),
          size: effectiveSize.toNumber(),
          orderValue: orderValue.toNumber(),
          minOrderValue: info.minOrderValue.toNumber(),
        });
        return { kind: 'local_rejected', reason: error.message, error };
      }
    }

    const orderId = this._deps.orderIdGenerator.next();
    const portfolio = this._deps.portfolioStore.get(ctx.accountId);

    if (portfolio === undefined) {
      this._logger.warn('ExecutionEngine: portfolio not found, skipping place', {
        strategyId: ctx.strategyId,
        accountId: String(ctx.accountId),
      });
      return {
        kind: 'failed',
        error: new Error(`Portfolio not found for account ${String(ctx.accountId)}`),
        failureCode: 'PORTFOLIO_UNAVAILABLE',
      };
    }

    const openOrdersCount = await this._deps.orderRepo.countByStrategyId(ctx.strategyId);

    let activeSize = effectiveSize;
    let activeOrderId = orderId;

    let result = await this._deps.placeOrderUseCase.execute({
      orderId: activeOrderId,
      accountId: ctx.accountId,
      asset: effectiveAsset,
      instrumentId: effectiveInstrumentId,
      side: intent.side,
      price: intent.price,
      size: activeSize,
      postOnly: intent.postOnly,
      strategyId: ctx.strategyId,
      portfolio,
      openOrdersCount,
    });

    // L2 safety net: SELL dust-retry. Разрешён ТОЛЬКО при typed
    // INSUFFICIENT_TOKEN_BALANCE (definite venue reject) С числовой
    // balance-metadata. НИКОГДА не парсим текст ошибки; никакого retry при
    // SUBMISSION_OUTCOME_UNKNOWN / transport ambiguity / прочих кодах.
    if (!result.ok && intent.side === 'SELL') {
      const failureCode = getPlaceFailureCode(result.error);
      const balanceMetadata = getPlaceFailureBalance(result.error);
      if (failureCode === 'INSUFFICIENT_TOKEN_BALANCE' && balanceMetadata !== undefined) {
        const onChainBalance = balanceMetadata.onChainBalanceMicro;
        const orderAmount = balanceMetadata.orderAmountMicro;
        const deficit = orderAmount.minus(onChainBalance);
        const deficitPct = orderAmount.gt(0) ? deficit.div(orderAmount) : new Decimal(1);

        if (deficit.gt(0) && deficitPct.lt(ExecutionEngine._SELL_DUST_RETRY_MAX_DEFICIT)) {
          // Polymarket масштабирует amounts в микроединицах (1e6). Округляем
          // вниз до 2 dp (требование API для SELL makerAmount).
          const adjustedTokens = onChainBalance.div(1e6).toDecimalPlaces(2, Decimal.ROUND_DOWN);

          if (adjustedTokens.gt(0)) {
            try {
              const adjustedQty = Quantity.of(adjustedTokens);
              const newOrderId = this._deps.orderIdGenerator.next();
              this._sellDustRetryCount++;
              this._logger.warn('ExecutionEngine: SELL retry with on-chain adjusted size (typed metadata)', {
                strategyId: ctx.strategyId,
                instrumentId: instrumentKey,
                originalSize: activeSize.toNumber(),
                adjustedSize: adjustedTokens.toNumber(),
                deficitPct: deficitPct.toFixed(4),
                newOrderId: String(newOrderId),
                failureCode,
              });

              const refreshedPortfolio = this._deps.portfolioStore.get(ctx.accountId);
              if (refreshedPortfolio) {
                const retryOpenOrdersCount = await this._deps.orderRepo.countByStrategyId(ctx.strategyId);
                activeOrderId = newOrderId;
                activeSize = adjustedQty;
                result = await this._deps.placeOrderUseCase.execute({
                  orderId: activeOrderId,
                  accountId: ctx.accountId,
                  asset: effectiveAsset,
                  instrumentId: effectiveInstrumentId,
                  side: intent.side,
                  price: intent.price,
                  size: activeSize,
                  postOnly: intent.postOnly,
                  strategyId: ctx.strategyId,
                  portfolio: refreshedPortfolio,
                  openOrdersCount: retryOpenOrdersCount,
                });
              }
            } catch (err) {
              this._logger.warn('ExecutionEngine: SELL retry skipped — invalid adjusted size', {
                strategyId: ctx.strategyId,
                instrumentId: instrumentKey,
                adjustedTokens: adjustedTokens.toNumber(),
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      }
    }

    if (!result.ok) {
      const failureCode = getPlaceFailureCode(result.error);

      // Benign skip — ТОЛЬКО точный typed код POST_ONLY_WOULD_TAKE.
      if (intent.postOnly === true && failureCode === 'POST_ONLY_WOULD_TAKE') {
        this._benignPostOnlyRejects++;
        this._logger.info('ExecutionEngine: skip — benign post-only reject (typed)', {
          strategyId: ctx.strategyId,
          instrumentId: instrumentKey,
          side: intent.side,
          price: intent.price.toNumber(),
          size: intent.size.toNumber(),
          failureCode,
        });
        return { kind: 'skipped', reason: 'post-only would take (benign)' };
      }

      // Устанавливаем cooldown чтобы не спамить биржу при стабильном rejection.
      // SELL не блокируем: стратегия сама контролирует темп через FOK-логику.
      if (intent.side !== 'SELL') {
        this._exchangeRejectionCooldowns.set(rejectionKey, this._deps.clock.now().getTime());
      }
      // portfolioTokenQty: диагностика десинка in-memory vs on-chain.
      const currentPortfolio = this._deps.portfolioStore.get(ctx.accountId);
      const portfolioTokenQty = currentPortfolio
        ?.getPosition?.(effectiveInstrumentId)?.quantity.value().toNumber();
      const tokenReserved = currentPortfolio
        ?.tokenReservations?.get(effectiveInstrumentId)?.toNumber();
      this._logger.warn('ExecutionEngine: place failed — exchange rejection cooldown set', {
        orderId: String(orderId),
        strategyId: ctx.strategyId,
        side: intent.side,
        price: intent.price.toNumber(),
        size: intent.size.toNumber(),
        failureCode,
        error: result.error.message,
        cooldownMs: ExecutionEngine._EXCHANGE_REJECTION_COOLDOWN_MS,
        portfolioTokenQty,
        tokenReserved,
      });

      // Диагностика: при SELL rejection проверяем реальный баланс токена на CLOB.
      if (intent.side === 'SELL' && this._deps.tokenBalanceChecker) {
        const rawTokenId = effectiveAsset.type === 'POLYMARKET_CTF_TOKEN'
          ? effectiveAsset.tokenId
          : String(effectiveInstrumentId);
        this._deps.tokenBalanceChecker.getTokenBalanceAllowance(rawTokenId)
          .then((clobBalance) => {
            if (clobBalance) {
              this._logger.warn('ExecutionEngine: CLOB token balance after SELL rejection', {
                strategyId: ctx.strategyId,
                instrumentId: instrumentKey,
                clobBalance: clobBalance.balance,
                clobAllowance: clobBalance.allowance,
                portfolioTokenQty,
                tokenReserved,
              });
            }
          })
          .catch(() => { /* best effort */ });
      }

      return { kind: 'failed', error: result.error, failureCode };
    }

    this._logger.info('ExecutionEngine: order placed', {
      orderId: String(result.value),
      strategyId: ctx.strategyId,
      side: intent.side,
      price: intent.price.toNumber(),
      size: activeSize.toNumber(),
      ...(activeOrderId !== orderId ? { retriedAfterDust: true, originalSize: effectiveSize.toNumber() } : {}),
    });

    return { kind: 'placed' };
  }
}
