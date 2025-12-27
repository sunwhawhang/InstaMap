import { useState } from 'react';
import { Category } from '../shared/types';

interface CategoryTreeProps {
  categories: (Category & { children?: Category[] })[];
  onCategorySelect: (category: Category) => void;
}

export function CategoryTree({ categories, onCategorySelect }: CategoryTreeProps) {
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());

  const toggleExpand = (parentId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = new Set(expandedParents);
    if (next.has(parentId)) next.delete(parentId);
    else next.add(parentId);
    setExpandedParents(next);
  };

  if (categories.length === 0) return null;

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
      gap: '16px',
      alignItems: 'start'
    }}>
      {categories.map((parent) => (
        <div
          key={parent.id}
          style={{
            background: 'var(--surface)',
            borderRadius: 'var(--radius)',
            overflow: 'hidden',
            border: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            // If expanded, span full width to show children properly
            gridColumn: expandedParents.has(parent.id) ? '1 / -1' : 'auto'
          }}
        >
          <div
            onClick={() => onCategorySelect(parent)}
            style={{
              padding: '12px 16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              cursor: 'pointer',
              background: parent.isParent ? 'var(--background)' : 'transparent',
              borderLeft: `4px solid ${parent.color || '#0095f6'}`
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
              {parent.isParent && (
                <span
                  onClick={(e) => toggleExpand(parent.id, e)}
                  style={{
                    fontSize: '10px',
                    cursor: 'pointer',
                    width: '18px',
                    height: '18px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '4px',
                    background: 'rgba(0,0,0,0.05)',
                    transition: 'transform 0.2s',
                    transform: expandedParents.has(parent.id) ? 'rotate(90deg)' : 'none'
                  }}
                >
                  ▶
                </span>
              )}
              {!parent.isParent && <div style={{ width: '18px' }}></div>}
              <h3 style={{
                fontSize: '14px',
                fontWeight: '600',
                margin: 0,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}>
                {parent.name}
              </h3>
            </div>
            <span style={{
              fontSize: '11px',
              color: 'var(--text-secondary)',
              background: 'var(--surface)',
              padding: '1px 6px',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              flexShrink: 0
            }}>
              {parent.postCount}
            </span>
          </div>

          {expandedParents.has(parent.id) && parent.children && parent.children.length > 0 && (
            <div style={{
              padding: '12px 16px 16px 40px',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: '8px',
              background: 'rgba(0,0,0,0.02)',
              borderTop: '1px solid var(--border)'
            }}>
              {parent.children.map((child) => (
                <div
                  key={child.id}
                  onClick={() => onCategorySelect(child)}
                  style={{
                    padding: '8px 12px',
                    background: 'var(--surface)',
                    borderRadius: '6px',
                    fontSize: '13px',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    border: '1px solid var(--border)',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
                  }}
                >
                  <span style={{ fontWeight: '500' }}>{child.name}</span>
                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{child.postCount}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

