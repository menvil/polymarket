/**
 * Порт проектора портфеля.
 *
 * @remarks
 * Используется BalancePolicy для мгновенных проверок баланса без обращения к API.
 * Event-sourced — всегда актуален без задержки.
 */

/**
 * Интерфейс для мгновенного получения позиций из проектора.
 */
export interface IPortfolioProjector {
  /** Возвращает позицию по tokenId или undefined если позиции нет */
  getPosition(tokenId: string): { quantity: number } | undefined;
}
