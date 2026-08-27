/**
 * DumbStrategy — простейшая стратегия для smoke-тестирования всей цепочки.
 *
 * @remarks
 * ### Алгоритм (gather → decide → toIntents):
 *
 * **gather**: Считывает refPrice (lastTradePrice из tape или bestAsk), позицию, открытые ордера и баланс.
 *
 * **decide**:
 * 1. Нет позиции + нет ордеров → ENTER: BUY по (refPrice - buyOffset).
 * 2. Нет позиции + есть BUY ордер + цена ушла вверх (> repriceThreshold USDC) → REPRICE: CANCEL + новый тик сделает ENTER.
 * 3. Нет позиции + есть BUY ордер + цена в норме → HOLD (ждём исполнения).
 * 4. Есть позиция + нет SELL-ордера + нет BUY-ордеров → EXIT: SELL по (entryPrice + profitMargin).
 * 5. Есть позиция + есть SELL ордер → HOLD (ждём исполнения).
 * 6. Есть позиция + есть открытые BUY-ордера → CANCEL их, потом SELL.
 *
 * ### REPRICE и race condition (решено в инфраструктуре):
 * ProcessFillUseCase выполняет шаги apply+save атомарно (без yield), сохраняя
 * FILLED в IOrderStateStore до первого await. CancelOrderUseCase проверяет
 * `order.isTerminal` и сравнивает stateStore vs repo после cancel:
 * - Если fill обогнал cancel → orderStateStore=FILED, cancel пропускает резервацию.
 * - Если cancel обогнал fill → fill читает CANCELLED из repo → applyFill возвращает Err
 *   → ProcessFillUseCase логирует warn и возвращает Err (fill потерян).
 * Вывод: repriceThreshold должен быть достаточно большим (например 0.05–0.10 USDC),
 * чтобы REPRICE не срабатывал при мелких колебаниях и fill успевал обработаться.
 *
 * ### Строгий режим «купил → продай → потом покупай»:
 * Стратегия не выставляет новый BUY пока positionQty > 0.
 * Гарантируется через ветвление: positionQty.isZero() → BUY-ветка, иначе SELL-ветка.
 *
 * ### Пример потока (AMM-рынок, цена из tape):
 * ```
 * lastTradePrice=0.50 → BUY лимитка @ 0.497 (offset=0.003)
 * bestAsk=0.497 ≤ 0.497 → book crossing → BUY исполнился @ 0.497
 * positionQty=5 → SELL @ 0.497+0.003=0.500
 * tradePrice=0.501 ≥ 0.500 → tape fill → SELL исполнился
 * positionQty=0 → снова BUY
 * ```
 *
 * @example
 * ```typescript
 * const dumb = new DumbStrategy({
 *   orderSize: new Decimal('5'),
 *   buyOffsetPct: new Decimal('10'),    // BUY на 10% ниже refPrice
 *   profitMarginPct: new Decimal('5'),  // SELL на 5% выше цены входа
 *   repriceThreshold: new Decimal('0.08'), // переставляем если рынок ушёл вверх на 8 центов
 * });
 * await scheduler.register({ strategy: dumb, instrumentId, asset, accountId, market });
 * ```
 */
import { BaseStrategy } from '@polymarket/strategy';
import type { StrategySnapshot, StrategyIntent, TriggerReason } from '@polymarket/strategy';
import { OutcomePrice, Quantity } from '@polymarket/value-objects';
import type { OrderId, StrategyId } from '@polymarket/ids';
import { unsafeStrategyId } from '@polymarket/ids';
import type { ILogger } from '@polymarket/logger';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренний Decimal-конвент apps/bot/strategies/*, см. docs/architecture/boundary-contract.md, Решение 11
import Decimal from 'decimal.js';

// ── Конфигурация ─────────────────────────────────────────────────────────────

/**
 * Параметры DumbStrategy.
 *
 * @param orderSize - Размер ордера (в токенах)
 * @param buyOffsetPct - Отступ ниже refPrice в процентах (0–100). Например, `10` = BUY
 *   на 10% ниже refPrice: `targetBuyPrice = refPrice * (1 - buyOffsetPct / 100)`
 * @param profitMarginPct - Наценка на продажу в процентах (0–100). Например, `5` = SELL
 *   на 5% выше цены входа: `sellPrice = entryPrice * (1 + profitMarginPct / 100)`
 * @param repriceThreshold - Абсолютный порог переставки в USDC: переставляем BUY если рынок
 *   ушёл вверх на ≥ repriceThreshold от текущей цены ордера. Например, `0.08` = 8 центов.
 */
export interface DumbStrategyConfig {
  readonly orderSize: Decimal;
  readonly buyOffsetPct: Decimal;
  readonly profitMarginPct: Decimal;
  readonly repriceThreshold: Decimal;
}

// ── Типы gather/decide ──────────────────────────────────────────────────────

/** Открытый BUY-ордер, переданный из gather в decide */
export interface OpenBuyOrder {
  readonly orderId: OrderId;
  readonly orderPrice: Decimal;
}

/** Данные, собранные из snapshot для принятия решений */
export interface DumbData {
  /**
   * Ориентир цены для размещения BUY-ордера.
   *
   * @remarks
   * Приоритет: lastTradePrice (из ленты трейдов) → bestAsk (топ книги).
   * На AMM-рынках (Polymarket "Up or Down") bestAsk фиксирован на уровне AMM,
   * поэтому lastTradePrice даёт реальную рыночную цену.
   */
  readonly refPrice: Decimal | undefined;
  /** Количество токенов в позиции (0 если нет позиции) */
  readonly positionQty: Decimal;
  /** Средняя цена входа (undefined если нет позиции) */
  readonly entryPrice: Decimal | undefined;
  /** Доступный баланс USDC */
  readonly availableBalance: Decimal;
  /** Открытые BUY-ордера этой стратегии (не более одного в нормальной работе) */
  readonly openBuyOrders: readonly OpenBuyOrder[];
  /** Есть ли открытые SELL-ордера (для HOLD при ожидании продажи) */
  readonly hasOpenSellOrders: boolean;
  /**
   * Есть ли MATCHED ордера (in-flight fills, MATCHED → MINED → CONFIRMED).
   *
   * @remarks
   * Если true — не размещать новые BUY/SELL, ждать CONFIRMED.
   * Без этой проверки стратегия многократно покупает пока fills в пути.
   */
  readonly hasMatchedOrders: boolean;
  /** Минимальный размер ордера в токенах (из constraints, undefined если нет данных) */
  readonly minOrderSize: Decimal | undefined;
  /** Минимальная стоимость ордера в USDC (из constraints, undefined если нет данных) */
  readonly minOrderValue: Decimal | undefined;
  /** Минимальный шаг цены (из constraints, undefined если нет данных) */
  readonly tickSize: Decimal | undefined;
}

/** Действие стратегии */
export type DumbAction =
  | { readonly type: 'ENTER'; readonly price: Decimal; readonly size: Decimal }
  | { readonly type: 'EXIT'; readonly price: Decimal; readonly size: Decimal }
  | { readonly type: 'CANCEL'; readonly orderId: OrderId };

// ── Реализация ──────────────────────────────────────────────────────────────

export class DumbStrategy extends BaseStrategy<DumbData, DumbAction> {
  public readonly id: StrategyId;
  public readonly name = 'DumbStrategy';

  private readonly _config: DumbStrategyConfig;
  private readonly _logger: ILogger | undefined;

  /**
   * @param config - Параметры стратегии
   * @param strategyId - Уникальный идентификатор экземпляра (по умолчанию 'dumb-1')
   * @param logger - Опциональный логгер для диагностики тиков
   */
  constructor(config: DumbStrategyConfig, strategyId: StrategyId = unsafeStrategyId('dumb-1'), logger?: ILogger) {
    super();
    this._config = config;
    this.id = strategyId;
    this._logger = logger;
  }

  /**
   * Считывает данные из snapshot.
   *
   * @param snapshot - Readonly snapshot текущего состояния
   * @returns DumbData (refPrice может быть undefined — decide() сам решает,
   *   какие ветки требуют refPrice)
   *
   * @remarks
   * Приоритет цены: lastTradePrice (tape) > bestAsk (topOfBook).
   * На AMM-рынках Polymarket bestAsk может быть нерепрезентативным,
   * а реальная цена приходит в last_trade_price событиях.
   */
  protected gather(snapshot: StrategySnapshot): DumbData | undefined {
    const tob = snapshot.topOfBook;
    const tapeRecords = snapshot.tradeTape?.getAll();
    const lastTradePrice = tapeRecords && tapeRecords.length > 0
      ? tapeRecords[tapeRecords.length - 1]!.price.value()
      : undefined;

    const refPrice = lastTradePrice ?? tob?.bestAsk?.value();

    const position = snapshot.portfolio?.getPosition(snapshot.instrumentId);
    // Пыль: если остаток < minOrderSize → SELL невозможен, считаем за ноль.
    // Без этого стратегия зависает: positionQty > 0 (не может BUY),
    // но < minOrderSize (не может SELL) → бесконечный HOLD.
    // Fallback 0.01 — минимальная точность SELL на Polymarket (2 знака после запятой).
    const rawQty = position?.quantity.value() ?? new Decimal(0);
    const minSize = snapshot.constraints?.minOrderSize.value();
    const dustThreshold = minSize ?? new Decimal('0.01');
    const isDust = rawQty.gt(0) && rawQty.lt(dustThreshold);
    const positionQty = isDust ? new Decimal(0) : rawQty;

    if (isDust) {
      this._logger?.debug('DumbStrategy: dust position detected, treating as zero', {
        rawQty: rawQty.toFixed(4),
        dustThreshold: dustThreshold.toFixed(2),
      });
    }
    const entryPrice = position ? position.averageEntryPrice.value() : undefined;
    const availableBalance = snapshot.portfolio?.balance.available().value() ?? new Decimal(0);

    const openBuyOrders: OpenBuyOrder[] = snapshot.openOrders
      .filter((o) => o.side === 'BUY')
      .map((o) => ({ orderId: o.id, orderPrice: o.price.value() }));

    const hasOpenSellOrders = snapshot.openOrders.some((o) => o.side === 'SELL');

    // Instrument-level: ловит in-flight fills даже для cancelled/deleted ордеров.
    // matchedOrders.length > 0 не работает: cancelled ордер удалён из repo.
    const hasMatchedOrders = snapshot.hasInFlightFills || snapshot.matchedOrders.length > 0;

    return {
      refPrice,
      positionQty,
      entryPrice,
      availableBalance,
      openBuyOrders,
      hasOpenSellOrders,
      hasMatchedOrders,
      minOrderSize: snapshot.constraints?.minOrderSize.value(),
      minOrderValue: snapshot.constraints?.minOrderValue.value(),
      tickSize: snapshot.constraints?.tickSize.value(),
    };
  }

  /**
   * Логика принятия решений.
   *
   * @param data - Данные из gather
   * @param _reasons - Причины пересчёта (не используются)
   * @returns Массив действий
   *
   * @remarks
   * Строгий режим «купил → продай → потом покупай»:
   * - positionQty=0 и нет BUY-ордера → ENTER BUY
   * - positionQty=0 и есть BUY-ордер + drift > threshold → REPRICE (CANCEL; следующий тик сделает ENTER)
   * - positionQty=0 и есть BUY-ордер + drift ≤ threshold → HOLD (ждём исполнения)
   * - positionQty>0 и нет SELL-ордера → EXIT SELL (или CANCEL BUY если нужно)
   * - positionQty>0 и есть SELL-ордер → HOLD
   */
  protected decide(data: DumbData, _reasons: ReadonlySet<TriggerReason>): DumbAction[] {
    // Диагностика: полный snapshot данных на каждый тик (INFO для видимости в логах).
    this._logger?.debug('DumbStrategy tick', {
      positionQty: data.positionQty.toFixed(4),
      entryPrice: data.entryPrice?.toFixed(4) ?? 'none',
      refPrice: data.refPrice?.toFixed(4) ?? 'none',
      hasMatchedOrders: data.hasMatchedOrders,
      openBuyOrders: data.openBuyOrders.length,
      hasOpenSellOrders: data.hasOpenSellOrders,
      availableBalance: data.availableBalance.toFixed(4),
      reasons: [..._reasons].join(','),
    });

    // ── In-flight fills → HOLD ──────────────────────────────────────────────
    // MATCHED ордера = fills в пути (on-chain). Ждём CONFIRMED.
    // Без этой проверки стратегия ставит новый BUY каждый тик пока fills идут.
    if (data.hasMatchedOrders) {
      this._logger?.info('DumbStrategy: HOLD — matched orders in-flight, waiting for CONFIRMED');
      return [];
    }

    // ── Нет позиции ─────────────────────────────────────────────────────────
    if (data.positionQty.isZero()) {
      if (data.refPrice === undefined) {
        this._logger?.info('DumbStrategy: skip — no refPrice (no book/tape data yet)');
        return [];
      }

      const ONE_HUNDRED = new Decimal(100);

      // Есть открытый BUY-ордер — проверяем нужен ли REPRICE
      if (data.openBuyOrders.length > 0) {
        const targetPrice = quantizePriceToTick(
          data.refPrice.mul(new Decimal(1).minus(this._config.buyOffsetPct.div(ONE_HUNDRED))),
          data.tickSize,
          Decimal.ROUND_DOWN,
        );
        const openOrder = data.openBuyOrders[0]!;

        // REPRICE только когда рынок ушёл ВВЕРХ (targetPrice > orderPrice):
        // ордер завис далеко ниже рынка и может не исполниться.
        // Когда рынок идёт ВНИЗ — ордер приближается к рынку, держим HOLD.
        if (!this._config.repriceThreshold.isZero() && targetPrice.gt(openOrder.orderPrice)) {
          const drift = targetPrice.minus(openOrder.orderPrice);

          if (drift.gte(this._config.repriceThreshold)) {
            this._logger?.info('DumbStrategy: REPRICE — market moved up, chasing', {
              refPrice: data.refPrice.toFixed(4),
              orderPrice: openOrder.orderPrice.toFixed(4),
              targetPrice: targetPrice.toFixed(4),
              drift: drift.toFixed(4),
              threshold: this._config.repriceThreshold.toFixed(4),
            });
            return data.openBuyOrders.map((o) => ({ type: 'CANCEL' as const, orderId: o.orderId }));
          }
        }

        this._logger?.debug('DumbStrategy: HOLD — waiting for BUY fill', {
          refPrice: data.refPrice.toFixed(4),
          orderPrice: openOrder.orderPrice.toFixed(4),
        });
        return [];
      }

      // Целевая цена покупки: на buyOffsetPct% ниже refPrice
      // При buyOffsetPct=0 → BUY по refPrice (taker, мгновенный fill)
      // ExecutionEngine отклоняет цены, не кратные tickSize (reject-only,
      // без молчаливого округления) — стратегия сама квантует цену:
      // BUY округляется ВНИЗ (консервативно — не переплачиваем).
      const targetBuyPrice = quantizePriceToTick(
        data.refPrice.mul(new Decimal(1).minus(this._config.buyOffsetPct.div(ONE_HUNDRED))),
        data.tickSize,
        Decimal.ROUND_DOWN,
      );
      if (targetBuyPrice.lte(0)) {
        this._logger?.debug('DumbStrategy: skip — targetBuyPrice <= 0', {
          refPrice: data.refPrice.toFixed(4),
          buyOffsetPct: this._config.buyOffsetPct.toFixed(2),
          targetBuyPrice: targetBuyPrice.toFixed(4),
        });
        return [];
      }

      // Размер BUY: minOrderSize + запас на fee deduction (3%).
      // После BUY комиссия вычитается из токенов (fee ≈ 1.5% при p=0.50).
      // Без буфера: BUY 5 → fee 0.08 → 4.92 < minOrderSize → SELL невозможен.
      // С буфером 3%: BUY 5.15 → fee 0.08 → 5.07 ≥ minOrderSize → SELL OK.
      const FEE_BUFFER = new Decimal('1.03');
      const minSizeWithBuffer = data.minOrderSize !== undefined
        ? data.minOrderSize.mul(FEE_BUFFER).toDecimalPlaces(2, Decimal.ROUND_UP)
        : this._config.orderSize;
      const effectiveSize = Decimal.max(this._config.orderSize, minSizeWithBuffer);

      // Нет ордеров → проверяем баланс и ставим новый
      const cost = targetBuyPrice.mul(effectiveSize);

      if (data.availableBalance.lt(cost)) {
        this._logger?.debug('DumbStrategy: skip — insufficient balance', {
          need: cost.toFixed(4),
          available: data.availableBalance.toFixed(4),
        });
        return [];
      }

      this._logger?.debug('DumbStrategy: ENTER BUY', {
        refPrice: data.refPrice.toFixed(4),
        targetBuyPrice: targetBuyPrice.toFixed(4),
        size: effectiveSize.toFixed(2),
        adjustedFromConfig: !effectiveSize.eq(this._config.orderSize),
      });

      return [{
        type: 'ENTER',
        price: targetBuyPrice,
        size: effectiveSize,
      }];
    }

    // ── Есть позиция ─────────────────────────────────────────────────────────
    // Ждём если SELL уже выставлен
    if (data.hasOpenSellOrders) {
      this._logger?.debug('DumbStrategy: HOLD — waiting for SELL fill', {
        positionQty: data.positionQty.toFixed(2),
      });
      return [];
    }

    // Если есть активные BUY-ордера (частично исполненные) — отменяем их перед SELL
    if (data.openBuyOrders.length > 0) {
      this._logger?.debug('DumbStrategy: CANCEL stale BUY orders before SELL', {
        count: data.openBuyOrders.length,
      });
      return data.openBuyOrders.map((o) => ({ type: 'CANCEL' as const, orderId: o.orderId }));
    }

    // Нет SELL → выставляем с наценкой
    if (data.entryPrice === undefined) {
      this._logger?.debug('DumbStrategy: skip SELL — no entryPrice');
      return [];
    }

    // SELL округляется ВВЕРХ к tickSize (не продаём дешевле целевой цены).
    const sellPrice = quantizePriceToTick(
      data.entryPrice.mul(new Decimal(1).plus(this._config.profitMarginPct.div(new Decimal(100)))),
      data.tickSize,
      Decimal.ROUND_UP,
    );

    // Не продаём если цена вне допустимого диапазона
    if (sellPrice.gt('0.99')) {
      this._logger?.info('DumbStrategy: skip SELL — sellPrice > 0.99', {
        sellPrice: sellPrice.toFixed(4),
        entryPrice: data.entryPrice.toFixed(4),
        profitMarginPct: this._config.profitMarginPct.toFixed(2),
      });
      return [];
    }

    // DumbStrategy продаёт всю позицию целиком.
    // orderSize ограничивает только BUY (размер входа).
    // SELL всегда = positionQty — нет смысла дробить на части.
    const effectiveSellSize = data.positionQty;

    this._logger?.info('DumbStrategy: EXIT SELL', {
      entryPrice: data.entryPrice.toFixed(4),
      sellPrice: sellPrice.toFixed(4),
      size: effectiveSellSize.toFixed(2),
      minOrderSize: data.minOrderSize?.toFixed(2) ?? 'none',
    });

    return [{
      type: 'EXIT',
      price: sellPrice,
      size: effectiveSellSize,
    }];
  }

  /**
   * Преобразует доменные действия в StrategyIntent[].
   *
   * @param actions - Массив DumbAction из decide()
   * @returns Массив StrategyIntent для ExecutionEngine
   */
  protected toIntents(actions: DumbAction[]): StrategyIntent[] {
    const intents: StrategyIntent[] = [];

    for (const action of actions) {
      switch (action.type) {
        case 'ENTER':
          intents.push({
            type: 'PLACE',
            side: 'BUY',
            price: OutcomePrice.of(action.price),
            size: Quantity.of(action.size),
          });
          break;

        case 'EXIT':
          intents.push({
            type: 'PLACE',
            side: 'SELL',
            price: OutcomePrice.of(action.price),
            size: Quantity.of(action.size),
          });
          break;

        case 'CANCEL':
          intents.push({ type: 'CANCEL', orderId: action.orderId });
          break;
      }
    }

    return intents;
  }
}

/**
 * Квантует цену к сетке tickSize.
 *
 * @param price - Сырая цена (Decimal)
 * @param tickSize - Шаг цены из constraints (undefined — цена не меняется)
 * @param rounding - Направление округления (ROUND_DOWN для BUY, ROUND_UP для SELL)
 * @returns Цена, кратная tickSize
 */
function quantizePriceToTick(
  price: Decimal,
  tickSize: Decimal | undefined,
  rounding: Decimal.Rounding,
): Decimal {
  if (tickSize === undefined || tickSize.lte(0)) return price;
  return price.div(tickSize).toDecimalPlaces(0, rounding).mul(tickSize);
}
