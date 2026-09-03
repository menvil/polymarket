/**
 * DEVELOPMENT-ONLY live smoke: разделяемые CEX-подписки на реальной бирже.
 *
 * @remarks
 * Доказывает на публичных endpoints (без credentials), что контроллер
 * действительно материализует спрос владельцев в РАЗДЕЛЯЕМЫЕ физические
 * потоки:
 *
 * ```text
 * owner demands (ownerKey + CexPolicy)
 *        ↓
 * CexSubscriptionController.reconcile(demands, now)
 *        ↓ aggregate pools
 * CexSource (по одному на поток)
 *        ↓ CEX_ORDERBOOK / CEX_TRADE
 * ExternalMessageBus
 * ```
 *
 * Прогон идёт четырьмя фазами и проверяет ровно те инварианты, которые
 * нельзя доказать подделкой источника:
 *
 * ```text
 * 1. baseline   A: BTC стакан+сделки → 2 пула, оба поколения 1, сообщения идут
 * 2. sharing    +B на ТОТ ЖЕ ресурс  → пулов по-прежнему 2, поколения ТЕ ЖЕ
 * 3. expansion  B добавляет ETH      → оба пула заменены, поколение 2, оба символа
 * 4. shrink     A уходит, потом []   → пулы закрыты, physicalPools = 0
 * ```
 *
 * Это НЕ Collector: скрипт ничего не пишет на диск, не запускает ни
 * стратегий, ни семантических адаптеров, работает фиксированное dev-окно
 * и завершается сам.
 *
 * ### Код возврата — часть контракта smoke
 *
 * Прогон завершается НЕнулевым кодом, если:
 *
 * - переменные окружения заданы, но невалидны;
 * - baseline не поднял оба пула либо дал отказ транспорта;
 * - за окно наблюдения не пришло ни одного `CEX_ORDERBOOK` или `CEX_TRADE`;
 * - добавление ВТОРОГО владельца того же ресурса создало новые поколения
 *   (то есть ресурс был продублирован, а не разделён);
 * - расширение набора символов не привело к замене поколений либо новый
 *   пул не наблюдает оба символа;
 * - уход одного из двух владельцев при неизменной спецификации вызвал
 *   замену;
 * - после пустого спроса остались физические пулы;
 * - какой-либо источник ушёл в терминальный отказ.
 *
 * ### Почему число сообщений ЗДЕСЬ является критерием
 *
 * В отличие от Polymarket-смоука, где приобретается ПРЕДСТОЯЩИЙ рынок и
 * тишина законна, у биржи поток непрерывен: `BTC/USDT` на binance spot
 * присылает наблюдения непрерывно. Отсутствие сообщений за 20 секунд
 * означает, что физического потока на самом деле нет.
 *
 * Запуск из корня repo (нужен собранный dist зависимостей — `npm run build`
 * в пакете строит их через project references):
 *
 * ```bash
 * npx tsx packages/infrastructure/cex-subscription-control/scripts/cex-subscription-control-smoke.ts
 *
 * CEX_SMOKE_EXCHANGE=binance \
 * CEX_SMOKE_MARKET_TYPE=spot \
 * CEX_SMOKE_SYMBOL=BTC/USDT \
 * CEX_SMOKE_SECOND_SYMBOL=ETH/USDT \
 * CEX_SMOKE_HOLD_SECONDS=20 \
 *   npx tsx packages/infrastructure/cex-subscription-control/scripts/cex-subscription-control-smoke.ts
 * ```
 */
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { Timestamp } from '@polymarket/timestamp';
import { LiveHighResolutionClock, MessageMetadataGenerator } from '@polymarket/messages';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { parsePolicyConfig } from '@polymarket/policy';
import type { CexPolicy } from '@polymarket/policy';
import { CexSource } from '@polymarket/cex-v2';
import type { CexExternalMessage } from '@polymarket/cex-v2';
import { CexSubscriptionController } from '../src/index.js';
import type {
  CexSubscriptionDemand,
  CexSubscriptionPoolSnapshot,
  CexSubscriptionReconcileResult,
} from '../src/index.js';

/** Владельцы прогона: непрозрачные строки, как их увидит контроллер. */
const OWNER_A = 'smoke:owner-a';
const OWNER_B = 'smoke:owner-b';

/** Биржа по умолчанию. */
const DEFAULT_EXCHANGE = 'binance';
/** Тип рынка по умолчанию. */
const DEFAULT_MARKET_TYPE = 'spot';
/** Основной символ по умолчанию. */
const DEFAULT_SYMBOL = 'BTC/USDT';
/** Символ расширения по умолчанию. */
const DEFAULT_SECOND_SYMBOL = 'ETH/USDT';
/** Глубина стакана прогона. */
const SMOKE_DEPTH = 10;
/** Окно наблюдения одной фазы по умолчанию (секунды). */
const DEFAULT_HOLD_SECONDS = 20;

/** Код возврата провалившегося прогона. */
const EXIT_FAILURE = 1;

/**
 * Ошибка конфигурации прогона: переменная окружения задана неверно.
 *
 * @remarks
 * Отдельный тип нужен, чтобы верхний обработчик отличал «оператор ошибся в
 * аргументе» (печатаем одну понятную строку) от неожиданного сбоя скрипта
 * (печатаем ошибку целиком, со стеком).
 */
class SmokeConfigError extends Error {}

/** Разобранная конфигурация прогона. */
interface SmokeConfig {
  readonly exchangeId: string;
  readonly marketType: string;
  readonly symbol: string;
  readonly secondSymbol: string;
  readonly holdMs: number;
}

/**
 * Разбирает `CEX_SMOKE_HOLD_SECONDS`.
 *
 * @param raw - Сырое значение переменной окружения
 * @returns Окно наблюдения в миллисекундах
 * @throws {SmokeConfigError} Значение задано, но не конечное положительное
 *
 * @remarks
 * `NaN` превратил бы паузу в мгновенную, и smoke «прошёл» бы, не увидев ни
 * одного наблюдения; `Infinity` — повесил бы прогон навсегда.
 */
function parseHoldMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_HOLD_SECONDS * 1000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new SmokeConfigError(
      `CEX_SMOKE_HOLD_SECONDS must be a finite positive number of seconds, got "${raw}"`,
    );
  }
  return parsed * 1000;
}

/**
 * Собирает конфигурацию прогона из окружения.
 *
 * @returns Разобранная конфигурация
 * @throws {SmokeConfigError} Любое заданное значение невалидно
 */
function parseConfig(): SmokeConfig {
  const config: SmokeConfig = {
    exchangeId: process.env['CEX_SMOKE_EXCHANGE'] ?? DEFAULT_EXCHANGE,
    marketType: process.env['CEX_SMOKE_MARKET_TYPE'] ?? DEFAULT_MARKET_TYPE,
    symbol: process.env['CEX_SMOKE_SYMBOL'] ?? DEFAULT_SYMBOL,
    secondSymbol: process.env['CEX_SMOKE_SECOND_SYMBOL'] ?? DEFAULT_SECOND_SYMBOL,
    holdMs: parseHoldMs(process.env['CEX_SMOKE_HOLD_SECONDS']),
  };
  if (config.symbol === config.secondSymbol) {
    throw new SmokeConfigError(
      'CEX_SMOKE_SYMBOL and CEX_SMOKE_SECOND_SYMBOL must differ: the expansion phase needs a second symbol',
    );
  }
  return config;
}

/**
 * Собирает CEX-policy прогона ЧЕРЕЗ plain-конфигурацию.
 *
 * @param config - Конфигурация прогона
 * @param symbols - Символы этой фазы
 * @param streams - Какие потоки нужны владельцу
 * @returns Canonical `CexPolicy`
 * @throws {SmokeConfigError} Если конфигурация не даёт policy
 *
 * @remarks
 * Именно `parsePolicyConfig`, а не ручная сборка canonical-типа: smoke
 * заодно подтверждает путь «plain config → canonical Policy», которым
 * пойдёт живая конфигурация.
 */
function buildPolicy(
  config: SmokeConfig,
  symbols: readonly string[],
  streams: { orderbook: boolean; trades: boolean },
): CexPolicy {
  try {
    return parsePolicyConfig({
      kind: 'CEX',
      exchangeIds: [config.exchangeId],
      marketTypes: [config.marketType],
      symbols: [...symbols],
      orderbook: streams.orderbook,
      trades: streams.trades,
      orderbookDepth: SMOKE_DEPTH,
    });
  } catch (error) {
    throw new SmokeConfigError(
      `smoke policy is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Пауза наблюдения фазы. */
async function hold(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Компактная строка снимка пула. */
function formatPool(pool: CexSubscriptionPoolSnapshot): string {
  return (
    `  ${pool.poolKey} gen=${String(pool.generation)}` +
    ` symbols=[${pool.symbols.join(', ')}]` +
    (pool.orderbookDepth === undefined ? '' : ` depth=${String(pool.orderbookDepth)}`) +
    ` owners=[${pool.ownerKeys.join(', ')}]` +
    ` running=${String(pool.running)} failed=${String(pool.failed)}`
  );
}

/** Компактный отчёт одной фазы. */
function formatPhase(title: string, result: CexSubscriptionReconcileResult): string[] {
  return [
    '',
    `${title}:`,
    `  demands: active=${String(result.activeDemands)} inactive=${String(result.inactiveDemands)}`,
    `  desired pools: ${String(result.desiredPools)}`,
    `  unchanged=[${result.unchangedPools.join(', ')}]`,
    `  opened=[${result.openedPools.join(', ')}]`,
    `  replaced=[${result.replacedPools.join(', ')}]`,
    `  closed=[${result.closedPools.join(', ')}]`,
    `  failures: ${
      result.failures.length === 0
        ? 'none'
        : result.failures.map((item) => `${item.poolKey}/${item.stage}: ${item.reason}`).join('; ')
    }`,
  ];
}

/**
 * Записывает терминально отказавшие пулы в провалы прогона.
 *
 * @param phase - Фаза, после которой сделана проверка
 * @param pools - Снимок пулов контроллера
 * @param failures - Накопитель провалов прогона
 *
 * @remarks
 * Проверка нужна ОТДЕЛЬНО от `result.failures`: тот отчёт описывает
 * переходы САМОГО прохода, а источник может уйти в терминальный отказ уже
 * ПОСЛЕ успешного перехода — например, за время окна наблюдения. Такой
 * пул остаётся желаемым и внешне выглядит как поднятый, поэтому без этой
 * проверки smoke завершился бы нулевым кодом при мёртвом потоке.
 *
 * Вызывать до СЛЕДУЮЩЕГО reconcile: он заменит отказавшее поколение, и
 * причина провала перестанет быть видна (останется только неожиданный
 * bump номера поколения).
 */
function recordFailedPools(
  phase: string,
  pools: readonly CexSubscriptionPoolSnapshot[],
  failures: string[],
): void {
  for (const pool of pools) {
    if (pool.failed) failures.push(`${phase}: pool ${pool.poolKey} is in terminal failure`);
  }
}

/** Номера поколений по ключу пула. */
function generations(pools: readonly CexSubscriptionPoolSnapshot[]): Map<string, number> {
  return new Map(pools.map((pool) => [pool.poolKey, pool.generation]));
}

async function main(): Promise<void> {
  const config = parseConfig();
  const clock = new LiveClock();
  const logger = new ConsoleLogger(clock, LogLevel.WARN).child({ component: 'cex-smoke' });
  const bus = new ExternalMessageBus<CexExternalMessage>();
  const metadataGenerator = new MessageMetadataGenerator({
    clock,
    highResolutionClock: new LiveHighResolutionClock(),
  });

  const counts = new Map<string, number>();
  const symbolsSeen = new Set<string>();
  // Оба типа наблюдений считаем и запоминаем символы: именно по ним smoke
  // отличает «поток есть» от «контроллер отчитался, а данных нет».
  const observe = (message: CexExternalMessage): void => {
    counts.set(message.type, (counts.get(message.type) ?? 0) + 1);
    symbolsSeen.add(message.payload.symbol);
  };
  bus.subscribe('CEX_ORDERBOOK', observe);
  bus.subscribe('CEX_TRADE', observe);

  // Production-композиция фабрики: контроллер про шину и metadata не знает.
  const controller = new CexSubscriptionController({
    sourceFactory: (sourceConfig) =>
      new CexSource({ config: sourceConfig, bus, metadataGenerator, logger }),
    logger,
  });

  const lines: string[] = [
    'CEX subscription control smoke',
    `  exchange=${config.exchangeId} marketType=${config.marketType}`,
    `  symbols=${config.symbol} (+${config.secondSymbol} on expansion)`,
    `  hold=${String(config.holdMs / 1000)}s per phase`,
  ];
  const failures: string[] = [];

  try {
    // ─── Фаза 1: baseline ────────────────────────────────────────────────
    const baselinePolicy = buildPolicy(config, [config.symbol], {
      orderbook: true,
      trades: true,
    });
    const baseline = await controller.reconcile(
      [{ ownerKey: OWNER_A, policy: baselinePolicy }],
      Timestamp.now(clock),
    );
    lines.push(...formatPhase('phase 1 — baseline (owner A)', baseline));
    lines.push(...controller.listPools().map(formatPool));

    if (baseline.openedPools.length !== 2) {
      failures.push(`baseline expected 2 opened pools, got ${String(baseline.openedPools.length)}`);
    }
    if (baseline.failures.length > 0) {
      failures.push('baseline reported transport failures');
    }
    const baselineGenerations = generations(controller.listPools());

    lines.push('', `observing for ${String(config.holdMs / 1000)}s ...`);
    await hold(config.holdMs);

    const orderbookCount = counts.get('CEX_ORDERBOOK') ?? 0;
    const tradeCount = counts.get('CEX_TRADE') ?? 0;
    lines.push(
      '',
      'external messages observed:',
      `  CEX_ORDERBOOK: ${String(orderbookCount)}`,
      `  CEX_TRADE: ${String(tradeCount)}`,
    );
    if (orderbookCount === 0) failures.push('no CEX_ORDERBOOK observed during baseline');
    if (tradeCount === 0) failures.push('no CEX_TRADE observed during baseline');
    recordFailedPools('baseline', controller.listPools(), failures);

    // ─── Фаза 2: sharing ─────────────────────────────────────────────────
    const sharingDemands: CexSubscriptionDemand[] = [
      { ownerKey: OWNER_A, policy: baselinePolicy },
      { ownerKey: OWNER_B, policy: baselinePolicy },
    ];
    const sharing = await controller.reconcile(sharingDemands, Timestamp.now(clock));
    lines.push(...formatPhase('phase 2 — sharing (owner B joins the same resource)', sharing));
    lines.push(...controller.listPools().map(formatPool));

    if (sharing.openedPools.length > 0 || sharing.replacedPools.length > 0) {
      failures.push('sharing phase created new physical generations instead of sharing');
    }
    if (controller.getStats().physicalPools !== 2) {
      failures.push('sharing phase changed the number of physical pools');
    }
    if (controller.getStats().logicalClaims !== 4) {
      failures.push('sharing phase did not double the logical claims');
    }
    for (const [key, generation] of generations(controller.listPools())) {
      if (baselineGenerations.get(key) !== generation) {
        failures.push(`sharing phase bumped generation of ${key}`);
      }
    }
    recordFailedPools('sharing', controller.listPools(), failures);

    // ─── Фаза 3: expansion ───────────────────────────────────────────────
    const expandedPolicy = buildPolicy(config, [config.symbol, config.secondSymbol], {
      orderbook: true,
      trades: true,
    });
    const expansion = await controller.reconcile(
      [
        { ownerKey: OWNER_A, policy: baselinePolicy },
        { ownerKey: OWNER_B, policy: expandedPolicy },
      ],
      Timestamp.now(clock),
    );
    lines.push(...formatPhase('phase 3 — expansion (owner B adds a second symbol)', expansion));
    lines.push(...controller.listPools().map(formatPool));

    if (expansion.replacedPools.length !== 2) {
      failures.push(
        `expansion expected 2 replaced pools, got ${String(expansion.replacedPools.length)}`,
      );
    }
    for (const pool of controller.listPools()) {
      if (pool.symbols.length !== 2) failures.push(`${pool.poolKey} does not watch both symbols`);
      if (pool.generation !== 2) failures.push(`${pool.poolKey} generation is not 2`);
    }

    symbolsSeen.clear();
    lines.push('', `observing both symbols for ${String(config.holdMs / 1000)}s ...`);
    await hold(config.holdMs);
    lines.push('', `symbols observed after expansion: [${[...symbolsSeen].sort().join(', ')}]`);
    for (const symbol of [config.symbol, config.secondSymbol]) {
      if (!symbolsSeen.has(symbol)) failures.push(`no observations for ${symbol} after expansion`);
    }
    recordFailedPools('expansion', controller.listPools(), failures);

    // ─── Фаза 4: shrink и полное снятие спроса ───────────────────────────
    const shrink = await controller.reconcile(
      [{ ownerKey: OWNER_B, policy: expandedPolicy }],
      Timestamp.now(clock),
    );
    lines.push(...formatPhase('phase 4a — shrink (owner A leaves, spec unchanged)', shrink));
    if (shrink.replacedPools.length > 0 || shrink.closedPools.length > 0) {
      failures.push('owner A leaving changed physical pools despite an unchanged spec');
    }
    if (controller.listPools().some((pool) => pool.ownerKeys.includes(OWNER_A))) {
      failures.push('owner A still holds claims after leaving');
    }
    recordFailedPools('shrink', controller.listPools(), failures);

    const drained = await controller.reconcile([], Timestamp.now(clock));
    lines.push(...formatPhase('phase 4b — empty demands', drained));
    if (drained.closedPools.length !== 2) {
      failures.push(`empty demands expected 2 closed pools, got ${String(drained.closedPools.length)}`);
    }
    const finalStats = controller.getStats();
    lines.push(
      '',
      'final stats:',
      `  desiredPools=${String(finalStats.desiredPools)} physicalPools=${String(finalStats.physicalPools)}`,
      `  logicalClaims=${String(finalStats.logicalClaims)} owners=${String(finalStats.owners)}`,
    );
    if (finalStats.physicalPools !== 0) failures.push('physical pools remain after empty demands');
    if (finalStats.logicalClaims !== 0) failures.push('logical claims remain after empty demands');
  } finally {
    // Контроллер сам закрывает ВСЕ созданные им источники; шина — не его,
    // её закрывает composition root (здесь — скрипт).
    await controller.close();
    const busClosed = await bus.close();
    lines.push('', `closed: controller pools, bus (drain ok: ${String(busClosed.ok)})`);
    // eslint-disable-next-line no-console -- отчёт smoke-скрипта, а не логи сервиса
    console.log(lines.join('\n'));
  }

  if (failures.length > 0) {
    console.error(
      `\nCEX subscription control smoke failed (${String(failures.length)} check(s)):\n` +
        failures.map((failure) => `  - ${failure}`).join('\n'),
    );
    process.exitCode = EXIT_FAILURE;
  }
}

main().catch((error: unknown) => {
  // Ошибка конфигурации — вина вызова, а не скрипта: стек ничего не добавит.
  if (error instanceof SmokeConfigError) {
    console.error(`CEX subscription control smoke failed: ${error.message}`);
  } else {
    console.error('CEX subscription control smoke failed:', error);
  }
  process.exitCode = EXIT_FAILURE;
});
