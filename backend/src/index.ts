import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { postsRouter } from './routes/posts.js';
import { categoriesRouter } from './routes/categories.js';
import { chatRouter } from './routes/chat.js';
import { searchRouter } from './routes/search.js';
import { neo4jService } from './services/neo4j.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/health', async (req, res) => {
  try {
    const neo4jConnected = await neo4jService.healthCheck();
    res.json({
      status: 'ok',
      neo4j: neo4jConnected ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Routes
app.use('/api/posts', postsRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/chat', chatRouter);
app.use('/api/search', searchRouter);

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ error: err.message });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 InstaMap backend running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await neo4jService.close();
  process.exit(0);
});
