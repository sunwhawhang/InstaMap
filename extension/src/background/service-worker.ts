import { MessageType } from '../shared/types';
import { getPosts, updateSyncStatus } from '../shared/storage';
import { api } from '../shared/api';

// Listen for messages from content scripts and popup
chrome.runtime.onMessage.addListener((message: MessageType, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(error => {
    console.error('[InstaMap] Error handling message:', error);
    sendResponse({ error: error.message });
  });
  return true; // Keep channel open for async response
});

async function handleMessage(message: MessageType, _sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message.type) {
    case 'POSTS_SCRAPED':
      console.log(`[InstaMap] Received ${message.posts.length} scraped posts`);
      // Update badge with post count
      const posts = await getPosts();
      updateBadge(posts.length);
      return { success: true };

    case 'SYNC_TO_BACKEND':
      return await syncToBackend();

    case 'GET_POSTS':
      return await getPosts();

    case 'GET_STATUS':
      return await import('../shared/storage').then(m => m.getSyncStatus());

    case 'OPEN_DASHBOARD':
      chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
      return { success: true };

    default:
      return { error: 'Unknown message type' };
  }
}

// Sync posts to backend
async function syncToBackend(): Promise<{ success: boolean; synced?: number; error?: string }> {
  try {
    await updateSyncStatus({ syncInProgress: true });

    const posts = await getPosts();
    if (posts.length === 0) {
      await updateSyncStatus({ syncInProgress: false });
      return { success: true, synced: 0 };
    }

    const result = await api.syncPosts(posts);

    await updateSyncStatus({
      syncInProgress: false,
      lastSync: new Date().toISOString(),
      totalPosts: posts.length,
    });

    return { success: true, synced: result.synced };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await updateSyncStatus({
      syncInProgress: false,
      error: errorMessage,
    });
    return { success: false, error: errorMessage };
  }
}

// Update extension badge with post count
function updateBadge(count: number): void {
  const text = count > 0 ? (count > 99 ? '99+' : count.toString()) : '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: '#E1306C' });
}

// Initialize badge on startup
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[InstaMap] Extension installed/updated');
  const posts = await getPosts();
  updateBadge(posts.length);
});

// Wake up and check posts
chrome.runtime.onStartup.addListener(async () => {
  console.log('[InstaMap] Extension started');
  const posts = await getPosts();
  updateBadge(posts.length);
});

// Handle extension icon click (optional - opens popup by default)
// chrome.action.onClicked.addListener((tab) => {
//   // If no popup is set, this will fire
//   chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
// });

// Context menu for quick actions - only if API is available
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus?.create({
      id: 'instamap-open-dashboard',
      title: 'Open InstaMap Dashboard',
      contexts: ['action'],
    });
  } catch (e) {
    console.log('[InstaMap] Context menus not available');
  }
});

try {
  chrome.contextMenus?.onClicked?.addListener((info, _tab) => {
    if (info.menuItemId === 'instamap-open-dashboard') {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
    }
  });
} catch (e) {
  // Context menus not available
}

export { };
