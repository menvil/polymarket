/**
 * @polymarket/dns-override — обход заблокированного или подменённого DNS.
 *
 * @remarks
 * ### Почему отдельный пакет
 *
 * Подмена DNS — забота ПРОЦЕССА, а не биржевого адаптера: она ставит
 * monkey-patch на `node:dns` и потому действует на весь процесс целиком —
 * и на `undici` (fetch официального SDK), и на `new WebSocket()`, и на любой
 * другой сетевой клиент. Раньше эти классы жили внутри `@polymarket/exchange`
 * (legacy V1-адаптер площадки), из-за чего сборщик — которому нужен ТОЛЬКО
 * обход DNS — тянул за собой весь legacy-стек и ломался вместе с ним.
 *
 * Пакет ни от чего, кроме логгера и node-builtins, не зависит.
 *
 * ### Экспортируемые классы:
 * - `DnsOverride` — основной класс, устанавливает monkey-patch и управляет жизненным циклом
 * - `IpStore` — хранилище IP с round-robin ротацией (используется внутри DnsOverride)
 * - `DnsResolver` — DNS-резолвер через dns.resolve4 (используется внутри DnsOverride)
 *
 * ### Типичное использование:
 * ```typescript
 * import { DnsOverride } from '@polymarket/dns-override';
 *
 * const dnsOverride = new DnsOverride(logger);
 * await dnsOverride.install([
 *   'clob.polymarket.com',
 *   'gamma-api.polymarket.com',
 *   'data-api.polymarket.com',
 *   'ws-subscriptions-clob.polymarket.com',
 * ]);
 * ```
 */

export { DnsOverride } from './DnsOverride.js';
export type { DnsOverrideInstallResult, DnsResolverPort } from './DnsOverride.js';
export { IpStore } from './IpStore.js';
export { DnsResolver } from './DnsResolver.js';
