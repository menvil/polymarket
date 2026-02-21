#!/usr/bin/env node

/**
 * Smoke test для проверки реального ESM импорта всех субпутей @polymarket/value-objects из dist.
 *
 * @remarks
 * Этот тест:
 * 1. Импортирует из РЕАЛЬНЫХ package subpaths (dist/{subpath}/index.js)
 * 2. Проверяет что все публичные экспорты доступны
 * 3. Выполняет базовые smoke-операции для каждого субпути
 * 4. Возвращает exit code 0 при успехе, 1 при ошибке
 *
 * ВАЖНО: Запускается ПОСЛЕ сборки (npm run build)
 * НЕ использует Jest — это чистый Node.js ESM скрипт
 */

import Decimal from 'decimal.js';

const PASS = '  ✓';
const FAIL = '  ✗';

let totalSubpaths = 0;
let passedSubpaths = 0;
const errors = [];

async function checkExports(module, names, subpath) {
  for (const name of names) {
    if (module[name] == null) {
      throw new Error(`[${subpath}] Missing export: ${name}`);
    }
    console.log(`${PASS} ${name}`);
  }
}

async function testSubpath(name, fn) {
  totalSubpaths++;
  console.log(`\n[${name}]`);
  try {
    await fn();
    passedSubpaths++;
  } catch (error) {
    console.error(`${FAIL} FAILED: ${error.message}`);
    errors.push({ subpath: name, error });
  }
}

// ─── money ───────────────────────────────────────────────────────────────────
await testSubpath('money', async () => {
  const m = await import('@polymarket/value-objects/money');
  await checkExports(m, [
    'Money', 'MoneyService', 'MoneySerializer', 'MoneyFormatter',
    'MoneyInvariantViolation', 'MoneyErrorReason',
    'ValidateDivisorForMoneyDivision', 'ValidateFactorForMoneyMultiplication',
    'ValidateDeltaForIncreaseBy',
  ], 'money');

  const money = m.Money.of(new Decimal(100));
  if (money.toNumber() !== 100) throw new Error('Money.of() returned wrong value');
  console.log(`${PASS} Money.of() works`);

  const createResult = m.MoneyService.create(100, 'USDC');
  if (!createResult.ok) throw new Error(`MoneyService.create() failed: ${createResult.error.message}`);
  console.log(`${PASS} MoneyService.create() works`);

  const json = m.MoneySerializer.toJSON(money);
  const fromJson = m.MoneySerializer.fromJSON(json);
  if (!fromJson.ok) throw new Error(`MoneySerializer roundtrip failed: ${fromJson.error.message}`);
  console.log(`${PASS} MoneySerializer roundtrip works`);
});

// ─── price ───────────────────────────────────────────────────────────────────
await testSubpath('price', async () => {
  const m = await import('@polymarket/value-objects/price');
  await checkExports(m, [
    'Price', 'PriceService', 'PriceSerializer', 'PriceFormatter',
    'PriceInvariantViolation', 'PriceErrorReason',
  ], 'price');

  const result = m.PriceService.create(0.5);
  if (!result.ok) throw new Error(`PriceService.create() failed: ${result.error.message}`);
  console.log(`${PASS} PriceService.create() works`);

  const json = m.PriceSerializer.toJSON(result.value);
  const fromJson = m.PriceSerializer.fromJSON(json);
  if (!fromJson.ok) throw new Error(`PriceSerializer roundtrip failed: ${fromJson.error.message}`);
  console.log(`${PASS} PriceSerializer roundtrip works`);
});

// ─── quantity ─────────────────────────────────────────────────────────────────
await testSubpath('quantity', async () => {
  const m = await import('@polymarket/value-objects/quantity');
  await checkExports(m, [
    'Quantity', 'QuantityService', 'QuantitySerializer', 'QuantityFormatter',
    'QuantityInvariantViolation', 'QuantityErrorReason',
  ], 'quantity');

  const result = m.QuantityService.create(10);
  if (!result.ok) throw new Error(`QuantityService.create() failed: ${result.error.message}`);
  console.log(`${PASS} QuantityService.create() works`);

  const json = m.QuantitySerializer.toJSON(result.value);
  const fromJson = m.QuantitySerializer.fromJSON(json);
  if (!fromJson.ok) throw new Error(`QuantitySerializer roundtrip failed: ${fromJson.error.message}`);
  console.log(`${PASS} QuantitySerializer roundtrip works`);
});

// ─── ratio ───────────────────────────────────────────────────────────────────
await testSubpath('ratio', async () => {
  const m = await import('@polymarket/value-objects/ratio');
  await checkExports(m, [
    'Ratio', 'RatioService', 'RatioSerializer', 'RatioFormatter',
    'RatioInvariantViolation', 'RatioErrorReason',
    'ValidateRatioGteMinusOne', 'ValidateRatioLteOne',
  ], 'ratio');

  // RatioService использует fromDecimal / fromPercent / fromBps (не create)
  const result = m.RatioService.fromDecimal(0.5);
  if (!result.ok) throw new Error(`RatioService.fromDecimal() failed: ${result.error.message}`);
  console.log(`${PASS} RatioService.fromDecimal() works`);

  const json = m.RatioSerializer.toJSON(result.value);
  const fromJson = m.RatioSerializer.fromJSON(json);
  if (!fromJson.ok) throw new Error(`RatioSerializer roundtrip failed: ${fromJson.error.message}`);
  console.log(`${PASS} RatioSerializer roundtrip works`);
});

// ─── spread ──────────────────────────────────────────────────────────────────
await testSubpath('spread', async () => {
  const m = await import('@polymarket/value-objects/spread');
  await checkExports(m, [
    'Spread', 'SpreadService', 'SpreadSerializer', 'SpreadFormatter',
    'SpreadInvariantViolation', 'SpreadErrorReason',
    'ValidateBidAsk', 'ValidateMinWidth', 'ValidateMaxWidth',
  ], 'spread');

  // SpreadService.create принимает Price объекты, получаем их из subpath price
  const priceMod = await import('@polymarket/value-objects/price');
  const bidResult = priceMod.PriceService.create(0.45);
  const askResult = priceMod.PriceService.create(0.55);
  if (!bidResult.ok) throw new Error(`PriceService.create(bid) failed: ${bidResult.error.message}`);
  if (!askResult.ok) throw new Error(`PriceService.create(ask) failed: ${askResult.error.message}`);

  // SpreadService.create принимает два Price объекта позиционно, не как объект
  const result = m.SpreadService.create(bidResult.value, askResult.value);
  if (!result.ok) throw new Error(`SpreadService.create() failed: ${result.error.message}`);
  console.log(`${PASS} SpreadService.create() works`);

  const json = m.SpreadSerializer.toJSON(result.value);
  const fromJson = m.SpreadSerializer.fromJSON(json);
  if (!fromJson.ok) throw new Error(`SpreadSerializer roundtrip failed: ${fromJson.error.message}`);
  console.log(`${PASS} SpreadSerializer roundtrip works`);
});

// ─── balance ─────────────────────────────────────────────────────────────────
await testSubpath('balance', async () => {
  const m = await import('@polymarket/value-objects/balance');
  await checkExports(m, [
    'Balance', 'BalanceService', 'BalanceSerializer', 'BalanceFormatter',
    'BalanceInvariantViolation', 'BalanceErrorReason',
    'ValidateReserveAmount', 'ValidateReleaseAmount', 'ValidateCurrencyMatch',
  ], 'balance');

  // BalanceService.create принимает (AccountId, VenueId, Money)
  // AccountId и VenueId — branded типы из @polymarket/ids (runtime = plain object/string)
  const moneyMod = await import('@polymarket/value-objects/money');
  const moneyResult = moneyMod.MoneyService.create(100, 'USDC');
  if (!moneyResult.ok) throw new Error(`MoneyService.create() failed: ${moneyResult.error.message}`);

  // BalanceService.create(available, reserved, accountId, venueId)
  const reservedResult = moneyMod.MoneyService.create(0, 'USDC');
  if (!reservedResult.ok) throw new Error(`MoneyService.create(0) failed: ${reservedResult.error.message}`);
  const accountId = { kind: 'WALLET', address: '0x1234567890123456789012345678901234567890' };
  const venueId = 'POLYMARKET';
  const result = m.BalanceService.create(moneyResult.value, reservedResult.value, accountId, venueId);
  if (!result.ok) throw new Error(`BalanceService.create() failed: ${result.error.message}`);
  console.log(`${PASS} BalanceService.create() works`);

  const json = m.BalanceSerializer.toJSON(result.value);
  const fromJson = m.BalanceSerializer.fromJSON(json);
  if (!fromJson.ok) throw new Error(`BalanceSerializer roundtrip failed: ${fromJson.error.message}`);
  console.log(`${PASS} BalanceSerializer roundtrip works`);
});

// ─── quote ───────────────────────────────────────────────────────────────────
await testSubpath('quote', async () => {
  const m = await import('@polymarket/value-objects/quote');
  await checkExports(m, [
    'Quote', 'QuoteService', 'QuoteSerializer', 'QuoteFormatter',
    'QuoteInvariantViolation', 'QuoteErrorReason',
    'ValidateQuoteSizes', 'ValidateMinSpread', 'ValidateMaxSpread', 'ValidateMarketCrossing',
  ], 'quote');

  // QuoteService.create(bidValue, askValue, bidSizeValue, askSizeValue, sourceId, instrumentId)
  // принимает сырые числа + branded string ID (runtime = plain string)
  const sourceId = 'POLYMARKET';
  const instrumentId = '12345678901234567890123456789012345678901234567890';
  const result = m.QuoteService.create(0.45, 0.55, 100, 100, sourceId, instrumentId);
  if (!result.ok) throw new Error(`QuoteService.create() failed: ${result.error.message}`);
  console.log(`${PASS} QuoteService.create() works`);

  const json = m.QuoteSerializer.toJSON(result.value);
  const fromJson = m.QuoteSerializer.fromJSON(json);
  if (!fromJson.ok) throw new Error(`QuoteSerializer roundtrip failed: ${fromJson.error.message}`);
  console.log(`${PASS} QuoteSerializer roundtrip works`);
});

// ─── asset-quantity ──────────────────────────────────────────────────────────
await testSubpath('asset-quantity', async () => {
  const m = await import('@polymarket/value-objects/asset-quantity');
  await checkExports(m, [
    'AssetQuantity', 'AssetQuantityService', 'AssetQuantitySerializer', 'AssetQuantityFormatter',
    'AssetQuantityErrorReason',
  ], 'asset-quantity');

  // AssetQuantityService использует createUsdc / createOutcomeToken (не currency)
  const result = m.AssetQuantityService.createUsdc(50);
  if (!result.ok) throw new Error(`AssetQuantityService.createUsdc() failed: ${result.error.message}`);
  console.log(`${PASS} AssetQuantityService.createUsdc() works`);

  const json = m.AssetQuantitySerializer.toJSON(result.value);
  const fromJson = m.AssetQuantitySerializer.fromJSON(json);
  if (!fromJson.ok) throw new Error(`AssetQuantitySerializer roundtrip failed: ${fromJson.error.message}`);
  console.log(`${PASS} AssetQuantitySerializer roundtrip works`);
});

// ─── outcome-token ───────────────────────────────────────────────────────────
await testSubpath('outcome-token', async () => {
  const m = await import('@polymarket/value-objects/outcome-token');
  await checkExports(m, [
    'OutcomeToken', 'OutcomeTokenService', 'OutcomeTokenSerializer', 'OutcomeTokenFormatter',
    'OutcomeTokenInvariantViolation',
  ], 'outcome-token');
  console.log(`${PASS} All exports available`);
});

// ─── token-balance ───────────────────────────────────────────────────────────
await testSubpath('token-balance', async () => {
  const m = await import('@polymarket/value-objects/token-balance');
  await checkExports(m, [
    'TokenBalance', 'TokenBalanceService', 'TokenBalanceSerializer', 'TokenBalanceFormatter',
    'TokenBalanceInvariantViolation', 'TokenBalanceErrorReason', 'InvalidTokenBalanceError',
    'ValidateReserveAmount', 'ValidateReleaseAmount', 'ValidateTokenMatch',
  ], 'token-balance');
  console.log(`${PASS} All exports available`);
});

// ─── main export (.) ─────────────────────────────────────────────────────────
await testSubpath('main (.)', async () => {
  const m = await import('@polymarket/value-objects');
  await checkExports(m, [
    'Money', 'MoneyService', 'Price', 'PriceService',
    'Quantity', 'QuantityService', 'Ratio', 'RatioService',
    'Spread', 'SpreadService', 'Balance', 'BalanceService',
    'Quote', 'QuoteService', 'AssetQuantity', 'AssetQuantityService',
    'OutcomeToken', 'TokenBalance', 'TokenBalanceService',
  ], '.');
});

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passedSubpaths}/${totalSubpaths} subpaths passed`);

if (errors.length > 0) {
  console.error('\n❌ Smoke test FAILED:');
  for (const { subpath, error } of errors) {
    console.error(`  [${subpath}] ${error.message}`);
  }
  process.exit(1);
}

console.log('\n✅ All smoke tests passed!');
