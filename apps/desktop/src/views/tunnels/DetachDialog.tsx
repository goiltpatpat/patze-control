import { useFocusTrap } from '../../hooks/useFocusTrap';

export function DetachDialog(props: {
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): JSX.Element {
  const { containerRef: dialogRef, handleKeyDown } = useFocusTrap(props.onCancel);

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="detach-dialog-title"
      onKeyDown={handleKeyDown}
    >
      <div className="dialog-card" ref={dialogRef}>
        <h3 id="detach-dialog-title">Disconnect endpoint?</h3>
        <p>This will close the current connection. You can re-connect at any time.</p>
        <div className="actions">
          <button className="btn-secondary" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="btn-danger" onClick={props.onConfirm}>
            Confirm Disconnect
          </button>
        </div>
      </div>
    </div>
  );
}
