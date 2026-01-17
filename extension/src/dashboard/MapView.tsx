import { useState, useEffect, useMemo, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.markercluster';
import { api, getProxyImageUrl } from '../shared/api';
import { InstagramPost, MentionedPlace } from '../shared/types';

// A place on the map - links a MentionedPlace to its source post
interface MapPlace {
  place: MentionedPlace;
  post: InstagramPost;
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

function LocationPopupContent({ group }: { group: LocationGroup }) {
  const map = useMap();
  const [selectedMapPlace, setSelectedMapPlace] = useState<MapPlace | null>(null);
  const [postCategories, setPostCategories] = useState<string[]>([]);
  const [isLoadingCategories, setIsLoadingCategories] = useState(false);
  const [visibleCount, setVisibleCount] = useState(12); // Start with 12, load more on demand

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

  const handlePlaceClick = async (e: React.MouseEvent, mapPlace: MapPlace) => {
    e.preventDefault();
    e.stopPropagation(); // Prevent popup from closing
    setSelectedMapPlace(mapPlace);
    setIsLoadingCategories(true);
    try {
      const cats = await api.getPostCategories(mapPlace.post.id);
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
      <h4 style={{ margin: '0 0 8px 0', fontSize: '15px', fontWeight: 600 }}>
        {group.isCountry ? '🌍' : '📍'} {group.locationName}
      </h4>
      <p style={{ margin: '0 0 12px 0', color: '#666', fontSize: '13px' }}>
        {group.places.length} place{group.places.length !== 1 ? 's' : ''}
      </p>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '6px',
      }}>
        {group.places.slice(0, visibleCount).map((mapPlace, idx) => (
          <button
            key={`${mapPlace.post.id}-${mapPlace.place.venue}-${idx}`}
            onClick={(e) => handlePlaceClick(e, mapPlace)}
            style={{
              display: 'block',
              aspectRatio: '1',
              borderRadius: '6px',
              overflow: 'hidden',
              padding: 0,
              border: 'none',
              cursor: 'pointer',
              background: mapPlace.post.imageExpired && !mapPlace.post.localImagePath ? '#e0e0e0' : 'transparent',
              position: 'relative',
            }}
          >
            {mapPlace.post.imageExpired && !mapPlace.post.localImagePath ? (
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
                  src={mapPlace.post.localImagePath
                    ? getProxyImageUrl(mapPlace.post.imageUrl, mapPlace.post.id)
                    : mapPlace.post.imageUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                  }}
                  onError={(e) => {
                    if (mapPlace.post.localImagePath) return;
                    const target = e.target as HTMLImageElement;
                    if (mapPlace.post.imageUrl && !target.dataset.triedProxy) {
                      target.dataset.triedProxy = 'true';
                      target.src = getProxyImageUrl(mapPlace.post.imageUrl, mapPlace.post.id);
                    }
                  }}
                />
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
                  {mapPlace.place.venue}
                </div>
              </>
            )}
          </button>
        ))}
      </div>
      {group.places.length > visibleCount && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setVisibleCount(prev => Math.min(prev + 12, group.places.length));
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
          Load More ({group.places.length - visibleCount} remaining)
        </button>
      )}
    </div>
  );
}

// Check if a location string is country-only (no city specified)
function isCountryOnly(location: string): boolean {
  if (!location) return false;
  // If there's no comma, it's likely a country-only location
  return !location.includes(',');
}

// Extract country from location string (e.g., "Paris, France" -> "France")
function extractCountry(location: string): string | null {
  if (!location) return null;
  const parts = location.split(',').map(p => p.trim());
  if (parts.length >= 2) {
    return parts[parts.length - 1];
  }
  // Single word is the country itself
  return location.trim();
}

// Group places by country
function groupPlacesByCountry(places: MapPlace[]): Map<string, MapPlace[]> {
  const groups = new Map<string, MapPlace[]>();

  for (const mapPlace of places) {
    const country = extractCountry(mapPlace.place.location || '') || 'Unknown';
    if (!groups.has(country)) {
      groups.set(country, []);
    }
    groups.get(country)!.push(mapPlace);
  }

  return groups;
}

// Group places by city/exact location
function groupPlacesByCity(places: MapPlace[]): Map<string, MapPlace[]> {
  const groups = new Map<string, MapPlace[]>();

  for (const mapPlace of places) {
    let groupKey: string;
    const location = mapPlace.place.location;

    if (!location || location === 'Unknown') {
      groupKey = 'Unknown';
    } else if (isCountryOnly(location)) {
      groupKey = `${location} (country)`;
    } else {
      groupKey = location;
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

// Create location groups based on zoom level
function createLocationGroups(posts: InstagramPost[], zoom: number): LocationGroup[] {
  // First extract all places with coordinates from posts
  const allPlaces = extractMapPlaces(posts);

  const isCountryLevel = zoom < 6;
  const groups = isCountryLevel ? groupPlacesByCountry(allPlaces) : groupPlacesByCity(allPlaces);

  // DEBUG: Log groups
  console.log(`[MapView] Zoom: ${zoom}, isCountryLevel: ${isCountryLevel}, total places: ${allPlaces.length}`);
  for (const [name, groupPlaces] of groups) {
    console.log(`  Group "${name}": ${groupPlaces.length} places`);
  }

  const result: LocationGroup[] = [];

  for (const [locationName, groupPlaces] of groups) {
    const coords = getAverageCoords(groupPlaces);
    if (coords.lat !== 0 || coords.lng !== 0) {
      const isCountryOnlyGroup = locationName.endsWith('(country)');
      const displayName = isCountryOnlyGroup
        ? locationName.replace(' (country)', '') + ' (country center)'
        : locationName;

      console.log(`  → Result: "${displayName}" at [${coords.lat.toFixed(2)}, ${coords.lng.toFixed(2)}] with ${groupPlaces.length} places`);

      result.push({
        lat: coords.lat,
        lng: coords.lng,
        places: groupPlaces,
        locationName: displayName,
        isCountry: isCountryLevel || isCountryOnlyGroup,
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
  async function handleGeocode() {
    setIsGeocoding(true);
    setGeocodeMessage('Starting geocoding...');

    try {
      // Start geocoding
      await api.geocodePosts();

      // Poll for progress
      const pollInterval = setInterval(async () => {
        try {
          const status = await api.getGeocodeStatus();

          if (status.status === 'running') {
            const percent = Math.round((status.processed / status.total) * 100);
            setGeocodeMessage(
              `⏳ ${status.processed}/${status.total} (${percent}%) - ${status.localHits} instant, ${status.apiHits} API` +
              (status.currentLocation ? ` | ${status.currentLocation}` : '')
            );
          } else if (status.status === 'done') {
            clearInterval(pollInterval);
            setGeocodeMessage(`✅ Done! ${status.geocoded} geocoded, ${status.failed} failed (${status.localHits} instant, ${status.apiHits} API)`);
            setIsGeocoding(false);
            // Reload map data
            await loadMapData();
            setTimeout(() => setGeocodeMessage(null), 10000);
          }
        } catch (error) {
          console.error('Failed to get geocode status:', error);
        }
      }, 500); // Poll every 500ms

    } catch (error) {
      console.error('Geocoding failed:', error);
      setGeocodeMessage('❌ Geocoding failed');
      setIsGeocoding(false);
      setTimeout(() => setGeocodeMessage(null), 5000);
    }
  }

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
            onClick={handleGeocode}
            disabled={isGeocoding}
            style={{ marginLeft: 'auto' }}
          >
            {isGeocoding ? '⏳ Geocoding...' : `🌍 Geocode ${needsGeocoding} posts`}
          </button>
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
        {zoom < 6 ? '🌍 Country view' : '🏙️ City view'} (zoom: {zoom})
        {zoom < 6 && <span> — Zoom in to see cities</span>}
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
        }}>
          <MapContainer
            center={[20, 0]}
            zoom={3}
            style={{ height: '100%', width: '100%' }}
            scrollWheelZoom={true}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <ZoomTracker onZoomChange={handleZoomChange} />
            <FitBounds groups={locationGroups} />

            {locationGroups.map((group, index) => (
              <Marker
                key={`${group.locationName}-${index}`}
                position={[group.lat, group.lng]}
                icon={createClusterIcon(group.places.length, group.isCountry)}
              >
                <Popup maxWidth={450} minWidth={350}>
                  <LocationPopupContent group={group} />
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>
      )}
    </div>
  );
}
