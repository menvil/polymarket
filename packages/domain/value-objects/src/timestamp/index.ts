/**
 * Timestamp module
 *
 * @remarks
 * Value object для представления временных меток (epoch milliseconds).
 */

// Core
export { Timestamp } from './core/index.js';

// Facade
export { TimestampService } from './facade/index.js';

// Adapters
export { TimestampSerializer, TimestampFormatter } from './adapters/index.js';

// Errors
export { TimestampErrorReason } from './errors/index.js';
