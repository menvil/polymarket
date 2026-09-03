/**
 * Конфигурация одного `CexSource` (одна биржа × один тип рынка).
 *
 * @remarks
 * Несколько бирж = несколько независимых `CexSource`-инстансов на ОДНОМ
 * общем `ExternalMessageBus` (composition root). Дефолты таймингов —
 * production-значения legacy-коллектора; переопределения существуют для
 * тестов и нестандартных транспортов, менять их в production без причины
 * не нужно.
 */
import type { CexMarketType } from './CexExternalMessage.js';

/** Глубина стакана по умолчанию (уровней на сторону). */
export const DEFAULT_ORDERBOOK_DEPTH = 10;
/**
 * Плановый перезапуск CCXT Pro инстансов по умолчанию: 30 минут.
 * Освобождает накопленный внутренний стейт (WS-буферы, кэши, GC-фрагментацию) —
 * production-значение legacy-коллектора (2 часа приводили к росту RSS до 4 GB).
 */
export const DEFAULT_RESTART_INTERVAL_MS = 30 * 60 * 1000;
/** Stale-таймаут стакана по умолчанию: нет обновлений 60s → рестарт сессии. */
export const DEFAULT_ORDERBOOK_STALE_TIMEOUT_MS = 60_000;
/** Stale-таймаут сделок по умолчанию: нет обновлений 180s → рестарт сессии. */
export const DEFAULT_TRADES_STALE_TIMEOUT_MS = 180_000;
/** Пауза между REST-опросами в режиме `orderbookMethod: 'fetch'`. */
export const DEFAULT_FETCH_POLL_INTERVAL_MS = 500;
/** Таймаут закрытия CCXT-инстанса. */
export const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;
/** Начальный backoff supervised-рестарта сессии. */
export const DEFAULT_INITIAL_BACKOFF_MS = 2_000;
/** Максимальный backoff supervised-рестарта сессии. */
export const DEFAULT_MAX_BACKOFF_MS = 60_000;
/** Доля jitter планового restart-интервала (±10%). */
export const PLANNED_RESTART_JITTER_RATIO = 0.1;

/**
 * Конфигурация `CexSource`.
 *
 * @example
 * ```typescript
 * const config: CexSourceConfig = {
 *   exchangeId: 'binance',
 *   marketType: 'swap',
 *   symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT'],
 *   watchOrderbook: true,
 *   watchTrades: true,
 * };
 * ```
 */
export interface CexSourceConfig {
  /** Идентификатор биржи в ccxt.pro (напр. `binance`). */
  readonly exchangeId: string;
  /** Тип рынка (`options.defaultType` CCXT-инстанса). */
  readonly marketType: CexMarketType;
  /** Unified-символы для наблюдения (непустой список). */
  readonly symbols: readonly string[];
  /** Наблюдать стакан. */
  readonly watchOrderbook: boolean;
  /** Наблюдать поток сделок. */
  readonly watchTrades: boolean;
  /**
   * Запрошенная глубина стакана (уровней на сторону).
   * Реальная может быть скорректирована по vendor-whitelist.
   * Default: {@link DEFAULT_ORDERBOOK_DEPTH}.
   */
  readonly orderbookDepth?: number;
  /**
   * Метод получения стакана:
   * - `watch` — WebSocket (авто-выбор multiplex/per-symbol);
   * - `fetch` — REST polling.
   * Default: автоопределение по capability CCXT Pro.
   */
  readonly orderbookMethod?: 'watch' | 'fetch';
  /** Интервал планового перезапуска CCXT-инстансов (ms). Default: 30 минут. */
  readonly restartIntervalMs?: number;
  /** Stale-таймаут стакана (ms). Default: 60s. */
  readonly orderbookStaleTimeoutMs?: number;
  /** Stale-таймаут сделок (ms). Default: 180s. */
  readonly tradesStaleTimeoutMs?: number;
  /** Пауза между REST-опросами fetch-режима (ms). Default: 500. */
  readonly fetchPollIntervalMs?: number;
  /**
   * Сколько cleanup ОДНОЙ сессии ждёт закрытия её CCXT-инстанса (ms).
   * Default: 10s.
   *
   * @remarks
   * Это НЕ «через столько транспорт закрыт». Таймаут ограничивает ровно
   * одно: сколько session cleanup держит supervised restart, чтобы
   * зависший vendor не подвесил плановый/аварийный перезапуск навсегда.
   * По его истечении закрытие продолжается в фоне.
   *
   * `CexSource.close()` фоновой дочистки НЕ дожидается: право публиковать
   * снимает abort сессии, а не закрытие сокета, и безусловное ожидание
   * превратило бы один зависший `instance.close()` в бессрочную остановку
   * всего lifecycle владельца source.
   */
  readonly closeTimeoutMs?: number;
  /** Начальный backoff supervised-рестарта (ms). Default: 2s. */
  readonly initialBackoffMs?: number;
  /** Максимальный backoff supervised-рестарта (ms). Default: 60s. */
  readonly maxBackoffMs?: number;
}

/**
 * Валидирует конфигурацию `CexSource`.
 *
 * @param config - Конфигурация для проверки
 * @throws {Error} Если `exchangeId` пуст, список символов пуст либо не
 *   включён ни один поток
 *
 * @remarks
 * Ошибки конфигурации — программные (fail-fast на construct), а не
 * операционные: Result здесь не используется.
 */
export function assertValidCexSourceConfig(config: CexSourceConfig): void {
  if (config.exchangeId.trim().length === 0) {
    throw new Error('CexSourceConfig.exchangeId must not be empty');
  }
  if (config.symbols.length === 0) {
    throw new Error('CexSourceConfig.symbols must not be empty');
  }
  if (!config.watchOrderbook && !config.watchTrades) {
    throw new Error('CexSourceConfig must enable at least one stream (orderbook or trades)');
  }
  const depth = config.orderbookDepth ?? DEFAULT_ORDERBOOK_DEPTH;
  if (!Number.isInteger(depth) || depth <= 0) {
    throw new Error('CexSourceConfig.orderbookDepth must be a positive integer');
  }
}
