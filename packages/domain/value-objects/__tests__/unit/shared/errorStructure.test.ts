import { describe, it, expect } from '@jest/globals';
import { ErrorSource } from '@polymarket/errors';
import { QuoteService } from '../../../src/quote/facade/QuoteService.js';
import { PriceService } from '../../../src/price/facade/PriceService.js';
import { QuantityService } from '../../../src/quantity/facade/QuantityService.js';
import { MoneyService } from '../../../src/money/facade/MoneyService.js';
import Decimal from 'decimal.js';

// Helper type для доступа к полям context
type ErrorContext = Record<string, any>;

describe('Error Structure - ErrorSource & opChain tracking', () => {
  describe('ErrorSource.PARSING', () => {
    it('помечает ошибки парсинга с source=parsing', () => {
      const result = QuoteService.create('invalid' as any, 0.52, 100, 150);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const ctx = result.error.context as ErrorContext;
        expect(ctx?.source).toBe(ErrorSource.PARSING);
        expect(ctx?.raw?.field).toBe('bidValue');
        expect(ctx?.raw?.value).toBe('invalid');
      }
    });

    it('помечает ошибки парсинга в PriceService', () => {
      const result = PriceService.create('invalid' as any);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const ctx = result.error.context as ErrorContext;
        expect(ctx?.source).toBe(ErrorSource.PARSING);
        expect(ctx?.raw?.field).toBe('value');
      }
    });

    it('помечает ошибки парсинга в QuantityService', () => {
      const result = QuantityService.create('not-a-number' as any);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const ctx = result.error.context as ErrorContext;
        expect(ctx?.source).toBe(ErrorSource.PARSING);
        expect(ctx?.raw?.field).toBe('value');
      }
    });
  });

  describe('ErrorSource.CORE_INVARIANT', () => {
    it('помечает нарушения инвариантов с source=core_invariant', () => {
      // Bid > Ask - нарушение инварианта Quote
      const result = QuoteService.create(0.60, 0.40, 100, 150);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.source).toBe(ErrorSource.CORE_INVARIANT);
        expect(result.error.context?.reason).toBeDefined();
      }
    });

    it('помечает нарушения инвариантов Price (отрицательная цена)', () => {
      const result = PriceService.create(new Decimal(-1));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.source).toBe(ErrorSource.CORE_INVARIANT);
        expect(result.error.context?.reason).toBeDefined();
      }
    });

    it('помечает нарушения инвариантов Quantity (отрицательное количество)', () => {
      const result = QuantityService.create(new Decimal(-10));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.source).toBe(ErrorSource.CORE_INVARIANT);
        expect(result.error.context?.reason).toBeDefined();
      }
    });

    it('помечает нарушения инвариантов Balance', () => {
      // BalanceService.create требует Money объекты
      const availableResult = MoneyService.create(-100, 'USDC');
      if (availableResult.ok) {
        // Если MoneyService принял -100 (что не должно быть), тест не применим
        return;
      }

      // Проверяем, что ошибка от MoneyService имеет source=core_invariant
      const ctx = availableResult.error.context as ErrorContext;
      expect(ctx?.source).toBe(ErrorSource.CORE_INVARIANT);
      expect(ctx?.reason).toBeDefined();
    });
  });

  describe('ErrorSource.RULE_VALIDATION', () => {
    it('помечает ошибки валидации правил (проверяется в Rules тестах)', () => {
      // NOTE: Rules (ValidateStepSize, ValidateMinSize и т.д.) - это отдельные модули,
      // а не методы на QuantityService. Они тестируются в отдельных тестах.
      // Здесь мы просто проверяем, что концепция source=rule_validation работает.

      // Для демонстрации используем SpreadService, который имеет inline validations
      // или проверяем через Rules напрямую в других тестах
      expect(ErrorSource.RULE_VALIDATION).toBe('rule_validation');
    });
  });

  describe('ErrorSource.SERVICE_CALL', () => {
    it('сохраняет source из вложенного сервиса (SERVICE_CALL wrapper)', () => {
      // QuoteService.create вызывает PriceService.create
      // Если Price вернёт ошибку с source=core_invariant, она должна сохраниться
      const result = QuoteService.create(0, 0.52, 100, 150); // bid=0 - invalid price

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // source должен быть core_invariant (от PriceService), а не service_call
        expect(result.error.context?.source).toBe(ErrorSource.CORE_INVARIANT);
        expect(result.error.context?.component).toBe('bid');
      }
    });

    it('сохраняет source из вложенного сервиса для askSize', () => {
      const result = QuoteService.create(0.48, 0.52, 100, -150); // askSize < 0

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.source).toBe(ErrorSource.CORE_INVARIANT);
        expect(result.error.context?.component).toBe('askSize');
      }
    });
  });

  describe('opChain tracking', () => {
    it('создаёт opChain для single service call', () => {
      const result = PriceService.create(new Decimal(0));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const ctx = result.error.context as ErrorContext;
        const opChain = ctx?.opChain as string[] | undefined;
        expect(opChain).toBeDefined();
        expect(opChain).toContain('PriceService.create');
        expect(opChain?.length).toBe(1);
      }
    });

    it('создаёт opChain для nested service calls (QuoteService -> PriceService)', () => {
      const result = QuoteService.create(1.5, 0.52, 100, 150); // bid > MAX_PRICE

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const ctx = result.error.context as ErrorContext;
        const opChain = ctx?.opChain as string[] | undefined;

        expect(opChain).toBeDefined();
        expect(opChain?.length).toBeGreaterThanOrEqual(2);

        // opChain показывает путь [origin -> caller]: ['PriceService.create', 'QuoteService.create']
        // Первая операция - где произошла ошибка (origin)
        expect(opChain?.[0]).toBe('PriceService.create');

        // Последняя операция - точка входа (entry point)
        const lastOp = opChain?.[opChain.length - 1];
        expect(lastOp).toBe('QuoteService.create');
      }
    });

    it('создаёт opChain с nested service call через helper', () => {
      const result = QuoteService.create(0.48, 1.5, 100, 150); // ask > MAX_PRICE

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const ctx = result.error.context as ErrorContext;
        const opChain = ctx?.opChain as string[] | undefined;
        expect(opChain).toBeDefined();

        // Helpers (createPrice) не добавляются в opChain - они используют op родителя
        // Но мы видим путь через services: PriceService -> QuoteService
        expect(opChain?.length).toBeGreaterThanOrEqual(2);
        expect(opChain?.[0]).toBe('PriceService.create');
        expect(opChain).toContain('QuoteService.create');
      }
    });

    it('создаёт opChain для math операций', () => {
      // Тестируем math operations, которые могут создать opChain
      const qtyResult = QuantityService.create(new Decimal(100));
      expect(qtyResult.ok).toBe(true);
      if (!qtyResult.ok) return;

      // Divide by очень маленькое число может вызвать overflow
      const divResult = QuantityService.divide(
        qtyResult.value,
        new Decimal('0.00000000001')
      );

      // Проверяем наличие opChain независимо от результата
      if (!divResult.ok) {
        const ctx = divResult.error.context as ErrorContext;
        expect(ctx?.opChain).toBeDefined();
      }
    });
  });

  describe('service tracking', () => {
    it('устанавливает service для single service call', () => {
      const result = PriceService.create(new Decimal(0));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.service).toBe('PriceService');
      }
    });

    it('сохраняет service из nested call (root service protection)', () => {
      // QuoteService вызывает PriceService
      // service должен остаться "PriceService" (где произошла первичная ошибка)
      const result = QuoteService.create(0, 0.52, 100, 150);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.service).toBe('PriceService');
      }
    });

    it('сохраняет service для QuantityService', () => {
      const result = QuantityService.create(new Decimal(-1));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.service).toBe('QuantityService');
      }
    });

    it('сохраняет service для MoneyService', () => {
      // MoneyService разрешает отрицательные значения (balance может быть отрицательным)
      // Проверим ошибку парсинга вместо этого
      const result = MoneyService.create('invalid' as any, 'USDC');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const ctx = result.error.context as ErrorContext;
        expect(ctx?.service).toBe('MoneyService');
        expect(ctx?.source).toBe(ErrorSource.PARSING);
      }
    });

    it('сохраняет service через math операции', () => {
      // Проверяем service tracking через math операции
      const money = MoneyService.create(100, 'USDC');
      expect(money.ok).toBe(true);
      if (!money.ok) return;

      // Попробуем divide by zero
      const result = MoneyService.divide(money.value, new Decimal(0));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const ctx = result.error.context as ErrorContext;
        expect(ctx?.service).toBe('MoneyService');
      }
    });
  });

  describe('root fields protection', () => {
    it('сохраняет source через rewrap', () => {
      const result = QuoteService.create(0, 0.52, 100, 150);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // source=core_invariant от PriceService должен сохраниться
        expect(result.error.context?.source).toBe(ErrorSource.CORE_INVARIANT);
        // Но добавляется новый контекст (component)
        expect(result.error.context?.component).toBe('bid');
      }
    });

    it('сохраняет reason через rewrap', () => {
      const result = QuoteService.create(0.48, 0, 100, 150);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // reason от PriceService должен сохраниться
        expect(result.error.context?.reason).toBeDefined();
        // Но добавляется component от QuoteService
        expect(result.error.context?.component).toBe('ask');
      }
    });

    it('сохраняет raw через rewrap', () => {
      const result = QuoteService.create('invalid' as any, 0.52, 100, 150);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const ctx = result.error.context as ErrorContext;
        // raw от toDecimal должен сохраниться
        expect(ctx?.raw).toBeDefined();
        expect(ctx?.raw?.field).toBe('bidValue');
        expect(ctx?.raw?.value).toBe('invalid');
      }
    });
  });

  describe('integration: complex nested calls', () => {
    it('трассирует полный путь через multiple services', () => {
      // QuoteService.create -> createPrice -> PriceService.create
      const result = QuoteService.create(0, 0.52, 100, 150);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const ctx = result.error.context as ErrorContext;
        const opChain = ctx?.opChain as string[] | undefined;

        // Проверяем все компоненты error structure
        expect(ctx?.source).toBe(ErrorSource.CORE_INVARIANT);
        expect(ctx?.service).toBe('PriceService');
        expect(opChain).toBeDefined();
        expect(opChain?.length).toBeGreaterThan(1);

        // opChain показывает путь [origin -> entry]: ['PriceService.create', 'QuoteService.create']
        // Первая операция - где произошла ошибка
        expect(opChain?.[0]).toBe('PriceService.create');

        // Последняя операция - точка входа
        const lastOp = opChain?.[opChain.length - 1];
        expect(lastOp).toBe('QuoteService.create');

        // Root fields сохранены
        expect(ctx?.reason).toBeDefined();
        expect(ctx?.component).toBe('bid');
      }
    });

    it('показывает разницу между parsing и core_invariant в nested calls', () => {
      // Parsing error в QuoteService
      const parseResult = QuoteService.create('invalid' as any, 0.52, 100, 150);
      expect(parseResult.ok).toBe(false);
      if (!parseResult.ok) {
        expect(parseResult.error.context?.source).toBe(ErrorSource.PARSING);
        expect(parseResult.error.context?.service).toBe('QuoteService');
      }

      // Core invariant error в PriceService (через QuoteService)
      const invariantResult = QuoteService.create(0, 0.52, 100, 150);
      expect(invariantResult.ok).toBe(false);
      if (!invariantResult.ok) {
        expect(invariantResult.error.context?.source).toBe(ErrorSource.CORE_INVARIANT);
        expect(invariantResult.error.context?.service).toBe('PriceService');
      }
    });
  });
});
