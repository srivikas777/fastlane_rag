/**
 * Fast in-memory session management using Redis
 */
class Memory {
  constructor(redis) {
    this.redis = redis;
    this.ttl = 1800; // 30 min TTL
    console.log('[MEMORY] Initialized session memory with Redis (30 min TTL)');
  }

  /**
   * Get last appointment context for a session
   */
  async getLastAppt(sessionId) {
    const key = `memory:${sessionId}`;
    const data = await this.redis.get(key);
    if (!data) return null;
    
    const session = JSON.parse(data);
    return session.last_appt || null;
  }

  /**
   * Set last appointment context
   */
  async setLastAppt(sessionId, apptData) {
    const key = `memory:${sessionId}`;
    const existing = await this.redis.get(key);
    const session = existing ? JSON.parse(existing) : {};
    
    session.last_appt = {
      ...apptData,
      timestamp: new Date().toISOString()
    };
    
    await this.redis.setex(key, this.ttl, JSON.stringify(session));
    console.log(`[MEMORY] Saved appointment context for session ${sessionId}`);
  }

  /**
   * Update session with any data
   */
  async updateSession(sessionId, data) {
    const key = `memory:${sessionId}`;
    const existing = await this.redis.get(key);
    const session = existing ? JSON.parse(existing) : {};
    
    Object.assign(session, data);
    await this.redis.setex(key, this.ttl, JSON.stringify(session));
  }

  /**
   * Get full session data
   */
  async getSession(sessionId) {
    const key = `memory:${sessionId}`;
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : {};
  }

  /**
   * Clear a specific session
   */
  async clearSession(sessionId) {
    const key = `memory:${sessionId}`;
    await this.redis.del(key);
    console.log(`[MEMORY] Cleared session ${sessionId}`);
  }

  /**
   * Get all sessions (for debugging)
   */
  async getAllSessions() {
    const keys = await this.redis.keys('memory:*');
    const sessions = {};
    
    for (const key of keys) {
      const data = await this.redis.get(key);
      if (data) {
        sessions[key] = JSON.parse(data);
      }
    }
    
    return sessions;
  }

  /**
   * Get session count
   */
  async getSessionCount() {
    const keys = await this.redis.keys('memory:*');
    return keys.length;
  }

  /**
   * Clear all sessions
   */
  async clearAll() {
    const keys = await this.redis.keys('memory:*');
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
    console.log('[MEMORY] Cleared all sessions');
  }
}

module.exports = Memory;

