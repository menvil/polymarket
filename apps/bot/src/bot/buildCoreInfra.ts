/**
 * Построитель базовой инфраструктуры бота.
 *
 * @remarks
 * Создаёт три фундаментальные зависимости, от которых зависят все остальные:
 * - `IClock` — источник времени (LiveClock в продакшне, FakeClock в тестах)
 * - `ILogger` — структурированный логгер с временными метками от clock
 * - `IEventBus` — шина событий для связи компонентов
 *
 * Все три объекта immutable и не требуют явного `stop()`.
 *
 * @example
 * ```typescript
 * const { clock, logger, eventBus } = buildCoreInfra({ logLevel: LogLevel.DEBUG });
 * ```
 */

import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { EventBus } from '@polymarket/event-bus';
import { MessageMetadataGenerator, SystemHighResolutionClock } from '@polymarket/messages';
import type { IClock } from '@polymarket/time';
import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';

/** Параметры для создания базовой инфраструктуры */
export interface BuildCoreInfraParams {
  /** Уровень логирования (по умолчанию INFO) */
  readonly logLevel?: LogLevel;
  /**
   * Источник времени. По умолчанию создаётся `LiveClock`.
   * Передайте `ReplayClock` для детерминированного бектеста.
   */
  readonly clock?: IClock;
}

/** Результат построения базовой инфраструктуры */
export interface CoreInfra {
  readonly clock: IClock;
  readonly logger: ILogger;
  readonly eventBus: IEventBus;
  /**
   * Canonical-генератор metadata сообщений (M-003) — ОДИН на процесс.
   *
   * @remarks
   * Все producers событий (handlers, use-cases, rotation, recorders) получают
   * именно этот instance: runId один на runtime, sequence сквозной.
   */
  readonly metadataGenerator: MessageMetadataGenerator;
}

/**
 * Создаёт базовую инфраструктуру: clock, logger, eventBus.
 *
 * @param params - Параметры инициализации
 * @returns Объект с clock, logger, eventBus
 *
 * @example
 * ```typescript
 * const infra = buildCoreInfra({ logLevel: LogLevel.INFO });
 * infra.logger.info('Bot starting');
 * ```
 */
export function buildCoreInfra(params: BuildCoreInfraParams = {}): CoreInfra {
  const clock = params.clock ?? new LiveClock();
  const logger = new ConsoleLogger(clock, params.logLevel ?? LogLevel.INFO);
  const eventBus = new EventBus(logger);
  // Composition root message-metadata (M-003): live-режим (дефолтный LiveClock)
  // получает когерентное epoch-время с sub-ms precision (wall-origin +
  // monotonic elapsed); инъецированный clock (paper/replay/тесты) —
  // millisecond precision с детерминированными нулями sub-ms (sequence
  // сохраняет точный порядок).
  const metadataGenerator = new MessageMetadataGenerator({
    clock,
    highResolutionClock: params.clock === undefined ? new SystemHighResolutionClock() : undefined,
  });

  return { clock, logger, eventBus, metadataGenerator };
}
