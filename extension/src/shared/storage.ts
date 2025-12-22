import {
  InstagramPost,
  Category,
  SyncStatus,
  Settings,
  STORAGE_KEYS,
  DEFAULT_SETTINGS
} from './types';

// Helper to get data from chrome.storage.local
async function getFromStorage<T>(key: string): Promise<T | null> {
  const result = await chrome.storage.local.get(key);
  return result[key] ?? null;
}

// Helper to set data in chrome.storage.local
async function setInStorage<T>(key: string, value: T): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

// Posts
export async function getPosts(): Promise<InstagramPost[]> {
  return (await getFromStorage<InstagramPost[]>(STORAGE_KEYS.POSTS)) ?? [];
}

export async function savePosts(posts: InstagramPost[]): Promise<void> {
  await setInStorage(STORAGE_KEYS.POSTS, posts);
}

export async function addPosts(newPosts: InstagramPost[]): Promise<InstagramPost[]> {
  const existingPosts = await getPosts();
  const existingIds = new Set(existingPosts.map(p => p.instagramId));

  const uniqueNewPosts = newPosts.filter(p => !existingIds.has(p.instagramId));
  const allPosts = [...existingPosts, ...uniqueNewPosts];

  await savePosts(allPosts);
  return allPosts;
}

// Categories
export async function getCategories(): Promise<Category[]> {
  return (await getFromStorage<Category[]>(STORAGE_KEYS.CATEGORIES)) ?? [];
}

export async function saveCategories(categories: Category[]): Promise<void> {
  await setInStorage(STORAGE_KEYS.CATEGORIES, categories);
}

// Sync Status
export async function getSyncStatus(): Promise<SyncStatus> {
  return (await getFromStorage<SyncStatus>(STORAGE_KEYS.SYNC_STATUS)) ?? {
    lastSync: null,
    totalPosts: 0,
    syncInProgress: false,
  };
}

export async function updateSyncStatus(status: Partial<SyncStatus>): Promise<SyncStatus> {
  const current = await getSyncStatus();
  const updated = { ...current, ...status };
  await setInStorage(STORAGE_KEYS.SYNC_STATUS, updated);
  return updated;
}

// Settings
export async function getSettings(): Promise<Settings> {
  return (await getFromStorage<Settings>(STORAGE_KEYS.SETTINGS)) ?? DEFAULT_SETTINGS;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await setInStorage(STORAGE_KEYS.SETTINGS, settings);
}

// Clear all data
export async function clearAllData(): Promise<void> {
  await chrome.storage.local.clear();
}
