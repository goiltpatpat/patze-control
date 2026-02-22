import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export interface NotificationAction {
  readonly kind: 'navigate';
  readonly route: string;
  readonly params?: Record<string, string>;
}

export interface AppNotification {
  readonly id: string;
  readonly timestamp: number;
  readonly type: NotificationType;
  readonly title: string;
  readonly message: string;
  readonly action?: NotificationAction | undefined;
  read: boolean;
}

const STORAGE_KEY = 'patze_notifications';
const MAX_NOTIFICATIONS = 100;

function isValidNotification(value: unknown): value is AppNotification {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.timestamp === 'number' &&
    typeof obj.type === 'string' &&
    typeof obj.title === 'string' &&
    typeof obj.message === 'string' &&
    typeof obj.read === 'boolean'
  );
}

function isValidAction(value: unknown): value is NotificationAction {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj.kind === 'navigate' && typeof obj.route === 'string';
}

function loadNotifications(): AppNotification[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidNotification);
  } catch {
    return [];
  }
}

function saveNotifications(items: readonly AppNotification[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_NOTIFICATIONS)));
  } catch {
    /* storage full */
  }
}

let idCounter = 0;

export interface UseNotificationsResult {
  readonly notifications: readonly AppNotification[];
  readonly unreadCount: number;
  readonly addNotification: (
    type: NotificationType,
    title: string,
    message: string,
    action?: NotificationAction
  ) => void;
  readonly markRead: (id: string) => void;
  readonly markAllRead: () => void;
  readonly deleteNotification: (id: string) => void;
  readonly clearRead: () => void;
}

export function useNotifications(): UseNotificationsResult {
  const [notifications, setNotifications] = useState<AppNotification[]>(() => loadNotifications());
  const notificationsRef = useRef(notifications);
  notificationsRef.current = notifications;

  // Persist whenever notifications change
  useEffect(() => {
    saveNotifications(notifications);
  }, [notifications]);

  const unreadCount = useMemo(() => notifications.filter((n) => !n.read).length, [notifications]);

  const addNotification = useCallback(
    (type: NotificationType, title: string, message: string, action?: NotificationAction) => {
      const id = `notif_${Date.now()}_${String(++idCounter)}`;
      const item: AppNotification = {
        id,
        timestamp: Date.now(),
        type,
        title,
        message,
        action: action && isValidAction(action) ? action : undefined,
        read: false,
      };
      setNotifications((prev) => {
        const next = [item, ...prev];
        return next.length > MAX_NOTIFICATIONS ? next.slice(0, MAX_NOTIFICATIONS) : next;
      });
    },
    []
  );

  const markRead = useCallback((id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const deleteNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const clearRead = useCallback(() => {
    setNotifications((prev) => prev.filter((n) => !n.read));
  }, []);

  return {
    notifications,
    unreadCount,
    addNotification,
    markRead,
    markAllRead,
    deleteNotification,
    clearRead,
  };
}
