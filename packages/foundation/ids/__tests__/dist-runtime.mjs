/**
 * Runtime test для проверки собранного пакета (dist/)
 *
 * @remarks
 * Этот тест НЕ запускается через jest, т.к. jest подменяет импорты на source.
 * Запускается напрямую через Node.js после build для проверки:
 * - ESM runtime работоспособности
 * - Корректности exports в package.json
 * - Отсутствия broken imports в собранном коде
 *
 * ⚠️ ВАЖНО: Требует чтобы зависимости были собраны!
 * Перед запуском убедись что @polymarket/result имеет dist/ с правильными ESM exports.
 *
 * Запуск вручную: npm run test:dist
 * Запуск всех тестов: npm run test:all
 */

import assert from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distPath = resolve(__dirname, '../dist');

console.log('🧪 Testing runtime import from dist/...');

try {

// Test core exports
console.log('  ✓ Importing core exports...');
const coreModule = await import(pathToFileURL(`${distPath}/core/index.js`).href);

// Check essential types and functions exist
assert(typeof coreModule.parseWalletAddress === 'function', 'parseWalletAddress should be exported');
assert(typeof coreModule.accountIdFromWallet === 'function', 'accountIdFromWallet should be exported');
assert(typeof coreModule.parseAccountId === 'function', 'parseAccountId should be exported');
assert(typeof coreModule.parseConditionId === 'function', 'parseConditionId should be exported');
assert(typeof coreModule.asVenueId === 'function', 'asVenueId should be exported');

// Test execution exports
console.log('  ✓ Importing execution exports...');
const executionModule = await import(pathToFileURL(`${distPath}/execution/index.js`).href);

assert(typeof executionModule.asExecutionVenueId === 'function', 'asExecutionVenueId should be exported');
assert(typeof executionModule.asOrderId === 'function', 'asOrderId should be exported');
assert(typeof executionModule.asFillId === 'function', 'asFillId should be exported');
assert(executionModule.SIMULATOR === 'SIMULATOR', 'SIMULATOR constant should be exported');

// Test market-data exports
console.log('  ✓ Importing market-data exports...');
const marketDataModule = await import(pathToFileURL(`${distPath}/market-data/index.js`).href);

assert(typeof marketDataModule.asMarketDataSourceId === 'function', 'asMarketDataSourceId should be exported');
assert(typeof marketDataModule.asInstrumentId === 'function', 'asInstrumentId should be exported');
assert(typeof marketDataModule.sourceToVenue === 'function', 'sourceToVenue should be exported');

// Test main barrel export (flat exports, not namespaces)
console.log('  ✓ Importing main barrel export...');
const mainModule = await import(pathToFileURL(`${distPath}/index.js`).href);

// Barrel export использует export * (flat), не namespace объекты
// Проверяем что ключевые exports доступны
assert(typeof mainModule.parseWalletAddress === 'function', 'parseWalletAddress should be exported from barrel');
assert(typeof mainModule.asExecutionVenueId === 'function', 'asExecutionVenueId should be exported from barrel');
assert(typeof mainModule.asMarketDataSourceId === 'function', 'asMarketDataSourceId should be exported from barrel');

// Test actual functionality (smoke test)
console.log('  ✓ Testing actual functionality...');

// Test WalletAddress parsing (40 hex chars после 0x, case-insensitive input)
const wallet = coreModule.parseWalletAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
assert(wallet !== undefined, 'parseWalletAddress should parse valid address');
assert(wallet === '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 'should return lowercase canonical format');

// Test AccountId creation
const accountId = coreModule.accountIdFromWallet(wallet);
assert(accountId.kind === 'WALLET', 'accountIdFromWallet should create WALLET account');
assert(accountId.address === wallet, 'address should match');

// Test serialization round-trip
const serialized = coreModule.accountIdToString(accountId);
assert(serialized === `wallet:${wallet}`, 'accountIdToString should produce correct format');

const parsed = coreModule.parseAccountId(serialized);
assert(parsed !== undefined, 'parseAccountId should parse serialized string');
assert(coreModule.accountIdEquals(accountId, parsed), 'round-trip should preserve equality');

// Test VenueId
// asVenueId принимает любой валидный формат (известные + custom venues)
const venueId = coreModule.asVenueId('POLYMARKET');
assert(venueId === 'POLYMARKET', 'asVenueId should accept known venue');
assert(coreModule.asVenueId('MY_CUSTOM_VENUE') !== undefined, 'asVenueId should accept custom venues with valid format');
assert(coreModule.asVenueId('invalid-venue') === undefined, 'asVenueId should reject venues with invalid format (lowercase/dash)');

// Test execution parsers
const orderId = executionModule.asOrderId('order-123');
assert(orderId === 'order-123', 'asOrderId should accept valid id');
assert(executionModule.asOrderId('') === undefined, 'asOrderId should reject empty string');

const fillId = executionModule.asFillId('fill-456');
assert(fillId === 'fill-456', 'asFillId should accept valid id');
assert(executionModule.asFillId('') === undefined, 'asFillId should reject empty string');

// Test market-data parsers
const instrumentId = marketDataModule.asInstrumentId('BTC-USD');
assert(instrumentId === 'BTC-USD', 'asInstrumentId should accept valid id');
assert(marketDataModule.asInstrumentId('') === undefined, 'asInstrumentId should reject empty string');

  console.log('\n✅ All runtime tests passed!');
  console.log('   ESM imports work correctly');
  console.log('   Public API is functional');
  console.log('   Round-trip serialization works');
} catch (err) {
  console.error('\n❌ Runtime test failed:', err.message);
  process.exitCode = 1;
}
