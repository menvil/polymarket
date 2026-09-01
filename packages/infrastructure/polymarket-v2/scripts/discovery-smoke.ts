/**
 * DEVELOPMENT-ONLY live smoke: один обход Polymarket V2 Discovery.
 *
 * @remarks
 * Проверяет против ПУБЛИЧНЫХ endpoints Polymarket (без credentials), что
 * реальный vendor-каталог превращается в canonical universe:
 *
 * - bounded-пагинация каталога и окно `endDate`;
 * - классификация семейства `CRYPTO_UP_DOWN` на реальных данных;
 * - точное `startsAt` из `event.schedule.startTime` для каждого рынка;
 * - экономия точечных запросов события (кэш + дедупликация).
 *
 * Это НЕ Collector: скрипт НЕ открывает WS-подписок, ничего не пишет и
 * завершается сам. Печатает диагностику обхода и найденные серии.
 *
 * ### Код возврата — часть контракта smoke
 *
 * Прогон завершается НЕнулевым кодом, если:
 *
 * - `DISCOVERY_WINDOW_HOURS` задан, но не является конечным положительным
 *   числом (см. {@link parseWindowHours});
 * - любой из двух обходов вернул `false` — `refresh()` по контракту НЕ
 *   бросает, отказ площадки наблюдаем ТОЛЬКО по возвращённому значению
 *   (см. {@link collectFailures});
 * - свежий снимок пуст: ни одного canonical рынка (причина различается по
 *   счётчикам снимка — см. {@link collectFailures});
 * - тёплый проход не переиспользовал из кэша событий НИ ОДНОГО расписания.
 *
 * Smoke, который не умеет падать, бесполезен: недоступный Gamma обязан
 * отличаться от «сегодня нет подходящих серий» кодом возврата, а не только
 * глазами читающего отчёт. И `true` от обоих обходов сам по себе ничего не
 * доказывает: обход каталога удаётся и тогда, когда обогащение расписанием
 * отказало целиком, — именно поэтому проверяется РЕЗУЛЬТАТ обхода, а не
 * только его исход.
 *
 * Запуск из корня repo (нужен собранный dist зависимостей — `npm run build`
 * в пакете строит их через project references):
 *
 * ```bash
 * npx tsx packages/infrastructure/polymarket-v2/scripts/discovery-smoke.ts
 * # окно обзора в часах (по умолчанию 6)
 * DISCOVERY_WINDOW_HOURS=2 npx tsx packages/infrastructure/polymarket-v2/scripts/discovery-smoke.ts
 * ```
 */
import { createPublicClient } from '@polymarket/client';
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import type { MarketDiscoveryDiagnostics, MarketDiscoveryEntry } from '@polymarket/ports';
import { PolymarketMarketDiscovery } from '../src/index.js';

/** Окно обзора `endDate` в часах по умолчанию (ближайшие серии, а не весь мир). */
const DEFAULT_WINDOW_HOURS = 6;

/** Код возврата провалившегося прогона. */
const EXIT_FAILURE = 1;

/**
 * Ошибка конфигурации прогона: переменная окружения задана неверно.
 *
 * @remarks
 * Отдельный тип нужен, чтобы верхний обработчик отличал «пользователь
 * ошибся в аргументе» (печатаем одну понятную строку) от неожиданного сбоя
 * скрипта (печатаем ошибку целиком, со стеком).
 */
class SmokeConfigError extends Error {}

/**
 * Разбирает и валидирует `DISCOVERY_WINDOW_HOURS`.
 *
 * Алгоритм:
 * 1. Значение не задано — берём {@link DEFAULT_WINDOW_HOURS}, `Number()` не
 *    вызываем вовсе (дефолт не обязан проходить парсинг).
 * 2. Значение задано — приводим к числу и требуем КОНЕЧНОЕ ПОЛОЖИТЕЛЬНОЕ.
 * 3. Иначе — {@link SmokeConfigError}.
 *
 * @param raw - Сырое значение переменной окружения (`undefined`, если не задана)
 * @returns Окно обзора в часах: конечное число строго больше нуля
 * @throws {SmokeConfigError} Значение задано, но не является конечным положительным числом
 *
 * @remarks
 * Почему валидация обязана быть ДО построения конфига discovery: значение
 * уходит в `endDateWindowMs: windowHours * 60 * 60_000`, а
 * `PolymarketMarketDiscovery` этот параметр не проверяет. `Number('abc')`
 * даёт `NaN` — клиентский cutoff обхода становится невалидным и любое
 * сравнение с ним ложно, поэтому universe молча пуст. `Number('Infinity')`
 * и отрицательные значения ломают окно в другую сторону: cutoff перестаёт
 * ограничивать обход, и пагинация идёт до упора в `maxPages` вместо
 * запрошенного окна. Оба исхода выглядят как «успешный smoke» — то есть
 * невалидное окно тихо подменяет предмет проверки.
 *
 * Верхняя граница СОЗНАТЕЛЬНО не вводится: обход и так ограничен
 * `maxPages`, а большое конечное окно — осмысленный запрос оператора, в
 * отличие от `NaN`/`Infinity`, которые запросом не являются вообще.
 *
 * @example
 * ```typescript
 * parseWindowHours(undefined); // 6 — дефолт
 * parseWindowHours('2');       // 2
 * parseWindowHours('0.5');     // 0.5 — дробное окно допустимо
 * parseWindowHours('abc');     // SmokeConfigError
 * ```
 */
function parseWindowHours(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_WINDOW_HOURS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new SmokeConfigError(
      `DISCOVERY_WINDOW_HOURS must be a finite positive number of hours, ` +
        `got "${raw}" (parsed as ${String(parsed)}). Example: DISCOVERY_WINDOW_HOURS=2`,
    );
  }
  return parsed;
}

/**
 * Собирает список нарушенных инвариантов прогона.
 *
 * @param input - Исходы обоих обходов и диагностика ИТОГОВОГО снимка
 * @returns Человекочитаемые причины провала; пустой массив — прогон успешен
 *
 * @remarks
 * ### Почему исход обхода читается из возвращённого значения
 *
 * Порт `IMarketDiscoveryService` гарантирует, что `refresh()` НЕ бросает:
 * отказ площадки он возвращает как `false`, оставляя доступным ПРЕДЫДУЩИЙ
 * снимок (last-good семантика). В первом прогоне предыдущий снимок пуст,
 * поэтому недоступный Gamma без этой проверки выглядит как пустой отчёт с
 * кодом 0. `try/catch` здесь не поймал бы ничего.
 *
 * Тёплый проход проверяется так же строго, как холодный: именно он —
 * предмет проверки «расписания переиспользуются кэшем». Провалившийся тёплый
 * проход не обновляет снимок, и печатаемые `eventCacheHits`/`eventFetches`
 * относятся тогда к холодному обходу, то есть отчёт о кэше становится
 * ложным.
 *
 * ### Почему ПУСТОЙ universe — провал, а не строка отчёта
 *
 * `true` от `refresh()` означает лишь «обход каталога состоялся», а не
 * «контур работает». Показательный отказ: если падает КАЖДЫЙ `fetchEvent`,
 * `PolymarketMarketDiscovery` ведёт себя штатно — пишет warn на каждое
 * событие, помечает рынки непригодными (`invalidMarkets`) и всё равно
 * возвращает `true`, потому что каталог обойти удалось. Оба прохода зелёные,
 * universe пуст, код возврата 0 — ровно та ложная уверенность, ради которой
 * smoke и существует.
 *
 * Пустота значима именно как ПРОВАЛ, потому что площадка непрерывно
 * публикует 5-минутные серии: в осмысленном окне (дефолт — 6 часов) их
 * истекает десятками, и «ноль canonical рынков» означает поломку контура, а
 * не тишину площадки. Ложное срабатывание возможно на экстремально малом
 * окне — `DISCOVERY_WINDOW_HOURS=0.001` даёт четыре секунды, в которые
 * может не попасть ни одно истечение. Для dev-smoke это приемлемо: окно
 * задаёт сам оператор осознанно, а «в моё окно не истекает ничего» — тоже
 * повод прочитать отчёт (счётчики покажут `tradeableMarkets: 0` при живом
 * `marketsScanned`), а не молча получить код 0. Тихая проверка, которую
 * нельзя нарушить, уже стоила этому скрипту одного инварианта.
 *
 * ### Почему причина различается по счётчикам
 *
 * «Каталог не отдал ничего» и «каталог отдал, но ни один рынок не стал
 * canonical» чинятся в разных местах, и smoke обязан сказать, в каком:
 *
 * - `tradeableMarkets === 0` — проблема каталога либо окна: пагинация,
 *   `endDate`-cutoff или technical gate торгуемости. До классификации и
 *   запросов события дело не дошло вовсе.
 * - `tradeableMarkets > 0`, но canonical рынков нет — проблема классификации
 *   либо обогащения расписанием. Полный отказ `fetchEvent` попадает именно
 *   сюда, и его подпись — большой `invalidMarkets` при ненулевом
 *   `eventFetches`; сплошной `unsupportedMarkets` вместо него означал бы
 *   сломанный классификатор семейства.
 *
 * ### Почему пустота проверяется только у СВЕЖЕГО снимка
 *
 * Если оба обхода вернули `false`, снимок — предыдущий (в первом прогоне
 * пустой), и его пустота есть следствие уже сообщённого отказа, а не
 * самостоятельная находка. Описывать один дефект двумя строками с разными
 * причинами — значит дезориентировать читателя отчёта.
 *
 * ### Почему кэш проверяется как `eventCacheHits > 0`
 *
 * Главное утверждение скрипта — «тёплый проход обслуживается кэшем
 * событий» — до сих пор только печаталось. Строгое `eventFetches === 0`
 * было бы флаки: между проходами площадка публикует новые серии (замер на
 * 6-часовом окне: тёплый проход дал `eventFetches: 6` при полностью
 * исправном кэше). Сломанный же кэш даёт РОВНО ноль попаданий, и новые
 * рынки помешать этому не могут — поэтому порог стоит на попаданиях, а не
 * на запросах.
 *
 * Проверка требует обоих успешных проходов и непустого universe: кэш
 * наполняет холодный проход, поэтому после его отказа ноль попаданий в
 * тёплом — норма, а не дефект; на пустом universe кэшировать было нечего.
 *
 * @example
 * ```typescript
 * // Здоровый прогон: оба обхода прошли, universe непуст, кэш сработал
 * collectFailures({
 *   coldRefreshed: true,
 *   warmRefreshed: true,
 *   universeSize: 588,
 *   diagnostics, // tradeableMarkets: 588, eventCacheHits: 624
 * }); // []
 *
 * // Полный отказ fetchEvent: обходы «удались», universe пуст
 * collectFailures({
 *   coldRefreshed: true,
 *   warmRefreshed: true,
 *   universeSize: 0,
 *   diagnostics, // tradeableMarkets: 588, invalidMarkets: 588
 * });
 * // ['empty canonical universe: 588 tradeable market(s) produced no canonical one …']
 * ```
 */
function collectFailures(input: {
  readonly coldRefreshed: boolean;
  readonly warmRefreshed: boolean;
  readonly universeSize: number;
  readonly diagnostics: MarketDiscoveryDiagnostics;
}): readonly string[] {
  const failures: string[] = [];
  const { diagnostics } = input;

  if (!input.coldRefreshed) {
    failures.push(
      'cold refresh returned false: the first catalog traversal failed ' +
        '(public Gamma endpoint unavailable?) and produced no snapshot of its own; ' +
        'the report above therefore describes the warm pass, or the initial empty snapshot if that one failed too',
    );
  }
  if (!input.warmRefreshed) {
    failures.push(
      'warm refresh returned false: catalog traversal failed on the second pass; ' +
        'the event-cache figures above describe the cold pass, not a warm one',
    );
  }

  // Пустота ПРЕДЫДУЩЕГО снимка ничего не доказывает — она следствие уже
  // сообщённого отказа обхода.
  const snapshotIsFresh = input.coldRefreshed || input.warmRefreshed;
  if (snapshotIsFresh && input.universeSize === 0) {
    failures.push(
      diagnostics.tradeableMarkets === 0
        ? 'empty canonical universe: the catalog window yielded no tradeable market at all ' +
            `(pagesFetched=${String(diagnostics.pagesFetched)}, ` +
            `marketsScanned=${String(diagnostics.marketsScanned)}) — ` +
            'catalog traversal or the endDate window is broken, classification never ran'
        : `empty canonical universe: ${String(diagnostics.tradeableMarkets)} tradeable market(s) ` +
            'produced no canonical one ' +
            `(unsupported=${String(diagnostics.unsupportedMarkets)}, ` +
            `invalid=${String(diagnostics.invalidMarkets)}, ` +
            `duplicates=${String(diagnostics.duplicateMarkets)}, ` +
            `eventFetches=${String(diagnostics.eventFetches)}) — ` +
            'classification or schedule enrichment is broken; ' +
            'a total fetchEvent outage lands here, with invalid matching the supported-family count',
    );
  }

  if (
    input.coldRefreshed &&
    input.warmRefreshed &&
    input.universeSize > 0 &&
    diagnostics.eventCacheHits === 0
  ) {
    failures.push(
      'warm pass served 0 event(s) from the event cache ' +
        `(eventFetches=${String(diagnostics.eventFetches)}): the second pass re-fetched every schedule, ` +
        'so event caching — the very claim this smoke exists to check — does not work',
    );
  }
  return failures;
}

/** `HH:MM` в UTC — компактная разметка окна серии в отчёте. */
function hhmm(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(11, 16);
}

/** Человекочитаемая длительность серии (`5m`, `15m`, `1h`). */
function humanDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes % 60 === 0 && minutes >= 60 ? `${String(minutes / 60)}h` : `${String(minutes)}m`;
}

/** Группирует записи по ключу, сохраняя порядок появления. */
function groupBy(
  entries: readonly MarketDiscoveryEntry[],
  key: (entry: MarketDiscoveryEntry) => string,
): Map<string, MarketDiscoveryEntry[]> {
  const groups = new Map<string, MarketDiscoveryEntry[]>();
  for (const entry of entries) {
    const bucket = groups.get(key(entry));
    if (bucket === undefined) {
      groups.set(key(entry), [entry]);
    } else {
      bucket.push(entry);
    }
  }
  return groups;
}

/**
 * Точка входа smoke: два обхода discovery, отчёт, проверка инвариантов.
 *
 * @returns Ничего; провал прогона выражен через `process.exitCode`
 * @throws {SmokeConfigError} Невалидный `DISCOVERY_WINDOW_HOURS`
 *
 * @remarks
 * Окно валидируется ПЕРВЫМ действием — до создания клиента и конфига
 * discovery, чтобы невалидное значение не превратилось в сетевой прогон с
 * бессмысленным cutoff.
 *
 * Отчёт печатается ВСЕГДА, даже когда обход провалился: диагностика нужна,
 * чтобы понять причину. Код возврата выставляется после отчёта.
 *
 * Инварианты считаются по ИТОГОВОМУ снимку — тому же, что напечатан выше,
 * — чтобы отчёт и код возврата не расходились: объясняющие провал счётчики
 * читатель видит в отчёте, а не восстанавливает по памяти.
 *
 * @example
 * ```typescript
 * await main(); // process.exitCode === 0 при успешном прогоне
 * ```
 */
async function main(): Promise<void> {
  const windowHours = parseWindowHours(process.env['DISCOVERY_WINDOW_HOURS']);

  const clock = new LiveClock();
  const logger = new ConsoleLogger(clock, LogLevel.INFO);

  const discovery = new PolymarketMarketDiscovery(
    { client: createPublicClient(), clock, logger },
    { endDateWindowMs: windowHours * 60 * 60_000 },
  );

  // Первый обход — холодный кэш событий; второй — проверка того, что
  // расписания переиспользуются, а не запрашиваются заново. Результат
  // КАЖДОГО прохода сохраняется: `refresh()` не бросает, и `false` —
  // единственный наблюдаемый признак отказа площадки.
  const coldStartedMs = Date.now();
  const coldRefreshed = await discovery.refresh({ force: true });
  const coldElapsedMs = Date.now() - coldStartedMs;
  const coldDiagnostics = discovery.getSnapshot().diagnostics;

  const warmStartedMs = Date.now();
  const warmRefreshed = await discovery.refresh({ force: true });
  const warmElapsedMs = Date.now() - warmStartedMs;
  const snapshot = discovery.getSnapshot();

  const lines: string[] = [
    '',
    'Polymarket V2 Discovery',
    '',
    `windowHours: ${String(windowHours)}`,
    `cold refresh: ${String(coldRefreshed)}`,
    `warm refresh: ${String(warmRefreshed)}`,
    `cold pass: ${String(coldElapsedMs)} ms, eventFetches=${String(coldDiagnostics.eventFetches)}`,
    `warm pass: ${String(warmElapsedMs)} ms, eventFetches=${String(snapshot.diagnostics.eventFetches)}` +
      `, eventCacheHits=${String(snapshot.diagnostics.eventCacheHits)}`,
    `observedAt: ${snapshot.observedAt.toISO()}`,
    '',
  ];
  for (const [name, value] of Object.entries(snapshot.diagnostics)) {
    lines.push(`${name}: ${String(value)}`);
  }
  lines.push('');

  const byAsset = groupBy(snapshot.entries, (entry) => String(entry.market.crypto?.asset ?? '—'));
  for (const [asset, group] of [...byAsset].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${asset.toUpperCase()}: ${String(group.length)}`);
    for (const entry of group) {
      lines.push(
        `  ${hhmm(entry.market.startsAt.toNumber())}–${hhmm(entry.market.expiresAt.toNumber())}` +
          `  ${humanDuration(entry.market.duration().toNumber())}` +
          `  liq=${entry.metrics.liquidity.value().toFixed(0)}` +
          `  ${entry.market.outcomes.map((outcome) => outcome.label).join('/')}`,
      );
    }
    lines.push('');
  }

  const byDuration = groupBy(snapshot.entries, (entry) =>
    humanDuration(entry.market.duration().toNumber()),
  );
  lines.push('by duration:');
  for (const [duration, group] of byDuration) {
    lines.push(`  ${duration}: ${String(group.length)}`);
  }

  lines.push('', `canonical markets in universe: ${String(snapshot.entries.length)}`);

  // eslint-disable-next-line no-console -- отчёт smoke-скрипта, а не логи сервиса
  console.log(lines.join('\n'));

  const failures = collectFailures({
    coldRefreshed,
    warmRefreshed,
    universeSize: snapshot.entries.length,
    diagnostics: snapshot.diagnostics,
  });
  if (failures.length > 0) {
    console.error(
      `\nDiscovery smoke failed (${String(failures.length)} check(s)):\n` +
        failures.map((failure) => `  - ${failure}`).join('\n'),
    );
    process.exitCode = EXIT_FAILURE;
  }
}

main().catch((error: unknown) => {
  // Ошибка конфигурации — вина вызова, а не скрипта: стек ничего не добавит.
  if (error instanceof SmokeConfigError) {
    console.error(`Discovery smoke failed: ${error.message}`);
  } else {
    console.error('Discovery smoke failed:', error);
  }
  process.exitCode = EXIT_FAILURE;
});
