import { InstagramPost, Category, ChatMessage } from './types';
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
 */
export function getProxyImageUrl(imageUrl: string | undefined): string {
  if (!imageUrl) return '';

  // Use cached URL, fallback to default
  const baseUrl = cachedBackendUrl || 'http://localhost:3001';

  // Only proxy Instagram CDN URLs
  if (imageUrl.includes('cdninstagram.com') || imageUrl.includes('instagram.com')) {
    return `${baseUrl}/api/posts/image-proxy?url=${encodeURIComponent(imageUrl)}`;
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

  // Posts
  async syncPosts(posts: InstagramPost[]): Promise<{ synced: number }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ posts }),
    });
    if (!response.ok) throw new Error('Failed to sync posts');
    return response.json();
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
    return response.json();
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
    return data.postIds;
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
    location?: string;
    venue?: string;
    eventDate?: string;
    hashtags?: string[];
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
};
