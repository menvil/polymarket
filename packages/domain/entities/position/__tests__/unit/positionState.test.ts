/**
 * Тесты canonical-равенства состояния позиции.
 *
 * @remarks
 * Каждая пара строится так, чтобы отличаться РОВНО одним полем: иначе тест
 * «разное состояние → false» проходил бы по чужой причине и не доказывал бы,
 * что сравнивается именно проверяемое поле.
 */
import { describe, it, expect } from '@jest/globals';
import { Position, type PositionParams } from '../../src/Position.js';
import { PositionLot } from '../../src/core/PositionLot.js';
import { samePositionState } from '../../src/positionState.js';
import {
  FeeService,
  OutcomePriceService,
  QuantityService,
  SignedQuantityService,
  type OutcomePrice,
  type Quantity,
} from '@polymarket/value-objects';
import { TimestampService, type Timestamp } from '@polymarket/timestamp';
import {
  AssetIdHelpers,
  asInstrumentId,
  asPolymarketCtfToken,
  asPositionId,
  parseAccountId,
  type InstrumentId,
  type PositionId,
} from '@polymarket/ids';

/** Разворачивает `Result` фикстуры: отказ здесь — дефект самого теста. */
function must<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!result.ok) throw new Error(`fixture failed: ${String(result.error)}`);
  return result.value as T;
}

/** Момент времени из миллисекунд. */
const at = (ms: number): Timestamp => must(TimestampService.create(ms));
/** Количество. */
const qty = (value: number): Quantity => must(QuantityService.create(value));
/** Цена исхода. */
const price = (value: number): OutcomePrice => must(OutcomePriceService.create(value));

const ACCOUNT = parseAccountId('venue:POLYMARKET:account-456')!;
const INSTRUMENT = asInstrumentId('instrument-up') as InstrumentId;
const OPENED_AT = at(1_705_318_200_000);

/** Лот с управляемыми полями. */
function lot(params: { qty?: number; price?: number; atMs?: number; fee?: number } = {}): PositionLot {
  return PositionLot.create({
    quantity: qty(params.qty ?? 100),
    entryPrice: price(params.price ?? 0.65),
    timestamp: at(params.atMs ?? 1_705_318_200_000),
    ...(params.fee === undefined
      ? {}
      : { fee: must(FeeService.create(AssetIdHelpers.USDC, params.fee)) }),
  });
}

/** Позиция, собранная заново при каждом вызове — новый объект, то же содержимое. */
function build(overrides: Partial<PositionParams> = {}): Position {
  const created = Position.create({
    id: asPositionId('position-1') as PositionId,
    accountId: ACCOUNT,
    instrumentId: INSTRUMENT,
    asset: AssetIdHelpers.USDC,
    side: 'LONG',
    openedAt: OPENED_AT,
    lots: [lot()],
    ...overrides,
  });
  if (!created.ok) throw new Error(`fixture failed: ${created.error.message}`);
  return created.value;
}

describe('samePositionState', () => {
  it('две независимо собранные позиции с одним содержимым равны', () => {
    const a = build();
    const b = build();
    expect(a).not.toBe(b);
    expect(samePositionState(a, b)).toBe(true);
  });

  it('эквивалентный AccountId из другого объекта не делает позиции разными', () => {
    const a = build();
    const b = build({ accountId: parseAccountId('venue:POLYMARKET:account-456')! });
    expect(samePositionState(a, b)).toBe(true);
  });

  it.each<[string, Partial<PositionParams>]>([
    ['id', { id: asPositionId('position-2') as PositionId }],
    ['accountId', { accountId: parseAccountId('venue:POLYMARKET:account-999')! }],
    ['instrumentId', { instrumentId: asInstrumentId('instrument-down') as InstrumentId }],
    ['asset', { asset: asPolymarketCtfToken('123456')! }],
    ['side', { side: 'SHORT' }],
    ['openedAt', { openedAt: at(1_705_318_100_000) }],
    ['updatedAt', { updatedAt: at(1_705_318_900_000) }],
    ['openedQuantity', { openedQuantity: qty(150) }],
    ['realizedPnL', { realizedPnL: must(SignedQuantityService.create(-3)) }],
    ['количество лота', { lots: [lot({ qty: 101 })] }],
    ['цена лота', { lots: [lot({ price: 0.66 })] }],
    ['время лота', { lots: [lot({ atMs: 1_705_318_200_001 })] }],
    ['число лотов', { lots: [lot(), lot({ atMs: 1_705_318_300_000 })] }],
  ])('расхождение в поле «%s» даёт false', (_field, overrides) => {
    expect(samePositionState(build(), build(overrides))).toBe(false);
  });

  it('комиссия лота — часть состояния, хотя PositionLot.equals её игнорирует', () => {
    const withFee = build({ lots: [lot({ fee: 0.5 })] });
    const withoutFee = build({ lots: [lot()] });

    expect(withFee.lots[0].equals(withoutFee.lots[0])).toBe(true);
    expect(samePositionState(withFee, withoutFee)).toBe(false);
    expect(samePositionState(withFee, build({ lots: [lot({ fee: 0.5 })] }))).toBe(true);
    expect(samePositionState(withFee, build({ lots: [lot({ fee: 0.7 })] }))).toBe(false);
  });

  it('после операции над позицией состояние считается изменённым', () => {
    const before = build();
    const grown = before.addLots([lot({ atMs: 1_705_318_300_000 })], at(1_705_318_300_000));
    if (!grown.ok) throw grown.error;
    expect(samePositionState(before, grown.value)).toBe(false);
  });
});
