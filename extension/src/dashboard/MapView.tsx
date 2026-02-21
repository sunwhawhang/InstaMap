import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.markercluster';
import { api, getProxyImageUrl } from '../shared/api';
import { InstagramPost, MentionedPlace } from '../shared/types';

// Create rainbow gradient marker for highlighted location
function createHighlightedMarker(): L.DivIcon {
  const size = 50;
  return L.divIcon({
    html: `
      <div style="
        width: ${size}px;
        height: ${size}px;
        border-radius: 50%;
        background: conic-gradient(
          from 0deg,
          #ff0000, #ff8000, #ffff00, #80ff00, #00ff00, #00ff80, 
          #00ffff, #0080ff, #0000ff, #8000ff, #ff00ff, #ff0080, #ff0000
        );
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 15px rgba(0,0,0,0.4);
        border: 4px solid white;
        animation: pulse 1.5s ease-in-out infinite;
      ">
        <div style="
          width: ${size - 20}px;
          height: ${size - 20}px;
          border-radius: 50%;
          background: white;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
        ">📍</div>
      </div>
      <style>
        @keyframes pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.1); }
        }
      </style>
    `,
    className: 'highlighted-marker-icon',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// A place on the map - links a MentionedPlace to its source post
interface MapPlace {
  place: MentionedPlace;
  post: InstagramPost;
}

// A post grouped with all its places within a location group
interface GroupedPostEntry {
  post: InstagramPost;
  places: MentionedPlace[];      // All places from this post in this location group
  primaryPlace: MentionedPlace;  // First place (for display)
}

// Deduplicate MapPlace[] by post ID, grouping all places per post
function groupPlacesByPost(mapPlaces: MapPlace[]): GroupedPostEntry[] {
  const postMap = new Map<string, { post: InstagramPost; places: MentionedPlace[] }>();

  for (const mp of mapPlaces) {
    const key = mp.post.id;
    if (!postMap.has(key)) {
      postMap.set(key, { post: mp.post, places: [] });
    }
    postMap.get(key)!.places.push(mp.place);
  }

  return Array.from(postMap.values()).map(entry => ({
    ...entry,
    primaryPlace: entry.places[0],
  }));
}

// Format venue display text with "+N more" suffix
function getDisplayVenue(entry: GroupedPostEntry): string {
  if (entry.places.length === 1) return entry.primaryPlace.venue;
  return `${entry.primaryPlace.venue} +${entry.places.length - 1} more`;
}

// Extract all places with coordinates from posts
function extractMapPlaces(posts: InstagramPost[]): MapPlace[] {
  const places: MapPlace[] = [];
  for (const post of posts) {
    if (post.mentionedPlaces) {
      for (const place of post.mentionedPlaces) {
        if (place.latitude !== undefined && place.longitude !== undefined) {
          places.push({ place, post });
        }
      }
    }
  }
  return places;
}

// Fix Leaflet default icon paths for bundlers
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// Check if a value is a placeholder/unknown value that shouldn't be displayed
function isValidValue(value: string | undefined | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '<unknown>' && !normalized.startsWith('<') && normalized !== 'unknown';
}

// Group places by location name (country or city based on zoom)
interface LocationGroup {
  lat: number;
  lng: number;
  places: MapPlace[];
  locationName: string;
  isCountry: boolean;
}

// Generate consistent colors for categories (copied from PostDetailModal)
function getCategoryColor(categoryName: string): string {
  const colors = [
    '#E1306C', // Instagram pink
    '#405DE6', // Instagram blue
    '#5851DB', // Purple
    '#833AB4', // Deep purple
    '#C13584', // Magenta
    '#FD1D1D', // Red
    '#F77737', // Orange
    '#FCAF45', // Yellow-orange
    '#58C322', // Green
    '#00A693', // Teal
    '#0095F6', // Light blue
    '#6C5CE7', // Violet
  ];

  let hash = 0;
  for (let i = 0; i < categoryName.length; i++) {
    hash = categoryName.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function LocationPopupContent({ 
  group, 
  onOpenPostPanel,
  onOpenListPanel,
}: { 
  group: LocationGroup;
  onOpenPostPanel: (post: InstagramPost, place: MentionedPlace, group: LocationGroup) => void;
  onOpenListPanel: (group: LocationGroup) => void;
}) {
  const map = useMap();
  const [selectedMapPlace, setSelectedMapPlace] = useState<MapPlace | null>(null);
  const [postCategories, setPostCategories] = useState<string[]>([]);
  const [isLoadingCategories, setIsLoadingCategories] = useState(false);
  const [visibleCount, setVisibleCount] = useState(12); // Start with 12, load more on demand

  // Deduplicate: group places by post within this location group
  const groupedEntries = useMemo(() => groupPlacesByPost(group.places), [group.places]);

  // Update popup position when content changes
  useEffect(() => {
    setTimeout(() => {
      map.eachLayer((layer) => {
        if ((layer as any).getPopup?.()?.isOpen?.()) {
          (layer as any).getPopup().update();
        }
      });
    }, 50);
  }, [selectedMapPlace, map]);

  const handlePlaceClick = async (e: React.MouseEvent, entry: GroupedPostEntry) => {
    e.preventDefault();
    e.stopPropagation(); // Prevent popup from closing
    setSelectedMapPlace({ post: entry.post, place: entry.primaryPlace });
    setIsLoadingCategories(true);
    try {
      const cats = await api.getPostCategories(entry.post.id);
      setPostCategories(cats.map(c => c.name));
    } catch (error) {
      console.error('Failed to load categories:', error);
      setPostCategories([]);
    } finally {
      setIsLoadingCategories(false);
    }
  };

  const handleBack = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation(); // Prevent popup from closing
    setSelectedMapPlace(null);
    // Note: Don't reset visibleCount here - user expects to see the same scroll position
  };

  if (selectedMapPlace) {
    const { place, post } = selectedMapPlace;
    return (
      <div
        style={{
          width: '400px',
          maxWidth: '100%',
          maxHeight: '500px',
          display: 'flex',
          flexDirection: 'column',
          boxSizing: 'border-box'
        }}
        onClick={(e) => e.stopPropagation()} // Extra safety
      >
        {/* Header with Back Button */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          marginBottom: '12px',
          paddingBottom: '8px',
          borderBottom: '1px solid #eee'
        }}>
          <button
            onClick={handleBack}
            style={{
              background: '#f0f0f0',
              border: 'none',
              borderRadius: '4px',
              color: 'var(--primary)',
              cursor: 'pointer',
              fontSize: '11px',
              fontWeight: 600,
              padding: '4px 8px',
              display: 'flex',
              alignItems: 'center',
              gap: '4px'
            }}
          >
            ← Back
          </button>
          <span style={{ fontSize: '13px', fontWeight: 600, color: '#333' }}>Place Detail</span>
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onOpenPostPanel(post, place, group);
            }}
            style={{
              marginLeft: 'auto',
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              border: 'none',
              borderRadius: '4px',
              color: 'white',
              cursor: 'pointer',
              fontSize: '11px',
              fontWeight: 600,
              padding: '4px 10px',
              display: 'flex',
              alignItems: 'center',
              gap: '4px'
            }}
          >
            More Details →
          </button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, paddingRight: '4px' }}>
          {/* Place Info Header */}
          <div style={{
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            color: 'white',
            padding: '12px',
            borderRadius: '8px',
            marginBottom: '12px'
          }}>
            <div style={{ fontSize: '16px', fontWeight: 600 }}>{place.venue}</div>
            <div style={{ fontSize: '13px', opacity: 0.9, marginTop: '4px' }}>📍 {place.location}</div>
            {place.handle && (
              <a
                href={`https://www.instagram.com/${place.handle.replace('@', '')}/`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'white', fontSize: '12px', opacity: 0.8 }}
              >
                {place.handle}
              </a>
            )}
            {place.metadata && (
              <div style={{ fontSize: '11px', marginTop: '6px', opacity: 0.85 }}>{place.metadata}</div>
            )}
          </div>

          {/* Image from source post */}
          <div style={{
            width: '100%',
            aspectRatio: '1',
            borderRadius: '8px',
            overflow: 'hidden',
            marginBottom: '12px',
            background: '#e0e0e0'
          }}>
            {post.imageExpired && !post.localImagePath ? (
              <div style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#9e9e9e',
                fontSize: '32px',
              }}>
                📷
                <span style={{ fontSize: '12px', marginTop: '6px' }}>Expired</span>
              </div>
            ) : (
              <img
                src={post.localImagePath
                  ? getProxyImageUrl(post.imageUrl, post.id)
                  : post.imageUrl}
                alt=""
                referrerPolicy="no-referrer"
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                onError={(e) => {
                  if (post.localImagePath) return;
                  const target = e.target as HTMLImageElement;
                  if (post.imageUrl && !target.dataset.triedProxy) {
                    target.dataset.triedProxy = 'true';
                    target.src = getProxyImageUrl(post.imageUrl, post.id);
                  }
                }}
              />
            )}
          </div>

          {/* Source Post Info */}
          <div style={{ marginBottom: '12px', overflowWrap: 'break-word' }}>
            <div style={{ fontSize: '11px', color: '#999', marginBottom: '4px' }}>From post by:</div>
            <div style={{ fontWeight: 600, fontSize: '14px' }}>@{post.ownerUsername || 'unknown'}</div>
            <a
              href={`https://www.instagram.com/p/${post.instagramId}/`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--primary)', fontSize: '12px', textDecoration: 'none', wordBreak: 'break-all' }}
            >
              View on Instagram →
            </a>
          </div>

          {/* Caption */}
          {post.caption && (
            <div style={{ marginBottom: '16px' }}>
              <p style={{
                margin: 0,
                fontSize: '13px',
                lineHeight: '1.4',
                color: '#333',
                whiteSpace: 'pre-wrap',
                maxHeight: '80px',
                overflowY: 'auto',
                background: '#f9f9f9',
                padding: '8px',
                borderRadius: '6px'
              }}>
                {post.caption}
              </p>
            </div>
          )}

          {/* Categories */}
          <div style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: '11px', color: '#999', marginBottom: '6px', fontWeight: 600, textTransform: 'uppercase' }}>Categories</div>
            {isLoadingCategories ? (
              <div style={{ fontSize: '12px', color: '#999' }}>Loading...</div>
            ) : postCategories.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                {postCategories.map(cat => (
                  <span
                    key={cat}
                    style={{
                      background: getCategoryColor(cat),
                      color: 'white',
                      padding: '2px 8px',
                      borderRadius: '10px',
                      fontSize: '11px',
                      fontWeight: 500
                    }}
                  >
                    {cat}
                  </span>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: '12px', color: '#999', fontStyle: 'italic' }}>No categories</div>
            )}
          </div>

          {/* Extracted Metadata */}
          <div style={{
            background: '#f5f5f5',
            padding: '10px',
            borderRadius: '8px',
            fontSize: '12px',
            overflowWrap: 'break-word'
          }}>
            {isValidValue(post.eventDate) && (
              <div style={{ marginBottom: '6px' }}>
                <span style={{ fontWeight: 600 }}>📅 Date:</span> {post.eventDate}
              </div>
            )}
            {post.hashtags && post.hashtags.length > 0 && (
              <div style={{ wordBreak: 'break-word' }}>
                <span style={{ fontWeight: 600 }}>#️⃣</span> {post.hashtags.map(tag => `#${tag}`).join(', ')}
              </div>
            )}
          </div>

          {/* Meta info */}
          <div style={{ fontSize: '11px', color: '#999', marginTop: '12px', padding: '0 4px' }}>
            <p style={{ margin: '2px 0' }}>Saved: {new Date(post.savedAt).toLocaleDateString()}</p>
            {post.timestamp && (
              <p style={{ margin: '2px 0' }}>Posted: {new Date(post.timestamp).toLocaleDateString()}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        width: '400px',
        maxWidth: '100%',
        maxHeight: '400px',
        overflowY: 'auto',
        boxSizing: 'border-box',
        padding: '4px'
      }}
      onClick={(e) => e.stopPropagation()} // Prevent popup from closing when clicking background
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '8px',
      }}>
        <h4 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>
          {group.isCountry ? '🌍' : '📍'} {group.locationName}
        </h4>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onOpenListPanel(group);
          }}
          style={{
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            border: 'none',
            borderRadius: '4px',
            color: 'white',
            cursor: 'pointer',
            fontSize: '11px',
            fontWeight: 500,
            padding: '4px 10px',
          }}
        >
          View in Panel →
        </button>
      </div>
      <p style={{ margin: '0 0 12px 0', color: '#666', fontSize: '13px' }}>
        {groupedEntries.length} post{groupedEntries.length !== 1 ? 's' : ''} · {group.places.length} place{group.places.length !== 1 ? 's' : ''}
      </p>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '6px',
      }}>
        {groupedEntries.slice(0, visibleCount).map((entry, idx) => (
          <button
            key={`${entry.post.id}-${idx}`}
            onClick={(e) => handlePlaceClick(e, entry)}
            style={{
              display: 'block',
              aspectRatio: '1',
              borderRadius: '6px',
              overflow: 'hidden',
              padding: 0,
              border: 'none',
              cursor: 'pointer',
              background: entry.post.imageExpired && !entry.post.localImagePath ? '#e0e0e0' : 'transparent',
              position: 'relative',
            }}
          >
            {entry.post.imageExpired && !entry.post.localImagePath ? (
              <div style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#9e9e9e',
                fontSize: '16px',
              }}>
                📷
                <span style={{ fontSize: '8px', marginTop: '2px' }}>Expired</span>
              </div>
            ) : (
              <>
                <img
                  src={entry.post.localImagePath
                    ? getProxyImageUrl(entry.post.imageUrl, entry.post.id)
                    : entry.post.imageUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                  }}
                  onError={(e) => {
                    if (entry.post.localImagePath) return;
                    const target = e.target as HTMLImageElement;
                    if (entry.post.imageUrl && !target.dataset.triedProxy) {
                      target.dataset.triedProxy = 'true';
                      target.src = getProxyImageUrl(entry.post.imageUrl, entry.post.id);
                    }
                  }}
                />
                {/* Places count badge */}
                {entry.places.length > 1 && (
                  <div style={{
                    position: 'absolute',
                    top: 3,
                    right: 3,
                    background: '#E1306C',
                    color: 'white',
                    borderRadius: '10px',
                    minWidth: '18px',
                    height: '18px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '10px',
                    fontWeight: 700,
                    padding: '0 4px',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                    zIndex: 1,
                  }}>
                    {entry.places.length}
                  </div>
                )}
                {/* Venue name overlay */}
                <div style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  background: 'linear-gradient(transparent, rgba(0,0,0,0.7))',
                  color: 'white',
                  fontSize: '9px',
                  padding: '12px 4px 4px',
                  textAlign: 'center',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {getDisplayVenue(entry)}
                </div>
              </>
            )}
          </button>
        ))}
      </div>
      {groupedEntries.length > visibleCount && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setVisibleCount(prev => Math.min(prev + 12, groupedEntries.length));
          }}
          style={{
            marginTop: '10px',
            width: '100%',
            padding: '8px 12px',
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: 500,
          }}
        >
          Load More ({groupedEntries.length - visibleCount} remaining)
        </button>
      )}
    </div>
  );
}

// Extract country from location string (e.g., "Paris, France" -> "France")
function extractCountry(location: string): string | null {
  if (!location) return null;
  const parts = location.split(',').map(p => p.trim());
  if (parts.length >= 2) {
    return parts[parts.length - 1];
  }
  return location.trim();
}

// Extract city from location string (e.g., "Belgravia, London, UK" -> "London")
function extractCity(location: string): string | null {
  if (!location) return null;
  const parts = location.split(',').map(p => p.trim());
  if (parts.length >= 2) {
    // Second to last is usually the city
    return parts[parts.length - 2] || parts[0];
  }
  return parts[0];
}

// Group places by country (zoom < 6)
function groupPlacesByCountry(places: MapPlace[]): Map<string, MapPlace[]> {
  const groups = new Map<string, MapPlace[]>();

  for (const mapPlace of places) {
    // Use normalizedCountry if available, fall back to extracting
    let country = mapPlace.place.normalizedCountry;
    if (!country) {
      country = extractCountry(mapPlace.place.location || '') || 'Unknown';
    }

    if (!groups.has(country)) {
      groups.set(country, []);
    }
    groups.get(country)!.push(mapPlace);
  }

  return groups;
}

// Group places by city (zoom 6-9) - e.g., all London places in one pin
function groupPlacesByCity(places: MapPlace[]): Map<string, MapPlace[]> {
  const groups = new Map<string, MapPlace[]>();

  for (const mapPlace of places) {
    // Use normalizedCity + normalizedCountry for grouping
    const city = mapPlace.place.normalizedCity;
    const country = mapPlace.place.normalizedCountry;

    let groupKey: string;

    if (city && country) {
      groupKey = `${city}, ${country}`;
    } else if (city) {
      groupKey = city;
    } else if (country) {
      // No city, just country (e.g., for country-level locations)
      groupKey = `${country} (country)`;
    } else {
      // Fall back to extracting from location
      const extractedCity = extractCity(mapPlace.place.location || '');
      const extractedCountry = extractCountry(mapPlace.place.location || '');
      if (extractedCity && extractedCountry) {
        groupKey = `${extractedCity}, ${extractedCountry}`;
      } else if (extractedCity) {
        groupKey = extractedCity;
      } else if (extractedCountry) {
        groupKey = `${extractedCountry} (country)`;
      } else {
        groupKey = mapPlace.place.location || 'Unknown';
      }
    }

    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey)!.push(mapPlace);
  }

  return groups;
}

// Group places by neighborhood (zoom >= 10) - e.g., Westminster, Belgravia as separate pins
function groupPlacesByNeighborhood(places: MapPlace[]): Map<string, MapPlace[]> {
  const groups = new Map<string, MapPlace[]>();

  for (const mapPlace of places) {
    const neighborhood = mapPlace.place.normalizedNeighborhood;
    const city = mapPlace.place.normalizedCity;
    const country = mapPlace.place.normalizedCountry;

    let groupKey: string;

    if (neighborhood && city && country) {
      groupKey = `${neighborhood}, ${city}, ${country}`;
    } else if (city && country) {
      groupKey = `${city}, ${country}`;
    } else {
      // Fall back to full location string
      groupKey = mapPlace.place.normalizedLocation || mapPlace.place.location || 'Unknown';
    }

    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey)!.push(mapPlace);
  }

  return groups;
}

// Calculate average coordinates for a group of places
function getAverageCoords(places: MapPlace[]): { lat: number; lng: number } {
  const validPlaces = places.filter(mp => mp.place.latitude !== undefined && mp.place.longitude !== undefined);
  if (validPlaces.length === 0) return { lat: 0, lng: 0 };

  const lat = validPlaces.reduce((sum, mp) => sum + (mp.place.latitude || 0), 0) / validPlaces.length;
  const lng = validPlaces.reduce((sum, mp) => sum + (mp.place.longitude || 0), 0) / validPlaces.length;

  return { lat, lng };
}

// Determine grouping level based on zoom
type GroupingLevel = 'country' | 'city' | 'neighborhood';

function getGroupingLevel(zoom: number): GroupingLevel {
  if (zoom < 6) return 'country';
  if (zoom < 10) return 'city';
  return 'neighborhood';
}

// Create location groups based on zoom level
function createLocationGroups(posts: InstagramPost[], zoom: number): LocationGroup[] {
  // First extract all places with coordinates from posts
  const allPlaces = extractMapPlaces(posts);

  const groupingLevel = getGroupingLevel(zoom);
  let groups: Map<string, MapPlace[]>;

  switch (groupingLevel) {
    case 'country':
      groups = groupPlacesByCountry(allPlaces);
      break;
    case 'city':
      groups = groupPlacesByCity(allPlaces);
      break;
    case 'neighborhood':
      groups = groupPlacesByNeighborhood(allPlaces);
      break;
  }

  // DEBUG: Log groups
  console.log(`[MapView] Zoom: ${zoom}, groupingLevel: ${groupingLevel}, total places: ${allPlaces.length}`);
  for (const [name, groupPlaces] of groups) {
    console.log(`  Group "${name}": ${groupPlaces.length} places`);
  }

  const result: LocationGroup[] = [];

  for (const [locationName, groupPlaces] of groups) {
    const coords = getAverageCoords(groupPlaces);
    if (coords.lat !== 0 || coords.lng !== 0) {
      const displayName = locationName;

      console.log(`  → Result: "${displayName}" at [${coords.lat.toFixed(2)}, ${coords.lng.toFixed(2)}] with ${groupPlaces.length} places`);

      result.push({
        lat: coords.lat,
        lng: coords.lng,
        places: groupPlaces,
        locationName: displayName,
        isCountry: groupingLevel === 'country',
      });
    }
  }

  return result;
}

// Create custom cluster icon
function createClusterIcon(count: number, isCountry: boolean): L.DivIcon {
  const size = Math.min(60, Math.max(40, 30 + Math.log10(count) * 15));
  const bgColor = isCountry ? '#E1306C' : '#405DE6';

  return L.divIcon({
    html: `
      <div style="
        width: ${size}px;
        height: ${size}px;
        border-radius: 50%;
        background: ${bgColor};
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: bold;
        font-size: ${size / 3}px;
        box-shadow: 0 3px 10px rgba(0,0,0,0.3);
        border: 3px solid white;
      ">
        ${count}
      </div>
    `,
    className: 'custom-cluster-icon',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// Component to track zoom and update markers
function ZoomTracker({ onZoomChange }: { onZoomChange: (zoom: number) => void }) {
  const map = useMapEvents({
    zoomend: () => {
      onZoomChange(map.getZoom());
    },
  });

  useEffect(() => {
    onZoomChange(map.getZoom());
  }, [map, onZoomChange]);

  return null;
}

// Component to fit map bounds to markers
function FitBounds({ groups }: { groups: LocationGroup[] }) {
  const map = useMap();

  useEffect(() => {
    if (groups.length === 0) return;

    const bounds = L.latLngBounds(groups.map(g => [g.lat, g.lng]));
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 10 });
  }, [groups.length > 0]); // Only fit on first load

  return null;
}

// Component to close all popups when panel is open or panel content changes
function PopupCloser({ isPanelOpen, panelGroupName }: { isPanelOpen: boolean; panelGroupName: string | null }) {
  const map = useMap();

  useEffect(() => {
    if (isPanelOpen) {
      map.closePopup();
    }
  }, [isPanelOpen, panelGroupName, map]);

  return null;
}

// Hamburger icon component
function HamburgerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

// Left panel component for showing list view and post details
function SidePanel({
  view,
  group,
  selectedMapPlace,
  categories,
  isLoading,
  isCollapsed,
  onToggleCollapse,
  onClose,
  onBackToList,
  onSelectPlace,
  onReGeocodePost,
}: {
  view: 'list' | 'detail';
  group: LocationGroup | null;
  selectedMapPlace: MapPlace | null;
  categories: string[];
  isLoading: boolean;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onClose: () => void;
  onBackToList: () => void;
  onSelectPlace: (mapPlace: MapPlace) => void;
  onReGeocodePost: (postId: string) => Promise<{ success: boolean; geocoded: number }>;
}) {
  const [showReasons, setShowReasons] = useState(false);
  const [placesExpanded, setPlacesExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(20);
  const [isReGeocoding, setIsReGeocoding] = useState(false);
  const [reGeocodeResult, setReGeocodeResult] = useState<string | null>(null);

  // Deduplicate: group places by post within this location group
  const groupedEntries = useMemo(
    () => (group ? groupPlacesByPost(group.places) : []),
    [group?.places]
  );

  // Reset visible count when group changes
  useEffect(() => {
    setVisibleCount(20);
  }, [group?.locationName]);

  if (isCollapsed) {
    return (
      <div style={{
        width: '48px',
        height: '100%',
        background: 'white',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: '12px',
        zIndex: 1000,
        boxShadow: '2px 0 8px rgba(0,0,0,0.1)',
      }}>
        <button
          onClick={onToggleCollapse}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: '#666',
            padding: '8px',
            borderRadius: '4px',
          }}
          title="Expand panel"
        >
          <HamburgerIcon />
        </button>
      </div>
    );
  }

  // Detail view - showing a specific post
  if (view === 'detail' && selectedMapPlace) {
    const { post, place } = selectedMapPlace;
    const hasLocalImage = !!post.localImagePath;
    const mentionedPlaces = post.mentionedPlaces || [];

    const hasBeenExtracted = !!(post.categoriesReason || post.mentionedPlacesReason ||
      post.hashtagsReason || post.eventDateReason || post.mentionsReason ||
      (post.mentionedPlaces && post.mentionedPlaces.length > 0));

    const hasReasons = post.eventDateReason || post.hashtagsReason ||
      post.categoriesReason || post.mentionsReason || post.mentionedPlacesReason;

    return (
      <div style={{
        width: '380px',
        height: '100%',
        background: 'white',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 1000,
        boxShadow: '2px 0 8px rgba(0,0,0,0.1)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          padding: '12px 16px',
          borderBottom: '1px solid #eee',
          background: 'white',
          gap: '8px',
        }}>
          <button
            onClick={onBackToList}
            style={{
              background: '#f0f0f0',
              border: 'none',
              borderRadius: '4px',
              color: 'var(--primary)',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: 600,
              padding: '6px 10px',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            ← Back
          </button>
          <h3 style={{ margin: 0, fontSize: '15px', flex: 1 }}>Post Details</h3>
          <button
            onClick={onToggleCollapse}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#666',
              padding: '4px',
            }}
            title="Collapse panel"
          >
            <HamburgerIcon />
          </button>
        </div>

        {/* Body - scrollable */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px',
        }}>
          {/* Selected Place Header */}
          <div style={{
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            color: 'white',
            padding: '12px',
            borderRadius: '8px',
            marginBottom: '16px',
          }}>
            <div style={{ fontSize: '15px', fontWeight: 600 }}>{place.venue}</div>
            <div style={{ fontSize: '12px', opacity: 0.9, marginTop: '4px' }}>📍 {place.location}</div>
            {place.handle && (
              <a
                href={`https://www.instagram.com/${place.handle.replace('@', '')}/`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'white', fontSize: '11px', opacity: 0.8 }}
              >
                {place.handle}
              </a>
            )}
          </div>

          {/* Image */}
          <div style={{
            width: '100%',
            aspectRatio: '1',
            borderRadius: '8px',
            overflow: 'hidden',
            marginBottom: '16px',
            background: '#e0e0e0',
          }}>
            {post.imageExpired && !hasLocalImage ? (
              <div style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#757575',
              }}>
                <span style={{ fontSize: '48px' }}>📷</span>
                <span style={{ fontSize: '14px' }}>Expired</span>
              </div>
            ) : (
              <img
                src={hasLocalImage
                  ? getProxyImageUrl(post.imageUrl, post.id)
                  : post.imageUrl}
                alt=""
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                }}
                onError={(e) => {
                  if (hasLocalImage) return;
                  const target = e.target as HTMLImageElement;
                  if (!target.dataset.triedProxy && post.imageUrl) {
                    target.dataset.triedProxy = 'true';
                    target.src = getProxyImageUrl(post.imageUrl, post.id);
                  }
                }}
              />
            )}
          </div>

          {/* Username and link */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '12px',
            flexWrap: 'wrap',
          }}>
            <span style={{ fontWeight: 600, fontSize: '14px' }}>@{post.ownerUsername || 'unknown'}</span>
            <a
              href={`https://www.instagram.com/p/${post.instagramId}/`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: 'var(--primary)',
                fontSize: '12px',
              }}
            >
              View on Instagram →
            </a>
          </div>

          {/* Caption */}
          <div style={{ marginBottom: '16px' }}>
            <h4 style={{ margin: '0 0 6px 0', fontSize: '13px', color: '#666' }}>Caption</h4>
            <p style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              lineHeight: 1.5,
              maxHeight: '120px',
              overflowY: 'auto',
              background: '#f9f9f9',
              padding: '10px',
              borderRadius: '8px',
              fontSize: '13px',
            }}>
              {post.caption || <em style={{ color: '#999' }}>No caption</em>}
            </p>
          </div>

          {/* Categories */}
          <div style={{ marginBottom: '16px' }}>
            <h4 style={{ margin: '0 0 6px 0', fontSize: '13px', color: '#666' }}>Categories</h4>
            {isLoading ? (
              <div style={{ fontSize: '12px', color: '#999' }}>Loading...</div>
            ) : categories.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {categories.map((cat) => (
                  <span
                    key={cat}
                    style={{
                      background: getCategoryColor(cat),
                      color: 'white',
                      padding: '4px 10px',
                      borderRadius: '16px',
                      fontSize: '12px',
                      fontWeight: 500,
                    }}
                  >
                    {cat}
                  </span>
                ))}
              </div>
            ) : (
              <p style={{ margin: 0, color: '#999', fontStyle: 'italic', fontSize: '13px' }}>
                Not categorized yet
              </p>
            )}
          </div>

          {/* Extracted Data */}
          <div style={{ marginBottom: '16px' }}>
            <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', color: '#666' }}>Extracted Data</h4>
            <div style={{
              background: '#f9f9f9',
              borderRadius: '8px',
              padding: '12px',
            }}>
              {/* Places */}
              <div style={{ marginBottom: '12px' }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '6px',
                }}>
                  <label style={{ fontSize: '12px', color: '#666' }}>
                    📍 Places {mentionedPlaces.length > 0 && `(${mentionedPlaces.length})`}
                  </label>
                  {mentionedPlaces.length > 3 && (
                    <button
                      onClick={() => setPlacesExpanded(!placesExpanded)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#1976d2',
                        fontSize: '11px',
                        cursor: 'pointer',
                        padding: '2px 4px',
                      }}
                    >
                      {placesExpanded ? 'Show less ▲' : 'Show all ▼'}
                    </button>
                  )}
                </div>
                {mentionedPlaces.length > 0 ? (
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    maxHeight: placesExpanded ? '200px' : 'none',
                    overflowY: placesExpanded ? 'auto' : 'visible',
                    background: '#fff8e1',
                    borderRadius: '6px',
                    padding: '8px',
                    border: '1px solid #ffcc80',
                  }}>
                    {(placesExpanded ? mentionedPlaces : mentionedPlaces.slice(0, 3)).map((p, i) => (
                      <div key={i} style={{ fontSize: '12px' }}>
                        <span style={{ fontWeight: 500 }}>{i + 1}. {p.venue}</span>
                        <span style={{ color: '#666', marginLeft: '4px' }}>• {p.location}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <span style={{ fontSize: '13px', color: '#999', fontStyle: 'italic' }}>None</span>
                )}
              </div>

              {/* Event Date */}
              {(post.eventDate || !hasBeenExtracted) && (
                <div style={{ marginBottom: '10px' }}>
                  <label style={{ fontSize: '12px', color: '#666', display: 'block', marginBottom: '2px' }}>
                    📅 Event Date
                  </label>
                  <span style={{ fontSize: '13px' }}>
                    {post.eventDate || <em style={{ color: '#999' }}>None</em>}
                  </span>
                </div>
              )}

              {/* Hashtags */}
              <div style={{ marginBottom: '10px' }}>
                <label style={{ fontSize: '12px', color: '#666', display: 'block', marginBottom: '2px' }}>
                  #️⃣ Hashtags
                </label>
                {post.hashtags && post.hashtags.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {post.hashtags.map((tag, i) => (
                      <span
                        key={i}
                        style={{
                          background: '#e0e0e0',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          fontSize: '11px',
                        }}
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span style={{ fontSize: '13px', color: '#999', fontStyle: 'italic' }}>None</span>
                )}
              </div>

              {/* Mentions */}
              <div>
                <label style={{ fontSize: '12px', color: '#666', display: 'block', marginBottom: '2px' }}>
                  🏷️ Featured Accounts
                </label>
                {post.mentions && post.mentions.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {post.mentions.map((mention, i) => (
                      <a
                        key={i}
                        href={`https://instagram.com/${mention.replace('@', '')}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          background: '#e3f2fd',
                          color: '#1976d2',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          fontSize: '11px',
                          textDecoration: 'none',
                        }}
                      >
                        {mention.startsWith('@') ? mention : `@${mention}`}
                      </a>
                    ))}
                  </div>
                ) : (
                  <span style={{ fontSize: '13px', color: '#999', fontStyle: 'italic' }}>None</span>
                )}
              </div>
            </div>
          </div>

          {/* AI Reasoning */}
          {hasReasons && (
            <div style={{ marginBottom: '16px' }}>
              <button
                onClick={() => setShowReasons(!showReasons)}
                style={{
                  background: 'none',
                  border: '1px solid #ddd',
                  padding: '8px 12px',
                  borderRadius: '8px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  color: '#666',
                }}
              >
                <span>🤖 AI Reasoning</span>
                <span>{showReasons ? '▲' : '▼'}</span>
              </button>

              {showReasons && (
                <div style={{
                  marginTop: '8px',
                  padding: '10px',
                  background: '#f5f5f5',
                  borderRadius: '8px',
                  fontSize: '11px',
                  fontFamily: 'monospace',
                  whiteSpace: 'pre-wrap',
                  maxHeight: '200px',
                  overflow: 'auto',
                }}>
                  {JSON.stringify({
                    mentionedPlaces: {
                      count: post.mentionedPlaces?.length || 0,
                      reason: post.mentionedPlacesReason || 'No reason provided',
                    },
                    mentions: {
                      value: post.mentions || [],
                      reason: post.mentionsReason || 'No reason provided',
                    },
                    eventDate: {
                      value: post.eventDate || null,
                      reason: post.eventDateReason || 'No reason provided',
                    },
                    hashtags: {
                      value: post.hashtags || [],
                      reason: post.hashtagsReason || 'No reason provided',
                    },
                    categories: {
                      value: categories,
                      reason: post.categoriesReason || 'No reason provided',
                    },
                  }, null, 2)}
                </div>
              )}
            </div>
          )}

          {/* Re-geocode this post */}
          <button
            onClick={async () => {
              setIsReGeocoding(true);
              setReGeocodeResult(null);
              try {
                const result = await onReGeocodePost(post.id);
                setReGeocodeResult(result.success
                  ? `✅ Re-geocoded ${result.geocoded} place${result.geocoded !== 1 ? 's' : ''}`
                  : '❌ Failed');
              } catch (error) {
                setReGeocodeResult('❌ Failed to re-geocode');
              } finally {
                setIsReGeocoding(false);
                setTimeout(() => setReGeocodeResult(null), 5000);
              }
            }}
            disabled={isReGeocoding}
            style={{
              width: '100%',
              padding: '8px 12px',
              background: isReGeocoding ? '#e0e0e0' : '#f5f5f5',
              border: '1px solid #ddd',
              borderRadius: '8px',
              cursor: isReGeocoding ? 'not-allowed' : 'pointer',
              fontSize: '12px',
              fontWeight: 500,
              color: '#555',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              marginBottom: '12px',
            }}
          >
            {isReGeocoding ? '⏳ Re-geocoding...' : '🔄 Re-geocode this post'}
          </button>
          {reGeocodeResult && (
            <div style={{
              fontSize: '12px',
              marginBottom: '8px',
              padding: '6px 10px',
              borderRadius: '6px',
              background: reGeocodeResult.includes('✅') ? '#e8f5e9' : '#ffebee',
              color: reGeocodeResult.includes('✅') ? '#2e7d32' : '#c62828',
            }}>
              {reGeocodeResult}
            </div>
          )}

          {/* Meta info */}
          <div style={{ fontSize: '11px', color: '#999' }}>
            <p style={{ margin: '4px 0' }}>Saved: {new Date(post.savedAt).toLocaleString()}</p>
            {post.timestamp && (
              <p style={{ margin: '4px 0' }}>Posted: {new Date(post.timestamp).toLocaleString()}</p>
            )}
            {post.lastEditedBy && post.lastEditedAt && (
              <p style={{
                margin: '8px 0 4px 0',
                padding: '4px 8px',
                background: post.lastEditedBy === 'user' ? '#e3f2fd' : '#f3e5f5',
                borderRadius: '4px',
                display: 'inline-block',
              }}>
                {post.lastEditedBy === 'user' ? '✏️ Manually edited' : '🤖 AI extracted'} on {new Date(post.lastEditedAt).toLocaleString()}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // List view - showing places in a group
  return (
    <div style={{
      width: '380px',
      height: '100%',
      background: 'white',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 1000,
      boxShadow: '2px 0 8px rgba(0,0,0,0.1)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: '12px 16px',
        borderBottom: '1px solid #eee',
        background: 'white',
        gap: '8px',
      }}>
        <button
          onClick={onClose}
          style={{
            background: '#f0f0f0',
            border: 'none',
            borderRadius: '4px',
            color: '#666',
            cursor: 'pointer',
            fontSize: '18px',
            padding: '4px 8px',
            lineHeight: 1,
          }}
          title="Close panel"
        >
          ×
        </button>
        <h3 style={{ margin: 0, fontSize: '15px', flex: 1 }}>
          {group?.isCountry ? '🌍' : '📍'} {group?.locationName || 'Places'}
        </h3>
        <button
          onClick={onToggleCollapse}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: '#666',
            padding: '4px',
          }}
          title="Collapse panel"
        >
          <HamburgerIcon />
        </button>
      </div>

      {/* Places count */}
      {group && (
        <div style={{
          padding: '12px 16px',
          borderBottom: '1px solid #eee',
          color: '#666',
          fontSize: '13px',
        }}>
          {groupedEntries.length} post{groupedEntries.length !== 1 ? 's' : ''} · {group.places.length} place{group.places.length !== 1 ? 's' : ''} in this location
        </div>
      )}

      {/* Body - scrollable list of posts */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '12px',
      }}>
        {group ? (
          <>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: '8px',
            }}>
              {groupedEntries.slice(0, visibleCount).map((entry, idx) => (
                <button
                  key={`${entry.post.id}-${idx}`}
                  onClick={() => onSelectPlace({ post: entry.post, place: entry.primaryPlace })}
                  style={{
                    display: 'block',
                    aspectRatio: '1',
                    borderRadius: '8px',
                    overflow: 'hidden',
                    padding: 0,
                    border: 'none',
                    cursor: 'pointer',
                    background: entry.post.imageExpired && !entry.post.localImagePath ? '#e0e0e0' : 'transparent',
                    position: 'relative',
                  }}
                >
                  {entry.post.imageExpired && !entry.post.localImagePath ? (
                    <div style={{
                      width: '100%',
                      height: '100%',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#9e9e9e',
                      fontSize: '24px',
                    }}>
                      📷
                      <span style={{ fontSize: '10px', marginTop: '4px' }}>Expired</span>
                    </div>
                  ) : (
                    <>
                      <img
                        src={entry.post.localImagePath
                          ? getProxyImageUrl(entry.post.imageUrl, entry.post.id)
                          : entry.post.imageUrl}
                        alt=""
                        referrerPolicy="no-referrer"
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                        }}
                        onError={(e) => {
                          if (entry.post.localImagePath) return;
                          const target = e.target as HTMLImageElement;
                          if (entry.post.imageUrl && !target.dataset.triedProxy) {
                            target.dataset.triedProxy = 'true';
                            target.src = getProxyImageUrl(entry.post.imageUrl, entry.post.id);
                          }
                        }}
                      />
                      {/* Places count badge */}
                      {entry.places.length > 1 && (
                        <div style={{
                          position: 'absolute',
                          top: 4,
                          right: 4,
                          background: '#E1306C',
                          color: 'white',
                          borderRadius: '10px',
                          minWidth: '20px',
                          height: '20px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '11px',
                          fontWeight: 700,
                          padding: '0 5px',
                          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                          zIndex: 1,
                        }}>
                          {entry.places.length}
                        </div>
                      )}
                      {/* Venue name overlay */}
                      <div style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        background: 'linear-gradient(transparent, rgba(0,0,0,0.8))',
                        color: 'white',
                        fontSize: '11px',
                        padding: '20px 6px 6px',
                        textAlign: 'center',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {getDisplayVenue(entry)}
                      </div>
                    </>
                  )}
                </button>
              ))}
            </div>
            {groupedEntries.length > visibleCount && (
              <button
                onClick={() => setVisibleCount(prev => Math.min(prev + 20, groupedEntries.length))}
                style={{
                  marginTop: '12px',
                  width: '100%',
                  padding: '10px 12px',
                  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  color: 'white',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: 500,
                }}
              >
                Load More ({groupedEntries.length - visibleCount} remaining)
              </button>
            )}
          </>
        ) : (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: '#999',
          }}>
            <span style={{ fontSize: '32px', marginBottom: '8px' }}>📍</span>
            <p style={{ margin: 0, fontSize: '14px' }}>Click a marker on the map to view places</p>
          </div>
        )}
      </div>
    </div>
  );
}

interface MapViewProps {
  backendConnected: boolean;
}

export function MapView({ backendConnected }: MapViewProps) {
  const [posts, setPosts] = useState<InstagramPost[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isGeocoding, setIsGeocoding] = useState(false);
  const [needsGeocoding, setNeedsGeocoding] = useState(0);
  const [geocodeMessage, setGeocodeMessage] = useState<string | null>(null);
  const [zoom, setZoom] = useState(3);

  // Provider selection state
  const [availableProviders, setAvailableProviders] = useState<{ mapbox: boolean; google: boolean }>({ mapbox: false, google: false });
  const [showProviderModal, setShowProviderModal] = useState(false);

  // Left panel state
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isPanelCollapsed, setIsPanelCollapsed] = useState(false);
  const [panelView, setPanelView] = useState<'list' | 'detail'>('list');
  const [panelGroup, setPanelGroup] = useState<LocationGroup | null>(null);
  const [panelMapPlace, setPanelMapPlace] = useState<MapPlace | null>(null);
  const [panelCategories, setPanelCategories] = useState<string[]>([]);
  const [isPanelLoading, setIsPanelLoading] = useState(false);

  // Open panel with detail view for a specific post
  const openPostPanel = useCallback(async (post: InstagramPost, place: MentionedPlace, group: LocationGroup) => {
    setIsPanelOpen(true);
    setIsPanelCollapsed(false);
    setPanelView('detail');
    setPanelGroup(group);
    setPanelMapPlace({ post, place });
    setIsPanelLoading(true);
    try {
      const cats = await api.getPostCategories(post.id);
      setPanelCategories(cats.map(c => c.name));
    } catch (error) {
      console.error('Failed to load categories:', error);
      setPanelCategories([]);
    } finally {
      setIsPanelLoading(false);
    }
  }, []);

  // Open panel with list view for a location group
  const openListPanel = useCallback((group: LocationGroup) => {
    setIsPanelOpen(true);
    setIsPanelCollapsed(false);
    setPanelView('list');
    setPanelGroup(group);
    setPanelMapPlace(null);
    setPanelCategories([]);
  }, []);

  // Clear selection and close panel (used by X button in panel)
  const clearAndClosePanel = useCallback(() => {
    setIsPanelOpen(false);
    setPanelView('list');
    setPanelGroup(null);
    setPanelMapPlace(null);
    setPanelCategories([]);
  }, []);

  // Go back from detail to list view
  const goBackToList = useCallback(() => {
    setPanelView('list');
    setPanelMapPlace(null);
    setPanelCategories([]);
  }, []);

  // Select a place from the list to view details
  const selectPlace = useCallback(async (mapPlace: MapPlace) => {
    setPanelView('detail');
    setPanelMapPlace(mapPlace);
    setIsPanelLoading(true);
    try {
      const cats = await api.getPostCategories(mapPlace.post.id);
      setPanelCategories(cats.map(c => c.name));
    } catch (error) {
      console.error('Failed to load categories:', error);
      setPanelCategories([]);
    } finally {
      setIsPanelLoading(false);
    }
  }, []);

  // Toggle panel open/closed from header button (preserves selection)
  const togglePanel = useCallback(() => {
    if (isPanelOpen) {
      setIsPanelOpen(false);
      // Preserve selection when closing via toggle
    } else {
      setIsPanelOpen(true);
      setIsPanelCollapsed(false);
      // Don't reset panelView/panelGroup - restore previous state
    }
  }, [isPanelOpen]);

  // Refs to store current callbacks for use in Leaflet popups
  const openPostPanelRef = useRef(openPostPanel);
  const openListPanelRef = useRef(openListPanel);
  
  // Keep refs updated
  useEffect(() => {
    openPostPanelRef.current = openPostPanel;
    openListPanelRef.current = openListPanel;
  }, [openPostPanel, openListPanel]);
  
  // Stable callbacks that read from refs (for Leaflet popups)
  const stableOpenPostPanel = useCallback((post: InstagramPost, place: MentionedPlace, group: LocationGroup) => {
    openPostPanelRef.current(post, place, group);
  }, []);
  
  const stableOpenListPanel = useCallback((group: LocationGroup) => {
    openListPanelRef.current(group);
  }, []);

  // Load posts with coordinates
  async function loadMapData() {
    if (!backendConnected) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      // Get posts with coordinates
      const { posts: mapPosts } = await api.getPostsWithCoordinates();
      setPosts(mapPosts);

      // Check how many need geocoding
      const { count } = await api.getPostsNeedingGeocoding();
      setNeedsGeocoding(count);

      // Check available providers
      const providers = await api.getGeocodingProviders();
      setAvailableProviders(providers);
    } catch (error) {
      console.error('Failed to load map data:', error);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadMapData();
  }, [backendConnected]);

  // Handle geocoding with progress polling
  async function handleGeocode(provider: 'mapbox' | 'google') {
    setShowProviderModal(false);
    setIsGeocoding(true);
    setGeocodeMessage(`Starting geocoding with ${provider}...`);

    try {
      // Start geocoding with selected provider
      await api.geocodePlaces(provider);

      // Poll for progress
      const pollInterval = setInterval(async () => {
        try {
          const status = await api.getGeocodePlacesStatus();

          if (status.status === 'running') {
            const percent = Math.round((status.processed / status.total) * 100);
            setGeocodeMessage(
              `⏳ ${status.processed}/${status.total} (${percent}%)` +
              (status.currentLocation ? ` | ${status.currentLocation}` : '')
            );
          } else if (status.status === 'done') {
            clearInterval(pollInterval);
            setGeocodeMessage(`✅ Done! ${status.geocoded} geocoded, ${status.failed} failed`);
            setIsGeocoding(false);
            // Reload map data
            await loadMapData();
            setTimeout(() => setGeocodeMessage(null), 10000);
          }
        } catch (error) {
          console.error('Failed to get geocode status:', error);
        }
      }, 500);

    } catch (error) {
      console.error('Geocoding failed:', error);
      setGeocodeMessage('❌ Geocoding failed');
      setIsGeocoding(false);
      setTimeout(() => setGeocodeMessage(null), 5000);
    }
  }

  // Show provider selection modal
  function openProviderModal() {
    if (!availableProviders.mapbox && !availableProviders.google) {
      setGeocodeMessage('❌ No geocoding providers configured. Add MAPBOX_ACCESS_TOKEN or GOOGLE_PLACES_API_KEY to backend .env');
      setTimeout(() => setGeocodeMessage(null), 5000);
      return;
    }
    // If only one provider available, use it directly
    if (availableProviders.mapbox && !availableProviders.google) {
      handleGeocode('mapbox');
      return;
    }
    if (availableProviders.google && !availableProviders.mapbox) {
      handleGeocode('google');
      return;
    }
    // Both available - show modal
    setShowProviderModal(true);
  }

  // Re-geocode ALL posts (force-bypasses cache)
  async function handleReGeocodeAll() {
    if (!availableProviders.mapbox && !availableProviders.google) {
      setGeocodeMessage('❌ No geocoding providers configured');
      setTimeout(() => setGeocodeMessage(null), 5000);
      return;
    }

    const provider = availableProviders.google ? 'google' : 'mapbox';
    setIsGeocoding(true);
    setGeocodeMessage(`🔄 Starting re-geocode with ${provider}...`);

    try {
      await api.runGeocodingMigration(provider, true);

      const pollInterval = setInterval(async () => {
        try {
          const status = await api.getGeocodingMigrationStatus();
          if (status.status === 'running') {
            const percent = status.total > 0 ? Math.round((status.processed / status.total) * 100) : 0;
            setGeocodeMessage(`🔄 Re-geocoding: ${status.processed}/${status.total} (${percent}%)`);
          } else if (status.status === 'done') {
            clearInterval(pollInterval);
            setGeocodeMessage(`✅ Re-geocoded ${status.updated} places (${status.skipped} skipped)`);
            setIsGeocoding(false);
            await loadMapData();
            setTimeout(() => setGeocodeMessage(null), 10000);
          }
        } catch (error) {
          console.error('Failed to get re-geocode status:', error);
        }
      }, 1000);
    } catch (error) {
      console.error('Re-geocoding failed:', error);
      setGeocodeMessage('❌ Re-geocoding failed');
      setIsGeocoding(false);
      setTimeout(() => setGeocodeMessage(null), 5000);
    }
  }

  // Re-geocode a single post (called from SidePanel)
  const handleReGeocodePost = useCallback(async (postId: string) => {
    const provider = availableProviders.google ? 'google' : 'mapbox';
    const result = await api.reGeocodePost(postId, provider);

    if (result.success && result.post) {
      // Update the panel's post data with re-geocoded result
      if (panelMapPlace && panelMapPlace.post.id === postId) {
        const updatedPlace = result.post.mentionedPlaces?.[0] || panelMapPlace.place;
        setPanelMapPlace({ post: result.post, place: updatedPlace });
      }
      // Reload map data to reflect new coordinates
      await loadMapData();
    }

    return result;
  }, [availableProviders, panelMapPlace]);

  // Handle zoom change
  const handleZoomChange = useCallback((newZoom: number) => {
    setZoom(newZoom);
  }, []);

  // Create location groups based on zoom level
  const locationGroups = useMemo(() => createLocationGroups(posts, zoom), [posts, zoom]);

  if (!backendConnected) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">🗺️</div>
        <h3>Backend not connected</h3>
        <p>Connect to the backend to view posts on the map.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">⏳</div>
        <h3>Loading map...</h3>
      </div>
    );
  }

  return (
    <div className="map-view">
      {/* Header with stats and geocode button */}
      <div className="map-header" style={{
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        marginBottom: '16px',
        flexWrap: 'wrap',
      }}>
        {/* Panel toggle button */}
        <button
          onClick={togglePanel}
          style={{
            background: isPanelOpen ? 'var(--primary)' : '#f0f0f0',
            color: isPanelOpen ? 'white' : '#333',
            border: 'none',
            borderRadius: '8px',
            padding: '8px 14px',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            transition: 'all 0.2s',
          }}
          title={isPanelOpen ? 'Close places panel' : 'Open places panel'}
        >
          <span style={{ fontSize: '16px' }}>☰</span>
          {isPanelOpen ? 'Close Panel' : 'Places Panel'}
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '24px' }}>📍</span>
          <span style={{ fontWeight: 600 }}>
            {posts.length} posts on map
          </span>
          <span style={{ color: 'var(--text-muted)' }}>
            ({locationGroups.length} {zoom < 6 ? 'countries' : 'locations'})
          </span>
        </div>

        {needsGeocoding > 0 && (
          <button
            className="btn btn-primary"
            onClick={openProviderModal}
            disabled={isGeocoding}
            style={{ marginLeft: 'auto' }}
          >
            {isGeocoding ? '⏳ Geocoding...' : `🌍 Geocode ${needsGeocoding} posts`}
          </button>
        )}

        {/* Re-geocode all button (visible when posts exist on map) */}
        {posts.length > 0 && (
          <button
            className="btn"
            onClick={handleReGeocodeAll}
            disabled={isGeocoding}
            style={{
              marginLeft: needsGeocoding > 0 ? '0' : 'auto',
              background: '#f0f0f0',
              color: '#333',
              fontSize: '13px',
            }}
            title="Force re-geocode all posts (bypasses cache)"
          >
            🔄 Re-geocode All
          </button>
        )}

        {/* Provider Selection Modal */}
        {showProviderModal && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
          }} onClick={() => setShowProviderModal(false)}>
            <div style={{
              background: 'white',
              borderRadius: '12px',
              padding: '24px',
              maxWidth: '400px',
              width: '90%',
            }} onClick={e => e.stopPropagation()}>
              <h3 style={{ margin: '0 0 16px 0' }}>Choose Geocoding Provider</h3>
              <p style={{ color: '#666', fontSize: '14px', marginBottom: '20px' }}>
                Select which service to use for geocoding locations.
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {availableProviders.google && (
                  <button
                    className="btn btn-primary"
                    onClick={() => handleGeocode('google')}
                    style={{ padding: '12px', fontSize: '14px' }}
                  >
                    🔍 Google Places
                    <span style={{ display: 'block', fontSize: '11px', opacity: 0.8, marginTop: '4px' }}>
                      More accurate, especially for neighborhoods
                    </span>
                  </button>
                )}

                {availableProviders.mapbox && (
                  <button
                    className="btn"
                    onClick={() => handleGeocode('mapbox')}
                    style={{ padding: '12px', fontSize: '14px', background: '#f0f0f0', color: '#333' }}
                  >
                    🗺️ Mapbox
                    <span style={{ display: 'block', fontSize: '11px', opacity: 0.8, marginTop: '4px' }}>
                      Good for city-level geocoding
                    </span>
                  </button>
                )}
              </div>

              <button
                onClick={() => setShowProviderModal(false)}
                style={{
                  marginTop: '16px',
                  width: '100%',
                  padding: '8px',
                  background: 'transparent',
                  border: '1px solid #ddd',
                  borderRadius: '6px',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {geocodeMessage && (
          <span style={{
            padding: '8px 12px',
            borderRadius: '8px',
            background: geocodeMessage.includes('✅') ? 'var(--success)' :
              geocodeMessage.includes('❌') ? 'var(--error)' : 'var(--primary)',
            color: 'white',
            fontSize: '13px',
          }}>
            {geocodeMessage}
          </span>
        )}
      </div>

      {/* Zoom level indicator */}
      <div style={{
        marginBottom: '12px',
        fontSize: '13px',
        color: 'var(--text-muted)',
      }}>
        {zoom < 6 ? '🌍 Country view' : zoom < 10 ? '🏙️ City view' : '📍 Neighborhood view'} (zoom: {zoom})
        {zoom < 6 && <span> — Zoom in to see cities</span>}
        {zoom >= 6 && zoom < 10 && <span> — Zoom in more to see neighborhoods</span>}
      </div>

      {posts.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">🗺️</div>
          <h3>No posts with locations</h3>
          <p>
            {needsGeocoding > 0
              ? `${needsGeocoding} posts have locations but need geocoding. Click the button above to add them to the map.`
              : 'Auto-categorize posts to extract location data, then geocode them to see them on the map.'}
          </p>
        </div>
      ) : (
        <div style={{
          height: 'calc(100vh - 250px)',
          minHeight: '400px',
          borderRadius: '12px',
          overflow: 'hidden',
          border: '1px solid var(--border)',
          display: 'flex',
          position: 'relative',
        }}>
          {/* Left Panel */}
          {isPanelOpen && (
            <SidePanel
              view={panelView}
              group={panelGroup}
              selectedMapPlace={panelMapPlace}
              categories={panelCategories}
              isLoading={isPanelLoading}
              isCollapsed={isPanelCollapsed}
              onToggleCollapse={() => setIsPanelCollapsed(!isPanelCollapsed)}
              onClose={clearAndClosePanel}
              onBackToList={goBackToList}
              onSelectPlace={selectPlace}
              onReGeocodePost={handleReGeocodePost}
            />
          )}

          <MapContainer
            center={[20, 0]}
            zoom={3}
            style={{ height: '100%', flex: 1 }}
            scrollWheelZoom={true}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <ZoomTracker onZoomChange={handleZoomChange} />
            <FitBounds groups={locationGroups} />
            <PopupCloser isPanelOpen={isPanelOpen} panelGroupName={panelGroup?.locationName ?? null} />

            {locationGroups.map((group, index) => (
              <Marker
                key={`${group.locationName}-${index}`}
                position={[group.lat, group.lng]}
                icon={createClusterIcon(group.places.length, group.isCountry)}
                eventHandlers={{
                  click: () => {
                    // When panel is open, update it with this location's places
                    if (isPanelOpen) {
                      stableOpenListPanel(group);
                    }
                  }
                }}
              >
                <Popup maxWidth={450} minWidth={350}>
                  <LocationPopupContent 
                    group={group} 
                    onOpenPostPanel={stableOpenPostPanel}
                    onOpenListPanel={stableOpenListPanel}
                  />
                </Popup>
              </Marker>
            ))}

            {/* Show rainbow marker for selected location */}
            {/* In list view: show at group's location */}
            {isPanelOpen && panelView === 'list' && panelGroup && (
              <Marker
                key="highlighted-group"
                position={[panelGroup.lat, panelGroup.lng]}
                icon={createHighlightedMarker()}
                zIndexOffset={1000}
              />
            )}
            {/* In detail view: show at the specific place's location */}
            {isPanelOpen && panelView === 'detail' && panelMapPlace && panelMapPlace.place.latitude && panelMapPlace.place.longitude && (
              <Marker
                key="highlighted-place"
                position={[panelMapPlace.place.latitude, panelMapPlace.place.longitude]}
                icon={createHighlightedMarker()}
                zIndexOffset={1000}
              />
            )}
          </MapContainer>
        </div>
      )}
    </div>
  );
}
