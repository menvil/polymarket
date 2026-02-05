import { describe, it, expect } from '@jest/globals';
import {
  type ExecutionVenueId,
  KnownExecutionVenues,
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
  });
});
