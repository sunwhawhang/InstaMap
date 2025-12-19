import { useEffect, useState } from 'react';
import { SyncStatus } from '../shared/types';
import { getSyncStatus, getPosts } from '../shared/storage';
import { api } from '../shared/api';

export function Popup() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [postCount, setPostCount] = useState(0);
  const [isOnInstagram, setIsOnInstagram] = useState(false);
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
    setIsOnInstagram(tab?.url?.includes('instagram.com') ?? false);
  }

  async function checkBackend() {
    const connected = await api.health();
    setBackendConnected(connected);
  }

  async function handleScrape() {
    setIsSyncing(true);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_POSTS' });
      }
    } catch (error) {
      console.error('Failed to scrape:', error);
    }
    setTimeout(() => {
      loadStatus();
      setIsSyncing(false);
    }, 2000);
  }

  async function handleSyncToBackend() {
    if (!backendConnected) return;

    setIsSyncing(true);
    try {
      const posts = await getPosts();
      await api.syncPosts(posts);
      await loadStatus();
    } catch (error) {
      console.error('Failed to sync to backend:', error);
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
        <button
          className="btn btn-primary"
          onClick={handleScrape}
          disabled={!isOnInstagram || isSyncing}
        >
          {isSyncing ? 'Syncing...' : '📥 Collect Posts'}
        </button>

        <button
          className="btn btn-secondary"
          onClick={handleSyncToBackend}
          disabled={!backendConnected || isSyncing || postCount === 0}
        >
          ☁️ Sync to Cloud
        </button>

        <button
          className="btn btn-outline"
          onClick={openDashboard}
        >
          📊 Open Dashboard
        </button>
      </div>

      <footer className="popup-footer">
        <a href="#" onClick={(e) => { e.preventDefault(); /* TODO: open settings */ }}>
          Settings
        </a>
      </footer>
    </div>
  );
}
