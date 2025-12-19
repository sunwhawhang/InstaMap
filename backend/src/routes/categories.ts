import { Router, Request, Response } from 'express';
import { neo4jService } from '../services/neo4j.js';

export const categoriesRouter = Router();

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
