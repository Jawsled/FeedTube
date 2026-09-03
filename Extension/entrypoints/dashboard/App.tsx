import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { readStoredStatus } from '../../lib/core/feed-engine';
import { loadSettings } from '../../lib/settings';
import type { EngineStatus } from '../../lib/types';
import { Icon, Icons } from './components/ui';
import { FeedView } from './components/FeedView';
import { SubscriptionsView } from './components/SubscriptionsView';
import { HistoryView } from './components/HistoryView';
import { SettingsView } from './components/SettingsView';

const ROUTES = ['feed', 'subs', 'history', 'settings'] as const;
type Route = (typeof ROUTES)[number];

function currentRoute(): Route {
  const h = location.hash.replace(/^#\/?/, '').split('?')[0];
  return (ROUTES as readonly string[]).includes(h) ? (h as Route) : 'feed';
}

export function App() {
  const [route, setRoute] = useState<Route>(currentRoute);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [toggleMode, setToggleMode] = useState<'logo' | 'hamburger'>('logo');

  useEffect(() => {
    const onHash = () => setRoute(currentRoute());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const read = () => void readStoredStatus().then(setStatus);
    read();
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && 'engineStatus' in changes) read();
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);

  useEffect(() => {
    void loadSettings().then((s) => setToggleMode(s.sidebarToggle));
  }, []);

  const go = (r: Route) => {
    location.hash = `#/${r}`;
    setRoute(r);
  };

  const toggleSidebar = () => setCollapsed((c) => !c);

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <nav
        class={`nav ${collapsed ? 'collapsed' : 'expanded'}`}
        style={{
          width: collapsed ? 64 : 210,
          flexShrink: 0,
          borderRight: '1px solid var(--border)',
          padding: '18px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          position: 'sticky',
          top: 0,
          height: '100vh',
          overflowX: 'hidden',
          transition: 'width 0.18s ease',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: collapsed ? '0 0 16px' : '0 6px 16px',
            fontWeight: 800,
            fontSize: 17,
            letterSpacing: '-.3px',
          }}
        >
          {toggleMode === 'logo' ? (
            <button class="brand-toggle" onClick={toggleSidebar} title="Toggle sidebar">
              <img src="/icon/32.png" alt="" width={26} height={26} style={{ borderRadius: 5 }} />
            </button>
          ) : (
            <button
              class="icon-btn"
              onClick={toggleSidebar}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              style={{ padding: 6, lineHeight: 0 }}
            >
              <Icon path={Icons.menu} size={18} />
            </button>
          )}
          <span class="nav-label brand-name">FeedTube</span>
        </div>
        {(
          [
            ['feed', 'Feed', Icons.feed],
            ['subs', 'Subscriptions', Icons.users],
            ['history', 'History', Icons.history],
            ['settings', 'Settings', Icons.gear],
          ] as [Route, string, string][]
        ).map(([key, label, icon]) => (
          <button
            key={key}
            class={`nav-btn${route === key ? ' active' : ''}`}
            onClick={() => go(key)}
            title={label}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: collapsed ? 'center' : 'flex-start',
              gap: collapsed ? 0 : 11,
              padding: collapsed ? '9px 0' : '9px 10px',
              borderRadius: 6,
              textAlign: 'left',
              whiteSpace: 'nowrap',
              transition: 'background 0.15s ease, color 0.15s ease',
            }}
          >
            <Icon path={icon} size={17} />
            <span class="nav-label">{label}</span>
          </button>
        ))}

        <div style={{ flex: 1 }} />

        {!collapsed && !status?.running && (status?.errors.length ?? 0) > 0 && (
          <button
            class="error-text"
            style={{ padding: '4px 10px', textAlign: 'left', cursor: 'pointer' }}
            onClick={() => {
              const summary = status!.errors.length === 1
                ? status!.errors[0]
                : `${status!.errors.length} errors (first: ${status!.errors[0]})`;
              alert(`Refresh errors:\n\n${summary}\n\nOpen the Feed log (Show log button) for full details.`);
            }}
            title={status!.errors.join('\n')}
          >
            ⚠ {status!.errors.length} channel{status!.errors.length === 1 ? '' : 's'} failed
          </button>
        )}
      </nav>

      <main style={{ flex: 1, minWidth: 0, padding: '24px max(28px, 5vw)' }}>
        {route === 'feed' && <FeedView onGoToSubs={() => go('subs')} />}
        {route === 'subs' && <SubscriptionsView onGoToImport={() => go('settings')} />}
        {route === 'history' && <HistoryView />}
        {route === 'settings' && <SettingsView />}
      </main>
    </div>
  );
}
