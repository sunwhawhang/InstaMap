import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { neo4jService } from '../services/neo4j.js';
import { claudeService } from '../services/claude.js';
import { ChatRequest, ChatMessage } from '../types/index.js';

export const chatRouter = Router();

// List all conversations
chatRouter.get('/conversations', async (_req: Request, res: Response) => {
  try {
    const conversations = await neo4jService.listConversations();
    res.json(conversations);
  } catch (error) {
    console.error('Failed to list conversations:', error);
    res.status(500).json({ error: 'Failed to list conversations' });
  }
});

// Get a single conversation with messages
chatRouter.get('/conversations/:id', async (req: Request, res: Response) => {
  try {
    const conversation = await neo4jService.getConversation(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    res.json(conversation);
  } catch (error) {
    console.error('Failed to get conversation:', error);
    res.status(500).json({ error: 'Failed to get conversation' });
  }
});

// Chat with AI about posts
chatRouter.post('/', async (req: Request<{}, {}, ChatRequest>, res: Response) => {
  try {
    const { message, context, conversationId } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Load existing conversation history if conversationId provided
    let conversationMessages: ChatMessage[] = [];
    let resolvedConversationId = conversationId || uuidv4();
    let isNewConversation = !conversationId;

    if (conversationId) {
      const existing = await neo4jService.getConversation(conversationId);
      if (existing) {
        conversationMessages = existing.messages;
      } else {
        // conversationId provided but not found — treat as new
        isNewConversation = true;
      }
    }

    // Get posts for context
    let posts = await neo4jService.getPosts({ limit: 50 });

    // If specific post IDs provided, filter to those
    if (context?.postIds && context.postIds.length > 0) {
      posts = posts.filter(p => context.postIds!.includes(p.id));
    }

    const response = await claudeService.chat(message, posts, conversationMessages);

    // Try to find related posts based on the conversation
    const keywords = extractKeywords(message);
    const relatedPosts = posts.filter(p => {
      const caption = p.caption.toLowerCase();
      return keywords.some(kw => caption.includes(kw.toLowerCase()));
    }).slice(0, 3);

    // Build the user message that was sent
    const userMessage: ChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    };

    // Full updated message list
    const updatedMessages: ChatMessage[] = [
      ...conversationMessages,
      userMessage,
      { ...response, relatedPosts: relatedPosts.length > 0 ? relatedPosts : undefined },
    ];

    // Persist conversation
    if (isNewConversation) {
      const title = message.slice(0, 60);
      await neo4jService.createConversation(resolvedConversationId, title, updatedMessages);
    } else {
      await neo4jService.updateConversation(resolvedConversationId, updatedMessages);
    }

    res.json({
      ...response,
      relatedPosts: relatedPosts.length > 0 ? relatedPosts : undefined,
      conversationId: resolvedConversationId,
    });
  } catch (error) {
    console.error('Chat failed:', error);
    res.status(500).json({ error: 'Failed to process chat message' });
  }
});

// Simple keyword extraction
function extractKeywords(text: string): string[] {
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
