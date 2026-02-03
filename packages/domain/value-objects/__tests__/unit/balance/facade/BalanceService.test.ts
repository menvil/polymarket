import { describe, it, expect } from '@jest/globals';
import { BalanceService } from '../../../../src/balance/facade/BalanceService.js';
import { Money } from '../../../../src/money/core/Money.js';
import { BalanceErrorReason } from '../../../../src/balance/errors/BalanceErrorReason.js';

describe('BalanceService', () => {
  describe('create()', () => {
    describe('успешное создание', () => {
      it('создаёт баланс из available и reserved', () => {
        const result = BalanceService.create(
          Money.of(10000),
          Money.of(2000)
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(10000);
          expect(result.value.reserved().value().toNumber()).toBe(2000);
          expect(result.value.total().value().toNumber()).toBe(12000);
        }
      });

      it('создаёт баланс с нулевым reserved', () => {
        const result = BalanceService.create(
          Money.of(10000),
          Money.of(0)
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.hasReserved()).toBe(false);
        }
      });

      it('создаёт пустой баланс', () => {
        const result = BalanceService.create(
          Money.of(0),
          Money.of(0)
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isEmpty()).toBe(true);
        }
      });
    });

    describe('ошибки создания', () => {
      it('возвращает ошибку NEGATIVE_AVAILABLE', () => {
        const result = BalanceService.create(
          Money.of(-100, 'USDC'),
          Money.of(0)
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('create');
          expect(result.error.context?.reason).toBe(BalanceErrorReason.NEGATIVE_AVAILABLE);
        }
      });

      it('возвращает ошибку NEGATIVE_RESERVED', () => {
        const result = BalanceService.create(
          Money.of(10000),
          Money.of(-100, 'USDC')
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('create');
          expect(result.error.context?.reason).toBe(BalanceErrorReason.NEGATIVE_RESERVED);
        }
      });

      // ПРИМЕЧАНИЕ: Тест на CURRENCY_MISMATCH невозможен, так как Money поддерживает только USDC.
      // Если добавятся другие валюты, раскомментировать:
      // it('возвращает ошибку CURRENCY_MISMATCH', () => {
      //   const result = BalanceService.create(
      //     Money.of(10000),
      //     Money.of(2000, 'EUR' as any)
      //   );
      //
      //   expect(result.ok).toBe(false);
      //   if (!result.ok) {
      //     expect(result.error.context?.op).toBe('create');
      //     expect(result.error.context?.reason).toBe(BalanceErrorReason.CURRENCY_MISMATCH);
      //   }
      // });
    });
  });

  describe('reserve()', () => {
    const createBalance = () => {
      const result = BalanceService.create(
        Money.of(10000),
        Money.of(2000)
      );
      if (!result.ok) throw new Error('Failed to create balance');
      return result.value;
    };

    describe('успешное резервирование', () => {
      it('резервирует средства из available', () => {
        const balance = createBalance();
        const result = BalanceService.reserve(balance, Money.of(3000));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(7000);
          expect(result.value.reserved().value().toNumber()).toBe(5000);
          expect(result.value.total().value().toNumber()).toBe(12000);
        }
      });

      it('резервирует все available', () => {
        const balance = createBalance();
        const result = BalanceService.reserve(balance, Money.of(10000));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(0);
          expect(result.value.reserved().value().toNumber()).toBe(12000);
        }
      });

      it('возвращает новый экземпляр (immutability)', () => {
        const balance = createBalance();
        const result = BalanceService.reserve(balance, Money.of(1000));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).not.toBe(balance);
          expect(balance.available().value().toNumber()).toBe(10000); // оригинал не изменён
        }
      });
    });

    describe('ошибки резервирования', () => {
      it('возвращает ошибку INSUFFICIENT_FUNDS', () => {
        const balance = createBalance();
        const result = BalanceService.reserve(balance, Money.of(15000));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('reserve');
          expect(result.error.context?.reason).toBe(BalanceErrorReason.INSUFFICIENT_FUNDS);
        }
      });

      // ПРИМЕЧАНИЕ: Тест на CURRENCY_MISMATCH невозможен, так как Money поддерживает только USDC.
      // Если добавятся другие валюты, раскомментировать:
      // it('возвращает ошибку CURRENCY_MISMATCH', () => {
      //   const balance = createBalance();
      //   const result = BalanceService.reserve(balance, Money.of(1000, 'EUR' as any));
      //
      //   expect(result.ok).toBe(false);
      //   if (!result.ok) {
      //     expect(result.error.context?.op).toBe('reserve');
      //     expect(result.error.context?.reason).toBe(BalanceErrorReason.CURRENCY_MISMATCH);
      //   }
      // });

      it('возвращает ошибку для нулевой суммы', () => {
        const balance = createBalance();
        const result = BalanceService.reserve(balance, Money.of(0));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(BalanceErrorReason.INVALID_FORMAT);
        }
      });
    });
  });

  describe('unfreezeReserved()', () => {
    const createBalance = () => {
      const result = BalanceService.create(
        Money.of(7000),
        Money.of(5000)
      );
      if (!result.ok) throw new Error('Failed to create balance');
      return result.value;
    };

    describe('успешное освобождение', () => {
      it('освобождает зарезервированные средства', () => {
        const balance = createBalance();
        const result = BalanceService.unfreezeReserved(balance, Money.of(2000));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(9000);
          expect(result.value.reserved().value().toNumber()).toBe(3000);
          expect(result.value.total().value().toNumber()).toBe(12000);
        }
      });

      it('освобождает все reserved', () => {
        const balance = createBalance();
        const result = BalanceService.unfreezeReserved(balance, Money.of(5000));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(12000);
          expect(result.value.reserved().value().toNumber()).toBe(0);
        }
      });

      it('возвращает новый экземпляр (immutability)', () => {
        const balance = createBalance();
        const result = BalanceService.unfreezeReserved(balance, Money.of(1000));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).not.toBe(balance);
          expect(balance.reserved().value().toNumber()).toBe(5000); // оригинал не изменён
        }
      });
    });

    describe('ошибки освобождения', () => {
      it('возвращает ошибку INSUFFICIENT_RESERVED', () => {
        const balance = createBalance();
        const result = BalanceService.unfreezeReserved(balance, Money.of(10000));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('unfreezeReserved');
          expect(result.error.context?.reason).toBe(BalanceErrorReason.INSUFFICIENT_RESERVED);
        }
      });

      // ПРИМЕЧАНИЕ: Тест на CURRENCY_MISMATCH невозможен, так как Money поддерживает только USDC.
      // Если добавятся другие валюты, раскомментировать:
      // it('возвращает ошибку CURRENCY_MISMATCH', () => {
      //   const balance = createBalance();
      //   const result = BalanceService.unfreezeReserved(balance, Money.of(1000, 'EUR' as any));
      //
      //   expect(result.ok).toBe(false);
      //   if (!result.ok) {
      //     expect(result.error.context?.op)\.toBe('unfreezeReserved');
      //     expect(result.error.context?.reason).toBe(BalanceErrorReason.CURRENCY_MISMATCH);
      //   }
      // });

      it('возвращает ошибку для нулевой суммы', () => {
        const balance = createBalance();
        const result = BalanceService.unfreezeReserved(balance, Money.of(0));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(BalanceErrorReason.INVALID_FORMAT);
        }
      });
    });
  });

  describe('updateAvailable()', () => {
    const createBalance = () => {
      const result = BalanceService.create(
        Money.of(10000),
        Money.of(2000)
      );
      if (!result.ok) throw new Error('Failed to create balance');
      return result.value;
    };

    describe('успешное обновление', () => {
      it('обновляет available, сохраняя reserved', () => {
        const balance = createBalance();
        const result = BalanceService.updateAvailable(balance, Money.of(15000));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(15000);
          expect(result.value.reserved().value().toNumber()).toBe(2000);
          expect(result.value.total().value().toNumber()).toBe(17000);
        }
      });

      it('обновляет available на 0', () => {
        const balance = createBalance();
        const result = BalanceService.updateAvailable(balance, Money.of(0));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(0);
          expect(result.value.reserved().value().toNumber()).toBe(2000);
        }
      });

      it('возвращает новый экземпляр (immutability)', () => {
        const balance = createBalance();
        const result = BalanceService.updateAvailable(balance, Money.of(20000));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).not.toBe(balance);
          expect(balance.available().value().toNumber()).toBe(10000); // оригинал не изменён
        }
      });
    });

    describe('ошибки обновления', () => {
      // ПРИМЕЧАНИЕ: Тест на CURRENCY_MISMATCH невозможен, так как Money поддерживает только USDC.
      // Если добавятся другие валюты, раскомментировать:
      // it('возвращает ошибку CURRENCY_MISMATCH', () => {
      //   const balance = createBalance();
      //   const result = BalanceService.updateAvailable(balance, Money.of(15000, 'EUR' as any));
      //
      //   expect(result.ok).toBe(false);
      //   if (!result.ok) {
      //     expect(result.error.context?.op).toBe('updateAvailable');
      //     expect(result.error.context?.reason).toBe(BalanceErrorReason.CURRENCY_MISMATCH);
      //   }
      // });

      it('возвращает ошибку для отрицательного available', () => {
        const balance = createBalance();
        const result = BalanceService.updateAvailable(balance, Money.of(-1000, 'USDC'));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(BalanceErrorReason.NEGATIVE_AVAILABLE);
        }
      });
    });
  });

  describe('Facade Error Contract', () => {
    it('reserve: содержит op и операционные поля', () => {
      const balanceResult = BalanceService.create(Money.of(100), Money.of(0));
      if (!balanceResult.ok) fail('Balance creation failed');

      const result = BalanceService.reserve(balanceResult.value, Money.of(200));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('reserve');
        expect(result.error.context?.available).toBeDefined();
        expect(result.error.context?.reserved).toBeDefined();
        expect(result.error.context?.amount).toBeDefined();
        expect(result.error.context?.currency).toBeDefined();
      }
    });

    it('unfreezeReserved: содержит op и операционные поля', () => {
      const balanceResult = BalanceService.create(Money.of(100), Money.of(50));
      if (!balanceResult.ok) fail('Balance creation failed');

      const result = BalanceService.unfreezeReserved(balanceResult.value, Money.of(100));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('unfreezeReserved');
        expect(result.error.context?.available).toBeDefined();
        expect(result.error.context?.reserved).toBeDefined();
        expect(result.error.context?.amount).toBeDefined();
      }
    });

    it('updateAvailable: содержит op и операционные поля', () => {
      const balanceResult = BalanceService.create(Money.of(100), Money.of(50));
      if (!balanceResult.ok) fail('Balance creation failed');

      const result = BalanceService.updateAvailable(balanceResult.value, Money.of(-100, 'USDC'));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('updateAvailable');
        expect(result.error.context?.oldAvailable).toBeDefined();
        expect(result.error.context?.newAvailable).toBeDefined();
        expect(result.error.context?.reserved).toBeDefined();
      }
    });
  });

  describe('equals()', () => {
    describe('успешное сравнение', () => {
      it('возвращает true для идентичных балансов', () => {
        const balance1Result = BalanceService.create(Money.of(10000), Money.of(2000));
        const balance2Result = BalanceService.create(Money.of(10000), Money.of(2000));

        if (!balance1Result.ok || !balance2Result.ok) fail('Balance creation failed');

        const result = BalanceService.equals(balance1Result.value, balance2Result.value);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('возвращает false для балансов с разным available', () => {
        const balance1Result = BalanceService.create(Money.of(10000), Money.of(2000));
        const balance2Result = BalanceService.create(Money.of(10001), Money.of(2000));

        if (!balance1Result.ok || !balance2Result.ok) fail('Balance creation failed');

        const result = BalanceService.equals(balance1Result.value, balance2Result.value);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

      it('возвращает false для балансов с разным reserved', () => {
        const balance1Result = BalanceService.create(Money.of(10000), Money.of(2000));
        const balance2Result = BalanceService.create(Money.of(10000), Money.of(2001));

        if (!balance1Result.ok || !balance2Result.ok) fail('Balance creation failed');

        const result = BalanceService.equals(balance1Result.value, balance2Result.value);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

      it('возвращает true для нулевых балансов', () => {
        const balance1Result = BalanceService.create(Money.of(0), Money.of(0));
        const balance2Result = BalanceService.create(Money.of(0), Money.of(0));

        if (!balance1Result.ok || !balance2Result.ok) fail('Balance creation failed');

        const result = BalanceService.equals(balance1Result.value, balance2Result.value);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });
    });

    describe('ошибки сравнения', () => {
      // ПРИМЕЧАНИЕ: Тест для CURRENCY_MISMATCH невозможен, так как Money поддерживает только USDC
      // it('возвращает ошибку CURRENCY_MISMATCH для разных валют', () => {
      //   const balance1Result = BalanceService.create(Money.of(10000, 'USDC'), Money.of(2000, 'USDC'));
      //   const balance2Result = BalanceService.create(Money.of(10000, 'EUR'), Money.of(2000, 'EUR'));
      //
      //   if (!balance1Result.ok || !balance2Result.ok) fail('Balance creation failed');
      //
      //   const result = BalanceService.equals(balance1Result.value, balance2Result.value);
      //
      //   expect(result.ok).toBe(false);
      //   if (!result.ok) {
      //     expect(result.error.context?.reason).toBe(BalanceErrorReason.CURRENCY_MISMATCH);
      //   }
      // });
    });
  });

  describe('canAfford()', () => {
    describe('успешная проверка', () => {
      it('возвращает true если available >= amount', () => {
        const balanceResult = BalanceService.create(Money.of(10000), Money.of(2000));
        if (!balanceResult.ok) fail('Balance creation failed');

        const result = BalanceService.canAfford(balanceResult.value, Money.of(5000));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('возвращает true если available === amount (граница)', () => {
        const balanceResult = BalanceService.create(Money.of(10000), Money.of(2000));
        if (!balanceResult.ok) fail('Balance creation failed');

        const result = BalanceService.canAfford(balanceResult.value, Money.of(10000));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('возвращает false если available < amount', () => {
        const balanceResult = BalanceService.create(Money.of(10000), Money.of(2000));
        if (!balanceResult.ok) fail('Balance creation failed');

        const result = BalanceService.canAfford(balanceResult.value, Money.of(15000));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

      it('возвращает true для нулевой суммы', () => {
        const balanceResult = BalanceService.create(Money.of(10000), Money.of(2000));
        if (!balanceResult.ok) fail('Balance creation failed');

        const result = BalanceService.canAfford(balanceResult.value, Money.of(0));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('возвращает false для пустого баланса с ненулевой суммой', () => {
        const balanceResult = BalanceService.create(Money.of(0), Money.of(0));
        if (!balanceResult.ok) fail('Balance creation failed');

        const result = BalanceService.canAfford(balanceResult.value, Money.of(100));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

      it('не учитывает reserved при проверке (только available)', () => {
        const balanceResult = BalanceService.create(Money.of(1000), Money.of(9000));
        if (!balanceResult.ok) fail('Balance creation failed');

        // total = 10000, но available только 1000
        const result = BalanceService.canAfford(balanceResult.value, Money.of(5000));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });
    });

    describe('ошибки проверки', () => {
      // ПРИМЕЧАНИЕ: Тест для CURRENCY_MISMATCH невозможен, так как Money поддерживает только USDC
      // it('возвращает ошибку CURRENCY_MISMATCH для разных валют', () => {
      //   const balanceResult = BalanceService.create(Money.of(10000, 'USDC'), Money.of(2000, 'USDC'));
      //   if (!balanceResult.ok) fail('Balance creation failed');
      //
      //   const result = BalanceService.canAfford(balanceResult.value, Money.of(5000, 'EUR'));
      //
      //   expect(result.ok).toBe(false);
      //   if (!result.ok) {
      //     expect(result.error.context?.reason).toBe(BalanceErrorReason.CURRENCY_MISMATCH);
      //   }
      // });
    });
  });
});
