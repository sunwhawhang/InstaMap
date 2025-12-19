import { InstagramPost, Category, ChatMessage } from './types';
import { getSettings } from './storage';

// Get the backend URL from settings
async function getBackendUrl(): Promise<string> {
  const settings = await getSettings();
  return settings.backendUrl;
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
  }): Promise<InstagramPost[]> {
    const baseUrl = await getBackendUrl();
    const params = new URLSearchParams();
    if (options?.category) params.set('category', options.category);
    if (options?.search) params.set('search', options.search);
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.offset) params.set('offset', options.offset.toString());

    const response = await fetch(`${baseUrl}/api/posts?${params}`);
    if (!response.ok) throw new Error('Failed to fetch posts');
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

  async autoCategorize(postIds: string[]): Promise<{ categorized: number }> {
    const baseUrl = await getBackendUrl();
    const response = await fetch(`${baseUrl}/api/posts/auto-categorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postIds }),
    });
    if (!response.ok) throw new Error('Failed to auto-categorize');
    return response.json();
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
};
