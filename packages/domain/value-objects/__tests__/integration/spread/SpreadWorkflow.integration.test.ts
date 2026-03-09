import { describe, it, expect } from '@jest/globals';
import { SpreadService } from '../../../src/spread/facade/SpreadService.js';
import { SpreadSerializer } from '../../../src/spread/adapters/SpreadSerializer.js';
import { SpreadFormatter } from '../../../src/spread/adapters/SpreadFormatter.js';
import { PriceService } from '../../../src/price/index.js';

describe('Spread Integration Workflow', () => {
  describe('Scenario 1: Create → Query → Operations', () => {
    it('должен создать spread и выполнить базовые операции', () => {
      // Создание через SpreadService
      const bidResult = PriceService.create(0.48);
      const askResult = PriceService.create(0.52);

      expect(bidResult.ok).toBe(true);
      expect(askResult.ok).toBe(true);

      if (!bidResult.ok || !askResult.ok) return;

      const spreadResult = SpreadService.create(bidResult.value, askResult.value);
      expect(spreadResult.ok).toBe(true);

      if (!spreadResult.ok) return;

      const spread = spreadResult.value;

      // Query методы
      expect(spread.bid().toNumber()).toBe(0.48);
      expect(spread.ask().toNumber()).toBe(0.52);
      expect(spread.width().toNumber()).toBe(0.04);
      expect(spread.mid().toNumber()).toBe(0.5);
    });

    it('должен выполнить tighten операцию', () => {
      const bidResult = PriceService.create(0.45);
      const askResult = PriceService.create(0.55);

      expect(bidResult.ok).toBe(true);
      expect(askResult.ok).toBe(true);
      if (!bidResult.ok || !askResult.ok) return;

      const spreadResult = SpreadService.create(bidResult.value, askResult.value);
      expect(spreadResult.ok).toBe(true);
      if (!spreadResult.ok) return;

      // Tighten на 0.01 с каждой стороны
      const tightenResult = SpreadService.tighten(spreadResult.value, 0.01);
      expect(tightenResult.ok).toBe(true);

      if (tightenResult.ok) {
        expect(tightenResult.value.bid().toNumber()).toBe(0.46);
        expect(tightenResult.value.ask().toNumber()).toBe(0.54);
        expect(tightenResult.value.width().toNumber()).toBe(0.08);
      }
    });

    it('должен выполнить widen операцию', () => {
      const bidResult = PriceService.create(0.48);
      const askResult = PriceService.create(0.52);

      if (!bidResult.ok || !askResult.ok) return;

      const spreadResult = SpreadService.create(bidResult.value, askResult.value);
      if (!spreadResult.ok) return;

      // Widen на 0.02 с каждой стороны
      const widenResult = SpreadService.widen(spreadResult.value, 0.02);
      expect(widenResult.ok).toBe(true);

      if (widenResult.ok) {
        expect(widenResult.value.bid().toNumber()).toBe(0.46);
        expect(widenResult.value.ask().toNumber()).toBe(0.54);
        expect(widenResult.value.width().toNumber()).toBe(0.08);
      }
    });

    it('должен выполнить shift операцию', () => {
      const bidResult = PriceService.create(0.48);
      const askResult = PriceService.create(0.52);

      if (!bidResult.ok || !askResult.ok) return;

      const spreadResult = SpreadService.create(bidResult.value, askResult.value);
      if (!spreadResult.ok) return;

      // Shift вверх на 0.05
      const shiftResult = SpreadService.shift(spreadResult.value, 0.05);
      expect(shiftResult.ok).toBe(true);

      if (shiftResult.ok) {
        expect(shiftResult.value.bid().toNumber()).toBeCloseTo(0.53, 5);
        expect(shiftResult.value.ask().toNumber()).toBeCloseTo(0.57, 5);
        // Width должна остаться прежней
        expect(shiftResult.value.width().toNumber()).toBeCloseTo(0.04, 5);
      }
    });
  });

  describe('Scenario 2: Serialization round-trip', () => {
    it('должен сохранять значение при serialize → deserialize', () => {
      const bidResult = PriceService.create(0.48);
      const askResult = PriceService.create(0.52);

      if (!bidResult.ok || !askResult.ok) return;

      const spreadResult = SpreadService.create(bidResult.value, askResult.value);
      if (!spreadResult.ok) return;

      const original = spreadResult.value;

      // Serialize
      const json = SpreadSerializer.toJSON(original);
      expect(json.bid).toBe(0.48);
      expect(json.ask).toBe(0.52);

      // Deserialize
      const deserResult = SpreadSerializer.fromJSON(json);
      expect(deserResult.ok).toBe(true);

      if (deserResult.ok) {
        const deserialized = deserResult.value;
        expect(deserialized.bid().equals(original.bid())).toBe(true);
        expect(deserialized.ask().equals(original.ask())).toBe(true);
        expect(deserialized.width().equals(original.width())).toBe(true);
      }
    });

    it('должен обработать невалидный JSON', () => {
      const invalidJson = { bid: 0.6, ask: 0.4 }; // bid > ask
      const result = SpreadSerializer.fromJSON(invalidJson);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeDefined();
      }
    });

    it('должен обработать отсутствующие поля', () => {
      const invalidJson = { bid: 0.5 }; // нет ask
      const result = SpreadSerializer.fromJSON(invalidJson);

      expect(result.ok).toBe(false);
    });
  });

  describe('Scenario 3: Formatting', () => {
    it('должен форматировать spread для отображения', () => {
      const bidResult = PriceService.create(0.48);
      const askResult = PriceService.create(0.52);

      if (!bidResult.ok || !askResult.ok) return;

      const spreadResult = SpreadService.create(bidResult.value, askResult.value);
      if (!spreadResult.ok) return;

      const spread = spreadResult.value;

      // format (default)
      const formatted = SpreadFormatter.format(spread);
      expect(formatted).toContain('0.48');
      expect(formatted).toContain('0.52');

      // toBidAskString
      const bidAsk = SpreadFormatter.toBidAskString(spread);
      expect(bidAsk).toContain('0.48');
      expect(bidAsk).toContain('0.52');

      // toDetailedString
      const detailed = SpreadFormatter.toDetailedString(spread);
      expect(detailed).toBeTruthy();
      expect(typeof detailed).toBe('string');
    });
  });

  describe('Scenario 4: Cross-layer consistency (Core → Facade → Adapters)', () => {
    it('Core creation → Facade validation → Serialization → Formatting', () => {
      // Шаг 1: Создание через Facade
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);
      if (!spreadResult.ok) return;

      const spread = spreadResult.value;

      // Шаг 2: Проверка Core инвариантов
      expect(spread.bid().toNumber()).toBeLessThan(spread.ask().toNumber());
      expect(spread.width().toNumber()).toBeGreaterThan(0);

      // Шаг 3: Сериализация
      const json = SpreadSerializer.toJSON(spread);
      expect(json.bid).toBe(0.48);
      expect(json.ask).toBe(0.52);

      // Шаг 4: Десериализация
      const deserResult = SpreadSerializer.fromJSON(json);
      expect(deserResult.ok).toBe(true);
      if (!deserResult.ok) return;

      // Шаг 5: Форматирование
      const formatted = SpreadFormatter.format(deserResult.value);
      expect(formatted).toBeTruthy();
      expect(typeof formatted).toBe('string');
    });
  });

  describe('Scenario 5: fromMidAndWidth workflow', () => {
    it('должен создать spread из mid price и width', () => {
      // fromMidAndWidth принимает number/string/Decimal, а не Price
      const spreadResult = SpreadService.fromMidAndWidth(0.5, 0.04);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const spread = spreadResult.value;
        expect(spread.mid().toNumber()).toBe(0.5);
        expect(spread.width().toNumber()).toBeCloseTo(0.04, 5);
        expect(spread.bid().toNumber()).toBeCloseTo(0.48, 5);
        expect(spread.ask().toNumber()).toBeCloseTo(0.52, 5);
      }
    });

    it('должен создать spread из mid и width percentage', () => {
      // fromMidAndWidthPercentage принимает number/string/Decimal
      const spreadResult = SpreadService.fromMidAndWidthPercentage(0.5, 8);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const spread = spreadResult.value;
        expect(spread.mid().toNumber()).toBe(0.5);
        // 8% от 0.5 = 0.04
        expect(spread.width().toNumber()).toBeCloseTo(0.04, 5);
      }
    });
  });

  describe('Scenario 6: Edge cases', () => {
    it('должен обработать минимальный spread', () => {
      const bidResult = PriceService.create(0.4999);
      const askResult = PriceService.create(0.5001);

      if (!bidResult.ok || !askResult.ok) return;

      const spreadResult = SpreadService.create(bidResult.value, askResult.value);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        expect(spreadResult.value.width().toNumber()).toBeCloseTo(0.0002, 5);
      }
    });

    it('должен обработать максимальный spread', () => {
      const bidResult = PriceService.create(0.0001);
      const askResult = PriceService.create(0.9999);

      if (!bidResult.ok || !askResult.ok) return;

      const spreadResult = SpreadService.create(bidResult.value, askResult.value);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        expect(spreadResult.value.width().toNumber()).toBeCloseTo(0.9998, 5);
      }
    });

    it('должен отклонить spread где bid >= ask', () => {
      const bidResult = PriceService.create(0.52);
      const askResult = PriceService.create(0.48);

      if (!bidResult.ok || !askResult.ok) return;

      const spreadResult = SpreadService.create(bidResult.value, askResult.value);
      expect(spreadResult.ok).toBe(false);
    });
  });
});
