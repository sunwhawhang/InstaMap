import React, { useState, useEffect } from 'react';
import { InstagramPost, Category, SyncStatus } from '../shared/types';
import { getPosts, getCategories, getSyncStatus } from '../shared/storage';
import { api } from '../shared/api';
import { Chat } from './Chat';
import { Categories } from './Categories';
import { PostCard } from './PostCard';

type View = 'posts' | 'chat' | 'categories';

export function Dashboard() {
  const [view, setView] = useState<View>('posts');
  const [posts, setPosts] = useState<InstagramPost[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [backendConnected, setBackendConnected] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

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

      // If connected, try to fetch from backend
      if (connected) {
        try {
          const backendCategories = await api.getCategories();
          setCategories(backendCategories);
        } catch {
          // Use local categories if backend fetch fails
        }
      }
    } catch (error) {
      console.error('Failed to load data:', error);
    }
    setIsLoading(false);
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) {
      loadData();
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

  async function handleAutoCategorize() {
    if (!backendConnected) return;
    
    try {
      const postIds = posts.map(p => p.id);
      await api.autoCategorize(postIds);
      loadData();
    } catch (error) {
      console.error('Auto-categorize failed:', error);
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
            onCategorySelect={(category) => {
              setSearchQuery(`category:${category.name}`);
              setView('posts');
            }}
          />
        );
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
              {backendConnected && (
                <button 
                  type="button" 
                  className="btn btn-secondary"
                  onClick={handleAutoCategorize}
                >
                  ✨ Auto-Categorize
                </button>
              )}
            </form>

            {posts.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">📭</div>
                <h3>No posts yet</h3>
                <p>Go to your Instagram saved posts and click "Collect Posts" in the extension popup.</p>
              </div>
            ) : (
              <div className="posts-grid">
                {posts.map((post) => (
                  <PostCard key={post.id} post={post} />
                ))}
              </div>
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
    </div>
  );
}
