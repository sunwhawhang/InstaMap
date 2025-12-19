import Anthropic from '@anthropic-ai/sdk';
import { InstagramPost, Category, ChatMessage } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

class ClaudeService {
  private client: Anthropic | null = null;

  private getClient(): Anthropic {
    if (!this.client) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY environment variable is not set');
      }
      this.client = new Anthropic({ apiKey });
    }
    return this.client;
  }

  /**
   * Auto-categorize posts based on their content
   */
  async categorizePost(post: InstagramPost, existingCategories: Category[]): Promise<string[]> {
    const client = this.getClient();

    const categoryNames = existingCategories.map(c => c.name).join(', ');
    
    const prompt = `You are a helpful assistant that categorizes Instagram posts.

Given this Instagram post:
- Caption: "${post.caption || 'No caption'}"
- Username: @${post.ownerUsername || 'unknown'}
- Is Video: ${post.isVideo ? 'Yes' : 'No'}

${existingCategories.length > 0 
  ? `Existing categories: ${categoryNames}\n\nAssign this post to 1-3 existing categories, or suggest new categories if none fit.`
  : 'Suggest 1-3 categories for this post.'}

Respond with ONLY a JSON array of category names, like: ["Travel", "Food", "Photography"]`;

    const response = await client.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    
    try {
      // Extract JSON array from response
      const match = text.match(/\[.*\]/s);
      if (match) {
        const categories = JSON.parse(match[0]);
        return Array.isArray(categories) ? categories : [];
      }
    } catch (e) {
      console.error('Failed to parse categories:', text);
    }

    return [];
  }

  /**
   * Chat with AI about posts
   */
  async chat(
    message: string, 
    posts: InstagramPost[],
    conversationHistory: ChatMessage[] = []
  ): Promise<ChatMessage> {
    const client = this.getClient();

    // Build context about posts
    const postsContext = posts.length > 0
      ? `The user has ${posts.length} saved Instagram posts. Here are some of them:\n${
          posts.slice(0, 10).map((p, i) => 
            `${i + 1}. Caption: "${p.caption || 'No caption'}" by @${p.ownerUsername || 'unknown'}`
          ).join('\n')
        }`
      : 'The user has no saved posts yet.';

    const systemPrompt = `You are InstaMap, a helpful AI assistant that helps users explore and understand their saved Instagram posts.

${postsContext}

Help the user find, understand, and organize their saved posts. You can:
- Answer questions about their posts
- Help them find posts by topic, person, or theme
- Suggest ways to organize their collection
- Provide insights about their saved content

Be friendly, concise, and helpful. If you mention specific posts, describe them clearly.`;

    // Build messages array
    const messages: Anthropic.MessageParam[] = [
      ...conversationHistory.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: message },
    ];

    const response = await client.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 1000,
      system: systemPrompt,
      messages,
    });

    const responseText = response.content[0].type === 'text' 
      ? response.content[0].text 
      : 'I apologize, but I encountered an issue generating a response.';

    return {
      id: uuidv4(),
      role: 'assistant',
      content: responseText,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Extract entities from post caption
   */
  async extractEntities(caption: string): Promise<{ 
    people: string[];
    places: string[];
    brands: string[];
    topics: string[];
    hashtags: string[];
  }> {
    if (!caption || caption.trim().length === 0) {
      return { people: [], places: [], brands: [], topics: [], hashtags: [] };
    }

    const client = this.getClient();

    const prompt = `Extract entities from this Instagram post caption:

"${caption}"

Respond with ONLY a JSON object in this format:
{
  "people": ["names of people mentioned"],
  "places": ["locations, cities, countries"],
  "brands": ["brand names, companies"],
  "topics": ["general topics like food, travel, fitness"],
  "hashtags": ["hashtags without the # symbol"]
}`;

    const response = await client.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        return JSON.parse(match[0]);
      }
    } catch (e) {
      console.error('Failed to parse entities:', text);
    }

    return { people: [], places: [], brands: [], topics: [], hashtags: [] };
  }
}

export const claudeService = new ClaudeService();
