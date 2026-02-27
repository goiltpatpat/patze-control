import fs from 'node:fs';
import path from 'node:path';
import { OpenClawController } from './openclaw-controller.js';
import type { BridgeControlCommand, BridgeControlCommandResult, BridgeLogger } from './types.js';

interface BridgeControlPollerOptions {
  readonly baseUrl: string;
  readonly token?: string | undefined;
  readonly machineId: string;
  readonly pollPath: string;
  readonly ackPathTemplate: string;
  readonly heartbeatPathTemplate: string;
  readonly resultPathTemplate: string;
  readonly pollIntervalMs: number;
  readonly leaseTtlMs: number;
  readonly receiptStateFile: string;
  readonly logger: BridgeLogger;
  readonly controller: OpenClawController;
}

interface StoredReceipt {
  readonly commandId: string;
  readonly machineId: string;
  readonly result: BridgeControlCommandResult;
  readonly storedAt: string;
}

interface ReceiptStateFile {
  readonly version: 1;
  readonly receipts: readonly StoredReceipt[];
}

function toUrl(baseUrl: string, pathname: string): string {
  const target = new URL(baseUrl);
  target.pathname = pathname;
  target.search = '';
  target.hash = '';
  return target.toString();
}

function toCommandPath(template: string, commandId: string): string {
  return template.replace('{commandId}', encodeURIComponent(commandId));
}

export class BridgeControlPoller {
  private readonly options: BridgeControlPollerOptions;
  private readonly receipts = new Map<string, StoredReceipt>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private inFlight = false;

  public constructor(options: BridgeControlPollerOptions) {
    this.options = options;
    this.loadReceipts();
  }

  public async start(options?: { readonly skipInitialPoll?: boolean }): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (!options?.skipInitialPoll) {
      await this.tick();
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.pollIntervalMs);
  }

  public stop(): void {
    this.running = false;
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  public isRunning(): boolean {
    return this.running;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.options.token) {
      headers.Authorization = `Bearer ${this.options.token}`;
    }
    return headers;
  }

  private async pollCommand(): Promise<BridgeControlCommand | null> {
    const response = await fetch(toUrl(this.options.baseUrl, this.options.pollPath), {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        machineId: this.options.machineId,
        leaseTtlMs: this.options.leaseTtlMs,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`bridge_control_poll_http_${String(response.status)}`);
    }
    const payload = (await response.json()) as {
      available?: boolean;
      command?: BridgeControlCommand;
    };
    if (!payload.available || !payload.command) return null;
    return payload.command;
  }

  private async ackRunning(commandId: string): Promise<void> {
    const response = await fetch(
      toUrl(this.options.baseUrl, toCommandPath(this.options.ackPathTemplate, commandId)),
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ machineId: this.options.machineId }),
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!response.ok) {
      throw new Error(`bridge_control_ack_http_${String(response.status)}`);
    }
  }

  private async pushResult(commandId: string, result: BridgeControlCommandResult): Promise<void> {
    const response = await fetch(
      toUrl(this.options.baseUrl, toCommandPath(this.options.resultPathTemplate, commandId)),
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          machineId: this.options.machineId,
          result,
        }),
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!response.ok) {
      throw new Error(`bridge_control_result_http_${String(response.status)}`);
    }
  }

  private rememberReceipt(commandId: string, result: BridgeControlCommandResult): void {
    this.receipts.set(commandId, {
      commandId,
      machineId: this.options.machineId,
      result,
      storedAt: new Date().toISOString(),
    });
    this.saveReceipts();
  }

  private loadReceipts(): void {
    try {
      if (!fs.existsSync(this.options.receiptStateFile)) return;
      const raw = fs.readFileSync(this.options.receiptStateFile, 'utf-8');
      const parsed = JSON.parse(raw) as ReceiptStateFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.receipts)) return;
      for (const receipt of parsed.receipts) {
        this.receipts.set(receipt.commandId, receipt);
      }
    } catch {
      this.receipts.clear();
    }
  }

  private saveReceipts(): void {
    const dir = path.dirname(this.options.receiptStateFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const payload: ReceiptStateFile = {
      version: 1,
      receipts: [...this.receipts.values()].slice(-500),
    };
    const tmpPath = `${this.options.receiptStateFile}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.options.receiptStateFile);
  }

  private async executeCommand(command: BridgeControlCommand): Promise<void> {
    const receipt = this.receipts.get(command.id);
    if (receipt) {
      await this.pushResult(command.id, { ...receipt.result, duplicate: true });
      return;
    }
    await this.ackRunning(command.id);
    const result = await this.options.controller.execute(command);
    this.rememberReceipt(command.id, result);
    await this.pushResult(command.id, result);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    try {
      const command = await this.pollCommand();
      if (!command) return;
      await this.executeCommand(command);
      this.options.logger.info('bridge_control_command_processed', {
        commandId: command.id,
        intent: command.snapshot.intent,
      });
    } catch (error) {
      this.options.logger.warn('bridge_control_tick_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlight = false;
    }
  }
}
