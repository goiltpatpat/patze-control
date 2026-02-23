import { useMemo } from 'react';

export interface DiffViewerProps {
  readonly before: string;
  readonly after: string;
  readonly title?: string | undefined;
}

interface DiffLine {
  readonly type: 'same' | 'added' | 'removed';
  readonly text: string;
  readonly lineNum: number;
}

function computeDiffLines(before: string, after: string): readonly DiffLine[] {
  const bLines = before.split('\n');
  const aLines = after.split('\n');
  const result: DiffLine[] = [];
  const maxLen = Math.max(bLines.length, aLines.length);

  for (let i = 0; i < maxLen; i++) {
    const bLine = i < bLines.length ? bLines[i] : undefined;
    const aLine = i < aLines.length ? aLines[i] : undefined;

    if (bLine === aLine) {
      result.push({ type: 'same', text: bLine ?? '', lineNum: i + 1 });
    } else {
      if (bLine !== undefined) {
        result.push({ type: 'removed', text: bLine, lineNum: i + 1 });
      }
      if (aLine !== undefined) {
        result.push({ type: 'added', text: aLine, lineNum: i + 1 });
      }
    }
  }
  return result;
}

export function DiffViewer(props: DiffViewerProps): JSX.Element {
  const lines = useMemo(() => computeDiffLines(props.before, props.after), [props.before, props.after]);

  return (
    <div className="diff-viewer">
      {props.title ? <div className="diff-viewer-title">{props.title}</div> : null}
      <pre className="diff-viewer-content">
        {lines.map((line, i) => (
          <div
            key={i}
            className={`diff-line diff-line-${line.type}`}
          >
            <span className="diff-line-num">{line.lineNum}</span>
            <span className="diff-line-prefix">
              {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
            </span>
            <span className="diff-line-text">{line.text}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
