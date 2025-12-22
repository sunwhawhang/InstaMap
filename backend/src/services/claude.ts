import Anthropic from '@anthropic-ai/sdk';
import { InstagramPost, Category, ChatMessage, PostExtraction } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

const MODEL = 'claude-haiku-4-5-20251001';
const BATCH_SIZE = 20;

/**
 * Extract hashtags directly from caption text (no AI needed)
 * Returns array of hashtags without the # symbol
 */
export function extractHashtagsFromCaption(caption: string | null | undefined): string[] {
  if (!caption) return [];
  const matches = caption.match(/#(\w+)/g);
  if (!matches) return [];
  return [...new Set(matches.map(h => h.slice(1).toLowerCase()))];
}

/**
 * Extract @ mentions from caption (potential venues/accounts)
 */
export function extractMentionsFromCaption(caption: string | null | undefined): string[] {
  if (!caption) return [];
  const matches = caption.match(/@(\w+)/g);
  if (!matches) return [];
  return [...new Set(matches.map(m => m.slice(1)))];
}

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

  // Tool schema for batch extraction (real-time)
  private getBatchExtractionTool(): Anthropic.Messages.Tool {
    return {
      name: 'extract_posts_batch',
      description: 'Extract structured metadata from multiple Instagram post captions. Be thorough - look for ALL relevant information.',
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
                  description: 'Additional hashtags inferred from content (we auto-extract explicit #hashtags separately). Include topic keywords.',
                },
                hashtagsReason: {
                  type: 'string',
                  description: 'Why these hashtags were chosen, or "No additional hashtags needed" if none',
                },
                location: {
                  type: 'string',
                  description: 'Location in format "City, Country" or "Neighborhood, City, Country". Look for 📍 emoji, place names, addresses. Use null if truly no location.',
                },
                locationReason: {
                  type: 'string',
                  description: 'How location was determined (e.g., "Found after 📍 emoji", "Mentioned Hong Kong in text") or why null',
                },
                venue: {
                  type: 'string',
                  description: 'Restaurant, cafe, shop, hotel, or business name. Look for @mentions, names before location, business names. Use null if none.',
                },
                venueReason: {
                  type: 'string',
                  description: 'How venue was identified (e.g., "Name before location", "@mention is a business") or why null',
                },
                categories: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Content categories: Food, Travel, Fashion, Tech, Fitness, Photography, Art, Music, Nature, Pets, Lifestyle, Comedy, Education, Business, Beauty, Sports, Gaming, DIY, Cooking, etc.',
                },
                categoriesReason: {
                  type: 'string',
                  description: 'Why these categories were chosen based on content',
                },
                eventDate: {
                  type: 'string',
                  description: 'Date in ISO format (YYYY-MM-DD) if a specific event/date is mentioned. Use null if no date.',
                },
                eventDateReason: {
                  type: 'string',
                  description: 'How date was determined or why null',
                },
              },
              required: ['postId', 'hashtags', 'hashtagsReason', 'location', 'locationReason', 'venue', 'venueReason', 'categories', 'categoriesReason', 'eventDate', 'eventDateReason'],
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
    _existingCategories: Category[], // Not used - we deduplicate on backend
    onProgress?: (completed: number, total: number) => void
  ): Promise<Map<string, PostExtraction>> {
    const client = this.getClient();
    const results = new Map<string, PostExtraction>();

    // Pre-extract hashtags and mentions from all posts
    const preExtracted = new Map<string, { hashtags: string[]; mentions: string[] }>();
    for (const post of posts) {
      preExtracted.set(post.id, {
        hashtags: extractHashtagsFromCaption(post.caption),
        mentions: extractMentionsFromCaption(post.caption),
      });
    }

    // Process in batches
    for (let i = 0; i < posts.length; i += BATCH_SIZE) {
      const batch = posts.slice(i, i + BATCH_SIZE);

      const postsText = batch
        .map((p, idx) => {
          const pre = preExtracted.get(p.id)!;
          return `[${idx + 1}] ID: ${p.id}
Caption: "${p.caption || 'No caption'}"
Pre-extracted hashtags: ${pre.hashtags.length > 0 ? pre.hashtags.join(', ') : 'none'}
Pre-extracted @mentions: ${pre.mentions.length > 0 ? pre.mentions.join(', ') : 'none'}`;
        })
        .join('\n\n');

      const prompt = `Extract structured metadata from these ${batch.length} Instagram posts.

IMPORTANT EXTRACTION RULES:
1. LOCATION: Look for 📍 emoji, city/country names, addresses. Format as "City, Country" or "Neighborhood, City, Country"
2. VENUE: Look for restaurant/shop/business names, especially before locations or as @mentions. @mentions are often business accounts.
3. HASHTAGS: We've already extracted explicit #hashtags. Add any ADDITIONAL topic keywords that would help categorize.
4. CATEGORIES: Assign relevant categories based on content (Food, Travel, Fashion, Tech, Fitness, etc.)
5. EVENT DATE: Only if a specific date/event is mentioned

For EACH field, you MUST provide a reason explaining your choice or why it's null.

POSTS:
${postsText}

Use the extract_posts_batch tool. Return extractions in the same order as the posts.`;

      try {
        const response = await client.messages.create({
          model: MODEL,
          max_tokens: 8192,
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
              const pre = preExtracted.get(postId);

              // Merge pre-extracted hashtags with AI-extracted ones
              const aiHashtags = Array.isArray(ext.hashtags) ? ext.hashtags as string[] : [];
              const allHashtags = [...new Set([...(pre?.hashtags || []), ...aiHashtags])];

              results.set(postId, {
                hashtags: allHashtags,
                hashtagsReason: (ext.hashtagsReason as string) || 'No reason provided',
                location: (ext.location as string) || null,
                locationReason: (ext.locationReason as string) || 'No reason provided',
                venue: (ext.venue as string) || null,
                venueReason: (ext.venueReason as string) || 'No reason provided',
                categories: Array.isArray(ext.categories) ? ext.categories as string[] : [],
                categoriesReason: (ext.categoriesReason as string) || 'No reason provided',
                eventDate: (ext.eventDate as string) || null,
                eventDateReason: (ext.eventDateReason as string) || 'No reason provided',
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
    _existingCategories: Category[] // Not used - we deduplicate categories on backend instead
  ): Promise<{ batchId: string; requestCount: number }> {
    const client = this.getClient();

    // Create individual requests for each post
    const requests = posts.map((post) => {
      const preHashtags = extractHashtagsFromCaption(post.caption);
      const preMentions = extractMentionsFromCaption(post.caption);

      return {
        custom_id: post.id,
        params: {
          model: MODEL,
          max_tokens: 1024,
          tools: [this.getSingleExtractionTool()],
          tool_choice: { type: 'tool' as const, name: 'extract_post_data' },
          messages: [
            {
              role: 'user' as const,
              content: `Extract structured metadata from this Instagram post.

Caption: "${post.caption || 'No caption'}"
Pre-extracted #hashtags: ${preHashtags.length > 0 ? preHashtags.join(', ') : 'none'}
Pre-extracted @mentions: ${preMentions.length > 0 ? preMentions.join(', ') : 'none'}

EXTRACTION RULES:
1. LOCATION: Look for 📍 emoji, city/country names, addresses. Format as "City, Country"
2. VENUE: Look for business names, especially before locations. @mentions are often business accounts.
3. HASHTAGS: Add topic keywords beyond the pre-extracted ones
4. CATEGORIES: Food, Travel, Fashion, Tech, Fitness, Photography, Art, Music, Nature, etc.
5. EVENT DATE: Only if a specific date is mentioned

For EACH field, provide a reason explaining your choice or why null.

Use the extract_post_data tool.`,
            },
          ],
        },
      };
    });

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

            // Note: We'll merge pre-extracted hashtags when saving to DB, not here
            // because we don't have access to the original caption in this context
            results.set(result.custom_id, {
              hashtags: Array.isArray(input.hashtags) ? input.hashtags as string[] : [],
              hashtagsReason: (input.hashtagsReason as string) || 'No reason provided',
              location: (input.location as string) || null,
              locationReason: (input.locationReason as string) || 'No reason provided',
              venue: (input.venue as string) || null,
              venueReason: (input.venueReason as string) || 'No reason provided',
              categories: Array.isArray(input.categories) ? input.categories as string[] : [],
              categoriesReason: (input.categoriesReason as string) || 'No reason provided',
              eventDate: (input.eventDate as string) || null,
              eventDateReason: (input.eventDateReason as string) || 'No reason provided',
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
      description: 'Extract structured metadata from an Instagram post caption. Be thorough - look for ALL relevant information.',
      input_schema: {
        type: 'object',
        properties: {
          hashtags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Additional topic keywords beyond explicit #hashtags (which are pre-extracted)',
          },
          hashtagsReason: {
            type: 'string',
            description: 'Why these hashtags/keywords were chosen',
          },
          location: {
            type: 'string',
            description: 'Location as "City, Country" or "Neighborhood, City, Country". Look for 📍 emoji, place names. Use null if none.',
          },
          locationReason: {
            type: 'string',
            description: 'How location was determined or why null',
          },
          venue: {
            type: 'string',
            description: 'Restaurant, cafe, shop, hotel name. Look for @mentions, business names. Use null if none.',
          },
          venueReason: {
            type: 'string',
            description: 'How venue was identified or why null',
          },
          categories: {
            type: 'array',
            items: { type: 'string' },
            description: 'Content categories: Food, Travel, Fashion, Tech, Fitness, Photography, Art, Music, Nature, Pets, Lifestyle, Comedy, Education, Business, Beauty, Sports, Gaming, DIY, Cooking, etc.',
          },
          categoriesReason: {
            type: 'string',
            description: 'Why these categories based on content',
          },
          eventDate: {
            type: 'string',
            description: 'ISO date (YYYY-MM-DD) if specific event mentioned. Use null if none.',
          },
          eventDateReason: {
            type: 'string',
            description: 'How date was determined or why null',
          },
        },
        required: ['hashtags', 'hashtagsReason', 'location', 'locationReason', 'venue', 'venueReason', 'categories', 'categoriesReason', 'eventDate', 'eventDateReason'],
      },
    };
  }

  /**
   * Legacy single post extraction (for backwards compatibility)
   */
  async extractPostData(post: InstagramPost, existingCategories: Category[]): Promise<PostExtraction> {
    const results = await this.extractPostsBatch([post], existingCategories);
    return results.get(post.id) || {
      hashtags: [],
      hashtagsReason: 'Extraction failed',
      location: null,
      locationReason: 'Extraction failed',
      venue: null,
      venueReason: 'Extraction failed',
      categories: [],
      categoriesReason: 'Extraction failed',
      eventDate: null,
      eventDateReason: 'Extraction failed',
    };
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
