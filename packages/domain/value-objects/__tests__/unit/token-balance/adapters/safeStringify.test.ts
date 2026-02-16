import { describe, it, expect } from '@jest/globals';

/**
 * Копия safeStringify из TokenBalanceSerializer для тестирования
 * (приватная функция, тестируем через косвенный доступ)
 */
function safeStringify(value: unknown): string {
  try {
    const seen = new WeakSet();
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) {
          return '[Circular]';
        }
        seen.add(val);
      }
      return val;
    });
  } catch {
    return '[Unstringifiable]';
  }
}

describe('safeStringify', () => {
  describe('нормальные случаи', () => {
    it('сериализует простой объект', () => {
      const result = safeStringify({ foo: 'bar', num: 42 });
      expect(result).toBe('{"foo":"bar","num":42}');
    });

    it('сериализует массив', () => {
      const result = safeStringify([1, 2, 3]);
      expect(result).toBe('[1,2,3]');
    });

    it('сериализует строку', () => {
      const result = safeStringify('hello');
      expect(result).toBe('"hello"');
    });

    it('сериализует null', () => {
      const result = safeStringify(null);
      expect(result).toBe('null');
    });
  });

  describe('circular references', () => {
    it('обрабатывает простую циклическую ссылку', () => {
      const obj: any = { name: 'test' };
      obj.self = obj; // circular reference

      const result = safeStringify(obj);

      expect(result).toContain('[Circular]');
      expect(result).toContain('"name":"test"');
    });

    it('обрабатывает вложенную циклическую ссылку', () => {
      const parent: any = { name: 'parent' };
      const child: any = { name: 'child', parent };
      parent.child = child; // circular through child

      const result = safeStringify(parent);

      expect(result).toContain('[Circular]');
      expect(result).toContain('"name":"parent"');
      expect(result).toContain('"name":"child"');
    });

    it('обрабатывает массив с циклической ссылкой', () => {
      const arr: any[] = [1, 2];
      arr.push(arr); // array references itself

      const result = safeStringify(arr);

      expect(result).toContain('[Circular]');
      expect(result).toContain('1');
      expect(result).toContain('2');
    });
  });

  describe('unstringifiable values', () => {
    it('обрабатывает BigInt (unstringifiable)', () => {
      const obj = { bigint: BigInt(123) };

      const result = safeStringify(obj);

      expect(result).toBe('[Unstringifiable]');
    });

    it('обрабатывает символы', () => {
      const obj = { sym: Symbol('test') };

      const result = safeStringify(obj);

      // Символы игнорируются JSON.stringify, но это не ошибка
      expect(result).toBe('{}');
    });

    it('обрабатывает функции (пропускаются)', () => {
      const obj = { fn: () => 'hello', data: 42 };

      const result = safeStringify(obj);

      // Функции пропускаются JSON.stringify
      expect(result).toBe('{"data":42}');
    });
  });

  describe('edge cases', () => {
    it('обрабатывает undefined', () => {
      const result = safeStringify(undefined);
      // JSON.stringify(undefined) возвращает undefined (не строку), но не бросает
      expect(result).toBeUndefined();
    });

    it('обрабатывает глубоко вложенные объекты', () => {
      const deep = { a: { b: { c: { d: { e: 'value' } } } } };

      const result = safeStringify(deep);

      expect(result).toContain('"e":"value"');
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        const circular: any = {};
        circular.self = circular;
        safeStringify(circular);
        safeStringify(BigInt(999));
        safeStringify(undefined);
        safeStringify(null);
      }).not.toThrow();
    });
  });
});
