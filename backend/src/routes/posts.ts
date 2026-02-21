import { Router, Request, Response } from 'express';
import { neo4jService } from '../services/neo4j.js';
import { embeddingsService } from '../services/embeddings.js';
import { claudeService } from '../services/claude.js';
import { geocodingService, GeocodingProvider } from '../services/geocoding.js';
import { categoryCleanupService } from '../services/categoryCleanup.js';
import { imageStorageService } from '../services/imageStorage.js';
import { InstagramPost, SyncPostsRequest, AutoCategorizeRequest } from '../types/index.js';

// ============ SEARCH CONFIGURATION ============
// These constants control semantic search behavior - adjust as needed
const SEARCH_TOP_K = 200;              // Max results from vector search
const SEARCH_MIN_SIMILARITY = 0.3;     // Minimum cosine similarity (0-1)
const SEARCH_CATEGORY_BOOST = 0.2;     // Boost for category name matches
const SEARCH_EXACT_PHRASE_BOOST = 0.1; // Boost for exact phrase in caption

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
    const { posts, storeImages = true, localPostCount, checkpoint } = req.body;

    if (!Array.isArray(posts)) {
      return res.status(400).json({ error: 'Posts must be an array' });
    }

    console.log(`Syncing ${posts.length} posts... (storeImages: ${storeImages})`);

    const synced = await neo4jService.upsertPosts(posts);

    // Update sync metadata with local post count at sync time
    // Use provided count or default to synced posts count
    const countToStore = localPostCount ?? posts.length;
    await neo4jService.updateSyncMetadata(countToStore, checkpoint === undefined ? undefined : (checkpoint === null ? null : JSON.stringify(checkpoint)));

    // Generate embeddings for posts with captions (in background)
    generateEmbeddingsInBackground(posts);

    // Note: Image download is now done client-side via /images/upload endpoint
    // Server-side download fails due to Instagram auth requirements

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

// Get posts with expired images (paginated, returns only instagramIds)
postsRouter.get('/images/expired', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 0;
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 1000, 1000);

    const posts = await neo4jService.getPostsWithExpiredImages();
    const totalCount = posts.length;

    // Paginate
    const start = page * pageSize;
    const end = start + pageSize;
    const pagePosts = posts.slice(start, end);

    // Only return instagramId to keep payload small
    const ids = pagePosts.map(p => ({ instagramId: p.instagramId }));
    res.json({ posts: ids, count: totalCount, page, pageSize });
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

// Record refresh failures for posts (increments counter, auto-deletes at threshold)
postsRouter.post('/record-refresh-failures', async (req: Request, res: Response) => {
  try {
    const { instagramIds } = req.body;

    if (!instagramIds || !Array.isArray(instagramIds) || instagramIds.length === 0) {
      return res.status(400).json({ error: 'instagramIds array is required' });
    }

    const result = await neo4jService.recordRefreshFailures(instagramIds);
    console.log(`Recorded refresh failures for ${result.processed} posts (${result.autoDeleted} auto-deleted)`);
    res.json(result);
  } catch (error) {
    console.error('Failed to record refresh failures:', error);
    res.status(500).json({ error: 'Failed to record refresh failures' });
  }
});

// Mark posts as deleted/unsaved (404 from Instagram - post no longer exists)
postsRouter.post('/mark-deleted', async (req: Request, res: Response) => {
  try {
    const { instagramIds } = req.body;

    if (!instagramIds || !Array.isArray(instagramIds) || instagramIds.length === 0) {
      return res.status(400).json({ error: 'instagramIds array is required' });
    }

    let marked = 0;
    for (const instagramId of instagramIds) {
      await neo4jService.markPostDeleted(instagramId);
      marked++;
    }

    console.log(`Marked ${marked} posts as deleted`);
    res.json({ marked });
  } catch (error) {
    console.error('Failed to mark posts as deleted:', error);
    res.status(500).json({ error: 'Failed to mark posts as deleted' });
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
// Accepts either postId (internal) or instagramId
postsRouter.post('/images/refresh-urls', async (req: Request, res: Response) => {
  try {
    const { updates } = req.body as { updates: Array<{ postId?: string; instagramId?: string; imageUrl: string }> };

    if (!Array.isArray(updates)) {
      return res.status(400).json({ error: 'updates must be an array' });
    }

    let updated = 0;
    for (const update of updates) {
      try {
        if (update.instagramId) {
          // Update by Instagram ID (from collection refresh)
          const success = await neo4jService.updatePostImageUrlByInstagramId(update.instagramId, update.imageUrl);
          if (success) updated++;
        } else if (update.postId) {
          // Update by internal ID
          await neo4jService.updatePostImageUrl(update.postId, update.imageUrl);
          updated++;
        }
      } catch (e) {
        console.error(`Failed to update image URL:`, e);
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

// Get Instagram IDs that need image upload (for extension to filter)
postsRouter.get('/images/needs-upload', async (_req: Request, res: Response) => {
  try {
    const instagramIds = await neo4jService.getInstagramIdsNeedingImages();
    res.json({ instagramIds });
  } catch (error) {
    console.error('Failed to get posts needing images:', error);
    res.status(500).json({ error: 'Failed to get posts needing images' });
  }
});

// Upload image from extension (client-side fetch, bypasses Instagram auth)
postsRouter.post('/images/upload', async (req: Request, res: Response) => {
  try {
    const { postId, instagramId, imageData } = req.body;

    if (!instagramId || !imageData) {
      return res.status(400).json({ error: 'instagramId and imageData are required' });
    }

    const result = imageStorageService.storeFromBase64(postId || instagramId, instagramId, imageData);

    if (result.success && result.localPath) {
      // Use instagramId for matching (more reliable than local postId)
      await neo4jService.updatePostLocalImageByInstagramId(instagramId, result.localPath);
      res.json({ success: true, localPath: result.localPath });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('Failed to upload image:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// Reconcile orphaned images (images on disk but not recorded in Neo4j)
postsRouter.post('/images/reconcile', async (_req: Request, res: Response) => {
  try {
    // Get all image files from disk
    const diskImages = imageStorageService.getAllImageFiles();
    console.log(`[Reconcile] Found ${diskImages.length} images on disk`);

    // Extract instagramId from filename (format: {instagramId}_{hash}.jpg)
    const diskInstagramIds = new Map<string, string>();
    for (const filename of diskImages) {
      const match = filename.match(/^([^_]+)_[^.]+\.jpg$/);
      if (match) {
        diskInstagramIds.set(match[1], filename);
      }
    }

    // Get posts missing localImagePath but have images on disk
    const postsNeedingUpdate = await neo4jService.getInstagramIdsNeedingImages();

    let reconciled = 0;
    for (const instagramId of postsNeedingUpdate) {
      const filename = diskInstagramIds.get(instagramId);
      if (filename) {
        await neo4jService.updatePostLocalImageByInstagramId(instagramId, filename);
        reconciled++;
        console.log(`[Reconcile] Updated ${instagramId} with ${filename}`);
      }
    }

    res.json({
      success: true,
      diskImages: diskImages.length,
      postsNeedingImages: postsNeedingUpdate.length,
      reconciled,
      message: `Reconciled ${reconciled} orphaned images`,
    });
  } catch (error) {
    console.error('Failed to reconcile images:', error);
    res.status(500).json({ error: 'Failed to reconcile images' });
  }
});

// Get search result count (for pagination)
postsRouter.get('/search-count', async (req: Request, res: Response) => {
  try {
    const searchQuery = req.query.search as string;

    if (!searchQuery || !searchQuery.trim()) {
      return res.json({ count: 0 });
    }

    // Generate embedding for search query
    const queryEmbedding = await embeddingsService.generateEmbedding(searchQuery.trim());

    // Get count
    const count = await neo4jService.getSearchCount(
      queryEmbedding,
      SEARCH_TOP_K,
      SEARCH_MIN_SIMILARITY
    );

    res.json({ count });
  } catch (error) {
    console.error('Failed to get search count:', error);
    res.status(500).json({ error: 'Failed to get search count' });
  }
});

// Get all posts (with optional semantic search)
postsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const categoryId = req.query.category as string;
    const recursive = req.query.recursive === 'true';
    const searchQuery = req.query.search as string;

    // If search query provided, do semantic search
    if (searchQuery && searchQuery.trim()) {
      try {
        // Generate embedding for search query
        const queryEmbedding = await embeddingsService.generateEmbedding(searchQuery.trim());

        // Perform semantic search with boosting
        const { posts, total } = await neo4jService.searchPosts(
          queryEmbedding,
          searchQuery.trim(),
          {
            topK: SEARCH_TOP_K,
            minSimilarity: SEARCH_MIN_SIMILARITY,
            categoryBoost: SEARCH_CATEGORY_BOOST,
            exactPhraseBoost: SEARCH_EXACT_PHRASE_BOOST,
            limit,
            offset,
          }
        );

        // Return with total for pagination
        return res.json({ posts, total, isSearch: true });
      } catch (searchError) {
        console.error('Semantic search failed:', searchError);
        // Fall back to returning empty results rather than crashing
        return res.json({ posts: [], total: 0, isSearch: true, error: 'Search failed' });
      }
    }

    // Normal listing (no search)
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

// Get categorized post Instagram IDs (returns instagramId, not internal id)
// TODO: we shoud paginate this
postsRouter.get('/categorized-ids', async (_req: Request, res: Response) => {
  try {
    const instagramIds = await neo4jService.getCategorizedPostIds();
    res.json({ instagramIds });
  } catch (error) {
    console.error('Failed to get categorized post IDs:', error);
    res.status(500).json({ error: 'Failed to get categorized post IDs' });
  }
});

// Get uncategorized post count
postsRouter.get('/uncategorized-count', async (_req: Request, res: Response) => {
  try {
    const count = await neo4jService.getUncategorizedCount();
    res.json({ count });
  } catch (error) {
    console.error('Failed to get uncategorized count:', error);
    res.status(500).json({ error: 'Failed to get uncategorized count' });
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

// Get total post count
postsRouter.get('/count', async (_req: Request, res: Response) => {
  try {
    const total = await neo4jService.getPostCount();
    res.json({ total });
  } catch (error) {
    console.error('Failed to get post count:', error);
    res.status(500).json({ error: 'Failed to get post count' });
  }
});

// Get all synced Instagram IDs (for smart collection - avoid re-scraping synced posts)
postsRouter.get('/synced-instagram-ids', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20000;
    const offset = parseInt(req.query.offset as string) || 0;
    const instagramIds = await neo4jService.getSyncedInstagramIds(limit, offset);
    const metadata = await neo4jService.getSyncMetadata();
    res.json({ 
      instagramIds, 
      checkpoint: metadata.syncCheckpoint ? JSON.parse(metadata.syncCheckpoint) : null 
    });
  } catch (error) {
    console.error('Failed to get synced Instagram IDs:', error);
    res.status(500).json({ error: 'Failed to get synced Instagram IDs' });
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
// ============ GEOCODING ============
// Geocode mentionedPlaces in posts
let mentionedPlacesGeocodingProgress: {
  status: 'idle' | 'running' | 'done';
  processed: number;
  total: number;
  geocoded: number;
  failed: number;
  postsProcessed: number;
  totalPosts: number;
  currentLocation?: string;
  provider?: GeocodingProvider;
} = { status: 'idle', processed: 0, total: 0, geocoded: 0, failed: 0, postsProcessed: 0, totalPosts: 0 };

// Get available geocoding providers
postsRouter.get('/geocode-providers', async (_req: Request, res: Response) => {
  const providers = geocodingService.getAvailableProviders();
  res.json(providers);
});

// Get mentionedPlaces geocoding status
postsRouter.get('/geocode-places/status', async (_req: Request, res: Response) => {
  res.json(mentionedPlacesGeocodingProgress);
});

// Start geocoding mentionedPlaces
postsRouter.post('/geocode-places', async (req: Request, res: Response) => {
  const provider: GeocodingProvider = req.body?.provider || 'mapbox';
  try {
    // Check if already running
    if (mentionedPlacesGeocodingProgress.status === 'running') {
      return res.json({
        ...mentionedPlacesGeocodingProgress,
        message: `Already geocoding places: ${mentionedPlacesGeocodingProgress.processed}/${mentionedPlacesGeocodingProgress.total}`,
      });
    }

    const postsWithPlaces = await neo4jService.getPostsWithMentionedPlacesNeedingGeocoding();

    if (postsWithPlaces.length === 0) {
      return res.json({
        status: 'done',
        geocoded: 0,
        total: 0,
        message: 'No mentioned places need geocoding'
      });
    }

    // Count total places needing geocoding
    let totalPlaces = 0;
    for (const post of postsWithPlaces) {
      if (post.mentionedPlaces) {
        totalPlaces += post.mentionedPlaces.filter(p =>
          p.latitude === undefined || p.longitude === undefined
        ).length;
      }
    }

    // Initialize progress
    mentionedPlacesGeocodingProgress = {
      status: 'running',
      processed: 0,
      total: totalPlaces,
      geocoded: 0,
      failed: 0,
      postsProcessed: 0,
      totalPosts: postsWithPlaces.length,
      provider,
    };

    console.log(`[InstaMap] Starting geocoding of ${totalPlaces} mentioned places across ${postsWithPlaces.length} posts using ${provider}...`);

    // Return immediately, process in background
    res.json({
      status: 'started',
      total: totalPlaces,
      totalPosts: postsWithPlaces.length,
      message: `Started geocoding ${totalPlaces} places in ${postsWithPlaces.length} posts. Poll /api/posts/geocode-places/status for progress.`,
    });

    // Process in background
    (async () => {
      for (const post of postsWithPlaces) {
        if (!post.mentionedPlaces) continue;

        let updated = false;
        const updatedPlaces = [...post.mentionedPlaces];

        for (let i = 0; i < updatedPlaces.length; i++) {
          const place = updatedPlaces[i];

          // Skip if already geocoded
          if (place.latitude !== undefined && place.longitude !== undefined) continue;

          // Try geocoding with venue + location, fall back to just location
          const searchQuery = `${place.venue}, ${place.location}`;
          mentionedPlacesGeocodingProgress.currentLocation = searchQuery;

          try {
            // Try geocoding just the location (better for normalization)
            let result = await geocodingService.geocode(place.location, provider);

            // If that fails, try venue + location
            if (!result) {
              result = await geocodingService.geocode(searchQuery, provider);
            }

            if (result) {
              updatedPlaces[i] = {
                ...place,
                latitude: result.latitude,
                longitude: result.longitude,
                normalizedLocation: result.normalizedLocation,
                normalizedCountry: result.normalizedCountry,
                normalizedCity: result.normalizedCity,
                normalizedNeighborhood: result.normalizedNeighborhood,
                geocodingProvider: result.provider,
              };
              updated = true;
              mentionedPlacesGeocodingProgress.geocoded++;
            } else {
              mentionedPlacesGeocodingProgress.failed++;
            }
          } catch (error) {
            mentionedPlacesGeocodingProgress.failed++;
            console.error(`[InstaMap] Geocoding error for "${searchQuery}":`, error);
          }

          mentionedPlacesGeocodingProgress.processed++;
        }

        // Save updated places if any were geocoded
        if (updated) {
          await neo4jService.updateMentionedPlaces(post.id, updatedPlaces);
        }

        mentionedPlacesGeocodingProgress.postsProcessed++;

        // Log progress every 10 posts
        if (mentionedPlacesGeocodingProgress.postsProcessed % 10 === 0) {
          console.log(`[InstaMap] MentionedPlaces geocoding: ${mentionedPlacesGeocodingProgress.postsProcessed}/${mentionedPlacesGeocodingProgress.totalPosts} posts, ${mentionedPlacesGeocodingProgress.geocoded} places geocoded`);
        }
      }

      mentionedPlacesGeocodingProgress.status = 'done';
      mentionedPlacesGeocodingProgress.currentLocation = undefined;
      console.log(`[InstaMap] MentionedPlaces geocoding complete: ${mentionedPlacesGeocodingProgress.geocoded} geocoded, ${mentionedPlacesGeocodingProgress.failed} failed`);
    })();

  } catch (error) {
    console.error('MentionedPlaces geocoding failed:', error);
    mentionedPlacesGeocodingProgress.status = 'idle';
    res.status(500).json({ error: 'Failed to start mentionedPlaces geocoding' });
  }
});

// Geocode a single location (for testing)
postsRouter.post('/geocode-single', async (req: Request, res: Response) => {
  try {
    const { location, provider = 'mapbox' } = req.body;

    if (!location) {
      return res.status(400).json({ error: 'Location is required' });
    }

    const result = await geocodingService.geocode(location, provider as GeocodingProvider);

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

// Re-geocode a single post's mentionedPlaces (force-bypasses cache)
postsRouter.post('/:id/re-geocode', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const provider: GeocodingProvider = req.body?.provider || 'google';

    const post = await neo4jService.getPostById(id);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (!post.mentionedPlaces || post.mentionedPlaces.length === 0) {
      return res.json({ success: true, geocoded: 0, message: 'No mentionedPlaces to geocode' });
    }

    const updatedPlaces = [...post.mentionedPlaces];
    let geocoded = 0;

    for (let i = 0; i < updatedPlaces.length; i++) {
      const place = updatedPlaces[i];

      try {
        // Force re-geocode (bypass cache)
        let result = await geocodingService.geocode(place.location, provider, true);
        if (!result) {
          result = await geocodingService.geocode(`${place.venue}, ${place.location}`, provider, true);
        }

        if (result) {
          updatedPlaces[i] = {
            ...place,
            latitude: result.latitude,
            longitude: result.longitude,
            normalizedLocation: result.normalizedLocation,
            normalizedCountry: result.normalizedCountry,
            normalizedCity: result.normalizedCity,
            normalizedNeighborhood: result.normalizedNeighborhood,
            geocodingProvider: result.provider,
          };
          geocoded++;
          console.log(`[Re-geocode] "${place.venue}" @ "${place.location}" → ${result.normalizedCity}, ${result.normalizedCountry} [${result.latitude}, ${result.longitude}]`);
        }
      } catch (error) {
        console.error(`[Re-geocode] Error for "${place.venue}":`, error);
      }
    }

    // Save updated places
    await neo4jService.updateMentionedPlaces(id, updatedPlaces);

    // Return the updated post
    const updatedPost = await neo4jService.getPostById(id);
    res.json({
      success: true,
      geocoded,
      total: updatedPlaces.length,
      post: updatedPost,
    });
  } catch (error) {
    console.error('Re-geocode post failed:', error);
    res.status(500).json({ error: 'Failed to re-geocode post' });
  }
});

// ============ GEOCODING MIGRATION ============
// Migration to add normalizedLocation to all existing places (re-geocodes everything)

let migrationProgress: {
  status: 'idle' | 'running' | 'done';
  processed: number;
  total: number;
  updated: number;
  skipped: number;
  cacheHits: number;
  apiHits: number;
  currentPost?: string;
  provider?: GeocodingProvider;
} = { status: 'idle', processed: 0, total: 0, updated: 0, skipped: 0, cacheHits: 0, apiHits: 0 };

// Get migration status
postsRouter.get('/geocode-migrate/status', async (_req: Request, res: Response) => {
  res.json(migrationProgress);
});

// Start migration - re-geocode all places to add normalizedLocation
postsRouter.post('/geocode-migrate', async (req: Request, res: Response) => {
  const provider: GeocodingProvider = req.body?.provider || 'mapbox';
  const forceAll: boolean = req.body?.forceAll || false; // Re-geocode even if already has data
  try {
    // Check if already running
    if (migrationProgress.status === 'running') {
      return res.json({
        ...migrationProgress,
        message: `Migration already running: ${migrationProgress.processed}/${migrationProgress.total}`,
      });
    }

    // Get all posts with mentionedPlaces
    const allPosts = await neo4jService.getPostsWithCoordinates();
    // Also get posts that have places but no coordinates yet
    const postsNeedingGeocode = await neo4jService.getPostsWithMentionedPlacesNeedingGeocoding();

    // Combine and dedupe
    const postMap = new Map<string, InstagramPost>();
    for (const post of [...allPosts, ...postsNeedingGeocode]) {
      if (post.mentionedPlaces && post.mentionedPlaces.length > 0) {
        postMap.set(post.id, post);
      }
    }
    const postsToMigrate = Array.from(postMap.values());

    if (postsToMigrate.length === 0) {
      return res.json({
        status: 'done',
        updated: 0,
        total: 0,
        message: 'No posts with places to migrate'
      });
    }

    // Count total places
    let totalPlaces = 0;
    for (const post of postsToMigrate) {
      totalPlaces += post.mentionedPlaces?.length || 0;
    }

    // Reset progress
    migrationProgress = {
      status: 'running',
      processed: 0,
      total: totalPlaces,
      updated: 0,
      skipped: 0,
      cacheHits: 0,
      apiHits: 0,
      provider,
    };

    console.log(`[InstaMap] Starting geocoding migration for ${totalPlaces} places in ${postsToMigrate.length} posts using ${provider} (forceAll=${forceAll})...`);

    // Return immediately, process in background
    res.json({
      status: 'started',
      total: totalPlaces,
      totalPosts: postsToMigrate.length,
      message: `Started migration for ${totalPlaces} places. Poll /api/posts/geocode-migrate/status for progress.`,
    });

    // Process in background
    (async () => {
      for (const post of postsToMigrate) {
        if (!post.mentionedPlaces) continue;
        migrationProgress.currentPost = post.id;

        let updated = false;
        const updatedPlaces = [...post.mentionedPlaces];

        for (let i = 0; i < updatedPlaces.length; i++) {
          const place = updatedPlaces[i];

          // Skip if already has normalizedCity (unless forceAll)
          if (!forceAll && place.normalizedCity) {
            migrationProgress.skipped++;
            migrationProgress.processed++;
            continue;
          }

          // Try geocoding with just the location (for consistent normalization)
          try {
            const result = await geocodingService.geocode(place.location, provider);

            if (result) {
              updatedPlaces[i] = {
                ...place,
                latitude: result.latitude,
                longitude: result.longitude,
                normalizedLocation: result.normalizedLocation,
                normalizedCountry: result.normalizedCountry,
                normalizedCity: result.normalizedCity,
                normalizedNeighborhood: result.normalizedNeighborhood,
                geocodingProvider: result.provider,
              };
              updated = true;
              migrationProgress.updated++;

              if (result.source === 'cache' || result.source === 'local') {
                migrationProgress.cacheHits++;
              } else {
                migrationProgress.apiHits++;
              }
            } else {
              migrationProgress.skipped++;
            }
          } catch (error) {
            migrationProgress.skipped++;
            console.error(`[InstaMap] Migration geocoding error for "${place.location}":`, error);
          }

          migrationProgress.processed++;
        }

        // Save updated places
        if (updated) {
          await neo4jService.updateMentionedPlaces(post.id, updatedPlaces);
        }

        // Log progress every 20 posts
        if (postsToMigrate.indexOf(post) % 20 === 0) {
          console.log(`[InstaMap] Migration progress: ${migrationProgress.processed}/${migrationProgress.total} places (${migrationProgress.cacheHits} cache, ${migrationProgress.apiHits} API)`);
        }
      }

      migrationProgress.status = 'done';
      migrationProgress.currentPost = undefined;
      console.log(`[InstaMap] Migration complete: ${migrationProgress.updated} updated, ${migrationProgress.skipped} skipped (${migrationProgress.cacheHits} cache hits, ${migrationProgress.apiHits} API calls)`);
    })();

  } catch (error) {
    console.error('Migration failed:', error);
    migrationProgress.status = 'idle';
    res.status(500).json({ error: 'Failed to start migration' });
  }
});

// Get geocoding cache stats
postsRouter.get('/geocode-cache/stats', async (_req: Request, res: Response) => {
  try {
    const stats = await neo4jService.getGeocodingCacheStats();
    res.json(stats);
  } catch (error) {
    console.error('Failed to get cache stats:', error);
    res.status(500).json({ error: 'Failed to get cache stats' });
  }
});

// ============ EMBEDDING REGENERATION ENDPOINTS ============

// Clear geocoding cache
postsRouter.delete('/geocode-cache', async (_req: Request, res: Response) => {
  try {
    const deleted = await neo4jService.clearGeocodingCache();
    geocodingService.clearMemoryCache();
    res.json({ success: true, deleted, message: `Cleared ${deleted} cache entries` });
  } catch (error) {
    console.error('Failed to clear geocoding cache:', error);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

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
    const { eventDate, hashtags, mentionedPlaces } = req.body;

    // Pass 'user' as source to track manual edits
    await neo4jService.updatePostMetadata(id, {
      eventDate,
      hashtags,
      mentionedPlaces,
    }, 'user');

    res.json({ success: true, message: 'Post metadata updated by user' });
  } catch (error) {
    console.error('Failed to update post metadata:', error);
    res.status(500).json({ error: 'Failed to update post metadata' });
  }
});

// ============ MIGRATION: location/venue to mentionedPlaces ============
// One-off endpoint to migrate old location/venue data to mentionedPlaces array
postsRouter.post('/migrate/location-to-places', async (_req: Request, res: Response) => {
  try {
    console.log('[Migration] Starting location/venue to mentionedPlaces migration...');
    const result = await neo4jService.migrateLocationVenueToMentionedPlaces();
    console.log('[Migration] Complete:', result);
    res.json({
      success: true,
      ...result,
      message: `Migrated ${result.migrated} posts, skipped ${result.skipped} (no location/venue data).`,
    });
  } catch (error) {
    console.error('Migration failed:', error);
    res.status(500).json({ error: 'Failed to migrate location/venue data' });
  }
});

// One-off endpoint to clean up legacy location/venue fields after migration
postsRouter.post('/migrate/cleanup-legacy-fields', async (_req: Request, res: Response) => {
  try {
    console.log('[Migration] Cleaning up legacy location/venue fields...');
    const cleaned = await neo4jService.cleanupLegacyLocationFields();
    console.log('[Migration] Cleaned up:', cleaned, 'posts');
    res.json({
      success: true,
      cleaned,
      message: `Removed legacy location/venue fields from ${cleaned} posts.`,
    });
  } catch (error) {
    console.error('Cleanup failed:', error);
    res.status(500).json({ error: 'Failed to clean up legacy fields' });
  }
});

// ============ CLEANUP: Merge duplicate posts ============
// One-off endpoint to find and merge duplicate posts by instagramId
postsRouter.post('/cleanup/duplicates', async (req: Request, res: Response) => {
  try {
    console.log('[Cleanup] Starting duplicate post cleanup...');
    const result = await neo4jService.cleanupDuplicatePosts();
    console.log('[Cleanup] Complete:', result);
    res.json({
      success: true,
      ...result,
      message: `Found ${result.duplicatesFound} instagramIds with duplicates. Merged ${result.postsMerged} posts, deleted ${result.postsDeleted} duplicates.`,
    });
  } catch (error) {
    console.error('Failed to cleanup duplicates:', error);
    res.status(500).json({ error: 'Failed to cleanup duplicates', details: String(error) });
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

// Get real-time categorization progress
postsRouter.get('/auto-categorize/status', async (_req: Request, res: Response) => {
  if (!realtimeProgress) {
    return res.json({ status: 'idle' });
  }
  res.json(realtimeProgress);
});

// Helper to process real-time categorization in background
async function processRealtimeCategorization(
  posts: InstagramPost[],
  parentNames: string[],
  existingCategories: { id: string; name: string }[]
) {
  try {
    realtimeProgress = {
      status: 'processing',
      completed: 0,
      total: posts.length,
      categorized: 0,
      startedAt: Date.now(),
    };

    console.log(`[InstaMap] Processing ${posts.length} posts in real-time batches...`);

    const extractions = await claudeService.extractPostsBatch(posts, parentNames, (completed, total) => {
      console.log(`[InstaMap] Progress: ${completed}/${total}`);
      if (realtimeProgress) {
        realtimeProgress.completed = completed;
        realtimeProgress.total = total;
      }
    });

    // Update status to saving
    if (realtimeProgress) {
      realtimeProgress.status = 'saving';
    }

    let categorized = 0;
    const categorizedPostIds: string[] = [];

    for (const [postId, extraction] of extractions) {
      try {
        console.log(`[InstaMap] Extracted from post ${postId}:`, {
          hashtags: extraction.hashtags.length,
          mentionedPlaces: extraction.mentionedPlaces.length,
          categories: extraction.categories.length,
          eventDate: extraction.eventDate,
        });

        // Save all extracted metadata AND reasons to Neo4j
        await neo4jService.updatePostMetadata(postId, {
          eventDate: extraction.eventDate || undefined,
          hashtags: extraction.hashtags,
          mentions: extraction.mentions,
          mentionedPlaces: extraction.mentionedPlaces,
          // Save the AI reasoning
          eventDateReason: extraction.eventDateReason,
          hashtagsReason: extraction.hashtagsReason,
          categoriesReason: extraction.categoriesReason,
          mentionsReason: extraction.mentionsReason,
          mentionedPlacesReason: extraction.mentionedPlacesReason,
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

        // Update progress during saving
        if (realtimeProgress) {
          realtimeProgress.categorized = categorized;
        }
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

    // Mark as done
    if (realtimeProgress) {
      realtimeProgress.status = 'done';
      realtimeProgress.categorized = categorized;
    }
    console.log(`[InstaMap] Real-time categorization complete: ${categorized}/${posts.length}`);

  } catch (error) {
    console.error('Real-time categorization failed:', error);
    if (realtimeProgress) {
      realtimeProgress.status = 'error';
      realtimeProgress.error = error instanceof Error ? error.message : 'Unknown error';
    }
  }
}

// Auto-categorize posts (Option A: real-time batched processing)
postsRouter.post('/auto-categorize', async (req: Request<{}, {}, AutoCategorizeRequest & { mode?: 'realtime' | 'async' }>, res: Response) => {
  try {
    const { postIds, mode = 'realtime' } = req.body;

    if (!Array.isArray(postIds) || postIds.length === 0) {
      return res.status(400).json({ error: 'postIds must be a non-empty array' });
    }

    // Check if real-time job is already running
    if (mode === 'realtime' && realtimeProgress && realtimeProgress.status === 'processing') {
      return res.status(409).json({
        error: 'Real-time categorization already in progress',
        progress: realtimeProgress,
      });
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

    // Option A: Real-time batched processing - run in background
    // Return immediately and let client poll for status
    processRealtimeCategorization(posts, parentNames, existingCategories);

    res.json({
      mode: 'realtime',
      status: 'started',
      total: posts.length,
      message: `Started processing ${posts.length} posts. Poll /posts/auto-categorize/status for progress.`,
    });
  } catch (error) {
    console.error('Auto-categorize failed:', error);
    res.status(500).json({ error: 'Failed to auto-categorize posts' });
  }
});

// Track batches being processed to avoid duplicate processing
const batchesBeingProcessed = new Set<string>();
const batchProcessingResults = new Map<string, { categorized: number; total: number; error?: string }>();

// Track real-time categorization progress
interface RealtimeProgress {
  status: 'processing' | 'saving' | 'done' | 'error';
  completed: number;
  total: number;
  categorized: number;
  startedAt: number;
  error?: string;
}
let realtimeProgress: RealtimeProgress | null = null;

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
        eventDate: extraction.eventDate || undefined,
        hashtags: extraction.hashtags,
        mentions: extraction.mentions,
        mentionedPlaces: extraction.mentionedPlaces,
        // Save the AI reasoning
        eventDateReason: extraction.eventDateReason,
        hashtagsReason: extraction.hashtagsReason,
        categoriesReason: extraction.categoriesReason,
        mentionsReason: extraction.mentionsReason,
        mentionedPlacesReason: extraction.mentionedPlacesReason,
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

  // Get existing post IDs that already have embeddings to skip them
  const existingIds = await neo4jService.getPostIdsWithEmbeddings();
  const existingSet = new Set(existingIds);

  const postsNeedingEmbeddings = postsWithCaptions.filter(p => !existingSet.has(p.id));

  if (postsNeedingEmbeddings.length === 0) {
    console.log('[Embeddings] All posts already have embeddings, skipping');
    return;
  }

  console.log(`[Embeddings] Generating for ${postsNeedingEmbeddings.length} new posts (skipping ${postsWithCaptions.length - postsNeedingEmbeddings.length} existing)`);

  for (const post of postsNeedingEmbeddings) {
    try {
      const embedding = await embeddingsService.generatePostEmbedding({
        caption: post.caption,
        ownerUsername: post.ownerUsername,
      });
      await neo4jService.updatePostEmbedding(post.id, embedding);
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
          mentionedPlaces: post.mentionedPlaces,
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

