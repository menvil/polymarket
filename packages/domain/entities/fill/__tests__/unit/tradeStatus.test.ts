/**
 * Политика наблюдений за статусом сделки на площадке.
 *
 * @remarks
 * Правило переехало сюда из `@polymarket/account-state`: оно выводится из
 * контракта `TradeStatus` и не зависит ни от наблюдателя, ни от того, где
 * хранится результат. Тесты, проверяющие ЧЕМ каждый исход оборачивается в
 * состоянии аккаунта (ошибка, no-op, запись), остались там же, где это
 * решается.
 *
 * Здесь проверяется само правило, включая полноту разбора: если в
 * `TradeStatus` появится шестой статус, `EXHAUSTIVE` перестанет
 * компилироваться.
 */
import { describe, expect, it } from '@jest/globals';
import {
  TERMINAL_TRADE_STATUSES,
  classifyTradeStatusObservation,
  isTerminalTradeStatus,
  type TradeStatus,
  type TradeStatusObservation,
} from '../../src/index.js';

/**
 * Полный разбор `TradeStatus` по терминальности.
 *
 * @remarks
 * `Record` вместо массива намеренно: новый статус в union ломает компиляцию,
 * тогда как список молча остался бы неполным.
 */
const EXHAUSTIVE: Record<TradeStatus, 'terminal' | 'transient'> = {
  MATCHED: 'transient',
  MINED: 'transient',
  RETRYING: 'transient',
  CONFIRMED: 'terminal',
  FAILED: 'terminal',
};

const ALL_STATUSES = Object.keys(EXHAUSTIVE) as TradeStatus[];
const TERMINAL = ALL_STATUSES.filter((s) => EXHAUSTIVE[s] === 'terminal');
const TRANSIENT = ALL_STATUSES.filter((s) => EXHAUSTIVE[s] === 'transient');

describe('isTerminalTradeStatus', () => {
  it('терминальны ровно CONFIRMED и FAILED', () => {
    expect([...TERMINAL_TRADE_STATUSES].sort()).toEqual(['CONFIRMED', 'FAILED']);
  });

  it.each(TERMINAL)('%s — терминальный', (status) => {
    expect(isTerminalTradeStatus(status)).toBe(true);
  });

  it.each(TRANSIENT)('%s — нетерминальный', (status) => {
    expect(isTerminalTradeStatus(status)).toBe(false);
  });

  it('MINED не терминален: блок ≠ финальность', () => {
    // Расчётная транзакция попала в блок, но площадка из этого статуса ходит
    // дальше — и в CONFIRMED, и в FAILED при реорганизации.
    expect(isTerminalTradeStatus('MINED')).toBe(false);
  });

  it('множество и предикат согласованы на всём union', () => {
    for (const status of ALL_STATUSES) {
      expect(isTerminalTradeStatus(status)).toBe(TERMINAL_TRADE_STATUSES.has(status));
    }
  });
});

describe('classifyTradeStatusObservation', () => {
  it.each(ALL_STATUSES)('%s сам на себя — DUPLICATE', (status) => {
    expect(classifyTradeStatusObservation(status, status)).toBe('DUPLICATE');
  });

  it('нетерминальный → любой другой = ACCEPT', () => {
    for (const current of TRANSIENT) {
      for (const incoming of ALL_STATUSES) {
        if (current === incoming) continue;
        expect(classifyTradeStatusObservation(current, incoming)).toBe('ACCEPT');
      }
    }
  });

  it('терминальный → нетерминальный = STALE', () => {
    for (const current of TERMINAL) {
      for (const incoming of TRANSIENT) {
        expect(classifyTradeStatusObservation(current, incoming)).toBe('STALE');
      }
    }
  });

  it('CONFIRMED → MINED = STALE, а не ошибка', () => {
    // Наблюдение сделано РАНЬШЕ и доехало позже. Это порядок доставки, а не
    // движение площадки назад; у потребителя такое приходит по подписке, и
    // штатное переупорядочивание сети не должно становиться отказом.
    expect(classifyTradeStatusObservation('CONFIRMED', 'MINED')).toBe('STALE');
  });

  it('два РАЗНЫХ терминальных исхода = CONFLICT', () => {
    expect(classifyTradeStatusObservation('CONFIRMED', 'FAILED')).toBe('CONFLICT');
    expect(classifyTradeStatusObservation('FAILED', 'CONFIRMED')).toBe('CONFLICT');
  });

  it('CONFLICT возникает ТОЛЬКО между разными терминальными', () => {
    const conflicts: Array<[TradeStatus, TradeStatus]> = [];
    for (const current of ALL_STATUSES) {
      for (const incoming of ALL_STATUSES) {
        if (classifyTradeStatusObservation(current, incoming) === 'CONFLICT') {
          conflicts.push([current, incoming]);
        }
      }
    }
    expect(conflicts.sort()).toEqual([
      ['CONFIRMED', 'FAILED'],
      ['FAILED', 'CONFIRMED'],
    ]);
  });

  it('разбор полон: на всём union возвращается известный исход', () => {
    const known: readonly TradeStatusObservation[] = ['ACCEPT', 'DUPLICATE', 'STALE', 'CONFLICT'];
    for (const current of ALL_STATUSES) {
      for (const incoming of ALL_STATUSES) {
        expect(known).toContain(classifyTradeStatusObservation(current, incoming));
      }
    }
  });
});
