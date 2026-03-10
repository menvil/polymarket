/**
 * Типы данных Order — только структуры, ноль логики
 *
 * @remarks
 * OrderState — внутреннее представление агрегата (value objects).
 * OrderSnapshot — внешний формат для персистентности и синхронизации с биржей.
 * CreateOrderParams — параметры для создания новой заявки (status всегда PENDING).
 * FillData — данные одного исполнения (входной параметр applyFill).
 */
/** Статусы из которых заявка больше не изменится */
export const TERMINAL_STATUSES = new Set([
    'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED',
]);
/** Статусы в которых заявка может принять fill */
export const FILLABLE_STATUSES = new Set([
    'OPEN', 'PARTIALLY_FILLED',
]);
//# sourceMappingURL=OrderState.js.map