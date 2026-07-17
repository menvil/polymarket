/**
 * ExecutionEngine — исполняет StrategyIntent[] от стратегии.
 *
 * @remarks
 * ### Ответственности:
 * 1. **Нормализация** — dedupe и очистка intents перед исполнением
 * 2. **Порядок** — CANCEL_ALL → CANCEL → PLACE
 * 3. **Параллелизм** — Cancels параллельно, Places последовательно
 * 4. **Валидация** — reject (skip) если size/value нарушает constraints каталога
 * 5. **Отчёт** — ExecutionReport с результатами и ошибками
 *
 * ### Нормализация intents:
 * - Если есть CANCEL_ALL → убрать все отдельные CANCEL (дублирование)
 * - Dedupe CANCEL по orderId (один orderId → один cancel)
 * - Dedupe PLACE по `${side}:${price}` — оставить последний
 *
 * ### Валидация размера (reject-only, без коррекции):
 * Стратегия получает `InstrumentConstraints` через snapshot и сама адаптирует
 * размеры ордеров (BaseStrategy.adjustBuySize/adjustSellSize).
 * ExecutionEngine только валидирует: если intent нарушает constraints — reject (skip).
 * Никакого молчаливого клампирования — стратегия и execution полностью прозрачны.
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
 *   { type: 'CANCEL', orderId: someOrderId }, // будет удалён — дубль CANCEL_ALL
 *   { type: 'PLACE', side: 'BUY', price, size },
 * ]);
 *
 * console.log(report.placed, report.cancelled, report.errors.length);
 * ```
 */
import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { AccountId, AssetId, InstrumentId } from '@polymarket/ids';
import { asOrderId } from '@polymarket/ids';
import { Quantity } from '@polymarket/value-objects';
import type { PlaceOrderUseCase } from '@polymarket/use-cases';
import type { CancelOrderUseCase } from '@polymarket/use-cases';
import type { IPortfolioStore, IMarketCatalog } from '@polymarket/ports';
import type {
  StrategyIntent,
  PlaceIntent,
  CancelIntent,
} from './types/StrategyIntent.js';

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
}

/**
 * Типизированный результат исполнения CANCEL intent.
 *
 * @remarks
 * - `CONFIRMED` — venue подтвердил отмену (`CANCELLED`/`ALREADY_CANCELLED`):
 *   капитал освобождён, можно считать cancel успешным.
 * - `PENDING` — отмена НЕ подтверждена (`FILL_PENDING`: ордер matched, ждём
 *   fill; `RECONCILIATION_REQUIRED`: venue-исход неоднозначен): PLACE intents
 *   текущего цикла блокируются — размещение поверх неопределённого состояния
 *   могло бы задвоить экспозицию.
 * - `FAILED` — use case вернул Err (например, ордер не найден).
 */
export type CancelExecutionResult = 'CONFIRMED' | 'PENDING' | 'FAILED';

/**
 * Отчёт об исполнении intents.
 */
export interface ExecutionReport {
  /** Количество успешно размещённых ордеров */
  readonly placed: number;
  /** Количество успешно отменённых ордеров */
  readonly cancelled: number;
  /**
   * Количество намеренно пропущенных размещений (skip).
   *
   * @remarks
   * Skip ≠ ошибка. Пример: size < minOrderSize или value < minOrderValue.
   * Стратегия должна использовать constraints из snapshot для корректных размеров.
   */
  readonly skipped: number;
  /** Ошибки при исполнении отдельных intents */
  readonly errors: ReadonlyArray<{ intent: StrategyIntent; error: Error }>;
}

// ── Импорт IOrderRepository через inline type ──────────────
// (чтобы не добавлять лишнюю зависимость на ports — уже есть)

import type { IOrderRepository } from '@polymarket/ports';

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
   * (например, SELL с "not enough balance/allowance" из-за отсутствия token approval).
   * Без этого cooldown каждое новое рыночное событие триггерит стратегию →
   * SELL → rejection → откат резервации → следующий тик → снова SELL → 10+ RPS.
   */
  private readonly _exchangeRejectionCooldowns = new Map<string, number>();

  /** 5 секунд cooldown после отклонения биржей */
  private static readonly _EXCHANGE_REJECTION_COOLDOWN_MS = 5_000;

  /**
   * Cooldown per instrumentId после cancel ордера.
   * Ключ: instrumentId. Значение: timestamp последнего cancel (clock.now()).
   *
   * @remarks
   * Защищает от cancel-and-replace race condition на Polymarket:
   * cancel на CLOB НЕ отменяет on-chain fill (MINT уже в пути).
   * Без этого cooldown стратегия отменяет BUY-ордер, сразу ставит новый BUY,
   * а fill на отменённый ордер всё равно приходит → двойная/тройная покупка.
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
   * Вызывается при получении CONFIRMED fill для инструмента.
   * On-chain settlement завершён → безопасно размещать новые ордера.
   * Без этого стратегия ждёт полные 20 секунд даже если fill пришёл раньше.
   */
  public clearPostCancelCooldown(instrumentId: InstrumentId): void {
    const key = String(instrumentId);
    if (this._postCancelCooldowns.delete(key)) {
      this._logger.debug('ExecutionEngine: post-cancel cooldown cleared (fill received)', {
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
   * @param ctx - Контекст: strategyId, accountId, instrumentId, asset
   * @param intents - Сырые intents от стратегии
   * @returns ExecutionReport с результатами
   *
   * @remarks
   * Порядок: normalize → CANCEL_ALL → CANCEL → PLACE.
   * Cancels параллельно (Promise.allSettled), places последовательно (баланс).
   * Ошибки не прерывают исполнение — собираются в report.errors.
   */
  public async execute(
    ctx: ExecutionContext,
    intents: readonly StrategyIntent[],
  ): Promise<ExecutionReport> {
    const normalized = _normalize(intents);
    if (!normalized.hasCancelAll && normalized.cancels.length === 0 && normalized.places.length === 0) {
      return { placed: 0, cancelled: 0, skipped: 0, errors: [] };
    }

    let cancelled = 0;
    let placed = 0;
    let skipped = 0;
    const errors: Array<{ intent: StrategyIntent; error: Error }> = [];

    // ── 1. CANCEL_ALL → разворачиваем в конкретные orderIds ─
    if (normalized.hasCancelAll) {
      const orders = await this._deps.orderRepo.getByStrategyId(ctx.strategyId);
      for (const order of orders) {
        normalized.cancels.push({ type: 'CANCEL', orderId: order.id });
      }
    }

    // ── 2. Cancels параллельно ──────────────────────────────
    // PENDING (FILL_PENDING / RECONCILIATION_REQUIRED) — отмена НЕ подтверждена:
    // блокируем ВСЕ PLACE intents текущего цикла (включая SELL — reconciliation
    // block не обходится по стороне). Финальный контроль остаётся в
    // PlaceOrderUseCase (unsettled-fills guard под mutex).
    let hasPendingCancel = false;
    if (normalized.cancels.length > 0) {
      const cancelResults = await Promise.allSettled(
        normalized.cancels.map((intent) => this._executeCancel(ctx, intent)),
      );

      for (let i = 0; i < cancelResults.length; i++) {
        const result = cancelResults[i];
        if (result.status === 'rejected') {
          errors.push({
            intent: normalized.cancels[i],
            error: result.reason instanceof Error
              ? result.reason
              : new Error(String(result.reason)),
          });
          continue;
        }
        switch (result.value) {
          case 'CONFIRMED':
            // cancelled++ ТОЛЬКО для подтверждённой отмены (CANCELLED/ALREADY_CANCELLED).
            cancelled++;
            break;
          case 'PENDING':
            hasPendingCancel = true;
            break;
          case 'FAILED':
            // Cancel failed via Result.err — already logged in _executeCancel
            errors.push({
              intent: normalized.cancels[i],
              error: new Error('Cancel failed'),
            });
            break;
        }
      }
    }

    // ── 3. Places последовательно ───────────────────────────
    for (const intent of normalized.places) {
      if (hasPendingCancel) {
        // Неопределённый cancel в этом же цикле: размещение (BUY И SELL)
        // блокируется до подтверждения/реконсиляции — SELL не обходит блок.
        this._logger.warn('ExecutionEngine: skip PLACE — unconfirmed cancel in same execution cycle', {
          strategyId: ctx.strategyId,
          instrumentId: String(intent.targetInstrumentId ?? ctx.instrumentId),
          side: intent.side,
        });
        skipped++;
        continue;
      }
      const result = await this._executePlace(ctx, intent);
      if (result === 'placed') {
        placed++;
      } else if (result === 'skipped') {
        skipped++;
      } else {
        errors.push({ intent, error: new Error('Place failed') });
      }
    }

    return { placed, cancelled, skipped, errors };
  }

  // ── Исполнение отдельных intents ─────────────────────────

  /**
   * Исполняет CANCEL intent.
   *
   * @returns Типизированный {@link CancelExecutionResult}:
   *   `CONFIRMED` — venue подтвердил (CANCELLED/ALREADY_CANCELLED);
   *   `PENDING` — не подтверждено (FILL_PENDING/RECONCILIATION_REQUIRED);
   *   `FAILED` — use case вернул Err
   *
   * @remarks
   * Раньше ЛЮБОЙ Ok считался успешной отменой — но `CancelOrderOutcome`
   * включает FILL_PENDING/RECONCILIATION_REQUIRED, которые отменой НЕ являются.
   * Cooldown ставится только для CONFIRMED: он — защита от on-chain fill после
   * подтверждённого cancel, а НЕ подтверждение отмены. Окончательный контроль
   * всё равно в PlaceOrderUseCase (unsettled-fills guard).
   */
  private async _executeCancel(ctx: ExecutionContext, intent: CancelIntent): Promise<CancelExecutionResult> {
    const result = await this._deps.cancelOrderUseCase.execute({
      orderId: intent.orderId,
      accountId: ctx.accountId,
      reason: `Strategy ${ctx.strategyId} requested cancel`,
    });

    if (!result.ok) {
      this._logger.warn('ExecutionEngine: cancel failed', {
        orderId: String(intent.orderId),
        strategyId: ctx.strategyId,
        error: result.error.message,
      });
      return 'FAILED';
    }

    const outcome = result.value;
    if (outcome.status === 'FILL_PENDING' || outcome.status === 'RECONCILIATION_REQUIRED') {
      // Отмена НЕ подтверждена: ордер matched (ждём fill) либо venue-исход
      // неоднозначен. cancelled НЕ инкрементируется, PLACE intents текущего
      // цикла будут заблокированы (см. execute()).
      this._logger.warn('ExecutionEngine: cancel not confirmed — blocking PLACE intents this cycle', {
        orderId: String(intent.orderId),
        strategyId: ctx.strategyId,
        outcome: outcome.status,
        ...(outcome.status === 'RECONCILIATION_REQUIRED' ? { reason: outcome.reason } : {}),
      });
      return 'PENDING';
    }

    // CANCELLED / ALREADY_CANCELLED — подтверждённая отмена.
    // Post-cancel cooldown: блокируем новые BUY на этом инструменте.
    // Cancel на CLOB не отменяет on-chain fill — MINT может быть уже в пути.
    // Без cooldown: cancel → place(новый) → fill(старый) приходит → двойная покупка.
    const instrumentKey = String(ctx.instrumentId);
    this._postCancelCooldowns.set(instrumentKey, this._deps.clock.now().getTime());
    this._logger.info('ExecutionEngine: post-cancel cooldown set', {
      strategyId: ctx.strategyId,
      instrumentId: instrumentKey,
      orderId: String(intent.orderId),
      cooldownMs: ExecutionEngine._POST_CANCEL_COOLDOWN_MS,
    });

    return 'CONFIRMED';
  }

  /**
   * Исполняет PLACE intent.
   *
   * @returns `'placed'` при успехе, `'skipped'` при намеренном пропуске, `'failed'` при ошибке
   *
   * @remarks
   * Генерирует orderId, получает portfolio из store,
   * считает openOrdersCount и вызывает PlaceOrderUseCase.
   *
   * ### Валидация (reject-only, без коррекции):
   * - Reject если `size < minOrderSize`
   * - Reject BUY если `price × size < minOrderValue`
   * Стратегия должна сама адаптировать размеры через `InstrumentConstraints`
   * в snapshot и helpers `BaseStrategy.adjustBuySize()/adjustSellSize()`.
   *
   * ### Exchange rejection cooldown:
   * При rejection от биржи устанавливается 5-секундный cooldown per `instrumentId:side`.
   * Предотвращает retry-цикл: rejection → откат резервации → новый тик → снова rejection.
   */
  private async _executePlace(ctx: ExecutionContext, intent: PlaceIntent): Promise<'placed' | 'skipped' | 'failed'> {
    const nowForCooldown = this._deps.clock.now().getTime();
    // Если intent указывает целевой инструмент (auto-selection) — используем его
    const effectiveInstrumentId = intent.targetInstrumentId ?? ctx.instrumentId;
    const effectiveAsset = intent.targetAsset ?? ctx.asset;
    const instrumentKey = String(effectiveInstrumentId);

    // ── Post-cancel cooldown ────────────────────────────────
    // Блокируем только новые BUY после cancel. SELL-выходы нельзя задерживать:
    // hard stop / emergency exit должен пройти даже если перед этим отменяли
    // stale BUY. Иначе на 5m binary market позиция может уйти к 1c за cooldown.
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
      return 'skipped';
    }

    // ── Exchange rejection cooldown ──────────────────────────
    // Если биржа недавно отклонила ордер по этому инструменту/стороне —
    // пропускаем размещение до истечения cooldown.
    // Предотвращает retry-цикл: rejection → откат резервации → новый тик → снова rejection.
    //
    // SELL-выходы (SL/TP) исключаем из cooldown: стратегия сама контролирует темп retry
    // через FOK-логику (не чаще чем раз в 0.5s). Cooldown блокировал бы критические
    // SELL на 5s — слишком долго для stop-loss на 5-минутном рынке.
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
        return 'skipped';
      }
    }

    const orderId = asOrderId(randomUUID())!;
    const portfolio = this._deps.portfolioStore.get(ctx.accountId);

    if (portfolio === undefined) {
      this._logger.warn('ExecutionEngine: portfolio not found, skipping place', {
        strategyId: ctx.strategyId,
        accountId: String(ctx.accountId),
      });
      return 'failed';
    }

    // Валидация size по каталогу — reject без коррекции.
    // Стратегия должна сама адаптировать size используя constraints из snapshot
    // и helpers BaseStrategy.adjustBuySize() / adjustSellSize().
    const info = this._deps.catalog.get(effectiveInstrumentId);
    const effectiveSize = intent.size;
    const effectivePrice = intent.price;

    if (!effectiveSize.value().gt(0) || !effectivePrice.value().gt(0)) {
      this._logger.warn('ExecutionEngine: reject — non-positive order price or size', {
        strategyId: ctx.strategyId,
        instrumentId: instrumentKey,
        side: intent.side,
        price: effectivePrice.toNumber(),
        size: effectiveSize.toNumber(),
      });
      return 'skipped';
    }

    if (info) {
      // 1. Reject BUY если size < minOrderSize.
      // SELL не блокируем по minOrderSize — Polymarket позволяет продать остаток
      // целиком даже если он меньше minOrderSize (после fee deduction и т.п.).
      if (intent.side === 'BUY' && effectiveSize.value().lt(info.minOrderSize.value())) {
        this._logger.warn('ExecutionEngine: reject — size below minOrderSize (strategy must use constraints)', {
          strategyId: ctx.strategyId,
          instrumentId: instrumentKey,
          side: intent.side,
          size: effectiveSize.toNumber(),
          minOrderSize: info.minOrderSize.toNumber(),
        });
        return 'skipped';
      }

      // 2. Reject BUY если orderValue < minOrderValue
      if (intent.side === 'BUY' && info.minOrderValue.value().gt(0)) {
        const orderValue = intent.price.value().mul(effectiveSize.value());
        if (orderValue.lt(info.minOrderValue.value())) {
          this._logger.warn('ExecutionEngine: reject — order value below minOrderValue (strategy must use constraints)', {
            strategyId: ctx.strategyId,
            instrumentId: instrumentKey,
            price: intent.price.toNumber(),
            size: effectiveSize.toNumber(),
            orderValue: orderValue.toNumber(),
            minOrderValue: info.minOrderValue.toNumber(),
          });
          return 'skipped';
        }
      }
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
    } as any);

    // L2 safety net: при SELL rejection с dust-дефицитом (<1%) парсим on-chain balance
    // из текста ошибки и повторяем ОДИН раз с adjusted size. Страхует случаи,
    // когда L1 pre-check в адаптере не сконфигурирован или проигнорировал race condition
    // (баланс упал между pre-check и postOrder).
    if (!result.ok && intent.side === 'SELL') {
      const retryHint = _parseBalanceRejection(result.error.message);
      if (retryHint) {
        const { onChainBalance, orderAmount } = retryHint;
        const deficit = orderAmount - onChainBalance;
        const deficitPct = orderAmount > 0 ? deficit / orderAmount : 1;

        if (deficit > 0 && deficitPct < ExecutionEngine._SELL_DUST_RETRY_MAX_DEFICIT) {
          // Polymarket маскшабирует amounts в микроединицах (1e6). Округляем вниз до 2 dp
          // (требование API для SELL makerAmount).
          const adjustedTokens = Math.floor((onChainBalance / 1e6) * 100) / 100;

          if (adjustedTokens > 0) {
            try {
              const adjustedQty = Quantity.of(new Decimal(adjustedTokens));
              const newOrderId = asOrderId(randomUUID())!;
              this._sellDustRetryCount++;
              this._logger.warn('ExecutionEngine: SELL retry with on-chain adjusted size', {
                strategyId: ctx.strategyId,
                instrumentId: instrumentKey,
                originalSize: activeSize.toNumber(),
                adjustedSize: adjustedTokens,
                deficitPct: deficitPct.toFixed(4),
                newOrderId: String(newOrderId),
                previousError: result.error.message,
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
                } as any);
              }
            } catch (err) {
              this._logger.warn('ExecutionEngine: SELL retry skipped — invalid adjusted size', {
                strategyId: ctx.strategyId,
                instrumentId: instrumentKey,
                adjustedTokens,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      }
    }

    if (!result.ok) {
      if (intent.postOnly === true && _isBenignPostOnlyReject(result.error.message)) {
        this._benignPostOnlyRejects++;
        this._logger.info('ExecutionEngine: skip — benign post-only reject', {
          strategyId: ctx.strategyId,
          instrumentId: instrumentKey,
          side: intent.side,
          price: intent.price.toNumber(),
          size: intent.size.toNumber(),
          error: result.error.message,
        });
        return 'skipped';
      }

      // Устанавливаем cooldown чтобы не спамить биржу при стабильном rejection.
      // Cooldown сбросится сам через _EXCHANGE_REJECTION_COOLDOWN_MS (5s).
      // SELL не блокируем: стратегия сама контролирует темп через FOK-логику.
      if (intent.side !== 'SELL') {
        this._exchangeRejectionCooldowns.set(rejectionKey, this._deps.clock.now().getTime());
      }
      // portfolioTokenQty: диагностика десинка in-memory vs on-chain.
      // Если qty совпадает с размером ордера — скорее всего token approval не выставлен.
      // Если qty=0 или меньше — fill не дошёл, портфолио не обновлён.
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
        error: result.error.message,
        cooldownMs: ExecutionEngine._EXCHANGE_REJECTION_COOLDOWN_MS,
        portfolioTokenQty,
        tokenReserved,
      });

      // Диагностика: при SELL rejection проверяем реальный баланс токена на CLOB.
      // Позволяет отличить settlement lag от allowance проблемы.
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

      return 'failed';
    }

    this._logger.info('ExecutionEngine: order placed', {
      orderId: String(result.value),
      strategyId: ctx.strategyId,
      side: intent.side,
      price: intent.price.toNumber(),
      size: activeSize.toNumber(),
      ...(activeOrderId !== orderId ? { retriedAfterDust: true, originalSize: effectiveSize.toNumber() } : {}),
    });

    return 'placed';
  }

  /**
   * Парсит сообщение rejection от Polymarket CLOB для извлечения фактического баланса.
   *
   * @param message - Текст ошибки от биржи (обычно обёрнут в TradingError)
   * @returns Числа в микроединицах (1e6) или null если формат не распознан
   *
   * @remarks
   * Ожидаемый формат (стабильный на текущей версии CLOB):
   * `not enough balance / allowance: the balance is not enough -> balance: 9557200, order amount: 9560000`
   *
   * Значения в микроединицах USDC/token (6 dp). Парсер толерантен к префиксу: ищет
   * подстроку `balance: X, order amount: Y` в любом месте сообщения.
   */
}

// ── Внутренние чистые функции ──────────────────────────────

/**
 * Нормализует intents: dedupe и сортировка.
 *
 * @remarks
 * 1. Если CANCEL_ALL → все отдельные CANCEL удаляются
 * 2. CANCEL dedupe по orderId
 * 3. PLACE dedupe по `${side}:${price}` — последний побеждает
 */
function _normalize(intents: readonly StrategyIntent[]): NormalizedIntents {
  let hasCancelAll = false;
  const cancelMap = new Map<string, CancelIntent>();
  const placeMap = new Map<string, PlaceIntent>();

  for (const intent of intents) {
    switch (intent.type) {
      case 'CANCEL_ALL':
        hasCancelAll = true;
        break;
      case 'CANCEL':
        cancelMap.set(String(intent.orderId), intent);
        break;
      case 'PLACE':
        placeMap.set(`${intent.side}:${intent.price.toNumber()}`, intent);
        break;
    }
  }

  return {
    hasCancelAll,
    cancels: hasCancelAll ? [] : [...cancelMap.values()],
    places: [...placeMap.values()],
  };
}

function _parseBalanceRejection(message: string): { onChainBalance: number; orderAmount: number } | null {
  const match = message.match(/balance:\s*(\d+),\s*order amount:\s*(\d+)/i);
  if (!match) return null;
  const onChainBalance = Number(match[1]);
  const orderAmount = Number(match[2]);
  if (!Number.isFinite(onChainBalance) || !Number.isFinite(orderAmount)) return null;
  return { onChainBalance, orderAmount };
}

function _isBenignPostOnlyReject(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('post only') ||
    text.includes('post-only') ||
    text.includes('defer') ||
    text.includes('marketable') ||
    text.includes('would execute immediately')
  );
}

interface NormalizedIntents {
  readonly hasCancelAll: boolean;
  readonly cancels: CancelIntent[];
  readonly places: PlaceIntent[];
}
