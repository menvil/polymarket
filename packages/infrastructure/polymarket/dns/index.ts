/**
 * DNS Override — динамическая подмена DNS для обхода блокировок Polymarket.
 *
 * @remarks
 * Экспортирует три класса для работы с DNS override:
 * - `DnsOverride` — основной класс, устанавливает monkey-patch и управляет жизненным циклом
 * - `IpStore` — хранилище IP с round-robin ротацией (используется внутри DnsOverride)
 * - `DnsResolver` — DNS-резолвер через dns.resolve4 (используется внутри DnsOverride)
 *
 * ### Типичное использование:
 * ```typescript
 * import { DnsOverride } from './dns/index.js';
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
export { IpStore } from './IpStore.js';
export { DnsResolver } from './DnsResolver.js';
