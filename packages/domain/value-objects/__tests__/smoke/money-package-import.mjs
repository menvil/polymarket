#!/usr/bin/env node

/**
 * Smoke test для проверки реального ESM импорта @polymarket/value-objects/money из dist
 *
 * @remarks
 * Этот тест:
 * 1. Импортирует из РЕАЛЬНОГО package subpath (dist/money/index.js)
 * 2. Проверяет что все публичные экспорты доступны
 * 3. Проверяет базовые операции
 * 4. Возвращает exit code 0 при успехе, 1 при ошибке
 *
 * ВАЖНО: Запускается ПОСЛЕ сборки (npm run build)
 * НЕ использует Jest - это чистый Node.js скрипт
 */

import Decimal from 'decimal.js';

console.log('🔍 Starting smoke test for @polymarket/value-objects/money package import...\n');

async function runSmokeTest() {
  try {
    // 1. Импортируем из РЕАЛЬНОГО package subpath (через exports в package.json)
    console.log('Step 1: Importing from @polymarket/value-objects/money');
    const moneyModule = await import('@polymarket/value-objects/money');

    // 2. Проверяем что все основные экспорты присутствуют
    console.log('Step 2: Checking core exports...');
    const requiredExports = [
      'Money',
      'MoneyService',
      'MoneySerializer',
      'MoneyFormatter',
      'MoneyInvariantViolation',
      'ValidateDivisorForMoneyDivision',
      'ValidateFactorForMoneyMultiplication',
      'ValidateDeltaForIncreaseBy',
      'MoneyErrorReason',
    ];

    for (const exportName of requiredExports) {
      if (!moneyModule[exportName]) {
        throw new Error(`Missing export: ${exportName}`);
      }
      console.log(`  ✓ ${exportName}`);
    }

    // 3. Проверяем что Money.of() работает
    console.log('\nStep 3: Testing Money.of()...');
    const { Money } = moneyModule;
    const money = Money.of(new Decimal(100));
    if (money.toNumber() !== 100) {
      throw new Error(`Expected money.toNumber() to be 100, got ${money.toNumber()}`);
    }
    console.log('  ✓ Money.of() works');

    // 4. Проверяем MoneyService.create()
    console.log('\nStep 4: Testing MoneyService.create()...');
    const { MoneyService } = moneyModule;
    const result = MoneyService.create(100, 'USDC');
    if (!result.ok) {
      throw new Error(`MoneyService.create() failed: ${result.error.message}`);
    }
    console.log('  ✓ MoneyService.create() works');

    // 5. Проверяем MoneySerializer roundtrip
    console.log('\nStep 5: Testing MoneySerializer roundtrip...');
    const { MoneySerializer } = moneyModule;
    const json = MoneySerializer.toJSON(money);
    const deserializeResult = MoneySerializer.fromJSON(json);
    if (!deserializeResult.ok) {
      throw new Error(
        `MoneySerializer.fromJSON() failed: ${deserializeResult.error.message}`
      );
    }
    if (deserializeResult.value.toNumber() !== 100) {
      throw new Error(
        `Expected deserialized value to be 100, got ${deserializeResult.value.toNumber()}`
      );
    }
    console.log('  ✓ MoneySerializer roundtrip works');

    // 6. Проверяем validation rules
    console.log('\nStep 6: Testing validation rules...');
    const { ValidateDivisorForMoneyDivision } = moneyModule;
    const validationResult = ValidateDivisorForMoneyDivision.check(new Decimal(2));
    if (!validationResult.ok) {
      throw new Error('ValidateDivisorForMoneyDivision.check() should return Ok for valid divisor');
    }
    console.log('  ✓ Validation rules work');

    console.log('\n✅ All smoke tests passed!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Smoke test failed:');
    console.error(error);
    process.exit(1);
  }
}

runSmokeTest();
