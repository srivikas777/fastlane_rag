const { v4: uuidv4 } = require('uuid');

/**
 * Mock scheduling API - simulates appointment booking system
 * In production, this would call external scheduling service
 */
class ScheduleAPI {
  constructor(redis) {
    this.redis = redis;
    this.lastApptNumber = 1000; // Counter for sequential IDs
    console.log('[SCHEDULE_API] Initialized');
  }

  /**
   * Generate unique appointment ID
   */
  async generateApptId() {
    // Use timestamp + counter for uniqueness
    const timestamp = Date.now().toString().slice(-6);
    this.lastApptNumber++;
    const apptId = `A-${timestamp}-${this.lastApptNumber}`;
    
    // Ensure it doesn't exist (paranoid check)
    const exists = await this.redis.exists(`appt:${apptId}`);
    if (exists) {
      return this.generateApptId(); // Recursive retry
    }
    
    return apptId;
  }

  /**
   * Schedule a new appointment
   * @param {Object} params - { name, slot, location }
   * @returns {Object} { ok, appt_id, patient, normalized_slot_iso, location }
   */
  async scheduleAppointment({ name, slot, location }) {
    try {
      // Validate inputs
      if (!name || !slot || !location) {
        return {
          ok: false,
          error: 'Missing required fields: name, slot, location'
        };
      }

      // Generate unique appointment ID
      const apptId = await this.generateApptId();

      // Normalize slot to ISO
      const slotDate = new Date(slot);
      if (isNaN(slotDate.getTime())) {
        return {
          ok: false,
          error: 'Invalid date/time format'
        };
      }

      // Create appointment record
      const appointment = {
        appt_id: apptId,
        patient: name,
        normalized_slot_iso: slotDate.toISOString(),
        location: location,
        status: 'scheduled',
        created_at: new Date().toISOString()
      };

      // Store in Redis
      await this.redis.setex(
        `appt:${apptId}`,
        86400 * 7, // 7 days TTL
        JSON.stringify(appointment)
      );

      // Add to index
      await this.redis.sadd('appts:all', apptId);

      console.log(`[SCHEDULE_API] Created appointment ${apptId} for ${name}`);

      return {
        ok: true,
        ...appointment
      };
    } catch (error) {
      console.error('[SCHEDULE_API] Error scheduling appointment:', error);
      return {
        ok: false,
        error: error.message
      };
    }
  }

  /**
   * Reschedule an existing appointment
   * @param {string} apptId - Appointment ID
   * @param {string} newSlot - New time slot (ISO string)
   * @returns {Object} Updated appointment
   */
  async rescheduleAppointment(apptId, newSlot) {
    try {
      // Get existing appointment
      const apptData = await this.redis.get(`appt:${apptId}`);
      if (!apptData) {
        return {
          ok: false,
          error: `Appointment ${apptId} not found`
        };
      }

      const appointment = JSON.parse(apptData);

      // Update slot
      const slotDate = new Date(newSlot);
      if (isNaN(slotDate.getTime())) {
        return {
          ok: false,
          error: 'Invalid date/time format'
        };
      }

      appointment.normalized_slot_iso = slotDate.toISOString();
      appointment.updated_at = new Date().toISOString();

      // Save updated appointment
      await this.redis.setex(
        `appt:${apptId}`,
        86400 * 7, // 7 days TTL
        JSON.stringify(appointment)
      );

      console.log(`[SCHEDULE_API] Rescheduled appointment ${apptId}`);

      return {
        ok: true,
        ...appointment
      };
    } catch (error) {
      console.error('[SCHEDULE_API] Error rescheduling appointment:', error);
      return {
        ok: false,
        error: error.message
      };
    }
  }

  /**
   * Get appointment by ID
   */
  async getAppointment(apptId) {
    try {
      const apptData = await this.redis.get(`appt:${apptId}`);
      if (!apptData) {
        return null;
      }
      return JSON.parse(apptData);
    } catch (error) {
      console.error('[SCHEDULE_API] Error getting appointment:', error);
      return null;
    }
  }

  /**
   * Get all appointments
   */
  async getAllAppointments() {
    try {
      const apptIds = await this.redis.smembers('appts:all');
      const appointments = [];

      for (const apptId of apptIds) {
        const apptData = await this.redis.get(`appt:${apptId}`);
        if (apptData) {
          appointments.push(JSON.parse(apptData));
        }
      }

      return appointments;
    } catch (error) {
      console.error('[SCHEDULE_API] Error getting appointments:', error);
      return [];
    }
  }

  /**
   * Cancel appointment
   */
  async cancelAppointment(apptId) {
    try {
      const apptData = await this.redis.get(`appt:${apptId}`);
      if (!apptData) {
        return {
          ok: false,
          error: `Appointment ${apptId} not found`
        };
      }

      // Remove from index and delete
      await this.redis.srem('appts:all', apptId);
      await this.redis.del(`appt:${apptId}`);

      console.log(`[SCHEDULE_API] Cancelled appointment ${apptId}`);

      return {
        ok: true,
        message: `Appointment ${apptId} cancelled`
      };
    } catch (error) {
      console.error('[SCHEDULE_API] Error cancelling appointment:', error);
      return {
        ok: false,
        error: error.message
      };
    }
  }

  /**
   * Delete all appointments
   * @returns {Object} { ok, deleted_count, message }
   */
  async deleteAllAppointments() {
    try {
      // Get all appointment IDs
      const apptIds = await this.redis.smembers('appts:all');
      
      if (apptIds.length === 0) {
        return {
          ok: true,
          deleted_count: 0,
          message: 'No appointments to delete'
        };
      }

      // Delete all appointment records
      const keysToDelete = apptIds.map(id => `appt:${id}`);
      await this.redis.del(...keysToDelete);
      
      // Clear the index
      await this.redis.del('appts:all');

      console.log(`[SCHEDULE_API] Deleted all ${apptIds.length} appointments`);

      return {
        ok: true,
        deleted_count: apptIds.length,
        message: `Deleted ${apptIds.length} appointments`
      };
    } catch (error) {
      console.error('[SCHEDULE_API] Error deleting all appointments:', error);
      return {
        ok: false,
        error: error.message
      };
    }
  }
}

module.exports = ScheduleAPI;

