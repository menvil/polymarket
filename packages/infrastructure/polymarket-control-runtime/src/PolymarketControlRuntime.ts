/**
 * Прямая оркестрация control-plane Polymarket: один детерминированный
 * проход от обхода каталога до физических подписок.
 *
 * @remarks
 * ### Что здесь появляется впервые в контуре
 *
 * ```text
 *                     CONTROL PLANE
 *
 * PolymarketMarketDiscovery
 *         ↓ refresh()
 * MarketUniverse
 *         ↓
 * runtime demands (ownerKey + Policy + acquireLimit)
 *         ↓
 * PolymarketSubscriptionPlanner
 *         ↓ первые N пригодных будущих рынков
 * PolymarketSubscriptionController.acquire()
 *         ↓
 * физические подписки Polymarket
 * ```
 *
 * Все пять компонентов существовали и раньше — не существовало прохода,
 * который соединяет их в одно решение. Этот класс и есть проход, и ничего
 * кроме прохода: ни сбора данных, ни финализации, ни стратегий, ни ордеров,
 * ни CEX, ни семантики.
 *
 * ### `runOnce()` и никакого таймера
 *
 * Внутри нет ни `setInterval`, ни цикла, ни планировщика: каденцию задаёт
 * composition root. Причина не в экономии кода, а в предмете: проход обязан
 * быть ДЕТЕРМИНИРОВАННЫМ шагом, который можно вызвать из теста, из replay и
 * из живого рантайма и получить один и тот же ответ. Собственный таймер
 * превратил бы его в фоновый сервис — то есть в объект, поведение которого
 * зависит от того, когда его наблюдают.
 *
 * ### ACQUISITION ≠ RETENTION (наследуется от контроллера)
 *
 * ```text
 * demands  → что сейчас нужно ПОПРОБОВАТЬ приобрести
 * demands  ≠ полный desired-state уже приобретённых рынков
 * ```
 *
 * Отсюда три правила, которых у рантайма нет ни в одной строке:
 *
 * - владелец пропал из `demands` — claim НЕ снимается;
 * - policy владельца сменилась — прежний рынок НЕ отпускается;
 * - `acquireLimit` уменьшился — «лишние» claim-ы НЕ снимаются.
 *
 * Ни одного вызова `release`/`releaseOwner` в пакете нет, и это проверяется
 * структурным тестом. Явный конец владения — работа composition root: он
 * знает, что экземпляр стратегии действительно остановлен, а рантайм видит
 * только спрос на один тик.
 *
 * ### `acquireLimit` считает КАНДИДАТОВ, а не claim-ы
 *
 * ```text
 * 17:57  план: [X=BTC 18:00, Y=BTC 18:05]  limit 1 → acquire X
 * 17:58  план: [X, Y]                      limit 1 → X already-held
 * 18:00  план: [Y, ...]  (X стартовал)     limit 1 → acquire Y
 *
 * итог: владелец держит X (начавшийся) И Y (предстоящий)
 * ```
 *
 * Считай лимит по claim-ам — и владелец с `limit 1` навсегда остановился бы
 * на первом же купленном рынке: следующий он смог бы взять только после
 * явного release, которого никто не делает. Именно поэтому поле называется
 * `acquireLimit`, а не `maxActiveMarkets`.
 *
 * ### Один `now` на весь проход
 *
 * Часы читаются РОВНО ОДИН раз — после обхода каталога, — и этот момент
 * получают все вызовы планировщика тика. Иначе на стыке 18:00 владелец A
 * увидел бы рынок 18:00 будущим, а владелец B, спланированный на
 * миллисекунду позже, — уже начавшимся: один тик описывал бы два разных
 * мира.
 *
 * Контроллер при этом читает часы САМ на каждом `acquire()` — и это не
 * дублирование, а разные вопросы:
 *
 * ```text
 * время планировщика → единый снимок РЕШЕНИЯ тика
 * время контроллера  → последняя проверка перед ФИЗИЧЕСКИМ действием
 * ```
 *
 * ### Детерминированный порядок владельцев
 *
 * Владельцы обрабатываются по `ownerKey` ASC, последовательно, независимо
 * от порядка во входном массиве. Два владельца могут захотеть один рынок, и
 * при произвольном порядке было бы недетерминировано, кто получит `opened`,
 * а кто `joined`. Физический результат от этого не меняется (подписка всё
 * равно одна), а вот диагностика — меняется, и повторяемость отчёта стоит
 * дороже нескольких миллисекунд параллелизма. `Promise.all` здесь
 * сознательно не используется, хотя контроллер конкурентное приобретение
 * выдерживает.
 *
 * ### Никаких ретраев внутри прохода
 *
 * На каждого отобранного кандидата — РОВНО одна попытка. Отказ контроллера
 * (`rejected`/`failed`) попадает в отчёт и не бросается: рынок мог
 * стартовать между планом и вызовом, vendor-подготовка — смениться,
 * транспорт — отказать. Повтор произойдёт сам собой на следующем внешнем
 * тике, если планировщик всё ещё возвращает этот рынок. Ретрай внутри
 * прохода сделал бы длительность тика непредсказуемой и ничего бы не
 * исправил: за миллисекунды мир не меняется.
 *
 * @example
 * ```typescript
 * const runtime = new PolymarketControlRuntime({
 *   discovery, universe, planner, controller, clock, logger,
 * });
 *
 * // каденцию задаёт composition root
 * const result = await runtime.runOnce([
 *   { ownerKey: 'collector:raw', policy: btc5m, acquireLimit: 2 },
 *   { ownerKey: 'strategy:btc-5m', policy: btc5m, acquireLimit: 1 },
 * ]);
 *
 * result.owners[0].acquisitions[0]?.status; // 'opened' | 'joined' | ...
 * ```
 */
import { ValidationError } from '@polymarket/errors';
import { Timestamp } from '@polymarket/timestamp';
import type { ILogger } from '@polymarket/logger';
import type { MarketId } from '@polymarket/ids';
import type { MarketDiscoveryEntry } from '@polymarket/ports';
import type { IClock } from '@polymarket/time';
import type { MarketUniverse } from '@polymarket/market-discovery';
import type { PolymarketSubscriptionPlanner } from '@polymarket/subscription-planning';
import type {
  PolymarketAcquireResult,
  PolymarketSubscriptionController,
  SubscriptionOwnerKey,
} from '@polymarket/polymarket-subscription-control';
import type {
  ControlRuntimeDiscovery,
  PolymarketControlRuntimeDependencies,
  PolymarketControlRuntimeResult,
  PolymarketOwnerRuntimeResult,
  PolymarketSubscriptionDemand,
} from './PolymarketControlRuntimeTypes.js';

/**
 * Разбор исходов приобретения одного владельца.
 *
 * @internal
 * @remarks
 * Существует только ради лога и решения «тик что-нибудь изменил?». В отчёт
 * не уезжает: там лежат сами исходы, а считать их по массиву потребитель
 * умеет сам — материализованный счётчик пережил бы своё вычисление и стал
 * бы вторым представлением одних и тех же фактов.
 */
interface AcquisitionTally {
  opened: number;
  joined: number;
  alreadyHeld: number;
  rejected: number;
  failed: number;
}

/**
 * Сравнивает ключи владельцев для детерминированного порядка обработки.
 *
 * @param left - Первый ключ
 * @param right - Второй ключ
 * @returns Отрицательное/ноль/положительное — как требует `Array.sort`
 *
 * @internal
 * @remarks
 * Сравнение по кодовым единицам, а НЕ `localeCompare`: локаль процесса не
 * должна влиять на то, кто из двух владельцев одного рынка получит
 * `opened`. Тот же приём, что у `PolymarketSubscriptionController.listSubscriptions`.
 */
function compareOwnerKeys(left: SubscriptionOwnerKey, right: SubscriptionOwnerKey): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * Проверяет ключ владельца.
 *
 * @param ownerKey - Ключ из спроса
 * @throws {ValidationError} Если ключ не строка либо пуст/состоит из пробелов
 *
 * @internal
 * @remarks
 * Правило то же, что у контроллера, и проверка здесь НЕ ради второго
 * контракта, а ради момента: контроллер узнает о пустом ключе только на
 * `acquire()` — то есть ПОСЛЕ обхода каталога и, возможно, после
 * приобретений предыдущих владельцев. Дефект вызывающего не должен
 * оставлять проход наполовину выполненным.
 */
function assertOwnerKey(ownerKey: SubscriptionOwnerKey): void {
  if (typeof ownerKey !== 'string' || ownerKey.trim() === '') {
    throw new ValidationError('Runtime demand owner key must be a non-blank string', {
      context: { ownerKey: String(ownerKey) },
    });
  }
}

/**
 * Проверяет лимит приобретения.
 *
 * @param ownerKey - Ключ владельца (для контекста ошибки)
 * @param acquireLimit - Значение из спроса
 * @throws {ValidationError} Если значение не целое число `>= 1`
 *
 * @internal
 * @remarks
 * Отвергаются `0`, отрицательные, дробные, `NaN` и `Infinity`. Ни одно из
 * них не является запросом: `slice(0, NaN)` молча даёт пустой срез,
 * `slice(0, 0)` — тоже, и владелец, чей спрос никогда не выполняется,
 * выглядел бы как владелец, которому просто не подошёл ни один рынок.
 * `Infinity` формально работает, но означает «приобрести весь план» —
 * решение, которое обязано быть написано числом, а не побочным эффектом
 * опечатки. Ноль как «выключить владельца» тоже не принимается: выключенный
 * владелец не подаёт спрос вовсе.
 */
function assertAcquireLimit(ownerKey: SubscriptionOwnerKey, acquireLimit: number): void {
  if (!Number.isInteger(acquireLimit) || acquireLimit < 1) {
    throw new ValidationError('Runtime demand acquireLimit must be an integer >= 1', {
      context: { ownerKey, acquireLimit },
    });
  }
}

/**
 * Проверяет спрос прохода и возвращает его в порядке обработки.
 *
 * @param demands - Спрос владельцев как его подал вызывающий
 * @returns НОВЫЙ массив тех же объектов, отсортированный по `ownerKey` ASC
 * @throws {ValidationError} Пустой ключ владельца, дубликат владельца либо
 *   недопустимый `acquireLimit`
 *
 * @internal
 * @remarks
 * Вся валидация выполняется ДО любого побочного эффекта прохода — до
 * `discovery.refresh()` и до первого `controller.acquire()`. Невалидный
 * вход не должен ни трогать сеть, ни приобретать ресурсы: иначе «проход
 * упал» означало бы «часть прохода всё-таки выполнилась», и вызывающему
 * пришлось бы выяснять, какая именно.
 *
 * Дубликат владельца — именно ошибка, а не «побеждает первый»: два спроса
 * одного владельца в одном тике не дают ответа на вопросы «какая policy
 * каноническая» и «какой лимит канонический», а молчаливый выбор одного из
 * них сделал бы результат зависящим от порядка массива.
 *
 * Входной массив НЕ мутируется: сортируется его копия. Сами объекты спроса
 * и их policy не копируются и не трогаются — они принадлежат вызывающему.
 */
function validateDemands(
  demands: readonly PolymarketSubscriptionDemand[],
): readonly PolymarketSubscriptionDemand[] {
  const seen = new Set<SubscriptionOwnerKey>();
  for (const demand of demands) {
    assertOwnerKey(demand.ownerKey);
    if (seen.has(demand.ownerKey)) {
      throw new ValidationError('Runtime demands must not contain a duplicate owner key', {
        context: { ownerKey: demand.ownerKey },
      });
    }
    seen.add(demand.ownerKey);
    assertAcquireLimit(demand.ownerKey, demand.acquireLimit);
  }
  return [...demands].sort((left, right) => compareOwnerKeys(left.ownerKey, right.ownerKey));
}

/**
 * Считает исходы приобретения по категориям.
 *
 * @param acquisitions - Исходы одного владельца
 * @returns Разбор по статусам
 *
 * @internal
 */
function tally(acquisitions: readonly PolymarketAcquireResult[]): AcquisitionTally {
  const counts: AcquisitionTally = { opened: 0, joined: 0, alreadyHeld: 0, rejected: 0, failed: 0 };
  for (const acquisition of acquisitions) {
    switch (acquisition.status) {
      case 'opened':
        counts.opened += 1;
        break;
      case 'joined':
        counts.joined += 1;
        break;
      case 'already-held':
        counts.alreadyHeld += 1;
        break;
      case 'rejected':
        counts.rejected += 1;
        break;
      case 'failed':
        counts.failed += 1;
        break;
    }
  }
  return counts;
}

/**
 * Прямой оркестратор control-plane Polymarket.
 *
 * @remarks
 * Не хранит НИЧЕГО между проходами: ни владельцев, ни их policy, ни
 * приобретённых рынков, ни прошлого плана. Source of truth владения —
 * контроллер (`getStats()`/`listSubscriptions()`), source of truth
 * universe — `MarketUniverse`, source of truth спроса — composition root.
 * Второй реестр claim-ов внутри рантайма означал бы два ответа на вопрос
 * «кто чем владеет», и расходиться они начали бы на первом же откате
 * транзакции контроллера.
 *
 * Пакет НАМЕРЕННО не generic: `ControlLoop<T>`/`GenericVenueRuntime` до
 * появления второй площадки был бы предположением о том, что у CEX
 * получится такая же форма прохода. Проверим это после CEX-контроллера.
 */
export class PolymarketControlRuntime {
  private readonly _discovery: ControlRuntimeDiscovery;
  private readonly _universe: MarketUniverse;
  private readonly _planner: PolymarketSubscriptionPlanner;
  private readonly _controller: PolymarketSubscriptionController;
  private readonly _clock: IClock;
  private readonly _logger: ILogger;

  /**
   * Создаёт рантайм поверх готовых компонентов контура.
   *
   * @param dependencies - Обход каталога, universe, планировщик, контроллер, часы, логгер
   *
   * @example
   * ```typescript
   * const runtime = new PolymarketControlRuntime({
   *   discovery, universe, planner, controller, clock, logger,
   * });
   * ```
   */
  public constructor(dependencies: PolymarketControlRuntimeDependencies) {
    this._discovery = dependencies.discovery;
    this._universe = dependencies.universe;
    this._planner = dependencies.planner;
    this._controller = dependencies.controller;
    this._clock = dependencies.clock;
    this._logger = dependencies.logger.child({ component: 'PolymarketControlRuntime' });
  }

  /**
   * Выполняет один проход control-plane.
   *
   * Алгоритм:
   * 1. Проверяем спрос целиком (ключи, дубликаты, лимиты) — ДО побочных
   *    эффектов; копию сортируем по `ownerKey` ASC.
   * 2. Обходим каталог. Успех — заменяем universe свежим снимком; отказ —
   *    оставляем last-good universe нетронутым.
   * 3. Читаем часы РОВНО ОДИН раз и берём один и тот же срез universe.
   * 4. Для каждого владельца по порядку: план → первые `acquireLimit`
   *    кандидатов → `controller.acquire()` по одному, последовательно.
   * 5. Собираем замороженный отчёт: планы, отобранные рынки, исходы,
   *    состояние контроллера.
   *
   * @param demands - Спрос владельцев на ЭТОТ тик (вход не мутируется)
   * @returns Замороженный отчёт прохода (см. {@link PolymarketControlRuntimeResult})
   * @throws {ValidationError} Пустой ключ владельца, дубликат владельца в
   *   одном проходе либо `acquireLimit` не целое `>= 1`. Отказы площадки и
   *   контроллера исключениями НЕ являются — они попадают в отчёт
   *
   * @remarks
   * Проход не бросает из-за недоступного Gamma, отказавшего транспорта или
   * непригодного рынка: всё это нормальный рантайм control-plane, и
   * ответом на него служит следующий тик, а не остановка вызывающего.
   * Исключение — только дефект спроса, потому что чинить его должен
   * вызывающий, а не следующий тик.
   *
   * Пустой `demands` — законный проход: каталог обновится, universe
   * останется актуальным, ни один claim не будет снят (см. TSDoc класса).
   *
   * @example
   * ```typescript
   * const result = await runtime.runOnce([
   *   { ownerKey: 'strategy:A', policy, acquireLimit: 1 },
   * ]);
   *
   * const owner = result.owners[0];
   * owner.plan.diagnostics.alreadyStarted;  // почему кандидатов меньше
   * owner.selectedMarketIds[0];             // что пытались приобрести
   * owner.acquisitions[0];                  // чем это кончилось
   * ```
   */
  public async runOnce(
    demands: readonly PolymarketSubscriptionDemand[],
  ): Promise<PolymarketControlRuntimeResult> {
    const ordered = validateDemands(demands);
    this._logger.debug('Control runtime tick started', { demands: ordered.length });

    const discoveryRefreshed = await this._discovery.refresh();
    if (discoveryRefreshed) {
      this._universe.replace(this._discovery.getSnapshot());
    }

    // Момент решения тика: одно чтение часов на весь проход (см. TSDoc класса).
    const now = Timestamp.now(this._clock);
    // Один и тот же срез universe для всех владельцев — по той же причине,
    // что и один `now`: тик обязан описывать ОДИН мир.
    const entries = this._universe.getAll();

    this._logger.debug(
      discoveryRefreshed
        ? 'Universe replaced from a fresh discovery snapshot'
        : 'Discovery refresh unavailable, planning on the last-good universe',
      { universeEntries: entries.length, ranAt: now.toISO() },
    );

    const owners: PolymarketOwnerRuntimeResult[] = [];
    let changedSomething = false;
    for (const demand of ordered) {
      const owner = await this._runOwner(demand, entries, now);
      owners.push(owner);
      changedSomething ||= owner.acquisitions.some(
        (acquisition) => acquisition.status !== 'already-held',
      );
    }

    const result: PolymarketControlRuntimeResult = Object.freeze({
      ranAt: now,
      discoveryRefreshed,
      universeEntries: entries.length,
      owners: Object.freeze(owners),
      // Снимок контроллера уже заморожен им самим (вместе с массивом фидов
      // и каждым его элементом) — защитная копия добавила бы объект без
      // единого нового факта.
      controller: this._controller.getStats(),
    });

    // Тик, ничего не изменивший, — норма при каденции в секунду, и писать о
    // нём в info значило бы утопить в шуме тики, которые что-то сделали.
    const summary = {
      discoveryRefreshed,
      universeEntries: result.universeEntries,
      owners: owners.length,
      openingMarkets: result.controller.openingMarkets,
      activeMarkets: result.controller.activeMarkets,
      claims: result.controller.claims,
    };
    if (changedSomething) {
      this._logger.info('Control runtime tick completed', summary);
    } else {
      this._logger.debug('Control runtime tick completed', summary);
    }
    return result;
  }

  /**
   * Планирует и приобретает рынки одного владельца.
   *
   * @param demand - Проверенный спрос владельца
   * @param entries - Срез universe этого прохода
   * @param now - Момент решения прохода (один на все владельцев)
   * @returns Замороженный отчёт владельца
   *
   * @internal
   * @remarks
   * Кандидаты берутся из плана КАК ЕСТЬ — планировщик уже упорядочил их
   * (`startsAt` → `expiresAt` → ликвидность → площадка → id). Никакой своей
   * фильтрации по активу, номиналу серии, запасу времени или ликвидности
   * здесь нет и быть не должно: второй отбор поверх Policy означал бы
   * вторые правила отбора, которые расходятся с первыми молча.
   *
   * Приобретения выполняются последовательно и без ретраев (см. TSDoc
   * класса); ни один исход контроллера не считается ошибкой.
   */
  private async _runOwner(
    demand: PolymarketSubscriptionDemand,
    entries: readonly MarketDiscoveryEntry[],
    now: Timestamp,
  ): Promise<PolymarketOwnerRuntimeResult> {
    const plan = this._planner.plan(entries, demand.policy, now);
    const selected = plan.candidates.slice(0, demand.acquireLimit);

    const selectedMarketIds: MarketId[] = [];
    const acquisitions: PolymarketAcquireResult[] = [];
    for (const entry of selected) {
      selectedMarketIds.push(entry.market.id);
      acquisitions.push(await this._controller.acquire(demand.ownerKey, entry));
    }

    const counts = tally(acquisitions);
    this._logger.debug('Owner tick summary', {
      ownerKey: demand.ownerKey,
      acquireLimit: demand.acquireLimit,
      planCandidates: plan.candidates.length,
      selected: selectedMarketIds.length,
      ...counts,
    });

    return Object.freeze({
      ownerKey: demand.ownerKey,
      acquireLimit: demand.acquireLimit,
      // Диагностика заморожена планировщиком — переупаковывать её незачем.
      plan: Object.freeze({
        candidateCount: plan.candidates.length,
        diagnostics: plan.diagnostics,
      }),
      selectedMarketIds: Object.freeze(selectedMarketIds),
      acquisitions: Object.freeze(acquisitions),
    });
  }
}
