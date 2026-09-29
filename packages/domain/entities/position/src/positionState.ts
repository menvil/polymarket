/**
 * Сравнение позиций по полному состоянию.
 *
 * @remarks
 * Позиция — immutable-сущность, и каждая операция над ней (`close()`,
 * `addLots()`) возвращает новый экземпляр. Поэтому два объекта, описывающие
 * одну и ту же позицию, по ссылке равными почти никогда не бывают: один собран
 * живым контуром, другой — из authoritative-снимка площадки. Вопрос «изменилось
 * ли что-нибудь» обязан решаться по содержимому.
 *
 * ### Почему это живёт в домене
 *
 * «Что делает две позиции одним и тем же состоянием» — знание о позиции, а не о
 * конкретном потребителе. Сверка аккаунта, приватное состояние и будущая
 * персистентность задают один и тот же вопрос, и независимые ответы на него
 * разошлись бы — ровно так, как это случилось бы с `sameOrderState` и
 * `sameFillFact`, живи они у потребителей.
 *
 * ### Что сравнивается
 *
 * ```text
 * id, accountId, instrumentId, asset, side     идентичность позиции
 * openedAt, updatedAt                          история операций
 * openedQuantity, realizedPnL                  накопленная экономика
 * lots (по порядку, включая комиссию лота)     единственный источник quantity
 * ```
 *
 * `quantity` и `averageEntryPrice` отдельно НЕ сравниваются: это производные
 * от лотов, и равенство лотов уже их покрывает.
 *
 * ### Почему не `JSON.stringify` и не `PositionLot.equals`
 *
 * `Decimal` внутри `Quantity`/`OutcomePrice` сериализуется по внутреннему
 * представлению (`0.65` против `0.650`), а `AssetId` — размеченное объединение,
 * чья строка зависит от порядка полей. `PositionLot.equals` же сознательно
 * игнорирует комиссию лота, а для «то же ли это состояние» комиссия — часть
 * истории позиции: лот с комиссией и без неё — разные исходы исполнения.
 */
import { AssetIdHelpers, accountIdEquals } from '@polymarket/ids';
import type { Fee } from '@polymarket/value-objects';
import type { PositionLot } from './core/PositionLot.js';
import type { Position } from './Position.js';

/**
 * Две позиции описывают одно и то же состояние.
 *
 * @param a - Первая позиция
 * @param b - Вторая позиция
 * @returns `true`, если совпали идентичность, история, накопленная экономика и
 *   все лоты в том же порядке
 *
 * @remarks
 * Лоты сравниваются ПО ПОРЯДКУ: конструктор `Position` сортирует их по времени,
 * и FIFO-закрытие опирается именно на этот порядок. Та же пара лотов в другом
 * порядке — другая очередь закрытия, а не та же позиция.
 *
 * Сравнение строгое, без epsilon: `Decimal.equals` внутри value objects.
 *
 * @example
 * ```typescript
 * samePositionState(position, position);                  // → true
 * samePositionState(position, position.addLots([lot], at).value); // → false
 * ```
 */
export function samePositionState(a: Position, b: Position): boolean {
  if (a.id !== b.id) return false;
  if (a.instrumentId !== b.instrumentId) return false;
  if (a.side !== b.side) return false;
  if (!accountIdEquals(a.accountId, b.accountId)) return false;
  if (!AssetIdHelpers.equals(a.asset, b.asset)) return false;
  if (!a.openedAt.equals(b.openedAt)) return false;
  if (!a.updatedAt.equals(b.updatedAt)) return false;
  if (!a.openedQuantity.equals(b.openedQuantity)) return false;
  if (!a.realizedPnL.equals(b.realizedPnL)) return false;

  if (a.lots.length !== b.lots.length) return false;
  return a.lots.every((lot, index) => sameLotState(lot, b.lots[index]));
}

/**
 * Лоты совпадают полностью — включая комиссию.
 *
 * @param a - Первый лот
 * @param b - Второй лот (может отсутствовать при выходе за границу массива)
 * @returns `true`, если совпали количество, цена входа, время и комиссия
 *
 * @remarks
 * `PositionLot.equals` покрывает первые три поля; комиссия добавляется здесь,
 * а не меняется в самом `equals`, потому что у того есть собственные
 * потребители с собственным контрактом.
 */
function sameLotState(a: PositionLot, b: PositionLot | undefined): boolean {
  if (b === undefined) return false;
  return a.equals(b) && sameOptionalFee(a.fee, b.fee);
}

/**
 * Две возможно отсутствующие комиссии совпадают.
 *
 * @param a - Первая комиссия
 * @param b - Вторая комиссия
 * @returns `true`, если обе отсутствуют либо обе есть и равны
 *
 * @remarks
 * `Fee.equals` сравнивает и актив комиссии, и её величину.
 */
function sameOptionalFee(a: Fee | undefined, b: Fee | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.equals(b);
}
