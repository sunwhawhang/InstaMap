import { useState, useEffect, useMemo, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.markercluster';
import { api } from '../shared/api';
import { InstagramPost } from '../shared/types';

// Fix Leaflet default icon paths for bundlers
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// Group posts by location name (country or city based on zoom)
interface LocationGroup {
  lat: number;
  lng: number;
  posts: InstagramPost[];
  locationName: string;
  isCountry: boolean;
}

// Extract country from location string (e.g., "Paris, France" -> "France")
function extractCountry(location: string): string | null {
  if (!location) return null;
  const parts = location.split(',').map(p => p.trim());
  if (parts.length >= 2) {
    return parts[parts.length - 1];
  }
  // Single word might be a country
  return location.trim();
}

// Group posts by country
function groupByCountry(posts: InstagramPost[]): Map<string, InstagramPost[]> {
  const groups = new Map<string, InstagramPost[]>();

  for (const post of posts) {
    const country = extractCountry(post.location || '') || 'Unknown';
    if (!groups.has(country)) {
      groups.set(country, []);
    }
    groups.get(country)!.push(post);
  }

  return groups;
}

// Group posts by city/exact location
function groupByCity(posts: InstagramPost[]): Map<string, InstagramPost[]> {
  const groups = new Map<string, InstagramPost[]>();

  for (const post of posts) {
    const location = post.location || 'Unknown';
    if (!groups.has(location)) {
      groups.set(location, []);
    }
    groups.get(location)!.push(post);
  }

  return groups;
}

// Calculate average coordinates for a group
function getAverageCoords(posts: InstagramPost[]): { lat: number; lng: number } {
  const validPosts = posts.filter(p => p.latitude !== undefined && p.longitude !== undefined);
  if (validPosts.length === 0) return { lat: 0, lng: 0 };

  const lat = validPosts.reduce((sum, p) => sum + (p.latitude || 0), 0) / validPosts.length;
  const lng = validPosts.reduce((sum, p) => sum + (p.longitude || 0), 0) / validPosts.length;

  return { lat, lng };
}

// Create location groups based on zoom level
function createLocationGroups(posts: InstagramPost[], zoom: number): LocationGroup[] {
  const isCountryLevel = zoom < 6;
  const groups = isCountryLevel ? groupByCountry(posts) : groupByCity(posts);

  const result: LocationGroup[] = [];

  for (const [locationName, groupPosts] of groups) {
    const coords = getAverageCoords(groupPosts);
    if (coords.lat !== 0 || coords.lng !== 0) {
      result.push({
        lat: coords.lat,
        lng: coords.lng,
        posts: groupPosts,
        locationName,
        isCountry: isCountryLevel,
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
                icon={createClusterIcon(group.posts.length, group.isCountry)}
              >
                <Popup maxWidth={350} minWidth={250}>
                  <div style={{ maxHeight: '350px', overflowY: 'auto' }}>
                    <h4 style={{ margin: '0 0 8px 0', fontSize: '15px', fontWeight: 600 }}>
                      {group.isCountry ? '🌍' : '📍'} {group.locationName}
                    </h4>
                    <p style={{ margin: '0 0 12px 0', color: '#666', fontSize: '13px' }}>
                      {group.posts.length} post{group.posts.length !== 1 ? 's' : ''}
                    </p>
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(3, 1fr)',
                      gap: '6px',
                    }}>
                      {group.posts.slice(0, 9).map((post) => (
                        <a
                          key={post.id}
                          href={`https://www.instagram.com/p/${post.instagramId}/`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            display: 'block',
                            aspectRatio: '1',
                            borderRadius: '6px',
                            overflow: 'hidden',
                          }}
                        >
                          <img
                            src={post.imageUrl}
                            alt=""
                            style={{
                              width: '100%',
                              height: '100%',
                              objectFit: 'cover',
                            }}
                          />
                        </a>
                      ))}
                    </div>
                    {group.posts.length > 9 && (
                      <div style={{
                        marginTop: '8px',
                        fontSize: '12px',
                        color: '#666',
                        textAlign: 'center'
                      }}>
                        +{group.posts.length - 9} more posts
                      </div>
                    )}
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>
      )}
    </div>
  );
}
