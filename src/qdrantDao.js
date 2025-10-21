const { QdrantClient } = require('@qdrant/js-client-rest');
const Redis = require('ioredis');
const OpenAI = require('openai');
const { v4: uuidv4 } = require('uuid');
const natural = require('natural');
const TfIdf = natural.TfIdf;
require('dotenv').config();

class QdrantDao {
  constructor() {
    // Initialize Qdrant client
    this.qdrant = new QdrantClient({
      url: process.env.QDRANT_URL,
      apiKey: process.env.QDRANT_API_KEY,
    });

    // Initialize Redis client
    this.redis = new Redis(process.env.REDIS_URL, {
      retryDelayOnFailover: 100,
      enableReadyCheck: false,
      maxRetriesPerRequest: 3,
    });

    // Initialize OpenAI client
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    this.collectionName = 'fastlane_knowledge';
    this.embeddingModel = 'text-embedding-3-small';
    this.embeddingDimensions = 512; // Reduced for faster processing
    
    // BM25 index for hybrid search
    this.tfidf = new TfIdf();
    this.documentMap = new Map(); // Map point_id -> document
    
    // Deterministic random seed
    Math.seedrandom = require('seedrandom');
    this.rng = Math.seedrandom('fastlane-rag-42');
  }

  // High-resolution timer for latency tracking
  startTimer() {
    return process.hrtime.bigint();
  }

  endTimer(startTime) {
    return Number(process.hrtime.bigint() - startTime) / 1000000; // Convert to milliseconds
  }

  // Generate embeddings using OpenAI with caching
  async generateEmbedding(text) {
    try {
      // Check cache first
      const cached = await this.getCachedEmbedding(text);
      if (cached) {
        return cached;
      }

      // Generate new embedding with reduced dimensions for speed
      const response = await this.openai.embeddings.create({
        model: this.embeddingModel,
        input: text,
        dimensions: 512, // Reduced from 1536 for faster processing
      });
      
      const embedding = response.data[0].embedding;
      
      // Cache the embedding asynchronously (don't wait)
      this.setCachedEmbedding(text, embedding).catch(() => {});
      
      return embedding;
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw error;
    }
  }

  // Chunk text into 512 token chunks
  chunkText(text, maxTokens = 512) {
    const words = text.split(' ');
    const chunks = [];
    let currentChunk = [];
    let currentTokens = 0;

    for (const word of words) {
      const wordTokens = Math.ceil(word.length / 4); // Rough token estimation
      if (currentTokens + wordTokens > maxTokens && currentChunk.length > 0) {
        chunks.push(currentChunk.join(' '));
        currentChunk = [word];
        currentTokens = wordTokens;
      } else {
        currentChunk.push(word);
        currentTokens += wordTokens;
      }
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join(' '));
    }

    return chunks;
  }

  // Create collection if it doesn't exist
  async ensureCollection() {
    try {
      const collections = await this.qdrant.getCollections();
      const exists = collections.collections.some(col => col.name === this.collectionName);
      
      if (!exists) {
        await this.qdrant.createCollection(this.collectionName, {
          vectors: {
            size: this.embeddingDimensions,
            distance: 'Cosine'
          }
        });
        console.log(`Created collection: ${this.collectionName}`);
      }
    } catch (error) {
      console.error('Error ensuring collection:', error);
      throw error;
    }
  }

  // Upsert documents to Qdrant with BM25 indexing
  async upsertDocuments(documents) {
    try {
      await this.ensureCollection();
      
      const points = [];
      let chunkCount = 0;

      // Clear existing BM25 index
      this.tfidf = new TfIdf();
      this.documentMap.clear();

      for (const doc of documents) {
        const chunks = this.chunkText(doc.text);
        
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const embedding = await this.generateEmbedding(chunk);
          const pointId = uuidv4();
          
          points.push({
            id: pointId,
            vector: embedding,
            payload: {
              text: chunk,
              doc_id: doc.id,
              chunk_index: i,
              tags: doc.tags || [],
              // original_text: doc.text
            }
          });
          
          // Index for BM25
          this.tfidf.addDocument(chunk);
          this.documentMap.set(chunkCount, {
            id: pointId,
            text: chunk,
            doc_id: doc.id,
            chunk_index: i
          });
          
          chunkCount++;
        }
      }

      await this.qdrant.upsert(this.collectionName, {
        wait: true,
        points: points
      });

      return chunkCount;
    } catch (error) {
      console.error('Error upserting documents:', error);
      throw error;
    }
  }

  // Cache operations for query results
  async getCachedResults(query) {
    try {
      const cacheKey = `query:${Buffer.from(query).toString('base64')}`;
      const cached = await this.redis.get(cacheKey);
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      console.error('Error getting cached results:', error);
      return null;
    }
  }

  async setCachedResults(query, results) {
    try {
      const cacheKey = `query:${Buffer.from(query).toString('base64')}`;
      await this.redis.setex(cacheKey, 30, JSON.stringify(results)); // 30s LRU as per spec
    } catch (error) {
      console.error('Error setting cached results:', error);
    }
  }

  // Cache embeddings for faster retrieval
  async getCachedEmbedding(text) {
    try {
      const cacheKey = `emb:${Buffer.from(text).toString('base64').slice(0, 100)}`;
      const cached = await this.redis.get(cacheKey);
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      console.error('Error getting cached embedding:', error);
      return null;
    }
  }

  async setCachedEmbedding(text, embedding) {
    try {
      const cacheKey = `emb:${Buffer.from(text).toString('base64').slice(0, 100)}`;
      await this.redis.setex(cacheKey, 3600, JSON.stringify(embedding)); // 1 hour TTL
    } catch (error) {
      console.error('Error setting cached embedding:', error);
    }
  }

  // Session management
  async getSession(sessionId) {
    try {
      const sessionKey = `session:${sessionId}`;
      const session = await this.redis.get(sessionKey);
      return session ? JSON.parse(session) : { messages: [] };
    } catch (error) {
      console.error('Error getting session:', error);
      return { messages: [] };
    }
  }

  async setSession(sessionId, session) {
    try {
      const sessionKey = `session:${sessionId}`;
      await this.redis.setex(sessionKey, 3600, JSON.stringify(session)); // 1 hour TTL
    } catch (error) {
      console.error('Error setting session:', error);
    }
  }

  // Hybrid search: BM25 + Vector (optimized with caching)
  async searchDocuments(query, limit = 3) {
    try {
      // Check cache first
      const cached = await this.getCachedResults(query);
      if (cached) {
        return cached;
      }

      // Parallel: BM25 lexical search + Vector ANN search
      const [bm25Results, vectorResults] = await Promise.all([
        this.bm25Search(query, 8),
        this.vectorSearch(query, 8)
      ]);

      // Merge results using Reciprocal Rank Fusion (RRF)
      const merged = this.mergeResults(bm25Results, vectorResults);
      
      // Take top 8 for MMR
      const top8 = merged.slice(0, 8);
      
      // Apply MMR for diversity (Top-8 → MMR → Top-3)
      const top3 = this.applyMMR(top8, limit);

      // Cache results asynchronously
      this.setCachedResults(query, top3).catch(() => {});

      return top3;
    } catch (error) {
      console.error('Error searching documents:', error);
      throw error;
    }
  }

  // BM25 lexical search
  async bm25Search(query, limit) {
    try {
      if (this.tfidf.documents.length === 0) {
        return [];
      }

      const results = [];
      this.tfidf.tfidfs(query, (i, measure) => {
        if (measure > 0 && this.documentMap.has(i)) {
          const doc = this.documentMap.get(i);
          results.push({
            id: doc.id,
            score: measure,
            payload: {
              text: doc.text,
              doc_id: doc.doc_id,
              chunk_index: doc.chunk_index
            }
          });
        }
      });

      // Sort by score and limit
      return results.sort((a, b) => b.score - a.score).slice(0, limit);
    } catch (error) {
      console.error('Error in BM25 search:', error);
      return [];
    }
  }

  // Vector ANN search
  async vectorSearch(query, limit) {
    try {
      const queryEmbedding = await this.generateEmbedding(query);
      
      const searchResults = await this.qdrant.search(this.collectionName, {
        vector: queryEmbedding,
        limit,
        with_payload: true,
        with_vector: false,
        score_threshold: 0.2
      });

      return searchResults;
    } catch (error) {
      console.error('Error in vector search:', error);
      return [];
    }
  }

  // Merge BM25 and Vector results using Reciprocal Rank Fusion
  mergeResults(bm25Results, vectorResults) {
    const k = 60; // RRF parameter
    const scoreMap = new Map();

    // Add BM25 scores
    bm25Results.forEach((result, rank) => {
      const key = result.id;
      const rrfScore = 1 / (k + rank + 1);
      scoreMap.set(key, {
        score: rrfScore,
        result
      });
    });

    // Add Vector scores
    vectorResults.forEach((result, rank) => {
      const key = result.id;
      const rrfScore = 1 / (k + rank + 1);
      if (scoreMap.has(key)) {
        scoreMap.get(key).score += rrfScore;
      } else {
        scoreMap.set(key, {
          score: rrfScore,
          result
        });
      }
    });

    // Sort by combined score
    const merged = Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .map(item => ({
        ...item.result,
        score: item.score
      }));

    return merged;
  }

  // Maximal Marginal Relevance algorithm (text-based for speed)
  applyMMR(results, finalLimit, lambda = 0.5) {
    if (results.length <= finalLimit) {
      return results;
    }

    const selected = [];
    const remaining = [...results];
    
    // Select first result (highest relevance score)
    selected.push(remaining.shift());

    while (selected.length < finalLimit && remaining.length > 0) {
      let bestIndex = 0;
      let bestScore = -Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        
        // Calculate max similarity to already selected items (text-based)
        let maxSimilarity = 0;
        for (const selectedItem of selected) {
          const similarity = this.textSimilarity(
            candidate.payload.text,
            selectedItem.payload.text
          );
          maxSimilarity = Math.max(maxSimilarity, similarity);
        }

        // MMR score: λ * relevance - (1-λ) * max_similarity
        const mmrScore = lambda * candidate.score - (1 - lambda) * maxSimilarity;
        
        if (mmrScore > bestScore) {
          bestScore = mmrScore;
          bestIndex = i;
        }
      }

      selected.push(remaining.splice(bestIndex, 1)[0]);
    }

    return selected;
  }

  // Fast text similarity (Jaccard similarity on word sets)
  textSimilarity(text1, text2) {
    const words1 = new Set(text1.toLowerCase().split(/\s+/));
    const words2 = new Set(text2.toLowerCase().split(/\s+/));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }

  // Cosine similarity helper
  cosineSimilarity(vecA, vecB) {
    if (vecA.length !== vecB.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // Warm up the index on startup with common queries
  async warmIndex(commonQueries = []) {
    try {
      await this.ensureCollection();
      
      if (commonQueries.length === 0) {
        console.log('Index warmed up (collection ready)');
        return;
      }
      
      console.log(`Warming index with ${commonQueries.length} common queries...`);
      
      // Pre-compute embeddings for common queries
      let warmedCount = 0;
      for (const query of commonQueries) {
        try {
          // This will cache the embedding in Redis
          await this.generateEmbedding(query);
          warmedCount++;
        } catch (error) {
          console.error(`Error warming query "${query}":`, error.message);
        }
      }
      
      console.log(`Index warmed up: ${warmedCount}/${commonQueries.length} queries pre-cached`);
    } catch (error) {
      console.error('Error warming up index:', error);
    }
  }

  // Reset collection - delete all documents
  async resetCollection() {
    try {
      // Delete the entire collection
      await this.qdrant.deleteCollection(this.collectionName);
      console.log(`Collection ${this.collectionName} deleted successfully`);
      
      // Recreate the collection
      await this.ensureCollection();
      console.log(`Collection ${this.collectionName} recreated successfully`);
      
      return {
        ok: true,
        message: `Collection ${this.collectionName} reset successfully`,
        collection_name: this.collectionName
      };
    } catch (error) {
      console.error('Error resetting collection:', error);
      throw error;
    }
  }
}

module.exports = QdrantDao;
