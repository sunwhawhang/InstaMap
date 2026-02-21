import neo4j, { Driver, Session } from 'neo4j-driver';
import { InstagramPost, Category, Entity, MentionedPlace } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';
import { geocodingService, GeocodingCacheEntry } from './geocoding.js';

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

  public getSession(): Session {
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

      await session.run(`
        CREATE CONSTRAINT geocoding_cache_key IF NOT EXISTS
        FOR (g:GeocodingCache) REQUIRE g.queryKey IS UNIQUE
      `);

      // Create vector index for embeddings (Neo4j 5.11+)
      // Try to create the index, attempting different syntaxes for compatibility
      try {
        // Check if index already exists
        const indexCheck = await session.run(`SHOW INDEXES WHERE name = 'post_embeddings'`);
        if (indexCheck.records.length === 0) {
          // Try Neo4j 5.x syntax
          try {
            await session.run(`
              CREATE VECTOR INDEX post_embeddings IF NOT EXISTS
              FOR (p:Post) ON (p.embedding)
              OPTIONS {indexConfig: {
                \`vector.dimensions\`: 1536,
                \`vector.similarity_function\`: 'cosine'
              }}
            `);
            console.log('Vector index post_embeddings created successfully');
          } catch (syntaxError: any) {
            // Try alternative syntax for newer Neo4j versions
            console.log('Trying alternative vector index syntax...');
            await session.run(`
              CREATE VECTOR INDEX post_embeddings IF NOT EXISTS
              FOR (p:Post) ON p.embedding
              OPTIONS {
                indexConfig: {
                  \`vector.dimensions\`: 1536,
                  \`vector.similarity_function\`: 'cosine'
                }
              }
            `);
            console.log('Vector index post_embeddings created with alternative syntax');
          }
        } else {
          console.log('Vector index post_embeddings already exists');
        }
      } catch (e: any) {
        console.error('Failed to create vector index:', e.message || e);
        console.log('Semantic search will not work until the vector index is created.');
        console.log('You may need to create it manually in Neo4j Browser with:');
        console.log('CREATE VECTOR INDEX post_embeddings FOR (p:Post) ON (p.embedding) OPTIONS {indexConfig: {`vector.dimensions`: 1536, `vector.similarity_function`: "cosine"}}');
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
          p.updatedAt = datetime(),
          p.imageExpired = CASE WHEN $imageUrl IS NOT NULL THEN false ELSE p.imageExpired END,
          p.imageExpiredAt = CASE WHEN $imageUrl IS NOT NULL THEN null ELSE p.imageExpiredAt END
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
    recursive?: boolean;
  }): Promise<InstagramPost[]> {
    const session = this.getSession();
    try {
      const limit = options?.limit || 50;
      const offset = options?.offset || 0;
      const recursive = options?.recursive !== false; // Default to true if not specified

      let query = `
        MATCH (p:Post)
      `;

      if (options?.categoryId) {
        if (recursive) {
          query += `
            MATCH (p)-[:BELONGS_TO]->(c:Category)-[:CHILD_OF*0..]->(:Category {id: $categoryId})
          `;
        } else {
          query += `
            MATCH (p)-[:BELONGS_TO]->(c:Category {id: $categoryId})
          `;
        }
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

  /**
   * Semantic search for posts using vector similarity with boosting
   * Returns posts with relevance scores, paginated
   */
  async searchPosts(
    queryEmbedding: number[],
    queryText: string,
    options: {
      topK: number;
      minSimilarity: number;
      categoryBoost: number;
      exactPhraseBoost: number;
      limit: number;
      offset: number;
    }
  ): Promise<{ posts: InstagramPost[]; total: number }> {
    const session = this.getSession();
    try {
      const queryLower = queryText.toLowerCase();

      // Vector search with boosting applied in Cypher
      const result = await session.run(`
        CALL db.index.vector.queryNodes('post_embeddings', $topK, $embedding)
        YIELD node, score
        WHERE score >= $minSimilarity
        WITH node as p, score
        
        // Get categories for this post
        OPTIONAL MATCH (p)-[:BELONGS_TO]->(c:Category)
        WITH p, score, collect(c.name) as categoryNames
        
        // Calculate boosts
        WITH p, score, categoryNames,
          CASE WHEN ANY(cat IN categoryNames WHERE toLower(cat) CONTAINS $queryLower) 
               THEN $categoryBoost ELSE 0 END as catBoost,
          CASE WHEN toLower(p.caption) CONTAINS $queryLower 
               THEN $exactPhraseBoost ELSE 0 END as phraseBoost
        
        // Final score with boosts (capped at 1.0)
        WITH p, categoryNames,
          CASE WHEN (score + catBoost + phraseBoost) > 1.0 
               THEN 1.0 
               ELSE (score + catBoost + phraseBoost) END as finalScore
        
        ORDER BY finalScore DESC
        RETURN p, categoryNames, finalScore
        SKIP $offset LIMIT $limit
      `, {
        embedding: queryEmbedding,
        topK: neo4j.int(options.topK),
        minSimilarity: options.minSimilarity,
        categoryBoost: options.categoryBoost,
        exactPhraseBoost: options.exactPhraseBoost,
        queryLower,
        offset: neo4j.int(options.offset),
        limit: neo4j.int(options.limit),
      });

      const posts = result.records.map(r => ({
        ...this.recordToPost(r.get('p')),
        categories: r.get('categoryNames') as string[],
        relevanceScore: r.get('finalScore') as number,
      }));

      // Get total count (separate query for efficiency)
      const countResult = await session.run(`
        CALL db.index.vector.queryNodes('post_embeddings', $topK, $embedding)
        YIELD node, score
        WHERE score >= $minSimilarity
        RETURN count(node) as total
      `, {
        embedding: queryEmbedding,
        topK: neo4j.int(options.topK),
        minSimilarity: options.minSimilarity,
      });

      const total = countResult.records[0]?.get('total')?.toNumber?.() ||
        countResult.records[0]?.get('total') || 0;

      return { posts, total };
    } catch (error) {
      console.error('Semantic search failed:', error);
      return { posts: [], total: 0 };
    } finally {
      await session.close();
    }
  }

  /**
   * Get count of search results (for pagination)
   */
  async getSearchCount(
    queryEmbedding: number[],
    topK: number,
    minSimilarity: number
  ): Promise<number> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        CALL db.index.vector.queryNodes('post_embeddings', $topK, $embedding)
        YIELD node, score
        WHERE score >= $minSimilarity
        RETURN count(node) as total
      `, {
        embedding: queryEmbedding,
        topK: neo4j.int(topK),
        minSimilarity,
      });

      return result.records[0]?.get('total')?.toNumber?.() ||
        result.records[0]?.get('total') || 0;
    } catch (error) {
      console.error('Search count failed:', error);
      return 0;
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

  async getCategoriesBelowThreshold(minPosts: number): Promise<Category[]> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (c:Category)
        OPTIONAL MATCH (p:Post)-[:BELONGS_TO]->(c)
        WITH c, count(p) as postCount
        WHERE postCount < $minPosts
        RETURN c, postCount
      `, { minPosts: neo4j.int(minPosts) });

      return result.records.map(r => ({
        ...this.recordToCategory(r.get('c')),
        postCount: r.get('postCount').toNumber(),
      }));
    } finally {
      await session.close();
    }
  }

  async addHashtagToPostsInCategory(categoryId: string, hashtag: string): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (c:Category {id: $categoryId})<-[:BELONGS_TO]-(p:Post)
        SET p.hashtags = CASE 
          WHEN p.hashtags IS NULL THEN [$hashtag]
          WHEN NOT $hashtag IN p.hashtags THEN p.hashtags + $hashtag
          ELSE p.hashtags 
        END
      `, { categoryId, hashtag });
    } finally {
      await session.close();
    }
  }

  /**
   * Add a parent to a category. Supports multiple parents per category.
   * @param childId - The child category ID
   * @param parentId - The parent category ID to add (or null to clear all parents)
   */
  async setCategoryParent(childId: string, parentId: string | null): Promise<void> {
    const session = this.getSession();
    try {
      if (parentId) {
        await session.run(`
          MATCH (child:Category {id: $childId})
          MATCH (parent:Category {id: $parentId})
          MERGE (child)-[:CHILD_OF]->(parent)
          SET parent.isParent = true
        `, { childId, parentId });
      } else {
        // Remove ALL parent relationships
        await session.run(`
          MATCH (child:Category {id: $childId})
          OPTIONAL MATCH (child)-[r:CHILD_OF]->(:Category)
          DELETE r
        `, { childId });
      }
    } finally {
      await session.close();
    }
  }

  async updateCategoryName(id: string, name: string): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (c:Category {id: $id})
        SET c.name = $name
      `, { id, name });
    } finally {
      await session.close();
    }
  }

  async setCategoryIsParent(id: string, isParent: boolean): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (c:Category {id: $id})
        SET c.isParent = $isParent
      `, { id, isParent });
    } finally {
      await session.close();
    }
  }

  async updateCategoryEmbedding(categoryId: string, embedding: number[]): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (c:Category {id: $id})
        SET c.embedding = $embedding
      `, { id: categoryId, embedding });
    } finally {
      await session.close();
    }
  }

  /**
   * BACKUP: Prepare for category cleanup by tagging existing state
   */
  async createCleanupBackup(): Promise<void> {
    const session = this.getSession();
    try {
      console.log('[InstaMap] Creating cleanup backup in Neo4j...');

      // 1. Tag all current categories as "Original" and preserve their original names
      await session.run(`
        MATCH (c:Category)
        SET c:OriginalCategory, c.originalName = c.name
      `);

      // 2. Backup current Post -> Category relationships
      await session.run(`
        MATCH (p:Post)-[:BELONGS_TO]->(c:Category)
        MERGE (p)-[:HAD_CATEGORY_BEFORE_CLEANUP]->(c)
      `);

      console.log('[InstaMap] Cleanup backup created successfully.');
    } finally {
      await session.close();
    }
  }

  /**
   * SOFT DELETE: Move category to archive instead of deleting
   */
  async softDeleteCategory(categoryId: string): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (c:Category {id: $categoryId})
        REMOVE c:Category
        SET c:ArchivedCategory
      `, { categoryId });
    } finally {
      await session.close();
    }
  }

  /**
   * REVERT: Undo cleanup and restore original state
   */
  async revertCleanup(): Promise<void> {
    const session = this.getSession();
    try {
      console.log('[InstaMap] Reverting category cleanup...');

      // 1. Delete all categories created by AI (they don't have OriginalCategory tag)
      await session.run(`
        MATCH (c:Category)
        WHERE NOT c:OriginalCategory
        DETACH DELETE c
      `);

      // 2. Restore archived categories
      await session.run(`
        MATCH (c:ArchivedCategory)
        SET c:Category
        REMOVE c:ArchivedCategory
      `);

      // 3. Reset relationships
      // Delete current mappings
      await session.run(`
        MATCH (:Post)-[r:BELONGS_TO]->(:Category)
        DELETE r
      `);
      await session.run(`
        MATCH (:Category)-[r:CHILD_OF]->(:Category)
        DELETE r
      `);

      // Restore from backup
      await session.run(`
        MATCH (p:Post)-[:HAD_CATEGORY_BEFORE_CLEANUP]->(c:Category)
        MERGE (p)-[:BELONGS_TO]->(c)
      `);

      // 4. Cleanup hierarchy flags and restore original names
      await session.run(`
        MATCH (c:Category)
        SET c.isParent = false
        WITH c
        WHERE c.originalName IS NOT NULL
        SET c.name = c.originalName
        REMOVE c.originalName
      `);

      console.log('[InstaMap] Cleanup reverted successfully.');
    } finally {
      await session.close();
    }
  }

  /**
   * COMMIT: Finalize cleanup and remove backup data
   */
  async commitCleanup(): Promise<void> {
    const session = this.getSession();
    try {
      console.log('[InstaMap] Committing category cleanup...');

      // 1. Permanently delete archived nodes
      await session.run(`
        MATCH (c:ArchivedCategory)
        DETACH DELETE c
      `);

      // 2. Remove backup relationships
      await session.run(`
        MATCH (:Post)-[r:HAD_CATEGORY_BEFORE_CLEANUP]->(:Category)
        DELETE r
      `);

      // 3. Remove backup labels and properties
      await session.run(`
        MATCH (c:OriginalCategory)
        REMOVE c:OriginalCategory, c.originalName
      `);

      console.log('[InstaMap] Cleanup committed successfully.');
    } finally {
      await session.close();
    }
  }

  /**
   * Check if a backup exists
   */
  async hasCleanupBackup(): Promise<boolean> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (c:OriginalCategory)
        RETURN count(c) > 0 as hasBackup
      `);
      return result.records[0].get('hasBackup');
    } finally {
      await session.close();
    }
  }

  async deleteCategory(categoryId: string): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (c:Category {id: $id})
        DETACH DELETE c
      `, { id: categoryId });
    } finally {
      await session.close();
    }
  }

  async reassignPosts(fromCategoryId: string, toCategoryId: string): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (p:Post)-[r:BELONGS_TO]->(old:Category {id: $fromId})
        MATCH (new:Category {id: $toId})
        DELETE r
        MERGE (p)-[:BELONGS_TO]->(new)
      `, { fromId: fromCategoryId, toId: toCategoryId });
    } finally {
      await session.close();
    }
  }

  async getParentCategories(): Promise<Category[]> {
    const session = this.getSession();
    try {
      // Count UNIQUE posts - a post belonging to multiple children should count once
      // Use subquery to get all posts under this parent (direct + via children)
      const result = await session.run(`
        MATCH (c:Category)
        WHERE c.isParent = true
        CALL {
          WITH c
          MATCH (p:Post)-[:BELONGS_TO]->(cat:Category)
          WHERE cat = c OR (cat)-[:CHILD_OF*]->(c)
          RETURN DISTINCT p.instagramId as postId
        }
        WITH c, count(postId) as postCount
        RETURN c, postCount
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

  async getChildCategories(parentId: string): Promise<Category[]> {
    const session = this.getSession();
    try {
      // Count UNIQUE posts under each child (including descendants)
      const result = await session.run(`
        MATCH (parent:Category {id: $parentId})
        MATCH (c:Category)-[:CHILD_OF]->(parent)
        CALL {
          WITH c
          MATCH (p:Post)-[:BELONGS_TO]->(cat:Category)
          WHERE cat = c OR (cat)-[:CHILD_OF*]->(c)
          RETURN DISTINCT p.instagramId as postId
        }
        WITH c, count(postId) as postCount
        RETURN c, postCount
        ORDER BY postCount DESC
      `, { parentId });

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
        RETURN DISTINCT p.instagramId as instagramId
      `);
      return result.records.map(r => r.get('instagramId') as string);
    } finally {
      await session.close();
    }
  }

  async getUncategorizedCount(): Promise<number> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:Post)
        WHERE NOT (p)-[:BELONGS_TO]->(:Category)
        RETURN COUNT(p) as count
      `);
      return result.records[0].get('count').toNumber();
    } finally {
      await session.close();
    }
  }

  // Get count of unique posts in a category (including children)
  async getCategoryPostCount(categoryId: string): Promise<number> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (c:Category {id: $categoryId})
        MATCH (p:Post)-[:BELONGS_TO]->(cat:Category)
        WHERE cat = c OR (cat)-[:CHILD_OF*]->(c)
        RETURN count(DISTINCT p.instagramId) as count
      `, { categoryId });
      return result.records[0]?.get('count')?.toNumber() || 0;
    } finally {
      await session.close();
    }
  }

  async getAllPostIds(): Promise<string[]> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:Post)
        RETURN p.id as id
      `);
      return result.records.map(r => r.get('id') as string);
    } finally {
      await session.close();
    }
  }

  async getPostCount(): Promise<number> {
    const session = this.getSession();
    try {
      const result = await session.run('MATCH (p:Post) RETURN count(p) as total');
      return result.records[0].get('total').toNumber();
    } finally {
      await session.close();
    }
  }

  async getSyncedInstagramIds(limit: number = 20000, offset: number = 0): Promise<string[]> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:Post)
        RETURN p.instagramId as instagramId
        ORDER BY p.savedAt DESC, p.timestamp DESC
        SKIP $offset
        LIMIT $limit
      `, {
        limit: neo4j.int(limit),
        offset: neo4j.int(offset)
      });
      return result.records.map(r => r.get('instagramId') as string);
    } finally {
      await session.close();
    }
  }

  async updatePostMetadata(postId: string, metadata: {
    eventDate?: string;
    hashtags?: string[];
    // Featured mentions (brands, collaborators, etc.)
    mentions?: string[];
    // All places mentioned in the post
    mentionedPlaces?: MentionedPlace[];
    // Extraction reasons
    eventDateReason?: string;
    hashtagsReason?: string;
    categoriesReason?: string;
    mentionsReason?: string;
    mentionedPlacesReason?: string;
  }, source: 'user' | 'claude' = 'claude'): Promise<void> {
    const session = this.getSession();
    try {
      const sets: string[] = [];
      const params: Record<string, unknown> = { id: postId };

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
      if (metadata.mentionedPlaces !== undefined) {
        // Store as JSON string since Neo4j doesn't support nested objects in arrays
        sets.push('p.mentionedPlaces = $mentionedPlaces');
        params.mentionedPlaces = metadata.mentionedPlaces && metadata.mentionedPlaces.length > 0
          ? JSON.stringify(metadata.mentionedPlaces)
          : null;
      }

      // Store extraction reasons
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
      if (metadata.mentionedPlacesReason !== undefined) {
        sets.push('p.mentionedPlacesReason = $mentionedPlacesReason');
        params.mentionedPlacesReason = metadata.mentionedPlacesReason;
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
   * Get posts with mentionedPlaces that have places needing geocoding
   * Returns posts where at least one mentionedPlace lacks coordinates
   */
  async getPostsWithMentionedPlacesNeedingGeocoding(): Promise<InstagramPost[]> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:Post)
        WHERE p.mentionedPlaces IS NOT NULL 
          AND p.mentionedPlaces <> '[]'
        RETURN p
      `);

      // Filter in JS since we need to parse the JSON to check for missing coordinates
      return result.records
        .map(r => this.recordToPost(r.get('p')))
        .filter(post => {
          if (!post.mentionedPlaces || post.mentionedPlaces.length === 0) return false;
          // Check if any place lacks coordinates
          return post.mentionedPlaces.some(place =>
            place.latitude === undefined || place.longitude === undefined
          );
        });
    } finally {
      await session.close();
    }
  }

  /**
   * Update mentionedPlaces for a post (with new coordinates)
   */
  async updateMentionedPlaces(postId: string, mentionedPlaces: MentionedPlace[]): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (p:Post {id: $id})
        SET p.mentionedPlaces = $mentionedPlaces
      `, {
        id: postId,
        mentionedPlaces: JSON.stringify(mentionedPlaces)
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Get posts that have at least one geocoded place (for map display)
   */
  async getPostsWithCoordinates(): Promise<InstagramPost[]> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:Post)
        WHERE p.mentionedPlaces IS NOT NULL 
          AND p.mentionedPlaces <> '[]'
        RETURN p
        ORDER BY p.savedAt DESC
      `);

      // Filter to posts that have at least one place with coordinates
      return result.records
        .map(r => this.recordToPost(r.get('p')))
        .filter(post => {
          if (!post.mentionedPlaces || post.mentionedPlaces.length === 0) return false;
          return post.mentionedPlaces.some(place =>
            place.latitude !== undefined && place.longitude !== undefined
          );
        });
    } finally {
      await session.close();
    }
  }

  /**
   * Migrate old location/venue data to mentionedPlaces format
   * Returns count of posts migrated
   */
  async migrateLocationVenueToMentionedPlaces(): Promise<{ migrated: number; skipped: number }> {
    const session = this.getSession();
    try {
      // Find posts with old location/venue but no mentionedPlaces
      const result = await session.run(`
        MATCH (p:Post)
        WHERE (p.location IS NOT NULL OR p.venue IS NOT NULL)
          AND (p.mentionedPlaces IS NULL OR p.mentionedPlaces = '[]')
        RETURN p.id as id, p.location as location, p.venue as venue, 
               p.latitude as latitude, p.longitude as longitude
      `);

      let migrated = 0;
      let skipped = 0;

      for (const record of result.records) {
        const id = record.get('id') as string;
        const location = record.get('location') as string | null;
        const venue = record.get('venue') as string | null;
        const latitude = record.get('latitude') as number | null;
        const longitude = record.get('longitude') as number | null;

        // Skip if no useful data
        if (!location && !venue) {
          skipped++;
          continue;
        }

        // Create mentionedPlace entry
        const place: MentionedPlace = {
          venue: venue || 'Unknown Venue',
          location: location || 'Unknown Location',
        };

        // Preserve coordinates if they exist
        if (latitude !== null && longitude !== null) {
          place.latitude = latitude;
          place.longitude = longitude;
        }

        // Update the post with new mentionedPlaces
        await session.run(`
          MATCH (p:Post {id: $id})
          SET p.mentionedPlaces = $mentionedPlaces,
              p.mentionedPlacesReason = 'Migrated from legacy location/venue fields'
        `, {
          id,
          mentionedPlaces: JSON.stringify([place]),
        });

        migrated++;
      }

      return { migrated, skipped };
    } finally {
      await session.close();
    }
  }

  /**
   * Clean up old location/venue fields after migration
   */
  async cleanupLegacyLocationFields(): Promise<number> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:Post)
        WHERE p.location IS NOT NULL OR p.venue IS NOT NULL
          OR p.locationReason IS NOT NULL OR p.venueReason IS NOT NULL
          OR p.latitude IS NOT NULL OR p.longitude IS NOT NULL
        SET p.location = null, p.venue = null,
            p.locationReason = null, p.venueReason = null,
            p.latitude = null, p.longitude = null
        RETURN count(p) as cleaned
      `);
      return result.records[0]?.get('cleaned')?.toNumber?.() || 0;
    } finally {
      await session.close();
    }
  }

  // Helpers
  private recordToPost(node: any): InstagramPost {
    const props = node.properties;

    // Parse mentionedPlaces from JSON string
    let mentionedPlaces: MentionedPlace[] | undefined;
    if (props.mentionedPlaces) {
      try {
        mentionedPlaces = JSON.parse(props.mentionedPlaces);
      } catch {
        mentionedPlaces = undefined;
      }
    }

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
      eventDate: props.eventDate,
      mentions: props.mentions,
      mentionedPlaces,
      // Extraction reasons
      hashtagsReason: props.hashtagsReason,
      categoriesReason: props.categoriesReason,
      eventDateReason: props.eventDateReason,
      mentionsReason: props.mentionsReason,
      mentionedPlacesReason: props.mentionedPlacesReason,
      // Edit tracking
      lastEditedBy: props.lastEditedBy,
      lastEditedAt: props.lastEditedAt,
      // Embedding tracking
      embeddingVersion: props.embeddingVersion || 0,
      // Image storage
      localImagePath: props.localImagePath,
      imageExpired: props.imageExpired || false,
      imageExpiredAt: props.imageExpiredAt,
      // Deleted post tracking
      deleted: props.deleted || false,
      deletedAt: props.deletedAt,
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
   * Get post IDs that already have embeddings (to skip during sync)
   */
  async getPostIdsWithEmbeddings(): Promise<string[]> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:Post)
        WHERE p.embedding IS NOT NULL
        RETURN p.id as id
      `);
      return result.records.map(r => r.get('id') as string);
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

  // ============ IMAGE STORAGE METHODS ============

  /**
   * Update post with local image path (by internal id)
   */
  async updatePostLocalImage(postId: string, localImagePath: string): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (p:Post {id: $id})
        SET p.localImagePath = $localImagePath, 
            p.imageExpired = false,
            p.imageExpiredAt = null
      `, { id: postId, localImagePath });
    } finally {
      await session.close();
    }
  }

  /**
   * Update post with local image path (by Instagram ID)
   */
  async updatePostLocalImageByInstagramId(instagramId: string, localImagePath: string): Promise<boolean> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:Post {instagramId: $instagramId})
        SET p.localImagePath = $localImagePath, 
            p.imageExpired = false,
            p.imageExpiredAt = null
        RETURN p.id as id
      `, { instagramId, localImagePath });
      return result.records.length > 0;
    } finally {
      await session.close();
    }
  }

  /**
   * Mark post image as expired (403 error)
   */
  async markPostImageExpired(postId: string): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (p:Post {id: $id})
        SET p.imageExpired = true,
            p.imageExpiredAt = $expiredAt
      `, { id: postId, expiredAt: new Date().toISOString() });
    } finally {
      await session.close();
    }
  }

  /**
   * Mark post as deleted (404 from Instagram - post unsaved or deleted)
   */
  async markPostDeleted(instagramId: string): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (p:Post {instagramId: $instagramId})
        SET p.deleted = true,
            p.deletedAt = $deletedAt,
            p.imageExpired = true
      `, { instagramId, deletedAt: new Date().toISOString() });
    } finally {
      await session.close();
    }
  }

  /**
   * Record a refresh failure for a post. Increments refreshFailCount.
   * If count reaches the threshold (3), auto-marks as deleted.
   * Returns the new fail count and whether it was auto-deleted.
   */
  async recordRefreshFailure(instagramId: string, threshold: number = 3): Promise<{ failCount: number; autoDeleted: boolean }> {
    const session = this.getSession();
    try {
      // Step 1: Increment failure count and return new value
      const result = await session.run(`
        MATCH (p:Post {instagramId: $instagramId})
        SET p.refreshFailCount = COALESCE(p.refreshFailCount, 0) + 1
        RETURN p.refreshFailCount AS failCount
      `, { instagramId });
      const failCount = result.records[0]?.get('failCount')?.toNumber?.() ?? 0;

      // Step 2: Auto-mark as deleted if threshold reached
      let autoDeleted = false;
      if (failCount >= threshold) {
        await session.run(`
          MATCH (p:Post {instagramId: $instagramId})
          SET p.deleted = true,
              p.deletedAt = $deletedAt,
              p.imageExpired = true
        `, { instagramId, deletedAt: new Date().toISOString() });
        autoDeleted = true;
        console.log(`[Neo4j] Post ${instagramId} auto-marked as deleted after ${failCount} consecutive refresh failures`);
      }

      return { failCount, autoDeleted };
    } finally {
      await session.close();
    }
  }

  /**
   * Record refresh failures for multiple posts. Returns summary.
   */
  async recordRefreshFailures(instagramIds: string[], threshold: number = 3): Promise<{ processed: number; autoDeleted: number }> {
    let autoDeleted = 0;
    for (const id of instagramIds) {
      const result = await this.recordRefreshFailure(id, threshold);
      if (result.autoDeleted) autoDeleted++;
    }
    return { processed: instagramIds.length, autoDeleted };
  }

  /**
   * Update post image URL (when refreshed from Instagram) - by internal ID
   */
  async updatePostImageUrl(postId: string, imageUrl: string): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MATCH (p:Post {id: $id})
        SET p.imageUrl = $imageUrl,
            p.thumbnailUrl = $imageUrl,
            p.imageExpired = false,
            p.imageExpiredAt = null
      `, { id: postId, imageUrl });
    } finally {
      await session.close();
    }
  }

  /**
   * Update post image URL by Instagram ID (for collection refresh)
   */
  async updatePostImageUrlByInstagramId(instagramId: string, imageUrl: string): Promise<boolean> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:Post {instagramId: $instagramId})
        SET p.imageUrl = $imageUrl,
            p.thumbnailUrl = $imageUrl,
            p.imageExpired = false,
            p.imageExpiredAt = null,
            p.refreshFailCount = 0
        RETURN p.id as id
      `, { instagramId, imageUrl });
      return result.records.length > 0;
    } finally {
      await session.close();
    }
  }

  /**
   * Get posts with expired images
   */
  async getPostsWithExpiredImages(): Promise<InstagramPost[]> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:Post)
        WHERE p.imageExpired = true
          AND (p.localImagePath IS NULL OR p.localImagePath = '')
          AND (p.deleted IS NULL OR p.deleted = false)
        RETURN p
        ORDER BY p.imageExpiredAt DESC
      `);
      return result.records.map(r => this.recordToPost(r.get('p')));
    } finally {
      await session.close();
    }
  }

  /**
   * Get posts that need images downloaded (no local image, not expired)
   */
  async getPostsNeedingImageDownload(): Promise<InstagramPost[]> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:Post)
        WHERE (p.localImagePath IS NULL OR p.localImagePath = '')
          AND (p.imageExpired IS NULL OR p.imageExpired = false)
          AND p.imageUrl IS NOT NULL
          AND p.imageUrl <> ''
        RETURN p
        ORDER BY p.savedAt DESC
      `);
      return result.records.map(r => this.recordToPost(r.get('p')));
    } finally {
      await session.close();
    }
  }

  /**
   * Get Instagram IDs of posts that need image upload (for extension to filter)
   */
  async getInstagramIdsNeedingImages(): Promise<string[]> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:Post)
        WHERE (p.localImagePath IS NULL OR p.localImagePath = '')
          AND (p.imageExpired IS NULL OR p.imageExpired = false)
          AND p.imageUrl IS NOT NULL
        RETURN p.instagramId as instagramId
      `);
      return result.records.map(r => r.get('instagramId') as string);
    } finally {
      await session.close();
    }
  }

  /**
   * Get count of posts by image status
   */
  async getImageStorageStats(): Promise<{
    total: number;
    withLocalImage: number;
    expired: number;
    needsDownload: number;
  }> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (p:Post)
        RETURN 
          count(p) as total,
          count(CASE WHEN p.localImagePath IS NOT NULL AND p.localImagePath <> '' THEN 1 END) as withLocalImage,
          count(CASE WHEN p.imageExpired = true THEN 1 END) as expired,
          count(CASE WHEN (p.localImagePath IS NULL OR p.localImagePath = '') AND (p.imageExpired IS NULL OR p.imageExpired = false) AND p.imageUrl IS NOT NULL THEN 1 END) as needsDownload
      `);
      const record = result.records[0];
      return {
        total: record.get('total').toNumber(),
        withLocalImage: record.get('withLocalImage').toNumber(),
        expired: record.get('expired').toNumber(),
        needsDownload: record.get('needsDownload').toNumber(),
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Get posts that need expiry checking (no local image AND not already marked expired)
   * Can order by oldest first (more likely to be expired) or newest
   */
  async getPostsForExpiryCheck(limit: number = 500, oldestFirst: boolean = true): Promise<InstagramPost[]> {
    const session = this.getSession();
    try {
      const orderBy = oldestFirst ? 'p.savedAt ASC' : 'p.savedAt DESC';
      const result = await session.run(`
        MATCH (p:Post)
        WHERE (p.localImagePath IS NULL OR p.localImagePath = '')
          AND (p.imageExpired IS NULL OR p.imageExpired = false)
          AND p.imageUrl IS NOT NULL
          AND p.imageUrl <> ''
        RETURN p
        ORDER BY ${orderBy}
        LIMIT $limit
      `, { limit: neo4j.int(limit) });
      return result.records.map(r => this.recordToPost(r.get('p')));
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
      isParent: props.isParent || false,
      embedding: props.embedding || undefined,
    };
  }

  /**
   * Get cloud sync status: total post count, last sync time, and cached local post count
   * Used by popup to show accurate counts even when local cache is cleared
   */
  async getSyncMetadata(): Promise<{
    cloudPostCount: number;
    lastSyncedAt: string | null;
    cachedLocalPostCount: number | null;
    syncCheckpoint: string | null;
  }> {
    const session = this.getSession();
    try {
      // Get total post count
      const countResult = await session.run(`MATCH (p:Post) RETURN count(p) as total`);
      const cloudPostCount = countResult.records[0]?.get('total')?.toNumber() ?? 0;

      // Get sync metadata from a singleton node
      const metaResult = await session.run(`
        MATCH (m:SyncMetadata {id: 'global'})
        RETURN m.lastSyncedAt as lastSyncedAt, m.cachedLocalPostCount as cachedLocalPostCount, m.syncCheckpoint as syncCheckpoint
      `);

      const record = metaResult.records[0];

      // Convert Neo4j DateTime to ISO string
      let lastSyncedAt: string | null = null;
      const rawDate = record?.get('lastSyncedAt');
      if (rawDate) {
        // Neo4j DateTime has toStandardDate() method
        if (typeof rawDate.toStandardDate === 'function') {
          lastSyncedAt = rawDate.toStandardDate().toISOString();
        } else if (typeof rawDate === 'string') {
          lastSyncedAt = rawDate;
        }
      }

      return {
        cloudPostCount,
        lastSyncedAt,
        cachedLocalPostCount: record?.get('cachedLocalPostCount')?.toNumber?.() ?? null,
        syncCheckpoint: record?.get('syncCheckpoint') ?? null,
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Update sync metadata after a successful sync
   * Stores the last sync time and the number of posts in local cache at sync time
   */
  async updateSyncMetadata(localPostCount: number, checkpoint?: string | null): Promise<void> {
    const session = this.getSession();
    try {
      if (checkpoint !== undefined) {
        await session.run(`
          MERGE (m:SyncMetadata {id: 'global'})
          SET m.lastSyncedAt = datetime(),
              m.cachedLocalPostCount = $localPostCount,
              m.syncCheckpoint = $checkpoint
        `, { localPostCount: neo4j.int(localPostCount), checkpoint });
      } else {
        await session.run(`
          MERGE (m:SyncMetadata {id: 'global'})
          SET m.lastSyncedAt = datetime(),
              m.cachedLocalPostCount = $localPostCount
        `, { localPostCount: neo4j.int(localPostCount) });
      }
    } finally {
      await session.close();
    }
  }

  // Cleanup: Find and merge duplicate posts by instagramId
  async cleanupDuplicatePosts(): Promise<{
    duplicatesFound: number;
    postsMerged: number;
    postsDeleted: number;
  }> {
    const session = this.getSession();
    try {
      // Step 1: Find all instagramIds that have duplicates
      const duplicatesResult = await session.run(`
        MATCH (p:Post)
        WITH p.instagramId AS instagramId, collect(p) AS posts, count(p) AS cnt
        WHERE cnt > 1
        RETURN instagramId, cnt, [post IN posts | post.id] AS postIds
      `);

      const duplicates = duplicatesResult.records.map(r => ({
        instagramId: r.get('instagramId'),
        count: r.get('cnt').toNumber(),
        postIds: r.get('postIds') as string[],
      }));

      console.log(`[Cleanup] Found ${duplicates.length} instagramIds with duplicates`);

      let postsMerged = 0;
      let postsDeleted = 0;

      for (const dup of duplicates) {
        console.log(`[Cleanup] Processing ${dup.instagramId}: ${dup.count} copies`);

        // Step 2: Merge all data into the first post (keeper)
        // Collect all categories, hashtags, and use COALESCE for other fields
        const mergeResult = await session.run(`
          MATCH (p:Post {instagramId: $instagramId})
          WITH collect(p) AS posts
          WITH posts, posts[0] AS keeper
          
          // Collect all unique categories from all duplicates
          OPTIONAL MATCH (dup:Post {instagramId: $instagramId})-[:BELONGS_TO]->(c:Category)
          WITH posts, keeper, collect(DISTINCT c) AS allCategories
          
          // Collect all unique hashtags from all duplicates
          WITH posts, keeper, allCategories,
               reduce(tags = [], p IN posts | 
                 CASE WHEN p.hashtags IS NOT NULL 
                   THEN tags + [t IN p.hashtags WHERE NOT t IN tags] 
                   ELSE tags 
                 END
               ) AS allHashtags
          
          // Merge scalar fields: prefer non-null, newest for dates
          WITH posts, keeper, allCategories, allHashtags,
               reduce(loc = null, p IN posts | COALESCE(loc, p.location)) AS mergedLocation,
               reduce(venue = null, p IN posts | COALESCE(venue, p.venue)) AS mergedVenue,
               reduce(lat = null, p IN posts | COALESCE(lat, p.latitude)) AS mergedLat,
               reduce(lng = null, p IN posts | COALESCE(lng, p.longitude)) AS mergedLng,
               reduce(evt = null, p IN posts | COALESCE(evt, p.eventDate)) AS mergedEventDate,
               reduce(embed = null, p IN posts | COALESCE(embed, p.embedding)) AS mergedEmbedding,
               reduce(localPath = null, p IN posts | COALESCE(localPath, p.localImagePath)) AS mergedLocalPath,
               reduce(imgUrl = null, p IN posts | COALESCE(imgUrl, p.imageUrl)) AS mergedImageUrl,
               reduce(caption = '', p IN posts | 
                 CASE WHEN size(p.caption) > size(caption) THEN p.caption ELSE caption END
               ) AS mergedCaption
          
          // Update the keeper with merged data
          SET keeper.location = mergedLocation,
              keeper.venue = mergedVenue,
              keeper.latitude = mergedLat,
              keeper.longitude = mergedLng,
              keeper.eventDate = mergedEventDate,
              keeper.embedding = mergedEmbedding,
              keeper.localImagePath = mergedLocalPath,
              keeper.imageUrl = COALESCE(mergedImageUrl, keeper.imageUrl),
              keeper.caption = CASE WHEN size(mergedCaption) > 0 THEN mergedCaption ELSE keeper.caption END,
              keeper.hashtags = allHashtags,
              keeper.updatedAt = datetime()
          
          // Create category relationships for keeper
          WITH posts, keeper, allCategories
          UNWIND allCategories AS cat
          MERGE (keeper)-[:BELONGS_TO]->(cat)
          
          RETURN keeper.id AS keeperId, size(posts) AS totalPosts
        `, { instagramId: dup.instagramId });

        const keeperId = mergeResult.records[0]?.get('keeperId');
        const totalPosts = mergeResult.records[0]?.get('totalPosts')?.toNumber() || 0;

        // Step 3: Delete all duplicates except the keeper
        if (keeperId) {
          const deleteResult = await session.run(`
            MATCH (p:Post {instagramId: $instagramId})
            WHERE p.id <> $keeperId
            DETACH DELETE p
            RETURN count(p) AS deleted
          `, { instagramId: dup.instagramId, keeperId });

          const deleted = deleteResult.records[0]?.get('deleted')?.toNumber() || 0;
          postsDeleted += deleted;
          postsMerged++;
          console.log(`[Cleanup] Merged ${totalPosts} posts into ${keeperId}, deleted ${deleted} duplicates`);
        }
      }

      return {
        duplicatesFound: duplicates.length,
        postsMerged,
        postsDeleted,
      };
    } finally {
      await session.close();
    }
  }

  // ============ GEOCODING CACHE ============

  /**
   * Initialize geocoding service with cache functions
   * Call this after neo4jService is created
   */
  initGeocodingCache(): void {
    geocodingService.initCache(
      this.lookupGeocodingCache.bind(this),
      this.saveGeocodingCache.bind(this)
    );
  }

  /**
   * Look up a geocoding result from the cache
   */
  async lookupGeocodingCache(queryKey: string): Promise<GeocodingCacheEntry | null> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (g:GeocodingCache {queryKey: $queryKey})
        RETURN g
      `, { queryKey });

      if (result.records.length === 0) {
        return null;
      }

      const record = result.records[0].get('g').properties;
      return {
        queryKey: record.queryKey,
        latitude: typeof record.latitude === 'object' ? record.latitude.toNumber() : record.latitude,
        longitude: typeof record.longitude === 'object' ? record.longitude.toNumber() : record.longitude,
        normalizedLocation: record.normalizedLocation,
        normalizedCountry: record.normalizedCountry || '',
        normalizedCity: record.normalizedCity || '',
        normalizedNeighborhood: record.normalizedNeighborhood || undefined,
        provider: record.provider || 'mapbox',
        createdAt: record.createdAt,
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Save a geocoding result to the cache
   */
  async saveGeocodingCache(entry: GeocodingCacheEntry): Promise<void> {
    const session = this.getSession();
    try {
      await session.run(`
        MERGE (g:GeocodingCache {queryKey: $queryKey})
        SET g.latitude = $latitude,
            g.longitude = $longitude,
            g.normalizedLocation = $normalizedLocation,
            g.normalizedCountry = $normalizedCountry,
            g.normalizedCity = $normalizedCity,
            g.normalizedNeighborhood = $normalizedNeighborhood,
            g.provider = $provider,
            g.createdAt = $createdAt
      `, {
        queryKey: entry.queryKey,
        latitude: entry.latitude,
        longitude: entry.longitude,
        normalizedLocation: entry.normalizedLocation,
        normalizedCountry: entry.normalizedCountry,
        normalizedCity: entry.normalizedCity,
        normalizedNeighborhood: entry.normalizedNeighborhood || null,
        provider: entry.provider,
        createdAt: entry.createdAt,
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Get all cached geocoding entries (for debugging/stats)
   */
  async getGeocodingCacheStats(): Promise<{ total: number; bySource: Record<string, number> }> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (g:GeocodingCache)
        RETURN g.source AS source, count(g) AS count
      `);

      const bySource: Record<string, number> = {};
      let total = 0;

      for (const record of result.records) {
        const source = record.get('source') as string;
        const count = record.get('count').toNumber();
        bySource[source] = count;
        total += count;
      }

      return { total, bySource };
    } finally {
      await session.close();
    }
  }

  /**
   * Clear the geocoding cache (for migration/reset)
   */
  async clearGeocodingCache(): Promise<number> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (g:GeocodingCache)
        DELETE g
        RETURN count(g) AS deleted
      `);
      return result.records[0]?.get('deleted')?.toNumber() || 0;
    } finally {
      await session.close();
    }
  }
}

export const neo4jService = new Neo4jService();
