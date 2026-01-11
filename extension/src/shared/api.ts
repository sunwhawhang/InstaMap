import { InstagramPost, Category, ChatMessage, MentionedPlace } from './types';
import { getSettings } from './storage';

// Get the backend URL from settings
async function getBackendUrl(): Promise<string> {
  const settings = await getSettings();
  return settings.backendUrl;
}

// Cached backend URL for sync access in getProxyImageUrl
let cachedBackendUrl: string | null = null;

// Initialize/update cached URL (call this at app startup or when settings change)
export async function initImageProxy(): Promise<void> {
  cachedBackendUrl = await getBackendUrl();
}

/**
 * Convert an Instagram CDN URL to a proxied URL through our backend.
 * This bypasses CORS restrictions for displaying images in the extension.
 * If postId is provided, the backend can serve locally stored images.
 */
export function getProxyImageUrl(imageUrl: string | undefined, postId?: string): string {
  if (!imageUrl) return '';

  // Use cached URL, fallback to default
  const baseUrl = cachedBackendUrl || 'http://localhost:3001';

  // Only proxy Instagram CDN URLs
  if (imageUrl.includes('cdninstagram.com') || imageUrl.includes('instagram.com')) {
    let url = `${baseUrl}/api/posts/image-proxy?url=${encodeURIComponent(imageUrl)}`;
    if (postId) {
      url += `&postId=${encodeURIComponent(postId)}`;
    }
    return url;
  }

  // Return original URL for non-Instagram images
  return imageUrl;
}

// API client for backend communication
export const api = {
  // Health check
  async health(): Promise<boolean> {
    try {
      const baseUrl = await getBackendUrl();
      const response = await fetch(`${baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  },

  // Get cloud sync status (works even when local cache is cleared)
  async getCloudSyncStatus(): Promise<{
    cloudPostCount: number;
    lastSyncedAt: string | null;
    cachedLocalPostCount: number | null;
  }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/sync-status`);
    if (!response.ok) throw new Error('Failed to get cloud sync status');
    return response.json();
  },

  // Posts - syncs in chunks of 50 to avoid payload size limits
  async syncPosts(
    posts: InstagramPost[],
    storeImages?: boolean,
    localPostCount?: number,
    onProgress?: (synced: number, total: number) => void
  ): Promise<{ synced: number; storeImages: boolean }> {
    const baseUrl = await getBackendUrl();
    const settings = await getSettings();
    const shouldStoreImages = storeImages ?? settings.storeImages;

    const CHUNK_SIZE = 50;
    const total = posts.length;
    let totalSynced = 0;
    let lastStoreImages = shouldStoreImages;

    for (let i = 0; i < posts.length; i += CHUNK_SIZE) {
      const chunk = posts.slice(i, i + CHUNK_SIZE);
      const response = await fetch(`${baseUrl}/api/posts/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          posts: chunk,
          storeImages: shouldStoreImages,
          localPostCount: i === 0 ? (localPostCount ?? total) : undefined
        }),
      });
      if (!response.ok) throw new Error('Failed to sync posts');
      const result = await response.json();
      totalSynced += result.synced;
      lastStoreImages = result.storeImages;
      onProgress?.(totalSynced, total);
    }

    return { synced: totalSynced, storeImages: lastStoreImages };
  },

  async getPosts(options?: {
    category?: string;
    search?: string;
    limit?: number;
    offset?: number;
    recursive?: boolean;
  }): Promise<InstagramPost[]> {
    const baseUrl = await getBackendUrl();
    const params = new URLSearchParams();
    if (options?.category) params.set('category', options.category);
    if (options?.search) params.set('search', options.search);
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.offset) params.set('offset', options.offset.toString());
    if (options?.recursive !== undefined) params.set('recursive', options.recursive.toString());

    const response = await fetch(`${baseUrl}/api/posts?${params}`);
    if (!response.ok) throw new Error('Failed to fetch posts');

    const data = await response.json();

    // Search returns { posts, total, isSearch }, normal returns array
    if (data.isSearch) {
      return data.posts;
    }
    return data;
  },

  async getSearchCount(query: string): Promise<number> {
    const baseUrl = await getBackendUrl();
    const params = new URLSearchParams({ search: query });
    const response = await fetch(`${baseUrl}/api/posts/search-count?${params}`);
    if (!response.ok) throw new Error('Failed to get search count');
    const data = await response.json();
    return data.count;
  },

  async getPost(postId: string): Promise<InstagramPost | null> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/${postId}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Failed to fetch post');
    return response.json();
  },

  async searchSimilar(postId: string, limit = 5): Promise<InstagramPost[]> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/${postId}/similar?limit=${limit}`);
    if (!response.ok) throw new Error('Failed to find similar posts');
    return response.json();
  },

  // Categories
  async getCategories(): Promise<Category[]> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/categories`);
    if (!response.ok) throw new Error('Failed to fetch categories');
    return response.json();
  },

  async getCategoryHierarchy(): Promise<(Category & { children: Category[] })[]> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/categories/hierarchy`);
    if (!response.ok) throw new Error('Failed to fetch category hierarchy');
    return response.json();
  },

  async getCategoryPostCount(categoryId: string): Promise<number> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/categories/${categoryId}/count`);
    if (!response.ok) throw new Error('Failed to get category post count');
    const data = await response.json();
    return data.count;
  },

  async analyzeCategoryCleanup(minPosts: number): Promise<{
    toKeep: Category[];
    toDelete: Category[];
    orphanedPosts: number;
  }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/categories/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minPosts }),
    });
    if (!response.ok) throw new Error('Failed to analyze categories');
    return response.json();
  },

  async getCategoryCleanupStatus(): Promise<{
    status: 'idle' | 'running' | 'done' | 'error';
    message: string;
    progress: number;
    logs?: string[];
    result?: {
      deletedCount: number;
      hashtagsAdded: number;
      remainingCount: number;
      parentCount: number;
      childCount: number;
    };
    error?: string;
  }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/categories/cleanup/status`);
    if (!response.ok) throw new Error('Failed to get cleanup status');
    return response.json();
  },

  async executeCategoryCleanup(minPosts: number, dryRun = false): Promise<{
    deletedCount: number;
    hashtagsAdded: number;
    remainingCount: number;
    parentCount: number;
    childCount: number;
  }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/categories/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minPosts, dryRun }),
    });
    if (!response.ok) throw new Error('Failed to execute category cleanup');
    return response.json();
  },

  async resetCategories(): Promise<void> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/categories/reset`, {
      method: 'POST',
    });
    if (!response.ok) throw new Error('Failed to reset categories');
  },

  async commitTaxonomy(): Promise<void> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/categories/cleanup/commit`, {
      method: 'POST',
    });
    if (!response.ok) throw new Error('Failed to commit taxonomy');
  },

  async setCategoryParent(childId: string, parentId: string | null): Promise<void> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/categories/${childId}/parent`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId }),
    });
    if (!response.ok) throw new Error('Failed to set category parent');
  },

  async getPostCategories(postId: string): Promise<Category[]> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/${postId}/categories`);
    if (!response.ok) throw new Error('Failed to fetch post categories');
    return response.json();
  },

  async createCategory(name: string, description?: string): Promise<Category> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    });
    if (!response.ok) throw new Error('Failed to create category');
    return response.json();
  },

  async assignCategory(postId: string, categoryId: string): Promise<void> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/${postId}/categories/${categoryId}`, {
      method: 'PUT',
    });
    if (!response.ok) throw new Error('Failed to assign category');
  },

  async autoCategorize(
    postIds: string[],
    mode: 'realtime' | 'async' = 'realtime'
  ): Promise<{
    mode: string;
    categorized?: number;
    total?: number;
    batchId?: string;
    requestCount?: number;
  }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/auto-categorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postIds, mode }),
    });
    if (!response.ok) throw new Error('Failed to auto-categorize');
    return response.json();
  },

  async getBatchStatus(batchId: string): Promise<{
    status: 'in_progress' | 'ended' | 'canceling' | 'canceled' | 'failed' | 'expired' | 'processing_results';
    categorized?: number;
    total?: number;
    progress?: { completed: number; total: number };
    message?: string;
  }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/batch/${batchId}`);
    if (!response.ok) throw new Error('Failed to get batch status');
    return response.json();
  },

  async getCategorizedPostIds(): Promise<string[]> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/categorized-ids`);
    if (!response.ok) throw new Error('Failed to get categorized post IDs');
    const data = await response.json();
    return data.instagramIds; // Changed from postIds to instagramIds
  },

  async getUncategorizedCount(): Promise<number> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/uncategorized-count`);
    if (!response.ok) throw new Error('Failed to get uncategorized count');
    const data = await response.json();
    return data.count;
  },

  async getAllPostIds(): Promise<string[]> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/all-ids`);
    if (!response.ok) throw new Error('Failed to get all post IDs');
    const data = await response.json();
    return data.postIds;
  },

  async getPostCount(): Promise<number> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/count`);
    if (!response.ok) throw new Error('Failed to get post count');
    const data = await response.json();
    return data.total;
  },

  async getSyncedInstagramIds(limit: number = 20000, offset: number = 0): Promise<string[]> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/synced-instagram-ids?limit=${limit}&offset=${offset}`);
    if (!response.ok) throw new Error('Failed to get synced Instagram IDs');
    const data = await response.json();
    return data.instagramIds;
  },

  async getSyncedInstagramIdsAll(pageSize: number = 20000): Promise<string[]> {
    let allIds: string[] = [];
    let offset = 0;

    // Get total once at the start
    const totalCount = await this.getPostCount();

    while (allIds.length < totalCount) {
      const ids = await this.getSyncedInstagramIds(pageSize, offset);

      if (ids.length === 0) break; // Safety break

      allIds = [...allIds, ...ids];
      offset += ids.length;
    }
    return allIds;
  },

  // Chat
  async chat(message: string, context?: { postIds?: string[] }): Promise<ChatMessage> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, context }),
    });
    if (!response.ok) throw new Error('Failed to send chat message');
    return response.json();
  },

  // Semantic search
  async semanticSearch(query: string, limit = 10): Promise<InstagramPost[]> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit }),
    });
    if (!response.ok) throw new Error('Failed to search');
    return response.json();
  },

  // Map / Geocoding
  async getPostsWithCoordinates(): Promise<{ posts: InstagramPost[]; count: number }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/with-coordinates`);
    if (!response.ok) throw new Error('Failed to fetch posts with coordinates');
    return response.json();
  },

  async getPostsNeedingGeocoding(): Promise<{ posts: { id: string; location: string }[]; count: number }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/needs-geocoding`);
    if (!response.ok) throw new Error('Failed to fetch posts needing geocoding');
    return response.json();
  },

  async geocodePosts(): Promise<{ status: string; total: number; message: string }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/geocode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) throw new Error('Failed to geocode posts');
    return response.json();
  },

  async updatePostMetadata(postId: string, metadata: {
    eventDate?: string;
    hashtags?: string[];
    mentionedPlaces?: MentionedPlace[];
  }): Promise<{ success: boolean }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/${postId}/metadata`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    });
    if (!response.ok) throw new Error('Failed to update post metadata');
    return response.json();
  },

  async getGeocodeStatus(): Promise<{
    status: 'idle' | 'running' | 'done';
    processed: number;
    total: number;
    geocoded: number;
    failed: number;
    localHits: number;
    apiHits: number;
    currentLocation?: string;
  }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/geocode/status`);
    if (!response.ok) throw new Error('Failed to get geocode status');
    return response.json();
  },

  // Embeddings
  async getEmbeddingsNeedingRefresh(): Promise<{ count: number; posts: { id: string; embeddingVersion: number }[] }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/embeddings/needs-refresh`);
    if (!response.ok) throw new Error('Failed to get embeddings needing refresh');
    return response.json();
  },

  async regenerateEmbeddings(): Promise<{ status: string; total: number; message: string }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/embeddings/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) throw new Error('Failed to regenerate embeddings');
    return response.json();
  },

  async getEmbeddingStatus(): Promise<{
    status: 'idle' | 'running' | 'done';
    processed: number;
    total: number;
    updated: number;
    skipped: number;
  }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/embeddings/status`);
    if (!response.ok) throw new Error('Failed to get embedding status');
    return response.json();
  },

  // Image Storage
  async getImageStorageStatus(): Promise<{
    total: number;
    withLocalImage: number;
    expired: number;
    needsDownload: number;
    storageStats: { count: number; totalSizeBytes: number; directory: string };
    downloadProgress: {
      status: 'idle' | 'running' | 'done';
      processed: number;
      total: number;
      downloaded: number;
      failed: number;
      alreadyStored: number;
    };
    expiryCheckProgress: {
      status: 'idle' | 'running' | 'done';
      processed: number;
      total: number;
      expired: number;
      valid: number;
      startedAt?: string;
    };
  }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/images/status`);
    if (!response.ok) throw new Error('Failed to get image status');
    return response.json();
  },

  async checkExpiredImages(options?: { limit?: number; oldestFirst?: boolean }): Promise<{
    status: string;
    total: number;
    estimatedMinutes?: number;
    message: string;
  }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/images/check-expired`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options || {}),
    });
    if (!response.ok) throw new Error('Failed to start expiry check');
    return response.json();
  },

  async stopExpiryCheck(): Promise<{ success: boolean; message: string }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/images/check-expired/stop`, {
      method: 'POST',
    });
    if (!response.ok) throw new Error('Failed to stop expiry check');
    return response.json();
  },

  async getExpiredImages(): Promise<{ posts: InstagramPost[]; count: number }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/images/expired`);
    if (!response.ok) throw new Error('Failed to get expired images');
    return response.json();
  },

  async markImageExpired(postId: string): Promise<{ success: boolean }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/images/mark-expired`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId }),
    });
    if (!response.ok) throw new Error('Failed to mark image expired');
    return response.json();
  },

  async downloadAllImages(): Promise<{ status: string; total: number; message: string }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/images/download-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) throw new Error('Failed to start image download');
    return response.json();
  },

  async refreshImageUrls(updates: Array<{ postId: string; imageUrl: string }>): Promise<{
    success: boolean;
    updated: number;
    total: number;
  }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/images/refresh-urls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    });
    if (!response.ok) throw new Error('Failed to refresh image URLs');
    return response.json();
  },

  // Upload image from client (bypasses Instagram server-side auth)
  async uploadImage(postId: string, instagramId: string, imageData: string): Promise<{
    success: boolean;
    localPath?: string;
    error?: string;
  }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/images/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId, instagramId, imageData }),
    });
    if (!response.ok) throw new Error('Failed to upload image');
    return response.json();
  },

  // Get Instagram IDs that need image upload
  async getInstagramIdsNeedingImages(): Promise<string[]> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/images/needs-upload`);
    if (!response.ok) throw new Error('Failed to get posts needing images');
    const data = await response.json();
    return data.instagramIds;
  },

  // Upload images in batches after sync (with progress callback)
  // Only uploads for posts that need images (not already stored, not expired)
  async uploadImagesFromPosts(
    posts: InstagramPost[],
    onProgress?: (uploaded: number, total: number) => void
  ): Promise<{ uploaded: number; failed: number; skipped: number }> {
    // Get which posts actually need images
    const needsImageIds = new Set(await this.getInstagramIdsNeedingImages());
    const postsNeedingUpload = posts.filter(p => p.imageUrl && needsImageIds.has(p.instagramId));

    if (postsNeedingUpload.length === 0) {
      console.log('[ImageUpload] All posts already have images or are expired, skipping');
      return { uploaded: 0, failed: 0, skipped: posts.length };
    }

    console.log(`[ImageUpload] Uploading ${postsNeedingUpload.length} images (skipping ${posts.length - postsNeedingUpload.length})`);

    const BATCH_SIZE = 10;
    const DELAY_BETWEEN_BATCHES = 200;
    let uploaded = 0;
    let failed = 0;
    const total = postsNeedingUpload.length;

    for (let i = 0; i < postsNeedingUpload.length; i += BATCH_SIZE) {
      const batch = postsNeedingUpload.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (post) => {
        try {
          const imgResponse = await fetch(post.imageUrl!);
          if (!imgResponse.ok) {
            console.warn(`[ImageUpload] Failed to fetch ${post.instagramId}: HTTP ${imgResponse.status}`);
            failed++;
            return;
          }

          const blob = await imgResponse.blob();

          // Check if it's actually an image (not an error page)
          if (!blob.type.startsWith('image/')) {
            console.warn(`[ImageUpload] ${post.instagramId}: Got ${blob.type} instead of image (URL may be expired)`);
            failed++;
            return;
          }

          const base64 = await blobToBase64(blob);

          const result = await this.uploadImage(post.id, post.instagramId, base64);
          if (result.success) {
            uploaded++;
          } else {
            console.warn(`[ImageUpload] Failed to upload ${post.instagramId}: ${result.error}`);
            failed++;
          }
        } catch (err) {
          console.warn(`[ImageUpload] Error for ${post.instagramId}:`, err);
          failed++;
        }
      }));

      onProgress?.(uploaded, total);

      if (i + BATCH_SIZE < postsNeedingUpload.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
      }
    }

    return { uploaded, failed, skipped: posts.length - postsNeedingUpload.length };
  },
};

// Helper to convert blob to base64
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
