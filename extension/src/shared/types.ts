// A place mentioned in a post (restaurants, attractions, hotels, etc.)
export interface MentionedPlace {
  venue: string;          // "Kle Restaurant"
  location: string;       // "Belgravia, London, United Kingdom" (from Claude - should include country)
  handle?: string;        // "@klerestaurant" (useful for lookups)
  metadata?: string;      // "1⭐ – €180" (stars, price, ranking, etc.)
  latitude?: number;      // Geocoded coordinates
  longitude?: number;
  // Normalized location hierarchy from geocoding API
  normalizedLocation?: string;      // Full: "Westminster, London, England, United Kingdom"
  normalizedCountry?: string;       // "United Kingdom"
  normalizedCity?: string;          // "London"
  normalizedNeighborhood?: string;  // "Westminster" (optional, for areas within cities)
  geocodingProvider?: 'mapbox' | 'google'; // Which API was used
}

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
  eventDate?: string;
  mentions?: string[];  // Featured accounts: brands, collaborators, products
  mentionedPlaces?: MentionedPlace[];  // All places mentioned in the post
  // Extraction reasons (from AI)
  hashtagsReason?: string;
  categoriesReason?: string;
  eventDateReason?: string;
  mentionsReason?: string;
  mentionedPlacesReason?: string;
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
  deleted?: boolean;         // True if post was deleted/unsaved from Instagram (404)
  deletedAt?: string;        // When the post was marked as deleted
  // Search relevance (only present in search results)
  relevanceScore?: number;   // 0-1 similarity score from semantic search
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
  USERNAME: 'instamap_username',
} as const;

// Settings
export interface Settings {
  backendUrl: string;
  autoSync: boolean;
  syncInterval: number; // minutes
  scrollDelayMs: number; // delay between scrolls to avoid rate limiting
  storeImages: boolean; // Whether to download and store images on backend (default: true)
}

export const DEFAULT_SETTINGS: Settings = {
  backendUrl: 'http://localhost:3001',
  autoSync: false,
  syncInterval: 60,
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
  | { type: 'REFRESH_IMAGE_URLS'; instagramIds: string[] }
  | { type: 'FETCH_EXPIRED_IMAGES' }
  | { type: 'UPDATE_IMAGE_URLS'; updates: { instagramId: string; imageUrl: string }[] }
  | { type: 'MARK_POSTS_DELETED'; instagramIds: string[] }
  | { type: 'RECORD_REFRESH_FAILURES'; instagramIds: string[] }
  | { type: 'FETCH_SYNCED_IDS' };
