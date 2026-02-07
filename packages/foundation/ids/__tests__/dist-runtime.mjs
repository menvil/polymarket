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
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distPath = resolve(__dirname, '../dist');

console.log('🧪 Testing runtime import from dist/...');

// Test core exports
console.log('  ✓ Importing core exports...');
const coreModule = await import(`${distPath}/core/index.js`);

// Check essential types and functions exist
assert(typeof coreModule.parseWalletAddress === 'function', 'parseWalletAddress should be exported');
assert(typeof coreModule.accountIdFromWallet === 'function', 'accountIdFromWallet should be exported');
assert(typeof coreModule.parseAccountId === 'function', 'parseAccountId should be exported');
assert(typeof coreModule.parseConditionId === 'function', 'parseConditionId should be exported');
assert(typeof coreModule.asVenueId === 'function', 'asVenueId should be exported');

// Test execution exports
console.log('  ✓ Importing execution exports...');
const executionModule = await import(`${distPath}/execution/index.js`);

assert(typeof executionModule.asExecutionVenueId === 'function', 'asExecutionVenueId should be exported');
assert(typeof executionModule.asOrderId === 'function', 'asOrderId should be exported');
assert(typeof executionModule.asFillId === 'function', 'asFillId should be exported');
assert(executionModule.SIMULATOR === 'SIMULATOR', 'SIMULATOR constant should be exported');

// Test market-data exports
console.log('  ✓ Importing market-data exports...');
const marketDataModule = await import(`${distPath}/market-data/index.js`);

assert(typeof marketDataModule.asMarketDataSourceId === 'function', 'asMarketDataSourceId should be exported');
assert(typeof marketDataModule.asInstrumentId === 'function', 'asInstrumentId should be exported');
assert(typeof marketDataModule.sourceToVenue === 'function', 'sourceToVenue should be exported');

// Test main barrel export
console.log('  ✓ Importing main barrel export...');
const mainModule = await import(`${distPath}/index.js`);

assert(mainModule.core !== undefined, 'core namespace should be exported');
assert(mainModule.execution !== undefined, 'execution namespace should be exported');
assert(mainModule.marketData !== undefined, 'marketData namespace should be exported');

// Test actual functionality (smoke test)
console.log('  ✓ Testing actual functionality...');

// Test WalletAddress parsing
const wallet = coreModule.parseWalletAddress('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb');
assert(wallet !== undefined, 'parseWalletAddress should parse valid address');
assert(wallet === '0x742d35cc6634c0532925a3b844bc9e7595f0beb', 'should return lowercase canonical format');

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
const venueId = coreModule.asVenueId('POLYMARKET');
assert(venueId === 'POLYMARKET', 'asVenueId should accept known venue');
assert(coreModule.asVenueId('UNKNOWN') === undefined, 'asVenueId should reject unknown venue');

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
