import { HttpSinkAdapter } from '@patze/telemetry-core';
import type { BridgeConfig } from './config.js';
import { createMapperState, mapRunStateChangedEvents, toMachineHeartbeatEvent, toMachineRegisteredEvent } from './mapper.js';
import { OpenClawCliSource, OpenClawFileSource } from './sources/index.js';
import type { BridgeLogger, RunDetector, TelemetryEnvelope } from './types.js';

export class BridgeRuntime {
  private readonly config: BridgeConfig;

  private readonly sender: HttpSinkAdapter;

  private readonly logger: BridgeLogger;

  private readonly collector: RunDetector;

  private readonly mapperState = createMapperState();

  private timer: ReturnType<typeof setInterval> | null = null;

  public constructor(config: BridgeConfig, logger: BridgeLogger) {
    this.config = config;
    this.logger = logger;
    this.sender = new HttpSinkAdapter(
      {
        endpoint: {
          id: 'control-plane',
          label: 'Control Plane',
          transport: 'http',
          baseUrl: config.controlPlaneBaseUrl,
          auth: config.controlPlaneToken
            ? { mode: 'token', token: config.controlPlaneToken }
            : { mode: 'none' },
        },
        batchSize: 50,
        flushIntervalMs: Math.max(500, Math.floor(config.heartbeatIntervalMs / 2)),
        maxRetries: 3,
      }
    );
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
  }

  public async start(): Promise<void> {
    this.safeSend(toMachineRegisteredEvent({
      machineId: this.config.machineId,
      machineLabel: this.config.machineLabel,
      machineKind: this.config.machineKind,
    }));

    await this.tick();

    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.heartbeatIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    void this.sender.close();
  }

  private async tick(): Promise<void> {
    try {
      this.safeSend(toMachineHeartbeatEvent(this.config.machineId));

      const snapshot = await this.collector.collect();
      const runEvents = mapRunStateChangedEvents(this.config.machineId, snapshot.activeRuns, this.mapperState);
      for (const runEvent of runEvents) {
        this.safeSend(runEvent);
      }
      await this.sender.flush();
    } catch (error) {
      this.logger.error('tick_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
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
}
