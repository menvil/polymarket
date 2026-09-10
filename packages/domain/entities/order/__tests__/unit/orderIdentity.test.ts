/**
 * Сравнение заявок: идентичность отдельно от состояния.
 *
 * @remarks
 * Проверяется то, чего сценарий не показывает: что сравнение идёт по
 * canonical-равенствам value objects, а не по ссылке и не по строке. Разница
 * видна только на парах, где ссылки различаются, а значения совпадают, — и
 * наоборот.
 */
import { describe, expect, it } from '@jest/globals';
import { unsafeStrategyId, type StrategyId } from '@polymarket/ids';
import {
  findOrderIdentityDifference,
  sameOrderIdentity,
  sameOrderState,
} from '../../src/identity';
import { DOWN_TOKEN, must, order, walletAccount, withFill } from '../identityFixtures';
import { nextTestMetadata } from '../helpers';

/** Идентификатор стратегии для проверки поля идентичности. */
function strategyId(raw: string): StrategyId {
  return unsafeStrategyId(raw);
}

describe('§45. идентичность и состояние заявки', () => {
  it('пересобранная заявка равна исходной по идентичности и по состоянию', () => {
    const a = order({ accountId: walletAccount() });
    const b = order({ accountId: walletAccount() });
    expect(a).not.toBe(b);
    expect(sameOrderIdentity(a, b)).toBe(true);
    expect(sameOrderState(a, b)).toBe(true);
    expect(findOrderIdentityDifference(a, b)).toBeUndefined();
  });

  it('разные OrderId различаются по полю id', () => {
    const difference = findOrderIdentityDifference(order({ id: 'order-1' }), order({ id: 'order-2' }));
    expect(difference?.field).toBe('id');
    expect(difference?.left).toBe('order-1');
    expect(difference?.right).toBe('order-2');
  });

  it('инструмент входит в идентичность', () => {
    const difference = findOrderIdentityDifference(order(), order({ asset: DOWN_TOKEN }));
    expect(difference?.field).toBe('asset');
    expect(difference?.left).not.toBe(difference?.right);
  });

  it('сторона, цена и объём входят в идентичность', () => {
    expect(findOrderIdentityDifference(order(), order({ side: 'SELL' }))?.field).toBe('side');
    expect(findOrderIdentityDifference(order(), order({ price: 0.42 }))?.field).toBe('price');
    expect(findOrderIdentityDifference(order(), order({ size: 250 }))?.field).toBe('size');
    expect(findOrderIdentityDifference(order(), order({ timestampMs: 1 }))?.field).toBe('timestamp');
  });

  it('отсутствующий владелец отличается от присутствующего', () => {
    const withOwner = order({ accountId: walletAccount() });
    const withoutOwner = order({ accountId: null });
    expect(findOrderIdentityDifference(withOwner, withoutOwner)?.field).toBe('accountId');
    expect(findOrderIdentityDifference(withoutOwner, withOwner)?.field).toBe('accountId');
    expect(findOrderIdentityDifference(withoutOwner, order({ accountId: null }))).toBeUndefined();
  });

  it('отсутствующая стратегия отличается от заданной', () => {
    const difference = findOrderIdentityDifference(
      order({ strategyId: strategyId('alpha') }),
      order(),
    );
    expect(difference?.field).toBe('strategyId');
    expect(difference?.left).toBe('alpha');
    expect(difference?.right).toBe('<none>');
  });

  it('идентичность равна, а состояние — нет: это и есть законное обновление', () => {
    const open = must(order({ accountId: walletAccount() }).accept());
    const partially = withFill(open, { size: 40 });

    expect(sameOrderIdentity(open, partially)).toBe(true);
    expect(sameOrderState(open, partially)).toBe(false);
  });

  it('буфер драфтов событий в сравнение НЕ входит', () => {
    // `Order.create()` кладёт в буфер OrderCreatedEvent, а `pullEvents()`
    // опустошает его мутацией. Заявка, у которой драфты слиты, и заявка, у
    // которой ещё нет, — одна и та же заявка: буфер описывает, что осталось
    // ОПУБЛИКОВАТЬ, а не торговое состояние.
    //
    // Если это когда-нибудь перестанет быть так, приватное состояние начнёт
    // считать повторно доставленный commit «законным обновлением» и применит
    // устаревший портфель.
    const withDrafts = order();
    const drained = order();
    expect(drained.pullEvents(() => nextTestMetadata()).length).toBeGreaterThan(0);

    expect(sameOrderIdentity(withDrafts, drained)).toBe(true);
    expect(sameOrderState(withDrafts, drained)).toBe(true);
    expect(findOrderIdentityDifference(withDrafts, drained)).toBeUndefined();
  });

  it('состояние различается по каждому изменяемому полю', () => {
    const open = must(order({ accountId: walletAccount() }).accept());

    // status
    expect(sameOrderState(open, order({ accountId: walletAccount() }))).toBe(false);
    // reason
    const canceled = must(open.cancel('risk'));
    const canceledOther = must(open.cancel('strategy'));
    expect(sameOrderIdentity(canceled, canceledOther)).toBe(true);
    expect(sameOrderState(canceled, canceledOther)).toBe(false);
    // filledSize и averagePrice
    const fortyAt65 = withFill(open, { id: 'fill-a', size: 40 });
    const twentyAt65 = withFill(open, { id: 'fill-a', size: 20 });
    expect(sameOrderState(fortyAt65, twentyAt65)).toBe(false);
    // averagePrice при равном объёме, но разной цене
    const fortyAt70 = withFill(open, { id: 'fill-a', size: 40, price: 0.7 });
    expect(sameOrderState(fortyAt65, fortyAt70)).toBe(false);
    // averagePrice: undefined против заданного
    expect(sameOrderState(open, fortyAt65)).toBe(false);
    // fillIds: тот же объём, но другое исполнение
    const fortyOtherFill = withFill(open, { id: 'fill-b', size: 40 });
    expect(sameOrderIdentity(fortyAt65, fortyOtherFill)).toBe(true);
    expect(sameOrderState(fortyAt65, fortyOtherFill)).toBe(false);
    // fillIds: разное количество исполнений при равном суммарном объёме
    const twiceTwenty = withFill(withFill(open, { id: 'fill-a', size: 20 }), {
      id: 'fill-b',
      size: 20,
    });
    expect(sameOrderState(fortyAt65, twiceTwenty)).toBe(false);
  });
});
