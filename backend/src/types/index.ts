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
  embedding?: number[];
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
  // Edit tracking
  lastEditedBy?: 'user' | 'claude';
  lastEditedAt?: string;
  // Embedding tracking: 0=none, 1=basic (caption only), 2=enriched (with categories)
  embeddingVersion?: number;
  // Image storage
  localImagePath?: string;   // Path to locally stored image (if storeImages enabled)
  imageExpired?: boolean;    // True if image URL returned 403 (expired)
  imageExpiredAt?: string;   // When the image was marked as expired
  // Deleted post tracking
  deleted?: boolean;         // True if post was deleted/unsaved from Instagram (404)
  deletedAt?: string;        // When the post was marked as deleted
  // Search relevance (only present in search results)
  relevanceScore?: number;   // 0-1 similarity score from semantic search
}

// Structured extraction from Claude
export interface PostExtraction {
  hashtags: string[];
  hashtagsReason: string;
  categories: string[];
  categoriesReason: string;
  eventDate: string | null;
  eventDateReason: string;
  mentions: string[];  // Featured accounts: brands, collaborators, products
  mentionsReason: string;
  mentionedPlaces: MentionedPlace[];  // All places mentioned in the post
  mentionedPlacesReason: string;
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

// Request/Response types
export interface SyncPostsRequest {
  posts: InstagramPost[];
  storeImages?: boolean; // Whether to download and store images locally (default: true)
  checkpoint?: { start: string[]; end: string[] } | null;
}

export interface SyncPostsResponse {
  synced: number;
  total: number;
}

export interface SearchRequest {
  query: string;
  limit?: number;
}

export interface ChatRequest {
  message: string;
  context?: {
    postIds?: string[];
  };
}

export interface AutoCategorizeRequest {
  postIds: string[];
}
