import { describe, it, expect } from '@jest/globals';
import {
  type ExecutionVenueId,
  KnownExecutionVenues,
  isKnownExecutionVenue,
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

    it('should validate known execution venues', () => {
      expect(isKnownExecutionVenue('POLYMARKET')).toBe(true);
      expect(isKnownExecutionVenue('KALSHI')).toBe(true);
      expect(isKnownExecutionVenue('SIMULATOR')).toBe(true);
      expect(isKnownExecutionVenue('UNKNOWN_VENUE')).toBe(false);
      expect(isKnownExecutionVenue('polymarket')).toBe(false);
      expect(isKnownExecutionVenue('')).toBe(false);
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

    it('should map custom execution venue to venue with validation', () => {
      const customExec = asExecutionVenueId('CUSTOM_VENUE');
      expect(customExec).toBeDefined();

      const venue = executionToVenue(customExec!);
      expect(venue).toBe('CUSTOM_VENUE');
    });

    it('should return undefined for invalid format when mapping to venue', () => {
      // Создаем execution venue с невалидным форматом через cast (обход валидации)
      const invalidExec = 'invalid-venue' as ExecutionVenueId;

      // executionToVenue должен валидировать через asVenueId
      const venue = executionToVenue(invalidExec);
      expect(venue).toBeUndefined();
    });
  });
});
