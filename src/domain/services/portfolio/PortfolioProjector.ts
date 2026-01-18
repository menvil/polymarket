/**
 * PortfolioProjector - event sourcing projector для positions
 *
 * @remarks
 * КРИТИЧНО v4.2: Полноценный projector (НЕ live observer)!
 *
 * State = fold(OrderFilled events)
 * НЕ подписывается на EventBus (вызывается вручную)
 * Каждый fill → projector.project(fill) → новый state
 *
 * Публикация в EventBus = optional (для UI live updates)
 *
 * Инварианты DumbStrategy (ОБЯЗАТЕЛЬНЫ):
 * 1. Только long (buy → sell → buy)
 * 2. Полный fill перед reverse order
 * 3. NO flip, NO interleaving
 *
 * Если стратегия нарушает инварианты → console.warn (видимо в логах)
 *
 * TODO (v5): Auto-rebuild from EventLog с snapshot'ами
 *
 * @example
 * ```typescript
 * const projector = new PortfolioProjector('strategy-1');
 *
 * // Buy 100 @ 0.52
 * projector.project({
 *   type: 'OrderFilled',
 *   orderId: 'order-1',
 *   strategyId: 'strategy-1',
 *   tokenId: 'token1',
 *   side: 'BUY',
 *   filledDelta: 100,
 *   price: 0.52,
 *   timestamp: new Date()
 * });
 *
 * const pos1 = projector.getPosition('token1');
 * // → { tokenId: 'token1', quantity: 100, averageCost: 0.52, realizedPnL: 0 }
 *
 * // Sell 100 @ 0.53
 * projector.project({
 *   type: 'OrderFilled',
 *   orderId: 'order-2',
 *   strategyId: 'strategy-1',
 *   tokenId: 'token1',
 *   side: 'SELL',
 *   filledDelta: 100,
 *   price: 0.53,
 *   timestamp: new Date()
 * });
 *
 * const pos2 = projector.getPosition('token1');
 * // → { tokenId: 'token1', quantity: 0, averageCost: 0.52, realizedPnL: 1.0 }
 * //   realized = 100 × (0.53 - 0.52) = 1.0 USDC
 * ```
 */

// ✅ v7.7.15: OrderFilled УДАЛЁН - стратегия работает только по StrategyTick!
// import type { OrderFilled } from '../../events/ExecutionEvent.js';
import type { Position } from './PnLCalculator.js';
import type { OrderDisplayData, FillRecordDisplayData } from '../../../infrastructure/ui/types.js';

/**
 * ✅ v7.7.15: FillEvent - локальный тип для описания fill данных
 * Используется для обновления portfolio без OrderFilled event
 */
export interface FillEvent {
  type: 'OrderFilled';
  orderId: string;
  strategyId?: string;
  tokenId: string;
  filledDelta: number;
  price: number;
  side: 'BUY' | 'SELL';
  timestamp: Date;
  fillReason?: 'REAL' | 'CROSSED_BOOK' | 'TRADE_THROUGH' | 'BOOK_TOUCH';
}

/**
 * ✅ v7.7.17: PortfolioSnapshot - атомарный snapshot состояния портфеля стратегии
 *
 * @remarks
 * Единая source of truth для стратегии. Содержит:
 * - Fills (история всех трейдов)
 * - Orders (текущие активные ордера)
 * - Inventory (вычислено из fills)
 * - PnL метрики
 *
 * Strategy читает snapshot чтобы получить согласованное состояние.
 */
export interface PortfolioSnapshot {
  /** ID стратегии */
  strategyId: string;
  /** ID токена (asset) */
  tokenId: string;
  /** Все fills стратегии */
  fills: FillRecordDisplayData[];
  /** Активные ордера */
  orders: OrderDisplayData[];
  /** Текущий inventory (вычислено из fills: SUM(BUY) - SUM(SELL)) */
  inventory: number;
  /** Средняя цена входа (weighted average) */
  averageCost: number;
  /** Реализованный PnL (USDC) */
  realizedPnL: number;
}

/**
 * IPortfolioProjector - интерфейс event sourcing projector
 */
export interface IPortfolioProjector {
  /**
   * Применить fill event к состоянию (pure reducer)
   *
   * @param fill - FillEvent данные (v7.7.15: локальный тип вместо OrderFilled event)
   *
   * @remarks
   * КРИТИЧНО v4.2: Это pure reducer, НЕ live observer!
   * Вызывается вручную из стратегического кода.
   *
   * Алгоритм:
   * 1. Фильтр по strategyId (если fill НЕ для этой стратегии → игнорируем)
   * 2. Получить текущую позицию (или создать новую)
   * 3. Если BUY: увеличить position, пересчитать avg cost
   * 4. Если SELL: уменьшить position, вычислить realized PnL
   * 5. Валидировать инварианты (console.warn при нарушении)
   *
   * @example
   * ```typescript
   * // Buy 100 @ 0.52
   * projector.project({
   *   type: 'OrderFilled',
   *   strategyId: 'strategy-1',
   *   tokenId: 'token1',
   *   side: 'BUY',
   *   filledDelta: 100,
   *   price: 0.52,
   *   // ...
   * });
   * ```
   */
  project(fill: FillEvent): void;

  /**
   * Получить текущие позиции (read-only)
   *
   * @returns Map<tokenId, Position>
   *
   * @remarks
   * Возвращает неизменяемую карту позиций.
   * Используется PnLCalculator для расчёта PnL.
   */
  getPositions(): ReadonlyMap<string, Position>;

  /**
   * Получить позицию по tokenId
   *
   * @param tokenId - ID токена
   * @returns Position или undefined
   *
   * @example
   * ```typescript
   * const pos = projector.getPosition('token1');
   * if (pos) {
   *   console.log('Quantity:', pos.quantity);
   *   console.log('Realized PnL:', pos.realizedPnL);
   * }
   * ```
   */
  getPosition(tokenId: string): Position | undefined;

  /**
   * v6.4: Синхронизировать позицию с реальными данными биржи
   *
   * @param tokenId - Token ID
   * @param realQuantity - Реальное количество tokens на бирже
   *
   * @remarks
   * **КРИТИЧНО**: Не гадаем что произошло - синхронизируемся с реальностью!
   *
   * Используется когда обнаружен дисбаланс:
   * - OrderRejected (insufficient balance)
   * - Periodic reconciliation
   *
   * Алгоритм:
   * 1. Получаем текущую позицию (internal state)
   * 2. Сравниваем с realQuantity (данные биржи)
   * 3. Если mismatch → корректируем internal state
   *
   * @example
   * ```typescript
   * // Internal state: quantity = 5
   * // Exchange API: balance = 0
   * projector.syncPosition(tokenId, 0);
   * // → Internal state corrected: quantity = 0
   * ```
   */
  syncPosition(tokenId: string, realQuantity: number): void;

  /**
   * ✅ v7.7.17: Зарегистрировать стратегию в projector
   *
   * @param strategyId - ID стратегии
   * @param tokenId - ID токена для этой стратегии
   *
   * @remarks
   * Создает пустой snapshot для стратегии.
   * Должен быть вызван перед использованием addFill/syncOrders.
   *
   * @example
   * ```typescript
   * projector.registerStrategy('dumb-0xabc...', 'token-123');
   * ```
   */
  registerStrategy(strategyId: string, tokenId: string): void;

  /**
   * ✅ v7.7.17: Добавить fill в portfolio стратегии
   *
   * @param strategyId - ID стратегии
   * @param fill - Fill данные
   *
   * @remarks
   * Добавляет fill в историю и пересчитывает inventory.
   * Inventory = SUM(BUY.size) - SUM(SELL.size)
   *
   * @example
   * ```typescript
   * projector.addFill('strategy-1', {
   *   orderId: '0xabc...',
   *   side: 'buy',
   *   price: 0.62,
   *   size: 5.0,
   *   timestamp: new Date(),
   * });
   * ```
   */
  addFill(strategyId: string, fill: FillRecordDisplayData): void;

  /**
   * ✅ v7.7.17: Синхронизировать активные ордера стратегии
   *
   * @param strategyId - ID стратегии
   * @param orders - Список активных ордеров с биржи
   *
   * @remarks
   * Заменяет текущий список ордеров новым (полная синхронизация).
   *
   * @example
   * ```typescript
   * projector.syncOrders('strategy-1', [
   *   { id: '0xabc...', side: 'SELL', price: 0.68, size: 5.1 }
   * ]);
   * ```
   */
  syncOrders(strategyId: string, orders: OrderDisplayData[]): void;

  /**
   * ✅ v7.7.17: Получить атомарный snapshot портфеля стратегии
   *
   * @param strategyId - ID стратегии
   * @returns Portfolio snapshot или undefined если стратегия не зарегистрирована
   *
   * @remarks
   * Возвращает консистентный snapshot:
   * - Fills (история)
   * - Orders (текущие)
   * - Inventory (вычислено из fills)
   * - PnL метрики
   *
   * Strategy использует этот snapshot для проверки изменений состояния.
   *
   * @example
   * ```typescript
   * const snapshot = projector.getSnapshot('strategy-1');
   * if (snapshot) {
   *   console.log('Inventory:', snapshot.inventory);
   *   console.log('Fills:', snapshot.fills.length);
   *   console.log('Orders:', snapshot.orders.length);
   * }
   * ```
   */
  getSnapshot(strategyId: string): PortfolioSnapshot | undefined;

  /**
   * Сброс state (для ротации рынков)
   *
   * @remarks
   * Очищает все позиции.
   * Используется когда стратегия завершается и начинается новая.
   */
  reset(): void;
}

/**
 * PortfolioProjector - event sourcing projector для positions
 *
 * @remarks
 * КРИТИЧНО v4.2: Полноценный projector (НЕ live observer)!
 *
 * State = fold(OrderFilled events)
 * НЕ подписывается на EventBus (вызывается вручную)
 *
 * Инварианты DumbStrategy (ОБЯЗАТЕЛЬНЫ):
 * 1. Только long (buy → sell → buy)
 * 2. Полный fill перед reverse order
 * 3. NO flip (sell > position)
 * 4. NO interleaving
 *
 * @example
 * ```typescript
 * const projector = new PortfolioProjector('strategy-1');
 *
 * // Обработка событий вручную (НЕ через EventBus.subscribe)
 * runner.onExecutionEvent = (event) => {
 *   if (event.type === 'OrderFilled') {
 *     projector.project(event); // ✅ Вручную!
 *   }
 * };
 * ```
 */
export class PortfolioProjector implements IPortfolioProjector {
  // ✅ v7.7.17: Legacy хранилище - оставляем для совместимости со старым API (getPosition, syncPosition)
  private positions = new Map<string, Position>();

  // ✅ v7.7.17: NEW - Единое хранилище портфелей всех стратегий (strategyId → snapshot)
  private portfolios = new Map<string, PortfolioSnapshot>();

  /**
   * ✅ v7.7.17: Конструктор без параметров - глобальный projector для ВСЕХ стратегий
   *
   * @param strategyId - (DEPRECATED) ID стратегии - оставлен для обратной совместимости, игнорируется
   *
   * @remarks
   * v7.7.17: Теперь PortfolioProjector - глобальный для всех стратегий.
   * Используйте registerStrategy() для добавления новых стратегий.
   */
  constructor(private readonly strategyId?: string) {}

  /**
   * Применить FillEvent (pure reducer)
   * ✅ v7.7.15: OrderFilled УДАЛЁН, используем локальный тип FillEvent
   *
   * @param fill - FillEvent данные
   *
   * @remarks
   * КРИТИЧНО v4.2: Это pure reducer, НЕ live observer!
   * Вызывается вручную из StrategyRunner.
   *
   * Алгоритм:
   * 1. Фильтр по strategyId
   * 2. Получить/создать позицию
   * 3. BUY: увеличить qty, пересчитать avg cost
   * 4. SELL: уменьшить qty, вычислить realized PnL
   * 5. Валидация инвариантов (console.warn)
   */
  project(fill: FillEvent): void {
    // ✅ КРИТИЧНО v4.2: Фильтр по strategyId (multi-strategy isolation)
    if (fill.strategyId !== this.strategyId) {
      // Игнорируем события других стратегий
      return;
    }

    const tokenId = fill.tokenId || 'unknown';
    const pos = this.positions.get(tokenId) || {
      tokenId,
      quantity: 0,
      averageCost: 0,
      realizedPnL: 0,
      totalCost: 0,
      totalRevenue: 0,
      totalBought: 0,
      totalSold: 0,
    };

    const fillCost = fill.filledDelta * fill.price;

    if (fill.side === 'BUY') {
      // Увеличиваем позицию
      const newQty = pos.quantity + fill.filledDelta;
      const totalCostBasis =
        pos.quantity * pos.averageCost + fillCost;
      const newAvgCost = newQty > 0 ? totalCostBasis / newQty : 0;

      // ✅ v5.5: Логируем изменение позиции с источником fill
      const netCashFlow = (pos.totalRevenue) - (pos.totalCost + fillCost);
      const fillSource = fill.fillReason
        ? (fill.fillReason === 'TRADE_THROUGH' ? '📈 TRADE' :
           fill.fillReason === 'BOOK_TOUCH' ? '📊 BOOK' :
           fill.fillReason === 'CROSSED_BOOK' ? '⚡ CROSSED' :
           '💱 REAL')
        : '❓ UNKNOWN';
      console.log(
        `\n💰 PORTFOLIO UPDATE: BUY ${fill.filledDelta} @ ${fill.price.toFixed(4)}`,
        `| ${fillSource}`,
        `| Cost: -${fillCost.toFixed(2)} USDC`,
        `| Inventory: ${pos.quantity} → ${newQty}`,
        `| Net Cash: ${netCashFlow >= 0 ? '+' : ''}${netCashFlow.toFixed(2)} USDC`
      );
      // ✅ v7.7.15: fillDetails удалён из FillEvent
      // if (fill.fillDetails) {
      //   console.log(`   Details: ${fill.fillDetails}`);
      // }

      this.positions.set(tokenId, {
        tokenId,
        quantity: newQty,
        averageCost: newAvgCost,
        realizedPnL: pos.realizedPnL, // Не меняется при buy
        totalCost: pos.totalCost + fillCost, // ✅ v5.5: Накапливаем потраченное
        totalRevenue: pos.totalRevenue, // Не меняется при buy
        totalBought: pos.totalBought + fill.filledDelta, // ✅ v5.5: Счётчик купленного
        totalSold: pos.totalSold, // Не меняется при buy
      });
    } else {
      // SELL: Уменьшаем позицию (реализуем PnL)

      // ⚠️ КРИТИЧНО: Проверка инвариантов DumbStrategy!
      if (pos.quantity === 0) {
        console.warn(
          '[PortfolioProjector] INVARIANT VIOLATION: Sell before buy (short flow)!',
          {
            tokenId,
            fill,
          }
        );
      }

      if (fill.filledDelta > pos.quantity) {
        console.warn(
          '[PortfolioProjector] INVARIANT VIOLATION: Sell > position (flip)!',
          {
            tokenId,
            position: pos.quantity,
            fillDelta: fill.filledDelta,
          }
        );
      }

      // Вычисляем realized PnL для этого fill
      const realizedPnLDelta = fill.filledDelta * (fill.price - pos.averageCost);
      const newQty = pos.quantity - fill.filledDelta;
      const newTotalRevenue = pos.totalRevenue + fillCost;
      const newRealizedPnL = pos.realizedPnL + realizedPnLDelta;

      // ✅ v5.5: Логируем изменение позиции с PnL и источником fill
      const netCashFlow = newTotalRevenue - pos.totalCost;
      const fillSource = fill.fillReason
        ? (fill.fillReason === 'TRADE_THROUGH' ? '📈 TRADE' :
           fill.fillReason === 'BOOK_TOUCH' ? '📊 BOOK' :
           fill.fillReason === 'CROSSED_BOOK' ? '⚡ CROSSED' :
           '💱 REAL')
        : '❓ UNKNOWN';
      console.log(
        `\n💰 PORTFOLIO UPDATE: SELL ${fill.filledDelta} @ ${fill.price.toFixed(4)}`,
        `| ${fillSource}`,
        `| Revenue: +${fillCost.toFixed(2)} USDC`,
        `| Inventory: ${pos.quantity} → ${newQty}`,
        `| PnL this trade: ${realizedPnLDelta >= 0 ? '+' : ''}${realizedPnLDelta.toFixed(2)} USDC`,
        `| Total PnL: ${newRealizedPnL >= 0 ? '+' : ''}${newRealizedPnL.toFixed(2)} USDC`,
        `| Net Cash: ${netCashFlow >= 0 ? '+' : ''}${netCashFlow.toFixed(2)} USDC`
      );
      // ✅ v7.7.15: fillDetails удалён из FillEvent
      // if (fill.fillDetails) {
      //   console.log(`   Details: ${fill.fillDetails}`);
      // }

      this.positions.set(tokenId, {
        tokenId,
        quantity: newQty,
        averageCost: pos.averageCost, // Сохраняем (FIFO approximation)
        realizedPnL: newRealizedPnL, // ✅ Накапливаем realized PnL
        totalCost: pos.totalCost, // Не меняется при sell
        totalRevenue: newTotalRevenue, // ✅ v5.5: Накапливаем полученное
        totalBought: pos.totalBought, // Не меняется при sell
        totalSold: pos.totalSold + fill.filledDelta, // ✅ v5.5: Счётчик проданного
      });
    }
  }

  /**
   * Получить все позиции (read-only)
   *
   * @returns ReadonlyMap<tokenId, Position>
   */
  getPositions(): ReadonlyMap<string, Position> {
    return this.positions;
  }

  /**
   * Получить позицию по tokenId
   *
   * @param tokenId - ID токена
   * @returns Position или undefined
   */
  getPosition(tokenId: string): Position | undefined {
    return this.positions.get(tokenId);
  }

  /**
   * v6.4: Синхронизировать позицию с реальными данными биржи
   *
   * @param tokenId - Token ID
   * @param realQuantity - Реальное количество tokens на бирже (из getPositions API)
   *
   * @remarks
   * **КРИТИЧНО**: НЕ гадаем что произошло - синхронизируемся с реальностью!
   *
   * Вызывается когда обнаружен дисбаланс (mismatch между internal state и биржей):
   * - OrderRejected с "insufficient balance"
   * - Periodic reconciliation обнаружил несоответствие
   *
   * Алгоритм:
   * 1. Получаем текущую позицию (internal state)
   * 2. Если mismatch с realQuantity:
   *    - Корректируем quantity
   *    - Сохраняем averageCost и realizedPnL (не перезаписываем!)
   *    - Логируем WARNING о дисбалансе
   *
   * @example
   * ```typescript
   * // Scenario: BUY 5 filled (мы думаем), но биржа говорит 0
   * // Internal: quantity = 5, avgCost = 0.58
   * // Exchange: balance = 0
   *
   * projector.syncPosition(tokenId, 0);
   *
   * // Result:
   * // Internal: quantity = 0, avgCost = 0.58 (сохранён), realizedPnL = 0
   * // WARNING logged: "Position mismatch detected"
   * ```
   */
  syncPosition(tokenId: string, realQuantity: number): void {
    const currentPosition = this.positions.get(tokenId);

    // Если нет позиции и realQuantity = 0 → всё ок
    if (!currentPosition && realQuantity === 0) {
      return;
    }

    // Если нет позиции но realQuantity > 0 → кто-то вручную купил tokens
    if (!currentPosition && realQuantity > 0) {
      console.warn('[PortfolioProjector] SYNC: Unexpected position detected (manual buy?)', {
        strategyId: this.strategyId,
        tokenId: tokenId.substring(0, 16) + '...',
        internalQuantity: 0,
        realQuantity,
      });

      // Создаём позицию с unknown cost
      this.positions.set(tokenId, {
        tokenId,
        quantity: realQuantity,
        averageCost: 0, // Unknown (не знаем по какой цене купили)
        realizedPnL: 0,
        totalCost: 0, // Unknown
        totalRevenue: 0,
        totalBought: realQuantity, // Предполагаем что купили
        totalSold: 0,
      });

      return;
    }

    // Если есть позиция - проверяем mismatch
    const internalQuantity = currentPosition?.quantity ?? 0;

    // Tolerance 0.001 (защита от float rounding)
    if (Math.abs(internalQuantity - realQuantity) < 0.001) {
      // Всё синхронизировано ✅
      return;
    }

    // ⚠️ MISMATCH обнаружен!
    console.warn('[PortfolioProjector] SYNC: Position mismatch detected!', {
      strategyId: this.strategyId,
      tokenId: tokenId.substring(0, 16) + '...',
      internalQuantity,
      realQuantity,
      diff: realQuantity - internalQuantity,
    });

    if (currentPosition) {
      // Корректируем quantity, сохраняем averageCost и realizedPnL
      currentPosition.quantity = realQuantity;

      console.warn('[PortfolioProjector] SYNC: Position corrected', {
        strategyId: this.strategyId,
        tokenId: tokenId.substring(0, 16) + '...',
        newQuantity: realQuantity,
        averageCost: currentPosition.averageCost.toFixed(4),
        realizedPnL: currentPosition.realizedPnL.toFixed(2),
      });
    } else {
      // Нет внутренней позиции, но есть реальная → создаём
      this.positions.set(tokenId, {
        tokenId,
        quantity: realQuantity,
        averageCost: 0, // Unknown
        realizedPnL: 0,
        totalCost: 0, // Unknown
        totalRevenue: 0,
        totalBought: realQuantity,
        totalSold: 0,
      });
    }
  }

  /**
   * ✅ v7.7.17: Зарегистрировать стратегию в projector
   */
  registerStrategy(strategyId: string, tokenId: string): void {
    if (this.portfolios.has(strategyId)) {
      console.warn(`[PortfolioProjector] Strategy ${strategyId.substring(0, 20)}... already registered`);
      return;
    }

    this.portfolios.set(strategyId, {
      strategyId,
      tokenId,
      fills: [],
      orders: [],
      inventory: 0,
      averageCost: 0,
      realizedPnL: 0,
    });
  }

  /**
   * ✅ v7.7.17: Добавить fill в portfolio стратегии (DEPRECATED - use rebuildSnapshot)
   *
   * @deprecated Use rebuildSnapshot() for atomic updates instead
   */
  addFill(_strategyId: string, _fill: FillRecordDisplayData): void {
    console.warn('[PortfolioProjector] addFill() is deprecated, use rebuildSnapshot() for atomic updates');
    // NO-OP - use rebuildSnapshot() instead
  }

  /**
   * ✅ v7.7.17: АТОМАРНО пересчитать и заменить весь snapshot стратегии
   *
   * @param strategyId - ID стратегии
   * @param fills - ВСЕ fills стратегии (от API, отфильтрованные)
   * @param orders - ВСЕ активные ордера стратегии
   *
   * @remarks
   * Batch processing подход:
   * 1. Получаем ВСЕ fills и orders
   * 2. Пересчитываем inventory из ВСЕХ fills
   * 3. АТОМАРНО заменяем весь snapshot
   *
   * Преимущества:
   * - Нет race conditions
   * - Всегда консистентное состояние
   * - Проще тестировать
   *
   * @example
   * ```typescript
   * // После reconciliation:
   * const fills = await api.getTrades()
   * const filtered = fills.filter(f => isTrackedOrder(f.orderId))
   * portfolioProjector.rebuildSnapshot(strategyId, filtered, orders)
   * ```
   */
  rebuildSnapshot(
    strategyId: string,
    fills: FillRecordDisplayData[],
    orders: OrderDisplayData[]
  ): void {
    const portfolio = this.portfolios.get(strategyId);
    if (!portfolio) {
      console.warn(`[PortfolioProjector] Strategy ${strategyId.substring(0, 20)}... not registered, call registerStrategy() first`);
      return;
    }

    // ✅ Фильтровать fills по tokenId (только этот рынок)
    const validFills = fills.filter(f => {
      if (!f.tokenId) {
        console.warn(
          `[PortfolioProjector] Fill has no tokenId, ignoring`,
          `(strategy: ${portfolio.strategyId.substring(0, 20)}...)`
        );
        return false;
      }
      if (f.tokenId !== portfolio.tokenId) {
        console.warn(
          `[PortfolioProjector] Fill tokenId mismatch, ignoring`,
          `(strategy tokenId: ${portfolio.tokenId.substring(0, 12)}..., fill tokenId: ${f.tokenId.substring(0, 12)}...)`
        );
        return false;
      }
      return true;
    });

    // ✅ КРИТИЧНО: Пересчитать inventory из ВСЕХ fills
    let inventory = 0;
    let totalBought = 0;
    let totalSold = 0;
    let costBasis = 0;

    for (const f of validFills) {
      const side = f.side?.toUpperCase() || 'BUY';
      const size = f.size || 0;
      const price = f.price || 0;

      if (side === 'BUY') {
        inventory += size;
        totalBought += size;
        costBasis += size * price;
      } else if (side === 'SELL') {
        inventory -= size;
        totalSold += size;
        const avgCost = totalBought > 0 ? costBasis / totalBought : 0;
        portfolio.realizedPnL += size * (price - avgCost);
      }
    }

    // Truncate к 2 знакам (биржа работает с точностью 0.01)
    inventory = Math.floor(inventory * 100) / 100;

    // Average cost (weighted average of all buys)
    const averageCost = totalBought > 0 ? costBasis / totalBought : 0;

    // Keep last 100 fills (prevent memory leak)
    const limitedFills = validFills.slice(-100);

    // ✅ АТОМАРНО заменить весь snapshot
    portfolio.fills = limitedFills;
    portfolio.orders = [...orders];
    portfolio.inventory = inventory;
    portfolio.averageCost = averageCost;
    // portfolio.realizedPnL уже обновлён выше

    console.log(
      `[PortfolioProjector] Snapshot rebuilt atomically`,
      `(strategy: ${strategyId.substring(0, 20)}..., fills: ${limitedFills.length}, orders: ${orders.length}, inventory: ${inventory})`
    );
  }

  /**
   * ✅ v7.7.17: Синхронизировать активные ордера стратегии
   */
  syncOrders(strategyId: string, orders: OrderDisplayData[]): void {
    const portfolio = this.portfolios.get(strategyId);
    if (!portfolio) {
      console.warn(`[PortfolioProjector] Strategy ${strategyId.substring(0, 20)}... not registered, call registerStrategy() first`);
      return;
    }

    // Полная замена списка ордеров (snapshot с биржи)
    portfolio.orders = [...orders];
  }

  /**
   * ✅ v7.7.17: Получить атомарный snapshot портфеля стратегии
   */
  getSnapshot(strategyId: string): PortfolioSnapshot | undefined {
    const portfolio = this.portfolios.get(strategyId);
    if (!portfolio) {
      return undefined;
    }

    // Возвращаем копию чтобы избежать мутаций снаружи
    return {
      strategyId: portfolio.strategyId,
      tokenId: portfolio.tokenId,
      fills: [...portfolio.fills],
      orders: [...portfolio.orders],
      inventory: portfolio.inventory,
      averageCost: portfolio.averageCost,
      realizedPnL: portfolio.realizedPnL,
    };
  }

  /**
   * Сброс state (очистка всех позиций)
   *
   * @remarks
   * Используется при ротации рынков или перезапуске стратегии.
   */
  reset(): void {
    this.positions.clear();
    this.portfolios.clear(); // ✅ v7.7.17: Очищаем оба хранилища
  }
}
