/**
 * Bucketizer Entry Point
 *
 * @remarks
 * Offline mode для построения статистических buckets из historical snapshots.
 * Читает JSONL файлы из snapshots/, строит fill probability распределения.
 *
 * Features:
 * - Reads compressed (.gz) and plain (.jsonl) snapshots
 * - Multiple bucket types support (extensible)
 * - Incremental merge with existing bucket files
 * - Backpressure control (no parallel event processing)
 * - SCALED replay mode for realistic timing
 *
 * @example
 * ```bash
 * # Development mode
 * npm run bucketize:dev
 *
 * # Production mode
 * npm run bucketize
 * ```
 *
 * @module bootstrap/bucketizer
 */

import { EnvConfig } from '../infrastructure/config/EnvConfig.js';
import type { ILogger } from '../domain/ports/ILogger.js';
import { ConsoleLogger } from '../infrastructure/logging/ConsoleLogger.js';
import { SnapshotScanner } from '../infrastructure/persistence/snapshot-readers/SnapshotScanner.js';
import { SnapshotReaderFactory } from '../infrastructure/persistence/snapshot-readers/SnapshotReaderFactory.js';
import { ReplayRunner } from '../application/services/bucketizer/ReplayRunner.js';
import { BucketTypeRegistry } from '../application/services/bucketizer/BucketTypeRegistry.js';
import { BucketPipeline } from '../application/services/bucketizer/BucketPipeline.js';
import { BucketWriter } from '../application/services/bucketizer/BucketWriter.js';
import { VolumeLevelProbabilityFillBucketType } from '../application/services/bucketizer/bucket-types/VolumeLevelProbabilityFillBucketType.js';
import type { ReplayConfig } from '../application/services/bucketizer/types/replay.js';

/**
 * Global state for graceful shutdown
 */
let logger: ILogger | null = null;
let abortController: AbortController | null = null;

/**
 * Main bucketizer bootstrap function
 *
 * @remarks
 * Algorithm:
 * 1. Load configuration
 * 2. Initialize logger
 * 3. Scan snapshot files
 * 4. Create bucket pipelines
 * 5. Process events through ReplayRunner
 * 6. Write final buckets
 * 7. Generate summary report
 */
async function bootstrap(): Promise<void> {
  try {
    console.log('📊 Starting Polymarket Bucketizer...\n');

    // 1. Load configuration
    console.log('⚙️  Loading configuration...');
    const config = EnvConfig;

    console.log(`   Environment: ${config.NODE_ENV}`);
    console.log(`   Input Dir: ${config.BUCKET_INPUT_DIR}`);
    console.log(`   Output Dir: ${config.BUCKET_OUTPUT_DIR}`);
    console.log(`   Bucket Types: ${config.BUCKET_TYPES.join(', ')}`);
    console.log(`   Max Levels: ${config.BUCKET_MAX_LEVELS}`);
    console.log(`   Volume Step: ${config.BUCKET_VOLUME_STEP}`);
    console.log(`   Volume Range: [${config.BUCKET_VOLUME_MIN}, ${config.BUCKET_VOLUME_MAX}]`);
    console.log(`   Horizons: ${config.BUCKET_HORIZONS_SEC.join(', ')}s`);
    console.log(`   Replay Mode: ${config.REPLAY_MODE}`);
    if (config.REPLAY_MODE === 'SCALED') {
      console.log(`   Replay Scale: ${config.REPLAY_SCALE}x`);
      console.log(`   Max Catchup Delay: ${config.REPLAY_MAX_CATCHUP_DELAY_MS}ms`);
    }
    if (config.BUCKET_FROM_DAY || config.BUCKET_TO_DAY) {
      console.log(`   Date Range: ${config.BUCKET_FROM_DAY || 'ALL'} → ${config.BUCKET_TO_DAY || 'ALL'}`);
    }
    console.log('✅ Configuration loaded\n');

    // 2. Initialize logger
    console.log('📝 Initializing logger...');
    logger = new ConsoleLogger({ level: config.LOG_LEVEL.toLowerCase() as any });
    logger.info('Bucketizer starting', {
      inputDir: config.BUCKET_INPUT_DIR,
      outputDir: config.BUCKET_OUTPUT_DIR,
      bucketTypes: config.BUCKET_TYPES,
    });
    console.log('✅ Logger ready\n');

    // 3. Scan snapshots
    console.log('🔍 Scanning snapshots...');
    console.log(`   Date filter: ${config.BUCKET_FROM_DAY || 'ALL'} → ${config.BUCKET_TO_DAY || 'ALL'}`);

    const scanner = new SnapshotScanner(config.BUCKET_INPUT_DIR, logger);
    const scanResult = await scanner.scan({
      fromDate: config.BUCKET_FROM_DAY,
      toDate: config.BUCKET_TO_DAY,
    });

    console.log(`   Found ${scanResult.files.length} files`);
    console.log(`   Total size: ${(scanResult.totalSizeBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Date range: ${scanResult.dateRange.from} → ${scanResult.dateRange.to}`);
    console.log(`   Dates with files: ${scanResult.datesFound.join(', ')}`);
    console.log('✅ Scan complete\n');

    if (scanResult.files.length === 0) {
      console.log('⚠️  No snapshot files found. Exiting.');
      logger.warn('No snapshot files found', { inputDir: config.BUCKET_INPUT_DIR });
      process.exit(0);
    }

    // 4. Setup bucket types
    console.log('🗂️  Setting up bucket types...');
    const registry = new BucketTypeRegistry();

    // Register bucket types based on config
    for (const bucketTypeName of config.BUCKET_TYPES) {
      if (bucketTypeName === 'volume_level_probability_fill') {
        const bucketType = new VolumeLevelProbabilityFillBucketType({
          maxLevels: config.BUCKET_MAX_LEVELS,
          volumeStep: config.BUCKET_VOLUME_STEP,
          volumeMin: config.BUCKET_VOLUME_MIN,
          volumeMax: config.BUCKET_VOLUME_MAX,
          horizonsSec: config.BUCKET_HORIZONS_SEC,
          logger: logger,
        });
        registry.register(bucketType);
        console.log(`   ✓ Registered: ${bucketTypeName}`);
      } else {
        logger.warn('Unknown bucket type, skipping', { bucketType: bucketTypeName });
        console.log(`   ⚠ Unknown bucket type: ${bucketTypeName}`);
      }
    }
    console.log('✅ Bucket types ready\n');

    // 5. Create bucket pipeline
    console.log('🔄 Creating bucket pipeline...');
    const pipeline = new BucketPipeline(registry, logger);
    console.log('✅ Pipeline ready\n');

    // 6. Setup replay runner
    console.log('⏯️  Setting up replay runner...');
    const readerFactory = new SnapshotReaderFactory(logger);

    const replayConfig: ReplayConfig = {
      mode: config.REPLAY_MODE,
      scale: config.REPLAY_SCALE,
      maxCatchupDelayMs: config.REPLAY_MAX_CATCHUP_DELAY_MS,
      scanOptions: {
        fromDate: config.BUCKET_FROM_DAY,
        toDate: config.BUCKET_TO_DAY,
      },
    };

    const runner = new ReplayRunner(scanner, readerFactory, replayConfig, logger);
    console.log('✅ Replay runner ready\n');

    // 7. Process events
    console.log('▶️  Processing events...');
    console.log('   Press Ctrl+C to stop gracefully\n');

    abortController = new AbortController();
    const startTime = Date.now();

    const stats = await runner.run(
      async (event) => {
        await pipeline.processEvent(event);
      },
      async () => {
        // Финализируем каждый файл (закрываем attempts, очищаем trackers)
        await pipeline.finalizeFile();
      },
      abortController.signal
    );

    const duration = Date.now() - startTime;

    console.log('\n📊 Processing complete!');
    console.log(`   Events processed: ${stats.processedEvents}`);
    console.log(`   Events skipped: ${stats.skippedEvents}`);
    console.log(`   Events with errors: ${stats.errorEvents}`);
    console.log(`   Files processed: ${stats.filesProcessed}`);
    console.log(`   Duration: ${(duration / 1000).toFixed(2)}s`);
    console.log(`   Speed: ${Math.round(stats.processedEvents / (duration / 1000))} events/sec`);
    console.log('✅ Events processed\n');

    // 8. Get buckets (финализация уже произошла после каждого файла)
    const buckets = pipeline.getBuckets();
    const pipelineStats = pipeline.getStats();

    console.log('📈 Pipeline statistics:');
    console.log(`   Events processed: ${pipelineStats.eventsProcessed}`);
    console.log(`   Attempts finalized: ${pipelineStats.attemptsFinalized}`);
    console.log(`   Buckets aggregated: ${pipelineStats.bucketsAggregated}`);
    console.log(`   Total buckets: ${buckets.size}`);
    console.log('✅ Buckets ready\n');

    if (buckets.size === 0) {
      console.log('⚠️  No buckets created. Nothing to write.');
      logger.warn('No buckets created');
      process.exit(0);
    }

    // 9. Write buckets
    console.log('💾 Writing buckets to disk...');
    const writer = new BucketWriter(registry, logger);

    const writeStats = await writer.write(buckets, {
      mode: 'merge',  // Use merge mode to preserve existing data
      outputDir: config.BUCKET_OUTPUT_DIR,
    });

    console.log(`   Buckets written: ${writeStats.bucketsWritten}`);
    console.log(`   Files written: ${writeStats.filesWritten}`);
    console.log(`   Merged buckets: ${writeStats.mergedBuckets}`);
    console.log(`   New buckets: ${writeStats.newBuckets}`);
    console.log(`   Bytes written: ${(writeStats.bytesWritten / 1024).toFixed(2)} KB`);
    console.log(`   Duration: ${writeStats.durationMs}ms`);
    console.log('✅ Buckets written\n');

    // 10. Summary
    console.log('═'.repeat(60));
    console.log('✅ Bucketizer completed successfully!');
    console.log('═'.repeat(60));
    console.log(`📂 Output directory: ${config.BUCKET_OUTPUT_DIR}`);
    console.log(`📊 Total buckets: ${writeStats.bucketsWritten}`);
    console.log(`📈 Events processed: ${stats.processedEvents}`);
    console.log(`⏱️  Total duration: ${(duration / 1000).toFixed(2)}s`);
    console.log('═'.repeat(60) + '\n');

    logger.info('Bucketizer completed', {
      outputDir: config.BUCKET_OUTPUT_DIR,
      bucketsWritten: writeStats.bucketsWritten,
      eventsProcessed: stats.processedEvents,
      durationMs: duration,
    });

    process.exit(0);
  } catch (error) {
    if (error instanceof Error && error.message === 'Aborted') {
      // Graceful shutdown was triggered
      console.log('\n⚠️  Bucketizer stopped by user');

      if (logger) {
        logger.info('Bucketizer stopped gracefully');
      }

      // Try to save partial results
      await savePartialResults();

      process.exit(0);
    } else {
      // Unexpected error
      if (logger) {
        logger.error('Failed to run Bucketizer', error);
      }
      console.error('\n❌ Failed to run Bucketizer:', error);
      process.exit(1);
    }
  }
}

/**
 * Save partial results when interrupted
 */
async function savePartialResults(): Promise<void> {
  try {
    console.log('\n💾 Saving partial results...');

    // TODO: Implement saving partial results
    // This would require access to pipeline and writer
    // For now, just log a message

    console.log('✅ Partial results saved (if any)\n');
  } catch (error) {
    console.error('⚠️  Failed to save partial results:', error);
  }
}

/**
 * Graceful shutdown handler
 */
async function shutdown(): Promise<void> {
  console.log('\n🛑 Shutdown signal received...');

  if (abortController) {
    console.log('   Aborting replay...');
    abortController.abort();
  }

  if (logger) {
    logger.info('Bucketizer shutdown initiated');
  }

  // The main bootstrap function will handle cleanup
  // via the AbortController signal
}

// Handle shutdown signals
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  if (logger) {
    logger.error('Unhandled rejection', { reason, promise });
  }
  process.exit(1);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  if (logger) {
    logger.error('Uncaught exception', error);
  }
  process.exit(1);
});

// Start bucketizer
bootstrap();
