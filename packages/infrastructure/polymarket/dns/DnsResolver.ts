/**
 * DNS-резолвер через DNS-over-HTTPS (DoH).
 *
 * @remarks
 * Вместо системного `dns.resolve4` (который идёт через DNS-сервер провайдера —
 * потенциально заблокированный или подменённый) использует DoH-запросы напрямую
 * по IP к доверенным резолверам:
 *
 * 1. Cloudflare `1.1.1.1` — запрос по IP, не требует DNS-резолвинга
 * 2. Cloudflare `1.0.0.1` — резервный IP Cloudflare
 * 3. Системный `dns.resolve4` — fallback если оба DoH недоступны
 *
 * ### Почему DoH, а не dns.resolve4:
 * - `dns.resolve4` → системный DNS-сервер → может быть провайдерским (заблокирован/подменён)
 * - `fetch('https://1.1.1.1/dns-query')` → прямое HTTPS к IP → провайдер не перехватывает
 *
 * ### Формат ответа (application/dns-json, RFC 8484):
 * ```json
 * {
 *   "Status": 0,
 *   "Answer": [
 *     { "type": 1, "data": "104.21.0.1", "TTL": 300 },
 *     { "type": 5, "data": "cname.target.com", "TTL": 300 }
 *   ]
 * }
 * ```
 * Фильтруем только `type === 1` (A-записи).
 *
 * @example
 * ```typescript
 * const resolver = new DnsResolver();
 * const ips = await resolver.resolve('clob.polymarket.com');
 * console.log(ips); // ['104.21.0.1', '172.67.0.1']
 * ```
 */

import { resolve4 } from 'node:dns/promises';

/** Тип A-записи в DoH-ответе (IPv4) */
const DNS_TYPE_A = 1;

/** Таймаут одного DoH-запроса (5 секунд) */
const DOH_REQUEST_TIMEOUT_MS = 5_000;

/**
 * DoH JSON ответ (формат Cloudflare / Google `application/dns-json`)
 */
interface DoHResponse {
  /** Статус DNS-ответа (0 = NOERROR) */
  Status: number;
  /** Массив записей ответа */
  Answer?: Array<{
    /** Тип записи (1 = A, 5 = CNAME, 28 = AAAA) */
    type: number;
    /** Данные записи (IP для type=1) */
    data: string;
  }>;
}

/**
 * DoH провайдеры — запросы идут напрямую по IP, DNS-резолвинг не нужен.
 */
const DOH_PROVIDERS: ReadonlyArray<{ url: string; name: string }> = [
  { url: 'https://1.1.1.1/dns-query', name: 'Cloudflare 1.1.1.1' },
  { url: 'https://1.0.0.1/dns-query', name: 'Cloudflare 1.0.0.1' },
];

/**
 * DNS-резолвер через DoH.
 *
 * @remarks
 * Пробует DoH-провайдеры по порядку.
 * Если все недоступны — падает на системный `dns.resolve4` как последний resort.
 */
export class DnsResolver {
  /**
   * Резолвит IPv4-адреса для хоста через DoH.
   *
   * @param host - Hostname для резолвинга
   * @returns Список IPv4-адресов (минимум 1)
   * @throws {Error} Если все DoH-провайдеры и системный DNS завершились ошибкой
   *
   * @example
   * ```typescript
   * const ips = await resolver.resolve('ws-subscriptions-clob.polymarket.com');
   * // ['104.21.0.1', '172.67.0.1']
   * ```
   */
  async resolve(host: string): Promise<string[]> {
    for (const provider of DOH_PROVIDERS) {
      try {
        const ips = await this._queryDoH(provider.url, host);
        if (ips.length > 0) {
          return ips;
        }
      } catch {
        // Пробуем следующего провайдера
      }
    }

    // Последний резорт: системный DNS
    return resolve4(host);
  }

  /**
   * Выполняет DoH-запрос к указанному провайдеру.
   *
   * @param providerUrl - URL DoH-провайдера (по IP, без DNS-резолвинга)
   * @param host - Hostname для резолвинга
   * @returns Список IPv4-адресов из A-записей
   * @throws {Error} При HTTP-ошибке, таймауте или отсутствии A-записей
   */
  private async _queryDoH(providerUrl: string, host: string): Promise<string[]> {
    const url = `${providerUrl}?name=${encodeURIComponent(host)}&type=A`;

    const response = await fetch(url, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(DOH_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`DoH HTTP ${response.status} from ${providerUrl}`);
    }

    const data = (await response.json()) as DoHResponse;

    if (data.Status !== 0) {
      throw new Error(`DoH RCODE ${data.Status} for ${host}`);
    }

    return (data.Answer ?? [])
      .filter((record) => record.type === DNS_TYPE_A)
      .map((record) => record.data);
  }
}
