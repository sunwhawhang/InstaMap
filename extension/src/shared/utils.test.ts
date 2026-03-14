import { describe, it, expect } from 'vitest';
import { isInstagramUrlExpired, deduplicatePosts, computeNormalPageItems, sortByNewest } from './utils';

describe('sortByNewest', () => {
  it('sorts by savedAt DESC (newest first)', () => {
    const posts = [
      { savedAt: '2025-01-01' },
      { savedAt: '2025-03-07' },
      { savedAt: '2025-02-15' },
    ];
    const sorted = sortByNewest(posts);
    expect(sorted.map(p => p.savedAt)).toEqual(['2025-03-07', '2025-02-15', '2025-01-01']);
  });

  it('falls back to timestamp when savedAt is missing', () => {
    const posts = [
      { timestamp: '2025-01-01' },
      { savedAt: '2025-03-07' },
      { timestamp: '2025-02-15' },
    ];
    const sorted = sortByNewest(posts);
    expect(sorted[0].savedAt).toBe('2025-03-07');
    expect(sorted[2].timestamp).toBe('2025-01-01');
  });

  it('does not mutate the original array', () => {
    const posts = [{ savedAt: '2025-01-01' }, { savedAt: '2025-03-07' }];
    const sorted = sortByNewest(posts);
    expect(posts[0].savedAt).toBe('2025-01-01'); // unchanged
    expect(sorted[0].savedAt).toBe('2025-03-07');
  });
});

describe('isInstagramUrlExpired', () => {
  it('returns false for empty/falsy URLs', () => {
    expect(isInstagramUrlExpired('')).toBe(false);
    expect(isInstagramUrlExpired(null as unknown as string)).toBe(false);
  });

  it('returns true for Instagram CDN URL with expired oe= timestamp', () => {
    // oe=60000000 = Unix 1610612736 = Jan 2021 (definitely expired)
    const url = 'https://scontent-sjc3-1.cdninstagram.com/v/t51.2885-15/123.jpg?oe=60000000&oh=abc123';
    expect(isInstagramUrlExpired(url)).toBe(true);
  });

  it('returns false for Instagram CDN URL with future oe= timestamp', () => {
    // Set expiry far in the future: year 2040
    const futureTimestamp = Math.floor(new Date('2040-01-01').getTime() / 1000).toString(16);
    const url = `https://scontent-sjc3-1.cdninstagram.com/v/t51.2885-15/123.jpg?oe=${futureTimestamp}&oh=abc123`;
    expect(isInstagramUrlExpired(url)).toBe(false);
  });

  it('returns true for Instagram CDN URL WITHOUT oe= parameter (cdninstagram.com)', () => {
    const url = 'https://scontent-sjc3-1.cdninstagram.com/v/t51.2885-15/123.jpg?oh=abc123';
    expect(isInstagramUrlExpired(url)).toBe(true);
  });

  it('returns true for fbcdn.net URL without oe= parameter', () => {
    const url = 'https://scontent.fbcdn.net/v/t51.2885-15/123.jpg?_nc_cat=100';
    expect(isInstagramUrlExpired(url)).toBe(true);
  });

  it('returns false for non-Instagram URL without oe= parameter', () => {
    // A locally stored image or external URL should not be flagged
    const url = 'https://example.com/images/photo.jpg';
    expect(isInstagramUrlExpired(url)).toBe(false);
  });

  it('returns false for non-Instagram URL with oe= parameter', () => {
    // oe= on a non-CDN URL with future timestamp
    const futureTimestamp = Math.floor(new Date('2040-01-01').getTime() / 1000).toString(16);
    const url = `https://example.com/photo.jpg?oe=${futureTimestamp}`;
    expect(isInstagramUrlExpired(url)).toBe(false);
  });

  it('handles oe= as first query parameter', () => {
    const url = 'https://scontent-sjc3-1.cdninstagram.com/v/t51.2885-15/123.jpg?oe=60000000';
    expect(isInstagramUrlExpired(url)).toBe(true);
  });
});

describe('deduplicatePosts', () => {
  const post = (id: string) => ({ instagramId: id, caption: `Post ${id}` });

  it('returns existing posts when no new posts', () => {
    const existing = [post('A'), post('B')];
    const result = deduplicatePosts(existing, []);
    expect(result).toEqual(existing);
  });

  it('returns all posts when no overlap', () => {
    const existing = [post('A'), post('B')];
    const newPosts = [post('C'), post('D')];
    const result = deduplicatePosts(existing, newPosts);
    expect(result.map(p => p.instagramId)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('skips new posts that already exist', () => {
    const existing = [post('A'), post('B')];
    const newPosts = [post('B'), post('C')];
    const result = deduplicatePosts(existing, newPosts);
    expect(result.map(p => p.instagramId)).toEqual(['A', 'B', 'C']);
  });

  it('preserves existing post data over new post data', () => {
    const existing = [{ instagramId: 'A', caption: 'Original' }];
    const newPosts = [{ instagramId: 'A', caption: 'Updated' }];
    const result = deduplicatePosts(existing, newPosts);
    expect(result[0].caption).toBe('Original');
  });

  it('handles all duplicates', () => {
    const existing = [post('A'), post('B')];
    const newPosts = [post('A'), post('B')];
    const result = deduplicatePosts(existing, newPosts);
    expect(result).toEqual(existing);
  });
});

describe('computeNormalPageItems', () => {
  type Post = { instagramId: string; savedAt?: string; timestamp?: string };
  const post = (id: string, savedAt: string): Post => ({ instagramId: id, savedAt });

  it('shows only cloud posts when no unsynced posts exist', () => {
    const cloudPosts = [post('C1', '2025-03-07'), post('C2', '2025-03-06'), post('C3', '2025-03-05')];
    const result = computeNormalPageItems(
      cloudPosts, // all synced
      new Set(['C1', 'C2', 'C3']),
      cloudPosts,
      0, 3,
    );
    expect(result.map(p => p.instagramId)).toEqual(['C1', 'C2', 'C3']);
  });

  it('merges cloud and unsynced posts by savedAt DESC (newest first)', () => {
    // L1 is newest, C1 next, L2 is oldest
    const localPosts = [
      post('L1', '2025-03-07'), // newest unsynced
      post('L2', '2025-03-01'), // old unsynced
      post('C1', '2025-03-05'), // synced
    ];
    const syncedIds = new Set(['C1']);
    const cloudPosts = [post('C1', '2025-03-05')];

    const result = computeNormalPageItems(
      localPosts, syncedIds,
      cloudPosts,
      0, 10,
    );
    // Sorted: L1 (Mar 7), C1 (Mar 5), L2 (Mar 1)
    expect(result.map(p => p.instagramId)).toEqual(['L1', 'C1', 'L2']);
  });

  it('newer unsynced posts appear before older cloud posts', () => {
    const localPosts = [
      post('NEW1', '2025-03-07'), // just collected today, not synced
      post('NEW2', '2025-03-06'),
      post('C1', '2025-02-01'), // old synced post
    ];
    const syncedIds = new Set(['C1']);
    const cloudPosts = [post('C1', '2025-02-01')];

    const result = computeNormalPageItems(
      localPosts, syncedIds,
      cloudPosts,
      0, 10,
    );
    expect(result.map(p => p.instagramId)).toEqual(['NEW1', 'NEW2', 'C1']);
  });

  it('paginates correctly across merged list', () => {
    const localPosts = [
      post('L1', '2025-03-07'),
      post('C1', '2025-03-05'),
      post('C2', '2025-03-03'),
    ];
    const syncedIds = new Set(['C1', 'C2']);
    const cloudPosts = [post('C1', '2025-03-05'), post('C2', '2025-03-03')];

    // Page 1: first 2 items
    const page1 = computeNormalPageItems(localPosts, syncedIds, cloudPosts, 0, 2);
    expect(page1.map(p => p.instagramId)).toEqual(['L1', 'C1']);

    // Page 2: remaining
    const page2 = computeNormalPageItems(localPosts, syncedIds, cloudPosts, 2, 4);
    expect(page2.map(p => p.instagramId)).toEqual(['C2']);
  });

  it('returns empty when page is beyond all posts', () => {
    const localPosts = [post('L1', '2025-03-07'), post('C1', '2025-03-05')];
    const syncedIds = new Set(['C1']);
    const cloudPosts = [post('C1', '2025-03-05')];

    const result = computeNormalPageItems(localPosts, syncedIds, cloudPosts, 10, 20);
    expect(result).toEqual([]);
  });
});
