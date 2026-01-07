/**
 * Unit tests for PolymarketErrorMapper
 *
 * @remarks
 * Tests deterministic HTTP → ExchangeError mapping (dirty layer).
 * PolymarketErrorMapper uses string matching (temporary/dirty solution).
 */

import { describe, it, expect } from '@jest/globals';
import { PolymarketErrorMapper } from '../../../../src/infrastructure/exchange/mappers/PolymarketErrorMapper.js';
import { ExchangeErrorCode } from '../../../../src/domain/types/ExchangeError.js';

describe('PolymarketErrorMapper', () => {
  describe('mapHttpError() - network errors (httpStatus = 0)', () => {
    it('should map timeout error', () => {
      const error = new Error('Request timeout - ETIMEDOUT');
      const result = PolymarketErrorMapper.mapHttpError(0, undefined, error);

      expect(result.type).toBe('NETWORK_ERROR');
      expect(result.code).toBe(ExchangeErrorCode.NETWORK_ERROR);
      if (result.type === 'NETWORK_ERROR') {
        expect(result.message).toContain('TIMEOUT');
        expect(result.message).toContain('timeout');
      }
    });

    it('should map connection refused error', () => {
      const error = new Error('connect ECONNREFUSED 127.0.0.1:8080');
      const result = PolymarketErrorMapper.mapHttpError(0, undefined, error);

      expect(result.type).toBe('NETWORK_ERROR');
      expect(result.code).toBe(ExchangeErrorCode.NETWORK_ERROR);
      if (result.type === 'NETWORK_ERROR') {
        expect(result.message).toContain('CONNECTION_FAILED');
        expect(result.message).toContain('ECONNREFUSED');
      }
    });

    it('should map DNS resolution error', () => {
      const error = new Error('getaddrinfo ENOTFOUND example.com');
      const result = PolymarketErrorMapper.mapHttpError(0, undefined, error);

      expect(result.type).toBe('NETWORK_ERROR');
      expect(result.code).toBe(ExchangeErrorCode.NETWORK_ERROR);
      if (result.type === 'NETWORK_ERROR') {
        expect(result.message).toContain('DNS_FAILED');
        expect(result.message).toContain('ENOTFOUND');
      }
    });

    it('should map connection reset error', () => {
      const error = new Error('socket hang up - ECONNRESET');
      const result = PolymarketErrorMapper.mapHttpError(0, undefined, error);

      expect(result.type).toBe('NETWORK_ERROR');
      expect(result.code).toBe(ExchangeErrorCode.NETWORK_ERROR);
      if (result.type === 'NETWORK_ERROR') {
        expect(result.message).toContain('CONNECTION_FAILED');
      }
    });

    it('should map unknown network error', () => {
      const error = new Error('Some unknown network error');
      const result = PolymarketErrorMapper.mapHttpError(0, undefined, error);

      expect(result.type).toBe('NETWORK_ERROR');
      expect(result.code).toBe(ExchangeErrorCode.NETWORK_ERROR);
      if (result.type === 'NETWORK_ERROR') {
        expect(result.message).toContain('UNKNOWN');
      }
    });

    it('should handle missing error object', () => {
      const result = PolymarketErrorMapper.mapHttpError(0);

      expect(result.type).toBe('NETWORK_ERROR');
      expect(result.code).toBe(ExchangeErrorCode.NETWORK_ERROR);
      if (result.type === 'NETWORK_ERROR') {
        expect(result.message).toBe('UNKNOWN: Network error');
      }
    });
  });

  describe('mapHttpError() - rate limiting (httpStatus = 429)', () => {
    it('should map 429 with retryAfter in response', () => {
      const responseBody = {
        error: 'Too many requests',
        retryAfter: 120,
      };

      const result = PolymarketErrorMapper.mapHttpError(429, responseBody);

      expect(result.type).toBe('RATE_LIMITED');
      expect(result.code).toBe(ExchangeErrorCode.RATE_LIMITED);
      if (result.type === 'RATE_LIMITED') {
        expect(result.retryAfter).toBe(120);
        expect(result.message).toContain('Too many requests');
      }
    });

    it('should map 429 without retryAfter (use default 60s)', () => {
      const responseBody = {
        error: 'Rate limit exceeded',
      };

      const result = PolymarketErrorMapper.mapHttpError(429, responseBody);

      expect(result.type).toBe('RATE_LIMITED');
      if (result.type === 'RATE_LIMITED') {
        expect(result.retryAfter).toBe(60); // Default
      }
    });

    it('should map 429 with no response body', () => {
      const result = PolymarketErrorMapper.mapHttpError(429);

      expect(result.type).toBe('RATE_LIMITED');
      if (result.type === 'RATE_LIMITED') {
        expect(result.retryAfter).toBe(60); // Default
        expect(result.message).toBe('Rate limit exceeded');
      }
    });
  });

  describe('mapHttpError() - auth errors (httpStatus = 401, 403)', () => {
    it('should map 401 Unauthorized', () => {
      const responseBody = {
        error: 'Invalid signature',
      };

      const result = PolymarketErrorMapper.mapHttpError(401, responseBody);

      expect(result.type).toBe('AUTH_FAILED');
      expect(result.code).toBe(ExchangeErrorCode.AUTH_FAILED);
      if (result.type === 'AUTH_FAILED') {
        expect(result.httpStatus).toBe(401);
        expect(result.reason).toContain('Invalid signature');
      }
    });

    it('should map 403 Forbidden', () => {
      const responseBody = {
        message: 'Access denied',
      };

      const result = PolymarketErrorMapper.mapHttpError(403, responseBody);

      expect(result.type).toBe('AUTH_FAILED');
      expect(result.code).toBe(ExchangeErrorCode.AUTH_FAILED);
      if (result.type === 'AUTH_FAILED') {
        expect(result.httpStatus).toBe(403);
        expect(result.reason).toContain('Access denied');
      }
    });

    it('should map 401 with no response body', () => {
      const result = PolymarketErrorMapper.mapHttpError(401);

      expect(result.type).toBe('AUTH_FAILED');
      if (result.type === 'AUTH_FAILED') {
        expect(result.reason).toBe('Authentication failed');
      }
    });
  });

  describe('mapHttpError() - not found (httpStatus = 404)', () => {
    it('should map 404 with order not found message', () => {
      const responseBody = {
        error: 'Order not found',
      };

      const result = PolymarketErrorMapper.mapHttpError(404, responseBody);

      expect(result.type).toBe('ORDER_NOT_FOUND');
      expect(result.code).toBe(ExchangeErrorCode.ORDER_NOT_FOUND);
      if (result.type === 'ORDER_NOT_FOUND') {
        expect(result.orderId).toBe('unknown'); // No orderId in response body
      }
    });

    it('should map 404 with generic not found message', () => {
      const responseBody = {
        detail: 'Resource not found',
      };

      const result = PolymarketErrorMapper.mapHttpError(404, responseBody);

      expect(result.type).toBe('ORDER_NOT_FOUND');
      if (result.type === 'ORDER_NOT_FOUND') {
        expect(result.orderId).toBe('unknown');
      }
    });

    it('should map 404 with no response body', () => {
      const result = PolymarketErrorMapper.mapHttpError(404);

      expect(result.type).toBe('ORDER_NOT_FOUND');
      if (result.type === 'ORDER_NOT_FOUND') {
        expect(result.orderId).toBe('unknown');
      }
    });
  });

  describe('mapHttpError() - client errors (httpStatus = 4xx)', () => {
    it('should map 400 market closed error (string matching)', () => {
      const responseBody = {
        error: 'Market is closed and inactive',
      };

      const result = PolymarketErrorMapper.mapHttpError(400, responseBody);

      expect(result.type).toBe('MARKET_CLOSED');
      expect(result.code).toBe(ExchangeErrorCode.MARKET_CLOSED);
      if (result.type === 'MARKET_CLOSED') {
        expect(result.reason).toContain('Market is closed');
        expect(result.marketId).toBe('unknown');
      }
    });

    it('should map 400 market unavailable error', () => {
      const responseBody = {
        message: 'Market unavailable for trading',
      };

      const result = PolymarketErrorMapper.mapHttpError(400, responseBody);

      expect(result.type).toBe('MARKET_CLOSED');
      if (result.type === 'MARKET_CLOSED') {
        expect(result.marketId).toBe('unknown');
      }
    });

    it('should map unrecognized 400 as FATAL', () => {
      const responseBody = {
        error: 'Some unknown client error',
      };

      const result = PolymarketErrorMapper.mapHttpError(400, responseBody);

      expect(result.type).toBe('FATAL');
      expect(result.code).toBe(ExchangeErrorCode.FATAL);
      if (result.type === 'FATAL') {
        expect(result.httpStatus).toBe(400);
        expect(result.requiresManualInvestigation).toBe(true);
      }
    });

    it('should map 422 Unprocessable Entity as FATAL', () => {
      const responseBody = {
        error: 'Validation failed',
      };

      const result = PolymarketErrorMapper.mapHttpError(422, responseBody);

      expect(result.type).toBe('FATAL');
      if (result.type === 'FATAL') {
        expect(result.httpStatus).toBe(422);
      }
    });
  });

  describe('mapHttpError() - server errors (httpStatus = 5xx)', () => {
    it('should map 500 Internal Server Error', () => {
      const responseBody = {
        error: 'Internal Server Error',
      };

      const result = PolymarketErrorMapper.mapHttpError(500, responseBody);

      expect(result.type).toBe('SERVER_ERROR');
      expect(result.code).toBe(ExchangeErrorCode.SERVER_ERROR);
      if (result.type === 'SERVER_ERROR') {
        expect(result.status).toBe(500);
        expect(result.message).toContain('Internal Server Error');
      }
    });

    it('should map 502 Bad Gateway', () => {
      const responseBody = {
        message: 'Bad Gateway',
      };

      const result = PolymarketErrorMapper.mapHttpError(502, responseBody);

      expect(result.type).toBe('SERVER_ERROR');
      if (result.type === 'SERVER_ERROR') {
        expect(result.status).toBe(502);
      }
    });

    it('should map 503 Service Unavailable', () => {
      const result = PolymarketErrorMapper.mapHttpError(503);

      expect(result.type).toBe('SERVER_ERROR');
      if (result.type === 'SERVER_ERROR') {
        expect(result.status).toBe(503);
        expect(result.message).toBe('Server error');
      }
    });

    it('should map 504 Gateway Timeout', () => {
      const result = PolymarketErrorMapper.mapHttpError(504);

      expect(result.type).toBe('SERVER_ERROR');
      if (result.type === 'SERVER_ERROR') {
        expect(result.status).toBe(504);
      }
    });
  });

  describe('mapHttpError() - unknown status codes (FATAL)', () => {
    it('should map unknown 2xx as FATAL', () => {
      const result = PolymarketErrorMapper.mapHttpError(206);

      expect(result.type).toBe('FATAL');
      expect(result.code).toBe(ExchangeErrorCode.FATAL);
      if (result.type === 'FATAL') {
        expect(result.httpStatus).toBe(206);
        expect(result.requiresManualInvestigation).toBe(true);
      }
    });

    it('should map 418 I\'m a teapot as FATAL', () => {
      const responseBody = {
        message: 'I am a teapot',
      };

      const result = PolymarketErrorMapper.mapHttpError(418, responseBody);

      expect(result.type).toBe('FATAL');
      if (result.type === 'FATAL') {
        expect(result.httpStatus).toBe(418);
        expect(result.responseBody).toEqual(responseBody);
      }
    });

    it('should include responseBody in FATAL errors', () => {
      const responseBody = {
        error: 'Unexpected error',
        details: { foo: 'bar' },
      };

      const result = PolymarketErrorMapper.mapHttpError(999, responseBody);

      expect(result.type).toBe('FATAL');
      if (result.type === 'FATAL') {
        expect(result.responseBody).toEqual(responseBody);
      }
    });
  });

  describe('mapHttpError() - response body parsing', () => {
    it('should parse JSON string response body', () => {
      const jsonString = JSON.stringify({
        error: 'Rate limit exceeded',
        retryAfter: 30,
      });

      const result = PolymarketErrorMapper.mapHttpError(429, jsonString);

      expect(result.type).toBe('RATE_LIMITED');
      if (result.type === 'RATE_LIMITED') {
        expect(result.retryAfter).toBe(30);
      }
    });

    it('should handle plain text response body', () => {
      const plainText = 'Service temporarily unavailable';

      const result = PolymarketErrorMapper.mapHttpError(503, plainText);

      expect(result.type).toBe('SERVER_ERROR');
      if (result.type === 'SERVER_ERROR') {
        expect(result.message).toContain('Service temporarily unavailable');
      }
    });

    it('should handle already parsed object', () => {
      const parsedObject = {
        error: 'Authentication failed',
      };

      const result = PolymarketErrorMapper.mapHttpError(401, parsedObject);

      expect(result.type).toBe('AUTH_FAILED');
      if (result.type === 'AUTH_FAILED') {
        expect(result.reason).toContain('Authentication failed');
      }
    });

    it('should handle null response body', () => {
      const result = PolymarketErrorMapper.mapHttpError(500, null);

      expect(result.type).toBe('SERVER_ERROR');
      if (result.type === 'SERVER_ERROR') {
        expect(result.message).toBe('Server error');
      }
    });

    it('should handle undefined response body', () => {
      const result = PolymarketErrorMapper.mapHttpError(500, undefined);

      expect(result.type).toBe('SERVER_ERROR');
    });

    it('should handle invalid JSON string', () => {
      const invalidJson = '{invalid json';

      const result = PolymarketErrorMapper.mapHttpError(500, invalidJson);

      expect(result.type).toBe('SERVER_ERROR');
      if (result.type === 'SERVER_ERROR') {
        expect(result.message).toContain('{invalid json');
      }
    });

    it('should handle empty string', () => {
      const result = PolymarketErrorMapper.mapHttpError(500, '');

      expect(result.type).toBe('SERVER_ERROR');
    });
  });

  describe('mapHttpError() - determinism', () => {
    it('should be deterministic (same input → same output)', () => {
      const responseBody = {
        error: 'Too many requests',
        retryAfter: 60,
      };

      const result1 = PolymarketErrorMapper.mapHttpError(429, responseBody);
      const result2 = PolymarketErrorMapper.mapHttpError(429, responseBody);
      const result3 = PolymarketErrorMapper.mapHttpError(429, responseBody);

      expect(result1.type).toBe(result2.type);
      expect(result1.type).toBe(result3.type);
      if (result1.type === 'RATE_LIMITED' && result2.type === 'RATE_LIMITED' && result3.type === 'RATE_LIMITED') {
        expect(result1.retryAfter).toBe(result2.retryAfter);
        expect(result1.retryAfter).toBe(result3.retryAfter);
        expect(result1.message).toBe(result2.message);
        expect(result1.message).toBe(result3.message);
      }
    });

    it('should produce consistent results for network errors', () => {
      const error = new Error('ETIMEDOUT');

      const result1 = PolymarketErrorMapper.mapHttpError(0, undefined, error);
      const result2 = PolymarketErrorMapper.mapHttpError(0, undefined, error);

      expect(result1.type).toBe(result2.type);
      if (result1.type === 'NETWORK_ERROR' && result2.type === 'NETWORK_ERROR') {
        expect(result1.message).toBe(result2.message);
      }
    });
  });

  describe('mapHttpError() - string matching edge cases', () => {
    it('should match "market closed" case-insensitively', () => {
      const responseBody = {
        error: 'MARKET IS CLOSED',
      };

      const result = PolymarketErrorMapper.mapHttpError(400, responseBody);

      expect(result.type).toBe('MARKET_CLOSED');
    });

    it('should match "market inactive" as market closed', () => {
      const responseBody = {
        error: 'Market inactive',
      };

      const result = PolymarketErrorMapper.mapHttpError(400, responseBody);

      expect(result.type).toBe('MARKET_CLOSED');
    });

    it('should not match partial words incorrectly', () => {
      const responseBody = {
        error: 'Marketplace error', // Contains "market" but not "market closed"
      };

      const result = PolymarketErrorMapper.mapHttpError(400, responseBody);

      // Should be FATAL (unrecognized client error)
      expect(result.type).toBe('FATAL');
    });
  });
});
