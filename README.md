# ⚡️ FastLane RAG Orchestrator

Ultra-fast RAG orchestrator with text-based intent detection achieving **<500ms end-to-end latency**.

## 🚀 Quick Start

### Prerequisites
- Node.js (v14+)
- Redis server
- Qdrant vector database

### Installation & Setup

```bash
# Install dependencies
npm install

# Start Redis (if not running)
redis-server

# Start Qdrant (if not running)
# Download from: https://qdrant.tech/documentation/quick-start/

# Set environment variables
cp .env.example .env
# Edit .env with your Qdrant, Redis, and OpenAI credentials

# Start the server
npm start
```

### Environment Variables (.env)
```bash
QDRANT_URL=http://localhost:6333
REDIS_URL=redis://localhost:6379
OPENAI_API_KEY=your_openai_key
PORT=3002
```

## 📡 Usage

### Chat Endpoint
```bash
curl -X POST http://localhost:3002/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What is the late policy?",
    "session_id": "user-123"
  }'
```

### Schedule Appointment
```bash
curl -X POST http://localhost:3002/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Book Chen for tomorrow at 10:30 AM",
    "session_id": "user-123"
  }'
```

### Reschedule (using context)
```bash
curl -X POST http://localhost:3002/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Make it 11:00 instead",
    "session_id": "user-123"
  }'
```

## 🎯 What It Does

- **Knowledge Queries**: "What is the late policy?" → Returns policy with citations
- **Appointment Booking**: "Book Dr. Chen for tomorrow at 10:30" → Creates appointment
- **Rescheduling**: "Make it 11:00 instead" → Updates existing appointment (uses context)
- **Dual Intent**: "What's the parking policy and book Rivera for 2pm?" → Handles both simultaneously

## 🔧 Development

```bash
# Run with auto-reload
npm run dev

# Run tests
npm test
```
