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
 * import { MarketState, asMarketId, parseMarketSlug, parseOutcomeTokenId } from './value-objects';
 *
 * const result = Market.create({
 *   id: asMarketId('market-abc'),
 *   slug: parseMarketSlug('will-trump-win-2024')!,
 *   question: 'Will Trump win the 2024 election?',
 *   outcomeNames: ['Yes', 'No'],
 *   outcomeTokenIds: [
 *     parseOutcomeTokenId('token-yes-123')!,
 *     parseOutcomeTokenId('token-no-456')!,
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
import {
  type MarketId,
  parseMarketId,
  type MarketSlug,
  parseMarketSlug,
  type OutcomeTokenId,
  parseOutcomeTokenId,
  type OutcomeIndex,
  MarketState,
  isActive,
  isClosed,
  isResolved,
  canTransition,
} from './value-objects/index.js';
import { MarketValidationError, MarketLifecycleError } from './errors/MarketErrors.js';

/**
 * Outcome — inline value object для исхода рынка
 *
 * @remarks
 * Не выносится в отдельный файл, т.к. используется только внутри Market.
 * Содержит всю необходимую информацию об одном исходе бинарного рынка.
 */
export interface Outcome {
  /** Токен-идентификатор исхода на блокчейне */
  readonly tokenId: OutcomeTokenId;
  /** Индекс исхода (0 = YES, 1 = NO) */
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
 *
 * ### Изменения относительно старой версии:
 * - `expirationMs: number` вместо `expirationDate: Date` (иммутабельность)
 * - `state: MarketState` вместо `status + resolvedOutcomeIndex` (type safety)
 * - `id: MarketId` вместо `id: string` (branded type)
 * - `slug: MarketSlug` вместо `slug: string` (branded type + валидация)
 * - `outcomeTokenIds: [OutcomeTokenId, OutcomeTokenId]` (branded types)
 */
export interface MarketProps {
  /** Уникальный идентификатор рынка */
  readonly id: MarketId;
  /** URL-safe слаг для построения ссылок */
  readonly slug: MarketSlug;
  /** Вопрос рынка */
  readonly question: string;
  /** Названия исходов: [YES, NO] */
  readonly outcomeNames: readonly [string, string];
  /** Токен-идентификаторы исходов: [YES token, NO token] */
  readonly outcomeTokenIds: readonly [OutcomeTokenId, OutcomeTokenId];
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
   * Приватный конструктор — используйте Market.create()
   */
  private constructor(props: MarketProps) {
    this.id = props.id;
    this.slug = props.slug;
    this.question = props.question;
    this._expirationMs = props.expirationMs;
    this.state = props.state;
    this.outcomes = [
      Object.freeze({
        tokenId: props.outcomeTokenIds[0],
        index: 0 as OutcomeIndex,
        name: props.outcomeNames[0],
      }),
      Object.freeze({
        tokenId: props.outcomeTokenIds[1],
        index: 1 as OutcomeIndex,
        name: props.outcomeNames[1],
      }),
    ];
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
   * 1. Проверка id (непустой)
   * 2. Проверка slug (URL-safe символы)
   * 3. Проверка question (непустой)
   * 4. Проверка outcomeNames (два непустых названия)
   * 5. Проверка outcomeTokenIds (два непустых токен-идентификатора)
   * 6. Проверка expirationMs (конечное число)
   * 7. Проверка state (допустимый MarketState)
   *
   * @example
   * ```typescript
   * const result = Market.create({
   *   id: asMarketId('market-abc'),
   *   slug: parseMarketSlug('will-trump-win')!,
   *   question: 'Will Trump win?',
   *   outcomeNames: ['Yes', 'No'],
   *   outcomeTokenIds: [parseOutcomeTokenId('token-yes')!, parseOutcomeTokenId('token-no')!],
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
    // Валидация id
    const idCheck = parseMarketId(props.id);
    if (idCheck === undefined) {
      return Err(
        new MarketValidationError('Market ID must be a non-empty string', {
          context: { field: 'id', value: props.id },
        })
      );
    }

    // Валидация slug
    const slugCheck = parseMarketSlug(props.slug);
    if (slugCheck === undefined) {
      return Err(
        new MarketValidationError(
          'Market slug must contain only lowercase letters, digits and hyphens (a-z0-9-)',
          { context: { field: 'slug', value: props.slug } }
        )
      );
    }

    // Валидация question
    if (typeof props.question !== 'string' || props.question.trim().length === 0) {
      return Err(
        new MarketValidationError('Market question must be a non-empty string', {
          context: { field: 'question', value: props.question },
        })
      );
    }

    // Валидация outcomeNames[0]
    if (typeof props.outcomeNames[0] !== 'string' || props.outcomeNames[0].trim().length === 0) {
      return Err(
        new MarketValidationError('Outcome name at index 0 must be a non-empty string', {
          context: { field: 'outcomeNames[0]', value: props.outcomeNames[0] },
        })
      );
    }

    // Валидация outcomeNames[1]
    if (typeof props.outcomeNames[1] !== 'string' || props.outcomeNames[1].trim().length === 0) {
      return Err(
        new MarketValidationError('Outcome name at index 1 must be a non-empty string', {
          context: { field: 'outcomeNames[1]', value: props.outcomeNames[1] },
        })
      );
    }

    // Валидация outcomeTokenIds[0]
    const tokenId0 = parseOutcomeTokenId(props.outcomeTokenIds[0]);
    if (tokenId0 === undefined) {
      return Err(
        new MarketValidationError('Outcome token ID at index 0 must be a non-empty string', {
          context: { field: 'outcomeTokenIds[0]', value: props.outcomeTokenIds[0] },
        })
      );
    }

    // Валидация outcomeTokenIds[1]
    const tokenId1 = parseOutcomeTokenId(props.outcomeTokenIds[1]);
    if (tokenId1 === undefined) {
      return Err(
        new MarketValidationError('Outcome token ID at index 1 must be a non-empty string', {
          context: { field: 'outcomeTokenIds[1]', value: props.outcomeTokenIds[1] },
        })
      );
    }

    // Валидация expirationMs
    if (typeof props.expirationMs !== 'number' || !Number.isFinite(props.expirationMs)) {
      return Err(
        new MarketValidationError('Market expirationMs must be a finite number', {
          context: { field: 'expirationMs', value: props.expirationMs },
        })
      );
    }

    // Валидация state
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

  /**
   * Проверяет, можно ли торговать на рынке
   *
   * @returns true если рынок ACTIVE и не истёк
   *
   * @remarks
   * Торговля возможна только если рынок активен И не истёк по времени.
   *
   * @example
   * ```typescript
   * if (market.canTrade()) {
   *   // Можно подавать ордера
   * } else {
   *   // Торговля недоступна
   * }
   * ```
   */
  public canTrade(): boolean {
    return isActive(this.state) && !this.isExpired();
  }

  // ==================== Lifecycle Transitions ====================

  /**
   * Закрывает рынок (ACTIVE → CLOSED)
   *
   * @returns Новый Market в состоянии CLOSED
   * @throws {MarketLifecycleError} Если рынок не в состоянии ACTIVE
   *
   * @remarks
   * Переход: ACTIVE → CLOSED
   *
   * Бросает MarketLifecycleError (не возвращает Result), т.к. вызов close()
   * на CLOSED/RESOLVED рынке всегда является ошибкой программиста,
   * а не ошибкой пользователя.
   *
   * @example
   * ```typescript
   * const activeMarket = /* ... *\/;
   * const closedMarket = activeMarket.close();
   * console.log(closedMarket.state.status); // 'CLOSED'
   *
   * // Повторный вызов бросает ошибку:
   * closedMarket.close(); // throws MarketLifecycleError
   * ```
   */
  public close(): Market {
    if (!canTransition(this.state, 'CLOSED')) {
      throw new MarketLifecycleError(
        `Cannot close market in ${this.state.status} state. ` +
          (this.state.status === 'CLOSED'
            ? 'Market is already closed.'
            : 'Market has already been resolved.'),
        {
          code: MarketLifecycleError.code,
          context: { marketId: this.id, currentStatus: this.state.status },
        }
      );
    }

    return new Market({
      id: this.id,
      slug: this.slug,
      question: this.question,
      outcomeNames: [this.outcomes[0].name, this.outcomes[1].name],
      outcomeTokenIds: [this.outcomes[0].tokenId, this.outcomes[1].tokenId],
      expirationMs: this._expirationMs,
      state: MarketState.closed(),
    });
  }

  /**
   * Разрешает рынок с конкретным исходом (CLOSED → RESOLVED)
   *
   * @param outcomeIndex - Индекс победившего исхода (0 = YES, 1 = NO)
   * @returns Новый Market в состоянии RESOLVED
   * @throws {MarketLifecycleError} Если рынок не в состоянии CLOSED
   *
   * @remarks
   * Переход: CLOSED → RESOLVED
   *
   * OutcomeIndex = 0 | 1 — компилятор TypeScript гарантирует валидность,
   * поэтому дополнительная проверка не нужна.
   *
   * Бросает MarketLifecycleError, т.к. вызов resolve() на ACTIVE или RESOLVED
   * рынке всегда является ошибкой программиста.
   *
   * @example
   * ```typescript
   * const closedMarket = activeMarket.close();
   * const resolvedMarket = closedMarket.resolve(0); // YES победил
   *
   * if (resolvedMarket.isResolved()) {
   *   const state = resolvedMarket.state;
   *   if (state.status === 'RESOLVED') {
   *     console.log(state.resolvedOutcomeIndex); // 0
   *   }
   * }
   * ```
   */
  public resolve(outcomeIndex: OutcomeIndex): Market {
    if (!canTransition(this.state, 'RESOLVED')) {
      throw new MarketLifecycleError(
        `Cannot resolve market in ${this.state.status} state. ` +
          (this.state.status === 'ACTIVE'
            ? 'Call close() first.'
            : 'Market has already been resolved.'),
        {
          code: MarketLifecycleError.code,
          context: {
            marketId: this.id,
            currentStatus: this.state.status,
            outcomeIndex,
          },
        }
      );
    }

    return new Market({
      id: this.id,
      slug: this.slug,
      question: this.question,
      outcomeNames: [this.outcomes[0].name, this.outcomes[1].name],
      outcomeTokenIds: [this.outcomes[0].tokenId, this.outcomes[1].tokenId],
      expirationMs: this._expirationMs,
      state: MarketState.resolved(outcomeIndex),
    });
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
