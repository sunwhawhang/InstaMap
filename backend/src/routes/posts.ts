import { Router, Request, Response } from 'express';
import { neo4jService } from '../services/neo4j.js';
import { embeddingsService } from '../services/embeddings.js';
import { claudeService } from '../services/claude.js';
import { geocodingService } from '../services/geocoding.js';
import { categoryCleanupService } from '../services/categoryCleanup.js';
import { imageStorageService } from '../services/imageStorage.js';
import { InstagramPost, SyncPostsRequest, AutoCategorizeRequest } from '../types/index.js';

export const postsRouter = Router();

// ============ IMAGE PROXY (must be before other routes) ============
// This proxies Instagram images to bypass CORS restrictions in the extension.
// If a local image exists, serve it instead of proxying from Instagram.
// If Instagram returns 403, mark the post's image as expired.
postsRouter.get('/image-proxy', async (req: Request, res: Response) => {
  try {
    const imageUrl = req.query.url as string;
    const postId = req.query.postId as string;

    if (!imageUrl) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    // Check if we have a locally stored image OR if image is already marked expired
    if (postId) {
      try {
        const post = await neo4jService.getPostById(postId);

        // If we have a local image, serve it
        if (post?.localImagePath && imageStorageService.exists(post.localImagePath)) {
          const fullPath = imageStorageService.getFullPath(post.localImagePath);
          res.setHeader('Content-Type', 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year (local)
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('X-Image-Source', 'local');
          return res.sendFile(fullPath);
        }

        // If image is already marked expired, don't retry fetching from Instagram
        // This saves bandwidth and avoids repeated 403 errors
        if (post?.imageExpired) {
          return res.status(403).json({
            error: 'Image expired (cached)',
            expired: true,
            postId,
            cachedExpiry: true, // Indicates this was cached, not a new 403
          });
        }
      } catch (e) {
        // Continue to proxy from Instagram
      }
    }

    // Validate URL is from Instagram CDN
    const url = new URL(imageUrl);
    if (!url.hostname.includes('cdninstagram.com') && !url.hostname.includes('instagram.com')) {
      return res.status(400).json({ error: 'Only Instagram URLs are allowed' });
    }

    // Fetch the image from Instagram
    const response = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.instagram.com/',
      },
    });

    if (!response.ok) {
      console.error(`[Image Proxy] Failed to fetch: ${response.status} ${response.statusText}`);

      // If 403 (expired), mark the post image as expired
      if (response.status === 403 && postId) {
        try {
          await neo4jService.markPostImageExpired(postId);
          console.log(`[Image Proxy] Marked post ${postId} image as expired`);
        } catch (e) {
          console.error(`[Image Proxy] Failed to mark image expired:`, e);
        }
        return res.status(403).json({
          error: 'Image expired',
          expired: true,
          postId
        });
      }

      return res.status(response.status).json({ error: 'Failed to fetch image' });
    }

    // Get content type
    const contentType = response.headers.get('content-type') || 'image/jpeg';

    // Set response headers
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Image-Source', 'instagram');

    // Stream the image data
    const arrayBuffer = await response.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (error) {
    console.error('[Image Proxy] Error:', error);
    res.status(500).json({ error: 'Failed to proxy image' });
  }
});

// Serve locally stored images
postsRouter.get('/image/:filename', async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;

    if (!imageStorageService.exists(filename)) {
      return res.status(404).json({ error: 'Image not found' });
    }

    const fullPath = imageStorageService.getFullPath(filename);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.sendFile(fullPath);
  } catch (error) {
    console.error('[Image Serve] Error:', error);
    res.status(500).json({ error: 'Failed to serve image' });
  }
});

// Get cloud sync status (post count, last sync, etc.)
// Used by popup to show accurate data even when local cache is cleared
postsRouter.get('/sync-status', async (_req: Request, res: Response) => {
  try {
    const metadata = await neo4jService.getSyncMetadata();
    res.json(metadata);
  } catch (error) {
    console.error('Failed to get sync status:', error);
    res.status(500).json({ error: 'Failed to get sync status' });
  }
});

// Sync posts from extension
postsRouter.post('/sync', async (req: Request<{}, {}, SyncPostsRequest & { localPostCount?: number }>, res: Response) => {
  try {
    const { posts, storeImages = true, localPostCount } = req.body;

    if (!Array.isArray(posts)) {
      return res.status(400).json({ error: 'Posts must be an array' });
    }

    console.log(`Syncing ${posts.length} posts... (storeImages: ${storeImages})`);

    const synced = await neo4jService.upsertPosts(posts);

    // Update sync metadata with local post count at sync time
    // Use provided count or default to synced posts count
    const countToStore = localPostCount ?? posts.length;
    await neo4jService.updateSyncMetadata(countToStore);

    // Generate embeddings for posts with captions (in background)
    generateEmbeddingsInBackground(posts);

    // Download and store images in background (if enabled)
    if (storeImages) {
      downloadImagesInBackground(posts);
    }

    res.json({
      synced,
      total: posts.length,
      message: `Successfully synced ${synced} posts`,
      storeImages,
    });
  } catch (error) {
    console.error('Sync failed:', error);
    res.status(500).json({ error: 'Failed to sync posts' });
  }
});

// ============ IMAGE STORAGE ENDPOINTS ============

// Image download progress tracking
let imageDownloadProgress: {
  status: 'idle' | 'running' | 'done';
  processed: number;
  total: number;
  downloaded: number;
  failed: number;
  alreadyStored: number;
} = { status: 'idle', processed: 0, total: 0, downloaded: 0, failed: 0, alreadyStored: 0 };

// Image expiry check progress tracking
let expiryCheckProgress: {
  status: 'idle' | 'running' | 'done';
  processed: number;
  total: number;
  expired: number;
  valid: number;
  alreadyExpired: number;
  startedAt?: string;
} = { status: 'idle', processed: 0, total: 0, expired: 0, valid: 0, alreadyExpired: 0 };

// Daily auto expiry check - runs ONCE per day, checks all eligible posts at 5/sec
let dailyExpiryCheck: {
  enabled: boolean;
  lastRunDate?: string;      // Date string (YYYY-MM-DD) of last run
  lastRunStats?: {
    checked: number;
    expired: number;
    valid: number;
    duration: string;
  };
  nextScheduledRun?: string;
  status: 'idle' | 'running' | 'done';
  currentProgress?: {
    checked: number;
    total: number;
    expired: number;
  };
  runAtHour: number;         // Hour of day to run (0-23), default 3am
} = {
  enabled: true,
  status: 'idle',
  runAtHour: 3,              // Run at 3am by default
};

// Schedule the daily expiry check
function scheduleDailyExpiryCheck() {
  const now = new Date();
  const todayDateStr = now.toISOString().split('T')[0];

  // Calculate next run time
  const nextRun = new Date(now);
  nextRun.setHours(dailyExpiryCheck.runAtHour, 0, 0, 0);

  // If we've already passed that hour today, schedule for tomorrow
  if (now >= nextRun) {
    nextRun.setDate(nextRun.getDate() + 1);
  }

  // But if we haven't run today yet and server just started, run now
  const alreadyRanToday = dailyExpiryCheck.lastRunDate === todayDateStr;

  dailyExpiryCheck.nextScheduledRun = nextRun.toISOString();

  const msUntilNextRun = nextRun.getTime() - now.getTime();
  console.log(`[DailyExpiryCheck] Next scheduled run: ${nextRun.toLocaleString()} (in ${Math.round(msUntilNextRun / 1000 / 60)} minutes)`);

  // Schedule the next run
  setTimeout(() => {
    runDailyExpiryCheck();
    // After running, schedule the next one
    scheduleDailyExpiryCheck();
  }, msUntilNextRun);

  // If we haven't run today and it's after the scheduled hour, run now
  if (!alreadyRanToday && now.getHours() >= dailyExpiryCheck.runAtHour) {
    console.log(`[DailyExpiryCheck] Haven't run today, starting now...`);
    runDailyExpiryCheck();
  }
}

async function runDailyExpiryCheck() {
  if (!dailyExpiryCheck.enabled) {
    console.log('[DailyExpiryCheck] Disabled, skipping');
    return;
  }

  if (dailyExpiryCheck.status === 'running') {
    console.log('[DailyExpiryCheck] Already running, skipping');
    return;
  }

  const todayDateStr = new Date().toISOString().split('T')[0];

  try {
    // Get ALL posts that need checking (no local image, not already expired)
    const posts = await neo4jService.getPostsForExpiryCheck(10000, true);

    if (posts.length === 0) {
      console.log('[DailyExpiryCheck] No posts need checking (all have local images or already marked expired)');
      dailyExpiryCheck.lastRunDate = todayDateStr;
      dailyExpiryCheck.lastRunStats = { checked: 0, expired: 0, valid: 0, duration: '0s' };
      return;
    }

    console.log(`[DailyExpiryCheck] Starting check of ${posts.length} posts at 5/sec...`);
    dailyExpiryCheck.status = 'running';
    dailyExpiryCheck.currentProgress = { checked: 0, total: posts.length, expired: 0 };

    const startTime = Date.now();
    let expired = 0;
    let valid = 0;

    const DELAY_MS = 200; // 5 requests per second

    for (const post of posts) {
      if (!dailyExpiryCheck.enabled || dailyExpiryCheck.status !== 'running') {
        console.log('[DailyExpiryCheck] Stopped early');
        break;
      }

      try {
        const response = await fetch(post.imageUrl, {
          method: 'HEAD',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'image/*',
            'Referer': 'https://www.instagram.com/',
          },
        });

        if (response.status === 403 || !response.ok) {
          await neo4jService.markPostImageExpired(post.id);
          expired++;
        } else {
          valid++;
        }
      } catch {
        // Network error - skip, don't mark expired
      }

      dailyExpiryCheck.currentProgress!.checked++;
      dailyExpiryCheck.currentProgress!.expired = expired;

      // Log every 100
      if (dailyExpiryCheck.currentProgress!.checked % 100 === 0) {
        console.log(`[DailyExpiryCheck] Progress: ${dailyExpiryCheck.currentProgress!.checked}/${posts.length} (${expired} expired)`);
      }

      await new Promise(r => setTimeout(r, DELAY_MS));
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    const durationStr = duration > 60 ? `${Math.round(duration / 60)}m ${duration % 60}s` : `${duration}s`;

    dailyExpiryCheck.status = 'done';
    dailyExpiryCheck.lastRunDate = todayDateStr;
    dailyExpiryCheck.lastRunStats = {
      checked: dailyExpiryCheck.currentProgress!.checked,
      expired,
      valid,
      duration: durationStr,
    };
    dailyExpiryCheck.currentProgress = undefined;

    console.log(`[DailyExpiryCheck] Complete! Checked ${dailyExpiryCheck.lastRunStats.checked} posts in ${durationStr}. Found ${expired} expired.`);

  } catch (error) {
    console.error('[DailyExpiryCheck] Error:', error);
    dailyExpiryCheck.status = 'idle';
  }
}

// Initialize daily check scheduler after Neo4j is ready
setTimeout(() => {
  if (dailyExpiryCheck.enabled) {
    console.log('[DailyExpiryCheck] Initializing daily expiry check scheduler...');
    scheduleDailyExpiryCheck();
  }
}, 5000);

// Get image storage status
postsRouter.get('/images/status', async (_req: Request, res: Response) => {
  try {
    const dbStats = await neo4jService.getImageStorageStats();
    const storageStats = imageStorageService.getStats();

    res.json({
      ...dbStats,
      storageStats,
      downloadProgress: imageDownloadProgress,
      expiryCheckProgress,
      dailyExpiryCheck, // Daily auto-check status
    });
  } catch (error) {
    console.error('Failed to get image status:', error);
    res.status(500).json({ error: 'Failed to get image status' });
  }
});

// Gradually check for expired images in the background
// Uses HEAD requests first (faster), falls back to GET if needed
// Rate limited: 1 request per 2 seconds to avoid Instagram blocking
postsRouter.post('/images/check-expired', async (req: Request, res: Response) => {
  try {
    const { limit = 500, oldestFirst = true } = req.body;

    if (expiryCheckProgress.status === 'running') {
      return res.json({
        ...expiryCheckProgress,
        message: 'Already checking for expired images',
      });
    }

    // Get posts that don't have local images and aren't already marked expired
    const posts = await neo4jService.getPostsForExpiryCheck(limit, oldestFirst);

    if (posts.length === 0) {
      return res.json({
        status: 'done',
        message: 'No posts to check (all have local images or already marked expired)',
        processed: 0,
        expired: 0,
      });
    }

    // Initialize progress
    expiryCheckProgress = {
      status: 'running',
      processed: 0,
      total: posts.length,
      expired: 0,
      valid: 0,
      alreadyExpired: 0,
      startedAt: new Date().toISOString(),
    };

    // Estimate time (2 seconds per image)
    const estimatedMinutes = Math.ceil((posts.length * 2) / 60);

    res.json({
      status: 'started',
      total: posts.length,
      estimatedMinutes,
      message: `Checking ${posts.length} images for expiry. ETA: ~${estimatedMinutes} minutes. Poll /api/posts/images/status for progress.`,
    });

    // Run check in background
    checkImagesForExpiry(posts);

  } catch (error) {
    console.error('Failed to start expiry check:', error);
    expiryCheckProgress.status = 'idle';
    res.status(500).json({ error: 'Failed to start expiry check' });
  }
});

// Stop the expiry check
postsRouter.post('/images/check-expired/stop', async (_req: Request, res: Response) => {
  if (expiryCheckProgress.status === 'running') {
    expiryCheckProgress.status = 'done';
    res.json({ success: true, message: 'Expiry check stopped', ...expiryCheckProgress });
  } else {
    res.json({ success: false, message: 'No expiry check running' });
  }
});

// Get daily expiry check status
postsRouter.get('/images/daily-check', async (_req: Request, res: Response) => {
  res.json(dailyExpiryCheck);
});

// Configure daily expiry check
postsRouter.patch('/images/daily-check', async (req: Request, res: Response) => {
  const { enabled, runAtHour } = req.body;

  if (typeof enabled === 'boolean') {
    dailyExpiryCheck.enabled = enabled;
  }
  if (typeof runAtHour === 'number' && runAtHour >= 0 && runAtHour <= 23) {
    dailyExpiryCheck.runAtHour = runAtHour;
  }

  console.log(`[DailyExpiryCheck] Config updated: enabled=${dailyExpiryCheck.enabled}, runAtHour=${dailyExpiryCheck.runAtHour}`);

  res.json({
    success: true,
    message: 'Daily expiry check config updated',
    config: dailyExpiryCheck
  });
});

// Manually trigger daily check now
postsRouter.post('/images/daily-check/run', async (_req: Request, res: Response) => {
  if (dailyExpiryCheck.status === 'running') {
    return res.json({
      success: false,
      message: 'Already running',
      ...dailyExpiryCheck
    });
  }

  // Run in background
  runDailyExpiryCheck();

  res.json({
    success: true,
    message: 'Daily expiry check started',
    status: 'running'
  });
});

// Stop daily check
postsRouter.post('/images/daily-check/stop', async (_req: Request, res: Response) => {
  if (dailyExpiryCheck.status === 'running') {
    dailyExpiryCheck.status = 'idle';
    res.json({ success: true, message: 'Stopped' });
  } else {
    res.json({ success: false, message: 'Not running' });
  }
});

// Get posts with expired images
postsRouter.get('/images/expired', async (_req: Request, res: Response) => {
  try {
    const posts = await neo4jService.getPostsWithExpiredImages();
    res.json({ posts, count: posts.length });
  } catch (error) {
    console.error('Failed to get expired images:', error);
    res.status(500).json({ error: 'Failed to get expired images' });
  }
});

// Mark a post's image as expired (for frontend to call on 403)
postsRouter.post('/images/mark-expired', async (req: Request, res: Response) => {
  try {
    const { postId } = req.body;

    if (!postId) {
      return res.status(400).json({ error: 'postId is required' });
    }

    await neo4jService.markPostImageExpired(postId);
    res.json({ success: true, message: `Marked post ${postId} image as expired` });
  } catch (error) {
    console.error('Failed to mark image expired:', error);
    res.status(500).json({ error: 'Failed to mark image expired' });
  }
});

// Download all images that don't have local copies
postsRouter.post('/images/download-all', async (_req: Request, res: Response) => {
  try {
    if (imageDownloadProgress.status === 'running') {
      return res.json({
        ...imageDownloadProgress,
        message: 'Already downloading images',
      });
    }

    const postsNeedingDownload = await neo4jService.getPostsNeedingImageDownload();

    if (postsNeedingDownload.length === 0) {
      return res.json({
        status: 'done',
        downloaded: 0,
        total: 0,
        message: 'All posts already have local images',
      });
    }

    // Initialize progress
    imageDownloadProgress = {
      status: 'running',
      processed: 0,
      total: postsNeedingDownload.length,
      downloaded: 0,
      failed: 0,
      alreadyStored: 0,
    };

    // Return immediately, download in background
    res.json({
      status: 'started',
      total: postsNeedingDownload.length,
      message: `Started downloading ${postsNeedingDownload.length} images. Poll /api/posts/images/status for progress.`,
    });

    // Download in background
    downloadImagesInBackground(postsNeedingDownload);

  } catch (error) {
    console.error('Failed to start image download:', error);
    imageDownloadProgress.status = 'idle';
    res.status(500).json({ error: 'Failed to start image download' });
  }
});

// Update image URL for a post (when refreshed from Instagram)
postsRouter.patch('/:id/image-url', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { imageUrl } = req.body;

    if (!imageUrl) {
      return res.status(400).json({ error: 'imageUrl is required' });
    }

    await neo4jService.updatePostImageUrl(id, imageUrl);
    res.json({ success: true, message: 'Image URL updated' });
  } catch (error) {
    console.error('Failed to update image URL:', error);
    res.status(500).json({ error: 'Failed to update image URL' });
  }
});

// Bulk update image URLs (from frontend after re-collection)
postsRouter.post('/images/refresh-urls', async (req: Request, res: Response) => {
  try {
    const { updates } = req.body as { updates: Array<{ postId: string; imageUrl: string }> };

    if (!Array.isArray(updates)) {
      return res.status(400).json({ error: 'updates must be an array' });
    }

    let updated = 0;
    for (const { postId, imageUrl } of updates) {
      try {
        await neo4jService.updatePostImageUrl(postId, imageUrl);
        updated++;
      } catch (e) {
        console.error(`Failed to update image URL for ${postId}:`, e);
      }
    }

    res.json({
      success: true,
      updated,
      total: updates.length,
      message: `Updated ${updated}/${updates.length} image URLs`,
    });
  } catch (error) {
    console.error('Failed to refresh image URLs:', error);
    res.status(500).json({ error: 'Failed to refresh image URLs' });
  }
});

// Get all posts
postsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const categoryId = req.query.category as string;
    const recursive = req.query.recursive === 'true';

    const posts = await neo4jService.getPosts({
      limit,
      offset,
      categoryId,
      recursive: categoryId ? (req.query.recursive !== 'false') : false
    });
    res.json(posts);
  } catch (error) {
    console.error('Failed to get posts:', error);
    res.status(500).json({ error: 'Failed to get posts' });
  }
});

// Get categorized post IDs
postsRouter.get('/categorized-ids', async (_req: Request, res: Response) => {
  try {
    const postIds = await neo4jService.getCategorizedPostIds();
    res.json({ postIds });
  } catch (error) {
    console.error('Failed to get categorized post IDs:', error);
    res.status(500).json({ error: 'Failed to get categorized post IDs' });
  }
});

// Get all post IDs (for calculating overlap with local cache)
postsRouter.get('/all-ids', async (_req: Request, res: Response) => {
  try {
    const postIds = await neo4jService.getAllPostIds();
    res.json({ postIds });
  } catch (error) {
    console.error('Failed to get all post IDs:', error);
    res.status(500).json({ error: 'Failed to get all post IDs' });
  }
});

// ============ MAP / GEOCODING ENDPOINTS ============
// NOTE: These must be defined BEFORE /:id route to avoid being caught by it

// Get posts with coordinates (for map display)
postsRouter.get('/with-coordinates', async (_req: Request, res: Response) => {
  try {
    const posts = await neo4jService.getPostsWithCoordinates();
    res.json({ posts, count: posts.length });
  } catch (error) {
    console.error('Failed to get posts with coordinates:', error);
    res.status(500).json({ error: 'Failed to get posts with coordinates' });
  }
});

// Get posts that need geocoding
postsRouter.get('/needs-geocoding', async (_req: Request, res: Response) => {
  try {
    const posts = await neo4jService.getPostsNeedingGeocoding();
    res.json({ posts, count: posts.length });
  } catch (error) {
    console.error('Failed to get posts needing geocoding:', error);
    res.status(500).json({ error: 'Failed to get posts needing geocoding' });
  }
});

// Geocoding progress tracking
let geocodingProgress: {
  status: 'idle' | 'running' | 'done';
  processed: number;
  total: number;
  geocoded: number;
  failed: number;
  localHits: number;
  apiHits: number;
  currentLocation?: string;
} = { status: 'idle', processed: 0, total: 0, geocoded: 0, failed: 0, localHits: 0, apiHits: 0 };

// Get geocoding progress
postsRouter.get('/geocode/status', async (_req: Request, res: Response) => {
  res.json(geocodingProgress);
});

// Geocode all posts that have location but no coordinates
postsRouter.post('/geocode', async (_req: Request, res: Response) => {
  try {
    // Check if already running
    if (geocodingProgress.status === 'running') {
      return res.json({
        ...geocodingProgress,
        message: `Already geocoding: ${geocodingProgress.processed}/${geocodingProgress.total}`,
      });
    }

    const postsToGeocode = await neo4jService.getPostsNeedingGeocoding();

    if (postsToGeocode.length === 0) {
      return res.json({
        status: 'done',
        geocoded: 0,
        total: 0,
        message: 'No posts need geocoding'
      });
    }

    // Initialize progress
    geocodingProgress = {
      status: 'running',
      processed: 0,
      total: postsToGeocode.length,
      geocoded: 0,
      failed: 0,
      localHits: 0,
      apiHits: 0,
    };

    console.log(`[InstaMap] Starting geocoding of ${postsToGeocode.length} posts...`);

    // Return immediately, process in background
    res.json({
      status: 'started',
      total: postsToGeocode.length,
      message: `Started geocoding ${postsToGeocode.length} posts. Poll /api/posts/geocode/status for progress.`,
    });

    // Process in background
    (async () => {
      for (const post of postsToGeocode) {
        geocodingProgress.currentLocation = post.location;

        try {
          const result = await geocodingService.geocode(post.location);

          if (result) {
            await neo4jService.updatePostCoordinates(post.id, result.latitude, result.longitude);
            geocodingProgress.geocoded++;
            if (result.source === 'local') {
              geocodingProgress.localHits++;
            } else {
              geocodingProgress.apiHits++;
            }
          } else {
            geocodingProgress.failed++;
          }
        } catch (error) {
          geocodingProgress.failed++;
          console.error(`[InstaMap] Geocoding error for ${post.location}:`, error);
        }

        geocodingProgress.processed++;

        // Log progress every 50 posts
        if (geocodingProgress.processed % 50 === 0) {
          console.log(`[InstaMap] Geocoding progress: ${geocodingProgress.processed}/${geocodingProgress.total} (${geocodingProgress.localHits} local, ${geocodingProgress.apiHits} API)`);
        }
      }

      geocodingProgress.status = 'done';
      geocodingProgress.currentLocation = undefined;
      console.log(`[InstaMap] Geocoding complete: ${geocodingProgress.geocoded} geocoded, ${geocodingProgress.failed} failed`);
    })();

  } catch (error) {
    console.error('Geocoding failed:', error);
    geocodingProgress.status = 'idle';
    res.status(500).json({ error: 'Failed to start geocoding' });
  }
});

// Geocode a single location (for testing)
postsRouter.post('/geocode-single', async (req: Request, res: Response) => {
  try {
    const { location } = req.body;

    if (!location) {
      return res.status(400).json({ error: 'Location is required' });
    }

    const result = await geocodingService.geocode(location);

    if (result) {
      res.json(result);
    } else {
      res.status(404).json({ error: 'Location not found' });
    }
  } catch (error) {
    console.error('Geocoding failed:', error);
    res.status(500).json({ error: 'Failed to geocode location' });
  }
});

// ============ EMBEDDING REGENERATION ENDPOINTS ============

// Embedding regeneration progress tracking
let embeddingProgress: {
  status: 'idle' | 'running' | 'done';
  processed: number;
  total: number;
  updated: number;
  skipped: number;
} = { status: 'idle', processed: 0, total: 0, updated: 0, skipped: 0 };

// Get embedding regeneration status
postsRouter.get('/embeddings/status', async (_req: Request, res: Response) => {
  res.json(embeddingProgress);
});

// Get count of posts needing enriched embeddings
postsRouter.get('/embeddings/needs-refresh', async (_req: Request, res: Response) => {
  try {
    const posts = await neo4jService.getPostsNeedingEnrichedEmbeddings();
    res.json({
      count: posts.length,
      posts: posts.slice(0, 10), // Return first 10 as preview
    });
  } catch (error) {
    console.error('Failed to get posts needing embeddings:', error);
    res.status(500).json({ error: 'Failed to get posts needing embeddings' });
  }
});

// Manually trigger embedding regeneration for categorized posts
postsRouter.post('/embeddings/regenerate', async (_req: Request, res: Response) => {
  try {
    // Check if already running
    if (embeddingProgress.status === 'running') {
      return res.json({
        ...embeddingProgress,
        message: 'Embedding regeneration already in progress',
      });
    }

    // Get posts that need enriched embeddings
    const postsNeedingRefresh = await neo4jService.getPostsNeedingEnrichedEmbeddings();

    if (postsNeedingRefresh.length === 0) {
      return res.json({
        status: 'done',
        message: 'All categorized posts already have enriched embeddings',
        updated: 0,
        total: 0,
      });
    }

    // Reset progress
    embeddingProgress = {
      status: 'running',
      processed: 0,
      total: postsNeedingRefresh.length,
      updated: 0,
      skipped: 0,
    };

    res.json({
      status: 'started',
      message: `Starting embedding regeneration for ${postsNeedingRefresh.length} posts`,
      total: postsNeedingRefresh.length,
    });

    // Process in background with progress updates
    (async () => {
      const postIds = postsNeedingRefresh.map(p => p.id);
      const result = await regenerateEnrichedEmbeddings(postIds, false, (processed, updated, skipped) => {
        // Update progress in real-time
        embeddingProgress.processed = processed;
        embeddingProgress.updated = updated;
        embeddingProgress.skipped = skipped;
      });

      embeddingProgress.status = 'done';
      embeddingProgress.updated = result.updated;
      embeddingProgress.skipped = result.skipped;
      embeddingProgress.processed = postIds.length;
    })();

  } catch (error) {
    console.error('Embedding regeneration failed:', error);
    embeddingProgress.status = 'idle';
    res.status(500).json({ error: 'Failed to start embedding regeneration' });
  }
});

// Update post metadata (for manual editing)
postsRouter.patch('/:id/metadata', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { location, venue, eventDate, hashtags } = req.body;

    // Pass 'user' as source to track manual edits
    await neo4jService.updatePostMetadata(id, {
      location,
      venue,
      eventDate,
      hashtags,
    }, 'user');

    res.json({ success: true, message: 'Post metadata updated by user' });
  } catch (error) {
    console.error('Failed to update post metadata:', error);
    res.status(500).json({ error: 'Failed to update post metadata' });
  }
});

// Get single post
postsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const post = await neo4jService.getPostById(req.params.id);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json(post);
  } catch (error) {
    console.error('Failed to get post:', error);
    res.status(500).json({ error: 'Failed to get post' });
  }
});

// Get similar posts
postsRouter.get('/:id/similar', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 5;
    const post = await neo4jService.getPostById(req.params.id);

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (!post.embedding || post.embedding.length === 0) {
      // Generate embedding if missing
      try {
        const embedding = await embeddingsService.generatePostEmbedding(post);
        await neo4jService.updatePostEmbedding(post.id, embedding);
        post.embedding = embedding;
      } catch (e) {
        return res.json([]); // Return empty if can't generate embedding
      }
    }

    const similarPosts = await neo4jService.findSimilarPosts(post.embedding, limit + 1);
    // Filter out the original post
    const filtered = similarPosts.filter(p => p.id !== post.id).slice(0, limit);

    res.json(filtered);
  } catch (error) {
    console.error('Failed to find similar posts:', error);
    res.status(500).json({ error: 'Failed to find similar posts' });
  }
});

// Auto-categorize posts (Option A: real-time batched processing)
postsRouter.post('/auto-categorize', async (req: Request<{}, {}, AutoCategorizeRequest & { mode?: 'realtime' | 'async' }>, res: Response) => {
  try {
    const { postIds, mode = 'realtime' } = req.body;

    if (!Array.isArray(postIds) || postIds.length === 0) {
      return res.status(400).json({ error: 'postIds must be a non-empty array' });
    }

    // Fetch all posts
    const posts: InstagramPost[] = [];
    for (const postId of postIds) {
      const post = await neo4jService.getPostById(postId);
      if (post) posts.push(post);
    }

    if (posts.length === 0) {
      return res.status(404).json({ error: 'No valid posts found' });
    }

    const existingCategories = await neo4jService.getCategories();
    const parents = await neo4jService.getParentCategories();
    const parentNames = parents.map(p => p.name);

    // Option B: Async batch API (50% cheaper)
    if (mode === 'async') {
      const { batchId, requestCount } = await claudeService.submitBatchExtraction(posts, parentNames);
      return res.json({
        mode: 'async',
        batchId,
        requestCount,
        message: `Submitted ${requestCount} posts for async processing. Poll /posts/batch/${batchId} for results.`,
      });
    }

    // Option A: Real-time batched processing
    console.log(`[InstaMap] Processing ${posts.length} posts in real-time batches...`);

    const extractions = await claudeService.extractPostsBatch(posts, parentNames, (completed, total) => {
      console.log(`[InstaMap] Progress: ${completed}/${total}`);
    });

    let categorized = 0;
    const categorizedPostIds: string[] = [];

    for (const [postId, extraction] of extractions) {
      try {
        console.log(`[InstaMap] Extracted from post ${postId}:`, {
          hashtags: extraction.hashtags.length,
          location: extraction.location,
          venue: extraction.venue,
          categories: extraction.categories.length,
          eventDate: extraction.eventDate,
        });

        // Save all extracted metadata AND reasons to Neo4j
        await neo4jService.updatePostMetadata(postId, {
          location: extraction.location || undefined,
          venue: extraction.venue || undefined,
          eventDate: extraction.eventDate || undefined,
          hashtags: extraction.hashtags,
          mentions: extraction.mentions,
          // Save the AI reasoning
          locationReason: extraction.locationReason,
          venueReason: extraction.venueReason,
          eventDateReason: extraction.eventDateReason,
          hashtagsReason: extraction.hashtagsReason,
          categoriesReason: extraction.categoriesReason,
          mentionsReason: extraction.mentionsReason,
        });

        // Handle categories (including hierarchy support)
        for (const fullName of extraction.categories) {
          const parts = fullName.split('/');
          const parentName = parts.length > 1 ? parts[0].trim() : null;
          const categoryName = parts.length > 1 ? parts[1].trim() : parts[0].trim();

          // Find or create child category
          let category = existingCategories.find(c =>
            c.name.toLowerCase() === categoryName.toLowerCase()
          );

          if (!category) {
            category = await neo4jService.createCategory(categoryName);
            existingCategories.push(category);
          }

          // Handle parent if specified
          if (parentName) {
            let parent = existingCategories.find(c => c.name.toLowerCase() === parentName.toLowerCase());
            if (!parent) {
              parent = await neo4jService.createCategory(parentName);
              existingCategories.push(parent);
              // Set isParent flag
              const session = (neo4jService as any).getSession();
              try {
                await session.run('MATCH (c:Category {id: $id}) SET c.isParent = true', { id: parent.id });
              } finally {
                await session.close();
              }
            }
            await neo4jService.setCategoryParent(category.id, parent.id);
          }

          await neo4jService.assignPostToCategory(postId, category.id);
        }

        categorized++;
        categorizedPostIds.push(postId);
      } catch (e) {
        console.error(`Failed to process extraction for post ${postId}:`, e);
      }
    }

    // Regenerate embeddings with enriched metadata (in background)
    if (categorizedPostIds.length > 0) {
      regenerateEnrichedEmbeddings(categorizedPostIds).catch(err =>
        console.error('Failed to regenerate embeddings:', err)
      );

      // Trigger auto-cleanup of categories (optional, but good for keeping it tidy)
      // We use a threshold of 3 for auto-cleanup to be less aggressive than manual
      categoryCleanupService.analyzeCategories(3).then((analysis: { toDelete: any[] }) => {
        if (analysis.toDelete.length > 50) { // Only auto-cleanup if there's a lot of noise
          categoryCleanupService.executeCleanup({
            minPostThreshold: 3,
            reassignOrphans: true,
            dryRun: false
          }).catch((err: Error) => console.error('Auto-cleanup failed:', err));
        }
      });
    }

    res.json({
      mode: 'realtime',
      categorized,
      total: postIds.length,
      message: `Categorized ${categorized} posts`,
    });
  } catch (error) {
    console.error('Auto-categorize failed:', error);
    res.status(500).json({ error: 'Failed to auto-categorize posts' });
  }
});

// Track batches being processed to avoid duplicate processing
const batchesBeingProcessed = new Set<string>();
const batchProcessingResults = new Map<string, { categorized: number; total: number; error?: string }>();

// Get async batch status and results (Option B)
postsRouter.get('/batch/:batchId', async (req: Request, res: Response) => {
  try {
    const { batchId } = req.params;

    // Check if we already processed this batch
    const cachedResult = batchProcessingResults.get(batchId);
    if (cachedResult) {
      if (cachedResult.error) {
        return res.json({
          status: 'ended',
          categorized: cachedResult.categorized,
          total: cachedResult.total,
          message: `Batch complete with errors: ${cachedResult.error}`,
        });
      }
      return res.json({
        status: 'ended',
        categorized: cachedResult.categorized,
        total: cachedResult.total,
        message: `Batch complete. Categorized ${cachedResult.categorized} posts.`,
      });
    }

    // Check if batch is currently being processed
    if (batchesBeingProcessed.has(batchId)) {
      return res.json({
        status: 'processing_results',
        message: 'Batch complete, processing results... This may take a few minutes for large batches.',
      });
    }

    // Get batch status from Anthropic
    const result = await claudeService.getBatchStatus(batchId);

    if (result.status !== 'ended') {
      return res.json({
        status: result.status,
        progress: result.progress,
        message: 'Batch still processing',
      });
    }

    // Batch is complete - start background processing
    batchesBeingProcessed.add(batchId);

    // Respond immediately
    res.json({
      status: 'processing_results',
      message: 'Batch complete! Processing results in background... Check again in a minute.',
    });

    // Process in background
    processBatchResults(batchId).catch(err => {
      console.error(`Failed to process batch ${batchId}:`, err);
      batchProcessingResults.set(batchId, { categorized: 0, total: 0, error: err.message });
    }).finally(() => {
      batchesBeingProcessed.delete(batchId);
    });

  } catch (error) {
    console.error('Failed to get batch results:', error);
    res.status(500).json({ error: 'Failed to get batch results' });
  }
});

// Background batch processing function
async function processBatchResults(batchId: string) {
  console.log(`[InstaMap] Starting to process batch ${batchId}...`);

  const fullResult = await claudeService.getBatchResults(batchId);

  if (!fullResult.results || fullResult.results.size === 0) {
    batchProcessingResults.set(batchId, { categorized: 0, total: 0 });
    return;
  }

  const existingCategories = await neo4jService.getCategories();
  let categorized = 0;
  let processed = 0;
  const total = fullResult.results.size;
  const categorizedPostIds: string[] = [];

  for (const [postId, extraction] of fullResult.results) {
    try {
      // Save all extracted metadata AND reasons
      await neo4jService.updatePostMetadata(postId, {
        location: extraction.location || undefined,
        venue: extraction.venue || undefined,
        eventDate: extraction.eventDate || undefined,
        hashtags: extraction.hashtags,
        mentions: extraction.mentions,
        // Save the AI reasoning
        locationReason: extraction.locationReason,
        venueReason: extraction.venueReason,
        eventDateReason: extraction.eventDateReason,
        hashtagsReason: extraction.hashtagsReason,
        categoriesReason: extraction.categoriesReason,
        mentionsReason: extraction.mentionsReason,
      });

      // Process categories (including hierarchy support)
      for (const fullName of extraction.categories) {
        const parts = fullName.split('/');
        const parentName = parts.length > 1 ? parts[0].trim() : null;
        const categoryName = parts.length > 1 ? parts[1].trim() : parts[0].trim();

        // Find or create child category
        let category = existingCategories.find(c =>
          c.name.toLowerCase() === categoryName.toLowerCase()
        );

        if (!category) {
          category = await neo4jService.createCategory(categoryName);
          existingCategories.push(category);
        }

        // Handle parent if specified
        if (parentName) {
          let parent = existingCategories.find(c => c.name.toLowerCase() === parentName.toLowerCase());
          if (!parent) {
            parent = await neo4jService.createCategory(parentName);
            existingCategories.push(parent);
            // Set isParent flag
            const session = (neo4jService as any).getSession();
            try {
              await session.run('MATCH (c:Category {id: $id}) SET c.isParent = true', { id: parent.id });
            } finally {
              await session.close();
            }
          }
          await neo4jService.setCategoryParent(category.id, parent.id);
        }

        await neo4jService.assignPostToCategory(postId, category.id);
      }
      categorized++;
      categorizedPostIds.push(postId);
    } catch (e) {
      console.error(`Failed to process batch result for post ${postId}:`, e);
    }

    processed++;
    if (processed % 100 === 0) {
      console.log(`[InstaMap] Processed ${processed}/${total} posts...`);
    }
  }

  // Regenerate embeddings with enriched metadata (in background)
  if (categorizedPostIds.length > 0) {
    regenerateEnrichedEmbeddings(categorizedPostIds).catch(err =>
      console.error('Failed to regenerate embeddings:', err)
    );

    // Trigger auto-cleanup of categories
    categoryCleanupService.analyzeCategories(3).then((analysis: { toDelete: any[] }) => {
      if (analysis.toDelete.length > 50) {
        categoryCleanupService.executeCleanup({
          minPostThreshold: 3,
          reassignOrphans: true,
          dryRun: false
        }).catch((err: Error) => console.error('Auto-cleanup failed:', err));
      }
    });
  }

  console.log(`[InstaMap] Batch ${batchId} complete! Categorized ${categorized}/${total} posts.`);
  batchProcessingResults.set(batchId, { categorized, total });
}

// Cancel async batch
postsRouter.delete('/batch/:batchId', async (req: Request, res: Response) => {
  try {
    const { batchId } = req.params;
    await claudeService.cancelBatch(batchId);
    res.json({ success: true, message: 'Batch cancelled' });
  } catch (error) {
    console.error('Failed to cancel batch:', error);
    res.status(500).json({ error: 'Failed to cancel batch' });
  }
});

// Assign post to category
postsRouter.put('/:postId/categories/:categoryId', async (req: Request, res: Response) => {
  try {
    const { postId, categoryId } = req.params;
    await neo4jService.assignPostToCategory(postId, categoryId);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to assign category:', error);
    res.status(500).json({ error: 'Failed to assign category' });
  }
});

// Get post categories
postsRouter.get('/:postId/categories', async (req: Request, res: Response) => {
  try {
    const categories = await neo4jService.getPostCategories(req.params.postId);
    res.json(categories);
  } catch (error) {
    console.error('Failed to get post categories:', error);
    res.status(500).json({ error: 'Failed to get post categories' });
  }
});

// Background job to generate embeddings (for newly synced posts)
async function generateEmbeddingsInBackground(posts: InstagramPost[]) {
  const postsWithCaptions = posts.filter(p => p.caption && p.caption.trim().length > 0);

  for (const post of postsWithCaptions) {
    try {
      // At sync time, we only have caption and basic metadata (no categories yet)
      const embedding = await embeddingsService.generatePostEmbedding({
        caption: post.caption,
        ownerUsername: post.ownerUsername,
        // Categories, location, venue, etc. are added during categorization
        // Embeddings will be regenerated with enriched data after categorization
      });
      await neo4jService.updatePostEmbedding(post.id, embedding);
      // Mark as basic embedding (version 1) since it's at sync time before categorization
      await neo4jService.updateEmbeddingVersion(post.id, 1);
      console.log(`Generated embedding for post ${post.id}`);
    } catch (error) {
      console.error(`Failed to generate embedding for post ${post.id}:`, error);
    }
  }
}

// Background job to check images for expiry (user-triggered batch)
// Uses HEAD requests (fast, no body transfer)
async function checkImagesForExpiry(posts: InstagramPost[]) {
  console.log(`[ImageExpiry] Starting expiry check for ${posts.length} posts...`);

  const DELAY_BETWEEN_CHECKS = 200; // 200ms between requests (5/sec - fast but not abusive)

  for (const post of posts) {
    // Check if stopped
    if (expiryCheckProgress.status !== 'running') {
      console.log(`[ImageExpiry] Check stopped at ${expiryCheckProgress.processed}/${posts.length}`);
      break;
    }

    try {
      // Skip if no image URL
      if (!post.imageUrl) {
        expiryCheckProgress.processed++;
        continue;
      }

      // Use HEAD request first (cheaper, no body transfer)
      const response = await fetch(post.imageUrl, {
        method: 'HEAD',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
          'Referer': 'https://www.instagram.com/',
        },
      });

      if (response.status === 403) {
        // Image is expired
        await neo4jService.markPostImageExpired(post.id);
        expiryCheckProgress.expired++;
        console.log(`[ImageExpiry] Expired: ${post.instagramId}`);
      } else if (response.ok) {
        // Image is still valid
        expiryCheckProgress.valid++;
      } else {
        // Other error, treat as expired to be safe
        await neo4jService.markPostImageExpired(post.id);
        expiryCheckProgress.expired++;
        console.log(`[ImageExpiry] Error ${response.status} for ${post.instagramId}, marked expired`);
      }

    } catch (error) {
      // Network error - could be rate limited, mark as expired to be safe
      console.error(`[ImageExpiry] Network error for ${post.instagramId}:`, error);
      await neo4jService.markPostImageExpired(post.id);
      expiryCheckProgress.expired++;

      // If we get an error, wait longer before next request
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    expiryCheckProgress.processed++;

    // Log progress every 50 posts
    if (expiryCheckProgress.processed % 50 === 0) {
      console.log(`[ImageExpiry] Progress: ${expiryCheckProgress.processed}/${posts.length} (${expiryCheckProgress.expired} expired, ${expiryCheckProgress.valid} valid)`);
    }

    // Rate limit: wait between requests
    if (expiryCheckProgress.status === 'running') {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_CHECKS));
    }
  }

  expiryCheckProgress.status = 'done';
  console.log(`[ImageExpiry] Complete! Checked ${expiryCheckProgress.processed}/${posts.length} (${expiryCheckProgress.expired} expired, ${expiryCheckProgress.valid} valid)`);
}

// Background job to download and store images locally
async function downloadImagesInBackground(posts: InstagramPost[]) {
  console.log(`[ImageStorage] Starting background download for ${posts.length} posts...`);

  // Reference the progress tracker (declared at module level)
  const progress = imageDownloadProgress;

  // Only update if not already running with different total
  if (progress.status !== 'running' || progress.total === 0) {
    progress.status = 'running';
    progress.processed = 0;
    progress.total = posts.length;
    progress.downloaded = 0;
    progress.failed = 0;
    progress.alreadyStored = 0;
  }

  const BATCH_SIZE = 5; // Download 5 at a time to avoid rate limiting
  const DELAY_BETWEEN_BATCHES = 1000; // 1 second between batches

  for (let i = 0; i < posts.length; i += BATCH_SIZE) {
    const batch = posts.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (post) => {
        try {
          // Skip if already has local image
          if (post.localImagePath && imageStorageService.exists(post.localImagePath)) {
            progress.alreadyStored++;
            progress.processed++;
            return;
          }

          // Skip if no image URL
          if (!post.imageUrl) {
            progress.processed++;
            return;
          }

          const result = await imageStorageService.downloadAndStore(
            post.id,
            post.instagramId,
            post.imageUrl
          );

          if (result.success && result.localPath) {
            await neo4jService.updatePostLocalImage(post.id, result.localPath);
            progress.downloaded++;
          } else {
            // If failed due to 403, mark as expired
            if (result.error?.includes('403') || result.error?.includes('expired')) {
              await neo4jService.markPostImageExpired(post.id);
            }
            progress.failed++;
          }
          progress.processed++;

        } catch (error) {
          console.error(`[ImageStorage] Failed to download image for ${post.instagramId}:`, error);
          progress.failed++;
          progress.processed++;
        }
      })
    );

    // Log progress every batch
    console.log(`[ImageStorage] Progress: ${progress.processed}/${progress.total} (${progress.downloaded} downloaded, ${progress.failed} failed)`);

    // Delay between batches to avoid rate limiting
    if (i + BATCH_SIZE < posts.length) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
    }
  }

  progress.status = 'done';
  console.log(`[ImageStorage] Complete! Downloaded ${progress.downloaded}/${posts.length} images (${progress.failed} failed, ${progress.alreadyStored} already stored)`);
}

// Regenerate embeddings with enriched metadata (after categorization)
// Uses batch processing for much faster execution
async function regenerateEnrichedEmbeddings(
  postIds: string[],
  skipAlreadyEnriched = false,
  onProgress?: (processed: number, updated: number, skipped: number) => void
) {
  console.log(`[InstaMap] Regenerating embeddings for ${postIds.length} posts with enriched metadata (BATCH MODE)...`);
  let updated = 0;
  let skipped = 0;
  let processed = 0;

  const BATCH_SIZE = 100; // Process 100 posts at a time

  for (let i = 0; i < postIds.length; i += BATCH_SIZE) {
    const batchIds = postIds.slice(i, i + BATCH_SIZE);

    try {
      // Step 1: Fetch all posts in parallel
      const posts = await Promise.all(
        batchIds.map(id => neo4jService.getPostById(id))
      );

      // Step 2: Fetch categories for all posts in parallel
      const categoriesPerPost = await Promise.all(
        batchIds.map(id => neo4jService.getPostCategories(id))
      );

      // Step 3: Build texts for embedding and track which posts to process
      const textsToEmbed: string[] = [];
      const postsToUpdate: { postId: string; textIndex: number }[] = [];
      const skippedInBatch: string[] = [];

      for (let j = 0; j < batchIds.length; j++) {
        const post = posts[j];
        const postId = batchIds[j];

        if (!post || !post.caption) {
          processed++;
          continue;
        }

        if (skipAlreadyEnriched && post.embeddingVersion === 2) {
          skipped++;
          processed++;
          skippedInBatch.push(postId);
          continue;
        }

        const categoryNames = categoriesPerPost[j].map(c => c.name);
        const text = embeddingsService.buildPostEmbeddingText({
          caption: post.caption,
          ownerUsername: post.ownerUsername,
          categories: categoryNames,
          location: post.location,
          venue: post.venue,
          hashtags: post.hashtags,
          mentions: post.mentions,
        });

        if (text) {
          textsToEmbed.push(text);
          postsToUpdate.push({ postId, textIndex: textsToEmbed.length - 1 });
        } else {
          processed++;
        }
      }

      // Step 4: Generate all embeddings in one batch API call
      let embeddings: number[][] = [];
      if (textsToEmbed.length > 0) {
        embeddings = await embeddingsService.generateEmbeddings(textsToEmbed);
      }

      // Step 5: Save all embeddings in parallel
      await Promise.all(
        postsToUpdate.map(async ({ postId, textIndex }) => {
          const embedding = embeddings[textIndex];
          if (embedding && embedding.length > 0) {
            await neo4jService.updatePostEmbedding(postId, embedding);
            await neo4jService.updateEmbeddingVersion(postId, 2);
            updated++;
          }
          processed++;
        })
      );

      // Report progress after each batch
      onProgress?.(processed, updated, skipped);

      console.log(`[InstaMap] Batch ${Math.floor(i / BATCH_SIZE) + 1}: processed ${processed}/${postIds.length}`);

    } catch (error) {
      console.error(`Failed to process batch starting at ${i}:`, error);
      // Mark batch as processed even on error
      processed += batchIds.length;
      onProgress?.(processed, updated, skipped);
    }
  }

  console.log(`[InstaMap] Regenerated ${updated}/${postIds.length} embeddings with enriched metadata (skipped ${skipped} already enriched)`);
  return { updated, skipped };
}

