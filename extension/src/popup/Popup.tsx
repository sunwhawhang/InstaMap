import { useEffect, useState } from 'react';
import { SyncStatus, STORAGE_KEYS } from '../shared/types';
import { getSyncStatus, getPosts } from '../shared/storage';
import { api } from '../shared/api';

interface CloudSyncStatus {
  cloudPostCount: number;
  lastSyncedAt: string | null;
  cachedLocalPostCount: number | null;
}

interface PostCounts {
  local: number;
  cloud: number;
  common: number;
  total: number; // Unique posts across both (local + cloud - common)
}

export function Popup() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [localPostCount, setLocalPostCount] = useState(0);
  const [cloudStatus, setCloudStatus] = useState<CloudSyncStatus | null>(null);
  const [postCounts, setPostCounts] = useState<PostCounts | null>(null);
  const [isOnInstagram, setIsOnInstagram] = useState(false);
  const [isOnSavedPage, setIsOnSavedPage] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [backendConnected, setBackendConnected] = useState<boolean | null>(null);
  const [cacheWarning, setCacheWarning] = useState<string | null>(null);
  const [view, setView] = useState<'main' | 'settings'>('main');
  const [autoSync, setAutoSync] = useState(false);
  const [storeImages, setStoreImages] = useState(true);
  const [backendUrl, setBackendUrl] = useState('http://localhost:3001');
  const [scrollDelay, setScrollDelay] = useState(2000);

  useEffect(() => {
    loadStatus();
    checkCurrentTab();
    checkBackend();
    loadSettings();
  }, []);

  async function loadSettings() {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    const settings = stored[STORAGE_KEYS.SETTINGS] || {};

    if (settings.autoSync !== undefined) setAutoSync(settings.autoSync);
    if (settings.storeImages !== undefined) setStoreImages(settings.storeImages);
    if (settings.backendUrl !== undefined) setBackendUrl(settings.backendUrl);
    if (settings.scrollDelayMs !== undefined) setScrollDelay(settings.scrollDelayMs);
  }

  const updateSetting = async (key: string, value: any) => {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    const settings = stored[STORAGE_KEYS.SETTINGS] || {};
    await chrome.storage.local.set({
      [STORAGE_KEYS.SETTINGS]: { ...settings, [key]: value }
    });
  };

  const toggleAutoSync = async () => {
    const newVal = !autoSync;
    setAutoSync(newVal);
    await updateSetting('autoSync', newVal);
  };

  const toggleStoreImages = async () => {
    const newVal = !storeImages;
    setStoreImages(newVal);
    await updateSetting('storeImages', newVal);
  };

  async function loadStatus() {
    const syncStatus = await getSyncStatus();
    const posts = await getPosts();
    setStatus(syncStatus);
    setLocalPostCount(posts.length);

    // Also try to load saved username from storage if available
    const stored = await chrome.storage.local.get(STORAGE_KEYS.USERNAME);
    if (stored[STORAGE_KEYS.USERNAME]) {
      setUsername(stored[STORAGE_KEYS.USERNAME]);
    }
  }

  async function checkCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ?? '';
    const onInsta = url.includes('instagram.com');
    setIsOnInstagram(onInsta);
    setIsOnSavedPage(url.includes('/saved'));

    // 1. Try to get username from URL if on profile page
    if (onInsta) {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/').filter(Boolean);
      if (pathParts.length === 1) {
        const potentialUsername = pathParts[0];
        const ignoredPaths = ['explore', 'reels', 'direct', 'emails', 'accounts', 'stories', 'p', 'reel', 'saved'];
        if (!ignoredPaths.includes(potentialUsername)) {
          setUsername(potentialUsername);
          chrome.storage.local.set({ [STORAGE_KEYS.USERNAME]: potentialUsername });
        }
      }
    }

    // 2. Try to get username directly from Instagram API (works because of host_permissions)
    if (onInsta) {
      try {
        const response = await fetch('https://www.instagram.com/api/v1/accounts/current_user/', {
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'X-IG-App-ID': '936619743392459',
          },
        });
        if (response.ok) {
          const data = await response.json();
          if (data.user?.username) {
            setUsername(data.user.username);
            chrome.storage.local.set({ [STORAGE_KEYS.USERNAME]: data.user.username });
          }
        }
      } catch (err) {
        console.warn('[InstaMap] Failed to fetch username from API:', err);
      }
    }

    if (onInsta && tab?.id) {
      // 3. Also try to get info from content script for page-specific state
      try {
        chrome.tabs.sendMessage(tab.id, { type: 'GET_USER_INFO' }, (response) => {
          if (chrome.runtime.lastError) return;
          if (response?.username && !username) {
            setUsername(response.username);
            chrome.storage.local.set({ [STORAGE_KEYS.USERNAME]: response.username });
          }
          if (response?.isOnSavedPage !== undefined) {
            setIsOnSavedPage(response.isOnSavedPage);
          }
        });
      } catch (err) {
        // Content script might not be loaded, that's fine
      }
    }
  }

  async function checkBackend() {
    const connected = await api.health();
    setBackendConnected(connected);

    // If backend connected, also fetch cloud sync status and calculate overlap
    if (connected) {
      try {
        const cloudData = await api.getCloudSyncStatus();
        setCloudStatus(cloudData);

        // Get local posts and cloud Instagram IDs to calculate overlap
        const localPosts = await getPosts();
        const localInstagramIds = new Set(localPosts.map(p => p.instagramId));

        // Get cloud Instagram IDs for accurate overlap calculation
        let cloudInstagramIds: Set<string> = new Set();
        try {
          const syncedIds = await api.getSyncedInstagramIds();
          cloudInstagramIds = new Set(syncedIds);
        } catch {
          console.warn('[InstaMap] Could not fetch cloud Instagram IDs');
        }

        // Calculate overlap by instagramId (not internal id)
        const common = [...localInstagramIds].filter(id => cloudInstagramIds.has(id)).length;
        const notInCloud = [...localInstagramIds].filter(id => !cloudInstagramIds.has(id));
        const total = localInstagramIds.size + cloudInstagramIds.size - common;

        // Debug: log posts not in cloud
        if (notInCloud.length > 0) {
          console.log(`[InstaMap] ${notInCloud.length} local posts NOT in cloud:`, notInCloud.slice(0, 5), notInCloud.length > 5 ? '...' : '');
        }

        setPostCounts({
          local: localPosts.length,
          cloud: cloudInstagramIds.size || cloudData.cloudPostCount,
          common,
          total,
        });

        // Check for cache discrepancy: local is empty but cloud has data
        if (localPosts.length === 0 && cloudData.cloudPostCount > 0) {
          setCacheWarning(
            `⚠️ ${cloudData.cloudPostCount} posts synced to cloud, but local cache appears cleared. ` +
            `Re-collect from Instagram to restore local cache.`
          );
        } else if (
          cloudData.cachedLocalPostCount &&
          localPosts.length < cloudData.cachedLocalPostCount * 0.5 // More than 50% lost
        ) {
          setCacheWarning(
            `⚠️ Local cache may have been partially cleared. ` +
            `Previously: ${cloudData.cachedLocalPostCount} posts, now: ${localPosts.length}.`
          );
        }
      } catch (err) {
        console.warn('[InstaMap] Failed to fetch cloud sync status:', err);
      }
    } else {
      // Backend not connected - just show local count
      const localPosts = await getPosts();
      setPostCounts({
        local: localPosts.length,
        cloud: 0,
        common: 0,
        total: localPosts.length,
      });
    }
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
        chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_POSTS' }, async (response) => {
          // Check for connection errors
          if (chrome.runtime.lastError) {
            console.log('Content script not ready, try refreshing Instagram page');
            alert('Content script not loaded. Please refresh the Instagram page and try again.');
            setIsSyncing(false);
            return;
          }

          if (response?.success) {
            await loadStatus();
            await checkBackend(); // Refresh counts to see what's new

            if (response.count > 0) {
              if (autoSync && backendConnected) {
                // Trigger auto-sync
                handleSyncToBackend();
              } else {
                alert(`Collected ${response.count} posts!`);
              }
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
      const message = username
        ? `Please go to your Saved posts first.\n\nClick the link in the popup or go to:\ninstagram.com/${username}/saved/`
        : 'Please go to your Instagram saved posts page first.\n\nGo to your Profile → Saved';
      alert(message);
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

  const needsSyncCount = (backendConnected && postCounts) ? Math.max(0, postCounts.total - postCounts.cloud) : 0;
  const isAllSynced = !!backendConnected && (
    postCounts
      ? (postCounts.total === postCounts.cloud)
      : (localPostCount === 0)
  );

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
    setSyncMessage(`Syncing 0/${posts.length}...`);

    try {
      // Sync post metadata
      const result = await api.syncPosts(posts, storeImages, posts.length, (synced, total) => {
        setSyncMessage(`Syncing ${synced}/${total}...`);
      });

      // Upload images from client if enabled
      if (storeImages && posts.length > 0) {
        setSyncMessage(`Checking images...`);
        const imgResult = await api.uploadImagesFromPosts(posts, (uploaded, total) => {
          setSyncMessage(`Uploading images ${uploaded}/${total}...`);
        });
        if (imgResult.uploaded > 0 || imgResult.failed > 0) {
          setSyncMessage(`✅ Synced ${result.synced} posts, ${imgResult.uploaded} images!`);
        } else {
          setSyncMessage(`✅ Synced ${result.synced} posts (images up to date)`);
        }
      } else {
        setSyncMessage(`✅ Synced ${result.synced} posts!`);
      }

      await loadStatus();
      await checkBackend();
      setCacheWarning(null);
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

  if (view === 'settings') {
    return (
      <div className="popup">
        <header className="popup-header" style={{ display: 'flex', alignItems: 'center', gap: '12px', textAlign: 'left', marginBottom: '24px' }}>
          <button
            onClick={() => setView('main')}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '20px',
              cursor: 'pointer',
              padding: '4px'
            }}
          >
            ←
          </button>
          <h1 style={{ margin: 0 }}>Settings</h1>
        </header>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <section>
            <h3 style={{ fontSize: '14px', marginBottom: '12px', color: 'var(--text-secondary)' }}>Instagram Account</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)' }}>Username</label>
              <input
                type="text"
                value={username || ''}
                onChange={(e) => {
                  const val = e.target.value;
                  setUsername(val);
                  chrome.storage.local.set({ [STORAGE_KEYS.USERNAME]: val });
                }}
                placeholder="Not detected"
                style={{
                  height: '36px',
                  padding: '0 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--border)',
                  background: 'var(--background)',
                  fontSize: '13px',
                  width: '100%',
                  outline: 'none',
                  transition: 'all 0.2s ease'
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = 'var(--primary)';
                  e.target.style.boxShadow = '0 0 0 2px rgba(225, 48, 108, 0.1)';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = 'var(--border)';
                  e.target.style.boxShadow = 'none';
                }}
              />
              <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                Detected from your profile or active session.
              </p>
            </div>
          </section>

          <section>
            <h3 style={{ fontSize: '14px', marginBottom: '12px', color: 'var(--text-secondary)' }}>Sync Options</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  cursor: 'pointer',
                  padding: '8px 12px',
                  background: 'var(--background)',
                  borderRadius: '8px',
                  transition: 'background 0.2s'
                }}
                onClick={toggleAutoSync}
                onMouseEnter={(e) => e.currentTarget.style.background = '#f0f0f0'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'var(--background)'}
              >
                <input
                  type="checkbox"
                  checked={autoSync}
                  onChange={() => { }}
                  style={{ cursor: 'pointer', width: '16px', height: '16px' }}
                />
                <span style={{ fontSize: '13px', color: 'var(--text-primary)' }}>Auto-sync after collection</span>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  cursor: 'pointer',
                  padding: '8px 12px',
                  background: 'var(--background)',
                  borderRadius: '8px',
                  transition: 'background 0.2s'
                }}
                onClick={toggleStoreImages}
                onMouseEnter={(e) => e.currentTarget.style.background = '#f0f0f0'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'var(--background)'}
              >
                <input
                  type="checkbox"
                  checked={storeImages}
                  onChange={() => { }}
                  style={{ cursor: 'pointer', width: '16px', height: '16px' }}
                />
                <span style={{ fontSize: '13px', color: 'var(--text-primary)' }}>Store images in cloud</span>
              </div>
            </div>
            <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '8px', padding: '0 4px', lineHeight: '1.4' }}>
              💡 Storing images saves space but they may expire. Auto-sync pushes new posts to cloud automatically.
            </p>
          </section>

          <section>
            <h3 style={{ fontSize: '14px', marginBottom: '12px', color: 'var(--text-secondary)' }}>Advanced</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)' }}>Backend URL</label>
                <input
                  type="text"
                  value={backendUrl}
                  onChange={(e) => {
                    const val = e.target.value;
                    setBackendUrl(val);
                    updateSetting('backendUrl', val);
                  }}
                  style={{
                    height: '36px',
                    padding: '0 12px',
                    borderRadius: '8px',
                    border: '1px solid var(--border)',
                    background: 'var(--background)',
                    fontSize: '13px',
                    width: '100%',
                    outline: 'none',
                    transition: 'all 0.2s ease'
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = 'var(--primary)';
                    e.target.style.boxShadow = '0 0 0 2px rgba(225, 48, 108, 0.1)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = 'var(--border)';
                    e.target.style.boxShadow = 'none';
                  }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)' }}>Scroll Delay (ms)</label>
                <input
                  type="number"
                  value={scrollDelay}
                  onChange={(e) => {
                    const val = parseInt(e.target.value) || 0;
                    setScrollDelay(val);
                    updateSetting('scrollDelayMs', val);
                  }}
                  step="500"
                  min="500"
                  style={{
                    height: '36px',
                    padding: '0 12px',
                    borderRadius: '8px',
                    border: '1px solid var(--border)',
                    background: 'var(--background)',
                    fontSize: '13px',
                    width: '100%',
                    outline: 'none',
                    transition: 'all 0.2s ease'
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = 'var(--primary)';
                    e.target.style.boxShadow = '0 0 0 2px rgba(225, 48, 108, 0.1)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = 'var(--border)';
                    e.target.style.boxShadow = 'none';
                  }}
                />
              </div>
            </div>
          </section>

          <section>
            <h3 style={{ fontSize: '14px', marginBottom: '8px', color: 'var(--text-secondary)' }}>Data Management</h3>
            <button
              className="btn btn-outline"
              style={{ width: '100%', borderColor: 'var(--error)', color: 'var(--error)' }}
              onClick={async () => {
                if (confirm('Are you sure? This will delete all locally collected posts from the extension, but won\'t touch your Cloud data.')) {
                  await chrome.storage.local.clear();
                  loadStatus();
                  setView('main');
                }
              }}
            >
              🗑️ Clear Local Cache
            </button>
          </section>

          <section>
            <h3 style={{ fontSize: '14px', marginBottom: '8px', color: 'var(--text-secondary)' }}>About</h3>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
              <p>InstaMap v1.0.0</p>
              <p>Organize your Instagram saves with AI & Graphs.</p>
            </div>
          </section>
        </div>

        <footer className="popup-footer" style={{ marginTop: '32px' }}>
          <button
            className="btn btn-primary"
            style={{ width: '100%' }}
            onClick={() => setView('main')}
          >
            Done
          </button>
        </footer>
      </div>
    );
  }

  return (
    <div className="popup">
      <header className="popup-header">
        <h1>🗺️ InstaMap</h1>
        <p className="subtitle">Organize your saved posts</p>
      </header>

      <div className="stats">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }} title={postCounts ? `Local: ${postCounts.local} | Cloud: ${postCounts.cloud} | Common: ${postCounts.common}` : ''}>
          <div className="stat" style={{ flex: 1, padding: '8px 12px' }}>
            <span className="stat-label" style={{ fontSize: '10px', display: 'block' }}>Total Posts</span>
            <span style={{ fontSize: '18px', fontWeight: 600, color: 'var(--primary)', display: 'block' }}>
              {postCounts?.total ?? localPostCount}
            </span>
          </div>
          <div className="stat" style={{ flex: 1, padding: '8px 12px' }}>
            <span className="stat-label" style={{ fontSize: '10px', display: 'block' }}>☁️ Synced</span>
            <span style={{ fontSize: '18px', fontWeight: 600, color: '#0ea5e9', display: 'block' }}>
              {postCounts?.cloud ?? 0}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
          <div className="stat" style={{ flex: 1, padding: '8px 12px' }}>
            <span className="stat-label" style={{ fontSize: '10px', display: 'block' }}>Last Sync</span>
            <span style={{ fontSize: '18px', fontWeight: 600, color: 'var(--primary)', display: 'block' }}>
              {status?.lastSync
                ? new Date(status.lastSync).toLocaleDateString()
                : 'Never'}
            </span>
          </div>
          <div className="stat" style={{ flex: 1, padding: '8px 12px' }}>
            <span className="stat-label" style={{ fontSize: '10px', display: 'block' }}>☁️ Last Cloud</span>
            <span style={{ fontSize: '18px', fontWeight: 600, color: '#0ea5e9', display: 'block' }}>
              {cloudStatus?.lastSyncedAt && !isNaN(new Date(cloudStatus.lastSyncedAt).getTime())
                ? new Date(cloudStatus.lastSyncedAt).toLocaleDateString()
                : 'Never'}
            </span>
          </div>
        </div>
      </div>

      {cacheWarning && (
        <div style={{
          padding: '10px 12px',
          borderRadius: '8px',
          background: '#fff3cd',
          border: '1px solid #ffc107',
          color: '#856404',
          fontSize: '12px',
          marginBottom: '12px',
          lineHeight: '1.4',
        }}>
          {cacheWarning}
        </div>
      )}

      <div className="status-indicators">
        <div className={`status-item ${isOnInstagram ? 'active' : ''}`}>
          <span className="status-dot"></span>
          <span>
            {isOnInstagram ? 'On Instagram' : (
              <>
                Not on Instagram
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    const targetUrl = username
                      ? `https://www.instagram.com/${username}/saved/all-posts/`
                      : 'https://www.instagram.com/';
                    chrome.tabs.update({ url: targetUrl });
                    window.close();
                  }}
                  style={{ color: 'var(--primary)', marginLeft: '4px', textDecoration: 'none' }}
                >
                  (Go to {username ? 'Saved' : 'Instagram'})
                </a>
              </>
            )}
          </span>
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

        <div style={{ position: 'relative' }}>
          <button
            className="btn btn-secondary"
            onClick={handleSyncToBackend}
            disabled={!backendConnected || isSyncing || isAllSynced}
            style={{
              width: '100%',
              background: isAllSynced ? 'var(--success)' : undefined
            }}
          >
            {isSyncing ? '⏳ Syncing...' : isAllSynced ? '✅ All Synced' : '☁️ Sync to Cloud'}
          </button>
          {needsSyncCount > 0 && (
            <span style={{
              position: 'absolute',
              top: '-6px',
              right: '-6px',
              background: 'var(--primary)',
              color: 'white',
              borderRadius: '10px',
              padding: '2px 6px',
              fontSize: '10px',
              fontWeight: 'bold',
              boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
              pointerEvents: 'none'
            }}>
              {needsSyncCount}
            </span>
          )}
        </div>

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
          💡 {username ? (
            <>Go to your <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                chrome.tabs.update({ url: `https://www.instagram.com/${username}/saved/all-posts/` });
                window.close();
              }}
              style={{ color: 'var(--primary)' }}
            >saved posts</a> to collect</>
          ) : (
            <>Please go to your Profile → Saved to collect</>
          )}
        </div>
      )}

      <footer className="popup-footer">
        <a href="#" onClick={(e) => { e.preventDefault(); setView('settings'); }}>
          Settings
        </a>
        {/* {' • '}
        <a href="#" onClick={async (e) => {
          e.preventDefault();
          if (confirm('Clear all collected posts?')) {
            await chrome.storage.local.clear();
            loadStatus();
          }
        }}>
          Clear Data
        </a> */}
      </footer>
    </div>
  );
}
