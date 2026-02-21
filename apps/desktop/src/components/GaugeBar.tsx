export interface GaugeBarProps {
  readonly label: string;
  readonly value: number;
  readonly max?: number;
  readonly unit?: string;
  readonly formatValue?: (value: number) => string;
}

function getTone(pct: number): string {
  if (pct >= 90) {
    return 'bad';
  }
  if (pct >= 70) {
    return 'warn';
  }
  return 'good';
}

export function GaugeBar(props: GaugeBarProps): JSX.Element {
  const max = props.max ?? 100;
  const pct = max > 0 ? Math.min(100, (props.value / max) * 100) : 0;
  const tone = getTone(pct);
  const displayValue = props.formatValue ? props.formatValue(props.value) : `${pct.toFixed(0)}%`;

  return (
    <div className="gauge-bar">
      <div className="gauge-bar-header">
        <span className="gauge-bar-label">{props.label}</span>
        <span className={`gauge-bar-value gauge-tone-${tone}`}>
          {displayValue}
          {props.unit ? ` ${props.unit}` : null}
        </span>
      </div>
      <div className="gauge-bar-track">
        <div
          className={`gauge-bar-fill gauge-tone-${tone}`}
          style={{ width: `${String(pct)}%` }}
        />
      </div>
    </div>
  );
}
