/**
 * Canonical идентичность владельца-коллектора в общем control-plane.
 *
 * @remarks
 * После Collector-cutover сборщик перестаёт владеть источниками и выражает
 * интерес к данным как ОБЫЧНЫЙ владелец claim-ов — той же непрозрачной
 * строкой `ownerKey`, что и стратегии. Контроллеры подписок эту строку не
 * разбирают; она лишь отличает claim-ы коллектора от чужих на разделяемом
 * физическом потоке.
 *
 * Ключ вынесен в одну константу, потому что им параметризуются ДВА
 * независимых спроса (Polymarket и CEX): расхождение строк развело бы claim-ы
 * коллектора на два разных владельца, и release одного не затронул бы другой.
 */

/**
 * Owner key коллектора сырых данных.
 *
 * @remarks
 * Форма `<role>:<instance>` повторяет соглашение контура
 * (`strategy:btc-5m`, `collector:raw`). Значение стабильно: под ним живут
 * claim-ы коллектора и в Polymarket, и в CEX control-plane.
 *
 * @example
 * ```typescript
 * const demand = { ownerKey: COLLECTOR_RAW_OWNER_KEY, policy, acquireLimit: 20 };
 * ```
 */
export const COLLECTOR_RAW_OWNER_KEY = 'collector:raw';
