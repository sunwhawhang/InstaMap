import neo4j, { Driver, Session } from 'neo4j-driver';
import { InstagramPost, Category, Entity } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

class Neo4jService {
  private driver: Driver | null = null;

  private getDriver(): Driver {
    if (!this.driver) {
      const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
      const user = process.env.NEO4J_USER || 'neo4j';
      const password = process.env.NEO4J_PASSWORD || 'password123';

      this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
    }
    return this.driver;
  }

  private getSession(): Session {
    return this.getDriver().session();
  }

  async healthCheck(): Promise<boolean> {
    const session = this.getSession();
    try {
      await session.run('RETURN 1');
      return true;
    } catch (error) {
      console.error('Neo4j health check failed:', error);
      return false;
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }

  // Initialize schema and indexes
  async initializeSchema(): Promise<void> {
    const session = this.getSession();
    try {
      // Create constraints
      await session.run(`
        CREATE CONSTRAINT post_id IF NOT EXISTS
        FOR (p:Post) REQUIRE p.id IS UNIQUE
      `);

      await session.run(`
        CREATE CONSTRAINT post_instagram_id IF NOT EXISTS
        FOR (p:Post) REQUIRE p.instagramId IS UNIQUE
      `);

      await session.run(`
        CREATE CONSTRAINT category_id IF NOT EXISTS
        FOR (c:Category) REQUIRE c.id IS UNIQUE
      `);

      await session.run(`
        CREATE CONSTRAINT category_name IF NOT EXISTS
        FOR (c:Category) REQUIRE c.name IS UNIQUE
      `);

      // Create vector index for embeddings (Neo4j 5.11+)
      try {
        await session.run(`
          CREATE VECTOR INDEX post_embeddings IF NOT EXISTS
          FOR (p:Post) ON (p.embedding)
          OPTIONS {indexConfig: {
            \`vector.dimensions\`: 1536,
            \`vector.similarity_function\`: 'cosine'
          }}
        `);
      } catch (e) {
        console.log('Vector index creation skipped (may already exist or Neo4j version < 5.11)');
      }

      console.log('Neo4j schema initialized');
    } finally {
      await session.close();
    }
  }

  // Posts
  async upsertPost(post: InstagramPost): Promise<InstagramPost> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MERGE (p:Post {instagramId: $instagramId})
        ON CREATE SET
          p.id = $id,
          p.imageUrl = $imageUrl,
          p.thumbnailUrl = $thumbnailUrl,
          p.caption = $caption,
          p.ownerUsername = $ownerUsername,
          p.timestamp = $timestamp,
          p.savedAt = $savedAt,
          p.isVideo = $isVideo,
          p.createdAt = datetime()
        ON MATCH SET
          p.imageUrl = COALESCE($imageUrl, p.imageUrl),
          p.thumbnailUrl = COALESCE($thumbnailUrl, p.thumbnailUrl),
          p.caption = COALESCE($caption, p.caption),
          p.ownerUsername = COALESCE($ownerUsername, p.ownerUsername),
          p.updatedAt = datetime()
        RETURN p
      `, {
        id: post.id || uuidv4(),
        instagramId: post.instagramId,
        imageUrl: post.imageUrl,
        thumbnailUrl: post.thumbnailUrl || null,
        caption: post.caption || '',
        ownerUsername: post.ownerUsername || '',
        timestamp: post.timestamp,
        savedAt: post.savedAt,
        isVideo: post.isVideo,
      });

      const record = result.records[0];
      return this.recordToPost(record.get('p'));
    } finally {
      await session.close();
    }
  }

  async upsertPosts(posts: InstagramPost[]): Promise<number> {
    let synced = 0;
    for (const post of posts) {
      try {
        await this.upsertPost(post);
        synced++;
      } catch (error) {
        console.error(`Failed to upsert post ${post.instagramId}:`, error);
      }
    }
    return synced;
  }

  async getPosts(options?: {
    limit?: number;
    offset?: number;
    categoryId?: string;
  }): Promise<InstagramPost[]> {
    const session = this.getSession();
    try {
      const limit = options?.limit || 50;
      const offset = options?.offset || 0;

      let query = `
        MATCH (p:Post)
      `;

      if (options?.categoryId) {
        query += `
          MATCH (p)-[:BELONGS_TO]->(c:Category {id: $categoryId})
        `;
      }

      query += `
        RETURN p
        ORDER BY p.savedAt DESC
        SKIP $offset
        LIMIT $limit
      `;

      const result = await session.run(query, {
        limit: neo4j.int(limit),
        offset: neo4j.int(offset),
        categoryId: options?.categoryId || null,
      });

      return result.records.map(r => this.recordToPost(r.get('p')));
    } finally {
      await session.close();
    }
  }

  async getPostById(id: string): Promise<InstagramPost | null> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:Post {id: $id})
        RETURN p
      `, { id });

      if (result.records.length === 0) return null;
      return this.recordToPost(result.records[0].get('p'));
    } finally {
      await session.close();
    }
  }

  async updatePostEmbedding(postId: string, embedding: number[]): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (p:Post {id: $id})
        SET p.embedding = $embedding
      `, { id: postId, embedding });
    } finally {
      await session.close();
    }
  }

  async findSimilarPosts(embedding: number[], limit = 10): Promise<InstagramPost[]> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        CALL db.index.vector.queryNodes('post_embeddings', $limit, $embedding)
        YIELD node, score
        RETURN node as p, score
        ORDER BY score DESC
      `, {
        embedding,
        limit: neo4j.int(limit),
      });

      return result.records.map(r => ({
        ...this.recordToPost(r.get('p')),
        similarityScore: r.get('score'),
      }));
    } catch (error) {
      console.error('Vector search failed:', error);
      return [];
    } finally {
      await session.close();
    }
  }

  // Categories
  async createCategory(name: string, description?: string, color?: string): Promise<Category> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MERGE (c:Category {name: $name})
        ON CREATE SET
          c.id = $id,
          c.description = $description,
          c.color = $color,
          c.createdAt = datetime()
        RETURN c
      `, {
        id: uuidv4(),
        name,
        description: description || null,
        color: color || null,
      });

      return this.recordToCategory(result.records[0].get('c'));
    } finally {
      await session.close();
    }
  }

  async getCategories(): Promise<Category[]> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (c:Category)
        OPTIONAL MATCH (p:Post)-[:BELONGS_TO]->(c)
        RETURN c, count(p) as postCount
        ORDER BY postCount DESC
      `);

      return result.records.map(r => ({
        ...this.recordToCategory(r.get('c')),
        postCount: r.get('postCount').toNumber(),
      }));
    } finally {
      await session.close();
    }
  }

  async assignPostToCategory(postId: string, categoryId: string): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (p:Post {id: $postId})
        MATCH (c:Category {id: $categoryId})
        MERGE (p)-[:BELONGS_TO]->(c)
      `, { postId, categoryId });
    } finally {
      await session.close();
    }
  }

  async getPostCategories(postId: string): Promise<Category[]> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:Post {id: $postId})-[:BELONGS_TO]->(c:Category)
        RETURN c
      `, { postId });

      return result.records.map(r => this.recordToCategory(r.get('c')));
    } finally {
      await session.close();
    }
  }

  async getCategorizedPostIds(): Promise<string[]> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:Post)-[:BELONGS_TO]->(:Category)
        RETURN DISTINCT p.id as id
      `);
      return result.records.map(r => r.get('id') as string);
    } finally {
      await session.close();
    }
  }

  async updatePostMetadata(postId: string, metadata: {
    location?: string;
    venue?: string;
    eventDate?: string;
    hashtags?: string[];
    latitude?: number;
    longitude?: number;
    // Featured mentions (brands, collaborators, etc.)
    mentions?: string[];
    // Extraction reasons
    locationReason?: string;
    venueReason?: string;
    eventDateReason?: string;
    hashtagsReason?: string;
    categoriesReason?: string;
    mentionsReason?: string;
  }, source: 'user' | 'claude' = 'claude'): Promise<void> {
    const session = this.getSession();
    try {
      const sets: string[] = [];
      const params: Record<string, unknown> = { id: postId };

      if (metadata.location !== undefined) {
        sets.push('p.location = $location');
        params.location = metadata.location || null;
      }
      if (metadata.venue !== undefined) {
        sets.push('p.venue = $venue');
        params.venue = metadata.venue || null;
      }
      if (metadata.eventDate !== undefined) {
        sets.push('p.eventDate = $eventDate');
        params.eventDate = metadata.eventDate || null;
      }
      if (metadata.hashtags !== undefined) {
        sets.push('p.hashtags = $hashtags');
        params.hashtags = metadata.hashtags && metadata.hashtags.length > 0 ? metadata.hashtags : null;
      }
      if (metadata.mentions !== undefined) {
        sets.push('p.mentions = $mentions');
        params.mentions = metadata.mentions && metadata.mentions.length > 0 ? metadata.mentions : null;
      }
      if (metadata.latitude !== undefined && metadata.longitude !== undefined) {
        sets.push('p.latitude = $latitude');
        sets.push('p.longitude = $longitude');
        params.latitude = metadata.latitude;
        params.longitude = metadata.longitude;
      }

      // Store extraction reasons
      if (metadata.locationReason !== undefined) {
        sets.push('p.locationReason = $locationReason');
        params.locationReason = metadata.locationReason;
      }
      if (metadata.venueReason !== undefined) {
        sets.push('p.venueReason = $venueReason');
        params.venueReason = metadata.venueReason;
      }
      if (metadata.eventDateReason !== undefined) {
        sets.push('p.eventDateReason = $eventDateReason');
        params.eventDateReason = metadata.eventDateReason;
      }
      if (metadata.hashtagsReason !== undefined) {
        sets.push('p.hashtagsReason = $hashtagsReason');
        params.hashtagsReason = metadata.hashtagsReason;
      }
      if (metadata.categoriesReason !== undefined) {
        sets.push('p.categoriesReason = $categoriesReason');
        params.categoriesReason = metadata.categoriesReason;
      }
      if (metadata.mentionsReason !== undefined) {
        sets.push('p.mentionsReason = $mentionsReason');
        params.mentionsReason = metadata.mentionsReason;
      }

      if (sets.length > 0) {
        sets.push('p.lastEditedBy = $lastEditedBy');
        sets.push('p.lastEditedAt = $lastEditedAt');
        params.lastEditedBy = source;
        params.lastEditedAt = new Date().toISOString();

        await session.run(`
          MATCH (p:Post {id: $id})
          SET ${sets.join(', ')}
        `, params);
      }
    } finally {
      await session.close();
    }
  }

  /**
   * Get posts that have location but no coordinates (need geocoding)
   */
  async getPostsNeedingGeocoding(): Promise<{ id: string; location: string }[]> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:Post)
        WHERE p.location IS NOT NULL 
          AND p.location <> ''
          AND p.location <> '<UNKNOWN>'
          AND NOT p.location STARTS WITH '<'
          AND p.latitude IS NULL
        RETURN p.id as id, p.location as location
      `);
      return result.records.map(r => ({
        id: r.get('id') as string,
        location: r.get('location') as string,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Get posts that have coordinates (for map display)
   */
  async getPostsWithCoordinates(): Promise<InstagramPost[]> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:Post)
        WHERE p.latitude IS NOT NULL 
          AND p.longitude IS NOT NULL
          AND p.location IS NOT NULL
          AND p.location <> '<UNKNOWN>'
          AND NOT p.location STARTS WITH '<'
        RETURN p
        ORDER BY p.savedAt DESC
      `);
      return result.records.map(r => this.recordToPost(r.get('p')));
    } finally {
      await session.close();
    }
  }

  /**
   * Update post with geocoded coordinates
   */
  async updatePostCoordinates(postId: string, lat: number, lng: number): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (p:Post {id: $id})
        SET p.latitude = $lat, p.longitude = $lng
      `, { id: postId, lat, lng });
    } finally {
      await session.close();
    }
  }

  // Helpers
  private recordToPost(node: any): InstagramPost {
    const props = node.properties;
    return {
      id: props.id,
      instagramId: props.instagramId,
      imageUrl: props.imageUrl,
      thumbnailUrl: props.thumbnailUrl,
      caption: props.caption || '',
      ownerUsername: props.ownerUsername || '',
      timestamp: props.timestamp,
      savedAt: props.savedAt,
      isVideo: props.isVideo || false,
      embedding: props.embedding,
      // Extracted metadata
      hashtags: props.hashtags,
      location: props.location,
      venue: props.venue,
      eventDate: props.eventDate,
      mentions: props.mentions,
      // Extraction reasons
      hashtagsReason: props.hashtagsReason,
      locationReason: props.locationReason,
      venueReason: props.venueReason,
      categoriesReason: props.categoriesReason,
      eventDateReason: props.eventDateReason,
      mentionsReason: props.mentionsReason,
      // Coordinates
      latitude: props.latitude,
      longitude: props.longitude,
      // Edit tracking
      lastEditedBy: props.lastEditedBy,
      lastEditedAt: props.lastEditedAt,
      // Embedding tracking
      embeddingVersion: props.embeddingVersion || 0,
    };
  }

  /**
   * Update embedding version for a post
   */
  async updateEmbeddingVersion(postId: string, version: number): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (p:Post {id: $id})
        SET p.embeddingVersion = $version
      `, { id: postId, version });
    } finally {
      await session.close();
    }
  }

  /**
   * Get posts that need enriched embeddings (version < 2 and have been categorized)
   */
  async getPostsNeedingEnrichedEmbeddings(): Promise<{ id: string; embeddingVersion: number }[]> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:Post)-[:BELONGS_TO]->(:Category)
        WHERE p.embeddingVersion IS NULL OR p.embeddingVersion < 2
        RETURN DISTINCT p.id as id, COALESCE(p.embeddingVersion, 0) as embeddingVersion
      `);
      return result.records.map(r => ({
        id: r.get('id'),
        embeddingVersion: r.get('embeddingVersion')?.toNumber?.() || r.get('embeddingVersion') || 0,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Mark post as needing embedding refresh (e.g., after re-categorization)
   */
  async markPostNeedsEmbeddingRefresh(postId: string): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (p:Post {id: $id})
        SET p.embeddingVersion = 1
      `, { id: postId });
    } finally {
      await session.close();
    }
  }

  private recordToCategory(node: any): Category {
    const props = node.properties;
    return {
      id: props.id,
      name: props.name,
      description: props.description,
      color: props.color,
      postCount: 0,
      createdAt: props.createdAt?.toString() || new Date().toISOString(),
    };
  }
}

export const neo4jService = new Neo4jService();
