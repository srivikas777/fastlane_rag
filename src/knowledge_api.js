/**
 * Knowledge retrieval API with Redis caching
 * Handles RAG queries with warm cache for <200ms latency
 */
class KnowledgeAPI {
  constructor(qdrantDao) {
    this.qdrantDao = qdrantDao;
    this.redis = qdrantDao.redis;
    this.cacheTTL = 600; // 10 min TTL
    
    console.log('[KNOWLEDGE_API] Initialized with Redis cache');
  }

  /**
   * Get answer for a knowledge query
   * @param {string} message - User query
   * @returns {Object} { reply, citations }
   */
  async getKnowledgeAnswer(message) {
    try {
      // Check cache first
      const cacheKey = `knowledge:${Buffer.from(message).toString('base64').slice(0, 100)}`;
      const cached = await this.redis.get(cacheKey);
      
      if (cached) {
        console.log('[KNOWLEDGE_API] Cache hit for query');
        return JSON.parse(cached);
      }

      // Search Qdrant
      const startTime = process.hrtime.bigint();
      const docs = await this.qdrantDao.searchDocuments(message, 3);
      const latency = Number(process.hrtime.bigint() - startTime) / 1000000;

      console.log(`[KNOWLEDGE_API] Retrieved ${docs.length} docs in ${Math.round(latency)}ms`);

      if (docs.length === 0) {
        return {
          reply: "I don't have information about that in my knowledge base.",
          citations: []
        };
      }

      // Build citations
      const citations = docs.map((doc, idx) => ({
        id: doc.payload.doc_id,
        chunk: doc.payload.chunk_index,
        score: Math.round(doc.score * 100) / 100,
        ref: idx + 1
      }));

      // Get best answer from top result
      const topDoc = docs[0];
      const reply = topDoc.payload.text;

      const result = { reply, citations };

      // Cache result
      await this.redis.setex(cacheKey, this.cacheTTL, JSON.stringify(result));

      return result;
    } catch (error) {
      console.error('[KNOWLEDGE_API] Error getting knowledge answer:', error);
      return {
        reply: "Sorry, I encountered an error retrieving that information.",
        citations: []
      };
    }
  }

  /**
   * Warm up the cache with common queries
   */
  async warmCache(commonQueries = []) {
    console.log(`[KNOWLEDGE_API] Warming cache with ${commonQueries.length} queries...`);
    
    for (const query of commonQueries) {
      try {
        await this.getKnowledgeAnswer(query);
      } catch (error) {
        console.error(`[KNOWLEDGE_API] Error warming query "${query}":`, error.message);
      }
    }
    
    console.log('[KNOWLEDGE_API] Cache warmed');
  }

  /**
   * Clear cache
   */
  async clearCache() {
    const keys = await this.redis.keys('knowledge:*');
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
    console.log('[KNOWLEDGE_API] Cache cleared');
  }

  /**
   * Get cache stats
   */
  async getCacheStats() {
    const keys = await this.redis.keys('knowledge:*');
    return {
      cached_queries: keys.length
    };
  }
}

module.exports = KnowledgeAPI;

