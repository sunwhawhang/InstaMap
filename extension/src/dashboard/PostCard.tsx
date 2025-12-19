import { InstagramPost } from '../shared/types';

interface PostCardProps {
  post: InstagramPost;
  onClick?: () => void;
}

export function PostCard({ post, onClick }: PostCardProps) {
  const openOnInstagram = () => {
    window.open(`https://www.instagram.com/p/${post.instagramId}/`, '_blank');
  };

  return (
    <div className="post-card" onClick={onClick}>
      <img
        src={post.imageUrl || post.thumbnailUrl}
        alt={post.caption || 'Instagram post'}
        className="post-image"
        loading="lazy"
        onError={(e) => {
          // Fallback for broken images
          (e.target as HTMLImageElement).src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="%23f0f0f0" width="100" height="100"/><text x="50%" y="50%" text-anchor="middle" dy=".3em" fill="%23999" font-size="14">📷</text></svg>';
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
          <span>
            {post.ownerUsername ? `@${post.ownerUsername}` : 'Unknown'}
          </span>
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
