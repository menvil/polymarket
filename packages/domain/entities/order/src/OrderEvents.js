/**
 * Domain events для Order
 *
 * @remarks
 * События — факты, которые уже произошли.
 * Используются в режиме replay: Order.fromEvents(events) воспроизводит
 * историю без валидации.
 *
 * Отличие от команд (accept(), applyFill()):
 * - Команда — намерение (нуждается в валидации, может вернуть ошибку)
 * - Событие — факт (применяется без валидации)
 */
export {};
//# sourceMappingURL=OrderEvents.js.map