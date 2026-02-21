import type { AnyTelemetryEvent, TelemetryEvent, TelemetryEventType } from './events.js';
import { InMemoryEventBus, type EventBus, type TelemetryEventListener } from './event-bus.js';
import { deepFreeze } from './utils.js';

export interface EventStore {
  append<TType extends TelemetryEventType>(
    event: TelemetryEvent<TType>
  ): Readonly<TelemetryEvent<TType>>;
  appendMany(events: readonly AnyTelemetryEvent[]): readonly Readonly<AnyTelemetryEvent>[];
  getLog(): readonly Readonly<AnyTelemetryEvent>[];
  subscribe(listener: TelemetryEventListener): void;
  unsubscribe(listener: TelemetryEventListener): void;
}

function cloneAndFreezeEvent<TType extends TelemetryEventType>(
  event: TelemetryEvent<TType>
): Readonly<TelemetryEvent<TType>> {
  return deepFreeze(structuredClone(event));
}

const DEFAULT_MAX_LOG_SIZE = 100_000;

export interface EventStoreOptions {
  bus?: EventBus;
  maxLogSize?: number;
}

export class InMemoryEventStore implements EventStore {
  private readonly log: AnyTelemetryEvent[] = [];

  private readonly bus: EventBus;

  private readonly maxLogSize: number;

  public constructor(options: EventStoreOptions = {}) {
    this.bus = options.bus ?? new InMemoryEventBus();
    this.maxLogSize = options.maxLogSize ?? DEFAULT_MAX_LOG_SIZE;
  }

  public append<TType extends TelemetryEventType>(
    event: TelemetryEvent<TType>
  ): Readonly<TelemetryEvent<TType>> {
    const immutableEvent = cloneAndFreezeEvent(event);
    const storedEvent = immutableEvent as Readonly<AnyTelemetryEvent>;
    this.log.push(storedEvent);
    this.evictIfNeeded();
    this.bus.emit(storedEvent);
    return immutableEvent;
  }

  public appendMany(events: readonly AnyTelemetryEvent[]): readonly Readonly<AnyTelemetryEvent>[] {
    const appended: Readonly<AnyTelemetryEvent>[] = [];
    for (const event of events) {
      const immutableEvent = cloneAndFreezeEvent(event);
      const storedEvent = immutableEvent as Readonly<AnyTelemetryEvent>;
      this.log.push(storedEvent);
      appended.push(immutableEvent as Readonly<AnyTelemetryEvent>);
    }
    this.evictIfNeeded();
    for (const event of appended) {
      this.bus.emit(event);
    }
    return appended;
  }

  private evictIfNeeded(): void {
    if (this.log.length > this.maxLogSize) {
      const excess = this.log.length - this.maxLogSize;
      this.log.splice(0, excess);
    }
  }

  public getLog(): readonly Readonly<AnyTelemetryEvent>[] {
    return this.log;
  }

  public subscribe(listener: TelemetryEventListener): void {
    this.bus.subscribe(listener);
  }

  public unsubscribe(listener: TelemetryEventListener): void {
    this.bus.unsubscribe(listener);
  }
}
