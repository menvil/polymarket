/**
 * DEVELOPMENT-ONLY live smoke: полная цепочка control-plane на ТЕКУЩЕМ V2.
 *
 * @remarks
 * Доказывает на публичных endpoints Polymarket (без credentials), что новая
 * цепочка действительно открывает ФИЗИЧЕСКУЮ подписку:
 *
 * ```text
 * createPublicClient()
 *        ↓
 * PolymarketMarketDiscovery ──refresh()──► MarketUniverse
 *        ↓                                      ↓
 *        │                        PolymarketSubscriptionPlanner ◄── Policy
 *        │                                      ↓
 *        └──prepareMarket()──► PolymarketSubscriptionController
 *                                               ↓
 *                              PolymarketSource → ExternalMessageBus
 * ```
 *
 * Это НЕ Collector: скрипт ничего не пишет на диск, не запускает ни
 * стратегий, ни финализации, работает фиксированное dev-окно и завершается
 * сам. V1-путь не используется вовсе.
 *
 * ### Код возврата — часть контракта smoke
 *
 * Прогон завершается НЕнулевым кодом, если:
 *
 * - переменные окружения заданы, но невалидны;
 * - ни один проход не дал пригодного universe;
 * - policy не дала НИ ОДНОГО кандидата;
 * - ни один кандидат не дал `opened`/`joined`/`already-held`;
 * - после успешного приобретения у контроллера ноль рынков (ни активных, ни
 *   открывающихся) — то есть физического ресурса на самом деле не появилось;
 * - источник перешёл в терминальный отказ.
 *
 * ### Почему число сообщений НЕ является критерием
 *
 * Предмет smoke — control plane и физическое открытие подписки, а не
 * трафик. Приобретается ПРЕДСТОЯЩИЙ рынок (иначе контроллер откажет), и в
 * короткое dev-окно до старта торгов он законно может не прислать ни одного
 * события своей книги. Требовать сообщений значило бы получить smoke,
 * который краснеет от нормального поведения площадки, — то есть перестаёт
 * что-либо значить. Счётчики печатаются как диагностика.
 *
 * Запуск из корня repo (нужен собранный dist зависимостей — `npm run build`
 * в пакете строит их через project references):
 *
 * ```bash
 * npx tsx packages/infrastructure/polymarket-control-runtime/scripts/control-runtime-smoke.ts
 *
 * POLYMARKET_SMOKE_ASSET=xrp \
 * POLYMARKET_SMOKE_DURATION=15m \
 * POLYMARKET_SMOKE_ACQUIRE_LIMIT=2 \
 * DISCOVERY_WINDOW_HOURS=2 \
 *   npx tsx packages/infrastructure/polymarket-control-runtime/scripts/control-runtime-smoke.ts
 * ```
 */
import { createPublicClient } from '@polymarket/client';
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { LiveHighResolutionClock, MessageMetadataGenerator } from '@polymarket/messages';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { MarketUniverse } from '@polymarket/market-discovery';
import { parsePolicyConfig } from '@polymarket/policy';
import type { PolymarketPolicy } from '@polymarket/policy';
import { PolymarketSubscriptionPlanner } from '@polymarket/subscription-planning';
import { PolymarketMarketDiscovery, PolymarketSource } from '@polymarket/polymarket-v2';
import type { PolymarketExternalMessage } from '@polymarket/polymarket-v2';
import { PolymarketSubscriptionController } from '@polymarket/polymarket-subscription-control';
import { PolymarketControlRuntime } from '../src/index.js';
import type { PolymarketControlRuntimeResult } from '../src/index.js';

/** Владелец прогона: непрозрачная строка, как её увидит контроллер. */
const SMOKE_OWNER_KEY = 'smoke:control-runtime';

/** Окно обзора `endDate` в часах по умолчанию. */
const DEFAULT_WINDOW_HOURS = 1;
/** Базовый криптоактив по умолчанию. */
const DEFAULT_ASSET = 'btc';
/** Номинал серии по умолчанию. */
const DEFAULT_DURATION = '5m';
/** Лимит приобретения по умолчанию. */
const DEFAULT_ACQUIRE_LIMIT = 1;

/** Сколько держать физическую подписку живой (dev-окно наблюдения). */
const HOLD_MS = 20_000;

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
  readonly asset: string;
  readonly duration: string;
  readonly acquireLimit: number;
  readonly windowHours: number;
}

/**
 * Разбирает `DISCOVERY_WINDOW_HOURS`.
 *
 * @param raw - Сырое значение переменной окружения
 * @returns Окно обзора в часах: конечное число строго больше нуля
 * @throws {SmokeConfigError} Значение задано, но не конечное положительное
 *
 * @remarks
 * Значение уходит в `endDateWindowMs`, который discovery НЕ проверяет:
 * `NaN` сделал бы cutoff невалидным и universe молча пустым, `Infinity` —
 * снял бы ограничение окна вовсе. Оба исхода выглядят как «smoke прошёл».
 */
function parseWindowHours(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WINDOW_HOURS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new SmokeConfigError(
      `DISCOVERY_WINDOW_HOURS must be a finite positive number of hours, got "${raw}"`,
    );
  }
  return parsed;
}

/**
 * Разбирает `POLYMARKET_SMOKE_ACQUIRE_LIMIT`.
 *
 * @param raw - Сырое значение переменной окружения
 * @returns Целый лимит `>= 1`
 * @throws {SmokeConfigError} Значение задано, но не целое `>= 1`
 *
 * @remarks
 * Правило то же, что у самого рантайма. Проверка здесь нужна ради
 * СООБЩЕНИЯ: `ValidationError` из недр прохода не подскажет оператору, что
 * он ошибся именно в переменной окружения.
 */
function parseAcquireLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_ACQUIRE_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new SmokeConfigError(
      `POLYMARKET_SMOKE_ACQUIRE_LIMIT must be an integer >= 1, got "${raw}"`,
    );
  }
  return parsed;
}

/**
 * Собирает конфигурацию прогона из окружения.
 *
 * @returns Разобранная конфигурация
 * @throws {SmokeConfigError} Любое заданное значение невалидно
 */
function parseConfig(): SmokeConfig {
  return {
    asset: process.env['POLYMARKET_SMOKE_ASSET'] ?? DEFAULT_ASSET,
    duration: process.env['POLYMARKET_SMOKE_DURATION'] ?? DEFAULT_DURATION,
    acquireLimit: parseAcquireLimit(process.env['POLYMARKET_SMOKE_ACQUIRE_LIMIT']),
    windowHours: parseWindowHours(process.env['DISCOVERY_WINDOW_HOURS']),
  };
}

/**
 * Собирает policy прогона ЧЕРЕЗ plain-конфигурацию.
 *
 * @param config - Конфигурация прогона
 * @returns Canonical `PolymarketPolicy`
 * @throws {SmokeConfigError} Если конфигурация не даёт policy площадки
 *
 * @remarks
 * Именно `parsePolicyConfig`, а не ручная сборка canonical-типов: smoke
 * заодно подтверждает путь «plain config → canonical Policy», которым
 * пойдёт живая конфигурация. Ручной `unsafeCryptoAssetId()` здесь означал
 * бы, что прогон проверяет не ту дверь, которой пользуется прод.
 */
function buildPolicy(config: SmokeConfig): PolymarketPolicy {
  const policy = parsePolicyConfig({
    kind: 'POLYMARKET',
    family: 'CRYPTO_UP_DOWN',
    assets: [config.asset],
    durations: [config.duration],
  });
  if (policy.kind !== 'POLYMARKET') {
    throw new SmokeConfigError('Smoke policy config must produce a Polymarket policy');
  }
  return policy;
}

/** `HH:MM:SS` в UTC — компактная разметка момента в отчёте. */
function hhmmss(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(11, 19);
}

/**
 * Разворачивает отчёт прохода в строки отчёта.
 *
 * @param label - Имя прохода
 * @param result - Отчёт рантайма
 * @returns Строки для печати
 */
function formatTick(label: string, result: PolymarketControlRuntimeResult): readonly string[] {
  const lines: string[] = [
    '',
    `── ${label} ──`,
    `ranAt: ${result.ranAt.toISO()}`,
    `discoveryRefreshed: ${String(result.discoveryRefreshed)}`,
    `universeEntries: ${String(result.universeEntries)}`,
  ];
  for (const owner of result.owners) {
    const { diagnostics } = owner.plan;
    lines.push(
      `owner ${owner.ownerKey} (acquireLimit=${String(owner.acquireLimit)})`,
      `  plan candidates: ${String(owner.plan.candidateCount)} of ${String(diagnostics.scanned)}`,
      `  plan rejects: wrongVenue=${String(diagnostics.wrongVenue)}` +
        `, inactive=${String(diagnostics.inactive)}` +
        `, alreadyStarted=${String(diagnostics.alreadyStarted)}` +
        `, insufficientLeadTime=${String(diagnostics.insufficientLeadTime)}` +
        `, policyMismatch=${String(diagnostics.policyMismatch)}`,
    );
    owner.selectedMarketIds.forEach((marketId, index) => {
      const acquisition = owner.acquisitions[index];
      const status =
        acquisition === undefined
          ? 'n/a'
          : acquisition.status === 'rejected'
            ? `rejected(${acquisition.reason})`
            : acquisition.status === 'failed'
              ? `failed(${acquisition.stage})`
              : acquisition.status;
      lines.push(`  ${String(marketId)} → ${status}`);
    });
  }
  lines.push(
    `controller: opening=${String(result.controller.openingMarkets)}` +
      `, active=${String(result.controller.activeMarkets)}` +
      `, claims=${String(result.controller.claims)}` +
      `, rtdsFeeds=${String(result.controller.rtdsFeeds.length)}` +
      `, sourceFailed=${String(result.controller.sourceFailed)}`,
  );
  return lines;
}

/**
 * Считает исходы приобретения, которые означают «ресурс у владельца есть».
 *
 * @param result - Отчёт прохода
 * @returns Сколько кандидатов дали `opened`/`joined`/`already-held`
 */
function heldOutcomes(result: PolymarketControlRuntimeResult): number {
  return result.owners.reduce(
    (total, owner) =>
      total +
      owner.acquisitions.filter(
        (acquisition) =>
          acquisition.status === 'opened' ||
          acquisition.status === 'joined' ||
          acquisition.status === 'already-held',
      ).length,
    0,
  );
}

/**
 * Собирает список нарушенных инвариантов прогона.
 *
 * @param first - Отчёт первого прохода
 * @param second - Отчёт второго прохода
 * @returns Человекочитаемые причины провала; пустой массив — прогон успешен
 *
 * @remarks
 * Инварианты проверяются по ОБОИМ проходам вместе: за минуту между ними
 * рынок мог стартовать, и «первый купил, второй получил следующий» — такой
 * же успех, как «оба увидели один и тот же pre-open рынок». Требовать
 * дословной идемпотентности значило бы падать от нормального хода времени.
 */
function collectFailures(
  first: PolymarketControlRuntimeResult,
  second: PolymarketControlRuntimeResult,
): readonly string[] {
  const failures: string[] = [];

  if (first.universeEntries === 0 && second.universeEntries === 0) {
    failures.push(
      'no usable universe: neither tick produced a canonical market ' +
        '(catalog traversal, the endDate window or schedule enrichment is broken)',
    );
  }

  const candidates = first.owners[0]?.plan.candidateCount ?? 0;
  const secondCandidates = second.owners[0]?.plan.candidateCount ?? 0;
  if (candidates === 0 && secondCandidates === 0) {
    failures.push(
      'policy produced no candidate in either tick: check the asset/duration selectors ' +
        'against the plan-reject counters printed above',
    );
  }

  const held = heldOutcomes(first) + heldOutcomes(second);
  if (held === 0) {
    failures.push(
      'no candidate reached opened/joined/already-held: the control plane selected markets ' +
        'but no physical subscription was ever held',
    );
  } else if (second.controller.activeMarkets + second.controller.openingMarkets === 0) {
    // Приобретение «удалось», а рынков у контроллера нет — значит ресурса на
    // самом деле не появилось (или он успел развалиться).
    failures.push(
      'controller holds no market right after a successful acquisition ' +
        `(opening=${String(second.controller.openingMarkets)}, ` +
        `active=${String(second.controller.activeMarkets)})`,
    );
  }

  if (first.controller.sourceFailed || second.controller.sourceFailed) {
    failures.push('PolymarketSource reached a terminal failure during the run');
  }
  return failures;
}

/**
 * Точка входа smoke: сборка реального контура, два прохода, отчёт, закрытие.
 *
 * @returns Ничего; провал прогона выражен через `process.exitCode`
 * @throws {SmokeConfigError} Невалидные переменные окружения
 *
 * @remarks
 * Конфигурация разбирается ПЕРВЫМ действием — до создания клиента, — чтобы
 * опечатка не превращалась в сетевой прогон с бессмысленными параметрами.
 *
 * Закрытие ресурсов выполняется в `finally`: даже провалившийся прогон не
 * имеет права оставить живой websocket и подвесить процесс. Порядок
 * закрытия — контроллер (его подписки) → source (его handles и pump-циклы)
 * → bus (drain), то есть от владельца claim-ов к транспорту и дальше к
 * доставке.
 */
async function main(): Promise<void> {
  const config = parseConfig();
  const policy = buildPolicy(config);

  const clock = new LiveClock();
  const logger = new ConsoleLogger(clock, LogLevel.INFO);
  const client = createPublicClient();

  const bus = new ExternalMessageBus<PolymarketExternalMessage>();
  const metadataGenerator = new MessageMetadataGenerator({
    clock,
    highResolutionClock: new LiveHighResolutionClock(),
  });

  const discovery = new PolymarketMarketDiscovery(
    { client, clock, logger },
    { endDateWindowMs: config.windowHours * 60 * 60_000 },
  );
  const source = new PolymarketSource({ client, bus, metadataGenerator, logger });
  const controller = new PolymarketSubscriptionController({ discovery, source, clock, logger });
  const universe = new MarketUniverse(clock);
  const planner = new PolymarketSubscriptionPlanner();
  const runtime = new PolymarketControlRuntime({
    discovery,
    universe,
    planner,
    controller,
    clock,
    logger,
  });

  const demand = { ownerKey: SMOKE_OWNER_KEY, policy, acquireLimit: config.acquireLimit };

  // Счётчики трафика — ДИАГНОСТИКА, а не критерий (см. TSDoc модуля).
  const counts = new Map<string, number>();
  const record = (message: PolymarketExternalMessage): void => {
    counts.set(message.type, (counts.get(message.type) ?? 0) + 1);
  };
  bus.subscribe('POLYMARKET_MARKET', record);
  bus.subscribe('POLYMARKET_CRYPTO_BINANCE', record);
  bus.subscribe('POLYMARKET_CRYPTO_CHAINLINK', record);
  bus.subscribe('POLYMARKET_CRYPTO_CHAINLINK_TWAP', record);

  const lines: string[] = [
    '',
    'Polymarket Control Runtime — live smoke',
    '',
    `owner: ${SMOKE_OWNER_KEY}`,
    `policy: ${config.asset}/${config.duration}`,
    `acquireLimit: ${String(config.acquireLimit)}`,
    `discovery window: ${String(config.windowHours)}h`,
    `started at: ${hhmmss(clock.now().getTime())} UTC`,
  ];

  let failures: readonly string[] = [];
  try {
    const first = await runtime.runOnce([demand]);
    lines.push(...formatTick('tick 1', first));

    // Второй проход тем же спросом: повтор до старта обязан дать
    // `already-held` без нового физического ресурса; если рынок за это время
    // стартовал — нормальным исходом становится следующий рынок серии.
    const second = await runtime.runOnce([demand]);
    lines.push(...formatTick('tick 2 (idempotency)', second));

    lines.push(
      '',
      'subscriptions after tick 2:',
      ...controller
        .listSubscriptions()
        .map(
          (item) =>
            `  ${String(item.marketId)} ${item.state}` +
            ` startsAt=${hhmmss(item.startsAt.toNumber())}` +
            ` owners=[${item.ownerKeys.join(', ')}]` +
            ` rtdsFeeds=${String(item.rtdsFeedCount)}`,
        ),
    );

    if (heldOutcomes(second) > 0) {
      lines.push('', `holding physical subscriptions for ${String(HOLD_MS / 1000)}s ...`);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, HOLD_MS);
      });
    }

    lines.push(
      '',
      'external messages observed (diagnostics only, 0 is not a failure):',
      ...(counts.size === 0
        ? ['  none']
        : [...counts].map(([type, count]) => `  ${type}: ${String(count)}`)),
    );
    failures = collectFailures(first, second);
  } finally {
    // Порядок: владелец claim-ов → транспорт → доставка. Выполняется и на
    // провале: висящий websocket не даст процессу завершиться.
    await controller.close();
    await source.close();
    const busClosed = await bus.close();
    lines.push('', `closed: controller, source, bus (drain ok: ${String(busClosed.ok)})`);
    // eslint-disable-next-line no-console -- отчёт smoke-скрипта, а не логи сервиса
    console.log(lines.join('\n'));
  }

  if (failures.length > 0) {
    console.error(
      `\nControl runtime smoke failed (${String(failures.length)} check(s)):\n` +
        failures.map((failure) => `  - ${failure}`).join('\n'),
    );
    process.exitCode = EXIT_FAILURE;
  }
}

main().catch((error: unknown) => {
  // Ошибка конфигурации — вина вызова, а не скрипта: стек ничего не добавит.
  if (error instanceof SmokeConfigError) {
    console.error(`Control runtime smoke failed: ${error.message}`);
  } else {
    console.error('Control runtime smoke failed:', error);
  }
  process.exitCode = EXIT_FAILURE;
});
