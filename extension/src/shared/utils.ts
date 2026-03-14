// Pure utility functions extracted for testability

/**
 * Check if an Instagram CDN URL has expired by parsing the `oe=` (expiry) hex timestamp.
 * Instagram CDN URLs without `oe=` are also treated as expired since we can't verify them.
 */
export function isInstagramUrlExpired(url: string): boolean {
  if (!url) return false;
  const isInstagramCdn = /cdninstagram\.com|fbcdn\.net|instagram\.\w+\/v\//.test(url);
  const match = url.match(/[?&]oe=([0-9a-fA-F]+)/);
  if (!match) {
    // No expiry param — if it's an Instagram CDN URL, assume expired (can't verify)
    return isInstagramCdn;
  }
  const expiryTimestamp = parseInt(match[1], 16);
  return expiryTimestamp * 1000 < Date.now();
}

/**
 * Deduplicate posts by instagramId, keeping existing posts over new ones.
 * Returns the merged array.
 */
export function deduplicatePosts<T extends { instagramId: string }>(
  existingPosts: T[],
  newPosts: T[]
): T[] {
  const existingIds = new Set(existingPosts.map(p => p.instagramId));
  const uniqueNewPosts = newPosts.filter(p => !existingIds.has(p.instagramId));
  return [...existingPosts, ...uniqueNewPosts];
}

/**
 * Sort posts by savedAt DESC (newest first). Falls back to timestamp if savedAt missing.
 */
export function sortByNewest<T extends { savedAt?: string; timestamp?: string }>(posts: T[]): T[] {
  return [...posts].sort((a, b) => {
    const aTime = new Date(a.savedAt || a.timestamp || 0).getTime();
    const bTime = new Date(b.savedAt || b.timestamp || 0).getTime();
    return bTime - aTime;
  });
}

/**
 * Compute paginated items for the normal dashboard view.
 * Merges cloud + unsynced local posts sorted by savedAt DESC (newest first).
 */
export function computeNormalPageItems<T extends { instagramId: string; savedAt?: string; timestamp?: string }>(
  localPosts: T[],
  syncedPostIds: Set<string>,
  cloudPosts: T[],
  pageStartIdx: number,
  pageEndIdx: number,
): T[] {
  const unsyncedPosts = localPosts.filter(p => !syncedPostIds.has(p.instagramId));

  if (unsyncedPosts.length === 0) {
    return cloudPosts.slice(pageStartIdx, pageEndIdx);
  }

  // Merge cloud + unsynced, sort by savedAt DESC
  const merged = sortByNewest([...cloudPosts, ...unsyncedPosts]);

  return merged.slice(pageStartIdx, pageEndIdx);
}
