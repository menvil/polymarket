/**
 * Интеграция контроллера с НАСТОЯЩИМ `CexSource` поверх управляемого
 * fake-инстанса CCXT.
 *
 * @remarks
 * Юнит-тесты доказывают половины по отдельности: `CexSource.close()`
 * дожидается подтверждённого teardown, а контроллер дожидается
 * `close()`. Этот тест проверяет их СТЫК — то самое место, где инвариант
 * и был декларативным:
 *
 * ```text
 * старое поколение: instance.close() ещё выполняется
 * session-таймаут:  ИСТЁК
 *   ⇒ новое поколение той же routing identity НЕ создано и НЕ запущено
 * ```
 *
 * Fake CCXT намеренно минимальный: один мультиплексный поток сделок и
 * управляемое закрытие. Полноценный harness vendor-границы живёт в
 * `@polymarket/cex-v2` и дублировать его здесь незачем — предмет теста
 * не транспорт, а порядок владения поколением.
 */
import { describe, it, expect } from '@jest/globals';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { LiveClock } from '@polymarket/time';
import { Ok } from '@polymarket/result';
import type { Result } from '@polymarket/result';
import type { MessageBusPublishError } from '@polymarket/message-bus';
import { CexSource } from '@polymarket/cex-v2';
import type {
  CcxtProExchangeInstance,
  CcxtRawTrade,
  CexExternalMessage,
} from '@polymarket/cex-v2';
import { CexSubscriptionController } from '../src/index.js';
import type { CexSubscriptionSourceFactory } from '../src/index.js';
import { AT_1800_MS, CapturingLogger, policy, ts } from './helpers/fakes.js';

/** Пауза теста. */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Минимальный управляемый инстанс CCXT: мультиплексный поток сделок и
 * закрытие, завершение которого держит тест.
 */
class FakeCcxtInstance implements CcxtProExchangeInstance {
  public readonly has = { watchTradesForSymbols: true };
  public closeCalls = 0;
  public watchCalls = 0;

  private _closeGate: Promise<void> | null = null;
  private _rejectWatch: ((error: unknown) => void) | null = null;

  public readonly watchTradesForSymbols = (
    _symbols: string[],
  ): Promise<readonly CcxtRawTrade[]> => {
    this.watchCalls += 1;
    // Поток «живой»: наблюдений нет, промис висит до закрытия инстанса —
    // ровно так ведёт себя ccxt.pro между сделками.
    return new Promise<readonly CcxtRawTrade[]>((_resolve, reject) => {
      this._rejectWatch = reject;
    });
  };

  public readonly close = (): Promise<unknown> => {
    this.closeCalls += 1;
    // Pending watch отклоняется СРАЗУ, как в ccxt.pro: иначе сессия не
    // вышла бы из цикла и тест проверял бы зависший abort, а не teardown.
    this._rejectWatch?.(new Error('Exchange instance closed'));
    this._rejectWatch = null;
    return this._closeGate ?? Promise.resolve();
  };

  /** Задерживает ЗАВЕРШЕНИЕ close() до вызова возвращённой функции. */
  public holdClose(): () => void {
    let resolve: () => void = () => undefined;
    this._closeGate = new Promise<void>((res) => {
      resolve = res;
    });
    return resolve;
  }
}

describe('контроллер поверх настоящего CexSource', () => {
  it('поколение 2 не стартует, пока instance.close() поколения 1 не завершён — даже после closeTimeoutMs', async () => {
    const instances: FakeCcxtInstance[] = [];
    const logger = new CapturingLogger();
    const metadataGenerator = new MessageMetadataGenerator({ clock: new LiveClock() });
    const bus = {
      publish: (_message: CexExternalMessage): Promise<Result<void, MessageBusPublishError>> =>
        Promise.resolve(Ok(undefined)),
    };

    const sourceFactory: CexSubscriptionSourceFactory = (config) =>
      new CexSource({
        // Session-таймаут заведомо мал: он ОБЯЗАН истечь в этом тесте,
        // чтобы доказать, что границей жизненного цикла он не является.
        config: { ...config, closeTimeoutMs: 20, initialBackoffMs: 5, maxBackoffMs: 10 },
        bus,
        metadataGenerator,
        logger,
        exchangeFactory: () => {
          const instance = new FakeCcxtInstance();
          instances.push(instance);
          return instance;
        },
      });

    const controller = new CexSubscriptionController({ sourceFactory, logger });

    try {
      await controller.reconcile(
        [{ ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT'] }) }],
        ts(AT_1800_MS),
      );
      // Поколение 1 подняло ровно один инстанс и наблюдает поток.
      await sleep(20);
      expect(instances).toHaveLength(1);
      expect(instances[0]?.watchCalls).toBeGreaterThan(0);

      const release = instances[0]!.holdClose();

      let replaced = false;
      const pending = controller
        .reconcile(
          [{ ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT', 'ETH/USDT'] }) }],
          ts(AT_1800_MS),
        )
        .then((result) => {
          replaced = true;
          return result;
        });

      // Заведомо дольше closeTimeoutMs: session cleanup давно перестал
      // ЖДАТЬ, но teardown транспорта поколения 1 ещё идёт.
      await sleep(120);

      expect(instances[0]?.closeCalls).toBe(1);
      expect(instances).toHaveLength(1); // второго инстанса нет вовсе
      expect(replaced).toBe(false);
      expect(controller.listPools()[0]).toMatchObject({ generation: 1, satisfied: true });

      release();
      const result = await pending;

      expect(result.replacedPools).toEqual(['binance|swap|TRADES']);
      expect(instances).toHaveLength(2);
      expect(controller.listPools()[0]).toMatchObject({ generation: 2, satisfied: true });
    } finally {
      await controller.close();
    }
  });
});
