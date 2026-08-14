/**
 * @polymarket/external-messages — boundary-контракт сообщений внешнего мира.
 *
 * @remarks
 * Infrastructure-владелец semantic-границы «источник прислал нам
 * source-native сообщение, semantic adapter его ещё не интерпретировал»:
 *
 * - `ExternalMessage<TType, TPayload, TMetadata>` — canonical contract
 *   внешнего сообщения (specialization Foundation-конверта, не второй
 *   envelope);
 * - `AnyExternalMessage` — generic bound infrastructure-кода внешнего
 *   контура (bus/Recorder/Reader), НЕ замена типизации payload.
 *
 * Пакет намеренно минимален: он не содержит ни source-specific контрактов
 * (Polymarket/CEX/RTDS появятся в M-005+), ни runtime-кода, ни validation, ни
 * зависимостей от Application/Domain. Единственная зависимость —
 * `@polymarket/messages` (canonical owner структуры
 * `{ type, payload, metadata }`).
 *
 * @example
 * ```typescript
 * import type { ExternalMessage } from '@polymarket/external-messages';
 *
 * type VenueBookExternalMessage = ExternalMessage<
 *   'VENUE_BOOK',
 *   { readonly instrument: string; readonly bids: readonly [number, number][] }
 * >;
 * ```
 */
/** Canonical contract внешнего сообщения (см. ExternalMessage.ts). */
export type { ExternalMessage, AnyExternalMessage } from './ExternalMessage.js';
