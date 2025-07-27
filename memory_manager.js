/**
 * Memory Management System for Galaxy Service
 * Addresses critical memory leaks and implements LRU eviction
 */

class MemoryManager {
    constructor() {
        this.config = {
            MAX_RIVAL_ACTIVITY_PROFILES: 500,
            MAX_TRACKED_RIVALS: 50,
            MAX_USER_MAP_SIZE: 1000,
            MAX_DETECTION_CACHE: 200,
            CLEANUP_INTERVAL_MS: 30000, // 30 seconds
            MAX_ENTRY_AGE_MS: 1800000,  // 30 minutes
            EMERGENCY_CLEANUP_THRESHOLD: 0.9
        };
        
        // LRU tracking
        this.accessOrder = new Map(); // Map key -> last access time
        this.memoryUsage = {
            rivalActivityProfiles: 0,
            trackedRivals: 0,
            userMap: 0,
            detectionCache: 0
        };
        
        // Cleanup intervals
        this.cleanupIntervals = new Set();
        
        this.initializeCleanup();
    }
    
    initializeCleanup() {
        // Main cleanup interval
        const mainCleanup = setInterval(() => {
            this.performMemoryCleanup();
        }, this.config.CLEANUP_INTERVAL_MS);
        
        this.cleanupIntervals.add(mainCleanup);
        
        // Emergency cleanup when memory usage is high
        const emergencyCleanup = setInterval(() => {
            this.checkEmergencyCleanup();
        }, 10000); // Check every 10 seconds
        
        this.cleanupIntervals.add(emergencyCleanup);
        
        console.log('🧹 Memory Manager initialized with automatic cleanup');
    }
    
    /**
     * Track access to maintain LRU order
     */
    trackAccess(mapName, key) {
        const accessKey = `${mapName}:${key}`;
        this.accessOrder.set(accessKey, Date.now());
    }
    
    /**
     * Safe add operation with automatic cleanup
     */
    safeAddToMap(map, key, value, mapName) {
        try {
            // Track access
            this.trackAccess(mapName, key);
            
            // Check if we need cleanup before adding
            if (map.size >= this.getMaxSize(mapName)) {
                this.performLRUEviction(map, mapName);
            }
            
            map.set(key, value);
            this.updateMemoryUsage(mapName, map.size);
            
            return true;
        } catch (error) {
            console.error(`❌ Memory Manager: Failed to add to ${mapName}:`, error.message);
            return false;
        }
    }
    
    /**
     * Perform LRU eviction on a map
     */
    performLRUEviction(map, mapName) {
        const maxSize = this.getMaxSize(mapName);
        const targetSize = Math.floor(maxSize * 0.8); // Remove 20% to prevent frequent cleanup
        
        if (map.size <= targetSize) return;
        
        // Get all entries with their last access times
        const entries = [];
        for (const [key, value] of map.entries()) {
            const accessKey = `${mapName}:${key}`;
            const lastAccess = this.accessOrder.get(accessKey) || 0;
            entries.push({ key, value, lastAccess });
        }
        
        // Sort by last access time (oldest first)
        entries.sort((a, b) => a.lastAccess - b.lastAccess);
        
        // Remove oldest entries
        const toRemove = entries.length - targetSize;
        const removed = [];
        
        for (let i = 0; i < toRemove; i++) {
            const entry = entries[i];
            map.delete(entry.key);
            this.accessOrder.delete(`${mapName}:${entry.key}`);
            removed.push(entry.key);
            
            // Special cleanup for complex objects
            if (mapName === 'trackedRivals' && entry.value) {
                this.cleanupRivalData(entry.value);
            }
        }
        
        this.updateMemoryUsage(mapName, map.size);
        console.log(`🧹 LRU eviction: Removed ${toRemove} entries from ${mapName} (${removed.length} cleaned)`);
        
        return removed;
    }
    
    /**
     * Perform comprehensive memory cleanup
     */
    performMemoryCleanup() {
        const startTime = Date.now();
        const now = Date.now();
        let totalCleaned = 0;
        
        try {
            // Get references to global maps (these would be passed in or injected)
            const maps = this.getGlobalMaps();
            
            for (const [mapName, map] of Object.entries(maps)) {
                if (!map || typeof map.entries !== 'function') continue;
                
                const initialSize = map.size;
                const entriesToCheck = Array.from(map.entries());
                
                for (const [key, value] of entriesToCheck) {
                    if (this.shouldCleanupEntry(mapName, key, value, now)) {
                        map.delete(key);
                        this.accessOrder.delete(`${mapName}:${key}`);
                        totalCleaned++;
                        
                        // Special cleanup for complex objects
                        if (mapName === 'trackedRivals' && value) {
                            this.cleanupRivalData(value);
                        }
                    }
                }
                
                const cleaned = initialSize - map.size;
                if (cleaned > 0) {
                    this.updateMemoryUsage(mapName, map.size);
                    console.log(`🧹 Age-based cleanup: Removed ${cleaned} expired entries from ${mapName}`);
                }
            }
            
            // Cleanup access order map
            this.cleanupAccessOrder(now);
            
            const duration = Date.now() - startTime;
            if (totalCleaned > 0) {
                console.log(`🧹 Memory cleanup completed: ${totalCleaned} entries cleaned in ${duration}ms`);
            }
            
        } catch (error) {
            console.error('❌ Memory cleanup error:', error.message);
        }
    }
    
    /**
     * Check if entry should be cleaned up based on age
     */
    shouldCleanupEntry(mapName, key, value, now) {
        if (!value) return true;
        
        let timestamp;
        
        switch (mapName) {
            case 'rivalActivityProfiles':
                timestamp = value.loginTime || value.lastActivityTime || 0;
                break;
            case 'trackedRivals':
                timestamp = value.loginTime || 0;
                break;
            case 'detectionCache':
                timestamp = value.timestamp || 0;
                break;
            default:
                // For simple maps, check access order
                const accessKey = `${mapName}:${key}`;
                timestamp = this.accessOrder.get(accessKey) || 0;
        }
        
        const age = now - timestamp;
        return age > this.config.MAX_ENTRY_AGE_MS;
    }
    
    /**
     * Clean up rival data with timeouts
     */
    cleanupRivalData(rivalData) {
        try {
            if (rivalData.kickTimeout) {
                clearTimeout(rivalData.kickTimeout);
                rivalData.kickTimeout = null;
            }
            if (rivalData.presenceCheckTimeout) {
                clearTimeout(rivalData.presenceCheckTimeout);
                rivalData.presenceCheckTimeout = null;
            }
            if (rivalData.prisonTimeout) {
                clearTimeout(rivalData.prisonTimeout);
                rivalData.prisonTimeout = null;
            }
        } catch (error) {
            console.error('❌ Error cleaning up rival data:', error.message);
        }
    }
    
    /**
     * Emergency cleanup when memory usage is critical
     */
    checkEmergencyCleanup() {
        const maps = this.getGlobalMaps();
        let needsEmergencyCleanup = false;
        
        for (const [mapName, map] of Object.entries(maps)) {
            if (!map || typeof map.size !== 'number') continue;
            
            const maxSize = this.getMaxSize(mapName);
            const usage = map.size / maxSize;
            
            if (usage >= this.config.EMERGENCY_CLEANUP_THRESHOLD) {
                console.warn(`🚨 Emergency cleanup needed: ${mapName} at ${(usage * 100).toFixed(1)}% capacity`);
                needsEmergencyCleanup = true;
                
                // Aggressive LRU eviction
                this.performLRUEviction(map, mapName);
            }
        }
        
        if (needsEmergencyCleanup) {
            // Force immediate comprehensive cleanup
            this.performMemoryCleanup();
        }
    }
    
    /**
     * Clean up access order tracking
     */
    cleanupAccessOrder(now) {
        const toRemove = [];
        
        for (const [accessKey, timestamp] of this.accessOrder.entries()) {
            if (now - timestamp > this.config.MAX_ENTRY_AGE_MS * 2) { // Keep access logs longer
                toRemove.push(accessKey);
            }
        }
        
        for (const key of toRemove) {
            this.accessOrder.delete(key);
        }
        
        if (toRemove.length > 0) {
            console.log(`🧹 Cleaned ${toRemove.length} old access order entries`);
        }
    }
    
    /**
     * Get maximum size for a map type
     */
    getMaxSize(mapName) {
        switch (mapName) {
            case 'rivalActivityProfiles': return this.config.MAX_RIVAL_ACTIVITY_PROFILES;
            case 'trackedRivals': return this.config.MAX_TRACKED_RIVALS;
            case 'userMap': return this.config.MAX_USER_MAP_SIZE;
            case 'detectionCache': return this.config.MAX_DETECTION_CACHE;
            default: return 1000;
        }
    }
    
    /**
     * Update memory usage tracking
     */
    updateMemoryUsage(mapName, currentSize) {
        if (this.memoryUsage.hasOwnProperty(mapName)) {
            this.memoryUsage[mapName] = currentSize;
        }
    }
    
    /**
     * Get memory usage summary
     */
    getMemoryUsage() {
        const maps = this.getGlobalMaps();
        const usage = {};
        
        for (const [mapName, map] of Object.entries(maps)) {
            if (map && typeof map.size === 'number') {
                const maxSize = this.getMaxSize(mapName);
                usage[mapName] = {
                    current: map.size,
                    max: maxSize,
                    percentage: ((map.size / maxSize) * 100).toFixed(1) + '%'
                };
            }
        }
        
        return usage;
    }
    
    /**
     * This would be implemented to get references to the actual global maps
     * For now, returning empty object - this needs to be connected to the actual maps
     */
    getGlobalMaps() {
        // This needs to be implemented to return the actual global maps
        // For example: { rivalActivityProfiles, trackedRivals, userMap, detectionCache }
        return {};
    }
    
    /**
     * Shutdown cleanup
     */
    shutdown() {
        // Clear all cleanup intervals
        for (const interval of this.cleanupIntervals) {
            clearInterval(interval);
        }
        this.cleanupIntervals.clear();
        
        // Final cleanup
        this.performMemoryCleanup();
        
        console.log('🧹 Memory Manager shutdown completed');
    }
}

module.exports = MemoryManager;
