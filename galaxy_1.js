// AI-specific error handling section will be placed after variable declarations
const WebSocket = require('ws');
const fs = require('fs').promises;
const fsSync = require('fs');
const CryptoJS = require('crypto-js');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const { MISTRAL_API_KEY } = require('./src/secrets/mistral_api_key');
const io = require('socket.io-client');
const SmartAdaptiveTimingPredictor = require('./smart_adaptive_ai_timing_predictor');
let lastKickedRival = null;
let lastPredictedTiming = null;

const LOG_FILE_PATH = 'galaxy_1.log';
const LOG_FILE_MAX_SIZE_BYTES = 1024 * 1024; // 1 MB
const LOG_CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds (synchronized)
const aiPredictor = new SmartAdaptiveTimingPredictor();
let aiPredictorEnabled = true; // Can be controlled via config

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

// Enhanced shutdown handler for proper cleanup
let isShuttingDown = false;
const shutdownTimeouts = new Set();
const shutdownIntervals = new Set();

// Track all intervals and timeouts for cleanup
const originalSetTimeout = global.setTimeout;
const originalSetInterval = global.setInterval;
const originalClearTimeout = global.clearTimeout;
const originalClearInterval = global.clearInterval;

global.setTimeout = function(callback, delay, ...args) {
    const timeoutId = originalSetTimeout.call(this, callback, delay, ...args);
    if (!isShuttingDown) {
        shutdownTimeouts.add(timeoutId);
    }
    return timeoutId;
};

global.setInterval = function(callback, delay, ...args) {
    const intervalId = originalSetInterval.call(this, callback, delay, ...args);
    if (!isShuttingDown) {
        shutdownIntervals.add(intervalId);
    }
    return intervalId;
};

global.clearTimeout = function(timeoutId) {
    shutdownTimeouts.delete(timeoutId);
    return originalClearTimeout.call(this, timeoutId);
};

global.clearInterval = function(intervalId) {
    shutdownIntervals.delete(intervalId);
    return originalClearInterval.call(this, intervalId);
};

async function gracefulShutdown(signal) {
    if (isShuttingDown) {
        console.log('Force exit...');
        process.exit(1);
    }
    
    isShuttingDown = true;
    console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
    
    try {
        // Clear all timeouts and intervals
        shutdownTimeouts.forEach(id => originalClearTimeout(id));
        shutdownIntervals.forEach(id => originalClearInterval(id));
        shutdownTimeouts.clear();
        shutdownIntervals.clear();
        
        console.log('✅ Cleared all timeouts and intervals');
        
        // Close WebSocket API connection
        if (apiSocket && apiSocket.connected) {
            apiSocket.disconnect();
            console.log('✅ Disconnected from Flask API');
        }
        
        // Close all active connections
        if (activeConnection) {
            await activeConnection.cleanup(true);
            activeConnection = null;
            console.log('✅ Closed active connection');
        }
        
        // Close all pool connections
        const closePromises = [];
        connectionPool.forEach(conn => {
            closePromises.push(conn.cleanup(true));
        });
        
        // Close all prison connections
        prisonConnectionPool.forEach(conn => {
            closePromises.push(conn.cleanup(true));
        });
        
        await Promise.allSettled(closePromises);
        console.log(`✅ Closed ${closePromises.length} pool connections`);
        
        // Clear all data structures
        connectionPool.length = 0;
        prisonConnectionPool.length = 0;
        trackedRivals.clear();
        userMap.clear();
        rivalActivityProfiles.clear();
        rivalCache.clear();
        founderIds.clear();
        
        console.log('✅ Cleared all data structures');
        
        // Flush any remaining logs
        if (mlDataLogger) {
            await mlDataLogger.flushLogs();
            console.log('✅ Flushed ML data logs');
        }
        
        await processLogQueue();
        console.log('✅ Processed remaining log queue');
        
        console.log('🏁 Graceful shutdown completed successfully');
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Error during shutdown:', error.message);
        process.exit(1);
    }
}

// Handle various shutdown signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGQUIT', () => gracefulShutdown('SIGQUIT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    gracefulShutdown('uncaughtException');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    
    // If AI predictor fails, disable it temporarily
    if (reason && reason.message && reason.message.includes('AI')) {
        appLog(`⚠️ Temporarily disabling AI predictor due to error`);
        aiPredictorEnabled = false;
        
        // Re-enable after 30 seconds
        setTimeout(() => {
            aiPredictorEnabled = config.aiPredictorEnabled === "true" || config.aiPredictorEnabled === true;
            appLog(`🔄 AI predictor re-enabled: ${aiPredictorEnabled}`);
        }, 30000);
    }
    
    // Don't exit on unhandled rejection, just log it
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

// MISSING FUNCTIONS FROM AI PILOT CONTEXT

// Apply timing constraints based on AI pilot context requirements
function applyTimingConstraints(timing, mode) {
    const isAttack = mode === 'attack';
    
    // **BALANCED CONSTRAINTS - ALLOW MORE VARIANCE**
    const minTime = isAttack ? 1350 : 1450;  // Lower minimums: Attack: 1350ms, Defense: 1450ms
    const maxTime = isAttack ? 1750 : 1850;  // Higher maximums: Attack: 1750ms, Defense: 1850ms
    
    if (timing < minTime) {
        appLog(`⚠️🛡️ Timing ${timing}ms below safe ${mode} range, adjusting to ${minTime}ms`);
        return minTime;
    }
    
    if (timing > maxTime) {
        appLog(`⚠️ Timing ${timing}ms above safe ${mode} range, adjusting to ${maxTime}ms`);
        return maxTime;
    }
    
    return Math.round(timing);
}

// Get rival activity level for AI prediction
function getRivalActivityLevel(rivalId) {
    const profile = rivalActivityProfiles.get(rivalId);
    if (!profile) return 0.7; // Default activity level
    
    const now = Date.now();
    const recentActivity = profile.activities.filter(a => now - a.timestamp < 10000); // Last 10 seconds
    
    if (recentActivity.length === 0) return 0.3; // Low activity
    
    // Calculate activity based on frequency of actions
    const avgInterval = recentActivity.length > 1 ? 
        (recentActivity[recentActivity.length - 1].timestamp - recentActivity[0].timestamp) / recentActivity.length : 1000;
        
    return Math.min(1.0, Math.max(0.1, 1000 / avgInterval));
}

// Get rival movement frequency
function getRivalMovementFreq(rivalId) {
    const profile = rivalActivityProfiles.get(rivalId);
    if (!profile || !profile.movements) return 0.5;
    
    const now = Date.now();
    const recentMovements = profile.movements.filter(m => now - m.timestamp < 30000); // Last 30 seconds
    
    return Math.min(1.0, recentMovements.length / 10); // Normalize to 0-1
}

// Get rival interaction rate
function getRivalInteractionRate(rivalId) {
    const profile = rivalActivityProfiles.get(rivalId);
    if (!profile || !profile.interactions) return 0.6;
    
    const now = Date.now();
    const recentInteractions = profile.interactions.filter(i => now - i.timestamp < 20000); // Last 20 seconds
    
    return Math.min(1.0, recentInteractions.length / 5); // Normalize to 0-1
}

// Get current system load
function getSystemLoad() {
    // Simple system load approximation based on connection pool usage
    const activeConnections = connectionPool.filter(c => c.state === CONNECTION_STATES.READY).length;
    const maxConnections = POOL_MAX_SIZE;
    
    return Math.min(1.0, activeConnections / maxConnections);
}

// Enhanced 3-second rule processing with AI feedback
function processThreeSecondRuleFeedback(rivalId, predictedTiming, isThreeSecondRule) {
    if (!aiPredictorEnabled || !rivalId) return;
    
    // Immediate feedback to AI predictor for learning
    const feedback = {
        rivalId: rivalId,
        predictedTiming: predictedTiming,
        success: !isThreeSecondRule,
        wasThreeSecondRule: isThreeSecondRule,
        timingError: isThreeSecondRule ? 50 : 0, // Estimate error magnitude
        timestamp: Date.now()
    };
    
    // Process feedback immediately (within 50ms as per AI pilot context)
    aiPredictor.processFeedback(
        rivalId,
        predictedTiming,
        !isThreeSecondRule,
        Date.now() - (lastKickedRival?.loginTime || Date.now()),
        feedback
    ).catch(error => {
        appLog(`❌ AI Feedback processing error: ${error.message}`);
    });
    
    appLog(`📊 AI Feedback sent: Rival=${rivalId}, 3sRule=${isThreeSecondRule}, Success=${!isThreeSecondRule}`);
}

// 5. ENHANCED 3-SECOND RULE RECOVERY (Add this new function)
// Add this function to better handle 3-second rule recovery:

function processThreeSecondRuleRecovery(rivalId, predictedTiming, isThreeSecondRule, mode) {
    if (!isThreeSecondRule) return; // No recovery needed
    
    const rivalProfile = rivalActivityProfiles.get(rivalId);
    if (!rivalProfile) return;
    
    // **HUMAN-AWARE 3-SECOND RULE RECOVERY**
    const humanProbability = assessHumanLikelihood(rivalId, rivalProfile.name || 'unknown', rivalProfile.loginTime);
    
    let adjustmentAmount;
    if (humanProbability >= 0.7) {
        // Conservative adjustment for humans
        adjustmentAmount = 80 + (Math.random() * 40); // 80-120ms for humans
        appLog(`👤⚡ Human 3s Rule Recovery: +${adjustmentAmount.toFixed(0)}ms for human rival`);
    } else {
        // More aggressive for suspected bots
        adjustmentAmount = 40 + (Math.random() * 30); // 40-70ms for bots
        appLog(`🤖⚡ Bot 3s Rule Recovery: +${adjustmentAmount.toFixed(0)}ms for bot rival`);
    }
    
    // Apply the adjustment to AI predictor if available
    if (aiPredictorEnabled && aiPredictor.applyImmediateAdjustment) {
        aiPredictor.applyImmediateAdjustment(rivalId, adjustmentAmount);
    }
    
    // Also adjust manual timing for this RC/mode combination
    const rcKey = activeConnection ? activeConnection.rcKey : 'RC1';
    const globalStateForRC = globalTimingState[rcKey];
    
    if (mode === 'attack') {
        globalStateForRC.attack.currentTime = Math.min(
            globalStateForRC.attack.currentTime + adjustmentAmount,
            1700 // Don't exceed maximum
        );
    } else {
        globalStateForRC.defense.currentTime = Math.min(
            globalStateForRC.defense.currentTime + adjustmentAmount,
            1800 // Don't exceed maximum
        );
    }
    
    appLog(`🔧 Applied 3s Rule Recovery: ${mode} timing adjusted by +${adjustmentAmount.toFixed(0)}ms`);
}

// Rival activity tracking system
let rivalActivityProfiles = new Map(); // rivalId -> activity profile

// Track rival activity for AI prediction enhancement
function trackRivalActivity(rivalId, activityType, data = {}) {
    // **ENHANCED SAFETY**: Validate inputs
    if (!rivalId || typeof rivalId !== 'string') {
        appLog(`⚠️ trackRivalActivity: Invalid rivalId: ${rivalId}`);
        return;
    }
    
    if (!rivalActivityProfiles.has(rivalId)) {
        rivalActivityProfiles.set(rivalId, {
            activities: [],
            movements: [],
            interactions: [],
            loginTime: Date.now(),
            sessionDuration: 0, // Will be calculated only when session ends
            
            // **NEW: HUMAN DETECTION FIELDS**
            lastActivityTime: Date.now(),
            activityIntervals: [],
            responseDelays: [],
            movementVariability: [],
            interactionComplexity: 0
        });
        
        appLog(`🆕 Created activity profile for ${rivalId}`);
    } else {
        // CRITICAL: Update loginTime if this is a new join activity (rival rejoining)
        if (activityType === 'activity' && data && data.type === 'join') {
            const profile = rivalActivityProfiles.get(rivalId);
            
            // **SAFETY CHECK**: Ensure profile exists
            if (!profile) {
                appLog(`⚠️ trackRivalActivity: Profile missing for ${rivalId}, recreating`);
                rivalActivityProfiles.set(rivalId, {
                    activities: [],
                    movements: [],
                    interactions: [],
                    loginTime: Date.now(),
                    sessionDuration: 0,
                    lastActivityTime: Date.now(),
                    activityIntervals: [],
                    responseDelays: [],
                    movementVariability: [],
                    interactionComplexity: 0
                });
                return;
            }
            
            const newLoginTime = Date.now();
            
            // Clear previous session data for the new session
            profile.activities = [];
            profile.movements = [];
            profile.interactions = [];
            profile.loginTime = newLoginTime;
            profile.sessionDuration = 0; // Reset to 0 for new session
            profile.lastActivityTime = newLoginTime;
            profile.activityIntervals = [];
            profile.responseDelays = [];
            profile.movementVariability = [];
            profile.interactionComplexity = 0;
            
            appLog(`🔄 Activity Profile Reset: ${rivalId} rejoined - new loginTime: ${newLoginTime}`);
        }
    }
    
    const profile = rivalActivityProfiles.get(rivalId);
    
    // **CRITICAL SAFETY CHECK**: Ensure profile exists before proceeding
    if (!profile) {
        appLog(`⚠️ trackRivalActivity: No profile found for ${rivalId} after initialization`);
        return;
    }
    
    const timestamp = Date.now();
    
    // **ENHANCED ACTIVITY TRACKING WITH HUMAN DETECTION**
    switch (activityType) {
        case 'activity':
            // Track timing intervals for human detection
            if (profile.lastActivityTime) {
                const interval = timestamp - profile.lastActivityTime;
                profile.activityIntervals.push(interval);
                if (profile.activityIntervals.length > 20) {
                    profile.activityIntervals = profile.activityIntervals.slice(-20);
                }
            }
            
            profile.activities.push({ 
                timestamp, 
                level: data.level || Math.random(), // Activity intensity
                intensity: data.intensity || Math.random(),
                ...data 
            });
            
            // Keep only recent activities (last 50)
            if (profile.activities.length > 50) {
                profile.activities = profile.activities.slice(-50);
            }
            profile.lastActivityTime = timestamp;
            break;
            
        case 'movement':
            // Track movement timing and patterns
            const movementDelay = data.delay || (timestamp - (data.lastMovement || timestamp));
            profile.movementVariability.push(movementDelay);
            if (profile.movementVariability.length > 15) {
                profile.movementVariability = profile.movementVariability.slice(-15);
            }
            
            profile.movements.push({ 
                timestamp, 
                instant: movementDelay < 50, // Movements under 50ms are likely bot
                delay: movementDelay,
                towardExit: data.towardExit || false,
                ...data 
            });
            
            if (profile.movements.length > 30) {
                profile.movements = profile.movements.slice(-30);
            }
            break;
            
        case 'interaction':
            // Track interaction complexity and response times
            const responseTime = data.responseTime || 200;
            profile.responseDelays.push(responseTime);
            if (profile.responseDelays.length > 10) {
                profile.responseDelays = profile.responseDelays.slice(-10);
            }
            
            // Increase complexity score for varied interactions
            if (responseTime > 150) profile.interactionComplexity += 1;
            if (data.complex) profile.interactionComplexity += 2;
            
            profile.interactions.push({ 
                timestamp, 
                responseTime,
                complex: data.complex || false,
                ...data 
            });
            
            if (profile.interactions.length > 20) {
                profile.interactions = profile.interactions.slice(-20);
            }
            break;
    }
    
    // REMOVED: Continuous session duration calculation
    // Session duration will only be calculated when the session actually ends (PART/SLEEP/KICK)
}

// 2. HUMAN DETECTION HELPER FUNCTIONS

// Check for variable human-like delays in actions
function checkVariableHumanDelay(rivalId) {
    const profile = rivalActivityProfiles.get(rivalId);
    if (!profile || !profile.activities || profile.activities.length < 3) return false;
    
    const recentActivities = profile.activities.slice(-10); // Last 10 activities
    const intervals = [];
    
    for (let i = 1; i < recentActivities.length; i++) {
        intervals.push(recentActivities[i].timestamp - recentActivities[i-1].timestamp);
    }
    
    if (intervals.length < 2) return false;
    
    // Calculate variance - humans have more variable timing
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((acc, val) => acc + Math.pow(val - avg, 2), 0) / intervals.length;
    const stdDev = Math.sqrt(variance);
    
    // Humans typically have stdDev > 100ms, bots have very low variance
    return stdDev > 100;
}

// Detect human interaction patterns
function detectHumanInteractionPatterns(rivalId) {
    const profile = rivalActivityProfiles.get(rivalId);
    if (!profile) return false;
    
    const humanIndicators = [
        // Variable activity levels (not constant)
        profile.activities && profile.activities.length > 5 && 
        profile.activities.some(a => a.level !== profile.activities[0].level),
        
        // Natural movement patterns
        profile.movements && profile.movements.length > 3 &&
        !profile.movements.every(m => m.instant === true),
        
        // Interaction delays showing thought process
        profile.interactions && profile.interactions.length > 2 &&
        profile.interactions.some(i => i.responseTime > 200), // >200ms response time
    ];
    
    return humanIndicators.filter(Boolean).length >= 2; // At least 2 human indicators
}

// Check for natural activity patterns
function checkNaturalActivityPattern(rivalId) {
    const profile = rivalActivityProfiles.get(rivalId);
    if (!profile || !profile.activities || profile.activities.length < 5) return false;
    
    const now = Date.now();
    const recentActivities = profile.activities.filter(a => now - a.timestamp < 30000); // Last 30 seconds
    
    // Natural patterns: not perfectly consistent, some pauses, variable intensity
    const hasNaturalPauses = recentActivities.some((activity, i) => {
        if (i === 0) return false;
        const gap = activity.timestamp - recentActivities[i-1].timestamp;
        return gap > 1000 && gap < 5000; // 1-5 second natural pauses
    });
    
    const hasVariableIntensity = recentActivities.length > 0 && 
        !recentActivities.every(a => a.intensity === recentActivities[0].intensity);
    
    return hasNaturalPauses || hasVariableIntensity;
}

// Detection cache to prevent duplicate logging
let detectionCache = new Map(); // rivalId -> { result, timestamp, logged }

// SESSION DURATION-BASED human likelihood assessment (Updated with 2250ms baseline)
function assessHumanLikelihood(rivalId, rivalName, loginTime) {
    const sessionDuration = Date.now() - (loginTime || Date.now());
    
    // **NEW BASELINE LOGIC**: >= 2250ms = Human, < 2250ms = Bot
    // For current session duration assessment
    if (sessionDuration >= 2250) {
        // Removed noisy bot detection log
        return 0.8; // High human probability for long sessions
    } else if (sessionDuration < 2250) {
        // Removed noisy bot detection log  
        return 0.2; // Low human probability for short sessions
    }
    
    // Check cache to prevent duplicate detection logging
    const cached = detectionCache.get(rivalId);
    const cacheValidTime = 5000; // 5 seconds cache validity
    
    if (cached && Date.now() - cached.timestamp < cacheValidTime) {
        return cached.result; // Return cached result without logging
    }
    
    // **PURE GAMEPLAY ANALYSIS** - Focus entirely on behavior patterns
    const gameplayFactors = [
        // Core gameplay behavior indicators (highest weight)
        { weight: 15, check: hasRoboticTimingConsistency(rivalId), desc: "Robotic timing consistency", isBot: true },
        { weight: 12, check: showsInstantReactions(rivalId), desc: "Instant reactions", isBot: true },
        { weight: 10, check: hasPerfectActivityPatterns(rivalId), desc: "Perfect activity patterns", isBot: true },
        
        // Human behavior indicators
        { weight: 8, check: checkVariableHumanDelay(rivalId), desc: "Variable timing" },
        { weight: 7, check: showsThinkingDelays(rivalId), desc: "Shows thinking delays" },
        { weight: 6, check: hasInconsistentBehavior(rivalId), desc: "Inconsistent behavior patterns" },
        
        // Session behavior analysis (gameplay only)
        { weight: 9, check: sessionDuration < 800 && getRivalActivityLevel(rivalId) === 1.0, desc: "Bot-like quick perfect session", isBot: true },
        { weight: 5, check: sessionDuration > 2000 && getRivalActivityLevel(rivalId) < 0.8, desc: "Human-like longer imperfect session" },
        
        // Movement and activity patterns
        { weight: 8, check: hasZeroVariationMovements(rivalId), desc: "Zero movement variation", isBot: true },
        { weight: 6, check: getRivalMovementFreq(rivalId) < 0.7, desc: "Natural movement frequency" }
    ];
    
    let humanScore = 0;
    let botScore = 0;
    let maxPossibleScore = 0;
    const humanIndicators = [];
    const botIndicators = [];
    
    gameplayFactors.forEach(factor => {
        maxPossibleScore += factor.weight;
        if (factor.check) {
            if (factor.isBot) {
                botScore += factor.weight;
                botIndicators.push(factor.desc);
            } else {
                humanScore += factor.weight;
                humanIndicators.push(factor.desc);
            }
        }
    });
    
    // Calculate final probability based on gameplay evidence
    const botProbability = maxPossibleScore > 0 ? botScore / maxPossibleScore : 0;
    const humanProbability = maxPossibleScore > 0 ? humanScore / maxPossibleScore : 0.5;
    
    // Determine if it's a bot based on strong bot evidence (80% threshold)
    const isBot = botProbability >= 0.8;
    const finalHumanProbability = isBot ? 0.2 : Math.max(0.3, humanProbability);
    
    // Cache the result
    detectionCache.set(rivalId, {
        result: finalHumanProbability,
        timestamp: Date.now(),
        logged: false
    });
    
    // Only log if we haven't logged for this rival recently
    const shouldLog = !cached || Math.abs((cached.result || 0.5) - finalHumanProbability) > 0.1;
    
    if (shouldLog) {
        if (isBot) {
            appLog(`🤖 Bot detected via gameplay: ${rivalName} (${(botProbability * 100).toFixed(1)}% bot confidence)`);
            if (botIndicators.length > 0) {
                appLog(`   Bot indicators: ${botIndicators.join(', ')}`);
            }
        } else {
            appLog(`👤 Human detected via gameplay: ${rivalName} (${(finalHumanProbability * 100).toFixed(1)}% human confidence)`);
            if (humanIndicators.length > 0) {
                appLog(`   Human indicators: ${humanIndicators.join(', ')}`);
            }
        }
        
        // Mark as logged
        detectionCache.get(rivalId).logged = true;
    }
    
    return finalHumanProbability;
}

// **ENHANCED GAMEPLAY-BASED BOT DETECTION FUNCTIONS**

// Check for robotic timing consistency (strongest bot indicator)
function hasRoboticTimingConsistency(rivalId) {
    const profile = rivalActivityProfiles.get(rivalId);
    if (!profile || !profile.activityIntervals || profile.activityIntervals.length < 4) return false;
    
    const intervals = profile.activityIntervals.slice(-6); // Last 6 intervals
    if (intervals.length < 4) return false;
    
    // Check for extremely consistent timing (variance < 10ms = very likely bot)
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const maxDeviation = Math.max(...intervals.map(interval => Math.abs(interval - avgInterval)));
    
    const isRobotic = maxDeviation < 10; // Less than 10ms deviation = robotic
    
    if (isRobotic) {
        appLog(`🤖⏱️ Robotic timing detected: max deviation ${maxDeviation.toFixed(1)}ms (avg: ${avgInterval.toFixed(1)}ms)`);
    }
    
    return isRobotic;
}

// Check for instant reactions (bot indicator)
function showsInstantReactions(rivalId) {
    const profile = rivalActivityProfiles.get(rivalId);
    if (!profile || !profile.responseDelays || profile.responseDelays.length < 3) return false;
    
    // Check for multiple responses under 50ms (very unlikely for humans)
    const instantReactions = profile.responseDelays.filter(delay => delay < 50).length;
    const totalReactions = profile.responseDelays.length;
    
    const hasInstantReactions = (instantReactions / totalReactions) >= 0.6; // 60%+ instant = bot
    
    if (hasInstantReactions) {
        appLog(`🤖⚡ Instant reactions detected: ${instantReactions}/${totalReactions} under 50ms`);
    }
    
    return hasInstantReactions;
}

// Check for perfect activity patterns (bot indicator)
function hasPerfectActivityPatterns(rivalId) {
    const profile = rivalActivityProfiles.get(rivalId);
    if (!profile || !profile.activities || profile.activities.length < 5) return false;
    
    // Check for perfect consistency in activity levels
    const activities = profile.activities.slice(-8);
    const levels = activities.map(a => a.level || 0.5);
    
    // Perfect patterns: all levels identical or following exact pattern
    const uniqueLevels = new Set(levels.map(l => Math.round(l * 100))); // Round to avoid floating point issues
    const isPerfect = uniqueLevels.size <= 2 && levels.length >= 5; // Only 1-2 unique activity levels
    
    if (isPerfect) {
        appLog(`🤖📊 Perfect activity pattern detected: ${uniqueLevels.size} unique levels in ${levels.length} activities`);
    }
    
    return isPerfect;
}

// Check for zero movement variation (strong bot indicator)
function hasZeroVariationMovements(rivalId) {
    const profile = rivalActivityProfiles.get(rivalId);
    if (!profile || !profile.movementVariability || profile.movementVariability.length < 4) return false;
    
    // Check if all movements have identical timing
    const movements = profile.movementVariability.slice(-6);
    const uniqueTimings = new Set(movements);
    
    const hasZeroVariation = uniqueTimings.size <= 2 && movements.length >= 4; // Almost identical timings
    
    if (hasZeroVariation) {
        appLog(`🤖🎯 Zero movement variation detected: ${uniqueTimings.size} unique timings in ${movements.length} movements`);
    }
    
    return hasZeroVariation;
}

// Check for inconsistent behavior patterns (humans are less predictable)
function hasInconsistentBehavior(rivalId) {
    const profile = rivalActivityProfiles.get(rivalId);
    if (!profile || !profile.activities || profile.activities.length < 5) return true; // Default to human if no data
    
    const activities = profile.activities.slice(-10); // Last 10 activities
    
    // Check for variation in activity levels (humans vary more)
    const levels = activities.map(a => a.level || 0.5);
    const avgLevel = levels.reduce((a, b) => a + b, 0) / levels.length;
    const hasLevelVariation = levels.some(level => Math.abs(level - avgLevel) > 0.15);
    
    // Check for irregular timing between activities
    const intervals = [];
    for (let i = 1; i < activities.length; i++) {
        intervals.push(activities[i].timestamp - activities[i-1].timestamp);
    }
    
    if (intervals.length < 2) return hasLevelVariation;
    
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const hasTimingInconsistency = intervals.some(interval => Math.abs(interval - avgInterval) > avgInterval * 0.3);
    
    return hasLevelVariation || hasTimingInconsistency;
}

// Check for human-like timing variance (bots have very consistent timing)
function hasHumanTimingVariance(rivalId) {
    const profile = rivalActivityProfiles.get(rivalId);
    if (!profile || !profile.activityIntervals || profile.activityIntervals.length < 3) return true; // Default to human if no data
    
    const intervals = profile.activityIntervals.slice(-8); // Last 8 intervals
    if (intervals.length < 3) return true;
    
    // Calculate coefficient of variation
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((acc, val) => acc + Math.pow(val - avg, 2), 0) / intervals.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = avg > 0 ? stdDev / avg : 0;
    
    // Humans typically have coefficient of variation > 0.15, bots have much lower
    return coefficientOfVariation > 0.15;
}

// Check for thinking delays (humans pause to think)
function showsThinkingDelays(rivalId) {
    const profile = rivalActivityProfiles.get(rivalId);
    if (!profile || !profile.responseDelays || profile.responseDelays.length < 3) return true; // Default to human
    
    const delays = profile.responseDelays.slice(-5); // Last 5 response delays
    
    // Check for delays > 300ms (human thinking time)
    const hasThinkingDelays = delays.some(delay => delay > 300);
    
    // Check for variation in response times
    const avgDelay = delays.reduce((a, b) => a + b, 0) / delays.length;
    const hasVariation = delays.some(delay => Math.abs(delay - avgDelay) > 100);
    
    return hasThinkingDelays || hasVariation;
}

// Check for complex activity patterns (humans have more diverse behavior)
function hasComplexActivityPattern(rivalId) {
    const profile = rivalActivityProfiles.get(rivalId);
    if (!profile) return false;
    
    let complexityScore = 0;
    
    // Check activity diversity
    if (profile.activities && profile.activities.length > 5) {
        const uniqueLevels = new Set(profile.activities.map(a => Math.round((a.level || 0.5) * 10)));
        if (uniqueLevels.size > 3) complexityScore++;
    }
    
    // Check movement diversity
    if (profile.movements && profile.movements.length > 3) {
        const hasVariedMovements = profile.movements.some(m => !m.instant) && profile.movements.some(m => m.instant);
        if (hasVariedMovements) complexityScore++;
    }
    
    // Check interaction complexity
    if (profile.interactionComplexity > 2) {
        complexityScore++;
    }
    
    return complexityScore >= 2;
}

// **ENHANCED RIVAL TIMING RECORDING FUNCTION**
// Record when we observe a rival's action timing for adaptive learning
function recordRivalActionTiming(rivalId, observedTiming, actionType = 'unknown') {
    if (!aiPredictorEnabled || !rivalId || !observedTiming) return;
    
    try {
        // Record the timing in AI predictor for learning
        aiPredictor.recordRivalTiming(rivalId, observedTiming);
        
        // Track in local activity profiles for immediate adaptive use
        const profile = rivalActivityProfiles.get(rivalId);
        if (profile) {
            // Initialize timing tracking
            if (!profile.timingHistory) {
                profile.timingHistory = [];
            }
            
            profile.timingHistory.push({
                timing: observedTiming,
                actionType: actionType,
                timestamp: Date.now()
            });
            
            // Keep recent timings for adaptive response (last 5 for accuracy)
            if (profile.timingHistory.length > 5) {
                profile.timingHistory = profile.timingHistory.slice(-5);
            }
            
            // Calculate rival's average timing for immediate adaptation
            const recentTimings = profile.timingHistory.map(t => t.timing);
            const avgTiming = recentTimings.reduce((a, b) => a + b, 0) / recentTimings.length;
            profile.averageObservedTiming = Math.round(avgTiming);
            
            appLog(`⏱️ Rival timing recorded: ${rivalId} = ${observedTiming}ms | Avg: ${profile.averageObservedTiming}ms | Observations: ${profile.timingHistory.length}`);
        }
    } catch (error) {
        appLog(`❌ Error recording rival timing: ${error.message}`);
    }
}

// **ADAPTIVE RIVAL TIMING OBSERVER**
// Intelligently estimate and record rival's timing based on session behavior
function estimateAndRecordRivalTiming(rivalId, rivalName) {
    const profile = rivalActivityProfiles.get(rivalId);
    if (!profile || !profile.loginTime) return null;
    
    const sessionDuration = Date.now() - profile.loginTime;
    const humanLikelihood = assessHumanLikelihood(rivalId, rivalName, profile.loginTime);
    
    // **ADAPTIVE ESTIMATION BASED ON GAMEPLAY ANALYSIS**
    let estimatedTiming;
    
    if (humanLikelihood < 0.3) {
        // Confirmed bot - use bot timing patterns
        if (sessionDuration < 800) {
            estimatedTiming = 1420 + (Math.random() * 60); // 1420-1480ms (fast bot)
        } else if (sessionDuration < 1500) {
            estimatedTiming = 1450 + (Math.random() * 80); // 1450-1530ms (medium bot)
        } else {
            estimatedTiming = 1480 + (Math.random() * 100); // 1480-1580ms (slower bot)
        }
        
        appLog(`🤖⏱️ Bot timing estimated: ${rivalName} = ${Math.round(estimatedTiming)}ms (session: ${sessionDuration}ms)`);
    } else {
        // Suspected human - use conservative human timing
        if (sessionDuration < 1500) {
            estimatedTiming = 1550 + (Math.random() * 100); // 1550-1650ms 
        } else if (sessionDuration < 3000) {
            estimatedTiming = 1580 + (Math.random() * 120); // 1580-1700ms
        } else {
            estimatedTiming = 1600 + (Math.random() * 150); // 1600-1750ms (human)
        }
        
        appLog(`👤⏱️ Human timing estimated: ${rivalName} = ${Math.round(estimatedTiming)}ms (session: ${sessionDuration}ms)`);
    }
    
    // Fine-tune based on activity patterns
    const activityLevel = getRivalActivityLevel(rivalId);
    if (activityLevel >= 0.95) {
        // Extremely high activity = likely bot
        estimatedTiming -= 30; // Be faster against bots
    } else if (activityLevel <= 0.4) {
        // Low activity = likely human thinking
        estimatedTiming += 50; // Be more conservative
    }
    
    const finalEstimatedTiming = Math.round(estimatedTiming);
    
    // Record the estimated timing for future adaptive predictions
    recordRivalActionTiming(rivalId, finalEstimatedTiming, 'gameplay_estimated');
    
    return finalEstimatedTiming;
}

// Human-specific protection timing
function applyHumanProtectionTiming(baseTiming, mode, sessionData) {
    const isAttack = mode === 'attack';
    let protectedTiming = baseTiming;
    
    // Base human protection - add safety buffer
    const baseBuffer = isAttack ? 120 : 180; // Attack: +120ms, Defense: +180ms
    protectedTiming += baseBuffer;
    
    // Additional protections based on human confidence
    if (sessionData.isLikelyHuman >= 0.9) {
        // Very confident human - maximum protection
        protectedTiming += isAttack ? 80 : 120; // Extra 80/120ms
        appLog(`👤🛡️ Maximum human protection applied: +${baseBuffer + (isAttack ? 80 : 120)}ms total`);
    } else if (sessionData.isLikelyHuman >= 0.8) {
        // Confident human - high protection
        protectedTiming += isAttack ? 50 : 80; // Extra 50/80ms
        appLog(`👤🛡️ High human protection applied: +${baseBuffer + (isAttack ? 50 : 80)}ms total`);
    } else if (sessionData.isLikelyHuman >= 0.7) {
        // Likely human - moderate protection
        protectedTiming += isAttack ? 30 : 50; // Extra 30/50ms
        appLog(`👤🛡️ Moderate human protection applied: +${baseBuffer + (isAttack ? 30 : 50)}ms total`);
    }
    
    // Session duration protection (longer sessions = more likely human)
    if (sessionData.sessionDuration > 5000) { // 5+ seconds
        protectedTiming += 40;
        appLog(`👤⏱️ Long session protection: +40ms (session: ${sessionData.sessionDuration}ms)`);
    }
    
    // Variable activity protection
    if (sessionData.hasVariableDelay) {
        protectedTiming += 30;
        appLog(`👤🎯 Variable activity protection: +30ms`);
    }
    
    return Math.round(protectedTiming);
}

// Preemptive logout detection system
function detectPreemptiveLogout(rivalId) {
    const profile = rivalActivityProfiles.get(rivalId);
    if (!profile) return { shouldKick: false, confidence: 0 };
    
    const now = Date.now();
    const recentActivity = profile.activities.filter(a => now - a.timestamp < 5000); // Last 5 seconds
    
    // Check for pre-logout signals
    const activityDrop = recentActivity.length < 2; // Very low recent activity
    const longSession = profile.sessionDuration > 10000; // Session longer than 10 seconds
    const movementToExit = profile.movements.some(m => now - m.timestamp < 2000 && m.towardExit);
    
    let logoutProbability = 0;
    if (activityDrop) logoutProbability += 0.4;
    if (longSession) logoutProbability += 0.3;
    if (movementToExit) logoutProbability += 0.3;
    
    const shouldKick = logoutProbability >= 0.8;
    
    if (shouldKick) {
        appLog(`⚡ Preemptive logout detected for rival ${rivalId}: probability=${logoutProbability.toFixed(2)}`);
    }
    
    return {
        shouldKick,
        confidence: logoutProbability,
        timing: now + 12 // Kick 12ms from now (within 0-15ms range)
    };
}

// Enhanced JSON logging system for ML training
class MLDataLogger {
    constructor() {
        this.logPath = path.join(__dirname, 'ai_training_data.json');
        this.logBatch = [];
        this.batchSize = 10;
        this.flushInterval = 5000; // 5 seconds
        
        // Start periodic flushing
        if (!this.flushTimer) {
            this.flushTimer = setInterval(() => this.flushLogs(), this.flushInterval);
        }
    }
    
    logPrediction(rivalId, mode, predictedTiming, features, confidence = 0.5) {
        const logEntry = {
            timestamp: Date.now(),
            sessionId: `${rivalId}_${Date.now()}`,
            eventType: 'prediction',
            rivalId,
            mode,
            predictedTiming,
            confidence,
            features,
            gameState: {
                connectionState: activeConnection ? activeConnection.state : 'none',
                poolSize: connectionPool.length,
                processingRival: isProcessingRivalAction
            },
            networkConditions: {
                latency: activeConnection ? activeConnection.lastPingTime || 50 : 50,
                systemLoad: getSystemLoad()
            }
        };
        
        this.logBatch.push(logEntry);
        
        if (this.logBatch.length >= this.batchSize) {
            this.flushLogs();
        }
    }
    
    logOutcome(rivalId, predictedTiming, success, actualDuration, additionalData = {}) {
        const logEntry = {
            timestamp: Date.now(),
            eventType: 'outcome',
            rivalId,
            predictedTiming,
            success,
            actualDuration,
            timingError: success ? 0 : (additionalData.timingError || 50),
            wasThreeSecondRule: additionalData.wasThreeSecondRule || false,
            learningTrigger: !success, // Trigger learning on failures
            adjustmentMade: additionalData.adjustmentMade || 0,
            ...additionalData
        };
        
        this.logBatch.push(logEntry);
        
        if (this.logBatch.length >= this.batchSize) {
            this.flushLogs();
        }
    }
    
    async flushLogs() {
        if (this.logBatch.length === 0) return;
        
        try {
            let existingLogs = [];
            try {
                const data = await fs.readFile(this.logPath, 'utf8');
                existingLogs = JSON.parse(data);
            } catch (error) {
                // File doesn't exist or is empty
                existingLogs = [];
            }
            
            // Add new logs
            existingLogs.push(...this.logBatch);
            
            // Keep only recent logs (last 5000 entries)
            if (existingLogs.length > 5000) {
                existingLogs = existingLogs.slice(-5000);
            }
            
            // Write asynchronously to prevent timing delays
            await fs.writeFile(this.logPath, JSON.stringify(existingLogs, null, 2));
            
            appLog(`📋 ML Data: Logged ${this.logBatch.length} entries to training data`);
            this.logBatch = [];
            
        } catch (error) {
            appLog(`❌ ML Data logging error: ${error.message}`);
        }
    }
}

// Initialize ML data logger
const mlDataLogger = new MLDataLogger();

// AI-specific error handling (moved to main shutdown handler)

// Initialize system startup check
setTimeout(() => {
    appLog(`🚀 Galaxy AI Service fully initialized`);
    appLog(`🤖 AI Predictor: ${aiPredictorEnabled ? 'ENABLED' : 'DISABLED'}`);
    appLog(`🎯 Timing Constraints: Attack(1300-1700ms), Defense(1400-1800ms)`);
    appLog(`📊 ML Data Logging: ${mlDataLogger ? 'ACTIVE' : 'INACTIVE'}`);
    
    // Initial system health check (removed noisy log)
    const healthSummary = {
        connectionPool: connectionPool.length,
        trackedRivals: trackedRivals.size,
        userMap: userMap.size,
        aiPredictor: aiPredictorEnabled,
        mlDataLogger: !!mlDataLogger
    };
    
    // Removed noisy system health log
}, 5000); // 5 seconds after startup

// Enhanced system initialization with human protection
setTimeout(() => {
    appLog(`🛡️ ZERO-KICK PROTECTION SYSTEM LOADED`);
    appLog(`👤 Human Detection: ENABLED`);
    // Removed noisy timing range log
    appLog(`⚡ Enhanced 3s Rule Recovery: ACTIVE`);
    appLog(`🔧 Variable Human Protection: ACTIVE`);
    
    // Test human detection on startup (without logging bot detection test)
    const testHuman = assessHumanLikelihood('test123', 'TestHumanPlayer', Date.now() - 5000);
    const testBot = assessHumanLikelihood('bot456', 'TestBotPlayer', Date.now() - 1000);
    
    appLog(`🧪 Detection Test: Human=${(testHuman * 100).toFixed(1)}%, Bot=${(testBot * 100).toFixed(1)}%`);
    
}, 6000); // 6 seconds after startup to ensure all systems are loaded

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

// Performance monitoring and cleanup intervals
setInterval(performMemoryCleanup, MEMORY_CLEANUP_INTERVAL);
setInterval(measureTimingDrift, 300000); // Every 5 minutes

// AI Predictor performance monitoring
setInterval(async () => {
    if (aiPredictorEnabled && aiPredictor.initialized) {
        const performance = aiPredictor.getPerformanceSummary();
        if (performance.totalPredictions > 0) {
            appLog(`🤖 AI Performance: ${performance.overallAccuracy}% accuracy, ${performance.rivalsTracked} rivals tracked, avg rival accuracy: ${performance.averageRivalAccuracy}%`);
        }
        
        // Save AI data periodically
        try {
            await aiPredictor.saveData();
        } catch (error) {
            appLog(`❌ AI data save error: ${error.message}`);
        }
    }
}, 600000); // Every 10 minutes

// Enhanced rival activity cleanup with AI integration
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    
    // Clean up old rival activity profiles
    for (const [rivalId, profile] of rivalActivityProfiles.entries()) {
        if (now - profile.loginTime > 600000) { // 10 minutes old
            rivalActivityProfiles.delete(rivalId);
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        appLog(`🧼 Cleaned ${cleaned} old rival activity profiles`);
    }
}, 300000); // Every 5 minutes

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
        const existingRivalData = trackedRivals.get(rival.id);
        
        if (!existingRivalData) {
            // New rival - create fresh tracking data
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
            appLog(`🆕 New rival tracking: ${rival.name} (${rival.id}) - loginTime: ${rivalData.loginTime}`);
        } else {
            // Rival rejoining - update loginTime for new session (CRITICAL: Use single timestamp for both data structures)
            const newLoginTime = Date.now();
            
            // Update trackedRivals first
            existingRivalData.loginTime = newLoginTime;
            existingRivalData.mode = mode;
            existingRivalData.connection = connection;
            existingRivalData.coordinate = rival.coordinate;
            
            // CRITICAL: Synchronize rivalActivityProfiles with EXACT same loginTime
            let rivalProfile = rivalActivityProfiles.get(rival.id);
            if (!rivalProfile) {
                // Create new profile if it doesn't exist
                rivalProfile = {
                    activities: [],
                    movements: [],
                    interactions: [],
                    loginTime: newLoginTime,
                    sessionDuration: 0,
                    lastActivityTime: newLoginTime,
                    activityIntervals: [],
                    responseDelays: [],
                    movementVariability: [],
                    interactionComplexity: 0
                };
                rivalActivityProfiles.set(rival.id, rivalProfile);
                appLog(`🔄 Created new Activity Profile: ${rival.id} - loginTime: ${newLoginTime}`);
            } else {
                // Clear previous session data for the new session
                rivalProfile.activities = [];
                rivalProfile.movements = [];
                rivalProfile.interactions = [];
                rivalProfile.loginTime = newLoginTime; // Use EXACT same timestamp
                rivalProfile.sessionDuration = 0;
                rivalProfile.lastActivityTime = newLoginTime;
                rivalProfile.activityIntervals = [];
                rivalProfile.responseDelays = [];
                rivalProfile.movementVariability = [];
                rivalProfile.interactionComplexity = 0;
                
                appLog(`🔄 Activity Profile Reset: ${rival.id} rejoined - loginTime synced: ${newLoginTime}`);
            }
            
            // Verify synchronization
            appLog(`✅ LoginTime Sync Verified: trackedRivals=${existingRivalData.loginTime}, rivalActivityProfiles=${rivalProfile.loginTime}`);
            
            // Clear any existing timeouts
            if (existingRivalData.kickTimeout) {
                clearTimeout(existingRivalData.kickTimeout);
                existingRivalData.kickTimeout = null;
            }
            if (existingRivalData.presenceCheckTimeout) {
                clearTimeout(existingRivalData.presenceCheckTimeout);
                existingRivalData.presenceCheckTimeout = null;
            }
            
            // Schedule new kick with updated loginTime
            scheduleRivalKick(rival.id, existingRivalData);
            appLog(`🔄 Rival rejoining: ${rival.name} (${rival.id}) - updated loginTime: ${newLoginTime}`);
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
        currentTime: null,
        lastMode: null,
        consecutiveErrors: 0,
        attack: {
            currentTime: null
        },
        defense: {
            currentTime: null
        }
    },
    RC2: {
        currentTime: null,
        lastMode: null,
        consecutiveErrors: 0,
        attack: {
            currentTime: null
        },
        defense: {
            currentTime: null
        }
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
    const globalStateForRC = globalTimingState[rcKey];
    
    // Initialize connection's timing state from the global timing state for the specific RC
    connection.timingState = {
        currentTime: globalStateForRC.currentTime,
        lastMode: globalStateForRC.lastMode,
        consecutiveErrors: globalStateForRC.consecutiveErrors,
        attack: {
            currentTime: globalStateForRC.attack.currentTime
        },
        defense: {
            currentTime: globalStateForRC.defense.currentTime
        }
    };
    
    appLog(`🔄 Initialized timing states for ${connection.botId} (${rcKey}): Attack=${globalStateForRC.attack.currentTime}ms, Defense=${globalStateForRC.defense.currentTime}ms`);
}

function updateConfigValues(newConfig = null) {
    if (newConfig) {
        // Update from WebSocket
        config = newConfig;
    //    appLog(`Config updated via WebSocket: ${JSON.stringify(Object.keys(config))}`);
    } else {
        // Fallback to file-based config if WebSocket not available
        try {
            delete require.cache[require.resolve('./config1.json')];
            const configRaw = fsSync.readFileSync('./config1.json', 'utf8');
            const rawConfig = JSON.parse(configRaw);
            
            // Fix the config key mapping - handle both with and without '1' suffix
            config = {};
            Object.keys(rawConfig).forEach(key => {
                // Remove '1' suffix from keys for consistency
                const cleanKey = key.endsWith('1') ? key.slice(0, -1) : key;
                config[cleanKey] = rawConfig[key];
                // Also keep original key for backward compatibility
                config[key] = rawConfig[key];
            });
            
            // Ensure RC1 and RC2 are properly mapped
            if (rawConfig.RC11) config.RC1 = rawConfig.RC11;
            if (rawConfig.RC21) config.RC2 = rawConfig.RC21;
            if (rawConfig.PlanetName1) config.planetName = rawConfig.PlanetName1;
            
            // Debug log RC values
            appLog(`🔧 Config loaded - RC1: ${config.RC1}, RC2: ${config.RC2}`);
            
        //    appLog("Config loaded from file (fallback)");
        } catch (error) {
        //    appLog("Failed to load config from file:", error);
            return;
        }
    }
    if (config.aiPredictorEnabled !== undefined) {
        aiPredictorEnabled = config.aiPredictorEnabled === "true" || config.aiPredictorEnabled === true;
        appLog(`🧠 AI Predictor ${aiPredictorEnabled ? 'ENABLED' : 'DISABLED'}`);
    }
    
    // Process arrays and booleans - handle both with and without '1' suffix
    const blackListSource = config.blackListRival || config.blackListRival1 || [];
    const whiteListSource = config.whiteListMember || config.whiteListMember1 || [];
    
    blackListRival = Array.isArray(blackListSource) ? blackListSource : 
        (typeof blackListSource === 'string' ? blackListSource.split(',').map(name => name.trim()) : []);
    whiteListMember = Array.isArray(whiteListSource) ? whiteListSource : 
        (typeof whiteListSource === 'string' ? whiteListSource.split(',').map(name => name.trim()) : []);
    
    // Clear rival cache when whitelist/blacklist changes to ensure updates take effect
    rivalCache.clear();
    
    // Convert booleans - handle both string and boolean values explicitly, with and without '1' suffix
    config.standOnEnemy = (config.standOnEnemy || config.standOnEnemy1) === "true" || (config.standOnEnemy || config.standOnEnemy1) === true;
    config.actionOnEnemy = (config.actionOnEnemy || config.actionOnEnemy1) === "true" || (config.actionOnEnemy || config.actionOnEnemy1) === true;
    config.aiChatToggle = (config.aiChatToggle || config.aiChatToggle1) === "true" || (config.aiChatToggle || config.aiChatToggle1) === true;
    config.dualRCToggle = (config.dualRCToggle || config.dualRCToggle1) === "true" || (config.dualRCToggle || config.dualRCToggle1) === true;
    config.kickAllToggle = (config.kickAllToggle || config.kickAllToggle1) === "true" || (config.kickAllToggle || config.kickAllToggle1) === true;
    
    // Log config updates for debugging
    if (newConfig) {
        appLog(`🔄 Config updated - dualRCToggle: ${config.dualRCToggle}, standOnEnemy: ${config.standOnEnemy}`);
    }
    
    // Always update timing states when config is received (both start and update)
    if (newConfig || !newConfig) {
        // Debug log ALL config keys and values
       // appLog(`🔍 Full config received:`, JSON.stringify(config, null, 2));
       // appLog(`🔍 Config keys:`, Object.keys(config));
       // appLog(`🔍 Specific timing values:`, {
        //     RC1_startAttackTime: config.RC1_startAttackTime,
        //     RC1_startDefenceTime: config.RC1_startDefenceTime,
        //     RC2_startAttackTime: config.RC2_startAttackTime,
        //     RC2_startDefenceTime: config.RC2_startDefenceTime,
        //     types: {
        //         RC1_startAttackTime: typeof config.RC1_startAttackTime,
        //         RC1_startDefenceTime: typeof config.RC1_startDefenceTime,
        //         RC2_startAttackTime: typeof config.RC2_startAttackTime,
        //         RC2_startDefenceTime: typeof config.RC2_startDefenceTime
        //     }
        // });
        
        // Parse timing values from config parameters - handle both with and without '1' suffix
        const rc1AttackTime = parseInt(config.RC1_startAttackTime || config.RC1_startAttackTime1) || 1700;
        const rc1DefenseTime = parseInt(config.RC1_startDefenceTime || config.RC1_startDefenceTime1) || 1700;
        const rc2AttackTime = parseInt(config.RC2_startAttackTime || config.RC2_startAttackTime1) || 1700;
        const rc2DefenseTime = parseInt(config.RC2_startDefenceTime || config.RC2_startDefenceTime1) || 1725;
        
        // Always update all timing states
        globalTimingState.RC1.attack.currentTime = rc1AttackTime;
        globalTimingState.RC1.defense.currentTime = rc1DefenseTime;
        globalTimingState.RC1.currentTime = rc1AttackTime;
        
        globalTimingState.RC2.attack.currentTime = rc2AttackTime;
        globalTimingState.RC2.defense.currentTime = rc2DefenseTime;
        globalTimingState.RC2.currentTime = rc2AttackTime;
        
        appLog(`🔄 Global Timing States Updated:`);
    appLog(`   RC1: Attack=${rc1AttackTime}ms, Defense=${rc1DefenseTime}ms`);
    appLog(`   RC2: Attack=${rc2AttackTime}ms, Defense=${rc2DefenseTime}ms`);
        
        // Update existing connections immediately
        connectionPool.forEach(conn => {
            if (conn.timingState) {
                conn.timingState.attack = { currentTime: conn.rcKey === 'RC1' ? rc1AttackTime : rc2AttackTime };
                conn.timingState.defense = { currentTime: conn.rcKey === 'RC1' ? rc1DefenseTime : rc2DefenseTime };
                appLog(`🔄 Updated connection ${conn.botId || 'pending'} (${conn.rcKey}) timing states`);
            }
        });
        if (activeConnection && activeConnection.timingState) {
            const isRC1 = activeConnection.rcKey === 'RC1';
            activeConnection.timingState.attack = { currentTime: isRC1 ? rc1AttackTime : rc2AttackTime };
            activeConnection.timingState.defense = { currentTime: isRC1 ? rc1DefenseTime : rc2DefenseTime };
            appLog(`🔄 Updated active connection ${activeConnection.botId || 'pending'} (${activeConnection.rcKey}) timing states`);
        }
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
      //ved config update via WebSocket:`, data.config);
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
appLog(`🚀 Galaxy service initialized with RC1: ${config.RC1}, RC2: ${config.RC2}`);
connectToAPI();

// Fallback file watching (only used if WebSocket is not available)
let configLastModified = 0;
const configPath = './config1.json';

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
    const globalStateForRC = globalTimingState[rcKey];
    
    // Parse config values with proper parameter names - handle both with and without '1' suffix
    const configStart = isAttack ? 
        parseInt(config[`${rcKey}_startAttackTime`] || config[`${rcKey}_startAttackTime1`]) || 1700 :
        parseInt(config[`${rcKey}_startDefenceTime`] || config[`${rcKey}_startDefenceTime1`]) || 1700;
    const configStop = isAttack ? 
        parseInt(config[`${rcKey}_stopAttackTime`] || config[`${rcKey}_stopAttackTime1`]) || 1750 :
        parseInt(config[`${rcKey}_stopDefenceTime`] || config[`${rcKey}_stopDefenceTime1`]) || 1775;
    const configInterval = isAttack ? 
        parseInt(config[`${rcKey}_attackIntervalTime`] || config[`${rcKey}_attackIntervalTime1`]) || 5 :
        parseInt(config[`${rcKey}_defenceIntervalTime`] || config[`${rcKey}_defenceIntervalTime1`]) || 5;

    if (errorType !== 'success') {
        globalStateForRC.consecutiveErrors++;
    } else {
        globalStateForRC.consecutiveErrors = 0;
    }

    // Update the specific mode timing state
    const modeState = isAttack ? globalStateForRC.attack : globalStateForRC.defense;
    const oldTime = modeState.currentTime;
    modeState.currentTime += configInterval;

    if (modeState.currentTime > configStop) {
        modeState.currentTime = configStart;
        globalStateForRC.consecutiveErrors = 0;
        appLog(`${mode} timing for ${connection.botId} (${rcKey}) cycled back to start: ${modeState.currentTime}ms`);
    } else {
        appLog(`${mode} timing for ${connection.botId} (${rcKey}) incremented: ${oldTime}ms -> ${modeState.currentTime}ms`);
    }

    // Also update the general currentTime for backward compatibility
    globalStateForRC.currentTime = modeState.currentTime;
    globalStateForRC.lastMode = mode;

    // Update the connection's timing state to reflect the global state immediately
    connection.timingState.currentTime = modeState.currentTime;

    return modeState.currentTime;
}

async function getCurrentTiming(mode, connection, rivalId = null, rivalName = null, loginTime = null) {
    // If AI predictor is enabled and we have rival data, use AI prediction
    if (aiPredictorEnabled && rivalId && rivalName && loginTime) {
        try {
            // **ENHANCED SESSION DATA WITH HUMAN DETECTION**
            const sessionData = {
                activityLevel: getRivalActivityLevel(rivalId) || 0.7,
                movementFreq: getRivalMovementFreq(rivalId) || 0.5,
                interactionRate: getRivalInteractionRate(rivalId) || 0.6,
                networkLatency: connection.lastPingTime || 50,
                systemLoad: getSystemLoad(),
                currentTime: Date.now(),
                
                // **CRITICAL HUMAN DETECTION ENHANCEMENTS**
                sessionDuration: Date.now() - loginTime,
                connectionSpeed: connection.lastPingTime <= 10 ? 'instant' : 'normal',
                rivalActivityProfile: rivalActivityProfiles.get(rivalId),
                isQuickSession: (Date.now() - loginTime) < 1000,
                isPerfectActivity: getRivalActivityLevel(rivalId) === 1.0,
                hasInstantMovements: getRivalMovementFreq(rivalId) >= 0.95,
                
                // **NEW: HUMAN BEHAVIOR INDICATORS**
                hasVariableDelay: checkVariableHumanDelay(rivalId),
                showsHumanPatterns: detectHumanInteractionPatterns(rivalId),
                hasNaturalActivity: checkNaturalActivityPattern(rivalId),
                isLikelyHuman: assessHumanLikelihood(rivalId, rivalName, loginTime)
            };
            
            const aiPrediction = await aiPredictor.predictOptimalTiming(
                rivalId, 
                rivalName, 
                loginTime, 
                mode, 
                sessionData
            );
            
            // **HUMAN PROTECTION LAYER**
            let finalTiming = aiPrediction;
            if (sessionData.isLikelyHuman >= 0.7) { // 70% human confidence
                finalTiming = applyHumanProtectionTiming(aiPrediction, mode, sessionData);
                appLog(`👤 Human detected: ${rivalName} - Applied protection timing: ${finalTiming}ms`);
            }
            
            // Apply timing constraints
            const constrainedTiming = applyTimingConstraints(finalTiming, mode);
            
            appLog(`🎯 AI Prediction: ${rivalName} (${mode}) = ${constrainedTiming}ms [original: ${aiPrediction}ms]`);
            return constrainedTiming;
            
        } catch (error) {
            appLog(`❌ AI Prediction failed: ${error.message}, falling back to manual timing`);
            // Fall through to original logic
        }
    }
    
    // ORIGINAL TIMING LOGIC with human protection enhancement
    const isAttack = mode === 'attack';
    const rcKey = connection.rcKey;
    const globalStateForRC = globalTimingState[rcKey];
    
    let timing;
    if (isAttack) {
        timing = globalStateForRC.attack.currentTime !== null ? 
            globalStateForRC.attack.currentTime : 
            parseInt(config[`${rcKey}_startAttackTime`] || config[`${rcKey}_startAttackTime1`]) || 1700;
    } else {
        timing = globalStateForRC.defense.currentTime !== null ? 
            globalStateForRC.defense.currentTime : 
            parseInt(config[`${rcKey}_startDefenceTime`] || config[`${rcKey}_startDefenceTime1`]) || 1700;
    }
    
    // **ENHANCED HUMAN PROTECTION FOR MANUAL TIMING**
    if (rivalName && rivalId) {
        const humanLikelihood = assessHumanLikelihood(rivalId, rivalName, loginTime);
        if (humanLikelihood >= 0.7) { // 70% human confidence
            // Apply conservative timing for humans
            if (isAttack) {
                timing = Math.max(timing + 100, 1600); // Add 100ms safety buffer, minimum 1600ms
            } else {
                timing = Math.max(timing + 150, 1650); // Add 150ms safety buffer, minimum 1650ms
            }
            appLog(`👤 Manual Human Protection: ${rivalName} - Extended timing to ${timing}ms`);
        }
    }
    
    // Apply constraints to manual timing too
    const constrainedTiming = applyTimingConstraints(timing, mode);
    appLog(`🕰️ Manual Timing: mode=${mode}, rcKey=${rcKey}, timing=${constrainedTiming}ms, rival=${rivalName}`);
    return constrainedTiming;
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
    
    // Safety check for undefined RC values
    if (!rcValue) {
        appLog(`❌ ERROR: ${rcKey} is undefined! Config RC1: ${config.RC1}, RC2: ${config.RC2}`);
        appLog(`❌ Available config keys: ${Object.keys(config).join(', ')}`);
        throw new Error(`RC value ${rcKey} is undefined - check your config file`);
    }
    
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
        timingState: { currentTime: null, lastMode: null, consecutiveErrors: 0 }, // Per-connection timing state, will be synced with global
        
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
                        // Track rival activity for AI prediction ONLY for actual rivals (blacklist or kickall enabled)
                        if (parts.length >= 4) {
                            const rivalName = parts.length >= 5 && REGEX_PATTERNS.userId.test(parts[3]) ? parts[2] : parts[1];
                            const rivalId = parts.length >= 5 && REGEX_PATTERNS.userId.test(parts[3]) ? parts[3] : parts[2];
                            
                            if (rivalId && REGEX_PATTERNS.userId.test(rivalId)) {
                                // Only track activity for actual rivals
                                const classification = classifyRival(rivalName, rivalId, this);
                                if (classification.isRival) {
                                    const isRejoining = rivalActivityProfiles.has(rivalId);
                                    trackRivalActivity(rivalId, 'activity', { type: 'join', timestamp: Date.now(), isRejoining });
                                    appLog(`📊 Tracking JOIN activity for rival: ${rivalName} (${rivalId})`);
                                }
                            }
                        }
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
                                // **OPTIMIZED: Check if user is a potential rival FIRST**
                                const classification = classifyRival(userName, userId, this);
                                
                                if (classification.isRival) {
                                    // Only log and process for actual rivals
                                    appLog(`🚪 RIVAL PART: ${userName} (${userId}) departed`);
                                    
                                    // Track rival departure for AI learning
                                    trackRivalActivity(userId, 'activity', { type: 'part', timestamp: Date.now() });
                                    
                                    // CRITICAL: Update AI session history with actual session duration
                                    const rivalData = trackedRivals.get(userId);
                                    const syncedRivalProfile = rivalActivityProfiles.get(userId);
                                    const loginTime = syncedRivalProfile?.loginTime || (rivalData && rivalData.loginTime);
                    
                                    if (loginTime && aiPredictorEnabled) {
                                        const currentTime = Date.now();
                                        const actualSessionDuration = currentTime - loginTime;
                                        try {
                                            aiPredictor.updateRivalSessionHistory(userId, actualSessionDuration, 'departed_part');
                                            appLog(`📊 PART: Updated session history for rival ${userName}: ${actualSessionDuration}ms`);
                                        } catch (error) {
                                            appLog(`❌ PART: AI session history update failed: ${error.message}`);
                                        }
                                    }
                                    
                                    handleRivalDeparture(userId, userName);
                                }
                                // No logging for non-rivals to reduce noise
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
                                // **OPTIMIZED: Check if user is a potential rival FIRST**
                                const classification = classifyRival(userName, userId, this);
                                
                                if (classification.isRival) {
                                    // Only log and process for actual rivals
                                    appLog(`😴 RIVAL SLEEP: ${userName} (${userId}) went to sleep`);
                                    
                                    // Track rival sleep for AI learning
                                    trackRivalActivity(userId, 'activity', { type: 'sleep', timestamp: Date.now() });
                                    
                                    // CRITICAL: Update AI session history with actual session duration
                                    const rivalData = trackedRivals.get(userId);
                                    const rivalProfile = rivalActivityProfiles.get(userId);
                                    const loginTime = rivalProfile?.loginTime || rivalData?.loginTime;
                    
                                    if (loginTime && aiPredictorEnabled) {
                                        const currentTime = Date.now();
                                        const actualSessionDuration = currentTime - loginTime;
                                        aiPredictor.updateRivalSessionHistory(userId, actualSessionDuration, 'departed_sleep');
                                        appLog(`📊 SLEEP: Updated session history for rival ${userName}: ${actualSessionDuration}ms`);
                                    }
                                    
                                    handleRivalDeparture(userId, userName);
                                }
                                // No logging for non-rivals to reduce noise
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
                                                // Removed noisy log for 353 processing during prison release
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
                        const is3SecondRule = payload.includes("3 секунд(ы)") || payload.includes("Нельзя");
                        const kickSuccess = !is3SecondRule;
                        
                        // Enhanced 3-second rule processing with immediate feedback
                        if (lastKickedRival && lastKickedRival.predictedTiming) {
                            const actualSessionDuration = Date.now() - lastKickedRival.loginTime;
                            
                            // CRITICAL: Record session duration for successful kicks in AI history
                            if (kickSuccess && aiPredictorEnabled) {
                                aiPredictor.updateRivalSessionHistory(lastKickedRival.id, actualSessionDuration, 'kicked_successfully');
                                appLog(`📊 KICK SUCCESS: Updated session history for ${lastKickedRival.name}: ${actualSessionDuration}ms`);
                            }
                            
                            // Immediate AI feedback processing (within 50ms as per AI pilot context)
                            processThreeSecondRuleFeedback(
                                lastKickedRival.id,
                                lastKickedRival.predictedTiming,
                                is3SecondRule
                            );
                            
                            // Log outcome for ML training
                            mlDataLogger.logOutcome(
                                lastKickedRival.id,
                                lastKickedRival.predictedTiming,
                                kickSuccess,
                                actualSessionDuration,
                                {
                                    wasThreeSecondRule: is3SecondRule,
                                    mode: lastKickedRival.mode,
                                    timingError: is3SecondRule ? 50 : 0
                                }
                            );
                            
                            appLog(`📊 Enhanced AI Feedback: Rival=${lastKickedRival.name}, Success=${kickSuccess}, 3sRule=${is3SecondRule}, Duration=${actualSessionDuration}ms`);
                        }
                        
                        // Original timing adjustment logic (as fallback)
                        if (is3SecondRule) {
                            appLog(`⚡ 3-second rule detected. Immediate Exit and re-evaluation.`);
                            if (currentMode === 'attack' || currentMode === 'defence') {
                                const newTiming = incrementTiming(currentMode, this, '3second');
                                appLog(`Adjusted ${currentMode} timing due to 3-second rule: ${newTiming}ms`);
                            }
                        } else {
                            appLog(`⚡⚡KICKED Rival in mode: ${currentMode} - ${payload}`);
                            if (currentMode === 'attack' || currentMode === 'defence') {
                                const newTiming = incrementTiming(currentMode, this, 'success');
                                appLog(`Adjusted ${currentMode} timing due to kick: ${newTiming}ms`);
                            }
                        }
                        
                        // Reset processing flags and cleanup
                        isProcessingRivalAction = false;
                        if (processingRivalTimeout) {
                            clearTimeout(processingRivalTimeout);
                            processingRivalTimeout = null;
                        }
                        
                        this.send("QUIT :ds");
                        await this.cleanup();
                        if (activeConnection === this) {
                            activeConnection = null;
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

async function scheduleRivalKick(rivalId, rivalData) {
    // Check for preemptive logout first
    const preemptiveLogout = detectPreemptiveLogout(rivalId);
    if (preemptiveLogout.shouldKick) {
        appLog(`⚡ Preemptive logout kick scheduled: ${rivalData.name} in 12ms (confidence: ${preemptiveLogout.confidence.toFixed(2)})`);
        
        // Log preemptive prediction
        if (aiPredictorEnabled) {
            mlDataLogger.logPrediction(
                rivalId,
                'preemptive',
                12,
                {
                    sessionDuration: Date.now() - rivalData.loginTime,
                    logoutProbability: preemptiveLogout.confidence,
                    activityLevel: getRivalActivityLevel(rivalId)
                },
                preemptiveLogout.confidence
            );
        }
        
        // Schedule immediate kick
        rivalData.kickTimeout = setTimeout(() => {
            executeRivalKick(rivalId, rivalData);
        }, 12); // 12ms delay for preemptive kick
        
        return;
    }
    
    // Pass rival information to getCurrentTiming for AI prediction (single call to avoid duplicates)
    const waitTime = await getCurrentTiming(
        rivalData.mode, 
        rivalData.connection, 
        rivalId, 
        rivalData.name, 
        rivalData.loginTime
    );

    // Use the same timing value to avoid duplicate AI predictions
    lastPredictedTiming = waitTime;
    const presenceCheckTime = Math.max(0, waitTime - 200);
    
    // High precision scheduling
    const scheduleTime = getHighPrecisionTime();
    rivalData.scheduledTime = scheduleTime + waitTime;
    rivalData.predictedTiming = waitTime; // Store for feedback
    
    // Log prediction for ML training
    if (aiPredictorEnabled) {
        mlDataLogger.logPrediction(
            rivalId,
            rivalData.mode,
            waitTime,
            {
                sessionDuration: Date.now() - rivalData.loginTime,
                activityLevel: getRivalActivityLevel(rivalId),
                movementFreq: getRivalMovementFreq(rivalId)
            },
            0.8 // Default confidence
        );
    }
    
    appLog(`📅 AI Scheduling rival ${rivalData.name} (${rivalData.mode}) - Wait: ${waitTime}ms, Check: ${presenceCheckTime}ms`);
    
    // Rest of original scheduling logic remains the same
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
        return;
    }
    
    // CRITICAL: Store rival data for AI feedback
    lastKickedRival = {
        id: rivalId,
        name: rivalData.name,
        loginTime: rivalData.loginTime,
        predictedTiming: rivalData.predictedTiming,
        mode: rivalData.mode
    };
    
    // IMPORTANT: Mark rival as being kicked but DON'T remove from tracking yet
    // We need to keep the rivalData until we get 850 response OR PART/SLEEP command
    rivalData.beingKicked = true;
    rivalData.kickStartTime = Date.now();
    
    // Clear the scheduled timeouts since we're executing now
    if (rivalData.kickTimeout) {
        clearTimeout(rivalData.kickTimeout);
        rivalData.kickTimeout = null;
    }
    if (rivalData.presenceCheckTimeout) {
        clearTimeout(rivalData.presenceCheckTimeout);
        rivalData.presenceCheckTimeout = null;
    }
    
    if (isProcessingRivalAction) {
        appLog(`⚠️ Rival action already in progress, skipping ${rivalData.name}`);
        return;
    }
    
    isProcessingRivalAction = true;
    appLog(`⚡ Executing AI-scheduled kick for rival ${rivalData.name} (predicted: ${rivalData.predictedTiming}ms)`);
    
    processingRivalTimeout = setTimeout(() => {
        if (isProcessingRivalAction) {
            appLog(`⏰ Processing timeout - resetting flags`);
            isProcessingRivalAction = false;
            processingRivalTimeout = null;
            
            // Clean up rival tracking on timeout
            cleanupRivalTracking(rivalId);
        }
    }, 5000); // Extended timeout to allow for PART/SLEEP commands
    
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
        
        // Send feedback to AI about early departure
        if (rivalData.predictedTiming && rivalData.loginTime) {
            const actualSessionDuration = Date.now() - rivalData.loginTime;
            
            aiPredictor.processFeedback(
                rivalId,
                rivalData.predictedTiming,
                false, // Early departure = failed prediction
                actualSessionDuration
            ).catch(error => {
                appLog(`❌ AI Early departure feedback error: ${error.message}`);
            });
            
            appLog(`📊 AI Early departure feedback: Duration=${actualSessionDuration}ms vs Predicted=${rivalData.predictedTiming}ms`);
        }
        
        // CRITICAL: Clean up rival tracking to allow rejoining
        cleanupRivalTracking(rivalId);
        appLog(`🧹 Cleaned up tracking for ${rivalName} (${rivalId}) - ready for rejoin`);
        return true;
    } else {
        // CRITICAL: Even if no rivalData, ensure tracking is cleared for rejoining
        appLog(`🧹 Force cleanup tracking for ${rivalName} (${rivalId}) - no existing data but ensuring clean state`);
        cleanupRivalTracking(rivalId);
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
                    } else if (trackedRivals.has(rival.id)) {
                        // **FORCE CLEANUP AND RETRY - Same as handleJoinCommand**
                        cleanupRivalTracking(rival.id);
                        appLog(`🧹 353: Force cleaned tracking for ${rival.name} (${rival.id})`);
                        
                        // Retry immediately after cleanup
                        addToBatch(rival, 'defence', connection);
                        appLog(`📋 353: Force queued rival ${rival.name} for defence mode after cleanup`);
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
                } else if (trackedRivals.has(id)) {
                    // **FORCE CLEANUP AND RETRY**
                    cleanupRivalTracking(id);
                    appLog(`🧹 Force cleaned tracking for ${name} (${id})`);
                    
                    // Retry immediately after cleanup
                    const rival = { name, id, coordinate };
                    addToBatch(rival, 'attack', connection);
                    appLog(`📋 Force queued rival ${name} for attack mode after cleanup`);
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
    .then(() => {
        // Removed noisy "Optimized connection initialized" log
    })
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
