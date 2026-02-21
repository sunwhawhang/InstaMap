/**
 * Geocoding service - supports Mapbox and Google Places APIs
 * Uses Neo4j cache to avoid redundant API calls
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type GeocodingProvider = 'mapbox' | 'google';

export interface GeocodingResult {
  latitude: number;
  longitude: number;
  normalizedLocation: string;      // Full: "Westminster, London, England, United Kingdom"
  normalizedCountry: string;       // "United Kingdom"
  normalizedCity: string;          // "London"
  normalizedNeighborhood?: string; // "Westminster" (optional)
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
  normalizedCountry: string;
  normalizedCity: string;
  normalizedNeighborhood?: string;
  provider: GeocodingProvider;
  createdAt: string;
}

type CacheLookupFn = (queryKey: string) => Promise<GeocodingCacheEntry | null>;
type CacheSaveFn = (entry: GeocodingCacheEntry) => Promise<void>;

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
   * Parse Mapbox response to extract location hierarchy
   */
  private parseMapboxResult(feature: MapboxFeature): Omit<GeocodingResult, 'source'> {
    const [lng, lat] = feature.center;
    
    let country = '';
    let city = '';
    let neighborhood = '';
    
    // The main result text
    const mainText = feature.text;
    const placeType = feature.place_type[0];
    
    // Parse context for hierarchy
    if (feature.context) {
      for (const ctx of feature.context) {
        if (ctx.id.startsWith('country')) {
          country = ctx.text;
        } else if (ctx.id.startsWith('place') || ctx.id.startsWith('city')) {
          city = ctx.text;
        } else if (ctx.id.startsWith('locality') || ctx.id.startsWith('neighborhood')) {
          // If we already have something in neighborhood, this might be the city
          if (neighborhood && !city) {
            city = ctx.text;
          } else if (!neighborhood) {
            neighborhood = ctx.text;
          }
        } else if (ctx.id.startsWith('region') && !city) {
          // Sometimes region is the city for smaller places
          city = ctx.text;
        }
      }
    }
    
    // Determine what the main result is
    if (placeType === 'country') {
      country = mainText;
    } else if (placeType === 'place' || placeType === 'city') {
      city = mainText;
    } else if (placeType === 'locality' || placeType === 'neighborhood') {
      neighborhood = mainText;
    } else if (!city) {
      // Default: treat main text as city if we don't have one
      city = mainText;
    }
    
    // If we have neighborhood but no city, promote neighborhood to city
    if (neighborhood && !city) {
      city = neighborhood;
      neighborhood = '';
    }
    
    return {
      latitude: lat,
      longitude: lng,
      normalizedLocation: feature.place_name,
      normalizedCountry: country,
      normalizedCity: city,
      normalizedNeighborhood: neighborhood || undefined,
      provider: 'mapbox',
    };
  }

  /**
   * Parse Google Geocoding response to extract location hierarchy
   */
  private parseGoogleResult(result: GoogleGeocodeResult): Omit<GeocodingResult, 'source'> {
    const { lat, lng } = result.geometry.location;
    
    let country = '';
    let city = '';
    let neighborhood = '';
    let adminArea1 = ''; // State/Region (e.g., England, California)
    let adminArea2 = ''; // County (e.g., Greater London)
    
    for (const component of result.address_components) {
      const types = component.types;
      
      if (types.includes('country')) {
        country = component.long_name;
      } else if (types.includes('locality') || types.includes('postal_town')) {
        city = component.long_name;
      } else if (types.includes('administrative_area_level_1')) {
        adminArea1 = component.long_name;
      } else if (types.includes('administrative_area_level_2')) {
        adminArea2 = component.long_name;
      } else if (types.includes('sublocality') || types.includes('sublocality_level_1') || 
                 types.includes('neighborhood') || types.includes('administrative_area_level_3')) {
        if (!neighborhood) {
          neighborhood = component.long_name;
        }
      }
    }
    
    // Normalize Greater London → London
    if (adminArea2 === 'Greater London' || city === 'Greater London') {
      city = 'London';
    }
    
    // If no city found, try admin area 2 (county level)
    if (!city && adminArea2) {
      city = adminArea2;
    }
    
    // Don't set city to admin area 1 (state/region level like England, California)
    // These are not cities - let them be empty so they group at country level
    if (city && adminArea1 && city.toLowerCase() === adminArea1.toLowerCase()) {
      city = '';
    }
    
    return {
      latitude: lat,
      longitude: lng,
      normalizedLocation: result.formatted_address,
      normalizedCountry: country,
      normalizedCity: city,
      normalizedNeighborhood: neighborhood || undefined,
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
      return {
        latitude: city.lat,
        longitude: city.lng,
        normalizedLocation: `${cityName}, ${countryName}`,
        normalizedCountry: countryName,
        normalizedCity: cityName,
        provider: 'mapbox',
        source: 'local',
      };
    }

    // Try exact match for country names
    if (parts.length === 1 && this.citiesDb.countries[normalized]) {
      const country = this.citiesDb.countries[normalized];
      // Use canonical name to avoid "UK" vs "United Kingdom" duplication
      const countryName = GeocodingService.COUNTRY_CANONICAL_NAMES[normalized] || location.trim();
      return {
        latitude: country.lat,
        longitude: country.lng,
        normalizedLocation: countryName,
        normalizedCountry: countryName,
        normalizedCity: '',
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
        return {
          latitude: city.lat,
          longitude: city.lng,
          normalizedLocation: `${cityName}, ${countryName}`,
          normalizedCountry: countryName,
          normalizedCity: cityName,
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
