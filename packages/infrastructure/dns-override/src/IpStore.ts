/**
 * Хранилище IP-адресов с round-robin ротацией и отслеживанием сбоев.
 *
 * @remarks
 * Для каждого хоста хранит список IPv4-адресов, текущий индекс ротации
 * и множество временно недоступных IP-адресов.
 *
 * ### Round-robin алгоритм:
 * - `getNextIp()` возвращает следующий доступный IP, пропуская недоступные
 * - Если все IP помечены недоступными — сбрасывает список сбоев и начинает заново
 * - `markLastFailed()` помечает последний выданный IP как недоступный
 *
 * ### Интеграция:
 * Используется `DnsOverride` для прозрачной подмены результатов `dns.lookup`.
 *
 * @example
 * ```typescript
 * const store = new IpStore();
 * store.setIps('clob.polymarket.com', ['1.2.3.4', '5.6.7.8']);
 *
 * const ip1 = store.getNextIp('clob.polymarket.com'); // '1.2.3.4'
 * const ip2 = store.getNextIp('clob.polymarket.com'); // '5.6.7.8'
 *
 * store.markLastFailed('clob.polymarket.com'); // помечаем '5.6.7.8' как сбойный
 * const ip3 = store.getNextIp('clob.polymarket.com'); // '1.2.3.4' (пропускает '5.6.7.8')
 * ```
 */

/** Внутренняя запись для хоста */
interface HostEntry {
  /** Список IPv4-адресов */
  ips: string[];
  /** Текущий индекс ротации */
  index: number;
  /** Временно недоступные IP */
  failed: Set<string>;
  /** Последний выданный IP (для markLastFailed) */
  lastServed: string | undefined;
}

/**
 * Хранилище IP-адресов с round-robin ротацией.
 *
 * @remarks
 * Не зависит от внешних пакетов — чистый domain-объект.
 */
export class IpStore {
  private readonly _store = new Map<string, HostEntry>();

  /**
   * Устанавливает список IP-адресов для хоста.
   *
   * @param host - Hostname
   * @param ips - Список IPv4-адресов
   *
   * @remarks
   * Сохраняет текущий индекс ротации при обновлении.
   * Сбрасывает список недоступных IP при каждом обновлении.
   *
   * @example
   * ```typescript
   * store.setIps('clob.polymarket.com', ['1.2.3.4', '5.6.7.8']);
   * ```
   */
  setIps(host: string, ips: string[]): void {
    const existing = this._store.get(host);
    this._store.set(host, {
      ips: [...ips],
      index: existing?.index ?? 0,
      failed: new Set(),
      lastServed: undefined,
    });
  }

  /**
   * Возвращает следующий доступный IP по round-robin.
   *
   * @param host - Hostname
   * @returns IPv4-адрес или `undefined` если хост не зарегистрирован или список пуст
   *
   * @remarks
   * Пропускает IP из списка `failed`.
   * Если все IP недоступны — сбрасывает список сбоев и возвращает первый IP.
   *
   * @example
   * ```typescript
   * const ip = store.getNextIp('clob.polymarket.com'); // '1.2.3.4'
   * ```
   */
  getNextIp(host: string): string | undefined {
    const entry = this._store.get(host);
    if (!entry || entry.ips.length === 0) return undefined;

    const n = entry.ips.length;

    // Пробуем все IP по кругу, пропуская недоступные
    for (let i = 0; i < n; i++) {
      const idx = entry.index % n;
      const ip = entry.ips[idx]!;
      entry.index = (idx + 1) % n;

      if (!entry.failed.has(ip)) {
        entry.lastServed = ip;
        return ip;
      }
    }

    // Все IP помечены недоступными — сбрасываем и возвращаем первый
    entry.failed.clear();
    const ip = entry.ips[0]!;
    entry.lastServed = ip;
    entry.index = 1 % n;
    return ip;
  }

  /**
   * Помечает последний выданный IP для хоста как временно недоступный.
   *
   * @param host - Hostname
   *
   * @remarks
   * Вызывается `DnsOverride.notifyConnectionFailed()` при ошибке сети.
   * Следующий вызов `getNextIp()` вернёт другой IP.
   *
   * @example
   * ```typescript
   * store.markLastFailed('clob.polymarket.com');
   * ```
   */
  markLastFailed(host: string): void {
    const entry = this._store.get(host);
    if (entry?.lastServed) {
      entry.failed.add(entry.lastServed);
    }
  }

  /**
   * Проверяет, зарегистрирован ли хост.
   *
   * @param host - Hostname
   * @returns `true` если хост есть в хранилище
   */
  hasHost(host: string): boolean {
    return this._store.has(host);
  }

  /**
   * Возвращает список зарегистрированных хостов.
   *
   * @returns Массив hostname
   */
  getHosts(): string[] {
    return [...this._store.keys()];
  }
}
