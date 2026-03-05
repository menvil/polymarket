/**
 * Market — доменная сущность рынка предсказаний
 *
 * @remarks
 * Представляет бинарный рынок предсказаний в системе Polymarket.
 * Market является неизменяемой (immutable) доменной сущностью.
 *
 * ### Архитектура:
 * - Все свойства readonly — мутации возвращают новый экземпляр
 * - MarketState (discriminated union) вместо разрозненных полей status + resolvedOutcomeIndex
 * - Typed IDs (MarketId, MarketSlug, OutcomeTokenId) вместо bare string
 * - expirationDate хранится как number (ms) для иммутабельности
 * - Lifecycle guards: переходы проверяются через canTransition()
 *
 * ### Жизненный цикл рынка:
 * ```
 * ACTIVE → CLOSED → RESOLVED
 * ```
 *
 * ### Бизнес-правила:
 * 1. Рынок должен иметь непустой id, slug и вопрос
 * 2. Должно быть ровно 2 исхода (YES/NO)
 * 3. close() допустим только из ACTIVE состояния
 * 4. resolve() допустим только из CLOSED состояния
 * 5. Дата истечения хранится как number для иммутабельности
 *
 * @example
 * ```typescript
 * import { Market } from './Market';
 * import { MarketState, asMarketId, parseMarketSlug } from './value-objects';
 * import { OutcomeToken, BinaryOutcome } from '@polymarket/value-objects/outcome-token';
 *
 * const conditionRef = { kind: 'ONCHAIN', protocolId: 'POLYMARKET_CTF', chainId: 137, conditionId: '0x...' };
 * const result = Market.create({
 *   id: asMarketId('market-abc')!,
 *   slug: parseMarketSlug('will-trump-win-2024')!,
 *   question: 'Will Trump win the 2024 election?',
 *   outcomes: [
 *     { token: OutcomeToken.of(conditionRef, BinaryOutcome.UP), index: 0, name: 'Yes' },
 *     { token: OutcomeToken.of(conditionRef, BinaryOutcome.DOWN), index: 1, name: 'No' },
 *   ],
 *   expirationMs: Date.parse('2024-11-05T00:00:00Z'),
 *   state: MarketState.active(),
 * });
 *
 * if (result.ok) {
 *   const market = result.value;
 *   const closed = market.close();
 *   const resolved = closed.resolve(0); // YES победил
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { OutcomeToken } from '@polymarket/value-objects/outcome-token';
import {
  type MarketId,
  type MarketSlug,
  type OutcomeIndex,
  MarketState,
  isActive,
  isClosed,
  isResolved,
} from './value-objects/index.js';
import { MarketValidationError } from '@polymarket/errors/market';
import { type MarketEvent } from './MarketEvents.js';

/**
 * Outcome — value object исхода рынка
 *
 * @remarks
 * Инкапсулирует всю информацию об одном исходе бинарного рынка.
 * Использует `OutcomeToken` из `@polymarket/value-objects` для представления
 * on-chain токена с полной семантикой (conditionRef, outcomeKey, equals).
 *
 * @example
 * ```typescript
 * import { OutcomeToken, BinaryOutcome } from '@polymarket/value-objects/outcome-token';
 *
 * const outcome: Outcome = {
 *   token: OutcomeToken.of(conditionRef, BinaryOutcome.UP),
 *   index: 0,
 *   name: 'Yes',
 * };
 * ```
 */
export interface Outcome {
  /** On-chain токен исхода с conditionRef и outcomeKey */
  readonly token: OutcomeToken;
  /** Позиция в массиве исходов (0 = YES/UP, 1 = NO/DOWN) */
  readonly index: OutcomeIndex;
  /** Человекочитаемое название исхода */
  readonly name: string;
}

/**
 * MarketProps — параметры создания Market
 *
 * @remarks
 * Используется в Market.create() factory method.
 * Все поля immutable (readonly).
 */
export interface MarketProps {
  /** Уникальный идентификатор рынка */
  readonly id: MarketId;
  /** URL-safe слаг для построения ссылок */
  readonly slug: MarketSlug;
  /** Вопрос рынка */
  readonly question: string;
  /** Исходы рынка: пара [YES/UP, NO/DOWN] */
  readonly outcomes: readonly [Outcome, Outcome];
  /** Время истечения рынка в миллисекундах (Unix timestamp) */
  readonly expirationMs: number;
  /** Текущее состояние рынка */
  readonly state: MarketState;
}

/**
 * Market — неизменяемая доменная сущность рынка предсказаний
 *
 * @remarks
 * Все свойства readonly. Методы изменения состояния возвращают новый экземпляр.
 *
 * ### Typed IDs:
 * - **id** — MarketId (branded string, непустая)
 * - **slug** — MarketSlug (branded string, URL-safe: a-z0-9-)
 *
 * ### Иммутабельность:
 * - expirationDate getter возвращает `new Date(expirationMs)` каждый раз (копию)
 * - Внутреннее хранение через `_expirationMs: number`
 *
 * ### Lifecycle:
 * - close() — только из ACTIVE, иначе бросает MarketLifecycleError
 * - resolve() — только из CLOSED, иначе бросает MarketLifecycleError
 *
 * ### Domain Events (Outbox pattern):
 * - close() эмитирует MarketClosedEvent в буфер
 * - resolve() эмитирует MarketResolvedEvent в буфер
 * - pullEvents() возвращает и очищает буфер
 */
export class Market {
  public readonly id: MarketId;
  public readonly slug: MarketSlug;
  public readonly question: string;
  public readonly outcomes: readonly [Outcome, Outcome];
  public readonly state: MarketState;

  /**
   * Время истечения в миллисекундах (внутреннее хранение)
   *
   * @remarks
   * Хранится как number для гарантии иммутабельности.
   * Используйте getter `expirationDate` для получения Date объекта.
   */
  private readonly _expirationMs: number;

  /**
   * Буфер доменных событий (Domain Event Outbox)
   *
   * @remarks
   * Контролируемая мутация: единственная изменяемая часть immutable entity.
   * splice(0) в pullEvents() атомарно возвращает и очищает буфер.
   */
  private readonly _pendingEvents: MarketEvent[];

  /**
   * Приватный конструктор — используйте Market.create()
   */
  private constructor(props: MarketProps, pendingEvents: MarketEvent[] = []) {
    this.id = props.id;
    this.slug = props.slug;
    this.question = props.question;
    this._expirationMs = props.expirationMs;
    this.state = props.state;
    this.outcomes = [
      Object.freeze({ ...props.outcomes[0] }),
      Object.freeze({ ...props.outcomes[1] }),
    ];
    this._pendingEvents = pendingEvents;
  }

  // ==================== Getters ====================

  /**
   * Дата истечения рынка
   *
   * @returns Новый Date объект каждый раз (иммутабельность)
   *
   * @remarks
   * Возвращает копию, чтобы внешний код не мог мутировать внутреннее состояние.
   *
   * @example
   * ```typescript
   * const d1 = market.expirationDate;
   * const d2 = market.expirationDate;
   * console.log(d1 === d2); // false (разные объекты)
   * console.log(d1.getTime() === d2.getTime()); // true (одинаковое время)
   * ```
   */
  public get expirationDate(): Date {
    return new Date(this._expirationMs);
  }

  /**
   * Backward-compatible getter для текущего статуса
   *
   * @returns Текущий статус рынка как строка
   *
   * @example
   * ```typescript
   * console.log(market.status); // 'ACTIVE' | 'CLOSED' | 'RESOLVED'
   * ```
   */
  public get status(): MarketState['status'] {
    return this.state.status;
  }

  // ==================== Domain Events ====================

  /**
   * Возвращает и очищает буфер доменных событий (Outbox pattern)
   *
   * @returns Список событий, накопленных с момента последнего вызова
   *
   * @remarks
   * Application-слой должен вызывать pullEvents() после каждой успешной команды
   * и публиковать результат в event bus.
   *
   * Вызов pullEvents() опустошает буфер — следующий вызов вернёт [].
   * Market.create() и MarketViewModel.fromJSON() не эмитируют событий
   * (восстановление состояния ≠ новое бизнес-событие).
   *
   * @example
   * ```typescript
   * const closed = market.close();
   * const events = closed.pullEvents(); // [MarketClosedEvent]
   * await eventBus.publish(events);
   *
   * closed.pullEvents(); // [] — буфер очищен
   * ```
   */
  public pullEvents(): readonly MarketEvent[] {
    return this._pendingEvents.splice(0);
  }

  // ==================== Factory ====================

  /**
   * Создаёт Market с валидацией входных данных
   *
   * @param props - Параметры создания рынка
   * @returns Result<Market, MarketValidationError>
   *
   * @remarks
   * Factory method с Result pattern.
   * Валидирует все обязательные поля и бизнес-инварианты.
   *
   * ### Алгоритм валидации:
   * 1. Проверка question (непустой) — id/slug/OutcomeToken уже валидированы на уровне VO
   * 2. Проверка outcomes[i].name — два непустых и различных названия
   * 3. Проверка outcomes[i].token — два различных токена (через OutcomeToken.equals)
   * 4. Проверка expirationMs (конечное число)
   * 5. Проверка state (допустимый MarketState, runtime-защита)
   *
   * @example
   * ```typescript
   * const result = Market.create({
   *   id: asMarketId('market-abc')!,
   *   slug: parseMarketSlug('will-trump-win')!,
   *   question: 'Will Trump win?',
   *   outcomes: [
   *     { token: OutcomeToken.of(conditionRef, BinaryOutcome.UP), index: 0, name: 'Yes' },
   *     { token: OutcomeToken.of(conditionRef, BinaryOutcome.DOWN), index: 1, name: 'No' },
   *   ],
   *   expirationMs: Date.now() + 86400000,
   *   state: MarketState.active(),
   * });
   *
   * if (result.ok) {
   *   console.log(result.value.id); // 'market-abc'
   * }
   * ```
   */
  public static create(props: MarketProps): Result<Market, MarketValidationError> {
    // Валидация question — не может быть гарантирована типом string
    if (typeof props.question !== 'string' || props.question.trim().length === 0) {
      return Err(
        new MarketValidationError('Market question must be a non-empty string', {
          context: { field: 'question', value: props.question },
        })
      );
    }

    // Валидация outcomes[0].name
    if (
      typeof props.outcomes[0].name !== 'string' ||
      props.outcomes[0].name.trim().length === 0
    ) {
      return Err(
        new MarketValidationError('Outcome name at index 0 must be a non-empty string', {
          context: { field: 'outcomes[0].name', value: props.outcomes[0].name },
        })
      );
    }

    // Валидация outcomes[1].name
    if (
      typeof props.outcomes[1].name !== 'string' ||
      props.outcomes[1].name.trim().length === 0
    ) {
      return Err(
        new MarketValidationError('Outcome name at index 1 must be a non-empty string', {
          context: { field: 'outcomes[1].name', value: props.outcomes[1].name },
        })
      );
    }

    // Инвариант: названия исходов должны отличаться
    if (props.outcomes[0].name.trim() === props.outcomes[1].name.trim()) {
      return Err(
        new MarketValidationError('Outcome names must be distinct', {
          context: {
            field: 'outcomes',
            value: [props.outcomes[0].name, props.outcomes[1].name],
          },
        })
      );
    }

    // Инвариант: токены исходов должны отличаться (OutcomeToken.equals сравнивает по AssetId)
    if (props.outcomes[0].token.equals(props.outcomes[1].token)) {
      return Err(
        new MarketValidationError('Outcome tokens must be distinct', {
          context: { field: 'outcomes', value: 'tokens are equal' },
        })
      );
    }

    // Валидация expirationMs — number в JS может быть NaN или Infinity
    if (typeof props.expirationMs !== 'number' || !Number.isFinite(props.expirationMs)) {
      return Err(
        new MarketValidationError('Market expirationMs must be a finite number', {
          context: { field: 'expirationMs', value: props.expirationMs },
        })
      );
    }

    // Валидация state — runtime-защита от невалидных объектов (JS, JSON, as-касты)
    if (
      !props.state ||
      typeof props.state !== 'object' ||
      !['ACTIVE', 'CLOSED', 'RESOLVED'].includes(props.state.status)
    ) {
      return Err(
        new MarketValidationError('Market state must be a valid MarketState object', {
          context: {
            field: 'state',
            value: props.state ? props.state.status : props.state,
          },
        })
      );
    }

    return Ok(new Market(props));
  }

  // ==================== Time Methods ====================

  /**
   * Проверяет, истёк ли рынок в заданный момент времени
   *
   * @param nowMs - Текущее время в миллисекундах (Unix timestamp)
   * @returns true если текущее время >= времени истечения
   *
   * @remarks
   * Принимает nowMs вместо вызова Date.now() для тестируемости.
   * Используйте isExpired() для удобства в продакшн-коде.
   *
   * @example
   * ```typescript
   * const past = Date.parse('2020-01-01T00:00:00Z');
   * market.isExpiredAt(past);     // → false (если market.expirationMs > past)
   * market.isExpiredAt(Date.now()); // → зависит от expirationMs
   * ```
   */
  public isExpiredAt(nowMs: number): boolean {
    return nowMs >= this._expirationMs;
  }

  /**
   * Проверяет, истёк ли рынок в текущий момент
   *
   * @returns true если рынок истёк
   *
   * @remarks
   * Convenience wrapper над isExpiredAt(Date.now()).
   * В тестах используйте isExpiredAt(nowMs) для детерминизма.
   *
   * @example
   * ```typescript
   * if (market.isExpired()) {
   *   // Рынок истёк, торговля невозможна
   * }
   * ```
   */
  public isExpired(): boolean {
    return this.isExpiredAt(Date.now());
  }

  /**
   * Возвращает время до истечения рынка в заданный момент
   *
   * @param nowMs - Текущее время в миллисекундах
   * @returns Миллисекунды до истечения (отрицательное если уже истёк)
   *
   * @remarks
   * Принимает nowMs вместо вызова Date.now() для тестируемости.
   *
   * @example
   * ```typescript
   * const remaining = market.timeToExpiryAt(Date.now());
   * if (remaining > 0) {
   *   console.log(`Expires in ${remaining}ms`);
   * }
   * ```
   */
  public timeToExpiryAt(nowMs: number): number {
    return this._expirationMs - nowMs;
  }

  /**
   * Возвращает время до истечения рынка в текущий момент
   *
   * @returns Миллисекунды до истечения (отрицательное если уже истёк)
   *
   * @remarks
   * Convenience wrapper над timeToExpiryAt(Date.now()).
   *
   * @example
   * ```typescript
   * const ms = market.timeToExpiry();
   * console.log(`Expires in ${ms / 1000} seconds`);
   * ```
   */
  public timeToExpiry(): number {
    return this.timeToExpiryAt(Date.now());
  }

  // ==================== Predicates ====================

  /**
   * Проверяет, активен ли рынок
   *
   * @returns true если state.status === 'ACTIVE'
   *
   * @example
   * ```typescript
   * if (market.isActive()) {
   *   // Рынок открыт для торговли
   * }
   * ```
   */
  public isActive(): boolean {
    return isActive(this.state);
  }

  /**
   * Проверяет, закрыт ли рынок
   *
   * @returns true если state.status === 'CLOSED'
   *
   * @example
   * ```typescript
   * if (market.isClosed()) {
   *   // Торговля остановлена, ожидание разрешения
   * }
   * ```
   */
  public isClosed(): boolean {
    return isClosed(this.state);
  }

  /**
   * Проверяет, разрешён ли рынок
   *
   * @returns true если state.status === 'RESOLVED'
   *
   * @example
   * ```typescript
   * if (market.isResolved()) {
   *   // Рынок разрешён с конкретным исходом
   * }
   * ```
   */
  public isResolved(): boolean {
    return isResolved(this.state);
  }

  // ==================== Identity ====================

  /**
   * Сравнивает две сущности Market по идентичности
   *
   * @param other - Другой Market для сравнения
   * @returns true если оба рынка имеют одинаковый id
   *
   * @remarks
   * Entity определяется идентичностью (id), а не ссылкой.
   * Два объекта с разным state но одинаковым id — это одна и та же сущность.
   *
   * @example
   * ```typescript
   * const closed = market.close();
   * market.equals(closed); // true — тот же рынок, другое состояние
   * ```
   */
  public equals(other: Market): boolean {
    return this.id === other.id;
  }

  // ==================== Lifecycle Transitions ====================

  /**
   * Создаёт копию рынка с новым состоянием и событиями
   *
   * @param state - Новое состояние
   * @param events - Доменные события этого перехода
   * @returns Новый Market с тем же id/slug/question/outcomes/expiry, другим state и буфером событий
   *
   * @remarks
   * Централизует копирование props — изменение структуры затрагивает одно место.
   */
  private copy(state: MarketState, events: MarketEvent[]): Market {
    return new Market(
      {
        id: this.id,
        slug: this.slug,
        question: this.question,
        outcomes: this.outcomes,
        expirationMs: this._expirationMs,
        state,
      },
      events
    );
  }

  /**
   * Закрывает рынок (ACTIVE → CLOSED)
   *
   * @param nowMs - Текущее время в мс для метки события (по умолчанию Date.now())
   * @returns Новый Market в состоянии CLOSED
   * @throws {MarketAlreadyClosedError} Если рынок уже в состоянии CLOSED
   * @throws {MarketAlreadyResolvedError} Если рынок уже в состоянии RESOLVED
   *
   * @remarks
   * Переход: ACTIVE → CLOSED.
   * FSM-логика делегируется в MarketState.close() — entity не знает правил.
   * Параметр nowMs обеспечивает детерминизм в тестах.
   *
   * @example
   * ```typescript
   * const closedMarket = activeMarket.close();
   *
   * // Детерминированный тест:
   * const closedMarket = activeMarket.close(1_700_000_000_000);
   * expect(closedMarket.pullEvents()[0].occurredAt).toBe(1_700_000_000_000);
   * ```
   */
  public close(nowMs: number): Market {
    const nextState = MarketState.close(this.state, { marketId: this.id });
    return this.copy(nextState, [
      { type: 'MARKET_CLOSED', marketId: this.id, slug: this.slug, occurredAt: nowMs },
    ]);
  }

  /**
   * Разрешает рынок с конкретным исходом (CLOSED → RESOLVED)
   *
   * @param outcomeIndex - Индекс победившего исхода (0 = YES, 1 = NO)
   * @param nowMs - Текущее время в мс для метки события (по умолчанию Date.now())
   * @returns Новый Market в состоянии RESOLVED
   * @throws {MarketAlreadyResolvedError} Если рынок уже в состоянии RESOLVED
   * @throws {MarketInvalidTransitionError} Если рынок в состоянии ACTIVE (нужно сначала close())
   *
   * @remarks
   * Переход: CLOSED → RESOLVED.
   * FSM-логика делегируется в MarketState.resolve() — entity не знает правил.
   * Параметр nowMs обеспечивает детерминизм в тестах.
   *
   * @example
   * ```typescript
   * const resolvedMarket = closedMarket.resolve(0); // YES победил
   * const state = resolvedMarket.state;
   * if (state.status === 'RESOLVED') {
   *   console.log(state.resolvedOutcomeIndex); // 0
   * }
   * ```
   */
  public resolve(outcomeIndex: OutcomeIndex, nowMs: number): Market {
    if (outcomeIndex < 0 || outcomeIndex >= this.outcomes.length) {
      throw new MarketValidationError('resolvedOutcomeIndex must be a valid outcome index', {
        context: {
          field: 'outcomeIndex',
          value: outcomeIndex,
          validRange: `0..${this.outcomes.length - 1}`,
        },
      });
    }
    const nextState = MarketState.resolve(this.state, outcomeIndex, { marketId: this.id });
    return this.copy(nextState, [
      {
        type: 'MARKET_RESOLVED',
        marketId: this.id,
        slug: this.slug,
        resolvedOutcomeIndex: outcomeIndex,
        occurredAt: nowMs,
      },
    ]);
  }

  // ==================== String Representation ====================

  /**
   * Строковое представление рынка
   *
   * @returns Краткое описание рынка
   *
   * @example
   * ```typescript
   * console.log(market.toString());
   * // 'Market[market-abc](ACTIVE): Will Trump win the 2024 election?'
   * ```
   */
  public toString(): string {
    return `Market[${this.id}](${this.state.status}): ${this.question}`;
  }
}
