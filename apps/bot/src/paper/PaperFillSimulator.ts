/**
 * PaperFillSimulator — симулятор исполнения ордеров для paper/backtest режима.
 *
 * @remarks
 * ### Механизм симуляции:
 * Подписывается на EventBus и реагирует на рыночные события теми же событиями,
 * что и реальная биржа (ProcessFillUseCase). Стратегия не знает о режиме.
 *
 * ### Два источника fills:
 *
 * **1. Book crossing (BOOK_UPDATED):**
 * ```
 * Pending BUY @ 0.48 + bestAsk = 0.47 ≤ 0.48 → full fill
 * Pending SELL @ 0.55 + bestBid = 0.56 ≥ 0.55 → full fill
 * ```
 * Не учитывает объём — всегда full fill. Используется как fallback
 * когда tape не даёт достаточно гранулярности.
 *
 * **2. Tape matching (TRADE_RECEIVED):**
 * ```
 * Pending BUY @ 0.48, trade = { price: 0.47, size: 30 }
 * → trade.price ≤ orderPrice → fill min(30, remainingSize)
 * ```
 * Учитывает объём → поддерживает partial fills.
 * Несколько tape событий накапливаются до полного исполнения.
 *
 * ### Приоритет:
 * Tape события обрабатываются независимо от book crossing.
 * Если один и тот же ордер уже закрыт tape событием — book crossing
 * пропускает его (ордер убирается из pending list при закрытии).
 *
 * ### Цена исполнения:
 * При `fillAtOrderPrice=true`: fill @ orderPrice (предсказуемо, без slippage).
 * При `fillAtOrderPrice=false`: fill @ trade.price / bestAsk / bestBid (реалистично).
 *
 * @example
 * ```typescript
 * const simulator = new PaperFillSimulator({
 *   processFillUseCase,
 *   eventBus,
 *   clock,
 *   logger,
 *   config: { fillOnBookCrossing: true, fillOnTape: true, fillAtOrderPrice: true },
 * });
 *
 * simulator.start();
 * // При placeOrder:
 * simulator.trackOrder({ orderId, instrumentId, side, price, remainingSize, accountId, asset, marketId });
 * ```
 */

import type { IEventBus } from '@polymarket/event-bus';
import type { ProcessFillUseCase } from '@polymarket/use-cases';
import type { IClock } from '@polymarket/time';
import type { ILogger } from '@polymarket/logger';
import type { IPortfolioStore } from '@polymarket/ports';
import type { AccountId, AssetId, InstrumentId, MarketId, OrderId } from '@polymarket/ids';
import { asFillId, KnownVenues } from '@polymarket/ids';
import { AssetIdHelpers } from '@polymarket/ids';
import { Fill } from '@polymarket/fill';
import { Fee, Price, Quantity } from '@polymarket/value-objects';
import { TimestampService } from '@polymarket/value-objects';
import type { Side } from '@polymarket/value-objects';
import type { PaperConfig } from '../config/BotConfig.js';
import { calculatePolymarketTakerFee } from '@polymarket/fill';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренняя Decimal-арифметика/парсинг границы после VO-типизированного публичного API, см. docs/architecture/boundary-contract.md, Решение 1
import Decimal from 'decimal.js';

// ── Типы ─────────────────────────────────────────────────────────────────────

/**
 * Описание ожидающего исполнения ордера.
 *
 * @remarks
 * Хранится в PaperFillSimulator от момента размещения до полного исполнения/отмены.
 */
export interface PendingPaperOrder {
  readonly orderId: OrderId;
  readonly instrumentId: InstrumentId;
  readonly marketId: MarketId;
  readonly side: Side;
  readonly price: Price;
  readonly totalSize: Quantity;
  /** Оставшийся объём (уменьшается при partial fills) */
  remainingSize: Decimal;
  readonly accountId: AccountId;
  readonly asset: AssetId;
  /** Accepted post-only order can only fill as maker. */
  readonly postOnly: boolean;
  readonly orderType?: 'GTC' | 'GTD' | 'FOK' | 'FAK';
  /**
   * Время размещения ордера (epoch ms от clock).
   *
   * @remarks
   * Fallback для обычных лимитных ордеров:
   * - fill на том же тике (fillTime === placedAtMs) → taker
   * - fill позже → maker
   *
   * Для принятых `postOnly` ордеров liquidity фиксируется как maker.
   */
  readonly placedAtMs: number;
}

/**
 * Зависимости PaperFillSimulator.
 */
export interface PaperFillSimulatorDeps {
  /** Use case для применения fill к портфелю и ордерам */
  readonly processFillUseCase: ProcessFillUseCase;
  /** Store портфеля для defensive-проверки SELL fills */
  readonly portfolioStore?: IPortfolioStore;
  /** EventBus для подписки на BOOK_UPDATED и TRADE_RECEIVED */
  readonly eventBus: IEventBus;
  /** Источник времени */
  readonly clock: IClock;
  /** Logger */
  readonly logger: ILogger;
  /** Конфигурация симуляции */
  readonly config: PaperConfig;
}

// ── Реализация ───────────────────────────────────────────────────────────────

export class PaperFillSimulator {
  /** Ожидающие исполнения ордера: orderId → PendingPaperOrder */
  private readonly _pending = new Map<string, PendingPaperOrder>();
  /** Последний известный top of book: instrumentId → best bid / ask */
  private readonly _topOfBook = new Map<string, { bestBid?: Decimal; bestAsk?: Decimal }>();
  /** Функции отписки от EventBus */
  private readonly _unsubscribers: Array<() => void> = [];

  constructor(private readonly _deps: PaperFillSimulatorDeps) {}

  /**
   * Начинает симуляцию: подписывается на EventBus.
   *
   * @remarks
   * Вызывать после инициализации EventBus и до регистрации первых ордеров.
   */
  public start(): void {
    const { eventBus, config } = this._deps;

    if (config.fillOnBookCrossing) {
      const unsub = eventBus.subscribe('BOOK_UPDATED', (event) => {
        void this._onBookUpdated(
          event.instrumentId,
          event.topOfBook.bestBid?.value(),
          event.topOfBook.bestAsk?.value(),
        );
      });
      this._unsubscribers.push(unsub);
    }

    if (config.fillOnTape) {
      const unsub = eventBus.subscribe('TRADE_RECEIVED', (event) => {
        void this._onTradeReceived(
          event.instrumentId,
          event.price.value(),
          event.size.value(),
        );
      });
      this._unsubscribers.push(unsub);
    }

    this._deps.logger.info('PaperFillSimulator started', {
      fillOnBookCrossing: config.fillOnBookCrossing,
      fillOnTape: config.fillOnTape,
      fillAtOrderPrice: config.fillAtOrderPrice,
    });
  }

  /**
   * Останавливает симуляцию и очищает состояние.
   */
  public stop(): void {
    for (const unsub of this._unsubscribers) unsub();
    this._unsubscribers.length = 0;
    this._pending.clear();
    this._deps.logger.info('PaperFillSimulator stopped');
  }

  /**
   * Регистрирует новый ожидающий ордер.
   *
   * @param order - Описание ордера (получается из MockExchangeClient после submitOrder)
   *
   * @remarks
   * Вызывается сразу после успешного `submitOrder()`.
   */
  public trackOrder(order: PendingPaperOrder): void {
    this._pending.set(order.orderId, {
      ...order,
      remainingSize: order.totalSize.value(),
    });
    this._deps.logger.debug('Paper order tracked', {
      orderId: order.orderId,
      side: order.side,
      price: order.price.value().toNumber(),
      size: order.totalSize.value().toNumber(),
      instrumentId: String(order.instrumentId),
    });
  }

  /**
   * Удаляет ордер из отслеживания (при отмене или ручном закрытии).
   *
   * @param orderId - ID отменяемого ордера
   */
  public removeOrder(orderId: OrderId): void {
    const existed = this._pending.delete(orderId);
    if (existed) {
      this._deps.logger.debug('Paper order removed from tracking', { orderId });
    }
  }

  /**
   * Возвращает количество ожидающих ордеров (для тестирования).
   */
  public get pendingCount(): number {
    return this._pending.size;
  }

  /**
   * Проверяет, исполнится ли post-only ордер немедленно по последнему известному стакану.
   */
  public wouldCrossImmediately(
    instrumentId: InstrumentId,
    side: Side,
    price: Price,
  ): boolean {
    const top = this._topOfBook.get(String(instrumentId));
    if (!top) return false;

    const orderPrice = price.value();
    if (side === 'BUY') {
      return top.bestAsk !== undefined && top.bestAsk.lte(orderPrice);
    }

    return top.bestBid !== undefined && top.bestBid.gte(orderPrice);
  }

  // ── Приватные обработчики событий ──────────────────────────────────────────

  /**
   * Обработчик BOOK_UPDATED.
   *
   * @remarks
   * Book crossing → full fill:
   * - BUY: если bestAsk ≤ orderPrice → fill весь remainingSize
   * - SELL: если bestBid ≥ orderPrice → fill весь remainingSize
   *
   * @param instrumentId - Инструмент, для которого обновился стакан
   * @param bestBid - Лучшая цена покупки (может быть undefined)
   * @param bestAsk - Лучшая цена продажи (может быть undefined)
   */
  private async _onBookUpdated(
    instrumentId: InstrumentId,
    bestBid: Decimal | undefined,
    bestAsk: Decimal | undefined,
  ): Promise<void> {
    this._topOfBook.set(String(instrumentId), { bestBid, bestAsk });

    for (const order of this._pending.values()) {
      if (String(order.instrumentId) !== String(instrumentId)) continue;

      const orderPrice = order.price.value();
      let fillPrice: Decimal | undefined;

      if (order.side === 'BUY' && bestAsk !== undefined && bestAsk.lte(orderPrice)) {
        // Кто-то готов продать по цене ≤ нашей лимитки → fill
        // Price improvement: на реальной бирже BUY заполняется по min(orderPrice, bestAsk)
        fillPrice = this._deps.config.fillAtOrderPrice
          ? Decimal.min(orderPrice, bestAsk)
          : bestAsk;
      } else if (order.side === 'SELL' && bestBid !== undefined && bestBid.gte(orderPrice)) {
        // Кто-то готов купить по цене ≥ нашей лимитки → fill
        // Price improvement: на реальной бирже SELL заполняется по max(orderPrice, bestBid)
        fillPrice = this._deps.config.fillAtOrderPrice
          ? Decimal.max(orderPrice, bestBid)
          : bestBid;
      }

      if (fillPrice !== undefined) {
        const nowMs = this._deps.clock.now().getTime();
        const isTaker = !order.postOnly && nowMs === order.placedAtMs;
        await this._applyFill(order, fillPrice, order.remainingSize, isTaker);
      }
    }
  }

  /**
   * Обработчик TRADE_RECEIVED.
   *
   * @remarks
   * Tape matching → partial или full fill:
   * - BUY: если trade.price ≤ orderPrice → fill min(trade.size, remainingSize)
   * - SELL: если trade.price ≥ orderPrice → fill min(trade.size, remainingSize)
   *
   * Несколько tape событий накапливаются: ордер закрывается когда remainingSize = 0.
   *
   * @param instrumentId - Инструмент, по которому прошла сделка
   * @param tradePrice - Цена сделки
   * @param tradeSize - Объём сделки
   */
  private async _onTradeReceived(
    instrumentId: InstrumentId,
    tradePrice: Decimal,
    tradeSize: Decimal,
  ): Promise<void> {
    for (const order of this._pending.values()) {
      if (String(order.instrumentId) !== String(instrumentId)) continue;

      const orderPrice = order.price.value();
      let matches = false;

      if (order.side === 'BUY' && tradePrice.lte(orderPrice)) {
        // В рынке прошла сделка по нашей цене или ниже → могли заматчиться
        matches = true;
      } else if (order.side === 'SELL' && tradePrice.gte(orderPrice)) {
        // В рынке прошла сделка по нашей цене или выше → могли заматчиться
        matches = true;
      }

      if (matches) {
        // Исполняем min(tradeSize, remainingSize) — partial fill если нужно
        const fillSize = Decimal.min(tradeSize, order.remainingSize);
        // Price improvement: BUY → min(order, trade), SELL → max(order, trade)
        const fillPrice = this._deps.config.fillAtOrderPrice
          ? (order.side === 'BUY' ? Decimal.min(orderPrice, tradePrice) : Decimal.max(orderPrice, tradePrice))
          : tradePrice;
        const nowMs = this._deps.clock.now().getTime();
        const isTaker = !order.postOnly && nowMs === order.placedAtMs;
        await this._applyFill(order, fillPrice, fillSize, isTaker);
      }
    }
  }

  /**
   * Применяет fill к ордеру через ProcessFillUseCase.
   *
   * @remarks
   * 1. Уменьшает remainingSize в pending ордере
   * 2. Если remainingSize = 0 → удаляет ордер из pending
   * 3. Создаёт Fill domain object с комиссией
   * 4. Вызывает ProcessFillUseCase.execute(fill)
   *
   * ### Комиссия Polymarket (crypto-рынки):
   * - **Taker**: `feeUSDC = round5(size × 0.072 × price × (1 - price))`
   * - **Maker**: fee = 0 (taker-only fee model)
   *
   * ProcessFillUseCase:
   * - Обновляет Order (applyFill → PARTIALLY_FILLED или FILLED)
   * - Обновляет Portfolio (debit/credit)
   * - Обновляет Ledger
   * - Публикует ORDER_EVENT → OrderEventBridge → scheduler.dirty('FILL') → tick()
   *
   * @param order - Ожидающий ордер
   * @param fillPrice - Цена исполнения
   * @param fillSize - Объём исполнения
   * @param isTaker - true если мы пересекли спред (taker), false если стояли в стакане (maker)
   */
  private async _applyFill(
    order: PendingPaperOrder,
    fillPrice: Decimal,
    fillSize: Decimal,
    isTaker: boolean,
  ): Promise<void> {
    if (!this._canApplySellFill(order, fillSize)) return;

    // Обновляем remainingSize
    order.remainingSize = order.remainingSize.minus(fillSize);
    const isFull = order.remainingSize.lte(0);

    if (isFull) {
      this._pending.delete(order.orderId);
    }

    this._deps.logger.debug('Paper fill', {
      orderId: order.orderId,
      side: order.side,
      fillPrice: fillPrice.toNumber(),
      fillSize: fillSize.toNumber(),
      remaining: order.remainingSize.toNumber(),
      full: isFull,
      liquidity: isTaker ? 'TAKER' : 'MAKER',
    });

    // Создаём Fill domain object
    const nowMs = this._deps.clock.now().getTime();
    const timestampResult = TimestampService.create(nowMs);
    if (!timestampResult.ok) {
      this._deps.logger.error('PaperFillSimulator: invalid timestamp', {
        error: String(timestampResult.error),
      });
      return;
    }

    const fillIdRaw = `paper-fill-${order.orderId}-${nowMs}`;
    const fillId = asFillId(fillIdRaw);
    if (!fillId) {
      this._deps.logger.error('PaperFillSimulator: invalid fillId', { fillIdRaw });
      return;
    }

    // Комиссия: taker платит, maker — нет (Polymarket taker-only fee model)
    const price = Price.of(fillPrice);
    const size = Quantity.of(fillSize);
    const fee = isTaker
      ? calculatePolymarketTakerFee(size, price)
      : Fee.zero(AssetIdHelpers.USDC);

    const fillResult = Fill.create({
      id: fillId,
      orderId: order.orderId,
      accountId: order.accountId,
      venueId: KnownVenues.POLYMARKET,
      marketId: order.marketId,
      tokenId: order.asset,
      settlementAssetId: AssetIdHelpers.USDC,
      price,
      size,
      side: order.side,
      timestamp: timestampResult.value,
      fee,
    });

    if (!fillResult.ok) {
      this._deps.logger.error('PaperFillSimulator: failed to create Fill', {
        error: String(fillResult.error),
        orderId: order.orderId,
      });
      return;
    }

    // Передаём в use case (обновляет Order, Portfolio, Ledger, публикует события)
    const processResult = await this._deps.processFillUseCase.execute(fillResult.value);

    if (!processResult.ok) {
      this._deps.logger.error('PaperFillSimulator: ProcessFillUseCase failed', {
        error: String(processResult.error),
        orderId: order.orderId,
      });
    }
  }

  /**
   * Проверяет, что SELL fill не продаёт больше фактической позиции.
   *
   * @remarks
   * Здесь нельзя использовать availableTokenQuantity(): при нормальном SELL-ордере
   * токены уже зарезервированы под этот же ордер, поэтому available может быть 0.
   */
  private _canApplySellFill(order: PendingPaperOrder, fillSize: Decimal): boolean {
    if (order.side !== 'SELL') return true;

    const portfolioStore = this._deps.portfolioStore;
    if (!portfolioStore) return true;

    const portfolio = portfolioStore.get(order.accountId);
    const positionQty = portfolio
      ?.getPosition(order.instrumentId)
      ?.quantity.value() ?? new Decimal(0);

    if (positionQty.gte(fillSize)) return true;

    this._deps.logger.warn('Paper SELL fill blocked: insufficient token position', {
      orderId: String(order.orderId),
      instrumentId: String(order.instrumentId),
      fillSize: fillSize.toString(),
      positionQty: positionQty.toString(),
    });
    return false;
  }
}
