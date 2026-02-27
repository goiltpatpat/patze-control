import { HttpSinkAdapter } from '@patze/telemetry-core';
import type { BridgeConfig } from './config.js';
import { BridgeControlPoller } from './control-poller.js';
import { CronPusher } from './cron-pusher.js';
import {
  createMapperState,
  mapRunStateChangedEvents,
  toMachineHeartbeatEvent,
  toMachineRegisteredEvent,
} from './mapper.js';
import { OpenClawCliSource, OpenClawFileSource } from './sources/index.js';
import { OpenClawController } from './openclaw-controller.js';
import type { BridgeLogger, RunDetector, TelemetryEnvelope } from './types.js';
import { BridgeHealthServer, type BridgeHealthSnapshot } from './health-server.js';

export class BridgeRuntime {
  private readonly config: BridgeConfig;

  private readonly sender: HttpSinkAdapter;

  private readonly logger: BridgeLogger;

  private readonly collector: RunDetector;

  private readonly mapperState = createMapperState();

  private readonly cronPusher: CronPusher;
  private readonly controlPoller: BridgeControlPoller;
  private readonly healthServer: BridgeHealthServer;

  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly startedAt = new Date().toISOString();
  private tickCount = 0;
  private tickSuccessCount = 0;
  private tickFailureCount = 0;
  private lastTickAt: string | null = null;
  private lastTickError: string | null = null;
  private consecutiveTickFailures = 0;

  public constructor(config: BridgeConfig, logger: BridgeLogger) {
    this.config = config;
    this.logger = logger;
    this.sender = new HttpSinkAdapter({
      endpoint: {
        id: 'control-plane',
        label: 'Control Plane',
        transport: 'http',
        baseUrl: config.controlPlaneBaseUrl,
        auth: config.controlPlaneToken
          ? { mode: 'token', token: config.controlPlaneToken }
          : { mode: 'none' },
        headers: {
          'X-Patze-Machine-Id': config.machineId,
          'X-Patze-Bridge-Version': config.bridgeVersion,
        },
      },
      batchSize: 50,
      flushIntervalMs: Math.max(500, Math.floor(config.heartbeatIntervalMs / 2)),
      maxRetries: 3,
      ...(config.telemetrySpoolEnabled
        ? { persistedQueueFilePath: config.telemetrySpoolFile }
        : {}),
    });
    this.collector =
      config.sourceMode === 'cli'
        ? new OpenClawCliSource(
            {
              openclawBin: config.openclawBin,
              openclawArgs: config.openclawArgs,
            },
            logger
          )
        : new OpenClawFileSource({
            sessionDir: config.sessionDir,
          });
    this.cronPusher = new CronPusher({
      controlPlaneBaseUrl: config.controlPlaneBaseUrl,
      ...(config.controlPlaneToken ? { controlPlaneToken: config.controlPlaneToken } : {}),
      machineId: config.machineId,
      machineLabel: config.machineLabel,
      bridgeVersion: config.bridgeVersion,
      openclawHomeDir: config.openclawHomeDir,
      syncPath: config.cronSyncPath,
      syncIntervalMs: config.cronSyncIntervalMs,
      stateFilePath: config.cronOffsetStateFile,
      logger: this.logger,
    });
    const controller = new OpenClawController({
      openclawBin: config.openclawBin,
      openclawHomeDir: config.openclawHomeDir,
      logger,
      maxStdoutBytes: 32 * 1024,
      maxStderrBytes: 32 * 1024,
    });
    this.controlPoller = new BridgeControlPoller({
      baseUrl: config.controlPlaneBaseUrl,
      ...(config.controlPlaneToken ? { token: config.controlPlaneToken } : {}),
      machineId: config.machineId,
      pollPath: config.controlPollPath,
      ackPathTemplate: config.controlAckPathTemplate,
      heartbeatPathTemplate: config.controlHeartbeatPathTemplate,
      resultPathTemplate: config.controlResultPathTemplate,
      pollIntervalMs: config.controlPollIntervalMs,
      leaseTtlMs: config.controlLeaseTtlMs,
      receiptStateFile: config.controlReceiptStateFile,
      logger,
      controller,
    });
    this.healthServer = new BridgeHealthServer({
      host: config.healthHost,
      port: config.healthPort,
      logger,
      getSnapshot: () => this.buildHealthSnapshot(),
      getMetrics: () => this.buildMetrics(),
    });
  }

  public async start(options?: { readonly fastStart?: boolean }): Promise<void> {
    const fastStart = Boolean(options?.fastStart);
    this.safeSend(
      toMachineRegisteredEvent({
        machineId: this.config.machineId,
        machineLabel: this.config.machineLabel,
        machineKind: this.config.machineKind,
      })
    );

    await this.healthServer.start();
    if (fastStart) {
      void this.tick();
      await this.cronPusher.start({ skipInitialSync: true });
      await this.controlPoller.start({ skipInitialPoll: true });
    } else {
      await this.tick();
      await this.cronPusher.start();
      await this.controlPoller.start();
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.heartbeatIntervalMs);
  }

  public async stop(): Promise<void> {
    this.cronPusher.stop();
    this.controlPoller.stop();
    await this.healthServer.stop();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.sender.close();
  }

  private async tick(): Promise<void> {
    try {
      this.tickCount += 1;
      this.safeSend(toMachineHeartbeatEvent(this.config.machineId));

      const snapshot = await this.collector.collect();
      const runEvents = mapRunStateChangedEvents(
        this.config.machineId,
        snapshot.activeRuns,
        this.mapperState
      );
      for (const runEvent of runEvents) {
        this.safeSend(runEvent);
      }
      await this.sender.flush();
      this.tickSuccessCount += 1;
      this.lastTickAt = new Date().toISOString();
      this.lastTickError = null;
      this.consecutiveTickFailures = 0;
    } catch (error) {
      this.tickFailureCount += 1;
      this.lastTickAt = new Date().toISOString();
      this.lastTickError = error instanceof Error ? error.message : String(error);
      this.consecutiveTickFailures += 1;
      this.logger.error('tick_failed', {
        message: this.lastTickError,
      });
    }
  }

  private buildHealthSnapshot(): BridgeHealthSnapshot {
    const now = new Date();
    const started = new Date(this.startedAt);
    const uptimeMs = Math.max(0, now.getTime() - started.getTime());
    const ok = this.consecutiveTickFailures < 3;
    const sender = this.sender.getStats();
    return {
      ok,
      status: ok ? 'ok' : 'degraded',
      startedAt: this.startedAt,
      now: now.toISOString(),
      uptimeSec: Math.floor(uptimeMs / 1000),
      machineId: this.config.machineId,
      machineLabel: this.config.machineLabel,
      bridgeVersion: this.config.bridgeVersion,
      controlPlaneBaseUrl: this.config.controlPlaneBaseUrl,
      ...(this.config.tokenExpiresAt ? { tokenExpiresAt: this.config.tokenExpiresAt } : {}),
      runtime: {
        running: this.timer !== null,
        tickCount: this.tickCount,
        lastTickAt: this.lastTickAt,
        lastTickError: this.lastTickError,
        consecutiveTickFailures: this.consecutiveTickFailures,
        cronSyncRunning: this.cronPusher.isRunning(),
        controlPollerRunning: this.controlPoller.isRunning(),
        queueSize: sender.queueSize,
        queueMaxSize: sender.maxQueueSize,
        spoolEnabled: sender.spool.enabled,
        spoolFilePath: sender.spool.filePath,
        spoolHydratedCount: sender.spool.hydratedCount,
        spoolDroppedOnHydrate: sender.spool.droppedOnHydrate,
        spoolLastPersistedAt: sender.spool.lastPersistedAt,
        spoolLastPersistError: sender.spool.lastPersistError,
      },
    };
  }

  private safeSend(event: TelemetryEnvelope): void {
    const result = this.sender.ingest(event);
    if (result.ok) {
      this.logger.info('event_enqueued', { type: event.type });
      return;
    }

    this.logger.warn('event_enqueue_failed', {
      type: event.type,
      message: result.error.message,
    });
  }

  private buildMetrics(): string {
    const nowMs = Date.now();
    const startedMs = new Date(this.startedAt).getTime();
    const uptimeSec = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
    const health = this.buildHealthSnapshot();
    const mem = process.memoryUsage();
    const sender = this.sender.getStats();

    const rows: string[] = [
      '# HELP patze_bridge_up Bridge runtime healthy status (1=ok, 0=degraded).',
      '# TYPE patze_bridge_up gauge',
      `patze_bridge_up ${health.ok ? 1 : 0}`,
      '# HELP patze_bridge_runtime_running Bridge runtime loop status (1=running, 0=stopped).',
      '# TYPE patze_bridge_runtime_running gauge',
      `patze_bridge_runtime_running ${health.runtime.running ? 1 : 0}`,
      '# HELP patze_bridge_uptime_seconds Bridge runtime uptime in seconds.',
      '# TYPE patze_bridge_uptime_seconds gauge',
      `patze_bridge_uptime_seconds ${uptimeSec}`,
      '# HELP patze_bridge_tick_total Total heartbeat tick attempts.',
      '# TYPE patze_bridge_tick_total counter',
      `patze_bridge_tick_total ${this.tickCount}`,
      '# HELP patze_bridge_tick_success_total Total successful heartbeat ticks.',
      '# TYPE patze_bridge_tick_success_total counter',
      `patze_bridge_tick_success_total ${this.tickSuccessCount}`,
      '# HELP patze_bridge_tick_failure_total Total failed heartbeat ticks.',
      '# TYPE patze_bridge_tick_failure_total counter',
      `patze_bridge_tick_failure_total ${this.tickFailureCount}`,
      '# HELP patze_bridge_tick_consecutive_failures Current consecutive failed ticks.',
      '# TYPE patze_bridge_tick_consecutive_failures gauge',
      `patze_bridge_tick_consecutive_failures ${this.consecutiveTickFailures}`,
      '# HELP patze_bridge_cron_sync_running Cron sync worker status (1=running, 0=stopped).',
      '# TYPE patze_bridge_cron_sync_running gauge',
      `patze_bridge_cron_sync_running ${health.runtime.cronSyncRunning ? 1 : 0}`,
      '# HELP patze_bridge_control_poller_running Control poller status (1=running, 0=stopped).',
      '# TYPE patze_bridge_control_poller_running gauge',
      `patze_bridge_control_poller_running ${health.runtime.controlPollerRunning ? 1 : 0}`,
      '# HELP patze_bridge_queue_size Current telemetry queue size.',
      '# TYPE patze_bridge_queue_size gauge',
      `patze_bridge_queue_size ${sender.queueSize}`,
      '# HELP patze_bridge_queue_capacity Configured telemetry queue capacity.',
      '# TYPE patze_bridge_queue_capacity gauge',
      `patze_bridge_queue_capacity ${sender.maxQueueSize}`,
      '# HELP patze_bridge_spool_enabled Telemetry spool persistence enabled flag (1=enabled, 0=disabled).',
      '# TYPE patze_bridge_spool_enabled gauge',
      `patze_bridge_spool_enabled ${sender.spool.enabled ? 1 : 0}`,
      '# HELP patze_bridge_spool_hydrated_total Number of queue items restored from spool on startup.',
      '# TYPE patze_bridge_spool_hydrated_total counter',
      `patze_bridge_spool_hydrated_total ${sender.spool.hydratedCount}`,
      '# HELP patze_bridge_spool_dropped_on_hydrate_total Number of queued items dropped during hydrate due to limits.',
      '# TYPE patze_bridge_spool_dropped_on_hydrate_total counter',
      `patze_bridge_spool_dropped_on_hydrate_total ${sender.spool.droppedOnHydrate}`,
      '# HELP patze_bridge_spool_last_persist_error Spool persist status (0=ok, 1=last persist errored).',
      '# TYPE patze_bridge_spool_last_persist_error gauge',
      `patze_bridge_spool_last_persist_error ${sender.spool.lastPersistError ? 1 : 0}`,
      '# HELP patze_bridge_process_resident_memory_bytes Resident memory usage in bytes.',
      '# TYPE patze_bridge_process_resident_memory_bytes gauge',
      `patze_bridge_process_resident_memory_bytes ${mem.rss}`,
      '# HELP patze_bridge_process_heap_used_bytes Node.js heap used in bytes.',
      '# TYPE patze_bridge_process_heap_used_bytes gauge',
      `patze_bridge_process_heap_used_bytes ${mem.heapUsed}`,
      '# HELP patze_bridge_process_heap_total_bytes Node.js heap total in bytes.',
      '# TYPE patze_bridge_process_heap_total_bytes gauge',
      `patze_bridge_process_heap_total_bytes ${mem.heapTotal}`,
      '# HELP patze_bridge_process_external_bytes Node.js external memory in bytes.',
      '# TYPE patze_bridge_process_external_bytes gauge',
      `patze_bridge_process_external_bytes ${mem.external}`,
    ];
    return `${rows.join('\n')}\n`;
  }
}
