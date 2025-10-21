const chrono = require('chrono-node');
const nlp = require('compromise');
const Memory = require('./memory');
const ScheduleAPI = require('./schedule_api');
const KnowledgeAPI = require('./knowledge_api');
const IntentDetector = require('./intent_detector');

/**
 * Fast orchestrator with FastText intent detection
 * Handles schedule and knowledge queries with <500ms latency
 */
class Orchestrator {
  constructor(qdrantDao) {
    this.qdrantDao = qdrantDao;
    this.memory = new Memory(qdrantDao.redis);
    this.scheduleAPI = new ScheduleAPI(qdrantDao.redis);
    this.knowledgeAPI = new KnowledgeAPI(qdrantDao);
    this.intentDetector = new IntentDetector();
    
    console.log('[ORCHESTRATOR] Initialized with FastText intent detection');
  }

  /**
   * Initialize the orchestrator (train/load FastText model)
   */
  async initialize() {
    await this.intentDetector.load();
  }

  /**
   * FastText-based intent detection (~5ms)
   * @param {string} message - User message
   * @returns {Object} { schedule: boolean, knowledge: boolean }
   */
  async detectIntent(message) {
    return await this.intentDetector.predict(message);
  }

  /**
   * Extract datetime using chrono-node
   */
  extractTime(message) {
    const parsed = chrono.parseDate(message);
    console.log(`kdhfasjkhfksdlhhk [ORCHESTRATOR] Parsed time: ${parsed}`);
    return parsed ? parsed.toISOString() : null;
  }

  /**
   * Extract person name using compromise + regex fallback
   */
  extractName(message) {
    // Try compromise first
    const doc = nlp(message);
    const people = doc.people().out('array');
    if (people && people.length > 0) {
      console.log(`[ORCHESTRATOR] Name extracted via compromise: ${people[0]}`);
      return people[0];
    }
    
    // Fallback: look for common booking patterns
    // "book [Name]", "schedule [Name]", "for [Name]"
    const patterns = [
      /\b(?:book|schedule)\s+([A-Z][a-z]+)/i,
      /\b(?:for|patient)\s+([A-Z][a-z]+)/i,
      /\b([A-Z][a-z]+)\s+(?:tomorrow|today|next|at|for)/i
    ];
    
    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match && match[1]) {
        console.log(`[ORCHESTRATOR] Name extracted via regex: ${match[1]}`);
        return match[1];
      }
    }
    
    console.log('[ORCHESTRATOR] No name found in message');
    return null;
  }

  /**
   * Extract location from message
   */
  extractLocation(message) {
    const lower = message.toLowerCase();
    if (lower.includes('midtown')) return 'Midtown';
    if (lower.includes('uptown')) return 'Uptown';
    if (lower.includes('downtown')) return 'Downtown';
    if (lower.includes('brooklyn')) return 'Brooklyn';
    if (lower.includes('queens')) return 'Queens';
    if (lower.includes('bronx')) return 'Bronx';
    if (lower.includes('manhattan')) return 'Manhattan';
    return 'Midtown'; // Default
  }

  /**
   * Check if message is a reschedule intent
   */
  isReschedule(message) {
    const patterns = /make it|change to|move|reschedule|change the|move it/i;
    return patterns.test(message);
  }

  /**
   * Main orchestration method
   * @param {string} message - User message
   * @param {string} sessionId - Session identifier
   * @returns {Object} Response with reply, citations, plan_steps, latency_ms
   */
  async orchestrate(sessionId, message) {
    const startTime = process.hrtime.bigint();
    const planSteps = [];

    try {
      // Step 1: Intent detection (~5ms)
      const intentStart = process.hrtime.bigint();
      const intent = await this.detectIntent(message);
      const intentLatency = Number(process.hrtime.bigint() - intentStart) / 1000000;
      
      planSteps.push({
        step: 'intent_detection',
        detected: intent,
        latency_ms: Math.round(intentLatency)
      });

      console.log(`[ORCHESTRATOR] Intent:`, intent);

      // Get session context
      const ctx = await this.memory.getLastAppt(sessionId);
      
      // Handle dual intent (knowledge + schedule)
      if (intent.knowledge && intent.schedule) {
        return await this.handleDualIntent(sessionId, message, planSteps, startTime);
      }

      // Handle schedule intent
      if (intent.schedule) {
        const isReschedule = this.isReschedule(message) && ctx;
        
        if (isReschedule) {
          return await this.handleReschedule(sessionId, message, ctx, planSteps, startTime);
        } else {
          console.log('adkjhaskjd [ORCHESTRATOR] Handling schedule intent');
          return await this.handleSchedule(sessionId, message, planSteps, startTime);
        }
      }

      // Handle knowledge intent
      if (intent.knowledge) {
        return await this.handleKnowledge(sessionId, message, planSteps, startTime);
      }

      // Fallback
      const totalLatency = Number(process.hrtime.bigint() - startTime) / 1000000;
      return {
        reply: "I'm not sure what you mean. You can ask about our policies or schedule an appointment.",
        citations: [],
        plan_steps: planSteps,
        latency_ms: Math.round(totalLatency)
      };

    } catch (error) {
      console.error('[ORCHESTRATOR] Error:', error);
      const totalLatency = Number(process.hrtime.bigint() - startTime) / 1000000;
      return {
        reply: "Sorry, I encountered an error processing your request.",
        citations: [],
        plan_steps: planSteps,
        error: error.message,
        latency_ms: Math.round(totalLatency)
      };
    }
  }

  /**
   * Handle scheduling request
   */
  async handleSchedule(sessionId, message, planSteps, startTime) {
    // Extract entities
    const extractStart = process.hrtime.bigint();
    const chronoDate = this.extractTime(message);
    const name = this.extractName(message);
    const location = this.extractLocation(message);
    const extractLatency = Number(process.hrtime.bigint() - extractStart) / 1000000;

    planSteps.push({
      step: 'extract_entities',
      extracted: { name, time: chronoDate, location },
      latency_ms: Math.round(extractLatency)
    });

    if (!name || !chronoDate) {
      const totalLatency = Number(process.hrtime.bigint() - startTime) / 1000000;
      return {
        reply: "I need a patient name and time to schedule. For example: 'Book Chen for tomorrow at 10:30'",
        citations: [],
        plan_steps: planSteps,
        latency_ms: Math.round(totalLatency)
      };
    }

    // Call schedule API
    const scheduleStart = process.hrtime.bigint();
    const result = await this.scheduleAPI.scheduleAppointment({
      name,
      slot: chronoDate,
      location
    });
    const scheduleLatency = Number(process.hrtime.bigint() - scheduleStart) / 1000000;

    planSteps.push({
      step: 'schedule_appointment',
      result: result.ok ? 'success' : 'failed',
      latency_ms: Math.round(scheduleLatency)
    });

    if (result.ok) {
      // Save to memory
      await this.memory.setLastAppt(sessionId, {
        patient: name,
        slot: chronoDate,
        location,
        appt_id: result.appt_id
      });

      // Format reply
      const dateStr = new Date(result.normalized_slot_iso).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });

      const totalLatency = Number(process.hrtime.bigint() - startTime) / 1000000;

      return {
        reply: `Booked ${name} for ${dateStr} at ${location} (${result.appt_id}).`,
        citations: [],
        plan_steps: planSteps,
        tool_calls: [{
          name: 'schedule_appointment',
          args: { name, slot: chronoDate, location },
          result
        }],
        latency_ms: Math.round(totalLatency)
      };
    } else {
      const totalLatency = Number(process.hrtime.bigint() - startTime) / 1000000;
      return {
        reply: `Failed to schedule appointment: ${result.error}`,
        citations: [],
        plan_steps: planSteps,
        latency_ms: Math.round(totalLatency)
      };
    }
  }

  /**
   * Handle reschedule request
   */
  async handleReschedule(sessionId, message, ctx, planSteps, startTime) {
    const extractStart = process.hrtime.bigint();
    const chronoDate = this.extractTime(message);
    const extractLatency = Number(process.hrtime.bigint() - extractStart) / 1000000;

    planSteps.push({
      step: 'extract_time',
      extracted: { new_time: chronoDate },
      latency_ms: Math.round(extractLatency)
    });

    if (!chronoDate) {
      const totalLatency = Number(process.hrtime.bigint() - startTime) / 1000000;
      return {
        reply: "I need a new time to reschedule. For example: 'Make it 11:00' or 'Change to 2pm'",
        citations: [],
        plan_steps: planSteps,
        latency_ms: Math.round(totalLatency)
      };
    }

    // Reschedule using context
    const rescheduleStart = process.hrtime.bigint();
    const result = await this.scheduleAPI.rescheduleAppointment(ctx.appt_id, chronoDate);
    const rescheduleLatency = Number(process.hrtime.bigint() - rescheduleStart) / 1000000;

    planSteps.push({
      step: 'reschedule_appointment',
      result: result.ok ? 'success' : 'failed',
      latency_ms: Math.round(rescheduleLatency)
    });

    if (result.ok) {
      // Update memory
      await this.memory.setLastAppt(sessionId, {
        patient: result.patient,
        slot: chronoDate,
        location: result.location,
        appt_id: result.appt_id
      });

      // Format reply
      const dateStr = new Date(result.normalized_slot_iso).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });

      const totalLatency = Number(process.hrtime.bigint() - startTime) / 1000000;

      return {
        reply: `Rebooked ${result.patient} for ${dateStr} at ${result.location} (${result.appt_id}).`,
        citations: [],
        plan_steps: planSteps,
        tool_calls: [{
          name: 'reschedule_appointment',
          args: { appt_id: ctx.appt_id, new_slot_iso: chronoDate },
          result
        }],
        latency_ms: Math.round(totalLatency)
      };
    } else {
      const totalLatency = Number(process.hrtime.bigint() - startTime) / 1000000;
      return {
        reply: `Failed to reschedule: ${result.error}`,
        citations: [],
        plan_steps: planSteps,
        latency_ms: Math.round(totalLatency)
      };
    }
  }

  /**
   * Handle knowledge query
   */
  async handleKnowledge(sessionId, message, planSteps, startTime) {
    // Retrieve from knowledge base
    const retrieveStart = process.hrtime.bigint();
    const answer = await this.knowledgeAPI.getKnowledgeAnswer(message);
    const retrieveLatency = Number(process.hrtime.bigint() - retrieveStart) / 1000000;

    planSteps.push({
      step: 'retrieve_knowledge',
      docs_found: answer.citations.length,
      latency_ms: Math.round(retrieveLatency)
    });

    const totalLatency = Number(process.hrtime.bigint() - startTime) / 1000000;

    return {
      reply: answer.reply,
      citations: answer.citations,
      plan_steps: planSteps,
      latency_ms: Math.round(totalLatency)
    };
  }

  /**
   * Handle dual intent (knowledge + schedule)
   */
  async handleDualIntent(sessionId, message, planSteps, startTime) {
    console.log('[ORCHESTRATOR] Handling dual intent');

    // Execute both in parallel
    const [knowledgeResult, scheduleResult] = await Promise.all([
      (async () => {
        const retrieveStart = process.hrtime.bigint();
        const answer = await this.knowledgeAPI.getKnowledgeAnswer(message);
        const retrieveLatency = Number(process.hrtime.bigint() - retrieveStart) / 1000000;

        planSteps.push({
          step: 'retrieve_knowledge',
          docs_found: answer.citations.length,
          latency_ms: Math.round(retrieveLatency)
        });

        return answer;
      })(),

      (async () => {
        const extractStart = process.hrtime.bigint();
        const chronoDate = this.extractTime(message);
        const name = this.extractName(message);
        const location = this.extractLocation(message);
        const extractLatency = Number(process.hrtime.bigint() - extractStart) / 1000000;

        planSteps.push({
          step: 'extract_entities',
          extracted: { name, time: chronoDate, location },
          latency_ms: Math.round(extractLatency)
        });

        // Log extraction results for debugging
        console.log(`[ORCHESTRATOR] Dual intent extraction: name=${name}, time=${chronoDate}, location=${location}`);

        if (!name || !chronoDate) {
          console.log(`[ORCHESTRATOR] Skipping schedule (missing ${!name ? 'name' : 'time'})`);
          return null;
        }

        const scheduleStart = process.hrtime.bigint();
        const result = await this.scheduleAPI.scheduleAppointment({
          name,
          slot: chronoDate,
          location
        });
        const scheduleLatency = Number(process.hrtime.bigint() - scheduleStart) / 1000000;

        console.log(`[ORCHESTRATOR] Schedule result: ${result.ok ? 'success' : 'failed'} - ${result.appt_id || result.error}`);

        planSteps.push({
          step: 'schedule_appointment',
          result: result.ok ? 'success' : 'failed',
          latency_ms: Math.round(scheduleLatency)
        });

        if (result.ok) {
          await this.memory.setLastAppt(sessionId, {
            patient: name,
            slot: chronoDate,
            location,
            appt_id: result.appt_id
          });
        }

        return { result, name, chronoDate, location };
      })()
    ]);

    // Compose reply
    let replyParts = [];
    const citations = knowledgeResult.citations || [];
    const toolCalls = [];

    if (knowledgeResult.reply) {
      replyParts.push(knowledgeResult.reply);
    }

    if (scheduleResult && scheduleResult.result && scheduleResult.result.ok) {
      const dateStr = new Date(scheduleResult.result.normalized_slot_iso).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
      replyParts.push(`Booked ${scheduleResult.name} for ${dateStr} at ${scheduleResult.location} (${scheduleResult.result.appt_id}).`);
      
      toolCalls.push({
        name: 'schedule_appointment',
        args: {
          name: scheduleResult.name,
          slot: scheduleResult.chronoDate,
          location: scheduleResult.location
        },
        result: scheduleResult.result
      });
    }

    const totalLatency = Number(process.hrtime.bigint() - startTime) / 1000000;

    return {
      reply: replyParts.join(' '),
      citations,
      plan_steps: planSteps,
      tool_calls: toolCalls,
      latency_ms: Math.round(totalLatency)
    };
  }

  /**
   * Warm up the index with common queries
   */
  async warmIndex(commonQueries = []) {
    await this.knowledgeAPI.warmCache(commonQueries);
  }
}

module.exports = Orchestrator;

