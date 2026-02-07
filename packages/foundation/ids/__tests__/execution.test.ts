import { describe, it, expect } from '@jest/globals';
import {
  type ExecutionVenueId,
  KnownExecutionVenues,
  asExecutionVenueId,
  executionToVenue,
  isSimulator,
  isLiveVenue,
  asOrderId,
  asFillId,
} from '../src/index.js';

describe('Execution IDs', () => {
  describe('ExecutionVenueId', () => {
    it('should have known execution venues', () => {
      const polymarket: ExecutionVenueId = KnownExecutionVenues.POLYMARKET;
      const kalshi: ExecutionVenueId = KnownExecutionVenues.KALSHI;
      const simulator: ExecutionVenueId = KnownExecutionVenues.SIMULATOR;

      expect(polymarket).toBe('POLYMARKET');
      expect(kalshi).toBe('KALSHI');
      expect(simulator).toBe('SIMULATOR');
    });

    it('should map execution venue to venue', () => {
      expect(executionToVenue(KnownExecutionVenues.POLYMARKET)).toBe('POLYMARKET');
      expect(executionToVenue(KnownExecutionVenues.KALSHI)).toBe('KALSHI');
      expect(executionToVenue(KnownExecutionVenues.SIMULATOR)).toBeUndefined();
    });

    it('should detect simulator', () => {
      expect(isSimulator(KnownExecutionVenues.SIMULATOR)).toBe(true);
      expect(isSimulator(KnownExecutionVenues.POLYMARKET)).toBe(false);
      expect(isSimulator(KnownExecutionVenues.KALSHI)).toBe(false);
    });

    it('should detect live venues', () => {
      expect(isLiveVenue(KnownExecutionVenues.POLYMARKET)).toBe(true);
      expect(isLiveVenue(KnownExecutionVenues.KALSHI)).toBe(true);
      expect(isLiveVenue(KnownExecutionVenues.SIMULATOR)).toBe(false);
    });

    it('should parse valid execution venue IDs', () => {
      // Известные venues
      expect(asExecutionVenueId('POLYMARKET')).toBe('POLYMARKET');
      expect(asExecutionVenueId('KALSHI')).toBe('KALSHI');
      expect(asExecutionVenueId('SIMULATOR')).toBe('SIMULATOR');

      // Custom venues с валидным форматом
      expect(asExecutionVenueId('CUSTOM_VENUE')).toBe('CUSTOM_VENUE');
      expect(asExecutionVenueId('MY_EXCHANGE')).toBe('MY_EXCHANGE');
      expect(asExecutionVenueId('VENUE_123')).toBe('VENUE_123');
      expect(asExecutionVenueId('_UNDERSCORE')).toBe('_UNDERSCORE');
    });

    it('should reject invalid execution venue IDs', () => {
      // Lowercase
      expect(asExecutionVenueId('polymarket')).toBeUndefined();
      expect(asExecutionVenueId('Polymarket')).toBeUndefined();

      // Содержит недопустимые символы
      expect(asExecutionVenueId('VENUE-NAME')).toBeUndefined(); // дефис
      expect(asExecutionVenueId('VENUE.NAME')).toBeUndefined(); // точка
      expect(asExecutionVenueId('VENUE:NAME')).toBeUndefined(); // двоеточие
      expect(asExecutionVenueId('VENUE\\NAME')).toBeUndefined(); // обратный слеш
      expect(asExecutionVenueId('VENUE NAME')).toBeUndefined(); // пробел

      // Начинается с цифры
      expect(asExecutionVenueId('123VENUE')).toBeUndefined();
      expect(asExecutionVenueId('1_VENUE')).toBeUndefined();

      // Пустая строка или слишком длинная
      expect(asExecutionVenueId('')).toBeUndefined();
      expect(asExecutionVenueId('A'.repeat(33))).toBeUndefined(); // 33 символа (лимит 32)
    });

    it('should accept execution venue ID at max length', () => {
      const maxLenId = 'A'.repeat(32);
      expect(asExecutionVenueId(maxLenId)).toBe(maxLenId);
    });

    it('should accept consecutive underscores', () => {
      expect(asExecutionVenueId('VENUE__NAME')).toBe('VENUE__NAME');
    });

    it('should accept ending with underscore', () => {
      expect(asExecutionVenueId('VENUE_')).toBe('VENUE_');
    });

    it('should map custom execution venue to venue with validation', () => {
      const customExec = asExecutionVenueId('CUSTOM_VENUE');
      expect(customExec).toBeDefined();

      const venue = executionToVenue(customExec!);
      expect(venue).toBe('CUSTOM_VENUE');
    });

    it('should handle custom venue live/simulator checks', () => {
      const customVenue = asExecutionVenueId('CUSTOM_VENUE')!;
      // Custom venues are treated as live venues by default
      expect(isLiveVenue(customVenue)).toBe(true);
      // Only SIMULATOR is a simulator
      expect(isSimulator(customVenue)).toBe(false);
    });
  });

  describe('OrderId', () => {
    it('should parse valid order IDs', () => {
      expect(asOrderId('order-123')).toBe('order-123');
      expect(asOrderId('ORDER_456')).toBe('ORDER_456');
      expect(asOrderId('uuid-1234-5678')).toBe('uuid-1234-5678');
      expect(asOrderId('12345')).toBe('12345');
    });

    it('should trim whitespace', () => {
      expect(asOrderId('  order-123  ')).toBe('order-123');
      expect(asOrderId('\torder-456\n')).toBe('order-456');
    });

    it('should reject empty strings', () => {
      expect(asOrderId('')).toBeUndefined();
      expect(asOrderId('  ')).toBeUndefined();
      expect(asOrderId('\t\n')).toBeUndefined();
    });

    it('should reject strings exceeding max length', () => {
      const maxLength = 'x'.repeat(256);
      const tooLong = 'x'.repeat(257);

      expect(asOrderId(maxLength)).toBe(maxLength);
      expect(asOrderId(tooLong)).toBeUndefined();
    });

    it('should reject control characters', () => {
      expect(asOrderId('order\x00id')).toBeUndefined(); // null
      expect(asOrderId('order\x01id')).toBeUndefined(); // start of heading
      expect(asOrderId('order\x1Fid')).toBeUndefined(); // unit separator
      expect(asOrderId('order\x7Fid')).toBeUndefined(); // delete
      expect(asOrderId('order\x9Fid')).toBeUndefined(); // application program command
    });

    it('should accept special characters except control chars', () => {
      expect(asOrderId('order-123')).toBe('order-123');
      expect(asOrderId('order_456')).toBe('order_456');
      expect(asOrderId('order.789')).toBe('order.789');
      expect(asOrderId('order@venue')).toBe('order@venue');
    });
  });

  describe('FillId', () => {
    it('should parse valid fill IDs', () => {
      expect(asFillId('fill-123')).toBe('fill-123');
      expect(asFillId('FILL_456')).toBe('FILL_456');
      expect(asFillId('trade-uuid-1234')).toBe('trade-uuid-1234');
      expect(asFillId('67890')).toBe('67890');
    });

    it('should trim whitespace', () => {
      expect(asFillId('  fill-123  ')).toBe('fill-123');
      expect(asFillId('\tfill-456\n')).toBe('fill-456');
    });

    it('should reject empty strings', () => {
      expect(asFillId('')).toBeUndefined();
      expect(asFillId('  ')).toBeUndefined();
      expect(asFillId('\t\n')).toBeUndefined();
    });

    it('should reject strings exceeding max length', () => {
      const maxLength = 'x'.repeat(256);
      const tooLong = 'x'.repeat(257);

      expect(asFillId(maxLength)).toBe(maxLength);
      expect(asFillId(tooLong)).toBeUndefined();
    });

    it('should reject control characters', () => {
      expect(asFillId('fill\x00id')).toBeUndefined(); // null
      expect(asFillId('fill\x01id')).toBeUndefined(); // start of heading
      expect(asFillId('fill\x1Fid')).toBeUndefined(); // unit separator
      expect(asFillId('fill\x7Fid')).toBeUndefined(); // delete
      expect(asFillId('fill\x9Fid')).toBeUndefined(); // application program command
    });

    it('should accept special characters except control chars', () => {
      expect(asFillId('fill-123')).toBe('fill-123');
      expect(asFillId('fill_456')).toBe('fill_456');
      expect(asFillId('fill.789')).toBe('fill.789');
      expect(asFillId('fill@venue')).toBe('fill@venue');
    });
  });
});
