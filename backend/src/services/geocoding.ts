/**
 * Geocoding service - supports Mapbox and Google Places APIs
 * Uses Neo4j cache to avoid redundant API calls
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AddressComponent } from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type GeocodingProvider = 'mapbox' | 'google';

export interface GeocodingResult {
  latitude: number;
  longitude: number;
  normalizedLocation: string;      // Full formatted address from API
  addressComponents: AddressComponent[];  // Raw hierarchy from API
  // Legacy fields (derived from addressComponents)
  normalizedCountry: string;
  normalizedCity: string;
  normalizedNeighborhood?: string;
  provider: GeocodingProvider;
  source: 'cache' | 'local' | 'api';
}

// Mapbox response types
interface MapboxFeature {
  place_name: string;
  center: [number, number]; // [lng, lat]
  context?: Array<{
    id: string;
    text: string;
    short_code?: string;
  }>;
  place_type: string[];
  text: string;
}

interface MapboxResponse {
  features: MapboxFeature[];
}

// Google Places response types
interface GoogleGeocodeResult {
  formatted_address: string;
  geometry: {
    location: {
      lat: number;
      lng: number;
    };
  };
  address_components: Array<{
    long_name: string;
    short_name: string;
    types: string[];
  }>;
}

interface GoogleGeocodeResponse {
  results: GoogleGeocodeResult[];
  status: string;
}

interface CityData {
  lat: number;
  lng: number;
  country?: string;
}

interface CitiesDatabase {
  cities: Record<string, CityData>;
  countries: Record<string, CityData>;
}

// Cache interface for Neo4j storage
export interface GeocodingCacheEntry {
  queryKey: string;
  latitude: number;
  longitude: number;
  normalizedLocation: string;
  addressComponents: AddressComponent[];
  // Legacy fields (derived, kept for cache queryability)
  normalizedCountry: string;
  normalizedCity: string;
  normalizedNeighborhood?: string;
  provider: GeocodingProvider;
  createdAt: string;
}

type CacheLookupFn = (queryKey: string) => Promise<GeocodingCacheEntry | null>;
type CacheSaveFn = (entry: GeocodingCacheEntry) => Promise<void>;

// Unified type maps: API-specific types → our canonical types
const GOOGLE_TYPE_MAP: Record<string, string> = {
  'country': 'country',
  'administrative_area_level_1': 'admin_area_1',
  'administrative_area_level_2': 'admin_area_2',
  'locality': 'locality',
  'postal_town': 'locality',
  'sublocality': 'sublocality',
  'sublocality_level_1': 'sublocality',
  'sublocality_level_2': 'sublocality',
  'neighborhood': 'neighborhood',
  'administrative_area_level_3': 'neighborhood',
};

const MAPBOX_TYPE_MAP: Record<string, string> = {
  'country': 'country',
  'region': 'admin_area_1',
  'district': 'admin_area_2',
  'place': 'locality',
  'city': 'locality',
  'locality': 'sublocality',
  'neighborhood': 'neighborhood',
};

// Normalizations applied to specific component types (e.g., "Greater London" → "London")
const COMPONENT_NORMALIZATIONS: Record<string, Record<string, string>> = {
  locality: { 'Greater London': 'London' },
  admin_area_2: { 'Greater London': 'London' },
};

/**
 * Derive legacy normalizedCountry/City/Neighborhood from addressComponents
 */
function deriveHierarchyFields(components: AddressComponent[]): {
  normalizedCountry: string;
  normalizedCity: string;
  normalizedNeighborhood?: string;
} {
  const byType = new Map(components.map(c => [c.type, c.name]));
  return {
    normalizedCountry: byType.get('country') || '',
    normalizedCity: byType.get('locality') || byType.get('admin_area_2') || byType.get('admin_area_1') || '',
    normalizedNeighborhood: byType.get('neighborhood') || byType.get('sublocality') || undefined,
  };
}

class GeocodingService {
  private citiesDb: CitiesDatabase;
  private memoryCache: Map<string, GeocodingResult | null> = new Map();
  private cacheLookup: CacheLookupFn | null = null;
  private cacheSave: CacheSaveFn | null = null;

  // Map common aliases/abbreviations to canonical country names
  // Prevents "UK" and "United Kingdom" from appearing as separate countries
  private static readonly COUNTRY_CANONICAL_NAMES: Record<string, string> = {
    'uk': 'United Kingdom',
    'usa': 'United States',
    'us': 'United States',
    'uae': 'United Arab Emirates',
  };

  constructor() {
    try {
      const citiesPath = join(__dirname, '../data/cities.json');
      const data = readFileSync(citiesPath, 'utf-8');
      this.citiesDb = JSON.parse(data);
      console.log(`[Geocoding] Loaded ${Object.keys(this.citiesDb.cities).length} cities, ${Object.keys(this.citiesDb.countries).length} countries`);
    } catch (error) {
      console.error('[Geocoding] Failed to load cities database:', error);
      this.citiesDb = { cities: {}, countries: {} };
    }
  }

  initCache(lookup: CacheLookupFn, save: CacheSaveFn): void {
    this.cacheLookup = lookup;
    this.cacheSave = save;
    console.log('[Geocoding] Neo4j cache initialized');
  }

  private normalizeQuery(location: string): string {
    return location.toLowerCase().trim();
  }

  /**
   * Parse Mapbox response into addressComponents
   */
  private parseMapboxResult(feature: MapboxFeature): Omit<GeocodingResult, 'source'> {
    const [lng, lat] = feature.center;
    const components: AddressComponent[] = [];
    const seen = new Set<string>();

    // Add the main feature result
    const mainType = MAPBOX_TYPE_MAP[feature.place_type[0]];
    if (mainType && !seen.has(mainType)) {
      components.push({ name: feature.text, type: mainType });
      seen.add(mainType);
    }

    // Add context hierarchy
    if (feature.context) {
      for (const ctx of feature.context) {
        const prefix = ctx.id.split('.')[0];
        const type = MAPBOX_TYPE_MAP[prefix];
        if (type && !seen.has(type)) {
          components.push({ name: ctx.text, type });
          seen.add(type);
        }
      }
    }

    const derived = deriveHierarchyFields(components);
    return {
      latitude: lat,
      longitude: lng,
      normalizedLocation: feature.place_name,
      addressComponents: components,
      ...derived,
      provider: 'mapbox',
    };
  }

  /**
   * Parse Google Geocoding response into addressComponents
   */
  private parseGoogleResult(result: GoogleGeocodeResult): Omit<GeocodingResult, 'source'> {
    const { lat, lng } = result.geometry.location;
    const components: AddressComponent[] = [];
    const seen = new Set<string>();

    for (const component of result.address_components) {
      // Find the first matching type from our map
      let mappedType: string | undefined;
      for (const googleType of component.types) {
        if (GOOGLE_TYPE_MAP[googleType]) {
          mappedType = GOOGLE_TYPE_MAP[googleType];
          break;
        }
      }
      if (mappedType && !seen.has(mappedType)) {
        let name = component.long_name;
        // Apply normalizations (e.g., "Greater London" → "London")
        const normalizations = COMPONENT_NORMALIZATIONS[mappedType];
        if (normalizations && normalizations[name]) {
          name = normalizations[name];
        }
        components.push({ name, type: mappedType });
        seen.add(mappedType);
      }
    }

    const derived = deriveHierarchyFields(components);
    return {
      latitude: lat,
      longitude: lng,
      normalizedLocation: result.formatted_address,
      addressComponents: components,
      ...derived,
      provider: 'google',
    };
  }

  /**
   * Try local database lookup
   * Only use for simple queries (single word or "City, Country" format)
   * Skip for complex queries with 3+ parts (likely neighborhoods)
   */
  private lookupLocal(location: string): GeocodingResult | null {
    const normalized = this.normalizeQuery(location);
    const parts = location.split(',').map(p => p.trim());

    // Skip local lookup for complex queries (3+ parts like "Belgravia, London, UK")
    // These need proper API geocoding to get the hierarchy right
    if (parts.length >= 3) {
      return null;
    }

    // Try exact match for simple city names (no comma)
    if (parts.length === 1 && this.citiesDb.cities[normalized]) {
      const city = this.citiesDb.cities[normalized];
      const cityName = location.trim();
      const countryName = city.country || 'Unknown';
      const addressComponents: AddressComponent[] = [
        { name: countryName, type: 'country' },
        { name: cityName, type: 'locality' },
      ];
      return {
        latitude: city.lat,
        longitude: city.lng,
        normalizedLocation: `${cityName}, ${countryName}`,
        addressComponents,
        ...deriveHierarchyFields(addressComponents),
        provider: 'mapbox',
        source: 'local',
      };
    }

    // Try exact match for country names
    if (parts.length === 1 && this.citiesDb.countries[normalized]) {
      const country = this.citiesDb.countries[normalized];
      // Use canonical name to avoid "UK" vs "United Kingdom" duplication
      const countryName = GeocodingService.COUNTRY_CANONICAL_NAMES[normalized] || location.trim();
      const addressComponents: AddressComponent[] = [
        { name: countryName, type: 'country' },
      ];
      return {
        latitude: country.lat,
        longitude: country.lng,
        normalizedLocation: countryName,
        addressComponents,
        ...deriveHierarchyFields(addressComponents),
        provider: 'mapbox',
        source: 'local',
      };
    }

    // For "City, Country" format (2 parts), ONLY match if city is in our database
    // Do NOT fall back to country coordinates - that gives wrong locations
    if (parts.length === 2) {
      const cityPart = parts[0].toLowerCase();

      // Only return local result if we have the actual city
      if (this.citiesDb.cities[cityPart]) {
        const city = this.citiesDb.cities[cityPart];
        const cityName = parts[0];
        const countryName = city.country || parts[1];
        const addressComponents: AddressComponent[] = [
          { name: countryName, type: 'country' },
          { name: cityName, type: 'locality' },
        ];
        return {
          latitude: city.lat,
          longitude: city.lng,
          normalizedLocation: `${cityName}, ${countryName}`,
          addressComponents,
          ...deriveHierarchyFields(addressComponents),
          provider: 'mapbox',
          source: 'local',
        };
      }
      // If city not found, return null to let API handle it properly
    }

    return null;
  }

  /**
   * Fetch from Mapbox API
   */
  private async fetchFromMapbox(location: string): Promise<GeocodingResult | null> {
    const accessToken = process.env.MAPBOX_ACCESS_TOKEN;
    if (!accessToken) {
      console.error('[Geocoding] MAPBOX_ACCESS_TOKEN not set');
      return null;
    }

    const normalized = this.normalizeQuery(location);
    if (normalized === '<unknown>' || normalized === 'unknown' || normalized.length < 2) {
      return null;
    }

    try {
      const encodedLocation = encodeURIComponent(location);
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodedLocation}.json?access_token=${accessToken}&limit=1&types=place,locality,neighborhood,region,country`;

      const response = await fetch(url);
      if (!response.ok) {
        console.error(`[Geocoding] Mapbox API error: ${response.status}`);
        return null;
      }

      const data = await response.json() as MapboxResponse;
      if (!data.features || data.features.length === 0) {
        console.log(`[Geocoding] No Mapbox results for: ${location}`);
        return null;
      }

      const parsed = this.parseMapboxResult(data.features[0]);
      return { ...parsed, source: 'api' };
    } catch (error) {
      console.error(`[Geocoding] Mapbox error for "${location}":`, error);
      return null;
    }
  }

  /**
   * Fetch from Google Places Geocoding API
   */
  private async fetchFromGoogle(location: string): Promise<GeocodingResult | null> {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      console.error('[Geocoding] GOOGLE_PLACES_API_KEY not set');
      return null;
    }

    const normalized = this.normalizeQuery(location);
    if (normalized === '<unknown>' || normalized === 'unknown' || normalized.length < 2) {
      return null;
    }

    try {
      const encodedLocation = encodeURIComponent(location);
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodedLocation}&key=${apiKey}`;

      const response = await fetch(url);
      if (!response.ok) {
        console.error(`[Geocoding] Google API error: ${response.status}`);
        return null;
      }

      const data = await response.json() as GoogleGeocodeResponse;
      if (data.status !== 'OK' || !data.results || data.results.length === 0) {
        console.log(`[Geocoding] No Google results for: ${location} (status: ${data.status})`);
        return null;
      }

      const parsed = this.parseGoogleResult(data.results[0]);
      return { ...parsed, source: 'api' };
    } catch (error) {
      console.error(`[Geocoding] Google error for "${location}":`, error);
      return null;
    }
  }

  /**
   * Geocode a location using specified provider
   */
  async geocode(location: string, provider: GeocodingProvider = 'mapbox', force = false): Promise<GeocodingResult | null> {
    if (!location || location.trim().length === 0) {
      return null;
    }

    const queryKey = `${provider}:${this.normalizeQuery(location)}`;

    if (!force) {
      // 1. Check memory cache
      if (this.memoryCache.has(queryKey)) {
        const cached = this.memoryCache.get(queryKey);
        if (cached) {
          console.log(`[Geocoding] Memory cache hit: "${location}"`);
          return { ...cached, source: 'cache' };
        }
        return null;
      }

      // 2. Check Neo4j cache
      if (this.cacheLookup) {
        try {
          const cached = await this.cacheLookup(queryKey);
          if (cached) {
            console.log(`[Geocoding] Neo4j cache hit: "${location}" → ${cached.normalizedCity}, ${cached.normalizedCountry}`);
            const result: GeocodingResult = {
              latitude: cached.latitude,
              longitude: cached.longitude,
              normalizedLocation: cached.normalizedLocation,
              addressComponents: cached.addressComponents,
              normalizedCountry: cached.normalizedCountry,
              normalizedCity: cached.normalizedCity,
              normalizedNeighborhood: cached.normalizedNeighborhood,
              provider: cached.provider,
              source: 'cache',
            };
            this.memoryCache.set(queryKey, result);
            return result;
          }
        } catch (error) {
          console.error('[Geocoding] Neo4j cache lookup failed:', error);
        }
      }
    } else {
      console.log(`[Geocoding] Force re-geocode: "${location}" (bypassing cache)`);
    }

    // 3. Try local database (only for simple city/country lookups)
    const localResult = this.lookupLocal(location);
    if (localResult) {
      console.log(`[Geocoding] Local hit: "${location}" → ${localResult.normalizedCity}, ${localResult.normalizedCountry}`);
      this.memoryCache.set(queryKey, localResult);
      await this.saveToCache(queryKey, localResult);
      return localResult;
    }

    // 4. Call the appropriate API
    let apiResult: GeocodingResult | null = null;
    if (provider === 'google') {
      apiResult = await this.fetchFromGoogle(location);
    } else {
      apiResult = await this.fetchFromMapbox(location);
    }

    if (apiResult) {
      console.log(`[Geocoding] ${provider} hit: "${location}" → ${apiResult.normalizedCity}, ${apiResult.normalizedCountry}`);
      this.memoryCache.set(queryKey, apiResult);
      await this.saveToCache(queryKey, apiResult);
      return apiResult;
    }

    console.log(`[Geocoding] Not found: "${location}"`);
    this.memoryCache.set(queryKey, null);
    return null;
  }

  private async saveToCache(queryKey: string, result: GeocodingResult): Promise<void> {
    if (this.cacheSave) {
      try {
        await this.cacheSave({
          queryKey,
          latitude: result.latitude,
          longitude: result.longitude,
          normalizedLocation: result.normalizedLocation,
          addressComponents: result.addressComponents,
          normalizedCountry: result.normalizedCountry,
          normalizedCity: result.normalizedCity,
          normalizedNeighborhood: result.normalizedNeighborhood,
          provider: result.provider,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        console.error('[Geocoding] Failed to save to cache:', error);
      }
    }
  }

  /**
   * Check which providers are available
   */
  getAvailableProviders(): { mapbox: boolean; google: boolean } {
    return {
      mapbox: !!process.env.MAPBOX_ACCESS_TOKEN,
      google: !!process.env.GOOGLE_PLACES_API_KEY,
    };
  }

  getStats(): { localCities: number; localCountries: number; memoryCacheSize: number } {
    return {
      localCities: Object.keys(this.citiesDb.cities).length,
      localCountries: Object.keys(this.citiesDb.countries).length,
      memoryCacheSize: this.memoryCache.size,
    };
  }

  clearMemoryCache(): void {
    this.memoryCache.clear();
    console.log('[Geocoding] Memory cache cleared');
  }
}

export const geocodingService = new GeocodingService();
