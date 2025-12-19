import { Router, Request, Response } from 'express';
import { neo4jService } from '../services/neo4j.js';
import { embeddingsService } from '../services/embeddings.js';
import { claudeService } from '../services/claude.js';
import { InstagramPost, SyncPostsRequest, AutoCategorizeRequest } from '../types/index.js';

export const postsRouter = Router();

// Sync posts from extension
postsRouter.post('/sync', async (req: Request<{}, {}, SyncPostsRequest>, res: Response) => {
  try {
    const { posts } = req.body;
    
    if (!Array.isArray(posts)) {
      return res.status(400).json({ error: 'Posts must be an array' });
    }

    console.log(`Syncing ${posts.length} posts...`);
    
    const synced = await neo4jService.upsertPosts(posts);
    
    // Generate embeddings for posts with captions (in background)
    generateEmbeddingsInBackground(posts);

    res.json({ 
      synced, 
      total: posts.length,
      message: `Successfully synced ${synced} posts`,
    });
  } catch (error) {
    console.error('Sync failed:', error);
    res.status(500).json({ error: 'Failed to sync posts' });
  }
});

// Get all posts
postsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const categoryId = req.query.category as string;

    const posts = await neo4jService.getPosts({ limit, offset, categoryId });
    res.json(posts);
  } catch (error) {
    console.error('Failed to get posts:', error);
    res.status(500).json({ error: 'Failed to get posts' });
  }
});

// Get single post
postsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const post = await neo4jService.getPostById(req.params.id);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json(post);
  } catch (error) {
    console.error('Failed to get post:', error);
    res.status(500).json({ error: 'Failed to get post' });
  }
});

// Get similar posts
postsRouter.get('/:id/similar', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 5;
    const post = await neo4jService.getPostById(req.params.id);
    
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (!post.embedding || post.embedding.length === 0) {
      // Generate embedding if missing
      try {
        const embedding = await embeddingsService.generatePostEmbedding(post);
        await neo4jService.updatePostEmbedding(post.id, embedding);
        post.embedding = embedding;
      } catch (e) {
        return res.json([]); // Return empty if can't generate embedding
      }
    }

    const similarPosts = await neo4jService.findSimilarPosts(post.embedding, limit + 1);
    // Filter out the original post
    const filtered = similarPosts.filter(p => p.id !== post.id).slice(0, limit);
    
    res.json(filtered);
  } catch (error) {
    console.error('Failed to find similar posts:', error);
    res.status(500).json({ error: 'Failed to find similar posts' });
  }
});

// Auto-categorize posts
postsRouter.post('/auto-categorize', async (req: Request<{}, {}, AutoCategorizeRequest>, res: Response) => {
  try {
    const { postIds } = req.body;
    
    if (!Array.isArray(postIds) || postIds.length === 0) {
      return res.status(400).json({ error: 'postIds must be a non-empty array' });
    }

    const existingCategories = await neo4jService.getCategories();
    let categorized = 0;

    for (const postId of postIds) {
      try {
        const post = await neo4jService.getPostById(postId);
        if (!post) continue;

        const categoryNames = await claudeService.categorizePost(post, existingCategories);
        
        for (const name of categoryNames) {
          // Create category if it doesn't exist
          let category = existingCategories.find(c => 
            c.name.toLowerCase() === name.toLowerCase()
          );
          
          if (!category) {
            category = await neo4jService.createCategory(name);
            existingCategories.push(category);
          }
          
          await neo4jService.assignPostToCategory(postId, category.id);
        }
        
        categorized++;
      } catch (e) {
        console.error(`Failed to categorize post ${postId}:`, e);
      }
    }

    res.json({ 
      categorized, 
      total: postIds.length,
      message: `Categorized ${categorized} posts`,
    });
  } catch (error) {
    console.error('Auto-categorize failed:', error);
    res.status(500).json({ error: 'Failed to auto-categorize posts' });
  }
});

// Assign post to category
postsRouter.put('/:postId/categories/:categoryId', async (req: Request, res: Response) => {
  try {
    const { postId, categoryId } = req.params;
    await neo4jService.assignPostToCategory(postId, categoryId);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to assign category:', error);
    res.status(500).json({ error: 'Failed to assign category' });
  }
});

// Get post categories
postsRouter.get('/:postId/categories', async (req: Request, res: Response) => {
  try {
    const categories = await neo4jService.getPostCategories(req.params.postId);
    res.json(categories);
  } catch (error) {
    console.error('Failed to get post categories:', error);
    res.status(500).json({ error: 'Failed to get post categories' });
  }
});

// Background job to generate embeddings
async function generateEmbeddingsInBackground(posts: InstagramPost[]) {
  const postsWithCaptions = posts.filter(p => p.caption && p.caption.trim().length > 0);
  
  for (const post of postsWithCaptions) {
    try {
      const embedding = await embeddingsService.generatePostEmbedding(post);
      await neo4jService.updatePostEmbedding(post.id, embedding);
      console.log(`Generated embedding for post ${post.id}`);
    } catch (error) {
      console.error(`Failed to generate embedding for post ${post.id}:`, error);
    }
  }
}
