/**
 * Создаёт Builder API keys через Polymarket CLOB API (`POST /auth/builder-api-key`).
 *
 * Обходит баг clob-client с ethers v6 (ожидает `_signTypedData` от ethers v5),
 * вызывая эндпоинт напрямую через fetch с L2-заголовками (HMAC).
 *
 * @example
 * ```bash
 * npx tsx scripts/create-builder-keys.ts
 * ```
 *
 * @remarks
 * Требует PRIVATE_KEY, POLYMARKET_API_KEY, POLYMARKET_API_SECRET,
 * POLYMARKET_API_PASSPHRASE в .env
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ethers } from 'ethers';
import { createHmac } from 'crypto';

// --- Загрузка .env ---
try {
  const envContent = readFileSync(resolve(import.meta.dirname ?? '.', '..', '.env'), 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
} catch { /* .env не найден */ }

const CLOB_HOST = 'https://clob.polymarket.com';

/**
 * Строит HMAC-SHA256 подпись в стиле Polymarket.
 *
 * @param secret - Base64-кодированный секрет API
 * @param timestamp - Unix timestamp в секундах
 * @param method - HTTP метод (GET, POST, DELETE)
 * @param requestPath - Путь запроса (например `/auth/builder-api-key`)
 * @param body - Тело запроса (опционально)
 * @returns URL-safe base64 подпись
 */
function buildPolyHmacSignature(
  secret: string,
  timestamp: number,
  method: string,
  requestPath: string,
  body?: string,
): string {
  let message = `${timestamp}${method}${requestPath}`;
  if (body !== undefined) {
    message += body;
  }
  const base64Secret = Buffer.from(secret, 'base64');
  const hmac = createHmac('sha256', base64Secret);
  const sig = hmac.update(message).digest('base64');
  return sig.replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Строит L2-заголовки для авторизации в CLOB API.
 *
 * @param address - Ethereum адрес кошелька
 * @param creds - CLOB API credentials (key, secret, passphrase)
 * @param method - HTTP метод
 * @param path - Путь запроса
 * @param body - Тело запроса (опционально)
 * @returns Объект заголовков
 */
function buildL2Headers(
  address: string,
  creds: { key: string; secret: string; passphrase: string },
  method: string,
  path: string,
  body?: string,
): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  const sig = buildPolyHmacSignature(creds.secret, ts, method, path, body);
  return {
    POLY_ADDRESS: address,
    POLY_SIGNATURE: sig,
    POLY_TIMESTAMP: `${ts}`,
    POLY_API_KEY: creds.key,
    POLY_PASSPHRASE: creds.passphrase,
  };
}

async function main(): Promise<void> {
  const privateKey = process.env['PRIVATE_KEY'];
  const apiKey = process.env['POLYMARKET_API_KEY'];
  const apiSecret = process.env['POLYMARKET_API_SECRET'];
  const passphrase = process.env['POLYMARKET_API_PASSPHRASE'];

  if (!privateKey || !apiKey || !apiSecret || !passphrase) {
    console.error('Missing env vars: PRIVATE_KEY, POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE');
    process.exit(1);
  }

  const wallet = new ethers.Wallet(privateKey);
  const address = await wallet.getAddress();
  console.log(`Wallet address: ${address}`);

  const creds = { key: apiKey, secret: apiSecret, passphrase };

  // --- Шаг 1: проверяем существующие builder keys ---
  console.log('\nChecking existing builder keys...');
  const getPath = '/auth/builder-api-key';
  const getHeaders = buildL2Headers(address, creds, 'GET', getPath);

  const getRes = await fetch(`${CLOB_HOST}${getPath}`, {
    method: 'GET',
    headers: getHeaders,
  });

  if (getRes.ok) {
    const existing = await getRes.json();
    console.log('Existing builder keys:', JSON.stringify(existing, null, 2));
    if (Array.isArray(existing) && existing.length > 0) {
      console.log('\nYou already have builder keys. Secret/passphrase are only shown at creation time.');
      console.log('If you need new ones, this script will create additional keys below.');
    }
  } else {
    const errText = await getRes.text();
    console.log(`GET builder keys: ${getRes.status} ${errText}`);
  }

  // --- Шаг 2: создаём новый builder API key ---
  console.log('\nCreating new builder API key...');
  const postPath = '/auth/builder-api-key';
  const postHeaders = buildL2Headers(address, creds, 'POST', postPath);

  const postRes = await fetch(`${CLOB_HOST}${postPath}`, {
    method: 'POST',
    headers: {
      ...postHeaders,
      'Content-Type': 'application/json',
    },
  });

  if (postRes.ok) {
    const builderKeys = await postRes.json();
    console.log('\n=== BUILDER API KEYS (SAVE THESE!) ===');
    console.log('Add to your .env file:\n');
    console.log(`BUILDER_API_KEY=${builderKeys.apiKey ?? builderKeys.key}`);
    console.log(`BUILDER_API_SECRET=${builderKeys.secret}`);
    console.log(`BUILDER_API_PASSPHRASE=${builderKeys.passphrase}`);
    console.log('\n======================================');
    console.log('\nFull response:', JSON.stringify(builderKeys, null, 2));
  } else {
    const errText = await postRes.text();
    console.error(`Failed to create builder keys: ${postRes.status} ${errText}`);

    if (postRes.status === 401) {
      console.log('\n401 = invalid L2 auth. Verify POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE are correct.');
    } else if (postRes.status === 403) {
      console.log('\n403 = you may need to register as a Builder at https://polymarket.com/settings?tab=builder');
    }
  }
}

main().catch(console.error);
