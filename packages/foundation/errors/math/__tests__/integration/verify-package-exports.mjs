#!/usr/bin/env node

/**
 * Скрипт для проверки реального package.json exports контракта.
 *
 * Этот скрипт импортирует пакет через Node.js module resolution,
 * проверяя что dist/ exports работают корректно.
 *
 * @usage
 * ```bash
 * npm run test:exports  # Автоматически собирает через pretest:exports
 * ```
 *
 * @remarks
 * В отличие от exports.test.ts (который импортирует из src/),
 * этот скрипт проверяет:
 * - Корректность package.json exports map
 * - Сборку в dist/
 * - Реальный package contract как после публикации
 *
 * ВАЖНО: Запускается через npm run test:exports, который имеет
 * pretest:exports хук для автоматической сборки. Это гарантирует
 * стабильность на чистом workspace без заранее собранного dist/.
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
    // Arithmetic operations
    'addDecimal',
    'subtractDecimal',
    'multiplyDecimal',
    'divideDecimal',
    'averageDecimal',
    // Comparison operations
    'compareDecimal',
    'equalsDecimal',
    'lessThanDecimal',
    'lessThanOrEqualDecimal',
    'greaterThanDecimal',
    'greaterThanOrEqualDecimal',
    // Rounding operations - decimal
    'roundDecimal',
    'roundTowardZeroDecimal',
    'roundAwayFromZeroDecimal',
    'truncDecimal',
    'mathFloorDecimal',
    'mathCeilDecimal',
    // Rounding operations - tick
    'roundToTick',
    'floorToTick',
    'ceilToTick',
    'mathFloorToTick',
    'mathCeilToTick',
    'roundToPrecision',
    // Validation
    'isFiniteDecimal',
    'isPositiveDecimal',
    'isNonNegativeDecimal',
    'isZeroDecimal',
    // Constants
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
    'averageDecimal',
    'compareDecimal',
    'equalsDecimal',
    'lessThanDecimal',
    'lessThanOrEqualDecimal',
    'greaterThanDecimal',
    'greaterThanOrEqualDecimal',
    'roundDecimal',
    'roundTowardZeroDecimal',
    'roundAwayFromZeroDecimal',
    'truncDecimal',
    'mathFloorDecimal',
    'mathCeilDecimal',
  ],
  'Subpath ./decimal'
);

await verifyExport(
  '@polymarket/math/rounding',
  [
    'roundToTick',
    'floorToTick',
    'ceilToTick',
    'mathFloorToTick',
    'mathCeilToTick',
    'roundToPrecision',
  ],
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
  } else if (!MATH_CONSTANTS.HUNDRED) {
    console.error('❌ MATH_CONSTANTS.HUNDRED отсутствует');
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
