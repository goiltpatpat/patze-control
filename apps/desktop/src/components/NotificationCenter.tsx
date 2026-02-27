import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AppNotification, UseNotificationsResult } from '../hooks/useNotifications';
import {
  IconAlertTriangle,
  IconBell,
  IconCheck,
  IconCheckAll,
  IconCheckCircle,
  IconInfo,
  IconTrash,
  IconX,
  IconXCircle,
} from './Icons';
import { navigate } from '../shell/routes';
import type { AppRoute } from '../shell/routes';

export interface NotificationCenterProps {
  readonly notifications: UseNotificationsResult;
}

const TYPE_CONFIG: Record<
  AppNotification['type'],
  { icon: (p: { width?: number; height?: number }) => JSX.Element; color: string; bg: string }
> = {
  info: { icon: IconInfo, color: 'var(--blue)', bg: 'var(--blue-soft)' },
  success: { icon: IconCheckCircle, color: 'var(--green)', bg: 'var(--green-soft)' },
  warning: { icon: IconAlertTriangle, color: 'var(--amber)', bg: 'var(--amber-soft)' },
  error: { icon: IconXCircle, color: 'var(--red)', bg: 'var(--red-soft)' },
};

function formatRelativeShort(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

export function NotificationCenter(props: NotificationCenterProps): JSX.Element {
  const { notifications, unreadCount, markRead, markAllRead, deleteNotification, clearRead } =
    props.notifications;
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; left: number } | null>(
    null
  );
  const [keyboardIndex, setKeyboardIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(e: MouseEvent): void {
      const target = e.target as Node;
      if (
        rootRef.current &&
        !rootRef.current.contains(target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const bell = bellRef.current;
    if (!bell) return;

    const recalc = (): void => {
      const rect = bell.getBoundingClientRect();
      const dropdownWidth = 380;
      const viewportPadding = 12;
      const left = Math.max(
        viewportPadding,
        Math.min(window.innerWidth - dropdownWidth - viewportPadding, rect.right - dropdownWidth)
      );
      const top = Math.min(rect.bottom + 8, window.innerHeight - 12);
      setDropdownPosition({ top, left });
    };

    recalc();
    window.addEventListener('resize', recalc);
    window.addEventListener('scroll', recalc, true);
    return () => {
      window.removeEventListener('resize', recalc);
      window.removeEventListener('scroll', recalc, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const nextIndex = notifications.findIndex((n) => !n.read);
    setKeyboardIndex(nextIndex >= 0 ? nextIndex : 0);
  }, [isOpen, notifications]);

  useEffect(() => {
    if (!isOpen) return;
    const active = dropdownRef.current?.querySelector<HTMLElement>(
      `[data-notification-index="${String(keyboardIndex)}"]`
    );
    active?.scrollIntoView({ block: 'nearest' });
  }, [isOpen, keyboardIndex]);

  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        bellRef.current?.focus();
        return;
      }
      if (notifications.length === 0) return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setKeyboardIndex((prev) => (prev + 1) % notifications.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setKeyboardIndex((prev) => (prev - 1 + notifications.length) % notifications.length);
        return;
      }
      if (event.key !== 'Enter' && event.key !== ' ') return;

      event.preventDefault();
      const item = notifications[keyboardIndex];
      if (!item) return;
      if (!item.read) markRead(item.id);
      if (item.action?.kind === 'navigate') {
        navigate(
          item.action.route as AppRoute,
          item.action.params as Record<string, string> | undefined
        );
        setIsOpen(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, keyboardIndex, notifications, markRead]);

  return (
    <div style={{ position: 'relative' }} ref={rootRef}>
      {/* Bell Button */}
      <button
        ref={bellRef}
        className={`notification-bell${unreadCount > 0 ? ' has-unread' : ''}`}
        onClick={() => {
          setIsOpen((prev) => !prev);
        }}
        title={unreadCount > 0 ? `${String(unreadCount)} unread notifications` : 'Notifications'}
      >
        <IconBell width={16} height={16} />
        {unreadCount > 0 ? (
          <span className="notification-badge">{unreadCount > 9 ? '9+' : String(unreadCount)}</span>
        ) : null}
      </button>

      {/* Dropdown */}
      {isOpen && dropdownPosition
        ? createPortal(
            <div
              ref={dropdownRef}
              className="notification-dropdown notification-dropdown-portal"
              style={{ top: dropdownPosition.top, left: dropdownPosition.left }}
            >
              {/* Header */}
              <div className="notification-header">
                <div>
                  <h3 className="notification-header-title">Notifications</h3>
                  <p className="notification-header-meta">
                    {unreadCount > 0 ? `${String(unreadCount)} unread` : 'All caught up!'}
                  </p>
                </div>
                <div className="notification-header-actions">
                  {unreadCount > 0 ? (
                    <button
                      className="notification-action-btn"
                      title="Mark all as read"
                      onClick={markAllRead}
                    >
                      <IconCheckAll width={14} height={14} />
                    </button>
                  ) : null}
                  {notifications.some((n) => n.read) ? (
                    <button
                      className="notification-action-btn"
                      title="Clear read notifications"
                      onClick={clearRead}
                    >
                      <IconTrash width={14} height={14} />
                    </button>
                  ) : null}
                </div>
              </div>

              {/* List */}
              <div className="notification-list">
                {notifications.length === 0 ? (
                  <div className="notification-empty">
                    <IconBell width={36} height={36} />
                    <span style={{ fontSize: 13 }}>No notifications yet</span>
                  </div>
                ) : (
                  notifications.map((notif, index) => {
                    const config = TYPE_CONFIG[notif.type];
                    const TypeIcon = config.icon;
                    const hasAction = notif.action?.kind === 'navigate';

                    const handleClick = (): void => {
                      if (hasAction && notif.action) {
                        markRead(notif.id);
                        navigate(
                          notif.action.route as AppRoute,
                          notif.action.params as Record<string, string> | undefined
                        );
                        setIsOpen(false);
                      }
                    };

                    return (
                      <div
                        key={notif.id}
                        className={`notification-item${notif.read ? '' : ' unread'}${hasAction ? ' notification-item-clickable' : ''}${keyboardIndex === index ? ' notification-item-keyboard-focus' : ''}`}
                        data-notification-index={index}
                        onClick={hasAction ? handleClick : undefined}
                        onMouseEnter={() => {
                          setKeyboardIndex(index);
                        }}
                        role={hasAction ? 'button' : undefined}
                        tabIndex={hasAction ? 0 : undefined}
                      >
                        <div
                          className="notification-item-icon"
                          style={{ background: config.bg, color: config.color }}
                        >
                          <TypeIcon width={15} height={15} />
                        </div>
                        <div className="notification-item-body">
                          <div className="notification-item-title-row">
                            <span className="notification-item-title">{notif.title}</span>
                            {!notif.read ? <span className="notification-unread-dot" /> : null}
                          </div>
                          <p className="notification-item-message">{notif.message}</p>
                          <div className="notification-item-footer">
                            <span className="notification-item-time">
                              {formatRelativeShort(notif.timestamp)}
                            </span>
                            <div className="notification-item-actions">
                              {!notif.read ? (
                                <button
                                  className="notification-item-action action-read"
                                  title="Mark as read"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    markRead(notif.id);
                                  }}
                                >
                                  <IconCheck width={12} height={12} />
                                </button>
                              ) : null}
                              <button
                                className="notification-item-action action-delete"
                                title="Delete"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deleteNotification(notif.id);
                                }}
                              >
                                <IconX width={12} height={12} />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
