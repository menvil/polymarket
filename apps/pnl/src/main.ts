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
import {
  PolymarketRestClient,
  PolymarketSigner,
  SignatureType,
} from '@polymarket/exchange/rest';
import { parseConfig } from './PnlConfig.js';
import { TradesFetcher } from './core/TradesFetcher.js';
import { MarketEnricher } from './core/MarketEnricher.js';
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

  const clock  = new LiveClock();
  // В режиме --raw логи заглушаем чтобы stdout был чистым JSON
  const logger = new ColorConsoleLogger(clock, config.rawOutput ? LogLevel.ERROR : LogLevel.INFO);

  logger.info('PnL analytics started', {
    from: new Date(config.fromTs * 1000).toISOString().slice(0, 10),
    to:   new Date(config.toTs   * 1000).toISOString().slice(0, 10),
    mode: config.mode,
    makerAddress: config.makerAddress,
  });

  // ── REST клиент для CLOB API (L2-аутентификация) ─────────────────────────────
  const signer = new PolymarketSigner(config.privateKey, 137);
  const signatureType = config.funderAddress
    ? SignatureType.POLY_PROXY
    : SignatureType.EOA;

  const restClient = new PolymarketRestClient(
    {
      baseUrl:       'https://clob.polymarket.com',
      privateKey:    config.privateKey,
      chainId:       137,
      signatureType,
      funderAddress: config.funderAddress,
      l2Credentials: {
        apiKey:      config.apiKey,
        secret:      config.apiSecret,
        passphrase:  config.apiPassphrase,
      },
    },
    logger
  );

  // Проверяем что signer отдаёт правильный адрес (для диагностики)
  logger.info(`Wallet address: ${signer.getAddress()}`);

  // ── Шаг 1: Загрузка и нормализация сделок ───────────────────────────────────
  const fetcher  = new TradesFetcher(restClient, logger);
  const fetchParams = {
    makerAddress: config.makerAddress,
    fromTs: config.fromTs,
    toTs:   config.toTs,
  };

  // Режим --raw: вывод сырых трейдов из API и выход
  if (config.rawOutput) {
    const rawTrades = await fetcher.fetchRaw(fetchParams);
    console.log(JSON.stringify(rawTrades, null, 2));
    return;
  }

  const fills = await fetcher.fetchAll(fetchParams);

  if (fills.length === 0) {
    console.log('\nNo trades found for the given period.\n');
    return;
  }

  // ── Шаг 2: Обогащение метаданными рынков ─────────────────────────────────────
  const conditionIds = [...new Set(fills.map(f => f.market))];
  const enricher     = new MarketEnricher(logger);
  const marketMetas  = await enricher.fetchMetas(conditionIds);

  // ── Шаг 3: Расчёт PnL ────────────────────────────────────────────────────────
  const calc   = new PnlCalculator(logger);
  const fromDate = new Date(config.fromTs * 1000).toISOString().slice(0, 10);
  const toDate   = new Date(config.toTs   * 1000).toISOString().slice(0, 10);
  const report = calc.compute(fills, marketMetas, { fromDate, toDate });

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
