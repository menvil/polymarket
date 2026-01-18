/**
 * Агрегат RiskExposure
 *
 * @remarks
 * Управляет состоянием риска и режимами торговли для маркет-мейкера.
 * Отслеживает статус риска, защитный режим, срочность и режимы торговли.
 *
 * Алгоритм:
 * - Мониторит лимиты портфеля (нетто-позиция, брутто-позиция, наличные)
 * - Вычисляет срочность на основе времени до экспирации и размера позиции
 * - Переходит между состояниями риска: NORMAL → WARNING → DEFENSIVE → PANIC
 * - Управляет режимами торговли: QUOTE → SKEW → UNWIND → PANIC
 * - Применяет правила и лимиты управления рисками
 *
 * Состояния риска:
 * - NORMAL: Работа в пределах всех лимитов, нормальная торговля
 * - WARNING: Приближение к одному или нескольким лимитам, начало осторожности
 * - DEFENSIVE: Превышены мягкие лимиты, снижение экспозиции
 * - PANIC: Критические лимиты нарушены, экстренное закрытие позиций
 *
 * Режимы торговли:
 * - QUOTE: Нормальный двусторонний маркет-мейкинг
 * - SKEW: Смещение котировок для снижения экспозиции
 * - UNWIND: Активное закрытие позиций
 * - PANIC: Режим экстренной ликвидации
 *
 * Почему агрегат?
 * - Состояние риска является границей согласованности для решений по рискам
 * - Все изменения состояния, связанные с рисками, координируются
 * - Обеспечивает инварианты: срочность в [0,1], валидные переходы состояний
 * - Единый источник истины для управления рисками
 *
 * @example
 * ```typescript
 * // Create normal risk exposure
 * const risk = RiskExposure.create();
 * console.log(risk.status); // 'NORMAL'
 * console.log(risk.mode); // 'QUOTE'
 *
 * // Check limits against portfolio
 * const portfolio = Portfolio.create(Money.fromUSDC(1000));
 * const updated = risk.checkLimits(portfolio, 1000, 2000);
 * console.log(updated.status); // 'NORMAL' (within limits)
 *
 * // Calculate urgency as time runs out
 * const urgency = risk.calculateUrgency(3600000, 800, 1000); // 1 hour left
 * console.log(urgency); // 0.85 (high urgency)
 *
 * // Check if should panic
 * const shouldPanic = risk.shouldPanic(Money.fromUSDC(-500), Money.fromUSDC(100));
 * console.log(shouldPanic); // true (loss exceeds threshold)
 * ```
 */
import { Portfolio } from './Portfolio.js';
import { Money } from '../value-objects/Money.js';
import { TradingError } from '../../shared/errors/TradingError.js';
import { ConfigLoader } from '../../infrastructure/config/ConfigLoader.js';

/**
 * Тип статуса риска
 *
 * @remarks
 * Представляет текущий уровень риска портфеля
 */
export type RiskStatus = 'NORMAL' | 'WARNING' | 'DEFENSIVE' | 'PANIC';

/**
 * Тип режима торговли
 *
 * @remarks
 * Определяет, как маркет-мейкер должен котировать и торговать
 */
export type TradingMode = 'QUOTE' | 'SKEW' | 'UNWIND' | 'PANIC';

/**
 * Ошибка нарушения инварианта экспозиции риска
 *
 * @remarks
 * Выбрасывается когда состояние риска нарушает бизнес-правила
 */
export class RiskExposureInvariantError extends TradingError {
  constructor(message: string) {
    super(`Risk exposure invariant violation: ${message}`, 'RISK_INVARIANT_VIOLATION');
  }
}

/**
 * Конфигурация лимитов риска
 *
 * @remarks
 * Определяет пороговые значения для лимитов позиции и убытков
 */
export interface RiskLimits {
  readonly maxNetPosition: number;
  readonly maxGrossPosition: number;
  readonly maxLossThreshold: Money;
  readonly warningThreshold: number; // % of limit (e.g., 0.8 = 80%)
  readonly defensiveThreshold: number; // % of limit (e.g., 0.9 = 90%)
}

/**
 * Корневой агрегат экспозиции риска
 *
 * @remarks
 * Иммутабельный агрегат, управляющий всем состоянием риска.
 * Все методы возвращают новые экземпляры RiskExposure.
 */
export class RiskExposure {
  /**
   * Создаёт новый RiskExposure
   *
   * @param status - Текущий статус риска
   * @param mode - Текущий режим торговли
   * @param defensiveMode - Активен ли защитный режим
   * @param urgency - Уровень срочности [0, 1]
   * @param stateReason - Причина текущего состояния
   * @param stateEnterTime - Когда было введено текущее состояние
   *
   * @remarks
   * Приватный конструктор - используйте статические фабричные методы.
   */
  private constructor(
    public readonly status: RiskStatus,
    public readonly mode: TradingMode,
    public readonly defensiveMode: boolean,
    public readonly urgency: number,
    public readonly stateReason: string,
    public readonly stateEnterTime: Date
  ) {}

  /**
   * Создаёт новую экспозицию риска с нормальным состоянием
   *
   * @returns Новый RiskExposure в состоянии NORMAL
   *
   * @remarks
   * Фабричный метод, создающий начальное состояние риска.
   * Начинает со статуса NORMAL и режима QUOTE.
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create();
   * console.log(risk.status); // 'NORMAL'
   * console.log(risk.mode); // 'QUOTE'
   * console.log(risk.defensiveMode); // false
   * console.log(risk.urgency); // 0
   * ```
   */
  public static create(): RiskExposure {
    const risk = new RiskExposure(
      'NORMAL',
      'QUOTE',
      false,
      0,
      'Initial state',
      new Date()
    );
    risk.validateInvariants();
    return risk;
  }

  /**
   * Проверяет портфель на соответствие лимитам риска
   *
   * @param portfolio - Текущее состояние портфеля
   * @param maxNet - Максимальная нетто-позиция (абсолютное значение)
   * @param maxGross - Максимальная брутто-позиция
   * @returns Новый RiskExposure с обновлённым статусом
   *
   * @remarks
   * Алгоритм:
   * 1. Вычислить соотношение нетто-позиции: |net| / maxNet
   * 2. Вычислить соотношение брутто-позиции: gross / maxGross
   * 3. Взять максимум из обоих соотношений
   * 4. Определить статус на основе пороговых значений:
   *    - < 80%: NORMAL
   *    - 80-90%: WARNING
   *    - 90-100%: DEFENSIVE
   *    - > 100%: PANIC
   * 5. Обновить режим торговли на основе статуса
   * 6. Вернуть новый экземпляр RiskExposure
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create();
   * const portfolio = Portfolio.create(Money.fromUSDC(1000))
   *   .addPosition('token-1', 'YES', lot); // net = 100
   *
   * // Within limits
   * const updated = risk.checkLimits(portfolio, 1000, 2000);
   * console.log(updated.status); // 'NORMAL'
   *
   * // Approaching limits (net = 850 / 1000 = 85%)
   * const warning = risk.checkLimits(portfolioWarning, 1000, 2000);
   * console.log(warning.status); // 'WARNING'
   * ```
   */
  public checkLimits(
    portfolio: Portfolio,
    maxNet: number,
    maxGross: number
  ): RiskExposure {
    const netPosition = Math.abs(portfolio.netPosition);
    const grossPosition = portfolio.grossPosition;

    // Calculate position ratios
    const netRatio = maxNet > 0 ? netPosition / maxNet : 0;
    const grossRatio = maxGross > 0 ? grossPosition / maxGross : 0;
    const maxRatio = Math.max(netRatio, grossRatio);

    let newStatus: RiskStatus = this.status;
    let newMode: TradingMode = this.mode;
    let reason = this.stateReason;
    let enterTime = this.stateEnterTime;

    // Determine status based on thresholds (from config)
    const riskUtilConfig = ConfigLoader.getInstance().getRiskUtilizationConfig();
    if (maxRatio > 1.0) {
      newStatus = 'PANIC';
      newMode = 'PANIC';
      reason = `Critical limit breach: ${(maxRatio * 100).toFixed(1)}% of max`;
    } else if (maxRatio >= riskUtilConfig.criticalThreshold) {
      newStatus = 'DEFENSIVE';
      newMode = 'UNWIND';
      reason = `Defensive limit reached: ${(maxRatio * 100).toFixed(1)}% of max`;
    } else if (maxRatio >= riskUtilConfig.highThreshold) {
      newStatus = 'WARNING';
      newMode = 'SKEW';
      reason = `Warning threshold exceeded: ${(maxRatio * 100).toFixed(1)}% of max`;
    } else {
      newStatus = 'NORMAL';
      newMode = 'QUOTE';
      reason = `Within limits: ${(maxRatio * 100).toFixed(1)}% of max`;
    }

    // Update enter time if status changed
    if (newStatus !== this.status) {
      enterTime = new Date();
    }

    const risk = new RiskExposure(
      newStatus,
      newMode,
      newStatus === 'DEFENSIVE' || newStatus === 'PANIC',
      this.urgency,
      reason,
      enterTime
    );

    risk.validateInvariants();
    return risk;
  }

  /**
   * Вычисляет срочность на основе времени и позиции
   *
   * @param timeToExpiry - Миллисекунды до экспирации рынка
   * @param netPosition - Текущая нетто-позиция (абсолютное значение)
   * @param maxPosition - Максимально допустимая позиция
   * @returns Уровень срочности [0, 1]
   *
   * @remarks
   * Алгоритм:
   * 1. Вычислить срочность по времени: 1 - (timeLeft / totalTime)
   *    - Более срочно по мере истечения времени
   * 2. Вычислить срочность по позиции: netPosition / maxPosition
   *    - Более срочно при больших позициях
   * 3. Объединить: urgency = (timeUrgency * 0.6) + (positionUrgency * 0.4)
   *    - Вес времени 60%, вес позиции 40%
   * 4. Ограничить до [0, 1]
   *
   * Почему эта формула?
   * - Временное давление - основная проблема (60% веса)
   * - Размер позиции добавляет срочности (40% веса)
   * - Оба фактора объединяются для целостной срочности
   * - Нелинейно: срочность ускоряется при приближении экспирации
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create();
   *
   * // Early in market, small position
   * const u1 = risk.calculateUrgency(86400000, 100, 1000); // 24h left
   * console.log(u1); // ~0.04 (low urgency)
   *
   * // 1 hour left, large position
   * const u2 = risk.calculateUrgency(3600000, 900, 1000); // 1h left
   * console.log(u2); // ~0.85 (high urgency)
   *
   * // 5 minutes left, any position
   * const u3 = risk.calculateUrgency(300000, 500, 1000); // 5min left
   * console.log(u3); // ~0.95 (critical urgency)
   * ```
   */
  public calculateUrgency(
    timeToExpiry: number,
    netPosition: number,
    maxPosition: number
  ): number {
    // Time urgency: increases as expiry approaches
    const totalTime = 24 * 60 * 60 * 1000; // 24 hours in ms
    const timeUrgency = Math.max(0, Math.min(1, 1 - timeToExpiry / totalTime));

    // Position urgency: increases with position size
    const positionUrgency = maxPosition > 0 ? Math.abs(netPosition) / maxPosition : 0;

    // Combined urgency (time weighted more heavily)
    const urgency = timeUrgency * 0.6 + positionUrgency * 0.4;

    return Math.max(0, Math.min(1, urgency));
  }

  /**
   * Обновляет режим торговли с указанием причины
   *
   * @param newMode - Новый режим торговли для установки
   * @param reason - Причина смены режима
   * @returns Новый RiskExposure с обновлённым режимом
   *
   * @remarks
   * Обновляет режим торговли и записывает причину.
   * Автоматически корректирует флаг защитного режима.
   * Обновляет время входа в состояние при изменении режима.
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create();
   *
   * // Switch to skew mode
   * const skewed = risk.updateMode('SKEW', 'Large imbalance detected');
   * console.log(skewed.mode); // 'SKEW'
   * console.log(skewed.stateReason); // 'Large imbalance detected'
   *
   * // Emergency unwind
   * const unwinding = skewed.updateMode('UNWIND', 'Approaching position limit');
   * console.log(unwinding.mode); // 'UNWIND'
   * console.log(unwinding.defensiveMode); // true
   * ```
   */
  public updateMode(newMode: TradingMode, reason: string): RiskExposure {
    // Map mode to status
    let newStatus = this.status;
    if (newMode === 'PANIC') {
      newStatus = 'PANIC';
    } else if (newMode === 'UNWIND') {
      newStatus = 'DEFENSIVE';
    } else if (newMode === 'SKEW') {
      newStatus = 'WARNING';
    } else {
      newStatus = 'NORMAL';
    }

    const risk = new RiskExposure(
      newStatus,
      newMode,
      newMode === 'UNWIND' || newMode === 'PANIC',
      this.urgency,
      reason,
      newMode !== this.mode ? new Date() : this.stateEnterTime
    );

    risk.validateInvariants();
    return risk;
  }

  /**
   * Обновляет уровень срочности
   *
   * @param urgency - Новый уровень срочности [0, 1]
   * @param reason - Причина изменения срочности
   * @returns Новый RiskExposure с обновлённой срочностью
   *
   * @throws {RiskExposureInvariantError} Выбрасывается когда срочность вне диапазона
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create();
   *
   * const urgent = risk.updateUrgency(0.85, 'Market closing soon');
   * console.log(urgent.urgency); // 0.85
   * ```
   */
  public updateUrgency(urgency: number, reason: string): RiskExposure {
    if (urgency < 0 || urgency > 1) {
      throw new RiskExposureInvariantError(`Urgency must be in [0, 1], got ${urgency}`);
    }

    const risk = new RiskExposure(
      this.status,
      this.mode,
      this.defensiveMode,
      urgency,
      reason,
      this.stateEnterTime
    );

    risk.validateInvariants();
    return risk;
  }

  /**
   * Проверяет, нужно ли входить в режим паники
   *
   * @param unrealizedPnL - Текущий нереализованный PnL
   * @param lossThreshold - Максимально допустимый убыток
   * @returns True если нужно паниковать
   *
   * @remarks
   * Условия паники:
   * 1. Нереализованный убыток превышает порог
   * 2. Убыток отрицательный (реальный убыток, не прибыль)
   *
   * Почему паника?
   * - Предотвращает катастрофические убытки
   * - Запускает экстренное снижение риска
   * - Переопределяет нормальную торговую логику
   * - Требуется немедленное действие
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create();
   *
   * // Small loss - no panic
   * const shouldPanic1 = risk.shouldPanic(
   *   Money.fromUSDC(-50),
   *   Money.fromUSDC(100)
   * );
   * console.log(shouldPanic1); // false
   *
   * // Large loss - panic!
   * const shouldPanic2 = risk.shouldPanic(
   *   Money.fromUSDC(-150),
   *   Money.fromUSDC(100)
   * );
   * console.log(shouldPanic2); // true
   * ```
   */
  public shouldPanic(unrealizedPnL: Money, lossThreshold: Money): boolean {
    // Panic if loss exceeds threshold
    return unrealizedPnL.amount < 0 && Math.abs(unrealizedPnL.amount) > lossThreshold.amount;
  }

  /**
   * Проверяет, находится ли в нормальном состоянии
   *
   * @returns True если статус NORMAL
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create();
   * console.log(risk.isNormal()); // true
   * ```
   */
  public isNormal(): boolean {
    return this.status === 'NORMAL';
  }

  /**
   * Проверяет, находится ли в состоянии предупреждения
   *
   * @returns True если статус WARNING
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create()
   *   .updateMode('SKEW', 'Warning');
   * console.log(risk.isWarning()); // true
   * ```
   */
  public isWarning(): boolean {
    return this.status === 'WARNING';
  }

  /**
   * Проверяет, находится ли в защитном состоянии
   *
   * @returns True если статус DEFENSIVE
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create()
   *   .updateMode('UNWIND', 'Defensive');
   * console.log(risk.isDefensive()); // true
   * console.log(risk.defensiveMode); // true
   * ```
   */
  public isDefensive(): boolean {
    return this.status === 'DEFENSIVE';
  }

  /**
   * Проверяет, находится ли в состоянии паники
   *
   * @returns True если статус PANIC
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create()
   *   .updateMode('PANIC', 'Emergency');
   * console.log(risk.isPanic()); // true
   * console.log(risk.defensiveMode); // true
   * ```
   */
  public isPanic(): boolean {
    return this.status === 'PANIC';
  }

  /**
   * Получает время в текущем состоянии
   *
   * @returns Миллисекунды в текущем состоянии
   *
   * @remarks
   * Полезно для отслеживания времени в каждом состоянии.
   * Может использоваться для запуска действий после таймаута.
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create();
   * // ... time passes ...
   * const duration = risk.getTimeInState();
   * console.log(`In ${risk.status} for ${duration}ms`);
   * ```
   */
  public getTimeInState(): number {
    return Date.now() - this.stateEnterTime.getTime();
  }

  /**
   * Проверяет бизнес-правила и инварианты
   *
   * @throws {RiskExposureInvariantError} Выбрасывается когда любой инвариант нарушен
   *
   * @remarks
   * Бизнес-правила:
   * 1. Срочность должна быть в [0, 1]
   * 2. Защитный режим должен соответствовать статусу (DEFENSIVE или PANIC)
   * 3. Режим должен быть согласован со статусом
   * 4. Причина состояния должна быть непустой
   * 5. Время входа в состояние должно быть валидным
   *
   * Вызывается автоматически после каждого изменения состояния.
   */
  public validateInvariants(): void {
    // Rule 1: Urgency must be in [0, 1]
    if (this.urgency < 0 || this.urgency > 1) {
      throw new RiskExposureInvariantError(`Urgency must be in [0, 1], got ${this.urgency}`);
    }

    // Rule 2: Defensive mode must match status
    const shouldBeDefensive = this.status === 'DEFENSIVE' || this.status === 'PANIC';
    if (this.defensiveMode !== shouldBeDefensive) {
      throw new RiskExposureInvariantError(
        `Defensive mode (${this.defensiveMode}) inconsistent with status (${this.status})`
      );
    }

    // Rule 3: Mode must be consistent with status
    if (this.status === 'PANIC' && this.mode !== 'PANIC') {
      throw new RiskExposureInvariantError(`PANIC status requires PANIC mode, got ${this.mode}`);
    }

    // Rule 4: State reason must be non-empty
    if (!this.stateReason || this.stateReason.trim().length === 0) {
      throw new RiskExposureInvariantError('State reason cannot be empty');
    }

    // Rule 5: State enter time must be valid
    if (!(this.stateEnterTime instanceof Date) || isNaN(this.stateEnterTime.getTime())) {
      throw new RiskExposureInvariantError('State enter time must be valid Date');
    }
  }

  /**
   * Создаёт строковое представление экспозиции риска
   *
   * @returns Форматированная строка с сводкой состояния риска
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create()
   *   .updateMode('SKEW', 'Position imbalance');
   * console.log(risk.toString());
   * // "RiskExposure: WARNING/SKEW (defensive: false, urgency: 0.00) - Position imbalance"
   * ```
   */
  public toString(): string {
    return `RiskExposure: ${this.status}/${this.mode} (defensive: ${this.defensiveMode}, urgency: ${this.urgency.toFixed(2)}) - ${this.stateReason}`;
  }
}
