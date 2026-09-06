/**
 * Поведение monkey-patch `dns.lookup` и учёт отказов резолвинга.
 *
 * @remarks
 * Резолвер подставной: боевой ходит в сеть, а проверяемые здесь ветки — это
 * как раз «сеть не отвечает» и «спросили не тот тип записи».
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import dns from 'node:dns';
import { DnsOverride } from '../src/index.js';
import type { ILogger } from '@polymarket/logger';

interface Entry {
  readonly level: string;
  readonly message: string;
}

/** Логгер, запоминающий строки: проверяем именно наблюдаемость отказов. */
function createLogger(entries: Entry[]): ILogger {
  const logger = {
    debug: (message: string) => entries.push({ level: 'debug', message }),
    info: (message: string) => entries.push({ level: 'info', message }),
    warn: (message: string) => entries.push({ level: 'warn', message }),
    error: (message: string) => entries.push({ level: 'error', message }),
    fatal: (message: string) => entries.push({ level: 'fatal', message }),
    child: () => logger,
  } as unknown as ILogger;
  return logger;
}

const HOSTS = ['clob.polymarket.com', 'gamma-api.polymarket.com'];

let active: DnsOverride | undefined;

afterEach(() => {
  active?.uninstall();
  active = undefined;
});

describe('перехват dns.lookup', () => {
  it('обслуживает закэшированный IPv4 для известного хоста', async () => {
    const entries: Entry[] = [];
    active = new DnsOverride(createLogger(entries), 60_000, {
      resolve: async () => ['1.2.3.4'],
    });
    await active.install([...HOSTS]);

    const resolved = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      dns.lookup('clob.polymarket.com', (err, address, family) => {
        if (err) reject(err);
        else resolve({ address, family });
      });
    });

    expect(resolved).toEqual({ address: '1.2.3.4', family: 4 });
  });

  it('ЯВНЫЙ запрос IPv6 уходит в системный резолвер, а не получает IPv4', async () => {
    // Кэш хранит только A-записи: ответить на family: 6 адресом IPv4 значит
    // соврать вызывающему.
    const entries: Entry[] = [];
    active = new DnsOverride(createLogger(entries), 60_000, {
      resolve: async () => ['1.2.3.4'],
    });
    await active.install([...HOSTS]);

    const outcome = await new Promise<string>((resolve) => {
      dns.lookup('clob.polymarket.com', { family: 6 }, (err, address) => {
        resolve(err ? `error:${err.code ?? 'unknown'}` : `address:${address}`);
      });
    });

    // Какой бы ни был ответ системы, это НЕ наш закэшированный IPv4.
    expect(outcome).not.toBe('address:1.2.3.4');
    expect(entries.some((e) => e.message.includes('IPv6 requested'))).toBe(true);
  });

  it('неизвестный хост уходит в системный резолвер', async () => {
    const entries: Entry[] = [];
    active = new DnsOverride(createLogger(entries), 60_000, {
      resolve: async () => ['1.2.3.4'],
    });
    await active.install([...HOSTS]);

    const outcome = await new Promise<string>((resolve) => {
      dns.lookup('localhost', (err, address) => {
        resolve(err ? `error:${err.code ?? 'unknown'}` : `address:${address}`);
      });
    });

    expect(outcome).not.toBe('address:1.2.3.4');
  });
});

describe('учёт отказов резолвинга', () => {
  it('частичный отказ виден предупреждением с реальными числами', async () => {
    const entries: Entry[] = [];
    active = new DnsOverride(createLogger(entries), 60_000, {
      resolve: async (host: string) => {
        if (host === 'gamma-api.polymarket.com') throw new Error('DoH unreachable');
        return ['1.2.3.4'];
      },
    });
    await active.install([...HOSTS]);

    // Раньше эта ветка была недостижима: задача гасила ошибку сама, поэтому
    // allSettled никогда не возвращал rejected и счётчик всегда был нулевым.
    expect(entries.some((e) => e.level === 'warn' && e.message.includes('no cached IPs'))).toBe(
      true,
    );
    expect(active.isInstalled()).toBe(true);
  });

  it('полный отказ — ERROR, но патч ставится и продолжает пытаться', async () => {
    // Установка НЕ отменяется намеренно: `hasHost` вернёт false, запросы уйдут
    // в систему, а фоновый refresh поднимет override сам, когда DoH оживёт.
    const entries: Entry[] = [];
    active = new DnsOverride(createLogger(entries), 60_000, {
      resolve: async () => {
        throw new Error('DoH unreachable');
      },
    });
    await active.install([...HOSTS]);

    expect(entries.some((e) => e.level === 'error' && e.message.includes('inert'))).toBe(true);
    expect(active.isInstalled()).toBe(true);

    // И патч действительно инертен: запрос уходит системе, а не падает.
    const outcome = await new Promise<string>((resolve) => {
      dns.lookup('clob.polymarket.com', (err, address) => {
        resolve(err ? `error:${err.code ?? 'unknown'}` : `address:${address}`);
      });
    });
    expect(outcome).not.toMatch(/^address:1\.2\.3\.4$/);
  });

  it('успешный резолвинг всех хостов не поднимает ни warn, ни error', async () => {
    const entries: Entry[] = [];
    active = new DnsOverride(createLogger(entries), 60_000, {
      resolve: async () => ['1.2.3.4'],
    });
    await active.install([...HOSTS]);

    expect(entries.filter((e) => e.level === 'warn' || e.level === 'error')).toEqual([]);
  });
});

describe('uninstall снимает перехват', () => {
  it('после uninstall закэшированный IP больше не отдаётся', async () => {
    // Проверяем ПОВЕДЕНИЕ, а не идентичность функции: uninstall восстанавливает
    // `dns.lookup.bind(dns)`, снятый при установке, то есть эквивалентную
    // обёртку, а не тот же самый объект.
    const entries: Entry[] = [];
    const before = dns.lookup;
    const override = new DnsOverride(createLogger(entries), 60_000, {
      resolve: async () => ['1.2.3.4'],
    });
    active = override;
    await override.install([...HOSTS]);
    expect(dns.lookup).not.toBe(before);

    const patched = await new Promise<string>((resolve) => {
      dns.lookup('clob.polymarket.com', (_err, address) => resolve(address));
    });
    expect(patched).toBe('1.2.3.4');

    override.uninstall();
    active = undefined;
    expect(override.isInstalled()).toBe(false);

    const restored = await new Promise<string>((resolve) => {
      dns.lookup('clob.polymarket.com', (err, address) =>
        resolve(err ? `error:${err.code ?? 'unknown'}` : address),
      );
    });
    expect(restored).not.toBe('1.2.3.4');
  });
});

describe('install отчитывается о результате, а не только о факте', () => {
  it('полный отказ резолвинга виден в возвращённом результате', async () => {
    // Раньше install() возвращал void: вызывающий не мог отличить рабочий
    // override от инертного и логировал «installed» в обоих случаях.
    const entries: Entry[] = [];
    active = new DnsOverride(createLogger(entries), 60_000, {
      resolve: async () => {
        throw new Error('DoH unreachable');
      },
    });

    await expect(active.install([...HOSTS])).resolves.toEqual({ resolved: 0, total: 2 });
  });

  it('частичный успех отражён числами', async () => {
    const entries: Entry[] = [];
    active = new DnsOverride(createLogger(entries), 60_000, {
      resolve: async (host: string) => {
        if (host === 'gamma-api.polymarket.com') throw new Error('DoH unreachable');
        return ['1.2.3.4'];
      },
    });

    await expect(active.install([...HOSTS])).resolves.toEqual({ resolved: 1, total: 2 });
  });

  it('повторный install идемпотентен и возвращает текущее состояние', async () => {
    const entries: Entry[] = [];
    active = new DnsOverride(createLogger(entries), 60_000, {
      resolve: async () => ['1.2.3.4'],
    });

    await expect(active.install([...HOSTS])).resolves.toEqual({ resolved: 2, total: 2 });
    await expect(active.install([...HOSTS])).resolves.toEqual({ resolved: 2, total: 2 });
  });
});
