/**
 * Сравнение портфелей по полному состоянию.
 *
 * @remarks
 * `Portfolio` immutable: каждая операция возвращает новый экземпляр, а
 * authoritative-снимок площадки собирается заново при каждом чтении. Поэтому
 * вопрос «изменил бы этот портфель что-нибудь» решается по содержимому, а не по
 * ссылке, — иначе любая сверка, даже ничего не нашедшая, считалась бы
 * мутацией.
 *
 * ### Почему это живёт в домене
 *
 * «Что делает два портфеля одним состоянием» — знание о портфеле: из каких
 * частей он состоит и какие из них значимы. Держать это правило у потребителя
 * (сверки аккаунта) значило бы завести второе определение агрегата, которое
 * разошлось бы с первым при следующем же изменении `Portfolio`.
 *
 * ### Что сравнивается
 *
 * ```text
 * id, accountId                        идентичность агрегата
 * balance        available, reserved,  деньги и их владелец
 *                currency, accountId,
 *                venueId
 * positions      по InstrumentId       samePositionState — лоты, история, PnL
 * tokenBalances  по InstrumentId       TokenBalance.equals — available + reserved
 * ```
 *
 * Карты сравниваются как отображения, а не как последовательности: порядок
 * вставки в `Map` — артефакт того, каким путём собран агрегат, и смысла для
 * состояния не несёт.
 *
 * ### Почему не `JSON.stringify` и не `===`
 *
 * `Decimal` сериализуется по внутреннему представлению (`100` против
 * `100.00`), `AccountId` — объект с canonical-равенством (`accountIdEquals`
 * нечувствителен к регистру адреса кошелька), а `Map` в JSON не
 * сериализуется вовсе. Каждое поле сравнивается своим canonical-равенством.
 */
import { accountIdEquals, type InstrumentId } from '@polymarket/ids';
import { samePositionState, type Position } from '@polymarket/position';
import type { Balance } from '@polymarket/value-objects/balance';
import type { TokenBalance } from '@polymarket/value-objects/token-balance';
import type { Portfolio } from './Portfolio.js';

/**
 * Два портфеля описывают одно и то же состояние аккаунта.
 *
 * @param a - Первый портфель
 * @param b - Второй портфель
 * @returns `true`, если совпали идентичность, деньги, позиции и токенные балансы
 *
 * @remarks
 * Сравнение строгое, без epsilon. Разные валюты баланса дают `false`, а не
 * ошибку: вопрос «то же ли это состояние» имеет ответ и для несравнимых сумм.
 *
 * @example
 * ```typescript
 * if (samePortfolioState(stored, authoritative)) {
 *   // сверка ничего не меняет — мутации нет
 * }
 * ```
 */
export function samePortfolioState(a: Portfolio, b: Portfolio): boolean {
  if (a.id !== b.id) return false;
  if (!accountIdEquals(a.accountId, b.accountId)) return false;
  if (!sameBalanceState(a.balance, b.balance)) return false;
  if (!sameKeyedState(a.positions, b.positions, samePositionState)) return false;
  return sameKeyedState(a.tokenBalances, b.tokenBalances, sameTokenBalanceState);
}

/**
 * Балансы совпадают по деньгам и по владельцу.
 *
 * @param a - Первый баланс
 * @param b - Второй баланс
 * @returns `true`, если совпали валюта, available, reserved, аккаунт и площадка
 *
 * @remarks
 * `BalanceService.equals` не подходит: на разных валютах он возвращает `Err`,
 * тогда как для сравнения состояний это просто «не то же самое».
 */
function sameBalanceState(a: Balance, b: Balance): boolean {
  if (!a.hasSameCurrency(b)) return false;
  if (!a.available().value().equals(b.available().value())) return false;
  if (!a.reserved().value().equals(b.reserved().value())) return false;
  if (!accountIdEquals(a.accountId(), b.accountId())) return false;
  return a.venueId() === b.venueId();
}

/**
 * Токенные балансы совпадают.
 *
 * @param a - Первый баланс
 * @param b - Второй баланс
 * @returns Результат canonical `TokenBalance.equals`
 */
function sameTokenBalanceState(a: TokenBalance, b: TokenBalance): boolean {
  return a.equals(b);
}

/**
 * Две карты по инструментам описывают одно и то же.
 *
 * @param a - Первая карта
 * @param b - Вторая карта
 * @param same - Canonical-равенство значений
 * @returns `true`, если совпали наборы ключей и значения под каждым ключом
 */
function sameKeyedState<T extends Position | TokenBalance>(
  a: ReadonlyMap<InstrumentId, T>,
  b: ReadonlyMap<InstrumentId, T>,
  same: (left: T, right: T) => boolean,
): boolean {
  if (a.size !== b.size) return false;
  for (const [instrumentId, left] of a) {
    const right = b.get(instrumentId);
    if (right === undefined || !same(left, right)) return false;
  }
  return true;
}
