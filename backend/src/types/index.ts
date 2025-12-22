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
  // Edit tracking
  lastEditedBy?: 'user' | 'claude';
  lastEditedAt?: string;
  // Embedding tracking: 0=none, 1=basic (caption only), 2=enriched (with categories)
  embeddingVersion?: number;
}

// Structured extraction from Claude
export interface PostExtraction {
  hashtags: string[];
  hashtagsReason: string;
  location: string | null;
  locationReason: string;
  venue: string | null;
  venueReason: string;
  categories: string[];
  categoriesReason: string;
  eventDate: string | null;
  eventDateReason: string;
  mentions: string[];  // Featured accounts: brands, collaborators, products
  mentionsReason: string;
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
