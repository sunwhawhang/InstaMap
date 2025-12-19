import { Router, Request, Response } from 'express';
import { neo4jService } from '../services/neo4j.js';
import { embeddingsService } from '../services/embeddings.js';
import { SearchRequest } from '../types/index.js';

export const searchRouter = Router();

// Semantic search
searchRouter.post('/', async (req: Request<{}, {}, SearchRequest>, res: Response) => {
  try {
    const { query, limit = 10 } = req.body;
    
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Query is required' });
    }

    console.log(`Searching for: "${query}"`);

    // Generate embedding for the search query
    const queryEmbedding = await embeddingsService.generateEmbedding(query);
    
    // Search for similar posts
    const results = await neo4jService.findSimilarPosts(queryEmbedding, limit);
    
    res.json(results);
  } catch (error) {
    console.error('Search failed:', error);
    
    // Fallback to basic text search if embedding fails
    try {
      const posts = await neo4jService.getPosts({ limit: 50 });
      const query = req.body.query?.toLowerCase() || '';
      const filtered = posts.filter(p => 
        p.caption?.toLowerCase().includes(query) ||
        p.ownerUsername?.toLowerCase().includes(query)
      );
      res.json(filtered.slice(0, req.body.limit || 10));
    } catch (fallbackError) {
      res.status(500).json({ error: 'Search failed' });
    }
  }
});

// Text-based search (no embeddings required)
searchRouter.get('/text', async (req: Request, res: Response) => {
  try {
    const query = (req.query.q as string)?.toLowerCase() || '';
    const limit = parseInt(req.query.limit as string) || 20;
    
    if (!query) {
      return res.status(400).json({ error: 'Query parameter q is required' });
    }

    const posts = await neo4jService.getPosts({ limit: 100 });
    const filtered = posts.filter(p => 
      p.caption?.toLowerCase().includes(query) ||
      p.ownerUsername?.toLowerCase().includes(query)
    );
    
    res.json(filtered.slice(0, limit));
  } catch (error) {
    console.error('Text search failed:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});
