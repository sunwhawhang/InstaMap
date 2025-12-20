import Anthropic from '@anthropic-ai/sdk';
import { InstagramPost, Category, ChatMessage, PostExtraction } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

const MODEL = 'claude-haiku-4-5-20251001';
const BATCH_SIZE = 20;

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

  // Tool schema for batch extraction
  private getBatchExtractionTool(): Anthropic.Messages.Tool {
    return {
      name: 'extract_posts_batch',
      description: 'Extract structured metadata from multiple Instagram post captions',
      input_schema: {
        type: 'object',
        properties: {
          extractions: {
            type: 'array',
            description: 'Array of extractions, one per post in the same order as input',
            items: {
              type: 'object',
              properties: {
                postId: {
                  type: 'string',
                  description: 'The post ID from the input',
                },
                hashtags: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'All hashtags from the caption, without the # symbol',
                },
                location: {
                  type: 'string',
                  description: 'City, Country or specific address (e.g., "Shoreditch, London, UK"). Empty string if none.',
                },
                venue: {
                  type: 'string',
                  description: 'Restaurant, shop, hotel, or venue name. Empty string if none.',
                },
                categories: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Relevant categories (Travel, Food, Tech, Fashion, Fitness, Photography, Art, Music, Nature, Pets, Family, Lifestyle, Funny, Educational, Business, Beauty, Sports, Gaming, DIY, Cooking). Up to 10-15.',
                },
                eventDate: {
                  type: 'string',
                  description: 'ISO date (YYYY-MM-DD) or range. Empty string if none.',
                },
              },
              required: ['postId', 'hashtags', 'location', 'venue', 'categories', 'eventDate'],
            },
          },
        },
        required: ['extractions'],
      },
    };
  }

  /**
   * Option A: Extract data from multiple posts in batches (real-time)
   * Processes posts in batches of BATCH_SIZE, returns results as they complete
   */
  async extractPostsBatch(
    posts: InstagramPost[],
    existingCategories: Category[],
    onProgress?: (completed: number, total: number) => void
  ): Promise<Map<string, PostExtraction>> {
    const client = this.getClient();
    const results = new Map<string, PostExtraction>();

    const categoryHint = existingCategories.length > 0
      ? `Prefer existing categories if relevant: ${existingCategories.map(c => c.name).join(', ')}`
      : '';

    // Process in batches
    for (let i = 0; i < posts.length; i += BATCH_SIZE) {
      const batch = posts.slice(i, i + BATCH_SIZE);

      const postsText = batch
        .map((p, idx) => `[${idx + 1}] ID: ${p.id}\nCaption: "${p.caption || 'No caption'}"`)
        .join('\n\n');

      const prompt = `Extract structured metadata from these ${batch.length} Instagram posts.
${categoryHint}

POSTS:
${postsText}

Use the extract_posts_batch tool. Return extractions in the same order as the posts.`;

      try {
        const response = await client.messages.create({
          model: MODEL,
          max_tokens: 4096,
          tools: [this.getBatchExtractionTool()],
          tool_choice: { type: 'tool', name: 'extract_posts_batch' },
          messages: [{ role: 'user', content: prompt }],
        });

        // Extract results from tool call
        for (const block of response.content) {
          if (block.type === 'tool_use' && block.name === 'extract_posts_batch') {
            const input = block.input as { extractions: Array<Record<string, unknown>> };
            for (const ext of input.extractions) {
              const postId = ext.postId as string;
              results.set(postId, {
                hashtags: Array.isArray(ext.hashtags) ? ext.hashtags as string[] : [],
                location: (ext.location as string) || null,
                venue: (ext.venue as string) || null,
                categories: Array.isArray(ext.categories) ? ext.categories as string[] : [],
                eventDate: (ext.eventDate as string) || null,
              });
            }
          }
        }
      } catch (error) {
        console.error(`Batch extraction failed for posts ${i}-${i + batch.length}:`, error);
      }

      if (onProgress) {
        onProgress(Math.min(i + BATCH_SIZE, posts.length), posts.length);
      }
    }

    return results;
  }

  /**
   * Option B: Submit posts to Anthropic Batch API (async, 50% cheaper)
   * Returns a batch ID that can be polled for results
   */
  async submitBatchExtraction(
    posts: InstagramPost[],
    existingCategories: Category[]
  ): Promise<{ batchId: string; requestCount: number }> {
    const client = this.getClient();

    const categoryHint = existingCategories.length > 0
      ? `Prefer existing categories if relevant: ${existingCategories.map(c => c.name).join(', ')}`
      : '';

    // Create individual requests for each post
    const requests = posts.map((post) => ({
      custom_id: post.id,
      params: {
        model: MODEL,
        max_tokens: 512,
        tools: [this.getSingleExtractionTool()],
        tool_choice: { type: 'tool' as const, name: 'extract_post_data' },
        messages: [
          {
            role: 'user' as const,
            content: `Extract structured metadata from this Instagram post.
${categoryHint}

Caption: "${post.caption || 'No caption'}"

Use the extract_post_data tool.`,
          },
        ],
      },
    }));

    // Submit batch
    const batch = await client.messages.batches.create({
      requests,
    });

    return {
      batchId: batch.id,
      requestCount: requests.length,
    };
  }

  /**
   * Check batch status only (no results fetching)
   */
  async getBatchStatus(batchId: string): Promise<{
    status: 'in_progress' | 'ended' | 'canceling' | 'canceled';
    progress?: { completed: number; total: number };
  }> {
    const client = this.getClient();
    const batch = await client.messages.batches.retrieve(batchId);

    return {
      status: batch.processing_status,
      progress: {
        completed: batch.request_counts.succeeded + batch.request_counts.errored,
        total: batch.request_counts.processing + batch.request_counts.succeeded + batch.request_counts.errored,
      },
    };
  }

  /**
   * Check batch status and get results if complete
   */
  async getBatchResults(batchId: string): Promise<{
    status: 'in_progress' | 'ended' | 'canceling' | 'canceled';
    results?: Map<string, PostExtraction>;
    progress?: { completed: number; total: number };
  }> {
    const client = this.getClient();

    const batch = await client.messages.batches.retrieve(batchId);

    if (batch.processing_status !== 'ended') {
      return {
        status: batch.processing_status,
        progress: {
          completed: batch.request_counts.succeeded + batch.request_counts.errored,
          total: batch.request_counts.processing + batch.request_counts.succeeded + batch.request_counts.errored,
        },
      };
    }

    // Batch complete - fetch results
    const results = new Map<string, PostExtraction>();

    console.log(`[InstaMap] Fetching results for batch ${batchId}...`);

    // Stream results from the batch
    const batchResults = await client.messages.batches.results(batchId);
    for await (const result of batchResults) {
      if (result.result.type === 'succeeded') {
        const message = result.result.message;
        for (const block of message.content) {
          if (block.type === 'tool_use' && block.name === 'extract_post_data') {
            const input = block.input as Record<string, unknown>;
            results.set(result.custom_id, {
              hashtags: Array.isArray(input.hashtags) ? input.hashtags as string[] : [],
              location: (input.location as string) || null,
              venue: (input.venue as string) || null,
              categories: Array.isArray(input.categories) ? input.categories as string[] : [],
              eventDate: (input.eventDate as string) || null,
            });
          }
        }
      }
    }

    return { status: 'ended', results };
  }

  /**
   * Cancel a running batch
   */
  async cancelBatch(batchId: string): Promise<void> {
    const client = this.getClient();
    await client.messages.batches.cancel(batchId);
  }

  // Single post extraction tool (for Batch API)
  private getSingleExtractionTool(): Anthropic.Messages.Tool {
    return {
      name: 'extract_post_data',
      description: 'Extract structured metadata from an Instagram post caption',
      input_schema: {
        type: 'object',
        properties: {
          hashtags: {
            type: 'array',
            items: { type: 'string' },
            description: 'All hashtags from the caption, without the # symbol',
          },
          location: {
            type: 'string',
            description: 'City, Country or specific address. Empty string if none.',
          },
          venue: {
            type: 'string',
            description: 'Restaurant, shop, hotel, or venue name. Empty string if none.',
          },
          categories: {
            type: 'array',
            items: { type: 'string' },
            description: 'Relevant categories. Up to 10-15.',
          },
          eventDate: {
            type: 'string',
            description: 'ISO date or range. Empty string if none.',
          },
        },
        required: ['hashtags', 'location', 'venue', 'categories', 'eventDate'],
      },
    };
  }

  /**
   * Legacy single post extraction (for backwards compatibility)
   */
  async extractPostData(post: InstagramPost, existingCategories: Category[]): Promise<PostExtraction> {
    const results = await this.extractPostsBatch([post], existingCategories);
    return results.get(post.id) || { hashtags: [], location: null, venue: null, categories: [], eventDate: null };
  }

  /**
   * Legacy method - wraps extractPostData for backwards compatibility
   */
  async categorizePost(post: InstagramPost, existingCategories: Category[]): Promise<{ categories: string[]; location: string | null }> {
    const result = await this.extractPostData(post, existingCategories);
    return {
      categories: result.categories,
      location: result.location,
    };
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

    const postsContext = posts.length > 0
      ? `The user has ${posts.length} saved Instagram posts. Here are some of them:\n${posts.slice(0, 10).map((p, i) =>
        `${i + 1}. Caption: "${p.caption || 'No caption'}"`
      ).join('\n')
      }`
      : 'The user has no saved posts yet.';

    const systemPrompt = `You are InstaMap, a helpful AI assistant that helps users explore and understand their saved Instagram posts.

${postsContext}

Help the user find, understand, and organize their saved posts. Be friendly, concise, and helpful.`;

    const messages: Anthropic.MessageParam[] = [
      ...conversationHistory.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: message },
    ];

    const response = await client.messages.create({
      model: MODEL,
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
}

export const claudeService = new ClaudeService();
