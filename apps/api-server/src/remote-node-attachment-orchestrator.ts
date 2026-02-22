import {
  SseSourceAdapter,
  TelemetryAggregator,
  TelemetryNode,
  type MachineEndpoint,
  type SseSourceAdapterOptions,
} from '@patze/telemetry-core';
import { SshTunnelRuntime, type TunnelInfo } from './ssh-tunnel-runtime.js';

export interface RemoteAttachmentInfo {
  endpointId: string;
  nodeId: string;
  sshUser: string;
  tunnel: TunnelInfo;
  attachedAt: string;
}

interface RemoteAttachment {
  endpointId: string;
  nodeId: string;
  endpoint: MachineEndpoint;
  tunnel: TunnelInfo;
  node: TelemetryNode;
  source: SseSourceAdapter;
  unsubscribeSource: () => void;
  attachedAt: string;
}

function buildAuthHeader(endpoint: MachineEndpoint): Record<string, string> {
  if (endpoint.auth?.mode === 'token' && endpoint.auth.token) {
    return {
      Authorization: `Bearer ${endpoint.auth.token}`,
    };
  }

  return {};
}

function buildHealthUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = '/health';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export class RemoteNodeAttachmentOrchestrator {
  private readonly tunnelRuntime: SshTunnelRuntime;

  private readonly aggregator: TelemetryAggregator;

  private readonly attachments = new Map<string, RemoteAttachment>();

  private readonly unsubscribeTunnelClosed: () => void;

  public constructor(tunnelRuntime: SshTunnelRuntime, aggregator: TelemetryAggregator) {
    this.tunnelRuntime = tunnelRuntime;
    this.aggregator = aggregator;

    this.unsubscribeTunnelClosed = this.tunnelRuntime.onTunnelClosed((endpointId) => {
      void this.detachEndpoint(endpointId, { closeTunnel: false });
    });
  }

  public async attachEndpoint(endpoint: MachineEndpoint): Promise<RemoteAttachmentInfo> {
    const existing = this.attachments.get(endpoint.id);
    if (existing) {
      return this.toInfo(existing);
    }

    const tunnel = await this.tunnelRuntime.openTunnel(endpoint);

    try {
      await this.ensureHealthy(endpoint, tunnel);

      const mirrorNode = new TelemetryNode();
      const nodeId = `remote:${endpoint.id}`;
      this.aggregator.attachNode(nodeId, mirrorNode);

      const sseEndpoint: MachineEndpoint = {
        id: endpoint.id,
        label: endpoint.label,
        transport: 'sse',
        baseUrl: tunnel.localBaseUrl,
        ...(endpoint.auth ? { auth: endpoint.auth } : {}),
      };

      const sourceOptions: SseSourceAdapterOptions = {
        endpoint: sseEndpoint,
      };

      const source = new SseSourceAdapter(sourceOptions);
      const unsubscribeSource = source.onEvent((event) => {
        const result = mirrorNode.ingest(event);
        if (!result.ok) {
          return;
        }
      });

      source.start();

      const attachment: RemoteAttachment = {
        endpointId: endpoint.id,
        nodeId,
        endpoint,
        tunnel,
        node: mirrorNode,
        source,
        unsubscribeSource,
        attachedAt: new Date().toISOString(),
      };

      this.attachments.set(endpoint.id, attachment);
      return this.toInfo(attachment);
    } catch (error) {
      await this.tunnelRuntime.closeTunnel(endpoint.id);
      throw error;
    }
  }

  public async detachEndpoint(
    endpointId: string,
    options: { closeTunnel?: boolean } = {}
  ): Promise<void> {
    const attachment = this.attachments.get(endpointId);
    if (!attachment) {
      if (options.closeTunnel) {
        await this.tunnelRuntime.closeTunnel(endpointId);
      }
      return;
    }

    this.attachments.delete(endpointId);
    attachment.source.stop();
    attachment.unsubscribeSource();
    this.aggregator.detachNode(attachment.nodeId);

    if (options.closeTunnel ?? true) {
      await this.tunnelRuntime.closeTunnel(endpointId);
    }
  }

  public listAttachments(): readonly RemoteAttachmentInfo[] {
    return Object.freeze(
      Array.from(this.attachments.values())
        .map((attachment) => this.toInfo(attachment))
        .sort((left, right) => left.endpointId.localeCompare(right.endpointId))
    );
  }

  public getEndpointConfig(endpointId: string): MachineEndpoint | null {
    const attachment = this.attachments.get(endpointId);
    return attachment ? { ...attachment.endpoint } : null;
  }

  public async close(): Promise<void> {
    const endpointIds = Array.from(this.attachments.keys());
    for (const endpointId of endpointIds) {
      await this.detachEndpoint(endpointId, { closeTunnel: true });
    }
    this.unsubscribeTunnelClosed();
  }

  private toInfo(attachment: RemoteAttachment): RemoteAttachmentInfo {
    return Object.freeze({
      endpointId: attachment.endpointId,
      nodeId: attachment.nodeId,
      sshUser: attachment.endpoint.ssh?.user ?? '',
      tunnel: attachment.tunnel,
      attachedAt: attachment.attachedAt,
    });
  }

  private static readonly HEALTH_CHECK_TIMEOUT_MS = 5_000;

  private async ensureHealthy(endpoint: MachineEndpoint, tunnel: TunnelInfo): Promise<void> {
    const healthUrl = buildHealthUrl(tunnel.localBaseUrl);
    const response = await fetch(healthUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...buildAuthHeader(endpoint),
      },
      signal: AbortSignal.timeout(RemoteNodeAttachmentOrchestrator.HEALTH_CHECK_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `Remote health check failed for endpoint '${endpoint.id}' with status ${response.status}.`
      );
    }

    const payload: unknown = await response.json();
    if (typeof payload !== 'object' || payload === null || !('ok' in payload)) {
      throw new Error(`Remote health payload for endpoint '${endpoint.id}' is invalid.`);
    }

    const ok = (payload as { ok: unknown }).ok;
    if (ok !== true) {
      throw new Error(`Remote endpoint '${endpoint.id}' is unhealthy.`);
    }
  }
}
