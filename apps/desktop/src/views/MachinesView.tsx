import { useState } from 'react';
import { FilterTabs, type FilterTab } from '../components/FilterTabs';
import { GaugeBar } from '../components/GaugeBar';
import { IconServer } from '../components/Icons';
import { HealthBadge } from '../components/badges/HealthBadge';
import { StateBadge } from '../components/badges/StateBadge';
import { navigate, type RouteFilter } from '../shell/routes';
import type { FrontendUnifiedSnapshot } from '../types';
import { formatBytes, formatRelativeTime } from '../utils/time';

export interface MachinesViewProps {
  readonly snapshot: FrontendUnifiedSnapshot | null;
  readonly filter: RouteFilter;
}

type MachineFilter = 'all' | 'local' | 'vps' | 'offline';

export function MachinesView(props: MachinesViewProps): JSX.Element {
  const [filter, setFilter] = useState<MachineFilter>('all');
  const machines = props.snapshot?.machines ?? [];
  const healthMap = new Map(
    (props.snapshot?.health.machines ?? []).map((h) => [h.machineId, h])
  );

  const localCount = machines.filter((m) => m.kind === 'local').length;
  const vpsCount = machines.filter((m) => m.kind === 'vps').length;
  const offlineCount = machines.filter((m) => m.status === 'offline').length;

  const tabs: ReadonlyArray<FilterTab<MachineFilter>> = [
    { id: 'all', label: 'All', count: machines.length },
    { id: 'local', label: 'Local', count: localCount },
    { id: 'vps', label: 'VPS', count: vpsCount },
    { id: 'offline', label: 'Offline', count: offlineCount },
  ];

  const filtered = machines.filter((m) => {
    switch (filter) {
      case 'local': return m.kind === 'local';
      case 'vps': return m.kind === 'vps';
      case 'offline': return m.status === 'offline';
      case 'all': return true;
    }
  });

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Machines</h2>
        <FilterTabs tabs={tabs} active={filter} onChange={setFilter} />
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><IconServer width={28} height={28} /></div>
          {machines.length === 0
            ? 'No machines registered. Connect to a control plane to see machines.'
            : 'No machines match the current filter.'}
        </div>
      ) : (
        <div className="machine-grid">
          {filtered.map((machine) => {
            const health = healthMap.get(machine.machineId);
            const resource = machine.lastResource;
            return (
              <div
                key={machine.machineId}
                className="machine-card machine-card-clickable"
                role="button"
                tabIndex={0}
                onClick={() => { navigate('sessions', { machineId: machine.machineId }); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    navigate('sessions', { machineId: machine.machineId });
                  }
                }}
              >
                <div className="machine-card-header">
                  <div className="machine-card-title">
                    <span className="machine-card-name">
                      {machine.name ?? machine.machineId}
                    </span>
                    {machine.name ? (
                      <span className="machine-card-id">{machine.machineId}</span>
                    ) : null}
                  </div>
                  <StateBadge value={machine.status} />
                </div>

                <div className="machine-card-meta">
                  <div className="machine-card-meta-item">
                    <span className="machine-card-meta-label">Kind</span>
                    <span className="machine-card-meta-value">
                      {machine.kind ? (
                        <span className="kind-badge">{machine.kind}</span>
                      ) : '—'}
                    </span>
                  </div>
                  <div className="machine-card-meta-item">
                    <span className="machine-card-meta-label">Last Seen</span>
                    <span className="machine-card-meta-value">
                      {formatRelativeTime(machine.lastSeenAt)}
                    </span>
                  </div>
                  <div className="machine-card-meta-item">
                    <span className="machine-card-meta-label">Health</span>
                    <span className="machine-card-meta-value">
                      {health ? <HealthBadge health={health.status} /> : '—'}
                    </span>
                  </div>
                  <div className="machine-card-meta-item">
                    <span className="machine-card-meta-label">Active Runs</span>
                    <span className={`machine-card-meta-value${(health?.activeRunCount ?? 0) > 0 ? ' metric-active' : ''}`}>
                      {String(health?.activeRunCount ?? 0)}
                    </span>
                  </div>
                </div>

                {resource ? (
                  <div className="machine-card-gauges">
                    <GaugeBar label="CPU" value={resource.cpuPct} />
                    <GaugeBar
                      label="Memory"
                      value={resource.memoryPct}
                      formatValue={() => `${resource.memoryPct.toFixed(0)}% (${formatBytes(resource.memoryBytes)})`}
                    />
                    {resource.diskPct !== undefined ? (
                      <GaugeBar
                        label="Disk"
                        value={resource.diskPct}
                        formatValue={() =>
                          `${resource.diskPct!.toFixed(0)}%${resource.diskUsageBytes !== undefined && resource.diskTotalBytes !== undefined ? ` (${formatBytes(resource.diskUsageBytes)} / ${formatBytes(resource.diskTotalBytes)})` : ''}`
                        }
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
