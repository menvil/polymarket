/**
 * DNS Override — динамическая подмена DNS для обхода блокировок Polymarket.
 *
 * @remarks
 * Устанавливает monkey-patch на `node:dns` lookup для перехвата DNS-запросов
 * к хостам Polymarket. Вместо системного резолвинга подставляет IP из пула
 * с round-robin ротацией.
 *
 * ### Принцип работы:
 * Нативный `fetch()` и нативный `WebSocket` (Node.js 21+) оба основаны на `undici`.
 * `undici` вызывает `dns.lookup` при создании каждого нового TCP-сокета — именно
 * это место перехватывается monkey-patch'ем. Подмена прозрачна для всего сетевого
 * кода: не требуется изменять `fetch()` вызовы или конфигурацию `WebSocket`.
 * При каждом `new WebSocket()` → новый TCP-сокет → новый `dns.lookup` → наш патч.
 *
 * ### Почему DoH, а не dns.resolve4:
 * `dns.resolve4` идёт через системный DNS-сервер (провайдерский — заблокирован
 * или подменён). DoH через `fetch('https://1.1.1.1/dns-query?...')` отправляет
 * запрос напрямую по IP Cloudflare — провайдер не может его перехватить.
 *
 * ### Алгоритм `install()`:
 * 1. Резолвим IPv4-адреса для всех хостов через DoH (Cloudflare 1.1.1.1)
 * 2. Сохраняем IP в `IpStore`
 * 3. Устанавливаем monkey-patch на `dns.lookup`
 * 4. Запускаем фоновое обновление IP (по умолчанию каждые 5 минут)
 *
 * ### Алгоритм monkey-patch:
 * - Если хост в нашем списке → выдаём следующий IP из пула (round-robin)
 * - Если хост не в списке или нет IP → передаём в оригинальный `dns.lookup`
 *
 * ### Обработка сбоев:
 * `notifyConnectionFailed(host)` помечает последний выданный IP как недоступный.
 * Следующий `dns.lookup` вернёт другой IP из пула.
 *
 * @example
 * ```typescript
 * // При старте приложения:
 * const dnsOverride = new DnsOverride(logger);
 * await dnsOverride.install([
 *   'clob.polymarket.com',
 *   'gamma-api.polymarket.com',
 *   'data-api.polymarket.com',
 *   'ws-subscriptions-clob.polymarket.com',
 * ]);
 *
 * // При ошибке соединения (в PolymarketRestClient):
 * dnsOverride.notifyConnectionFailed('clob.polymarket.com');
 *
 * // При завершении приложения:
 * dnsOverride.uninstall();
 * ```
 */

import dns from 'node:dns';
import type { LookupOptions, LookupOneOptions, LookupAllOptions } from 'node:dns';
import type { ILogger } from '@polymarket/logger';
import { IpStore } from './IpStore.js';
import { DnsResolver } from './DnsResolver.js';

/** Тип колбэка однократного dns.lookup (без all: true) */
type LookupOneCallback = (
  err: NodeJS.ErrnoException | null,
  address: string,
  family: number,
) => void;

/** Интервал фонового обновления IP по умолчанию (5 минут) */
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * DNS Override — динамический DNS для обхода блокировок Polymarket.
 *
 * @remarks
 * Устанавливается один раз при старте приложения.
 * После `install()` все сетевые запросы к хостам Polymarket прозрачно
 * используют IP из пула с round-robin ротацией.
 */
/**
 * Порт резолвера: единственное, что нужно от него override-у.
 *
 * @remarks
 * Узкий тип вместо всего класса — чтобы тест мог подставить свой резолвер,
 * не наследуя боевой DoH-стек.
 */
export type DnsResolverPort = Pick<DnsResolver, 'resolve'>;

/**
 * Что дала установка override-а.
 *
 * @remarks
 * `resolved === 0` означает, что патч стоит, но обслуживать ему нечем: все
 * запросы уйдут в системный резолвер, пока фоновый refresh не поднимет хотя бы
 * один хост. Возвращать это, а не молчать, обязательно — иначе `install()`
 * отчитывается об успехе там, где не разрезолвился ни один хост, и вызывающий
 * не может отличить рабочий override от инертного.
 */
export interface DnsOverrideInstallResult {
  /** Сколько хостов имеет IP в кэше. */
  readonly resolved: number;
  /** Сколько хостов запрошено. */
  readonly total: number;
}

export class DnsOverride {
  private readonly _store: IpStore;
  private readonly _resolver: DnsResolverPort;
  private readonly _logger: ILogger;
  private readonly _refreshIntervalMs: number;

  private _originalLookup: typeof dns.lookup | null = null;
  private _refreshTimer: ReturnType<typeof setInterval> | null = null;
  private _hosts: string[] = [];
  private _installed = false;

  /**
   * @param logger - Логгер для диагностики
   * @param refreshIntervalMs - Интервал фонового обновления IP (по умолчанию 5 минут)
   * @param resolver - Резолвер DoH; по умолчанию боевой {@link DnsResolver}
   *
   * @remarks
   * Резолвер инъецируется ради тестов: без этого проверить поведение при
   * недоступном DoH можно было бы только настоящим сетевым запросом.
   *
   * @example
   * ```typescript
   * const dnsOverride = new DnsOverride(logger);
   * ```
   */
  constructor(
    logger: ILogger,
    refreshIntervalMs: number = DEFAULT_REFRESH_INTERVAL_MS,
    resolver: DnsResolverPort = new DnsResolver(),
  ) {
    this._store = new IpStore();
    this._resolver = resolver;
    this._logger = logger.child({ component: 'DnsOverride' });
    this._refreshIntervalMs = refreshIntervalMs;
  }

  /**
   * Устанавливает DNS-переопределение для указанных хостов.
   *
   * @param hosts - Список hostname для перехвата
   * @returns Сколько хостов реально разрезолвилось из скольких запрошенных
   *
   * @remarks
   * Последовательность:
   * 1. Резолвит IPv4 для всех хостов через DoH (Cloudflare 1.1.1.1)
   * 2. Сохраняет результаты в `IpStore`
   * 3. Патчит `dns.lookup`
   * 4. Запускает фоновый рефреш
   *
   * Повторный вызов — no-op, возвращающий текущее состояние кэша.
   *
   * Метод НЕ бросает при отказе резолвинга, в том числе полном: патч ставится
   * всё равно (`hasHost` вернёт false, запросы уйдут в системный резолвер), а
   * фоновый рефреш продолжает попытки и поднимает override сам, когда DoH
   * оживёт. Полный провал возвращается как `{ resolved: 0 }` — проверять его
   * обязан вызывающий; коллектор логирует на это ERROR.
   *
   * @example
   * ```typescript
   * const { resolved, total } = await dnsOverride.install([
   *   'clob.polymarket.com',
   *   'gamma-api.polymarket.com',
   * ]);
   * if (resolved === 0) {
   *   logger.error('DNS override is inert', { total });
   * }
   * ```
   */
  async install(hosts: string[]): Promise<DnsOverrideInstallResult> {
    if (this._installed) {
      return {
        resolved: this._hosts.filter((host) => this._store.hasHost(host)).length,
        total: this._hosts.length,
      };
    }

    this._hosts = [...hosts];
    this._logger.info('Installing DNS override', { hosts });

    // Резолвим IP для всех хостов перед установкой патча
    const resolved = await this._refreshAll();
    if (resolved === 0) {
      // Патч ставится всё равно, и это осознанно: `hasHost` вернёт false, все
      // запросы уйдут в системный резолвер, а фоновый refresh продолжит
      // попытки и поднимет override сам, когда DoH оживёт. Отказать в
      // установке значило бы обменять это самовосстановление на громкость —
      // громкость достигается строкой ниже дешевле.
      this._logger.error('DNS override resolved no hosts; it is inert until a refresh succeeds', {
        hosts: this._hosts,
        refreshIntervalMs: this._refreshIntervalMs,
      });
    }

    // Сохраняем оригинальный lookup перед подменой
    this._originalLookup = dns.lookup.bind(dns);

    // Monkey-patch: подменяем dns.lookup
    const store = this._store;
    const logger = this._logger;
    const originalLookup = this._originalLookup;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dns as any).lookup = (
      hostname: string,
      optionsOrCallback: LookupOneOptions | LookupAllOptions | LookupOptions | number | LookupOneCallback,
      maybeCallback?: LookupOneCallback,
    ): void => {
      // Определяем callback из перегруженных сигнатур dns.lookup
      const callback = (
        typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
      ) as LookupOneCallback;

      // Запрошенный family: `dns.lookup(host, 6, cb)` либо `{ family: 6 }`.
      const requestedFamily =
        typeof optionsOrCallback === 'number'
          ? optionsOrCallback
          : typeof optionsOrCallback === 'object' && optionsOrCallback !== null
            ? (optionsOrCallback as LookupOptions).family
            : undefined;

      // Кэш хранит ТОЛЬКО A-записи (resolve4), поэтому явный запрос AAAA
      // обслужить нечем: отдать IPv4 под видом ответа на family: 6 значит
      // соврать вызывающему. Такой запрос уходит в системный резолвер.
      if (requestedFamily === 6) {
        logger.debug('DNS override: IPv6 requested, delegating to system DNS', { hostname });
      } else if (store.hasHost(hostname)) {
        const ip = store.getNextIp(hostname);
        if (ip) {
          logger.debug('DNS override: serving cached IP', { hostname, ip });

          // ВАЖНО: undici вызывает dns.lookup с { all: true } — в этом режиме
          // колбэк ожидает массив объектов [{ address, family }], а не (address, family)
          const isAll =
            typeof optionsOrCallback === 'object' &&
            optionsOrCallback !== null &&
            (optionsOrCallback as LookupAllOptions).all === true;

          process.nextTick(() => {
            if (isAll) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (callback as any)(null, [{ address: ip, family: 4 }]);
            } else {
              callback(null, ip, 4);
            }
          });
          return;
        }
        logger.warn('DNS override: no IPs available, falling back to system DNS', { hostname });
      }

      // Хост не в нашем списке или нет IP — передаём в оригинальный lookup
      if (typeof optionsOrCallback === 'function') {
        originalLookup(hostname, optionsOrCallback);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        originalLookup(hostname, optionsOrCallback as any, maybeCallback!);
      }
    };

    this._installed = true;
    this._startAutoRefresh();

    this._logger.info('DNS override installed', {
      hosts: this._hosts,
      resolved,
      total: this._hosts.length,
    });
    return { resolved, total: this._hosts.length };
  }

  /**
   * Уведомляет о сбое соединения с хостом.
   *
   * @param host - Hostname, к которому не удалось подключиться
   *
   * @remarks
   * Помечает последний выданный IP как временно недоступный.
   * Следующий `dns.lookup` для этого хоста вернёт другой IP из пула.
   *
   * Вызывается из `PolymarketRestClient` при сетевой ошибке (не таймаут, не HTTP 4xx).
   *
   * @example
   * ```typescript
   * // В PolymarketRestClient при network error:
   * this._dnsOverride?.notifyConnectionFailed('clob.polymarket.com');
   * ```
   */
  notifyConnectionFailed(host: string): void {
    if (!this._store.hasHost(host)) return;

    this._store.markLastFailed(host);
    this._logger.warn('DNS override: IP marked as failed, will rotate on next request', { host });
  }

  /**
   * Удаляет monkey-patch и останавливает фоновый рефреш.
   *
   * @remarks
   * Восстанавливает оригинальный `dns.lookup`.
   * Вызывать при корректном завершении приложения.
   *
   * @example
   * ```typescript
   * dnsOverride.uninstall();
   * ```
   */
  uninstall(): void {
    if (!this._installed || !this._originalLookup) return;

    this._stopAutoRefresh();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dns as any).lookup = this._originalLookup;
    this._installed = false;
    this._originalLookup = null;

    this._logger.info('DNS override uninstalled');
  }

  /**
   * Возвращает `true` если monkey-patch установлен.
   *
   * @returns Статус установки
   */
  isInstalled(): boolean {
    return this._installed;
  }

  // ── Приватные методы ─────────────────────────────────────────────────────

  /**
   * Обновляет IP-адреса для всех хостов.
   *
   * @remarks
   * При ошибке резолвинга — логируем и сохраняем старые IP (если есть).
   * Сбой для одного хоста не прерывает обновление остальных.
   *
   * Итог считается по СОДЕРЖИМОМУ кэша, а не по статусам promise: каждая
   * задача гасит свою ошибку сама, поэтому `Promise.allSettled` никогда не
   * вернёт `rejected`, и агрегирующий счётчик по её статусам был мёртвым
   * кодом — предупреждение «часть хостов не разрезолвилась» не могло
   * сработать ни разу.
   *
   * @returns Сколько хостов имеет IP в кэше после обновления
   */
  private async _refreshAll(): Promise<number> {
    await Promise.all(
      this._hosts.map(async (host) => {
        try {
          const ips = await this._resolver.resolve(host);
          this._store.setIps(host, ips);
          this._logger.debug('DNS resolved', { host, ips });
        } catch (err) {
          this._logger.error('Failed to resolve DNS for host', {
            host,
            error: err instanceof Error ? err.message : String(err),
          });
          // Хост остаётся с прежним IP-пулом (или без IP если первый старт)
        }
      }),
    );

    const resolved = this._hosts.filter((host) => this._store.hasHost(host)).length;
    if (resolved < this._hosts.length) {
      this._logger.warn('Some hosts have no cached IPs after refresh', {
        resolved,
        total: this._hosts.length,
      });
    }
    return resolved;
  }

  /**
   * Запускает фоновый таймер обновления IP.
   */
  private _startAutoRefresh(): void {
    this._refreshTimer = setInterval(() => {
      this._logger.debug('DNS auto-refresh triggered', { hosts: this._hosts });
      this._refreshAll().catch((err) => {
        this._logger.error('DNS auto-refresh failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this._refreshIntervalMs);

    // Не блокируем завершение процесса
    this._refreshTimer.unref();
  }

  /**
   * Останавливает фоновый таймер обновления IP.
   */
  private _stopAutoRefresh(): void {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }
}
