/**
 * StrategyMetricsProjector - event sourcing projector для метрик
 *
 * @remarks
 * КРИТИЧНО v4.2: Полноценный projector (НЕ live observer)!
 *
 * State = fold(StrategyEvent stream)
 * НЕ подписывается на EventBus (вызывается вручную)
 * NO Date.now(), NO new Date() - только StrategyEvent.timestamp!
 *
 * Обрабатывает события:
 * - StrategyStarted (startedAt)
 * - StrategyStopped (stoppedAt)
 * - OrderAccepted (count)
 * - OrderFilled (count, lastEventAt)
 * - OrderCancelled (lastEventAt)
 * - StrategyTick (lastEventAt)
 *
 * Все timestamps из событий → replay = идентичные метрики.
 *
 * TODO (v5): Auto-rebuild from EventLog с snapshot'ами
 *
 * @example
 * ```typescript
 * const projector = new StrategyMetricsProjector();
 *
 * // Регистрация стратегии
 * projector.registerStrategy(
 *   'strategy-1',
 *   'Will Bitcoin reach $100k?',
 *   portfolioProjector
 * );
 *
 * // Обработка событий вручную (НЕ через EventBus.subscribe)
 * projector.project({
 *   type: 'StrategyStarted',
 *   strategyId: 'strategy-1',
 *   timestamp: new Date('2024-01-01T10:00:00Z')
 * });
 *
 * projector.project({
 *   type: 'OrderAccepted',
 *   strategyId: 'strategy-1',
 *   // ...
 *   timestamp: new Date('2024-01-01T10:00:05Z')
 * });
 *
 * const metrics = projector.getAllMetrics();
 * // → [{ strategyId: 'strategy-1', startedAt: '2024-01-01T10:00:00Z', uptimeMs: 5000, ... }]
 * ```
 */

import type { StrategyEvent } from '../../domain/events/StrategyEvent.js';
import type { IPortfolioProjector } from '../../domain/services/portfolio/PortfolioProjector.js';
import type { IOrderbookProjector } from '../../domain/services/orderbook/OrderbookProjector.js';
import type { OrderDisplayData } from '../../infrastructure/ui/types.js';

/**
 * FillRecord - запись о заполненном ордере
 *
 * @remarks
 * Хранит информацию о каждом fill для отображения в UI.
 * v5.5: Добавлены fillReason и inventory tracking.
 */
export interface FillRecord {
  orderId: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  timestamp: Date;
  /** Fill reason: CROSSED_BOOK, TRADE_THROUGH, BOOK_TOUCH, or REAL */
  fillReason?: 'CROSSED_BOOK' | 'TRADE_THROUGH' | 'BOOK_TOUCH' | 'REAL';
  /** Inventory before this fill */
  inventoryBefore?: number;
  /** Inventory after this fill */
  inventoryAfter?: number;
  /** Outcome name (e.g., "Up", "Down", "Yes", "No") */
  outcomeName?: string;
  /** Token ID (asset_id) - v7.7.12 */
  tokenId?: string;
  /** Market ID (condition_id) - v7.7.12 */
  marketId?: string;
}

/**
 * StrategyMetrics - метрики одной стратегии
 *
 * @remarks
 * Все поля вычисляются из event stream.
 * NO Date.now() - только timestamps из событий!
 */
export interface StrategyMetrics {
  strategyId: string;
  marketQuestion: string;
  state: string; // FSM state: IDLE, QUOTING, FILLED (TODO: получать из telemetry)
  activeOrders: number;
  totalOrders: number;
  totalFills: number;
  realizedPnL: number; // Из PortfolioProjector
  startedAt: Date; // ✅ из StrategyStarted.timestamp
  lastEventAt: Date; // ✅ из последнего StrategyEvent.timestamp
  uptimeMs: number; // ✅ derived = lastEventAt - startedAt
  status: 'RUNNING' | 'STOPPED';

  // ✅ NEW: Информация о текущем ордере
  orderSide?: 'buy' | 'sell'; // Сторона активного ордера
  orderPrice?: number; // Цена активного ордера
  bestBid?: number; // Текущий best bid из orderbook
  bestAsk?: number; // Текущий best ask из orderbook
  tokenId?: string; // Token ID для получения orderbook данных

  // ✅ v7: Реальный inventory из PortfolioProjector (синхронизирован с биржей!)
  currentInventory: number;

  // ✅ NEW: Список заполненных ордеров
  fills: FillRecord[];

  // ✅ v7.7.15: Список активных ордеров
  orders?: OrderDisplayData[];
}

/**
 * AggregateMetrics - агрегированные метрики всех стратегий
 */
export interface AggregateMetrics {
  totalStrategies: number;
  totalRealizedPnL: number;
  totalOrders: number;
  totalFills: number;
}

/**
 * IStrategyMetricsProjector - интерфейс metrics projector
 */
export interface IStrategyMetricsProjector {
  /**
   * Зарегистрировать стратегию для отслеживания метрик
   *
   * @param strategyId - ID стратегии
   * @param marketQuestion - Вопрос рынка (для UI)
   * @param portfolioProjector - Portfolio projector (для PnL)
   * @param tokenId - Token ID для получения orderbook данных (опционально)
   * @param outcomeName - Имя outcome (e.g., "Up", "Down") (опционально)
   *
   * @remarks
   * Регистрация создаёт пустые метрики для стратегии.
   * Метрики будут наполняться через project() events.
   */
  registerStrategy(
    strategyId: string,
    marketQuestion: string,
    portfolioProjector: IPortfolioProjector,
    tokenId?: string,
    outcomeName?: string
  ): void;

  /**
   * Применить событие к метрикам (pure reducer)
   *
   * @param event - StrategyEvent
   *
   * @remarks
   * КРИТИЧНО v4.2: Это pure reducer, НЕ live observer!
   * Вызывается вручную из StrategyRunner.
   *
   * Обрабатывает:
   * - StrategyStarted → startedAt, lastEventAt, status
   * - StrategyStopped → lastEventAt, status
   * - OrderAccepted → totalOrders, activeOrders, lastEventAt
   * - OrderFilled → totalFills, activeOrders, lastEventAt
   * - OrderCancelled → activeOrders, lastEventAt
   * - StrategyTick → lastEventAt (для uptime в IDLE)
   */
  project(event: StrategyEvent): void;

  /**
   * Получить метрики всех стратегий
   *
   * @returns Array of StrategyMetrics
   *
   * @remarks
   * Вычисляет derived поля:
   * - uptimeMs = lastEventAt - startedAt
   * - realizedPnL = из PortfolioProjector
   */
  getAllMetrics(): StrategyMetrics[];

  /**
   * ✅ v7.7.16: Получить метрики конкретной стратегии
   *
   * @param strategyId - ID стратегии
   * @returns StrategyMetrics or undefined if strategy not found
   */
  getMetrics(strategyId: string): StrategyMetrics | undefined;

  /**
   * Получить агрегированные метрики
   *
   * @returns AggregateMetrics
   */
  getAggregateMetrics(): AggregateMetrics;

  /**
   * Удалить стратегию из отслеживания
   *
   * @param strategyId - ID стратегии
   */
  unregisterStrategy(strategyId: string): void;

  /**
   * ✅ v7.7.15: Добавить fill в список fills стратегии
   *
   * @param strategyId - ID стратегии
   * @param fill - Fill record
   *
   * @remarks
   * Вызывается из OrderReconciliationService после обнаружения нового fill.
   */
  addFill(strategyId: string, fill: FillRecord): void;

  /**
   * ✅ v7.7.15: Обновить список активных ордеров стратегии
   *
   * @param strategyId - ID стратегии
   * @param orders - Список активных ордеров
   *
   * @remarks
   * Вызывается из OrderReconciliationService для синхронизации активных ордеров.
   */
  setOrders(strategyId: string, orders: OrderDisplayData[]): void;
}

/**
 * StrategyMetricsProjector - event sourcing projector для метрик
 *
 * @remarks
 * КРИТИЧНО v4.2:
 * - State = fold(StrategyEvent stream)
 * - НЕ подписывается на EventBus (вызывается вручную)
 * - NO Date.now() - только timestamps из событий
 * - uptime = derived (lastEventAt - startedAt)
 *
 * @example
 * ```typescript
 * const projector = new StrategyMetricsProjector();
 *
 * // Регистрация
 * projector.registerStrategy('strategy-1', 'Market?', portfolioProjector);
 *
 * // Обработка событий вручную (НЕ через EventBus.subscribe)
 * runner.onExecutionEvent = (event) => {
 *   projector.project(event); // ✅ Вручную!
 * };
 * ```
 */
export class StrategyMetricsProjector implements IStrategyMetricsProjector {
  private metrics = new Map<
    string,
    {
      strategyId: string;
      marketQuestion: string;
      state: string;
      activeOrders: number;
      totalOrders: number;
      totalFills: number;
      startedAt?: Date; // ✅ из StrategyStarted.timestamp
      lastEventAt?: Date; // ✅ из последнего StrategyEvent.timestamp
      status: 'RUNNING' | 'STOPPED';
      // ✅ NEW: Информация о текущем ордере
      orderSide?: 'buy' | 'sell';
      orderPrice?: number;
      tokenId?: string;
      outcomeName?: string; // ✅ v5.5: Имя outcome (e.g., "Up", "Down")
      // ✅ v7.7.17: fills + orders УДАЛЕНЫ - теперь в PortfolioProjector!
    }
  >();

  private orderbookProjector?: IOrderbookProjector;
  private globalPortfolioProjector?: IPortfolioProjector; // ✅ v7.7.17: GLOBAL source of truth!

  constructor(orderbookProjector?: IOrderbookProjector, globalPortfolioProjector?: IPortfolioProjector) {
    this.orderbookProjector = orderbookProjector;
    this.globalPortfolioProjector = globalPortfolioProjector; // ✅ v7.7.17: Source of truth для fills + orders + inventory!
  }

  /**
   * Зарегистрировать стратегию
   *
   * @param strategyId - ID стратегии
   * @param marketQuestion - Вопрос рынка
   * @param portfolioProjector - DEPRECATED v7.7.17: Ignored, using global portfolioProjector
   * @param tokenId - Token ID для получения orderbook данных
   * @param outcomeName - Имя outcome (e.g., "Up", "Down")
   *
   * @remarks
   * ✅ v7.7.17: portfolioProjector parameter is IGNORED!
   * Fills + orders теперь в GLOBAL PortfolioProjector (source of truth).
   */
  registerStrategy(
    strategyId: string,
    marketQuestion: string,
    _portfolioProjector: IPortfolioProjector, // ✅ v7.7.17: DEPRECATED (kept for backward compatibility)
    tokenId?: string,
    outcomeName?: string
  ): void {
    this.metrics.set(strategyId, {
      strategyId,
      marketQuestion,
      // ✅ v7.7.17: portfolioProjector УДАЛЁН - используем global!
      state: 'IDLE',
      activeOrders: 0,
      totalOrders: 0,
      totalFills: 0,
      startedAt: undefined, // ✅ Будет установлен из StrategyStarted
      lastEventAt: undefined, // ✅ Будет обновляться из каждого события
      status: 'RUNNING',
      // ✅ NEW: Информация о текущем ордере
      orderSide: undefined,
      orderPrice: undefined,
      tokenId,
      outcomeName, // ✅ v5.5: Имя outcome
      // ✅ v7.7.17: fills + orders УДАЛЕНЫ - теперь в PortfolioProjector!
    });
  }

  /**
   * Применить событие к метрикам (pure reducer)
   *
   * @param event - StrategyEvent
   *
   * @remarks
   * КРИТИЧНО v4.2: Это pure reducer, НЕ live observer!
   * Вызывается вручную из StrategyRunner.
   */
  project(event: StrategyEvent): void {
    // Найти метрику по strategyId
    // ⚠️ КРИТИЧНО: Нужно добавить strategyId в все StrategyEvent (Фаза 4)
    // Пока используем event.strategyId (уже есть в LifecycleEvent и StrategyTick)
    const strategyId =
      'strategyId' in event ? (event as any).strategyId : undefined;
    if (!strategyId) {
      // Пропускаем события без strategyId (ExecutionEvent пока не имеет strategyId)
      return;
    }

    const m = this.metrics.get(strategyId);
    if (!m) return; // Стратегия не зарегистрирована

    // Обработать событие по типу
    switch (event.type) {
      case 'StrategyStarted':
        m.startedAt = event.timestamp; // ✅ из события!
        m.lastEventAt = event.timestamp;
        m.status = 'RUNNING';
        break;

      case 'StrategyStopped':
        m.lastEventAt = event.timestamp; // ✅ из события!
        m.status = 'STOPPED';
        break;

      case 'OrderAccepted':
        m.totalOrders++;
        m.activeOrders++;
        m.lastEventAt = event.timestamp; // ✅ из события!
        m.state = 'QUOTING'; // ✅ Обновляем FSM state
        // ✅ Сохраняем информацию о текущем ордере
        m.orderSide = event.side.toLowerCase() as 'buy' | 'sell';
        m.orderPrice = event.price;
        break;

      // ✅ v7.7.15: OrderFilled УДАЛЁН - стратегия работает только по StrategyTick!
      // case 'OrderFilled': { ... }

      case 'OrderCancelled':
        m.activeOrders = Math.max(0, m.activeOrders - 1);
        m.lastEventAt = event.timestamp; // ✅ из события!
        m.state = 'IDLE'; // ✅ Обновляем FSM state
        m.orderSide = undefined;
        m.orderPrice = undefined;
        break;

      case 'StrategyTick':
        m.lastEventAt = event.timestamp; // ✅ из события! (для uptime в IDLE)
        break;

      // TODO: STATE_CHANGED telemetry event для FSM state
    }
  }

  /**
   * Удалить стратегию
   *
   * @param strategyId - ID стратегии
   */
  unregisterStrategy(strategyId: string): void {
    this.metrics.delete(strategyId);
  }

  /**
   * ✅ v7.7.15: Добавить fill в список fills стратегии
   * ⚠️ DEPRECATED v7.7.17: NO-OP! Fills теперь в PortfolioProjector (source of truth).
   *
   * @param strategyId - ID стратегии
   * @param fill - Fill record
   *
   * @remarks
   * ✅ v7.7.17: Этот метод больше НЕ используется!
   * Fills записываются в PortfolioProjector через OrderReconciliationService.
   * MetricsProjector читает fills из PortfolioProjector.getSnapshot().
   *
   * Метод сохранён для обратной совместимости (no-op).
   */
  addFill(_strategyId: string, _fill: FillRecord): void {
    // ✅ v7.7.17: NO-OP - fills в PortfolioProjector!
    // Kept for backward compatibility, but does nothing.
  }

  /**
   * ✅ v7.7.15: Обновить список активных ордеров стратегии
   * ⚠️ DEPRECATED v7.7.17: NO-OP! Orders теперь в PortfolioProjector (source of truth).
   *
   * @param strategyId - ID стратегии
   * @param orders - Список активных ордеров
   *
   * @remarks
   * ✅ v7.7.17: Этот метод больше НЕ используется!
   * Orders записываются в PortfolioProjector через OrderReconciliationService.
   * MetricsProjector читает orders из PortfolioProjector.getSnapshot().
   *
   * Метод сохранён для обратной совместимости (no-op).
   */
  setOrders(_strategyId: string, _orders: OrderDisplayData[]): void {
    // ✅ v7.7.17: NO-OP - orders в PortfolioProjector!
    // Kept for backward compatibility, but does nothing.
  }

  /**
   * Получить метрики всех стратегий
   *
   * @returns Array of StrategyMetrics
   *
   * @remarks
   * ✅ v7.7.17: Fills, orders, inventory, PnL теперь из GLOBAL PortfolioProjector (source of truth!)
   *
   * Вычисляет derived поля:
   * - uptimeMs = lastEventAt - startedAt
   * - realizedPnL, inventory, fills, orders = из PortfolioProjector.getSnapshot()
   */
  getAllMetrics(): StrategyMetrics[] {
    return Array.from(this.metrics.values()).map((m) => {
      // ✅ uptime = derived от timestamps из событий
      const uptimeMs =
        m.startedAt && m.lastEventAt
          ? m.lastEventAt.getTime() - m.startedAt.getTime()
          : 0;

      // ✅ v7.7.17: Получить snapshot из GLOBAL PortfolioProjector (source of truth!)
      const snapshot = this.globalPortfolioProjector?.getSnapshot(m.strategyId);

      // ✅ v7.7.17: Fills, orders, inventory, PnL из snapshot!
      const fills = snapshot?.fills ?? [];
      const orders = snapshot?.orders ?? [];
      const currentInventory = snapshot?.inventory ?? 0;
      const totalRealizedPnL = snapshot?.realizedPnL ?? 0;

      // ✅ NEW: Получить best bid/ask из orderbookProjector
      let bestBid: number | undefined;
      let bestAsk: number | undefined;
      if (this.orderbookProjector && m.tokenId) {
        const bid = this.orderbookProjector.getBestBid(m.tokenId);
        const ask = this.orderbookProjector.getBestAsk(m.tokenId);
        bestBid = bid !== null ? bid : undefined;
        bestAsk = ask !== null ? ask : undefined;
      }

      return {
        strategyId: m.strategyId,
        marketQuestion: m.marketQuestion,
        state: m.state,
        activeOrders: orders.length, // ✅ v7.7.17: From snapshot!
        totalOrders: m.totalOrders,
        totalFills: fills.length, // ✅ v7.7.17: From snapshot!
        realizedPnL: totalRealizedPnL, // ✅ v7.7.17: From snapshot!
        startedAt: m.startedAt || new Date(0), // fallback (не должно случиться)
        lastEventAt: m.lastEventAt || new Date(0),
        uptimeMs, // ✅ derived, NO Date.now()!
        status: m.status,
        // ✅ NEW: Информация о текущем ордере
        orderSide: m.orderSide,
        orderPrice: m.orderPrice,
        bestBid,
        bestAsk,
        tokenId: m.tokenId,
        // ✅ v7.7.17: Реальный inventory из PortfolioProjector snapshot!
        currentInventory,
        // ✅ v7.7.17: Fills из PortfolioProjector snapshot (source of truth!)
        fills,
        // ✅ v7.7.17: Orders из PortfolioProjector snapshot (source of truth!)
        orders,
      };
    });
  }

  /**
   * ✅ v7.7.16: Получить метрики конкретной стратегии
   *
   * @param strategyId - ID стратегии
   * @returns StrategyMetrics or undefined if strategy not found
   *
   * @remarks
   * Strategy self-sufficiency! Используется для ctx.getOrders() и ctx.getFills().
   */
  getMetrics(strategyId: string): StrategyMetrics | undefined {
    // Просто найдём стратегию среди всех метрик
    const all = this.getAllMetrics();
    return all.find(m => m.strategyId === strategyId);
  }

  /**
   * Получить агрегированные метрики
   *
   * @returns AggregateMetrics
   */
  getAggregateMetrics(): AggregateMetrics {
    const all = this.getAllMetrics();

    return {
      totalStrategies: all.length,
      totalRealizedPnL: all.reduce((sum, m) => sum + m.realizedPnL, 0),
      totalOrders: all.reduce((sum, m) => sum + m.totalOrders, 0),
      totalFills: all.reduce((sum, m) => sum + m.totalFills, 0),
    };
  }
}
