/**
 * Тесты валидации RiskPolicy.create.
 *
 * @remarks
 * Проверяет, что невалидная конфигурация (NaN, Infinity, отрицательные и дробные
 * integer-параметры, отрицательные/не-finite Decimal-лимиты) отклоняется на этапе
 * создания политики (`Err(RiskConfigError)`), а валидная — принимается и
 * замораживается (иммутабельность).
 */
import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { RiskPolicy, RiskConfigError } from '../../src/RiskPolicy.js';

describe('RiskPolicy.create', () => {
  // ── Валидные конфигурации ─────────────────────────────────────────────────

  it('Ok для пустой политики', () => {
    const r = RiskPolicy.create({});
    expect(r.ok).toBe(true);
  });

  it('Ok для валидной полной политики', () => {
    const r = RiskPolicy.create({
      maxOpenOrders: 5,
      minTimeToExpiryMs: 60_000,
      maxPositionSize: new Decimal('100'),
      maxTotalExposure: new Decimal('1000'),
      maxOrderNotional: new Decimal('500'),
      minAvailableBalance: new Decimal('1'),
    });
    expect(r.ok).toBe(true);
  });

  it('Ok допускает нулевые лимиты', () => {
    const r = RiskPolicy.create({
      maxOpenOrders: 0,
      minTimeToExpiryMs: 0,
      maxPositionSize: new Decimal('0'),
    });
    expect(r.ok).toBe(true);
  });

  it('замораживает params (иммутабельность)', () => {
    const r = RiskPolicy.create({ maxOpenOrders: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.isFrozen(r.value.params)).toBe(true);
    }
  });

  it('params — копия входного объекта (внешняя мутация не влияет)', () => {
    const input = { maxOpenOrders: 5 };
    const r = RiskPolicy.create(input);
    expect(r.ok).toBe(true);
    (input as { maxOpenOrders: number }).maxOpenOrders = 999;
    if (r.ok) {
      expect(r.value.params.maxOpenOrders).toBe(5);
    }
  });

  // ── Невалидные integer-счётчики ───────────────────────────────────────────

  it('Err для отрицательного maxOpenOrders', () => {
    const r = RiskPolicy.create({ maxOpenOrders: -1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(RiskConfigError);
      expect(r.error.field).toBe('maxOpenOrders');
    }
  });

  it('Err для дробного maxOpenOrders', () => {
    const r = RiskPolicy.create({ maxOpenOrders: 2.5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('maxOpenOrders');
  });

  it('Err для NaN maxOpenOrders', () => {
    const r = RiskPolicy.create({ maxOpenOrders: NaN });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('maxOpenOrders');
  });

  it('Err для Infinity minTimeToExpiryMs', () => {
    const r = RiskPolicy.create({ minTimeToExpiryMs: Infinity });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('minTimeToExpiryMs');
  });

  it('Err для отрицательного minTimeToExpiryMs', () => {
    const r = RiskPolicy.create({ minTimeToExpiryMs: -100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('minTimeToExpiryMs');
  });

  // ── Невалидные Decimal-лимиты ─────────────────────────────────────────────

  it('Err для отрицательного maxTotalExposure', () => {
    const r = RiskPolicy.create({ maxTotalExposure: new Decimal('-1') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('maxTotalExposure');
  });

  it('Err для NaN maxPositionSize', () => {
    const r = RiskPolicy.create({ maxPositionSize: new Decimal(NaN) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('maxPositionSize');
  });

  it('Err для не-finite maxOrderNotional', () => {
    const r = RiskPolicy.create({ maxOrderNotional: new Decimal(Infinity) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('maxOrderNotional');
  });

  it('Err для отрицательного minAvailableBalance', () => {
    const r = RiskPolicy.create({ minAvailableBalance: new Decimal('-0.01') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('minAvailableBalance');
  });

  // ── Runtime-граница: не доверять статическому типу ────────────────────────

  it('Err (НЕ throw) для number в Decimal-поле', () => {
    // Раньше бросало TypeError: value.isNaN is not a function.
    const r = RiskPolicy.create({ maxTotalExposure: 100 } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('maxTotalExposure');
  });

  it('Err (НЕ throw) для строки в Decimal-поле', () => {
    const r = RiskPolicy.create({ maxOrderNotional: '500' } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('maxOrderNotional');
  });

  it('Err для строки в integer-поле', () => {
    const r = RiskPolicy.create({ maxOpenOrders: '5' } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('maxOpenOrders');
  });

  it('Err для неизвестного поля (удалённый лимит maxDrawdown не просачивается)', () => {
    const r = RiskPolicy.create({ maxDrawdown: new Decimal('0.2') } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('maxDrawdown');
  });

  it('Err для не-объекта (null / number / array)', () => {
    expect(RiskPolicy.create(null as never).ok).toBe(false);
    expect(RiskPolicy.create(42 as never).ok).toBe(false);
    expect(RiskPolicy.create([] as never).ok).toBe(false);
  });

  it('params не содержит посторонних полей (whitelist)', () => {
    // undefined-значения известных полей допустимы и просто отбрасываются.
    const r = RiskPolicy.create({ maxOpenOrders: 5, minTimeToExpiryMs: undefined });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.value.params)).toEqual(['maxOpenOrders']);
    }
  });

  // ── Plain-object contract (Date / class / prototype) ──────────────────────

  it('RiskPolicy.create(new Date()) → Err(<root>)', () => {
    const r = RiskPolicy.create(new Date());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('<root>');
  });

  it('instance пользовательского class → Err(<root>)', () => {
    class Foo {
      maxOpenOrders = 5;
    }
    const r = RiskPolicy.create(new Foo());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('<root>');
  });

  it('Object.create(null) с валидным own field → Ok', () => {
    const obj = Object.create(null) as { maxOpenOrders?: number };
    obj.maxOpenOrders = 5;
    const r = RiskPolicy.create(obj);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.params.maxOpenOrders).toBe(5);
  });

  it('inherited maxOpenOrders не принимается (не-plain prototype → Err)', () => {
    const proto = { maxOpenOrders: 999 };
    const obj = Object.create(proto) as object; // прототип — не Object.prototype
    const r = RiskPolicy.create(obj);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('<root>');
  });

  it('неизвестный ключ с undefined-значением отклоняется', () => {
    const r = RiskPolicy.create({ maxOrderNotionl: undefined } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('maxOrderNotionl');
  });

  // ── Runtime introspection не должна бросать ────────────────────────────────

  it('throwing getter → Err(<root>), не throw', () => {
    const evil = {};
    Object.defineProperty(evil, 'maxOpenOrders', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const r = RiskPolicy.create(evil);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('<root>');
  });

  it('throwing Proxy ownKeys trap → Err(<root>), не throw', () => {
    const proxy = new Proxy({}, {
      ownKeys() {
        throw new Error('trap');
      },
    });
    const r = RiskPolicy.create(proxy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('<root>');
  });

  it('canonical params заморожены и содержат только validated own-поля', () => {
    const r = RiskPolicy.create({ maxOpenOrders: 5, maxTotalExposure: new Decimal('1000') });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.isFrozen(r.value.params)).toBe(true);
      expect(new Set(Object.keys(r.value.params))).toEqual(new Set(['maxOpenOrders', 'maxTotalExposure']));
    }
  });

  // ── Номинальный brand: структурная подделка отклоняется компилятором ───────

  it('структурная подделка RiskPolicy отклоняется компилятором (nominal brand)', () => {
    // @ts-expect-error structural forging must be rejected — RiskPolicy is nominally branded
    const forgedPolicy: RiskPolicy = { params: {} };
    // Используем forgedPolicy (noUnusedLocals). На runtime это plain object —
    // brand существует только на уровне типов (см. RiskPolicy._riskPolicyBrand).
    expect(forgedPolicy).toBeDefined();
  });
});
