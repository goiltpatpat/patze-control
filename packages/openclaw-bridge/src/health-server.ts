import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { BridgeLogger } from './types.js';

export interface BridgeHealthSnapshot {
  readonly ok: boolean;
  readonly status: 'ok' | 'degraded';
  readonly startedAt: string;
  readonly now: string;
  readonly uptimeSec: number;
  readonly machineId: string;
  readonly machineLabel: string;
  readonly bridgeVersion: string;
  readonly controlPlaneBaseUrl: string;
  readonly tokenExpiresAt?: string | undefined;
  readonly runtime: {
    readonly running: boolean;
    readonly tickCount: number;
    readonly lastTickAt: string | null;
    readonly lastTickError: string | null;
    readonly consecutiveTickFailures: number;
    readonly cronSyncRunning: boolean;
    readonly controlPollerRunning: boolean;
    readonly queueSize: number;
    readonly queueMaxSize: number;
    readonly spoolEnabled: boolean;
    readonly spoolFilePath: string | null;
    readonly spoolHydratedCount: number;
    readonly spoolDroppedOnHydrate: number;
    readonly spoolLastPersistedAt: string | null;
    readonly spoolLastPersistError: string | null;
  };
}

interface BridgeHealthServerOptions {
  readonly host: string;
  readonly port: number;
  readonly logger: BridgeLogger;
  readonly getSnapshot: () => BridgeHealthSnapshot;
  readonly getMetrics: () => string;
}

export class BridgeHealthServer {
  private readonly options: BridgeHealthServerOptions;
  private server: Server | null = null;

  public constructor(options: BridgeHealthServerOptions) {
    this.options = options;
  }

  public async start(): Promise<void> {
    if (this.options.port <= 0 || this.server) {
      return;
    }
    const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
      if (!req.url) {
        res.statusCode = 400;
        res.end('bad_request');
        return;
      }
      const pathname = new URL(req.url, 'http://bridge.local').pathname;
      if (pathname === '/metrics') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.end(this.options.getMetrics());
        return;
      }

      if (pathname !== '/health') {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }

      const snapshot = this.options.getSnapshot();
      res.statusCode = snapshot.ok ? 200 : 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(snapshot));
    };
    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const server = createServer(requestHandler);
      // Keep a fallback error handler so late socket errors never crash the process.
      server.on('error', () => {
        /* handled via one-shot listeners below */
      });
      this.server = server;
      try {
        await new Promise<void>((resolve, reject) => {
          const onListening = (): void => resolve();
          const onError = (error: Error): void => reject(error);
          server.once('listening', onListening);
          server.once('error', onError);
          server.listen(this.options.port, this.options.host);
        });
        break;
      } catch (error) {
        const code =
          typeof error === 'object' && error && 'code' in error
            ? String((error as { code?: unknown }).code)
            : '';
        if (code !== 'EADDRINUSE' || attempt >= maxAttempts) {
          this.server = null;
          throw error;
        }
        try {
          server.close();
        } catch {
          // no-op
        }
        this.server = null;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
    }

    this.options.logger.info('bridge_health_server_started', {
      host: this.options.host,
      port: this.options.port,
    });
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const server = this.server;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    this.server = null;
    this.options.logger.info('bridge_health_server_stopped');
  }
}
