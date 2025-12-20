import { useEffect, useState } from 'react';
import { SyncStatus } from '../shared/types';
import { getSyncStatus, getPosts } from '../shared/storage';
import { api } from '../shared/api';

export function Popup() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [postCount, setPostCount] = useState(0);
  const [isOnInstagram, setIsOnInstagram] = useState(false);
  const [isOnSavedPage, setIsOnSavedPage] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [backendConnected, setBackendConnected] = useState<boolean | null>(null);

  useEffect(() => {
    loadStatus();
    checkCurrentTab();
    checkBackend();
  }, []);

  async function loadStatus() {
    const syncStatus = await getSyncStatus();
    const posts = await getPosts();
    setStatus(syncStatus);
    setPostCount(posts.length);
  }

  async function checkCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ?? '';
    setIsOnInstagram(url.includes('instagram.com'));
    setIsOnSavedPage(url.includes('/saved'));
  }

  async function checkBackend() {
    const connected = await api.health();
    setBackendConnected(connected);
  }

  async function handleCollectVisible() {
    if (!isOnSavedPage) {
      alert('Please navigate to your Instagram saved posts page first.');
      return;
    }

    setIsSyncing(true);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_POSTS' }, (response) => {
          // Check for connection errors
          if (chrome.runtime.lastError) {
            console.log('Content script not ready, try refreshing Instagram page');
            alert('Content script not loaded. Please refresh the Instagram page and try again.');
            setIsSyncing(false);
            return;
          }

          if (response?.success) {
            loadStatus();
            if (response.count > 0) {
              alert(`Collected ${response.count} posts!`);
            } else {
              alert('No new posts found on screen. Scroll to load more or try on your saved posts page.');
            }
          }
          setIsSyncing(false);
        });
      } else {
        setIsSyncing(false);
      }
    } catch (error) {
      console.error('Failed to collect visible:', error);
      alert('Failed to collect posts. Please refresh the Instagram page and try again.');
      setIsSyncing(false);
    }
  }

  async function handleCollectAll() {
    // Check if on saved page
    if (!isOnSavedPage) {
      alert('Please go to your Instagram saved posts page first.\n\nGo to your profile → ☰ menu → Saved');
      return;
    }

    // Get current tab URL to pass to collector
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const savedUrl = tab?.url || '';

    if (!savedUrl.includes('/saved')) {
      alert('Please navigate to your Instagram saved posts page.');
      return;
    }

    // Open the collector popup window with the current URL
    chrome.windows.create({
      url: chrome.runtime.getURL(`src/collector/collector.html?url=${encodeURIComponent(savedUrl)}`),
      type: 'popup',
      width: 450,
      height: 550,
      focused: true,
    });
    window.close();
  }

  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  async function handleSyncToBackend() {
    if (!backendConnected) {
      alert('Backend not connected. Please start the backend server.');
      return;
    }

    const posts = await getPosts();
    if (posts.length === 0) {
      alert('No posts to sync. Collect some posts first!');
      return;
    }

    setIsSyncing(true);
    setSyncMessage('Syncing to cloud...');

    try {
      const result = await api.syncPosts(posts);
      setSyncMessage(`✅ Synced ${result.synced} posts!`);
      await loadStatus();

      // Clear message after 3 seconds
      setTimeout(() => setSyncMessage(null), 3000);
    } catch (error) {
      console.error('Failed to sync to backend:', error);
      setSyncMessage('❌ Sync failed. Check console.');
      setTimeout(() => setSyncMessage(null), 3000);
    }
    setIsSyncing(false);
  }

  function openDashboard() {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
  }

  return (
    <div className="popup">
      <header className="popup-header">
        <h1>🗺️ InstaMap</h1>
        <p className="subtitle">Organize your saved posts</p>
      </header>

      <div className="stats">
        <div className="stat">
          <span className="stat-value">{postCount}</span>
          <span className="stat-label">Posts Saved</span>
        </div>
        <div className="stat">
          <span className="stat-value">
            {status?.lastSync
              ? new Date(status.lastSync).toLocaleDateString()
              : 'Never'}
          </span>
          <span className="stat-label">Last Sync</span>
        </div>
      </div>

      <div className="status-indicators">
        <div className={`status-item ${isOnInstagram ? 'active' : ''}`}>
          <span className="status-dot"></span>
          <span>{isOnInstagram ? 'On Instagram' : 'Not on Instagram'}</span>
        </div>
        <div className={`status-item ${backendConnected ? 'active' : ''}`}>
          <span className="status-dot"></span>
          <span>
            {backendConnected === null
              ? 'Checking backend...'
              : backendConnected
                ? 'Backend connected'
                : 'Backend offline'}
          </span>
        </div>
      </div>

      <div className="actions">
        {/* Collect only visible posts - safest option */}
        <button
          className="btn btn-primary"
          onClick={handleCollectVisible}
          disabled={!isOnSavedPage || isSyncing}
          title="Only collect posts currently visible on screen"
        >
          📷 Collect Visible Posts
        </button>

        {/* Auto-scroll collection */}
        <button
          className="btn btn-secondary"
          onClick={handleCollectAll}
          disabled={!isOnSavedPage || isSyncing}
          title="Opens a window and auto-scrolls to collect all posts"
        >
          📥 Collect All Posts
        </button>

        <button
          className="btn btn-secondary"
          onClick={handleSyncToBackend}
          disabled={!backendConnected || isSyncing || postCount === 0}
        >
          {isSyncing ? '⏳ Syncing...' : '☁️ Sync to Cloud'}
        </button>

        {syncMessage && (
          <div style={{
            padding: '8px 12px',
            borderRadius: '8px',
            background: syncMessage.includes('✅') ? 'var(--success)' :
              syncMessage.includes('❌') ? 'var(--error)' : 'var(--secondary)',
            color: 'white',
            fontSize: '13px',
            textAlign: 'center',
          }}>
            {syncMessage}
          </div>
        )}

        <button
          className="btn btn-outline"
          onClick={openDashboard}
        >
          📊 Open Dashboard
        </button>
      </div>

      {!isOnSavedPage && isOnInstagram && (
        <div style={{
          fontSize: '12px',
          color: 'var(--text-secondary)',
          marginTop: '8px',
          textAlign: 'center'
        }}>
          💡 Go to your <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              chrome.tabs.update({ url: 'https://www.instagram.com/accounts/saved/' });
              window.close();
            }}
            style={{ color: 'var(--primary)' }}
          >saved posts</a> to collect
        </div>
      )}

      <footer className="popup-footer">
        <a href="#" onClick={(e) => { e.preventDefault(); /* TODO: open settings */ }}>
          Settings
        </a>
        {' • '}
        <a href="#" onClick={async (e) => {
          e.preventDefault();
          if (confirm('Clear all collected posts?')) {
            await chrome.storage.local.clear();
            loadStatus();
          }
        }}>
          Clear Data
        </a>
      </footer>
    </div>
  );
}
