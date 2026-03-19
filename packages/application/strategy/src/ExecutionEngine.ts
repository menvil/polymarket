/**
 * ExecutionEngine — исполняет StrategyIntent[] от стратегии.
 *
 * @remarks
 * ### Ответственности:
 * 1. **Нормализация** — dedupe и очистка intents перед исполнением
 * 2. **Порядок** — CANCEL_ALL → CANCEL → PLACE
 * 3. **Параллелизм** — Cancels параллельно, Places последовательно
 * 4. **Клампирование размера** — size клампируется к minOrderSize из каталога
 * 5. **Отчёт** — ExecutionReport с результатами и ошибками
 *
 * ### Нормализация intents:
 * - Если есть CANCEL_ALL → убрать все отдельные CANCEL (дублирование)
 * - Dedupe CANCEL по orderId (один orderId → один cancel)
 * - Dedupe PLACE по `${side}:${price}` — оставить последний
 *
 * ### Клампирование размера ордера:
 * Перед отправкой PLACE проверяем `InstrumentInfo.minOrderSize` из каталога.
 * Если `intent.size < minOrderSize` — клампируем к minOrderSize и логируем WARN.
 * Это корректирует некорректный конфиг стратегии вместо отклонения ордера.
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
import type { ILogger } from '@polymarket/logger';
import type { AccountId, AssetId, InstrumentId } from '@polymarket/ids';
import { asOrderId } from '@polymarket/ids';
import type { PlaceOrderUseCase } from '@polymarket/use-cases';
import type { CancelOrderUseCase } from '@polymarket/use-cases';
import type { IPortfolioStore, IMarketCatalog } from '@polymarket/ports';
import { Quantity } from '@polymarket/value-objects';
import Decimal from 'decimal.js';
import type {
  StrategyIntent,
  PlaceIntent,
  CancelIntent,
} from './types/StrategyIntent.js';

// ── Публичные типы ─────────────────────────────────────────

/**
 * Зависимости ExecutionEngine.
 */
export interface ExecutionEngineDeps {
  readonly placeOrderUseCase: PlaceOrderUseCase;
  readonly cancelOrderUseCase: CancelOrderUseCase;
  readonly orderRepo: IOrderRepository;
  readonly portfolioStore: IPortfolioStore;
  /** Каталог инструментов — используется для получения minOrderSize при клампировании */
  readonly catalog: IMarketCatalog;
  /**
   * Максимальный размер позиции по инструменту (в токенах).
   * Если задан, клампирование для minOrderValue не превысит оставшуюся ёмкость позиции —
   * вместо отправки заведомо невалидного ордера выдаётся ранний отказ.
   */
  readonly maxPositionSize?: Decimal;
  readonly logger: ILogger;
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
   * Skip ≠ ошибка. Пример: price × maxPositionCapacity < minOrderValue —
   * размещать заведомо невалидный ордер нет смысла.
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

  constructor(private readonly _deps: ExecutionEngineDeps) {
    this._logger = _deps.logger.child({ component: 'ExecutionEngine' });
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
    const normalized = this._normalize(intents);
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
    if (normalized.cancels.length > 0) {
      const cancelResults = await Promise.allSettled(
        normalized.cancels.map((intent) => this._executeCancel(ctx, intent)),
      );

      for (let i = 0; i < cancelResults.length; i++) {
        const result = cancelResults[i];
        if (result.status === 'fulfilled' && result.value) {
          cancelled++;
        } else if (result.status === 'rejected') {
          errors.push({
            intent: normalized.cancels[i],
            error: result.reason instanceof Error
              ? result.reason
              : new Error(String(result.reason)),
          });
        } else if (result.status === 'fulfilled' && !result.value) {
          // Cancel failed via Result.err — already logged in _executeCancel
          errors.push({
            intent: normalized.cancels[i],
            error: new Error('Cancel failed'),
          });
        }
      }
    }

    // ── 3. Places последовательно ───────────────────────────
    for (const intent of normalized.places) {
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

  // ── Нормализация ─────────────────────────────────────────

  /**
   * Нормализует intents: dedupe и сортировка.
   *
   * @param intents - Сырые intents
   * @returns Нормализованные: hasCancelAll, cancels (dedupe), places (dedupe)
   *
   * @remarks
   * 1. Если CANCEL_ALL → все отдельные CANCEL удаляются
   * 2. CANCEL dedupe по orderId
   * 3. PLACE dedupe по `${side}:${price}` — последний побеждает
   */
  private _normalize(intents: readonly StrategyIntent[]): NormalizedIntents {
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
      // Если CANCEL_ALL — не нужны отдельные cancels (CANCEL_ALL разворачивается отдельно)
      cancels: hasCancelAll ? [] : [...cancelMap.values()],
      places: [...placeMap.values()],
    };
  }

  // ── Исполнение отдельных intents ─────────────────────────

  /**
   * Исполняет CANCEL intent.
   *
   * @returns true если cancel успешен, false если ошибка
   */
  private async _executeCancel(ctx: ExecutionContext, intent: CancelIntent): Promise<boolean> {
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
      return false;
    }
    return true;
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
   * ### Клампирование размера:
   * Если `intent.size < minOrderSize` (из каталога) — клампируем к minOrderSize.
   * Это корректирует конфиг стратегии (orderSize) вместо отклонения ордера.
   * Логируем WARN с requested/effective размерами для отладки.
   *
   * ### Skip vs Error:
   * `'skipped'` возвращается когда размещать ордер нет смысла по известному условию
   * (например, price × maxPositionCapacity < minOrderValue). Это НЕ ошибка —
   * стратегия просто ждёт пока рыночные условия изменятся.
   */
  private async _executePlace(ctx: ExecutionContext, intent: PlaceIntent): Promise<'placed' | 'skipped' | 'failed'> {
    const orderId = asOrderId(randomUUID())!;
    const portfolio = this._deps.portfolioStore.get(ctx.accountId);

    if (portfolio === undefined) {
      this._logger.warn('ExecutionEngine: portfolio not found, skipping place', {
        strategyId: ctx.strategyId,
        accountId: String(ctx.accountId),
      });
      return 'failed';
    }

    // Клампирование size из каталога
    const info = this._deps.catalog.get(ctx.instrumentId);
    let effectiveSize = intent.size;

    if (info) {
      // 1. Клампирование к minOrderSize (минимум в токенах)
      if (effectiveSize.value().lt(info.minOrderSize.value())) {
        this._logger.warn('ExecutionEngine: clamping order size to minOrderSize', {
          strategyId: ctx.strategyId,
          instrumentId: String(ctx.instrumentId),
          requested: effectiveSize.toNumber(),
          effective: info.minOrderSize.toNumber(),
        });
        effectiveSize = info.minOrderSize;
      }

      // 2. Клампирование к minOrderValue (минимальная стоимость в USDC: price × size >= minOrderValue)
      // Polymarket отклоняет BUY-ордера с суммой < $1
      if (intent.side === 'BUY' && info.minOrderValue.value().gt(0)) {
        const orderValue = intent.price.value().mul(effectiveSize.value());
        if (orderValue.lt(info.minOrderValue.value())) {
          const minSizeForValue = info.minOrderValue.value().div(intent.price.value()).ceil();

          // Ограничиваем клампирование оставшейся ёмкостью позиции (maxPositionSize из riskParams).
          // Если minSizeForValue > remaining capacity — ордер всё равно провалился бы на риск-чекере.
          // Вместо отправки заведомо невалидного ордера — отказываем здесь с понятным сообщением.
          const maxPos = this._deps.maxPositionSize;
          if (maxPos !== undefined) {
            const currentQtyDecimal = portfolio.getPosition(ctx.instrumentId)?.quantity.value()
              ?? new Decimal(0);
            const remaining = maxPos.minus(currentQtyDecimal);
            if (minSizeForValue.gt(remaining)) {
              this._logger.debug('ExecutionEngine: skip — order value too small to place within position limit', {
                strategyId: ctx.strategyId,
                instrumentId: String(ctx.instrumentId),
                price: intent.price.toNumber(),
                requestedSize: effectiveSize.toNumber(),
                neededSizeForMinValue: minSizeForValue.toNumber(),
                remainingPositionCapacity: remaining.toNumber(),
                minOrderValue: info.minOrderValue.toNumber(),
              });
              return 'skipped';
            }
          }

          const clampedSize = Quantity.of(minSizeForValue);
          this._logger.warn('ExecutionEngine: clamping order size to meet minOrderValue', {
            strategyId: ctx.strategyId,
            instrumentId: String(ctx.instrumentId),
            price: intent.price.toNumber(),
            requestedSize: effectiveSize.toNumber(),
            effectiveSize: clampedSize.toNumber(),
            orderValue: orderValue.toNumber(),
            minOrderValue: info.minOrderValue.toNumber(),
          });
          effectiveSize = clampedSize;
        }
      }
    }

    const openOrdersCount = await this._deps.orderRepo.countByStrategyId(ctx.strategyId);

    const result = await this._deps.placeOrderUseCase.execute({
      orderId,
      accountId: ctx.accountId,
      asset: ctx.asset,
      instrumentId: ctx.instrumentId,
      side: intent.side,
      price: intent.price,
      size: effectiveSize,
      strategyId: ctx.strategyId,
      portfolio,
      openOrdersCount,
    });

    if (!result.ok) {
      this._logger.warn('ExecutionEngine: place failed', {
        orderId: String(orderId),
        strategyId: ctx.strategyId,
        side: intent.side,
        price: intent.price.toNumber(),
        size: intent.size.toNumber(),
        error: result.error.message,
      });
      return 'failed';
    }

    this._logger.debug('ExecutionEngine: order placed', {
      orderId: String(result.value),
      strategyId: ctx.strategyId,
      side: intent.side,
      price: intent.price.toNumber(),
      size: effectiveSize.toNumber(),
    });

    return 'placed';
  }
}

// ── Внутренний тип ─────────────────────────────────────────

interface NormalizedIntents {
  readonly hasCancelAll: boolean;
  readonly cancels: CancelIntent[];
  readonly places: PlaceIntent[];
}
