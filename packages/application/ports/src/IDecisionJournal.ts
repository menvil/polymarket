/**
 * Порт: журнал решений стратегии.
 *
 * @remarks
 * Записывает структурированные решения стратегии в отдельный NDJSON-файл
 * (не в лог рыночных данных). Каждый рынок — отдельный файл.
 *
 * ### Жизненный цикл:
 * ```
 * startSession(meta)            ← при открытии рынка
 * recordDecision(entry)         ← при каждом решении стратегии (BUY/HOLD/SKIP)
 * recordSignalEvent(entry)      ← при появлении/исчезновении/смене сигнала
 * recordCancel(entry)           ← при снятии ордера с контекстом drift
 * recordFill(entry)             ← при fill через EventBus
 * recordResolution(entry)       ← при разрешении рынка
 * endSession(marketId, reason)  ← при закрытии рынка
 * close()                       ← при завершении процесса
 * ```
 *
 * ### Гарантии:
 * - `startSession`, `recordDecision`, `recordSignalEvent`, `recordCancel`, `recordFill` —
 *   синхронные, fire-and-forget, не блокируют trading path
 * - `endSession`, `close` — асинхронные (I/O, flush на диск)
 *
 * Реализация: `DecisionJournalRecorder` в `@polymarket/data-collection`.
 *
 * @example
 * ```typescript
 * // В стратегии при BUY:
 * this._journal?.recordDecision({
 *   marketId, strategyId: this.id, ts: data.nowMs,
 *   action: 'BUY', state: { midCents: 62, deltaPct: 0.07, ... },
 *   bidPrice: 61, effectiveSide: 'up',
 * });
 * ```
 */

import type { MarketId } from '@polymarket/ids';

// ── Типы записей журнала ─────────────────────────────────────────────────────

/**
 * Метаданные сессии (записывается при открытии рынка).
 *
 * @param marketId - ID рынка
 * @param mode - Режим работы (live/paper)
 * @param strategyType - Тип стратегии
 * @param strategyConfig - Конфигурация стратегии (JSON-serializable)
 * @param marketQuestion - Вопрос рынка
 * @param instrumentId - ID инструмента
 * @param expiresAtMs - Время истечения (epoch ms)
 * @param eventStartMs - Время начала события (epoch ms)
 */
export interface SessionMeta {
  readonly marketId: string;
  readonly mode: 'live' | 'paper';
  readonly strategyType: string;
  readonly strategyConfig: Record<string, unknown>;
  readonly marketQuestion: string;
  readonly tokenIds: readonly string[];
  readonly instrumentId: string;
  readonly expiresAtMs: number;
  readonly eventStartMs?: number;
}

/**
 * Запись решения стратегии.
 *
 * @param marketId - ID рынка
 * @param strategyId - ID экземпляра стратегии
 * @param ts - Timestamp решения (epoch ms)
 * @param action - Действие: BUY, BUY_COMP, SELL, HOLD, SKIP, CANCEL
 * @param state - Полное состояние стратегии (SEData/AEData)
 * @param rejectReason - Причина отказа (если HOLD/SKIP)
 * @param rejectCounts - Счётчики фильтров
 * @param bidPrice - Цена BUY ордера (если BUY)
 * @param askPrice - Цена SELL ордера (если SELL)
 * @param orderSize - Размер ордера (если BUY/SELL)
 * @param effectiveSide - Выбранное направление (up/down)
 */
export interface DecisionEntry {
  readonly marketId: string;
  readonly strategyId: string;
  readonly ts: number;
  readonly action: 'BUY' | 'BUY_COMP' | 'SELL' | 'HOLD' | 'SKIP' | 'CANCEL';
  readonly state: Record<string, unknown>;
  readonly rejectReason?: string;
  readonly rejectCounts?: Record<string, number>;
  readonly bidPrice?: number;
  readonly askPrice?: number;
  readonly orderSize?: string;
  readonly effectiveSide?: string;
}

/**
 * Запись размещения ордера.
 *
 * @param marketId - ID рынка (tokenId для роутинга)
 * @param ts - Timestamp размещения (epoch ms)
 * @param orderId - ID ордера
 * @param side - Сторона: BUY или SELL
 * @param price - Цена ордера
 * @param size - Размер
 * @param midCentsAtPlacement - EWMA mid (¢) в момент выставления ордера
 * @param signalResidualBps - Residual сигнала (bps) в момент выставления
 * @param netExpectedEdgeCents - Ожидаемый edge (¢) в момент выставления
 */
export interface OrderEntry {
  readonly marketId: string;
  readonly ts: number;
  readonly orderId: string;
  readonly side: 'BUY' | 'SELL';
  readonly price: string;
  readonly size: string;
  /** EWMA mid (¢) в момент выставления ордера — для последующего drift-анализа */
  readonly midCentsAtPlacement?: number;
  /** Residual CEX vs Chainlink (bps) в момент выставления */
  readonly signalResidualBps?: number;
  /** Итоговый ожидаемый edge (¢) в момент выставления */
  readonly netExpectedEdgeCents?: number;
}

/**
 * Запись fill.
 *
 * @param marketId - ID рынка
 * @param ts - Timestamp fill (epoch ms)
 * @param orderId - ID ордера
 * @param side - Сторона: BUY или SELL
 * @param price - Цена исполнения
 * @param size - Размер
 * @param notional - Объём (price × size)
 * @param partial - Partial fill или full
 * @param orderPriceCents - Плановая цена ордера (¢) — для расчёта slippage
 * @param slippageCents - Разница fill vs order price (¢): положительная = улучшение цены
 */
export interface FillEntry {
  readonly marketId: string;
  readonly ts: number;
  readonly orderId: string;
  readonly side: 'BUY' | 'SELL';
  readonly price: string;
  readonly size: string;
  readonly notional: string;
  readonly partial: boolean;
  /** Плановая цена ордера (¢) — для расчёта slippage по сравнению с fill price */
  readonly orderPriceCents?: number;
  /**
   * Slippage (¢) = fillPrice*100 − orderPrice*100.
   * Для BUY: отрицательный = цена ниже плановой (хорошо), положительный = выше (плохо).
   * Для SELL: положительный = цена выше плановой (хорошо), отрицательный = ниже (плохо).
   */
  readonly slippageCents?: number;
}

/**
 * Событие жизненного цикла торгового сигнала.
 *
 * @remarks
 * Записывается при каждом переходе состояния сигнала:
 * - `SIGNAL_ON`      — сигнал появился (flat/adverse → favorable)
 * - `SIGNAL_OFF`     — сигнал пропал (favorable → flat)
 * - `SIGNAL_ADVERSE` — сигнал стал против позиции (favorable/flat → adverse с позицией)
 *
 * Позволяет offline-анализировать:
 * - Как долго сигнал держался до первого входа
 * - Был ли сигнал реальным: закрыл ли Chainlink gap к CEX (`gapClosedBps`, `gapClosedPct`)
 * - Как часто сигнал появлялся но вход блокировался
 * - Куда двинулся Chainlink за время жизни сигнала
 *
 * ### Метрики качества сигнала (только в SIGNAL_OFF / SIGNAL_ADVERSE):
 * - `gapClosedBps` = residualAtOn − residualNow: > 0 Chainlink догнал CEX (сигнал реальный)
 * - `gapClosedPct` = gapClosedBps / residualAtOn: 1.0 = gap полностью закрыт
 * - `chainlinkMoveUsd` = chainlinkNow − chainlinkAtOn: абсолютное движение Chainlink
 * - `chainlinkMoveBps` = движение Chainlink в bps (нормировано)
 *
 * @param marketId - ID рынка
 * @param ts - Timestamp события (epoch ms)
 * @param event - Тип перехода сигнала
 * @param direction - Текущее направление сигнала для токена
 * @param residualBps - Residual CEX vs Chainlink (bps) в текущий момент
 * @param signalStrength - Сила сигнала [0..10]
 * @param signalConfidence - Уверенность сигнала [0..1]
 * @param persistenceMs - Длительность сигнала в текущем направлении (ms)
 * @param midCents - EWMA mid Polymarket (¢) в момент события
 * @param chainlinkPrice - Цена Chainlink (USD) в момент события
 * @param netExpectedEdgeCents - Edge (¢) в момент события
 * @param openOrderPriceCents - Цена открытого BUY-ордера (¢), если есть
 * @param driftSinceOrderCents - mid_now − mid_at_placement (¢), если есть ордер
 * @param residualAtOn - Residual (bps) в момент SIGNAL_ON (только в OFF/ADVERSE)
 * @param chainlinkAtOn - Chainlink (USD) в момент SIGNAL_ON (только в OFF/ADVERSE)
 * @param gapClosedBps - residualAtOn − residualNow: > 0 = Chainlink догнал CEX
 * @param gapClosedPct - gapClosedBps / residualAtOn ∈ [-∞, 1]: 1.0 = gap полностью закрыт
 * @param chainlinkMoveUsd - chainlinkNow − chainlinkAtOn: движение Chainlink в USD
 * @param chainlinkMoveBps - то же в bps (нормировано на chainlinkAtOn)
 * @param durationMs - время жизни сигнала от ON до OFF (ms)
 */
export interface SignalEntry {
  readonly marketId: string;
  readonly ts: number;
  readonly event: 'SIGNAL_ON' | 'SIGNAL_OFF' | 'SIGNAL_ADVERSE';
  readonly direction: 'up' | 'down' | 'flat';
  readonly residualBps: number;
  readonly signalStrength: number;
  readonly signalConfidence: number;
  readonly persistenceMs: number;
  readonly midCents: number;
  /** Цена Chainlink (USD) в момент события — для gap-анализа */
  readonly chainlinkPrice: number;
  readonly netExpectedEdgeCents: number;
  /** Цена открытого BUY-ордера (¢) в момент события, если ордер был выставлен */
  readonly openOrderPriceCents?: number;
  /** mid_now − mid_at_placement (¢): дрейф рынка за время жизни ордера */
  readonly driftSinceOrderCents?: number;

  // ── Поля только для SIGNAL_OFF и SIGNAL_ADVERSE ───────────────────────────
  /** Residual (bps) в момент SIGNAL_ON — для расчёта закрытия gap */
  readonly residualAtOn?: number;
  /** Chainlink (USD) в момент SIGNAL_ON — для расчёта движения цены */
  readonly chainlinkAtOn?: number;
  /**
   * residualAtOn − residualNow (bps).
   * > 0 = Chainlink двинулся к CEX (сигнал реальный).
   * < 0 = Chainlink двинулся от CEX (ложный сигнал или разворот).
   */
  readonly gapClosedBps?: number;
  /**
   * gapClosedBps / residualAtOn ∈ (-∞, 1].
   * 1.0 = gap полностью закрыт, 0.5 = половина gap закрыта, < 0 = gap расширился.
   */
  readonly gapClosedPct?: number;
  /** Абсолютное движение Chainlink (USD) за время жизни сигнала */
  readonly chainlinkMoveUsd?: number;
  /** Движение Chainlink (bps) нормированное на начальную цену */
  readonly chainlinkMoveBps?: number;
  /** Время от SIGNAL_ON до SIGNAL_OFF (ms) */
  readonly durationMs?: number;
}

/**
 * Запись снятия ордера с контекстом drift.
 *
 * @remarks
 * Записывается при каждом CANCEL открытого BUY-ордера.
 * Позволяет анализировать:
 * - Куда ушёл рынок пока ордер стоял (driftCents)
 * - При каком состоянии сигнала ордер снимался
 * - Насколько цена ордера была актуальна к моменту снятия
 *
 * @param marketId - ID рынка
 * @param ts - Timestamp снятия (epoch ms)
 * @param orderId - ID снятого ордера
 * @param reason - Причина снятия (STALE_CHAINLINK, NO_ENTRY, IN_FLIGHT_FILLS, ...)
 * @param orderPriceCents - Цена ордера при выставлении (¢)
 * @param midAtPlacementCents - EWMA mid при выставлении ордера (¢)
 * @param midAtCancelCents - EWMA mid в момент снятия (¢)
 * @param driftCents - midAtCancel − midAtPlacement (¢): дрейф за время жизни ордера
 * @param signalAtCancel - Состояние сигнала в момент снятия
 * @param netEdgeAtCancel - Edge (¢) в момент снятия
 */
export interface CancelEntry {
  readonly marketId: string;
  readonly ts: number;
  readonly orderId: string;
  readonly reason: string;
  /** Цена ордера при размещении (¢) */
  readonly orderPriceCents: number;
  /** EWMA mid в момент выставления ордера (¢) */
  readonly midAtPlacementCents: number;
  /** EWMA mid в момент снятия ордера (¢) */
  readonly midAtCancelCents: number;
  /** midAtCancel − midAtPlacement (¢): дрейф рынка за время жизни ордера */
  readonly driftCents: number;
  /** Состояние сигнала в момент снятия */
  readonly signalAtCancel: 'favorable' | 'adverse' | 'flat' | 'stale';
  /** Ожидаемый edge (¢) в момент снятия */
  readonly netEdgeAtCancel: number;
}

/**
 * Запись разрешения рынка.
 *
 * @param marketId - ID рынка
 * @param ts - Timestamp разрешения (epoch ms)
 * @param resolution - Результат: UP, DOWN, UNKNOWN
 * @param pnl - PnL в USDC
 * @param entryPrice - Цена входа (если была позиция)
 * @param entrySize - Размер позиции
 * @param settlementPrice - Цена settlement (0 или 1)
 */
export interface ResolutionEntry {
  readonly marketId: string;
  readonly ts: number;
  readonly resolution: 'UP' | 'DOWN' | 'UNKNOWN';
  readonly pnl: string;
  readonly entryPrice?: string;
  readonly entrySize?: string;
  readonly settlementPrice: string;
}

// ── Порт ─────────────────────────────────────────────────────────────────────

/**
 * Порт журнала решений стратегии.
 *
 * @remarks
 * Синхронные методы `startSession`, `record*` — fire-and-forget, буферизация внутри.
 * Асинхронные `endSession`, `close` — I/O операции (flush буфера на диск).
 */
export interface IDecisionJournal {
  /**
   * Начинает сессию для рынка: создаёт файл, записывает SESSION_START.
   *
   * @param meta - Метаданные сессии
   */
  startSession(meta: SessionMeta): void;

  /**
   * Записывает решение стратегии (синхронно, fire-and-forget).
   *
   * @param entry - Данные решения
   */
  recordDecision(entry: DecisionEntry): void;

  /**
   * Записывает размещение ордера (синхронно, fire-and-forget).
   *
   * @param entry - Данные ордера
   */
  recordOrder(entry: OrderEntry): void;

  /**
   * Записывает событие жизненного цикла сигнала (синхронно, fire-and-forget).
   *
   * @param entry - Данные события сигнала
   */
  recordSignalEvent(entry: SignalEntry): void;

  /**
   * Записывает снятие ордера с контекстом drift (синхронно, fire-and-forget).
   *
   * @param entry - Данные снятия ордера
   */
  recordCancel(entry: CancelEntry): void;

  /**
   * Записывает fill (синхронно, fire-and-forget).
   *
   * @param entry - Данные fill
   */
  recordFill(entry: FillEntry): void;

  /**
   * Записывает разрешение рынка (синхронно, fire-and-forget).
   *
   * @param entry - Данные разрешения
   */
  recordResolution(entry: ResolutionEntry): void;

  /**
   * Завершает сессию для рынка: сбрасывает буфер, закрывает файл.
   *
   * @param marketId - ID рынка
   * @param reason - Причина завершения
   */
  endSession(marketId: MarketId, reason: string): Promise<void>;

  /**
   * Завершает работу: закрывает все сессии.
   */
  close(): Promise<void>;
}
