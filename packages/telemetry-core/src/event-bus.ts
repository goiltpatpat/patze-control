import type { AnyTelemetryEvent } from './events.js';

export type TelemetryEventListener = (event: Readonly<AnyTelemetryEvent>) => void;

export interface EventBus {
  subscribe(listener: TelemetryEventListener): void;
  unsubscribe(listener: TelemetryEventListener): void;
  emit(event: Readonly<AnyTelemetryEvent>): void;
}

export class InMemoryEventBus implements EventBus {
  private readonly listeners = new Set<TelemetryEventListener>();

  public subscribe(listener: TelemetryEventListener): void {
    this.listeners.add(listener);
  }

  public unsubscribe(listener: TelemetryEventListener): void {
    this.listeners.delete(listener);
  }

  public emit(event: Readonly<AnyTelemetryEvent>): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Prevent a failing listener from blocking others.
      }
    }
  }
}
