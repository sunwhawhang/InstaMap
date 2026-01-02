import { InstagramPost } from '../shared/types';
import { addPosts, updateSyncStatus, getSettings } from '../shared/storage';

// State for collection
let isCollecting = false;
let collectedPosts: InstagramPost[] = [];
let seenIds = new Set<string>();

// Instagram API endpoints (internal, undocumented)
const SAVED_POSTS_ENDPOINT = '/api/v1/feed/saved/posts/';

// Storage key for resume cursor
const RESUME_CURSOR_KEY = 'instamap_resume_cursor';

// Listen for messages from popup/background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'GET_USER_INFO':
      getCurrentUsername().then(username => {
        sendResponse({
          username,
          isOnSavedPage: isOnSavedPostsPage()
        });
      });
      return true;

    case 'SCRAPE_POSTS':
      // Scrape and save visible posts immediately
      scrapeAndSaveVisible().then(result => {
        sendResponse(result);
      }).catch(error => {
        sendResponse({ success: false, error: error.message, count: 0 });
      });
      return true;

    case 'START_QUICK_SYNC':
      startQuickSync().then(() => {
        sendResponse({ success: true });
      });
      return true;

    case 'START_API_COLLECTION':
      // New API-based collection (works in background)
      // message.stopAtExisting: if true, stop when reaching already-collected posts
      startApiCollection(message.stopAtExisting || false).then(() => {
        sendResponse({ success: true });
      }).catch(error => {
        sendResponse({ success: false, error: error.message });
      });
      return true;

    case 'CHECK_RESUME_CURSOR':
      // Check if there's a saved cursor to resume from
      chrome.storage.local.get(RESUME_CURSOR_KEY).then(stored => {
        sendResponse({ hasCursor: !!stored[RESUME_CURSOR_KEY] });
      });
      return true;

    case 'CLEAR_RESUME_CURSOR':
      // Clear the resume cursor (start fresh)
      chrome.storage.local.remove(RESUME_CURSOR_KEY).then(() => {
        sendResponse({ success: true });
      });
      return true;

    case 'STOP_COLLECTION':
      stopCollection();
      sendResponse({ success: true });
      return true;

    case 'REFRESH_IMAGE_URLS':
      // Refresh image URLs for specific Instagram IDs (for expired images)
      refreshImageUrls(message.instagramIds || []).then(result => {
        sendResponse(result);
      }).catch(error => {
        sendResponse({ success: false, error: error.message, updates: [] });
      });
      return true;

    default:
      return false;
  }
});

// Scrape visible posts and save immediately
async function scrapeAndSaveVisible(): Promise<{ success: boolean; count: number; total: number }> {
  console.log('[InstaMap] Scraping visible posts...');

  // Reset state for a fresh scrape
  collectedPosts = [];
  seenIds.clear();

  const posts = await scrapeVisiblePosts();

  if (posts.length === 0) {
    console.log('[InstaMap] No posts found on screen');
    return { success: true, count: 0, total: 0 };
  }

  // Save to storage
  const allPosts = await addPosts(posts);
  await updateSyncStatus({
    lastSync: new Date().toISOString(),
    totalPosts: allPosts.length,
  });

  console.log(`[InstaMap] Saved ${posts.length} new posts, total: ${allPosts.length}`);

  // Show confirmation
  updateIndicator(`✅ Collected ${posts.length} posts!`, 'done');
  setTimeout(() => updateIndicator('🗺️ InstaMap Ready', 'ready'), 3000);

  return { success: true, count: posts.length, total: allPosts.length };
}

// Check if we're on the saved posts page
function isOnSavedPostsPage(): boolean {
  return window.location.pathname.includes('/saved');
}

// Get the current logged-in username
async function getCurrentUsername(): Promise<string | null> {
  // 1. Try to get from API (most reliable)
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
        return data.user.username;
      }
    }
  } catch (err) {
    console.debug('[InstaMap] API username check failed:', err);
  }

  // 2. Try to get it from the profile link in navigation
  // Instagram's side nav often has a profile link with the username
  const profileSelectors = [
    'a[href^="/"][href$="/"] img[alt*="profile"]',
    'a[href^="/"][href$="/"] svg[aria-label*="Profile"]',
    'a[href^="/"][href$="/"] img[src*="profile"]',
    'nav a[href^="/"]',
    'header a[href^="/"]',
  ];

  for (const selector of profileSelectors) {
    const link = document.querySelector(selector)?.closest('a');
    if (link) {
      const href = link.getAttribute('href');
      if (href) {
        const username = href.replace(/\//g, '');
        if (username && !['explore', 'reels', 'direct', 'emails', 'accounts', 'stories', 'p', 'reel', 'saved'].includes(username)) {
          return username;
        }
      }
    }
  }

  // 3. Try to get it from the URL if we're on a profile page
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  if (pathParts.length === 1) {
    const potentialUsername = pathParts[0];
    if (!['explore', 'reels', 'direct', 'emails', 'accounts', 'stories'].includes(potentialUsername)) {
      return potentialUsername;
    }
  }

  return null;
}

// Generate a unique ID for a post
function generatePostId(): string {
  return `post_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Extract Instagram post ID from URL or element
function extractInstagramId(element: Element): string | null {
  const link = element.querySelector('a[href*="/p/"]') as HTMLAnchorElement;
  if (link) {
    const match = link.href.match(/\/p\/([^/]+)/);
    if (match) return match[1];
  }

  const reelLink = element.querySelector('a[href*="/reel/"]') as HTMLAnchorElement;
  if (reelLink) {
    const match = reelLink.href.match(/\/reel\/([^/]+)/);
    if (match) return match[1];
  }

  return null;
}

// Extract image URL and caption from the image element
function extractImageData(element: Element): { imageUrl: string | null; caption: string } {
  const img = element.querySelector('img') as HTMLImageElement;

  let imageUrl: string | null = null;
  let caption = '';

  if (img) {
    // Get image URL
    if (img.src) imageUrl = img.src;
    if (!imageUrl && img.srcset) {
      const srcset = img.srcset.split(',');
      const lastSrc = srcset[srcset.length - 1]?.trim().split(' ')[0];
      if (lastSrc) imageUrl = lastSrc;
    }

    // Caption is stored in the alt attribute!
    if (img.alt) {
      caption = img.alt.trim();
    }
  }

  // Fallback for video posts
  if (!imageUrl) {
    const video = element.querySelector('video') as HTMLVideoElement;
    if (video?.poster) imageUrl = video.poster;
  }

  return { imageUrl, caption };
}

// Check if the post is a video
function isVideoPost(element: Element): boolean {
  return element.querySelector('video') !== null ||
    element.querySelector('svg[aria-label*="Reel"]') !== null ||
    element.querySelector('span[aria-label*="Video"]') !== null;
}

// Scrape currently visible posts
async function scrapeVisiblePosts(): Promise<InstagramPost[]> {
  if (!isOnSavedPostsPage()) {
    console.log('[InstaMap] Not on saved posts page');
    return [];
  }

  const posts: InstagramPost[] = [];

  const selectors = [
    'article div[style*="flex-direction: column"] > div > div > div > div > a',
    'main article a[href*="/p/"]',
    'main article a[href*="/reel/"]',
    'div[style*="display: flex"][style*="flex-direction: column"] a[href*="/p/"]',
  ];

  let postElements: Element[] = [];

  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    if (elements.length > 0) {
      postElements = Array.from(elements);
      break;
    }
  }

  if (postElements.length === 0) {
    const allLinks = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
    postElements = Array.from(allLinks);
  }

  for (const element of postElements) {
    try {
      const instagramId = extractInstagramId(element) ||
        extractInstagramId(element.parentElement!) ||
        extractInstagramId(element.closest('article') || element);

      if (!instagramId || seenIds.has(instagramId)) continue;
      seenIds.add(instagramId);

      // Find the container with the image
      const container = element.closest('a[href*="/p/"], a[href*="/reel/"]') ||
        element.closest('div[class]') ||
        element;

      // Extract image URL and caption from the alt attribute
      const { imageUrl, caption } = extractImageData(container);

      if (!imageUrl) continue;

      const post: InstagramPost = {
        id: generatePostId(),
        instagramId,
        imageUrl,
        thumbnailUrl: imageUrl,
        caption: caption,
        ownerUsername: '', // Username not available in grid view
        timestamp: new Date().toISOString(),
        savedAt: new Date().toISOString(),
        isVideo: isVideoPost(container),
      };

      posts.push(post);
      collectedPosts.push(post);
    } catch (error) {
      console.error('[InstaMap] Error processing post element:', error);
    }
  }

  return posts;
}

// Create or update the floating indicator
function updateIndicator(text: string, status: 'ready' | 'collecting' | 'paused' | 'done' | 'error') {
  let indicator = document.getElementById('instamap-indicator');

  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'instamap-indicator';
    document.body.appendChild(indicator);
  }

  const colors = {
    ready: 'linear-gradient(45deg, #833AB4, #E1306C)',
    collecting: 'linear-gradient(45deg, #0095f6, #00c6ff)',
    paused: 'linear-gradient(45deg, #F77737, #FCAF45)',
    done: 'linear-gradient(45deg, #58c322, #7ed957)',
    error: 'linear-gradient(45deg, #ed4956, #ff6b6b)',
  };

  indicator.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: ${colors[status]};
    color: white;
    padding: 12px 20px;
    border-radius: 24px;
    font-size: 14px;
    font-weight: 600;
    z-index: 9999;
    box-shadow: 0 4px 15px rgba(0,0,0,0.3);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    transition: all 0.3s ease;
  `;

  indicator.innerHTML = text;

  if (status === 'collecting') {
    indicator.onclick = () => {
      stopCollection();
    };
    indicator.title = 'Click to stop';
  } else if (status === 'ready') {
    if (isOnSavedPostsPage()) {
      indicator.onclick = () => {
        // Use API collection with smart stop (only collect new posts)
        startApiCollection(true);
      };
      indicator.title = 'Click to collect new posts';
    } else {
      indicator.onclick = async () => {
        // Navigate to saved posts page (need username for correct URL)
        const username = await getCurrentUsername();
        if (username) {
          window.location.href = `https://www.instagram.com/${username}/saved/all-posts/`;
        } else {
          // Fallback to generic saved URL
          window.location.href = 'https://www.instagram.com/saved/';
        }
      };
      indicator.title = 'Click to go to Saved Posts';
    }
  } else {
    indicator.onclick = null;
  }
}

// ============================================
// API-BASED COLLECTION (works in background!)
// ============================================

const BASE_DELAY_MS = 1000; // 1 second between requests
const MAX_DELAY_MS = 60000; // Max 1 minute backoff

async function startApiCollection(stopAtExisting: boolean = false) {
  if (isCollecting) {
    console.log('[InstaMap] Already collecting');
    return;
  }

  console.log('[InstaMap] Starting API-based collection...', stopAtExisting ? '(stop at existing)' : '(full)');
  isCollecting = true;
  collectedPosts = [];
  seenIds.clear();

  // Load existing post IDs if we want to stop at existing posts
  // Check BOTH local cache AND cloud-synced posts
  let existingPostIds = new Set<string>();
  if (stopAtExisting) {
    // First try local cache
    try {
      const stored = await chrome.storage.local.get('instamap_posts');
      const existingPosts: InstagramPost[] = stored.instamap_posts || [];
      existingPostIds = new Set(existingPosts.map((p) => p.instagramId));
      console.log(`[InstaMap] Loaded ${existingPostIds.size} existing post IDs from local cache`);
    } catch (err) {
      console.warn('[InstaMap] Could not load existing posts from cache:', err);
    }

    // If local cache is empty, check cloud-synced posts
    if (existingPostIds.size === 0) {
      console.log('[InstaMap] Local cache empty, checking cloud-synced posts...');
      updateIndicator('🔄 Checking synced posts...', 'collecting');
      try {
        const settings = await getSettings();
        const response = await fetch(`${settings.backendUrl}/api/posts/synced-instagram-ids`);
        if (response.ok) {
          const data = await response.json();
          existingPostIds = new Set(data.instagramIds || []);
          console.log(`[InstaMap] Loaded ${existingPostIds.size} synced post IDs from cloud`);
        }
      } catch (err) {
        console.warn('[InstaMap] Could not load synced posts from cloud:', err);
        // Continue anyway - will scrape all if cloud is unreachable
      }
    }

    // Log sample IDs for debugging
    if (existingPostIds.size > 0) {
      const sampleIds = Array.from(existingPostIds).slice(0, 3);
      console.log('[InstaMap] Sample existing IDs:', sampleIds);
    }
  }

  // Check for resume cursor (only for full collection)
  let cursor: string | null = null;
  let resuming = false;

  if (!stopAtExisting) {
    try {
      const stored = await chrome.storage.local.get(RESUME_CURSOR_KEY);
      if (stored[RESUME_CURSOR_KEY]) {
        cursor = stored[RESUME_CURSOR_KEY];
        resuming = true;
        console.log('[InstaMap] Resuming from cursor:', cursor);
        updateIndicator('🔄 Resuming collection...', 'collecting');
      } else {
        updateIndicator('🔄 Fetching via API...', 'collecting');
      }
    } catch {
      // No resume cursor, start fresh
    }
  } else {
    updateIndicator('🔄 Collecting new posts...', 'collecting');
  }

  let hasMore = true;
  let totalFetched = 0;
  let consecutiveErrors = 0;
  const maxErrors = 5;
  let currentDelay = BASE_DELAY_MS;
  let consecutiveDuplicates = 0;
  const maxConsecutiveDuplicates = 5; // Stop after 5 consecutive already-synced posts

  try {
    while (hasMore && isCollecting && consecutiveErrors < maxErrors) {
      try {
        const result = await fetchSavedPostsPage(cursor);

        if (!result.success) {
          consecutiveErrors++;

          // Exponential backoff for rate limiting
          if (result.error?.includes('Rate limited') || result.error?.includes('429')) {
            currentDelay = Math.min(currentDelay * 2, MAX_DELAY_MS);
            console.warn(`[InstaMap] Rate limited! Waiting ${currentDelay / 1000}s before retry...`);
            updateIndicator(`⏳ Rate limited. Waiting ${Math.round(currentDelay / 1000)}s... (${totalFetched} saved)`, 'paused');

            // Save cursor so we can resume later
            if (cursor) {
              await chrome.storage.local.set({ [RESUME_CURSOR_KEY]: cursor });
            }

            await sleep(currentDelay);
            continue;
          }

          console.warn(`[InstaMap] API error (${consecutiveErrors}/${maxErrors}):`, result.error);

          if (consecutiveErrors >= maxErrors) {
            // Save cursor for resume
            if (cursor) {
              await chrome.storage.local.set({ [RESUME_CURSOR_KEY]: cursor });
              console.log('[InstaMap] Saved resume cursor for later');
            }
            break;
          }

          await sleep(3000);
          continue;
        }

        // Success! Reset error count and delay
        consecutiveErrors = 0;
        currentDelay = BASE_DELAY_MS;

        // Process posts
        console.log(`[InstaMap] Processing ${result.posts.length} posts from API page...`);

        for (const post of result.posts) {
          console.log(`[InstaMap] Checking post: ${post.instagramId}`);

          if (!seenIds.has(post.instagramId)) {
            // Check if this post already exists (for smart collection)
            const isExisting = stopAtExisting && existingPostIds.has(post.instagramId);
            console.log(`[InstaMap] Post ${post.instagramId} - isExisting: ${isExisting}`);

            if (isExisting) {
              consecutiveDuplicates++;
              console.log(`[InstaMap] Found existing post ${post.instagramId} (${consecutiveDuplicates}/${maxConsecutiveDuplicates})`);

              if (consecutiveDuplicates >= maxConsecutiveDuplicates) {
                console.log('[InstaMap] Reached existing posts, stopping collection');
                hasMore = false;
                break;
              }
              continue; // Skip this post, don't add it again
            }

            // Reset consecutive duplicates counter on new post
            consecutiveDuplicates = 0;
            seenIds.add(post.instagramId);
            collectedPosts.push(post);
            console.log(`[InstaMap] Found NEW post: ${post.instagramId}`);
          }
        }

        // Update count BEFORE checking for exit
        totalFetched = collectedPosts.length;
        hasMore = result.hasMore;
        cursor = result.nextCursor;

        // Check if we should stop due to reaching existing posts
        if (stopAtExisting && consecutiveDuplicates >= maxConsecutiveDuplicates) {
          console.log(`[InstaMap] Smart collection complete: ${totalFetched} new posts found`);
          hasMore = false; // Mark as complete
          break;
        }

        // Update progress
        let statusText: string;
        if (stopAtExisting) {
          statusText = `🔄 Found ${totalFetched} new posts...`;
        } else if (resuming) {
          statusText = `🔄 Resumed: ${totalFetched} posts fetched...`;
        } else {
          statusText = `🔄 Fetched ${totalFetched} posts via API...`;
        }
        updateIndicator(statusText, 'collecting');

        chrome.runtime.sendMessage({
          type: 'COLLECTION_PROGRESS',
          collected: totalFetched,
          status: 'scrolling',
        }).catch(() => { });

        // Save progress every 50 posts + save cursor
        if (totalFetched % 50 === 0) {
          await saveProgress();
          if (cursor) {
            await chrome.storage.local.set({ [RESUME_CURSOR_KEY]: cursor });
          }
          console.log(`[InstaMap] Saved progress: ${totalFetched} posts, cursor saved`);
        }

        // Delay between requests (1-2 seconds randomized)
        const delay = BASE_DELAY_MS + Math.random() * 1000;
        await sleep(delay);

      } catch (error) {
        consecutiveErrors++;
        console.error('[InstaMap] Fetch error:', error);

        if (consecutiveErrors >= maxErrors) {
          // Save cursor for resume
          if (cursor) {
            await chrome.storage.local.set({ [RESUME_CURSOR_KEY]: cursor });
          }
          break;
        }

        currentDelay = Math.min(currentDelay * 1.5, MAX_DELAY_MS);
        await sleep(currentDelay);
      }
    }

    // Final save
    await saveProgress();

    // Clear resume cursor on successful completion
    if (!hasMore) {
      await chrome.storage.local.remove(RESUME_CURSOR_KEY);
      console.log('[InstaMap] Collection complete, cleared resume cursor');
    }

    // Refresh expired image URLs from backend
    let expiredRefreshed = 0;
    console.log('[InstaMap] Collection done. stopAtExisting:', stopAtExisting, 'hasMore:', hasMore);
    if (stopAtExisting && !hasMore) {
      console.log('[InstaMap] Calling refreshExpiredImages()...');
      expiredRefreshed = await refreshExpiredImages();
      console.log('[InstaMap] refreshExpiredImages returned:', expiredRefreshed);
    } else {
      console.log('[InstaMap] Skipping refreshExpiredImages - condition not met');
    }

    let message: string;
    if (!hasMore) {
      if (stopAtExisting) {
        if (totalFetched > 0 && expiredRefreshed > 0) {
          message = `✅ Found ${totalFetched} new, refreshed ${expiredRefreshed} images!`;
        } else if (totalFetched > 0) {
          message = `✅ Found ${totalFetched} new post${totalFetched === 1 ? '' : 's'}!`;
        } else if (expiredRefreshed > 0) {
          message = `✅ All caught up! Refreshed ${expiredRefreshed} expired images.`;
        } else {
          message = `✅ All caught up! No new posts.`;
        }
      } else {
        message = `✅ Done! Fetched all ${totalFetched} posts`;
      }
    } else {
      message = isCollecting
        ? `⚠️ Stopped early. Saved ${totalFetched} posts. Resume later!`
        : `⏹️ Stopped. Saved ${totalFetched} posts. Resume later!`;
    }

    updateIndicator(message, hasMore ? 'paused' : 'done');

    chrome.runtime.sendMessage({
      type: 'COLLECTION_PROGRESS',
      collected: totalFetched,
      status: 'done',
    }).catch(() => { });

    chrome.runtime.sendMessage({
      type: 'POSTS_SCRAPED',
      posts: collectedPosts,
    }).catch(() => { });

  } catch (error) {
    console.error('[InstaMap] API collection error:', error);

    // Save cursor for resume on any error
    if (cursor) {
      await chrome.storage.local.set({ [RESUME_CURSOR_KEY]: cursor });
    }

    if (collectedPosts.length > 0) {
      await saveProgress();
      updateIndicator(`❌ Error. Saved ${collectedPosts.length} posts. Resume later!`, 'error');
    } else {
      updateIndicator('❌ API collection failed', 'error');
    }

    chrome.runtime.sendMessage({
      type: 'COLLECTION_PROGRESS',
      collected: collectedPosts.length,
      status: 'done',
    }).catch(() => { });

  } finally {
    isCollecting = false;

    setTimeout(() => {
      if (!isCollecting) {
        updateIndicator('🗺️ InstaMap Ready', 'ready');
      }
    }, 10000);
  }
}

// Fetch a page of saved posts via Instagram's internal API
async function fetchSavedPostsPage(cursor: string | null): Promise<{
  success: boolean;
  posts: InstagramPost[];
  hasMore: boolean;
  nextCursor: string | null;
  error?: string;
}> {
  try {
    // Build URL with cursor for pagination
    let url = `https://www.instagram.com${SAVED_POSTS_ENDPOINT}`;
    if (cursor) {
      url += `?max_id=${cursor}`;
    }

    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include', // Include cookies for auth
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'X-IG-App-ID': '936619743392459', // Instagram web app ID
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return { success: false, posts: [], hasMore: false, nextCursor: null, error: 'Not logged in' };
      }
      if (response.status === 429) {
        return { success: false, posts: [], hasMore: false, nextCursor: null, error: 'Rate limited' };
      }
      return { success: false, posts: [], hasMore: false, nextCursor: null, error: `HTTP ${response.status}` };
    }

    const data = await response.json();

    // Parse the response
    const posts: InstagramPost[] = [];
    const items = data.items || [];

    for (const item of items) {
      const media = item.media || item;

      const post: InstagramPost = {
        id: `post_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        instagramId: media.code || media.pk?.toString() || '',
        imageUrl: extractBestImage(media),
        thumbnailUrl: extractBestImage(media),
        caption: media.caption?.text || '',
        ownerUsername: media.user?.username || '',
        timestamp: media.taken_at ? new Date(media.taken_at * 1000).toISOString() : new Date().toISOString(),
        savedAt: new Date().toISOString(),
        isVideo: media.media_type === 2 || media.is_video || false,
      };

      if (post.instagramId && post.imageUrl) {
        posts.push(post);
      }
    }

    // Check for more pages
    const hasMore = data.more_available || false;
    const nextCursor = data.next_max_id || null;

    return { success: true, posts, hasMore, nextCursor };

  } catch (error) {
    console.error('[InstaMap] API fetch error:', error);
    return {
      success: false,
      posts: [],
      hasMore: false,
      nextCursor: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// Extract best quality image URL from media object
function extractBestImage(media: Record<string, unknown>): string {
  // Try different image sources
  if (media.image_versions2) {
    const versions = media.image_versions2 as { candidates?: Array<{ url: string; width: number }> };
    if (versions.candidates && versions.candidates.length > 0) {
      // Sort by width and get largest
      const sorted = [...versions.candidates].sort((a, b) => b.width - a.width);
      return sorted[0].url;
    }
  }

  if (media.carousel_media) {
    // For carousel posts, get first image
    const carousel = media.carousel_media as Array<Record<string, unknown>>;
    if (carousel.length > 0) {
      return extractBestImage(carousel[0]);
    }
  }

  // Fallback options
  if (typeof media.display_url === 'string') return media.display_url;
  if (typeof media.thumbnail_src === 'string') return media.thumbnail_src;
  if (typeof media.thumbnail_url === 'string') return media.thumbnail_url;

  return '';
}

// ============================================
// SCROLL-BASED COLLECTION (legacy method)
// ============================================

// Quick sync - auto-scroll within current tab
async function startQuickSync() {
  if (isCollecting) {
    console.log('[InstaMap] Already collecting, ignoring duplicate start');
    return;
  }

  if (!isOnSavedPostsPage()) {
    updateIndicator('⚠️ Go to Saved Posts page first', 'error');
    chrome.runtime.sendMessage({
      type: 'COLLECTION_PROGRESS',
      collected: 0,
      status: 'done',
    }).catch(() => { });
    setTimeout(() => updateIndicator('🗺️ InstaMap Ready', 'ready'), 3000);
    return;
  }

  console.log('[InstaMap] Starting collection...');
  isCollecting = true;
  collectedPosts = [];
  seenIds.clear();

  const settings = await getSettings();
  const scrollDelay = settings.scrollDelayMs || 2000;

  // Handle visibility changes - but allow background collection if started from collector
  const handleVisibilityChange = () => {
    if (document.hidden) {
      // Don't pause if we were started programmatically (from collector)
      // The collector opens the tab in background, so we should keep running
      console.log('[InstaMap] Tab became hidden, continuing collection...');
      chrome.runtime.sendMessage({
        type: 'COLLECTION_PROGRESS',
        collected: collectedPosts.length,
        status: 'scrolling',
      }).catch(() => { });
    } else {
      if (isCollecting) {
        updateIndicator(`📥 Collecting... ${collectedPosts.length} posts`, 'collecting');
      }
    }
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);

  updateIndicator('📥 Starting collection... (click to stop)', 'collecting');

  let noNewPostsCount = 0;
  let lastPostCount = 0;
  let consecutiveErrors = 0;
  let lastScrollHeight = 0;
  const maxConsecutiveErrors = 3;

  try {
    while (isCollecting && noNewPostsCount < 5) {
      if (!isCollecting) break;

      // Check for rate limiting / error indicators
      const errorDetected = detectInstagramError();
      if (errorDetected) {
        consecutiveErrors++;
        console.warn(`[InstaMap] Error detected (${consecutiveErrors}/${maxConsecutiveErrors}):`, errorDetected);

        if (consecutiveErrors >= maxConsecutiveErrors) {
          // Save what we have and stop
          await saveProgress();
          updateIndicator(`⚠️ Stopped: ${errorDetected}. Saved ${collectedPosts.length} posts ✓`, 'error');
          break;
        }

        // Wait longer before retrying
        updateIndicator(`⚠️ Issue detected, waiting... (${collectedPosts.length} posts saved)`, 'paused');
        await sleep(5000);
        continue;
      }

      consecutiveErrors = 0; // Reset on success

      // Scrape visible posts
      await scrapeVisiblePosts();

      updateIndicator(`📥 Collecting... ${collectedPosts.length} posts (click to stop)`, 'collecting');

      // Send progress to collector window
      chrome.runtime.sendMessage({
        type: 'COLLECTION_PROGRESS',
        collected: collectedPosts.length,
        status: 'scrolling',
      }).catch(() => { /* Collector might not be listening */ });

      // Check if we found new posts
      if (collectedPosts.length === lastPostCount) {
        noNewPostsCount++;
        console.log(`[InstaMap] No new posts found (${noNewPostsCount}/5)`);
      } else {
        noNewPostsCount = 0;
        lastPostCount = collectedPosts.length;
      }

      // Check if page is still scrollable
      const currentScrollHeight = document.documentElement.scrollHeight;
      if (currentScrollHeight === lastScrollHeight && noNewPostsCount > 0) {
        // Page hasn't grown, might be at the end
        noNewPostsCount++;
      }
      lastScrollHeight = currentScrollHeight;

      // Scroll down
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: 'smooth'
      });

      // Wait for content to load
      await sleep(scrollDelay);

      // Save progress incrementally every 10 posts
      if (collectedPosts.length % 10 === 0 && collectedPosts.length > 0) {
        await saveProgress();
        console.log(`[InstaMap] Progress saved: ${collectedPosts.length} posts`);
      }
    }

    // Final save
    await saveProgress();

    const wasInterrupted = !isCollecting;
    const message = wasInterrupted
      ? `⏹️ Stopped. Saved ${collectedPosts.length} posts ✓`
      : `✅ Done! Collected ${collectedPosts.length} posts ✓`;

    updateIndicator(message, 'done');

    // Notify collector with final count
    chrome.runtime.sendMessage({
      type: 'COLLECTION_PROGRESS',
      collected: collectedPosts.length,
      status: 'done',
    }).catch(() => { });

    // Notify background
    chrome.runtime.sendMessage({
      type: 'POSTS_SCRAPED',
      posts: collectedPosts,
    }).catch(() => { });

  } catch (error) {
    console.error('[InstaMap] Collection error:', error);

    // Still save what we have
    if (collectedPosts.length > 0) {
      await saveProgress();
      updateIndicator(`❌ Error occurred. Saved ${collectedPosts.length} posts ✓`, 'error');
    } else {
      updateIndicator(`❌ Error: ${error}`, 'error');
    }
  } finally {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    isCollecting = false;

    // Reset to ready state after 10 seconds
    setTimeout(() => {
      if (!isCollecting) {
        updateIndicator('🗺️ InstaMap Ready', 'ready');
      }
    }, 10000);
  }
}

// Detect Instagram error/rate limiting
function detectInstagramError(): string | null {
  // Check for common error messages
  const errorTexts = [
    'Please wait a few minutes',
    'Try again later',
    'Something went wrong',
    'Couldn\'t load',
    'Error loading',
    'rate limit',
    'too many requests',
  ];

  const bodyText = document.body.innerText.toLowerCase();

  for (const errorText of errorTexts) {
    if (bodyText.includes(errorText.toLowerCase())) {
      return errorText;
    }
  }

  // Check if posts grid has disappeared
  const gridSelectors = [
    'article',
    'main a[href*="/p/"]',
    'div[style*="flex-direction: column"] a[href*="/p/"]',
  ];

  let hasGrid = false;
  for (const selector of gridSelectors) {
    if (document.querySelector(selector)) {
      hasGrid = true;
      break;
    }
  }

  if (!hasGrid && collectedPosts.length > 0) {
    return 'Posts grid disappeared - possible rate limit';
  }

  return null;
}

// Stop collection
function stopCollection() {
  isCollecting = false;
  updateIndicator(`⏹️ Stopped. Collected ${collectedPosts.length} posts`, 'done');

  // Save whatever we have
  saveProgress();

  // Notify collector
  chrome.runtime.sendMessage({
    type: 'COLLECTION_PROGRESS',
    collected: collectedPosts.length,
    status: 'done',
  }).catch(() => { });
}

// Save progress to storage
async function saveProgress() {
  if (collectedPosts.length === 0) return;

  const allPosts = await addPosts(collectedPosts);
  await updateSyncStatus({
    lastSync: new Date().toISOString(),
    totalPosts: allPosts.length,
  });

  console.log(`[InstaMap] Saved ${collectedPosts.length} posts, total: ${allPosts.length}`);
}

// Refresh expired images by fetching their IDs from backend and getting fresh URLs
async function refreshExpiredImages(): Promise<number> {
  console.log('[InstaMap] refreshExpiredImages() called');
  let totalSaved = 0;

  try {
    // Get expired Instagram IDs from backend via background script (bypasses CORS)
    const data = await chrome.runtime.sendMessage({ type: 'FETCH_EXPIRED_IMAGES' });
    console.log('[InstaMap] Expired data:', { count: data.count, postsLength: data.posts?.length });

    const { posts: expiredPosts } = data;
    if (!expiredPosts || expiredPosts.length === 0) {
      console.log('[InstaMap] No expired images to refresh');
      return 0;
    }

    const expiredIds = expiredPosts.map((p: { instagramId: string }) => p.instagramId);
    console.log(`[InstaMap] Found ${expiredIds.length} expired images to refresh`);

    updateIndicator(`🔄 Refreshing ${expiredIds.length} expired images...`, 'collecting');

    // Batch save callback - saves incrementally to survive crashes
    const saveBatch = async (updates: Array<{ instagramId: string; imageUrl: string }>) => {
      // Update local storage
      const stored = await chrome.storage.local.get('instamap_posts');
      const posts: InstagramPost[] = stored.instamap_posts || [];
      const updateMap = new Map(updates.map(u => [u.instagramId, u.imageUrl]));

      for (const post of posts) {
        const newUrl = updateMap.get(post.instagramId);
        if (newUrl) {
          post.imageUrl = newUrl;
          post.thumbnailUrl = newUrl;
        }
      }
      await chrome.storage.local.set({ instamap_posts: posts });

      // Update backend via background script (bypasses CORS)
      const updateResult = await chrome.runtime.sendMessage({
        type: 'UPDATE_IMAGE_URLS',
        updates: updates.map(u => ({ instagramId: u.instagramId, imageUrl: u.imageUrl }))
      });

      totalSaved += updateResult.updated || updates.length;
      console.log(`[InstaMap] Batch saved ${updates.length} URLs, total: ${totalSaved}`);
    };

    // Fetch fresh URLs with incremental saves
    const result = await refreshImageUrls(expiredIds, saveBatch);
    console.log('[InstaMap] refreshImageUrls complete:', { found: result.found, notFound: result.notFound, totalSaved });

    return totalSaved;
  } catch (err) {
    console.warn('[InstaMap] Failed to refresh expired images:', err);
    // Return what was saved before the error
    return totalSaved;
  }
}

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Initialize on page load
function init() {
  console.log('[InstaMap] Content script initialized on:', window.location.pathname);

  if (isOnSavedPostsPage()) {
    console.log('[InstaMap] Detected saved posts page, ready to collect');
    updateIndicator('🗺️ InstaMap Ready', 'ready');
  } else {
    // Show indicator on all Instagram pages so user knows extension is active
    console.log('[InstaMap] Not on saved page, showing navigation hint');
    updateIndicator('🗺️ InstaMap (Go to Saved)', 'ready');
  }
}

// Run init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Re-init on navigation (Instagram is a SPA)
let lastUrl = location.href;
new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    setTimeout(init, 1000);
  }
}).observe(document, { subtree: true, childList: true });

// Refresh image URLs for specific Instagram IDs by fetching from API
// This is graceful and doesn't require scrolling - just API calls
// Rate limited, with incremental saves every 50 updates
async function refreshImageUrls(
  instagramIds: string[],
  onBatchSave?: (updates: Array<{ instagramId: string; imageUrl: string }>) => Promise<void>
): Promise<{
  success: boolean;
  updates: Array<{ instagramId: string; imageUrl: string }>;
  found: number;
  notFound: number;
}> {
  if (instagramIds.length === 0) {
    return { success: true, updates: [], found: 0, notFound: 0 };
  }

  const total = instagramIds.length;
  console.log(`[InstaMap] Refreshing image URLs for ${total} posts...`);
  updateIndicator(`🔄 Refreshing 0/${total} expired...`, 'collecting');

  const idsToFind = new Set(instagramIds);
  const allUpdates: Array<{ instagramId: string; imageUrl: string }> = [];
  let cursor: string | null = null;
  let hasMore = true;
  let pagesSearched = 0;
  let savedCount = 0;

  // Estimate pages needed (~15 posts per page)
  const estimatedPages = Math.ceil(total / 10);

  // Dynamic rate limiting
  const DELAY_BETWEEN_PAGES = total < 100 ? 200 : total < 500 ? 400 : 600;
  const maxPages = Math.max(estimatedPages * 3, 500);

  console.log(`[InstaMap] Using ${DELAY_BETWEEN_PAGES}ms delay, max ${maxPages} pages, saving after each page`);

  while (hasMore && idsToFind.size > 0 && pagesSearched < maxPages) {
    try {
      const result = await fetchSavedPostsPage(cursor);

      if (!result.success) {
        console.warn(`[InstaMap] API error while refreshing:`, result.error);
        await sleep(3000);
        continue;
      }

      pagesSearched++;

      // Check each post for matching IDs
      const pageUpdates: Array<{ instagramId: string; imageUrl: string }> = [];
      for (const post of result.posts) {
        if (idsToFind.has(post.instagramId)) {
          const update = { instagramId: post.instagramId, imageUrl: post.imageUrl };
          allUpdates.push(update);
          pageUpdates.push(update);
          idsToFind.delete(post.instagramId);
        }
      }

      // Save immediately after each page
      if (pageUpdates.length > 0 && onBatchSave) {
        await onBatchSave(pageUpdates);
        savedCount += pageUpdates.length;
      }

      // Update progress indicator
      updateIndicator(`🔄 Refreshing ${allUpdates.length}/${total} expired...`, 'collecting');

      hasMore = result.hasMore;
      cursor = result.nextCursor;

      if (idsToFind.size === 0) break;

      if (hasMore) {
        await sleep(DELAY_BETWEEN_PAGES);
      }

      // Log progress every 20 pages
      if (pagesSearched % 20 === 0) {
        console.log(`[InstaMap] Searched ${pagesSearched} pages, found ${allUpdates.length}/${total}, saved ${savedCount}`);
      }

    } catch (error) {
      console.error('[InstaMap] Error refreshing image URLs:', error);
      break;
    }
  }

  console.log(`[InstaMap] Refresh complete: found ${allUpdates.length}/${total} in ${pagesSearched} pages, saved ${savedCount}`);

  return {
    success: true,
    updates: allUpdates,
    found: allUpdates.length,
    notFound: idsToFind.size,
  };
}

export { scrapeVisiblePosts, startQuickSync, stopCollection, refreshImageUrls };

