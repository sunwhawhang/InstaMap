import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';

// Page size options for prefetch calculations
const PAGE_SIZE_OPTIONS = [100, 200, 300, 500, 1000] as const;
const MAX_PAGE_SIZE = Math.max(...PAGE_SIZE_OPTIONS);

export interface UseBidirectionalPaginationOptions<T> {
  // Unique key - when this changes, hook resets to initial state
  key: string;
  // Fetch function for loading pages
  fetchPage: (offset: number, limit: number) => Promise<T[]>;
  // Get total count (called once on init, skipped if initialTotal provided)
  getTotal: () => Promise<number>;
  // Extract unique ID for deduplication
  getId: (item: T) => string;
  // Page size for prefetch calculations
  pageSize: number;
  // Pre-seed data from cache or normal view
  initialFromStart?: T[];
  initialFromEnd?: T[];
  // Skip initial total fetch if already known
  initialTotal?: number;
}

export interface UseBidirectionalPaginationReturn<T> {
  // Data (what gets cached when switching filters)
  postsFromStart: T[];
  postsFromEnd: T[];
  totalCount: number;
  
  // Derived
  loadedFromStart: number;
  loadedFromEnd: number;
  
  // State
  isLoading: boolean;
  isLoadingMore: boolean;
  
  // Pagination control
  currentPage: number;
  setCurrentPage: React.Dispatch<React.SetStateAction<number>>;
  navigationDirection: 'forward' | 'backward';
  setNavigationDirection: (dir: 'forward' | 'backward') => void;
  
  // Computed
  getPageItems: () => T[];
  totalPages: number;
  isPageLoading: boolean;
}

export function useBidirectionalPagination<T>({
  key,
  fetchPage,
  getTotal,
  getId,
  pageSize,
  initialFromStart = [],
  initialFromEnd = [],
  initialTotal,
}: UseBidirectionalPaginationOptions<T>): UseBidirectionalPaginationReturn<T> {
  // Two separate arrays for bidirectional loading
  const [postsFromStart, setPostsFromStart] = useState<T[]>(initialFromStart);
  const [postsFromEnd, setPostsFromEnd] = useState<T[]>(initialFromEnd);
  const [totalCount, setTotalCount] = useState<number>(initialTotal ?? 0);
  
  // Loading states
  const [isLoading, setIsLoading] = useState(!initialTotal);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  
  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [navigationDirection, setNavigationDirection] = useState<'forward' | 'backward'>('forward');
  
  // Track the key to detect changes and reinitialize
  const prevKeyRef = useRef(key);
  
  // Reset state when key changes
  useEffect(() => {
    if (prevKeyRef.current !== key) {
      console.log(`[Pagination] Key changed: ${prevKeyRef.current} → ${key}, resetting state`);
      prevKeyRef.current = key;
      setPostsFromStart(initialFromStart);
      setPostsFromEnd(initialFromEnd);
      setTotalCount(initialTotal ?? 0);
      setIsLoading(!initialTotal);
      setIsLoadingMore(false);
      setCurrentPage(1);
      setNavigationDirection('forward');
    }
  }, [key, initialFromStart, initialFromEnd, initialTotal]);
  
  // Derived values
  const loadedFromStart = postsFromStart.length;
  const loadedFromEnd = postsFromEnd.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  
  // Fetch total on mount if not provided (also re-runs when key changes)
  useEffect(() => {
    if (initialTotal !== undefined) {
      setTotalCount(initialTotal);
      setIsLoading(false);
      return;
    }
    
    let cancelled = false;
    
    async function fetchTotal() {
      try {
        const total = await getTotal();
        if (!cancelled) {
          setTotalCount(total);
          setIsLoading(false);
        }
      } catch (error) {
        console.error('[Pagination] Failed to fetch total:', error);
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }
    
    fetchTotal();
    
    return () => { cancelled = true; };
  }, [key, getTotal, initialTotal]);
  
  // Initial load: fetch first and last pages if not seeded (also re-runs when key changes)
  useEffect(() => {
    if (isLoading || totalCount === 0) return;
    if (postsFromStart.length > 0 || postsFromEnd.length > 0) return; // Already have data
    
    let cancelled = false;
    
    async function loadInitial() {
      const lastPageOffset = Math.max(0, totalCount - pageSize);
      const shouldLoadLastPage = lastPageOffset >= pageSize; // No overlap
      
      console.log(`[Pagination] Initial load for key=${key}: first page (0) and last page (${lastPageOffset})`);
      
      try {
        const [firstPage, lastPage] = await Promise.all([
          fetchPage(0, pageSize),
          shouldLoadLastPage ? fetchPage(lastPageOffset, pageSize) : Promise.resolve([]),
        ]);
        
        if (!cancelled) {
          // Deduplicate: remove items from lastPage that exist in firstPage
          const firstPageIds = new Set(firstPage.map(getId));
          const deduplicatedLastPage = lastPage.filter(item => !firstPageIds.has(getId(item)));
          
          setPostsFromStart(firstPage);
          setPostsFromEnd(deduplicatedLastPage);
          console.log(`[Pagination] Initial load complete: ${firstPage.length} from start, ${deduplicatedLastPage.length} from end (${lastPage.length - deduplicatedLastPage.length} duplicates removed)`);
        }
      } catch (error) {
        console.error('[Pagination] Initial load failed:', error);
      }
    }
    
    loadInitial();
    
    return () => { cancelled = true; };
  }, [key, isLoading, totalCount, pageSize, fetchPage, getId, postsFromStart.length, postsFromEnd.length]);
  
  // Load more data (bidirectional) with deduplication
  const loadMore = useCallback(async (count: number, from: 'start' | 'end') => {
    const gap = totalCount - loadedFromStart - loadedFromEnd;
    if (isLoadingMore || gap <= 0) {
      console.log(`[Pagination] loadMore skipped - isLoadingMore: ${isLoadingMore}, gap: ${gap}`);
      return;
    }
    
    const toLoad = Math.min(count, gap);
    if (toLoad <= 0) return;
    
    setIsLoadingMore(true);
    
    try {
      const offset = from === 'start'
        ? loadedFromStart
        : totalCount - loadedFromEnd - toLoad;
      
      console.log(`[Pagination] Loading ${toLoad} posts from ${from} (offset: ${offset})...`);
      const loadStart = performance.now();
      
      const morePosts = await fetchPage(offset, toLoad);
      
      console.log(`[Pagination] Loaded ${morePosts.length} posts in ${(performance.now() - loadStart).toFixed(0)}ms`);
      
      if (morePosts.length === 0) {
        return;
      }
      
      if (from === 'start') {
        setPostsFromStart(prev => {
          // Deduplicate against existing posts
          const existingIds = new Set(prev.map(getId));
          const newPosts = morePosts.filter(p => !existingIds.has(getId(p)));
          console.log(`[Pagination] postsFromStart: ${prev.length} → ${prev.length + newPosts.length} (${morePosts.length - newPosts.length} duplicates)`);
          return [...prev, ...newPosts];
        });
      } else {
        setPostsFromEnd(prev => {
          // Deduplicate against existing posts
          const existingIds = new Set(prev.map(getId));
          const newPosts = morePosts.filter(p => !existingIds.has(getId(p)));
          console.log(`[Pagination] postsFromEnd: ${prev.length} → ${prev.length + newPosts.length} (${morePosts.length - newPosts.length} duplicates)`);
          return [...newPosts, ...prev];
        });
      }
    } finally {
      setIsLoadingMore(false);
    }
  }, [fetchPage, getId, loadedFromStart, loadedFromEnd, totalCount, isLoadingMore]);
  
  // Background prefetch effect
  useEffect(() => {
    if (isLoading || isLoadingMore || totalCount === 0) return;
    
    const fullyLoaded = loadedFromStart + loadedFromEnd >= totalCount;
    if (fullyLoaded) {
      console.log(`[Pagination] Prefetch: fully loaded (${loadedFromStart} + ${loadedFromEnd} >= ${totalCount})`);
      return;
    }
    
    const prefetchTarget = Math.max(MAX_PAGE_SIZE, 2 * pageSize);
    
    if (navigationDirection === 'forward') {
      const currentPositionEnd = currentPage * pageSize;
      const targetFromStart = currentPositionEnd + prefetchTarget;
      const maxFromStart = totalCount - loadedFromEnd;
      const needed = Math.min(targetFromStart, maxFromStart) - loadedFromStart;
      console.log(`[Pagination] Prefetch forward: page ${currentPage}, target ${targetFromStart}, have ${loadedFromStart}, need ${needed}`);
      if (needed > 0) {
        loadMore(needed, 'start');
      }
    } else {
      const currentPositionStart = (currentPage - 1) * pageSize;
      const targetFromEnd = totalCount - currentPositionStart + prefetchTarget;
      const maxFromEnd = totalCount - loadedFromStart;
      const needed = Math.min(targetFromEnd, maxFromEnd) - loadedFromEnd;
      console.log(`[Pagination] Prefetch backward: page ${currentPage}, target ${targetFromEnd}, have ${loadedFromEnd}, need ${needed}`);
      if (needed > 0) {
        loadMore(needed, 'end');
      }
    }
  }, [isLoading, isLoadingMore, currentPage, pageSize, navigationDirection, loadedFromStart, loadedFromEnd, totalCount, loadMore]);
  
  // Get items for current page with deduplication
  const getPageItems = useCallback((): T[] => {
    const pageStartIdx = (currentPage - 1) * pageSize;
    const pageEndIdx = currentPage * pageSize;
    const pageEndFromEnd = totalCount - pageStartIdx;
    const arraysHaveMet = loadedFromStart + loadedFromEnd >= totalCount;
    
    let items: T[] = [];
    
    if (pageStartIdx < loadedFromStart) {
      items = postsFromStart.slice(pageStartIdx, pageEndIdx);
      console.log(`[Pagination] Page ${currentPage} from postsFromStart[${pageStartIdx}:${pageEndIdx}], got ${items.length}`);
    } else if (arraysHaveMet && pageStartIdx < totalCount) {
      if (pageStartIdx < loadedFromStart) {
        const safeEnd = Math.min(pageEndIdx, postsFromStart.length);
        items = postsFromStart.slice(pageStartIdx, safeEnd);
      } else {
        const actualPageEnd = Math.min(pageEndIdx, totalCount);
        const actualPageSize = actualPageEnd - pageStartIdx;
        const endInEndArray = postsFromEnd.length - (totalCount - actualPageEnd);
        const startInEndArray = endInEndArray - actualPageSize;
        const safeStart = Math.max(0, startInEndArray);
        const safeEnd = Math.min(postsFromEnd.length, endInEndArray);
        items = postsFromEnd.slice(safeStart, safeEnd);
      }
      console.log(`[Pagination] Page ${currentPage} from merged arrays, got ${items.length}`);
    } else if (pageEndFromEnd <= loadedFromEnd) {
      const actualPageEnd = Math.min(pageEndIdx, totalCount);
      const actualPageSize = actualPageEnd - pageStartIdx;
      const endInEndArray = postsFromEnd.length - (totalCount - actualPageEnd);
      const startInEndArray = endInEndArray - actualPageSize;
      const safeStart = Math.max(0, startInEndArray);
      const safeEnd = Math.min(postsFromEnd.length, endInEndArray);
      items = postsFromEnd.slice(safeStart, safeEnd);
      console.log(`[Pagination] Page ${currentPage} from postsFromEnd[${safeStart}:${safeEnd}], got ${items.length}`);
    } else {
      console.log(`[Pagination] Page ${currentPage} is in GAP`);
      items = [];
    }
    
    // Final deduplication pass (in case of any overlap between arrays)
    const seen = new Set<string>();
    const deduplicated = items.filter(item => {
      const id = getId(item);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    
    if (deduplicated.length < items.length) {
      console.log(`[Pagination] Removed ${items.length - deduplicated.length} duplicate(s) from page ${currentPage}`);
    }
    
    return deduplicated;
  }, [currentPage, pageSize, totalCount, loadedFromStart, loadedFromEnd, postsFromStart, postsFromEnd, getId]);
  
  // Check if current page is still loading
  const isPageLoading = useMemo(() => {
    if (isLoading) return true;
    const pageStartIdx = (currentPage - 1) * pageSize;
    const expectedOnPage = Math.min(pageSize, totalCount - pageStartIdx);
    const pageItems = getPageItems();
    return pageItems.length === 0 && expectedOnPage > 0;
  }, [isLoading, currentPage, pageSize, totalCount, getPageItems]);
  
  return {
    postsFromStart,
    postsFromEnd,
    totalCount,
    loadedFromStart,
    loadedFromEnd,
    isLoading,
    isLoadingMore,
    currentPage,
    setCurrentPage,
    navigationDirection,
    setNavigationDirection,
    getPageItems,
    totalPages,
    isPageLoading,
  };
}

