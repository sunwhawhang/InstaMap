import { useState, useEffect } from 'react';
import { Category } from '../shared/types';
import { api } from '../shared/api';
import { CategoryTree } from './CategoryTree';
import { CleanupModal } from './CleanupModal';

interface CategoriesProps {
  categories: Category[];
  onCategorySelect: (category: Category) => void;
  onRefresh?: () => void;
}

export function Categories({ categories, onCategorySelect, onRefresh }: CategoriesProps) {
  const [hierarchy, setHierarchy] = useState<(Category & { children: Category[] })[]>([]);
  const [showCleanupModal, setShowCleanupModal] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [cleanupProgress, setCleanupProgress] = useState(0);

  const loadHierarchy = async () => {
    setIsLoading(true);
    try {
      const data = await api.getCategoryHierarchy();
      setHierarchy(data);
    } catch (err) {
      console.error('Failed to load hierarchy:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleHardReset = async () => {
    if (!window.confirm('⚠️ This action cannot be undone. It will revert all categories and remove the parent/child hierarchy. Are you sure?')) {
      return;
    }

    setIsResetting(true);
    try {
      await api.resetCategories();
      await loadHierarchy();
      onRefresh?.();
    } catch (err) {
      console.error('Failed to reset categories:', err);
      alert('Failed to reset categories');
    } finally {
      setIsResetting(false);
    }
  };

  const checkCleanupStatus = async () => {
    try {
      const status = await api.getCategoryCleanupStatus();
      if (status.status === 'running') {
        setIsCleaning(true);
        setCleanupProgress(status.progress);
      } else {
        if (isCleaning && status.status === 'done') {
          // It just finished
          loadHierarchy();
          onRefresh?.();
        }
        setIsCleaning(false);
      }
    } catch (err) {
      console.error('Failed to check cleanup status:', err);
    }
  };

  useEffect(() => {
    loadHierarchy();
    checkCleanupStatus();

    // Poll for status if cleaning is in progress
    const interval = setInterval(checkCleanupStatus, 5000);
    return () => clearInterval(interval);
  }, [categories.length]);

  if (categories.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">🏷️</div>
        <h3>No categories yet</h3>
        <p>Categories will appear here once you sync your posts and run auto-categorization.</p>
        <p style={{ marginTop: '12px', fontSize: '14px', color: 'var(--text-secondary)' }}>
          Make sure the backend is running and click "Auto-Categorize" on the posts page.
        </p>
      </div>
    );
  }

  const hasHierarchy = hierarchy.length > 0 && hierarchy.some(cat => cat.children && cat.children.length > 0);

  return (
    <div style={{ padding: '0 20px' }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '24px',
        padding: '16px 20px',
        background: 'var(--surface)',
        borderRadius: 'var(--radius)',
        border: '1px solid var(--border)'
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <h3 style={{ margin: 0 }}>Categories</h3>
            {hasHierarchy && (
              <button
                onClick={handleHardReset}
                disabled={isResetting}
                style={{
                  fontSize: '11px',
                  padding: '2px 6px',
                  color: 'var(--text-secondary)',
                  background: 'none',
                  border: '1px solid var(--border)',
                  borderRadius: '4px',
                  cursor: isResetting ? 'not-allowed' : 'pointer',
                  opacity: 0.6,
                  transition: 'opacity 0.2s'
                }}
                onMouseOver={e => e.currentTarget.style.opacity = '1'}
                onMouseOut={e => e.currentTarget.style.opacity = '0.6'}
              >
                {isResetting ? '⌛ Resetting...' : '⚠️ Hard Reset Taxonomy'}
              </button>
            )}
          </div>
          <p style={{ margin: '4px 0 0', fontSize: '13px', color: 'var(--text-secondary)' }}>
            {categories.length} total categories
          </p>
        </div>
        <button
          className="btn btn-secondary"
          onClick={() => setShowCleanupModal(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 16px',
            background: isCleaning ? 'var(--primary)' : undefined,
            color: isCleaning ? 'white' : undefined,
            position: 'relative'
          }}
        >
          {isCleaning ? (
            <>
              ⏳ Cleaning ({cleanupProgress}%)
              <div style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                height: '3px',
                background: 'rgba(255,255,255,0.5)',
                width: `${cleanupProgress}%`
              }} />
            </>
          ) : (
            '🧹 Cleanup & Organize'
          )}
        </button>
      </div>

      {isLoading && hierarchy.length === 0 ? (
        <div style={{ padding: '60px', textAlign: 'center' }}>
          <div className="spinner" style={{ margin: '0 auto 16px' }}></div>
          <p>Loading your taxonomy...</p>
        </div>
      ) : (
        <CategoryTree
          categories={hierarchy}
          onCategorySelect={onCategorySelect}
        />
      )}

      {showCleanupModal && (
        <CleanupModal
          onClose={() => setShowCleanupModal(false)}
          onComplete={() => {
            loadHierarchy();
            onRefresh?.();
          }}
        />
      )}
    </div>
  );
}
