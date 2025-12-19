import OpenAI from 'openai';

class EmbeddingsService {
  private client: OpenAI | null = null;

  private getClient(): OpenAI {
    if (!this.client) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY environment variable is not set');
      }
      this.client = new OpenAI({ apiKey });
    }
    return this.client;
  }

  /**
   * Generate embedding for a single text
   */
  async generateEmbedding(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new Error('Text cannot be empty');
    }

    const client = this.getClient();
    
    const response = await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: text.trim(),
      dimensions: 1536,
    });

    return response.data[0].embedding;
  }

  /**
   * Generate embeddings for multiple texts in batch
   */
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    // Filter out empty texts and track indices
    const validTexts: { text: string; index: number }[] = [];
    texts.forEach((text, index) => {
      if (text && text.trim().length > 0) {
        validTexts.push({ text: text.trim(), index });
      }
    });

    if (validTexts.length === 0) {
      return texts.map(() => []);
    }

    const client = this.getClient();
    
    // OpenAI supports batch embeddings
    const response = await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: validTexts.map(v => v.text),
      dimensions: 1536,
    });

    // Map back to original indices
    const result: number[][] = texts.map(() => []);
    response.data.forEach((embedding, i) => {
      const originalIndex = validTexts[i].index;
      result[originalIndex] = embedding.embedding;
    });

    return result;
  }

  /**
   * Generate embedding for a post (combines caption and other metadata)
   */
  async generatePostEmbedding(post: { 
    caption?: string; 
    ownerUsername?: string;
  }): Promise<number[]> {
    // Combine relevant text fields
    const textParts: string[] = [];
    
    if (post.caption) {
      textParts.push(post.caption);
    }
    
    if (post.ownerUsername) {
      textParts.push(`Posted by @${post.ownerUsername}`);
    }

    const combinedText = textParts.join('\n').trim();
    
    if (!combinedText) {
      // Return zero vector for posts with no text content
      return new Array(1536).fill(0);
    }

    return this.generateEmbedding(combinedText);
  }
}

export const embeddingsService = new EmbeddingsService();
