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
 * recordFill(entry)             ← при fill через EventBus
 * recordResolution(entry)       ← при разрешении рынка
 * endSession(marketId, reason)  ← при закрытии рынка
 * close()                       ← при завершении процесса
 * ```
 *
 * ### Гарантии:
 * - `recordDecision`, `recordFill` — синхронные, fire-and-forget, не блокируют trading path
 * - `startSession`, `endSession`, `close` — асинхронные (I/O)
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
 * @param action - Действие: BUY, BUY_COMP, HOLD, SKIP
 * @param state - Полное состояние стратегии (SEData/AEData)
 * @param rejectReason - Причина отказа (если HOLD/SKIP)
 * @param rejectCounts - Счётчики фильтров
 * @param bidPrice - Цена BUY ордера (если BUY)
 * @param orderSize - Размер ордера (если BUY)
 * @param effectiveSide - Выбранное направление (up/down)
 */
export interface DecisionEntry {
  readonly marketId: string;
  readonly strategyId: string;
  readonly ts: number;
  readonly action: 'BUY' | 'BUY_COMP' | 'HOLD' | 'SKIP' | 'CANCEL';
  readonly state: Record<string, unknown>;
  readonly rejectReason?: string;
  readonly rejectCounts?: Record<string, number>;
  readonly bidPrice?: number;
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
 */
export interface OrderEntry {
  readonly marketId: string;
  readonly ts: number;
  readonly orderId: string;
  readonly side: 'BUY' | 'SELL';
  readonly price: string;
  readonly size: string;
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
 * Синхронные методы `record*` — fire-and-forget, буферизация внутри.
 * Асинхронные `startSession`, `endSession`, `close` — I/O операции.
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
