/**
 * Application-события исполнения ордеров (user-channel Polymarket WS).
 *
 * @remarks
 * Жизненный цикл fill в user channel (WsFillStatus):
 * - MATCHED    → публикуем FILL_RECEIVED (primary trigger для ProcessFillUseCase)
 *                Portfolio обновляется немедленно. SELL может быть отклонён CLOB
 *                для cross-outcome mint — retry на следующем тике.
 * - MINED      → логируем, ждём finality
 * - CONFIRMED  → fallback: если MATCHED был пропущен (рестарт бота), публикуем FILL_RECEIVED.
 *                Иначе — idempotency guard в ProcessFillUseCase отбросит.
 * - RETRYING   → alert о проблеме с транзакцией
 * - FAILED     → публикуем FILL_FAILED с fills для отката Portfolio
 *
 * FillEventHandler проверяет WsFillStatus и публикует соответствующее событие.
 *
 * Это Application-контур: события описывают, что произошло на уровне приложения,
 * и не являются Domain-событиями `@polymarket/fill`/`@polymarket/order`.
 */
export type { FillReceivedEvent } from './FillReceivedEvent.js';
export type { FillConfirmedEvent } from './FillConfirmedEvent.js';
export type { FillFailedEvent } from './FillFailedEvent.js';
export type { DirectFillAppliedEvent } from './DirectFillAppliedEvent.js';
