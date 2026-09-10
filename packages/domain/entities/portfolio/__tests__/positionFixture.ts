/**
 * Настоящий `Position` для тестов Portfolio.
 *
 * @remarks
 * Раньше здесь хватало структурной заглушки: `Portfolio` принимал любой объект,
 * реализующий `IPosition`. Интерфейс удалён — подставлять оказалось нечего, —
 * и заглушки вместе с ним.
 *
 * Это не потеря, а восстановленная честность: тест, собиравший позицию из
 * четырёх полей, проверял `Portfolio` против объекта, которого в проде не
 * существует. Теперь он проверяет его против того самого `Position`, который
 * туда и попадёт.
 */
import {
  AssetIdHelpers,
  accountIdFromWallet,
  asInstrumentId,
  asPositionId,
  parseWalletAddress,
  type AccountId,
  type InstrumentId,
} from '@polymarket/ids';
import { TimestampService, type Timestamp } from '@polymarket/timestamp';
import { OutcomePriceService, QuantityService } from '@polymarket/value-objects';
import { Position, PositionLot, type PositionSide } from '@polymarket/position';

/** Разворачивает `Result` фикстуры: отказ здесь — дефект самого теста. */
function must<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!result.ok) throw new Error(`fixture failed: ${String(result.error)}`);
  return result.value as T;
}

/** Момент времени из миллисекунд. */
export function ts(ms: number): Timestamp {
  return must(TimestampService.create(ms));
}

/** Аккаунт-владелец позиции. */
export function positionAccount(
  address = '0x1234567890abcdef1234567890abcdef12345678',
): AccountId {
  const wallet = parseWalletAddress(address);
  if (wallet === undefined) throw new Error('fixture failed: invalid wallet address');
  return accountIdFromWallet(wallet);
}

/** Параметры позиции, которые тест переопределяет точечно. */
export interface PositionOverrides {
  readonly id?: string;
  readonly accountId?: AccountId;
  readonly side?: PositionSide;
  /** Количество в единственном лоте */
  readonly quantity?: number;
  /** Цена входа этого лота */
  readonly entryPrice?: number;
  readonly openedAtMs?: number;
}

/**
 * Позиция с одним лотом — достаточная форма для тестов Portfolio.
 *
 * @param instrumentId - Инструмент позиции
 * @param overrides - Что отличается от «нормальной» позиции
 * @returns Валидный `Position`
 *
 * @remarks
 * Один лот, а не пустой список: `quantity` и `averageEntryPrice` у `Position`
 * выводятся ИЗ ЛОТОВ, и позиция без лотов имеет нулевое количество — то есть
 * считается закрытой.
 */
export function position(
  instrumentId: InstrumentId | string,
  overrides: PositionOverrides = {},
): Position {
  const resolved =
    typeof instrumentId === 'string' ? asInstrumentId(instrumentId) : instrumentId;
  if (resolved === undefined) throw new Error('fixture failed: invalid instrumentId');

  const openedAt = ts(overrides.openedAtMs ?? 1_700_000_000_000);
  const lot = PositionLot.create({
    quantity: must(QuantityService.create(overrides.quantity ?? 100)),
    entryPrice: must(OutcomePriceService.create(overrides.entryPrice ?? 0.65)),
    timestamp: openedAt,
  });

  return must(
    Position.create({
      id: asPositionId(overrides.id ?? 'position-1') as never,
      accountId: overrides.accountId ?? positionAccount(),
      instrumentId: resolved,
      asset: AssetIdHelpers.USDC,
      side: overrides.side ?? 'LONG',
      openedAt,
      lots: [lot],
    }),
  );
}

/**
 * Закрытая позиция — лотов нет, количество нулевое.
 *
 * @param instrumentId - Инструмент позиции
 * @returns `Position`, для которого `isClosed()` истинно
 */
export function closedPosition(instrumentId: InstrumentId | string): Position {
  const resolved =
    typeof instrumentId === 'string' ? asInstrumentId(instrumentId) : instrumentId;
  if (resolved === undefined) throw new Error('fixture failed: invalid instrumentId');

  return must(
    Position.create({
      id: asPositionId('position-closed') as never,
      accountId: positionAccount(),
      instrumentId: resolved,
      asset: AssetIdHelpers.USDC,
      side: 'LONG',
      openedAt: ts(1_700_000_000_000),
      lots: [],
    }),
  );
}
