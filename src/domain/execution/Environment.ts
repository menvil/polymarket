/**
 * Environment - режим работы стратегии
 *
 * @remarks
 * v4: Определяет режим работы стратегии и выбор clock implementation.
 *
 * Режимы:
 * - LIVE: production, real exchange data, LiveClock
 * - PAPER: simulated trading, PaperClock
 * - REPLAY: replay from logs, ReplayClock
 */
export type Environment = 'LIVE' | 'PAPER' | 'REPLAY';
