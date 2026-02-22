import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

export type ToastSeverity = 'info' | 'success' | 'warn' | 'error';

export interface ToastItem {
  readonly id: string;
  readonly severity: ToastSeverity;
  readonly message: string;
}

interface ToastContextValue {
  toasts: readonly ToastItem[];
  addToast: (severity: ToastSeverity, message: string) => void;
  removeToast: (id: string) => void;
}

const TOAST_DURATION_MS = 5_000;
const MAX_TOASTS = 5;

const ToastContext = createContext<ToastContextValue>({
  toasts: [],
  addToast: () => {},
  removeToast: () => {},
});

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

export function ToastProvider(props: { readonly children: React.ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const counterRef = useRef(0);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (severity: ToastSeverity, message: string) => {
      const id = `toast_${String(++counterRef.current)}`;
      setToasts((prev) => {
        const next = [...prev, { id, severity, message }];
        return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
      });
      setTimeout(() => {
        removeToast(id);
      }, TOAST_DURATION_MS);
    },
    [removeToast]
  );

  const value = useMemo(() => ({ toasts, addToast, removeToast }), [toasts, addToast, removeToast]);

  return (
    <ToastContext.Provider value={value}>
      {props.children}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  );
}

function severityClass(severity: ToastSeverity): string {
  switch (severity) {
    case 'info':
      return 'toast-info';
    case 'success':
      return 'toast-success';
    case 'warn':
      return 'toast-warn';
    case 'error':
      return 'toast-error';
  }
}

function ToastContainer(props: {
  readonly toasts: readonly ToastItem[];
  readonly onDismiss: (id: string) => void;
}): JSX.Element | null {
  if (props.toasts.length === 0) {
    return null;
  }

  return (
    <div className="toast-container" role="status" aria-live="polite">
      {props.toasts.map((toast) => (
        <div key={toast.id} className={`toast-item ${severityClass(toast.severity)}`}>
          <span className="toast-message">{toast.message}</span>
          <button
            className="toast-dismiss"
            onClick={() => {
              props.onDismiss(toast.id);
            }}
            aria-label="Dismiss"
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
