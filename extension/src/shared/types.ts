// Instagram Post data structure
export interface InstagramPost {
  id: string;
  instagramId: string;
  imageUrl: string;
  thumbnailUrl?: string;
  caption: string;
  ownerUsername: string;
  ownerProfilePicUrl?: string;
  timestamp: string;
  savedAt: string;
  likes?: number;
  comments?: number;
  isVideo: boolean;
  videoUrl?: string;
}

// Category for organizing posts
export interface Category {
  id: string;
  name: string;
  description?: string;
  color?: string;
  postCount: number;
  createdAt: string;
}

// Post with category relationships
export interface PostWithCategories extends InstagramPost {
  categories: Category[];
  embedding?: number[];
}

// Entity extracted from posts (people, places, brands)
export interface Entity {
  id: string;
  name: string;
  type: 'person' | 'place' | 'brand' | 'topic' | 'hashtag';
  postCount: number;
}

// Chat message for AI interface
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  relatedPosts?: InstagramPost[];
}

// Sync status
export interface SyncStatus {
  lastSync: string | null;
  totalPosts: number;
  syncInProgress: boolean;
  error?: string;
}

// Storage keys
export const STORAGE_KEYS = {
  POSTS: 'instamap_posts',
  CATEGORIES: 'instamap_categories',
  SYNC_STATUS: 'instamap_sync_status',
  SETTINGS: 'instamap_settings',
} as const;

// Settings
export interface Settings {
  backendUrl: string;
  autoSync: boolean;
  syncInterval: number; // minutes
}

export const DEFAULT_SETTINGS: Settings = {
  backendUrl: 'http://localhost:3001',
  autoSync: false,
  syncInterval: 60,
};

// Messages between extension components
export type MessageType =
  | { type: 'SCRAPE_POSTS' }
  | { type: 'POSTS_SCRAPED'; posts: InstagramPost[] }
  | { type: 'SYNC_TO_BACKEND' }
  | { type: 'SYNC_COMPLETE'; status: SyncStatus }
  | { type: 'GET_POSTS' }
  | { type: 'GET_STATUS' }
  | { type: 'OPEN_DASHBOARD' };
