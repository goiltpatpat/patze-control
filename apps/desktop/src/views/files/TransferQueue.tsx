import { useState } from 'react';
import {
  IconChevronDown,
  IconChevronRight,
  IconUpload,
  IconDownload,
  IconX,
} from '../../components/Icons';
import type { TransferItem } from './types';

export interface TransferQueueProps {
  readonly items: readonly TransferItem[];
  readonly onClear: () => void;
}

export function TransferQueue(props: TransferQueueProps): JSX.Element {
  const { items, onClear } = props;
  const [collapsed, setCollapsed] = useState(false);

  const activeCount = items.filter((t) => t.status === 'active' || t.status === 'pending').length;

  if (items.length === 0) return <></>;

  return (
    <div className="fm-transfer-panel">
      <button className="fm-transfer-header" onClick={() => setCollapsed((c) => !c)}>
        {collapsed ? <IconChevronRight /> : <IconChevronDown />}
        <span className="fm-transfer-title">
          Transfers {activeCount > 0 ? `(${activeCount} active)` : ''}
        </span>
        <button
          className="fm-transfer-clear"
          title="Clear completed"
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
        >
          <IconX />
        </button>
      </button>
      {!collapsed && (
        <div className="fm-transfer-list">
          {items.map((item) => (
            <div key={item.id} className={`fm-transfer-item fm-transfer-${item.status}`}>
              <span className="fm-transfer-icon">
                {item.direction === 'upload' ? <IconUpload /> : <IconDownload />}
              </span>
              <span className="fm-transfer-name" title={item.name}>
                {item.name}
              </span>
              <span className="fm-transfer-status">
                {item.status === 'active' ? (
                  <span className="fm-transfer-progress">
                    <span
                      className="fm-transfer-bar"
                      style={{ width: `${Math.round(item.progress * 100)}%` }}
                    />
                  </span>
                ) : item.status === 'done' ? (
                  'done'
                ) : item.status === 'error' ? (
                  <span className="fm-transfer-error" title={item.error}>
                    error
                  </span>
                ) : (
                  'pending'
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
