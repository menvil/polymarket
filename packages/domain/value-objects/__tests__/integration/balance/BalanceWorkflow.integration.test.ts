import { describe, it, expect } from '@jest/globals';
import { BalanceService } from '../../../src/balance/facade/BalanceService.js';
import { BalanceSerializer } from '../../../src/balance/adapters/BalanceSerializer.js';
import { BalanceFormatter } from '../../../src/balance/adapters/BalanceFormatter.js';
import { Money } from '../../../src/money/core/Money.js';
import { BalanceErrorReason } from '../../../src/balance/errors/BalanceErrorReason.js';

describe('Balance Integration Tests', () => {
  describe('Полный workflow: создание → reserve → release → update', () => {
    it('сценарий торговли: создание → резервирование для ордера → освобождение после закрытия', () => {
      // Шаг 1: Создаём начальный баланс
      const createResult = BalanceService.create(
        Money.of(10000), // $10,000 доступно
        Money.of(0)      // ничего не зарезервировано
      );
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const balance1 = createResult.value;
      expect(balance1.available().value().toNumber()).toBe(10000);
      expect(balance1.reserved().value().toNumber()).toBe(0);
      expect(balance1.isZero()).toBe(false);

      // Шаг 2: Резервируем средства для открытия ордера
      const reserveResult = BalanceService.reserve(balance1, Money.of(3000));
      expect(reserveResult.ok).toBe(true);
      if (!reserveResult.ok) return;

      const balance2 = reserveResult.value;
      expect(balance2.available().value().toNumber()).toBe(7000);
      expect(balance2.reserved().value().toNumber()).toBe(3000);
      expect(balance2.total().value().toNumber()).toBe(10000);
      expect(balance2.hasReserved()).toBe(true);

      // Шаг 3: Освобождаем средства после закрытия ордера
      const releaseResult = BalanceService.unfreezeReserved(balance2, Money.of(3000));
      expect(releaseResult.ok).toBe(true);
      if (!releaseResult.ok) return;

      const balance3 = releaseResult.value;
      expect(balance3.available().value().toNumber()).toBe(10000);
      expect(balance3.reserved().value().toNumber()).toBe(0);

      // Шаг 4: Проверяем что оригинальные балансы не изменились (immutability)
      expect(balance1.available().value().toNumber()).toBe(10000);
      expect(balance2.available().value().toNumber()).toBe(7000);
    });

    it('сценарий пополнения: обновление available после депозита', () => {
      // Шаг 1: Начальный баланс с зарезервированными средствами
      const createResult = BalanceService.create(
        Money.of(5000),
        Money.of(2000)
      );
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const balance1 = createResult.value;
      const total1 = balance1.total().value().toNumber();

      // Шаг 2: Пополнение - увеличиваем available
      const newAvailable = Money.of(10000); // +$5,000
      const updateResult = BalanceService.updateAvailable(balance1, newAvailable);
      expect(updateResult.ok).toBe(true);
      if (!updateResult.ok) return;

      const balance2 = updateResult.value;
      expect(balance2.available().value().toNumber()).toBe(10000);
      expect(balance2.reserved().value().toNumber()).toBe(2000); // не изменилось
      expect(balance2.total().value().toNumber()).toBe(12000);

      // Проверка immutability
      expect(balance1.total().value().toNumber()).toBe(total1);
    });

    it('сценарий множественных резервирований (открытие нескольких ордеров)', () => {
      const createResult = BalanceService.create(Money.of(10000), Money.of(0));
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      let currentBalance = createResult.value;

      // Открываем 3 ордера, резервируя средства для каждого
      const orders = [2000, 1500, 3000];
      for (const orderAmount of orders) {
        const reserveResult = BalanceService.reserve(currentBalance, Money.of(orderAmount));
        expect(reserveResult.ok).toBe(true);
        if (!reserveResult.ok) return;
        currentBalance = reserveResult.value;
      }

      // Проверяем финальное состояние
      expect(currentBalance.available().value().toNumber()).toBe(3500); // 10000 - 6500
      expect(currentBalance.reserved().value().toNumber()).toBe(6500);  // 2000 + 1500 + 3000
      expect(currentBalance.reservedPercentage().toFixed(2)).toBe('65.00');
    });

    it('сценарий частичного освобождения (частичное закрытие позиций)', () => {
      const createResult = BalanceService.create(Money.of(3000), Money.of(7000));
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      let currentBalance = createResult.value;

      // Освобождаем средства частями
      const releases = [1000, 2000, 1500];
      for (const releaseAmount of releases) {
        const releaseResult = BalanceService.unfreezeReserved(currentBalance, Money.of(releaseAmount));
        expect(releaseResult.ok).toBe(true);
        if (!releaseResult.ok) return;
        currentBalance = releaseResult.value;
      }

      // Проверяем финальное состояние
      expect(currentBalance.available().value().toNumber()).toBe(7500);  // 3000 + 4500
      expect(currentBalance.reserved().value().toNumber()).toBe(2500);   // 7000 - 4500
      expect(currentBalance.total().value().toNumber()).toBe(10000);
    });
  });

  describe('Граничные случаи и ошибки', () => {
    it('попытка резервировать больше чем available', () => {
      const createResult = BalanceService.create(Money.of(1000), Money.of(0));
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const reserveResult = BalanceService.reserve(createResult.value, Money.of(2000));
      expect(reserveResult.ok).toBe(false);
      if (!reserveResult.ok) {
        expect(reserveResult.error.context?.reason).toBe(BalanceErrorReason.INSUFFICIENT_FUNDS);
        expect(reserveResult.error.context?.requested).toBe(2000);
        expect(reserveResult.error.context?.available).toBe('1000');
      }
    });

    it('попытка освободить больше чем reserved', () => {
      const createResult = BalanceService.create(Money.of(5000), Money.of(1000));
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const releaseResult = BalanceService.unfreezeReserved(createResult.value, Money.of(2000));
      expect(releaseResult.ok).toBe(false);
      if (!releaseResult.ok) {
        expect(releaseResult.error.context?.reason).toBe(BalanceErrorReason.INSUFFICIENT_RESERVED);
        expect(releaseResult.error.context?.requested).toBe(2000);
        expect(releaseResult.error.context?.reserved).toBe('1000');
      }
    });

    it('резервирование всех доступных средств', () => {
      const createResult = BalanceService.create(Money.of(1000), Money.of(0));
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const reserveResult = BalanceService.reserve(createResult.value, Money.of(1000));
      expect(reserveResult.ok).toBe(true);
      if (!reserveResult.ok) return;

      const balance = reserveResult.value;
      expect(balance.available().value().toNumber()).toBe(0);
      expect(balance.reserved().value().toNumber()).toBe(1000);

      const canAffordResult = BalanceService.canAfford(balance, Money.of(1));
      expect(canAffordResult.ok).toBe(true);
      if (canAffordResult.ok) {
        expect(canAffordResult.value).toBe(false);
      }
    });

    it('освобождение всех зарезервированных средств', () => {
      const createResult = BalanceService.create(Money.of(0), Money.of(1000));
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const releaseResult = BalanceService.unfreezeReserved(createResult.value, Money.of(1000));
      expect(releaseResult.ok).toBe(true);
      if (!releaseResult.ok) return;

      const balance = releaseResult.value;
      expect(balance.available().value().toNumber()).toBe(1000);
      expect(balance.reserved().value().toNumber()).toBe(0);
      expect(balance.hasReserved()).toBe(false);
    });
  });

  describe('Serialization round-trip', () => {
    it('fromJSON → toJSON сохраняет баланс', () => {
      const original = {
        available: { amount: '10000', currency: 'USDC' },
        reserved: { amount: '2000', currency: 'USDC' }
      };

      const deserResult = BalanceSerializer.fromJSON(original);
      expect(deserResult.ok).toBe(true);
      if (!deserResult.ok) return;

      const serialized = BalanceSerializer.toJSON(deserResult.value);
      expect(serialized).toEqual(original);

      // Second round-trip
      const deserResult2 = BalanceSerializer.fromJSON(serialized);
      expect(deserResult2.ok).toBe(true);
      if (!deserResult2.ok) return;

      const equalsResult = BalanceService.equals(deserResult2.value, deserResult.value);
      expect(equalsResult.ok).toBe(true);
      if (equalsResult.ok) {
        expect(equalsResult.value).toBe(true);
      }
    });

    it('сохраняет точность Decimal через string serialization', () => {
      const original = {
        available: { amount: '12345.6789', currency: 'USDC' },
        reserved: { amount: '9876.5432', currency: 'USDC' }
      };

      const deserResult = BalanceSerializer.fromJSON(original);
      expect(deserResult.ok).toBe(true);
      if (!deserResult.ok) return;

      const serialized = BalanceSerializer.toJSON(deserResult.value);
      expect(serialized.available.amount).toBe('12345.6789');
      expect(serialized.reserved.amount).toBe('9876.5432');
    });

    it('workflow → serialize → deserialize → продолжение workflow', () => {
      // Создаём баланс и выполняем операцию
      const createResult = BalanceService.create(Money.of(10000), Money.of(0));
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const reserveResult = BalanceService.reserve(createResult.value, Money.of(3000));
      expect(reserveResult.ok).toBe(true);
      if (!reserveResult.ok) return;

      // Сериализуем
      const serialized = BalanceSerializer.toJSON(reserveResult.value);

      // Десериализуем
      const deserResult = BalanceSerializer.fromJSON(serialized);
      expect(deserResult.ok).toBe(true);
      if (!deserResult.ok) return;

      // Продолжаем workflow с десериализованным балансом
      const releaseResult = BalanceService.unfreezeReserved(deserResult.value, Money.of(1000));
      expect(releaseResult.ok).toBe(true);
      if (!releaseResult.ok) return;

      expect(releaseResult.value.available().value().toNumber()).toBe(8000);
      expect(releaseResult.value.reserved().value().toNumber()).toBe(2000);
    });
  });

  describe('Formatter интеграция', () => {
    it('форматирование на всех этапах workflow', () => {
      const createResult = BalanceService.create(Money.of(10000), Money.of(2000));
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const balance = createResult.value;

      // Все форматтеры работают
      const summary = BalanceFormatter.toSummary(balance);
      expect(summary).toContain('Available: $10000.00');
      expect(summary).toContain('Reserved: $2000.00');
      expect(summary).toContain('16.67% reserved');

      const compact = BalanceFormatter.toCompact(balance);
      expect(compact).toContain('$10.0K');
      expect(compact).toContain('$2.0K');

      const debug = BalanceFormatter.toDebugString(balance);
      expect(debug).toContain('Balance(');
      expect(debug).toContain('10000 USDC');

      const percentage = BalanceFormatter.toPercentageString(balance);
      expect(percentage).toBe('16.67%');
    });

    it('форматирование edge cases', () => {
      // Пустой баланс
      const emptyResult = BalanceService.create(Money.of(0), Money.of(0));
      expect(emptyResult.ok).toBe(true);
      if (!emptyResult.ok) return;

      expect(BalanceFormatter.toPercentageString(emptyResult.value)).toBe('0.00%');

      // Всё зарезервировано
      const allReservedResult = BalanceService.create(Money.of(0), Money.of(10000));
      expect(allReservedResult.ok).toBe(true);
      if (!allReservedResult.ok) return;

      expect(BalanceFormatter.toPercentageString(allReservedResult.value)).toBe('100.00%');
    });
  });

  describe('Query методы в workflow', () => {
    it('canAfford проверка перед резервированием', () => {
      const createResult = BalanceService.create(Money.of(1000), Money.of(0));
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const balance = createResult.value;

      // Проверяем перед резервированием
      const canAfford500 = BalanceService.canAfford(balance, Money.of(500));
      expect(canAfford500.ok).toBe(true);
      expect(canAfford500.ok && canAfford500.value).toBe(true);

      const canAfford1000 = BalanceService.canAfford(balance, Money.of(1000));
      expect(canAfford1000.ok).toBe(true);
      expect(canAfford1000.ok && canAfford1000.value).toBe(true);

      const canAfford1500 = BalanceService.canAfford(balance, Money.of(1500));
      expect(canAfford1500.ok).toBe(true);
      expect(canAfford1500.ok && canAfford1500.value).toBe(false);

      // Резервируем
      const reserveResult = BalanceService.reserve(balance, Money.of(500));
      expect(reserveResult.ok).toBe(true);
      if (!reserveResult.ok) return;

      // Проверяем после резервирования
      const newBalance = reserveResult.value;

      const canAffordAfter500 = BalanceService.canAfford(newBalance, Money.of(500));
      expect(canAffordAfter500.ok).toBe(true);
      expect(canAffordAfter500.ok && canAffordAfter500.value).toBe(true);

      const canAffordAfter600 = BalanceService.canAfford(newBalance, Money.of(600));
      expect(canAffordAfter600.ok).toBe(true);
      expect(canAffordAfter600.ok && canAffordAfter600.value).toBe(false);
    });

    it('reservedPercentage отслеживание во время workflow', () => {
      const createResult = BalanceService.create(Money.of(10000), Money.of(0));
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      let balance = createResult.value;
      expect(balance.reservedPercentage().toNumber()).toBe(0);

      // Резервируем 25%
      const reserve1 = BalanceService.reserve(balance, Money.of(2500));
      expect(reserve1.ok).toBe(true);
      if (!reserve1.ok) return;
      balance = reserve1.value;
      expect(balance.reservedPercentage().toNumber()).toBe(25);

      // Резервируем еще 25% (итого 50%)
      const reserve2 = BalanceService.reserve(balance, Money.of(2500));
      expect(reserve2.ok).toBe(true);
      if (!reserve2.ok) return;
      balance = reserve2.value;
      expect(balance.reservedPercentage().toNumber()).toBe(50);

      // Освобождаем 25% (остаётся 25%)
      const release1 = BalanceService.unfreezeReserved(balance, Money.of(2500));
      expect(release1.ok).toBe(true);
      if (!release1.ok) return;
      balance = release1.value;
      expect(balance.reservedPercentage().toNumber()).toBe(25);
    });
  });

  describe('Immutability контракт', () => {
    it('все операции возвращают новые экземпляры', () => {
      const createResult = BalanceService.create(Money.of(10000), Money.of(2000));
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const original = createResult.value;
      const originalAvailable = original.available().value().toNumber();
      const originalReserved = original.reserved().value().toNumber();

      // reserve возвращает новый экземпляр
      const reserveResult = BalanceService.reserve(original, Money.of(1000));
      expect(reserveResult.ok).toBe(true);
      if (!reserveResult.ok) return;
      expect(reserveResult.value).not.toBe(original);
      expect(original.available().value().toNumber()).toBe(originalAvailable);

      // release возвращает новый экземпляр
      const releaseResult = BalanceService.unfreezeReserved(original, Money.of(1000));
      expect(releaseResult.ok).toBe(true);
      if (!releaseResult.ok) return;
      expect(releaseResult.value).not.toBe(original);
      expect(original.reserved().value().toNumber()).toBe(originalReserved);

      // updateAvailable возвращает новый экземпляр
      const updateResult = BalanceService.updateAvailable(original, Money.of(15000));
      expect(updateResult.ok).toBe(true);
      if (!updateResult.ok) return;
      expect(updateResult.value).not.toBe(original);
      expect(original.available().value().toNumber()).toBe(originalAvailable);
    });
  });

  describe('Decimal precision', () => {
    it('Decimal arithmetic точна для Balance операций', () => {
      const createResult = BalanceService.create(
        Money.of(0.1),
        Money.of(0.2)
      );
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const total = createResult.value.total();
      expect(total.value().toString()).toBe('0.3');
      expect(total.value().toNumber()).toBe(0.3);
    });

    it('reservedPercentage вычисляется точно', () => {
      const createResult = BalanceService.create(
        Money.of(8000),
        Money.of(2000)
      );
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const percentage = createResult.value.reservedPercentage();
      expect(percentage.toFixed(10)).toBe('20.0000000000');
    });
  });

  describe('Adapters граничные случаи', () => {
    it('Serializer отклоняет невалидные структуры', () => {
      const invalidStructures = [
        null,
        42,
        'string',
        [],
        {},
        { available: { amount: '100', currency: 'USDC' } }, // missing reserved
        { reserved: { amount: '100', currency: 'USDC' } },   // missing available
        { available: 'invalid', reserved: { amount: '100', currency: 'USDC' } }
      ];

      for (const invalid of invalidStructures) {
        const result = BalanceSerializer.fromJSON(invalid);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('fromJSON');
        }
      }
    });

    it('Formatter бросает RangeError для невалидных decimals', () => {
      const createResult = BalanceService.create(Money.of(10000), Money.of(2000));
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const balance = createResult.value;

      expect(() => BalanceFormatter.toSummary(balance, -1)).toThrow(RangeError);
      expect(() => BalanceFormatter.toSummary(balance, 2.5)).toThrow(RangeError);
      expect(() => BalanceFormatter.toPercentageString(balance, -1)).toThrow(RangeError);
    });
  });
});
