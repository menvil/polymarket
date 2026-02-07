import { describe, it, expect } from '@jest/globals';
import {
  type ExecutionVenueId,
  KnownExecutionVenues,
  asExecutionVenueId,
  executionToVenue,
  isSimulator,
  isLiveVenue,
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
});
