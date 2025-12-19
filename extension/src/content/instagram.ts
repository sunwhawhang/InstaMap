import { InstagramPost } from '../shared/types';
import { addPosts, updateSyncStatus } from '../shared/storage';

// Listen for messages from popup/background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SCRAPE_POSTS') {
    scrapeCurrentPage().then(posts => {
      sendResponse({ success: true, count: posts.length });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true; // Keep message channel open for async response
  }
});

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
  // Try to find a link to the post
  const link = element.querySelector('a[href*="/p/"]') as HTMLAnchorElement;
  if (link) {
    const match = link.href.match(/\/p\/([^/]+)/);
    if (match) return match[1];
  }
  
  // Try to find a link to reel
  const reelLink = element.querySelector('a[href*="/reel/"]') as HTMLAnchorElement;
  if (reelLink) {
    const match = reelLink.href.match(/\/reel\/([^/]+)/);
    if (match) return match[1];
  }
  
  return null;
}

// Extract image URL from various Instagram image formats
function extractImageUrl(element: Element): string | null {
  // Try to find the image directly
  const img = element.querySelector('img[src*="instagram"]') as HTMLImageElement;
  if (img?.src) return img.src;
  
  // Try srcset
  if (img?.srcset) {
    const srcset = img.srcset.split(',');
    const lastSrc = srcset[srcset.length - 1]?.trim().split(' ')[0];
    if (lastSrc) return lastSrc;
  }
  
  // Try video poster
  const video = element.querySelector('video') as HTMLVideoElement;
  if (video?.poster) return video.poster;
  
  return null;
}

// Check if the post is a video
function isVideoPost(element: Element): boolean {
  return element.querySelector('video') !== null || 
         element.querySelector('svg[aria-label*="Reel"]') !== null ||
         element.querySelector('span[aria-label*="Video"]') !== null;
}

// Main scraping function
async function scrapeCurrentPage(): Promise<InstagramPost[]> {
  if (!isOnSavedPostsPage()) {
    console.log('[InstaMap] Not on saved posts page');
    return [];
  }

  console.log('[InstaMap] Starting to scrape saved posts...');
  await updateSyncStatus({ syncInProgress: true });

  const posts: InstagramPost[] = [];
  const seenIds = new Set<string>();

  // Instagram uses a grid layout - find all post containers
  // The structure varies, so we try multiple selectors
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
      console.log(`[InstaMap] Found ${elements.length} elements with selector: ${selector}`);
      break;
    }
  }

  // Fallback: find all links to posts
  if (postElements.length === 0) {
    const allLinks = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
    postElements = Array.from(allLinks);
    console.log(`[InstaMap] Fallback: Found ${postElements.length} post links`);
  }

  for (const element of postElements) {
    try {
      const instagramId = extractInstagramId(element) || 
                          extractInstagramId(element.parentElement!) ||
                          extractInstagramId(element.closest('article') || element);
      
      if (!instagramId || seenIds.has(instagramId)) continue;
      seenIds.add(instagramId);

      // Find the closest container that might have the image
      const container = element.closest('div[class]') || element;
      const imageUrl = extractImageUrl(container) || extractImageUrl(element);

      if (!imageUrl) {
        console.log(`[InstaMap] Skipping post ${instagramId} - no image found`);
        continue;
      }

      const post: InstagramPost = {
        id: generatePostId(),
        instagramId,
        imageUrl,
        thumbnailUrl: imageUrl,
        caption: '', // Caption requires opening the post
        ownerUsername: '', // Would need to open post to get this
        timestamp: new Date().toISOString(),
        savedAt: new Date().toISOString(),
        isVideo: isVideoPost(container),
      };

      posts.push(post);
    } catch (error) {
      console.error('[InstaMap] Error processing post element:', error);
    }
  }

  console.log(`[InstaMap] Scraped ${posts.length} posts`);

  // Save to storage
  if (posts.length > 0) {
    const allPosts = await addPosts(posts);
    await updateSyncStatus({
      syncInProgress: false,
      lastSync: new Date().toISOString(),
      totalPosts: allPosts.length,
    });
  } else {
    await updateSyncStatus({ syncInProgress: false });
  }

  // Notify background script
  chrome.runtime.sendMessage({
    type: 'POSTS_SCRAPED',
    posts,
  });

  return posts;
}

// Auto-scroll to load more posts (optional, can be triggered)
async function scrollToLoadMore(maxScrolls = 5): Promise<void> {
  for (let i = 0; i < maxScrolls; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}

// Observe for dynamically loaded posts
function observeForNewPosts(callback: (posts: InstagramPost[]) => void): MutationObserver {
  const observer = new MutationObserver(async (mutations) => {
    const hasNewContent = mutations.some(m => m.addedNodes.length > 0);
    if (hasNewContent) {
      // Debounce to avoid too many scrapes
      const posts = await scrapeCurrentPage();
      if (posts.length > 0) {
        callback(posts);
      }
    }
  });

  const targetNode = document.querySelector('main') || document.body;
  observer.observe(targetNode, { childList: true, subtree: true });
  
  return observer;
}

// Initialize on page load
function init() {
  if (isOnSavedPostsPage()) {
    console.log('[InstaMap] Detected saved posts page, ready to scrape');
    
    // Add a small indicator that extension is active
    const indicator = document.createElement('div');
    indicator.id = 'instamap-indicator';
    indicator.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: linear-gradient(45deg, #833AB4, #E1306C);
      color: white;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      z-index: 9999;
      box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      cursor: pointer;
    `;
    indicator.textContent = '🗺️ InstaMap Ready';
    indicator.onclick = () => {
      scrapeCurrentPage();
      indicator.textContent = '🗺️ Scraping...';
      setTimeout(() => {
        indicator.textContent = '🗺️ InstaMap Ready';
      }, 2000);
    };
    
    // Only add if not already present
    if (!document.getElementById('instamap-indicator')) {
      document.body.appendChild(indicator);
    }
  }
}

// Run init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Export for potential use elsewhere
export { scrapeCurrentPage, scrollToLoadMore, observeForNewPosts };
