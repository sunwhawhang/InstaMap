import { useState, useEffect, useRef, useCallback, FormEvent } from 'react';
import { InstagramPost, Category, SyncStatus } from '../shared/types';
import { getPosts, getCategories, getSyncStatus, getSettings } from '../shared/storage';
import { api, initImageProxy } from '../shared/api';
import { Chat } from './Chat';
import { Categories } from './Categories';
import { PostCard } from './PostCard';
import { MapView } from './MapView';
import { PostDetailModal } from './PostDetailModal';

type View = 'posts' | 'chat' | 'categories' | 'map';
type CategorizeStatus = 'idle' | 'choosing' | 'processing' | 'polling' | 'done' | 'error';

const ACTIVE_BATCH_KEY = 'instamap_active_batch';

// Page size options for pagination
const PAGE_SIZE_OPTIONS = [100, 200, 300, 500, 1000] as const;
const MAX_PAGE_SIZE = Math.max(...PAGE_SIZE_OPTIONS);

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

  // Pagination
  const [pageSize, setPageSize] = useState(100);
  const [currentPage, setCurrentPage] = useState(1);

  // Cloud data pagination state - TWO SEPARATE ARRAYS for bidirectional loading
  // postsFromStart: posts loaded from offset 0 onwards (append-only from end)
  // postsFromEnd: posts loaded from the end backwards (append-only from start)
  const [postsFromStart, setPostsFromStart] = useState<InstagramPost[]>([]);
  const [postsFromEnd, setPostsFromEnd] = useState<InstagramPost[]>([]);
  const [totalCloudPosts, setTotalCloudPosts] = useState(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [navigationDirection, setNavigationDirection] = useState<'forward' | 'backward'>('forward');
  // Track how many posts loaded from each end (for prefetch calculations)
  const loadedFromStart = postsFromStart.length;
  const loadedFromEnd = postsFromEnd.length;

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

  // Load more cloud data incrementally for pagination (bidirectional)
  // Uses TWO SEPARATE ARRAYS - appending only, never shifting indices
  const loadMoreCloudData = useCallback(async (count: number, from: 'start' | 'end') => {
    // Check if ranges have met (fully loaded)
    const gap = totalCloudPosts - loadedFromStart - loadedFromEnd;
    if (isLoadingMore || gap <= 0) {
      console.log(`[Pagination] loadMoreCloudData skipped - isLoadingMore: ${isLoadingMore}, gap: ${gap}`);
      return;
    }

    // Don't load more than the gap
    const toLoad = Math.min(count, gap);
    if (toLoad <= 0) return;

    setIsLoadingMore(true);

    try {
      const offset = from === 'start'
        ? loadedFromStart
        : totalCloudPosts - loadedFromEnd - toLoad;

      console.log(`[Pagination] Loading ${toLoad} posts from ${from} (offset: ${offset})...`);
      const loadStart = performance.now();

      const morePosts = await api.getPosts({
        limit: toLoad,
        offset: offset
      });

      console.log(`[Pagination] Loaded ${morePosts.length} posts in ${(performance.now() - loadStart).toFixed(0)}ms`);

      if (morePosts.length === 0) {
        setIsLoadingMore(false);
        return;
      }

      // Append to the appropriate array (NEVER shift existing indices)
      if (from === 'start') {
        // Append to end of postsFromStart array
        setPostsFromStart(prev => {
          console.log(`[Pagination] postsFromStart: ${prev.length} → ${prev.length + morePosts.length}`);
          return [...prev, ...morePosts];
        });
      } else {
        // Prepend to start of postsFromEnd array (loaded posts are older, go at the beginning)
        setPostsFromEnd(prev => {
          console.log(`[Pagination] postsFromEnd: ${prev.length} → ${prev.length + morePosts.length}`);
          return [...morePosts, ...prev];
        });
      }
    } finally {
      setIsLoadingMore(false);
    }
  }, [loadedFromStart, loadedFromEnd, totalCloudPosts, isLoadingMore]);

  // Position-relative prefetch: maintain buffer ahead/behind current position
  // With TWO SEPARATE ARRAYS, prefetching from one direction doesn't affect the other!
  useEffect(() => {
    if (isLoading || isLoadingMore || totalCloudPosts === 0) return;

    // Check if fully loaded (ranges have met)
    const fullyLoaded = loadedFromStart + loadedFromEnd >= totalCloudPosts;
    if (fullyLoaded) {
      console.log(`[Pagination] Prefetch: fully loaded (${loadedFromStart} + ${loadedFromEnd} >= ${totalCloudPosts})`);
      return;
    }

    const prefetchTarget = Math.max(MAX_PAGE_SIZE, 2 * pageSize);

    if (navigationDirection === 'forward') {
      // Target: current position + buffer ahead
      const currentPositionEnd = currentPage * pageSize;
      const targetFromStart = currentPositionEnd + prefetchTarget;
      // Cap at gap boundary (don't overlap with loadedFromEnd)
      const maxFromStart = totalCloudPosts - loadedFromEnd;
      const needed = Math.min(targetFromStart, maxFromStart) - loadedFromStart;
      console.log(`[Pagination] Prefetch forward: page ${currentPage}, target ${targetFromStart}, have ${loadedFromStart}, need ${needed}`);
      if (needed > 0) {
        loadMoreCloudData(needed, 'start');
      }
    } else {
      // Target: current position + buffer behind
      const currentPositionStart = (currentPage - 1) * pageSize;
      const targetFromEnd = totalCloudPosts - currentPositionStart + prefetchTarget;
      // Cap at gap boundary (don't overlap with loadedFromStart)
      const maxFromEnd = totalCloudPosts - loadedFromStart;
      const needed = Math.min(targetFromEnd, maxFromEnd) - loadedFromEnd;
      console.log(`[Pagination] Prefetch backward: page ${currentPage}, target ${targetFromEnd}, have ${loadedFromEnd}, need ${needed}`);
      if (needed > 0) {
        loadMoreCloudData(needed, 'end');
      }
    }
  }, [isLoading, isLoadingMore, currentPage, pageSize, navigationDirection, loadedFromStart, loadedFromEnd, totalCloudPosts, loadMoreCloudData]);

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
          console.log(`[Pagination] Total cloud posts: ${totalCloud}, pageSize: ${pageSize}`);

          // Load first page and last page in parallel for immediate navigation
          // Only load last page if it doesn't overlap with first page (offset >= pageSize)
          const lastPageOffset = Math.max(0, totalCloud - pageSize);
          const shouldLoadLastPage = lastPageOffset >= pageSize; // No overlap

          console.log(`[Pagination] Loading first page (offset: 0) and last page (offset: ${lastPageOffset})...`);
          const loadStart = performance.now();

          const [firstPagePosts, lastPagePosts] = await Promise.all([
            api.getPosts({ limit: pageSize, offset: 0 }),
            shouldLoadLastPage
              ? api.getPosts({ limit: pageSize, offset: lastPageOffset })
              : Promise.resolve([])
          ]);

          console.log(`[Pagination] Initial load complete in ${(performance.now() - loadStart).toFixed(0)}ms - first: ${firstPagePosts.length}, last: ${lastPagePosts.length}`);

          // Store in TWO SEPARATE ARRAYS - no merging, no shifting
          console.log(`[Pagination] Initial: postsFromStart=${firstPagePosts.length} (IDs: ${firstPagePosts.slice(0, 2).map(p => p.instagramId).join(', ')}...)`);
          console.log(`[Pagination] Initial: postsFromEnd=${lastPagePosts.length} (IDs: ${lastPagePosts.slice(0, 2).map(p => p.instagramId).join(', ')}...)`);
          setPostsFromStart(firstPagePosts);
          setPostsFromEnd(lastPagePosts);

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

  // Calculate ACTUAL total posts available (not just loaded)
  // Total = unsynced local posts + all synced cloud posts
  const totalAvailablePosts = filterUnsynced
    ? unsyncedCount
    : filterUncategorized
      ? uncategorizedCount
      : unsyncedCount + totalCloudPosts;

  // Pagination - use actual total for page count so user can navigate to all pages
  const totalPages = Math.ceil(totalAvailablePosts / pageSize);

  const pageStartIdx = (currentPage - 1) * pageSize;
  const pageEndIdx = currentPage * pageSize;

  let paginatedPosts: InstagramPost[];
  let paginationSource: string = '';

  // FILTER MODE: When filters are active, use simple client-side pagination
  if (filterUnsynced) {
    // Unsynced filter: show only local posts not in cloud
    const unsyncedPosts = posts.filter(p => !syncedPostIds.has(p.instagramId));
    paginatedPosts = unsyncedPosts.slice(pageStartIdx, pageEndIdx);
    paginationSource = 'FILTER-UNSYNCED';
    console.log(`[Pagination] Filter: unsynced, showing ${paginatedPosts.length} of ${unsyncedPosts.length} posts`);
  } else if (filterUncategorized) {
    // Uncategorized filter: show posts not in categorizedPostIds
    // This includes: local unsynced + synced but uncategorized cloud posts
    // For now, filter from loaded cloud posts (postsFromStart + postsFromEnd deduplicated)
    const loadedCloudPosts = [...postsFromStart];
    const startIds = new Set(postsFromStart.map(p => p.instagramId));
    for (const p of postsFromEnd) {
      if (!startIds.has(p.instagramId)) {
        loadedCloudPosts.push(p);
      }
    }
    // Add local unsynced posts (they're uncategorized by definition)
    const localUnsynced = posts.filter(p => !syncedPostIds.has(p.instagramId));
    const allUncategorized = [
      ...localUnsynced,
      ...loadedCloudPosts.filter(p => !categorizedPostIds.has(p.instagramId))
    ];
    paginatedPosts = allUncategorized.slice(pageStartIdx, pageEndIdx);
    paginationSource = 'FILTER-UNCATEGORIZED';
    console.log(`[Pagination] Filter: uncategorized, showing ${paginatedPosts.length} of ${allUncategorized.length} loaded (${uncategorizedCount} total)`);
  } else {
    // NO FILTER: Use two-array pagination for cloud posts
    const pageEndFromEnd = totalCloudPosts - pageStartIdx;
    const arraysHaveMet = loadedFromStart + loadedFromEnd >= totalCloudPosts;

    console.log(`[Pagination] === Page ${currentPage} ===`);
    console.log(`[Pagination] postsFromStart.length=${postsFromStart.length}, postsFromEnd.length=${postsFromEnd.length}`);
    console.log(`[Pagination] pageStartIdx=${pageStartIdx}, pageEndIdx=${pageEndIdx}, pageEndFromEnd=${pageEndFromEnd}`);
    console.log(`[Pagination] arraysHaveMet=${arraysHaveMet}, totalCloudPosts=${totalCloudPosts}`);

    if (pageStartIdx < loadedFromStart) {
      paginatedPosts = postsFromStart.slice(pageStartIdx, pageEndIdx);
      paginationSource = 'START';
      console.log(`[Pagination] → Using postsFromStart[${pageStartIdx}:${pageEndIdx}], got ${paginatedPosts.length} posts`);
    } else if (arraysHaveMet && pageStartIdx < totalCloudPosts) {
      if (pageStartIdx < loadedFromStart) {
        const safeEnd = Math.min(pageEndIdx, postsFromStart.length);
        paginatedPosts = postsFromStart.slice(pageStartIdx, safeEnd);
        paginationSource = 'START-MET';
      } else {
        const actualPageEnd = Math.min(pageEndIdx, totalCloudPosts);
        const actualPageSize = actualPageEnd - pageStartIdx;
        const endInEndArray = postsFromEnd.length - (totalCloudPosts - actualPageEnd);
        const startInEndArray = endInEndArray - actualPageSize;
        const safeStart = Math.max(0, startInEndArray);
        const safeEnd = Math.min(postsFromEnd.length, endInEndArray);
        paginatedPosts = postsFromEnd.slice(safeStart, safeEnd);
        paginationSource = 'END-MET';
      }
      console.log(`[Pagination] → Met in middle, source=${paginationSource}, got ${paginatedPosts.length} posts`);
    } else if (pageEndFromEnd <= loadedFromEnd) {
      const actualPageEnd = Math.min(pageEndIdx, totalCloudPosts);
      const actualPageSize = actualPageEnd - pageStartIdx;
      const endInEndArray = postsFromEnd.length - (totalCloudPosts - actualPageEnd);
      const startInEndArray = endInEndArray - actualPageSize;
      const safeStart = Math.max(0, startInEndArray);
      const safeEnd = Math.min(postsFromEnd.length, endInEndArray);
      paginatedPosts = postsFromEnd.slice(safeStart, safeEnd);
      paginationSource = 'END';
      console.log(`[Pagination] → Using postsFromEnd[${safeStart}:${safeEnd}], got ${paginatedPosts.length} posts`);
    } else {
      paginatedPosts = [];
      paginationSource = 'GAP';
      console.log(`[Pagination] → Page is in GAP`);
    }
  }

  // Log first 2 post IDs for debugging
  if (paginatedPosts.length > 0) {
    console.log(`[Pagination] First 2 posts on page ${currentPage}: ${paginatedPosts.slice(0, 2).map(p => p.instagramId).join(', ')}`);
  }

  // Check if current page data is still loading (only for non-filter mode)
  const expectedPostsOnPage = Math.min(pageSize, totalAvailablePosts - (currentPage - 1) * pageSize);
  const isPageDataLoading = !filterUnsynced && !filterUncategorized &&
    paginatedPosts.length === 0 && expectedPostsOnPage > 0 && !isLoading;

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [filterUnsynced, filterUncategorized, pageSize]);

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
      loadData();
      return;
    }

    // Check for category: prefix
    const categoryMatch = searchQuery.match(/^category:(.+)$/i);
    if (categoryMatch) {
      const categoryName = categoryMatch[1].trim();
      await filterByCategory(categoryName);
      return;
    }

    if (backendConnected) {
      try {
        const results = await api.semanticSearch(searchQuery);
        setPosts(results);
      } catch (error) {
        console.error('Search failed:', error);
      }
    } else {
      // Local search fallback
      const query = searchQuery.toLowerCase();
      const localPosts = await getPosts();
      const filtered = localPosts.filter(p =>
        p.caption.toLowerCase().includes(query) ||
        p.ownerUsername.toLowerCase().includes(query)
      );
      setPosts(filtered);
    }
  }

  async function filterByCategory(categoryName: string) {
    if (!backendConnected) {
      alert('Category filter requires backend connection.');
      return;
    }

    try {
      // Find category ID by name
      const category = categories.find(c =>
        c.name.toLowerCase() === categoryName.toLowerCase()
      );

      if (!category) {
        alert(`Category "${categoryName}" not found.`);
        return;
      }

      const results = await api.getPosts({ category: category.id });
      setPosts(results);
    } catch (error) {
      console.error('Category filter failed:', error);
    }
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
              <input
                type="text"
                className="search-input"
                placeholder={backendConnected
                  ? "Search posts semantically..."
                  : "Search posts..."}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <button type="submit" className="btn btn-primary">
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
                      {selectionMode ? '✓ Selecting' : '☑️ Select'}
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
                          None
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
      {selectedPost && (
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
          }}
          onSave={backendConnected ? handleSavePostMetadata : undefined}
        />
      )}
    </div>
  );
}
