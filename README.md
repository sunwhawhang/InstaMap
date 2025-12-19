# InstaMap

A Chrome extension that collects your Instagram saved posts and uses AI to categorize and organize them with a knowledge graph.

## Features

- **Collect Saved Posts**: Automatically scrapes your Instagram saved posts
- **AI Categorization**: Uses Claude to intelligently categorize posts
- **Semantic Search**: Find posts by meaning using OpenAI embeddings
- **Knowledge Graph**: Neo4j-powered graph for relationships between posts, categories, and entities
- **Chat Interface**: Natural language queries ("Show me food posts from Japan")

## Tech Stack

| Layer | Technology |
|-------|------------|
| Extension | TypeScript + Vite + React |
| Backend | TypeScript + Node.js + Express |
| Database | Neo4j (graph + native vector search) |
| Embeddings | OpenAI text-embedding-3-small |
| LLM | Claude API |

## Project Structure

```
InstaMap/
├── extension/          # Chrome extension (Manifest V3)
│   ├── src/
│   │   ├── content/    # Content script for Instagram scraping
│   │   ├── popup/      # Extension popup UI
│   │   ├── dashboard/  # Full-page dashboard
│   │   ├── background/ # Service worker
│   │   └── shared/     # Shared types and utilities
│   └── public/         # Static assets
│
├── backend/            # Node.js API server
│   └── src/
│       ├── routes/     # API endpoints
│       └── services/   # Neo4j, OpenAI, Claude integrations
│
└── package.json        # Monorepo root
```

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+
- Docker (for Neo4j) or Neo4j Aura account

### Installation

```bash
# Install dependencies
npm install

# Start Neo4j (Docker)
docker run -d --name neo4j \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/password123 \
  neo4j:latest

# Start backend
npm run dev:backend

# Build extension (in another terminal)
npm run dev:extension
```

### Load Extension in Chrome

1. Go to `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select `extension/dist` folder
5. The InstaMap icon appears in your toolbar

## API Keys Required

Create a `.env` file in the `backend/` directory:

```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=password123
```

## Usage

1. Navigate to your Instagram saved posts page
2. Click the InstaMap extension icon
3. Click "Sync Posts" to collect your saved posts
4. Open the Dashboard to browse, search, and chat with your posts

## Development

```bash
# Run extension in watch mode
npm run dev:extension

# Run backend in watch mode
npm run dev:backend
```

## License

MIT
