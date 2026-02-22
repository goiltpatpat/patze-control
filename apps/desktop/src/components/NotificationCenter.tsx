import { useEffect, useRef, useState } from 'react';
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
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(e: MouseEvent): void {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div style={{ position: 'relative' }} ref={dropdownRef}>
      {/* Bell Button */}
      <button
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
      {isOpen ? (
        <div className="notification-dropdown">
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
              notifications.map((notif) => {
                const config = TYPE_CONFIG[notif.type];
                const TypeIcon = config.icon;

                return (
                  <div key={notif.id} className={`notification-item${notif.read ? '' : ' unread'}`}>
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
                              onClick={() => {
                                markRead(notif.id);
                              }}
                            >
                              <IconCheck width={12} height={12} />
                            </button>
                          ) : null}
                          <button
                            className="notification-item-action action-delete"
                            title="Delete"
                            onClick={() => {
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
        </div>
      ) : null}
    </div>
  );
}
