/**
 * Сборка тестового рантайма сверки.
 *
 * @remarks
 * Всё НАСТОЯЩЕЕ, кроме источника: шина `EventBus`, `AccountStateProjector` с
 * critical-подписками, `AccountReconciler`, `AccountReconciliationCoordinator`.
 * Подмена шины или проектора заглушкой доказала бы работу заглушки, а не
 * контракта «reconciler → IEventBus → projector → AccountHotState».
 *
 * Время — только `PaperClock`: и metadata событий, и health координатора
 * читают одни управляемые часы.
 */
import type {
  ApplicationEvent,
  TradingAccountReconciledEvent,
} from '@polymarket/application-events';
import { AccountStateProjector, type AccountHotStateView } from '@polymarket/account-state';
import { EventBus, type IEventBus } from '@polymarket/event-bus';
import type { AccountId } from '@polymarket/ids';
import { MessageMetadataGenerator } from '@polymarket/messages';
import type { Order } from '@polymarket/order';
import type { Portfolio } from '@polymarket/portfolio';
import { PaperClock } from '@polymarket/time';
import {
  AccountReconciler,
  AccountReconciliationCoordinator,
} from '../../src/index.js';
import { FakeAccountReconciliationSource } from './FakeAccountReconciliationSource.js';
import { VENUE, portfolio, silentLogger } from './fixtures.js';

/** Готовый рантайм сверки. */
export interface ReconciliationRuntime {
  readonly bus: IEventBus;
  readonly view: AccountHotStateView;
  readonly clock: PaperClock;
  readonly metadata: MessageMetadataGenerator;
  readonly source: FakeAccountReconciliationSource;
  readonly reconciler: AccountReconciler;
  readonly coordinator: AccountReconciliationCoordinator;
  /** Все `TRADING_ACCOUNT_RECONCILED`, дошедшие до шины, по порядку */
  readonly reconciledEvents: TradingAccountReconciledEvent[];
  /** Публикует живое событие и требует успеха */
  publishLive(event: ApplicationEvent): Promise<void>;
  /** Принимает аккаунт живым `TRADING_ACCOUNT_INITIALIZED` */
  initializeAccount(accountId: AccountId, initial?: Portfolio): Promise<void>;
  /** Коммитит заявку живым `TRADING_ACCOUNT_ORDER_COMMITTED` */
  commitOrder(accountId: AccountId, order: Order, after?: Portfolio): Promise<void>;
}

/**
 * Собирает рантайм.
 *
 * @param options - Предел конфликтов версий координатора
 * @returns Рантайм с пустым приватным состоянием и пустым источником
 */
export function buildRuntime(
  options: { maxConsecutiveVersionConflicts?: number } = {},
): ReconciliationRuntime {
  const clock = new PaperClock(new Date(1_000));
  const bus = new EventBus(silentLogger);
  const projector = AccountStateProjector.create(bus);
  projector.start();
  const metadata = new MessageMetadataGenerator({ clock });
  const source = new FakeAccountReconciliationSource();
  const reconciler = AccountReconciler.create({
    source,
    eventBus: bus,
    accountState: projector.state(),
    metadata,
  });
  const coordinator = AccountReconciliationCoordinator.create({
    reconciler,
    clock,
    ...options,
  });

  // Наблюдатель: НЕ critical и ничего не меняет — только считает, сколько
  // коррекций реально дошло до шины.
  const reconciledEvents: TradingAccountReconciledEvent[] = [];
  bus.subscribe('TRADING_ACCOUNT_RECONCILED', (event) => {
    reconciledEvents.push(event as TradingAccountReconciledEvent);
  });

  const publishLive = async (event: ApplicationEvent): Promise<void> => {
    const published = await bus.publish(event);
    if (!published.ok) throw new Error(`expected Ok for ${event.type}, got ${String(published.error)}`);
  };

  return {
    bus,
    view: projector.state(),
    clock,
    metadata,
    source,
    reconciler,
    coordinator,
    reconciledEvents,
    publishLive,
    initializeAccount: (accountId, initial) =>
      publishLive({
        type: 'TRADING_ACCOUNT_INITIALIZED',
        payload: { venueId: VENUE, accountId, portfolio: initial ?? portfolio({ accountId }) },
        metadata: metadata.nextRoot(),
      }),
    commitOrder: (accountId, order, after) =>
      publishLive({
        type: 'TRADING_ACCOUNT_ORDER_COMMITTED',
        payload: {
          venueId: VENUE,
          accountId,
          order,
          portfolio: after ?? portfolio({ accountId, available: 9_935, reserved: 65 }),
        },
        metadata: metadata.nextRoot(),
      }),
  };
}

/**
 * Версия аккаунта в приватном состоянии.
 *
 * @param view - Проекция
 * @param accountId - Аккаунт
 * @returns Версия; отсутствие аккаунта — дефект теста
 */
export function versionOf(view: AccountHotStateView, accountId: AccountId): number {
  const account = view.getAccount(VENUE, accountId);
  if (account === undefined) throw new Error('fixture failed: account is not initialized');
  return account.version;
}

/**
 * Отдаёт управление, пока не отработают все уже поставленные микротаски.
 *
 * @remarks
 * Нужна, чтобы убедиться, что «ничего не произошло» — что координатор
 * действительно НЕ запустил второй проход, а не просто не успел.
 */
export async function flushMicrotasks(): Promise<void> {
  // `setImmediate` срабатывает только после опустошения очереди микротасок.
  await new Promise<void>((resolve) => setImmediate(resolve));
}
