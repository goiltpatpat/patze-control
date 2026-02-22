import { useEffect, useRef } from 'react';
import { useToast } from '../components/Toast';
import type { FrontendUnifiedSnapshot } from '../types';

const DEDUPE_TTL_MS = 120_000;

interface ToastEvent {
  key: string;
  severity: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

function diffEvents(
  prev: FrontendUnifiedSnapshot | null,
  next: FrontendUnifiedSnapshot | null
): ToastEvent[] {
  if (!next || !prev) return [];

  const events: ToastEvent[] = [];

  const prevMachineStatus = new Map(prev.machines.map((m) => [m.machineId, m.status]));
  for (const machine of next.machines) {
    const prevStatus = prevMachineStatus.get(machine.machineId);
    if (prevStatus && prevStatus !== 'offline' && machine.status === 'offline') {
      events.push({
        key: `${machine.machineId}:offline`,
        severity: 'warn',
        message: `Machine ${machine.name ?? machine.machineId} went offline`,
      });
    }
  }

  const prevRunStates = new Map(prev.runs.map((r) => [r.runId, r.state]));
  for (const run of next.runs) {
    const prevState = prevRunStates.get(run.runId);
    if (prevState && prevState !== 'failed' && run.state === 'failed') {
      events.push({
        key: `${run.runId}:failed`,
        severity: 'error',
        message: `Run ${run.runId} failed${run.failureReason ? `: ${run.failureReason.slice(0, 60)}` : ''}`,
      });
    }
  }

  const prevHealth = prev.health.overall;
  const nextHealth = next.health.overall;
  if (prevHealth === 'healthy' && (nextHealth === 'degraded' || nextHealth === 'critical')) {
    events.push({
      key: `health:${nextHealth}`,
      severity: 'warn',
      message: `System health degraded to ${nextHealth}`,
    });
  }

  return events;
}

export function useEventToasts(snapshot: FrontendUnifiedSnapshot | null): void {
  const { addToast } = useToast();
  const prevSnapshotRef = useRef<FrontendUnifiedSnapshot | null>(null);
  const seenRef = useRef(new Map<string, number>());

  useEffect(() => {
    const prev = prevSnapshotRef.current;
    prevSnapshotRef.current = snapshot;

    if (!prev || !snapshot) return;

    const events = diffEvents(prev, snapshot);
    const now = Date.now();
    const seen = seenRef.current;

    for (const [key, ts] of seen) {
      if (now - ts > DEDUPE_TTL_MS) {
        seen.delete(key);
      }
    }

    for (const event of events) {
      const lastFired = seen.get(event.key);
      if (lastFired && now - lastFired < DEDUPE_TTL_MS) {
        continue;
      }
      seen.set(event.key, now);
      addToast(event.severity, event.message);
    }
  }, [snapshot, addToast]);
}
