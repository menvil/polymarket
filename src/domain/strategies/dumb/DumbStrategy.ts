/**
 * DumbStrategy - минимально тупая, но полная стратегия
 *
 * @remarks
 * КРИТИЧНО v4: БЕЗ logger! Fully event-sourced! Deterministic! Честные типы!
 *
 * Изменения v4 (по сравнению с v3):
 * - onExecutionEvent принимает StrategyEvent (ExecutionEvent | LifecycleEvent)
 * - LifecycleEvent обрабатывается отдельно
 * - Честные типы: ExecutionEvent ≠ LifecycleEvent
 *
 * Изменения v3 (по сравнению с v2):
 * - onStart() НЕ генерирует intents (возвращает [])
 * - Первый intent через StrategyStarted event
 * - State = fully event-sourced (DumbStrategyStateData, NO отдельных полей)
 * - emitTelemetry(ctx, ...) использует ctx.now() (deterministic)
 * - FSM violation → throw (NO try-catch)
 *
 * Behaviour v4:
 * 1. onStart() → [] (NO intents!)
 * 2. Runner публикует LifecycleEvent: StrategyStarted
 * 3. onExecutionEvent(StrategyStarted: LifecycleEvent) → state.lastSide установлен → PlaceOrderIntent
 * 4. onExecutionEvent(OrderAccepted: ExecutionEvent) → state = QUOTING
 * 5. onExecutionEvent(OrderFilled: ExecutionEvent) → state = FILLED → reverse intent
 * 6. onExecutionEvent(OrderAccepted: ExecutionEvent) → state = QUOTING (reverse order)
 *
 * @example
 * ```typescript
 * const config: DumbStrategyConfig = {
 *   id: 'dumb-1',
 *   tokenId: '21742633143463906290569050155826241533067272736897614950488156847949938836455',
 *   initialSide: 'buy',
 *   buyPrice: 0.52,
 *   sellPrice: 0.53,
 *   size: 100,
 * };
 *
 * const telemetrySink = new NoopTelemetrySink();
 * const strategy = new DumbStrategy(config, telemetrySink);
 *
 * // v4: onStart() NO intents
 * const intents1 = strategy.onStart(ctx);
 * // → [] (NO intents!)
 * // state = { tag: 'IDLE' }
 *
 * // Runner публикует LifecycleEvent: StrategyStarted
 * const intents2 = strategy.onExecutionEvent({
 *   type: 'StrategyStarted',
 *   strategyId: 'dumb-1',
 *   timestamp: new Date()
 * }, ctx);
 * // → [PlaceOrderIntent] (первый intent через событие!)
 * // state = { tag: 'IDLE', lastSide: 'buy' } (fully event-sourced)
 *
 * // ExecutionEvent: OrderAccepted
 * const intents3 = strategy.onExecutionEvent({
 *   type: 'OrderAccepted',
 *   orderId: '123',
 *   side: 'BUY',
 *   marketId: '0xabc',
 *   price: 0.52,
 *   size: 100,
 *   timestamp: new Date()
 * }, ctx);
 * // → []
 * // state = { tag: 'QUOTING', currentOrderId: '123', lastSide: 'buy' }
 *
 * // ExecutionEvent: OrderFilled
 * const intents4 = strategy.onExecutionEvent({
 *   type: 'OrderFilled',
 *   orderId: '123',
 *   filledSize: 100,
 *   timestamp: new Date()
 * }, ctx);
 * // → [PlaceOrderIntent] (reverse)
 * // state = { tag: 'FILLED', lastSide: 'sell' }
 * ```
 */

import type { IStrategy } from '../IStrategy.js';
import type { StrategyContext } from '../StrategyContext.js';
import type { StrategyIntent } from '../StrategyIntent.js';
import type { StrategyEvent } from '../../events/StrategyEvent.js';
import { isExecutionEvent, isLifecycleEvent } from '../../events/StrategyEvent.js';
import type { ITelemetrySink } from '../../telemetry/ITelemetrySink.js';
import type { DumbStrategyConfig } from './DumbStrategyConfig.js';
import type { DumbStrategyStateData } from './DumbStrategyState.js';
import { reduce, createInitialState } from './DumbStrategyFSM.js';

/**
 * DumbStrategy - минимально тупая, но полная стратегия
 *
 * @remarks
 * КРИТИЧНО v4:
 * - БЕЗ logger (только telemetry sink)
 * - State = fully event-sourced (DumbStrategyStateData)
 * - NO отдельных полей (currentOrderId, lastSide внутри state)
 * - onStart() возвращает [] (NO intents!)
 * - Первый intent через LifecycleEvent: StrategyStarted
 * - emitTelemetry(ctx, ...) использует ctx.now() → clock (deterministic)
 * - FSM violation → throw (NO try-catch)
 * - onExecutionEvent принимает StrategyEvent (ExecutionEvent | LifecycleEvent)
 *
 * v4 архитектурные гарантии:
 * ❌ NO logger
 * ❌ NO console.log
 * ❌ NO new Date() (только ctx.now() → clock)
 * ❌ NO internal state changes (только через StrategyEvent)
 * ❌ NO try-catch FSM violations (throws)
 * ❌ NO pre-FSM фазы (onStart не действует)
 * ✅ State = fully event-sourced
 * ✅ Telemetry = паразит (deterministic)
 * ✅ FSM = pure reactor на StrategyEvent
 *
 * @example
 * ```typescript
 * // Create strategy:
 * const config: DumbStrategyConfig = { ... };
 * const telemetrySink = new NoopTelemetrySink();
 * const strategy = new DumbStrategy(config, telemetrySink);
 *
 * // Lifecycle:
 * strategy.onStart(ctx); // → []
 * strategy.onExecutionEvent(StrategyStartedEvent, ctx); // → [PlaceOrderIntent]
 * strategy.onExecutionEvent(OrderAcceptedEvent, ctx); // → []
 * strategy.onExecutionEvent(OrderFilledEvent, ctx); // → [PlaceOrderIntent]
 * strategy.onStop(); // cleanup
 * ```
 */
export class DumbStrategy implements IStrategy {
  /**
   * КРИТИЧНО v3: State = fully event-sourced
   * NO отдельных полей (currentOrderId, lastSide - всё внутри state)
   */
  private state: DumbStrategyStateData = createInitialState();

  // ⚠️ v5.1: lastOrderPrice удалён - виртуальные fills отключены в LIVE mode
  // См. комментарий в onExecutionEvent() → StrategyTick handler

  /**
   * v5.2: Set для отслеживания orderIds, для которых уже отправлен virtual fill
   * Предотвращает дублирование fills между тиками (до прихода OrderFilled события)
   */
  private pendingVirtualFills = new Set<string>();

  /**
   * v7.7.16: Snapshot состояния ПЕРЕД размещением ордера
   *
   * @remarks
   * КРИТИЧНО: Strategy САМОСТОЯТЕЛЬНО отслеживает изменения!
   *
   * Алгоритм:
   * 1. Перед PlaceOrder → сохраняем snapshot (orderIds, fillIds, inventory)
   * 2. На каждом StrategyTick → сравниваем текущее состояние со snapshot
   * 3. Если что-то изменилось → ордер подтверждён или исполнен
   * 4. Если за 30 секунд ничего не изменилось → timeout (ордер failed)
   *
   * Обнаружение изменений:
   * - Новые ордера: newOrderIds = current.orderIds \ snapshot.orderIds
   * - Новые fills: newFillIds = current.fillIds \ snapshot.fillIds
   * - Inventory change: current.inventory !== snapshot.inventory
   *
   * Сценарии:
   * - hasNewOrders → ордер подтверждён биржей (appeared in book)
   * - inventoryChanged && hasNewFills → fill произошёл!
   * - inventoryChanged && hasNewFills && !hasNewOrders → TAKER fill (мгновенно)
   * - timeout && !hasChanges → ордер failed (не размещён)
   */
  private pendingOrderSnapshot: {
    orderIds: string[];
    fillIds: string[];
    inventory: number;
    timestamp: number;
  } | null = null;

  /**
   * Флаг что ордер появился в списке ордеров с биржи
   */
  private orderConfirmed: boolean = false;

  private readonly PENDING_TIMEOUT_MS = 30000; // 30 секунд

  /**
   * КРИТИЧНО v4: NO logger parameter!
   * Только telemetry sink.
   *
   * @param config - Strategy configuration
   * @param telemetrySink - Telemetry sink (паразит, НЕ субъект)
   */
  constructor(
    private readonly config: DumbStrategyConfig,
    private readonly telemetrySink: ITelemetrySink
  ) {}

  get id(): string {
    return this.config.id;
  }

  /**
   * v7.4 DEPRECATION NOTE:
   *
   * The old `getInventoryFromState()` method was REMOVED in v7.4!
   *
   * **Why it was BUGGY**:
   * - Only tracked `lastFillSize` (ONE fill), not cumulative inventory
   * - After 3 BUY fills of 5 shares each, it returned 5 instead of 15
   * - This caused Strategy to keep generating BUY orders instead of SELL orders
   *
   * **Solution v7.4**:
   * Use `ctx.getInventory(tokenId)` which queries REAL cumulative inventory
   * from PortfolioProjector!
   *
   * @example
   * ```typescript
   * // ✅ CORRECT (v7.4+):
   * const inventory = ctx.getInventory(this.config.tokenId);
   * // After fills: 5+5+5 → returns 15 (CORRECT!)
   * ```
   */

  /**
   * Lifecycle: Start
   *
   * @param ctx - Strategy context
   * @returns Empty array (NO intents! v3)
   *
   * @remarks
   * КРИТИЧНО v3: onStart() НЕ генерирует intents!
   * Только инициализация (если нужно).
   * Первый intent появляется через LifecycleEvent: StrategyStarted.
   *
   * v4: State остаётся { tag: 'IDLE' } (NO изменений).
   */
  onStart(_ctx: StrategyContext): StrategyIntent[] {
    // v3: NO intents! Только инициализация
    // State остаётся { tag: 'IDLE' }
    return []; // ✅ NO intents
  }

  /**
   * Lifecycle: Tick
   *
   * @param ctx - Strategy context
   * @returns Intents (обычно пустой массив для DumbStrategy)
   *
   * @remarks
   * КРИТИЧНО v3: onTick() НЕ меняет state!
   * State меняется ТОЛЬКО через onExecutionEvent.
   *
   * DumbStrategy не делает ничего на tick.
   * Всё управление через StrategyEvent.
   */
  onTick(_ctx: StrategyContext): StrategyIntent[] {
    // DumbStrategy не делает ничего на tick
    // Всё управление через StrategyEvent
    return [];
  }

  /**
   * Lifecycle: StrategyEvent (ExecutionEvent | LifecycleEvent | StrategyTick)
   *
   * @param event - StrategyEvent (v5: ExecutionEvent | LifecycleEvent | StrategyTick)
   * @param ctx - Strategy context
   * @returns Intents
   *
   * @remarks
   * КРИТИЧНО v5: ЕДИНСТВЕННЫЙ entry point FSM!
   * Обрабатывает ВСЕ события включая тики.
   *
   * Алгоритм v4:
   * 1. FSM reducer: (state, StrategyEvent) → newState (может throw! NO catch!)
   * 2. Emit telemetry с ctx.now() → clock (deterministic)
   * 3. Generate intents based on new state
   * 4. Return intents
   *
   * v4 changes:
   * - Принимает StrategyEvent (ExecutionEvent | LifecycleEvent)
   * - LifecycleEvent обрабатывается отдельно
   * - Честные типы: ExecutionEvent ≠ LifecycleEvent
   *
   * v5 changes:
   * - Обрабатывает StrategyTick (periodic time events)
   * - DumbStrategy игнорирует тики (возвращает [])
   */
  onExecutionEvent(event: StrategyEvent, ctx: StrategyContext): StrategyIntent[] {
    // Step 1: FSM transition (может throw!)
    // КРИТИЧНО v3: NO try-catch! FSM violation → throw → Runner обработает
    const oldState = this.state;
    this.state = reduce(this.state, event, this.config); // ✅ throws on violation

    // ✅ v7.7.15: OrderFilled УДАЛЁН - стратегия работает только по StrategyTick!
    // Telemetry removed for OrderFilled events

    // Step 2: Emit telemetry (паразит, ПОСЛЕ FSM transition)
    // КРИТИЧНО v4: используем ctx.now() → clock (deterministic)
    if (oldState.tag !== this.state.tag) {
      this.emitTelemetry(ctx, {
        category: 'STATE',
        type: 'STATE_CHANGED',
        payload: {
          from: oldState.tag,
          to: this.state.tag,
        },
      });
    }

    // Step 3: React to event (generate intents)

    // ✅ v7: Handle StrategyTick - единственное место для принятия решений!
    //
    // Алгоритм:
    // 1. Получить РЕАЛЬНОЕ состояние (inventory, hasPendingOrders, orderbook)
    // 2. Проверить изменилось ли состояние с lastIntent
    // 3. Если не изменилось и нет timeout → ждем (защита от дублирования)
    // 4. Если изменилось или timeout → принимаем решение на основе РЕАЛЬНОСТИ
    if (event.type === 'StrategyTick') {
      // ✅ v7.4: Получаем РЕАЛЬНОЕ состояние с Polymarket!
      // Inventory - ОБЯЗАТЕЛЬНО берем из PortfolioProjector (cumulative!)
      const inventory = ctx.getInventory(this.config.tokenId); // ✅ v7.4: NOT getInventoryFromState()!
      const hasPendingOrders = ctx.hasPendingOrders(); // ✅ NO arguments!
      const bestBid = ctx.getBestBid(this.config.tokenId);
      const bestAsk = ctx.getBestAsk(this.config.tokenId);
      const now = ctx.now().getTime(); // ✅ Convert Date to number (ms)

      // ✅ v7.7.16: PENDING STATE CHECK - Strategy self-sufficiency!
      // КРИТИЧНО: Strategy САМА отслеживает изменения через snapshot!
      if (this.pendingOrderSnapshot !== null) {
        // Получаем текущее состояние:
        const currentOrders = ctx.getOrders();
        const currentFills = ctx.getFills();

        const currentOrderIds = currentOrders.map(o => o.id);
        const currentFillIds = currentFills.map(f => f.orderId); // orderId

        // Обнаруживаем изменения:
        const newOrderIds = currentOrderIds.filter(
          (id) => !this.pendingOrderSnapshot!.orderIds.includes(id)
        );
        const newFillIds = currentFillIds.filter(
          (id) => !this.pendingOrderSnapshot!.fillIds.includes(id)
        );

        const hasNewOrders = newOrderIds.length > 0;
        const hasNewFills = newFillIds.length > 0;
        // ✅ v7.7.16: Используем реальный inventory из PortfolioProjector
        const inventoryChanged = inventory !== this.pendingOrderSnapshot.inventory;

        // Проверяем timeout (важен ТОЛЬКО когда состояние НЕ менялось!):
        const timeout = now - this.pendingOrderSnapshot.timestamp > this.PENDING_TIMEOUT_MS;

        // ============================================================
        // СЛУЧАЙ 1: Ордер появился в списке (подтверждён биржей)
        // ============================================================
        if (hasNewOrders && !this.orderConfirmed) {
          this.orderConfirmed = true;
          this.emitTelemetry(ctx, {
            category: 'DEBUG',
            type: 'ORDER_CONFIRMED',
            payload: {
              newOrderIds,
              message: 'Order confirmed by exchange (appeared in order list)',
            },
          });
          // НЕ сбрасываем snapshot - продолжаем ждать fill!
        }

        // ============================================================
        // СЛУЧАЙ 2: Inventory изменился → Fill произошёл!
        // ============================================================
        if (inventoryChanged || hasNewFills) {
          this.emitTelemetry(ctx, {
            category: 'DEBUG',
            type: 'FILL_DETECTED',
            payload: {
              inventoryBefore: this.pendingOrderSnapshot.inventory,
              inventoryAfter: inventory, // ✅ v7.7.16: Используем реальный inventory
              inventoryChanged,
              newFillIds,
              hasNewFills,
              message: hasNewOrders
                ? 'Order filled (MAKER - order was in book)'
                : 'Order filled IMMEDIATELY (TAKER - crossed spread)',
            },
          });

          // Сбрасываем PENDING:
          this.pendingOrderSnapshot = null;
          this.orderConfirmed = false;

          return []; // На следующем тике примем новое решение
        }

        // ============================================================
        // СЛУЧАЙ 3: TIMEOUT (только если состояние НЕ менялось!)
        // ============================================================
        if (timeout && !this.orderConfirmed) {
          // Timeout ДО подтверждения → ордер НЕ размещён!
          this.emitTelemetry(ctx, {
            category: 'WARNING',
            type: 'ORDER_PLACEMENT_TIMEOUT',
            payload: {
              timeSinceOrder: now - this.pendingOrderSnapshot.timestamp,
              timeoutMs: this.PENDING_TIMEOUT_MS,
              message: 'Order never appeared in exchange order list (possible API error, rejection, or network issue)',
            },
          });

          // Сбрасываем PENDING:
          this.pendingOrderSnapshot = null;
          this.orderConfirmed = false;

          return []; // На следующем тике попробуем снова
        }

        if (timeout && this.orderConfirmed) {
          // Timeout ПОСЛЕ подтверждения → ордер в книге, но долго не filled
          // Снимаем PENDING lock, передаём контроль CASE B (deviation check)
          this.emitTelemetry(ctx, {
            category: 'DEBUG',
            type: 'ORDER_CONFIRMED_NOT_FILLED',
            payload: {
              timeSinceOrder: now - this.pendingOrderSnapshot.timestamp,
              timeoutMs: this.PENDING_TIMEOUT_MS,
              message: 'Order confirmed but not filled after 30s - removing PENDING lock, allowing deviation check',
            },
          });

          // Сбрасываем PENDING:
          this.pendingOrderSnapshot = null;
          this.orderConfirmed = false;

          return []; // На следующем тике CASE B проверит deviation
        }

        // ============================================================
        // СЛУЧАЙ 4: Ждём (ничего не изменилось, timeout не прошёл)
        // ============================================================
        const waitTime = now - this.pendingOrderSnapshot.timestamp;
        const status = this.orderConfirmed ? 'waiting for fill' : 'waiting for confirmation';
        this.emitTelemetry(ctx, {
          category: 'DEBUG',
          type: 'PENDING_ORDER_WAITING',
          payload: {
            status,
            waitTime,
            timeoutMs: this.PENDING_TIMEOUT_MS,
            orderConfirmed: this.orderConfirmed,
          },
        });

        return []; // БЛОКИРУЕМ все новые решения
      }

      // ✅ Если дошли сюда, значит pendingOrderSnapshot === null
      // Можем принимать новое решение (CASE A/B/C/D)

      // Проверяем наличие orderbook данных и что цены валидные (> 0)
      // ✅ v7.7.15: КРИТИЧНО! Проверяем что bestBid/bestAsk > 0
      // Если bestBid = 0 → targetPrice = 0 → makerAmount = 0 → API ошибка!
      if (bestBid === null || bestAsk === null || bestBid === 0 || bestAsk === 0) {
        this.emitTelemetry(ctx, {
          category: 'WARNING',
          type: 'NO_ORDERBOOK_DATA',
          payload: {
            tokenId: this.config.tokenId,
            bestBid,
            bestAsk,
            reason: bestBid === 0 || bestAsk === 0 ? 'Price is zero' : 'Price is null',
          },
        });
        return []; // Нет валидных orderbook данных, ничего не делаем
      }

      // ✅ v7.7 DEBUG: Log BEFORE decision making
      this.emitTelemetry(ctx, {
        category: 'DEBUG',
        type: 'TICK_STATE_SNAPSHOT',
        payload: {
          inventory,
          hasPendingOrders,
          fsmState: this.state.tag,
          lastSide: this.state.lastSide,
          lastFillPrice: this.state.lastFillPrice,
          lastFillSize: this.state.lastFillSize,
          pendingOrder: this.pendingOrderSnapshot !== null,
          orderConfirmed: this.orderConfirmed,
          bestBid: bestBid.toFixed(4),
          bestAsk: bestAsk.toFixed(4),
        },
      });

      // CASE A: inventory < minOrderSize (exchange minimum), нет ордеров → PlaceOrder(BUY)
      // ✅ v7.7.15: CRITICAL FIX - Проверяем inventory < minOrderSize (exchange limit)!
      // После partial sell может остаться остаток (< minOrderSize), его нельзя продать.
      // Считаем такую позицию "пустой" и снова покупаем.
      const minOrderSize = ctx.getMinOrderSize(this.config.tokenId); // От биржи (обычно 1)

      // ✅ v7.7.15: КРИТИЧНО! Если есть старый ордер, сначала отменяем его!
      if (inventory < minOrderSize && hasPendingOrders && this.state.currentOrderId) {
        // ✅ v7.7.16: Создаём snapshot ПЕРЕД CANCEL
        const currentOrders = ctx.getOrders();
        const currentFills = ctx.getFills();

        this.emitTelemetry(ctx, {
          category: 'DECISION',
          type: 'CASE_A_CANCEL_OLD_ORDER_BEFORE_BUY',
          payload: {
            case: 'A',
            description: 'inventory < minOrderSize, but old order exists → cancel first',
            currentOrderId: this.state.currentOrderId.substring(0, 8) + '...',
            decision: 'CANCEL_OLD_ORDER',
            snapshot: {
              orderCount: currentOrders.length,
              fillCount: currentFills.length,
              inventory, // ✅ v7.7.16: Используем реальный inventory
            },
          },
        });

        // ✅ v7.7.16: Сохраняем snapshot
        this.pendingOrderSnapshot = {
          orderIds: currentOrders.map(o => o.id),
          fillIds: currentFills.map(f => f.orderId),
          inventory, // ✅ v7.7.16: Используем реальный inventory
          timestamp: now,
        };

        ctx.cancelOrder(this.state.currentOrderId);
        return [];
      }

      if (inventory < minOrderSize && !hasPendingOrders) {
        const targetPrice = bestBid * 0.98; // 2% ниже best bid

        // ✅ v7.7.16: Создаём snapshot ПЕРЕД PlaceOrder
        const currentOrders = ctx.getOrders();
        const currentFills = ctx.getFills();

        this.emitTelemetry(ctx, {
          category: 'DECISION',
          type: 'CASE_A_GENERATE_BUY_ORDER',
          payload: {
            case: 'A',
            description: `inventory < ${minOrderSize} (exchange min), no pending orders → generate BUY intent`,
            currentState: {
              inventory, // ✅ v7.7.16: Используем реальный inventory
              hasPendingOrders,
              fsmState: this.state.tag,
              lastSide: this.state.lastSide,
            },
            snapshot: {
              orderCount: currentOrders.length,
              fillCount: currentFills.length,
              inventory, // ✅ v7.7.16: Используем реальный inventory
            },
            orderbook: {
              bestBid: bestBid.toFixed(4),
              bestAsk: bestAsk.toFixed(4),
              spread: ((bestAsk - bestBid) / bestBid * 100).toFixed(2) + '%',
            },
            decision: {
              action: 'PLACE_BUY_ORDER',
              targetPrice: targetPrice.toFixed(4),
              pricingLogic: '2% below best bid (passive maker)',
              size: this.config.size,
            },
          },
        });

        // ✅ v7.7.16: Сохраняем snapshot
        this.pendingOrderSnapshot = {
          orderIds: currentOrders.map(o => o.id),
          fillIds: currentFills.map(f => f.orderId),
          inventory, // ✅ v7.7.16: Используем реальный inventory
          timestamp: now,
        };

        return [
          {
            type: 'PlaceOrder',
            strategyId: this.config.id,
            params: {
              tokenId: this.config.tokenId,
              side: 'buy',
              price: targetPrice,
              size: this.config.size,
            },
            reason: `BUY @ ${targetPrice.toFixed(4)} (2% below best bid ${bestBid.toFixed(4)})`,
          },
        ];
      }

      // CASE B: inventory < minOrderSize (exchange minimum), есть BUY ордер → проверить deviation (только для BUY!)
      // ✅ v7.7.15: CRITICAL FIX - Проверяем inventory < minOrderSize (exchange limit, обычно 1)!
      if (inventory < minOrderSize && hasPendingOrders && this.state.tag === 'QUOTING' && this.state.lastSide === 'buy') {
        const orderPrice = this.state.currentOrderPrice;
        if (orderPrice === undefined) {
          this.emitTelemetry(ctx, {
            category: 'WARNING',
            type: 'CASE_B_MISSING_ORDER_PRICE',
            payload: {
              case: 'B',
              description: 'inventory=0, has BUY order, but no price in state',
              currentState: {
                inventory,
                hasPendingOrders,
                fsmState: this.state.tag,
                lastSide: this.state.lastSide,
                currentOrderId: this.state.currentOrderId?.substring(0, 8) + '...',
              },
              decision: 'SKIP_DEVIATION_CHECK',
            },
          });
          return []; // Нет цены ордера в state
        }

        const midPrice = (bestBid + bestAsk) / 2;
        const deviation = Math.abs(orderPrice - midPrice) / orderPrice;

        if (deviation > 0.08) {
          // ✅ v7.7.16: Создаём snapshot ПЕРЕД CANCEL
          const currentOrders = ctx.getOrders();
          const currentFills = ctx.getFills();

          this.emitTelemetry(ctx, {
            category: 'DECISION',
            type: 'CASE_B_CANCEL_BUY_ORDER_DEVIATION',
            payload: {
              case: 'B',
              description: 'inventory=0, BUY order deviation > 8% → cancel and reposition',
              currentState: {
                inventory,
                hasPendingOrders,
                fsmState: this.state.tag,
                lastSide: this.state.lastSide,
                currentOrderId: this.state.currentOrderId?.substring(0, 8) + '...',
              },
              snapshot: {
                orderCount: currentOrders.length,
                fillCount: currentFills.length,
                inventory, // ✅ v7.7.16: Используем реальный inventory
              },
              orderbook: {
                bestBid: bestBid.toFixed(4),
                bestAsk: bestAsk.toFixed(4),
                midPrice: midPrice.toFixed(4),
              },
              deviationCheck: {
                orderPrice: orderPrice.toFixed(4),
                deviation: (deviation * 100).toFixed(2) + '%',
                threshold: '8%',
                exceeded: true,
              },
              decision: {
                action: 'CANCEL_ORDER',
                reason: 'Price deviation too large, need repositioning',
              },
            },
          });

          // ✅ v7.7.16: Сохраняем snapshot
          this.pendingOrderSnapshot = {
            orderIds: currentOrders.map(o => o.id),
            fillIds: currentFills.map(f => f.orderId),
            inventory, // ✅ v7.7.16: Используем реальный inventory
            timestamp: now,
          };

          ctx.cancelOrder(this.state.currentOrderId!);
          return [];
        } else {
          // Deviation OK, просто ждем fill
          this.emitTelemetry(ctx, {
            category: 'DECISION',
            type: 'CASE_B_BUY_ORDER_DEVIATION_OK',
            payload: {
              case: 'B',
              description: 'inventory=0, BUY order deviation < 8% → wait for fill',
              currentState: {
                inventory,
                hasPendingOrders,
                fsmState: this.state.tag,
                lastSide: this.state.lastSide,
              },
              deviationCheck: {
                orderPrice: orderPrice.toFixed(4),
                midPrice: midPrice.toFixed(4),
                deviation: (deviation * 100).toFixed(2) + '%',
                threshold: '8%',
                exceeded: false,
              },
              decision: 'WAIT_FOR_FILL',
            },
          });
        }
      }

      // CASE C: inventory >= minOrderSize (exchange minimum), нет ордеров → PlaceOrder(SELL)
      // ✅ v7.7.14: УПРОЩЕНО! Используем averageCost из PortfolioProjector (approximation FIFO)!
      // ✅ v7.7.15: CRITICAL FIX - Проверяем inventory >= minOrderSize (exchange limit, обычно 1)!
      // Если inventory < minOrderSize (например, остаток 0.01), его нельзя продать → возвращаемся к CASE A.

      // ✅ v7.7.15: КРИТИЧНО! Если есть старый ордер, сначала отменяем его!
      if (inventory >= minOrderSize && hasPendingOrders && this.state.currentOrderId) {
        // ✅ v7.7.16: Создаём snapshot ПЕРЕД CANCEL
        const currentOrders = ctx.getOrders();
        const currentFills = ctx.getFills();

        this.emitTelemetry(ctx, {
          category: 'DECISION',
          type: 'CASE_C_CANCEL_OLD_ORDER_BEFORE_SELL',
          payload: {
            case: 'C',
            description: 'inventory >= minOrderSize, but old order exists → cancel first',
            currentOrderId: this.state.currentOrderId.substring(0, 8) + '...',
            decision: 'CANCEL_OLD_ORDER',
            snapshot: {
              orderCount: currentOrders.length,
              fillCount: currentFills.length,
              inventory, // ✅ v7.7.16: Используем реальный inventory из PortfolioProjector
            },
          },
        });

        // ✅ v7.7.16: Сохраняем snapshot
        this.pendingOrderSnapshot = {
          orderIds: currentOrders.map(o => o.id),
          fillIds: currentFills.map(f => f.orderId),
          inventory, // ✅ v7.7.16: Используем реальный inventory из PortfolioProjector
          timestamp: now,
        };

        ctx.cancelOrder(this.state.currentOrderId);
        return [];
      }

      if (inventory >= minOrderSize && !hasPendingOrders) {
        // ✅ v7.7.16: Создаём snapshot ПЕРЕД PlaceOrder
        const currentOrders = ctx.getOrders();
        const currentFills = ctx.getFills();

        // ✅ Получаем averageCost из PortfolioProjector (средняя цена входа)
        const position = ctx.getPosition(this.config.tokenId);
        const averageCost = position?.averageCost || bestBid; // Fallback to bestBid if no position

        // ✅ КРИТИЧНО: Продаем ДОРОЖЕ чем купили!
        // Берем средневзвешенную цену для inventory и добавляем 4% профита.
        const targetPrice = averageCost * 1.04; // 4% profit

        // ✅ v7.7.16: КРИТИЧНО! Используем РЕАЛЬНЫЙ inventory из PortfolioProjector, НЕ из fills!
        // Fills могут быть неполными (lag, API issues), но PortfolioProjector синхронизирован с биржей каждые 4 сек.
        // Отбрасываем все после 2 знака после запятой (биржа работает с точностью до 0.01).
        const sellSize = Math.floor(inventory * 100) / 100;

        this.emitTelemetry(ctx, {
          category: 'DECISION',
          type: 'CASE_C_GENERATE_SELL_ORDER',
          payload: {
            case: 'C',
            description: `inventory >= ${minOrderSize} (exchange min), no pending orders → generate SELL intent`,
            currentState: {
              inventory, // ✅ v7.7.16: Используем реальный inventory
              inventoryTruncated: sellSize,
              hasPendingOrders,
              fsmState: this.state.tag,
              lastSide: this.state.lastSide,
            },
            snapshot: {
              orderCount: currentOrders.length,
              fillCount: currentFills.length,
              inventory, // ✅ v7.7.16: Используем реальный inventory
            },
            orderbook: {
              bestBid: bestBid.toFixed(4),
              bestAsk: bestAsk.toFixed(4),
              spread: ((bestAsk - bestBid) / bestBid * 100).toFixed(2) + '%',
            },
            position: {
              averageCost: averageCost.toFixed(4),
              inventory, // ✅ v7.7.16: Используем реальный inventory
              realizedPnL: position?.realizedPnL.toFixed(2) || '0.00',
            },
            decision: {
              action: 'PLACE_SELL_ORDER',
              targetPrice: targetPrice.toFixed(4),
              pricingLogic: '4% above averageCost (approximation FIFO)',
              size: sellSize,
              profitMargin: '4%',
              note: 'Sell ALL inventory at profitable price (truncated to 2 decimals)!',
            },
          },
        });

        // ✅ v7.7.16: Сохраняем snapshot
        this.pendingOrderSnapshot = {
          orderIds: currentOrders.map(o => o.id),
          fillIds: currentFills.map(f => f.orderId),
          inventory, // ✅ v7.7.16: Используем реальный inventory
          timestamp: now,
        };

        return [
          {
            type: 'PlaceOrder',
            strategyId: this.config.id,
            params: {
              tokenId: this.config.tokenId,
              side: 'sell',
              price: targetPrice,
              size: sellSize, // ✅ Продаем inventory с отброшенными знаками после 2-го!
            },
            reason: `SELL @ ${targetPrice.toFixed(4)} (4% profit from avg cost ${averageCost.toFixed(4)})`,
          },
        ];
      }

      // CASE D: inventory >= minOrderSize (exchange minimum), есть SELL ордер → НИЧЕГО НЕ ДЕЛАТЬ ✅
      // Просто ждем пока продастся
      // ✅ v7.7.15: CRITICAL FIX - Проверяем inventory >= minOrderSize (exchange limit, обычно 1)!
      if (inventory >= minOrderSize && hasPendingOrders) {
        this.emitTelemetry(ctx, {
          category: 'DECISION',
          type: 'CASE_D_SELL_ORDER_WAITING',
          payload: {
            case: 'D',
            description: 'inventory>0, has SELL order → wait for fill',
            currentState: {
              inventory,
              hasPendingOrders,
              fsmState: this.state.tag,
              lastSide: this.state.lastSide,
              currentOrderId: this.state.currentOrderId?.substring(0, 8) + '...',
              currentOrderPrice: this.state.currentOrderPrice?.toFixed(4),
            },
            decision: 'WAIT_FOR_FILL',
          },
        });
      }

      return [];
    }

    // v4: Handle LifecycleEvent separately
    if (isLifecycleEvent(event)) {
      switch (event.type) {
        case 'StrategyStarted':
          // ✅ v7: Не генерируем intent здесь! Только обновляем FSM state.
          // StrategyTick увидит (inventory=0, no orders) и сгенерирует BUY intent.
          return [];

        case 'StrategyStopped':
          // Strategy stopped (cleanup if needed)
          return [];

        default: {
          const _exhaustive: never = event;
          throw new Error(`Unhandled LifecycleEvent: ${JSON.stringify(_exhaustive)}`);
        }
      }
    }
    // v4: Handle ExecutionEvent separately
    else if (isExecutionEvent(event)) {
      switch (event.type) {
        case 'OrderAccepted':
          // State уже обновлён через FSM reducer
          // currentOrderId уже установлен в state
          // v6.3: Флаги удалены - используем ReconciliationService!

          // ✅ v5.5: Регистрируем активный ордер для event-driven fill detection
          ctx.registerActiveOrder({
            orderId: event.orderId,
            strategyId: this.config.id,
            tokenId: event.marketId, // OrderAccepted использует marketId
            side: event.side.toLowerCase() as 'buy' | 'sell',
            price: event.price,
            size: event.size,
            outcomeName: this.config.outcomeName, // ✅ v5.5: Имя outcome
          });

          return [];

        // ✅ v7.7.15: OrderPartiallyFilled УДАЛЁН - стратегия работает только по StrategyTick!
        // case 'OrderPartiallyFilled': return [];

        // ✅ v7.7.15: OrderFilled УДАЛЁН - стратегия работает только по StrategyTick!
        // case 'OrderFilled': ...

        case 'OrderCancelled':
          // ✅ v5.2: Очищаем orderId из pendingVirtualFills
          if (event.orderId) {
            this.pendingVirtualFills.delete(event.orderId);
          }
          // ✅ v5.5: Очищаем активный ордер
          ctx.clearActiveOrder();

          // ✅ v7.7.16: Сбрасываем PENDING state (ордер отменён!)
          if (this.pendingOrderSnapshot !== null) {
            this.emitTelemetry(ctx, {
              category: 'DEBUG',
              type: 'ORDER_CANCELLED_EVENT',
              payload: {
                orderId: event.orderId,
                message: 'OrderCancelled event received - resetting PENDING state',
              },
            });
            this.pendingOrderSnapshot = null;
            this.orderConfirmed = false;
          }

          // ✅ v6.4: НЕ вызываем ctx.untrackOrder() - main.ts subscriber уже делает это!
          // ReconciliationService.untrackOrder() вызывается в main.ts при OrderCancelled

          // ✅ v7: Не генерируем новый ордер здесь!
          // StrategyTick увидит реальное состояние и примет решение.
          if (this.state.tag === 'IDLE') {
            this.emitTelemetry(ctx, {
              category: 'DECISION',
              type: 'REPOSITIONING_COMPLETE',
              payload: {
                cancelledOrderId: event.orderId,
                newState: this.state.tag,
              },
            });
          }
          // FSM обновлен, ждем следующий StrategyTick
          return [];

        case 'OrderRejected':
          // ✅ v5.2: Очищаем orderId из pendingVirtualFills
          if (event.orderId) {
            this.pendingVirtualFills.delete(event.orderId);
          }

          // ✅ v7.7.16: Сбрасываем PENDING state (ордер rejected!)
          if (this.pendingOrderSnapshot !== null) {
            this.emitTelemetry(ctx, {
              category: 'WARNING',
              type: 'ORDER_REJECTED_EVENT',
              payload: {
                orderId: event.orderId,
                reason: event.reason,
                message: 'OrderRejected event received - resetting PENDING state',
              },
            });
            this.pendingOrderSnapshot = null;
            this.orderConfirmed = false;
          }

          // v6.3: Флаги удалены - используем ReconciliationService!
          // Strategy stopped (state.tag = STOPPED)
          return [];

        default: {
          const _exhaustive: never = event;
          throw new Error(`Unhandled ExecutionEvent: ${JSON.stringify(_exhaustive)}`);
        }
      }
    } else {
      // Не должно произойти (TypeScript гарантирует exhaustiveness)
      throw new Error(`Unknown StrategyEvent type: ${JSON.stringify(event)}`);
    }
  }

  /**
   * Lifecycle: Stop
   *
   * @remarks
   * Cleanup (если нужно).
   * DumbStrategy не требует cleanup.
   */
  onStop(): void {
    // ✅ v5.2: Очищаем pendingVirtualFills при остановке
    this.pendingVirtualFills.clear();
  }

  /**
   * Get current active order ID (if any)
   *
   * @returns Order ID or undefined if no active order
   *
   * @remarks
   * v5.2: Для отмены активных ордеров при остановке стратегии.
   */
  getCurrentOrderId(): string | undefined {
    return this.state.currentOrderId;
  }

  /**
   * Generate initial order intent (v4: через LifecycleEvent: StrategyStarted)
   *
   * @param ctx - Strategy context
   * @returns Array with single PlaceOrderIntent или [] если нет orderbook данных
   *
   * @remarks
   * v4: Вызывается при обработке LifecycleEvent: StrategyStarted.
   * v3: lastSide уже установлен в state через FSM reducer.
   *
   * v5.3: Новая логика ценообразования:
   * - BUY: 2% ниже best bid (passive maker, ждём fill от taker sells)
   * - SELL: 2% выше best ask (passive maker, ждём fill от taker buys)
   * - Если нет orderbook данных → пропускаем тик (возвращаем [])
   *
   * v7.7: Обновлённая логика ценообразования для SELL:
   * - SELL: 4% выше buy price (guaranteed 4% profit) - используем lastFillPrice * 1.04
   * - Fallback: 2% выше best ask (если lastFillPrice недоступен)
   */

  /**
   * Emit telemetry (паразит)
   *
   * @param ctx - Strategy context
   * @param event - Telemetry event (без timestamp и strategyId)
   *
   * @remarks
   * КРИТИЧНО v4: принимает ctx, использует ctx.now() → clock (deterministic)
   *
   * v4: ctx.now() → clock.now() (LiveClock | ReplayClock | PaperClock)
   * Replay = bit-for-bit те же telemetry timestamps.
   */
  private emitTelemetry(
    ctx: StrategyContext,
    event: Omit<
      { category: string; type: string; payload: unknown },
      'timestamp' | 'strategyId'
    >
  ): void {
    this.telemetrySink.emit({
      timestamp: ctx.now(), // ✅ deterministic (NO new Date())
      strategyId: this.id,
      ...event,
    } as any); // Type assertion needed due to discriminated union
  }
}
