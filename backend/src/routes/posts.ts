import { Router, Request, Response } from 'express';
import { neo4jService } from '../services/neo4j.js';
import { embeddingsService } from '../services/embeddings.js';
import { claudeService } from '../services/claude.js';
import { geocodingService } from '../services/geocoding.js';
import { InstagramPost, SyncPostsRequest, AutoCategorizeRequest } from '../types/index.js';

export const postsRouter = Router();

// ============ IMAGE PROXY (must be before other routes) ============
// This proxies Instagram images to bypass CORS restrictions in the extension
postsRouter.get('/image-proxy', async (req: Request, res: Response) => {
  try {
    const imageUrl = req.query.url as string;

    if (!imageUrl) {
      return res.status(400).json({ error: 'URL parameter is required' });
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
      return res.status(response.status).json({ error: 'Failed to fetch image' });
    }

    // Get content type
    const contentType = response.headers.get('content-type') || 'image/jpeg';

    // Set response headers
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Stream the image data
    const arrayBuffer = await response.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (error) {
    console.error('[Image Proxy] Error:', error);
    res.status(500).json({ error: 'Failed to proxy image' });
  }
});

// Sync posts from extension
postsRouter.post('/sync', async (req: Request<{}, {}, SyncPostsRequest>, res: Response) => {
  try {
    const { posts } = req.body;

    if (!Array.isArray(posts)) {
      return res.status(400).json({ error: 'Posts must be an array' });
    }

    console.log(`Syncing ${posts.length} posts...`);

    const synced = await neo4jService.upsertPosts(posts);

    // Generate embeddings for posts with captions (in background)
    generateEmbeddingsInBackground(posts);

    res.json({
      synced,
      total: posts.length,
      message: `Successfully synced ${synced} posts`,
    });
  } catch (error) {
    console.error('Sync failed:', error);
    res.status(500).json({ error: 'Failed to sync posts' });
  }
});

// Get all posts
postsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const categoryId = req.query.category as string;

    const posts = await neo4jService.getPosts({ limit, offset, categoryId });
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

    // Process in background
    (async () => {
      const postIds = postsNeedingRefresh.map(p => p.id);
      const result = await regenerateEnrichedEmbeddings(postIds, false);

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

    // Option B: Async batch API (50% cheaper)
    if (mode === 'async') {
      const { batchId, requestCount } = await claudeService.submitBatchExtraction(posts, existingCategories);
      return res.json({
        mode: 'async',
        batchId,
        requestCount,
        message: `Submitted ${requestCount} posts for async processing. Poll /posts/batch/${batchId} for results.`,
      });
    }

    // Option A: Real-time batched processing
    console.log(`[InstaMap] Processing ${posts.length} posts in real-time batches...`);

    const extractions = await claudeService.extractPostsBatch(posts, existingCategories, (completed, total) => {
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

        // Handle categories
        for (const name of extraction.categories) {
          let category = existingCategories.find(c =>
            c.name.toLowerCase() === name.toLowerCase()
          );

          if (!category) {
            category = await neo4jService.createCategory(name);
            existingCategories.push(category);
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

      // Process categories
      for (const name of extraction.categories) {
        let category = existingCategories.find(c =>
          c.name.toLowerCase() === name.toLowerCase()
        );

        if (!category) {
          category = await neo4jService.createCategory(name);
          existingCategories.push(category);
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

// Regenerate embeddings with enriched metadata (after categorization)
async function regenerateEnrichedEmbeddings(postIds: string[], skipAlreadyEnriched = false) {
  console.log(`[InstaMap] Regenerating embeddings for ${postIds.length} posts with enriched metadata...`);
  let updated = 0;
  let skipped = 0;

  for (const postId of postIds) {
    try {
      // Fetch the post with all its metadata
      const post = await neo4jService.getPostById(postId);
      if (!post || !post.caption) continue;

      // Skip if already has enriched embedding (version 2) and skipAlreadyEnriched is true
      if (skipAlreadyEnriched && post.embeddingVersion === 2) {
        skipped++;
        continue;
      }

      // Fetch categories for this post
      const categories = await neo4jService.getPostCategories(postId);
      const categoryNames = categories.map(c => c.name);

      // Generate enriched embedding
      const embedding = await embeddingsService.generatePostEmbedding({
        caption: post.caption,
        ownerUsername: post.ownerUsername,
        categories: categoryNames,
        location: post.location,
        venue: post.venue,
        hashtags: post.hashtags,
        mentions: post.mentions,
      });

      await neo4jService.updatePostEmbedding(postId, embedding);
      // Mark as enriched embedding (version 2)
      await neo4jService.updateEmbeddingVersion(postId, 2);
      updated++;
    } catch (error) {
      console.error(`Failed to regenerate embedding for post ${postId}:`, error);
    }
  }

  console.log(`[InstaMap] Regenerated ${updated}/${postIds.length} embeddings with enriched metadata (skipped ${skipped} already enriched)`);
  return { updated, skipped };
}

