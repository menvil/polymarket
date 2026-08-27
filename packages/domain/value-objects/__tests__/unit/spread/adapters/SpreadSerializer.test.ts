import { SpreadSerializer } from '../../../../src/spread/adapters/SpreadSerializer.js';
import { SpreadService } from '../../../../src/spread/facade/SpreadService.js';
import { SpreadErrorReason } from '../../../../src/spread/errors/SpreadErrorReason.js';

describe('SpreadSerializer', () => {
  describe('toJSON()', () => {
    it('should serialize spread to JSON object', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const json = SpreadSerializer.toJSON(spreadResult.value);

        expect(json.bid).toBe(0.48);
        expect(json.ask).toBe(0.52);
      }
    });

    it('should serialize zero width spread to JSON', () => {
      const spreadResult = SpreadService.fromValues(0.50, 0.50);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const json = SpreadSerializer.toJSON(spreadResult.value);

        expect(json.bid).toBe(0.50);
        expect(json.ask).toBe(0.50);
      }
    });
  });

  describe('fromJSON()', () => {
    // Диагностика строилась голым JSON.stringify внутри Err(...) без
    // защиты: циклический объект без обязательного поля ронял метод,
    // объявленный возвращающим Result
    it('should return Err, not throw, for cyclic input', () => {
      const cyclic: Record<string, unknown> = { ask: 0.52 };
      cyclic.self = cyclic;

      expect(() => SpreadSerializer.fromJSON(cyclic)).not.toThrow();

      const result = SpreadSerializer.fromJSON(cyclic);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_DTO);
      }
    });

    it('should not report [object Object] as diagnostics', () => {
      const result = SpreadSerializer.fromJSON('not-an-object');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const raw = result.error.context?.raw as { json: string } | undefined;
        expect(raw?.json).not.toContain('[object Object]');
      }
    });

    it('should deserialize valid JSON object to spread', () => {
      const json = { bid: 0.48, ask: 0.52 };

      const result = SpreadSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bid().value().toNumber()).toBe(0.48);
        expect(result.value.ask().value().toNumber()).toBe(0.52);
      }
    });

    it('should return Err when json is null', () => {
      const result = SpreadSerializer.fromJSON(null);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Expected object');
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_DTO);
      }
    });

    it('should return Err when json is not an object', () => {
      const result = SpreadSerializer.fromJSON('string');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Expected object');
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_DTO);
      }
    });

    it('should return Err when bid field is missing', () => {
      const json = { ask: 0.52 };

      const result = SpreadSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Missing required field: bid');
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_DTO);
      }
    });

    it('should return Err when ask field is missing', () => {
      const json = { bid: 0.48 };

      const result = SpreadSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Missing required field: ask');
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_DTO);
      }
    });

    it('should return Err when bid has non-number type', () => {
      const json = { bid: 'invalid', ask: 0.52 };

      const result = SpreadSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid type for field 'bid'");
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_DTO);
      }
    });

    it('should return Err when ask has non-number type', () => {
      const json = { bid: 0.48, ask: 'invalid' };

      const result = SpreadSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid type for field 'ask'");
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_DTO);
      }
    });

    it('should return Err when bid > ask (business rule)', () => {
      const json = { bid: 0.60, ask: 0.50 };

      const result = SpreadSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.BID_GREATER_THAN_ASK);
      }
    });

    it('should return Err when price values are out of range', () => {
      const json = { bid: 1.5, ask: 2.0 };

      const result = SpreadSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
    });
  });

  describe('toJSONString()', () => {
    it('should serialize spread to JSON string', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const jsonString = SpreadSerializer.toJSONString(spreadResult.value);

        expect(typeof jsonString).toBe('string');
        const parsed = JSON.parse(jsonString);
        expect(parsed.bid).toBe(0.48);
        expect(parsed.ask).toBe(0.52);
      }
    });
  });

  describe('fromJSONString()', () => {
    it('should deserialize valid JSON string to spread', () => {
      const jsonString = '{"bid":0.48,"ask":0.52}';

      const result = SpreadSerializer.fromJSONString(jsonString);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bid().value().toNumber()).toBe(0.48);
        expect(result.value.ask().value().toNumber()).toBe(0.52);
      }
    });

    it('should return Err when JSON string is invalid', () => {
      const jsonString = 'invalid json';

      const result = SpreadSerializer.fromJSONString(jsonString);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_JSON);
      }
    });

    it('should roundtrip correctly (toJSONString -> fromJSONString)', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const jsonString = SpreadSerializer.toJSONString(spreadResult.value);
        const result = SpreadSerializer.fromJSONString(jsonString);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.equals(spreadResult.value)).toBe(true);
        }
      }
    });
  });
});
