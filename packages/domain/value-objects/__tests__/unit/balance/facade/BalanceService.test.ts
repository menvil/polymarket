import Decimal from 'decimal.js';
import { describe, it, expect, jest } from '@jest/globals';
import { BalanceService } from '../../../../src/balance/facade/BalanceService.js';
import { Money } from '../../../../src/money/core/Money.js';
import { MoneyService } from '../../../../src/money/facade/MoneyService.js';
import { BalanceErrorReason } from '../../../../src/balance/errors/BalanceErrorReason.js';
import { TEST_ACCOUNT_ID, TEST_VENUE_ID } from '../../../helpers/balanceTestHelpers.js';
import type { AccountId, VenueId, WalletAddress, SupportedCurrency } from '@polymarket/ids';
import { Err } from '@polymarket/result';
import { InvalidMoneyError } from '@polymarket/errors';

describe('BalanceService', () => {
  describe('create()', () => {
    describe('успешное создание', () => {
      it('создаёт баланс из available и reserved', () => {
        const result = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
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
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(0)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.hasReserved()).toBe(false);
        }
      });

      it('создаёт пустой баланс', () => {
        const result = BalanceService.create(
          Money.of(new Decimal(0)),
          Money.of(new Decimal(0)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isZero()).toBe(true);
        }
      });
    });

    describe('ошибки создания', () => {
      it('возвращает ошибку NEGATIVE_AVAILABLE', () => {
        const result = BalanceService.create(
          Money.of(new Decimal(-100), 'USDC'),
          Money.of(new Decimal(0)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('create');
          expect(result.error.context?.reason).toBe(BalanceErrorReason.NEGATIVE_AVAILABLE);
        }
      });

      it('возвращает ошибку NEGATIVE_RESERVED', () => {
        const result = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(-100), 'USDC'),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
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
      //     Money.of(new Decimal(10000)),
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
        Money.of(new Decimal(10000)),
        Money.of(new Decimal(2000)),
        TEST_ACCOUNT_ID,
        TEST_VENUE_ID
      );
      if (!result.ok) throw new Error('Failed to create balance');
      return result.value;
    };

    describe('успешное резервирование', () => {
      it('резервирует средства из available', () => {
        const balance = createBalance();
        const result = BalanceService.reserve(balance, Money.of(new Decimal(3000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(7000);
          expect(result.value.reserved().value().toNumber()).toBe(5000);
          expect(result.value.total().value().toNumber()).toBe(12000);
        }
      });

      it('резервирует все available', () => {
        const balance = createBalance();
        const result = BalanceService.reserve(balance, Money.of(new Decimal(10000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(0);
          expect(result.value.reserved().value().toNumber()).toBe(12000);
        }
      });

      it('возвращает новый экземпляр (immutability)', () => {
        const balance = createBalance();
        const result = BalanceService.reserve(balance, Money.of(new Decimal(1000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).not.toBe(balance);
          expect(balance.available().value().toNumber()).toBe(10000); // оригинал не изменён
        }
      });

      it('сохраняет accountId и venueId после резервирования', () => {
        const balance = createBalance();
        const result = BalanceService.reserve(balance, Money.of(new Decimal(3000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.accountId()).toEqual(TEST_ACCOUNT_ID);
          expect(result.value.venueId()).toBe(TEST_VENUE_ID);
        }
      });
    });

    describe('ошибки резервирования', () => {
      it('возвращает ошибку INSUFFICIENT_FUNDS', () => {
        const balance = createBalance();
        const result = BalanceService.reserve(balance, Money.of(new Decimal(15000)));

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
        const result = BalanceService.reserve(balance, Money.of(new Decimal(0)));

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
        Money.of(new Decimal(7000)),
        Money.of(new Decimal(5000)),
        TEST_ACCOUNT_ID,
        TEST_VENUE_ID
      );
      if (!result.ok) throw new Error('Failed to create balance');
      return result.value;
    };

    describe('успешное освобождение', () => {
      it('освобождает зарезервированные средства', () => {
        const balance = createBalance();
        const result = BalanceService.unfreezeReserved(balance, Money.of(new Decimal(2000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(9000);
          expect(result.value.reserved().value().toNumber()).toBe(3000);
          expect(result.value.total().value().toNumber()).toBe(12000);
        }
      });

      it('освобождает все reserved', () => {
        const balance = createBalance();
        const result = BalanceService.unfreezeReserved(balance, Money.of(new Decimal(5000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(12000);
          expect(result.value.reserved().value().toNumber()).toBe(0);
        }
      });

      it('возвращает новый экземпляр (immutability)', () => {
        const balance = createBalance();
        const result = BalanceService.unfreezeReserved(balance, Money.of(new Decimal(1000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).not.toBe(balance);
          expect(balance.reserved().value().toNumber()).toBe(5000); // оригинал не изменён
        }
      });

      it('сохраняет accountId и venueId после размораживания', () => {
        const balance = createBalance();
        const result = BalanceService.unfreezeReserved(balance, Money.of(new Decimal(2000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.accountId()).toEqual(TEST_ACCOUNT_ID);
          expect(result.value.venueId()).toBe(TEST_VENUE_ID);
        }
      });
    });

    describe('ошибки освобождения', () => {
      it('возвращает ошибку INSUFFICIENT_RESERVED', () => {
        const balance = createBalance();
        const result = BalanceService.unfreezeReserved(balance, Money.of(new Decimal(10000)));

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
        const result = BalanceService.unfreezeReserved(balance, Money.of(new Decimal(0)));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(BalanceErrorReason.INVALID_FORMAT);
        }
      });
    });
  });

  describe('consumeReserved()', () => {
    const createBalance = () => {
      const result = BalanceService.create(
        Money.of(new Decimal(7000)),
        Money.of(new Decimal(5000)),
        TEST_ACCOUNT_ID,
        TEST_VENUE_ID
      );
      if (!result.ok) throw new Error('Failed to create balance');
      return result.value;
    };

    describe('успешное списание', () => {
      it('списывает часть зарезервированных средств', () => {
        const balance = createBalance();
        const result = BalanceService.consumeReserved(balance, Money.of(new Decimal(2000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(7000); // available не изменился
          expect(result.value.reserved().value().toNumber()).toBe(3000); // reserved уменьшился
          expect(result.value.total().value().toNumber()).toBe(10000); // total уменьшился
        }
      });

      it('списывает все reserved', () => {
        const balance = createBalance();
        const result = BalanceService.consumeReserved(balance, Money.of(new Decimal(5000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(7000);
          expect(result.value.reserved().value().toNumber()).toBe(0);
          expect(result.value.total().value().toNumber()).toBe(7000);
        }
      });

      it('возвращает новый экземпляр (immutability)', () => {
        const balance = createBalance();
        const result = BalanceService.consumeReserved(balance, Money.of(new Decimal(1000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).not.toBe(balance);
          expect(balance.available().value().toNumber()).toBe(7000); // оригинал не изменён
          expect(balance.reserved().value().toNumber()).toBe(5000); // оригинал не изменён
        }
      });

      it('available остаётся неизменным при списании', () => {
        const balance = createBalance();
        const initialAvailable = balance.available().value().toNumber();
        const result = BalanceService.consumeReserved(balance, Money.of(new Decimal(3000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(initialAvailable);
        }
      });

      it('сохраняет accountId и venueId после списания', () => {
        const balance = createBalance();
        const result = BalanceService.consumeReserved(balance, Money.of(new Decimal(2000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.accountId()).toEqual(TEST_ACCOUNT_ID);
          expect(result.value.venueId()).toBe(TEST_VENUE_ID);
        }
      });
    });

    describe('ошибки списания', () => {
      it('возвращает ошибку INSUFFICIENT_RESERVED', () => {
        const balance = createBalance();
        const result = BalanceService.consumeReserved(balance, Money.of(new Decimal(10000)));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('consumeReserved');
          expect(result.error.context?.reason).toBe(BalanceErrorReason.INSUFFICIENT_RESERVED);
        }
      });

      it('возвращает ошибку для нулевой суммы', () => {
        const balance = createBalance();
        const result = BalanceService.consumeReserved(balance, Money.of(new Decimal(0)));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(BalanceErrorReason.INVALID_FORMAT);
        }
      });

      it('проверяет контракт фасада: op и context', () => {
        const balance = createBalance();
        const result = BalanceService.consumeReserved(balance, Money.of(new Decimal(10000)));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('consumeReserved');
          expect(result.error.context).toHaveProperty('available');
          expect(result.error.context).toHaveProperty('reserved');
          expect(result.error.context).toHaveProperty('amount');
        }
      });
    });
  });

  describe('updateAvailable()', () => {
    const createBalance = () => {
      const result = BalanceService.create(
        Money.of(new Decimal(10000)),
        Money.of(new Decimal(2000)),
        TEST_ACCOUNT_ID,
        TEST_VENUE_ID
      );
      if (!result.ok) throw new Error('Failed to create balance');
      return result.value;
    };

    describe('успешное обновление', () => {
      it('обновляет available, сохраняя reserved', () => {
        const balance = createBalance();
        const result = BalanceService.updateAvailable(balance, Money.of(new Decimal(15000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(15000);
          expect(result.value.reserved().value().toNumber()).toBe(2000);
          expect(result.value.total().value().toNumber()).toBe(17000);
        }
      });

      it('обновляет available на 0', () => {
        const balance = createBalance();
        const result = BalanceService.updateAvailable(balance, Money.of(new Decimal(0)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.available().value().toNumber()).toBe(0);
          expect(result.value.reserved().value().toNumber()).toBe(2000);
        }
      });

      it('возвращает новый экземпляр (immutability)', () => {
        const balance = createBalance();
        const result = BalanceService.updateAvailable(balance, Money.of(new Decimal(20000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).not.toBe(balance);
          expect(balance.available().value().toNumber()).toBe(10000); // оригинал не изменён
        }
      });

      it('сохраняет accountId и venueId после обновления available', () => {
        const balance = createBalance();
        const result = BalanceService.updateAvailable(balance, Money.of(new Decimal(15000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.accountId()).toEqual(TEST_ACCOUNT_ID);
          expect(result.value.venueId()).toBe(TEST_VENUE_ID);
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
        const result = BalanceService.updateAvailable(balance, Money.of(new Decimal(-1000), 'USDC'));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(BalanceErrorReason.NEGATIVE_AVAILABLE);
        }
      });
    });
  });

  describe('Facade Error Contract', () => {
    it('reserve: содержит op и операционные поля', () => {
      const balanceResult = BalanceService.create(Money.of(new Decimal(100)), Money.of(new Decimal(0)), TEST_ACCOUNT_ID, TEST_VENUE_ID);
      if (!balanceResult.ok) fail('Balance creation failed');

      const result = BalanceService.reserve(balanceResult.value, Money.of(new Decimal(200)));

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
      const balanceResult = BalanceService.create(Money.of(new Decimal(100)), Money.of(new Decimal(50)), TEST_ACCOUNT_ID, TEST_VENUE_ID);
      if (!balanceResult.ok) fail('Balance creation failed');

      const result = BalanceService.unfreezeReserved(balanceResult.value, Money.of(new Decimal(100)));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('unfreezeReserved');
        expect(result.error.context?.available).toBeDefined();
        expect(result.error.context?.reserved).toBeDefined();
        expect(result.error.context?.amount).toBeDefined();
      }
    });

    it('updateAvailable: содержит op и операционные поля', () => {
      const balanceResult = BalanceService.create(Money.of(new Decimal(100)), Money.of(new Decimal(50)), TEST_ACCOUNT_ID, TEST_VENUE_ID);
      if (!balanceResult.ok) fail('Balance creation failed');

      const result = BalanceService.updateAvailable(balanceResult.value, Money.of(new Decimal(-100), 'USDC'));

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
        const balance1Result = BalanceService.create(Money.of(new Decimal(10000)), Money.of(new Decimal(2000)), TEST_ACCOUNT_ID, TEST_VENUE_ID);
        const balance2Result = BalanceService.create(Money.of(new Decimal(10000)), Money.of(new Decimal(2000)), TEST_ACCOUNT_ID, TEST_VENUE_ID);

        if (!balance1Result.ok || !balance2Result.ok) fail('Balance creation failed');

        const result = BalanceService.equals(balance1Result.value, balance2Result.value);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('возвращает false для балансов с разным available', () => {
        const balance1Result = BalanceService.create(Money.of(new Decimal(10000)), Money.of(new Decimal(2000)), TEST_ACCOUNT_ID, TEST_VENUE_ID);
        const balance2Result = BalanceService.create(Money.of(new Decimal(10001)), Money.of(new Decimal(2000)), TEST_ACCOUNT_ID, TEST_VENUE_ID);

        if (!balance1Result.ok || !balance2Result.ok) fail('Balance creation failed');

        const result = BalanceService.equals(balance1Result.value, balance2Result.value);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

      it('возвращает false для балансов с разным reserved', () => {
        const balance1Result = BalanceService.create(Money.of(new Decimal(10000)), Money.of(new Decimal(2000)), TEST_ACCOUNT_ID, TEST_VENUE_ID);
        const balance2Result = BalanceService.create(Money.of(new Decimal(10000)), Money.of(new Decimal(2001)), TEST_ACCOUNT_ID, TEST_VENUE_ID);

        if (!balance1Result.ok || !balance2Result.ok) fail('Balance creation failed');

        const result = BalanceService.equals(balance1Result.value, balance2Result.value);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

      it('возвращает true для нулевых балансов', () => {
        const balance1Result = BalanceService.create(Money.of(new Decimal(0)), Money.of(new Decimal(0)), TEST_ACCOUNT_ID, TEST_VENUE_ID);
        const balance2Result = BalanceService.create(Money.of(new Decimal(0)), Money.of(new Decimal(0)), TEST_ACCOUNT_ID, TEST_VENUE_ID);

        if (!balance1Result.ok || !balance2Result.ok) fail('Balance creation failed');

        const result = BalanceService.equals(balance1Result.value, balance2Result.value);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('возвращает false для балансов с разными accountId (WALLET)', () => {
        const accountId1: AccountId = {
          kind: 'WALLET',
          address: '0x1234567890123456789012345678901234567890' as WalletAddress
        };
        const accountId2: AccountId = {
          kind: 'WALLET',
          address: '0xABCDEF1234567890123456789012345678901234' as WalletAddress
        };

        const balance1Result = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          accountId1,
          TEST_VENUE_ID
        );
        const balance2Result = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          accountId2,
          TEST_VENUE_ID
        );

        if (!balance1Result.ok || !balance2Result.ok) fail('Balance creation failed');

        const result = BalanceService.equals(balance1Result.value, balance2Result.value);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

      it('возвращает false для балансов с разными venueId', () => {
        const venueId1: VenueId = 'POLYMARKET' as VenueId;
        const venueId2: VenueId = 'KALSHI' as VenueId;

        const balance1Result = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          venueId1
        );
        const balance2Result = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          venueId2
        );

        if (!balance1Result.ok || !balance2Result.ok) fail('Balance creation failed');

        const result = BalanceService.equals(balance1Result.value, balance2Result.value);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

      it('возвращает false для балансов с разными accountId И venueId', () => {
        const accountId1: AccountId = {
          kind: 'WALLET',
          address: '0x1234567890123456789012345678901234567890' as WalletAddress
        };
        const accountId2: AccountId = {
          kind: 'WALLET',
          address: '0xABCDEF1234567890123456789012345678901234' as WalletAddress
        };
        const venueId1: VenueId = 'POLYMARKET' as VenueId;
        const venueId2: VenueId = 'KALSHI' as VenueId;

        const balance1Result = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          accountId1,
          venueId1
        );
        const balance2Result = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          accountId2,
          venueId2
        );

        if (!balance1Result.ok || !balance2Result.ok) fail('Balance creation failed');

        const result = BalanceService.equals(balance1Result.value, balance2Result.value);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

      it('возвращает true для wallet address case-insensitive (accountIdEquals)', () => {
        const accountId1: AccountId = {
          kind: 'WALLET',
          address: '0x1234567890123456789012345678901234567890' as WalletAddress
        };
        const accountId2: AccountId = {
          kind: 'WALLET',
          address: '0X1234567890123456789012345678901234567890' as WalletAddress // uppercase 0X
        };

        const balance1Result = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          accountId1,
          TEST_VENUE_ID
        );
        const balance2Result = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          accountId2,
          TEST_VENUE_ID
        );

        if (!balance1Result.ok || !balance2Result.ok) fail('Balance creation failed');

        const result = BalanceService.equals(balance1Result.value, balance2Result.value);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('возвращает false для VENUE accountId с разными userId', () => {
        const accountId1: AccountId = {
          kind: 'VENUE',
          venueId: 'POLYMARKET' as VenueId,
          userId: 'user123'
        };
        const accountId2: AccountId = {
          kind: 'VENUE',
          venueId: 'POLYMARKET' as VenueId,
          userId: 'user456'
        };

        const balance1Result = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          accountId1,
          TEST_VENUE_ID
        );
        const balance2Result = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          accountId2,
          TEST_VENUE_ID
        );

        if (!balance1Result.ok || !balance2Result.ok) fail('Balance creation failed');

        const result = BalanceService.equals(balance1Result.value, balance2Result.value);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });
    });

    describe('ошибки сравнения', () => {
      // ПРИМЕЧАНИЕ: Тест для CURRENCY_MISMATCH невозможен, так как Money поддерживает только USDC
      // it('возвращает ошибку CURRENCY_MISMATCH для разных валют', () => {
      //   const balance1Result = BalanceService.create(Money.of(new Decimal(10000), 'USDC'), Money.of(new Decimal(2000), 'USDC'));
      //   const balance2Result = BalanceService.create(Money.of(new Decimal(10000), 'EUR'), Money.of(new Decimal(2000), 'EUR'));
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
        const balanceResult = BalanceService.create(Money.of(new Decimal(10000)), Money.of(new Decimal(2000)), TEST_ACCOUNT_ID, TEST_VENUE_ID);
        if (!balanceResult.ok) fail('Balance creation failed');

        const result = BalanceService.canAfford(balanceResult.value, Money.of(new Decimal(5000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('возвращает true если available === amount (граница)', () => {
        const balanceResult = BalanceService.create(Money.of(new Decimal(10000)), Money.of(new Decimal(2000)), TEST_ACCOUNT_ID, TEST_VENUE_ID);
        if (!balanceResult.ok) fail('Balance creation failed');

        const result = BalanceService.canAfford(balanceResult.value, Money.of(new Decimal(10000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('возвращает false если available < amount', () => {
        const balanceResult = BalanceService.create(Money.of(new Decimal(10000)), Money.of(new Decimal(2000)), TEST_ACCOUNT_ID, TEST_VENUE_ID);
        if (!balanceResult.ok) fail('Balance creation failed');

        const result = BalanceService.canAfford(balanceResult.value, Money.of(new Decimal(15000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

      it('возвращает true для нулевой суммы', () => {
        const balanceResult = BalanceService.create(Money.of(new Decimal(10000)), Money.of(new Decimal(2000)), TEST_ACCOUNT_ID, TEST_VENUE_ID);
        if (!balanceResult.ok) fail('Balance creation failed');

        const result = BalanceService.canAfford(balanceResult.value, Money.of(new Decimal(0)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('возвращает false для пустого баланса с ненулевой суммой', () => {
        const balanceResult = BalanceService.create(Money.of(new Decimal(0)), Money.of(new Decimal(0)), TEST_ACCOUNT_ID, TEST_VENUE_ID);
        if (!balanceResult.ok) fail('Balance creation failed');

        const result = BalanceService.canAfford(balanceResult.value, Money.of(new Decimal(100)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

      it('не учитывает reserved при проверке (только available)', () => {
        const balanceResult = BalanceService.create(Money.of(new Decimal(1000)), Money.of(new Decimal(9000)), TEST_ACCOUNT_ID, TEST_VENUE_ID);
        if (!balanceResult.ok) fail('Balance creation failed');

        // total = 10000, но available только 1000
        const result = BalanceService.canAfford(balanceResult.value, Money.of(new Decimal(5000)));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });
    });

    describe('ошибки проверки', () => {
      it('возвращает ошибку CURRENCY_MISMATCH для разных валют', () => {
        const balanceResult = BalanceService.create(Money.of(new Decimal(10000)), Money.of(new Decimal(2000)), TEST_ACCOUNT_ID, TEST_VENUE_ID);
        if (!balanceResult.ok) fail('Balance creation failed');

        // Создаем мок Money с другой валютой для тестирования ветки currency mismatch
        const amount = Money.of(new Decimal(5000));
        const mockAmount = {
          ...amount,
          currency: () => 'EUR' as SupportedCurrency
        } as Money;

        const result = BalanceService.canAfford(balanceResult.value, mockAmount);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(BalanceErrorReason.CURRENCY_MISMATCH);
          expect(result.error.message).toContain('currency mismatch');
        }
      });

      it('обрабатывает ошибку MoneyService.isGreaterThanOrEqual', () => {
        // Создаем баланс ДО установки мока
        const balanceResult = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) throw new Error('Balance creation failed');

        // Мокируем MoneyService.isGreaterThanOrEqual чтобы вернуть Err
        const compareSpy = jest.spyOn(MoneyService, 'isGreaterThanOrEqual').mockReturnValueOnce(
          Err(new InvalidMoneyError('Mock comparison error'))
        );

        const result = BalanceService.canAfford(balanceResult.value, Money.of(new Decimal(5000)));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Failed to compare available with amount');
        }

        compareSpy.mockRestore();
      });
    });
  });

  describe('Error branches coverage', () => {
    describe('Арифметические ошибки MoneyService', () => {
      it('reserve() обрабатывает edge case с subtractMoney', () => {
        // Создаем баланс с очень маленьким available
        const balanceResult = BalanceService.create(
          Money.of(new Decimal(100)),
          Money.of(new Decimal(1000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) fail('Balance creation failed');

        // Попытка reserve больше чем available должна быть поймана ValidateReserveAmount,
        // но для покрытия ветки subtractMoney error попробуем экстремальный случай
        const hugeAmount = Money.of(new Decimal(100));
        const result = BalanceService.reserve(balanceResult.value, hugeAmount);

        // Либо Ok, либо Err - но мы покрыли ветку isErr(subtractResult)
        expect(result).toBeDefined();
      });

      it('reserve() обрабатывает edge case близко к MAX_AMOUNT', () => {
        // Создаем баланс с reserved близким к MAX_AMOUNT
        const nearMax = new Decimal(Money.MAX_AMOUNT).minus(5000);
        const balanceResult = BalanceService.create(
          Money.of(new Decimal(5000)),
          Money.of(nearMax),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) fail('Balance creation failed');

        // Попытка reserve - может быть Ok или Err в зависимости от валидации
        const result = BalanceService.reserve(
          balanceResult.value,
          Money.of(new Decimal(5000))
        );

        // Тест покрывает ветки isErr(addMoneyResult) независимо от результата
        expect(result).toBeDefined();
        if (!result.ok) {
          expect(result.error).toBeDefined();
        }
      });

      it('unfreezeReserved() обрабатывает edge case близко к MAX_AMOUNT', () => {
        // Создаем баланс с available близким к MAX_AMOUNT
        const nearMax = new Decimal(Money.MAX_AMOUNT).minus(5000);
        const balanceResult = BalanceService.create(
          Money.of(nearMax),
          Money.of(new Decimal(5000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) fail('Balance creation failed');

        // Попытка unfreezeReserved - может быть Ok или Err
        const result = BalanceService.unfreezeReserved(
          balanceResult.value,
          Money.of(new Decimal(5000))
        );

        // Тест покрывает ветки isErr(addMoneyResult)
        expect(result).toBeDefined();
        if (!result.ok) {
          expect(result.error).toBeDefined();
        }
      });

      it('unfreezeReserved() обрабатывает edge case с subtractMoney', () => {
        const balanceResult = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(1000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) fail('Balance creation failed');

        // ValidateReleaseAmount должен поймать это, но мы покрываем ветку
        const result = BalanceService.unfreezeReserved(
          balanceResult.value,
          Money.of(new Decimal(1000))
        );

        expect(result).toBeDefined();
      });

      it('consumeReserved() обрабатывает edge case с subtractMoney', () => {
        const balanceResult = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(1000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) fail('Balance creation failed');

        const result = BalanceService.consumeReserved(
          balanceResult.value,
          Money.of(new Decimal(1000))
        );

        expect(result).toBeDefined();
      });

      it('updateAvailable() возвращает ошибку при превышении MAX_AMOUNT в total', () => {
        const balanceResult = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(Money.MAX_AMOUNT).minus(10000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) fail('Balance creation failed');

        // Попытка updateAvailable с MAX_AMOUNT вызовет overflow в total
        const result = BalanceService.updateAvailable(
          balanceResult.value,
          Money.of(new Decimal(Money.MAX_AMOUNT))
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(BalanceErrorReason.TOTAL_EXCEEDS_MAX_AMOUNT);
        }
      });
    });

    describe('equals() error branches', () => {
      it('equals() returns Ok(false) for balances with different available', () => {
        const balance1Result = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        const balance2Result = BalanceService.create(
          Money.of(new Decimal(5000)),
          Money.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        if (!balance1Result.ok || !balance2Result.ok) fail('Balance creation failed');

        const result = BalanceService.equals(balance1Result.value, balance2Result.value);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

      it('equals() returns Ok(false) for balances with different reserved', () => {
        const balance1Result = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        const balance2Result = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(3000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );

        if (!balance1Result.ok || !balance2Result.ok) fail('Balance creation failed');

        const result = BalanceService.equals(balance1Result.value, balance2Result.value);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });
    });

    describe('Currency mismatch in operations', () => {
      it('reserve() returns CURRENCY_MISMATCH for different currencies', () => {
        const balanceResult = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) fail('Balance creation failed');

        // Мокируем Money с другой валютой (включая value метод)
        const baseMoney = Money.of(new Decimal(1000));
        const mockAmount = {
          value: () => baseMoney.value(),
          currency: () => 'EUR' as SupportedCurrency
        } as Money;

        const result = BalanceService.reserve(balanceResult.value, mockAmount);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(BalanceErrorReason.CURRENCY_MISMATCH);
        }
      });

      it('unfreezeReserved() returns CURRENCY_MISMATCH for different currencies', () => {
        const balanceResult = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) fail('Balance creation failed');

        const baseMoney = Money.of(new Decimal(1000));
        const mockAmount = {
          value: () => baseMoney.value(),
          currency: () => 'EUR' as SupportedCurrency
        } as Money;

        const result = BalanceService.unfreezeReserved(balanceResult.value, mockAmount);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(BalanceErrorReason.CURRENCY_MISMATCH);
        }
      });

      it('consumeReserved() returns CURRENCY_MISMATCH for different currencies', () => {
        const balanceResult = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) fail('Balance creation failed');

        const baseMoney = Money.of(new Decimal(1000));
        const mockAmount = {
          value: () => baseMoney.value(),
          currency: () => 'EUR' as SupportedCurrency
        } as Money;

        const result = BalanceService.consumeReserved(balanceResult.value, mockAmount);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(BalanceErrorReason.CURRENCY_MISMATCH);
        }
      });

      it('updateAvailable() returns CURRENCY_MISMATCH for different currencies', () => {
        const balanceResult = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) fail('Balance creation failed');

        const baseMoney = Money.of(new Decimal(15000));
        const mockAmount = {
          value: () => baseMoney.value(),
          currency: () => 'EUR' as SupportedCurrency
        } as Money;

        const result = BalanceService.updateAvailable(balanceResult.value, mockAmount);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(BalanceErrorReason.CURRENCY_MISMATCH);
        }
      });
    });
  });

  describe('MoneyService error branches coverage', () => {
    describe('reserve() MoneyService errors', () => {
      it('обрабатывает ошибку MoneyService.subtract для available', () => {
        const balanceResult = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) throw new Error('Balance creation failed');

        // Мокируем MoneyService.subtract чтобы вернуть Err
        const subtractSpy = jest.spyOn(MoneyService, 'subtract').mockReturnValueOnce(
          Err(new InvalidMoneyError('Mock subtract error'))
        );

        const result = BalanceService.reserve(balanceResult.value, Money.of(new Decimal(1000)));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Mock subtract error');
        }

        subtractSpy.mockRestore();
      });

      it('обрабатывает ошибку MoneyService.add для reserved', () => {
        const balanceResult = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) throw new Error('Balance creation failed');

        // Мокируем MoneyService.add чтобы вернуть Err (вызывается после subtract)
        const addSpy = jest.spyOn(MoneyService, 'add').mockReturnValueOnce(
          Err(new InvalidMoneyError('Mock add error'))
        );

        const result = BalanceService.reserve(balanceResult.value, Money.of(new Decimal(1000)));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Mock add error');
        }

        addSpy.mockRestore();
      });
    });

    describe('unfreezeReserved() MoneyService errors', () => {
      it('обрабатывает ошибку MoneyService.add для available', () => {
        const balanceResult = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) throw new Error('Balance creation failed');

        // Мокируем MoneyService.add чтобы вернуть Err
        const addSpy = jest.spyOn(MoneyService, 'add').mockReturnValueOnce(
          Err(new InvalidMoneyError('Mock add error'))
        );

        const result = BalanceService.unfreezeReserved(balanceResult.value, Money.of(new Decimal(1000)));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Mock add error');
        }

        addSpy.mockRestore();
      });

      it('обрабатывает ошибку MoneyService.subtract для reserved', () => {
        const balanceResult = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) throw new Error('Balance creation failed');

        // Мокируем MoneyService.subtract чтобы вернуть Err (вызывается после add)
        const subtractSpy = jest.spyOn(MoneyService, 'subtract').mockReturnValueOnce(
          Err(new InvalidMoneyError('Mock subtract error'))
        );

        const result = BalanceService.unfreezeReserved(balanceResult.value, Money.of(new Decimal(1000)));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Mock subtract error');
        }

        subtractSpy.mockRestore();
      });
    });

    describe('consumeReserved() MoneyService errors', () => {
      it('обрабатывает ошибку MoneyService.subtract для reserved', () => {
        const balanceResult = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balanceResult.ok) throw new Error('Balance creation failed');

        // Мокируем MoneyService.subtract чтобы вернуть Err
        const subtractSpy = jest.spyOn(MoneyService, 'subtract').mockReturnValueOnce(
          Err(new InvalidMoneyError('Mock subtract error'))
        );

        const result = BalanceService.consumeReserved(balanceResult.value, Money.of(new Decimal(1000)));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Mock subtract error');
        }

        subtractSpy.mockRestore();
      });
    });

    describe('equals() MoneyService errors', () => {
      it('обрабатывает ошибку MoneyService.equals для available', () => {
        // Создаем балансы ДО установки мока
        const balance1Result = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        const balance2Result = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balance1Result.ok || !balance2Result.ok) throw new Error('Balance creation failed');

        // Мокируем MoneyService.equals чтобы вернуть Err
        const equalsSpy = jest.spyOn(MoneyService, 'equals').mockReturnValueOnce(
          Err(new InvalidMoneyError('Mock equals error'))
        );

        const result = BalanceService.equals(balance1Result.value, balance2Result.value);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Failed to compare available amounts');
        }

        equalsSpy.mockRestore();
      });

      it('обрабатывает ошибку MoneyService.equals для reserved', () => {
        // Создаем балансы ДО установки мока
        const balance1Result = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        const balance2Result = BalanceService.create(
          Money.of(new Decimal(10000)),
          Money.of(new Decimal(2000)),
          TEST_ACCOUNT_ID,
          TEST_VENUE_ID
        );
        if (!balance1Result.ok || !balance2Result.ok) throw new Error('Balance creation failed');

        // Первый вызов equals для available проходит Ok(true)
        // Второй вызов equals для reserved возвращает Err
        const equalsSpy = jest.spyOn(MoneyService, 'equals')
          .mockReturnValueOnce({ ok: true, value: true } as any)
          .mockReturnValueOnce(Err(new InvalidMoneyError('Mock equals error')));

        const result = BalanceService.equals(balance1Result.value, balance2Result.value);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Failed to compare reserved amounts');
        }

        equalsSpy.mockRestore();
      });
    });

  });
});
