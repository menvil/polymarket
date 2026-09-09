/**
 * Разбор аргументов и окружения.
 *
 * @remarks
 * Проверяется через `parseConfig()`, а не через внутренний парсер даты:
 * тестировать надо тот путь, которым пользуются, иначе ошибка проскочит
 * мимо проверки в самом `parseConfig`.
 */
import { parseConfig } from '../src/PnlConfig.js';

const WALLET = '0x0000000000000000000000000000000000000001';

/** Запускает `parseConfig()` с заданными аргументами и чистым окружением. */
function withArgs<T>(args: string[], fn: () => T): T {
  const argv = process.argv;
  const env = { ...process.env };
  process.argv = ['node', 'main.ts', ...args];
  process.env['WALLET_ADDRESS'] = WALLET;
  for (const key of ['PRIVATE_KEY', 'POLYMARKET_API_KEY', 'POLYMARKET_API_SECRET', 'POLYMARKET_API_PASSPHRASE']) {
    delete process.env[key];
  }
  try {
    return fn();
  } finally {
    process.argv = argv;
    process.env = env;
  }
}

describe('parseConfig(): календарные даты', () => {
  it('отвергает несуществующий день месяца', () => {
    // Форма верная, дня нет. `Date.UTC` молча превратил бы это в 2026-03-03.
    expect(() => withArgs(['--from', '2026-02-31'], parseConfig)).toThrow(/Invalid calendar date/);
  });

  it('отвергает несуществующий месяц', () => {
    // Стало бы 2027-01-01 — не просто другой день, другой ГОД.
    expect(() => withArgs(['--from', '2026-13-01'], parseConfig)).toThrow(/Invalid calendar date/);
  });

  it('отвергает неверную форму до разбора компонентов', () => {
    expect(() => withArgs(['--from', '01-06-2026'], parseConfig)).toThrow(/Invalid date format/);
  });

  it('принимает существующую дату', () => {
    const config = withArgs(['--from', '2026-06-01', '--to', '2026-06-06'], parseConfig);
    expect(new Date(config.fromTs * 1000).toISOString().slice(0, 10)).toBe('2026-06-01');
    expect(new Date(config.toTs * 1000).toISOString().slice(0, 10)).toBe('2026-06-06');
  });

  it('принимает високосное 29 февраля', () => {
    // Год прошедший: `--to` по умолчанию — сегодня, и будущая дата
    // отвалилась бы на проверке порядка, не дойдя до календарной.
    const config = withArgs(['--from', '2024-02-29'], parseConfig);
    expect(new Date(config.fromTs * 1000).toISOString().slice(0, 10)).toBe('2024-02-29');
  });

  it('отвергает 29 февраля в невисокосный год', () => {
    expect(() => withArgs(['--from', '2026-02-29'], parseConfig)).toThrow(/Invalid calendar date/);
  });
});

describe('parseConfig(): креденшелы', () => {
  it('без креденшелов идёт публичным путём', () => {
    const config = withArgs(['--from', '2026-06-01'], parseConfig);
    expect(config.credentials).toBeUndefined();
  });
});
