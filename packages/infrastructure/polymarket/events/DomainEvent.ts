/**
 * Базовый тип доменного события.
 *
 * @remarks
 * Stub — используется mapParsedToDomainEvent до рефакторинга Phase 0.5.
 */
export type DomainEvent = {
  readonly eventType: string;
  /** @deprecated Используй eventType. Алиас для обратной совместимости */
  readonly eventName?: string;
};
