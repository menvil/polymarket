/**
 * Интеграция контроллера с НАСТОЯЩИМ `CexSource` поверх управляемого
 * fake-инстанса CCXT.
 *
 * @remarks
 * Здесь проверяется ровно та гарантия, на которой держится запрет
 * перекрытия поколений:
 *
 * ```text
 * await source.close()
 *   ⇒ старое поколение больше НИКОГДА не инициирует publish
 *   ⇒ новое поколение может стартовать
 * ```
 *
 * Формулировка «vendor-сокет физически уничтожен до старта нового
 * поколения» была бы СИЛЬНЕЕ нужного и вредна: зависший
 * `instance.close()` тогда останавливал бы реконсиляцию навсегда — и,
 * из-за сериализации проходов, вместе с ней все остальные биржи. Дубли
 * в шине порождает публикующий цикл, а не живой сокет; «живой, но
 * немой» сокет наблюдений не создаёт.
 *
 * Fake CCXT намеренно минимальный: один мультиплексный поток сделок и
 * управляемое закрытие. Полноценный harness vendor-границы живёт в
 * `@polymarket/cex-v2` и дублировать его здесь незачем — предмет теста
 * не транспорт, а порядок смены поколений.
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

/** Ждёт условия с ограничением по времени. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error('Timed out waiting for condition');
}

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

  private _resolveWatch: ((trades: readonly CcxtRawTrade[]) => void) | null = null;

  public readonly watchTradesForSymbols = (
    _symbols: string[],
  ): Promise<readonly CcxtRawTrade[]> => {
    this.watchCalls += 1;
    // Поток «живой»: наблюдений нет, промис висит до закрытия инстанса или
    // до `emitTrade()` — ровно так ведёт себя ccxt.pro между сделками.
    return new Promise<readonly CcxtRawTrade[]>((resolve, reject) => {
      this._resolveWatch = resolve;
      this._rejectWatch = reject;
    });
  };

  /**
   * Заставляет vendor-сокет выдать наблюдение.
   *
   * @returns `true`, если у сокета был ожидающий watch
   *
   * @remarks
   * Ключевой инструмент теста: после `close()` сокет формально жив, и
   * вопрос ровно в том, дойдёт ли его наблюдение до шины. Возвращаемое
   * значение описывает сам сокет, а не факт публикации — проверять нужно
   * именно шину.
   */
  public emitTrade(): boolean {
    if (this._resolveWatch === null) return false;
    this._resolveWatch([
      { id: 't1', symbol: 'BTC/USDT', timestamp: 1_756_000_000_000, price: 1, amount: 1 },
    ] as unknown as readonly CcxtRawTrade[]);
    this._resolveWatch = null;
    return true;
  }

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
  interface Harness {
    readonly controller: CexSubscriptionController;
    readonly instances: FakeCcxtInstance[];
    readonly published: CexExternalMessage[];
  }

  function makeHarness(): Harness {
    const instances: FakeCcxtInstance[] = [];
    const published: CexExternalMessage[] = [];
    const logger = new CapturingLogger();
    const metadataGenerator = new MessageMetadataGenerator({ clock: new LiveClock() });
    const bus = {
      publish: (message: CexExternalMessage): Promise<Result<void, MessageBusPublishError>> => {
        published.push(message);
        return Promise.resolve(Ok(undefined));
      },
    };

    const sourceFactory: CexSubscriptionSourceFactory = (config) =>
      new CexSource({
        // Session-таймаут заведомо мал: он ОБЯЗАН истечь в этих тестах,
        // потому что vendor-закрытие в них не завершается никогда.
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

    return {
      controller: new CexSubscriptionController({ sourceFactory, logger }),
      instances,
      published,
    };
  }

  it('зависший vendor-close не мешает поколению 2 стартовать, а поколение 1 больше не публикует', async () => {
    const { controller, instances, published } = makeHarness();

    try {
      await controller.reconcile(
        [{ ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT'] }) }],
        ts(AT_1800_MS),
      );
      await sleep(20);
      expect(instances).toHaveLength(1);
      expect(instances[0]?.watchCalls).toBeGreaterThan(0);

      // Vendor-закрытие поколения 1 зависает НАВСЕГДА.
      instances[0]!.holdClose();

      const result = await controller.reconcile(
        [{ ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT', 'ETH/USDT'] }) }],
        ts(AT_1800_MS),
      );

      // Поколение 2 обязано подняться: право публиковать снимает abort
      // сессии, а не закрытие сокета.
      expect(result.replacedPools).toEqual(['binance|swap|TRADES']);
      expect(instances).toHaveLength(2);
      expect(controller.listPools()[0]).toMatchObject({ generation: 2, satisfied: true });
      await waitUntil(() => (instances[1]?.watchCalls ?? 0) > 0);

      // Сокет поколения 1 формально жив (его close() так и не завершился) —
      // заставляем его выдать наблюдение.
      published.length = 0;
      const watchCallsBefore = instances[0]!.watchCalls;
      instances[0]!.emitTrade();
      await sleep(50);

      // Наблюдение никуда не уходит: петля сессии поколения 1 завершена,
      // подписываться заново оно тоже не пытается.
      expect(published).toHaveLength(0);
      expect(instances[0]!.watchCalls).toBe(watchCallsBefore);

      // Поколение 2 при этом публикует нормально.
      expect(instances[1]!.emitTrade()).toBe(true);
      await waitUntil(() => published.length > 0);
      expect(published[0]?.type).toBe('CEX_TRADE');
    } finally {
      await controller.close();
    }
  });

  it('зависший vendor-close не останавливает последующие проходы', async () => {
    const { controller, instances } = makeHarness();

    try {
      await controller.reconcile(
        [{ ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT'] }) }],
        ts(AT_1800_MS),
      );
      await sleep(20);
      instances[0]!.holdClose();

      // Проход, вызывающий замену, и ДВА следующих за ним: сериализация
      // не должна превратить одну залипшую биржу в глобальный стоп
      // control-plane.
      await controller.reconcile(
        [{ ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT', 'ETH/USDT'] }) }],
        ts(AT_1800_MS),
      );
      const steady = await controller.reconcile(
        [{ ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT', 'ETH/USDT'] }) }],
        ts(AT_1800_MS),
      );
      const other = await controller.reconcile(
        [
          { ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT', 'ETH/USDT'] }) },
          { ownerKey: 'B', policy: policy({ exchangeIds: ['kraken'], symbols: ['BTC/USDT'] }) },
        ],
        ts(AT_1800_MS),
      );

      expect(steady.unchangedPools).toEqual(['binance|swap|TRADES']);
      // Другая биржа поднимается несмотря на залипший teardown первой.
      expect(other.openedPools).toEqual(['kraken|swap|TRADES']);
      expect(controller.getStats().physicalPools).toBe(2);
    } finally {
      await controller.close();
    }
  });

  it('controller.close() завершается при зависшем vendor-close', async () => {
    const { controller, instances } = makeHarness();

    await controller.reconcile(
      [{ ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT'] }) }],
      ts(AT_1800_MS),
    );
    await sleep(20);
    instances[0]!.holdClose();

    await controller.close();

    expect(controller.getStats().physicalPools).toBe(0);
    expect(controller.isClosed).toBe(true);
  });
});
