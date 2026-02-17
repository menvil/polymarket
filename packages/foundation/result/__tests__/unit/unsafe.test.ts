/**
 * Тесты для @polymarket/result/unsafe
 *
 * @remarks
 * Проверяет что unsafe операции доступны через субпуть /unsafe,
 * и что root-экспорт (@polymarket/result) не содержит `unwrap`.
 */
import { describe, it, expect } from '@jest/globals';
import { unwrap, expectOk, unwrapErr, expectErr } from '../../src/unsafe.js';
import { Ok, Err } from '../../src/result.js';
import * as rootExports from '../../src/index.js';

describe('@polymarket/result root не содержит unwrap', () => {
  it('не должен экспортировать unwrap из root', () => {
    expect('unwrap' in rootExports).toBe(false);
  });
});

describe('@polymarket/result/unsafe', () => {
  describe('unwrap', () => {
    it('возвращает значение для Ok', () => {
      expect(unwrap(Ok(42))).toBe(42);
    });

    it('бросает ошибку для Err', () => {
      expect(() => unwrap(Err('oops'))).toThrow('Called unwrap on Err result: oops');
    });

    it('бросает ошибку для Err с объектом', () => {
      expect(() => unwrap(Err({ code: 404 }))).toThrow('Called unwrap on Err result:');
    });
  });

  describe('expectOk', () => {
    it('возвращает значение с кастомным сообщением для Ok', () => {
      expect(expectOk(Ok(42), 'Should be Ok')).toBe(42);
    });

    it('бросает ошибку с кастомным сообщением для Err', () => {
      expect(() => expectOk(Err('oops'), 'Failed')).toThrow('Failed: oops');
    });
  });

  describe('unwrapErr', () => {
    it('возвращает ошибку для Err', () => {
      expect(unwrapErr(Err('oops'))).toBe('oops');
    });

    it('бросает ошибку для Ok', () => {
      expect(() => unwrapErr(Ok(42))).toThrow('Called unwrapErr on Ok result: 42');
    });
  });

  describe('expectErr', () => {
    it('возвращает ошибку для Err', () => {
      expect(expectErr(Err('oops'), 'Should be Err')).toBe('oops');
    });

    it('бросает ошибку с кастомным сообщением для Ok', () => {
      expect(() => expectErr(Ok(42), 'Should be Err')).toThrow(
        'Should be Err: expected Err but got Ok(42)'
      );
    });
  });
});
