const fastText = require('fasttext');
const path = require('path');
const fs = require('fs');

/**
 * FastText-based Intent Detector
 * Ultra-fast text classification for schedule vs knowledge intents
 */
class IntentDetector {
  constructor() {
    this.classifier = new fastText.Classifier();
    this.modelPath = path.join(__dirname, '..', 'intent_model.bin');
    this.trainPath = path.join(__dirname, '..', 'train.txt');
    this.isReady = false;
    
    console.log('[INTENT_DETECTOR] Initialized FastText-based intent detector');
  }

  /**
   * Train the FastText model
   */
  async train() {
    try {
      console.log('[INTENT_DETECTOR] Training FastText model...');
      
      const config = {
        input: this.trainPath,
        output: this.modelPath.replace('.bin', ''),
        loss: 'softmax',
        dim: 50,           // Reduced dimensions for speed
        epoch: 25,
        lr: 0.5,
        wordNgrams: 2,
        minCount: 1,
        thread: 4
      };
      
      await this.classifier.train('supervised', config);
      console.log('[INTENT_DETECTOR] Model trained successfully');
      
      // Load the trained model
      await this.load();
    } catch (error) {
      console.error('[INTENT_DETECTOR] Training failed:', error.message);
      console.log('[INTENT_DETECTOR] Falling back to keyword-based detection');
      this.isReady = false;
    }
  }

  /**
   * Load existing model
   */
  async load() {
    try {
      if (fs.existsSync(this.modelPath)) {
        await this.classifier.loadModel(this.modelPath);
        this.isReady = true;
        console.log('[INTENT_DETECTOR] FastText model loaded');
      } else {
        console.log('[INTENT_DETECTOR] No existing model found, training new model...');
        await this.train();
      }
    } catch (error) {
      console.error('[INTENT_DETECTOR] Failed to load model:', error.message);
      this.isReady = false;
    }
  }

  /**
   * Predict intent using FastText
   * @param {string} message - User message
   * @returns {Object} { schedule: boolean, knowledge: boolean }
   */
  async predict(message) {
    if (!this.isReady) {
      // Fallback to keyword-based detection
      return this.keywordFallback(message);
    }

    try {
      const predictions = await this.classifier.predict(message, 2); // Get top 2 predictions
      
      const intents = {
        schedule: false,
        knowledge: false
      };

      // Check predictions
      predictions.forEach(pred => {
        const label = pred.label.replace('__label__', '');
        if (label === 'schedule' && pred.value > 0.3) {
          intents.schedule = true;
        }
        if (label === 'knowledge' && pred.value > 0.3) {
          intents.knowledge = true;
        }
      });

      // If both are detected with similar confidence, keep both
      // Otherwise, prioritize the one with higher confidence
      if (predictions.length > 0 && !intents.schedule && !intents.knowledge) {
        const topLabel = predictions[0].label.replace('__label__', '');
        intents[topLabel] = true;
      }

      console.log(`[INTENT_DETECTOR] Detected: schedule=${intents.schedule}, knowledge=${intents.knowledge}`);
      return intents;
    } catch (error) {
      console.error('[INTENT_DETECTOR] Prediction error:', error.message);
      return this.keywordFallback(message);
    }
  }

  /**
   * Keyword-based fallback when FastText is not available
   */
  keywordFallback(message) {
    const lower = message.toLowerCase();
    
    const scheduleKeywords = [
      'book', 'schedule', 'appointment', 'reschedule', 'change', 
      'move', 'make it', 'change to', 'rebook', 'slot'
    ];
    
    const knowledgeKeywords = [
      'what', 'where', 'how', 'when', 'why', 'tell me', 'policy',
      'parking', 'hours', 'insurance', 'prepare', 'bring', 'access',
      'grace', 'late', 'cancellation', 'location', 'office'
    ];
    
    const hasSchedule = scheduleKeywords.some(kw => lower.includes(kw));
    const hasKnowledge = knowledgeKeywords.some(kw => lower.includes(kw));
    
    return {
      schedule: hasSchedule,
      knowledge: hasKnowledge && !hasSchedule // Prioritize schedule if both
    };
  }

  /**
   * Test the classifier with sample inputs
   */
  async test() {
    const testCases = [
      "Book Chen for tomorrow at 10:30",
      "What's your late policy?",
      "Where can patients park?",
      "Schedule Rivera for next Monday",
      "Make it 11:00 instead"
    ];

    console.log('[INTENT_DETECTOR] Running test cases...');
    for (const test of testCases) {
      const result = await this.predict(test);
      console.log(`  "${test}" → schedule=${result.schedule}, knowledge=${result.knowledge}`);
    }
  }
}

module.exports = IntentDetector;

