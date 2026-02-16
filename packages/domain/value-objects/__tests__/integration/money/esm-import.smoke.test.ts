import { describe, it, expect } from '@jest/globals';

/**
 * Smoke test для проверки ESM импорта @polymarket/value-objects/money
 *
 * @remarks
 * Проверяет что:
 * 1. Модуль успешно импортируется
 * 2. Все публичные экспорты доступны
 * 3. Runtime не падает при загрузке модуля
 */
describe('ESM import smoke test', () => {
  it('должен успешно импортировать все экспорты из @polymarket/value-objects/money', async () => {
    // Динамический импорт для проверки ESM
    const moneyModule = await import('../../../src/money/index.js');

    // Проверяем что все основные экспорты присутствуют
    expect(moneyModule.Money).toBeDefined();
    expect(moneyModule.MoneyService).toBeDefined();
    expect(moneyModule.MoneySerializer).toBeDefined();
    expect(moneyModule.MoneyFormatter).toBeDefined();
    expect(moneyModule.MoneyInvariantViolation).toBeDefined();

    // Проверяем validation rules
    expect(moneyModule.ValidateDivisorForMoneyDivision).toBeDefined();
    expect(moneyModule.ValidateFactorForMoneyMultiplication).toBeDefined();
    expect(moneyModule.ValidateDeltaForIncreaseBy).toBeDefined();

    // Проверяем типы/перечисления
    expect(moneyModule.MoneyErrorReason).toBeDefined();
  });

  it('должен создать Money объект без ошибок', async () => {
    const { Money } = await import('../../../src/money/index.js');
    const Decimal = (await import('decimal.js')).default;

    // Smoke test - просто проверяем что создание работает
    const money = Money.of(new Decimal(100));
    expect(money).toBeDefined();
    expect(money.toNumber()).toBe(100);
  });

  it('должен использовать MoneyService без ошибок', async () => {
    const { MoneyService } = await import('../../../src/money/index.js');

    // Smoke test - проверяем базовую операцию
    const result = MoneyService.create(100, 'USDC');
    expect(result.ok).toBe(true);
  });

  it('должен использовать MoneySerializer без ошибок', async () => {
    const { MoneySerializer, Money } = await import('../../../src/money/index.js');
    const Decimal = (await import('decimal.js')).default;

    // Smoke test - roundtrip сериализация
    const money = Money.of(new Decimal(100));
    const json = MoneySerializer.toJSON(money);
    const result = MoneySerializer.fromJSON(json);

    expect(result.ok).toBe(true);
  });
});
