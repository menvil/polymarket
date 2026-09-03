/**
 * Контроллер общих CEX-подписок: спрос владельцев → логические claim-ы →
 * агрегированные физические пулы → поколения `CexSource`.
 *
 * @remarks
 * ### Что здесь появляется впервые в контуре
 *
 * ```text
 * owner demands (ownerKey + CexPolicy)
 *          ↓  policy оценивается НА `now`
 * logical claims  (owner + exchange + marketType + symbol + stream)
 *          ↓  агрегация
 * physical pools  (exchange + marketType + stream)
 *          ↓  immutable поколения
 * CexSource → ExternalMessageBus
 * ```
 *
 * `CexPolicy`, `CexSource` и общая шина существовали и раньше — не
 * существовало слоя, который превращает НЕСКОЛЬКО owner-policy в
 * РАЗДЕЛЯЕМЫЕ физические потоки. Главный принцип ровно один:
 *
 * > несколько владельцев одного CEX-ресурса делят физический поток, а не
 * > создают дубликаты.
 *
 * ### CEX-спрос авторитетен (не копия Polymarket-контроллера)
 *
 * ```text
 * Polymarket: demands ≠ desired state   (ACQUISITION ≠ RETENTION)
 * CEX:        demands = desired state
 * ```
 *
 * У площадки предсказаний рынок исчезает из плана в момент старта
 * торгов — трактовать это как «отписаться» означало бы рвать подписку
 * тогда, когда она начала приносить данные. У биржи ничего подобного нет:
 * `BTC/USDT` — непрерывный поток без `startsAt`, `expiry` и rollover, и
 * единственная причина его держать — что кто-то его СЕЙЧАС хочет.
 * Поэтому пропавший из `demands` владелец действительно теряет claim-ы, а
 * ресурс, которого больше никто не хочет, закрывается.
 *
 * ### Policy оценивается на `now`, а не на «момент старта рынка»
 *
 * ```text
 * Polymarket: isPolicyEffectiveAt(policy, market.startsAt)
 * CEX:        isPolicyEffectiveAt(policy, now)
 * ```
 *
 * Вопрос у CEX другой: не «подойдёт ли этот рынок, когда он начнётся», а
 * «нужен ли этому владельцу непрерывный поток прямо сейчас».
 * Полуоткрытая семантика окна при этом сохраняется целиком:
 *
 * ```text
 * BTC policy effectiveUntil 18:00 · XRP policy effectiveFrom 18:00
 *
 * 17:59:59.999 → BTC активна,   XRP неактивна
 * 18:00:00.000 → BTC неактивна, XRP активна
 * ```
 *
 * ### Гранулярность пула: ОДИН CCXT-инстанс на поток
 *
 * ```text
 * pool key = exchangeId + marketType + stream
 *
 * binance|swap|ORDERBOOK   symbols = [BTC, ETH]      depth 50
 * binance|swap|TRADES      symbols = [BTC, ETH, XRP]
 * ```
 *
 * НЕ пул на владельца и НЕ пул на символ: `CexSource` специально
 * оптимизирован под «один CCXT Pro instance на поток для всех символов
 * одной биржи и типа рынка», и контроллер обязан сохранить эту
 * архитектуру, а не обойти её.
 *
 * Стакан и сделки — РАЗНЫЕ пулы, потому что `CexSource` и так держит для
 * них независимые transport-сессии, а разделение на уровне контроллера
 * даёт главное: смена набора символов стакана не заставляет
 * перезапускать поток сделок.
 *
 * ### Глубина стакана агрегируется МАКСИМУМОМ
 *
 * ```text
 * A: BTC depth 10 · B: BTC depth 50 · C: ETH depth 20
 * → binance|swap|ORDERBOOK  symbols=[BTC, ETH]  depth = 50
 * ```
 *
 * Более глубокий поток удовлетворяет и того, кому хватает меньшей
 * глубины: потребитель возьмёт нужный ему срез сам. Альтернатива —
 * поднять два источника на один и тот же символ с разной глубиной — дала
 * бы шине ДВЕ записи одной routing identity, которые data-plane никак не
 * различит.
 *
 * ### Полный desired snapshot строится ДО побочных эффектов
 *
 * ```text
 * 1. валидация ВСЕГО входа
 * 2. оценка PolicyWindow на `now`
 * 3. раскрытие активных policy в логические claim-ы
 * 4. агрегация claim-ов в полный набор желаемых пулов
 * 5. сравнение желаемых пулов с текущими физическими
 * 6. и только теперь — физические переходы
 * 7. фиксация логического снимка claim-ов
 * ```
 *
 * Менять состояние по ходу разбора одного владельца нельзя: это
 * авторитетный переход состояния целиком, а не последовательность
 * независимых команд. Отсюда же и запрет дубликата `ownerKey` в одном
 * входе — два спроса одного владельца не дают ответа, какая из двух
 * policy каноническая.
 *
 * ### Замена поколения: сначала ПОЛНОСТЬЮ закрыть старое
 *
 * ```text
 * spec изменилась
 *   → await old.close()      ← полностью
 *   → factory(new config)
 *   → new.start()
 * ```
 *
 * Обратный порядок («поднять новое, потом закрыть старое») дал бы окно, в
 * котором ОБА поколения публикуют `CEX_ORDERBOOK`/`CEX_TRADE` с
 * одинаковой routing identity. Такие дубли data-plane не отличает от
 * настоящих наблюдений — а вот пропуск он видит и переживает. Поэтому
 * выбран честный контракт:
 *
 * ```text
 * никогда не дублировать · допускается ограниченный разрыв
 *                          при ЯВНОЙ переконфигурации
 * ```
 *
 * Разрыв возникает не каждый тик: при неизменной спецификации источник
 * переиспользуется без единого рестарта (steady state), и только
 * добавление/удаление символа или рост агрегированной глубины приводят к
 * замене поколения. Zero-gap handover (тегирование поколений в
 * сообщениях, дедуп, readiness-протокол, подавление двойной публикации)
 * — отдельная сложная задача; начинать с него значило бы платить
 * сложностью раньше, чем доказана честная семантика.
 *
 * ### desired ≠ satisfied
 *
 * Отказ транспорта НЕ стирает намерение владельца:
 *
 * ```text
 * A хочет BTC → start() бросил
 * → claim A существует, пул желаем, физического пула нет, failure в отчёте
 * → следующий reconcile попробует поднять его снова
 * ```
 *
 * Поэтому логический снимок claim-ов фиксируется всегда, а `stats`
 * различает `desiredPools` и `physicalPools`. Называть claim-ы
 * «активными подписками» было бы прямой ложью: claim — это намерение и
 * владение, физический пул — его материализация.
 *
 * ### Чего здесь нет намеренно
 *
 * Ни `CexMarketUniverse`/`CexDiscovery`/`CexMarket`, ни знания о
 * коллекторе, рекордере и стратегиях, ни `ExternalMessageBus` (его
 * захватывает фабрика), ни control-событий на шине, ни собственного
 * таймера: `reconcile(demands, now)` — полный шаг control-plane CEX, а
 * каденцию задаёт composition root.
 */
import { ValidationError } from '@polymarket/errors';
import { DEFAULT_ORDERBOOK_DEPTH } from '@polymarket/cex-v2';
import type { CexMarketType, CexSourceConfig } from '@polymarket/cex-v2';
import { isCexPolicyMarketType, isPolicyEffectiveAt } from '@polymarket/policy';
import type { CexPolicy } from '@polymarket/policy';
import type { ILogger } from '@polymarket/logger';
import type { Timestamp } from '@polymarket/timestamp';
import type {
  CexPhysicalPoolSpec,
  CexPoolKey,
  CexPoolTransitionFailure,
  CexPoolTransitionStage,
  CexStreamKind,
  CexSubscriptionClaim,
  CexSubscriptionControllerDependencies,
  CexSubscriptionControllerStats,
  CexSubscriptionDemand,
  CexSubscriptionOwnerKey,
  CexSubscriptionPoolSnapshot,
  CexSubscriptionReconcileResult,
  CexSubscriptionSource,
  CexSubscriptionSourceFactory,
} from './CexSubscriptionTypes.js';

/**
 * Состояние одного материализованного пула.
 *
 * @internal
 * @remarks
 * `spec` — снимок ЖЕЛАЕМОГО состояния, по которому источник был создан, а
 * не наблюдение за источником: `CexSource` immutable, поэтому его
 * конфигурация не может разойтись с этим снимком иначе как через новое
 * поколение.
 */
interface CexPoolState {
  /** Детерминированный ключ пула. */
  readonly key: CexPoolKey;
  /** Спецификация, по которой создан источник. */
  readonly spec: CexPhysicalPoolSpec;
  /** Физический источник этого поколения. */
  readonly source: CexSubscriptionSource;
  /** Номер поколения (см. `_generations`). */
  readonly generation: number;
}

/**
 * Желаемый пул: спецификация + владельцы.
 *
 * @internal
 * @remarks
 * Владельцы лежат РЯДОМ со спецификацией, а не внутри неё: сравнение
 * желаемого пула с текущим физическим обязано игнорировать владельцев,
 * иначе появление второго владельца того же ресурса вызывало бы
 * бессмысленную замену поколения.
 */
interface DesiredPool {
  /** Детерминированный ключ пула. */
  readonly key: CexPoolKey;
  /** Желаемая спецификация. */
  readonly spec: CexPhysicalPoolSpec;
  /** Владельцы хотя бы одного claim-а пула, ASC. */
  readonly ownerKeys: readonly CexSubscriptionOwnerKey[];
}

/**
 * Промежуточный аккумулятор пула на этапе агрегации.
 *
 * @internal
 */
interface PoolAccumulator {
  readonly exchangeId: string;
  readonly marketType: CexMarketType;
  readonly stream: CexStreamKind;
  readonly symbols: Set<string>;
  readonly owners: Set<CexSubscriptionOwnerKey>;
  /** Максимум желаемых глубин; `undefined` у потока сделок. */
  maxDepth: number | undefined;
}

/**
 * Накопители отчёта одного прохода.
 *
 * @internal
 * @remarks
 * Мутабельные массивы, которые проход заполняет по мере переходов и
 * замораживает при сборке отчёта. Четыре списка переходов взаимно
 * исключающи: пул попадает ровно в один из них либо только в `failures`.
 */
interface TransitionReport {
  readonly unchangedPools: CexPoolKey[];
  readonly openedPools: CexPoolKey[];
  readonly replacedPools: CexPoolKey[];
  readonly closedPools: CexPoolKey[];
  readonly failures: CexPoolTransitionFailure[];
}

/**
 * Исход материализации одного поколения источника.
 *
 * @internal
 * @remarks
 * Union, а не `state | null`: причина отказа обязана дойти до отчёта, а
 * `null` заставил бы хранить её отдельным полем контроллера — то есть
 * завести состояние там, где его быть не должно.
 */
type MaterializeOutcome =
  | { readonly ok: true; readonly state: CexPoolState }
  | { readonly ok: false; readonly failure: CexPoolTransitionFailure };

/**
 * Собирает замороженный отказ перехода.
 *
 * @param poolKey - Ключ пула
 * @param stage - Этап отказа
 * @param reason - Сообщение исходной ошибки транспорта
 * @returns Отказ для отчёта
 *
 * @internal
 */
function transitionFailure(
  poolKey: CexPoolKey,
  stage: CexPoolTransitionStage,
  reason: string,
): CexPoolTransitionFailure {
  return Object.freeze({ poolKey, stage, reason });
}

/**
 * Сравнивает строки по кодовым единицам.
 *
 * @param left - Первая строка
 * @param right - Вторая строка
 * @returns Отрицательное/ноль/положительное — как требует `Array.sort`
 *
 * @internal
 * @remarks
 * НЕ `localeCompare`: локаль процесса не должна влиять ни на порядок
 * символов в спецификации пула, ни на порядок владельцев в отчёте.
 * Спецификация — значение, по которому принимается решение «менять
 * поколение или нет», и зависимость этого решения от переменных
 * окружения была бы дефектом, воспроизводимым только на чужой машине.
 */
function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * Строит детерминированный ключ пула.
 *
 * @param exchangeId - Биржа в нотации ccxt
 * @param marketType - Тип рынка
 * @param stream - Вид потока
 * @returns Ключ вида `binance|swap|ORDERBOOK`
 *
 * @internal
 * @remarks
 * Символы и владельцы в ключ НЕ входят: пул агрегирует символы, а
 * существует ради ресурса, а не ради того, кто его захотел.
 *
 * @example
 * ```typescript
 * poolKeyOf('binance', 'swap', 'TRADES'); // → 'binance|swap|TRADES'
 * ```
 */
function poolKeyOf(
  exchangeId: string,
  marketType: CexMarketType,
  stream: CexStreamKind,
): CexPoolKey {
  return `${exchangeId}|${marketType}|${stream}`;
}

/**
 * Строит однозначный ключ логического claim-а.
 *
 * @param ownerKey - Владелец
 * @param exchangeId - Биржа
 * @param marketType - Тип рынка
 * @param stream - Вид потока
 * @param symbol - Unified-символ
 * @returns Ключ дедупликации claim-ов прохода
 *
 * @internal
 * @remarks
 * JSON-кортеж, а не склейка через разделитель: `ownerKey` и `symbol`
 * непрозрачны, и разделитель, встретившийся ВНУТРИ них, сделал бы два
 * РАЗНЫХ claim-а неотличимыми — то есть молча потерял бы один из них.
 * Наружу этот ключ не выходит, поэтому читаемость ему не нужна; читаемый
 * ключ — у пула ({@link poolKeyOf}), и там все части словарные.
 */
function claimKey(
  ownerKey: CexSubscriptionOwnerKey,
  exchangeId: string,
  marketType: CexMarketType,
  stream: CexStreamKind,
  symbol: string,
): string {
  return JSON.stringify([ownerKey, exchangeId, marketType, stream, symbol]);
}

/**
 * Проверяет ключ владельца.
 *
 * @param ownerKey - Ключ из спроса
 * @throws {ValidationError} Если ключ не строка либо пуст/состоит из пробелов
 *
 * @internal
 * @remarks
 * Fail-fast, а не исход-значение: пустой ключ — дефект ВЫЗЫВАЮЩЕГО.
 * Молча принятый, он собрал бы claim-ы разных владельцев под одной пустой
 * identity, и исчезновение одного из них сняло бы чужие claim-ы.
 *
 * Ключ при этом НЕ нормализуется: обрезка склеила бы `'a'` и `'a '`.
 */
function assertOwnerKey(ownerKey: CexSubscriptionOwnerKey): void {
  if (typeof ownerKey !== 'string' || ownerKey.trim() === '') {
    throw new ValidationError('CEX subscription owner key must be a non-blank string', {
      context: { ownerKey: String(ownerKey) },
    });
  }
}

/**
 * Проверяет непустой список непустых строк.
 *
 * @param ownerKey - Ключ владельца (для контекста ошибки)
 * @param field - Имя поля policy (для контекста ошибки)
 * @param values - Значения поля
 * @throws {ValidationError} Если поле не массив либо содержит пустой элемент
 *
 * @internal
 * @remarks
 * ПУСТОЙ список ошибкой не считается: policy без символов — законное
 * «этот владелец сейчас ничего с этой биржи не хочет», и она просто не
 * даёт claim-ов. А вот пустая строка ВНУТРИ списка — дефект: она стала бы
 * частью ключа пула (`|swap|TRADES`) и попала бы в конфигурацию
 * источника, где её отверг бы уже транспорт — то есть после побочных
 * эффектов.
 */
function assertStringList(
  ownerKey: CexSubscriptionOwnerKey,
  field: string,
  values: readonly string[],
): void {
  if (!Array.isArray(values)) {
    throw new ValidationError(`CEX policy ${field} must be an array of strings`, {
      context: { ownerKey, field },
    });
  }
  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ValidationError(`CEX policy ${field} must not contain blank entries`, {
        context: { ownerKey, field, value: String(value) },
      });
    }
  }
}

/**
 * Проверяет policy одного владельца.
 *
 * @param ownerKey - Ключ владельца (для контекста ошибки)
 * @param policy - Policy из спроса
 * @throws {ValidationError} Если policy не CEX-вида, содержит пустые
 *   идентификаторы, неизвестный тип рынка либо недопустимую глубину
 *
 * @internal
 * @remarks
 * Проверяется ровно то, из чего строится identity ресурса и конфигурация
 * источника. Отсутствие потоков (`orderbook: false, trades: false`)
 * ошибкой НЕ является: такая policy просто не даёт claim-ов, как и policy
 * с пустым списком символов.
 */
function assertPolicy(ownerKey: CexSubscriptionOwnerKey, policy: CexPolicy): void {
  if (policy === null || typeof policy !== 'object' || policy.kind !== 'CEX') {
    throw new ValidationError('CEX subscription demand requires a CEX policy', {
      context: { ownerKey, kind: String((policy as { kind?: unknown } | null)?.kind) },
    });
  }
  assertStringList(ownerKey, 'exchangeIds', policy.exchangeIds);
  assertStringList(ownerKey, 'symbols', policy.symbols);
  if (!Array.isArray(policy.marketTypes)) {
    throw new ValidationError('CEX policy marketTypes must be an array', { context: { ownerKey } });
  }
  for (const marketType of policy.marketTypes) {
    if (!isCexPolicyMarketType(marketType)) {
      throw new ValidationError('CEX policy marketTypes contains an unknown market type', {
        context: { ownerKey, marketType: String(marketType) },
      });
    }
  }
  if (policy.orderbookDepth !== undefined) {
    if (!Number.isInteger(policy.orderbookDepth) || policy.orderbookDepth <= 0) {
      throw new ValidationError('CEX policy orderbookDepth must be a positive integer', {
        context: { ownerKey, orderbookDepth: policy.orderbookDepth },
      });
    }
  }
}

/**
 * Проверяет весь вход прохода и возвращает его в детерминированном порядке.
 *
 * @param demands - Спрос владельцев как его подал вызывающий
 * @returns НОВЫЙ массив тех же объектов, отсортированный по `ownerKey` ASC
 * @throws {ValidationError} Пустой ключ владельца, дубликат владельца либо
 *   дефект policy
 *
 * @internal
 * @remarks
 * Вся валидация выполняется ДО любого побочного эффекта — до первого
 * `close()` и до первого `start()`. Иначе «реконсиляция упала» означало
 * бы «часть переходов всё-таки выполнилась», и вызывающему пришлось бы
 * выяснять, какая именно.
 *
 * Дубликат владельца — именно ошибка, а не «побеждает первый»: два спроса
 * одного владельца в одном проходе не отвечают, какая policy
 * каноническая, а молчаливый выбор одного из них сделал бы результат
 * зависящим от порядка массива. Смена policy владельцем выражается ДВУМЯ
 * проходами, а не двумя элементами одного входа.
 *
 * Входной массив НЕ мутируется: сортируется его копия.
 */
function validateDemands(
  demands: readonly CexSubscriptionDemand[],
): readonly CexSubscriptionDemand[] {
  const seen = new Set<CexSubscriptionOwnerKey>();
  for (const demand of demands) {
    assertOwnerKey(demand.ownerKey);
    if (seen.has(demand.ownerKey)) {
      throw new ValidationError('CEX demands must not contain a duplicate owner key', {
        context: { ownerKey: demand.ownerKey },
      });
    }
    seen.add(demand.ownerKey);
    assertPolicy(demand.ownerKey, demand.policy);
  }
  return [...demands].sort((left, right) => compareStrings(left.ownerKey, right.ownerKey));
}

/**
 * Превращает спецификацию пула в конфигурацию `CexSource`.
 *
 * @param spec - Желаемая спецификация пула
 * @returns Конфигурация источника РОВНО с одним включённым потоком
 *
 * @internal
 * @remarks
 * Ровно один поток на источник — прямое следствие гранулярности пула:
 * так сохраняется «один CCXT-инстанс на поток» для агрегированного набора
 * символов, и отказ/переконфигурация стакана не трогает сделки.
 *
 * Тайминги транспорта (рестарты, stale-таймауты, backoff, способ
 * получения стакана) здесь НЕ задаются: это свойства транспорта, у них
 * свои дефолты в `CexSource`, и владельцы подписок про них ничего не
 * знают. Глубина передаётся как ЗАПРОШЕННАЯ — нормализацию под
 * возможности биржи делает `CexSource`, повторять его whitelist здесь
 * означало бы завести второй, отстающий.
 */
function toSourceConfig(spec: CexPhysicalPoolSpec): CexSourceConfig {
  return spec.stream === 'ORDERBOOK'
    ? {
        exchangeId: spec.exchangeId,
        marketType: spec.marketType,
        symbols: spec.symbols,
        watchOrderbook: true,
        watchTrades: false,
        orderbookDepth: spec.orderbookDepth,
      }
    : {
        exchangeId: spec.exchangeId,
        marketType: spec.marketType,
        symbols: spec.symbols,
        watchOrderbook: false,
        watchTrades: true,
      };
}

/**
 * Полностью ли совпадают две спецификации пула.
 *
 * @param left - Текущая спецификация
 * @param right - Желаемая спецификация
 * @returns `true`, если совпадают биржа, тип рынка, поток, набор символов
 *   и глубина
 *
 * @internal
 * @remarks
 * Символы сравниваются ПОЗИЦИОННО, и это корректно только потому, что оба
 * массива уже отсортированы ASC: сортировка — часть построения
 * спецификации, а не деталь сравнения. Иначе `[B, A]` и `[A, B]`
 * считались бы разными, и порядок элементов в спросе вызывал бы замену
 * поколения на ровном месте.
 *
 * @example
 * ```typescript
 * specEquals(current.spec, desired.spec); // → true ⇒ источник переиспользуется
 * ```
 */
function specEquals(left: CexPhysicalPoolSpec, right: CexPhysicalPoolSpec): boolean {
  if (
    left.exchangeId !== right.exchangeId ||
    left.marketType !== right.marketType ||
    left.stream !== right.stream ||
    left.orderbookDepth !== right.orderbookDepth ||
    left.symbols.length !== right.symbols.length
  ) {
    return false;
  }
  return left.symbols.every((symbol, index) => symbol === right.symbols[index]);
}

/**
 * Читаемое сообщение произвольной ошибки транспорта.
 *
 * @param error - Значение, брошенное фабрикой либо источником
 * @returns Сообщение для отчёта и логов
 *
 * @internal
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Контроллер общих CEX-подписок.
 *
 * @example
 * ```typescript
 * const controller = new CexSubscriptionController({
 *   sourceFactory: (config) => new CexSource({ config, bus, metadataGenerator, logger }),
 *   logger,
 * });
 *
 * await controller.reconcile(
 *   [
 *     { ownerKey: 'collector:raw', policy: binanceSpotBtc },
 *     { ownerKey: 'strategy:btc-5m', policy: binanceSpotBtc },
 *   ],
 *   Timestamp.now(clock),
 * );
 *
 * controller.listPools();   // один пул стакана и один пул сделок
 * await controller.close(); // закрывает ВСЕ созданные источники
 * ```
 */
export class CexSubscriptionController {
  private readonly _sourceFactory: CexSubscriptionSourceFactory;
  private readonly _logger: ILogger;

  /** Материализованные пулы по {@link CexPoolKey}. */
  private readonly _pools = new Map<CexPoolKey, CexPoolState>();
  /**
   * Зафиксированный логический снимок желаемых пулов.
   *
   * @remarks
   * Это НАМЕРЕНИЕ владельцев, а не наблюдение за транспортом: желаемый
   * пул остаётся здесь и тогда, когда его источник поднять не удалось.
   */
  private _desired = new Map<CexPoolKey, DesiredPool>();
  /** Зафиксированный логический снимок claim-ов (детерминированный порядок). */
  private _claims: readonly CexSubscriptionClaim[] = Object.freeze([]);
  /**
   * Счётчик поколений по ключу пула.
   *
   * @remarks
   * Монотонный за всю жизнь контроллера и НЕ сбрасывается при исчезновении
   * пула: номер поколения отвечает на вопрос «сколько физических
   * источников этот ключ пережил», и обнуление скрыло бы ровно тот
   * случай, ради которого номер и нужен, — цикл «отказал → поднят заново».
   */
  private readonly _generations = new Map<CexPoolKey, number>();

  /**
   * Хвост очереди реконсиляций (single-flight).
   *
   * @remarks
   * Никогда не отклоняется: отказ одного прохода не должен ронять
   * следующий.
   */
  private _reconcileTail: Promise<void> = Promise.resolve();

  private _closed = false;
  private _closePromise: Promise<void> | null = null;

  /**
   * Создаёт контроллер.
   *
   * @param dependencies - Фабрика источников и логгер
   *
   * @example
   * ```typescript
   * const controller = new CexSubscriptionController({ sourceFactory, logger });
   * ```
   */
  public constructor(dependencies: CexSubscriptionControllerDependencies) {
    this._sourceFactory = dependencies.sourceFactory;
    this._logger = dependencies.logger;
  }

  /**
   * Остановлен ли контроллер.
   *
   * @returns `true` после {@link CexSubscriptionController.close}
   */
  public get isClosed(): boolean {
    return this._closed;
  }

  /**
   * Приводит физическое состояние к спросу владельцев на момент `now`.
   *
   * @param demands - ПОЛНЫЙ desired state: владельцы и их CEX-policy
   * @param now - Момент оценки окон policy (приходит от вызывающего)
   * @returns Отчёт прохода: переходы пулов, отказы транспорта и снимок состояния
   * @throws {ValidationError} Контроллер закрыт; пустой ключ владельца;
   *   дубликат владельца; дефект policy
   *
   * @remarks
   * Вход АВТОРИТЕТЕН: владелец, которого в нём нет, теряет свои claim-ы, а
   * ресурс, которого больше никто не хочет, закрывается. Это сознательное
   * отличие от Polymarket-контроллера (см. TSDoc класса).
   *
   * Проходы сериализованы: два одновременных вызова не перестраивают
   * пулы вперемешку — второй начинается после полного commit первого, и
   * итоговое состояние соответствует ПОСЛЕДНЕМУ по порядку вызова.
   * Отклонять второй вызов при этом незачем: он не конфликтует, он просто
   * следующий.
   *
   * Отказы транспорта — значения в `failures`, а не исключения: отказ
   * одной биржи не должен мешать другой. Исключения оставлены для
   * дефектов вызывающего, и все они проверяются ДО побочных эффектов —
   * синхронно, в момент вызова, ещё до постановки прохода в очередь.
   * Метод при этом `async`: дефект входа обязан приходить ОТКЛОНЁННЫМ
   * промисом, а не синхронным throw, иначе вызывающий с `.catch()`
   * получил бы необработанное исключение из метода, чья сигнатура обещает
   * промис.
   *
   * @example
   * ```typescript
   * const result = await controller.reconcile(
   *   [{ ownerKey: 'strategy:A', policy: btcSwapPolicy }],
   *   now,
   * );
   * result.openedPools;   // ['binance|swap|TRADES']
   * result.failures;      // [] — транспорт поднялся
   * ```
   */
  public async reconcile(
    demands: readonly CexSubscriptionDemand[],
    now: Timestamp,
  ): Promise<CexSubscriptionReconcileResult> {
    this._assertOpen();
    // Валидация — синхронно, в момент ВЫЗОВА: она не должна ждать своей
    // очереди в single-flight, иначе дефект входа обнаружился бы уже после
    // побочных эффектов чужого прохода.
    const validated = validateDemands(demands);

    const run = this._reconcileTail.then(() => this._runReconcile(validated, now));
    this._reconcileTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Возвращает снимок состояния контроллера.
   *
   * @returns Счётчики логического и физического уровней
   *
   * @example
   * ```typescript
   * const stats = controller.getStats();
   * stats.desiredPools;  // сколько пулов хотят владельцы
   * stats.physicalPools; // сколько из них материализовано
   * ```
   */
  public getStats(): CexSubscriptionControllerStats {
    const owners = new Set<CexSubscriptionOwnerKey>();
    for (const claim of this._claims) owners.add(claim.ownerKey);

    let orderbookPools = 0;
    let tradePools = 0;
    let runningPools = 0;
    let failedPools = 0;
    for (const pool of this._pools.values()) {
      if (pool.spec.stream === 'ORDERBOOK') orderbookPools += 1;
      else tradePools += 1;
      if (pool.source.isRunning) runningPools += 1;
      if (pool.source.hasFailed) failedPools += 1;
    }

    return Object.freeze({
      owners: owners.size,
      logicalClaims: this._claims.length,
      desiredPools: this._desired.size,
      physicalPools: this._pools.size,
      orderbookPools,
      tradePools,
      runningPools,
      failedPools,
      closed: this._closed,
    });
  }

  /**
   * Возвращает снимки желаемых пулов вместе с их физическим состоянием.
   *
   * @returns Замороженные снимки, отсортированные по ключу пула
   *
   * @remarks
   * Перечисляются ЖЕЛАЕМЫЕ пулы: source of truth физического состояния —
   * карта пулов, но пул, который никто не хочет, в желаемом снимке и не
   * появляется, а желаемый, но не поднявшийся, обязан быть виден
   * (`satisfied: false`). Vendor-объекты наружу не выходят.
   *
   * @example
   * ```typescript
   * for (const pool of controller.listPools()) {
   *   logger.info(pool.poolKey, { symbols: pool.symbols, owners: pool.ownerKeys });
   * }
   * ```
   */
  public listPools(): readonly CexSubscriptionPoolSnapshot[] {
    const snapshots: CexSubscriptionPoolSnapshot[] = [];
    for (const key of [...this._desired.keys()].sort(compareStrings)) {
      const desired = this._desired.get(key);
      if (desired === undefined) continue;
      const pool = this._pools.get(key);
      snapshots.push(
        Object.freeze({
          poolKey: key,
          exchangeId: desired.spec.exchangeId,
          marketType: desired.spec.marketType,
          stream: desired.spec.stream,
          symbols: desired.spec.symbols,
          orderbookDepth: desired.spec.orderbookDepth,
          generation: pool?.generation ?? 0,
          ownerKeys: desired.ownerKeys,
          satisfied: pool !== undefined,
          running: pool?.source.isRunning ?? false,
          failed: pool?.source.hasFailed ?? false,
        }),
      );
    }
    return Object.freeze(snapshots);
  }

  /**
   * Возвращает зафиксированный снимок логических claim-ов.
   *
   * @returns Замороженный список claim-ов в детерминированном порядке
   *
   * @remarks
   * Claim — НАМЕРЕНИЕ и владение, а не «активная подписка»: он существует
   * и тогда, когда физический пул поднять не удалось. Порядок — владелец,
   * биржа, тип рынка, поток, символ (все ASC).
   *
   * @example
   * ```typescript
   * controller.listClaims().filter((claim) => claim.ownerKey === 'strategy:A');
   * ```
   */
  public listClaims(): readonly CexSubscriptionClaim[] {
    return this._claims;
  }

  /**
   * Останавливает контроллер и закрывает ВСЕ созданные им источники.
   *
   * @returns Promise, разрешающийся после закрытия последнего источника
   *
   * @remarks
   * Порядок: запретить новые проходы → дождаться идущего (включая
   * источники, которые он успел поднять) → закрыть все пулы → очистить
   * логическое состояние. Идемпотентен: повторные вызовы ждут первый.
   *
   * Общая шина и генератор metadata НЕ закрываются — ими владеет
   * composition root, а фабрика лишь захватила их.
   *
   * @example
   * ```typescript
   * await controller.close();
   * controller.getStats().physicalPools; // → 0
   * ```
   */
  public async close(): Promise<void> {
    if (this._closePromise !== null) {
      return this._closePromise;
    }
    this._closed = true; // новые проходы запрещены с этого тика
    this._closePromise = (async () => {
      // Идущий проход прервать нельзя: он мог уже закрыть старое поколение
      // и вот-вот поднимет новое. Дожидаемся его целиком — иначе close()
      // завершился бы, оставив живой источник.
      await this._reconcileTail;

      for (const key of [...this._pools.keys()].sort(compareStrings)) {
        const pool = this._pools.get(key);
        if (pool === undefined) continue;
        this._pools.delete(key);
        await this._closeSource(pool, 'controller shutdown');
      }
      this._desired = new Map();
      this._claims = Object.freeze([]);
      this._logger.info('CexSubscriptionController closed');
    })();
    return this._closePromise;
  }

  // ───────────────────────── Проход реконсиляции ─────────────────────────

  /**
   * Выполняет один проход: желаемое состояние → физические переходы → commit.
   *
   * @param demands - Уже проверенный и отсортированный спрос
   * @param now - Момент оценки окон policy
   * @returns Отчёт прохода
   * @throws {ValidationError} Если контроллер закрыли, пока проход стоял в очереди
   *
   * @internal
   */
  private async _runReconcile(
    demands: readonly CexSubscriptionDemand[],
    now: Timestamp,
  ): Promise<CexSubscriptionReconcileResult> {
    // Проход мог простоять в очереди, пока контроллер закрывали: поднимать
    // источники, которые тут же будут закрыты, бессмысленно.
    this._assertOpen();

    let activeDemands = 0;
    const claims = new Map<string, CexSubscriptionClaim>();
    for (const demand of demands) {
      if (!isPolicyEffectiveAt(demand.policy, now)) continue;
      activeDemands += 1;
      this._expandPolicy(demand.ownerKey, demand.policy, claims);
    }

    const desired = this._aggregate(claims);
    const keys = [...new Set([...desired.keys(), ...this._pools.keys()])].sort(compareStrings);

    const unchangedPools: CexPoolKey[] = [];
    const openedPools: CexPoolKey[] = [];
    const replacedPools: CexPoolKey[] = [];
    const closedPools: CexPoolKey[] = [];
    const failures: CexPoolTransitionFailure[] = [];

    // Последовательно, а не Promise.all: детерминированные логи, порядок
    // отчёта и простая изоляция отказов стоят дороже параллелизма
    // нескольких переходов, которые случаются далеко не каждый тик.
    for (const key of keys) {
      await this._transition(key, desired.get(key), {
        unchangedPools,
        openedPools,
        replacedPools,
        closedPools,
        failures,
      });
    }

    // Commit логического снимка: он отражает ПОСЛЕДНИЙ спрос независимо от
    // того, весь ли транспорт поднялся (см. TSDoc класса, desired ≠ satisfied).
    this._desired = desired;
    this._claims = Object.freeze(
      [...claims.values()].sort(
        (left, right) =>
          compareStrings(left.ownerKey, right.ownerKey) ||
          compareStrings(left.exchangeId, right.exchangeId) ||
          compareStrings(left.marketType, right.marketType) ||
          compareStrings(left.stream, right.stream) ||
          compareStrings(left.symbol, right.symbol),
      ),
    );

    const stats = this.getStats();
    this._logger.info('CEX subscriptions reconciled', {
      activeDemands,
      inactiveDemands: demands.length - activeDemands,
      desiredPools: desired.size,
      unchanged: unchangedPools.length,
      opened: openedPools.length,
      replaced: replacedPools.length,
      closed: closedPools.length,
      failures: failures.length,
    });

    return Object.freeze({
      reconciledAt: now,
      activeDemands,
      inactiveDemands: demands.length - activeDemands,
      desiredPools: desired.size,
      unchangedPools: Object.freeze(unchangedPools),
      openedPools: Object.freeze(openedPools),
      replacedPools: Object.freeze(replacedPools),
      closedPools: Object.freeze(closedPools),
      failures: Object.freeze(failures),
      stats,
    });
  }

  /**
   * Раскрывает активную policy в логические claim-ы владельца.
   *
   * @param ownerKey - Владелец claim-ов
   * @param policy - Действующая на момент прохода policy
   * @param claims - Накопитель claim-ов прохода (ключ — identity claim-а)
   *
   * @internal
   * @remarks
   * Декартово произведение `exchangeIds × marketTypes × symbols`, и на
   * каждую комбинацию — по одному claim-у на каждый ЗАПРОШЕННЫЙ поток.
   * Никаких выдуманных инструментов и рынков: identity ресурса CEX — это
   * ровно `exchangeId + marketType + symbol + stream`.
   *
   * Повторы внутри одной policy (`symbols: ['BTC', 'BTC']`) схлопываются:
   * ключ накопителя — identity claim-а, а не позиция в списке.
   */
  private _expandPolicy(
    ownerKey: CexSubscriptionOwnerKey,
    policy: CexPolicy,
    claims: Map<string, CexSubscriptionClaim>,
  ): void {
    if (!policy.orderbook && !policy.trades) return;
    const desiredDepth = policy.orderbookDepth ?? DEFAULT_ORDERBOOK_DEPTH;

    for (const exchangeId of policy.exchangeIds) {
      for (const policyMarketType of policy.marketTypes) {
        // Словарь Application и словарь транспорта — один и тот же набор
        // значений; расхождение станет ошибкой компиляции ЗДЕСЬ, а не
        // молчаливым несовпадением в конфигурации источника.
        const marketType: CexMarketType = policyMarketType;
        for (const symbol of policy.symbols) {
          if (policy.orderbook) {
            claims.set(claimKey(ownerKey, exchangeId, marketType, 'ORDERBOOK', symbol), {
              ownerKey,
              exchangeId,
              marketType,
              symbol,
              stream: 'ORDERBOOK',
              desiredDepth,
            });
          }
          if (policy.trades) {
            claims.set(claimKey(ownerKey, exchangeId, marketType, 'TRADES', symbol), {
              ownerKey,
              exchangeId,
              marketType,
              symbol,
              stream: 'TRADES',
            });
          }
        }
      }
    }
  }

  /**
   * Агрегирует логические claim-ы в полный набор желаемых пулов.
   *
   * @param claims - Все claim-ы прохода
   * @returns Желаемые пулы по ключу
   *
   * @internal
   * @remarks
   * Символы объединяются без дублей и сортируются ASC, владельцы — тоже:
   * спецификация обязана быть функцией МНОЖЕСТВА claim-ов, иначе `[B, A]`
   * и `[A, B]` дали бы разные спецификации и лишнюю замену поколения.
   *
   * Глубина стакана берётся МАКСИМУМОМ по пулу: более глубокий поток
   * удовлетворяет и тех, кому хватает меньшей глубины, а два источника на
   * один символ с разной глубиной дали бы шине дубли одной routing
   * identity.
   */
  private _aggregate(claims: Map<string, CexSubscriptionClaim>): Map<CexPoolKey, DesiredPool> {
    const accumulators = new Map<CexPoolKey, PoolAccumulator>();

    for (const claim of claims.values()) {
      const key = poolKeyOf(claim.exchangeId, claim.marketType, claim.stream);
      let accumulator = accumulators.get(key);
      if (accumulator === undefined) {
        accumulator = {
          exchangeId: claim.exchangeId,
          marketType: claim.marketType,
          stream: claim.stream,
          symbols: new Set<string>(),
          owners: new Set<CexSubscriptionOwnerKey>(),
          maxDepth: undefined,
        };
        accumulators.set(key, accumulator);
      }
      accumulator.symbols.add(claim.symbol);
      accumulator.owners.add(claim.ownerKey);
      if (claim.desiredDepth !== undefined) {
        accumulator.maxDepth =
          accumulator.maxDepth === undefined
            ? claim.desiredDepth
            : Math.max(accumulator.maxDepth, claim.desiredDepth);
      }
    }

    const desired = new Map<CexPoolKey, DesiredPool>();
    for (const [key, accumulator] of accumulators) {
      const spec: CexPhysicalPoolSpec = Object.freeze({
        exchangeId: accumulator.exchangeId,
        marketType: accumulator.marketType,
        stream: accumulator.stream,
        symbols: Object.freeze([...accumulator.symbols].sort(compareStrings)),
        orderbookDepth: accumulator.maxDepth,
      });
      desired.set(
        key,
        Object.freeze({
          key,
          spec,
          ownerKeys: Object.freeze([...accumulator.owners].sort(compareStrings)),
        }),
      );
    }
    return desired;
  }

  /**
   * Выполняет физический переход одного пула.
   *
   * @param key - Ключ пула
   * @param desired - Желаемый пул либо `undefined`, если его больше не хотят
   * @param report - Накопители отчёта прохода
   *
   * @internal
   * @remarks
   * Четыре случая:
   *
   * ```text
   * желаем + текущий совпадает и здоров → переиспользовать (steady state)
   * желаем + текущий отличается/мёртв   → заменить поколение
   * желаем + текущего нет               → поднять
   * не желаем + текущий есть            → закрыть
   * ```
   *
   * «Мёртв» — это `hasFailed` либо `isClosed`: такой источник желаемое
   * состояние не удовлетворяет, и притворяться, что пул активен, нельзя.
   * Попытка ровно одна на проход: внутреннего retry-цикла нет, следующий
   * внешний тик попробует снова.
   */
  private async _transition(
    key: CexPoolKey,
    desired: DesiredPool | undefined,
    report: TransitionReport,
  ): Promise<void> {
    const current = this._pools.get(key);

    if (desired === undefined) {
      if (current === undefined) return;
      this._pools.delete(key);
      const failure = await this._closeSource(current, 'pool no longer desired');
      if (failure !== null) report.failures.push(failure);
      report.closedPools.push(key);
      return;
    }

    if (current !== undefined) {
      const healthy = !current.source.hasFailed && !current.source.isClosed;
      if (healthy && specEquals(current.spec, desired.spec)) {
        report.unchangedPools.push(key);
        return;
      }
      // Замена поколения: старое закрывается ПОЛНОСТЬЮ до создания нового.
      // Перекрытие поколений дало бы дубли одной routing identity, которые
      // data-plane не отличит (см. TSDoc класса).
      this._pools.delete(key);
      const closeFailure = await this._closeSource(
        current,
        healthy ? 'pool spec changed' : 'pool source terminal',
      );
      if (closeFailure !== null) report.failures.push(closeFailure);

      const replacement = await this._materialize(key, desired.spec, 'replace');
      if (!replacement.ok) {
        report.failures.push(replacement.failure);
        return;
      }
      report.replacedPools.push(key);
      return;
    }

    const opened = await this._materialize(key, desired.spec, 'open');
    if (!opened.ok) {
      report.failures.push(opened.failure);
      return;
    }
    report.openedPools.push(key);
  }

  /**
   * Создаёт и запускает новое поколение источника.
   *
   * @param key - Ключ пула
   * @param spec - Желаемая спецификация
   * @param stage - Этап перехода (для отчёта и лога)
   * @returns Успех с состоянием пула либо отказ с причиной
   *
   * @internal
   * @remarks
   * Порядок строгий: сначала фабрика, потом `start()`, и только потом
   * коммит в карту пулов. `start()` синхронный, поэтому проверка
   * «источник действительно жив» выполняется сразу после него: источник,
   * родившийся закрытым или отказавшим, желаемое состояние не
   * удовлетворяет, и коммитить его как активный пул нельзя.
   *
   * Ни фабрика, ни `start()` не роняют весь проход — их отказ становится
   * значением в отчёте (см. TSDoc класса). Незакоммиченный источник при
   * этом закрывается: он мог успеть открыть транспорт, и оставить его
   * висеть значило бы утечь websocket-соединением.
   */
  private async _materialize(
    key: CexPoolKey,
    spec: CexPhysicalPoolSpec,
    stage: CexPoolTransitionStage,
  ): Promise<MaterializeOutcome> {
    const generation = (this._generations.get(key) ?? 0) + 1;

    let source: CexSubscriptionSource;
    try {
      source = this._sourceFactory(toSourceConfig(spec));
    } catch (error) {
      this._logger.error('CEX pool source factory failed', {
        poolKey: key,
        stage,
        err: error as Error,
      });
      return { ok: false, failure: transitionFailure(key, stage, describeError(error)) };
    }
    this._generations.set(key, generation);

    try {
      source.start();
    } catch (error) {
      this._logger.error('CEX pool source failed to start', {
        poolKey: key,
        stage,
        generation,
        err: error as Error,
      });
      await this._discardSource(key, source);
      return { ok: false, failure: transitionFailure(key, stage, describeError(error)) };
    }

    if (source.isClosed || source.hasFailed) {
      this._logger.error('CEX pool source is not alive right after start', {
        poolKey: key,
        stage,
        generation,
        closed: source.isClosed,
        failed: source.hasFailed,
      });
      await this._discardSource(key, source);
      return {
        ok: false,
        failure: transitionFailure(key, stage, 'source is not alive right after start'),
      };
    }

    const state: CexPoolState = { key, spec, source, generation };
    this._pools.set(key, state);
    this._logger.info('CEX pool source started', {
      poolKey: key,
      stage,
      generation,
      symbols: spec.symbols.length,
      orderbookDepth: spec.orderbookDepth,
    });
    return { ok: true, state };
  }

  /**
   * Закрывает источник, который так и не стал пулом.
   *
   * @param key - Ключ пула (для лога)
   * @param source - Незакоммиченный источник
   *
   * @internal
   * @remarks
   * Отказ закрытия здесь только логируется: в отчёт уже уезжает причина,
   * по которой источник не поднялся, и второй отказ о том же пуле
   * рассказал бы не больше.
   */
  private async _discardSource(key: CexPoolKey, source: CexSubscriptionSource): Promise<void> {
    try {
      await source.close();
    } catch (error) {
      this._logger.error('CEX pool discarded source failed to close', {
        poolKey: key,
        err: error as Error,
      });
    }
  }

  /**
   * Закрывает поколение источника.
   *
   * @param pool - Состояние пула (уже убранное из карты)
   * @param reason - Причина закрытия (для лога)
   * @returns Отказ закрытия либо `null`
   *
   * @internal
   * @remarks
   * Отказ `close()` не откатывается и пул не восстанавливает: источник, у
   * которого не получилось закрыться, желаемого состояния не
   * удовлетворяет всё равно. Отказ попадает в отчёт, а место в карте
   * остаётся свободным — иначе следующий проход не смог бы поднять
   * замену.
   */
  private async _closeSource(
    pool: CexPoolState,
    reason: string,
  ): Promise<CexPoolTransitionFailure | null> {
    try {
      await pool.source.close();
      this._logger.info('CEX pool source closed', {
        poolKey: pool.key,
        generation: pool.generation,
        reason,
      });
      return null;
    } catch (error) {
      this._logger.error('CEX pool source failed to close', {
        poolKey: pool.key,
        generation: pool.generation,
        reason,
        err: error as Error,
      });
      return Object.freeze({
        poolKey: pool.key,
        stage: 'close' as CexPoolTransitionStage,
        reason: describeError(error),
      });
    }
  }

  /**
   * Проверяет, что контроллер ещё работает.
   *
   * @throws {ValidationError} Если контроллер закрыт
   *
   * @internal
   * @remarks
   * Fail-fast, а не пустой «успешный» отчёт: вызов реконсиляции у
   * остановленного контроллера — дефект вызывающего, и отчёт, из которого
   * следует, что желаемое состояние достигнуто, был бы прямой ложью.
   */
  private _assertOpen(): void {
    if (this._closed) {
      throw new ValidationError('CexSubscriptionController is closed', {
        context: { operation: 'reconcile' },
      });
    }
  }
}
