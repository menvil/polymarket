/**
 * Тесты для @polymarket/result/unsafe
 *
 * @remarks
 * Проверяет что unsafe операции доступны через субпуть /unsafe,
 * и что root-экспорт (@polymarket/result) не содержит `unwrap`.
 */
import { describe, it, expect } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unwrap, expectOk, unwrapErr, expectErr } from '../../src/unsafe.js';
import { Ok, Err } from '../../src/result.js';
import * as rootExports from '../../src/index.js';

describe('@polymarket/result root не содержит unwrap', () => {
  it('не должен экспортировать unwrap из root (src)', () => {
    expect('unwrap' in rootExports).toBe(false);
  });

  it('dist/index.d.ts не должен объявлять экспорт unwrap (packaging regression)', () => {
    // Симулирует реальный потребительский контракт через скомпилированные декларации.
    // Пропускается если dist не собран — полную гарантию даёт `npm run build && npm test`.
    // process.cwd() — это корень пакета, откуда запускается jest
    const dtsPath = resolve(process.cwd(), 'dist/index.d.ts');
    if (!existsSync(dtsPath)) {
      return;
    }
    const content = readFileSync(dtsPath, 'utf8');

    // Извлекаем имена из всех export { } блоков декларации
    const exportPattern = /^export\s*\{([^}]+)\}/gm;
    const allExported: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = exportPattern.exec(content)) !== null) {
      const names = match[1]
        .split(',')
        .map((s) => s.replace(/\btype\b/g, '').trim()) // убрать 'type' keyword
        .filter(Boolean);
      allExported.push(...names);
    }

    // 'unwrap' не должен быть среди экспортов (только unwrapOr, unwrapOrElse допустимы)
    const hasUnwrap = allExported.some((name) => name === 'unwrap');
    expect(hasUnwrap).toBe(false);
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
