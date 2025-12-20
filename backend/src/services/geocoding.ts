/**
 * Geocoding service - uses local city database first, falls back to Nominatim API
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface GeocodingResult {
  latitude: number;
  longitude: number;
  displayName: string;
  source: 'local' | 'api';
}

interface NominatimResponse {
  lat: string;
  lon: string;
  display_name: string;
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

class GeocodingService {
  private citiesDb: CitiesDatabase;
  private apiCache: Map<string, GeocodingResult | null> = new Map();
  private lastRequestTime = 0;
  private readonly MIN_REQUEST_INTERVAL = 1100; // 1.1 seconds for Nominatim

  constructor() {
    // Load cities database
    try {
      const citiesPath = join(__dirname, '../data/cities.json');
      const data = readFileSync(citiesPath, 'utf-8');
      this.citiesDb = JSON.parse(data);
      console.log(`[Geocoding] Loaded ${Object.keys(this.citiesDb.cities).length} cities and ${Object.keys(this.citiesDb.countries).length} countries`);
    } catch (error) {
      console.error('[Geocoding] Failed to load cities database:', error);
      this.citiesDb = { cities: {}, countries: {} };
    }
  }

  /**
   * Normalize location string for lookup
   */
  private normalizeLocation(location: string): string {
    return location.toLowerCase().trim();
  }

  /**
   * Try to find location in local database
   */
  private lookupLocal(location: string): GeocodingResult | null {
    const normalized = this.normalizeLocation(location);

    // Try exact match in cities
    if (this.citiesDb.cities[normalized]) {
      const city = this.citiesDb.cities[normalized];
      return {
        latitude: city.lat,
        longitude: city.lng,
        displayName: location,
        source: 'local',
      };
    }

    // Try exact match in countries
    if (this.citiesDb.countries[normalized]) {
      const country = this.citiesDb.countries[normalized];
      return {
        latitude: country.lat,
        longitude: country.lng,
        displayName: location,
        source: 'local',
      };
    }

    // Try extracting city from "City, Country" format
    const parts = location.split(',').map(p => p.trim().toLowerCase());
    if (parts.length >= 1) {
      // Try first part as city
      if (this.citiesDb.cities[parts[0]]) {
        const city = this.citiesDb.cities[parts[0]];
        return {
          latitude: city.lat,
          longitude: city.lng,
          displayName: location,
          source: 'local',
        };
      }

      // Try last part as country (for country-only entries)
      const lastPart = parts[parts.length - 1];
      if (this.citiesDb.countries[lastPart]) {
        const country = this.citiesDb.countries[lastPart];
        return {
          latitude: country.lat,
          longitude: country.lng,
          displayName: location,
          source: 'local',
        };
      }
    }

    return null;
  }

  /**
   * Rate limit API requests
   */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
      const waitTime = this.MIN_REQUEST_INTERVAL - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    this.lastRequestTime = Date.now();
  }

  /**
   * Fetch from Nominatim API (fallback)
   */
  private async fetchFromApi(location: string): Promise<GeocodingResult | null> {
    const normalized = this.normalizeLocation(location);

    // Check API cache
    if (this.apiCache.has(normalized)) {
      return this.apiCache.get(normalized) || null;
    }

    // Skip obviously invalid locations
    if (normalized === '<unknown>' || normalized === 'unknown' || normalized.length < 2) {
      this.apiCache.set(normalized, null);
      return null;
    }

    await this.rateLimit();

    try {
      const encodedLocation = encodeURIComponent(location);
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodedLocation}&limit=1`;

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'InstaMap/1.0 (Instagram Saved Posts Manager)',
        },
      });

      if (!response.ok) {
        console.error(`[Geocoding] Nominatim API error: ${response.status}`);
        this.apiCache.set(normalized, null);
        return null;
      }

      const data = await response.json() as NominatimResponse[];

      if (data.length === 0) {
        console.log(`[Geocoding] No API results for: ${location}`);
        this.apiCache.set(normalized, null);
        return null;
      }

      const result: GeocodingResult = {
        latitude: parseFloat(data[0].lat),
        longitude: parseFloat(data[0].lon),
        displayName: data[0].display_name,
        source: 'api',
      };

      this.apiCache.set(normalized, result);
      return result;
    } catch (error) {
      console.error(`[Geocoding] API error for "${location}":`, error);
      this.apiCache.set(normalized, null);
      return null;
    }
  }

  /**
   * Geocode a location - tries local first, then API
   */
  async geocode(location: string): Promise<GeocodingResult | null> {
    if (!location || location.trim().length === 0) {
      return null;
    }

    // Try local database first (instant)
    const localResult = this.lookupLocal(location);
    if (localResult) {
      console.log(`[Geocoding] Local hit: "${location}" → ${localResult.latitude}, ${localResult.longitude}`);
      return localResult;
    }

    // Fall back to API (rate limited)
    const apiResult = await this.fetchFromApi(location);
    if (apiResult) {
      console.log(`[Geocoding] API hit: "${location}" → ${apiResult.latitude}, ${apiResult.longitude}`);
    } else {
      console.log(`[Geocoding] Not found: "${location}"`);
    }

    return apiResult;
  }

  /**
   * Batch geocode - local lookups are instant, API calls are rate limited
   */
  async batchGeocode(locations: string[]): Promise<Map<string, GeocodingResult | null>> {
    const results = new Map<string, GeocodingResult | null>();
    let localHits = 0;
    let apiHits = 0;
    let notFound = 0;

    for (const location of locations) {
      const result = await this.geocode(location);
      results.set(location, result);

      if (result?.source === 'local') localHits++;
      else if (result?.source === 'api') apiHits++;
      else notFound++;
    }

    console.log(`[Geocoding] Batch complete: ${localHits} local, ${apiHits} API, ${notFound} not found`);
    return results;
  }

  /**
   * Get stats
   */
  getStats(): { localCities: number; localCountries: number; apiCacheSize: number } {
    return {
      localCities: Object.keys(this.citiesDb.cities).length,
      localCountries: Object.keys(this.citiesDb.countries).length,
      apiCacheSize: this.apiCache.size,
    };
  }
}

export const geocodingService = new GeocodingService();
