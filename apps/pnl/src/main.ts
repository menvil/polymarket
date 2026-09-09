/**
 * PnL-аналитика Polymarket — точка входа.
 *
 * @remarks
 * ### Режимы:
 * - `daily`    (по умолчанию) — краткая таблица по дням
 * - `detailed` — подробный вывод по каждому рынку с fills
 *
 * ### Источники данных:
 * - Polymarket CLOB API `/data/trades` — исполнения пользователя (L2 auth)
 * - Gamma API `/markets` — метаданные рынков (public)
 *
 * ### Требования к ENV (в .env):
 * ```
 * PRIVATE_KEY=0x...
 * POLYMARKET_API_KEY=...
 * POLYMARKET_API_SECRET=...
 * POLYMARKET_API_PASSPHRASE=...
 * FUNDER_ADDRESS=0x...  # опционально, для POLY_PROXY кошельков
 * ```
 *
 * ### Примеры запуска:
 * ```bash
 * # Краткая сводка за март
 * npx tsx --env-file=.env src/main.ts --from 2026-03-01 --to 2026-03-31
 *
 * # Детальный отчёт за сегодня
 * npx tsx --env-file=.env src/main.ts --from 2026-04-08 --mode detailed
 *
 * # JSON для дальнейшей обработки
 * npx tsx --env-file=.env src/main.ts --from 2026-03-01 --json
 * ```
 */

import { ColorConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { createPublicClient, createSecureClient } from '@polymarket/client';
import { toApiKey } from '@polymarket/bindings';
import { parseConfig } from './PnlConfig.js';
import { ActivityFetcher } from './core/ActivityFetcher.js';
import { PositionsFetcher } from './core/PositionsFetcher.js';
import { TradesFetcher } from './core/TradesFetcher.js';
import { createEthersSigner } from './core/EthersSigner.js';
import { PnlCalculator } from './core/PnlCalculator.js';
import { DailyRenderer } from './renderers/DailyRenderer.js';
import { DetailedRenderer } from './renderers/DetailedRenderer.js';

async function main(): Promise<void> {
  // ── Конфигурация ─────────────────────────────────────────────────────────────
  let config;
  try {
    config = parseConfig();
  } catch (err) {
    console.error(`Configuration error: ${(err as Error).message}`);
    console.error('');
    console.error('Usage:');
    console.error('  npx tsx --env-file=.env src/main.ts --from YYYY-MM-DD [--to YYYY-MM-DD] [--mode daily|detailed] [--json]');
    process.exit(1);
  }

  const clock = new LiveClock();
  // Логгер пишет info через `console.log`, то есть в stdout. В машинных
  // режимах (`--json`, `--raw`) это ломает разбор вывода, поэтому там
  // остаются только ошибки.
  const machineReadable = config.jsonOutput || config.rawOutput;
  const logger = new ColorConsoleLogger(clock, machineReadable ? LogLevel.ERROR : LogLevel.INFO);

  logger.info('PnL analytics started', {
    from: new Date(config.fromTs * 1000).toISOString().slice(0, 10),
    to:   new Date(config.toTs   * 1000).toISOString().slice(0, 10),
    mode: config.mode,
    wallet: config.wallet,
  });

  // ── Публичный клиент SDK ────────────────────────────────────────────────────
  // Позиции и активность на Polymarket публичны: ни приватного ключа, ни
  // API-креденшелов read-only отчёту не нужно.
  const client = createPublicClient();

  const activity  = new ActivityFetcher(client, logger);
  const positions = new PositionsFetcher(client, logger);

  const period = { fromTs: config.fromTs, toTs: config.toTs };

  // ── Шаг 1: Сделки ───────────────────────────────────────────────────────────
  // С креденшелами берём аутентифицированный путь — только он несёт ставку
  // комиссии и роль MAKER/TAKER. Без них публичная лента: те же сделки,
  // но комиссия останется внутри realizedPnl и в отчёте будет `—`.
  const fills = config.credentials === undefined
    ? await activity.fetchAll({ wallet: config.wallet, ...period })
    : await (async () => {
        const { privateKey, apiKey, apiSecret, apiPassphrase } = config.credentials!;
        const secure = await createSecureClient({
          signer: createEthersSigner(privateKey),
          wallet: config.wallet,
          credentials: {
            key: toApiKey(apiKey),
            secret: apiSecret,
            passphrase: apiPassphrase,
          },
        });
        return new TradesFetcher(secure, logger).fetchAll({
          makerAddress: config.wallet,
          ...period,
        });
      })();

  // Режим --raw: вывод приведённых сделок и выход
  if (config.rawOutput) {
    console.log(JSON.stringify(fills, null, 2));
    return;
  }

  // ── Шаг 2: Позиции с реализованным PnL ──────────────────────────────────────
  const closedPositions = await positions.fetchAll({
    wallet: config.wallet,
    includeOpen: config.includeOpen,
    ...period,
  });

  // В машинном режиме пустой период — тоже результат: отдаём отчёт
  // установленной формы с нулями, а не прозу, которую нечем разобрать.
  if (closedPositions.length === 0 && !config.jsonOutput) {
    console.log('\nNo positions found for the given period.\n');
    return;
  }

  // ── Шаг 3: Сборка отчёта ────────────────────────────────────────────────────
  const calc     = new PnlCalculator(logger);
  const fromDate = new Date(config.fromTs * 1000).toISOString().slice(0, 10);
  const toDate   = new Date(config.toTs   * 1000).toISOString().slice(0, 10);
  const report   = calc.compute({ positions: closedPositions, fills, fromDate, toDate });

  // ── Шаг 4: Вывод ─────────────────────────────────────────────────────────────
  if (config.jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (config.mode === 'detailed') {
    const renderer = new DetailedRenderer();
    renderer.render(report);
  } else {
    const renderer = new DailyRenderer();
    renderer.render(report);
  }
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
