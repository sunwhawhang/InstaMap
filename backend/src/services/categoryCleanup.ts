import { neo4jService } from './neo4j.js';
import { embeddingsService } from './embeddings.js';
import { claudeService } from './claude.js';
import { Category } from '../types/index.js';
import neo4j from 'neo4j-driver';
import pluralize from 'pluralize';


interface CategoryNameUpdate {
  id: string;
  oldName: string;
  newName: string;
  isDuplicate: boolean;
  duplicateID: string | null;
}

export interface CategoryCluster {
  id: string;
  categories: Category[];
  canonicalName: string;
}

export interface CleanupConfig {
  minPostThreshold: number;
  reassignOrphans: boolean;
  dryRun?: boolean;
}

export interface CleanupResult {
  deletedCount: number;
  hashtagsAdded: number;
  remainingCount: number;
  parentCount: number;
  childCount: number;
}

const CATEGORY_TITLECASE_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'by',
  'for',
  'from',
  'in',
  'into',
  'nor',
  'of',
  'on',
  'onto',
  'or',
  'over',
  'per',
  'so',
  'the',
  'to',
  'under',
  'via',
  'vs',
  'with',
  'yet',
]);

class CategoryCleanupService {
  /**
   * Normalize a category name for comparison (lowercase, trim, normalize punctuation)
   */
  private normalizeForComparison(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/['']/g, "'")  // normalize apostrophes
      .replace(/\s+/g, ' ')   // normalize whitespace
      .replace(/[^a-z0-9\s]/g, ''); // remove special chars
  }

  /**
   * Basic English stemming - handles common plural forms
   * "outfits" -> "outfit", "categories" -> "category", "dishes" -> "dish"
   */
  private stemWord(word: string): string {
    const normalized = this.normalizeForComparison(word);

    // Handle common plural patterns
    if (normalized.endsWith('ies') && normalized.length > 4) {
      return normalized.slice(0, -3) + 'y'; // categories -> category
    }
    if (normalized.endsWith('es') && normalized.length > 3) {
      // dishes -> dish, but not "recipes" -> "recip"
      const stem = normalized.slice(0, -2);
      if (stem.endsWith('sh') || stem.endsWith('ch') || stem.endsWith('x') || stem.endsWith('s')) {
        return stem;
      }
    }
    if (normalized.endsWith('s') && normalized.length > 2 && !normalized.endsWith('ss')) {
      return normalized.slice(0, -1); // outfits -> outfit
    }
    return normalized;
  }

  private endsWithPluralS(name: string): boolean {
    const normalized = this.normalizeForComparison(name);
    return normalized.endsWith('s') && normalized.length > 2 && !normalized.endsWith('ss');
  }

  private toTitleCaseCategoryName(name: string): string {
    const normalized = name.trim().replace(/\s+/g, ' ');
    if (!normalized) return normalized;

    const titleCaseSegment = (segment: string, isFirstWord: boolean): string => {
      if (!segment) return segment;

      // Keep acronyms like "USA", "AI"
      if (/^[A-Z0-9]{2,}$/.test(segment)) return segment;

      // Preserve leading/trailing non-alphanumerics (e.g. "#food", "(travel)")
      const firstAlphaNumIdx = segment.search(/[A-Za-z0-9]/);
      if (firstAlphaNumIdx === -1) return segment;
      const lastAlphaNumIdx = segment.lastIndexOf(segment.match(/[A-Za-z0-9](?!.*[A-Za-z0-9])/g)?.[0] ?? '');

      // If regex fallback fails, just do a best-effort capitalization
      if (lastAlphaNumIdx === -1) {
        const lower = segment.toLowerCase();
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      }

      const prefix = segment.slice(0, firstAlphaNumIdx);
      const core = segment.slice(firstAlphaNumIdx, lastAlphaNumIdx + 1);
      const suffix = segment.slice(lastAlphaNumIdx + 1);

      const coreLower = core.toLowerCase();
      const shouldLowercase = !isFirstWord && CATEGORY_TITLECASE_STOP_WORDS.has(coreLower);
      const casedCore = shouldLowercase
        ? coreLower
        : coreLower.charAt(0).toUpperCase() + coreLower.slice(1);

      return `${prefix}${casedCore}${suffix}`;
    };

    const titleCaseToken = (token: string, isFirstWord: boolean): string => {
      // Handle dashed/underscored/slashed tokens:
      // "new-york" -> "New-York", "hair_care" -> "Hair_Care", "food/travel" -> "Food/Travel"
      const parts = token.split(/([\-_/])/);
      let firstSegment = true;
      return parts
        .map((part) => {
          if (part === '-' || part === '_' || part === '/') return part;
          const out = titleCaseSegment(part, isFirstWord && firstSegment);
          firstSegment = false;
          return out;
        })
        .join('');
    };

    return normalized
      .split(' ')
      .map((token, idx) => titleCaseToken(token, idx === 0))
      .join(' ');
  }

  /**
   * Cleanup before title-casing:
   * - strip leading/trailing whitespace
   * - collapse repeated whitespace
   * - drop punctuation/symbols (keep letters, numbers, space, -, _, /)
   * - ensure apostrophe is not removed e.g "women's" -> "women's"
   */
  private sanitizeCategoryNameInput(name: string): string {
    return name
      .replace(/[^\p{L}\p{N}\s\-_'\/]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Apply title case normalization AND pluralization to category names.
   * This handles both capitalization and converting singular forms to plural.
   */
  private applyTitleCaseNormalization(
    categories: Category[]
  ): Array<CategoryNameUpdate> {
    const updates: Array<CategoryNameUpdate> = [];
    const existingNamesToID = new Map<string, string>();

    // populate existing names with all category names
    for (const cat of categories) {
      existingNamesToID.set(cat.name, cat.id);
    }

    for (const cat of categories) {
      const cleaned = this.sanitizeCategoryNameInput(cat.name);
      let newName = cleaned
        ? this.toTitleCaseCategoryName(cleaned)
        : 'General'; // If original name had no alpha-numeric characters, use "General"

      // Apply pluralization to the title-cased name
      // if (newName && newName !== 'General') {
      //   newName = this.pluralizeCategoryName(newName);
      // }

      if (newName && newName !== cat.name) {
        if (existingNamesToID.has(newName)) {
          console.warn(`[InstaMap] Duplicate category name: "${newName}"`);
          updates.push({ id: cat.id, oldName: cat.name, newName, isDuplicate: true, duplicateID: existingNamesToID.get(newName)! });
        } else {
          updates.push({ id: cat.id, oldName: cat.name, newName, isDuplicate: false, duplicateID: null });
        }
        existingNamesToID.set(newName, cat.id);
        existingNamesToID.delete(cat.name);
      }
    }

    return updates;
  }

  /**
   * Intelligently pluralize category names while preserving multi-word structure.
   * Only pluralizes the final word (e.g., "Coffee Shop" → "Coffee Shops")
   * The pluralize library handles uncountable nouns, irregular plurals, and already-plural words automatically.
   */
  private pluralizeCategoryName(name: string): string {
    // Split into words, pluralize only the last word
    const words = name.split(' ');
    if (words.length === 0) return name;

    const lastWord = words[words.length - 1];
    const pluralLastWord = pluralize(lastWord);

    // If pluralization changed the word, reconstruct the full name
    if (pluralLastWord !== lastWord) {
      words[words.length - 1] = pluralLastWord;
      return words.join(' ');
    }

    return name;
  }

  private async persistCategoryNameUpdates(
    categories: Category[],
    updates: Array<CategoryNameUpdate>
  ): Promise<Category[]> {
    // First only update the categories that are not duplicates
    for (const u of updates) {
      if (!u.isDuplicate) {
        await neo4jService.updateCategoryName(u.id, u.newName);
        categories.find(c => c.id === u.id)!.name = u.newName;
      }
    }

    // For duplicates, we need to add the posts under them to the existing category
    for (const u of updates) {
      if (u.isDuplicate) {
        await neo4jService.reassignPosts(u.id, u.duplicateID!);
        await neo4jService.softDeleteCategory(u.id);
        // remove the category from the list
        categories = categories.filter(c => c.id !== u.id);
      }
    }

    return categories;
  }

  /**
   * Pre-cluster categories by normalized/stemmed name before embeddings
   * This catches obvious duplicates like "outfit" vs "outfits" vs "Outfit"
   */
  async preClusterByNormalization(categories: Category[]): Promise<Array<{ keep: Category; merge: Category[] }>> {
    const groups = new Map<string, Category[]>();

    for (const cat of categories) {
      const stemmed = this.stemWord(cat.name);
      if (!groups.has(stemmed)) {
        groups.set(stemmed, []);
      }
      groups.get(stemmed)!.push(cat);
    }

    // For each group with multiple categories, pick the best one to keep
    const mergeActions: Array<{ keep: Category; merge: Category[] }> = [];

    for (const [, group] of groups) {
      if (group.length > 1) {
        // Sort by:
        // 1) Prefer plural ("...s") variant when both singular+plural exist in the group
        // 2) Higher post count
        // 3) Stable tie-breakers
        const groupHasTrailingS = group.some(c => this.endsWithPluralS(c.name));
        const groupHasNonTrailingS = group.some(c => !this.endsWithPluralS(c.name));
        const preferTrailingS = groupHasTrailingS && groupHasNonTrailingS;

        group.sort((a, b) => {
          if (preferTrailingS) {
            const aS = this.endsWithPluralS(a.name);
            const bS = this.endsWithPluralS(b.name);
            if (aS !== bS) return aS ? -1 : 1;
          }

          // Prefer higher post count
          const countDiff = (b.postCount || 0) - (a.postCount || 0);
          if (countDiff !== 0) return countDiff;

          // Prefer shorter (more canonical) names
          const lenDiff = a.name.length - b.name.length;
          if (lenDiff !== 0) return lenDiff;

          return a.name.localeCompare(b.name);
        });

        const keep = group[0];
        const merge = group.slice(1);
        mergeActions.push({ keep, merge });
      }
    }

    return mergeActions;
  }

  /**
   * Execute pre-clustering merges in the database
   */
  async executeMerges(categories: Category[], mergeActions: Array<{ keep: Category; merge: Category[] }>): Promise<{ mergedCategories: Category[], mergedCount: number }> {
    let mergedCount = 0;

    for (const { keep, merge } of mergeActions) {
      for (const toMerge of merge) {
        console.log(`[InstaMap] Pre-merge (Soft): "${toMerge.name}" → "${keep.name}"`);
        await neo4jService.reassignPosts(toMerge.id, keep.id);
        await neo4jService.softDeleteCategory(toMerge.id);
        // remove the category from the list
        categories = categories.filter(c => c.id !== toMerge.id);
        mergedCount++;
      }
    }

    return { mergedCategories: categories, mergedCount };
  }

  /**
   * Analyze categories to determine which to keep and which to delete
   */
  async analyzeCategories(minPostThreshold: number): Promise<{
    toKeep: Category[];
    toDelete: Category[];
    orphanedPosts: number;
  }> {
    const allCategories = await neo4jService.getCategories();
    const toKeep = allCategories.filter(c => (c.postCount || 0) >= minPostThreshold);
    const toDelete = allCategories.filter(c => (c.postCount || 0) < minPostThreshold);

    let orphanedPosts = 0;
    toDelete.forEach(c => orphanedPosts += (c.postCount || 0));

    return { toKeep, toDelete, orphanedPosts };
  }

  /**
   * Convert deleted category names to hashtags on their posts
   */
  async convertCategoriesToHashtags(categories: Category[]): Promise<void> {
    const BATCH_SIZE = 50;
    for (let i = 0; i < categories.length; i += BATCH_SIZE) {
      const batch = categories.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (cat) => {
        // Format: camelCase, no spaces
        const hashtag = cat.name
          .split(/[\s_-]+/)
          .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
          .join('')
          .replace(/[^a-zA-Z0-9]/g, '');

        if (hashtag && hashtag.length > 0) {
          await neo4jService.addHashtagToPostsInCategory(cat.id, hashtag);
        }
      }));
    }
  }

  /**
   * Generate embeddings for remaining category names
   */
  async generateCategoryEmbeddings(categories: Category[]): Promise<void> {
    const categoriesToEmbed = categories.filter(c => !c.embedding);
    if (categoriesToEmbed.length === 0) return;

    // Process in batches of 100 for embeddings
    const BATCH_SIZE = 100;
    for (let i = 0; i < categoriesToEmbed.length; i += BATCH_SIZE) {
      const batch = categoriesToEmbed.slice(i, i + BATCH_SIZE);
      const names = batch.map(c => c.name);
      const embeddings = await embeddingsService.generateEmbeddings(names);

      await Promise.all(batch.map(async (item, idx) => {
        await neo4jService.updateCategoryEmbedding(item.id, embeddings[idx]);
        item.embedding = embeddings[idx]; // Update local object
      }));
    }
  }

  /**
   * Cluster similar categories (cosine similarity > 0.85)
   */
  async clusterCategories(categories: Category[]): Promise<CategoryCluster[]> {
    const threshold = 0.78; // Lowered from 0.85 to catch more semantic variants (outfit/outfits)
    const clusters: CategoryCluster[] = [];
    const visited = new Set<string>();

    for (let i = 0; i < categories.length; i++) {
      if (visited.has(categories[i].id)) continue;
      if (!categories[i].embedding) continue;

      const cluster: Category[] = [categories[i]];
      visited.add(categories[i].id);

      for (let j = i + 1; j < categories.length; j++) {
        if (visited.has(categories[j].id)) continue;
        if (!categories[j].embedding) continue;

        const sim = this.cosineSimilarity(categories[i].embedding!, categories[j].embedding!);
        if (sim >= threshold) {
          cluster.push(categories[j]);
          visited.add(categories[j].id);
        }
      }

      // Use the first (highest post count) category name as cluster ID for LLM clarity
      const canonicalName = cluster[0].name;
      clusters.push({
        id: canonicalName, // Use real name instead of cluster_X for better LLM understanding
        categories: cluster,
        canonicalName: canonicalName
      });
    }

    // Sort clusters by total post count (most important first)
    const sortedClusters = [...clusters].sort((a, b) => {
      const countA = a.categories.reduce((sum, c) => sum + (c.postCount || 0), 0);
      const countB = b.categories.reduce((sum, c) => sum + (c.postCount || 0), 0);
      return countB - countA;
    });

    // Log embedding clustering results
    const multiCategoryClusters = sortedClusters.filter(c => c.categories.length > 1);
    console.log(`[InstaMap] Embedding clustering: ${categories.length} categories → ${sortedClusters.length} clusters`);
    if (multiCategoryClusters.length > 0) {
      console.log(`[InstaMap] ${multiCategoryClusters.length} clusters have multiple categories (merged by embedding similarity):`);
      multiCategoryClusters.forEach(c => {
        console.log(`  - "${c.canonicalName}": ${c.categories.map(cat => cat.name).join(', ')}`);
      });
    }

    return sortedClusters;
  }

  /**
   * Step 5: Use LLM to create hierarchy with batching for large datasets
   */
  async createHierarchyWithLLM(categories: Category[]): Promise<{
    parents: { name: string; children: string[]; reason: string }[];
  }> {
    // Pass category names only - post counts are not relevant for hierarchy decisions
    const categoryNames = categories.map(c => ({ name: c.name }));
    return await claudeService.createCategoryHierarchy(categoryNames);
  }

  /**
   * Main orchestrator for the category cleanup process.
   * Handles backup, analysis, merging, and hierarchy generation.
   */
  async executeCleanup(
    config: CleanupConfig,
    onProgress?: (step: string, message: string, progress: number) => void
  ): Promise<CleanupResult> {
    const totalSteps = 11; // Updated: removed final rename step
    let currentStep = 0;

    const update = (message: string) => {
      currentStep++;
      if (onProgress) {
        onProgress(`step_${currentStep}`, message, Math.round((currentStep / totalSteps) * 100));
      }
      console.log(`[InstaMap] Cleanup Step ${currentStep}/${totalSteps}: ${message}`);
    };

    update(`Analyzing ${config.minPostThreshold} threshold...`);
    // 0. Analyze (Both for dry run and real run)
    let { toKeep, toDelete } = await this.analyzeCategories(config.minPostThreshold);

    if (config.dryRun) {
      // Dry run - just return the analysis results
      return {
        deletedCount: toDelete.length,
        hashtagsAdded: toDelete.length,
        remainingCount: toKeep.length,
        parentCount: 0,
        childCount: 0
      };
    }

    // 1. CREATE BACKUP FIRST
    update(`Creating cleanup backup (System Restore Point)...`);
    await neo4jService.createCleanupBackup();

    // 2. Convert low-count categories to hashtags
    update(`Preserving information as hashtags on posts for categories to delete...`);
    await this.convertCategoriesToHashtags(toDelete);

    // 3. Delete low-count categories
    update(`Deleting ${toDelete.length} low-count categories...`);
    const DELETE_BATCH = 50;
    for (let i = 0; i < toDelete.length; i += DELETE_BATCH) {
      const batch = toDelete.slice(i, i + DELETE_BATCH);
      await Promise.all(batch.map(cat => neo4jService.softDeleteCategory(cat.id)));
    }

    // 4. Normalize capitalization and update Neo4j
    update(`Normalizing capitalization of ${toKeep.length} categories...`);
    const titleCaseUpdates = this.applyTitleCaseNormalization(toKeep);
    toKeep = await this.persistCategoryNameUpdates(toKeep, titleCaseUpdates);

    // 5. Pre-cluster by normalization/stemming BEFORE embeddings (saves API calls!)
    update(`Pre-clustering obvious duplicates (outfit/outfits, Coffee/coffee)...`);
    const mergeActions = await this.preClusterByNormalization(toKeep);
    if (mergeActions.length > 0) {
      const { mergedCategories, mergedCount } = await this.executeMerges(toKeep, mergeActions);
      toKeep = mergedCategories;
      console.log(`[InstaMap] Pre-merged ${mergedCount} duplicate categories`);
    }

    // 6. Generate embeddings for all categories (needed for clustering and mapping)
    update(`Generating embeddings for ${toKeep.length} categories to keep...`);
    await this.generateCategoryEmbeddings(toKeep);

    // 7. Only reassign posts that would be orphaned (left with 0 categories)
    update(`Identifying posts that would be left with no categories and reassigning them to similar categories...`);
    await this.reassignOrphanedPosts(toKeep);

    // 8. Cluster by embeddings
    update(`Clustering ${toKeep.length} categories by embedding similarity (threshold: 0.78)...`);
    let sortedClusters = await this.clusterCategories(toKeep);

    // Add post counts to cluster data for Claude - using category names as IDs for clarity
    let clustersWithCounts = sortedClusters.map(c => ({
      id: c.id, // Now uses canonical name instead of cluster_X
      categories: c.categories.map(cat => cat.name),
      postCount: c.categories.reduce((sum, cat) => sum + (cat.postCount || 0), 0)
    }));

    // 9. FIRST LLM CALL: Identify which clusters should be merged
    update(`AI identifying semantic merges across ${sortedClusters.length} clusters (Claude call 1/2)...`);
    const mergeResult = await claudeService.mergeSimilarClusters(clustersWithCounts);

    // Apply LLM-suggested merges IMMEDIATELY to database
    if (mergeResult.merges && mergeResult.merges.length > 0) {
      update(`Applying ${mergeResult.merges.length} semantic merges to database...`);
      const semanticMergeActions: Array<{ keep: Category; merge: Category[] }> = [];

      for (const merge of mergeResult.merges) {

        // Find the clusters involved
        const clustersToMerge = merge.clusterIds
          .map(id => sortedClusters.find(c => c.id === id))
          .filter((c): c is CategoryCluster => !!c);
        if (merge.clusterIds.length < 2) continue; // i.e. only one cluster so no merging needed

        // Determine which category to keep (prefer the one matching canonicalName, else the first one)
        const allCategoriesInClusters = clustersToMerge.flatMap(c => c.categories);
        let keepCategory = allCategoriesInClusters.find(c => c.name.toLowerCase() === merge.canonicalName.toLowerCase());

        if (!keepCategory) {
          keepCategory = allCategoriesInClusters[0];
          // Rename it to the canonical name Claude suggested
          await neo4jService.updateCategoryName(keepCategory.id, merge.canonicalName);
          keepCategory.name = merge.canonicalName;
        }

        const toMerge = allCategoriesInClusters.filter(c => c.id !== keepCategory!.id);
        if (toMerge.length > 0) {
          semanticMergeActions.push({ keep: keepCategory, merge: toMerge });
          console.log(`[InstaMap] Semantic merge: "${toMerge.map(c => c.name).join(', ')}" → "${keepCategory.name}" (${merge.reason})`);
        }
      }

      if (semanticMergeActions.length > 0) {
        const { mergedCategories } = await this.executeMerges(toKeep, semanticMergeActions);
        toKeep = mergedCategories;
      }
    }

    // 10. SECOND LLM CALL: Create hierarchy from flat list of consolidated categories
    update(`AI generating taxonomy from ${toKeep.length} categories (Claude call 2/2)...`);
    const hierarchy = await this.createHierarchyWithLLM(toKeep);
    const parents = hierarchy?.parents || [];

    // 11. Apply hierarchy to database
    update(`Applying parent/child relationships to database...`);
    let childCount = 0;
    let actualParentCount = 0;
    for (const parentData of parents) {
      // Find all valid children for this parent (intersection of suggested children and actual categories)
      const childNamesSet = new Set(parentData.children);
      const validChildren = toKeep.filter(c => childNamesSet.has(c.name));

      // Skip if no valid children - keep category as flat/standalone
      if (validChildren.length === 0) {
        console.log(`[InstaMap] Skipping "${parentData.name}" - no valid children found, keeping as standalone category`);
        continue;
      }

      // Check if parent already exists in our categories (promoted from existing)
      let parentCat = toKeep.find(c => c.name === parentData.name);

      if (!parentCat) {
        // Create NEW parent category (doesn't exist in the list)
        parentCat = await neo4jService.createCategory(
          parentData.name,
          `Parent category created during cleanup: ${parentData.reason}`
        );
        console.log(`[InstaMap] Created new parent: "${parentData.name}" with ${validChildren.length} children`);
      } else {
        console.log(`[InstaMap] Promoted existing category to parent: "${parentData.name}" with ${validChildren.length} children`);
      }

      // Mark as parent (only if we have children)
      await neo4jService.setCategoryIsParent(parentCat.id, true);
      actualParentCount++;

      // Create parent-child relationships
      for (const childCat of validChildren) {
        if (childCat.id !== parentCat.id) { // Don't make a category its own child
          await neo4jService.setCategoryParent(childCat.id, parentCat.id);
          childCount++;
        }
      }
    }

    // 12. Handle orphan posts with parent-only categories (must be after hierarchy is set up)
    const otherCategoriesCreated = await this.handleOrphanParentPosts(parents, update);
    childCount += otherCategoriesCreated;

    // 13. Done!
    update(`Cleanup complete!`);

    return {
      deletedCount: toDelete.length,
      hashtagsAdded: toDelete.length,
      remainingCount: toKeep.length,
      parentCount: actualParentCount,
      childCount: childCount
    };
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private findMostSimilarCategory(targetEmbedding: number[], candidates: Category[]): Category | null {
    let maxSim = -1;
    let bestMatch: Category | null = null;

    for (const cand of candidates) {
      if (!cand.embedding) continue;
      const sim = this.cosineSimilarity(targetEmbedding, cand.embedding);
      if (sim > maxSim) {
        maxSim = sim;
        bestMatch = cand;
      }
    }
    return bestMatch;
  }

  private async findOrphanedPostIds(toKeepIds: string[]): Promise<string[]> {
    const session = neo4jService.getSession();
    try {
      // A post is orphaned if it has category relationships but NONE of them are in the toKeep list
      const result = await session.run(`
        MATCH (p:Post)-[:BELONGS_TO]->(c:Category)
        WITH p, collect(c.id) as catIds
        WHERE NONE(id IN catIds WHERE id IN $toKeepIds)
        RETURN p.id as id
      `, { toKeepIds });
      return result.records.map(r => r.get('id'));
    } finally {
      await session.close();
    }
  }

  private async reassignOrphanedPosts(toKeep: Category[]): Promise<void> {
    const toKeepIds = toKeep.map(c => c.id);
    const orphanedPostIds = await this.findOrphanedPostIds(toKeepIds);

    if (orphanedPostIds.length > 0) {
      // Sequential to avoid Neo4j deadlocks when multiple posts target same category
      for (const postId of orphanedPostIds) {
        const post = await neo4jService.getPostById(postId);
        if (post && post.embedding) {
          const bestMatch = this.findMostSimilarCategory(post.embedding, toKeep);
          if (bestMatch) {
            await neo4jService.assignPostToCategory(postId, bestMatch.id);
          }
        }
      }
    }
  }

  /**
   * Handle posts that have only a parent category tag when that category becomes a parent.
   * For each parent category:
   * 1. Find posts that have this parent category
   * 2. Check if they also have any child categories under this parent
   * 3. If they have children: remove the parent tag (redundant)
   * 4. If they don't have children: create "Other [Parent]" category and assign to it
   * 
   * @returns Number of "Other" categories created
   */
  private async handleOrphanParentPosts(
    parents: Array<{ name: string; children: string[]; reason?: string }>,
    update: (msg: string) => void
  ): Promise<number> {
    update(`Handling posts with parent-only categories...`);

    let orphansHandled = 0;
    let redundantParentsRemoved = 0;
    const otherCategoriesCreated = new Set<string>(); // Track unique "Other" categories created

    for (const parentData of parents) {
      const session = neo4jService.getSession();

      try {
        // Find the parent category (must exist by now as we just created/marked it)
        const parentResult = await session.run(`
          MATCH (c:Category {name: $parentName})
          RETURN c.id as id
        `, { parentName: parentData.name });

        if (parentResult.records.length === 0) {
          continue;
        }

        const parentId = parentResult.records[0].get('id');

        // Get child category IDs for this parent
        const childNames = parentData.children;
        const childResult = await session.run(`
          MATCH (c:Category)
          WHERE c.name IN $childNames
          RETURN c.id as id
        `, { childNames });

        const childIds = childResult.records.map(r => r.get('id'));

        if (childIds.length === 0) {
          // No children exist yet, skip
          continue;
        }

        // Find all posts that have this parent category
        const postsResult = await session.run(`
          MATCH (p:Post)-[:BELONGS_TO]->(parent:Category {id: $parentId})
          RETURN p.id as postId
        `, { parentId });

        const postIds = postsResult.records.map(r => r.get('postId'));

        // Collect posts that need "Other" category vs posts that just need parent removed
        const postsNeedingOther: string[] = [];
        const postsWithRedundantParent: string[] = [];

        for (const postId of postIds) {
          // Check if post has any child categories under this parent
          const childCheckResult = await session.run(`
            MATCH (p:Post {id: $postId})-[:BELONGS_TO]->(c:Category)
            WHERE c.id IN $childIds
            RETURN count(c) as childCount
          `, { postId, childIds });

          const childCount = childCheckResult.records[0].get('childCount').toNumber();

          if (childCount > 0) {
            postsWithRedundantParent.push(postId);
          } else {
            postsNeedingOther.push(postId);
          }
        }

        // Batch remove redundant parent tags
        if (postsWithRedundantParent.length > 0) {
          await session.run(`
            MATCH (p:Post)-[r:BELONGS_TO]->(parent:Category {id: $parentId})
            WHERE p.id IN $postIds
            DELETE r
          `, { parentId, postIds: postsWithRedundantParent });
          redundantParentsRemoved += postsWithRedundantParent.length;
        }

        // Handle posts that need "Other" category - ONLY if there are any
        if (postsNeedingOther.length > 0) {
          const otherCategoryName = `Other ${parentData.name}`;

          // Check if "Other" category exists, create if not (ONCE)
          let otherCategoryId: string;
          const otherCatResult = await session.run(`
            MATCH (c:Category {name: $otherName})
            RETURN c.id as id
          `, { otherName: otherCategoryName });

          if (otherCatResult.records.length > 0) {
            otherCategoryId = otherCatResult.records[0].get('id');
          } else {
            // Create new "Other [Parent]" category
            const newCat = await neo4jService.createCategory(
              otherCategoryName,
              `Catch-all for ${parentData.name} posts that don't fit specific subcategories`
            );
            otherCategoryId = newCat.id;

            // Set parent relationship for the new "Other" category
            await neo4jService.setCategoryParent(otherCategoryId, parentId);

            otherCategoriesCreated.add(otherCategoryName);
            console.log(`[InstaMap] Created "Other" category: "${otherCategoryName}" under "${parentData.name}"`);
          }

          // Batch update: remove parent and add "Other" category for all orphan posts
          await session.run(`
            MATCH (p:Post)-[r:BELONGS_TO]->(parent:Category {id: $parentId})
            WHERE p.id IN $postIds
            DELETE r
          `, { parentId, postIds: postsNeedingOther });

          await session.run(`
            MATCH (p:Post)
            WHERE p.id IN $postIds
            MATCH (c:Category {id: $otherCategoryId})
            MERGE (p)-[:BELONGS_TO]->(c)
          `, { postIds: postsNeedingOther, otherCategoryId });

          orphansHandled += postsNeedingOther.length;
        }
      } finally {
        await session.close();
      }
    }

    if (orphansHandled > 0 || redundantParentsRemoved > 0) {
      console.log(`[InstaMap] Orphan handling: ${orphansHandled} posts moved to "Other" categories, ${redundantParentsRemoved} redundant parent tags removed`);
    }

    return otherCategoriesCreated.size;
  }
}

export const categoryCleanupService = new CategoryCleanupService();
