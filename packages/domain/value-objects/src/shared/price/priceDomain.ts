/**
 * Описание ценового домена для общих операций над ценами.
 *
 * @remarks
 * ## Зачем
 *
 * Арифметика цен (`multiply`, `divide`, `average`, `applyRelativeChange`),
 * выравнивание по тику, форматирование и JSON round-trip у обоих ценовых
 * доменов идентичны с точностью до ТРЁХ вещей:
 *
 * ```text
 * как собрать результат обратно в цену   → create
 * каким типом ошибки сообщать о провале  → ErrorConstructor
 * как назвать сервис в контексте ошибки  → serviceName
 * ```
 *
 * Всё остальное — те же `Decimal`-операции с теми же проверками. Держать
 * две копии этого кода (по одной на домен) значило бы дублировать логику,
 * которая от домена не зависит, и чинить будущие дефекты дважды.
 *
 * ## Почему не наследование
 *
 * Общий предок `Price` с двумя наследниками выглядит естественно, но ломает
 * ровно то, ради чего домены разделены: предок обязан иметь самый слабый
 * инвариант, и тогда `AssetPrice` подставляется туда, где ждут
 * `OutcomePrice`. Плюс `equals` стал бы сравнивать доли исхода с ценами
 * актива, а приватные конструкторы со статическими фабриками через
 * `extends` не переиспользуются.
 *
 * Здесь переиспользуются ОПЕРАЦИИ, а типы остаются несмешиваемыми — тот же
 * приём, что у `bookPricing` в `@polymarket/orderbook`.
 *
 * @example
 * ```typescript
 * const OUTCOME_DOMAIN: PriceDomain<OutcomePrice, InvalidOutcomePriceError> = {
 *   serviceName: 'OutcomePriceService',
 *   ErrorConstructor: InvalidOutcomePriceError,
 *   invalidFormatReason: OutcomePriceErrorReason.INVALID_FORMAT,
 *   create: (value) => OutcomePriceService.create(value),
 * };
 *
 * multiplyPrice(OUTCOME_DOMAIN, price, 2);
 * ```
 */
import type Decimal from 'decimal.js';
import type { Result } from '@polymarket/result';
import type { AnyTradingError, ErrorConstructor } from '@polymarket/errors';
import type { DecimalPrice } from './DecimalPrice.js';

export interface PriceDomain<TPrice extends DecimalPrice, TError extends AnyTradingError> {
  /** Имя сервиса домена — попадает в `context.service` ошибки. */
  readonly serviceName: string;
  /** Класс ошибки домена (`InvalidOutcomePriceError` и т.п.). */
  readonly ErrorConstructor: ErrorConstructor<TError>;
  /** Причина, которой домен помечает непарсящийся операнд. */
  readonly invalidFormatReason: string;
  /**
   * Фабрика цены домена.
   *
   * @remarks
   * Именно она делает операцию доменной: результат арифметики проверяется
   * инвариантами конкретного домена (диапазон `[0.0001, 0.9999]` либо
   * «строго положительно»), и выход за них становится `Err`.
   *
   * Принимает `number | string | Decimal` — ровно то, что умеют фабрики
   * доменов. Строка нужна десериализации: значение из JSON хранится строкой
   * ради точности и парсится без промежуточного `number`.
   */
  readonly create: (value: number | string | Decimal) => Result<TPrice, TError>;
  /**
   * Верхняя граница шага сетки, если домен её имеет.
   *
   * @remarks
   * У рынка предсказаний тик не может превышать ширину диапазона
   * `[MIN, MAX]`; у цены актива верхней границы нет вовсе, и поле остаётся
   * `undefined` — проверка тогда не выполняется, а не выдумывает предел.
   */
  readonly maxTickSize?: Decimal;
}
