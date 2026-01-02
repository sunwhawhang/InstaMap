import { useState } from 'react';
import { InstagramPost } from '../shared/types';
import { getProxyImageUrl } from '../shared/api';

interface PostCardProps {
  post: InstagramPost;
  onClick?: () => void;
  isSynced?: boolean;
  isCategorized?: boolean;
  hasLocalImage?: boolean;
  isSelected?: boolean;
  onSelect?: (postId: string, selected: boolean, shiftKey: boolean) => void;
  selectionMode?: boolean;
  onImageExpired?: (postId: string) => void;
}

export function PostCard({
  post,
  onClick,
  isSynced = false,
  isCategorized = false,
  hasLocalImage = false,
  isSelected = false,
  onSelect,
  selectionMode = false,
  onImageExpired,
}: PostCardProps) {
  const [imageExpired, setImageExpired] = useState(post.imageExpired || false);

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
        {isSynced && (hasLocalImage ? (
          <span title="Image stored locally" style={{
            background: 'rgba(14, 165, 233, 0.9)',
            color: 'white',
            padding: '4px 6px',
            borderRadius: '4px',
            fontSize: '10px',
          }}>💾</span>
        ) : (
          <span title="Image not stored" style={{
            background: 'rgba(100, 100, 100, 0.8)',
            color: 'white',
            padding: '4px 6px',
            borderRadius: '4px',
            fontSize: '10px',
          }}>💾 ✗</span>
        ))}
      </div>

      {imageExpired ? (
        <div
          className="post-image"
          title="Image expired - click to view on Instagram and refresh"
          style={{
            background: '#e0e0e0',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '4px',
          }}
        >
          <span style={{ fontSize: '28px' }}>📷</span>
          <span style={{ fontSize: '10px', color: '#757575' }}>Expired</span>
        </div>
      ) : (
        <img
          src={post.imageUrl || post.thumbnailUrl}
          alt={post.caption || 'Instagram post'}
          className="post-image"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={(e) => {
            const target = e.target as HTMLImageElement;
            const originalSrc = post.imageUrl || post.thumbnailUrl;
            if (originalSrc && !target.dataset.triedProxy) {
              target.dataset.triedProxy = 'true';
              target.src = getProxyImageUrl(originalSrc, post.id);
            } else if (!target.dataset.markedExpired) {
              target.dataset.markedExpired = 'true';
              setImageExpired(true);
              if (isSynced && onImageExpired) {
                onImageExpired(post.id);
              }
            }
          }}
        />
      )}
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
