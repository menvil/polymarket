/**
 * Создаёт Builder API keys через Polymarket CLOB API.
 * Builder keys нужны для gasless redeem через Builder Relayer.
 *
 * @example
 * ```bash
 * npx tsx scripts/setup-builder-keys.ts
 * ```
 *
 * @remarks
 * Требует PRIVATE_KEY, POLYMARKET_API_KEY, POLYMARKET_API_SECRET,
 * POLYMARKET_API_PASSPHRASE в .env
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ClobClient } from '@polymarket/clob-client';

// Load .env
try {
  const envContent = readFileSync(resolve(import.meta.dirname ?? '.', '..', '.env'), 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
} catch { /* .env не найден */ }

async function main(): Promise<void> {
  const privateKey = process.env['PRIVATE_KEY'];
  const apiKey = process.env['POLYMARKET_API_KEY'];
  const apiSecret = process.env['POLYMARKET_API_SECRET'];
  const passphrase = process.env['POLYMARKET_API_PASSPHRASE'];

  if (!privateKey || !apiKey || !apiSecret || !passphrase) {
    console.error('Missing env vars: PRIVATE_KEY, POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE');
    process.exit(1);
  }

  console.log('Creating CLOB client...');
  const client = new ClobClient(
    'https://clob.polymarket.com',
    137,
    privateKey as `0x${string}`,
    {
      key: apiKey,
      secret: apiSecret,
      passphrase: passphrase,
    },
  );

  console.log('Creating Builder API keys...');
  try {
    const builderKeys = await (client as any).createBuilderApiKey();
    console.log('\n=== BUILDER API KEYS ===');
    console.log('Add these to your .env file:\n');
    console.log(`BUILDER_API_KEY=${builderKeys.apiKey}`);
    console.log(`BUILDER_API_SECRET=${builderKeys.secret}`);
    console.log(`BUILDER_API_PASSPHRASE=${builderKeys.passphrase}`);
    console.log('\n========================');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Failed to create Builder keys:', msg);

    // Try to list existing builder keys
    console.log('\nTrying to derive builder keys...');
    try {
      const keys = await (client as any).deriveBuilderApiKey();
      console.log('\n=== DERIVED BUILDER API KEYS ===');
      console.log(`BUILDER_API_KEY=${keys.apiKey}`);
      console.log(`BUILDER_API_SECRET=${keys.secret}`);
      console.log(`BUILDER_API_PASSPHRASE=${keys.passphrase}`);
    } catch (err2) {
      console.error('Also failed to derive:', err2 instanceof Error ? err2.message : String(err2));
      console.log('\nYou may need to register as a Builder at https://docs.polymarket.com/developers/builders/builder-intro');
    }
  }
}

main().catch(console.error);
