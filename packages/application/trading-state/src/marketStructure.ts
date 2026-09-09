/**
 * Сравнение canonical `Market` по trading-critical структуре.
 *
 * @remarks
 * `TRADING_MARKET_RESOLVED` приносит рынок целиком, и его нужно принять на
 * место уже сохранённого. Вопрос «тот же ли это рынок» имеет два разных
 * ответа, и оба нужны:
 *
 * ```text
 * Market.equals()          venueId + id           — та же СУЩНОСТЬ
 * sameTradingMarketStructure()  + расписание,     — та же торговая СТРУКТУРА
 *                          исходы, семейство
 * ```
 *
 * `Market.equals()` для замены недостаточно: он сравнивает только
 * идентичность сущности и вернёт `true` для рынка с тем же id, но другими
 * `InstrumentId` исходов или другим расписанием. Принять такой рынок значило
 * бы, что накопленная история инструментов и торговые решения относятся к
 * структуре, которой в состоянии больше нет.
 *
 * ### Что НЕ входит в сравнение
 *
 * ```text
 * question, slug   display metadata — площадка вправе уточнить формулировку
 * state            ОБЯЗАН измениться: в этом и смысл резолюции
 * ```
 *
 * ### Почему не `JSON.stringify(market)`
 *
 * Сериализация сравнила бы и `question`, и `state`, то есть отвергла бы любую
 * законную резолюцию. Кроме того, `Timestamp` и branded-типы попали бы в
 * сравнение в виде их внутреннего представления, и порядок ключей влиял бы на
 * результат.
 */
import type { Market, MarketOutcome } from '@polymarket/market';

/** Поле структуры, по которому рынки могут разойтись. */
export type TradingMarketStructuralField =
  | 'venueId'
  | 'id'
  | 'startsAt'
  | 'expiresAt'
  | 'outcomes[0].index'
  | 'outcomes[0].instrumentId'
  | 'outcomes[1].index'
  | 'outcomes[1].instrumentId'
  | 'family'
  | 'crypto'
  | 'crypto.asset'
  | 'crypto.duration';

/**
 * Первое найденное расхождение структуры.
 *
 * @remarks
 * Значения приведены к строкам сразу: контекст ошибки уходит в логи, а
 * `Timestamp` и branded-типы в сериализованном виде читаются хуже, чем ISO и
 * сам идентификатор.
 */
export interface TradingMarketStructureDifference {
  /** Какое поле разошлось */
  readonly field: TradingMarketStructuralField;
  /** Значение у уже принятого рынка */
  readonly admitted: string;
  /** Значение у пришедшего рынка */
  readonly incoming: string;
}

/** Пара сравниваемых значений одного поля. */
interface FieldProbe {
  readonly field: TradingMarketStructuralField;
  readonly admitted: string;
  readonly incoming: string;
  readonly equal: boolean;
}

/** Проба по строковому (или branded-строковому) полю. */
function sameString(
  field: TradingMarketStructuralField,
  admitted: string,
  incoming: string,
): FieldProbe {
  return { field, admitted, incoming, equal: admitted === incoming };
}

/** Проба по числовому полю. */
function sameNumber(
  field: TradingMarketStructuralField,
  admitted: number,
  incoming: number,
): FieldProbe {
  return {
    field,
    admitted: String(admitted),
    incoming: String(incoming),
    equal: admitted === incoming,
  };
}

/** Пробы по одному исходу — позиция и canonical identity инструмента. */
function outcomeProbes(
  position: 0 | 1,
  admitted: MarketOutcome,
  incoming: MarketOutcome,
): readonly FieldProbe[] {
  return [
    sameNumber(
      position === 0 ? 'outcomes[0].index' : 'outcomes[1].index',
      admitted.index,
      incoming.index,
    ),
    sameString(
      position === 0 ? 'outcomes[0].instrumentId' : 'outcomes[1].instrumentId',
      admitted.instrumentId,
      incoming.instrumentId,
    ),
  ];
}

/**
 * Пробы по предметной спецификации семейства.
 *
 * @remarks
 * `Market.create()` требует `crypto` ровно у `CRYPTO_UP_DOWN` и запрещает
 * остальным, поэтому при совпавшем `family` присутствие спецификации совпадает
 * автоматически. Проба `'crypto'` всё равно есть: она ловит рынок, собранный
 * в обход валидации (например, восстановленный из повреждённого снапшота), и
 * делает это отказом, а не молчаливым пропуском сравнения полей.
 */
function cryptoProbes(admitted: Market, incoming: Market): readonly FieldProbe[] {
  const a = admitted.crypto;
  const b = incoming.crypto;

  if (a === undefined || b === undefined) {
    return [
      {
        field: 'crypto',
        admitted: a === undefined ? 'absent' : 'present',
        incoming: b === undefined ? 'absent' : 'present',
        equal: (a === undefined) === (b === undefined),
      },
    ];
  }

  return [
    sameString('crypto.asset', a.asset, b.asset),
    sameNumber('crypto.duration', a.duration, b.duration),
  ];
}

/**
 * Находит первое расхождение trading-critical структуры двух рынков.
 *
 * @param admitted - Рынок, уже принятый торговым рантаймом
 * @param incoming - Рынок из пришедшего события
 * @returns Описание первого расхождения либо `undefined`, если структура та же
 *
 * @remarks
 * Сравниваются: `venueId`, `id`, расписание (`startsAt`/`expiresAt`), позиции и
 * `InstrumentId` обоих исходов, `family` и его спецификация. `question`, `slug`
 * и `state` не сравниваются намеренно.
 *
 * Возвращается ПЕРВОЕ расхождение, а не список: для отказа достаточно одного,
 * а собирать все означало бы делать лишнюю работу на пути, который всё равно
 * заканчивается ошибкой.
 *
 * @example
 * ```typescript
 * const diff = findTradingMarketStructureDifference(state.market, incoming);
 * if (diff !== undefined) return Err(new TradingMarketStructureConflictError(id, diff));
 * ```
 */
export function findTradingMarketStructureDifference(
  admitted: Market,
  incoming: Market,
): TradingMarketStructureDifference | undefined {
  const probes: readonly FieldProbe[] = [
    sameString('venueId', admitted.venueId, incoming.venueId),
    sameString('id', admitted.id, incoming.id),
    {
      field: 'startsAt',
      admitted: admitted.startsAt.toISO(),
      incoming: incoming.startsAt.toISO(),
      equal: admitted.startsAt.equals(incoming.startsAt),
    },
    {
      field: 'expiresAt',
      admitted: admitted.expiresAt.toISO(),
      incoming: incoming.expiresAt.toISO(),
      equal: admitted.expiresAt.equals(incoming.expiresAt),
    },
    ...outcomeProbes(0, admitted.outcomes[0], incoming.outcomes[0]),
    ...outcomeProbes(1, admitted.outcomes[1], incoming.outcomes[1]),
    sameString('family', admitted.family, incoming.family),
    ...cryptoProbes(admitted, incoming),
  ];

  const difference = probes.find((probe) => !probe.equal);
  if (difference === undefined) return undefined;
  return {
    field: difference.field,
    admitted: difference.admitted,
    incoming: difference.incoming,
  };
}

/**
 * Совпадает ли trading-critical структура двух рынков.
 *
 * @param admitted - Рынок, уже принятый торговым рантаймом
 * @param incoming - Рынок из пришедшего события
 * @returns `true`, если ни одно структурное поле не разошлось
 *
 * @remarks
 * Тонкая обёртка над {@link findTradingMarketStructureDifference} для мест, где
 * нужен только ответ «да/нет». Там, где расхождение попадёт в ошибку, лучше
 * брать само расхождение — иначе его придётся искать второй раз.
 *
 * @example
 * ```typescript
 * sameTradingMarketStructure(admittedMarket, resolvedMarket); // → true
 * ```
 */
export function sameTradingMarketStructure(admitted: Market, incoming: Market): boolean {
  return findTradingMarketStructureDifference(admitted, incoming) === undefined;
}
