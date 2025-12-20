import React, { useState, useEffect, useRef } from 'react';
import { InstagramPost, Category, SyncStatus } from '../shared/types';
import { getPosts, getCategories, getSyncStatus } from '../shared/storage';
import { api } from '../shared/api';
import { Chat } from './Chat';
import { Categories } from './Categories';
import { PostCard } from './PostCard';
import { MapView } from './MapView';
import { PostDetailModal } from './PostDetailModal';

type View = 'posts' | 'chat' | 'categories' | 'map';
type CategorizeStatus = 'idle' | 'choosing' | 'processing' | 'polling' | 'done' | 'error';

const ACTIVE_BATCH_KEY = 'instamap_active_batch';

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
    estimatedCost: string;
    realtimeCost: string;
    asyncCost: string;
  } | null>(null);
  const pollingIntervalRef = useRef<number | null>(null);
  const [manualBatchId, setManualBatchId] = useState('');
  const [showManualBatchInput, setShowManualBatchInput] = useState(false);

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
      const [localPosts, localCategories, syncStatus] = await Promise.all([
        getPosts(),
        getCategories(),
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
          const [backendCategories, cloudPosts, categorizedIds] = await Promise.all([
            api.getCategories(),
            api.getPosts({ limit: 10000 }), // Get all synced posts
            api.getCategorizedPostIds(),
          ]);

          setCategories(backendCategories);

          // Track which posts are synced to cloud
          const syncedIds = new Set(cloudPosts.map(p => p.id));
          setSyncedPostIds(syncedIds);

          // Track which posts are categorized
          setCategorizedPostIds(new Set(categorizedIds));

        } catch {
          // Use local categories if backend fetch fails
        }
      }
    } catch (error) {
      console.error('Failed to load data:', error);
    }
    setIsLoading(false);
  }

  // Calculate unsynced count
  const unsyncedCount = posts.filter(p => !syncedPostIds.has(p.id)).length;
  const uncategorizedCount = posts.filter(p => syncedPostIds.has(p.id) && !categorizedPostIds.has(p.id)).length;

  // Apply filters to posts
  const filteredPosts = posts.filter(post => {
    // Filter: show only unsynced
    if (filterUnsynced && syncedPostIds.has(post.id)) {
      return false;
    }
    // Filter: show only uncategorized (must be synced first)
    if (filterUncategorized) {
      if (!syncedPostIds.has(post.id) || categorizedPostIds.has(post.id)) {
        return false;
      }
    }
    return true;
  });

  // Pagination
  const totalPages = Math.ceil(filteredPosts.length / pageSize);
  const paginatedPosts = filteredPosts.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [filterUnsynced, filterUncategorized, pageSize]);

  // Handle post click to open detail modal
  async function handlePostClick(post: InstagramPost) {
    setSelectedPost(post);
    // Fetch categories for this post from backend
    if (backendConnected && categorizedPostIds.has(post.id)) {
      try {
        const cats = await api.getPostCategories(post.id);
        setPostCategories(cats.map(c => c.name));
      } catch (error) {
        console.error('Failed to fetch post categories:', error);
        setPostCategories([]);
      }
    } else {
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

  async function handleSyncToCloud() {
    if (!backendConnected) {
      alert('Backend not connected. Please start the backend server.');
      return;
    }

    if (posts.length === 0) {
      alert('No posts to sync. Collect some posts first!');
      return;
    }

    setIsSyncing(true);
    setSyncMessage(null); // Button already shows "Syncing..."

    try {
      const result = await api.syncPosts(posts);
      setSyncMessage(`✅ Synced ${result.synced} posts!`);

      // Reload to update sync status
      await loadData();

      setTimeout(() => setSyncMessage(null), 3000);
    } catch (error) {
      console.error('Sync failed:', error);
      setSyncMessage('❌ Sync failed');
      setTimeout(() => setSyncMessage(null), 3000);
    }

    setIsSyncing(false);
  }

  async function handleSearch(e: React.FormEvent) {
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
    if (isCategorizationBusy) {
      alert('Categorization already in progress. Please wait for it to complete.');
      return;
    }

    if (!backendConnected) {
      alert('Backend not connected. Please start the backend server.');
      return;
    }

    // Calculate stats
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

      // Count uncategorized posts (synced but not categorized, from selection)
      const uncategorizedPosts = postsToConsider.filter(id =>
        cloudPostIds.has(id) && !categorizedSet.has(id)
      );
      const uncategorizedCount = uncategorizedPosts.length;

      // Estimate cost: Claude 4.5 Haiku - $1/1M input + $5/1M output
      // Based on actual usage: ~500 tokens input, ~250 tokens output per post
      const inputTokensPerPost = 500;
      const outputTokensPerPost = 250;
      const inputCost = (uncategorizedCount * inputTokensPerPost / 1000000) * 1;
      const outputCost = (uncategorizedCount * outputTokensPerPost / 1000000) * 5;
      const realtimeCost = inputCost + outputCost;
      const asyncCost = realtimeCost * 0.5; // 50% off with batch API

      const formatCost = (cost: number) => cost < 0.01 ? '< $0.01' : `~$${cost.toFixed(2)}`;

      setCategorizeStats({
        unsynced: unsyncedInSelection,
        uncategorized: uncategorizedCount,
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

    // Get posts to categorize - either selected or all uncategorized synced posts
    let postIdsToProcess: string[];
    if (selectedPostIds.size > 0) {
      // Use selected posts that are synced and not yet categorized
      postIdsToProcess = Array.from(selectedPostIds).filter(
        id => syncedPostIds.has(id) && !categorizedPostIds.has(id)
      );
    } else {
      // Use all synced posts that aren't categorized
      postIdsToProcess = posts
        .filter(p => syncedPostIds.has(p.id) && !categorizedPostIds.has(p.id))
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
                title="Show only synced posts not yet categorized"
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

              {/* Selection mode toggle */}
              <button
                type="button"
                className="btn"
                onClick={toggleSelectionMode}
                title={selectionMode ? 'Exit selection mode' : 'Select posts'}
                style={{
                  background: selectionMode ? 'var(--primary)' : undefined,
                  color: selectionMode ? 'white' : undefined,
                }}
              >
                {selectionMode ? '✓ Selecting' : '☑️ Select'}
              </button>

              {/* Selection controls when in selection mode */}
              {selectionMode && (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={selectAllPosts}
                    title="Select all visible posts"
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={clearSelection}
                    title="Clear selection"
                  >
                    None
                  </button>
                  {selectedPostIds.size > 0 && (
                    <span style={{
                      padding: '8px 12px',
                      background: 'var(--primary)',
                      color: 'white',
                      borderRadius: '8px',
                      fontSize: '13px',
                    }}>
                      {selectedPostIds.size} selected
                    </span>
                  )}
                </>
              )}

              {backendConnected && (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleSyncToCloud}
                    disabled={isSyncing || posts.length === 0}
                    title={`Sync ${unsyncedCount} unsynced posts to cloud`}
                    style={{ position: 'relative' }}
                  >
                    {isSyncing ? '⏳ Syncing...' : '☁️ Sync to Cloud'}
                    {unsyncedCount > 0 && !isSyncing && (
                      <span style={{
                        position: 'absolute',
                        top: '-8px',
                        right: '-8px',
                        background: 'var(--error)',
                        color: 'white',
                        borderRadius: '50%',
                        width: '20px',
                        height: '20px',
                        fontSize: '11px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}>
                        {unsyncedCount > 99 ? '99+' : unsyncedCount}
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
            ) : filteredPosts.length === 0 ? (
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
                {/* Pagination controls - top */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '16px',
                  padding: '12px',
                  background: 'var(--bg-secondary)',
                  borderRadius: '8px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
                      Showing {((currentPage - 1) * pageSize) + 1}-{Math.min(currentPage * pageSize, filteredPosts.length)} of {filteredPosts.length}
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
                      <option value={100}>100 per page</option>
                      <option value={200}>200 per page</option>
                      <option value={300}>300 per page</option>
                      <option value={500}>500 per page</option>
                      <option value={1000}>1000 per page</option>
                    </select>
                  </div>

                  {totalPages > 1 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <button
                        className="btn"
                        onClick={() => setCurrentPage(1)}
                        disabled={currentPage === 1}
                        style={{ padding: '6px 12px', fontSize: '13px' }}
                      >
                        ⏮️
                      </button>
                      <button
                        className="btn"
                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                        disabled={currentPage === 1}
                        style={{ padding: '6px 12px', fontSize: '13px' }}
                      >
                        ◀️ Prev
                      </button>
                      <span style={{ padding: '0 12px', fontSize: '14px' }}>
                        Page {currentPage} of {totalPages}
                      </span>
                      <button
                        className="btn"
                        onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                        disabled={currentPage === totalPages}
                        style={{ padding: '6px 12px', fontSize: '13px' }}
                      >
                        Next ▶️
                      </button>
                      <button
                        className="btn"
                        onClick={() => setCurrentPage(totalPages)}
                        disabled={currentPage === totalPages}
                        style={{ padding: '6px 12px', fontSize: '13px' }}
                      >
                        ⏭️
                      </button>
                    </div>
                  )}
                </div>

                <div className="posts-grid">
                  {paginatedPosts.map((post) => (
                    <PostCard
                      key={post.id}
                      post={post}
                      onClick={() => handlePostClick(post)}
                      isSynced={syncedPostIds.has(post.id)}
                      isCategorized={categorizedPostIds.has(post.id)}
                      selectionMode={selectionMode}
                      isSelected={selectedPostIds.has(post.id)}
                      onSelect={handlePostSelect}
                    />
                  ))}
                </div>

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
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                    >
                      ◀️ Previous
                    </button>
                    <span style={{ padding: '0 16px' }}>
                      Page {currentPage} of {totalPages}
                    </span>
                    <button
                      className="btn"
                      onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
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
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>📊 Posts to categorize:</span>
                      <strong>{categorizeStats.uncategorized}</strong>
                    </div>
                  </div>
                )}

                {categorizeStats?.uncategorized === 0 ? (
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
          onCategoryClick={(category) => {
            setSearchQuery(`category:${category}`);
            setView('posts');
          }}
          onSave={backendConnected ? handleSavePostMetadata : undefined}
        />
      )}
    </div>
  );
}
