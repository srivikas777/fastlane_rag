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

      // Find the most similar sentence from the top result
      const topDoc = docs[0];
      const bestSentence = await this.findBestSentence(message, topDoc.payload.text);

      const result = { reply: bestSentence, citations };

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
   * Find the most similar sentence to the user query using semantic and BM25 scoring
   * @param {string} query - User query
   * @param {string} text - Text chunk to search within
   * @returns {string} Most similar sentence
   */
  async findBestSentence(query, text) {
    try {
      const startTime = process.hrtime.bigint();
      
      // Split text into sentences
      const sentences = this.splitIntoSentences(text);
      
      if (sentences.length === 0) {
        return text;
      }
      
      if (sentences.length === 1) {
        return sentences[0];
      }

      // Filter out very long sentences (likely not single sentences)
      const validSentences = sentences.filter(s => s.length <= 500);
      
      if (validSentences.length === 0) {
        return sentences[0];
      }

      // Generate embeddings in parallel for ALL sentences at once
      const embeddingStartTime = process.hrtime.bigint();
      const [queryEmbedding, ...sentenceEmbeddings] = await Promise.all([
        this.qdrantDao.generateEmbedding(query),
        ...validSentences.map(sentence => this.qdrantDao.generateEmbedding(sentence))
      ]);
      const embeddingTime = Number(process.hrtime.bigint() - embeddingStartTime) / 1000000;
      
      console.log(`[KNOWLEDGE_API] Generated ${validSentences.length + 1} embeddings in ${Math.round(embeddingTime)}ms`);
      
      let bestSentence = validSentences[0];
      let bestScore = -1;

      // Score all sentences
      for (let i = 0; i < validSentences.length; i++) {
        const sentence = validSentences[i];
        const sentenceEmbedding = sentenceEmbeddings[i];
        
        // Semantic similarity score
        const semanticScore = this.cosineSimilarity(queryEmbedding, sentenceEmbedding);
        
        // BM25 score for the sentence
        const bm25Score = this.calculateBM25Score(query, sentence);
        
        // Combined score (weighted average: 70% semantic, 30% BM25)
        const combinedScore = (0.7 * semanticScore) + (0.3 * bm25Score);
        
        if (combinedScore > bestScore) {
          bestScore = combinedScore;
          bestSentence = sentence;
        }
      }

      const totalTime = Number(process.hrtime.bigint() - startTime) / 1000000;
      console.log(`[KNOWLEDGE_API] Sentence selection completed in ${Math.round(totalTime)}ms (score: ${bestScore.toFixed(3)})`);
      
      return bestSentence.trim();
    } catch (error) {
      console.error('[KNOWLEDGE_API] Error finding best sentence:', error);
      return text; // Fallback to original text
    }
  }

  /**
   * Split text into sentences
   * @param {string} text - Text to split
   * @returns {Array<string>} Array of sentences
   */
  splitIntoSentences(text) {
    // Remove headers and section markers (=== HEADER ===)
    const cleanedText = text.replace(/===\s*[^=]+\s*===/g, '');
    
    // Split by newlines first to handle different sections
    const lines = cleanedText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    let sentences = [];
    
    for (const line of lines) {
      // Split each line by sentence-ending punctuation
      const lineSentences = line
        .split(/(?<=[.!?])\s+(?=[A-Z])/) // Split after sentence endings followed by capital letters
        .map(s => s.trim())
        .filter(s => s.length > 10); // Filter out very short fragments
      
      // Further split by periods if needed
      const splitSentences = [];
      for (const sent of lineSentences) {
        if (sent.length > 200 || !sent.match(/[.!?]$/)) {
          // Split by periods more aggressively
          const subSents = sent
            .split(/\.\s+/)
            .map(s => s.trim())
            .filter(s => s.length > 10)
            .map(s => s.endsWith('.') || s.endsWith('!') || s.endsWith('?') ? s : s + '.');
          splitSentences.push(...subSents);
        } else {
          splitSentences.push(sent);
        }
      }
      
      sentences.push(...splitSentences);
    }
    
    // Filter out duplicates and clean up
    const uniqueSentences = [...new Set(sentences)];
    
    console.log(`[KNOWLEDGE_API] Split into ${uniqueSentences.length} sentences`);
    
    return uniqueSentences;
  }

  /**
   * Calculate BM25 score for a sentence
   * @param {string} query - Query text
   * @param {string} sentence - Sentence text
   * @returns {number} BM25 score
   */
  calculateBM25Score(query, sentence) {
    const queryTerms = query.toLowerCase().split(/\s+/);
    const sentenceTerms = sentence.toLowerCase().split(/\s+/);
    
    let score = 0;
    const k1 = 1.2;
    const b = 0.75;
    const avgLength = 20; // Average sentence length
    
    for (const term of queryTerms) {
      const termFreq = sentenceTerms.filter(t => t === term).length;
      if (termFreq > 0) {
        const idf = Math.log(1); // Simplified IDF (could be improved with document frequency)
        const tf = (termFreq * (k1 + 1)) / (termFreq + k1 * (1 - b + b * (sentenceTerms.length / avgLength)));
        score += idf * tf;
      }
    }
    
    return score;
  }

  /**
   * Calculate cosine similarity between two vectors
   * @param {Array<number>} vecA - First vector
   * @param {Array<number>} vecB - Second vector
   * @returns {number} Cosine similarity score
   */
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

  /**
   * Warm up the cache with common queries
   */
  async warmCache(commonQueries = [
    "what's our late policy",
    "where do patients park",
    "what are the office hours"
  ]) {
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

