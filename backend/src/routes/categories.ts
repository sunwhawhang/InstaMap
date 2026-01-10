import { Router, Request, Response } from 'express';
import { neo4jService } from '../services/neo4j.js';
import { categoryCleanupService, CleanupResult } from '../services/categoryCleanup.js';

export const categoriesRouter = Router();

// Cleanup progress tracking
let cleanupProgress: {
  status: 'idle' | 'running' | 'done' | 'error';
  message: string;
  progress: number;
  logs: string[];
  result?: CleanupResult;
  error?: string;
} = { status: 'idle', message: '', progress: 0, logs: [] };

// Get all categories
categoriesRouter.get('/', async (req: Request, res: Response) => {
  try {
    const categories = await neo4jService.getCategories();
    res.json(categories);
  } catch (error) {
    console.error('Failed to get categories:', error);
    res.status(500).json({ error: 'Failed to get categories' });
  }
});

// Get category tree (hierarchy)
categoriesRouter.get('/hierarchy', async (req: Request, res: Response) => {
  try {
    const parents = await neo4jService.getParentCategories();

    if (parents.length === 0) {
      // No hierarchy exists, return flat list of all categories
      const allCategories = await neo4jService.getCategories();
      res.json(allCategories.map(cat => ({ ...cat, children: [] })));
      return;
    }

    // Build tree with parent-child relationships
    const tree = await Promise.all(parents.map(async (parent) => {
      const children = await neo4jService.getChildCategories(parent.id);
      return {
        ...parent,
        children
      };
    }));

    // Get all categories to find "flat" ones (not parent, not child)
    const allCategories = await neo4jService.getCategories();
    const parentIds = new Set(parents.map(p => p.id));
    const childIds = new Set();
    tree.forEach(parent => {
      parent.children.forEach(child => childIds.add(child.id));
    });

    // Find standalone categories (neither parent nor child)
    const flatCategories = allCategories
      .filter(cat => !parentIds.has(cat.id) && !childIds.has(cat.id))
      .map(cat => ({ ...cat, children: [] }));

    // Return parents + flat categories
    res.json([...tree, ...flatCategories]);
  } catch (error) {
    console.error('Failed to get category tree:', error);
    res.status(500).json({ error: 'Failed to get category tree' });
  }
});

// Reset category hierarchy
categoriesRouter.post('/reset', async (req: Request, res: Response) => {
  try {
    await neo4jService.revertCleanup();
    res.json({ success: true, message: 'Category reverted to original state' });
  } catch (error) {
    console.error('Failed to reset categories:', error);
    res.status(500).json({ error: 'Failed to reset categories' });
  }
});

// Preview cleanup
categoriesRouter.post('/analyze', async (req: Request, res: Response) => {
  try {
    const { minPosts } = req.body;
    const threshold = parseInt(minPosts) || 5;
    const result = await categoryCleanupService.analyzeCategories(threshold);
    res.json(result);
  } catch (error) {
    console.error('Failed to analyze categories:', error);
    res.status(500).json({ error: 'Failed to analyze categories' });
  }
});

// Get cleanup status
categoriesRouter.get('/cleanup/status', async (req: Request, res: Response) => {
  try {
    const hasBackup = await neo4jService.hasCleanupBackup();
    res.json({
      ...cleanupProgress,
      hasBackup
    });
  } catch (error) {
    res.json(cleanupProgress);
  }
});

// Revert cleanup
categoriesRouter.post('/cleanup/revert', async (req: Request, res: Response) => {
  try {
    await neo4jService.revertCleanup();
    // Reset local progress state if it was successful/done
    cleanupProgress = { status: 'idle', message: 'Cleanup reverted', progress: 0, logs: [] };
    res.json({ success: true, message: 'Cleanup successfully reverted to original state' });
  } catch (error) {
    console.error('Failed to revert cleanup:', error);
    res.status(500).json({ error: 'Failed to revert cleanup' });
  }
});

// Commit cleanup
categoriesRouter.post('/cleanup/commit', async (req: Request, res: Response) => {
  try {
    await neo4jService.commitCleanup();
    cleanupProgress = { status: 'idle', message: 'Cleanup committed', progress: 0, logs: [] };
    res.json({ success: true, message: 'Cleanup successfully committed (backups purged)' });
  } catch (error) {
    console.error('Failed to commit cleanup:', error);
    res.status(500).json({ error: 'Failed to commit cleanup' });
  }
});

// Execute cleanup
categoriesRouter.post('/cleanup', async (req: Request, res: Response) => {
  try {
    const { minPosts, dryRun } = req.body;

    // Check if already running
    if (cleanupProgress.status === 'running') {
      return res.json({
        ...cleanupProgress,
        message: 'Cleanup already in progress'
      });
    }

    const config = {
      minPostThreshold: parseInt(minPosts) || 5,
      reassignOrphans: true,
      dryRun: !!dryRun
    };

    // Reset progress
    cleanupProgress = {
      status: 'running',
      message: 'Starting cleanup...',
      progress: 0,
      logs: ['Starting cleanup...']
    };

    // If dry run, execute immediately and return
    if (dryRun) {
      const result = await categoryCleanupService.executeCleanup(config);
      return res.json(result);
    }

    // Process in background
    (async () => {
      try {
        const result = await categoryCleanupService.executeCleanup(config, (step, message, progress) => {
          cleanupProgress.message = message;
          cleanupProgress.progress = progress;
          if (!cleanupProgress.logs.includes(message)) {
            cleanupProgress.logs.push(message);
          }
        });
        cleanupProgress.status = 'done';
        cleanupProgress.result = result;
        cleanupProgress.progress = 100;
      } catch (error) {
        console.error('Category cleanup background job failed:', error);
        cleanupProgress.status = 'error';
        cleanupProgress.error = error instanceof Error ? error.message : 'Unknown error';
      }
    })();

    res.json({ status: 'started', message: 'Category cleanup started in background' });
  } catch (error) {
    console.error('Category cleanup failed:', error);
    cleanupProgress.status = 'error';
    res.status(500).json({ error: 'Category cleanup failed' });
  }
});

// Create category
categoriesRouter.post('/', async (req: Request, res: Response) => {
  try {
    const { name, description, color } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Name is required' });
    }

    const category = await neo4jService.createCategory(
      name.trim(),
      description?.trim(),
      color
    );

    res.status(201).json(category);
  } catch (error) {
    console.error('Failed to create category:', error);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

// Set category parent
categoriesRouter.patch('/:id/parent', async (req: Request, res: Response) => {
  try {
    const { parentId } = req.body;
    await neo4jService.setCategoryParent(req.params.id, parentId);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to set category parent:', error);
    res.status(500).json({ error: 'Failed to set category parent' });
  }
});

// Get post count for a category (unique posts including children)
categoriesRouter.get('/:id/count', async (req: Request, res: Response) => {
  try {
    const count = await neo4jService.getCategoryPostCount(req.params.id);
    res.json({ count });
  } catch (error) {
    console.error('Failed to get category post count:', error);
    res.status(500).json({ error: 'Failed to get category post count' });
  }
});

// Get category by ID with posts
categoriesRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const categories = await neo4jService.getCategories();
    const category = categories.find(c => c.id === req.params.id);

    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    // Get posts in this category
    const posts = await neo4jService.getPosts({ categoryId: req.params.id });

    res.json({
      ...category,
      posts,
    });
  } catch (error) {
    console.error('Failed to get category:', error);
    res.status(500).json({ error: 'Failed to get category' });
  }
});

