/**
 * Сравнение исполнений: `Fill` целиком неизменяем, поэтому меняться ему нечем.
 *
 * @remarks
 * В отличие от заявки, у исполнения нет «изменяемой части»: `Fill` — это
 * зафиксированный факт сделки, и ВСЕ его поля входят в идентичность. Отсюда
 * всего два случая по одному `FillId`:
 *
 * ```text
 * тот же факт      то же исполнение, полученное повторно
 * другой факт      ДРУГОЕ исполнение под чужим идентификатором
 * ```
 *
 * Третьего («законное обновление») быть не может: цена, размер или сторона
 * исполнения не «уточняются». Что делать с каждым исходом — решает
 * потребитель: приватное состояние считает первый дубликатом доставки, а
 * второй конфликтом, но само это решение здесь не зашито.
 *
 * ### Почему это живёт в домене
 *
 * «Что делает два `Fill` одним фактом исполнения» — знание об исполнении, а
 * не о конкретном потребителе. Сверка с площадкой, приватное состояние и
 * восстановление после разрыва задают один и тот же вопрос, и три
 * независимых ответа на него разошлись бы.
 *
 * ### Почему не `JSON.stringify` и не сравнение по ссылке
 *
 * `Fill` пересобирается на каждом входе (из WS-наблюдения, из REST-сверки,
 * из архива), поэтому по ссылке равными два экземпляра одного факта не
 * бывают. `JSON.stringify` же зависит от внутреннего представления `Decimal`
 * внутри `OutcomePrice`/`Quantity`/`Fee` и от порядка полей `AssetId` — то
 * есть даёт и ложные расхождения, и ложные совпадения.
 */
import { AssetIdHelpers, accountIdEquals, accountIdToString, assetIdToString } from '@polymarket/ids';
import type { Fill } from './Fill.js';
import { SideService } from '@polymarket/value-objects';

/** Поле факта исполнения, по которому нашлось расхождение. */
export type FillFactField =
  | 'id'
  | 'orderId'
  | 'accountId'
  | 'venueId'
  | 'marketId'
  | 'tokenId'
  | 'settlementAssetId'
  | 'price'
  | 'size'
  | 'side'
  | 'timestamp'
  | 'fee';

/**
 * Первое найденное расхождение факта исполнения.
 *
 * @remarks
 * Значения приводятся к строкам ДЛЯ ЛОГА. Сравнение выполняется по value
 * objects и canonical-равенствам, а не по этим строкам.
 *
 * Имена `left`/`right` нейтральны намеренно: домен не знает, какое из двух
 * исполнений «сохранённое», а какое «пришедшее». Эту роль называет
 * потребитель, когда строит сообщение об ошибке.
 */
export interface FillFactDifference {
  /** Поле, по которому исполнения разошлись */
  readonly field: FillFactField;
  /** Значение в первом аргументе */
  readonly left: string;
  /** Значение во втором аргументе */
  readonly right: string;
}

/**
 * Ищет расхождение неизменяемого факта двух исполнений.
 *
 * @param left - Первое исполнение
 * @param right - Второе исполнение
 * @returns Первое расхождение либо `undefined`, если факты идентичны
 *
 * @remarks
 * Порядок проверок — от самых дешёвых (строковые идентификаторы) к более
 * дорогим (`Decimal`-сравнения внутри value objects): подавляющее
 * большинство расхождений ловится первыми же сравнениями.
 *
 * @example
 * ```typescript
 * const difference = findFillFactDifference(stored, incoming);
 * if (difference !== undefined) {
 *   logger.warn(`fill ${stored.id} differs on ${difference.field}`);
 * }
 * ```
 */
export function findFillFactDifference(
  left: Fill,
  right: Fill,
): FillFactDifference | undefined {
  if (left.id !== right.id) {
    return { field: 'id', left: left.id, right: right.id };
  }

  if (left.orderId !== right.orderId) {
    return { field: 'orderId', left: left.orderId, right: right.orderId };
  }

  // accountId — объект, а не строка: сравнивается canonical-равенством.
  if (!accountIdEquals(left.accountId, right.accountId)) {
    return {
      field: 'accountId',
      left: accountIdToString(left.accountId),
      right: accountIdToString(right.accountId),
    };
  }

  if (left.venueId !== right.venueId) {
    return { field: 'venueId', left: left.venueId, right: right.venueId };
  }

  if (left.marketId !== right.marketId) {
    return { field: 'marketId', left: left.marketId, right: right.marketId };
  }

  if (!AssetIdHelpers.equals(left.tokenId, right.tokenId)) {
    return {
      field: 'tokenId',
      left: assetIdToString(left.tokenId),
      right: assetIdToString(right.tokenId),
    };
  }

  if (!AssetIdHelpers.equals(left.settlementAssetId, right.settlementAssetId)) {
    return {
      field: 'settlementAssetId',
      left: assetIdToString(left.settlementAssetId),
      right: assetIdToString(right.settlementAssetId),
    };
  }

  if (!SideService.equals(left.side, right.side)) {
    return { field: 'side', left: left.side, right: right.side };
  }

  if (!left.price.equals(right.price)) {
    return {
      field: 'price',
      left: left.price.value().toString(),
      right: right.price.value().toString(),
    };
  }

  if (!left.size.equals(right.size)) {
    return {
      field: 'size',
      left: left.size.value().toString(),
      right: right.size.value().toString(),
    };
  }

  if (!left.timestamp.equals(right.timestamp)) {
    return {
      field: 'timestamp',
      left: left.timestamp.toISO(),
      right: right.timestamp.toISO(),
    };
  }

  // Fee.equals сравнивает и актив комиссии, и её величину — комиссия «та же
  // сумма, но в другом активе» фактом того же исполнения не является.
  if (!left.fee.equals(right.fee)) {
    return { field: 'fee', left: left.fee.toString(), right: right.fee.toString() };
  }

  return undefined;
}

/**
 * Исполнения описывают один и тот же факт сделки.
 *
 * @param a - Первое исполнение
 * @param b - Второе исполнение
 * @returns `true`, если совпали ВСЕ поля обоих `Fill`
 *
 * @remarks
 * Тот же `FillId` с тем же фактом означает повторно полученное исполнение;
 * тот же `FillId` с другим фактом — другое исполнение под чужим
 * идентификатором. Реакцию выбирает потребитель.
 *
 * @example
 * ```typescript
 * if (sameFillFact(stored, incoming)) return; // уже знаем этот факт
 * ```
 */
export function sameFillFact(a: Fill, b: Fill): boolean {
  return findFillFactDifference(a, b) === undefined;
}
