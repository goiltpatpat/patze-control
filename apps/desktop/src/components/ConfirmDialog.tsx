import { useCallback, useEffect, useRef } from 'react';

export interface ConfirmDialogProps {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string | undefined;
  readonly cancelLabel?: string | undefined;
  readonly variant?: 'default' | 'danger' | 'warn' | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps): JSX.Element {
  const {
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    variant = 'default',
    onConfirm,
    onCancel,
  } = props;

  const dialogRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    },
    [onCancel]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    dialogRef.current?.querySelector<HTMLButtonElement>('.confirm-dialog-cancel')?.focus();
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const confirmBtnClass =
    variant === 'danger'
      ? 'confirm-dialog-btn confirm-dialog-btn-danger'
      : variant === 'warn'
        ? 'confirm-dialog-btn confirm-dialog-btn-warn'
        : 'confirm-dialog-btn confirm-dialog-btn-primary';

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="confirm-dialog-card"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="confirm-dialog-title">{title}</h3>
        <p className="confirm-dialog-message">{message}</p>
        <div className="confirm-dialog-actions">
          <button type="button" className="confirm-dialog-cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className={confirmBtnClass} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
