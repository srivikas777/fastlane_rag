const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const swaggerUi = require('swagger-ui-express');
const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');
const QdrantDao = require('./src/qdrantDao');
const Orchestrator = require('./src/orchestrator');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3002;

// Load Swagger YAML file
const swaggerPath = path.join(__dirname, 'swagger.yaml');
const swaggerContent = fs.readFileSync(swaggerPath, 'utf8');
const swaggerSpecs = yaml.load(swaggerContent);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  const startTime = process.hrtime.bigint();
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  
  res.on('finish', () => {
    const endTime = process.hrtime.bigint();
    const duration = Number(endTime - startTime) / 1000000;
    console.log(`Response: ${res.statusCode} (${Math.round(duration)}ms)`);
  });
  
  next();
});

// Initialize services
let qdrantDao;
let orchestrator;

// Swagger Documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpecs, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'FastLane RAG API v2.0'
}));

/**
 * POST /chat - Main chat endpoint
 */
app.post('/chat', async (req, res) => {
  try {
    const { message, session_id } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const sessionId = session_id || uuidv4();
    
    // Orchestrate the response
    const result = await orchestrator.orchestrate(sessionId, message);
    
    res.json({
      ...result,
      session_id: sessionId
    });
  } catch (error) {
    console.error('[CHAT] Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

/**
 * POST /knowledge - Upsert knowledge base
 */
app.post('/knowledge', async (req, res) => {
  try {
    const { documents } = req.body;
    
    if (!documents || !Array.isArray(documents)) {
      return res.status(400).json({ error: 'Documents array is required' });
    }

    const chunkCount = await qdrantDao.upsertDocuments(documents);
    
    res.json({
      ok: true,
      message: `Upserted ${documents.length} documents (${chunkCount} chunks)`,
      document_count: documents.length,
      chunk_count: chunkCount
    });
  } catch (error) {
    console.error('[KNOWLEDGE] Error:', error);
    res.status(500).json({
      error: 'Failed to upsert documents',
      details: error.message
    });
  }
});

/**
 * GET /health - Health check
 */
app.get('/health', async (req, res) => {
  try {
    // Check Redis
    await qdrantDao.redis.ping();
    
    // Check Qdrant
    const collections = await qdrantDao.qdrant.getCollections();
    
    res.json({
      status: 'healthy',
      services: {
        redis: 'connected',
        qdrant: 'connected',
        collections: collections.collections.length
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

/**
 * GET /stats - System statistics
 */
app.get('/stats', async (req, res) => {
  try {
    // Get Qdrant stats
    const collectionInfo = await qdrantDao.qdrant.getCollection(qdrantDao.collectionName);
    
    // Get Redis stats - count different cache types
    const memoryKeys = await qdrantDao.redis.keys('memory:*');
    const embeddingKeys = await qdrantDao.redis.keys('emb:*');
    const queryKeys = await qdrantDao.redis.keys('query:*');
    const knowledgeKeys = await qdrantDao.redis.keys('knowledge:*');
    
    // Get all appointments and count by status/location
    const appointments = await orchestrator.scheduleAPI.getAllAppointments();
    const appointmentStats = {
      total_count: appointments.length,
      active_count: appointments.filter(a => a.status === 'scheduled').length,
      cancelled_count: appointments.filter(a => a.status === 'cancelled').length,
      by_location: {},
      by_patient: []
    };
    
    // Group by location
    const locationMap = {};
    const patientMap = {};
    
    appointments.forEach(appt => {
      if (appt.status === 'scheduled') {
        locationMap[appt.location] = (locationMap[appt.location] || 0) + 1;
        patientMap[appt.patient] = (patientMap[appt.patient] || 0) + 1;
      }
    });
    
    appointmentStats.by_location = locationMap;
    appointmentStats.by_patient = Object.entries(patientMap).map(([patient, count]) => ({
      patient,
      count
    }));
    
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      qdrant: {
        collection_name: qdrantDao.collectionName,
        points_count: collectionInfo.points_count,
        vectors_count: collectionInfo.vectors_count || collectionInfo.points_count
      },
      redis: {
        sessions: memoryKeys.length,
        cache: {
          embeddings: embeddingKeys.length,
          query_results: queryKeys.length,
          answers: knowledgeKeys.length
        }
      },
      appointments: appointmentStats
    });
  } catch (error) {
    console.error('[STATS] Error:', error);
    res.status(500).json({
      error: 'Failed to get stats',
      details: error.message
    });
  }
});

/**
 * POST /tools/schedule_appointment - Direct schedule API
 */
app.post('/tools/schedule_appointment', async (req, res) => {
  try {
    const { patient, preferred_slot_iso, location } = req.body;
    
    if (!patient || !preferred_slot_iso || !location) {
      return res.status(400).json({
        error: 'Missing required fields: patient, preferred_slot_iso, location'
      });
    }

    const result = await orchestrator.scheduleAPI.scheduleAppointment({
      name: patient,
      slot: preferred_slot_iso,
      location
    });
    
    res.json(result);
  } catch (error) {
    console.error('[SCHEDULE] Error:', error);
    res.status(500).json({
      error: 'Failed to schedule appointment',
      details: error.message
    });
  }
});

/**
 * POST /tools/reschedule_appointment - Direct reschedule API
 */
app.post('/tools/reschedule_appointment', async (req, res) => {
  try {
    const { appt_id, new_slot_iso } = req.body;
    
    if (!appt_id || !new_slot_iso) {
      return res.status(400).json({
        error: 'Missing required fields: appt_id, new_slot_iso'
      });
    }

    const result = await orchestrator.scheduleAPI.rescheduleAppointment(appt_id, new_slot_iso);
    
    res.json(result);
  } catch (error) {
    console.error('[RESCHEDULE] Error:', error);
    res.status(500).json({
      error: 'Failed to reschedule appointment',
      details: error.message
    });
  }
});

/**
 * GET /appointments - List all appointments
 */
app.get('/appointments', async (req, res) => {
  try {
    const appointments = await orchestrator.scheduleAPI.getAllAppointments();
    res.json({
      appointments,
      count: appointments.length
    });
  } catch (error) {
    console.error('[APPOINTMENTS] Error:', error);
    res.status(500).json({
      error: 'Failed to get appointments',
      details: error.message
    });
  }
});

/**
 * GET /appointments/:appt_id - Get specific appointment
 */
app.get('/appointments/:appt_id', async (req, res) => {
  try {
    const { appt_id } = req.params;
    const appointment = await orchestrator.scheduleAPI.getAppointment(appt_id);
    
    if (!appointment) {
      return res.status(404).json({
        error: 'Appointment not found'
      });
    }
    
    res.json(appointment);
  } catch (error) {
    console.error('[APPOINTMENT] Error:', error);
    res.status(500).json({
      error: 'Failed to get appointment',
      details: error.message
    });
  }
});

/**
 * DELETE /appointments/:appt_id - Cancel appointment
 */
app.delete('/appointments/:appt_id', async (req, res) => {
  try {
    const { appt_id } = req.params;
    const result = await orchestrator.scheduleAPI.cancelAppointment(appt_id);
    res.json(result);
  } catch (error) {
    console.error('[CANCEL] Error:', error);
    res.status(500).json({
      error: 'Failed to cancel appointment',
      details: error.message
    });
  }
});

/**
 * DELETE /appointments - Delete all appointments
 */
app.delete('/appointments', async (req, res) => {
  try {
    const result = await orchestrator.scheduleAPI.deleteAllAppointments();
    res.json(result);
  } catch (error) {
    console.error('[DELETE_ALL_APPOINTMENTS] Error:', error);
    res.status(500).json({
      error: 'Failed to delete all appointments',
      details: error.message
    });
  }
});

/**
 * DELETE /cache/clear - Clear all caches
 */
app.delete('/cache/clear', async (req, res) => {
  try {
    await orchestrator.knowledgeAPI.clearCache();
    await orchestrator.memory.clearAll();
    
    res.json({
      ok: true,
      message: 'All caches cleared'
    });
  } catch (error) {
    console.error('[CLEAR_CACHE] Error:', error);
    res.status(500).json({
      error: 'Failed to clear cache',
      details: error.message
    });
  }
});

/**
 * DELETE /knowledge/reset - Reset knowledge base
 */
app.delete('/knowledge/reset', async (req, res) => {
  try {
    const result = await qdrantDao.resetCollection();
    res.json(result);
  } catch (error) {
    console.error('[RESET] Error:', error);
    res.status(500).json({
      error: 'Failed to reset knowledge base',
      details: error.message
    });
  }
});

/**
 * GET /debug/sessions - Debug endpoint for sessions
 */
app.get('/debug/sessions', async (req, res) => {
  try {
    const sessions = await orchestrator.memory.getAllSessions();
    const count = await orchestrator.memory.getSessionCount();
    
    res.json({
      session_count: count,
      sessions
    });
  } catch (error) {
    console.error('[DEBUG] Error:', error);
    res.status(500).json({
      error: 'Failed to get sessions',
      details: error.message
    });
  }
});

/**
 * GET / - Root endpoint
 */
app.get('/', (req, res) => {
  res.json({
    service: 'FastLane RAG Orchestrator',
    version: '2.0.0',
    status: 'running',
    architecture: 'Fast text-based intent detection',
    documentation: `http://localhost:${port}/api-docs`,
    endpoints: {
      'POST /chat': 'Process chat with intent detection (schedule/knowledge)',
      'POST /knowledge': 'Upsert documents to knowledge base',
      'GET /health': 'Health check',
      'GET /stats': 'System statistics (detailed)',
      'DELETE /cache/clear': 'Clear all caches',
      'DELETE /knowledge/reset': 'Reset knowledge base',
      'POST /tools/schedule_appointment': 'Schedule appointment',
      'POST /tools/reschedule_appointment': 'Reschedule appointment',
      'GET /appointments': 'List all appointments',
      'GET /appointments/:appt_id': 'Get appointment',
      'DELETE /appointments/:appt_id': 'Cancel appointment',
      'DELETE /appointments': 'Delete all appointments',
      'GET /debug/sessions': 'View session memory'
    }
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    details: error.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: `Route ${req.method} ${req.path} not found`
  });
});

/**
 * Start server
 */
async function startServer() {
  try {
    console.log('🚀 Initializing FastLane RAG Orchestrator v2.0...');
    
    // Initialize Qdrant DAO
    qdrantDao = new QdrantDao();
    await qdrantDao.ensureCollection();
    
    // Initialize Orchestrator
    orchestrator = new Orchestrator(qdrantDao);
    
    // Initialize FastText model
    await orchestrator.initialize();
    
    // Warm up with common queries
    const commonQueries = [
      "what's our late policy",
      "where do patients park",
      "what are the office hours"
    ];
    await orchestrator.warmIndex(commonQueries);
    
    // Start listening
    app.listen(port, () => {
      console.log(`⚡️ FastLane RAG Orchestrator v2.0 running on port ${port}`);
      console.log(`📚 API Docs: http://localhost:${port}/api-docs`);
      console.log(`📊 Health check: http://localhost:${port}/health`);
      console.log(`🎯 Architecture: FastText ML-based intent detection`);
      console.log(`⏱️  Target latency: <500ms end-to-end`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down FastLane RAG Orchestrator...');
  try {
    await qdrantDao.redis.quit();
    console.log('✅ Redis connection closed');
  } catch (error) {
    console.error('Error during shutdown:', error);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down FastLane RAG Orchestrator...');
  try {
    await qdrantDao.redis.quit();
    console.log('✅ Redis connection closed');
  } catch (error) {
    console.error('Error during shutdown:', error);
  }
  process.exit(0);
});

// Start the server
startServer();
