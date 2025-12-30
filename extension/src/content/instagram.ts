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
    indicator.onclick = () => {
      // Use API collection with smart stop (only collect new posts)
      startApiCollection(true);
    };
    indicator.title = 'Click to collect new posts';
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
  let existingPostIds = new Set<string>();
  if (stopAtExisting) {
    try {
      const stored = await chrome.storage.local.get('instamap_posts');
      const existingPosts: InstagramPost[] = stored.instamap_posts || [];
      existingPostIds = new Set(existingPosts.map((p) => p.instagramId));
      console.log(`[InstaMap] Loaded ${existingPostIds.size} existing post IDs`);
      // Log first few IDs for debugging
      const sampleIds = Array.from(existingPostIds).slice(0, 3);
      console.log('[InstaMap] Sample existing IDs:', sampleIds);
    } catch (err) {
      console.warn('[InstaMap] Could not load existing posts:', err);
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

    let message: string;
    if (!hasMore) {
      if (stopAtExisting) {
        message = totalFetched > 0
          ? `✅ Found ${totalFetched} new post${totalFetched === 1 ? '' : 's'}!`
          : `✅ All caught up! No new posts.`;
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

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Initialize on page load
function init() {
  if (isOnSavedPostsPage()) {
    console.log('[InstaMap] Detected saved posts page, ready to collect');
    updateIndicator('🗺️ InstaMap Ready', 'ready');
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
async function refreshImageUrls(instagramIds: string[]): Promise<{
  success: boolean;
  updates: Array<{ instagramId: string; imageUrl: string }>;
  found: number;
  notFound: number;
}> {
  if (instagramIds.length === 0) {
    return { success: true, updates: [], found: 0, notFound: 0 };
  }

  console.log(`[InstaMap] Refreshing image URLs for ${instagramIds.length} posts...`);

  const idsToFind = new Set(instagramIds);
  const updates: Array<{ instagramId: string; imageUrl: string }> = [];
  let cursor: string | null = null;
  let hasMore = true;
  let pagesSearched = 0;
  const maxPages = 50; // Limit to avoid too many API calls

  // Rate limiting
  const DELAY_BETWEEN_PAGES = 1500; // 1.5 seconds between pages

  while (hasMore && idsToFind.size > 0 && pagesSearched < maxPages) {
    try {
      const result = await fetchSavedPostsPage(cursor);

      if (!result.success) {
        console.warn(`[InstaMap] API error while refreshing:`, result.error);
        // Wait and retry once
        await sleep(3000);
        continue;
      }

      pagesSearched++;

      // Check each post for matching IDs
      for (const post of result.posts) {
        if (idsToFind.has(post.instagramId)) {
          updates.push({
            instagramId: post.instagramId,
            imageUrl: post.imageUrl,
          });
          idsToFind.delete(post.instagramId);
          console.log(`[InstaMap] Found fresh URL for ${post.instagramId}`);
        }
      }

      hasMore = result.hasMore;
      cursor = result.nextCursor;

      // If we found all posts, stop
      if (idsToFind.size === 0) {
        break;
      }

      // Rate limit between pages
      if (hasMore) {
        await sleep(DELAY_BETWEEN_PAGES);
      }

      // Log progress every 10 pages
      if (pagesSearched % 10 === 0) {
        console.log(`[InstaMap] Searched ${pagesSearched} pages, found ${updates.length}/${instagramIds.length} posts`);
      }

    } catch (error) {
      console.error('[InstaMap] Error refreshing image URLs:', error);
      break;
    }
  }

  console.log(`[InstaMap] Refresh complete: found ${updates.length}/${instagramIds.length} posts in ${pagesSearched} pages`);

  return {
    success: true,
    updates,
    found: updates.length,
    notFound: idsToFind.size,
  };
}

export { scrapeVisiblePosts, startQuickSync, stopCollection, refreshImageUrls };
