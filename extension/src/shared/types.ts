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
  // Extracted data
  hashtags?: string[];
  location?: string;
  venue?: string;
  eventDate?: string;
  mentions?: string[];  // Featured accounts: brands, collaborators, products
  // Extraction reasons (from AI)
  hashtagsReason?: string;
  locationReason?: string;
  venueReason?: string;
  categoriesReason?: string;
  eventDateReason?: string;
  mentionsReason?: string;
  // Geocoded coordinates
  latitude?: number;
  longitude?: number;
  // Categories (when fetched from backend)
  categories?: string[];
  // Edit tracking
  lastEditedBy?: 'user' | 'claude';
  lastEditedAt?: string;
  // Embedding tracking: 0=none, 1=basic (caption only), 2=enriched (with categories)
  embeddingVersion?: number;
  // Image storage
  localImagePath?: string;   // Path to locally stored image (if storeImages enabled)
  imageExpired?: boolean;    // True if image URL returned 403 (expired)
  imageExpiredAt?: string;   // When the image was marked as expired
}

// Category for organizing posts
export interface Category {
  id: string;
  name: string;
  description?: string;
  color?: string;
  postCount: number;
  createdAt: string;
  // New fields for hierarchy
  isParent?: boolean;       // True if this is a parent category
  embedding?: number[];     // Category name embedding for clustering
}

// Post with full category relationships (for detailed view)
export interface PostWithCategories extends Omit<InstagramPost, 'categories'> {
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
  quickSyncThresholdDays: number; // days since last sync to use quick sync
  scrollDelayMs: number; // delay between scrolls to avoid rate limiting
  storeImages: boolean; // Whether to download and store images on backend (default: true)
}

export const DEFAULT_SETTINGS: Settings = {
  backendUrl: 'http://localhost:3001',
  autoSync: false,
  syncInterval: 60,
  quickSyncThresholdDays: 7,
  scrollDelayMs: 2000,
  storeImages: true, // Default to storing images locally
};

// Messages between extension components
export type MessageType =
  | { type: 'SCRAPE_POSTS' }
  | { type: 'POSTS_SCRAPED'; posts: InstagramPost[] }
  | { type: 'SYNC_TO_BACKEND' }
  | { type: 'SYNC_COMPLETE'; status: SyncStatus }
  | { type: 'GET_POSTS' }
  | { type: 'GET_STATUS' }
  | { type: 'OPEN_DASHBOARD' }
  | { type: 'START_QUICK_SYNC' }
  | { type: 'START_FULL_COLLECTION' }
  | { type: 'COLLECTION_PROGRESS'; collected: number; status: 'scrolling' | 'paused' | 'done' }
  | { type: 'STOP_COLLECTION' }
  | { type: 'REFRESH_IMAGE_URLS'; instagramIds: string[] };
