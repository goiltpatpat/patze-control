#!/usr/bin/env node
import { loadBridgeConfigFileIntoEnv, loadBridgeConfigFromEnv } from './config.js';
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
  const configFile = process.env.BRIDGE_CONFIG_FILE;
  let runtime: BridgeRuntime | null = null;
  let stopping = false;

  const loadRuntime = async (options?: {
    readonly fastStart?: boolean;
  }): Promise<BridgeRuntime> => {
    if (configFile) {
      await loadBridgeConfigFileIntoEnv(configFile);
    }
    const config = await loadBridgeConfigFromEnv();
    const next = new BridgeRuntime(config, logger);
    await next.start(options?.fastStart ? { fastStart: true } : undefined);
    logger.info('bridge_started', {
      baseUrl: config.controlPlaneBaseUrl,
      machineId: config.machineId,
      machineIdFile: config.machineIdFile,
      heartbeatMs: config.heartbeatIntervalMs,
      cronSyncMs: config.cronSyncIntervalMs,
      sourceMode: config.sourceMode,
      bridgeVersion: config.bridgeVersion,
      healthHost: config.healthHost,
      healthPort: config.healthPort,
      telemetrySpoolEnabled: config.telemetrySpoolEnabled,
      telemetrySpoolFile: config.telemetrySpoolFile,
      fastStart: Boolean(options?.fastStart),
      hasConfigFile: Boolean(configFile),
    });
    return next;
  };

  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      try {
        await runtime?.stop();
        logger.info('bridge_stopped');
        process.exit(0);
      } catch (error) {
        logger.error('bridge_shutdown_failed', {
          message: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      }
    })();
  };

  const reload = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      logger.info('bridge_reload_requested', {
        hasConfigFile: Boolean(configFile),
      });
      await runtime?.stop();
      logger.info('bridge_reload_restart', {
        reason: 'signal_hup',
      });
      process.exit(0);
    } catch (error) {
      logger.error('bridge_reload_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', () => {
    void reload();
  });

  runtime = await loadRuntime();
}

main().catch((error: unknown) => {
  const logger = new ConsoleLogger();
  logger.error('bridge_fatal', {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
