---
alwaysApply: true
---

# InstaMap Project Context

## Overview
InstaMap is a Chrome extension + backend system for collecting, organizing, and visualizing Instagram saved posts. It extracts metadata using Claude AI, stores data in Neo4j, and provides features like semantic search, map visualization, and category management.

## Tech Stack

### Extension (`/extension`)
- **Framework**: React 18 + TypeScript + Vite
- **Build**: `@crxjs/vite-plugin` for Chrome Manifest V3
- **Key Dependencies**: `react-leaflet` for maps, `leaflet.markercluster`
- **Build Command**: `cd extension && npm run build`
- **Output**: `extension/dist/` (load as unpacked extension in Chrome)

### Backend (`/backend`)
- **Framework**: Node.js + Express + TypeScript
- **Database**: Neo4j (graph + vector search)
- **AI**: Anthropic Claude (`claude-haiku-4-5-20251001`) for categorization, OpenAI for embeddings
- **Build Command**: `cd backend && npm run build`
- **Run Command**: `cd backend && npm run dev` (port 3001)

### External Services
- **Neo4j**: `bolt://localhost:7687` (user: neo4j, pass: password123)
- **Nominatim API**: Free geocoding (rate limited 1 req/sec, uses local cities.json first)

## Key Files

### Extension
| File | Purpose |
|------|---------|
| `src/content/instagram.ts` | Content script injected into Instagram. Handles API-based collection of saved posts |
| `src/dashboard/Dashboard.tsx` | Main dashboard UI - posts grid, pagination, filters, auto-categorize modal |
| `src/dashboard/MapView.tsx` | Leaflet map showing posts by location with country/city zoom levels |
| `src/dashboard/PostDetailModal.tsx` | Modal for viewing/editing post details, categories, extracted data |
| `src/dashboard/PostCard.tsx` | Individual post card component with sync/categorize status badges |
| `src/shared/api.ts` | API client for all backend communication |
| `src/shared/storage.ts` | Chrome storage utilities for local post caching |
| `src/shared/types.ts` | TypeScript interfaces (InstagramPost, Category, etc.) |
| `src/popup/Popup.tsx` | Extension popup with collection controls |
| `src/collector/collector.ts` | Dedicated collection window with API/scroll methods |

### Backend
| File | Purpose |
|------|---------|
| `src/services/claude.ts` | Claude API for extracting categories, location, venue, hashtags, event dates. Supports real-time batching and Anthropic Batch API |
| `src/services/neo4j.ts` | All Neo4j operations - posts, categories, embeddings, coordinates |
| `src/services/geocoding.ts` | Converts location strings to lat/lng. Uses local `cities.json` first, falls back to Nominatim API |
| `src/services/embeddings.ts` | OpenAI embeddings for semantic search |
| `src/routes/posts.ts` | Post endpoints - sync, categorize, geocode, batch status |
| `src/data/cities.json` | 200+ major cities with coordinates for instant geocoding |

## Key Features & State

### Instagram Collection
- Uses Instagram's internal GraphQL API (`/api/v1/feed/saved/posts/`)
- "InstaMap Ready" button on Instagram page → collects new posts only (stops at existing)
- Collector window offers "New Only" or "All Posts" modes
- Rate limiting with exponential backoff (starts 2s, max 60s)

### Auto-Categorization (Claude)
- **Real-time**: Processes in batches of 5, ~$0.0075/post
- **Background (Batch API)**: 50% cheaper, async processing
- Extracts: categories, location, venue, event date, hashtags
- Uses Claude tool use for structured JSON output
- Tracks `lastEditedBy: 'user' | 'claude'` for edit history

### Dashboard Features
- **Pagination**: 100/200/300/500/1000 per page
- **Filters**: Unsynced only, Uncategorized only
- **Selection**: Checkbox mode with Shift+click range select
- **Post Modal**: Full caption, category bubbles, extracted data with edit capability
- **Map View**: Country grouping when zoomed out, city grouping when zoomed in

### Data Flow
1. Collect posts from Instagram → save to Chrome storage
2. "Sync to Cloud" → saves to Neo4j + generates embeddings
3. "Auto-Categorize" → Claude extracts metadata → saves to Neo4j
4. "Geocode" → converts location text to lat/lng → enables map

## Common Tasks

### Adding a new extracted field
1. Add to `backend/src/types/index.ts` (InstagramPost interface)
2. Add to `extension/src/shared/types.ts` (same)
3. Update Claude tool schema in `backend/src/services/claude.ts`
4. Update `neo4jService.updatePostMetadata()` to save it
5. Update `PostDetailModal.tsx` to display/edit it

### Adding a new API endpoint
1. Add route in `backend/src/routes/posts.ts` (BEFORE `/:id` route to avoid catch-all)
2. Add client method in `extension/src/shared/api.ts`
3. Build both: `cd backend && npm run build && cd ../extension && npm run build`

### Debugging
- Backend logs: Check terminal running `npm run dev`
- Extension logs: Chrome DevTools → Console (on Instagram page or dashboard)
- Neo4j browser: `http://localhost:7474` (query data directly)

## Important Notes
- Routes like `/with-coordinates`, `/needs-geocoding` must be defined BEFORE `/:id` in Express
- Geocoding progress runs in background - frontend polls `/api/posts/geocode/status`
- Batch API jobs persist in localStorage (`instamap_active_batch`) to survive page reloads
- Posts are stored in Chrome storage AND Neo4j (cloud). Local = collected, Cloud = synced
- New posts prepend to list (newest first, matching Instagram order)
