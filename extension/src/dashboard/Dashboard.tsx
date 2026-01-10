import { useState, useEffect, useRef, useCallback, useMemo, FormEvent } from 'react';
import { InstagramPost, Category, SyncStatus } from '../shared/types';
import { getPosts, getCategories, getSyncStatus, getSettings } from '../shared/storage';
import { api, initImageProxy } from '../shared/api';
import { Chat } from './Chat';
import { Categories } from './Categories';
import { PostCard } from './PostCard';
import { MapView } from './MapView';
import { PostDetailModal } from './PostDetailModal';
import { useBidirectionalPagination } from '../hooks/useBidirectionalPagination';

type View = 'posts' | 'chat' | 'categories' | 'map';
type CategorizeStatus = 'idle' | 'choosing' | 'processing' | 'polling' | 'done' | 'error';

// Cache structure for filter pagination data
interface CachedPaginationData {
  postsFromStart: InstagramPost[];
  postsFromEnd: InstagramPost[];
  totalCount: number;
}

const MAX_CACHED_FILTERS = 5;

const ACTIVE_BATCH_KEY = 'instamap_active_batch';

// Page size options for pagination
const PAGE_SIZE_OPTIONS = [100, 200, 300, 500, 1000] as const;

// Generate consistent colors for categories
function getCategoryColor(categoryName: string): string {
  const colors = [
    '#E1306C', '#405DE6', '#5851DB', '#833AB4', '#C13584',
    '#FD1D1D', '#F77737', '#FCAF45', '#58C322', '#00A693',
    '#0095F6', '#6C5CE7',
  ];
  let hash = 0;
  for (let i = 0; i < categoryName.length; i++) {
    hash = categoryName.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

export function Dashboard() {
  const [view, setView] = useState<View>('posts');
  const [posts, setPosts] = useState<InstagramPost[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  const [backendConnected, setBackendConnected] = useState(false);

  // Track synced and categorized posts
  const [syncedPostIds, setSyncedPostIds] = useState<Set<string>>(new Set());
  const [categorizedPostIds, setCategorizedPostIds] = useState<Set<string>>(new Set());
  const [uncategorizedCount, setUncategorizedCount] = useState<number>(0);

  // Sync state
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  // Selection mode for posts
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPostIds, setSelectedPostIds] = useState<Set<string>>(new Set());
  const [lastSelectedPostId, setLastSelectedPostId] = useState<string | null>(null);

  // Filter options
  const [filterUnsynced, setFilterUnsynced] = useState(false);
  const [filterUncategorized, setFilterUncategorized] = useState(false);

  // Page size for pagination (currentPage is managed by hook)
  const [pageSize, setPageSize] = useState(100);

  // Total synced posts count (needed for pagination config before hook is ready)
  const [totalCloudPosts, setTotalCloudPosts] = useState(0);

  // Post detail modal
  const [selectedPost, setSelectedPost] = useState<InstagramPost | null>(null);
  const [postCategories, setPostCategories] = useState<string[]>([]);

  // Auto-categorize state
  const [categorizeStatus, setCategorizeStatus] = useState<CategorizeStatus>('idle');
  const [categorizeMessage, setCategorizeMessage] = useState('');
  const [batchId, setBatchId] = useState<string | null>(null);
  const [showCategorizeModal, setShowCategorizeModal] = useState(false);
  const [categorizeStats, setCategorizeStats] = useState<{
    unsynced: number;
    uncategorized: number;
    alreadyCategorized: number;
    totalToProcess: number;
    estimatedCost: string;
    realtimeCost: string;
    asyncCost: string;
  } | null>(null);
  const pollingIntervalRef = useRef<number | null>(null);
  const [manualBatchId, setManualBatchId] = useState('');
  const [showManualBatchInput, setShowManualBatchInput] = useState(false);

  // Embedding refresh state
  const [embeddingsNeedingRefresh, setEmbeddingsNeedingRefresh] = useState(0);
  const [isRefreshingEmbeddings, setIsRefreshingEmbeddings] = useState(false);
  const [isCalculatingStats, setIsCalculatingStats] = useState(false);
  const [embeddingMessage, setEmbeddingMessage] = useState<string | null>(null);

  // LRU cache for filter pagination data (stores DATA, not hooks)
  const filterDataCacheRef = useRef(new Map<string, CachedPaginationData>());
  // Track the current filter key for the active hook
  const [activeFilterKey, setActiveFilterKey] = useState<string | null>(null);

  // Image download state
  const [imagesNeedingDownload, setImagesNeedingDownload] = useState(0);
  const [storeImagesEnabled, setStoreImagesEnabled] = useState(false);

  useEffect(() => {
    loadData();
    checkForActiveBatch();

    // Cleanup polling on unmount
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, []);

  // Helper: Save filter data to LRU cache
  const saveToFilterCache = useCallback((key: string, data: CachedPaginationData) => {
    const cache = filterDataCacheRef.current;
    // LRU: delete and re-add to move to end
    cache.delete(key);
    // Evict oldest if at limit
    if (cache.size >= MAX_CACHED_FILTERS) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(key, data);
    console.log(`[FilterCache] Saved ${key} (${data.postsFromStart.length}+${data.postsFromEnd.length} posts, total=${data.totalCount})`);
  }, []);

  // Helper: Invalidate all filter cache (call after sync/categorize)
  const invalidateFilterCache = useCallback(() => {
    filterDataCacheRef.current.clear();
    console.log('[FilterCache] Cache invalidated');
  }, []);

  // Pagination hook - key changes = state resets
  const paginationKey = activeFilterKey ?? 'normal';

  // Get initial data based on current filter
  const paginationInitialData = useMemo(() => {
    if (activeFilterKey === null) {
      // Normal view - no initial data, will load from API
      return { initialFromStart: undefined, initialFromEnd: undefined, initialTotal: totalCloudPosts || undefined };
    }
    // For filters, check cache
    // Note: We can't use getCachedOrSeedData here because normalPagination isn't ready yet
    // This will be handled by the filter activation flow
    const cached = filterDataCacheRef.current.get(activeFilterKey);
    if (cached) {
      return {
        initialFromStart: cached.postsFromStart,
        initialFromEnd: cached.postsFromEnd,
        initialTotal: cached.totalCount || undefined
      };
    }
    return { initialFromStart: undefined, initialFromEnd: undefined, initialTotal: undefined };
  }, [activeFilterKey, totalCloudPosts]);

  // Fetch page function based on current filter
  const fetchPage = useCallback(async (offset: number, limit: number): Promise<InstagramPost[]> => {
    if (activeFilterKey === null) {
      return api.getPosts({ offset, limit });
    }
    // Parse filter key to determine fetch method
    if (activeFilterKey.startsWith('category:')) {
      const categoryName = activeFilterKey.slice('category:'.length);
      // Find category ID from name
      const category = categories.find(c => c.name === categoryName);
      if (category) {
        return api.getPosts({ category: category.id, recursive: true, offset, limit });
      }
      return [];
    }
    if (activeFilterKey.startsWith('search:')) {
      const query = activeFilterKey.slice('search:'.length);
      return api.getPosts({ search: query, offset, limit });
    }
    return api.getPosts({ offset, limit });
  }, [activeFilterKey, categories]);

  // Get total function based on current filter
  const getTotal = useCallback(async (): Promise<number> => {
    if (activeFilterKey === null) {
      return totalCloudPosts;
    }
    if (activeFilterKey.startsWith('category:')) {
      const categoryName = activeFilterKey.slice('category:'.length);
      const category = categories.find(c => c.name === categoryName);
      if (category) {
        return api.getCategoryPostCount(category.id); // Already includes children
      }
      return 0;
    }
    if (activeFilterKey.startsWith('search:')) {
      const query = activeFilterKey.slice('search:'.length);
      return api.getSearchCount(query);
    }
    return 0;
  }, [activeFilterKey, categories, totalCloudPosts]);

  // The bidirectional pagination hook
  const normalPagination = useBidirectionalPagination<InstagramPost>({
    key: paginationKey,
    fetchPage,
    getTotal,
    getId: (p) => p.instagramId,
    pageSize,
    ...paginationInitialData,
  });

  // Destructure for easier access
  const {
    postsFromStart,
    postsFromEnd,
    totalCount: paginationTotalCount,
    currentPage,
    setCurrentPage,
    setNavigationDirection,
    isLoading: isPaginationLoading,
  } = normalPagination;

  // Track previous filter key to save cache when switching
  const prevFilterKeyRef = useRef<string | null>(null);

  // Save filter data to cache when switching away from a filter
  useEffect(() => {
    const prevKey = prevFilterKeyRef.current;

    // If we're switching away from a filter (and it's not initial mount)
    if (prevKey !== null && prevKey !== activeFilterKey && postsFromStart.length > 0) {
      // Save the data we had under the previous filter key
      saveToFilterCache(prevKey, {
        postsFromStart,
        postsFromEnd,
        totalCount: paginationTotalCount,
      });
    }

    // Update ref for next change
    prevFilterKeyRef.current = activeFilterKey;
  }, [activeFilterKey, postsFromStart, postsFromEnd, paginationTotalCount, saveToFilterCache]);

  async function checkForActiveBatch() {
    try {
      const stored = localStorage.getItem(ACTIVE_BATCH_KEY);
      if (stored) {
        const { batchId: storedBatchId, submittedAt } = JSON.parse(stored);

        // Check if batch is still valid (less than 24 hours old)
        const age = Date.now() - submittedAt;
        if (age > 24 * 60 * 60 * 1000) {
          localStorage.removeItem(ACTIVE_BATCH_KEY);
          return;
        }

        // Resume polling
        setBatchId(storedBatchId);
        setCategorizeStatus('polling');
        setCategorizeMessage(`Resuming batch check... (ID: ${storedBatchId})`);
        startPolling(storedBatchId);
      }
    } catch {
      localStorage.removeItem(ACTIVE_BATCH_KEY);
    }
  }

  function startPolling(id: string) {
    // Clear any existing interval
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
    }

    // Poll every 10 seconds
    pollingIntervalRef.current = window.setInterval(() => {
      checkBatchStatusById(id);
    }, 10000);

    // Also check immediately
    checkBatchStatusById(id);
  }

  function stopPolling() {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  }

  async function loadData() {
    setIsLoading(true);
    try {
      // Initialize image proxy with backend URL
      await initImageProxy();

      // local chrome cache storagedata
      const [localPosts, localCategories, syncStatus] = await Promise.all([
        getPosts(),
        getCategories(), // TODO: currently we don't store categories in chrome cache so it's redundant. We should implement it.
        getSyncStatus(),
      ]);

      setPosts(localPosts);
      setCategories(localCategories);
      setStatus(syncStatus);

      // Check backend connection
      const connected = await api.health();
      setBackendConnected(connected);

      // If connected, fetch cloud data
      if (connected) {
        try {
          const [backendCategories, syncedIdsArray, categorizedIds, uncategorizedCount] = await Promise.all([
            api.getCategories(),
            api.getSyncedInstagramIdsAll(), // this gets ALL instagramIds that are synced to the cloud without limit
            api.getCategorizedPostIds(), // this gets ALL instagramIds that are categorized
            api.getUncategorizedCount(), // this gets ALL uncategorized count
          ]);

          const totalCloud = syncedIdsArray.length;
          setTotalCloudPosts(totalCloud);
          console.log(`[Dashboard] Total cloud posts: ${totalCloud}, pageSize: ${pageSize}`);
          // Note: Initial post loading is now handled by useBidirectionalPagination hook

          // override local categories with backend categories
          setCategories(backendCategories);

          // Track which posts are synced to cloud (by instagramId for accurate matching)
          setSyncedPostIds(new Set(syncedIdsArray));
          setCategorizedPostIds(new Set(categorizedIds));
          setUncategorizedCount(uncategorizedCount);

          // Update sync status if cloud has more posts than local thinks
          if (totalCloud > (syncStatus?.totalPosts || 0)) {
            setStatus(prev => prev ? { ...prev, totalPosts: totalCloud } : {
              lastSync: null,
              totalPosts: totalCloud,
              syncInProgress: false
            });
          }

          // Check if any posts need enriched embeddings
          try {
            const embeddingStatus = await api.getEmbeddingsNeedingRefresh();
            setEmbeddingsNeedingRefresh(embeddingStatus.count);
          } catch {
            // Ignore embedding check errors
          }

          // Check image download needs
          try {
            const settings = await getSettings();
            setStoreImagesEnabled(settings.storeImages);

            if (settings.storeImages) {
              const imageStatus = await api.getImageStorageStatus();
              // Only count images that need download (have valid URL, no local path, not expired)
              const needsDownload = imageStatus.needsDownload || 0;
              setImagesNeedingDownload(needsDownload);
            }
          } catch {
            // Ignore image status check errors
          }

        } catch {
          // Use local categories if backend fetch fails
        }
      }
    } catch (error) {
      console.error('Failed to load data:', error);
    }
    setIsLoading(false);
  }

  // Calculate unsynced count (using instagramId for accurate matching)
  const unsyncedCount = posts.filter(p => !syncedPostIds.has(p.instagramId)).length;

  // Calculate ACTUAL total posts available based on current view
  const totalAvailablePosts = useMemo(() => {
    if (activeFilterKey !== null) {
      // For filters, use the hook's total count
      return paginationTotalCount;
    }
    if (filterUnsynced) {
      return unsyncedCount;
    }
    if (filterUncategorized) {
      return uncategorizedCount;
    }
    // Normal view: unsynced local + synced cloud
    return unsyncedCount + totalCloudPosts;
  }, [activeFilterKey, paginationTotalCount, filterUnsynced, unsyncedCount, filterUncategorized, uncategorizedCount, totalCloudPosts]);

  // Total pages from hook or calculated
  const totalPages = useMemo(() => {
    if (activeFilterKey !== null || (!filterUnsynced && !filterUncategorized)) {
      // Use hook's totalPages for normal/filter views
      return normalPagination.totalPages;
    }
    // For unsynced/uncategorized client-side filters, calculate
    return Math.max(1, Math.ceil(totalAvailablePosts / pageSize));
  }, [activeFilterKey, filterUnsynced, filterUncategorized, normalPagination.totalPages, totalAvailablePosts, pageSize]);

  const pageStartIdx = (currentPage - 1) * pageSize;
  const pageEndIdx = currentPage * pageSize;

  // Get paginated posts based on current view
  const paginatedPosts = useMemo(() => {
    // Client-side filters (don't use hook)
    if (filterUnsynced) {
      const unsyncedPosts = posts.filter(p => !syncedPostIds.has(p.instagramId));
      const sliced = unsyncedPosts.slice(pageStartIdx, pageEndIdx);
      console.log(`[Pagination] FILTER-UNSYNCED: showing ${sliced.length} of ${unsyncedPosts.length} posts`);
      return sliced;
    }

    if (filterUncategorized) {
      // Combine loaded cloud posts + local unsynced
      const loadedCloudPosts = [...postsFromStart];
      const startIds = new Set(postsFromStart.map(p => p.instagramId));
      for (const p of postsFromEnd) {
        if (!startIds.has(p.instagramId)) {
          loadedCloudPosts.push(p);
        }
      }
      const localUnsynced = posts.filter(p => !syncedPostIds.has(p.instagramId));
      const allUncategorized = [
        ...localUnsynced,
        ...loadedCloudPosts.filter(p => !categorizedPostIds.has(p.instagramId))
      ];
      const sliced = allUncategorized.slice(pageStartIdx, pageEndIdx);
      console.log(`[Pagination] FILTER-UNCATEGORIZED: showing ${sliced.length} of ${allUncategorized.length} loaded (${uncategorizedCount} total)`);
      return sliced;
    }

    // Normal view or filter view: use hook's getPageItems()
    const items = normalPagination.getPageItems();
    const source = activeFilterKey !== null ? `FILTER-${activeFilterKey}` : 'NORMAL';
    console.log(`[Pagination] ${source}: showing ${items.length} posts on page ${currentPage}`);
    return items;
  }, [
    filterUnsynced, filterUncategorized, activeFilterKey,
    posts, syncedPostIds, categorizedPostIds, uncategorizedCount,
    postsFromStart, postsFromEnd,
    pageStartIdx, pageEndIdx, currentPage,
    normalPagination
  ]);

  // Check if current page data is still loading
  const isPageDataLoading = normalPagination.isPageLoading && !filterUnsynced && !filterUncategorized;

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [filterUnsynced, filterUncategorized, pageSize]);

  // Clear filter when search query is cleared
  useEffect(() => {
    if (!searchQuery.trim() && activeFilterKey !== null) {
      setActiveFilterKey(null);
    }
  }, [searchQuery, activeFilterKey]);

  // Handle post click to open detail modal
  // Handle expired image - mark in backend so we know to refresh it
  async function handleImageExpired(postId: string) {
    if (backendConnected) {
      try {
        await api.markImageExpired(postId);
        console.log(`[InstaMap] Marked image expired for post ${postId}`);
      } catch (error) {
        console.error('Failed to mark image expired:', error);
      }
    }
  }

  async function handlePostClick(post: InstagramPost) {
    // Fetch full post data from backend to get reasons and latest data
    if (backendConnected && syncedPostIds.has(post.instagramId)) {
      try {
        const backendPost = await api.getPost(post.id);
        if (backendPost) {
          // Merge backend data with local post (backend has reasons, local has imageUrl)
          setSelectedPost({
            ...post,
            ...backendPost,
            imageUrl: post.imageUrl || backendPost.imageUrl, // Prefer local imageUrl
          });
        } else {
          setSelectedPost(post);
        }

        // Fetch categories
        const cats = await api.getPostCategories(post.id);
        setPostCategories(cats.map(c => c.name));
      } catch (error) {
        console.error('Failed to fetch post data:', error);
        setSelectedPost(post);
        setPostCategories(post.categories || []);
      }
    } else {
      setSelectedPost(post);
      setPostCategories(post.categories || []);
    }
  }

  // Handle saving post metadata
  async function handleSavePostMetadata(postId: string, updates: Partial<InstagramPost>) {
    if (!backendConnected) {
      throw new Error('Backend not connected');
    }
    await api.updatePostMetadata(postId, {
      location: updates.location,
      venue: updates.venue,
      eventDate: updates.eventDate,
      hashtags: updates.hashtags,
    });
    // Update local state
    setPosts(prev => prev.map(p =>
      p.id === postId ? { ...p, ...updates } : p
    ));
    if (selectedPost?.id === postId) {
      setSelectedPost(prev => prev ? { ...prev, ...updates } : null);
    }
  }

  // Selection handlers
  function handlePostSelect(postId: string, selected: boolean, shiftKey: boolean = false) {
    // Shift+click for range selection
    if (shiftKey && lastSelectedPostId && selected) {
      const postIds = posts.map(p => p.id);
      const lastIndex = postIds.indexOf(lastSelectedPostId);
      const currentIndex = postIds.indexOf(postId);

      if (lastIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        const rangeIds = postIds.slice(start, end + 1);

        setSelectedPostIds(prev => {
          const newSet = new Set(prev);
          rangeIds.forEach(id => newSet.add(id));
          return newSet;
        });
        return;
      }
    }

    // Normal single selection
    setSelectedPostIds(prev => {
      const newSet = new Set(prev);
      if (selected) {
        newSet.add(postId);
      } else {
        newSet.delete(postId);
      }
      return newSet;
    });

    // Track last selected for shift+click
    if (selected) {
      setLastSelectedPostId(postId);
    }
  }

  function selectAllPosts() {
    // Select all visible (paginated) posts
    setSelectedPostIds(new Set(paginatedPosts.map(p => p.id)));
  }

  function clearSelection() {
    setSelectedPostIds(new Set());
  }

  function toggleSelectionMode() {
    setSelectionMode(!selectionMode);
    if (selectionMode) {
      // Exiting selection mode - clear selection
      clearSelection();
      setLastSelectedPostId(null);
    }
  }

  async function handleSyncToCloud(e?: React.MouseEvent) {
    e?.preventDefault();
    e?.stopPropagation();

    if (!backendConnected) {
      alert('Backend not connected. Please start the backend server.');
      return;
    }

    if (posts.length === 0) {
      alert('No posts to sync. Collect some posts first!');
      return;
    }

    setIsSyncing(true);
    setSyncMessage(null);

    try {
      const doSync = unsyncedCount > 0;
      const doImages = storeImagesEnabled && imagesNeedingDownload > 0;

      // Track progress for both operations
      let syncProgress = { synced: 0, total: unsyncedCount };
      let imageProgress = { uploaded: 0, total: imagesNeedingDownload, failed: 0 };

      const updateProgress = () => {
        const parts: string[] = [];
        if (doSync) parts.push(`Syncing ${syncProgress.synced}/${syncProgress.total}`);
        if (doImages) parts.push(`📷 ${imageProgress.uploaded}/${imageProgress.total}`);
        setSyncMessage(parts.join(' • ') + '...');
      };

      if (doSync || doImages) {
        updateProgress();
      }

      // Prepare image upload task (get IDs needing images before parallel execution)
      let postsNeedingImages: typeof posts = [];
      if (doImages) {
        const idsNeeding = await api.getInstagramIdsNeedingImages();
        postsNeedingImages = posts.filter(p => idsNeeding.includes(p.instagramId));
        imageProgress.total = postsNeedingImages.length;
        updateProgress();
      }

      // Run sync and image upload in parallel
      const syncTask = doSync
        ? api.syncPosts(posts, undefined, undefined, (synced) => {
          syncProgress.synced = synced;
          updateProgress();
        })
        : Promise.resolve({ synced: 0 });

      const imageTask = doImages && postsNeedingImages.length > 0
        ? api.uploadImagesFromPosts(postsNeedingImages, (uploaded, total) => {
          imageProgress.uploaded = uploaded;
          imageProgress.total = total;
          updateProgress();
        })
        : Promise.resolve({ uploaded: 0, failed: 0 });

      const [syncResult, imageResult] = await Promise.all([syncTask, imageTask]);
      imageProgress.failed = imageResult.failed;

      // Build final message
      const resultParts: string[] = [];
      if (doSync && syncResult.synced > 0) resultParts.push(`✅ Synced ${syncResult.synced} posts`);
      if (doImages && imageResult.uploaded > 0) {
        if (imageResult.failed > 0) {
          resultParts.push(`⚠️ Uploaded ${imageResult.uploaded}, failed ${imageResult.failed}`);
        } else {
          resultParts.push(`✅ Uploaded ${imageResult.uploaded} images`);
        }
      }
      if (resultParts.length > 0) {
        setSyncMessage(resultParts.join(' • '));
      } else {
        setSyncMessage('✅ Already up to date');
      }

      // Invalidate filter cache since data changed
      invalidateFilterCache();

      // Reload to update sync status
      await loadData();

      // Exit selection mode after successful sync
      setSelectionMode(false);
      setSelectedPostIds(new Set());

      setTimeout(() => setSyncMessage(null), 5000);
    } catch (error) {
      console.error('Sync failed:', error);
      setSyncMessage('❌ Sync failed');
      setTimeout(() => setSyncMessage(null), 3000);
    }

    setIsSyncing(false);
  }

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) {
      // Clear search and return to normal view
      setActiveFilterKey(null);
      setCurrentPage(1);
      return;
    }

    // Check for category: prefix
    const categoryMatch = searchQuery.match(/^category:(.+)$/i);
    if (categoryMatch) {
      const categoryName = categoryMatch[1].trim();
      await filterByCategory(categoryName);
      return;
    }

    // Set search filter - hook handles the rest
    // For search, hook's key change triggers new data load
    setActiveFilterKey(`search:${searchQuery}`);
    setCurrentPage(1);
  }

  async function filterByCategory(categoryName: string) {
    if (!backendConnected) {
      alert('Category filter requires backend connection.');
      return;
    }

    // Find category by name
    const category = categories.find(c =>
      c.name.toLowerCase() === categoryName.toLowerCase()
    );

    if (!category) {
      alert(`Category "${categoryName}" not found.`);
      return;
    }

    // Save current normal view data to cache before switching
    if (activeFilterKey === null && postsFromStart.length > 0) {
      saveToFilterCache('normal', {
        postsFromStart,
        postsFromEnd,
        totalCount: totalCloudPosts,
      });
    }

    // Set category filter - hook handles the rest
    // Hook will use cached data or fetch from API
    setActiveFilterKey(`category:${categoryName}`);
    setCurrentPage(1);
  }

  // Check if categorization is in progress (prevent multiple runs)
  const isCategorizationBusy = categorizeStatus === 'processing' || categorizeStatus === 'polling';

  async function handleAutoCategorizeClick() {
    if (isCategorizationBusy || isCalculatingStats) {
      alert('Categorization already in progress. Please wait for it to complete.');
      return;
    }

    if (!backendConnected) {
      alert('Backend not connected. Please start the backend server.');
      return;
    }

    // Calculate stats
    setIsCalculatingStats(true);
    try {
      const [cloudPosts, categorizedIds] = await Promise.all([
        api.getPosts({ limit: 10000 }),
        api.getCategorizedPostIds(),
      ]);
      const cloudPostIds = new Set(cloudPosts.map(p => p.id));
      const categorizedSet = new Set(categorizedIds);

      // Determine which posts to consider
      let postsToConsider: string[];
      if (selectedPostIds.size > 0) {
        // User has selected specific posts
        postsToConsider = Array.from(selectedPostIds);
      } else {
        // All posts
        postsToConsider = posts.map(p => p.id);
      }

      // Count unsynced posts (from the posts to consider)
      const unsyncedInSelection = postsToConsider.filter(id => !cloudPostIds.has(id)).length;

      // Count synced posts
      const syncedPosts = postsToConsider.filter(id => cloudPostIds.has(id));

      // Count uncategorized posts (synced but not categorized)
      const uncategorizedPosts = syncedPosts.filter(id => !categorizedSet.has(id));
      const uncategorizedCount = uncategorizedPosts.length;

      // Count already categorized posts (for re-categorization)
      const alreadyCategorizedPosts = syncedPosts.filter(id => categorizedSet.has(id));
      const alreadyCategorizedCount = alreadyCategorizedPosts.length;

      // Total posts to process (all synced posts when selected)
      const totalToProcess = syncedPosts.length;

      // Estimate cost: Claude 4.5 Haiku
      // Based on actual usage: $3 for 3,424 posts batch = ~$0.00088 per post
      // Batch API: $0.50/1M input + $2.50/1M output
      // Regular API: $1.00/1M input + $5.00/1M output (2x batch)
      // Per post estimate: ~750 input tokens, ~200 output tokens
      const inputTokensPerPost = 750;
      const outputTokensPerPost = 200;

      // Batch pricing (based on TOTAL posts to process)
      const batchInputCost = (totalToProcess * inputTokensPerPost / 1000000) * 0.50;
      const batchOutputCost = (totalToProcess * outputTokensPerPost / 1000000) * 2.50;
      const asyncCost = batchInputCost + batchOutputCost;

      // Regular pricing (2x batch for input, 2x for output)
      const realtimeInputCost = (totalToProcess * inputTokensPerPost / 1000000) * 1.00;
      const realtimeOutputCost = (totalToProcess * outputTokensPerPost / 1000000) * 5.00;
      const realtimeCost = realtimeInputCost + realtimeOutputCost;

      const formatCost = (cost: number) => cost < 0.01 ? '< $0.01' : `~$${cost.toFixed(2)}`;

      setCategorizeStats({
        unsynced: unsyncedInSelection,
        uncategorized: uncategorizedCount,
        alreadyCategorized: alreadyCategorizedCount,
        totalToProcess: totalToProcess,
        estimatedCost: formatCost(realtimeCost),
        realtimeCost: formatCost(realtimeCost),
        asyncCost: formatCost(asyncCost),
      });

      // Show choice modal
      setCategorizeStatus('choosing');
      setShowCategorizeModal(true);

    } catch {
      alert('Could not check cloud status. Make sure backend is running.');
      return;
    }
  }

  async function handleCategorizeOption(mode: 'realtime' | 'async') {
    setCategorizeStatus('processing');

    // Get posts to categorize - either selected (including re-categorization) or all uncategorized
    let postIdsToProcess: string[];
    if (selectedPostIds.size > 0) {
      // Use ALL selected posts that are synced (including already-categorized for re-categorization)
      // Need to find posts by id and check their instagramId
      const selectedPosts = posts.filter(p => selectedPostIds.has(p.id));
      postIdsToProcess = selectedPosts
        .filter(p => syncedPostIds.has(p.instagramId))
        .map(p => p.id);
    } else {
      // Use all synced posts that aren't categorized
      postIdsToProcess = posts
        .filter(p => syncedPostIds.has(p.instagramId) && !categorizedPostIds.has(p.instagramId))
        .map(p => p.id);
    }

    if (postIdsToProcess.length === 0) {
      setCategorizeStatus('error');
      setCategorizeMessage('No posts to categorize. Make sure posts are synced first.');
      return;
    }

    setCategorizeMessage(mode === 'realtime'
      ? `Processing ${postIdsToProcess.length} posts... This may take a minute.`
      : `Submitting ${postIdsToProcess.length} posts to batch...`);

    try {
      const result = await api.autoCategorize(postIdsToProcess, mode);

      if (mode === 'async' && result.batchId) {
        // Save to storage so we can resume polling after modal close or page refresh
        localStorage.setItem(ACTIVE_BATCH_KEY, JSON.stringify({
          batchId: result.batchId,
          submittedAt: Date.now(),
          requestCount: result.requestCount,
        }));

        setBatchId(result.batchId);
        setCategorizeStatus('polling');
        setCategorizeMessage(`Batch submitted! Processing ${result.requestCount} posts in background.\nBatch ID: ${result.batchId}\n\nThis saves 50% on API costs. You can close this - we'll keep checking.`);

        // Start polling
        startPolling(result.batchId);
      } else {
        setCategorizeStatus('done');
        setCategorizeMessage(`✅ Done! Categorized ${result.categorized} of ${result.total} posts.`);
        invalidateFilterCache();
        loadData();
        // Exit selection mode after successful categorization
        setSelectionMode(false);
        setSelectedPostIds(new Set());
      }
    } catch (error) {
      console.error('Auto-categorize failed:', error);
      setCategorizeStatus('error');
      setCategorizeMessage('❌ Failed to categorize posts. Check console for details.');
    }
  }

  async function checkBatchStatusById(id: string) {
    try {
      const result = await api.getBatchStatus(id);

      if (result.status === 'ended') {
        // Clear storage and stop polling
        localStorage.removeItem(ACTIVE_BATCH_KEY);
        stopPolling();

        setCategorizeStatus('done');
        setCategorizeMessage(`✅ Batch complete! Categorized ${result.categorized} of ${result.total} posts.`);
        setShowCategorizeModal(true); // Re-open modal to show completion
        setBatchId(null);
        invalidateFilterCache();
        loadData();
        // Exit selection mode after successful batch categorization
        setSelectionMode(false);
        setSelectedPostIds(new Set());
      } else if (result.status === 'processing_results') {
        // Batch is done on Anthropic side, but backend is processing results
        setCategorizeMessage(`📦 Batch complete! Processing ${result.progress?.total || '?'} results... This may take a few minutes.`);
      } else if (result.status === 'canceled' || result.status === 'canceling' || result.status === 'failed' || result.status === 'expired') {
        // Clear on failure too
        localStorage.removeItem(ACTIVE_BATCH_KEY);
        stopPolling();

        setCategorizeStatus('error');
        setCategorizeMessage(`❌ Batch ${result.status}. Please try again.`);
        setShowCategorizeModal(true); // Re-open modal to show error
        setBatchId(null);
      } else {
        setCategorizeMessage(`⏳ Still processing... ${result.progress?.completed || 0}/${result.progress?.total || '?'} done`);
      }
    } catch (error) {
      console.error('Failed to check batch status:', error);
      // Don't clear on network error - might be temporary
    }
  }

  async function checkBatchStatus() {
    if (!batchId) return;
    await checkBatchStatusById(batchId);
  }

  function closeCategorizeModal() {
    if (categorizeStatus === 'processing') return; // Don't close while actively submitting

    // If polling, close modal but keep polling in background
    if (categorizeStatus === 'polling') {
      setShowCategorizeModal(false);
      return;
    }

    // For done/error/choosing, reset everything
    setShowCategorizeModal(false);
    setCategorizeStatus('idle');
    setCategorizeMessage('');
    setShowManualBatchInput(false);
    setManualBatchId('');
  }

  async function handleManualBatchRecover() {
    const trimmedId = manualBatchId.trim();
    if (!trimmedId) {
      alert('Please enter a batch ID');
      return;
    }

    // Save to storage and start polling
    localStorage.setItem(ACTIVE_BATCH_KEY, JSON.stringify({
      batchId: trimmedId,
      submittedAt: Date.now(),
      requestCount: 0, // Unknown
    }));

    setBatchId(trimmedId);
    setCategorizeStatus('polling');
    setCategorizeMessage(`Checking batch ${trimmedId}...`);
    setShowCategorizeModal(true);
    setShowManualBatchInput(false);
    setManualBatchId('');

    // Start polling
    startPolling(trimmedId);
  }

  async function handleRefreshEmbeddings() {
    if (isRefreshingEmbeddings) return;

    setIsRefreshingEmbeddings(true);
    setEmbeddingMessage('Starting...');

    try {
      const result = await api.regenerateEmbeddings();
      setEmbeddingMessage(`🔄 ${result.message}`);

      // Poll for completion
      const pollInterval = setInterval(async () => {
        try {
          const status = await api.getEmbeddingStatus();
          if (status.status === 'done') {
            clearInterval(pollInterval);
            setEmbeddingMessage(`✅ Updated ${status.updated} embeddings`);
            setEmbeddingsNeedingRefresh(0);
            setIsRefreshingEmbeddings(false);
            setTimeout(() => setEmbeddingMessage(null), 5000);
          } else if (status.status === 'running') {
            setEmbeddingMessage(`🔄 Processing ${status.processed}/${status.total}...`);
          }
        } catch {
          clearInterval(pollInterval);
          setIsRefreshingEmbeddings(false);
        }
      }, 2000);
    } catch (error) {
      console.error('Failed to refresh embeddings:', error);
      setEmbeddingMessage('❌ Failed to refresh embeddings');
      setIsRefreshingEmbeddings(false);
      setTimeout(() => setEmbeddingMessage(null), 3000);
    }
  }

  const renderContent = () => {
    switch (view) {
      case 'chat':
        return <Chat backendConnected={backendConnected} />;
      case 'categories':
        return (
          <Categories
            categories={categories}
            onCategorySelect={async (category) => {
              setSearchQuery(`category:${category.name}`);
              setView('posts');
              // Filter immediately
              await filterByCategory(category.name);
            }}
            onRefresh={loadData}
          />
        );
      case 'map':
        return <MapView backendConnected={backendConnected} />;
      case 'posts':
      default:
        return (
          <div>
            <form onSubmit={handleSearch} className="search-bar">
              {/* Category bubble or search input */}
              {searchQuery.match(/^category:(.+)$/i) ? (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  flex: 1,
                  minWidth: 0,
                  padding: '0 12px',
                  background: '#f5f5f5',
                  borderRadius: '8px',
                  height: '40px',
                }}>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      background: getCategoryColor(searchQuery.match(/^category:(.+)$/i)![1]),
                      color: 'white',
                      padding: '6px 12px',
                      borderRadius: '20px',
                      fontSize: '13px',
                      fontWeight: 500,
                    }}
                  >
                    {searchQuery.match(/^category:(.+)$/i)![1]}
                    <button
                      type="button"
                      onClick={() => {
                        setSearchQuery('');
                        setActiveFilterKey(null);
                        setCurrentPage(1);
                      }}
                      style={{
                        background: 'rgba(255,255,255,0.3)',
                        border: 'none',
                        borderRadius: '50%',
                        width: '18px',
                        height: '18px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        padding: 0,
                        color: 'white',
                        fontSize: '14px',
                        lineHeight: 1,
                      }}
                      title="Clear filter"
                    >
                      ×
                    </button>
                  </span>
                </div>
              ) : (
                <div style={{ position: 'relative', flex: 1, display: 'flex' }}>
                  <input
                    type="text"
                    className="search-input"
                    placeholder={backendConnected
                      ? "Search posts semantically..."
                      : "Search posts..."}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    style={{ paddingRight: searchQuery ? '32px' : undefined }}
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchQuery('');
                        setActiveFilterKey(null);
                        setCurrentPage(1);
                      }}
                      title="Clear search"
                      style={{
                        position: 'absolute',
                        right: '8px',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        background: 'none',
                        border: 'none',
                        color: '#999',
                        fontSize: '18px',
                        cursor: 'pointer',
                        padding: '4px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              )}
              <button type="submit" className="btn btn-primary" style={{ display: searchQuery.match(/^category:(.+)$/i) ? 'none' : undefined }}>
                🔍 Search
              </button>

              {/* Filter toggles */}
              <button
                type="button"
                className="btn"
                onClick={() => setFilterUnsynced(!filterUnsynced)}
                title="Show only posts not synced to cloud"
                style={{
                  background: filterUnsynced ? '#ff6b6b' : undefined,
                  color: filterUnsynced ? 'white' : undefined,
                  position: 'relative',
                }}
              >
                📱 Unsynced
                {filterUnsynced && unsyncedCount > 0 && (
                  <span style={{
                    position: 'absolute',
                    top: '-6px',
                    right: '-6px',
                    background: 'white',
                    color: '#ff6b6b',
                    borderRadius: '50%',
                    width: '18px',
                    height: '18px',
                    fontSize: '10px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 'bold',
                  }}>
                    {unsyncedCount > 99 ? '99+' : unsyncedCount}
                  </span>
                )}
              </button>

              <button
                type="button"
                className="btn"
                onClick={() => setFilterUncategorized(!filterUncategorized)}
                title="Show only posts not yet categorized (both synced and unsynced)"
                style={{
                  background: filterUncategorized ? '#ffab00' : undefined,
                  color: filterUncategorized ? 'white' : undefined,
                  position: 'relative',
                }}
              >
                🏷️ Uncategorized
                {filterUncategorized && uncategorizedCount > 0 && (
                  <span style={{
                    position: 'absolute',
                    top: '-6px',
                    right: '-6px',
                    background: 'white',
                    color: '#ffab00',
                    borderRadius: '50%',
                    width: '18px',
                    height: '18px',
                    fontSize: '10px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 'bold',
                  }}>
                    {uncategorizedCount > 99 ? '99+' : uncategorizedCount}
                  </span>
                )}
              </button>

              {backendConnected && (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={(e) => handleSyncToCloud(e)}
                    disabled={isSyncing || posts.length === 0 || (unsyncedCount === 0 && imagesNeedingDownload === 0)}
                    title={
                      unsyncedCount > 0
                        ? `Sync ${unsyncedCount} unsynced posts to cloud`
                        : imagesNeedingDownload > 0
                          ? `Download ${imagesNeedingDownload} images`
                          : 'All posts and images synced'
                    }
                    style={{ position: 'relative' }}
                  >
                    {isSyncing
                      ? '⏳ Syncing...'
                      : unsyncedCount === 0 && imagesNeedingDownload === 0
                        ? '✅ All Synced'
                        : unsyncedCount > 0
                          ? '☁️ Sync to Cloud'
                          : '📷 Download Images'}
                    {(unsyncedCount > 0 || imagesNeedingDownload > 0) && !isSyncing && (
                      <span style={{
                        position: 'absolute',
                        top: '-8px',
                        right: '-8px',
                        background: unsyncedCount > 0 ? 'var(--error)' : '#0ea5e9',
                        color: 'white',
                        borderRadius: '50%',
                        width: '20px',
                        height: '20px',
                        fontSize: '11px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}>
                        {(unsyncedCount > 0 ? unsyncedCount : imagesNeedingDownload) > 99 ? '99+' : (unsyncedCount > 0 ? unsyncedCount : imagesNeedingDownload)}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      if (isCategorizationBusy) {
                        setShowCategorizeModal(true); // Re-open modal to view status
                      } else {
                        handleAutoCategorizeClick();
                      }
                    }}
                    title={isCategorizationBusy ? 'Click to view progress' : 'Auto-categorize posts with AI'}
                    style={isCategorizationBusy ? { background: '#ffab00', color: '#000' } : undefined}
                  >
                    {isCategorizationBusy ? '⏳ Processing... (view)' : '✨ Auto-Categorize'}
                  </button>
                </>
              )}
              {syncMessage && (
                <span style={{
                  padding: '8px 12px',
                  borderRadius: '8px',
                  background: syncMessage.includes('✅') ? 'var(--success)' : 'var(--error)',
                  color: 'white',
                  fontSize: '13px',
                }}>
                  {syncMessage}
                </span>
              )}
            </form>

            {posts.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">📭</div>
                <h3>No posts yet</h3>
                <p>Go to your Instagram saved posts and click "Collect Posts" in the extension popup.</p>
              </div>
            ) : (isPaginationLoading || (paginationTotalCount > 0 && postsFromStart.length === 0 && postsFromEnd.length === 0)) ? (
              <div className="empty-state">
                <div className="empty-state-icon">⏳</div>
                <h3>Loading...</h3>
              </div>
            ) : (postsFromStart.length === 0 && postsFromEnd.length === 0) ? (
              <div className="empty-state">
                <div className="empty-state-icon">🔍</div>
                <h3>No matching posts</h3>
                <p>
                  {filterUnsynced && filterUncategorized
                    ? 'No posts match both filters.'
                    : filterUnsynced
                      ? 'All posts are synced to cloud!'
                      : filterUncategorized
                        ? 'All synced posts are categorized!'
                        : 'Try adjusting your filters.'}
                </p>
                <button
                  className="btn"
                  onClick={() => {
                    setFilterUnsynced(false);
                    setFilterUncategorized(false);
                  }}
                  style={{ marginTop: '16px' }}
                >
                  Clear Filters
                </button>
              </div>
            ) : (
              <>
                {/* Selection & Pagination row */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '16px',
                  padding: '12px',
                  background: 'var(--bg-secondary)',
                  borderRadius: '8px',
                }}>
                  {/* Left: Selection controls */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <button
                      type="button"
                      className="btn"
                      onClick={toggleSelectionMode}
                      title={selectionMode ? 'Exit selection mode' : 'Select posts'}
                      style={{
                        padding: '6px 12px',
                        fontSize: '13px',
                        background: selectionMode ? 'var(--primary)' : undefined,
                        color: selectionMode ? 'white' : undefined,
                      }}
                    >
                      {selectionMode ? 'Clear Selection' : '☑️ Select'}
                    </button>
                    {selectionMode && (
                      <>
                        <span
                          onClick={selectAllPosts}
                          style={{
                            color: 'var(--primary)',
                            cursor: 'pointer',
                            fontSize: '13px',
                            textDecoration: 'underline',
                          }}
                        >
                          All
                        </span>
                        <span
                          onClick={clearSelection}
                          style={{
                            color: 'var(--text-secondary)',
                            cursor: 'pointer',
                            fontSize: '13px',
                            textDecoration: 'underline',
                          }}
                        >
                          Unselect All
                        </span>
                        {selectedPostIds.size > 0 && (
                          <span style={{
                            padding: '4px 10px',
                            background: 'var(--primary)',
                            color: 'white',
                            borderRadius: '12px',
                            fontSize: '12px',
                          }}>
                            {selectedPostIds.size} selected
                          </span>
                        )}
                      </>
                    )}
                  </div>

                  {/* Right: Pagination info & controls */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
                      Showing {((currentPage - 1) * pageSize) + 1}-{Math.min(currentPage * pageSize, totalAvailablePosts)} of {totalAvailablePosts}
                    </span>
                    <select
                      value={pageSize}
                      onChange={(e) => setPageSize(Number(e.target.value))}
                      style={{
                        padding: '6px 12px',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        background: 'white',
                        fontSize: '13px',
                      }}
                    >
                      {PAGE_SIZE_OPTIONS.map(size => (
                        <option key={size} value={size}>{size} per page</option>
                      ))}
                    </select>
                    {totalPages > 1 && (
                      <>
                        <button
                          className="btn"
                          onClick={() => { setNavigationDirection('forward'); setCurrentPage(1); }}
                          disabled={currentPage === 1}
                          style={{ padding: '6px 12px', fontSize: '13px' }}
                        >
                          ⏮️
                        </button>
                        <button
                          className="btn"
                          onClick={() => { setNavigationDirection('backward'); setCurrentPage(p => Math.max(1, p - 1)); }}
                          disabled={currentPage === 1}
                          style={{ padding: '6px 12px', fontSize: '13px' }}
                        >
                          ◀️
                        </button>
                        <span style={{ fontSize: '13px' }}>
                          {currentPage}/{totalPages}
                        </span>
                        <button
                          className="btn"
                          onClick={() => { setNavigationDirection('forward'); setCurrentPage(p => Math.min(totalPages, p + 1)); }}
                          disabled={currentPage === totalPages}
                          style={{ padding: '6px 12px', fontSize: '13px' }}
                        >
                          ▶️
                        </button>
                        <button
                          className="btn"
                          onClick={() => { setNavigationDirection('backward'); setCurrentPage(totalPages); }}
                          disabled={currentPage === totalPages}
                          style={{ padding: '6px 12px', fontSize: '13px' }}
                        >
                          ⏭️
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {isPageDataLoading ? (
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '48px',
                    gap: '16px',
                  }}>
                    <div style={{ fontSize: '32px' }}>⏳</div>
                    <p style={{ color: 'var(--text-secondary)' }}>Loading page {currentPage}...</p>
                  </div>
                ) : (
                  <div className="posts-grid">
                    {paginatedPosts.map((post, idx) => (
                      <PostCard
                        key={`${currentPage}-${idx}-${post.id}`}
                        post={post}
                        onClick={() => handlePostClick(post)}
                        isSynced={syncedPostIds.has(post.instagramId)}
                        isCategorized={categorizedPostIds.has(post.instagramId)}
                        hasLocalImage={!!post.localImagePath}
                        selectionMode={selectionMode}
                        isSelected={selectedPostIds.has(post.id)}
                        onSelect={handlePostSelect}
                        onImageExpired={handleImageExpired}
                      />
                    ))}
                  </div>
                )}

                {/* Pagination controls - bottom */}
                {totalPages > 1 && (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginTop: '24px',
                    gap: '8px',
                  }}>
                    <button
                      className="btn"
                      onClick={() => { setNavigationDirection('backward'); setCurrentPage(p => Math.max(1, p - 1)); }}
                      disabled={currentPage === 1}
                    >
                      ◀️ Previous
                    </button>
                    <span style={{ padding: '0 16px' }}>
                      Page {currentPage} of {totalPages}
                    </span>
                    <button
                      className="btn"
                      onClick={() => { setNavigationDirection('forward'); setCurrentPage(p => Math.min(totalPages, p + 1)); }}
                      disabled={currentPage === totalPages}
                    >
                      Next ▶️
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        );
    }
  };

  return (
    <div className="dashboard">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>🗺️ InstaMap</h1>
        </div>

        <nav>
          <div
            className={`nav-item ${view === 'posts' ? 'active' : ''}`}
            onClick={() => setView('posts')}
          >
            <span>📷</span>
            <span>All Posts</span>
          </div>
          <div
            className={`nav-item ${view === 'categories' ? 'active' : ''}`}
            onClick={() => setView('categories')}
          >
            <span>🏷️</span>
            <span>Categories</span>
          </div>
          <div
            className={`nav-item ${view === 'map' ? 'active' : ''}`}
            onClick={() => setView('map')}
          >
            <span>🗺️</span>
            <span>Map</span>
          </div>
          <div
            className={`nav-item ${view === 'chat' ? 'active' : ''}`}
            onClick={() => setView('chat')}
          >
            <span>💬</span>
            <span>Chat with AI</span>
          </div>
        </nav>

        <div style={{ marginTop: 'auto', padding: '16px 0' }}>
          <div className="status-indicators">
            <div className={`status-item ${backendConnected ? 'active' : ''}`}>
              <span className="status-dot"></span>
              <span>{backendConnected ? 'Backend connected' : 'Offline mode'}</span>
            </div>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            {status?.totalPosts ?? posts.length} posts collected
            {status?.lastSync && (
              <div>Last sync: {new Date(status.lastSync).toLocaleString()}</div>
            )}
          </div>

          {/* Embedding refresh button - only show if needed */}
          {backendConnected && embeddingsNeedingRefresh > 0 && (
            <button
              onClick={handleRefreshEmbeddings}
              disabled={isRefreshingEmbeddings}
              style={{
                marginTop: '12px',
                width: '100%',
                padding: '8px 12px',
                fontSize: '12px',
                background: isRefreshingEmbeddings ? '#666' : 'var(--secondary)',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: isRefreshingEmbeddings ? 'not-allowed' : 'pointer',
              }}
              title="Regenerate search embeddings with category data for better search results"
            >
              {isRefreshingEmbeddings ? '🔄 Refreshing...' : `🔍 Refresh Search Index (${embeddingsNeedingRefresh})`}
            </button>
          )}
          {embeddingMessage && (
            <div style={{
              marginTop: '8px',
              fontSize: '11px',
              color: embeddingMessage.includes('✅') ? 'var(--success)' : 'var(--text-secondary)',
            }}>
              {embeddingMessage}
            </div>
          )}
        </div>
      </aside>

      <main className="main-content">
        <div className="content-header">
          <h2>
            {view === 'posts' && 'Your Saved Posts'}
            {view === 'chat' && 'Chat with Your Posts'}
            {view === 'categories' && 'Categories'}
            {view === 'map' && 'Map View'}
          </h2>
        </div>

        {isLoading ? (
          <div className="empty-state">
            <div className="empty-state-icon">⏳</div>
            <h3>Loading...</h3>
          </div>
        ) : (
          renderContent()
        )}
      </main>

      {/* Auto-Categorize Modal */}
      {(showCategorizeModal || categorizeStatus === 'done' || categorizeStatus === 'error') && categorizeStatus !== 'idle' && (
        <div className="modal-overlay" onClick={closeCategorizeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            {categorizeStatus === 'choosing' && (
              <>
                <h3>🤖 Auto-Categorize Posts</h3>

                {/* Selection info */}
                {selectedPostIds.size > 0 && (
                  <div style={{
                    background: 'var(--primary)',
                    color: 'white',
                    padding: '8px 12px',
                    borderRadius: '8px',
                    marginBottom: '12px',
                    fontSize: '13px',
                    textAlign: 'center',
                  }}>
                    ☑️ {selectedPostIds.size} posts selected
                  </div>
                )}

                {/* Stats summary */}
                {categorizeStats && (
                  <div style={{
                    background: 'var(--background)',
                    padding: '12px',
                    borderRadius: '8px',
                    marginBottom: '16px',
                    fontSize: '14px',
                  }}>
                    {categorizeStats.unsynced > 0 && (
                      <div style={{
                        color: 'var(--error)',
                        marginBottom: '8px',
                        padding: '8px',
                        background: 'rgba(237, 73, 86, 0.1)',
                        borderRadius: '4px',
                      }}>
                        ⚠️ <strong>{categorizeStats.unsynced}</strong> posts not synced to cloud
                        <br />
                        <span style={{ fontSize: '12px' }}>
                          Sync first to categorize them
                        </span>
                      </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <span>📊 Posts to process:</span>
                      <strong>{categorizeStats.totalToProcess}</strong>
                    </div>
                    {categorizeStats.uncategorized > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: '#666' }}>
                        <span>└ New (uncategorized):</span>
                        <span>{categorizeStats.uncategorized}</span>
                      </div>
                    )}
                    {categorizeStats.alreadyCategorized > 0 && (
                      <div style={{ marginTop: '8px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: '#666' }}>
                          <span>└ Re-categorizing:</span>
                          <span>{categorizeStats.alreadyCategorized}</span>
                        </div>
                        <div style={{
                          marginTop: '6px',
                          padding: '8px',
                          background: 'rgba(0, 149, 246, 0.1)',
                          borderRadius: '4px',
                          fontSize: '12px',
                          color: '#0095f6',
                        }}>
                          ℹ️ Re-categorization will override AI data but keep any manual edits you've made
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {categorizeStats?.totalToProcess === 0 ? (
                  <div style={{ textAlign: 'center', padding: '20px' }}>
                    <p>No posts to categorize!</p>
                    {categorizeStats.unsynced > 0 && (
                      <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '8px' }}>
                        Sync your {categorizeStats.unsynced} local posts first.
                      </p>
                    )}
                    <button
                      className="btn"
                      onClick={closeCategorizeModal}
                      style={{ marginTop: '16px' }}
                    >
                      Close
                    </button>
                  </div>
                ) : (
                  <>
                    <p style={{ marginBottom: '12px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                      Choose processing mode:
                    </p>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      <button
                        className="btn btn-primary"
                        onClick={() => handleCategorizeOption('realtime')}
                        style={{ padding: '16px', textAlign: 'left' }}
                      >
                        <strong>⚡ Real-time</strong>
                        <br />
                        <span style={{ fontSize: '12px', opacity: 0.8 }}>
                          Process now, see results immediately
                        </span>
                        <br />
                        <span style={{ fontSize: '12px', fontWeight: 600, color: '#FFD700' }}>
                          💰 {categorizeStats?.realtimeCost}
                        </span>
                      </button>

                      <button
                        className="btn btn-secondary"
                        onClick={() => handleCategorizeOption('async')}
                        style={{ padding: '16px', textAlign: 'left' }}
                      >
                        <strong>💰 Background (50% cheaper)</strong>
                        <br />
                        <span style={{ fontSize: '12px', opacity: 0.8 }}>
                          Batch processing, results in minutes
                        </span>
                        <br />
                        <span style={{ fontSize: '12px', fontWeight: 600, color: '#7ed957' }}>
                          💰 {categorizeStats?.asyncCost}
                        </span>
                      </button>
                    </div>

                    <button
                      className="btn"
                      onClick={closeCategorizeModal}
                      style={{ marginTop: '16px', width: '100%' }}
                    >
                      Cancel
                    </button>

                    {/* Manual batch recovery */}
                    <div style={{
                      marginTop: '16px',
                      paddingTop: '16px',
                      borderTop: '1px solid var(--border)',
                      textAlign: 'center',
                    }}>
                      {!showManualBatchInput ? (
                        <button
                          className="btn"
                          onClick={() => setShowManualBatchInput(true)}
                          style={{ fontSize: '12px', opacity: 0.7 }}
                        >
                          🔧 Recover lost batch
                        </button>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0 }}>
                            Enter batch ID to recover results:
                          </p>
                          <input
                            type="text"
                            value={manualBatchId}
                            onChange={(e) => setManualBatchId(e.target.value)}
                            placeholder="msgbatch_..."
                            style={{
                              padding: '8px 12px',
                              borderRadius: '8px',
                              border: '1px solid var(--border)',
                              fontSize: '13px',
                              fontFamily: 'monospace',
                            }}
                          />
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <button
                              className="btn btn-primary"
                              onClick={handleManualBatchRecover}
                              style={{ flex: 1 }}
                            >
                              Recover
                            </button>
                            <button
                              className="btn"
                              onClick={() => {
                                setShowManualBatchInput(false);
                                setManualBatchId('');
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            )}

            {categorizeStatus === 'processing' && (
              <>
                <h3>⏳ Processing...</h3>
                <div className="spinner" style={{ margin: '20px auto' }}></div>
                <p style={{ whiteSpace: 'pre-line' }}>{categorizeMessage}</p>
              </>
            )}

            {categorizeStatus === 'polling' && (
              <>
                <h3>📦 Batch Processing</h3>
                <div className="spinner" style={{ margin: '20px auto' }}></div>
                <p style={{ whiteSpace: 'pre-line', marginBottom: '12px' }}>{categorizeMessage}</p>
                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '20px' }}>
                  Auto-checking every 10 seconds...
                </p>
                <button
                  className="btn btn-primary"
                  onClick={checkBatchStatus}
                  style={{ marginRight: '8px' }}
                >
                  🔄 Check Now
                </button>
                <button className="btn" onClick={closeCategorizeModal}>
                  Dismiss (keeps checking)
                </button>
              </>
            )}

            {categorizeStatus === 'done' && (
              <>
                <h3>✅ Complete!</h3>
                <p style={{ marginBottom: '20px' }}>{categorizeMessage}</p>
                <button className="btn btn-primary" onClick={closeCategorizeModal}>
                  Done
                </button>
              </>
            )}

            {categorizeStatus === 'error' && (
              <>
                <h3>❌ Error</h3>
                <p style={{ marginBottom: '20px', color: '#ed4956' }}>{categorizeMessage}</p>
                <button className="btn" onClick={closeCategorizeModal}>
                  Close
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Post Detail Modal */}
      {selectedPost && (() => {
        const currentIndex = paginatedPosts.findIndex(p => p.id === selectedPost.id);
        const hasNext = currentIndex !== -1 && currentIndex < paginatedPosts.length - 1;
        const hasPrevious = currentIndex > 0;

        return (
          <PostDetailModal
            post={selectedPost}
            categories={postCategories}
            onClose={() => {
              setSelectedPost(null);
              setPostCategories([]);
            }}
            onCategoryClick={(category: string) => {
              setSearchQuery(`category:${category}`);
              setView('posts');
              filterByCategory(category);
            }}
            onSave={backendConnected ? handleSavePostMetadata : undefined}
            onNext={hasNext ? () => handlePostClick(paginatedPosts[currentIndex + 1]) : undefined}
            onPrevious={hasPrevious ? () => handlePostClick(paginatedPosts[currentIndex - 1]) : undefined}
            hasNext={hasNext}
            hasPrevious={hasPrevious}
            hasLocalImage={!!selectedPost.localImagePath}
          />
        );
      })()}
    </div>
  );
}
