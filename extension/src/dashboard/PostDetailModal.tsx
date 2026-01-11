import { useState, useEffect } from 'react';
import { InstagramPost, MentionedPlace } from '../shared/types';
import { getProxyImageUrl } from '../shared/api';

interface PostDetailModalProps {
  post: InstagramPost;
  categories: string[];
  onClose: () => void;
  onCategoryClick: (category: string) => void;
  onSave?: (postId: string, updates: Partial<InstagramPost>) => Promise<void>;
  onNext?: () => void;
  onPrevious?: () => void;
  hasNext?: boolean;
  hasPrevious?: boolean;
  hasLocalImage?: boolean;
}

// Generate consistent colors for categories
function getCategoryColor(categoryName: string): string {
  const colors = [
    '#E1306C', // Instagram pink
    '#405DE6', // Instagram blue
    '#5851DB', // Purple
    '#833AB4', // Deep purple
    '#C13584', // Magenta
    '#FD1D1D', // Red
    '#F77737', // Orange
    '#FCAF45', // Yellow-orange
    '#58C322', // Green
    '#00A693', // Teal
    '#0095F6', // Light blue
    '#6C5CE7', // Violet
  ];

  // Hash the category name to get a consistent color
  let hash = 0;
  for (let i = 0; i < categoryName.length; i++) {
    hash = categoryName.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

// Editable place item component
function PlaceItem({
  place,
  index,
  isEditing,
  onUpdate,
  onRemove,
}: {
  place: MentionedPlace;
  index: number;
  isEditing: boolean;
  onUpdate: (index: number, field: keyof MentionedPlace, value: string) => void;
  onRemove: (index: number) => void;
}) {
  if (isEditing) {
    return (
      <div style={{
        display: 'flex',
        gap: '6px',
        padding: '8px',
        background: 'white',
        borderRadius: '6px',
        border: '1px solid #e0e0e0',
        alignItems: 'flex-start',
      }}>
        <span style={{ color: '#666', fontSize: '12px', minWidth: '20px', paddingTop: '8px' }}>
          {index + 1}.
        </span>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <input
            type="text"
            value={place.venue}
            onChange={(e) => onUpdate(index, 'venue', e.target.value)}
            placeholder="Venue name"
            style={{
              padding: '6px 8px',
              borderRadius: '4px',
              border: '1px solid #ddd',
              fontSize: '13px',
              fontWeight: 500,
            }}
          />
          <input
            type="text"
            value={place.location}
            onChange={(e) => onUpdate(index, 'location', e.target.value)}
            placeholder="City, Country"
            style={{
              padding: '6px 8px',
              borderRadius: '4px',
              border: '1px solid #ddd',
              fontSize: '12px',
            }}
          />
          <div style={{ display: 'flex', gap: '4px' }}>
            <input
              type="text"
              value={place.handle || ''}
              onChange={(e) => onUpdate(index, 'handle', e.target.value)}
              placeholder="@handle (optional)"
              style={{
                flex: 1,
                padding: '6px 8px',
                borderRadius: '4px',
                border: '1px solid #ddd',
                fontSize: '12px',
              }}
            />
            <input
              type="text"
              value={place.metadata || ''}
              onChange={(e) => onUpdate(index, 'metadata', e.target.value)}
              placeholder="Notes (optional)"
              style={{
                flex: 1,
                padding: '6px 8px',
                borderRadius: '4px',
                border: '1px solid #ddd',
                fontSize: '12px',
              }}
            />
          </div>
        </div>
        <button
          onClick={() => onRemove(index)}
          style={{
            background: 'none',
            border: 'none',
            color: '#e53935',
            fontSize: '16px',
            cursor: 'pointer',
            padding: '4px',
            lineHeight: 1,
          }}
          title="Remove place"
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: '8px',
      padding: '6px 8px',
      background: 'white',
      borderRadius: '6px',
      fontSize: '13px',
    }}>
      <span style={{ color: '#666', minWidth: '20px' }}>
        {index + 1}.
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500 }}>
          {place.venue}
          {place.handle && (
            <a
              href={`https://instagram.com/${place.handle.replace('@', '')}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                marginLeft: '6px',
                color: '#1976d2',
                fontSize: '12px',
                textDecoration: 'none',
              }}
            >
              {place.handle}
            </a>
          )}
        </div>
        <div style={{ color: '#666', fontSize: '12px' }}>
          📍 {place.location}
          {place.metadata && (
            <span style={{ marginLeft: '8px', color: '#888' }}>
              • {place.metadata}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function PostDetailModal({
  post,
  categories,
  onClose,
  onCategoryClick,
  onSave,
  onNext,
  onPrevious,
  hasNext,
  hasPrevious,
  hasLocalImage = false,
}: PostDetailModalProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showReasons, setShowReasons] = useState(false);
  const [placesExpanded, setPlacesExpanded] = useState(false);

  // Editable fields
  const [eventDate, setEventDate] = useState(post.eventDate || '');
  const [hashtags, setHashtags] = useState((post.hashtags || []).join(', '));
  const [mentionedPlaces, setMentionedPlaces] = useState<MentionedPlace[]>(post.mentionedPlaces || []);

  // Reset state when post changes (for navigation)
  useEffect(() => {
    setEventDate(post.eventDate || '');
    setHashtags((post.hashtags || []).join(', '));
    setMentionedPlaces(post.mentionedPlaces || []);
    setIsEditing(false);
    setShowReasons(false);
    setPlacesExpanded(false);
  }, [post.id]);

  // Check if post has been extracted (has any extraction data)
  const hasBeenExtracted = !!(post.categoriesReason || post.mentionedPlacesReason ||
    post.hashtagsReason || post.eventDateReason || post.mentionsReason ||
    (post.mentionedPlaces && post.mentionedPlaces.length > 0));

  // Check if we have any extraction reasons to show
  const hasReasons = post.eventDateReason || post.hashtagsReason ||
    post.categoriesReason || post.mentionsReason || post.mentionedPlacesReason;

  const handleSave = async () => {
    if (!onSave) return;

    setIsSaving(true);
    try {
      // Filter out empty places
      const validPlaces = mentionedPlaces.filter(p => p.venue.trim() && p.location.trim());
      await onSave(post.id, {
        eventDate: eventDate || undefined,
        hashtags: hashtags ? hashtags.split(',').map(h => h.trim()).filter(Boolean) : undefined,
        mentionedPlaces: validPlaces.length > 0 ? validPlaces : undefined,
      });
      setIsEditing(false);
    } catch (error) {
      console.error('Failed to save:', error);
      alert('Failed to save changes');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setEventDate(post.eventDate || '');
    setHashtags((post.hashtags || []).join(', '));
    setMentionedPlaces(post.mentionedPlaces || []);
    setIsEditing(false);
  };

  const handlePlaceUpdate = (index: number, field: keyof MentionedPlace, value: string) => {
    setMentionedPlaces(prev => prev.map((p, i) =>
      i === index ? { ...p, [field]: value } : p
    ));
  };

  const handlePlaceRemove = (index: number) => {
    setMentionedPlaces(prev => prev.filter((_, i) => i !== index));
  };

  const handlePlaceAdd = () => {
    setMentionedPlaces(prev => [...prev, { venue: '', location: '' }]);
  };

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '20px',
      }}
    >
      {/* Previous Button */}
      {hasPrevious && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPrevious?.();
          }}
          style={{
            position: 'absolute',
            left: '30px',
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'none',
            border: 'none',
            color: 'white',
            fontSize: '64px',
            cursor: 'pointer',
            padding: '20px',
            opacity: 0.7,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1001,
            transition: 'opacity 0.2s, transform 0.2s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = '1';
            e.currentTarget.style.transform = 'translateY(-50%) scale(1.1)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = '0.7';
            e.currentTarget.style.transform = 'translateY(-50%) scale(1)';
          }}
          title="Previous post"
        >
          ‹
        </button>
      )}

      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white',
          borderRadius: '16px',
          maxWidth: '800px',
          width: '100%',
          maxHeight: '90vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: '1px solid #eee',
        }}>
          <h3 style={{ margin: 0, fontSize: '18px' }}>Post Details</h3>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '24px',
              cursor: 'pointer',
              color: '#666',
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{
          display: 'flex',
          flex: 1,
          overflow: 'hidden',
        }}>
          {/* Image */}
          <div style={{
            width: '40%',
            minWidth: '250px',
            background: '#e0e0e0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            {post.imageExpired && !hasLocalImage ? (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '8px',
                color: '#757575',
              }}>
                <span style={{ fontSize: '48px' }}>📷</span>
                <span style={{ fontSize: '14px' }}>Expired</span>
              </div>
            ) : (
              <img
                src={hasLocalImage
                  ? getProxyImageUrl(post.imageUrl, post.id)
                  : post.imageUrl}
                alt=""
                style={{
                  maxWidth: '100%',
                  maxHeight: '100%',
                  objectFit: 'contain',
                }}
                onError={(e) => {
                  // If we have local image, it should always work - don't show expired
                  if (hasLocalImage) return;

                  // Try proxy first before showing expired
                  const target = e.target as HTMLImageElement;
                  if (!target.dataset.triedProxy && post.imageUrl) {
                    target.dataset.triedProxy = 'true';
                    target.src = getProxyImageUrl(post.imageUrl, post.id);
                    return;
                  }

                  // Replace with expired placeholder on error
                  target.style.display = 'none';
                  const parent = target.parentElement;
                  if (parent && !parent.dataset.expiredShown) {
                    parent.dataset.expiredShown = 'true';
                    parent.innerHTML = `
                      <div style="display:flex;flex-direction:column;align-items:center;gap:8px;color:#757575">
                        <span style="font-size:48px">📷</span>
                        <span style="font-size:14px">Expired</span>
                      </div>
                    `;
                  }
                }}
              />
            )}
          </div>

          {/* Details */}
          <div style={{
            flex: 1,
            padding: '20px',
            overflowY: 'auto',
          }}>
            {/* Username and link */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              marginBottom: '16px',
            }}>
              <span style={{ fontWeight: 600 }}>@{post.ownerUsername || 'unknown'}</span>
              <a
                href={`https://www.instagram.com/p/${post.instagramId}/`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: 'var(--primary)',
                  fontSize: '13px',
                }}
              >
                View on Instagram →
              </a>
            </div>

            {/* Caption */}
            <div style={{ marginBottom: '20px' }}>
              <h4 style={{ margin: '0 0 8px 0', fontSize: '14px', color: '#666' }}>Caption</h4>
              <p style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                lineHeight: 1.5,
                maxHeight: '150px',
                overflowY: 'auto',
                background: '#f9f9f9',
                padding: '12px',
                borderRadius: '8px',
                fontSize: '14px',
              }}>
                {post.caption || <em style={{ color: '#999' }}>No caption</em>}
              </p>
            </div>

            {/* Categories */}
            <div style={{ marginBottom: '20px' }}>
              <h4 style={{ margin: '0 0 8px 0', fontSize: '14px', color: '#666' }}>Categories</h4>
              {categories.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {categories.map((cat) => (
                    <button
                      key={cat}
                      onClick={() => {
                        onCategoryClick(cat);
                        onClose();
                      }}
                      style={{
                        background: getCategoryColor(cat),
                        color: 'white',
                        border: 'none',
                        padding: '6px 12px',
                        borderRadius: '20px',
                        fontSize: '13px',
                        cursor: 'pointer',
                        fontWeight: 500,
                      }}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              ) : (
                <p style={{ margin: 0, color: '#999', fontStyle: 'italic', fontSize: '14px' }}>
                  Not categorized yet
                </p>
              )}
            </div>

            {/* Extracted Data */}
            <div style={{ marginBottom: '20px' }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '12px',
              }}>
                <h4 style={{ margin: 0, fontSize: '14px', color: '#666' }}>Extracted Data</h4>
                {!isEditing ? (
                  <button
                    onClick={() => setIsEditing(true)}
                    style={{
                      background: 'none',
                      border: '1px solid #ddd',
                      padding: '4px 12px',
                      borderRadius: '4px',
                      fontSize: '12px',
                      cursor: 'pointer',
                    }}
                  >
                    ✏️ Edit
                  </button>
                ) : (
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={handleCancel}
                      style={{
                        background: 'none',
                        border: '1px solid #ddd',
                        padding: '4px 12px',
                        borderRadius: '4px',
                        fontSize: '12px',
                        cursor: 'pointer',
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSave}
                      disabled={isSaving}
                      style={{
                        background: 'var(--primary)',
                        color: 'white',
                        border: 'none',
                        padding: '4px 12px',
                        borderRadius: '4px',
                        fontSize: '12px',
                        cursor: 'pointer',
                      }}
                    >
                      {isSaving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                )}
              </div>

              <div style={{
                background: '#f9f9f9',
                borderRadius: '8px',
                padding: '12px',
              }}>
                {/* Places - at top */}
                <div style={{ marginBottom: '12px' }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '8px',
                  }}>
                    <label style={{ fontSize: '12px', color: '#666' }}>
                      📍 Places {mentionedPlaces.length > 0 && `(${mentionedPlaces.length})`}
                    </label>
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      {!isEditing && mentionedPlaces.length > 3 && (
                        <button
                          onClick={() => setPlacesExpanded(!placesExpanded)}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#1976d2',
                            fontSize: '11px',
                            cursor: 'pointer',
                            padding: '2px 4px',
                          }}
                        >
                          {placesExpanded ? 'Show less ▲' : `Show all ▼`}
                        </button>
                      )}
                      {isEditing && (
                        <button
                          onClick={handlePlaceAdd}
                          style={{
                            background: '#e8f5e9',
                            border: '1px solid #81c784',
                            color: '#2e7d32',
                            fontSize: '12px',
                            cursor: 'pointer',
                            padding: '2px 8px',
                            borderRadius: '4px',
                            fontWeight: 500,
                          }}
                        >
                          + Add
                        </button>
                      )}
                    </div>
                  </div>
                  {mentionedPlaces.length > 0 ? (
                    <div style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                      maxHeight: (isEditing || placesExpanded) ? '300px' : 'none',
                      overflowY: (isEditing || placesExpanded) ? 'auto' : 'visible',
                      background: '#fff8e1',
                      borderRadius: '6px',
                      padding: '8px',
                      border: '1px solid #ffcc80',
                    }}>
                      {(isEditing || placesExpanded ? mentionedPlaces : mentionedPlaces.slice(0, 3)).map((place, i) => (
                        <PlaceItem
                          key={i}
                          place={place}
                          index={i}
                          isEditing={isEditing}
                          onUpdate={handlePlaceUpdate}
                          onRemove={handlePlaceRemove}
                        />
                      ))}
                    </div>
                  ) : (
                    isEditing ? (
                      <div style={{
                        color: '#999',
                        fontSize: '12px',
                        fontStyle: 'italic',
                        padding: '8px',
                        background: '#fafafa',
                        borderRadius: '4px',
                      }}>
                        No places yet. Click "+ Add" to add a place.
                      </div>
                    ) : (
                      <span style={{ fontSize: '14px', color: '#999', fontStyle: 'italic' }}>None</span>
                    )
                  )}
                </div>

                {/* Event Date - hidden if empty and already extracted */}
                {(isEditing || post.eventDate || !hasBeenExtracted) && (
                  <div style={{ marginBottom: '12px' }}>
                    <label style={{ fontSize: '12px', color: '#666', display: 'block', marginBottom: '4px' }}>
                      📅 Event Date
                    </label>
                    {isEditing ? (
                      <input
                        type="text"
                        value={eventDate}
                        onChange={(e) => setEventDate(e.target.value)}
                        placeholder="e.g., December 25, 2024"
                        style={{
                          width: '100%',
                          padding: '8px',
                          borderRadius: '4px',
                          border: '1px solid #ddd',
                          fontSize: '14px',
                        }}
                      />
                    ) : (
                      <span style={{ fontSize: '14px' }}>
                        {post.eventDate || <em style={{ color: '#999' }}>None</em>}
                      </span>
                    )}
                  </div>
                )}

                {/* Hashtags */}
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ fontSize: '12px', color: '#666', display: 'block', marginBottom: '4px' }}>
                    #️⃣ Hashtags
                  </label>
                  {isEditing ? (
                    <input
                      type="text"
                      value={hashtags}
                      onChange={(e) => setHashtags(e.target.value)}
                      placeholder="e.g., travel, food, paris"
                      style={{
                        width: '100%',
                        padding: '8px',
                        borderRadius: '4px',
                        border: '1px solid #ddd',
                        fontSize: '14px',
                      }}
                    />
                  ) : (
                    <span style={{ fontSize: '14px' }}>
                      {post.hashtags && post.hashtags.length > 0 ? (
                        <span style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                          {post.hashtags.map((tag, i) => (
                            <span
                              key={i}
                              style={{
                                background: '#e0e0e0',
                                padding: '2px 8px',
                                borderRadius: '4px',
                                fontSize: '12px',
                              }}
                            >
                              #{tag}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <em style={{ color: '#999' }}>None</em>
                      )}
                    </span>
                  )}
                </div>

                {/* Mentions (Brands/Collaborators) */}
                <div>
                  <label style={{ fontSize: '12px', color: '#666', display: 'block', marginBottom: '4px' }}>
                    🏷️ Featured Accounts
                  </label>
                  <span style={{ fontSize: '14px' }}>
                    {post.mentions && post.mentions.length > 0 ? (
                      <span style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {post.mentions.map((mention, i) => (
                          <a
                            key={i}
                            href={`https://instagram.com/${mention.replace('@', '')}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              background: '#e3f2fd',
                              color: '#1976d2',
                              padding: '2px 8px',
                              borderRadius: '4px',
                              fontSize: '12px',
                              textDecoration: 'none',
                            }}
                          >
                            {mention.startsWith('@') ? mention : `@${mention}`}
                          </a>
                        ))}
                      </span>
                    ) : (
                      <em style={{ color: '#999' }}>None</em>
                    )}
                  </span>
                </div>
              </div>
            </div>

            {/* AI Reasoning Section */}
            {hasReasons && (
              <div style={{ marginBottom: '20px' }}>
                <button
                  onClick={() => setShowReasons(!showReasons)}
                  style={{
                    background: 'none',
                    border: '1px solid #ddd',
                    padding: '8px 12px',
                    borderRadius: '8px',
                    fontSize: '13px',
                    cursor: 'pointer',
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    color: '#666',
                  }}
                >
                  <span>🤖 AI Reasoning</span>
                  <span>{showReasons ? '▲' : '▼'}</span>
                </button>

                {showReasons && (
                  <div style={{
                    marginTop: '8px',
                    padding: '12px',
                    background: '#f5f5f5',
                    borderRadius: '8px',
                    fontSize: '12px',
                    fontFamily: 'monospace',
                    whiteSpace: 'pre-wrap',
                    maxHeight: '300px',
                    overflow: 'auto',
                  }}>
                    {JSON.stringify({
                      mentionedPlaces: {
                        count: post.mentionedPlaces?.length || 0,
                        reason: post.mentionedPlacesReason || 'No reason provided',
                      },
                      mentions: {
                        value: post.mentions || [],
                        reason: post.mentionsReason || 'No reason provided',
                      },
                      eventDate: {
                        value: post.eventDate || null,
                        reason: post.eventDateReason || 'No reason provided',
                      },
                      hashtags: {
                        value: post.hashtags || [],
                        reason: post.hashtagsReason || 'No reason provided',
                      },
                      categories: {
                        value: categories,
                        reason: post.categoriesReason || 'No reason provided',
                      },
                    }, null, 2)}
                  </div>
                )}
              </div>
            )}

            {/* Meta info */}
            <div style={{ fontSize: '12px', color: '#999' }}>
              <p style={{ margin: '4px 0' }}>Saved: {new Date(post.savedAt).toLocaleString()}</p>
              {post.timestamp && (
                <p style={{ margin: '4px 0' }}>Posted: {new Date(post.timestamp).toLocaleString()}</p>
              )}
              {post.lastEditedBy && post.lastEditedAt && (
                <p style={{
                  margin: '8px 0 4px 0',
                  padding: '6px 10px',
                  background: post.lastEditedBy === 'user' ? '#e3f2fd' : '#f3e5f5',
                  borderRadius: '4px',
                  display: 'inline-block',
                }}>
                  {post.lastEditedBy === 'user' ? '✏️ Manually edited' : '🤖 AI extracted'} on {new Date(post.lastEditedAt).toLocaleString()}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Next Button */}
      {hasNext && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onNext?.();
          }}
          style={{
            position: 'absolute',
            right: '30px',
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'none',
            border: 'none',
            color: 'white',
            fontSize: '64px',
            cursor: 'pointer',
            padding: '20px',
            opacity: 0.7,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1001,
            transition: 'opacity 0.2s, transform 0.2s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = '1';
            e.currentTarget.style.transform = 'translateY(-50%) scale(1.1)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = '0.7';
            e.currentTarget.style.transform = 'translateY(-50%) scale(1)';
          }}
          title="Next post"
        >
          ›
        </button>
      )}
    </div>
  );
}
