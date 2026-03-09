import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import {
  parseWalletAddress,
  KnownOnChainProtocols,
  KnownChainIds,
  BinaryOutcome,
  KnownVenues,
  accountIdFromWallet,
} from '@polymarket/ids';
import type { OnChainConditionRef, ConditionId, AccountId, VenueId } from '@polymarket/ids';
import { OutcomeToken } from '../../../../src/outcome-token/core/OutcomeToken.js';
import { Quantity } from '../../../../src/quantity/core/Quantity.js';
import { TokenBalance } from '../../../../src/token-balance/core/TokenBalance.js';
import { TokenBalanceInvariantViolation } from '../../../../src/token-balance/core/TokenBalanceInvariantViolation.js';

describe('TokenBalance Core', () => {
  const conditionRef: OnChainConditionRef = {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: KnownChainIds.POLYGON,
    conditionId: '0xabc123def4560000000000000000000000000000000000000000000000000000' as ConditionId,
  };

  const token = OutcomeToken.of(conditionRef, BinaryOutcome.UP);
  const qty100 = Quantity.of(new Decimal(100));
  const qty50 = Quantity.of(new Decimal(50));
  const qty200 = Quantity.of(new Decimal(200));
  const qtyZero = Quantity.ZERO;

  // Test fixtures для accountId и venueId
  const walletAddress = parseWalletAddress('0x1234567890123456789012345678901234567890')!;
  const accountId: AccountId = accountIdFromWallet(walletAddress);
  const venueId: VenueId = KnownVenues.POLYMARKET;

  describe('of()', () => {
    it('создаёт TokenBalance с валидными token, available и reserved', () => {
      const balance = TokenBalance.of(token, qty100, qty50, accountId, venueId);

      expect(balance).toBeInstanceOf(TokenBalance);
      expect(balance.token()).toBe(token);
      expect(balance.available()).toBe(qty100);
      expect(balance.reserved()).toBe(qty50);
    });

    it('создаёт TokenBalance с нулевым reserved', () => {
      const balance = TokenBalance.of(token, qty100, qtyZero, accountId, venueId);

      expect(balance.available()).toBe(qty100);
      expect(balance.reserved().isZero()).toBe(true);
    });

    it('создаёт TokenBalance с нулевым available', () => {
      const balance = TokenBalance.of(token, qtyZero, qty50, accountId, venueId);

      expect(balance.available().isZero()).toBe(true);
      expect(balance.reserved()).toBe(qty50);
    });

    it('создаёт полностью нулевой TokenBalance', () => {
      const balance = TokenBalance.of(token, qtyZero, qtyZero, accountId, venueId);

      expect(balance.available().isZero()).toBe(true);
      expect(balance.reserved().isZero()).toBe(true);
      expect(balance.isZero()).toBe(true);
    });

    it('бросает TokenBalanceInvariantViolation если token null/undefined', () => {
      expect(() => {
        TokenBalance.of(null as any, qty100, qtyZero, accountId, venueId);
      }).toThrow(TokenBalanceInvariantViolation);

      expect(() => {
        TokenBalance.of(undefined as any, qty100, qtyZero, accountId, venueId);
      }).toThrow(TokenBalanceInvariantViolation);
    });

    it('бросает TokenBalanceInvariantViolation если available null/undefined', () => {
      expect(() => {
        TokenBalance.of(token, null as any, qtyZero, accountId, venueId);
      }).toThrow(TokenBalanceInvariantViolation);

      expect(() => {
        TokenBalance.of(token, undefined as any, qtyZero, accountId, venueId);
      }).toThrow(TokenBalanceInvariantViolation);
    });

    it('бросает TokenBalanceInvariantViolation если reserved null/undefined', () => {
      expect(() => {
        TokenBalance.of(token, qty100, null as any, accountId, venueId);
      }).toThrow(TokenBalanceInvariantViolation);

      expect(() => {
        TokenBalance.of(token, qty100, undefined as any, accountId, venueId);
      }).toThrow(TokenBalanceInvariantViolation);
    });

    it('бросает TokenBalanceInvariantViolation если accountId null/undefined', () => {
      expect(() => {
        TokenBalance.of(token, qty100, qtyZero, null as any, venueId);
      }).toThrow(TokenBalanceInvariantViolation);

      expect(() => {
        TokenBalance.of(token, qty100, qtyZero, undefined as any, venueId);
      }).toThrow(TokenBalanceInvariantViolation);
    });

    it('бросает TokenBalanceInvariantViolation если venueId null/undefined', () => {
      expect(() => {
        TokenBalance.of(token, qty100, qtyZero, accountId, null as any);
      }).toThrow(TokenBalanceInvariantViolation);

      expect(() => {
        TokenBalance.of(token, qty100, qtyZero, accountId, undefined as any);
      }).toThrow(TokenBalanceInvariantViolation);
    });

    it('бросает TokenBalanceInvariantViolation если token не OutcomeToken instance', () => {
      const fakeToken = { assetId: () => 'fake' };

      expect(() => {
        TokenBalance.of(fakeToken as any, qty100, qtyZero, accountId, venueId);
      }).toThrow(TokenBalanceInvariantViolation);
      expect(() => {
        TokenBalance.of(fakeToken as any, qty100, qtyZero, accountId, venueId);
      }).toThrow('token must be OutcomeToken instance');
    });

    it('бросает TokenBalanceInvariantViolation если available не Quantity instance', () => {
      const fakeAmount = { value: () => 100 };

      expect(() => {
        TokenBalance.of(token, fakeAmount as any, qtyZero, accountId, venueId);
      }).toThrow(TokenBalanceInvariantViolation);
      expect(() => {
        TokenBalance.of(token, fakeAmount as any, qtyZero, accountId, venueId);
      }).toThrow('available must be Quantity instance');
    });

    it('бросает TokenBalanceInvariantViolation если reserved не Quantity instance', () => {
      const fakeAmount = { value: () => 100 };

      expect(() => {
        TokenBalance.of(token, qty100, fakeAmount as any, accountId, venueId);
      }).toThrow(TokenBalanceInvariantViolation);
      expect(() => {
        TokenBalance.of(token, qty100, fakeAmount as any, accountId, venueId);
      }).toThrow('reserved must be Quantity instance');
    });
  });

  describe('withZeroReserved()', () => {
    it('создаёт TokenBalance с reserved = 0', () => {
      const balance = TokenBalance.withZeroReserved(token, qty100, accountId, venueId);

      expect(balance.available()).toBe(qty100);
      expect(balance.reserved().isZero()).toBe(true);
      expect(balance.total().equals(qty100)).toBe(true);
    });

    it('эквивалентен of() с Quantity.ZERO для reserved', () => {
      const balance1 = TokenBalance.withZeroReserved(token, qty100, accountId, venueId);
      const balance2 = TokenBalance.of(token, qty100, Quantity.ZERO, accountId, venueId);

      expect(balance1.equals(balance2)).toBe(true);
    });
  });

  // ПРИМЕЧАНИЕ: Тесты на NaN, Infinity и negative невозможны,
  // так как Quantity.of() теперь бросает исключение для этих значений.
  // Валидация происходит на уровне Quantity, не TokenBalance.

  describe('Accessors', () => {
    const balance = TokenBalance.of(token, qty100, qty50, accountId, venueId);

    it('token() возвращает OutcomeToken', () => {
      expect(balance.token()).toBe(token);
      expect(balance.token()).toBeInstanceOf(OutcomeToken);
    });

    it('available() возвращает Quantity', () => {
      expect(balance.available()).toBe(qty100);
      expect(balance.available()).toBeInstanceOf(Quantity);
    });

    it('reserved() возвращает Quantity', () => {
      expect(balance.reserved()).toBe(qty50);
      expect(balance.reserved()).toBeInstanceOf(Quantity);
    });

    it('total() возвращает сумму available + reserved', () => {
      const total = balance.total();

      expect(total).toBeInstanceOf(Quantity);
      expect(total.value().toNumber()).toBe(150); // 100 + 50
    });

    it('accountId() возвращает AccountId', () => {
      expect(balance.accountId()).toBe(accountId);
    });

    it('venueId() возвращает VenueId', () => {
      expect(balance.venueId()).toBe(venueId);
    });
  });

  describe('Helper accessors', () => {
    const balance = TokenBalance.of(token, qty100, qty50, accountId, venueId);

    it('assetId() делегирует к token.assetId()', () => {
      const assetId = balance.assetId();

      expect(assetId).toEqual(token.assetId());
      expect(assetId.type).toBe('OUTCOME_TOKEN');
    });

    it('conditionRef() делегирует к token.conditionRef()', () => {
      const ref = balance.conditionRef();

      expect(ref).toEqual(conditionRef);
      expect(ref.kind).toBe('ONCHAIN');
      expect(ref.protocolId).toBe(KnownOnChainProtocols.POLYMARKET_CTF);
      expect(ref.chainId).toBe(KnownChainIds.POLYGON);
    });

    it('outcomeKey() делегирует к token.outcomeKey()', () => {
      const key = balance.outcomeKey();

      expect(key).toBe(BinaryOutcome.UP);
    });
  });

  describe('total()', () => {
    it('возвращает сумму available + reserved', () => {
      const balance = TokenBalance.of(token, qty100, qty50, accountId, venueId);
      const total = balance.total();

      expect(total.value().equals(new Decimal(150))).toBe(true);
    });

    it('возвращает available когда reserved = 0', () => {
      const balance = TokenBalance.of(token, qty100, qtyZero, accountId, venueId);
      const total = balance.total();

      expect(total.equals(qty100)).toBe(true);
    });

    it('возвращает reserved когда available = 0', () => {
      const balance = TokenBalance.of(token, qtyZero, qty50, accountId, venueId);
      const total = balance.total();

      expect(total.equals(qty50)).toBe(true);
    });

    it('возвращает 0 когда оба 0', () => {
      const balance = TokenBalance.of(token, qtyZero, qtyZero, accountId, venueId);
      const total = balance.total();

      expect(total.isZero()).toBe(true);
    });
  });

  describe('hasReserved()', () => {
    it('возвращает true когда reserved > 0', () => {
      const balance = TokenBalance.of(token, qty100, qty50, accountId, venueId);

      expect(balance.hasReserved()).toBe(true);
    });

    it('возвращает false когда reserved = 0', () => {
      const balance = TokenBalance.of(token, qty100, qtyZero, accountId, venueId);

      expect(balance.hasReserved()).toBe(false);
    });

    it('возвращает true для маленького reserved', () => {
      const tinyQty = Quantity.of(new Decimal('0.000001'));
      const balance = TokenBalance.of(token, qty100, tinyQty, accountId, venueId);

      expect(balance.hasReserved()).toBe(true);
    });
  });

  describe('reservedPercentage()', () => {
    it('возвращает 0 для нулевого total', () => {
      const balance = TokenBalance.of(token, qtyZero, qtyZero, accountId, venueId);
      const percentage = balance.reservedPercentage();

      expect(percentage.toNumber()).toBe(0);
    });

    it('вычисляет правильный процент', () => {
      const available = Quantity.of(new Decimal(80));
      const reserved = Quantity.of(new Decimal(20));
      const balance = TokenBalance.of(token, available, reserved, accountId, venueId);
      const percentage = balance.reservedPercentage();

      expect(percentage.toNumber()).toBe(20); // 20/100 * 100 = 20%
    });

    it('возвращает 100 когда available = 0', () => {
      const balance = TokenBalance.of(token, qtyZero, qty100, accountId, venueId);
      const percentage = balance.reservedPercentage();

      expect(percentage.toNumber()).toBe(100);
    });

    it('возвращает 0 когда reserved = 0', () => {
      const balance = TokenBalance.of(token, qty100, qtyZero, accountId, venueId);
      const percentage = balance.reservedPercentage();

      expect(percentage.toNumber()).toBe(0);
    });

    it('вычисляет дробный процент', () => {
      const available = Quantity.of(new Decimal(90));
      const reserved = Quantity.of(new Decimal(10));
      const balance = TokenBalance.of(token, available, reserved, accountId, venueId);
      const percentage = balance.reservedPercentage();

      expect(percentage.toFixed(2)).toBe('10.00');
    });
  });

  describe('hasSameToken()', () => {
    const token1 = OutcomeToken.of(conditionRef, BinaryOutcome.UP);
    const token2 = OutcomeToken.of(conditionRef, BinaryOutcome.UP);
    const token3 = OutcomeToken.of(conditionRef, BinaryOutcome.DOWN);

    it('возвращает true для одинаковых токенов', () => {
      const balance1 = TokenBalance.of(token1, qty100, qty50, accountId, venueId);
      const balance2 = TokenBalance.of(token2, qty200, qtyZero, accountId, venueId);

      expect(balance1.hasSameToken(balance2)).toBe(true);
    });

    it('возвращает false для разных токенов', () => {
      const balance1 = TokenBalance.of(token1, qty100, qty50, accountId, venueId);
      const balance3 = TokenBalance.of(token3, qty100, qty50, accountId, venueId);

      expect(balance1.hasSameToken(balance3)).toBe(false);
    });
  });

  describe('equals()', () => {
    const token1 = OutcomeToken.of(conditionRef, BinaryOutcome.UP);
    const token2 = OutcomeToken.of(conditionRef, BinaryOutcome.UP);
    const token3 = OutcomeToken.of(conditionRef, BinaryOutcome.DOWN);

    it('возвращает true для одинаковых token, available и reserved', () => {
      const balance1 = TokenBalance.of(token1, qty100, qty50, accountId, venueId);
      const balance2 = TokenBalance.of(token2, qty100, qty50, accountId, venueId);

      expect(balance1.equals(balance2)).toBe(true);
    });

    it('возвращает false для разных token', () => {
      const balance1 = TokenBalance.of(token1, qty100, qty50, accountId, venueId);
      const balance3 = TokenBalance.of(token3, qty100, qty50, accountId, venueId);

      expect(balance1.equals(balance3)).toBe(false);
    });

    it('возвращает false для разных available', () => {
      const balance1 = TokenBalance.of(token1, qty100, qty50, accountId, venueId);
      const balance2 = TokenBalance.of(token1, qty200, qty50, accountId, venueId);

      expect(balance1.equals(balance2)).toBe(false);
    });

    it('возвращает false для разных reserved', () => {
      const balance1 = TokenBalance.of(token1, qty100, qty50, accountId, venueId);
      const balance2 = TokenBalance.of(token1, qty100, qty200, accountId, venueId);

      expect(balance1.equals(balance2)).toBe(false);
    });

    it('возвращает true для нулевых балансов', () => {
      const balance1 = TokenBalance.of(token1, qtyZero, qtyZero, accountId, venueId);
      const balance2 = TokenBalance.of(token2, qtyZero, qtyZero, accountId, venueId);

      expect(balance1.equals(balance2)).toBe(true);
    });

    it('возвращает false когда total одинаковый, но available/reserved разные', () => {
      const balance1 = TokenBalance.of(token1, qty100, qty50, accountId, venueId); // total 150
      const balance2 = TokenBalance.of(token1, qty50, qty100, accountId, venueId); // total 150

      expect(balance1.equals(balance2)).toBe(false);
    });
  });

  describe('isZero()', () => {
    it('возвращает true когда available = 0 AND reserved = 0', () => {
      const balance = TokenBalance.of(token, qtyZero, qtyZero, accountId, venueId);

      expect(balance.isZero()).toBe(true);
    });

    it('возвращает false когда available > 0', () => {
      const balance = TokenBalance.of(token, qty100, qtyZero, accountId, venueId);

      expect(balance.isZero()).toBe(false);
    });

    it('возвращает false когда reserved > 0', () => {
      const balance = TokenBalance.of(token, qtyZero, qty50, accountId, venueId);

      expect(balance.isZero()).toBe(false);
    });

    it('возвращает false когда оба > 0', () => {
      const balance = TokenBalance.of(token, qty100, qty50, accountId, venueId);

      expect(balance.isZero()).toBe(false);
    });
  });

  describe('isPositive()', () => {
    it('возвращает false для нулевого баланса', () => {
      const balance = TokenBalance.of(token, qtyZero, qtyZero, accountId, venueId);

      expect(balance.isPositive()).toBe(false);
    });

    it('возвращает true когда available > 0', () => {
      const balance = TokenBalance.of(token, qty100, qtyZero, accountId, venueId);

      expect(balance.isPositive()).toBe(true);
    });

    it('возвращает true когда reserved > 0', () => {
      const balance = TokenBalance.of(token, qtyZero, qty50, accountId, venueId);

      expect(balance.isPositive()).toBe(true);
    });

    it('возвращает true когда оба > 0', () => {
      const balance = TokenBalance.of(token, qty100, qty50, accountId, venueId);

      expect(balance.isPositive()).toBe(true);
    });

    it('возвращает true для очень маленького total', () => {
      const tinyQty = Quantity.of(new Decimal('0.000001'));
      const balance = TokenBalance.of(token, tinyQty, qtyZero, accountId, venueId);

      expect(balance.isPositive()).toBe(true);
    });
  });

  describe('Immutability', () => {
    it('созданный TokenBalance иммутабелен', () => {
      const balance = TokenBalance.of(token, qty100, qty50, accountId, venueId);

      // Попытка изменить available через получение и модификацию (не должно работать)
      const retrievedAvailable = balance.available();
      expect(retrievedAvailable).toBe(qty100);

      // Оригинальный баланс не изменился
      expect(balance.available()).toBe(qty100);
      expect(balance.reserved()).toBe(qty50);
    });

    it('total() создаёт новый объект каждый раз', () => {
      const balance = TokenBalance.of(token, qty100, qty50, accountId, venueId);

      const total1 = balance.total();
      const total2 = balance.total();

      // Значения одинаковые
      expect(total1.equals(total2)).toBe(true);
      // Но это разные объекты (derived value)
      expect(total1).not.toBe(total2);
    });
  });
});
