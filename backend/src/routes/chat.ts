import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { neo4jService } from '../services/neo4j.js';
import { embeddingsService } from '../services/embeddings.js';
import { claudeService } from '../services/claude.js';
import { ChatRequest, ChatMessage, InstagramPost } from '../types/index.js';

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
    const { message, conversationId } = req.body;

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

    // Tool handler: gives Claude the ability to query posts and categories
    const searchedPosts: InstagramPost[] = [];

    const toolHandler = async (toolName: string, toolInput: Record<string, unknown>) => {
      if (toolName === 'search_posts') {
        const query = String(toolInput.query || '');
        const limit = Math.min(Number(toolInput.limit || 5), 10);
        try {
          const embedding = await embeddingsService.generateEmbedding(query);
          const { posts: results } = await neo4jService.searchPosts(embedding, query, {
            topK: limit * 2,
            minSimilarity: 0.3,
            categoryBoost: 0.1,
            exactPhraseBoost: 0.05,
            limit,
            offset: 0,
          });
          // Track full posts for relatedPosts response
          for (const p of results) {
            if (!searchedPosts.find(s => s.id === p.id)) searchedPosts.push(p);
          }
          // Return simplified version to Claude (save tokens)
          const simplified = results.map(p => ({
            id: p.id,
            instagramId: p.instagramId,
            caption: p.caption ? p.caption.slice(0, 200) : undefined,
            imageUrl: p.imageUrl,
            thumbnailUrl: p.thumbnailUrl,
          }));
          return { posts: simplified, count: simplified.length };
        } catch {
          return { posts: [], count: 0, error: 'Search failed' };
        }
      }

      if (toolName === 'get_categories') {
        const categories = await neo4jService.getCategories();
        return categories.map(c => ({ id: c.id, name: c.name, postCount: c.postCount, isParent: c.isParent }));
      }

      return { error: 'Unknown tool' };
    };

    const response = await claudeService.chat(message, conversationMessages, toolHandler);

    // relatedPosts = posts fetched by search_posts tool (up to 3)
    const relatedPosts = searchedPosts.slice(0, 3);

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

