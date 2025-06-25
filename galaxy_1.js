const WebSocket = require('ws');
const fs = require('fs').promises;
const fsSync = require('fs');
const CryptoJS = require('crypto-js');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const { MISTRAL_API_KEY } = require('./src/secrets/mistral_api_key');

const LOG_FILE_PATH = 'galaxy_1.log';
const LOG_FILE_MAX_SIZE_BYTES = 1024 * 1024; // 1 MB
const LOG_CLEANUP_INTERVAL_MS = 30 * 1000; // 30 seconds

const originalConsoleLog = console.log;
const originalConsoleError = console.error;

const logQueue = [];
let logWriteInProgress = false;

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

function appLog(message, ...args) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message} ${args.map(arg => JSON.stringify(arg)).join(' ')}\n`;
    logQueue.push(logMessage);
    originalConsoleLog(message, ...args); // Also log to console
    // Trigger processing immediately, but it will be debounced by processLogQueue's flag
    processLogQueue();
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

// Optimized Connection Pool Settings
const POOL_MIN_SIZE = 1;
const POOL_MAX_SIZE = 1;
const POOL_TARGET_SIZE = 1;
const POOL_HEALTH_CHECK_INTERVAL = 15000; // 10 seconds for frequent checks
const CONNECTION_MAX_AGE = 10 * 60 * 1000; // 2 minutes
const CONNECTION_IDLE_TIMEOUT = 1 * 60 * 1000; // 1 minute

// Prison Pool Settings
const PRISON_POOL_MIN_SIZE = 1;
const PRISON_POOL_MAX_SIZE = 1;
const PRISON_POOL_TARGET_SIZE = 1;
const PRISON_CONNECTION_MAX_AGE = 1 * 60 * 1000; // 1 minute for rapid turnover

let poolMaintenanceInProgress = false;
let prisonMaintenanceInProgress = false;
let lastCloseTime = 0;
// Configuration
let config;
let blackListRival = [];
let whiteListMember = [];
let userMap = {};
let isOddReconnectAttempt = true; // Controls the odd/even alternation for reconnection delays
let currentMode = null;
let currentConnectionPromise = null; // New global variable to track ongoing connection attempts
let pendingRivals = new Map(); // Stores {name: {id, connection, mode}} for rivals detected in a short window
let rivalProcessingTimeout = null; // Timeout for debouncing rival actions
let founderIds = new Set(); // Stores IDs of founders to be skipped
let isProcessingRivalAction = false; // New flag to prevent new rival processing during an ongoing action

// Connection pool settings
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BACKOFF_BASE = 50; // Ultra-fast backoff base
const DUAL_RC_BACKOFF_BASE = 1500;
const DUAL_RC_MAX_BACKOFF = 3500; // Updated based on user's request for even backoff of 2500
const connectionPool = [];
let activeConnection = null;

// Prison pool settings
const prisonConnectionPool = [];

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

// Connection states
const CONNECTION_STATES = {
    CLOSED: 'closed',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    HASH_RECEIVED: 'hash_received',
    AUTHENTICATED: 'authenticated',
    READY: 'ready'
};

// Attack and defense timing variables
let currentAttackTime;
let currentDefenceTime;
let monitoringMode = true;
let isReconnectingAfterRivalAction = false; // New flag to manage reconnection state

// Recovery code alternation
let lastUsedRC = 'RC2'; // Start with RC2 so first connection uses RC1

function getNextRC() {
    if (config.dualRCToggle === false) {
    //    appLog("dualRCToggle is false, using only RC1 for reconnection.");
        return 'RC1';
    }
    lastUsedRC = lastUsedRC === 'RC1' ? 'RC2' : 'RC1';
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

function updateConfigValues() {
    let retries = 0;
    const maxRetries = 3;
    const retryDelay = 50; // ms

    function tryLoadConfig() {
        try {
            // Force Node.js to reload the config file from disk
            delete require.cache[require.resolve('./config1.json')];
            
            // Read the file directly first to ensure we're getting the latest version
            const configRaw = fsSync.readFileSync('./config1.json', 'utf8');
            let configData;
            
            try {
                configData = JSON.parse(configRaw);
            } catch (parseError) {
                appLog("Error parsing config JSON:", parseError);
                throw parseError;
            }
            
            // Update the config object
            config = configData;
            
            // Process blackListRival and whiteListMember names
            blackListRival = Array.isArray(config.blackListRival) ? config.blackListRival : config.blackListRival.split(',').map(name => name.trim());
            whiteListMember = Array.isArray(config.whiteListMember) ? config.whiteListMember : config.whiteListMember.split(',').map(name => name.trim());
            
            // Validate required fields
            if (!config.RC1 || !config.RC2) {
                throw new Error("Config must contain both RC1 and RC2");
            }
            
            // Convert string booleans to actual booleans
            config.standOnEnemy = config.standOnEnemy === "true" || config.standOnEnemy === true;
            config.actionOnEnemy = config.actionOnEnemy === "true" || config.actionOnEnemy === true;
            config.aiChatToggle = config.aiChatToggle === "true" || config.aiChatToggle === true;
            config.dualRCToggle = config.dualRCToggle === "true" || config.dualRCToggle === true;
            config.kickAllToggle = config.kickAllToggle === "true" || config.kickAllToggle === true;
            
            if (typeof config.actionOnEnemy === 'undefined') {
                throw new Error("Config must contain actionOnEnemy");
            }
            
            // Re-initialize timing states for all connections if needed
            // Initialize global timing states for each RC if they haven't been set or if config changes
            if (globalTimingState.RC1.attack.currentTime === null) {
                globalTimingState.RC1.attack.currentTime = config.RC1_startAttackTime;
                globalTimingState.RC1.attack.lastMode = null;
                globalTimingState.RC1.attack.consecutiveErrors = 0;
            }
            if (globalTimingState.RC1.defense.currentTime === null) {
                globalTimingState.RC1.defense.currentTime = config.RC1_startDefenceTime;
                globalTimingState.RC1.defense.lastMode = null;
                globalTimingState.RC1.defense.consecutiveErrors = 0;
            }
            if (globalTimingState.RC2.attack.currentTime === null) {
                globalTimingState.RC2.attack.currentTime = config.RC2_startAttackTime;
                globalTimingState.RC2.attack.lastMode = null;
                globalTimingState.RC2.attack.consecutiveErrors = 0;
            }
            if (globalTimingState.RC2.defense.currentTime === null) {
                globalTimingState.RC2.defense.currentTime = config.RC2_startDefenceTime;
                globalTimingState.RC2.defense.lastMode = null;
                globalTimingState.RC2.defense.consecutiveErrors = 0;
            }

            // Re-initialize timing states for all connections if needed
            // This should now pull from the global state based on their rcKey
            connectionPool.forEach(conn => {
                initializeTimingStates(conn);
            });
            
            if (activeConnection) {
                initializeTimingStates(activeConnection);
            }
        } catch (error) {
            if (retries < maxRetries) {
                retries++;
            //    appLog(`Retrying to load config (attempt ${retries}/${maxRetries})...`);
                setTimeout(tryLoadConfig, retryDelay);
            } else {
            //    appLog("Failed to update config after retries:", error);
            }
        }
    }

    tryLoadConfig();
}
updateConfigValues();

// More robust file watching with polling fallback for PM2 compatibility
let configLastModified = 0;
const configPath = './config1.json';

// Primary file watcher
fsSync.watch(configPath, { persistent: true }, (eventType) => {
    if (eventType === 'change') {
        try {
            const stats = fsSync.statSync(configPath);
            const mtime = stats.mtimeMs;
            
            // Only update if the file has actually changed (prevents duplicate updates)
            if (mtime > configLastModified) {
                configLastModified = mtime;
            //    appLog(`Config file changed (${new Date().toISOString()}), updating values...`);
                updateConfigValues();
            }
        } catch (err) {
        //    appLog('Error checking config file stats:', err);
        }
    }
});

// Fallback polling mechanism for PM2 environments where file watchers might be unreliable
const CONFIG_POLL_INTERVAL = 50; // Check every 50 milliseconds for ultra-fast updates
setInterval(() => {
    try {
        const stats = fsSync.statSync(configPath);
        const mtime = stats.mtimeMs;
        
        if (mtime > configLastModified) {
            configLastModified = mtime;
        //    appLog(`Config change detected via polling (${new Date().toISOString()}), updating values...`);
            updateConfigValues();
        }
    } catch (err) {
    //    appLog('Error polling config file:', err);
    }
}, CONFIG_POLL_INTERVAL);

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
    // It should always be initialized by updateConfigValues, but a fallback is good.
    return globalStateForRC.currentTime !== null ? globalStateForRC.currentTime : (isAttack ? config[`${rcKey}_startAttackTime`] : config[`${rcKey}_startDefenceTime`]);
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
        const conn = createConnection();
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
        const conn = createConnection();
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
            if (!skipCloseTimeCheck && now - lastCloseTime < 500) {
                const waitTime = 1000 - (now - lastCloseTime);
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
            const newConn = createConnection();
            try {
                originalConsoleLog('newConnectionCreation'); // Keep console.time for performance measurement
                await newConn.initialize(false);
                activeConnection = newConn;
                Promise.resolve().then(() => optimizedConnectionPoolMaintenance().catch(err => appLog("Error in post-creation maintenance:", err)));
                resolve(newConn);
            } catch (error) {
                appLog("Failed to create new connection:", error.message || error);
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


function createConnection() {
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
                   // appLog(`Initializing new connection with ${this.rcKey}: ${this.recoveryCode} (stopAtHash: ${stopAtHash})...`);
                    
                    this.socket = new WebSocket("wss://cs.mobstudio.ru:6672/", { rejectUnauthorized: false, handshakeTimeout: 15000 });
                    this.connectionTimeout = setTimeout(() => {
                        appLog("Connection initialization timeout");
                        this.authenticating = false;
                        this.cleanup();
                        reject(new Error("Connection initialization timeout"));
                    }, 30000);
                    
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
                        if (this.authenticating) {
                            this.authenticating = false;
                            clearTimeout(this.connectionTimeout);
                            reject(error);
                        }
                    });
                } catch (err) {
                    appLog("Error during connection initialization:", err);
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
                                                appLog(`AI Chat Error: ${error.message}`);
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
                    //    appLog(`Connection [${this.botId}] authenticated, sending setup commands...`);
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
                    //    appLog(`Connection [${this.botId}] is now READY`);
                        resolve(this);
                        break;
                    case "353":
                        parse353(message, this);
                        break;
                    case "JOIN":
                        handleJoinCommand(parts, this);
                        break;
                    case "PART":
                        if (parts.length >= commandIndex + 2) remove_user(parts[commandIndex + 1]);
                        break;
                    case "KICK":
                    //    appLog(`🔓 KICK command detected: ${message}`);
                        if (parts.length >= commandIndex + 3) {
                            const kickedUserId = parts[commandIndex + 2];
                            const isReleasedFromPrison = message.toLowerCase().includes("released") || message.toLowerCase().includes("освободили");
                            if (isReleasedFromPrison) {
                                appLog(`🎉 Bot ${this.botId} was released from prison, executing parallel release process...`);
                                
                                const parallelTasks = [];
                                
                                const joinTask = new Promise((resolve, reject) => {
                                    let joinAttempts = 0;
                                    const maxJoinAttempts = 10;
                                    
                                    const attemptJoin = () => {
                                        joinAttempts++;
                                    //    appLog(`JOIN attempt ${joinAttempts}/${maxJoinAttempts} for ${this.botId}`);
                                        
                                        const kickListener = (event) => {
                                            const message = event.data.toString().trim();
                                        //    appLog(`JOIN attempt ${joinAttempts} received: ${message}`);
                                            
                                            if (message.includes("KICK") && message.includes("Нельзя перелетать чаще одного раза в 3 с.")) {
                                                appLog(`🚫 3-second rule detected on ${joinAttempts}`);
                                                this.socket.removeEventListener('message', kickListener);
                                                if (joinAttempts < maxJoinAttempts) {
                                                //    appLog(`⏳ Retrying in 200ms... (attempt ${joinAttempts + 1}/${maxJoinAttempts})`);
                                                    setTimeout(() => {
                                                        attemptJoin();
                                                    }, 200);
                                                } else {
                                                 //   appLog(`❌ Max attempts (${maxJoinAttempts}) reached for ${this.botId}`);
                                                    reject(new Error(`Failed after ${maxJoinAttempts} attempts due to 3-second rule`));
                                                }
                                            } else if (message.includes("JOIN") && !message.includes("KICK")) {
                                                appLog(`✅ Successful for ${this.botId} on attempt ${joinAttempts}`);
                                                this.socket.removeEventListener('message', kickListener);
                                                resolve('join_complete');
                                            }
                                        };
                                        
                                        this.socket.addEventListener('message', kickListener);
                                        
                                        setTimeout(() => {
                                            this.send(`JOIN ${config.planetName}`);
                                         //   appLog(`Command sent for ${this.botId} (attempt ${joinAttempts})`);
                                            
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
                                
                                if (this.password) {
                                    const httpTask = performJailFreeWithRetry(this, 3, 1000)
                                        .then(() => {
                                        //    appLog(`HTTP jail_free completed for ${this.botId}`);
                                            return 'http_complete';
                                        })
                                        .catch(error => {
                                        //    appLog(`HTTP jail_free failed for ${this.botId}:`, error.message);
                                            return 'http_failed';
                                        });
                                    parallelTasks.push(httpTask);
                                }
                                
                                Promise.allSettled(parallelTasks).then(async (results) => {
                                //    appLog(`Parallel tasks completed for ${this.botId}:`, results.map(r => r.value || r.reason));
                                    
                                //    appLog(`⚡ Sending QUIT command for fast relogin [${this.botId}]`);
                                    this.send("QUIT :ds");
                                    this.prisonState = 'IDLE';
                                    
                                //    appLog(`⚡ Waiting for connection ${this.botId} to close before relogin`);
                                    await this.cleanup();
                                    if (activeConnection === this) {
                                        activeConnection = null;
                                    }
                                    isProcessingRivalAction = false; // Ensure flag is reset before new connection
                                    
                                //    appLog(`⚡ Connection closed, using dedicated prison connection for relogin`);
                                    try {
                                        originalConsoleLog('prisonRelogin'); // Keep console.time for performance measurement
                                        await getPrisonConnection();
                                        originalConsoleLog('prisonRelogin'); // Keep console.timeEnd for performance measurement
                                        appLog(`✅ Fast prison relogin completed`);
                                    } catch (error) {
                                        appLog("Failed to get prison connection:", error.message || error);
                                        await getConnection(true).catch(retryError => {
                                            appLog("Prison relogin fallback failed:", retryError.message || retryError);
                                        });
                                    }
                                });
                            }
                        }
                        break;
                    case "451":
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
                            // Introduce a 10-second delay before attempting to get a new connection
                            // setTimeout(() => {
                            //     Promise.resolve().then(() => getConnection(true).catch(err => appLog(`Failed after 452 error:`, e))));
                            // }, 1000); // 10 seconds delay
                            return;
                        } else {
                            this.cleanup();
                        }
                        break;
                    case "850":
                        if (payload.includes("3 секунд(ы)") || payload.includes("Нельзя")) {
                            appLog(`⚡ 3-second rule detected. Immediate QUIT and re-evaluation.`);
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
                            this.send("QUIT :ds");
                            await this.cleanup(); // Ensure connection is fully closed
                             if (activeConnection === this) {
                                 activeConnection = null;
                             }
                            appLog(`⚡⚡KICKED Rival in mode: ${currentMode} - ${payload}`);
                            if (currentMode === 'attack' || currentMode === 'defence') {
                                const newTiming = incrementTiming(currentMode, this, 'success');
                                appLog(`Adjusted ${currentMode} timing due to general error: ${newTiming}ms`);
                                
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
                        appLog("Connection activation timeout");
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
                                    this.socket.removeEventListener('message', authHandler);
                                    
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
    
                            this.socket.addEventListener('message', authHandler);
                            
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
                    this.socket = null;
                    this.authenticating = false;
                } catch (err) {
                    appLog(`Error in cleanup [${this.botId || 'connecting'}]:`, err);
                    resolve(); // Resolve even on error to avoid hanging
                }
            });
            return this.cleanupPromise;
        }
    };
    return conn;
    }

function processPendingRivals() {
    if (rivalProcessingTimeout) {
        clearTimeout(rivalProcessingTimeout);
    }
    rivalProcessingTimeout = setTimeout(() => {
        if (pendingRivals.size > 0) {
            let rivalToActOn = null;
            let rivalConnection = null;
            let rivalMode = null;
            let rivalCoordinate = null; // New variable to store coordinate

            // Iterate through pendingRivals to find the first one that matches criteria
            for (const [name, data] of pendingRivals.entries()) {
                // Re-check if the user is a founder before considering them a rival
                if (founderIds.has(data.id)) {
                    appLog(`Skipping founder ${name} (ID: ${data.id}) from pending rivals list.`);
                    continue; // Skip this entry if it's a founder
                }

                // If kickAllToggle is true, any rival added to pendingRivals is considered valid.
                // Otherwise, only rivals in blackListRival are considered.
                if (config.kickAllToggle || blackListRival.includes(name)) {
                    rivalToActOn = { name: name, id: data.id, coordinate: data.coordinate }; // Include coordinate
                    rivalConnection = data.connection;
                    rivalMode = data.mode;
                    rivalCoordinate = data.coordinate; // Store coordinate
                    break; // Found a rival to act on, exit loop
                }
            }

            if (rivalToActOn && rivalConnection && rivalConnection.state === CONNECTION_STATES.READY) {
                appLog(`🎯 Found matching rival in pending list: ${rivalToActOn.name} (ID: ${rivalToActOn.id}, Coordinate: ${rivalToActOn.coordinate}) from ${rivalMode} mode.`);
                isProcessingRivalAction = true; // Set flag before processing
                handleRivals([rivalToActOn], rivalMode, rivalConnection);
            } else {
                appLog(`No matching rivals found in pending list or connection not ready.`);
            }
            pendingRivals.clear(); // Clear the list after processing
        }
        rivalProcessingTimeout = null;
    }, 50); // Process rivals after a very short debounce period (e.g., 50ms)
}

function parse353(message, connection) {
    if (message.includes('PRISON') || message.includes('Prison') || message.includes('Тюрьма')) {
    //    appLog(`🔒 Prison mention detected: "${message}"`);
        handlePrisonAutomation(connection);
        return;
    }
    
    const colonIndex = message.indexOf(" :");
    const payload = colonIndex !== -1 ? message.substring(colonIndex + 2) : "";
    
    const tokens = payload.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    let i = 0;
    let detectedRivals = [];
    
    while (i < tokens.length) {
        let token = tokens[i];
        if (token === '-') {
            i++;
            continue;
        }
        
        let name = token;
        let hasPrefix = false;
        if (token.length > 1 && (token.startsWith('@') || token.startsWith('+'))) {
            name = token.substring(1);
            hasPrefix = true;
        }
        
        if (name.length === 0) {
            i++;
            continue;
        }
        
        if (name === '-' || name === '@' || name === '+') {
            i++;
            continue;
        }
        
        const isBlackListRival = blackListRival.includes(name);
        const isWhiteListMember = whiteListMember.includes(name);

        if (isBlackListRival) {
            appLog(`🎯 Exact blackListRival match found: "${name}"`);
        }
        if (isWhiteListMember) {
            appLog(`⭐ Exact whiteListMember match found: "${name}"`);
        }
        
        i++;
        
        if (i < tokens.length && /^\d+$/.test(tokens[i]) && tokens[i].length > 5) {
            const id = tokens[i];
            userMap[name] = id;
            
            // Determine if the user is a rival based on kickAllToggle and lists, prioritizing whiteListMember, skipping bot's own ID, and skipping founders
            const isConsideredRival = !isWhiteListMember && (name !== connection.nick) && !founderIds.has(id) && (config.kickAllToggle || isBlackListRival);

            if (isConsideredRival) {
                let coordinate = null;
                if (config.standOnEnemy) {
                    for (let j = i + 1; j < tokens.length; j++) {
                        if (tokens[j] === '@' && j + 5 < tokens.length && /^\d+$/.test(tokens[j + 5])) {
                            coordinate = tokens[j + 5];
                            break;
                        }
                    }
                }
                detectedRivals.push({ name, id, coordinate }); // Add coordinate to detectedRivals
                appLog(`✅ Detected rival [${connection.botId}]: ${name} with ID ${id} (kickAllToggle: ${config.kickAllToggle}, whiteListMember: ${isWhiteListMember}, self: ${name === connection.nick}, owner: ${founderIds.has(id)})`);
            }
            i++;
        }
    }
    
    if (detectedRivals.length > 0 && connection.state === CONNECTION_STATES.READY && !isProcessingRivalAction) { // Check new flag
        detectedRivals.forEach(rival => {
            if (!pendingRivals.has(rival.name)) {
                pendingRivals.set(rival.name, { id: rival.id, connection: connection, mode: 'defence', coordinate: rival.coordinate }); // Pass coordinate
            }
        });
        processPendingRivals();
    } else if (isProcessingRivalAction) {
    }
}

function handleJoinCommand(parts, connection) {
    if (parts.length >= 4) {
        let name = parts.length >= 5 && !isNaN(parts[3]) ? parts[2] : parts[1];
        let id = parts.length >= 5 && !isNaN(parts[3]) ? parts[3] : parts[2];
        userMap[name] = id;
        
        const isBlackListRival = blackListRival.includes(name);
        const isWhiteListMember = whiteListMember.includes(name);

        // Determine if the user is a rival based on kickAllToggle and lists, prioritizing whiteListMember, skipping bot's own ID, and skipping founders
        const isConsideredRival = !isWhiteListMember && (name !== connection.nick) && !founderIds.has(id) && (config.kickAllToggle || isBlackListRival);

        if (isConsideredRival) {
            appLog(`Rival ${name} joined [${connection.botId}] - Attack mode activated (kickAllToggle: ${config.kickAllToggle}, whiteListMember: ${isWhiteListMember}, self: ${name === connection.nick}, owner: ${founderIds.has(id)})`);
            
            let coordinate = null;
            if (config.standOnEnemy) {
                for (let i = parts.length >= 5 ? 4 : 3; i < parts.length; i++) {
                    if (parts[i] === '@' && i + 5 < parts.length && !isNaN(parts[i + 5])) {
                        coordinate = parts[i + 5];
                        break;
                    }
                }
            }
            
            // Add to pending rivals and process
            if (!pendingRivals.has(name) && !isProcessingRivalAction) { // Check new flag
                pendingRivals.set(name, { id: id, connection: connection, mode: 'attack', coordinate: coordinate }); // Pass coordinate
                processPendingRivals();
            } else if (isProcessingRivalAction) {
            }
        } else if (isWhiteListMember) {
        }
    }
}

function remove_user(user) {
    if (userMap[user]) {
        delete userMap[user];
    }
}

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
                appLog(`Jail free response for ${userID}:`, data);
                resolve(data);
            });
            res.on('error', (error) => {
                appLog(`Response error for ${userID}:`, error);
                reject(error);
            });
        });
        
        req.on('error', (error) => {
        //    appLog(`Request error performing jail_free for ${userID}:`, error.message);
            reject(error);
        });
        req.on('timeout', () => {
            appLog(`Request timeout for ${userID}`);
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
            appLog(`❌ Jail free attempt ${attempt}/${maxRetries} failed for ${userID}:`, error.message);
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
    const waitTime = getCurrentTiming(mode, connection);
    appLog(`Handling rivals in ${mode} mode with waitTime: ${waitTime}ms [${connection.botId}]`);
    
    monitoringMode = false;
    
    const ACTION_DELAY = 300; // Fixed delay between ACTION 29 and ACTION 3

    // Select only one detected rival
    const targetRival = rivals[0];
    
    if (!targetRival) {
        return;
    }

    const id = userMap[targetRival.name];
    if (id) {
        // Calculate the delay before ACTION 29 based on the total waitTime
        const delayBeforeAction29 = Math.max(0, waitTime - ACTION_DELAY);

        // Wait for the calculated delay before executing ACTION 29
     //   appLog(`Waiting ${delayBeforeAction29}ms before executing ACTION 29.`);
        await new Promise(resolve => setTimeout(resolve, delayBeforeAction29));

        // 2. Handle first ACTION (ACTION 29) if actionOnEnemy is true and lastActionCommand is available
        if (config.actionOnEnemy && connection.lastActionCommand) {
        //    appLog(`Sending ACTION ${connection.lastActionCommand} to ${targetRival.name} (ID: ${id}) [${connection.botId}]`);
            connection.send(`ACTION ${connection.lastActionCommand} ${id}`);
            connection.lastMoveCommandTime = Date.now(); // Update last move command time
        }
        
        // Wait for ACTION_DELAY before executing ACTION 3
    //    appLog(`Waiting ${ACTION_DELAY}ms before executing ACTION 3.`);
        await new Promise(resolve => setTimeout(resolve, ACTION_DELAY));
        // 1. Handle REMOVE if standOnEnemy is true and coordinate is available
        if (config.standOnEnemy && targetRival.coordinate) {
        //    appLog(`Sending REMOVE ${targetRival.coordinate} for rival ${targetRival.name} (ID: ${id}) [${connection.botId}]`);
            connection.send(`REMOVE ${targetRival.coordinate}`);
            connection.lastMoveCommandTime = Date.now(); // Update last move command time
        } else if (config.standOnEnemy && !targetRival.coordinate) {
        //    appLog(`Config standOnEnemy is true, but no coordinate found for rival ${targetRival.name} for REMOVE command.`);
        }
        // 3. Handle second ACTION (ACTION 3)
        appLog(`Sending ACTION 3 to ${targetRival.name} (ID: ${id}) [${connection.botId}]`);
        connection.send(`ACTION 3 ${id}`);
        connection.lastMoveCommandTime = Date.now(); // Update last move command time

    } else {
        return;
    }
    
    // Introduce a very short delay to allow for immediate server responses (like 850 errors)
    await new Promise(resolve => setTimeout(resolve, 10)); // 10ms delay, effectively yielding to event loop

    // Check if the connection was already handled by an 850 error (i.e., it's no longer activeConnection)
    // If activeConnection is null or different, it means the 850 handler already took over and cleaned up/reconnected.
    if (!activeConnection || activeConnection !== connection) {
        return; // Exit handleRivals, as 850 handler has taken over
    }

    await connection.cleanup(true);
    if (activeConnection === connection) activeConnection = null;
    
    isReconnectingAfterRivalAction = true; // Set flag to prevent monitoring connection interference
    monitoringMode = false; // Temporarily disable monitoring mode

    appLog(`⚡ Connection ${connection.botId} closed, activating new connection`);
    try {
        const reconnectTimerLabel = `reconnectAfterAction_${Date.now()}`; // Unique label for each timer
        originalConsoleLog(reconnectTimerLabel); // Keep console.time for performance measurement
        if (config.dualRCToggle === false) {
            const delay = isOddReconnectAttempt ? 500 : 1500; // 500ms for odd, 1500ms for even
            await new Promise(resolve => setTimeout(resolve, delay));
            isOddReconnectAttempt = !isOddReconnectAttempt; // Toggle for the next attempt immediately after delay
            await getConnection(true, true); // Keep skipCloseTimeCheck true for this specific scenario
        } else {
            // This block remains as is, using a fixed 500ms delay
            await new Promise(resolve => setTimeout(resolve, 1000));
            await getConnection(true, true);
        }
        originalConsoleLog(reconnectTimerLabel); // Keep console.timeEnd for performance measurement
    } catch (error) {
        appLog("Failed to get new connection after rival handling:", error.message || error);
        // Removed tryReconnectWithBackoff as per user's request.
        // Now, if getConnection fails, it will simply log the error.
    } finally {
        isProcessingRivalAction = false; // Reset flag after rival handling is complete
        isReconnectingAfterRivalAction = false; // Reset flag
        monitoringMode = true; // Re-enable monitoring mode
    }
    // Timing increment will now be handled by the 850 error message if applicable, or by the new connection's initialization.
}

async function handlePrisonAutomation(connection) {
    if (connection.prisonState !== 'IDLE') {
        return;
    }
    
    try {
        connection.prisonState = 'JOINING_PRISON_CHANNEL';
        appLog(`🔒 Starting prison automation for connection ${connection.botId}`);
        appLog(`🔒 Joining prison channel for ${connection.botId}...`);
        connection.send(`JOIN`);
        
        if (connection.prisonState === 'JOINING_PRISON_CHANNEL') {
        //    appLog(`🔒 Sending ACTION 29 for ${connection.botId}...`);
            connection.prisonState = 'WAITING_FOR_BROWSER_MESSAGE';
            connection.send(`ACTION 29 ${connection.botId}`);
            connection.prisonTimeout = setTimeout(() => {
                appLog(`Prison automation timed out for connection ${connection.botId}`);
                connection.prisonState = 'IDLE';
                connection.prisonTimeout = null;
            }, 3000);
        }
    } catch (error) {
        appLog(`Error during prison automation for connection ${connection.botId}:`, error);
        connection.prisonState = 'IDLE';
        if (connection.prisonTimeout) clearTimeout(connection.prisonTimeout);
    }
}

Promise.all([
    optimizedConnectionPoolMaintenance().catch(err => appLog("Initial setup failed:", err)),
    optimizedPrisonPoolMaintenance().catch(err => appLog("Initial prison setup failed:", err))
]).then(() => appLog("🚀 Optimized connection initialized"));

setInterval(() => {
    if (!poolMaintenanceInProgress && !prisonMaintenanceInProgress) {
        const healthyRegular = connectionPool.filter(conn => conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData).length;
        const healthyPrison = prisonConnectionPool.filter(conn => conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData).length;
        if (healthyRegular < POOL_MIN_SIZE) optimizedConnectionPoolMaintenance().catch(err => appLog("Scheduled maintenance error:", err));
        if (healthyPrison < PRISON_POOL_MIN_SIZE) optimizedPrisonPoolMaintenance().catch(err => appLog("Scheduled prison maintenance error:", err));
    }
}, POOL_HEALTH_CHECK_INTERVAL);

setInterval(() => {
    const healthyRegular = connectionPool.filter(conn => conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData).length;
    const healthyPrison = prisonConnectionPool.filter(conn => conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData).length;
}, 30000);

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
        appLog("Failed to establish initial monitoring connection:", error.message || error);
        setTimeout(recoverUser, 500);
    }
}

async function maintainMonitoringConnection() {
    if (isReconnectingAfterRivalAction) {
        // Skip maintenance if a rival action reconnection is in progress
        return;
    }

    if (monitoringMode && (!activeConnection || !activeConnection.state === CONNECTION_STATES.READY)) {
        appLog("Maintaining monitoring connection...");
        try {
            await getMonitoringConnection();
        } catch (error) {
            appLog("Failed to maintain monitoring connection:", error.message || error);
            setTimeout(maintainMonitoringConnection, 1000);
        }
    }
}

setInterval(maintainMonitoringConnection, 10000);

// Ensure log file is cleaned up on startup
(async () => {
    await cleanUpLogFile();
    recoverUser();
})();

process.on('SIGINT', async () => {
    appLog("Shutting down...");
    // Clear the log cleanup interval to prevent new log writes
    clearInterval(logCleanupIntervalId); // Assuming logCleanupIntervalId is the variable holding the interval ID

    await Promise.allSettled(connectionPool.map(conn => conn.cleanup(true)));
    if (activeConnection) await Promise.resolve(activeConnection.cleanup(true));

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
    appLog('Unhandled Rejection at:', promise, 'reason:', reason);
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
