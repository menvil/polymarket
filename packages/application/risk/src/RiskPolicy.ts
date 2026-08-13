/**
 * Иммутабельная валидированная риск-политика.
 *
 * @remarks
 * ### Зачем нужна:
 * `RiskParams` — «сырой» вход (может прийти из конфига/env). Прежде чем передать
 * его в `OrderRiskChecker`, параметры ОБЯЗАНЫ быть провалидированы: невалидный
 * лимит (NaN, Infinity, отрицательное число, дробный integer-счётчик) молча
 * отключил бы или исказил бы защиту. `RiskPolicy.create` возвращает `Result` —
 * невалидная конфигурация приводит к явному отказу на этапе создания (обычно —
 * fail-fast на старте приложения), а не к тихому багу в runtime.
 *
 * ### Иммутабельность:
 * После `create()` параметры заморожены (`Object.freeze`) и не могут меняться.
 * Runtime-обновление (`updateParams`) намеренно убрано из checker — политика
 * фиксируется на всё время жизни. Если политику нужно поменять — создаётся новый
 * `OrderRiskChecker` с новой `RiskPolicy` (atomic swap на уровне композиции).
 *
 * ### Правила валидации:
 * - вход обязан быть **plain object** (`Object.prototype` или `null` prototype):
 *   `Date`, массив, примитив, экземпляр класса → отказ;
 * - учитываются только **own**-свойства (унаследованные/prototype-pollution
 *   поля игнорируются, а не подставляются);
 * - `maxOpenOrders` — целое число >= 0 (счётчик ордеров);
 * - `minTimeToExpiryMs` — целое число >= 0 (миллисекунды);
 * - `maxPositionSize` — обязан быть экземпляром `Quantity` (`instanceof`); отдельная
 *   проверка на отрицательность не нужна — `Quantity` core уже enforces `>= 0` на
 *   собственном конструкторе, невалидный экземпляр физически не существует;
 * - `maxTotalExposure`/`maxOrderNotional`/`minAvailableBalance` — обязаны быть
 *   экземплярами `Money` (`instanceof`) И `>= 0` — `Money` core сознательно допускает
 *   отрицательные суммы (это НЕ invariant, см. `Money`'s докблок), поэтому
 *   неотрицательность лимита проверяется здесь явно, как и раньше;
 * - `undefined` допустим только для ИЗВЕСТНОГО поля (лимит не задан); неизвестный
 *   ключ отклоняется независимо от значения, включая `undefined`.
 *
 * ### Номинальность (compile-time):
 * `RiskPolicy` помечена приватным brand-полем — структурно совместимый plain
 * object нельзя присвоить типу `RiskPolicy` (защита от подделки на уровне
 * TypeScript-компилятора; это НЕ runtime-гарантия против произвольного JS).
 *
 * @example
 * ```typescript
 * const result = RiskPolicy.create({
 *   maxOpenOrders: 10,
 *   maxOrderNotional: Money.of(new Decimal(5000), 'USDC'),
 * });
 * if (!result.ok) {
 *   throw new Error(`Invalid risk config: ${result.error.message}`);
 * }
 * const checker = new OrderRiskChecker(result.value, logger);
 * ```
 */
import { Money, Quantity } from '@polymarket/value-objects';
import { Ok, Err } from '@polymarket/result';
import type { Result } from '@polymarket/result';
import type { RiskParams } from './RiskParams.js';

/**
 * Ошибка невалидной риск-конфигурации.
 *
 * @remarks
 * Возвращается из `RiskPolicy.create` через `Result`. `field` указывает на
 * конкретный невалидный параметр (для точной диагностики в логах/на старте).
 */
export class RiskConfigError extends Error {
  /** Имя невалидного поля `RiskParams`. */
  public readonly field: string;

  /**
   * @param field - Имя невалидного поля
   * @param message - Человекочитаемое описание (English)
   */
  constructor(field: string, message: string) {
    super(message);
    this.name = 'RiskConfigError';
    this.field = field;
  }
}

/** Разрешённые integer-поля (счётчики). */
const INTEGER_FIELDS = ['maxOpenOrders', 'minTimeToExpiryMs'] as const;
/** Разрешённые `Quantity`-поля (лимиты в токенах). */
const QUANTITY_FIELDS = ['maxPositionSize'] as const;
/** Разрешённые `Money`-поля (лимиты в USDC). */
const MONEY_FIELDS = [
  'maxTotalExposure',
  'maxOrderNotional',
  'minAvailableBalance',
] as const;
/** Полный набор разрешённых полей `RiskParams` (whitelist). */
const ALLOWED_FIELDS: ReadonlySet<string> = new Set<string>([
  ...INTEGER_FIELDS,
  ...QUANTITY_FIELDS,
  ...MONEY_FIELDS,
]);

/**
 * Валидированная иммутабельная риск-политика.
 *
 * @remarks
 * Единственный способ получить экземпляр — статический `create()`, который
 * возвращает `Result`. Конструктор приватный: снаружи невозможно создать
 * невалидную/непроверенную политику.
 */
export class RiskPolicy {
  /**
   * Compile-time brand: делает `RiskPolicy` номинальным типом. `declare` — поле
   * существует только на уровне типов (нет runtime-представления, конструктор
   * его не инициализирует). Структурно совместимый plain object без этого поля
   * нельзя присвоить `RiskPolicy`. Это TypeScript-гарантия, НЕ защита в runtime.
   */
  declare private readonly _riskPolicyBrand: void;

  /**
   * @param params - Уже провалидированные и замороженные параметры
   */
  private constructor(public readonly params: Readonly<RiskParams>) {}

  /**
   * Валидирует сырой конфиг и создаёт иммутабельную `RiskPolicy`.
   *
   * @param params - Сырой конфиг (runtime-граница: тип `unknown` до валидации)
   * @returns `Ok(RiskPolicy)` при валидной конфигурации, иначе
   *   `Err(RiskConfigError)` с именем первого невалидного/неизвестного поля
   *
   * @remarks
   * ### Полноценная runtime-валидация (не только compile-time):
   * `params` может прийти из внешнего источника (env/JSON/`as any`/Proxy),
   * поэтому проверки НЕ доверяют статическому типу:
   * - вход обязан быть **plain object** (prototype === `Object.prototype` или
   *   `null`): `Date`, экземпляр класса, массив, примитив → `Err('<root>')`;
   * - учитываются только **own**-свойства (`hasOwnProperty`): унаследованные и
   *   prototype-pollution поля игнорируются, а не подставляются;
   * - каждое поле читается ОДИН раз (устойчиво к getter'ам с side-effects);
   * - неизвестный own-ключ → `Err` независимо от значения (включая `undefined`);
   * - integer-поля — `typeof === 'number'`, finite, целые, `>= 0`;
   * - `Quantity`-поля — `instanceof Quantity` (сам тип уже enforces `>= 0` на
   *   конструкторе — отдельная проверка диапазона не нужна);
   * - `Money`-поля — `instanceof Money` И `>= 0` (`Money` core допускает отрицательные
   *   суммы, поэтому неотрицательность лимита — отдельная явная проверка);
   * - собирается НОВЫЙ объект ТОЛЬКО из провалидированных whitelisted own-полей.
   *
   * ### Никогда не бросает:
   * все ошибки — через `Result`. Если runtime-introspection (`Object.keys`,
   * `Object.getPrototypeOf`, getter, Proxy-trap) бросает — возвращается
   * `Err(RiskConfigError('<root>'))`. Сообщения об ошибках НЕ включают полное
   * raw-значение конфига (только тип/имя поля).
   *
   * @example
   * ```typescript
   * RiskPolicy.create({ maxOpenOrders: -1 });          // Err(field='maxOpenOrders')
   * RiskPolicy.create({ maxTotalExposure: 100 });       // Err (не Money), НЕ throw
   * RiskPolicy.create({ maxDrawdown: '0.2' } as never); // Err(field='maxDrawdown', unknown)
   * RiskPolicy.create(new Date());                       // Err('<root>')
   * ```
   */
  public static create(params: unknown): Result<RiskPolicy, RiskConfigError> {
    try {
      return RiskPolicy._validateAndBuild(params);
    } catch {
      // Runtime introspection бросил (throwing getter / Proxy trap /
      // getPrototypeOf). Fail-closed. НЕ включаем raw-значение и сообщение
      // исходной ошибки (могут содержать чувствительные данные).
      return Err(new RiskConfigError('<root>', 'Failed to introspect risk config (introspection threw)'));
    }
  }

  /**
   * Внутренняя валидация + сборка (может бросить на introspection — ловится в `create`).
   *
   * @param params - Сырой конфиг
   * @returns `Result<RiskPolicy, RiskConfigError>`
   */
  private static _validateAndBuild(params: unknown): Result<RiskPolicy, RiskConfigError> {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      return Err(new RiskConfigError('<root>', `RiskParams must be a plain object, got ${describe(params)}`));
    }
    // Только plain object: Object.prototype или null-prototype. Date/экземпляр
    // класса/Object.create(<non-plain>) отклоняем (их поля не доверяем).
    const proto = Object.getPrototypeOf(params);
    if (proto !== Object.prototype && proto !== null) {
      return Err(new RiskConfigError('<root>', 'RiskParams must be a plain object (class instance / non-plain prototype rejected)'));
    }
    const raw = params as Record<string, unknown>;

    // Неизвестные own-ключи отклоняем — независимо от значения (включая undefined).
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_FIELDS.has(key)) {
        return Err(new RiskConfigError(key, `Unknown risk parameter: ${key}`));
      }
    }

    const validated: {
      -readonly [K in keyof RiskParams]: RiskParams[K];
    } = {};

    for (const field of INTEGER_FIELDS) {
      // Только own-свойства: защита от prototype pollution (унаследованный
      // maxOpenOrders на Object.prototype в own-ключах не появится).
      if (!Object.prototype.hasOwnProperty.call(raw, field)) continue;
      const value = raw[field]; // читаем ОДИН раз
      if (value === undefined) continue; // лимит не задан
      const error = RiskPolicy._validateNonNegativeInteger(field, value);
      if (error) return Err(error);
      validated[field] = value as number;
    }

    for (const field of QUANTITY_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(raw, field)) continue;
      const value = raw[field]; // читаем ОДИН раз
      if (value === undefined) continue; // лимит не задан
      const error = RiskPolicy._validateQuantityField(field, value);
      if (error) return Err(error);
      validated[field] = value as Quantity;
    }

    for (const field of MONEY_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(raw, field)) continue;
      const value = raw[field]; // читаем ОДИН раз
      if (value === undefined) continue; // лимит не задан
      const error = RiskPolicy._validateMoneyField(field, value);
      if (error) return Err(error);
      validated[field] = value as Money;
    }

    // Замораживаем НОВЫЙ объект (только whitelisted validated own-поля) — внешние
    // мутации и посторонние ключи в политику не попадают.
    return Ok(new RiskPolicy(Object.freeze(validated)));
  }

  /**
   * Проверяет, что значение (если задано) — number, finite, целое и >= 0.
   *
   * @param field - Имя поля (для ошибки)
   * @param value - Сырое значение (unknown) или undefined
   * @returns `RiskConfigError` при нарушении, иначе `undefined`
   */
  private static _validateNonNegativeInteger(
    field: string,
    value: unknown,
  ): RiskConfigError | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number') {
      return new RiskConfigError(field, `${field} must be a number, got ${describe(value)}`);
    }
    if (!Number.isFinite(value)) {
      return new RiskConfigError(field, `${field} must be a finite number, got ${value}`);
    }
    if (!Number.isInteger(value)) {
      return new RiskConfigError(field, `${field} must be an integer, got ${value}`);
    }
    if (value < 0) {
      return new RiskConfigError(field, `${field} must be >= 0, got ${value}`);
    }
    return undefined;
  }

  /**
   * Проверяет, что значение (если задано) — экземпляр `Quantity`.
   *
   * @param field - Имя поля (для ошибки)
   * @param value - Сырое значение (unknown) или undefined
   * @returns `RiskConfigError` при нарушении, иначе `undefined`
   *
   * @remarks
   * Отдельной проверки на finite/`>= 0` не требуется: `Quantity` core enforces оба
   * инварианта на собственном конструкторе — невалидный экземпляр `Quantity`
   * физически не существует в runtime.
   */
  private static _validateQuantityField(
    field: string,
    value: unknown,
  ): RiskConfigError | undefined {
    if (value === undefined) return undefined;
    if (!(value instanceof Quantity)) {
      return new RiskConfigError(field, `${field} must be a Quantity, got ${describe(value)}`);
    }
    return undefined;
  }

  /**
   * Проверяет, что значение (если задано) — экземпляр `Money` и `>= 0`.
   *
   * @param field - Имя поля (для ошибки)
   * @param value - Сырое значение (unknown) или undefined
   * @returns `RiskConfigError` при нарушении, иначе `undefined`
   *
   * @remarks
   * `instanceof Money` проверяется ПЕРВЫМ: `Money` core не enforces неотрицательность
   * (это осознанно оставлено бизнес-логике вызывающего — см. `Money`'s докблок),
   * поэтому `isNegative()` — отдельная явная проверка лимита, не инвариант типа.
   */
  private static _validateMoneyField(
    field: string,
    value: unknown,
  ): RiskConfigError | undefined {
    if (value === undefined) return undefined;
    if (!(value instanceof Money)) {
      return new RiskConfigError(field, `${field} must be a Money, got ${describe(value)}`);
    }
    if (value.isNegative()) {
      return new RiskConfigError(field, `${field} must be >= 0, got ${value.value().toString()}`);
    }
    return undefined;
  }
}

/**
 * Короткое описание ТИПА значения для сообщений об ошибках.
 *
 * @param value - Любое значение
 * @returns Категория/тип значения (без самого значения — не логируем raw config)
 *
 * @remarks
 * Возвращает только тип (`'number'`, `'string'`, `'object'`, …), а не само
 * значение — чтобы диагностические сообщения не раскрывали содержимое конфига.
 * Диапазонные ошибки (`must be >= 0, got -1`) показывают конкретный числовой
 * лимит отдельно (это не чувствительные данные).
 */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
