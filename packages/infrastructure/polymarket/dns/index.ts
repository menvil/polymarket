/**
 * DNS Override — РЕЭКСПОРТ из `@polymarket/dns-override`.
 *
 * @remarks
 * Классы переехали в собственный пакет: подмена DNS — забота процесса
 * (monkey-patch на `node:dns` действует на весь процесс), а не биржевого
 * адаптера. Пока сборщик получал их отсюда, он тянул за собой весь legacy
 * V1-стек `@polymarket/exchange` и ломался вместе с ним.
 *
 * Этот файл оставлен, чтобы существующие импорты `@polymarket/exchange/dns`
 * продолжали работать. Новый код должен импортировать из
 * `@polymarket/dns-override` напрямую.
 *
 * @deprecated Импортируйте из `@polymarket/dns-override`.
 */
export { DnsOverride, IpStore, DnsResolver } from '@polymarket/dns-override';
