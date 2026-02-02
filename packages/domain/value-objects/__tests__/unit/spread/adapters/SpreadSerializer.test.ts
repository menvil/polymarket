import { SpreadSerializer } from '../../../../src/spread/adapters/SpreadSerializer.js';
import { SpreadService } from '../../../../src/spread/facade/SpreadService.js';
import { SpreadErrorReason } from '../../../../src/spread/core/SpreadErrorReason.js';

describe('SpreadSerializer', () => {
  describe('toDTO()', () => {
    it('should serialize spread to DTO', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const dto = SpreadSerializer.toDTO(spreadResult.value);

        expect(dto.bid).toBe(0.48);
        expect(dto.ask).toBe(0.52);
      }
    });

    it('should serialize zero width spread to DTO', () => {
      const spreadResult = SpreadService.fromValues(0.50, 0.50);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const dto = SpreadSerializer.toDTO(spreadResult.value);

        expect(dto.bid).toBe(0.50);
        expect(dto.ask).toBe(0.50);
      }
    });
  });

  describe('fromDTO()', () => {
    it('should deserialize valid DTO to spread', () => {
      const dto = { bid: 0.48, ask: 0.52 };

      const result = SpreadSerializer.fromDTO(dto);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bid().value().toNumber()).toBe(0.48);
        expect(result.value.ask().value().toNumber()).toBe(0.52);
      }
    });

    it('should return Err when DTO is not an object', () => {
      const result = SpreadSerializer.fromDTO(null as any);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_DTO);
      }
    });

    it('should return Err when DTO has non-number bid', () => {
      const dto = { bid: 'invalid', ask: 0.52 } as any;

      const result = SpreadSerializer.fromDTO(dto);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_DTO);
      }
    });

    it('should return Err when DTO has non-number ask', () => {
      const dto = { bid: 0.48, ask: 'invalid' } as any;

      const result = SpreadSerializer.fromDTO(dto);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_DTO);
      }
    });

    it('should return Err when DTO has invalid price values', () => {
      const dto = { bid: 1.5, ask: 0.52 };

      const result = SpreadSerializer.fromDTO(dto);

      expect(result.ok).toBe(false);
    });
  });

  describe('toJSON()', () => {
    it('should serialize spread to JSON string', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const json = SpreadSerializer.toJSON(spreadResult.value);

        expect(typeof json).toBe('string');
        const parsed = JSON.parse(json);
        expect(parsed.bid).toBe(0.48);
        expect(parsed.ask).toBe(0.52);
      }
    });
  });

  describe('fromJSON()', () => {
    it('should deserialize valid JSON to spread', () => {
      const json = '{"bid":0.48,"ask":0.52}';

      const result = SpreadSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bid().value().toNumber()).toBe(0.48);
        expect(result.value.ask().value().toNumber()).toBe(0.52);
      }
    });

    it('should return Err when JSON is invalid', () => {
      const json = 'invalid json';

      const result = SpreadSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_JSON);
      }
    });

    it('should roundtrip correctly (toJSON -> fromJSON)', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const json = SpreadSerializer.toJSON(spreadResult.value);
        const result = SpreadSerializer.fromJSON(json);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.equals(spreadResult.value)).toBe(true);
        }
      }
    });
  });
});
