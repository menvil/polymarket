#!/usr/bin/env node

/**
 * Скрипт для проверки реального package.json exports контракта.
 *
 * Этот скрипт импортирует пакет через Node.js module resolution,
 * проверяя что dist/ exports работают корректно.
 *
 * @usage
 * ```bash
 * npm run build  # Сначала собрать пакет
 * node __tests__/integration/verify-package-exports.mjs
 * ```
 *
 * @remarks
 * В отличие от exports.test.ts (который импортирует из src/),
 * этот скрипт проверяет:
 * - Корректность package.json exports map
 * - Сборку в dist/
 * - Реальный package contract как после публикации
 */

console.log('🔍 Проверка package exports контракта...\n');

let failures = 0;

/**
 * Проверяет, что импорт работает и экспортирует ожидаемые функции
 */
async function verifyExport(modulePath, expectedExports, description) {
  try {
    const module = await import(modulePath);

    // Проверяем наличие всех ожидаемых экспортов
    const missing = expectedExports.filter((name) => !(name in module));

    if (missing.length > 0) {
      console.error(`❌ ${description}: отсутствуют exports: ${missing.join(', ')}`);
      failures++;
    } else {
      console.log(`✅ ${description}: все exports найдены (${expectedExports.length})`);
    }
  } catch (error) {
    console.error(`❌ ${description}: ошибка импорта`);
    console.error(`   ${error.message}`);
    failures++;
  }
}

// Проверяем root exports
await verifyExport(
  '@polymarket/math',
  [
    'addDecimal',
    'subtractDecimal',
    'multiplyDecimal',
    'divideDecimal',
    'averageDecimal',
    'compareDecimal',
    'equalsDecimal',
    'roundDecimal',
    'mathFloorDecimal',
    'mathCeilDecimal',
    'roundToTick',
    'roundToPrecision',
    'isFiniteDecimal',
    'isPositiveDecimal',
    'isNonNegativeDecimal',
    'isZeroDecimal',
    'MATH_CONSTANTS',
  ],
  'Root exports (@polymarket/math)'
);

// Проверяем subpath exports
await verifyExport(
  '@polymarket/math/decimal',
  [
    'addDecimal',
    'subtractDecimal',
    'multiplyDecimal',
    'divideDecimal',
    'mathFloorDecimal',
    'mathCeilDecimal',
  ],
  'Subpath ./decimal'
);

await verifyExport(
  '@polymarket/math/rounding',
  ['roundToTick', 'roundToPrecision', 'mathFloorToTick', 'mathCeilToTick'],
  'Subpath ./rounding'
);

await verifyExport(
  '@polymarket/math/validation',
  ['isFiniteDecimal', 'isPositiveDecimal', 'isNonNegativeDecimal', 'isZeroDecimal'],
  'Subpath ./validation'
);

// Проверяем, что функции действительно функции
try {
  const { addDecimal, MATH_CONSTANTS } = await import('@polymarket/math');

  if (typeof addDecimal !== 'function') {
    console.error('❌ addDecimal не является функцией');
    failures++;
  }

  if (typeof MATH_CONSTANTS !== 'object' || MATH_CONSTANTS === null) {
    console.error('❌ MATH_CONSTANTS не является объектом');
    failures++;
  } else if (typeof MATH_CONSTANTS.ZERO?.toString !== 'function') {
    console.error('❌ MATH_CONSTANTS.ZERO не является Decimal');
    failures++;
  } else {
    console.log('✅ Типы экспортов корректны (function/object)');
  }
} catch (error) {
  console.error('❌ Ошибка при проверке типов');
  console.error(`   ${error.message}`);
  failures++;
}

// Итоги
console.log('\n' + '='.repeat(60));
if (failures === 0) {
  console.log('✅ Все проверки пройдены! Package exports работают корректно.');
  process.exit(0);
} else {
  console.error(`❌ Обнаружено ${failures} ошибок в package exports.`);
  console.error('\nВозможные причины:');
  console.error('- Пакет не собран (запустите: npm run build)');
  console.error('- Неправильная package.json exports map');
  console.error('- Отсутствующие файлы в dist/');
  process.exit(1);
}
