import Decimal from 'decimal.js';
import { Money } from '../../money/core/Money';
import type { SupportedCurrency, AccountId, VenueId } from '@polymarket/ids';
import { parseWalletAddress, asVenueId } from '@polymarket/ids';
import { BalanceInvariantViolation } from './BalanceInvariantViolation';
import { BalanceErrorReason } from '../errors/BalanceErrorReason';

/**
 * Helper для безопасного создания ZERO_WALLET_ADDRESS константы
 *
 * @remarks
 * Используем parseWalletAddress для runtime валидации вместо "as" cast.
 * Если валидация не пройдёт - будет выброшено исключение при инициализации модуля.
 */
function initZeroWalletAddress() {
  const addr = parseWalletAddress('0x0000000000000000000000000000000000000000');
  if (!addr) {
    throw new Error('Failed to parse ZERO_WALLET_ADDRESS constant');
  }
  return addr;
}

/**
 * Helper для безопасного создания SYSTEM_VENUE_ID константы
 *
 * @remarks
 * Используем asVenueId для runtime валидации вместо "as" cast.
 * Если валидация не пройдёт - будет выброшено исключение при инициализации модуля.
 */
function initSystemVenueId() {
  const venueId = asVenueId('SYSTEM');
  if (!venueId) {
    throw new Error('Failed to validate SYSTEM_VENUE_ID constant');
  }
  return venueId;
}

/**
 * Константа: нулевой адрес кошелька для системных балансов
 */
const ZERO_WALLET_ADDRESS = initZeroWalletAddress();

/**
 * Константа: системный VenueId для placeholder балансов
 */
const SYSTEM_VENUE_ID = initSystemVenueId();

/**
 * Balance - баланс денежных средств с разделением на available/reserved
 *
 * @remarks
 * Представляет баланс с разделением средств на:
 * - **available** - доступные для использования средства
 * - **reserved** - зарезервированные средства (например, для открытых ордеров)
 *
 * **Инварианты (проверяются в constructor):**
 * 1. available >= 0 (доступные средства не могут быть отрицательными)
 * 2. reserved >= 0 (зарезервированные средства не могут быть отрицательными)
 * 3. available.currency === reserved.currency (одинаковая валюта)
 * 4. available + reserved <= Money.MAX_AMOUNT (защита от overflow в total())
 *
 * **Derived values:**
 * - total = available + reserved (общая сумма средств)
 *
 * **Immutability:**
 * Это immutable value object. Все операции (reserve, unfreezeReserved, consumeReserved, updateAvailable)
 * выполняются через BalanceService и возвращают НОВЫЙ экземпляр Balance.
 *
 * **Архитектура Throws+Facade:**
 * - Core Layer (Balance) - может бросать BalanceInvariantViolation при нарушении инвариантов
 * - Facade Layer (BalanceService) - ловит исключения и возвращает Result
 *
 * Пользователи должны использовать BalanceService для безопасных операций.
 *
 * @example
 * ```typescript
 * import { Balance } from '@polymarket/value-objects/balance';
 * import { Money } from '@polymarket/value-objects/money';
 * import type { AccountId, VenueId, WalletAddress } from '@polymarket/ids';
 *
 * const accountId: AccountId = { kind: 'WALLET', address: '0x...' as WalletAddress };
 * const venueId: VenueId = 'POLYMARKET' as VenueId;
 *
 * // Создание баланса (может throw при нарушении инвариантов)
 * const balance = Balance.of(
 *   Money.of(new Decimal(10000), 'USDC'),  // available
 *   Money.of(new Decimal(2000), 'USDC'),   // reserved
 *   accountId,                             // ID аккаунта владельца
 *   venueId                                // ID площадки
 * );
 *
 * // Query методы (чистые, не могут fail)
 * console.log(balance.total().value());           // 12000
 * console.log(balance.available().value());       // 10000
 * console.log(balance.reserved().value());        // 2000
 * console.log(balance.reservedPercentage());       // 16.67
 *
 * // Helpers
 * const empty = Balance.ZERO.USDC;
 * const withZero = Balance.withZeroReserved(Money.of(new Decimal(10000), 'USDC'), accountId, venueId);
 * ```
 */
export class Balance {
  /**
   * Кэшированное значение total() - вычисляется один раз в конструкторе
   */
  private readonly _total: Money;

  /**
   * Private constructor для защиты инвариантов
   *
   * @param _available - Доступные средства
   * @param _reserved - Зарезервированные средства
   * @param _accountId - ID аккаунта владельца
   * @param _venueId - ID площадки (venue)
   * @throws {BalanceInvariantViolation} Если нарушены инварианты
   */
  private constructor(
    private readonly _available: Money,
    private readonly _reserved: Money,
    private readonly _accountId: AccountId,
    private readonly _venueId: VenueId
  ) {
    // Инвариант 0a: Not NaN
    if (_available.value().isNaN() || _reserved.value().isNaN()) {
      throw new BalanceInvariantViolation(
        'Balance amounts cannot be NaN',
        {
          reason: BalanceErrorReason.NAN,
          available: _available.value().toString(),
          reserved: _reserved.value().toString()
        }
      );
    }

    // Инвариант 0b: Must be finite
    if (!_available.value().isFinite() || !_reserved.value().isFinite()) {
      throw new BalanceInvariantViolation(
        'Balance amounts must be finite',
        {
          reason: BalanceErrorReason.NON_FINITE,
          available: _available.value().toString(),
          reserved: _reserved.value().toString()
        }
      );
    }

    // Инвариант 1: available >= 0
    if (_available.value().isNegative()) {
      throw new BalanceInvariantViolation(
        'Available amount cannot be negative',
        {
          reason: BalanceErrorReason.NEGATIVE_AVAILABLE,
          available: _available.value().toString()
        }
      );
    }

    // Инвариант 2: reserved >= 0
    if (_reserved.value().isNegative()) {
      throw new BalanceInvariantViolation(
        'Reserved amount cannot be negative',
        {
          reason: BalanceErrorReason.NEGATIVE_RESERVED,
          reserved: _reserved.value().toString()
        }
      );
    }

    // Инвариант 3: same currency
    if (_available.currency() !== _reserved.currency()) {
      throw new BalanceInvariantViolation(
        'Available and reserved must have the same currency',
        {
          reason: BalanceErrorReason.CURRENCY_MISMATCH,
          availableCurrency: _available.currency(),
          reservedCurrency: _reserved.currency()
        }
      );
    }

    // Инвариант 4: available + reserved <= Money.MAX_AMOUNT
    const totalAmount = _available.value().plus(_reserved.value());
    if (totalAmount.greaterThan(Money.MAX_AMOUNT)) {
      throw new BalanceInvariantViolation(
        `Total balance (available + reserved) exceeds maximum: ${Money.MAX_AMOUNT}`,
        {
          reason: BalanceErrorReason.TOTAL_EXCEEDS_MAX_AMOUNT,
          available: _available.value().toString(),
          reserved: _reserved.value().toString(),
          total: totalAmount.toString(),
          maxAmount: Money.MAX_AMOUNT.toString()
        }
      );
    }

    // Кэшируем total() - вычисляется один раз в конструкторе
    this._total = Money.of(totalAmount, this._available.currency());
  }

  /**
   * Создаёт Balance из available и reserved Money
   *
   * @param available - Доступные средства
   * @param reserved - Зарезервированные средства
   * @param accountId - ID аккаунта владельца
   * @param venueId - ID площадки (venue)
   * @returns Новый Balance объект
   * @throws {BalanceInvariantViolation} Если нарушены инварианты
   *
   * @remarks
   * Это главный способ создания Balance.
   * Проверяет все инварианты и бросает BalanceInvariantViolation при нарушении.
   *
   * Для безопасного создания с Result используй BalanceService.create().
   *
   * @example
   * ```typescript
   * // Прямое создание (может throw)
   * const balance = Balance.of(
   *   Money.of(new Decimal(10000), 'USDC'),
   *   Money.of(new Decimal(2000), 'USDC'),
   *   accountId,
   *   venueId
   * );
   *
   * // Или через BalanceService (Result-based)
   * const result = BalanceService.create(
   *   Money.of(new Decimal(10000), 'USDC'),
   *   Money.of(new Decimal(2000), 'USDC'),
   *   accountId,
   *   venueId
   * );
   * ```
   */
  public static of(
    available: Money,
    reserved: Money,
    accountId: AccountId,
    venueId: VenueId
  ): Balance {
    return new Balance(available, reserved, accountId, venueId);
  }

  /**
   * Создаёт Balance с нулевым reserved
   *
   * @param available - Доступные средства
   * @param accountId - ID аккаунта владельца
   * @param venueId - ID площадки (venue)
   * @returns Новый Balance с reserved = 0
   * @throws {BalanceInvariantViolation} Если available < 0
   *
   * @remarks
   * Convenience метод для создания баланса без зарезервированных средств.
   *
   * @example
   * ```typescript
   * const balance = Balance.withZeroReserved(Money.of(new Decimal(10000), 'USDC'), accountId, venueId);
   * // available: 10000, reserved: 0
   * ```
   */
  public static withZeroReserved(
    available: Money,
    accountId: AccountId,
    venueId: VenueId
  ): Balance {
    const zeroReserved = Money.ZERO[available.currency()];
    return new Balance(available, zeroReserved, accountId, venueId);
  }

  /**
   * Singleton константы для нулевых балансов
   *
   * @remarks
   * Автоматически создаётся для всех валют из Money.ZERO.
   * При добавлении новой валюты в SUPPORTED_CURRENCIES -
   * singleton создаётся автоматически.
   *
   * **Важно:** Эти балансы используют placeholder значения для accountId и venueId:
   * - accountId: WALLET с нулевым адресом (0x000...000)
   * - venueId: 'SYSTEM'
   *
   * Для создания balance с конкретным accountId/venueId используй Balance.of() или BalanceService.create().
   *
   * **Каждое поле (available, reserved) получает distinct Money instance,**
   * хотя они имеют одинаковое значение (0). Это предотвращает потенциальные проблемы
   * с shared state при использовании в составных операциях.
   *
   * @example
   * ```typescript
   * const balance = Balance.ZERO.USDC;
   * console.log(balance.isZero()); // true
   * console.log(balance.currency()); // 'USDC'
   *
   * // После добавления EUR в SUPPORTED_CURRENCIES:
   * const balanceEur = Balance.ZERO.EUR; // ✅ Автоматически доступен!
   * ```
   */
  public static readonly ZERO: Record<SupportedCurrency, Balance> =
    Object.fromEntries(
      Object.entries(Money.ZERO).map(([currency, money]) => [
        currency,
        new Balance(
          money,
          Money.of(new Decimal(0), currency as SupportedCurrency), // Создаём distinct instance для reserved
          { kind: 'WALLET', address: ZERO_WALLET_ADDRESS } as AccountId,
          SYSTEM_VENUE_ID
        )
      ])
    ) as Record<SupportedCurrency, Balance>;

  /**
   * Возвращает доступные средства
   *
   * @returns Money с available amount
   *
   * @example
   * ```typescript
   * const available = balance.available();
   * console.log(available.value().toNumber()); // 10000
   * ```
   */
  public available(): Money {
    return this._available;
  }

  /**
   * Возвращает зарезервированные средства
   *
   * @returns Money с reserved amount
   *
   * @example
   * ```typescript
   * const reserved = balance.reserved();
   * console.log(reserved.value().toNumber()); // 2000
   * ```
   */
  public reserved(): Money {
    return this._reserved;
  }

  /**
   * Возвращает общую сумму (available + reserved)
   *
   * @returns Money с total суммой
   *
   * @remarks
   * Derived value - кэшируется в конструкторе для производительности.
   *
   * Безопасно потому что:
   * - Валюты гарантированно совпадают (инвариант #3)
   * - Оба значения >= 0 (инварианты #1, #2)
   * - Оба значения finite и not NaN (инварианты #0a, #0b)
   * - Сумма не может превысить Money.MAX_AMOUNT (инвариант #4)
   *
   * @example
   * ```typescript
   * const balance = Balance.of(
   *   Money.of(10000),
   *   Money.of(2000),
   *   accountId,
   *   venueId
   * );
   * console.log(balance.total().value().toNumber()); // 12000
   * ```
   */
  public total(): Money {
    return this._total;
  }

  /**
   * Возвращает валюту баланса
   *
   * @returns Валюта (available и reserved всегда имеют одинаковую валюту)
   *
   * @example
   * ```typescript
   * console.log(balance.currency()); // 'USDC'
   * ```
   */
  public currency(): SupportedCurrency {
    return this._available.currency();
  }

  /**
   * Проверяет, равен ли баланс нулю (total = 0)
   *
   * @returns true если available = 0 AND reserved = 0
   *
   * @remarks
   * Баланс считается нулевым только если ОБА значения равны нулю.
   * Консистентно с Money.isZero(), Price.isZero(), Quantity.isZero().
   *
   * @example
   * ```typescript
   * const zero = Balance.ZERO.USDC;
   * console.log(zero.isZero()); // true
   *
   * const withReserved = Balance.of(Money.ZERO.USDC, Money.of(100, 'USDC'), accountId, venueId);
   * console.log(withReserved.isZero()); // false
   * ```
   */
  public isZero(): boolean {
    return this.total().value().equals(0);
  }

  /**
   * Проверяет, есть ли зарезервированные средства
   *
   * @returns true если reserved > 0
   *
   * @example
   * ```typescript
   * const balance = Balance.of(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000),
   *   accountId,
   *   venueId
   * );
   * console.log(balance.hasReserved()); // true
   * ```
   */
  public hasReserved(): boolean {
    return this._reserved.value().greaterThan(0);
  }

  /**
   * Вычисляет процент зарезервированных средств от total
   *
   * @returns Decimal с процентами (0-100), или 0 если total = 0
   *
   * @remarks
   * Formula: (reserved / total) * 100
   * Если total = 0, возвращает 0 (избегаем деления на ноль).
   *
   * @example
   * ```typescript
   * const balance = Balance.of(
   *   Money.of(8000, 'USDC'),
   *   Money.of(2000, 'USDC'),
   *   accountId,
   *   venueId
   * );
   * console.log(balance.reservedPercentage().toFixed(2)); // "20.00"
   *
   * const empty = Balance.ZERO.USDC;
   * console.log(empty.reservedPercentage().toFixed(2)); // "0.00"
   * ```
   */
  public reservedPercentage(): Decimal {
    const totalAmount = this.total().value();
    if (totalAmount.equals(0)) {
      return new Decimal(0);
    }

    return this._reserved.value().dividedBy(totalAmount).times(100);
  }

  /**
   * Проверяет совпадение валют
   *
   * @param other - Другой баланс для сравнения
   * @returns true если валюты совпадают
   *
   * @remarks
   * Используется в BalanceService для проверки совместимости операций.
   *
   * @example
   * ```typescript
   * const balance1 = Balance.of(Money.of(100), Money.of(50), accountId, venueId);
   * const balance2 = Balance.of(Money.of(200), Money.of(100), accountId, venueId);
   * console.log(balance1.hasSameCurrency(balance2)); // true
   * ```
   */
  public hasSameCurrency(other: Balance): boolean {
    return this.currency() === other.currency();
  }

  /**
   * Возвращает ID аккаунта владельца
   *
   * @returns AccountId
   *
   * @example
   * ```typescript
   * const accountId = balance.accountId();
   * if (accountId.kind === 'WALLET') {
   *   console.log('Wallet address:', accountId.address);
   * }
   * ```
   */
  public accountId(): AccountId {
    return this._accountId;
  }

  /**
   * Возвращает ID площадки (venue)
   *
   * @returns VenueId
   *
   * @example
   * ```typescript
   * const venueId = balance.venueId();
   * console.log('Venue:', venueId); // 'POLYMARKET'
   * ```
   */
  public venueId(): VenueId {
    return this._venueId;
  }
}
