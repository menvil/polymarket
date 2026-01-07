/**
 * Application layer barrel export
 *
 * @remarks
 * Exports all use cases (commands, queries) and DTOs.
 *
 * Application layer содержит:
 * - Commands: операции изменения состояния
 * - Queries: операции чтения данных
 * - DTOs: объекты передачи данных
 * - Handlers: обработчики команд и запросов
 */

// Commands
export * from './commands/index.js';

// Queries
export * from './queries/index.js';

// DTOs
export * from './dto/index.js';
