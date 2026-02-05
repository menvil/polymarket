/**
 * InstrumentId - идентификатор инструмента на market data source
 *
 * @remarks
 * Branded type для type safety.
 *
 * Представляет ID инструмента в venue-specific формате:
 * - Polymarket: token_id (ERC1155 token ID)
 * - Kalshi: ticker (e.g., "INXD-23DEC31-T4120")
 *
 * Используется для:
 * - Subscription на маркет-данные
 * - Идентификация инструмента в котировках/трейдах
 *
 * @example
 * ```typescript
 * // Polymarket token_id
 * const polymarketInstrument = '123456789' as InstrumentId;
 *
 * // Kalshi ticker
 * const kalshiInstrument = 'INXD-23DEC31-T4120' as InstrumentId;
 * ```
 */
export type InstrumentId = string & { readonly __brand: 'InstrumentId' };
