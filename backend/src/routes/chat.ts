import { Router, Request, Response } from 'express';
import { neo4jService } from '../services/neo4j.js';
import { claudeService } from '../services/claude.js';
import { ChatRequest } from '../types/index.js';

export const chatRouter = Router();

// Chat with AI about posts
chatRouter.post('/', async (req: Request<{}, {}, ChatRequest>, res: Response) => {
  try {
    const { message, context } = req.body;
    
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Get posts for context
    let posts = await neo4jService.getPosts({ limit: 50 });
    
    // If specific post IDs provided, filter to those
    if (context?.postIds && context.postIds.length > 0) {
      posts = posts.filter(p => context.postIds!.includes(p.id));
    }

    const response = await claudeService.chat(message, posts);
    
    // Try to find related posts based on the conversation
    // This is a simple approach - could be enhanced with semantic search
    const keywords = extractKeywords(message);
    const relatedPosts = posts.filter(p => {
      const caption = p.caption.toLowerCase();
      return keywords.some(kw => caption.includes(kw.toLowerCase()));
    }).slice(0, 3);

    res.json({
      ...response,
      relatedPosts: relatedPosts.length > 0 ? relatedPosts : undefined,
    });
  } catch (error) {
    console.error('Chat failed:', error);
    res.status(500).json({ error: 'Failed to process chat message' });
  }
});

// Simple keyword extraction
function extractKeywords(text: string): string[] {
  // Remove common words and extract potential keywords
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
    'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
    'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above',
    'below', 'between', 'under', 'again', 'further', 'then', 'once',
    'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
    'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such',
    'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too',
    'very', 'just', 'and', 'but', 'if', 'or', 'because', 'until',
    'while', 'although', 'though', 'after', 'before', 'when', 'whenever',
    'where', 'wherever', 'whether', 'which', 'who', 'whom', 'whose',
    'what', 'whatever', 'show', 'me', 'my', 'find', 'posts', 'about',
    'get', 'i', 'you', 'we', 'they', 'it', 'this', 'that', 'these', 'those',
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));

  return [...new Set(words)];
}
