import { useEffect, useRef, useState } from 'react';
import type { AppInfo } from './types.ts';
import { useI18n } from './i18n.tsx';
import {
  IconCheck,
  IconChevronDown,
  IconCross,
  IconHistoryServer,
  IconRefresh,
  IconSearch,
} from './Icons.tsx';

interface AppSelectProps {
  apps: AppInfo[];
  selectedId: string;
  onSelect: (appId: string) => void;
  loading?: boolean;
  onRefresh?: () => void;
}

export function AppSelect({ apps, selectedId, onSelect, loading, onRefresh }: AppSelectProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const selectedApp = apps.find((a) => a.id === selectedId);

  // Close when clicking outside
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  // Focus search input when popover opens
  useEffect(() => {
    if (open) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    } else {
      setQuery('');
    }
  }, [open]);

  const filteredApps = apps.filter((a) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      a.id.toLowerCase().includes(q) ||
      a.name.toLowerCase().includes(q) ||
      (a.user && a.user.toLowerCase().includes(q))
    );
  });

  return (
    <div className="custom-app-select" ref={containerRef}>
      {/* Trigger Button */}
      <div
        className={`app-select-trigger ${open ? 'focused' : ''} ${selectedApp ? 'has-value' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="trigger-icon">
          <IconHistoryServer width={16} height={16} />
        </span>

        <div className="trigger-content">
          {selectedApp ? (
            <div className="selected-app-view">
              <span className="selected-name">{selectedApp.name}</span>
              <span className="selected-id mono">{selectedApp.id}</span>
              <span className={`status-pill ${selectedApp.completed ? 'completed' : 'running'}`}>
                {selectedApp.completed ? t.completed : t.runningState}
              </span>
              {selectedApp.durationMs !== undefined && (
                <span className="selected-duration mono">
                  {selectedApp.durationMs < 60000
                    ? `${(selectedApp.durationMs / 1000).toFixed(1)}s`
                    : `${Math.round(selectedApp.durationMs / 60000)}m`}
                </span>
              )}
            </div>
          ) : (
            <span className="trigger-placeholder">
              {t.selectPlaceholder}
            </span>
          )}
        </div>

        <div className="trigger-actions" onClick={(e) => e.stopPropagation()}>
          {selectedApp && (
            <button
              type="button"
              className="btn-clear-app"
              onClick={() => onSelect('')}
              title={t.clearTargetApp}
            >
              <IconCross width={12} height={12} />
            </button>
          )}
          <button
            type="button"
            className="btn-toggle-arrow"
            onClick={() => setOpen((prev) => !prev)}
          >
            <IconChevronDown
              width={14}
              height={14}
              style={{
                transform: open ? 'rotate(180deg)' : 'none',
                transition: 'transform 0.2s',
              }}
            />
          </button>
        </div>
      </div>

      {/* Popover Dropdown */}
      {open && (
        <div className="app-select-popover">
          <div className="popover-search-row">
            <IconSearch width={14} height={14} className="search-icon" />
            <input
              ref={searchInputRef}
              type="text"
              className="popover-search-input"
              placeholder={t.searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                type="button"
                className="btn-clear-search"
                onClick={() => setQuery('')}
              >
                <IconCross width={12} height={12} />
              </button>
            )}
            {onRefresh && (
              <button
                type="button"
                className="btn-refresh-popover"
                onClick={(e) => {
                  e.stopPropagation();
                  onRefresh();
                }}
                disabled={loading}
                title={t.refreshApps}
              >
                <IconRefresh width={13} height={13} className={loading ? 'spinning' : ''} />
              </button>
            )}
          </div>

          <div className="popover-meta-bar">
            <span>
              {t.appsCount(filteredApps.length, apps.length)}
            </span>
            {selectedId && (
              <button
                type="button"
                className="btn-deselect"
                onClick={() => {
                  onSelect('');
                  setOpen(false);
                }}
              >
                {t.clearTargetApp}
              </button>
            )}
          </div>

          <div className="popover-list">
            {filteredApps.map((a) => {
              const isSelected = a.id === selectedId;
              const durationStr =
                a.durationMs !== undefined
                  ? a.durationMs < 60000
                    ? `${(a.durationMs / 1000).toFixed(1)}s`
                    : `${Math.round(a.durationMs / 60000)}m`
                  : null;

              return (
                <div
                  key={a.id}
                  className={`app-option-row ${isSelected ? 'selected' : ''}`}
                  onClick={() => {
                    onSelect(a.id);
                    setOpen(false);
                  }}
                >
                  <div className="option-main">
                    <div className="option-title-row">
                      <span className="option-name">{a.name}</span>
                      <span className={`status-pill ${a.completed ? 'completed' : 'running'}`}>
                        {a.completed ? t.completed : t.runningState}
                      </span>
                    </div>
                    <div className="option-sub-row">
                      <span className="option-id mono">{a.id}</span>
                      {a.user && <span className="option-user">{t.byUser(a.user)}</span>}
                    </div>
                  </div>

                  <div className="option-aside">
                    {durationStr && <span className="option-duration mono">{durationStr}</span>}
                    {isSelected && (
                      <span className="option-check">
                        <IconCheck width={14} height={14} />
                      </span>
                    )}
                  </div>
                </div>
              );
            })}

            {filteredApps.length === 0 && (
              <div className="popover-empty">
                {query ? t.noAppsFound : t.noAppsAvailable}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
