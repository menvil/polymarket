/**
 * Тест фонового авто-клейма: однократный запуск проверки.
 *
 * @example
 * ```bash
 * npx tsx scripts/test-auto-redeem.ts
 * ```
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Загружаем .env
try {
  const envPath = resolve(import.meta.dirname ?? '.', '..', '.env');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
} catch { /* .env не найден */ }

import { AutoRedeemer } from '../src/bot/AutoRedeemer.js';

// Минимальный logger
const logger = {
  info: (msg: string, ctx?: any) => console.log(`[INFO] ${msg}`, ctx ?? ''),
  warn: (msg: string, ctx?: any) => console.warn(`[WARN] ${msg}`, ctx ?? ''),
  error: (msg: string, ctx?: any) => console.error(`[ERROR] ${msg}`, ctx ?? ''),
  debug: (msg: string, ctx?: any) => console.log(`[DEBUG] ${msg}`, ctx ?? ''),
  trace: () => {},
  fatal: (msg: string, ctx?: any) => console.error(`[FATAL] ${msg}`, ctx ?? ''),
  child: () => logger,
} as any;

async function main(): Promise<void> {
  console.log('Creating AutoRedeemer from env...');
  const redeemer = AutoRedeemer.fromEnv(logger);

  console.log('\nRunning single check...');
  const result = await redeemer.checkOnce();

  console.log('\n=== Result ===');
  console.log(`Markets checked: ${result.marketsChecked}`);
  console.log(`Markets settled: ${result.marketsSettled}`);
  console.log(`Redeemed:        ${result.redeemed}`);
  console.log(`Errors:          ${result.errors}`);
}

main().catch(console.error);
