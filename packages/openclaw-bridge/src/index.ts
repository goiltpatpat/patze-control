#!/usr/bin/env node
import { loadBridgeConfigFromEnv } from './config.js';
import { BridgeRuntime } from './runtime.js';
import type { BridgeLogger } from './types.js';

class ConsoleLogger implements BridgeLogger {
  public info(message: string, context?: Record<string, string | number | boolean>): void {
    console.log(`[openclaw-bridge] ${message}`, context ?? {});
  }

  public warn(message: string, context?: Record<string, string | number | boolean>): void {
    console.warn(`[openclaw-bridge] ${message}`, context ?? {});
  }

  public error(message: string, context?: Record<string, string | number | boolean>): void {
    console.error(`[openclaw-bridge] ${message}`, context ?? {});
  }
}

async function main(): Promise<void> {
  const logger = new ConsoleLogger();
  const config = await loadBridgeConfigFromEnv();
  const runtime = new BridgeRuntime(config, logger);

  const shutdown = (): void => {
    runtime.stop();
    logger.info('bridge_stopped');
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await runtime.start();
  logger.info('bridge_started', {
    baseUrl: config.controlPlaneBaseUrl,
    machineId: config.machineId,
    machineIdFile: config.machineIdFile,
    heartbeatMs: config.heartbeatIntervalMs,
    cronSyncMs: config.cronSyncIntervalMs,
    sourceMode: config.sourceMode,
    bridgeVersion: config.bridgeVersion,
  });
}

main().catch((error: unknown) => {
  const logger = new ConsoleLogger();
  logger.error('bridge_fatal', {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
