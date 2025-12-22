import { InstagramPost } from '../shared/types';
import { getProxyImageUrl } from '../shared/api';

interface PostCardProps {
  post: InstagramPost;
  onClick?: () => void;
  isSynced?: boolean;
  isCategorized?: boolean;
  isSelected?: boolean;
  onSelect?: (postId: string, selected: boolean, shiftKey: boolean) => void;
  selectionMode?: boolean;
}

export function PostCard({
  post,
  onClick,
  isSynced = false,
  isCategorized = false,
  isSelected = false,
  onSelect,
  selectionMode = false,
}: PostCardProps) {
  const openOnInstagram = () => {
    window.open(`https://www.instagram.com/p/${post.instagramId}/`, '_blank');
  };

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect?.(post.id, !isSelected, e.shiftKey);
  };

  const handleCardClick = (e: React.MouseEvent) => {
    // In selection mode, clicking anywhere on the card toggles selection
    if (selectionMode) {
      onSelect?.(post.id, !isSelected, e.shiftKey);
    } else {
      onClick?.();
    }
  };

  return (
    <div
      className="post-card"
      onClick={handleCardClick}
      style={{
        position: 'relative',
        outline: isSelected ? '3px solid var(--primary)' : undefined,
        outlineOffset: '-3px',
        cursor: selectionMode ? 'pointer' : undefined,
      }}
    >
      {/* Selection checkbox */}
      {selectionMode && (
        <div
          onClick={handleCheckboxClick}
          style={{
            position: 'absolute',
            top: '8px',
            left: '8px',
            zIndex: 15,
            width: '24px',
            height: '24px',
            borderRadius: '4px',
            background: isSelected ? 'var(--primary)' : 'rgba(255, 255, 255, 0.9)',
            border: isSelected ? 'none' : '2px solid #ccc',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            fontSize: '14px',
            color: 'white',
          }}
        >
          {isSelected && '✓'}
        </div>
      )}

      {/* Status badges */}
      <div style={{
        position: 'absolute',
        top: '8px',
        right: '8px',
        display: 'flex',
        gap: '4px',
        zIndex: 10,
      }}>
        {isSynced ? (
          <span title="Synced to cloud" style={{
            background: 'rgba(88, 195, 34, 0.9)',
            color: 'white',
            padding: '4px 6px',
            borderRadius: '4px',
            fontSize: '10px',
          }}>☁️</span>
        ) : (
          <span title="Not synced - local only" style={{
            background: 'rgba(0, 0, 0, 0.6)',
            color: 'white',
            padding: '4px 6px',
            borderRadius: '4px',
            fontSize: '10px',
          }}>📱</span>
        )}
        {isCategorized ? (
          <span title="Categorized" style={{
            background: 'rgba(131, 58, 180, 0.9)',
            color: 'white',
            padding: '4px 6px',
            borderRadius: '4px',
            fontSize: '10px',
          }}>🏷️</span>
        ) : isSynced ? (
          <span title="Not categorized yet" style={{
            background: 'rgba(100, 100, 100, 0.8)',
            color: 'white',
            padding: '4px 6px',
            borderRadius: '4px',
            fontSize: '10px',
          }}>🏷️ ✗</span>
        ) : null}
      </div>

      <img
        src={post.imageUrl || post.thumbnailUrl}
        alt={post.caption || 'Instagram post'}
        className="post-image"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={(e) => {
          // Try proxy as fallback, then placeholder
          const target = e.target as HTMLImageElement;
          const originalSrc = post.imageUrl || post.thumbnailUrl;
          if (originalSrc && !target.dataset.triedProxy) {
            target.dataset.triedProxy = 'true';
            target.src = getProxyImageUrl(originalSrc);
          } else {
            target.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="%23f0f0f0" width="100" height="100"/><text x="50%" y="50%" text-anchor="middle" dy=".3em" fill="%23999" font-size="14">📷</text></svg>';
          }
        }}
      />
      <div className="post-content">
        {post.isVideo && (
          <span style={{
            display: 'inline-block',
            background: 'var(--primary)',
            color: 'white',
            padding: '2px 8px',
            borderRadius: '4px',
            fontSize: '11px',
            marginBottom: '8px'
          }}>
            🎬 Video
          </span>
        )}

        {post.caption && (
          <p className="post-caption">{post.caption}</p>
        )}

        {!post.caption && (
          <p className="post-caption" style={{ fontStyle: 'italic', color: 'var(--text-secondary)' }}>
            No caption
          </p>
        )}

        <div className="post-meta">
          <button
            onClick={(e) => { e.stopPropagation(); openOnInstagram(); }}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--primary)',
              cursor: 'pointer',
              fontSize: '12px',
            }}
          >
            View on IG →
          </button>
        </div>

        {post.savedAt && (
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '8px' }}>
            Saved: {new Date(post.savedAt).toLocaleDateString()}
          </div>
        )}
      </div>
    </div>
  );
}
