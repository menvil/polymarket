/**
 * venueTradeStatusPolicy — общая классификация on-chain статуса venue trade.
 *
 * @remarks
 * Единая реализация вместо дублирования в `ReconcileTradesUseCase` и
 * `SettleTerminalOrdersUseCase`. Два профиля:
 *
 * - `recovery` — используется `ReconcileTradesUseCase` (recovery после
 *   рестарта/разрыва WS): принимает И `CONFIRMED` (finality), И `MATCHED`
 *   (мгновенное исполнение) — осознанное исключение, чтобы не потерять fill,
 *   если REST вернул `MATCHED`, но WS fill-событие не пришло. Дубли исключены
 *   idempotency-guard'ом `IProcessedFillRepository`.
 * - `settlement` — используется `SettleTerminalOrdersUseCase` (authoritative
 *   release резервации после terminal venue-update): принимает ТОЛЬКО
 *   `CONFIRMED`. Settlement необратим (снимает блокировку капитала), поэтому
 *   не финализированный `MATCHED` здесь недостаточен — сделка ещё может
 *   стать `RETRYING`/`FAILED`.
 *
 * `MINED`/`RETRYING`/`undefined` НЕ processable ни в одном профиле — трактуются
 * как «ещё не финализировано», caller обязан оставить fill/pending без изменений.
 * `FAILED` тоже не processable — обрабатывается отдельной веткой (см.
 * `isFailedVenueTradeStatus`), а не как «применить».
 */
import type { VenueTradeStatus } from '@polymarket/ports';

/** Профиль классификации on-chain статуса venue trade. */
export type VenueTradeStatusProfile = 'recovery' | 'settlement';

const PROCESSABLE_BY_PROFILE: Readonly<Record<VenueTradeStatusProfile, ReadonlySet<VenueTradeStatus>>> = {
  recovery: new Set<VenueTradeStatus>(['CONFIRMED', 'MATCHED']),
  settlement: new Set<VenueTradeStatus>(['CONFIRMED']),
};

/**
 * Проверяет, готов ли trade к обработке (применению к Portfolio/journal) в
 * данном профиле.
 *
 * @param status - On-chain статус trade (`VenueTradeSnapshot.status`), опционально
 * @param profile - `'recovery'` (CONFIRMED+MATCHED) или `'settlement'` (только CONFIRMED)
 * @returns `true`, если trade можно обрабатывать сейчас
 *
 * @example
 * ```typescript
 * if (isProcessableVenueTradeStatus(trade.status, 'settlement')) {
 *   // безопасно применить trade и release-ить резервацию
 * }
 * ```
 */
export function isProcessableVenueTradeStatus(
  status: VenueTradeStatus | undefined,
  profile: VenueTradeStatusProfile,
): boolean {
  if (status === undefined) return false;
  return PROCESSABLE_BY_PROFILE[profile].has(status);
}

/**
 * Проверяет, является ли статус terminal-негативным (`FAILED`).
 *
 * @param status - On-chain статус trade, опционально
 * @returns `true`, если сделка окончательно не прошла (revert без retry)
 *
 * @remarks
 * `FAILED` обрабатывается отдельно от `isProcessableVenueTradeStatus`: если
 * fill уже применён локально (`APPLIED`) — требуется reversal/manual
 * reconciliation; если не применён — trade просто не вносит вклад (не
 * ошибка сама по себе, просто «эта сделка не состоялась»).
 */
export function isFailedVenueTradeStatus(status: VenueTradeStatus | undefined): boolean {
  return status === 'FAILED';
}
