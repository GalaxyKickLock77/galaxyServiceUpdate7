const WebSocket = require('ws');
const fs = require('fs').promises;
const fsSync = require('fs');
const CryptoJS = require('crypto-js');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const { MISTRAL_API_KEY } = require('./src/secrets/mistral_api_key');
const io = require('socket.io-client');

const LOG_FILE_PATH = 'galaxy_5.log';
const LOG_FILE_MAX_SIZE_BYTES = 1024 * 1024; // 1 MB
const LOG_CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds (synchronized)

const originalConsoleLog = console.log;
const originalConsoleError = console.error;

const logQueue = [];
let logWriteInProgress = false;
let logProcessTimeout = null;

async function processLogQueue() {
    if (logWriteInProgress || logQueue.length === 0) {
        return;
    }

    logWriteInProgress = true;
    const messagesToWrite = logQueue.splice(0, logQueue.length); // Get all current messages
    const logContent = messagesToWrite.join('');

    try {
        await fs.appendFile(LOG_FILE_PATH, logContent);
    } catch (err) {
        originalConsoleError(`Failed to write to log file: ${err.message}`);
    } finally {
        logWriteInProgress = false;
    }
}

// Debounced log processing for better performance
function debouncedLogProcess() {
    if (logProcessTimeout) return;
    logProcessTimeout = setTimeout(() => {
        processLogQueue();
        logProcessTimeout = null;
    }, 100);
}

function appLog(message, ...args) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message} ${args.map(arg => JSON.stringify(arg)).join(' ')}\n`;
    logQueue.push(logMessage);
    originalConsoleLog(message, ...args); // Also log to console
    // Use debounced processing for better performance
    debouncedLogProcess();
}

async function cleanUpLogFile() {
    try {
        // Always truncate the log file to 0 bytes
        await fs.truncate(LOG_FILE_PATH, 0);
        // appLog(`Log file ${LOG_FILE_PATH} truncated.`); // Use original console.log to avoid recursion
        originalConsoleLog(`[${new Date().toISOString()}] Log file ${LOG_FILE_PATH} truncated.`);
    } catch (err) {
        if (err.code === 'ENOENT') {
            // File does not exist, no need to clean up, but create it if it doesn't exist
            try {
                await fs.writeFile(LOG_FILE_PATH, '');
                // appLog(`Log file ${LOG_FILE_PATH} created.`); // Use original console.log to avoid recursion
                originalConsoleLog(`[${new Date().toISOString()}] Log file ${LOG_FILE_PATH} created.`);
            } catch (writeErr) {
                originalConsoleError(`Error creating log file: ${writeErr.message}`);
            }
        } else {
            originalConsoleError(`Error during log file cleanup: ${err.message}`);
        }
    }
}

// Handle PM2 signals for config reload
process.on('SIGUSR2', () => {
    updateConfigValues();
});

// Optimized Connection Pool to Avoid Rate Limits
const POOL_MIN_SIZE = 1;
const POOL_MAX_SIZE = 3;
const POOL_TARGET_SIZE = 2;
const POOL_HEALTH_CHECK_INTERVAL = 20000; // 20 seconds to avoid excessive checks
const CONNECTION_MAX_AGE = 10 * 60 * 1000; // 2 minutes
const CONNECTION_IDLE_TIMEOUT = 1 * 60 * 1000; // 1 minute

// Action timing constants
const ACTION_DELAY = 300; // Delay between ACTION commands
const SERVER_RESPONSE_DELAY = 10; // Wait for server responses
const CONNECTION_TIMEOUT = 8000; // WebSocket connection timeout
const HANDSHAKE_TIMEOUT = 10000; // WebSocket handshake timeout

// Connection states
const CONNECTION_STATES = {
    CLOSED: 'closed',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    HASH_RECEIVED: 'hash_received',
    AUTHENTICATED: 'authenticated',
    READY: 'ready'
};

let poolMaintenanceInProgress = false;
let lastCloseTime = 0;

// Core system variables
let monitoringMode = true;
let isReconnectingAfterRivalAction = false;
let activeConnection = null;
let connectionPool = [];

// Configuration
let config = {};
let blackListRival = [];
let whiteListMember = [];
let userMap = new Map(); // Use Map for better performance
let currentMode = null;
let currentConnectionPromise = null;

let rivalProcessingTimeout = null;
let founderIds = new Set();
let isProcessingRivalAction = false;
let processingRivalTimeout = null;

// Circuit breaker for connection failures
let connectionFailureCount = 0;
let lastConnectionFailure = 0;
const MAX_CONNECTION_FAILURES = 5;
const FAILURE_RESET_TIME = 60000; // 1 minute

function shouldAttemptConnection() {
    const now = Date.now();
    if (now - lastConnectionFailure > FAILURE_RESET_TIME) {
        connectionFailureCount = 0;
    }
    return connectionFailureCount < MAX_CONNECTION_FAILURES;
}

function recordConnectionFailure() {
    connectionFailureCount++;
    lastConnectionFailure = Date.now();
    if (connectionFailureCount >= MAX_CONNECTION_FAILURES) {
        appLog(`🚨 Circuit breaker activated: ${connectionFailureCount} failures`);
    }
}

// Helper function for safe timeout cleanup
function safeTimeoutCleanup(timeoutId) {
    if (timeoutId) {
        clearTimeout(timeoutId);
        return null;
    }
    return timeoutId;
}

// Cleanup rival tracking
function cleanupRivalTracking(rivalId) {
    const rivalData = trackedRivals.get(rivalId);
    if (rivalData) {
        if (rivalData.kickTimeout) clearTimeout(rivalData.kickTimeout);
        if (rivalData.presenceCheckTimeout) clearTimeout(rivalData.presenceCheckTimeout);
        if (rivalData.prisonTimeout) clearTimeout(rivalData.prisonTimeout);
        trackedRivals.delete(rivalId);
    }
}

// Get monitoring connection
async function getMonitoringConnection() {
    if (activeConnection && activeConnection.state === CONNECTION_STATES.READY) {
        return activeConnection;
    }
    return getConnection(true, true);
}

// Enhanced flag reset function with prison recovery
function resetProcessingFlag() {
    if (isProcessingRivalAction) {
        appLog(`🔄 Resetting processing flag`);
        isProcessingRivalAction = false;
        if (processingRivalTimeout) {
            clearTimeout(processingRivalTimeout);
            processingRivalTimeout = null;
        }
    }
    
    // Clear any stuck prison timeouts
    trackedRivals.forEach((rivalData, rivalId) => {
        if (rivalData.prisonTimeout) {
            clearTimeout(rivalData.prisonTimeout);
            rivalData.prisonTimeout = null;
        }
    });
    
    // CRITICAL: Ensure system is always ready for rival detection
    if (!monitoringMode && !isReconnectingAfterRivalAction) {
        appLog(`🔄 Force enabling monitoring mode`);
        monitoringMode = true;
    }
}

// Reset flag every 2 seconds to prevent stuck states
setInterval(resetProcessingFlag, 2000);

// Additional aggressive reset every 5 seconds if stuck
setInterval(() => {
    if (isProcessingRivalAction && processingRivalTimeout) {
        const now = Date.now();
        // Force reset if stuck for more than 3 seconds
        appLog(`🔄 Force resetting stuck processing flag`);
        isProcessingRivalAction = false;
        if (processingRivalTimeout) {
            clearTimeout(processingRivalTimeout);
            processingRivalTimeout = null;
        }
    }
}, 5000);

// Additional safety check every 5 seconds for prison recovery
setInterval(() => {
    if (activeConnection && activeConnection.state === CONNECTION_STATES.READY && !isProcessingRivalAction) {
        // System should be fully operational - no action needed
    } else if (!activeConnection && !isReconnectingAfterRivalAction && !poolMaintenanceInProgress) {
        appLog(`⚠️ No active connection detected, attempting recovery`);
        getConnection(true, true).catch(err => {
            appLog(`Recovery attempt failed: ${err.message}`);
        });
    }
}, 5000);

// Perfect rival tracking system with memory optimization
let trackedRivals = new Map(); // Map of rivalId -> { name, loginTime, mode, connection, coordinate, kickTimeout, presenceCheckTimeout }


// Memory optimization constants
const MAX_USER_MAP_SIZE = 1000;
const MAX_TRACKED_RIVALS = 50;
const MEMORY_CLEANUP_INTERVAL = 60000; // 60 seconds (adaptive)
const RIVAL_EXPIRE_TIME = 300000; // 5 minutes

// Timing precision enhancement
let timingDriftCorrection = 0;
let timingStats = {
    totalActions: 0,
    averageDelay: 0,
    minDelay: Infinity,
    maxDelay: 0
};

// High precision timing function
function getHighPrecisionTime() {
    return performance.now() + timingDriftCorrection;
}

// Adaptive memory cleanup function
function performMemoryCleanup() {
    // Only run if memory usage is high
    if (userMap.size < MAX_USER_MAP_SIZE * 0.7 && trackedRivals.size < MAX_TRACKED_RIVALS * 0.7) {
        return; // Skip cleanup if memory usage is low
    }
    
    const now = Date.now();
    let cleaned = 0;
    
    // Clean expired tracked rivals
    for (const [rivalId, rivalData] of trackedRivals.entries()) {
        if (now - rivalData.loginTime > RIVAL_EXPIRE_TIME) {
            cleanupRivalTracking(rivalId);
            cleaned++;
        }
    }
    
    // Limit userMap size
    if (userMap.size > MAX_USER_MAP_SIZE) {
        const entries = Array.from(userMap.entries());
        const toKeep = entries.slice(-MAX_USER_MAP_SIZE * 0.8); // Keep 80%
        userMap = new Map(toKeep);
        cleaned += entries.length - toKeep.length;
    }
    
    // Limit tracked rivals
    if (trackedRivals.size > MAX_TRACKED_RIVALS) {
        const oldestRivals = Array.from(trackedRivals.entries())
            .sort((a, b) => a[1].loginTime - b[1].loginTime)
            .slice(0, trackedRivals.size - MAX_TRACKED_RIVALS);
        
        oldestRivals.forEach(([rivalId]) => {
            cleanupRivalTracking(rivalId);
            cleaned++;
        });
    }
    
    if (cleaned > 0) {
        appLog(`🧹 Memory cleanup: removed ${cleaned} entries`);
    }
}

// Timing drift correction
function measureTimingDrift() {
    const start = getHighPrecisionTime();
    setTimeout(() => {
        const actual = getHighPrecisionTime() - start;
        const expected = 100; // 100ms test
        const drift = actual - expected;
        
        if (Math.abs(drift) > 5) { // More than 5ms drift
            timingDriftCorrection -= drift * 0.1; // Gradual correction
            appLog(`⏱️ Timing drift corrected: ${drift.toFixed(2)}ms`);
        }
    }, 100);
}

// Update timing statistics with overflow protection
function updateTimingStats(actualDelay, expectedDelay) {
    const delay = Math.abs(actualDelay - expectedDelay);
    timingStats.totalActions++;
    
    // Reset stats if overflow risk (every 1M actions)
    if (timingStats.totalActions > 1000000) {
        timingStats.totalActions = 1;
        timingStats.averageDelay = delay;
        timingStats.minDelay = delay;
        timingStats.maxDelay = delay;
        return;
    }
    
    timingStats.averageDelay = ((timingStats.averageDelay * (timingStats.totalActions - 1)) + delay) / timingStats.totalActions;
    timingStats.minDelay = Math.min(timingStats.minDelay, delay);
    timingStats.maxDelay = Math.max(timingStats.maxDelay, delay);
}

// Start memory cleanup and timing measurement intervals
setInterval(performMemoryCleanup, MEMORY_CLEANUP_INTERVAL);
setInterval(measureTimingDrift, 300000); // Every 5 minutes

// Conditional health reporting (every 10 minutes, only if active)
setInterval(() => {
    const rc1 = rcPerformance.RC1;
    const rc2 = rcPerformance.RC2;
    
    // Only report if there's been recent activity
    if ((rc1.totalConnections > 0 || rc2.totalConnections > 0) && 
        (Date.now() - Math.max(rc1.lastUsed, rc2.lastUsed) < 600000)) { // Within last 10 minutes
        appLog(`📊 RC Performance: RC1: ${(rc1.successRate * 100).toFixed(1)}% | RC2: ${(rc2.successRate * 100).toFixed(1)}% | Best: ${getBestPerformingRC()}`);
    }
}, 600000); // Every 10 minutes

// Rival Detection Speed Optimization
// Pre-compiled regex patterns for faster parsing
const REGEX_PATTERNS = {
    userId: /^\d{6,}$/,
    coordinate: /^\d+$/,
    tokenSplit: /(?:[^\s"]+|"[^"]*")+/g,
    namePrefix: /^[@+]/
};

// Rival ID cache for frequently accessed rivals
const rivalCache = new Map();
const RIVAL_CACHE_SIZE = 100; // Optimized for memory usage
const RIVAL_CACHE_TTL = 600000; // 10 minutes

// Batch processing for multiple rivals
let rivalBatch = [];
let batchTimeout = null;
const BATCH_SIZE = 10;
const BATCH_DELAY = 50; // 50ms

// Fast rival lookup with caching
function getCachedRival(name) {
    const cached = rivalCache.get(name);
    if (cached && Date.now() - cached.timestamp < RIVAL_CACHE_TTL) {
        return cached.data;
    }
    return null;
}

function setCachedRival(name, data) {
    if (rivalCache.size >= RIVAL_CACHE_SIZE) {
        const oldestKey = rivalCache.keys().next().value;
        rivalCache.delete(oldestKey);
    }
    rivalCache.set(name, {
        data: data,
        timestamp: Date.now()
    });
}

// Fast rival classification
function classifyRival(name, id, connection) {
    // Check cache first
    const cached = getCachedRival(name);
    if (cached !== null) {
        return cached;
    }
    
    // Fast classification logic
    const isBlackListed = blackListRival.includes(name);
    const isWhiteListed = whiteListMember.includes(name);
    const isFounder = founderIds.has(id);
    const isSelf = name === connection.nick;
    
    const classification = {
        isRival: !isWhiteListed && !isSelf && !isFounder && (config.kickAllToggle || isBlackListed),
        isBlackListed,
        isWhiteListed,
        isFounder,
        isSelf
    };
    
    // Cache the result
    setCachedRival(name, classification);
    return classification;
}

// Batch process rivals for better performance
function addToBatch(rival, mode, connection) {
    rivalBatch.push({ rival, mode, connection });
    
    if (rivalBatch.length >= BATCH_SIZE) {
        processBatch();
    } else if (!batchTimeout) {
        batchTimeout = setTimeout(processBatch, BATCH_DELAY);
    }
}

function processBatch() {
    if (batchTimeout) {
        clearTimeout(batchTimeout);
        batchTimeout = null;
    }
    
    if (rivalBatch.length === 0) return;
    
    const batch = rivalBatch.splice(0, rivalBatch.length);
    const startTime = getHighPrecisionTime();
    
    // Process all rivals in batch
    batch.forEach(({ rival, mode, connection }) => {
        if (!trackedRivals.has(rival.id)) {
            const rivalData = {
                name: rival.name,
                loginTime: Date.now(),
                mode: mode,
                connection: connection,
                coordinate: rival.coordinate,
                kickTimeout: null,
                presenceCheckTimeout: null
            };
            trackedRivals.set(rival.id, rivalData);
            scheduleRivalKick(rival.id, rivalData);
        }
    });
    
    const processingTime = getHighPrecisionTime() - startTime;
    if (batch.length > 1) {
        appLog(`⚡ Batch processed ${batch.length} rivals in ${processingTime.toFixed(2)}ms`);
    }
}

// WebSocket connection to Flask API
let apiSocket = null;
let isConnectedToAPI = false;
const FORM_NUMBER = 1; // This should be set based on which galaxy instance this is

// Connection pool settings
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BACKOFF_BASE = 50; // Ultra-fast backoff base
const DUAL_RC_BACKOFF_BASE = 1500;
const DUAL_RC_MAX_BACKOFF = 3500; // Updated based on user's request for even backoff of 2500


// Prison pool settings
const prisonConnectionPool = [];
let prisonMaintenanceInProgress = false;
const PRISON_POOL_MIN_SIZE = 1;
const PRISON_POOL_MAX_SIZE = 1;
const PRISON_POOL_TARGET_SIZE = 1;
const PRISON_CONNECTION_MAX_AGE = 1 * 60 * 1000;

let globalTimingState = {
    RC1: {
        attack: { currentTime: null, lastMode: null, consecutiveErrors: 0 },
        defense: { currentTime: null, lastMode: null, consecutiveErrors: 0 }
    },
    RC2: {
        attack: { currentTime: null, lastMode: null, consecutiveErrors: 0 },
        defense: { currentTime: null, lastMode: null, consecutiveErrors: 0 }
    }
};

// RC Performance Tracking System
let rcPerformance = {
    RC1: {
        totalConnections: 0,
        successfulConnections: 0,
        failedConnections: 0,
        totalResponseTime: 0,
        averageResponseTime: 0,
        successRate: 1.0,
        lastUsed: 0,
        recentErrors: 0
    },
    RC2: {
        totalConnections: 0,
        successfulConnections: 0,
        failedConnections: 0,
        totalResponseTime: 0,
        averageResponseTime: 0,
        successRate: 1.0,
        lastUsed: 0,
        recentErrors: 0
    }
};

// Connection Health Scoring Functions
function updateConnectionHealth(connection, success, responseTime = 0) {
    if (!connection.healthScore) {
        connection.healthScore = {
            totalActions: 0,
            successfulActions: 0,
            failedActions: 0,
            totalResponseTime: 0,
            averageResponseTime: 0,
            score: 1.0,
            lastUpdated: Date.now()
        };
    }
    
    const health = connection.healthScore;
    health.totalActions++;
    health.totalResponseTime += responseTime;
    health.averageResponseTime = health.totalResponseTime / health.totalActions;
    health.lastUpdated = Date.now();
    
    if (success) {
        health.successfulActions++;
    } else {
        health.failedActions++;
    }
    
    // Calculate health score (0.0 to 1.0)
    health.score = health.successfulActions / health.totalActions;
    
    // Update RC performance
    updateRCPerformance(connection.rcKey, success, responseTime);
}

function updateRCPerformance(rcKey, success, responseTime = 0) {
    const rc = rcPerformance[rcKey];
    if (!rc) return;
    
    rc.totalConnections++;
    rc.totalResponseTime += responseTime;
    rc.averageResponseTime = rc.totalResponseTime / rc.totalConnections;
    rc.lastUsed = Date.now();
    
    if (success) {
        rc.successfulConnections++;
        rc.recentErrors = Math.max(0, rc.recentErrors - 1); // Reduce recent errors on success
    } else {
        rc.failedConnections++;
        rc.recentErrors++;
    }
    
    // Calculate success rate
    rc.successRate = rc.successfulConnections / rc.totalConnections;
}

function getBestPerformingRC() {
    const rc1 = rcPerformance.RC1;
    const rc2 = rcPerformance.RC2;
    
    // If one RC has no data, use the other
    if (rc1.totalConnections === 0) return 'RC2';
    if (rc2.totalConnections === 0) return 'RC1';
    
    // Calculate weighted score (success rate + recent performance)
    const rc1Score = rc1.successRate - (rc1.recentErrors * 0.1);
    const rc2Score = rc2.successRate - (rc2.recentErrors * 0.1);
    
    return rc1Score >= rc2Score ? 'RC1' : 'RC2';
}

function getConnectionHealthSummary(connection) {
    if (!connection.healthScore) return 'No health data';
    const h = connection.healthScore;
    return `Score: ${(h.score * 100).toFixed(1)}% (${h.successfulActions}/${h.totalActions}) Avg: ${h.averageResponseTime.toFixed(0)}ms`;
}



// Recovery code alternation
let lastUsedRC = 'RC2'; // Start with RC2 so first connection uses RC1
let lastRCSwitch = 0; // Track last RC switch time

function getNextRC() {
    if (config.dualRCToggle === false) {
        return 'RC1';
    }
    
    // Smart RC selection based on performance (every 10th connection)
    if (rcPerformance.RC1.totalConnections + rcPerformance.RC2.totalConnections > 0 && 
        (rcPerformance.RC1.totalConnections + rcPerformance.RC2.totalConnections) % 10 === 0) {
        const bestRC = getBestPerformingRC();
        appLog(`🎯 Smart RC selection: ${bestRC} (RC1: ${(rcPerformance.RC1.successRate * 100).toFixed(1)}%, RC2: ${(rcPerformance.RC2.successRate * 100).toFixed(1)}%)`);
        return bestRC;
    }
    
    // Default alternating behavior
    lastUsedRC = lastUsedRC === 'RC1' ? 'RC2' : 'RC1';
    lastRCSwitch = Date.now();
    return lastUsedRC;
}

function initializeTimingStates(connection) {
    const rcKey = connection.rcKey;
    // Initialize connection's timing states from the global timing state for the specific RC
    connection.attackTimingState = {
        currentTime: globalTimingState[rcKey].attack.currentTime,
        lastMode: globalTimingState[rcKey].attack.lastMode,
        consecutiveErrors: globalTimingState[rcKey].attack.consecutiveErrors
    };
    connection.defenseTimingState = {
        currentTime: globalTimingState[rcKey].defense.currentTime,
        lastMode: globalTimingState[rcKey].defense.lastMode,
        consecutiveErrors: globalTimingState[rcKey].defense.consecutiveErrors
    };
}

function updateConfigValues(newConfig = null) {
    if (newConfig) {
        // Update from WebSocket
        config = newConfig;
    //    appLog(`Config updated via WebSocket: ${JSON.stringify(Object.keys(config))}`);
    } else {
        // Fallback to file-based config if WebSocket not available
        try {
            delete require.cache[require.resolve('./config5.json')];
            const configRaw = fsSync.readFileSync('./config5.json', 'utf8');
            config = JSON.parse(configRaw);
        //    appLog("Config loaded from file (fallback)");
        } catch (error) {
        //    appLog("Failed to load config from file:", error);
            return;
        }
    }
    
    // Process arrays and booleans
    blackListRival = Array.isArray(config.blackListRival) ? config.blackListRival : 
        (typeof config.blackListRival === 'string' ? config.blackListRival.split(',').map(name => name.trim()) : []);
    whiteListMember = Array.isArray(config.whiteListMember) ? config.whiteListMember : 
        (typeof config.whiteListMember === 'string' ? config.whiteListMember.split(',').map(name => name.trim()) : []);
    
    // Convert booleans
    config.standOnEnemy = config.standOnEnemy === "true" || config.standOnEnemy === true;
    config.actionOnEnemy = config.actionOnEnemy === "true" || config.actionOnEnemy === true;
    config.aiChatToggle = config.aiChatToggle === "true" || config.aiChatToggle === true;
    config.dualRCToggle = config.dualRCToggle === "true" || config.dualRCToggle === true;
    config.kickAllToggle = config.kickAllToggle === "true" || config.kickAllToggle === true;
    
    // Initialize timing states
    if (globalTimingState.RC1.attack.currentTime === null) {
        globalTimingState.RC1.attack.currentTime = config.RC1_startAttackTime || 1870;
        globalTimingState.RC1.defense.currentTime = config.RC1_startDefenceTime || 1870;
    }
    if (globalTimingState.RC2.attack.currentTime === null) {
        globalTimingState.RC2.attack.currentTime = config.RC2_startAttackTime || 1875;
        globalTimingState.RC2.defense.currentTime = config.RC2_startDefenceTime || 1850;
    }
    
    // Re-initialize connection timing states
    connectionPool.forEach(conn => initializeTimingStates(conn));
    if (activeConnection) initializeTimingStates(activeConnection);
}

// Initialize WebSocket connection to Flask API
function connectToAPI() {
    if (apiSocket && apiSocket.connected) {
    //    appLog("Already connected to Flask API WebSocket");
        return;
    }
    
   // appLog("Connecting to Flask API via WebSocket at http://127.0.0.1:7860...");
    
    try {
        apiSocket = io('http://127.0.0.1:7860', {
            transports: ['websocket'],
            timeout: 5000,
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionAttempts: 10,
            forceNew: true
        });
    } catch (error) {
     //   appLog("Error creating socket.io client:", error.message);
        return;
    }
    
    apiSocket.on('connect', () => {
        isConnectedToAPI = true;
       // appLog(`Connected to Flask API WebSocket`);
        
        // Register this galaxy instance
        apiSocket.emit('galaxy_connect', {
            form_number: FORM_NUMBER,
            timestamp: Date.now()
        });
    });
    
    apiSocket.on('connection_confirmed', (data) => {
       // appLog(`Connection confirmed for form ${data.form_number}`);
    });
    
    apiSocket.on('config_update', (data) => {
       // appLog(`Received config update via WebSocket`);
        updateConfigValues(data.config);
        
        // Send response back to API
        apiSocket.emit('galaxy_response', {
            form_number: FORM_NUMBER,
            response_id: data.response_id,
            response: {
                status: 'config_applied',
                timestamp: Date.now(),
                config_keys: Object.keys(data.config)
            }
        });
    });
    
    apiSocket.on('disconnect', () => {
        isConnectedToAPI = false;
      //  appLog("Disconnected from Flask API WebSocket");
    });
    
    apiSocket.on('connect_error', (error) => {
        isConnectedToAPI = false;
       // appLog("WebSocket connection error:", error.message || error);
       // appLog("Make sure Flask API is running on port 7860");
    });
    
    apiSocket.on('reconnect_error', (error) => {
      //  appLog("WebSocket reconnection error:", error.message || error);
    });
    
    apiSocket.on('error', (error) => {
      //  appLog("WebSocket general error:", error.message || error);
    });
}

// Initialize with fallback config and connect to API
updateConfigValues(); // Load from file initially
connectToAPI();

// Fallback file watching (only used if WebSocket is not available)
let configLastModified = 0;
const configPath = './config5.json';

// Only use file watching as fallback when WebSocket is disconnected
setInterval(() => {
    if (!isConnectedToAPI) {
        try {
            const stats = fsSync.statSync(configPath);
            const mtime = stats.mtimeMs;
            
            if (mtime > configLastModified) {
                configLastModified = mtime;
            //    appLog(`Config change detected via file polling (WebSocket fallback)`);
                updateConfigValues();
            }
        } catch (err) {
            // File doesn't exist or can't be read
        }
    }
}, 1000); // Check every second when WebSocket is down

// Reconnect to API if connection is lost
setInterval(() => {
    if (!isConnectedToAPI) {
        connectToAPI();
    }
}, 5000); // Try to reconnect every 5 seconds

function genHash(code) {
    const hash = CryptoJS.MD5(code);
    let str = hash.toString(CryptoJS.enc.Hex);
    str = str.split("").reverse().join("0").substr(5, 10);
    return str;
}

function incrementTiming(mode, connection, errorType = 'success') {
    const isAttack = mode === 'attack';
    const rcKey = connection.rcKey;
    const globalStateForRC = isAttack ? globalTimingState[rcKey].attack : globalTimingState[rcKey].defense;
    const configStart = isAttack ? config[`${rcKey}_startAttackTime`] : config[`${rcKey}_startDefenceTime`];
    const configStop = isAttack ? config[`${rcKey}_stopAttackTime`] : config[`${rcKey}_stopDefenceTime`];
    const configInterval = isAttack ? config[`${rcKey}_attackIntervalTime`] : config[`${rcKey}_defenceIntervalTime`];

    if (errorType !== 'success') {
        globalStateForRC.consecutiveErrors++;
    } else {
        globalStateForRC.consecutiveErrors = 0;
    }

    const oldTime = globalStateForRC.currentTime;
    globalStateForRC.currentTime += configInterval;

    if (globalStateForRC.currentTime > configStop) {
        globalStateForRC.currentTime = configStart;
        globalStateForRC.consecutiveErrors = 0;
    //    appLog(`${mode} global timing for ${connection.botId} (${rcKey}) cycled back to start: ${globalStateForRC.currentTime}ms`);
    } else {
    //    appLog(`${mode} global timing for ${connection.botId} (${rcKey}) incremented: ${oldTime}ms -> ${globalStateForRC.currentTime}ms (errors: ${globalStateForRC.consecutiveErrors}, type: ${errorType})`);
    }

    globalStateForRC.lastMode = mode;

    // Update the connection's timing state to reflect the global state immediately
    connection.attackTimingState.currentTime = globalTimingState[rcKey].attack.currentTime;
    connection.defenseTimingState.currentTime = globalTimingState[rcKey].defense.currentTime;

    return globalStateForRC.currentTime;
}

function getCurrentTiming(mode, connection) {
    const isAttack = mode === 'attack';
    const rcKey = connection.rcKey;
    const globalStateForRC = isAttack ? globalTimingState[rcKey].attack : globalTimingState[rcKey].defense;
    let timing = globalStateForRC.currentTime !== null ? globalStateForRC.currentTime : (isAttack ? config[`${rcKey}_startAttackTime`] : config[`${rcKey}_startDefenceTime`]);
    
    // Apply timing precision adjustments based on statistics
    if (timingStats.totalActions > 10) {
        const adjustment = timingStats.averageDelay > 50 ? -Math.min(timingStats.averageDelay * 0.5, 100) : 0;
        timing += adjustment;
        if (adjustment !== 0) {
            appLog(`⚡ Timing adjusted by ${adjustment.toFixed(1)}ms based on stats`);
        }
    }
    
    appLog(`🕰️ getCurrentTiming: mode=${mode}, rcKey=${rcKey}, timing=${timing}ms`);
    return Math.max(100, timing); // Minimum 100ms
}

async function optimizedConnectionPoolMaintenance() {
    if (poolMaintenanceInProgress) {
        return;
    }
    
    try {
        poolMaintenanceInProgress = true;
        const now = Date.now();
        
        const initialPoolSize = connectionPool.length;
        for (let i = connectionPool.length - 1; i >= 0; i--) {
            const conn = connectionPool[i];
            const age = now - conn.createdAt;
            const idleTime = now - conn.lastUsed;
            
            if (age > CONNECTION_MAX_AGE || idleTime > CONNECTION_IDLE_TIMEOUT || 
                (conn.state !== CONNECTION_STATES.HASH_RECEIVED && conn.state !== CONNECTION_STATES.READY) || !conn.registrationData) {
                await conn.cleanup();
                connectionPool.splice(i, 1);
            }
        }
        
        const healthyConnections = connectionPool.filter(conn => 
            conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData && now - conn.lastUsed < CONNECTION_IDLE_TIMEOUT);
        
        if (healthyConnections.length < POOL_TARGET_SIZE) {
            const needed = Math.min(POOL_TARGET_SIZE - healthyConnections.length, POOL_MAX_SIZE - connectionPool.length);
            if (needed > 0) {
                await createPoolConnections(needed);
            }
        }
        
    } catch (err) {
    //    appLog("Error in connection pool maintenance:", err);
    } finally {
        poolMaintenanceInProgress = false;
    }
}

async function createPoolConnections(count) {
    const creationPromises = [];
    
    for (let i = 0; i < count; i++) {
        const conn = await createConnection();
        creationPromises.push((async () => {
            try {
                await conn.initialize(true);
                if (conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData) {
                    connectionPool.push(conn);
                    return true;
                } else {
                    await conn.cleanup();
                    return false;
                }
            } catch (error) {
            //    appLog(`❌ Failed to create pool connection:`, error.message || error);
                await conn.cleanup();
                return false;
            }
        })());
    }
    
    const results = await Promise.allSettled(creationPromises);
    const successful = results.filter(r => r.status === 'fulfilled' && r.value).length;
}

async function optimizedPrisonPoolMaintenance() {
    if (prisonMaintenanceInProgress) {
        return;
    }
    
    try {
        prisonMaintenanceInProgress = true;
        const now = Date.now();
        
        const initialSize = prisonConnectionPool.length;
        for (let i = prisonConnectionPool.length - 1; i >= 0; i--) {
            const conn = prisonConnectionPool[i];
            const age = now - conn.createdAt;
            const idleTime = now - conn.lastUsed;
            
            if (age > PRISON_CONNECTION_MAX_AGE || idleTime > CONNECTION_IDLE_TIMEOUT || 
                (conn.state !== CONNECTION_STATES.HASH_RECEIVED && conn.state !== CONNECTION_STATES.READY) || !conn.registrationData) {
                await conn.cleanup();
                prisonConnectionPool.splice(i, 1);
            }
        }
        
        const healthyPrisonConnections = prisonConnectionPool.filter(conn => 
            conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData);
        
        if (healthyPrisonConnections.length < PRISON_POOL_TARGET_SIZE) {
            const needed = Math.min(PRISON_POOL_TARGET_SIZE - healthyPrisonConnections.length, PRISON_POOL_MAX_SIZE - prisonConnectionPool.length);
            if (needed > 0) {
                await createPrisonConnections(needed);
            }
        }
        
    } catch (err) {
    //    appLog("Error in prison pool maintenance:", err);
    } finally {
        prisonMaintenanceInProgress = false;
    }
}

async function createPrisonConnections(count) {
    const creationPromises = [];
    
    for (let i = 0; i < count; i++) {
        const conn = await createConnection();
        conn.isPrisonConnection = true;
        creationPromises.push((async () => {
            try {
                await conn.initialize(true);
                if (conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData) {
                    prisonConnectionPool.push(conn);
                    return true;
                } else {
                    await conn.cleanup();
                    return false;
                }
            } catch (error) {
            //    appLog(`❌ Failed to create PRISON connection:`, error.message || error);
                await conn.cleanup();
                return false;
            }
        })());
    }
    
    const results = await Promise.allSettled(creationPromises);
    const successful = results.filter(r => r.status === 'fulfilled' && r.value).length;
}

async function getPrisonConnection() {
//    appLog(`Getting PRISON connection from dedicated pool...`);
    const warmPrisonConnections = prisonConnectionPool.filter(conn => conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData);
    
    if (warmPrisonConnections.length > 0) {
        let newestIdx = -1;
        let newestTime = 0;
        for (let i = 0; i < prisonConnectionPool.length; i++) {
            const conn = prisonConnectionPool[i];
            if (conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData && conn.createdAt > newestTime) {
                newestTime = conn.createdAt;
                newestIdx = i;
            }
        }
        
        if (newestIdx !== -1) {
            const chosenConn = prisonConnectionPool[newestIdx];
            prisonConnectionPool.splice(newestIdx, 1);
        //    appLog(`⚡ Using PRISON connection from dedicated pool (pool size now: ${prisonConnectionPool.length}/${PRISON_POOL_MAX_SIZE})`);
            try {
                originalConsoleLog('prisonWarmActivation'); // Keep console.time for performance measurement
                await chosenConn.activateWarmConnection();
                activeConnection = chosenConn;
                Promise.resolve().then(() => optimizedPrisonPoolMaintenance().catch(err => appLog("Error re-warming prison pool:", err)));
                return chosenConn;
            } catch (error) {
            //    appLog("Failed to activate PRISON connection:", error.message || error);
                await chosenConn.cleanup();
                throw error;
            } finally {
                originalConsoleLog('prisonWarmActivation'); // Keep console.timeEnd for performance measurement
            }
        }
    }
    
//    appLog("No PRISON connections available, falling back to regular pool");
    return getConnection(true);
}

async function getConnection(activateFromPool = true, skipCloseTimeCheck = false) {
    if (currentConnectionPromise) {
        return currentConnectionPromise;
    }
 
    currentConnectionPromise = new Promise(async (resolve, reject) => {
        try {
            const now = Date.now();
            if (!skipCloseTimeCheck && now - lastCloseTime < 1000) {
                const waitTime = 2000 - (now - lastCloseTime);
            //    appLog(`Waiting ${waitTime}ms before attempting to get new connection (due to lastCloseTime)`);
                await new Promise(res => setTimeout(res, waitTime));
            }
 
           // appLog(`Getting connection (activateFromPool: ${activateFromPool})...`);
            if (activeConnection && activeConnection.state === CONNECTION_STATES.READY &&
                activeConnection.socket && activeConnection.socket.readyState === WebSocket.OPEN) {
             //   appLog(`Reusing existing active connection ${activeConnection.botId}`);
                activeConnection.lastUsed = Date.now();
                resolve(activeConnection);
                return;
            }
            
            // Ensure no active connection is in the process of closing
            if (activeConnection) {
            //    appLog(`Waiting for active connection ${activeConnection.botId} to fully close...`);
                await activeConnection.cleanupPromise;
                activeConnection = null;
            }
            
            if (activateFromPool) {
                const healthyConnections = connectionPool.filter(conn =>
                    conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData && Date.now() - conn.lastUsed < CONNECTION_IDLE_TIMEOUT);
                
                if (healthyConnections.length > 0) {
                    healthyConnections.sort((a, b) => b.createdAt - a.createdAt);
                    const chosenConn = healthyConnections[0];
                    const poolIndex = connectionPool.indexOf(chosenConn);
                    if (poolIndex !== -1) {
                        connectionPool.splice(poolIndex, 1);
                    //    appLog(`⚡ Using connection from pool (pool size now: ${connectionPool.length}/${POOL_MAX_SIZE})`);
                        try {
                            originalConsoleLog('connectionActivation'); // Keep console.time for performance measurement
                            await chosenConn.activateWarmConnection();
                            activeConnection = chosenConn;
                            if (connectionPool.length < POOL_MIN_SIZE) {
                            //    appLog(`Pool running low (${connectionPool.length}), triggering maintenance`);
                                Promise.resolve().then(() => optimizedConnectionPoolMaintenance().catch(err => appLog("Error in triggered pool maintenance:", err)));
                            }
                            resolve(chosenConn);
                            return;
                        } catch (error) {
                        //    appLog("Failed to activate pool connection:", error.message || error);
                            await chosenConn.cleanup();
                        } finally {
                            originalConsoleLog('connectionActivation'); // Keep console.timeEnd for performance measurement
                        }
                    }
                }
            }
            
        //    appLog("Creating new connection (pool unavailable or disabled)");
            const newConn = await createConnection();
            try {
                originalConsoleLog('newConnectionCreation'); // Keep console.time for performance measurement
                await newConn.initialize(false);
                activeConnection = newConn;
                Promise.resolve().then(() => optimizedConnectionPoolMaintenance().catch(err => appLog("Error in post-creation maintenance:", err)));
                resolve(newConn);
            } catch (error) {
               // appLog("Failed to create new connection:", error.message || error);
                await newConn.cleanup();
                reject(error);
            } finally {
                originalConsoleLog('newConnectionCreation'); // Keep console.timeEnd for performance measurement
            }
        } catch (err) {
            reject(err);
        } finally {
            currentConnectionPromise = null; // Reset after the promise settles
        }
    });
 
    return currentConnectionPromise;
}

async function getMonitoringConnection() {
    return getConnection(false);
}


async function createConnection() {
    // Add 500ms pause between RC switches for dual RC mode
    if (config.dualRCToggle && lastRCSwitch > 0) {
        const timeSinceSwitch = Date.now() - lastRCSwitch;
        if (timeSinceSwitch < 500) {
            await new Promise(resolve => setTimeout(resolve, 500 - timeSinceSwitch));
        }
    }
    
    const rcKey = getNextRC();
    const rcValue = config[rcKey];
   appLog(`Creating new connection instance with ${rcKey}: ${rcValue}`);
    const conn = {
        socket: null,
        state: CONNECTION_STATES.CLOSED,
        hash: null,
        botId: null,
        password: null,
        nick: null,
        lastUsed: Date.now(),
        authenticating: false,
        initPromise: null,
        reconnectAttempt: 0,
        createdAt: Date.now(),
        connectionTimeout: null,
        registrationData: null,
        prisonState: 'IDLE',
        prisonTimeout: null,
        currentPrisonTimeout: null,
        userCommandRetryCount: 0,
        recoveryCode: rcValue,
        rcKey: rcKey,
        cleanupResolve: null,
        cleanupPromise: null,
        lastActionCommand: null, // Track last action command
        lastMoveCommandTime: 0, // New property to track last move command time
        attackTimingState: { currentTime: null, lastMode: null, consecutiveErrors: 0 }, // Per-connection timing state, will be synced with global
        defenseTimingState: { currentTime: null, lastMode: null, consecutiveErrors: 0 }, // Per-connection timing state, will be synced with global
        
        send: function(str) {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(str + "\r\n");
                return true;
            } else {
            //    appLog(`Cannot send [${this.botId || 'connecting'}]: Socket not open (state: ${this.state})`);
                return false;
            }
        },
        
        initialize: function(stopAtHash = false) {
            if (this.initPromise) return this.initPromise;
            
            this.initPromise = new Promise((resolve, reject) => {
                try {
                    if (this.socket) this.cleanup();
                    this.state = CONNECTION_STATES.CONNECTING;
                    this.authenticating = true;
                    this.connectionStartTime = Date.now(); // Track connection start time
                   // appLog(`Initializing new connection with ${this.rcKey}: ${this.recoveryCode} (stopAtHash: ${stopAtHash})...`);
                    
                    // Check circuit breaker before attempting connection
                    if (!shouldAttemptConnection()) {
                        reject(new Error("Circuit breaker active - too many connection failures"));
                        return;
                    }
                    
                    this.socket = new WebSocket("wss://cs.mobstudio.ru:6672/", { 
                        rejectUnauthorized: false, 
                        handshakeTimeout: HANDSHAKE_TIMEOUT 
                    });
                    this.connectionTimeout = setTimeout(() => {
                        appLog("Connection initialization timeout");
                        updateConnectionHealth(this, false, Date.now() - this.connectionStartTime);
                        recordConnectionFailure();
                        this.authenticating = false;
                        this.cleanup();
                        reject(new Error("Connection initialization timeout"));
                    }, CONNECTION_TIMEOUT);
                    
                    this.socket.on('open', () => {
                        this.state = CONNECTION_STATES.CONNECTED;
                    //    appLog("WebSocket connected, initializing identity");
                        this.send(":ru IDENT 352 -2 4030 1 2 :GALA");
                        initializeTimingStates(this); // Initialize timing states for this connection from global
                    });
                    
                    this.socket.on('message', async (data) => {
                        const message = data.toString().trim();
                        if (stopAtHash && this.state === CONNECTION_STATES.HASH_RECEIVED) {
                            if (message.startsWith("REGISTER")) {
                            //    appLog("Storing registration data for later activation");
                                this.registrationData = message;
                                clearTimeout(this.connectionTimeout);
                                this.authenticating = false;
                                resolve(this);
                                return;
                            }
                        }
                        await this.handleMessage(message, resolve, reject, stopAtHash);
                    });
                    
                    this.socket.on('close', () => {
                //    appLog(`WebSocket [${this.botId || 'connecting'}] closed (state: ${this.state})`);
                    if (this.authenticating) {
                        this.authenticating = false;
                        clearTimeout(this.connectionTimeout);
                        reject(new Error("Connection closed during authentication"));
                    }
                    this.state = CONNECTION_STATES.CLOSED;
                    if (this.cleanupResolve) {
                        this.cleanupResolve();
                        this.cleanupResolve = null;
                        this.cleanupPromise = null;
                    }
                    const index = connectionPool.indexOf(this);
                    if (index !== -1) connectionPool.splice(index, 1);
                    if (this === activeConnection) {
                        appLog("Active connection closed");
                        activeConnection = null;
                    }
                    lastCloseTime = Date.now(); // Added here
                });
                    
                    this.socket.on('error', (error) => {
                    //    appLog(`WebSocket [${this.botId || 'connecting'}] error:`, error.message || error);
                        recordConnectionFailure();
                        if (this.authenticating) {
                            this.authenticating = false;
                            clearTimeout(this.connectionTimeout);
                            reject(error);
                        }
                    });
                } catch (err) {
                //    appLog("Error during connection initialization:", err);
                    clearTimeout(this.connectionTimeout);
                    this.authenticating = false;
                    reject(err);
                }
            }).finally(() => this.initPromise = null);
            
            return this.initPromise;
        },
        
        handleMessage: async function(message, resolve, reject, stopAtHash = false) {
            try {
                this.lastReceivedMessage = message;
                
                const prisonWords = ["PRISON", "Prison", "Тюрьма"];
                if (prisonWords.some(word => message.split(/\s+/).includes(word))) {
                 //   appLog(`🔒 Exact prison keyword detected: "${message}"`);
                    handlePrisonAutomation(this);
                    return;
                }
                
                const colonIndex = message.indexOf(" :");
                let payload = colonIndex !== -1 ? message.substring(colonIndex + 2) : "";
                const parts = message.split(/\s+/);
                let command = parts[0];
                let commandIndex = 0;
                
                if (parts[0].startsWith(':') && parts.length > 1) {
                    command = parts[1];
                    commandIndex = 1;
                }
                
                switch (command) {
                    case "PRIVMSG":
                        if (config.aiChatToggle) {
                            // Example message: :<sender_nick> PRIVMSG <target_id> <flag> <sender_id> :<message_content>
                            // Or: PRIVMSG <target_id> <flag> <sender_id> :<message_content>
                            // Based on user's example: PRIVMSG 14358744 1 54531773 :`[R]OLE[X]`, hi
                            
                            // parts[0] = PRIVMSG
                            // parts[1] = targetId (our bot's ID)
                            // parts[2] = flag (e.g., 1)
                            // parts[3] = senderId (user's ID)
                            // parts[4] = :`[R]OLE[X]`, hi (start of message content, including the leading colon)
                            
                            if (parts.length >= 5) {
                                const targetId = parts[3]; // Our bot's ID
                                const senderId = parts[1]; // The user ID who sent the message
                                
                                // Only process if the message is for our bot and not from our bot itself
                                if (targetId === this.botId && senderId !== this.botId) {
                                    // Reconstruct the full message content starting from the colon after senderId
                                    const messageContentStartIndex = message.indexOf(':', message.indexOf(senderId)) + 1;
                                    const fullMessageContent = message.substring(messageContentStartIndex).trim();
                                    
                                    let question = fullMessageContent;
                                    // Check if the message starts with the specific username format and remove it
                                    const usernamePrefix = '`[R]OLE[X]`, ';
                                    if (question.startsWith(usernamePrefix)) {
                                        question = question.substring(usernamePrefix.length).trim();
                                    }
                                    
                                    if (question) {
                                        getMistralChatResponse(question)
                                            .then(aiResponse => {
                                                const responseMessage = `PRIVMSG 0 0 :${aiResponse}`;
                                               setTimeout(() => {
                                                   this.send(responseMessage);
                                               }, 200); // 200ms delay for AI chat response
                                            })
                                            .catch(error => {
                                            //    appLog(`AI Chat Error: ${error.message}`);
                                            });
                                    }
                                }
                            }
                        }
                        break;
                    case "PING":
                        this.send("PONG");
                        break;
                    case "HAAAPSI":
                        if (parts.length >= commandIndex + 2) {
                            const code = parts[commandIndex + 1];
                            this.hash = genHash(code);
                         //   appLog(`Generated hash [${this.botId || 'connecting'}]: ${this.hash}`);
                            this.send(`RECOVER ${this.recoveryCode}`);
                            this.state = CONNECTION_STATES.HASH_RECEIVED;
                            if (stopAtHash) appLog(`connection reached state`);
                        }
                        break;
                    case "REGISTER":
                        if (parts.length >= commandIndex + 4) {
                            this.botId = parts[commandIndex + 1];
                            this.password = parts[commandIndex + 2];
                            this.nick = parts[commandIndex + 3];
                            if (stopAtHash) {
                                this.registrationData = message;
                            //    appLog(`Stored registration data for warm pool connection [${this.botId}]`);
                                clearTimeout(this.connectionTimeout);
                                this.authenticating = false;
                                resolve(this);
                                return;
                            }
                            if (this.hash) {
                                this.send(`USER ${this.botId} ${this.password} ${this.nick} ${this.hash}`);
                                this.send(":ru IDENT 352 -2 4030 1 2 :GALA");
                                this.send(`RECOVER ${this.recoveryCode}`);
                            //    appLog(`Authenticated with USER command [${this.botId}]`);
                            }
                        }
                        break;
                    case "999":
                        this.state = CONNECTION_STATES.AUTHENTICATED;
                        const connectionStartTime = this.connectionStartTime || Date.now();
                        const connectionTime = Date.now() - connectionStartTime;
                        
                        // Update connection health - successful connection
                        updateConnectionHealth(this, true, connectionTime);
                        connectionFailureCount = 0; // Reset failure count on success
                        
                    //    appLog(`Connection [${this.botId}] authenticated, sending setup commands...`);
                        if (this.socket && this.socket.readyState === WebSocket.OPEN) this.send("FWLISTVER 0");
                        if (this.socket && this.socket.readyState === WebSocket.OPEN) this.send("ADDONS 0 0");
                        if (this.socket && this.socket.readyState === WebSocket.OPEN) this.send("MYADDONS 0 0");
                        if (this.socket && this.socket.readyState === WebSocket.OPEN) this.send("PHONE 0 0 0 2 :Node.js");
                        if (this.socket && this.socket.readyState === WebSocket.OPEN) this.send("JOIN");
                        this.state = CONNECTION_STATES.READY;
                        this.authenticating = false;
                        this.userCommandRetryCount = 0;
                        
                        // CRITICAL: Immediately check for existing rivals after connection is ready
                        setTimeout(() => {
                            if (this.socket && this.socket.readyState === WebSocket.OPEN && this.state === CONNECTION_STATES.READY) {
                                this.send("WHO");
                                appLog(`🔍 Auto-sent WHO after connection ready to detect existing rivals`);
                            }
                        }, 300);
                        
                        if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
                        appLog(`📊 Connection [${this.botId}] READY - Health: ${getConnectionHealthSummary(this)}`);
                        resolve(this);
                        break;
                    case "353":
                        parse353(message, this);
                        break;
                    case "JOIN":
                        handleJoinCommand(parts, this);
                        break;
                    case "PART":
                        if (parts.length >= commandIndex + 2) {
                            const userId = parts[commandIndex + 1];
                            let userName = null;
                            for (const [name, id] of userMap.entries()) {
                                if (id === userId) {
                                    userName = name;
                                    break;
                                }
                            }
                            if (userName) {
                                handleRivalDeparture(userId, userName);
                            }
                            remove_user(userName || userId);
                        }
                        break;
                    case "SLEEP":
                        if (parts.length >= commandIndex + 2) {
                            const userId = parts[commandIndex + 1];
                            let userName = null;
                            for (const [name, id] of userMap.entries()) {
                                if (id === userId) {
                                    userName = name;
                                    break;
                                }
                            }
                            if (userName) {
                                handleRivalDeparture(userId, userName);
                            }
                        }
                        break;
                    case "KICK":
                    //    appLog(`🔓 KICK command detected: ${message}`);
                        if (parts.length >= commandIndex + 3) {
                            const kickedUserId = parts[commandIndex + 2];
                            const isReleasedFromPrison = message.toLowerCase().includes("released") || message.toLowerCase().includes("освободили");
                            if (isReleasedFromPrison) {
                                appLog(`🎉 Bot ${this.botId} was released from prison - Simple release process`);
                                
                                // Simple sequential approach - no fast relogin
                                this.prisonState = 'IDLE';
                                
                                // Reset all flags for clean state
                                isProcessingRivalAction = false;
                                isReconnectingAfterRivalAction = false;
                                monitoringMode = true;
                                currentMode = null;
                                
                                // Clear any pending timeouts
                                if (processingRivalTimeout) {
                                    clearTimeout(processingRivalTimeout);
                                    processingRivalTimeout = null;
                                }
                                
                                // Clear existing rival tracking
                                trackedRivals.clear();
                                
                                // CRITICAL: Parallel task for rejoining planet after prison release
                                const parallelTasks = [];
                                
                                const joinTask = new Promise((resolve, reject) => {
                                    let joinAttempts = 0;
                                    const maxJoinAttempts = 10;
                                    
                                    const attemptJoin = () => {
                                        joinAttempts++;
                                        appLog(`🌍 JOIN attempt ${joinAttempts}/${maxJoinAttempts} for ${this.botId}`);
                                        
                                        const kickListener = (event) => {
                                            const message = event.data.toString().trim();
                                            
                                            // Process 353 messages during JOIN attempts
                                            if (message.includes("353")) {
                                                parse353(message, this);
                                                appLog(`🔍 Processed 353 during prison release JOIN`);
                                            }
                                            
                                            if (message.includes("KICK") && message.includes("Нельзя перелетать чаще одного раза в 3 с.")) {
                                                appLog(`🚫 3-second rule detected on ${joinAttempts}`);
                                                if (this.socket) {
                                                    this.socket.removeEventListener('message', kickListener);
                                                }
                                                if (joinAttempts < maxJoinAttempts) {
                                                    setTimeout(() => {
                                                        attemptJoin();
                                                    }, 200);
                                                } else {
                                                    appLog(`❌ Max attempts (${maxJoinAttempts}) reached for ${this.botId}`);
                                                    reject(new Error(`Failed after ${maxJoinAttempts} attempts due to 3-second rule`));
                                                }
                                            } else if (message.includes("JOIN") && !message.includes("KICK")) {
                                                appLog(`✅ Successful JOIN for ${this.botId} on attempt ${joinAttempts}`);
                                                if (this.socket) {
                                                    this.socket.removeEventListener('message', kickListener);
                                                }
                                                resolve('join_complete');
                                            }
                                        };
                                        
                                        if (this.socket) {
                                            this.socket.addEventListener('message', kickListener);
                                        } else {
                                            reject(new Error("Socket is null during JOIN attempt"));
                                            return;
                                        }
                                        
                                        setTimeout(() => {
                                            this.send(`JOIN ${config.planetName}`);
                                            appLog(`🚀 JOIN ${config.planetName} command sent for ${this.botId} (attempt ${joinAttempts})`);
                                            
                                            setTimeout(() => {
                                                if (joinAttempts === maxJoinAttempts) {
                                                    this.socket.removeEventListener('message', kickListener);
                                                    resolve('join_timeout');
                                                }
                                            }, 5000);
                                        }, joinAttempts === 1 ? 2000 : 100);
                                    };
                                    
                                    attemptJoin();
                                });
                                parallelTasks.push(joinTask);
                                
                                // Execute parallel tasks
                                Promise.allSettled(parallelTasks).then((results) => {
                                    appLog(`🔄 Prison release tasks completed for ${this.botId}:`, results.map(r => r.value || r.reason?.message));
                                    
                                    // Send WHO command after tasks complete
                                    setTimeout(() => {
                                        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                                            this.send("WHO");
                                            appLog(`🔍 Sent WHO to detect existing rivals after prison release`);
                                        }
                                    }, 100);
                                });
                                
                                appLog(`✅ Prison release completed - Bot will rejoin planet and resume normal operation`);
                            }
                        }
                        break;
                    case "451":
                        // Update connection health - failed connection
                        updateConnectionHealth(this, false, Date.now() - (this.connectionStartTime || Date.now()));
                        
                     //   appLog(`Critical error 451 [${this.botId || 'connecting'}]: ${message}`);
                        if (this.authenticating) {
                            this.authenticating = false;
                            clearTimeout(this.connectionTimeout);
                            this.cleanup();
                        //    appLog(`⚡ Got 451 error, trying immediate recovery...`);
                            reject(new Error(`Critical error 451`));
                            Promise.resolve().then(() => getConnection(true).catch(err => appLog(`Failed after 451 error:`, err)));
                            return;
                        }
                        this.cleanup();
                        break;
                    case "452":
                        // Update connection health - failed connection (only on final failure)
                        if (this.userCommandRetryCount >= 10) {
                            updateConnectionHealth(this, false, Date.now() - (this.connectionStartTime || Date.now()));
                        }
                        
                    //    appLog(`Critical error 452 [${this.botId || 'connecting'}]: ${message}`);
                        if (this.authenticating && this.userCommandRetryCount < 10) {
                            this.userCommandRetryCount++;
                        //    appLog(`Retrying command (attempt ${this.userCommandRetryCount}/10) [${this.botId}]`);
                            if (this.botId && this.password && this.nick && this.hash) {
                                this.send(`USER ${this.botId} ${this.password} ${this.nick} ${this.hash}`);
                            } else {
                            //    appLog(`Cannot retry command: missing required data [${this.botId}]`);
                                this.authenticating = false;
                                clearTimeout(this.connectionTimeout);
                                this.cleanup();
                                reject(new Error(`Critical error 452 and missing data for retry`));
                            }
                        } else if (this.authenticating) {
                            this.authenticating = false;
                            clearTimeout(this.connectionTimeout);
                            this.cleanup();
                            const index = connectionPool.indexOf(this);
                            if (index !== -1) connectionPool.splice(index, 1);
                            if (this === activeConnection) {
                                activeConnection = null;
                            }
                        //    appLog(`⚡ Got 452 error after ${this.userCommandRetryCount} retries, closed connection, removed from pool, and trying recovery with 10-second backoff...`);
                            reject(new Error(`Critical error 452 after retries`));
                            return;
                        } else {
                            this.cleanup();
                        }
                        break;
                    case "850":
                        if (payload.includes("3 секунд(ы)") || payload.includes("Нельзя")) {
                            appLog(`⚡ 3-second rule detected. Immediate Exit and re-evaluation.`);
                            
                            // CRITICAL: Reset processing flags immediately
                            isProcessingRivalAction = false;
                            if (processingRivalTimeout) {
                                clearTimeout(processingRivalTimeout);
                                processingRivalTimeout = null;
                            }
                            
                            this.send("QUIT :ds");
                            await this.cleanup(); // Ensure connection is fully closed
                             if (activeConnection === this) {
                                 activeConnection = null;
                             }
                            // Now proceed with the original 850 handling logic for timing adjustment and reconnection
                            appLog(`3s notification detected in mode: ${currentMode}`);
                            if (currentMode === 'attack' || currentMode === 'defence') {
                                const newTiming = incrementTiming(currentMode, this, '3second');
                                appLog(`Adjusted ${currentMode} timing due to 3-second rule: ${newTiming}ms`);
                            } else {
                                appLog(`3s notification but no active mode, current mode: ${currentMode}`);
                            }
                            // Trigger reconnection after handling the 850 error
                           // Promise.resolve().then(() => getConnection(true, true).catch(err => appLog(`Failed after 850 error:`, err)));
                            return; // Exit handleMessage after immediate QUIT and re-evaluation
                        } else {
                            // CRITICAL: Reset processing flags for successful kick too
                            isProcessingRivalAction = false;
                            if (processingRivalTimeout) {
                                clearTimeout(processingRivalTimeout);
                                processingRivalTimeout = null;
                            }
                            
                            this.send("QUIT :ds");
                            await this.cleanup(); // Ensure connection is fully closed
                             if (activeConnection === this) {
                                 activeConnection = null;
                             }
                            appLog(`⚡⚡KICKED Rival in mode: ${currentMode} - ${payload}`);
                            if (currentMode === 'attack' || currentMode === 'defence') {
                                const newTiming = incrementTiming(currentMode, this, 'success');
                                appLog(`Adjusted ${currentMode} timing due to kick: ${newTiming}ms`);
                                
                            }
                        }
                        break;
                    case "FOUNDER":
                        if (parts.length >= commandIndex + 2) {
                            const founderId = parts[commandIndex + 1];
                            founderIds.add(founderId);
                        }
                        break;
                    case "854": // Capture last action command
                        if (parts.length >= 2) {
                            this.lastActionCommand = parts[1];
                        }
                        break;
                }
                
                if (this.prisonState === 'WAITING_FOR_BROWSER_MESSAGE' && message.startsWith("BROWSER 1")) {
                    const urlMatch = message.match(/https:\/\/galaxy\.mobstudio\.ru\/services\/\?a=jail_info&usercur=(\d+)&/);
                    if (urlMatch && urlMatch[1] === this.botId) {
                    //    appLog(`Received message for jail: ${message}`);
                        if (this.prisonTimeout) clearTimeout(this.prisonTimeout);
                        performJailFreeWithRetry(this, 3, 500).then(() => {
                        //    appLog(`Jail free completed for ${this.botId}, waiting for message...`);
                            this.prisonState = 'WAITING_FOR_KICK';
                        }).catch(error => {
                        //    appLog(`Error in jail_free for ${this.botId}:`, error);
                            this.prisonState = 'IDLE';
                        });
                    }
                }
            } catch (err) {
            //    appLog(`Error handling message [${this.botId || 'connecting'}]:`, err);
                if (this.authenticating) {
                    this.authenticating = false;
                    clearTimeout(this.connectionTimeout);
                    reject(err);
                }
            }
        },
        
        activateWarmConnection: function() {
            return new Promise((resolve, reject) => {
                try {
                    if (this.state !== CONNECTION_STATES.HASH_RECEIVED || !this.registrationData) {
                        reject(new Error("Cannot activate connection that isn't properly warmed up"));
                        return;
                    }
                //    appLog(`⚡ Fast-activating connection [${this.botId || 'pending'}] with ${this.rcKey}...`);
                    this.authenticating = true;
                    this.connectionTimeout = setTimeout(() => {

                        this.authenticating = false;
                        reject(new Error("Connection activation timeout"));
                    }, 2000);
    
                    const parts = this.registrationData.split(/\s+/);
                    if (parts.length >= 4) {
                        this.botId = parts[1];
                        this.password = parts[2];
                        this.nick = parts[3];
                        if (this.hash) {
                            let authenticationComplete = false;
    
                            let authHandler = (event) => {
                                const message = event.data.toString().trim();
                                if (message.startsWith("999") && !authenticationComplete) {
                                    authenticationComplete = true;
                                    if (this.socket) {
                                        this.socket.removeEventListener('message', authHandler);
                                    }
                                    
                                    this.state = CONNECTION_STATES.AUTHENTICATED;
                                 //   appLog(`⚡ Warm connection [${this.botId}] authenticated, sending setup commands...`);
                                    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.send("FWLISTVER 0");
                                    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.send("ADDONS 0 0");
                                    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.send("MYADDONS 0 0");
                                    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.send("PHONE 0 0 0 2 :Node.js");
                                    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.send("JOIN");
                                    this.state = CONNECTION_STATES.READY;
                                    this.authenticating = false;
                                    this.userCommandRetryCount = 0;
                                    // reconnectAttempt = 0; // Keep reconnectAttempt continuous for alternating backoff
                                    
                                    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
                                //    appLog(`✅ Warm connection [${this.botId}] SUCCESSFULLY activated and READY`);
                                    
                                    initializeTimingStates(this); // Initialize timing states for this connection from global
                                    resolve(this);
                                }
                            };
    
                            if (this.socket) {
                                this.socket.addEventListener('message', authHandler);
                            } else {
                                reject(new Error("Socket is null during activation"));
                                return;
                            }
                            
                            this.send(`USER ${this.botId} ${this.password} ${this.nick} ${this.hash}`);
                        //    appLog(`Activated warm connection with USER command [${this.botId}]`);
                        } else {
                            reject(new Error("No hash available for activation"));
                        }
                    } else {
                        reject(new Error("Invalid registration data for activation"));
                    }
                } catch (err) {
                //    appLog("Error during warm connection activation:", err);
                    this.authenticating = false;
                    clearTimeout(this.connectionTimeout);
                    reject(err);
                }
            });
        },
        
        cleanup: function(sendQuit = false) {
            if (this.cleanupPromise) return this.cleanupPromise;
            
            this.cleanupPromise = new Promise((resolve) => {
                this.cleanupResolve = resolve;
                try {
                    if (this.socket) {
                        if (sendQuit && this.socket.readyState === WebSocket.OPEN) {
                            this.send("QUIT :ds");
                        }
                        setTimeout(() => {
                            if (this.socket) this.socket.terminate();
                        }, 100);
                    } else {
                        this.state = CONNECTION_STATES.CLOSED;
                        resolve();
                    }
                    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
                    if (this.prisonTimeout) clearTimeout(this.prisonTimeout);
                    if (this.currentPrisonTimeout) clearTimeout(this.currentPrisonTimeout);
                    this.socket = null;
                    this.authenticating = false;
                } catch (err) {
                //    appLog(`Error in cleanup [${this.botId || 'connecting'}]:`, err);
                    resolve(); // Resolve even on error to avoid hanging
                }
            });
            return this.cleanupPromise;
        }
    };
    return conn;
    }

function scheduleRivalKick(rivalId, rivalData) {
    const waitTime = getCurrentTiming(rivalData.mode, rivalData.connection);
    const presenceCheckTime = Math.max(0, waitTime - 200);
    
    // High precision scheduling
    const scheduleTime = getHighPrecisionTime();
    rivalData.scheduledTime = scheduleTime + waitTime;
    
    appLog(`📅 Scheduling rival ${rivalData.name} (${rivalData.mode}) - Wait: ${waitTime}ms, Check: ${presenceCheckTime}ms`);
    
    // Validate timing values
    if (!waitTime || waitTime <= 0) {
        appLog(`❌ Invalid wait time ${waitTime}ms for rival ${rivalData.name}, using default 2000ms`);
        const defaultWaitTime = 2000;
        const defaultCheckTime = Math.max(0, defaultWaitTime - 200);
        
        rivalData.presenceCheckTimeout = setTimeout(() => {
            checkRivalPresence(rivalId, rivalData);
        }, defaultCheckTime);
        
        rivalData.kickTimeout = setTimeout(() => {
            executeRivalKick(rivalId, rivalData);
        }, defaultWaitTime);
        return;
    }
    
    // High precision scheduling with drift correction
    const adjustedPresenceTime = presenceCheckTime - timingDriftCorrection;
    const adjustedWaitTime = waitTime - timingDriftCorrection;
    
    rivalData.presenceCheckTimeout = setTimeout(() => {
        checkRivalPresence(rivalId, rivalData);
    }, Math.max(0, adjustedPresenceTime));
    
    rivalData.kickTimeout = setTimeout(() => {
        const actualTime = getHighPrecisionTime();
        const expectedTime = rivalData.scheduledTime;
        updateTimingStats(actualTime, expectedTime);
        executeRivalKick(rivalId, rivalData);
    }, Math.max(0, adjustedWaitTime));
}

function checkRivalPresence(rivalId, rivalData) {
    if (!trackedRivals.has(rivalId)) {
        return; // Rival already removed
    }
    
    appLog(`🔍 Checking presence of rival ${rivalData.name} before kick...`);
    // The rival is still tracked, so they haven't left yet
    // The kick will proceed as scheduled
}

function executeRivalKick(rivalId, rivalData) {
    if (!trackedRivals.has(rivalId)) {
        cleanupRivalTracking(rivalId);
        return;
    }
    
    // CRITICAL: Atomic check and set to prevent race conditions
    if (isProcessingRivalAction) {
        appLog(`⚠️ Rival action already in progress, skipping ${rivalData.name}`);
        cleanupRivalTracking(rivalId);
        return;
    }
    
    // Clean up tracking BEFORE setting processing flag to prevent stuck state
    cleanupRivalTracking(rivalId);
    
    isProcessingRivalAction = true;
    appLog(`⚡ Executing scheduled kick for rival ${rivalData.name}`);
    
    processingRivalTimeout = setTimeout(() => {
        if (isProcessingRivalAction) {
            appLog(`⏰ Processing timeout - resetting flags`);
            isProcessingRivalAction = false;
            processingRivalTimeout = null;
        }
    }, 2000); // Increased timeout to 2 seconds
    
    handleRivals([{ name: rivalData.name, id: rivalId, coordinate: rivalData.coordinate }], rivalData.mode, rivalData.connection);
}

function cleanupRivalTracking(rivalId) {
    const rivalData = trackedRivals.get(rivalId);
    if (rivalData) {
        if (rivalData.kickTimeout) clearTimeout(rivalData.kickTimeout);
        if (rivalData.presenceCheckTimeout) clearTimeout(rivalData.presenceCheckTimeout);
        trackedRivals.delete(rivalId);
    }
}

function handleRivalDeparture(rivalId, rivalName) {
    const rivalData = trackedRivals.get(rivalId);
    if (rivalData) {
        appLog(`🚪 Rival ${rivalName} left early, cancelling scheduled action`);
        cleanupRivalTracking(rivalId);
        // Stay on same RC without altering - no reconnection needed
        return true;
    }
    return false;
}

// Legacy processPendingRivals function removed - no longer needed

function parse353(message, connection) {
    if (message.includes('PRISON') || message.includes('Prison') || message.includes('Тюрьма')) {
        handlePrisonAutomation(connection);
        return;
    }
    
    const colonIndex = message.indexOf(" :");
    const payload = colonIndex !== -1 ? message.substring(colonIndex + 2) : "";
    
    // Use pre-compiled regex for faster parsing
    const tokens = payload.match(REGEX_PATTERNS.tokenSplit) || [];
    let i = 0;
    let detectedRivals = [];
    
    while (i < tokens.length) {
        let token = tokens[i];
        if (token === '-') {
            i++;
            continue;
        }
        
        let name = token;
        if (token.length > 1 && REGEX_PATTERNS.namePrefix.test(token)) {
            name = token.substring(1);
        }
        
        if (name.length === 0 || name === '-' || name === '@' || name === '+') {
            i++;
            continue;
        }
        
        i++;
        
        // Fast ID validation using pre-compiled regex
        if (i < tokens.length && REGEX_PATTERNS.userId.test(tokens[i])) {
            const id = tokens[i];
            userMap.set(name, id);
            
            // Fast rival classification with caching
            const classification = classifyRival(name, id, connection);
            
            if (classification.isRival) {
                let coordinate = null;
                if (config.standOnEnemy) {
                    // Optimized coordinate search
                    for (let j = i + 1; j < Math.min(i + 10, tokens.length); j++) {
                        if (tokens[j] === '@' && j + 5 < tokens.length && REGEX_PATTERNS.coordinate.test(tokens[j + 5])) {
                            coordinate = tokens[j + 5];
                            break;
                        }
                    }
                }
                detectedRivals.push({ name, id, coordinate });
            }
            i++;
        }
    }
    
    if (detectedRivals.length > 0 && connection.state === CONNECTION_STATES.READY) {
        appLog(`🔍 Found ${detectedRivals.length} rivals for defence mode`);
        
        // Dynamic delay to allow FOUNDER commands to be processed first
        const founderCheckDelay = Math.min(200, detectedRivals.length * 20); // Max 200ms, 20ms per rival
        setTimeout(() => {
            const validRivals = detectedRivals.filter(rival => !founderIds.has(rival.id));
            if (validRivals.length > 0) {
                appLog(`🔍 Processing ${validRivals.length} non-founder rivals after ${founderCheckDelay}ms delay`);
                validRivals.forEach(rival => {
                    if (!trackedRivals.has(rival.id)) {
                        addToBatch(rival, 'defence', connection);
                    }
                });
            } else {
                appLog(`✅ All detected rivals are founders, no action needed`);
            }
        }, founderCheckDelay);
    }
}

function handleJoinCommand(parts, connection) {
    if (parts.length >= 4) {
        let name = parts.length >= 5 && REGEX_PATTERNS.userId.test(parts[3]) ? parts[2] : parts[1];
        let id = parts.length >= 5 && REGEX_PATTERNS.userId.test(parts[3]) ? parts[3] : parts[2];
        userMap.set(name, id);
        
        // Fast rival classification with caching
        const classification = classifyRival(name, id, connection);

        if (classification.isRival) {
            appLog(`Rival ${name} joined [${connection.botId}] - Attack mode activated`);
            
            let coordinate = null;
            if (config.standOnEnemy) {
                // Optimized coordinate search with regex
                for (let i = parts.length >= 5 ? 4 : 3; i < Math.min(parts.length, 15); i++) {
                    if (parts[i] === '@' && i + 5 < parts.length && REGEX_PATTERNS.coordinate.test(parts[i + 5])) {
                        coordinate = parts[i + 5];
                        break;
                    }
                }
            }
            
            // Dynamic delay to allow FOUNDER commands to be processed first
            setTimeout(() => {
                if (!founderIds.has(id) && !trackedRivals.has(id)) {
                    const rival = { name, id, coordinate };
                    addToBatch(rival, 'attack', connection);
                    appLog(`📋 Queued rival ${name} for attack mode`);
                } else if (founderIds.has(id)) {
                    appLog(`✅ ${name} is a founder, skipping attack`);
                }
            }, 150); // 150ms delay for single rival JOIN
        }
    }
}

function remove_user(user) {
    if (userMap.has(user)) {
        userMap.delete(user);
    }
}

// Clean up any orphaned rival tracking on shutdown
process.on('SIGTERM', () => {
    trackedRivals.forEach((rivalData, rivalId) => {
        cleanupRivalTracking(rivalId);
    });
});

async function performJailFreeFast(connection) {
    const userID = connection.botId;
    const password = connection.password;
    const boundary = '----WebKitFormBoundarylRahhWQJyn2QX0gB';
    const formData = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="a"',
        '',
        'jail_free',
        `--${boundary}`,
        'Content-Disposition: form-data; name="type"',
        '',
        'escapeItemDiamond',
        `--${boundary}`,
        'Content-Disposition: form-data; name="usercur"',
        '',
        userID,
        `--${boundary}`,
        'Content-Disposition: form-data; name="ajax"',
        '',
        '1',
        `--${boundary}--`
    ].join('\r\n');
    
    const url = `https://galaxy.mobstudio.ru/services/?&userID=${userID}&password=${password}&query_rand=${Math.random()}`;
    const parsedUrl = new URL(url);
    const options = {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': Buffer.byteLength(formData),
            'Accept': '*/*',
            'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
            'Priority': 'u=1, i',
            'Sec-CH-UA': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
            'Sec-CH-UA-Mobile': '?0',
            'Sec-CH-UA-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'X-Galaxy-Client-Ver': '9.5',
            'X-Galaxy-Kbv': '352',
            'X-Galaxy-Lng': 'en',
            'X-Galaxy-Model': 'chrome 137.0.0.0',
            'X-Galaxy-Orientation': 'portrait',
            'X-Galaxy-Os-Ver': '1',
            'X-Galaxy-Platform': 'web',
            'X-Galaxy-Scr-Dpi': '1',
            'X-Galaxy-Scr-H': '675',
            'X-Galaxy-Scr-W': '700',
            'X-Galaxy-User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
        }
    };
    
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
            //    appLog(`Jail free response for ${userID}:`, data);
                resolve(data);
            });
            res.on('error', (error) => {
            //    appLog(`Response error for ${userID}:`, error);
                reject(error);
            });
        });
        
        req.on('error', (error) => {
        //    appLog(`Request error performing jail_free for ${userID}:`, error.message);
            reject(error);
        });
        req.on('timeout', () => {
        //    appLog(`Request timeout for ${userID}`);
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.setTimeout(3000);
        req.write(formData);
        req.end();
    });
}

async function performJailFreeWithRetry(connection, maxRetries = 10, retryDelay = 500) {
    const userID = connection.botId;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
        //    appLog(`Jail free attempt ${attempt}/${maxRetries} for ${userID}`);
            originalConsoleLog(`jailFreeAttempt${attempt}`); // Keep console.time for performance measurement
            const result = await performJailFreeFast(connection);
            originalConsoleLog(`jailFreeAttempt${attempt}`); // Keep console.timeEnd for performance measurement
            appLog(`✅ Jail free succeeded on attempt ${attempt} for ${userID}`);
            return result;
        } catch (error) {
        //    appLog(`❌ Jail free attempt ${attempt}/${maxRetries} failed for ${userID}:`, error.message);
            if (attempt < maxRetries) {
                const delay = retryDelay * attempt;
                appLog(`⏳ Retrying jail free in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                appLog(`🚫 All jail free attempts failed for ${userID}`);
                throw new Error(`Jail free failed after ${maxRetries} attempts: ${error.message}`);
            }
        }
    }
}

async function handleRivals(rivals, mode, connection) {
    if (!connection.botId || rivals.length === 0) {
        return;
    }
    
    currentMode = mode;
    appLog(`Executing rival action in ${mode} mode [${connection.botId}]`);
    
    monitoringMode = false;
    
    // Use predefined constant for action delay

    // Select only one detected rival
    const targetRival = rivals[0];
    
    if (!targetRival) {
        return;
    }

    const id = userMap.get(targetRival.name);
    if (id) {
        // Execute actions immediately since timing was already handled by scheduler
        
        // 1. Handle first ACTION (ACTION 29) if actionOnEnemy is true and lastActionCommand is available
        if (config.actionOnEnemy && connection.lastActionCommand) {
            connection.send(`ACTION ${connection.lastActionCommand} ${id}`);
            connection.lastMoveCommandTime = Date.now();
        }
        
        // Wait for ACTION_DELAY before executing next commands
        await new Promise(resolve => setTimeout(resolve, ACTION_DELAY));
        
        // 2. Handle REMOVE if standOnEnemy is true and coordinate is available
        if (config.standOnEnemy && targetRival.coordinate) {
            connection.send(`REMOVE ${targetRival.coordinate}`);
            connection.lastMoveCommandTime = Date.now();
        }
        
        // 3. Handle second ACTION (ACTION 3) with timeout
        appLog(`Trying to Prison ${targetRival.name} (ID: ${id}) [${connection.botId}]`);
        connection.send(`ACTION 3 ${id}`);
        connection.lastMoveCommandTime = Date.now();
        
        // Set prison action timeout to prevent getting stuck
        const prisonTimeout = setTimeout(() => {
            appLog(`⏰ Prison action timeout for ${targetRival.name} - forcing cleanup`);
            isProcessingRivalAction = false;
            if (processingRivalTimeout) {
                clearTimeout(processingRivalTimeout);
                processingRivalTimeout = null;
            }
        }, 5000); // 5 second timeout
        
        // Store timeout for cleanup
        connection.currentPrisonTimeout = prisonTimeout;

    } else {
        return;
    }
    
    // Allow time for immediate server responses (like 850 errors)
    await new Promise(resolve => setTimeout(resolve, SERVER_RESPONSE_DELAY));
    
    // Clear prison timeout if we get here (normal flow)
    if (connection.currentPrisonTimeout) {
        clearTimeout(connection.currentPrisonTimeout);
        connection.currentPrisonTimeout = null;
    }

    // Check if the connection was already handled by an 850 error
    if (!activeConnection || activeConnection !== connection) {
        return; // Exit handleRivals, as 850 handler has taken over
    }

    await connection.cleanup(true);
    if (activeConnection === connection) activeConnection = null;
    
    isReconnectingAfterRivalAction = true;
    monitoringMode = false;

    appLog(`⚡ Connection ${connection.botId} closed, activating new connection`);
    try {
        const reconnectTimerLabel = `reconnectAfterAction_${Date.now()}`;
        originalConsoleLog(reconnectTimerLabel);
        // Instant reconnection using pre-warmed pool
        await getConnection(true, true);
        originalConsoleLog(reconnectTimerLabel);
    } catch (error) {
        // Log error but don't retry
    } finally {
        isProcessingRivalAction = false;
        if (processingRivalTimeout) {
            clearTimeout(processingRivalTimeout);
            processingRivalTimeout = null;
        }
        isReconnectingAfterRivalAction = false;
        monitoringMode = true;
    }
}

async function handlePrisonAutomation(connection) {
    if (connection.prisonState !== 'IDLE') {
        return;
    }
    
    try {
        connection.prisonState = 'JOINING_PRISON_CHANNEL';
        appLog(`🔒 Starting prison automation for connection ${connection.botId}`);
        connection.send(`JOIN`);
        
        if (connection.prisonState === 'JOINING_PRISON_CHANNEL') {
            connection.prisonState = 'WAITING_FOR_BROWSER_MESSAGE';
            connection.send(`ACTION 29 ${connection.botId}`);
            connection.prisonTimeout = setTimeout(() => {
                connection.prisonState = 'IDLE';
                connection.prisonTimeout = null;
            }, 3000);
        }
    } catch (error) {
        connection.prisonState = 'IDLE';
        if (connection.prisonTimeout) clearTimeout(connection.prisonTimeout);
    }
}

optimizedConnectionPoolMaintenance()
    .then(() => appLog("🚀 Optimized connection initialized"))
    .catch(err => appLog("Initial setup failed:", err));

setInterval(() => {
    if (!poolMaintenanceInProgress) {
        const healthyConnections = connectionPool.filter(conn => conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData).length;
        // Aggressively maintain pool for instant reconnections
        if (healthyConnections < POOL_TARGET_SIZE) {
            optimizedConnectionPoolMaintenance().catch(err => appLog("Pool maintenance error:", err));
        }
    }
}, POOL_HEALTH_CHECK_INTERVAL);



// Automatic log file cleanup
const logCleanupIntervalId = setInterval(cleanUpLogFile, LOG_CLEANUP_INTERVAL_MS);

// Removed global timing state logging as it's now per-connection

async function recoverUser() {
    appLog("Starting recovery with alternating RCs");
    try {
        await optimizedConnectionPoolMaintenance();
        await getMonitoringConnection();
    //    appLog("Initial monitoring connection established successfully");
    } catch (error) {
     //   appLog("Failed to establish initial monitoring connection:", error.message || error);
        setTimeout(recoverUser, 500);
    }
}

async function maintainMonitoringConnection() {
    if (isReconnectingAfterRivalAction || isProcessingRivalAction) {
        // Skip maintenance if a rival action reconnection is in progress or rivals are being processed
        return;
    }

    if (monitoringMode && (!activeConnection || !activeConnection.state === CONNECTION_STATES.READY)) {
        appLog("🔄 Force enabling monitoring mode...");
        try {
            await getMonitoringConnection();
        } catch (error) {
        //    appLog("Failed to maintain monitoring connection:", error.message || error);
            setTimeout(maintainMonitoringConnection, 1000);
        }
    }
}

setInterval(maintainMonitoringConnection, 15000); // Every 15 seconds

// Ensure log file is cleaned up on startup
(async () => {
    await cleanUpLogFile();
    recoverUser();
})();

process.on('SIGINT', async () => {
    appLog("Shutting down...");
    // Clear the log cleanup interval to prevent new log writes
    clearInterval(logCleanupIntervalId); // Assuming logCleanupIntervalId is the variable holding the interval ID

    // Cleanup all connections
    const allConnections = [...connectionPool];
    if (activeConnection && !allConnections.includes(activeConnection)) {
        allConnections.push(activeConnection);
    }
    await Promise.allSettled(allConnections.map(conn => conn.cleanup(true)));

    // Add a small delay to allow any pending appLog writes to complete
    setTimeout(() => {
        process.exit(0);
    }, 500); // 500ms delay
});

process.on('uncaughtException', async (error) => {
    appLog('Uncaught exception:', error.message || error);
    if (activeConnection) {
        await activeConnection.cleanup();
        activeConnection = null;
    }
    setTimeout(() => {
        if (monitoringMode) getMonitoringConnection().catch(err => appLog("Failed to get new monitoring connection after error:", err.message || err));
        else getConnection(true).catch(err => appLog("Failed to get new connection after error:", err.message || err));
    }, 500);
});

process.on('unhandledRejection', async (reason, promise) => {
 //   appLog('Unhandled Rejection at:', promise, 'reason:', reason);
    if (activeConnection) {
        await activeConnection.cleanup();
        activeConnection = null;
    }
    setTimeout(() => {
        if (monitoringMode) getMonitoringConnection().catch(err => appLog("Failed to get new monitoring connection after error:", err.message || err));
        else getConnection(true).catch(err => appLog("Failed to get new connection after error:", err.message || err));
    }, 500);
});

async function getMistralChatResponse(prompt) {
    const url = 'https://api.mistral.ai/v1/chat/completions';
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${MISTRAL_API_KEY}`
    };
    const data = JSON.stringify({
        "model": "open-mistral-7b",
        "messages": [
            {"role": "user", "content": prompt}
        ],
        "max_tokens": 20,
        "temperature": 0.2,
        "top_p": 1,
        "random_seed": 42,
        "stream": false
    });

    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method: 'POST',
            headers: headers
        }, (res) => {
            let responseBody = '';
            res.on('data', (chunk) => {
                responseBody += chunk;
            });
            res.on('end', () => {
                try {
                    const jsonResponse = JSON.parse(responseBody);
                    if (jsonResponse.choices && jsonResponse.choices.length > 0) {
                        resolve(jsonResponse.choices[0].message.content);
                    } else {
                        reject(new Error('No response from Mistral AI'));
                    }
                } catch (e) {
                    reject(new Error(`Failed to parse Mistral AI response: ${e.message}`));
                }
            });
        });

        req.on('error', (e) => {
            reject(new Error(`Mistral AI request failed: ${e.message}`));
        });

        req.write(data);
        req.end();
    });
}
// Removed global debugTimingStates as it's now per-connection
