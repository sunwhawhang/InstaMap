import { Category } from '../shared/types';

interface CategoriesProps {
  categories: Category[];
  onCategorySelect: (category: Category) => void;
}

export function Categories({ categories, onCategorySelect }: CategoriesProps) {
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

  // Default colors for categories if not specified
  const defaultColors = [
    '#E1306C', '#833AB4', '#F77737', '#58c322',
    '#0095f6', '#8B5CF6', '#EC4899', '#14B8A6',
  ];

  return (
    <div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
        gap: '16px',
      }}>
        {categories.map((category, index) => (
          <div
            key={category.id}
            onClick={() => onCategorySelect(category)}
            style={{
              background: 'var(--surface)',
              borderRadius: 'var(--radius)',
              padding: '20px',
              cursor: 'pointer',
              boxShadow: 'var(--shadow)',
              transition: 'transform 0.2s, box-shadow 0.2s',
              borderLeft: `4px solid ${category.color || defaultColors[index % defaultColors.length]}`,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-4px)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
            }}
          >
            <h3 style={{
              fontSize: '18px',
              fontWeight: '600',
              marginBottom: '8px',
            }}>
              {category.name}
            </h3>

            {category.description && (
              <p style={{
                fontSize: '14px',
                color: 'var(--text-secondary)',
                marginBottom: '12px',
              }}>
                {category.description}
              </p>
            )}

            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '13px',
              color: 'var(--text-secondary)',
            }}>
              <span style={{
                background: 'var(--background)',
                padding: '4px 12px',
                borderRadius: '12px',
              }}>
                {category.postCount} posts
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
