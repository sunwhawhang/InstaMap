import Anthropic from '@anthropic-ai/sdk';
import { InstagramPost, Category, ChatMessage, PostExtraction } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

const MODEL_HAIKU = 'claude-haiku-4-5-20251001';
const MODEL_SONNET = 'claude-sonnet-4-5-20250929';
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
                mentions: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Featured @accounts that add useful context - brands, products, collaborators, companies, featured people. NOT physical venues. Include the @ symbol.',
                },
                mentionsReason: {
                  type: 'string',
                  description: 'Why these accounts were highlighted (e.g., "Product brand featured", "Collaboration partner", "Person tagged")',
                },
                mentionedPlaces: {
                  type: 'array',
                  description: 'ALL places mentioned in the post - restaurants, cafes, hotels, attractions, shops, etc. Extract every place with its location. Empty array if no places mentioned.',
                  items: {
                    type: 'object',
                    properties: {
                      venue: { type: 'string', description: 'Name of the place (e.g., "Kle Restaurant", "Cafe de Flore", "The Ritz")' },
                      location: { type: 'string', description: 'Location as "City, Country" or just "Country". Look for 📍 emoji, addresses, city mentions. Parse country from flag emojis: 🇫🇷=France, 🇯🇵=Japan, 🇩🇰=Denmark, 🇩🇪=Germany, 🇪🇸=Spain, 🇬🇧=UK, 🇮🇹=Italy, 🇨🇭=Switzerland, etc.' },
                      handle: { type: 'string', description: 'Instagram handle if present (e.g., "@klerestaurant"). Look for @mentions that are businesses.' },
                      metadata: { type: 'string', description: 'Additional context like star ratings, prices, rankings (e.g., "3⭐ – €400", "#1 ranked", "Michelin star")' },
                    },
                    required: ['venue', 'location'],
                  },
                },
                mentionedPlacesReason: {
                  type: 'string',
                  description: 'Brief reason: what places were found and how (e.g., "Restaurant after 📍", "44 ranked restaurants", "No places mentioned")',
                },
              },
              required: ['postId', 'hashtags', 'hashtagsReason', 'categories', 'categoriesReason', 'eventDate', 'eventDateReason', 'mentions', 'mentionsReason', 'mentionedPlaces', 'mentionedPlacesReason'],
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
    parentCategories: string[] = [],
    onProgress?: (completed: number, total: number) => void
  ): Promise<Map<string, PostExtraction>> {
    const client = this.getClient();
    const results = new Map<string, PostExtraction>();

    // Prepare taxonomy hint
    const taxonomyHint = parentCategories.length > 0
      ? `\nAVAILABLE PARENT CATEGORIES: ${parentCategories.join(', ')}\nUse the format "Parent/Subcategory" (e.g., "Food/Japanese") if possible. Suggest a new subcategory if nothing fits.`
      : '';

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

      const prompt = `Extract structured metadata from these ${batch.length} Instagram posts.${taxonomyHint}

EXTRACTION RULES:
1. MENTIONED PLACES: Extract ALL places mentioned - restaurants, cafes, hotels, shops, attractions. For each place include:
   - venue: The place name (e.g., "Cafe de Flore", "Restaurant Geranium")
   - location: "City, Country" format. Look for 📍 emoji, addresses, city names. Parse country from flag emojis (🇫🇷=France, 🇯🇵=Japan, 🇩🇰=Denmark, 🇩🇪=Germany, 🇪🇸=Spain, 🇬🇧=UK, etc.)
   - handle: @mention if the place has one (e.g., "@cafedeflore")
   - metadata: Extra info like star ratings, prices, rankings
   Leave empty array if no places mentioned.
2. MENTIONS: @accounts that are NOT physical venues - brands, products, collaborators, companies, people. Include @ symbol.
3. HASHTAGS: We've already extracted explicit #hashtags. Add ADDITIONAL topic keywords.
4. CATEGORIES: ${parentCategories.length > 0 ? 'Use "Parent/Subcategory" format using the provided parents.' : 'e.g., Food, Travel, Fashion, Tech, Fitness, etc.'}
5. EVENT DATE: Only if a specific date/event is mentioned

For EACH field, provide a brief reason.

POSTS:
${postsText}

Use the extract_posts_batch tool. Return extractions in the same order as the posts.`;

      try {
        const response = await client.messages.create({
          model: MODEL_HAIKU,
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

              // Parse mentionedPlaces array
              const rawPlaces = ext.mentionedPlaces;
              const mentionedPlaces = Array.isArray(rawPlaces)
                ? rawPlaces.map((p: any) => ({
                  venue: typeof p.venue === 'string' ? p.venue : '',
                  location: typeof p.location === 'string' ? p.location : '',
                  handle: typeof p.handle === 'string' ? p.handle : undefined,
                  metadata: typeof p.metadata === 'string' ? p.metadata : undefined,
                })).filter(p => p.venue && p.location)
                : [];

              results.set(postId, {
                hashtags: allHashtags,
                hashtagsReason: (ext.hashtagsReason as string) || 'No reason provided',
                categories: Array.isArray(ext.categories) ? ext.categories as string[] : [],
                categoriesReason: (ext.categoriesReason as string) || 'No reason provided',
                eventDate: (ext.eventDate as string) || null,
                eventDateReason: (ext.eventDateReason as string) || 'No reason provided',
                mentions: Array.isArray(ext.mentions) ? ext.mentions as string[] : [],
                mentionsReason: (ext.mentionsReason as string) || 'No reason provided',
                mentionedPlaces,
                mentionedPlacesReason: (ext.mentionedPlacesReason as string) || 'No reason provided',
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
    parentCategories: string[] = []
  ): Promise<{ batchId: string; requestCount: number }> {
    const client = this.getClient();

    const taxonomyHint = parentCategories.length > 0
      ? `\nAVAILABLE PARENT CATEGORIES: ${parentCategories.join(', ')}\nUse the format "Parent/Subcategory" (e.g., "Food/Japanese") if possible.`
      : '';

    // Create individual requests for each post
    const requests = posts.map((post) => {
      const preHashtags = extractHashtagsFromCaption(post.caption);
      const preMentions = extractMentionsFromCaption(post.caption);

      return {
        custom_id: post.id,
        params: {
          model: MODEL_HAIKU,
          max_tokens: 1024,
          tools: [this.getSingleExtractionTool()],
          tool_choice: { type: 'tool' as const, name: 'extract_post_data' },
          messages: [
            {
              role: 'user' as const,
              content: `Extract structured metadata from this Instagram post.${taxonomyHint}

Caption: "${post.caption || 'No caption'}"
Pre-extracted #hashtags: ${preHashtags.length > 0 ? preHashtags.join(', ') : 'none'}
Pre-extracted @mentions: ${preMentions.length > 0 ? preMentions.join(', ') : 'none'}

EXTRACTION RULES:
1. MENTIONED PLACES: Extract ALL places - restaurants, cafes, hotels, shops, attractions. Include venue name, location ("City, Country"), @handle if present, and metadata (ratings, prices). Parse country from flag emojis (🇫🇷=France, 🇯🇵=Japan, etc.). Empty array if no places.
2. MENTIONS: @accounts that are NOT venues - brands, products, collaborators, companies. Include @ symbol.
3. HASHTAGS: Add topic keywords beyond the pre-extracted ones
4. CATEGORIES: ${parentCategories.length > 0 ? 'Use "Parent/Subcategory" format using the provided parents.' : 'e.g., Food, Travel, Fashion, Tech, Fitness, Photography, Art, Music, Nature, etc.'}
5. EVENT DATE: Only if a specific date is mentioned

For EACH field, provide a brief reason.

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

            // Parse mentionedPlaces array
            const rawPlaces = input.mentionedPlaces;
            const mentionedPlaces = Array.isArray(rawPlaces)
              ? rawPlaces.map((p: any) => ({
                venue: typeof p.venue === 'string' ? p.venue : '',
                location: typeof p.location === 'string' ? p.location : '',
                handle: typeof p.handle === 'string' ? p.handle : undefined,
                metadata: typeof p.metadata === 'string' ? p.metadata : undefined,
              })).filter(p => p.venue && p.location)
              : [];

            results.set(result.custom_id, {
              hashtags: Array.isArray(input.hashtags) ? input.hashtags as string[] : [],
              hashtagsReason: (input.hashtagsReason as string) || 'No reason provided',
              categories: Array.isArray(input.categories) ? input.categories as string[] : [],
              categoriesReason: (input.categoriesReason as string) || 'No reason provided',
              eventDate: (input.eventDate as string) || null,
              eventDateReason: (input.eventDateReason as string) || 'No reason provided',
              mentions: Array.isArray(input.mentions) ? input.mentions as string[] : [],
              mentionsReason: (input.mentionsReason as string) || 'No reason provided',
              mentionedPlaces,
              mentionedPlacesReason: (input.mentionedPlacesReason as string) || 'No reason provided',
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
          mentions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Featured @accounts that add useful context - brands, products, collaborators, companies, featured people. NOT physical venues. Include the @ symbol.',
          },
          mentionsReason: {
            type: 'string',
            description: 'Why these accounts were highlighted (e.g., "Product brand featured", "Collaboration partner")',
          },
          mentionedPlaces: {
            type: 'array',
            description: 'ALL places mentioned - restaurants, cafes, hotels, shops, attractions. Extract each with venue name and location. Empty array if no places.',
            items: {
              type: 'object',
              properties: {
                venue: { type: 'string', description: 'Name of the place (e.g., "Cafe de Flore", "Restaurant Geranium")' },
                location: { type: 'string', description: 'Location as "City, Country" or just "Country". Look for 📍 emoji, addresses. Parse country from flag emojis: 🇫🇷=France, 🇯🇵=Japan, 🇩🇰=Denmark, 🇩🇪=Germany, etc.' },
                handle: { type: 'string', description: 'Instagram handle if present (e.g., "@cafedeflore")' },
                metadata: { type: 'string', description: 'Additional info like star ratings, prices, rankings' },
              },
              required: ['venue', 'location'],
            },
          },
          mentionedPlacesReason: {
            type: 'string',
            description: 'Brief reason: what places were found (e.g., "Restaurant after 📍", "44 ranked restaurants", "No places")',
          },
        },
        required: ['hashtags', 'hashtagsReason', 'categories', 'categoriesReason', 'eventDate', 'eventDateReason', 'mentions', 'mentionsReason', 'mentionedPlaces', 'mentionedPlacesReason'],
      },
    };
  }

  /**
   * Legacy single post extraction (for backwards compatibility)
   */
  async extractPostData(post: InstagramPost, parentCategories: string[] = []): Promise<PostExtraction> {
    const results = await this.extractPostsBatch([post], parentCategories);
    return results.get(post.id) || {
      hashtags: [],
      hashtagsReason: 'Extraction failed',
      categories: [],
      categoriesReason: 'Extraction failed',
      eventDate: null,
      eventDateReason: 'Extraction failed',
      mentions: [],
      mentionsReason: 'Extraction failed',
      mentionedPlaces: [],
      mentionedPlacesReason: 'Extraction failed',
    };
  }

  /**
   * Legacy method - wraps extractPostData for backwards compatibility
   */
  async categorizePost(post: InstagramPost, parentCategories: string[] = []): Promise<{ categories: string[] }> {
    const result = await this.extractPostData(post, parentCategories);
    return {
      categories: result.categories,
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
      model: MODEL_HAIKU,
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

  // Tool schema for cluster merging (first LLM call)
  private getMergeClustersTool(): Anthropic.Messages.Tool {
    return {
      name: 'merge_clusters',
      description: 'Identify which clusters should be merged because they represent the same or closely related concepts.',
      input_schema: {
        type: 'object',
        properties: {
          merges: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                clusterIds: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of cluster IDs that should be merged together'
                },
                canonicalName: {
                  type: 'string',
                  description: 'The best name to use for the merged cluster'
                },
                reason: {
                  type: 'string',
                  description: 'Brief reason (2-5 words): "synonyms", "plural form", "subset of X", "same concept"'
                }
              },
              required: ['clusterIds', 'canonicalName', 'reason'],
            },
          },
        },
        required: ['merges'],
      },
    };
  }

  /**
   * First LLM call: Identify clusters that should be merged
   */
  async mergeSimilarClusters(clusters: Array<{ id: string; categories: string[]; postCount?: number }>): Promise<{
    merges: Array<{ clusterIds: string[]; canonicalName: string; reason: string }>;
  }> {
    const client = this.getClient();

    // Format: "CategoryName (50): Syn1, Syn2"
    // The ID is the category name itself. Count is in parentheses.
    const clustersText = clusters.map(c => {
      const count = c.postCount || 0;
      const others = c.categories.filter(cat => cat !== c.id);
      if (others.length === 0) {
        return `"${c.id}" (${count})`;
      }
      return `"${c.id}" (${count}): ${others.join(', ')}`;
    }).join('\n');

    const prompt = `You are VALIDATING and REFINING ${clusters.length} category groups that were pre-grouped by embedding similarity.

FORMAT: "Main Category" (Total Post Count): Category2, Category3, ...

YOUR ROLE AS VALIDATOR:
- Categories after the ":" are ALREADY grouped by embedding similarity (they're not just synonyms, they're actual category names)
- Your job is to VALIDATE if they should truly be merged or if they should stay separate
- If you AGREE they should merge: Include ALL category names (Main + Category2 + Category3...) in clusterIds
  Example: "Facial Cares" (11): Face Cares → clusterIds: ["Facial Cares", "Face Cares"]
- If you DISAGREE: Either split them (omit from merges) or merge them differently with other groups

MERGE THESE ONLY (Identity Merges):
1. Synonyms: "clothing" and "apparel", "eateries" and "restaurants"
2. Same concept: "Coffee Shops" and "Cafes", "Workout" and "Exercise"
3. Word variations: "outfit ideas" and "outfit inspiration"
4. Singular/plural variants: "Cafe" and "Cafes" → prefer PLURAL form ("Cafes")
5. Catch-all categories: "Unknown", "General", "Misc", "Other", "Uncategorized", "Random", "Various" → all merge into "Miscellaneous"

DO NOT MERGE THESE (Hierarchical/Taxonomy):
- DO NOT merge subsets: Do NOT merge "Jeans" into "Fashion". Keep them separate.
- DO NOT merge types: Do NOT merge "Italian Food" into "Restaurants".
- DO NOT merge specific into general: Keep "Streetwear" separate from "Outfits".
- DO NOT merge Topic vs Topic + Format/Content: Keep "Funny" separate from "Funny Videos" or "Funny Content".
- DO NOT merge Topic vs Topic + Attribute: Keep "Viral" separate from "Viral Food" or "Viral Video".
- DO NOT merge distinct sub-niches: Keep "Travel Guide" separate from "Dining Guide" or "Hotel Guide". They are DIFFERENT types of guides.
- DO NOT merge just because they share a root word: "London" and "London Food" are different.
- ONLY merge if the two terms are 100% interchangeable in ALL contexts (e.g., "Cafe" and "Coffee Shop").

NAMING PREFERENCES:
- For singular/plural: prefer PLURAL ("Recipes" over "Recipe", "Outfits" over "Outfit")
- For proper capitalization: use Title Case ("Coffee Shops" not "coffee shops")

The goal is to eliminate duplicate names for the same thing, NOT to create a hierarchy. A separate process will handle parent/child relationships later.

CATEGORIES (use exact names as IDs):
${clustersText}

Use the merge_clusters tool. The clusterIds should include ALL category names from a group when you agree they should merge (Main + categories after ":"). Only include categories that need merging - don't list ones that should stay separate.`;

    console.log('\n=== CLAUDE MERGE CLUSTERS PROMPT ===');
    console.log(`Sending ${clusters.length} clusters for merge analysis`);
    console.log('--- FULL PROMPT TEXT ---');
    console.log(prompt);
    console.log('--- END PROMPT ---\n');

    try {
      const response = await client.messages.create({
        model: MODEL_SONNET,
        max_tokens: 8000,
        thinking: {
          type: 'enabled',
          budget_tokens: 4000
        },
        temperature: 0.1,  // low temperature for more deterministic output
        tools: [this.getMergeClustersTool()],
        tool_choice: { type: 'auto' },  // We can NOT force tool when using extended thinking
        messages: [{ role: 'user', content: prompt }],
      } as any); // Use any to bypass SDK version checks for thinking param

      console.log(`\n=== CLAUDE MERGE RESPONSE ===`);
      console.log(`Input tokens: ${response.usage.input_tokens}`);
      console.log(`Output tokens: ${response.usage.output_tokens}`);

      // Log thinking if present
      const thinkingBlock = response.content.find((b: any) => b.type === 'thinking');
      if (thinkingBlock && 'thinking' in thinkingBlock) {
        console.log('\n--- CLAUDE REASONING ---');
        console.log(thinkingBlock.thinking);
        console.log('--- END REASONING ---\n');
      }

      for (const block of response.content) {
        if (block.type === 'tool_use' && block.name === 'merge_clusters') {
          const input = block.input as any;
          console.log(`Merges identified: ${input.merges?.length || 0}`);
          if (input.merges) {
            input.merges.forEach((m: any) => {
              console.log(`  - Merge ${m.clusterIds.join(' + ')} → "${m.canonicalName}" (${m.reason || 'no reason'})`);
            });
          }
          return { merges: input.merges || [] };
        }
      }
      return { merges: [] };
    } catch (error) {
      console.error('Failed to merge clusters with Claude:', error);
      return { merges: [] };
    }
  }

  // Tool schema for consolidating parents across batches
  private getConsolidateParentsTool(): Anthropic.Messages.Tool {
    return {
      name: 'consolidate_parents',
      description: 'Identify which parent categories should be merged because they are duplicates or synonyms.',
      input_schema: {
        type: 'object',
        properties: {
          merges: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                parentNames: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of parent names to merge together'
                },
                canonicalName: { type: 'string', description: 'The final name to use for this merged parent' },
                reason: {
                  type: 'string',
                  description: 'Brief reason (2-5 words): "merged duplicates", "combined synonyms"'
                },
              },
              required: ['parentNames', 'canonicalName', 'reason'],
            },
          },
        },
        required: ['merges'],
      },
    };
  }

  /**
   * Final consolidation call: merge duplicate parent categories from batch processing
   */
  async consolidateParents(parents: Array<{ name: string; children: string[] }>): Promise<Array<{ name: string; children: string[]; reason: string }>> {
    const client = this.getClient();

    const parentsText = parents.map(p => `"${p.name}" (${p.children.length} children)`).join('\n');

    const prompt = `You have ${parents.length} parent categories from batch processing that may have duplicates or similar names.

Identify which parents should be MERGED:
- Merge duplicates: "Food" and "food" → "Food"
- Merge synonyms: "Fashion" and "Style" → "Fashion"
- Keep distinct: "Japanese Food" and "Italian Food" → keep both separate

PARENT CATEGORIES:
${parentsText}

Use the consolidate_parents tool. Only include parents that need merging - don't list ones that should stay separate.`;

    console.log(`\n=== CLAUDE CONSOLIDATE PARENTS ===`);
    console.log(`Consolidating ${parents.length} parent categories`);

    try {
      const response = await client.messages.create({
        model: MODEL_SONNET,
        max_tokens: 4096,
        tools: [this.getConsolidateParentsTool()],
        tool_choice: { type: 'tool', name: 'consolidate_parents' },
        messages: [{ role: 'user', content: prompt }],
      });

      // log the full json final output response
      console.log(`\n--- CLAUDE CONSOLIDATE PARENTS FINAL RESPONSE ---`);
      console.log(JSON.stringify(response.content, null, 2));
      console.log('--- END RESPONSE ---\n');

      for (const block of response.content) {
        if (block.type === 'tool_use' && block.name === 'consolidate_parents') {
          const input = block.input as any;
          const rawMerges = input?.merges;
          const mergesArray: any[] = Array.isArray(rawMerges)
            ? rawMerges
            : (rawMerges && typeof rawMerges === 'object' ? [rawMerges] : []);

          console.log(`Found ${mergesArray.length} parent merges`);

          // Apply merges to consolidate parents
          const parentMap = new Map(parents.map(p => [p.name, p]));
          const processed = new Set<string>();

          for (const merge of mergesArray) {
            const parentNames = Array.isArray(merge.parentNames) ? merge.parentNames : [];
            const canonicalName = typeof merge.canonicalName === 'string' ? merge.canonicalName.trim() : '';
            const reason = typeof merge.reason === 'string' ? merge.reason : 'merged';

            if (parentNames.length < 2 || !canonicalName) continue;

            console.log(`  - Merge ${parentNames.join(' + ')} → "${canonicalName}" (${reason})`);

            // Find all parents to merge
            const toMerge = parentNames
              .map((name: string) => parentMap.get(name))
              .filter((p: { name: string; children: string[] } | undefined): p is { name: string; children: string[] } => !!p);

            if (toMerge.length === 0) continue;

            // Combine all children
            const allChildren: string[] = [...new Set<string>(toMerge.flatMap((p: { name: string; children: string[] }) => p.children))];

            // Update/create consolidated parent
            parentMap.set(canonicalName, {
              name: canonicalName,
              children: allChildren
            });

            // Remove merged parents
            toMerge.forEach((p: { name: string; children: string[] }) => {
              processed.add(p.name);
              if (p.name !== canonicalName) {
                parentMap.delete(p.name);
              }
            });
          }

          // Return consolidated list with reasons
          const result = Array.from(parentMap.values()).map((p: { name: string; children: string[] }) => ({
            ...p,
            reason: processed.has(p.name) ? 'consolidated' : 'unchanged'
          }));

          console.log(`Consolidated to ${result.length} parents`);
          return result;
        }
      }
      // Return original with default reason if consolidation fails
      return parents.map(p => ({ ...p, reason: 'unchanged' }));
    } catch (error) {
      console.error('Failed to consolidate parents:', error);
      return parents.map(p => ({ ...p, reason: 'error fallback' }));
    }
  }

  // Tool schema for hierarchy creation (second LLM call)
  private getHierarchyTool(): Anthropic.Messages.Tool {
    return {
      name: 'create_hierarchy',
      description: 'Organize categories into a 2-level parent→child taxonomy.',
      input_schema: {
        type: 'object',
        properties: {
          parents: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Parent category name (can be from the list OR a new broader term)' },
                children: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Category names from the provided list (use exact names)'
                },
                reason: {
                  type: 'string',
                  description: 'Brief (2-5 words): why these belong together'
                },
              },
              required: ['name', 'children', 'reason'],
            },
          },
        },
        required: ['parents'],
      },
    };
  }

  async createCategoryHierarchy(categories: Array<{ name: string }>): Promise<{
    parents: { name: string; children: string[]; reason: string }[];
  }> {
    const HIERARCHY_BATCH_SIZE = 500;
    const MAX_PARALLEL = 3;

    let consolidatedParents: { name: string; children: string[]; reason: string }[];

    // If small enough, just do it in one go (with a buffer of 100 categories)
    if (categories.length <= HIERARCHY_BATCH_SIZE + 100) {
      const result = await this.executeHierarchyBatch(categories);
      consolidatedParents = result.parents;
    } else {
      // 1. Split into batches of equal size
      const numBatches = Math.ceil(categories.length / HIERARCHY_BATCH_SIZE);
      const itemsPerBatch = Math.ceil(categories.length / numBatches);
      const batches: Array<Array<{ name: string }>> = [];

      for (let i = 0; i < categories.length; i += itemsPerBatch) {
        batches.push(categories.slice(i, i + itemsPerBatch));
      }

      console.log(`[Claude] Parallelizing hierarchy for ${categories.length} categories (${batches.length} batches of ~${itemsPerBatch} each)`);

      // 2. Process batches in parallel with concurrency limit
      const batchResults: Array<{
        parents: { name: string; children: string[]; reason: string }[];
      }> = [];

      for (let i = 0; i < batches.length; i += MAX_PARALLEL) {
        const parallelGroup = batches.slice(i, i + MAX_PARALLEL);
        console.log(`[Claude] Processing hierarchy group ${Math.floor(i / MAX_PARALLEL) + 1}/${Math.ceil(batches.length / MAX_PARALLEL)} (${parallelGroup.length} batches)...`);

        const results = await Promise.all(parallelGroup.map(batch => this.executeHierarchyBatch(batch)));
        batchResults.push(...results);
      }

      // 3. Consolidate parents across all batches
      console.log(`[Claude] Consolidating parents from ${batchResults.length} batches...`);
      const parentMap = new Map<string, { children: string[]; reason: string }>();

      for (const result of batchResults) {
        for (const parent of result.parents) {
          const existing = parentMap.get(parent.name);
          if (existing) {
            parentMap.set(parent.name, {
              children: [...new Set([...existing.children, ...parent.children])],
              reason: existing.reason // Keep first reason
            });
          } else {
            parentMap.set(parent.name, { children: parent.children, reason: parent.reason });
          }
        }
      }

      consolidatedParents = Array.from(parentMap.entries()).map(([name, data]) => ({
        name,
        children: data.children,
        reason: data.reason
      }));

      if (batchResults.length > 1) {
        consolidatedParents = await this.consolidateParents(consolidatedParents);
      }
    }

    // Orphan check - ALWAYS runs regardless of single or multi-batch
    const assignedChildren = new Set(consolidatedParents.flatMap(p => p.children));
    const orphans = categories.filter(c => !assignedChildren.has(c.name));

    if (orphans.length > 0) {
      console.log(`[Claude] Found ${orphans.length} orphans. Running final assignment...`);
      const orphanResult = await this.assignOrphansToParents(orphans, consolidatedParents.map(p => p.name));

      // Process orphan assignments
      for (const assignment of orphanResult) {
        if (assignment.isNewParent) {
          consolidatedParents.push({
            name: assignment.parentName,
            children: [assignment.childName],
            reason: assignment.reason || 'new parent for orphans'
          });
          console.log(`[Claude] Created new parent "${assignment.parentName}" for orphan "${assignment.childName}"`);
        } else {
          const parent = consolidatedParents.find(p => p.name === assignment.parentName);
          if (parent) {
            if (!parent.children.includes(assignment.childName)) {
              parent.children.push(assignment.childName);
            }
          } else {
            console.warn(`[Claude] Parent "${assignment.parentName}" not found, creating it`);
            consolidatedParents.push({
              name: assignment.parentName,
              children: [assignment.childName],
              reason: assignment.reason || 'created for orphan'
            });
          }
        }
      }
    }

    return {
      parents: consolidatedParents,
    };
  }

  /**
   * Internal helper to execute a single hierarchy batch
   */
  private async executeHierarchyBatch(categories: Array<{ name: string }>): Promise<{
    parents: { name: string; children: string[]; reason: string }[];
  }> {
    const client = this.getClient();
    const categoriesText = categories.map(c => `"${c.name}"`).join('\n');

    const prompt = `Organize these ${categories.length} Instagram categories into a clean 2-level taxonomy (Parent → Child).

TASK:
1. Create ~15-30 parent categories
   - You can promote an EXISTING category from the list to be a parent (e.g., if "Fashion" is in the list, make it a parent)
   - OR create a NEW broader parent if needed (e.g., if you see "Croissants", "Ramen", "Pizza" but no "Food", create "Food" as a parent)

2. Assign each category below to its most relevant parent
   - Most categories belong under ONE parent
   - Multi-faceted categories (e.g., "Travel Outfits", "London Restaurants") can go under 2-3 parents for discoverability
   - Group aggressively: Streetwear, Casual Outfits, OOTD → all under Fashion/Outfits

IMPORTANT:
- Use the exact category names from the list below in your "children" arrays (copy-paste, don't retype)
- Assign ALL categories to at least one parent

CATEGORIES:
${categoriesText}

Use the create_hierarchy tool.`;

    try {
      const response = await client.messages.create({
        model: MODEL_SONNET,
        max_tokens: 8192,
        thinking: {
          type: 'enabled',
          budget_tokens: 4000
        },
        tools: [this.getHierarchyTool()],
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: prompt }],
      } as any);

      // Log thinking if present
      const thinkingBlock = response.content.find((b: any) => b.type === 'thinking');
      if (thinkingBlock && 'thinking' in thinkingBlock) {
        console.log(`\n--- CLAUDE HIERARCHY REASONING (Batch of ${categories.length}) ---`);
        console.log(thinkingBlock.thinking);
        console.log('--- END REASONING ---\n');
      }

      // log the full json final output response
      console.log(`\n--- CLAUDE HIERARCHY FINAL RESPONSE ---`);
      console.log(JSON.stringify(response.content, null, 2));
      console.log('--- END RESPONSE ---\n');

      for (const block of response.content) {
        if (block.type === 'tool_use' && block.name === 'create_hierarchy') {
          const input = block.input as any;

          const rawParents = input?.parents;
          const parentsArray: any[] = Array.isArray(rawParents)
            ? rawParents
            : (rawParents && typeof rawParents === 'object' ? [rawParents] : []);

          const normalizedParents = parentsArray
            .filter(p => p && typeof p === 'object')
            .map(p => {
              const children = Array.isArray(p.children)
                ? p.children
                : (typeof p.children === 'string' ? [p.children] : []);

              return {
                name: typeof p.name === 'string' ? p.name.trim() : '',
                children: children
                  .filter((c: unknown): c is string => typeof c === 'string')
                  .map((c: string) => c.trim())
                  .filter(Boolean),
                reason: typeof p.reason === 'string' ? p.reason : 'no reason'
              };
            })
            .filter(p => p.name.length > 0 && p.children.length > 0);

          return {
            parents: normalizedParents,
          };
        }
      }
      throw new Error('LLM failed to use create_hierarchy tool');
    } catch (error) {
      console.error('Failed to execute hierarchy batch with Claude:', error);
      return { parents: [] };
    }
  }

  /**
   * Final pass to assign any orphaned categories to existing parents
   */
  private async assignOrphansToParents(
    orphans: Array<{ name: string }>,
    parentNames: string[]
  ): Promise<Array<{ childName: string; parentName: string; isNewParent?: boolean; reason?: string }>> {
    const client = this.getClient();
    const orphansText = orphans.map(o => `"${o.name}"`).join('\n');
    const parentsText = parentNames.join(', ');

    const prompt = `I have ${orphans.length} "orphan" categories that weren't assigned to parents during the main batching process.

Assign each orphan to a parent category:
- Use an EXISTING parent from the list below if appropriate
- OR suggest a NEW parent category if none of the existing ones fit well

ORPHANS:
${orphansText}

EXISTING PARENTS:
${parentsText}

Use the assign_orphans tool.`;

    const tool: Anthropic.Messages.Tool = {
      name: 'assign_orphans',
      description: 'Assign orphaned categories to existing or new parents',
      input_schema: {
        type: 'object',
        properties: {
          assignments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                childName: { type: 'string', description: 'The orphan category name' },
                parentName: { type: 'string', description: 'Existing parent name OR a new parent name' },
                isNewParent: { type: 'boolean', description: 'True if parentName is a new parent category to create' },
                reason: { type: 'string', description: 'Brief (2-5 words): why this parent fits' }
              },
              required: ['childName', 'parentName', 'isNewParent', 'reason']
            }
          }
        },
        required: ['assignments']
      }
    };

    try {
      const response = await client.messages.create({
        model: MODEL_SONNET,
        max_tokens: 2000,
        tools: [tool],
        tool_choice: { type: 'tool', name: 'assign_orphans' },
        messages: [{ role: 'user', content: prompt }],
      });

      // log the full json final output response
      console.log(`\n--- CLAUDE ASSIGN ORPHANS FINAL RESPONSE ---`);
      console.log(JSON.stringify(response.content, null, 2));
      console.log('--- END RESPONSE ---\n');

      for (const block of response.content) {
        if (block.type === 'tool_use' && block.name === 'assign_orphans') {
          const assignments = (block.input as any).assignments || [];
          console.log(`Assigned ${assignments.length} orphans:`);
          assignments.forEach((a: any) => {
            const marker = a.isNewParent ? '[NEW]' : '[EXISTING]';
            console.log(`  - "${a.childName}" → "${a.parentName}" ${marker} (${a.reason || 'no reason'})`);
          });
          return assignments;
        }
      }
      return [];
    } catch (error) {
      console.error('Failed to assign orphans:', error);
      return [];
    }
  }
}

export const claudeService = new ClaudeService();
