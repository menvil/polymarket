/**
 * @polymarket/adapters - Infrastructure Adapters
 *
 * Адаптеры для интеграции с внешними сервисами (Pino, Datadog, CloudWatch).
 *
 * ## Почему Infrastructure Layer?
 *
 * Foundation layer должен быть zero dependencies. Adapters к внешним
 * библиотекам (pino, datadog, etc.) живут в infrastructure layer.
 *
 * ## Доступные адаптеры
 *
 * - **PinoLoggerAdapter** - Production logger на базе Pino
 *
 * @example
 * ```typescript
 * import { PinoLoggerAdapter } from '@polymarket/adapters';
 * import pino from 'pino';
 * import { LiveClock } from '@polymarket/time';
 *
 * const logger = new PinoLoggerAdapter(
 *   pino({ level: 'info' }),
 *   new LiveClock()
 * );
 *
 * logger.info('Server started', { port: 3000 });
 * ```
 *
 * @packageDocumentation
 */

export { PinoLoggerAdapter } from './PinoLoggerAdapter.js';
