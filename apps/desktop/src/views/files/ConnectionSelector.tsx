import { IconPlus, IconServer, IconTunnel } from '../../components/Icons';
import type { FileConnection } from './types';

export interface ConnectionSelectorProps {
  readonly connections: readonly FileConnection[];
  readonly selected: string | null;
  readonly onSelect: (id: string) => void;
  readonly onAddConnection: () => void;
}

export function ConnectionSelector(props: ConnectionSelectorProps): JSX.Element {
  const { connections, selected, onSelect, onAddConnection } = props;

  return (
    <div className="fm-conn-selector">
      <select
        className="fm-conn-select"
        value={selected ?? ''}
        onChange={(e) => {
          if (e.target.value) onSelect(e.target.value);
        }}
      >
        <option value="" disabled>
          Select connection...
        </option>
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.type === 'bridge' ? '🔗 ' : '🖥 '}
            {c.label} ({c.status})
          </option>
        ))}
      </select>
      <button className="fm-btn fm-btn-icon" onClick={onAddConnection} title="Add SSH Connection">
        <IconPlus />
      </button>
      {selected && (
        <span className="fm-conn-info">
          {connections.find((c) => c.id === selected)?.type === 'bridge' ? (
            <IconTunnel className="fm-conn-type-icon" />
          ) : (
            <IconServer className="fm-conn-type-icon" />
          )}
        </span>
      )}
    </div>
  );
}
