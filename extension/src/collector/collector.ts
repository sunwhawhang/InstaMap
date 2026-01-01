import { getPosts, getSettings } from '../shared/storage';
import { api } from '../shared/api';

let instagramTabId: number | null = null;
let instagramWindowId: number | null = null;
let isCollecting = false;
let collectionMethod: 'api' | 'scroll' = 'api';

// DOM elements
const setupView = document.getElementById('setup-view')!;
const progressView = document.getElementById('progress-view')!;
const doneView = document.getElementById('done-view')!;
const errorView = document.getElementById('error-view')!;

const startApiNewBtn = document.getElementById('start-api-new-btn')!;
const startApiAllBtn = document.getElementById('start-api-all-btn')!;
const startScrollBtn = document.getElementById('start-scroll-btn')!;
const stopBtn = document.getElementById('stop-btn')!;
const closeBtn = document.getElementById('close-btn')!;
const dashboardBtn = document.getElementById('dashboard-btn')!;
const retryBtn = document.getElementById('retry-btn')!;

const statusEl = document.getElementById('status')!;
const countEl = document.getElementById('count')!;
const finalCountEl = document.getElementById('final-count')!;
const progressEl = document.getElementById('progress')!;
const errorMessageEl = document.getElementById('error-message')!;

// Show a specific view
function showView(view: 'setup' | 'progress' | 'done' | 'error') {
  setupView.classList.add('hidden');
  progressView.classList.add('hidden');
  doneView.classList.add('hidden');
  errorView.classList.add('hidden');

  switch (view) {
    case 'setup': setupView.classList.remove('hidden'); break;
    case 'progress': progressView.classList.remove('hidden'); break;
    case 'done': doneView.classList.remove('hidden'); break;
    case 'error': errorView.classList.remove('hidden'); break;
  }
}

// Get the saved posts URL from query params
function getSavedUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('url') || '';
}

// ============================================
// API-BASED COLLECTION
// ============================================
async function startApiCollection(stopAtExisting: boolean = false) {
  try {
    const savedUrl = getSavedUrl();

    if (!savedUrl || !savedUrl.includes('instagram.com')) {
      showError('Please open this from your Instagram saved posts page.');
      return;
    }

    showView('progress');
    collectionMethod = 'api';
    statusEl.textContent = stopAtExisting
      ? 'Starting smart collection (new posts only)...'
      : 'Starting full API collection...';
    isCollecting = true;

    // Listen for progress updates
    listenForProgress();

    // For API method, we need to run on an Instagram tab
    // Find existing Instagram tab or use the source tab
    const [tab] = await chrome.tabs.query({ url: '*://www.instagram.com/*', active: true });

    if (!tab?.id) {
      // Open Instagram in background and use it
      const newTab = await chrome.tabs.create({
        url: savedUrl,
        active: false, // Keep collector focused
      });
      instagramTabId = newTab.id!;
      await waitForTabLoad(instagramTabId);
      await sleep(2000);
    } else {
      instagramTabId = tab.id;
    }

    // Start API collection in content script
    statusEl.textContent = stopAtExisting
      ? 'Finding new posts...'
      : 'Fetching posts via API... (works in background!)';

    let retries = 0;
    const maxRetries = 5;

    while (retries < maxRetries) {
      try {
        await chrome.tabs.sendMessage(instagramTabId!, {
          type: 'START_API_COLLECTION',
          stopAtExisting,
        });
        console.log('START_API_COLLECTION sent successfully', { stopAtExisting });
        break;
      } catch (error) {
        retries++;
        console.log(`Retry ${retries}/${maxRetries} - content script not ready`);
        if (retries >= maxRetries) {
          throw new Error('Content script not responding. Refresh Instagram and try again.');
        }
        await sleep(1000);
      }
    }

  } catch (error) {
    console.error('API collection error:', error);
    showError(error instanceof Error ? error.message : 'Failed to start API collection');
  }
}

// ============================================
// SCROLL-BASED COLLECTION
// ============================================
async function startScrollCollection() {
  try {
    const savedUrl = getSavedUrl();

    if (!savedUrl || !savedUrl.includes('/saved')) {
      showError('No valid saved posts URL. Go to your Instagram saved posts and try again.');
      return;
    }

    showView('progress');
    collectionMethod = 'scroll';
    statusEl.textContent = 'Opening Instagram in new window...';
    isCollecting = true;

    // Listen for progress updates first
    listenForProgress();

    // Open Instagram in a SEPARATE WINDOW so it stays visible
    const newWindow = await chrome.windows.create({
      url: savedUrl,
      type: 'normal',
      width: 1200,
      height: 900,
      focused: true,
    });

    instagramWindowId = newWindow.id!;

    // Get the tab ID from the new window
    if (newWindow.tabs && newWindow.tabs.length > 0) {
      instagramTabId = newWindow.tabs[0].id!;
    } else {
      throw new Error('Failed to create Instagram window');
    }

    // Wait for tab to fully load
    await waitForTabLoad(instagramTabId);
    statusEl.textContent = 'Waiting for page to render...';
    await sleep(3000);

    // Start scroll collection
    statusEl.textContent = 'Collecting... Keep the Instagram window visible!';

    let retries = 0;
    const maxRetries = 5;

    while (retries < maxRetries) {
      try {
        await chrome.tabs.sendMessage(instagramTabId, { type: 'START_QUICK_SYNC' });
        console.log('START_QUICK_SYNC sent successfully');
        break;
      } catch (error) {
        retries++;
        console.log(`Retry ${retries}/${maxRetries} - content script not ready`);
        if (retries >= maxRetries) {
          throw new Error('Content script not responding. Make sure you\'re logged into Instagram.');
        }
        await sleep(1000);
      }
    }

  } catch (error) {
    console.error('Scroll collection error:', error);
    showError(error instanceof Error ? error.message : 'Failed to start collection');
  }
}

// Wait for tab to finish loading
function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    // Timeout after 30s
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
  });
}

// Listen for progress updates from content script
function listenForProgress() {
  chrome.runtime.onMessage.addListener((message, sender) => {
    // For API method, accept messages from any Instagram tab
    // For scroll method, only accept from our specific tab
    if (collectionMethod === 'scroll' && sender.tab?.id !== instagramTabId) return;
    if (!sender.tab?.url?.includes('instagram.com')) return;

    if (message.type === 'COLLECTION_PROGRESS') {
      updateProgress(message.collected, message.status);
    } else if (message.type === 'POSTS_SCRAPED') {
      // Collection complete
      completeCollection(message.posts.length);
    }
  });

  // Poll tab only for scroll method
  if (collectionMethod === 'scroll') {
    const pollInterval = setInterval(async () => {
      if (!isCollecting || !instagramTabId) {
        clearInterval(pollInterval);
        return;
      }

      try {
        const tab = await chrome.tabs.get(instagramTabId);
        if (!tab) {
          showError('Instagram tab was closed');
          clearInterval(pollInterval);
        }
      } catch {
        clearInterval(pollInterval);
      }
    }, 5000);
  }
}

// Update progress display
function updateProgress(count: number, status: string) {
  countEl.textContent = count.toString();

  switch (status) {
    case 'scrolling':
      if (collectionMethod === 'api') {
        statusEl.textContent = 'Fetching via API... (works in background!)';
      } else {
        statusEl.textContent = 'Scrolling and collecting...';
      }
      progressEl.style.animation = 'pulse 2s infinite';
      break;
    case 'paused':
      statusEl.textContent = 'Paused (tab inactive)';
      progressEl.style.animation = 'none';
      break;
    case 'done':
      completeCollection(count);
      break;
  }
}

// Complete collection
async function completeCollection(count: number) {
  isCollecting = false;
  finalCountEl.textContent = count.toString();
  showView('done');

  // Check for auto-sync setting
  try {
    const settings = await getSettings();
    const connected = await api.health();

    if (settings.autoSync && connected && count > 0) {
      statusEl.textContent = 'Auto-syncing to cloud...';
      const posts = await getPosts();
      await api.syncPosts(posts, settings.storeImages, posts.length);
      statusEl.textContent = `Collection complete! Synced ${count} posts to cloud.`;
    }
  } catch (err) {
    console.warn('[InstaMap] Auto-sync failed:', err);
  }

  // Close the Instagram window (only for scroll method which opens a new window)
  if (collectionMethod === 'scroll') {
    if (instagramWindowId) {
      chrome.windows.remove(instagramWindowId).catch(() => { });
      instagramWindowId = null;
      instagramTabId = null;
    }
  }
  // For API method, don't close the user's Instagram tab
}

// Stop collection
async function stopCollection() {
  if (instagramTabId) {
    try {
      await chrome.tabs.sendMessage(instagramTabId, { type: 'STOP_COLLECTION' });
    } catch {
      // Tab might be gone
    }
  }
  isCollecting = false;
}

// Show error
function showError(message: string) {
  errorMessageEl.textContent = message;
  showView('error');
  isCollecting = false;
}

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Event listeners
startApiNewBtn.addEventListener('click', () => startApiCollection(true));
startApiAllBtn.addEventListener('click', () => startApiCollection(false));
startScrollBtn.addEventListener('click', startScrollCollection);
stopBtn.addEventListener('click', stopCollection);
closeBtn.addEventListener('click', () => window.close());
dashboardBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
  window.close();
});
retryBtn.addEventListener('click', () => {
  showView('setup');
});

// Initial state
showView('setup');
