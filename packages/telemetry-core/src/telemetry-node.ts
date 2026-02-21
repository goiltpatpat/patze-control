import type { AnyTelemetryEvent } from './events.js';
import { InMemoryEventStore, type EventStore } from './event-store.js';
import {
  DefaultTelemetryIngestor,
  type BatchIngestResult,
  type IngestResult,
  type TelemetryIngestor,
} from './ingestor.js';
import { TelemetryProjector, type TelemetrySnapshot } from './projections.js';
import type { TelemetryEventListener } from './event-bus.js';

export interface TelemetryNodeLike {
  ingest(event: unknown): IngestResult;
  ingestMany(events: readonly unknown[]): BatchIngestResult;
  subscribe(listener: TelemetryEventListener): () => void;
  getSnapshot(): TelemetrySnapshot;
  getEventLog(): readonly Readonly<AnyTelemetryEvent>[];
}

export class TelemetryNode implements TelemetryNodeLike {
  private readonly eventStore: EventStore;

  private readonly ingestor: TelemetryIngestor;

  private readonly projector: TelemetryProjector;

  private readonly unbindProjector: () => void;

  public constructor() {
    this.eventStore = new InMemoryEventStore();
    this.projector = new TelemetryProjector();
    this.unbindProjector = this.projector.bindToStore(this.eventStore);
    this.ingestor = new DefaultTelemetryIngestor(this.eventStore);
  }

  public ingest(event: unknown): IngestResult {
    return this.ingestor.ingest(event);
  }

  public ingestMany(events: readonly unknown[]): BatchIngestResult {
    return this.ingestor.ingestMany(events);
  }

  public subscribe(listener: TelemetryEventListener): () => void {
    this.eventStore.subscribe(listener);
    return (): void => {
      this.eventStore.unsubscribe(listener);
    };
  }

  public getSnapshot(): TelemetrySnapshot {
    return this.projector.snapshot();
  }

  public getEventLog(): readonly Readonly<AnyTelemetryEvent>[] {
    return [...this.eventStore.getLog()];
  }

  public dispose(): void {
    this.unbindProjector();
  }
}
