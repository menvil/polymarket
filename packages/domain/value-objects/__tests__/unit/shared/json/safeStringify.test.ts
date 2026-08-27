import { safeStringify } from '../../../../src/shared/json/safeStringify.js';

/**
 * Тесты закрывают дыру, из-за которой дефект прожил незамеченным: во всём
 * пакете `context.json` проверялся 8 раз, и все 8 — только про `[Circular]`
 * и `[Unstringifiable]`. Случай `undefined` не проверял никто, хотя именно
 * на нём `JSON.stringify` возвращает не строку.
 */
describe('safeStringify', () => {
  describe('обычные значения', () => {
    it('должен сериализовать объект', () => {
      expect(safeStringify({ a: 1 })).toBe('{"a":1}');
    });

    it('должен сериализовать примитивы', () => {
      expect(safeStringify('x')).toBe('"x"');
      expect(safeStringify(42)).toBe('42');
      expect(safeStringify(null)).toBe('null');
    });
  });

  describe('значения без JSON-представления', () => {
    it('должен вернуть СТРОКУ для undefined, а не undefined', () => {
      const result = safeStringify(undefined);

      expect(typeof result).toBe('string');
      expect(result).toBe('[Undefined]');
    });

    it('должен вернуть строку для функции', () => {
      expect(safeStringify(() => undefined)).toBe('[Undefined]');
    });

    it('должен вернуть строку для символа', () => {
      expect(safeStringify(Symbol('x'))).toBe('[Undefined]');
    });
  });

  describe('различение трёх исходов', () => {
    it('должен пометить цикл, сохранив остальные поля', () => {
      const cyclic: Record<string, unknown> = { a: 1 };
      cyclic.self = cyclic;

      const result = safeStringify(cyclic);

      // Ради этого цикл гасится replacer-ом, а не try/catch:
      // «[Circular] в одном поле» полезнее, чем потеря всего объекта
      expect(result).toContain('"a":1');
      expect(result).toContain('[Circular]');
    });

    it('должен пометить полностью несериализуемое значение', () => {
      expect(safeStringify(1n)).toBe('[Unstringifiable]');
    });

    it('должен различать [Undefined] и [Unstringifiable]', () => {
      expect(safeStringify(undefined)).not.toBe(safeStringify(1n));
    });
  });

  it('не должен бросать ни на каком вводе', () => {
    const hostile: unknown[] = [undefined, null, 1n, Symbol('s'), () => undefined, NaN, Infinity];
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    hostile.push(cyclic);

    for (const value of hostile) {
      expect(() => safeStringify(value)).not.toThrow();
      expect(typeof safeStringify(value)).toBe('string');
    }
  });
});
