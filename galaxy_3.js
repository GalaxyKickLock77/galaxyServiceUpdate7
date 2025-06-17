const WebSocket = require('ws');
const fs = require('fs').promises;
const fsSync = require('fs');
const CryptoJS = require('crypto-js');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const { MISTRAL_API_KEY } = require('./src/secrets/mistral_api_key');

// Handle PM2 signals for config reload
process.on('SIGUSR2', () => {
    console.log('Received SIGUSR2 signal, reloading configuration...');
    updateConfigValues();
});

// Optimized Connection Pool Settings
const POOL_MIN_SIZE = 1;
const POOL_MAX_SIZE = 1;
const POOL_TARGET_SIZE = 1;
const POOL_HEALTH_CHECK_INTERVAL = 1000; // 1 second for frequent checks
const CONNECTION_MAX_AGE = 10 * 60 * 1000; // 2 minutes
const CONNECTION_IDLE_TIMEOUT = 1 * 60 * 1000; // 1 minute

// Prison Pool Settings
const PRISON_POOL_MIN_SIZE = 1;
const PRISON_POOL_MAX_SIZE = 1;
const PRISON_POOL_TARGET_SIZE = 1;
const PRISON_CONNECTION_MAX_AGE = 10 * 60 * 1000; // 1 minute for rapid turnover
const PRISON_POOL_HEALTH_CHECK_INTERVAL = 1000; // 1 second for frequent checks

let poolMaintenanceInProgress = false;
let prisonMaintenanceInProgress = false;
let lastCloseTime = 0;
// Configuration
let config;
let rivalNames = [];
let userMap = {};
let isOddReconnectAttempt = true; // Controls the odd/even alternation for reconnection delays
let currentMode = null;
let currentConnectionPromise = null; // New global variable to track ongoing connection attempts
let activeRivalTarget = null; // Tracks the ID of the rival currently being processed
let isRivalProcessingInProgress = false; // New global flag to prevent concurrent rival processing
 
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

console.log("Initial globalTimingState:", JSON.stringify(globalTimingState));

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

// Recovery code alternation
let lastUsedRC = 'RC2'; // Start with RC2 so first connection uses RC1

function getNextRC() {
    if (config.dualRCToggle === false) {
        console.log("dualRCToggle is false, using only RC1 for reconnection.");
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
    console.log(`Initializing connection ${connection.botId || 'new connection'} with rcKey: ${rcKey}. Global state for this RC:`, JSON.stringify(globalTimingState[rcKey]));
    console.log(`Timing states initialized for ${connection.botId || 'new connection'} (${rcKey}) from global state:`, {
        attack: connection.attackTimingState.currentTime,
        defense: connection.defenseTimingState.currentTime
    });
}

function updateConfigValues() {
    let retries = 0;
    const maxRetries = 3;
    const retryDelay = 50; // ms

    function tryLoadConfig() {
        try {
            // Force Node.js to reload the config file from disk
            delete require.cache[require.resolve('./config3.json')];
            
            // Read the file directly first to ensure we're getting the latest version
            const configRaw = fsSync.readFileSync('./config3.json', 'utf8');
            let configData;
            
            try {
                configData = JSON.parse(configRaw);
            } catch (parseError) {
                console.error("Error parsing config JSON:", parseError);
                throw parseError;
            }
            
            // Update the config object
            config = configData;
            
            // Process rival names
            rivalNames = Array.isArray(config.rival) ? config.rival : config.rival.split(',').map(name => name.trim());
            
            // Validate required fields
            if (!config.RC1 || !config.RC2) {
                throw new Error("Config must contain both RC1 and RC2");
            }
            
            // Convert string booleans to actual booleans
            config.standOnEnemy = config.standOnEnemy === "true" || config.standOnEnemy === true;
            config.actionOnEnemy = config.actionOnEnemy === "true" || config.actionOnEnemy === true;
            config.aiChatToggle = config.aiChatToggle === "true" || config.aiChatToggle === true;
            config.dualRCToggle = config.dualRCToggle === "true" || config.dualRCToggle === true;
            
            if (typeof config.actionOnEnemy === 'undefined') {
                throw new Error("Config must contain actionOnEnemy");
            }
            
            console.log(`Configuration updated at ${new Date().toISOString()}:`, {
                rivalNames,
                standOnEnemy: config.standOnEnemy,
                actionOnEnemy: config.actionOnEnemy,
                aiChatToggle: config.aiChatToggle,
                dualRCToggle: config.dualRCToggle
            });
            
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
            console.log(`Global timing states initialized/updated from config:`, {
                RC1_attack: globalTimingState.RC1.attack.currentTime,
                RC1_defense: globalTimingState.RC1.defense.currentTime,
                RC2_attack: globalTimingState.RC2.attack.currentTime,
                RC2_defense: globalTimingState.RC2.defense.currentTime
            });

            // Re-initialize timing states for all connections if needed
            // This should now pull from the global state based on their rcKey
            connectionPool.forEach(conn => {
                initializeTimingStates(conn);
            });
            
            if (activeConnection) {
                initializeTimingStates(activeConnection);
            }
            console.log(`Final globalTimingState after updateConfigValues:`, JSON.stringify(globalTimingState));
        } catch (error) {
            if (retries < maxRetries) {
                retries++;
                console.log(`Retrying to load config (attempt ${retries}/${maxRetries})...`);
                setTimeout(tryLoadConfig, retryDelay);
            } else {
                console.error("Failed to update config after retries:", error);
            }
        }
    }

    tryLoadConfig();
}
updateConfigValues();

// More robust file watching with polling fallback for PM2 compatibility
let configLastModified = 0;
const configPath = './config3.json';

// Primary file watcher
fsSync.watch(configPath, { persistent: true }, (eventType) => {
    if (eventType === 'change') {
        try {
            const stats = fsSync.statSync(configPath);
            const mtime = stats.mtimeMs;
            
            // Only update if the file has actually changed (prevents duplicate updates)
            if (mtime > configLastModified) {
                configLastModified = mtime;
                console.log(`Config file changed (${new Date().toISOString()}), updating values...`);
                updateConfigValues();
            }
        } catch (err) {
            console.error('Error checking config file stats:', err);
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
            console.log(`Config change detected via polling (${new Date().toISOString()}), updating values...`);
            updateConfigValues();
        }
    } catch (err) {
        console.error('Error polling config file:', err);
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

    console.log(`Incrementing timing for ${mode} mode, rcKey: ${rcKey}. Current global state for this RC:`, JSON.stringify(globalTimingState[rcKey]));

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
        console.log(`${mode} global timing for ${connection.botId} (${rcKey}) cycled back to start: ${globalStateForRC.currentTime}ms`);
    } else {
        console.log(`${mode} global timing for ${connection.botId} (${rcKey}) incremented: ${oldTime}ms -> ${globalStateForRC.currentTime}ms (errors: ${globalStateForRC.consecutiveErrors}, type: ${errorType})`);
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
        console.log(`Pool maintenance skipped: already in progress`);
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
            
            // Prune connections that are too old, idle, or in a non-recoverable state (e.g., closed or failed to register)
            if (age > CONNECTION_MAX_AGE || idleTime > CONNECTION_IDLE_TIMEOUT || conn.state === CONNECTION_STATES.CLOSED || !conn.registrationData) {
                console.log(`Pruning connection ${conn.botId || 'none'} (Age: ${Math.round(age/1000)}s, Idle: ${Math.round(idleTime/1000)}s, State: ${conn.state}, Registered: ${!!conn.registrationData})`);
                await conn.cleanup();
                connectionPool.splice(i, 1);
            }
        }
        
        const healthyConnections = connectionPool.filter(conn => 
            conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData && now - conn.lastUsed < CONNECTION_IDLE_TIMEOUT);
        
        console.log(`Pool status - Total: ${connectionPool.length}, Healthy: ${healthyConnections.length}, Target: ${POOL_TARGET_SIZE}`);
        
        if (healthyConnections.length < POOL_TARGET_SIZE) {
            const needed = Math.min(POOL_TARGET_SIZE - healthyConnections.length, POOL_MAX_SIZE - connectionPool.length);
            if (needed > 0) {
                console.log(`Creating ${needed} new pool connection(s)`);
                await createPoolConnections(needed);
            }
        }
        
        if (initialPoolSize !== connectionPool.length) {
            console.log(`Pool maintenance complete: ${initialPoolSize} → ${connectionPool.length} connections`);
        }
    } catch (err) {
        console.error("Error in connection pool maintenance:", err);
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
                console.log(`Initializing pool connection ${(i+1)}/${count}`);
                await conn.initialize(true);
                if (conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData) {
                    connectionPool.push(conn);
                    console.log(`✅ Added connection to pool (${connectionPool.length}/${POOL_MAX_SIZE})`);
                    return true;
                } else {
                    console.warn(`❌ Connection failed to reach proper state: ${conn.state}`);
                    await conn.cleanup();
                    return false;
                }
            } catch (error) {
                console.error(`❌ Failed to create pool connection:`, error.message || error);
                await conn.cleanup();
                return false;
            }
        })());
    }
    
    const results = await Promise.allSettled(creationPromises);
    const successful = results.filter(r => r.status === 'fulfilled' && r.value).length;
    console.log(`Pool connection creation complete: ${successful}/${count} successful`);
}

async function optimizedPrisonPoolMaintenance() {
    if (prisonMaintenanceInProgress) {
        console.log(`Prison pool maintenance skipped: already in progress`);
        return;
    }
    
    try {
        prisonMaintenanceInProgress = true;
        const now = Date.now();
        
        const initialSize = prisonConnectionPool.length;
        for (let i = prisonConnectionPool.length - 1; i >= 0; i--) {
            const conn = prisonConnectionPool[i];
            const age = now - conn.createdAt;
            const idleTime = now - now - conn.lastUsed;
            
            if (age > PRISON_CONNECTION_MAX_AGE || idleTime > CONNECTION_IDLE_TIMEOUT || 
                (conn.state !== CONNECTION_STATES.HASH_RECEIVED && conn.state !== CONNECTION_STATES.READY) || !conn.registrationData) {
                console.log(`Pruning PRISON connection ${conn.botId || 'none'} (Age: ${Math.round(age/1000)}s)`);
                await conn.cleanup();
                prisonConnectionPool.splice(i, 1);
            }
        }
        
        const healthyPrisonConnections = prisonConnectionPool.filter(conn => 
            conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData);
        
        console.log(`Prison pool status - Total: ${prisonConnectionPool.length}, Healthy: ${healthyPrisonConnections.length}, Target: ${PRISON_POOL_TARGET_SIZE}`);
        
        if (healthyPrisonConnections.length < PRISON_POOL_TARGET_SIZE) {
            const needed = Math.min(PRISON_POOL_TARGET_SIZE - healthyPrisonConnections.length, PRISON_POOL_MAX_SIZE - prisonConnectionPool.length);
            if (needed > 0) {
                console.log(`Creating ${needed} new PRISON connection(s)`);
                await createPrisonConnections(needed);
            }
        }
        
        if (initialSize !== prisonConnectionPool.length) {
            console.log(`Prison maintenance complete: ${initialSize} → ${prisonConnectionPool.length} connections`);
        }
    } catch (err) {
        console.error("Error in prison pool maintenance:", err);
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
                console.log(`Initializing PRISON connection ${i+1}/${count}`);
                await conn.initialize(true);
                if (conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData) {
                    prisonConnectionPool.push(conn);
                    console.log(`✅ Added PRISON connection to pool (${prisonConnectionPool.length}/${PRISON_POOL_MAX_SIZE})`);
                    return true;
                } else {
                    await conn.cleanup();
                    return false;
                }
            } catch (error) {
                console.error(`❌ Failed to create PRISON connection:`, error.message || error);
                await conn.cleanup();
                return false;
            }
        })());
    }
    
    const results = await Promise.allSettled(creationPromises);
    const successful = results.filter(r => r.status === 'fulfilled' && r.value).length;
    console.log(`Prison connection creation complete: ${successful}/${count} successful`);
}

async function getPrisonConnection() {
    console.log(`Getting PRISON connection from dedicated pool...`);
    const warmPrisonConnections = prisonConnectionPool.filter(conn => conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData);
    console.log(`PRISON warm connections available: ${warmPrisonConnections.length}/${prisonConnectionPool.length}`);
    
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
            console.log(`⚡ Using PRISON connection from dedicated pool (pool size now: ${prisonConnectionPool.length}/${PRISON_POOL_MAX_SIZE})`);
            try {
                console.time('prisonWarmActivation');
                await chosenConn.activateWarmConnection();
                activeConnection = chosenConn;
                Promise.resolve().then(() => optimizedPrisonPoolMaintenance().catch(err => console.error("Error re-warming prison pool:", err)));
                return chosenConn;
            } catch (error) {
                console.error("Failed to activate PRISON connection:", error.message || error);
                await chosenConn.cleanup();
                throw error;
            } finally {
                console.timeEnd('prisonWarmActivation');
            }
        }
    }
    
    console.log("No PRISON connections available, falling back to regular pool");
    return getConnection(true);
}

async function getConnection(activateFromPool = true, skipCloseTimeCheck = false, forceNew = false) {
    if (currentConnectionPromise) {
        console.log("Connection attempt already in progress, returning existing promise.");
        return currentConnectionPromise;
    }
 
    currentConnectionPromise = new Promise(async (resolve, reject) => {
        try {
            // Removed lastCloseTime check to allow immediate reconnection attempts as requested.
            // const now = Date.now();
            // if (!skipCloseTimeCheck && now - lastCloseTime < 500) {
            //     const waitTime = 1000 - (now - lastCloseTime);
            //     console.log(`Waiting ${waitTime}ms before attempting to get new connection (due to lastCloseTime)`);
            //     await new Promise(res => setTimeout(res, waitTime));
            // }
 
            console.log(`Getting connection (activateFromPool: ${activateFromPool}, forceNew: ${forceNew})...`);
            // If forceNew is true, we explicitly do NOT reuse an existing active connection.
            if (!forceNew && activeConnection && activeConnection.state === CONNECTION_STATES.READY &&
                activeConnection.socket && activeConnection.socket.readyState === WebSocket.OPEN) {
                console.log(`Reusing existing active connection ${activeConnection.botId}`);
                activeConnection.lastUsed = Date.now();
                resolve(activeConnection);
                return;
            }
            
            // Ensure no active connection is in the process of closing
            // If forceNew is true, we always clean up the existing active connection to get a fresh one.
            if (activeConnection) {
                console.log(`Waiting for active connection ${activeConnection.botId} to fully close...`);
                // Ensure cleanup is awaited to prevent race conditions with new connections
                await activeConnection.cleanup(true).catch(err => console.error(`Error during active connection cleanup:`, err));
                activeConnection = null; // Explicitly nullify after cleanup
            }
            
            if (activateFromPool) {
                const healthyConnections = connectionPool.filter(conn =>
                    conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData && Date.now() - conn.lastUsed < CONNECTION_IDLE_TIMEOUT);
                console.log(`Healthy pool connections available: ${healthyConnections.length}/${connectionPool.length}`);
                
                if (healthyConnections.length > 0) {
                    healthyConnections.sort((a, b) => b.createdAt - a.createdAt);
                    const chosenConn = healthyConnections[0];
                    const poolIndex = connectionPool.indexOf(chosenConn);
                    if (poolIndex !== -1) {
                        connectionPool.splice(poolIndex, 1);
                        console.log(`⚡ Using connection from pool (pool size now: ${connectionPool.length}/${POOL_MAX_SIZE})`);
                        try {
                            console.time('connectionActivation');
                            await chosenConn.activateWarmConnection();
                            activeConnection = chosenConn;
                            if (connectionPool.length < POOL_MIN_SIZE) {
                                console.log(`Pool running low (${connectionPool.length}), triggering maintenance`);
                                Promise.resolve().then(() => optimizedConnectionPoolMaintenance().catch(err => console.error("Error in triggered pool maintenance:", err)));
                            }
                            resolve(chosenConn);
                            return;
                        } catch (error) {
                            console.error("Failed to activate pool connection:", error.message || error);
                            await chosenConn.cleanup();
                        } finally {
                            console.timeEnd('connectionActivation');
                        }
                    }
                }
            }
            
            console.log("Creating new connection (pool unavailable or disabled)");
            const newConn = createConnection();
            try {
                console.time('newConnectionCreation');
                await newConn.initialize(false);
                activeConnection = newConn;
                Promise.resolve().then(() => optimizedConnectionPoolMaintenance().catch(err => console.error("Error in post-creation pool maintenance:", err)));
                resolve(newConn);
            } catch (error) {
                console.error("Failed to create new connection:", error.message || error);
                await newConn.cleanup();
                reject(error);
            } finally {
                console.timeEnd('newConnectionCreation');
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
    // Monitoring connection can reuse existing or get from pool, no forceNew needed
    return getConnection(false, false, false); 
}


function createConnection() {
    const rcKey = getNextRC();
    const rcValue = config[rcKey];
    console.log(`DEBUG: Creating new connection instance with ${rcKey}: ${rcValue}`);
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
        attackTimingState: { currentTime: null, lastMode: null, consecutiveErrors: 0 }, // Per-connection timing state, will be synced with global
        defenseTimingState: { currentTime: null, lastMode: null, consecutiveErrors: 0 }, // Per-connection timing state, will be synced with global
        
        send: function(str) {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(str + "\r\n");
                console.log(`Sent [${this.botId || 'connecting'}]: ${str}`);
                this.lastUsed = Date.now();
                return true;
            } else {
                console.log(`Cannot send [${this.botId || 'connecting'}]: Socket not open (state: ${this.state})`);
                return false;
            }
        },
        
        initialize: function(stopAtHash = false) {
            console.log(`DEBUG: Initializing connection object for ${this.rcKey} (stopAtHash: ${stopAtHash})...`);
            if (this.initPromise) return this.initPromise;
            
            this.initPromise = new Promise((resolve, reject) => {
                try {
                    if (this.socket) this.cleanup();
                    this.state = CONNECTION_STATES.CONNECTING;
                    this.authenticating = true;
                    console.log(`Initializing new connection with ${this.rcKey}: ${this.recoveryCode} (stopAtHash: ${stopAtHash})...`);
                    
                    this.socket = new WebSocket("wss://cs.mobstudio.ru:6672/", { rejectUnauthorized: false, handshakeTimeout: 5000 }); // Optimized for faster handshake
                    this.connectionTimeout = setTimeout(() => {
                        console.log("Connection initialization timeout");
                        this.authenticating = false;
                        this.cleanup();
                        reject(new Error("Connection initialization timeout"));
                    }, 10000); // Optimized for faster connection initialization
                    
                    this.socket.on('open', () => {
                        this.state = CONNECTION_STATES.CONNECTED;
                        console.log("WebSocket connected, initializing identity");
                        this.send(":ru IDENT 352 -2 4030 1 2 :GALA");
                        initializeTimingStates(this); // Initialize timing states for this connection from global
                    });
                    
                    this.socket.on('message', async (data) => {
                        const message = data.toString().trim();
                        if (stopAtHash && this.state === CONNECTION_STATES.HASH_RECEIVED) {
                            if (message.startsWith("REGISTER")) {
                                console.log("Storing registration data for later activation");
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
                    console.log(`WebSocket [${this.botId || 'connecting'}] closed (state: ${this.state})`);
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
                        console.log("Active connection closed");
                        activeConnection = null;
                        // Clear currentConnectionPromise if the active connection was the one being tracked
                        if (currentConnectionPromise) {
                            currentConnectionPromise = null;
                            console.log("Cleared currentConnectionPromise due to active connection closure.");
                        }
                    }
                    lastCloseTime = Date.now(); // Added here
                });
                    
                    this.socket.on('error', (error) => {
                        console.error(`WebSocket [${this.botId || 'connecting'}] error:`, error.message || error);
                        if (this.authenticating) {
                            this.authenticating = false;
                            clearTimeout(this.connectionTimeout);
                            reject(error);
                        }
                    });
                } catch (err) {
                    console.error("Error during connection initialization:", err);
                    clearTimeout(this.connectionTimeout);
                    this.authenticating = false;
                    reject(err);
                }
            }).finally(() => this.initPromise = null);
            
            return this.initPromise;
        },
        
        handleMessage: async function(message, resolve, reject, stopAtHash = false) {
            try {
                console.log(`Received [${this.botId || 'connecting'}]: ${message}`);
                this.lastReceivedMessage = message;
                
                const prisonWords = ["PRISON", "Prison", "Тюрьма"];
                if (prisonWords.some(word => message.split(/\s+/).includes(word))) {
                    console.log(`🔒 Exact prison keyword detected: "${message}"`);
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
                    console.log(`Message has prefix, actual command: ${command}`);
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
                                        console.log(`AI Chat: Removed username prefix, question is now: "${question}"`);
                                    }
                                    console.log(`AI Chat: Received question: "${question}"`);
                                    
                                    if (question) {
                                        getMistralChatResponse(question)
                                            .then(aiResponse => {
                                                const responseMessage = `PRIVMSG 0 0 :${aiResponse}`;
                                               setTimeout(() => {
                                                   this.send(responseMessage);
                                               }, 200); // 200ms delay for AI chat response
                                                console.log(`AI Chat: Sent response: "${aiResponse}"`);
                                            })
                                            .catch(error => {
                                                console.error(`AI Chat Error: ${error.message}`);
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
                            console.log(`Generated hash [${this.botId || 'connecting'}]: ${this.hash}`);
                            this.send(`RECOVER ${this.recoveryCode}`);
                            this.state = CONNECTION_STATES.HASH_RECEIVED;
                            if (stopAtHash) console.log(`Warm pool connection reached HASH_RECEIVED state`);
                        }
                        break;
                    case "REGISTER":
                        if (parts.length >= commandIndex + 4) {
                            this.botId = parts[commandIndex + 1];
                            this.password = parts[commandIndex + 2];
                            this.nick = parts[commandIndex + 3];
                            if (stopAtHash) {
                                this.registrationData = message;
                                console.log(`Stored registration data for warm pool connection [${this.botId}]`);
                                clearTimeout(this.connectionTimeout);
                                this.authenticating = false;
                                resolve(this);
                                return;
                            }
                            if (this.hash) {
                                this.send(`USER ${this.botId} ${this.password} ${this.nick} ${this.hash}`);
                                this.send(":ru IDENT 352 -2 4030 1 2 :GALA");
                                this.send(`RECOVER ${this.recoveryCode}`);
                                console.log(`Authenticated with USER command [${this.botId}]`);
                            }
                        }
                        break;
                    case "999":
                        this.state = CONNECTION_STATES.AUTHENTICATED;
                        console.log(`Connection [${this.botId}] authenticated, sending setup commands...`);
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
                        console.log(`Connection [${this.botId}] is now READY`);
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
                        console.log(`🔓 KICK command detected: ${message}`);
                        if (parts.length >= commandIndex + 3) {
                            const kickedUserId = parts[commandIndex + 2];
                            const isReleasedFromPrison = message.toLowerCase().includes("released") || message.toLowerCase().includes("освободили");
                            if (isReleasedFromPrison) {
                                console.log(`🎉 Bot ${this.botId} was released from prison, executing parallel release process...`);
                                
                                const parallelTasks = [];
                                
                                const joinTask = new Promise((resolve, reject) => {
                                    let joinAttempts = 0;
                                    const maxJoinAttempts = 10;
                                    
                                    const attemptJoin = () => {
                                        joinAttempts++;
                                        console.log(`JOIN attempt ${joinAttempts}/${maxJoinAttempts} for ${this.botId}`);
                                        
                                        const kickListener = (event) => {
                                            const message = event.data.toString().trim();
                                            console.log(`JOIN attempt ${joinAttempts} received: ${message}`);
                                            
                                            if (message.includes("KICK") && message.includes("Нельзя перелетать чаще одного раза в 3 с.")) {
                                                console.log(`🚫 3-second rule detected on JOIN attempt ${joinAttempts}`);
                                                this.socket.removeEventListener('message', kickListener);
                                                if (joinAttempts < maxJoinAttempts) {
                                                    console.log(`⏳ Retrying JOIN in 200ms... (attempt ${joinAttempts + 1}/${maxJoinAttempts})`);
                                                    setTimeout(() => {
                                                        attemptJoin();
                                                    }, 200);
                                                } else {
                                                    console.log(`❌ Max JOIN attempts (${maxJoinAttempts}) reached for ${this.botId}`);
                                                    reject(new Error(`JOIN failed after ${maxJoinAttempts} attempts due to 3-second rule`));
                                                }
                                            } else if (message.includes("JOIN") && !message.includes("KICK")) {
                                                console.log(`✅ JOIN successful for ${this.botId} on attempt ${joinAttempts}`);
                                                this.socket.removeEventListener('message', kickListener);
                                                resolve('join_complete');
                                            }
                                        };
                                        
                                        this.socket.addEventListener('message', kickListener);
                                        
                                        setTimeout(() => {
                                            this.send(`JOIN ${config.planetName}`);
                                            console.log(`JOIN command sent for ${this.botId} (attempt ${joinAttempts})`);
                                            
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
                                            console.log(`HTTP jail_free completed for ${this.botId}`);
                                            return 'http_complete';
                                        })
                                        .catch(error => {
                                            console.error(`HTTP jail_free failed for ${this.botId}:`, error.message);
                                            return 'http_failed';
                                        });
                                    parallelTasks.push(httpTask);
                                }
                                
                                Promise.allSettled(parallelTasks).then(async (results) => {
                                    console.log(`Parallel tasks completed for ${this.botId}:`, results.map(r => r.value || r.reason));
                                    
                                    console.log(`⚡ Sending QUIT command and awaiting cleanup for fast relogin [${this.botId}]`);
                                    this.prisonState = 'IDLE';
                                    // Ensure cleanup is fully completed before attempting new connection, sending QUIT command
                                    await this.cleanup(true);
                                    if (activeConnection === this) {
                                        activeConnection = null;
                                    }
                                    
                                    console.log(`⚡ Connection closed, using dedicated prison connection for relogin`);
                                    try {
                                        console.time('prisonRelogin');
                                        await getPrisonConnection();
                                        console.timeEnd('prisonRelogin');
                                        console.log(`✅ Fast prison relogin completed`);
                                    } catch (error) {
                                        console.error("Failed to get prison connection:", error.message || error);
                                        await getConnection(true).catch(retryError => {
                                            console.error("Prison relogin fallback failed:", retryError.message || retryError);
                                        });
                                    }
                                });
                            }
                        }
                        break;
                    case "451":
                        console.log(`Critical error 451 [${this.botId || 'connecting'}]: ${message}`);
                        if (this.authenticating) {
                            this.authenticating = false;
                            clearTimeout(this.connectionTimeout);
                            this.cleanup();
                            console.log(`⚡ Got 451 error, trying immediate recovery...`);
                            reject(new Error(`Critical error 451`));
                            Promise.resolve().then(() => getConnection(true).catch(err => console.error(`Failed after 451 error:`, err)));
                            return;
                        }
                        this.cleanup();
                        break;
                    case "452":
                        console.log(`Critical error 452 [${this.botId || 'connecting'}]: ${message}`);
                        if (this.authenticating && this.userCommandRetryCount < 10) {
                            this.userCommandRetryCount++;
                            console.log(`Retrying USER command (attempt ${this.userCommandRetryCount}/10) [${this.botId}]`);
                            if (this.botId && this.password && this.nick && this.hash) {
                                this.send(`USER ${this.botId} ${this.password} ${this.nick} ${this.hash}`);
                            } else {
                                console.error(`Cannot retry USER command: missing required data [${this.botId}]`);
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
                            console.log(`⚡ Got 452 error after ${this.userCommandRetryCount} retries, closed connection, removed from pool, and trying recovery with 10-second backoff...`);
                            reject(new Error(`Critical error 452 after retries`));
                            // Introduce a 10-second delay before attempting to get a new connection
                            // setTimeout(() => {
                            //     Promise.resolve().then(() => getConnection(true).catch(err => console.error(`Failed after 452 error:`, e))));
                            // }, 1000); // 10 seconds delay
                            return;
                        } else {
                            this.cleanup();
                        }
                        break;
                    case "854": // Capture last action command
                        if (parts.length >= 2) {
                            this.lastActionCommand = parts[1];
                            console.log(`Updated lastActionCommand to ${this.lastActionCommand} for connection ${this.botId}`);
                        }
                        break;
                }
                
                if (this.prisonState === 'WAITING_FOR_BROWSER_MESSAGE' && message.startsWith("BROWSER 1")) {
                    const urlMatch = message.match(/https:\/\/galaxy\.mobstudio\.ru\/services\/\?a=jail_info&usercur=(\d+)&/);
                    if (urlMatch && urlMatch[1] === this.botId) {
                        console.log(`Received BROWSER 1 message for jail_info: ${message}`);
                        if (this.prisonTimeout) clearTimeout(this.prisonTimeout);
                        performJailFreeWithRetry(this, 3, 500).then(() => {
                            console.log(`Jail free completed for ${this.botId}, waiting for KICK message...`);
                            this.prisonState = 'WAITING_FOR_KICK';
                        }).catch(error => {
                            console.error(`Error in jail_free for ${this.botId}:`, error);
                            this.prisonState = 'IDLE';
                        });
                    }
                }
            } catch (err) {
                console.error(`Error handling message [${this.botId || 'connecting'}]:`, err);
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
                    console.log(`⚡ Fast-activating warm connection [${this.botId || 'pending'}] with ${this.rcKey}...`);
                    this.authenticating = true;
                    this.connectionTimeout = setTimeout(() => {
                        console.log("Connection activation timeout");
                        this.authenticating = false;
                        reject(new Error("Connection activation timeout"));
                    }, 2000); // Further optimized for faster warm connection activation
    
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
                                    console.log(`⚡ Warm connection [${this.botId}] authenticated, sending setup commands...`);
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
                                    console.log(`✅ Warm connection [${this.botId}] SUCCESSFULLY activated and READY`);
                                    
                                    initializeTimingStates(this); // Initialize timing states for this connection from global
                                    resolve(this);
                                }
                            };
    
                            this.socket.addEventListener('message', authHandler);
                            
                            this.send(`USER ${this.botId} ${this.password} ${this.nick} ${this.hash}`);
                            console.log(`Activated warm connection with USER command [${this.botId}]`);
                        } else {
                            reject(new Error("No hash available for activation"));
                        }
                    } else {
                        reject(new Error("Invalid registration data for activation"));
                    }
                } catch (err) {
                    console.error("Error during warm connection activation:", err);
                    this.authenticating = false;
                    clearTimeout(this.connectionTimeout);
                    reject(err);
                }
            });
        },
        
        cleanup: async function(sendQuit = false) { // Made function async
            if (this.cleanupPromise) return this.cleanupPromise;
            
            this.cleanupPromise = new Promise(async (resolve) => { // Made promise executor async
                this.cleanupResolve = resolve;
                try {
                    if (this.socket) {
                        if (sendQuit && this.socket.readyState === WebSocket.OPEN) {
                            this.send("QUIT :ds");
                            // Add a small delay to allow the QUIT command to be processed by the server
                            await new Promise(res => setTimeout(res, 100)); // 100ms delay
                        }
                        if (this.socket) this.socket.terminate();
                    } else {
                        this.state = CONNECTION_STATES.CLOSED;
                        resolve();
                    }
                    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
                    if (this.prisonTimeout) clearTimeout(this.prisonTimeout);
                    this.socket = null;
                    this.authenticating = false;
                } catch (err) {
                    console.error(`Error in cleanup [${this.botId || 'connecting'}]:`, err);
                    resolve(); // Resolve even on error to avoid hanging
                }
            });
            return this.cleanupPromise;
        }
    };
    return conn;
    }

function parse353(message, connection) {
    if (message.includes('PRISON') || message.includes('Prison') || message.includes('Тюрьма')) {
        console.log(`🔒 Prison mention detected: "${message}"`);
        handlePrisonAutomation(connection);
        return;
    }
    
    const colonIndex = message.indexOf(" :");
    const payload = colonIndex !== -1 ? message.substring(colonIndex + 2) : "";
    console.log(`Parsing 353 message [${connection.botId}]: ${message}`);
    console.log(`Parsed payload: ${payload}`);
    
    const tokens = payload.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    let i = 0;
    let detectedRivals = [];
    
    console.log(`Tokenized payload into: [${tokens.join(', ')}]`);
    
    while (i < tokens.length) {
        let token = tokens[i];
        if (token === '-') {
            console.log(`Skipping separator token: "${token}"`);
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
            console.log(`Skipping empty name`);
            i++;
            continue;
        }
        
        if (name === '-' || name === '@' || name === '+') {
            console.log(`Skipping separator token: "${name}"`);
            i++;
            continue;
        }
        
        console.log(`Processing token: "${token}" -> name: "${name}", hasPrefix: ${hasPrefix}`);
        
        const isRivalName = rivalNames.includes(name);
        if (isRivalName) {
            console.log(`🎯 Exact rival match found: "${name}"`);
        }
        
        i++;
        
        if (i < tokens.length && /^\d+$/.test(tokens[i]) && tokens[i].length > 5) {
            const id = tokens[i];
            userMap[name] = id;
            console.log(`Added to userMap [${connection.botId}]: ${name} -> ${id}`);
            
            if (isRivalName) {
                detectedRivals.push({ name, id });
                console.log(`✅ Detected rival [${connection.botId}]: ${name} with ID ${id}`);
                
                if (config.standOnEnemy) {
                    let coordinate = null;
                    for (let j = i + 1; j < tokens.length; j++) {
                        if (tokens[j] === '@' && j + 5 < tokens.length && /^\d+$/.test(tokens[j + 5])) {
                            coordinate = tokens[j + 5];
                            console.log(`Found coordinate ${coordinate} for rival ${name} in 353 message`);
                            break;
                        }
                    }
                    if (coordinate && connection.state === CONNECTION_STATES.READY) {
                        console.log(`Sending REMOVE ${coordinate} for rival ${name} [${connection.botId}]`);
                        connection.send(`REMOVE ${coordinate}`);
                    }
                }
            }
            i++;
        }
    }
    
    if (detectedRivals.length > 0 && connection.state === CONNECTION_STATES.READY) {
        console.log(`Detected rivals in 353 [${connection.botId}]: ${detectedRivals.map(r => r.name).join(', ')} - Defence mode activated`);
        // Take only the first rival and process it immediately
        const rivalToProcess = { ...detectedRivals[0], mode: 'defence' };
        console.log(`Immediately processing rival: ${rivalToProcess.name} (ID: ${rivalToProcess.id}) in ${rivalToProcess.mode} mode.`);
        // Ensure handleRivals is called only if no rival processing is currently in progress
        if (!isRivalProcessingInProgress) {
            isRivalProcessingInProgress = true; // Set flag to true before starting processing
            getConnection(true).then(conn => handleRivals([rivalToProcess], rivalToProcess.mode, conn)).catch(err => console.error("Error processing rival from 353:", err));
        } else {
            console.log(`Skipping processing of rival ${rivalToProcess.name} as another rival is already being processed.`);
        }
    }
}

function handleJoinCommand(parts, connection) {
    if (parts.length >= 4) {
        let name = parts.length >= 5 && !isNaN(parts[3]) ? parts[2] : parts[1];
        let id = parts.length >= 5 && !isNaN(parts[3]) ? parts[3] : parts[2];
        userMap[name] = id;
        console.log(`User ${name} joined with ID ${id} [${connection.botId}]`);
        if (rivalNames.includes(name)) {
            console.log(`Rival ${name} joined [${connection.botId}] - Attack mode activated`);
            
            let coordinate = null;
            if (config.standOnEnemy) {
                for (let i = parts.length >= 5 ? 4 : 3; i < parts.length; i++) {
                    if (parts[i] === '@' && i + 5 < parts.length && !isNaN(parts[i + 5])) {
                        coordinate = parts[i + 5];
                        console.log(`Found coordinate ${coordinate} for rival ${name} in JOIN message`);
                        break;
                    }
                }
                if (coordinate && connection.state === CONNECTION_STATES.READY) {
                    console.log(`Sending REMOVE ${coordinate} for rival ${name} [${connection.botId}]`);
                    connection.send(`REMOVE ${coordinate}`);
                }
            }
            
            // Take the joined rival and process it immediately
            const joinedRival = { name, id };
            console.log(`Immediately processing joined rival: ${joinedRival.name} (ID: ${joinedRival.id}) in attack mode.`);
            // Ensure handleRivals is called only if no rival processing is currently in progress
            if (!isRivalProcessingInProgress) {
                isRivalProcessingInProgress = true; // Set flag to true before starting processing
                getConnection(true).then(conn => handleRivals([joinedRival], 'attack', conn)).catch(err => console.error("Error processing rival from JOIN:", err));
            } else {
                console.log(`Skipping processing of joined rival ${joinedRival.name} as another rival is already being processed.`);
            }
        }
    }
}

function remove_user(user) {
    if (userMap[user]) {
        delete userMap[user];
        console.log(`Removed user ${user} from userMap`);
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
                console.log(`Jail free response for ${userID}:`, data);
                resolve(data);
            });
            res.on('error', (error) => {
                console.error(`Response error for ${userID}:`, error);
                reject(error);
            });
        });
        
        req.on('error', (error) => {
            console.error(`Request error performing jail_free for ${userID}:`, error.message);
            reject(error);
        });
        req.on('timeout', () => {
            console.error(`Request timeout for ${userID}`);
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
            console.log(`Jail free attempt ${attempt}/${maxRetries} for ${userID}`);
            console.time(`jailFreeAttempt${attempt}`);
            const result = await performJailFreeFast(connection);
            console.timeEnd(`jailFreeAttempt${attempt}`);
            console.log(`✅ Jail free succeeded on attempt ${attempt} for ${userID}`);
            return result;
        } catch (error) {
            console.error(`❌ Jail free attempt ${attempt}/${maxRetries} failed for ${userID}:`, error.message);
            if (attempt < maxRetries) {
                const delay = retryDelay * attempt;
                console.log(`⏳ Retrying jail free in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                console.error(`🚫 All jail free attempts failed for ${userID}`);
                throw new Error(`Jail free failed after ${maxRetries} attempts: ${error.message}`);
            }
        }
    }
}

async function handleRivals(rivals, mode, connection) {
    console.log(`DEBUG: handleRivals entered. RC Key: ${connection.rcKey}, isOddReconnectAttempt: ${isOddReconnectAttempt}`);
    currentMode = mode; // Set the global currentMode here

    if (!connection.botId || rivals.length === 0) {
        console.log(`No rivals to handle or bot ID not set`);
        return;
    }

    const targetRival = rivals[0];

    if (!targetRival) {
        console.log(`No target rival selected, skipping actions.`);
        return;
    }

    const id = userMap[targetRival.name];
    if (!id) {
        console.log(`Could not find ID for target rival ${targetRival.name}, skipping actions.`);
        return;
    }

    activeRivalTarget = id;
    console.log(`Set activeRivalTarget to ${activeRivalTarget} for ${targetRival.name} (ID: ${id})`);

    const waitTime = getCurrentTiming(mode, connection);
    console.log(`Handling rival ${targetRival.name} in ${mode} mode with waitTime: ${waitTime}ms [${connection.botId}]`);
    console.log(`Timing state for ${connection.botId} - Attack: ${connection.attackTimingState.currentTime}ms (errors: ${connection.attackTimingState.consecutiveErrors}), Defense: ${connection.defenseTimingState.currentTime}ms (errors: ${connection.defenseTimingState.consecutiveErrors})`);

    monitoringMode = false;

    const ACTION_DELAY = 300; // Minimum delay between actions in ms

    let actionPromise;
    try {
        if (config.actionOnEnemy && connection.lastActionCommand) {
            const firstActionTime = Math.max(0, waitTime - ACTION_DELAY);
            actionPromise = new Promise(resolve => {
                setTimeout(() => {
                    if (connection.socket && connection.socket.readyState === WebSocket.OPEN) {
                        console.log(`Sending ACTION ${connection.lastActionCommand} to ${targetRival.name} (ID: ${id}) at ${firstActionTime}ms [${connection.botId}]`);
                        connection.send(`ACTION ${connection.lastActionCommand} ${id}`);
                    } else {
                        console.log(`Skipping first ACTION: Connection not open for ${connection.botId}`);
                    }
                    setTimeout(() => {
                        if (connection.socket && connection.socket.readyState === WebSocket.OPEN) {
                            console.log(`Sending ACTION 3 to ${targetRival.name} (ID: ${id}) at ${waitTime}ms [${connection.botId}]`);
                            connection.send(`ACTION 3 ${id}`);
                        } else {
                            console.log(`Skipping second ACTION: Connection not open for ${connection.botId}`);
                        }
                        resolve();
                    }, ACTION_DELAY);
                }, firstActionTime);
            });
        } else {
            actionPromise = new Promise(resolve => {
                setTimeout(() => {
                    if (connection.socket && connection.socket.readyState === WebSocket.OPEN) {
                        console.log(`Sending ACTION 3 to ${targetRival.name} (ID: ${id}) with ${waitTime}ms delay [${connection.botId}]`);
                        connection.send(`ACTION 3 ${id}`);
                    } else {
                        console.log(`Skipping ACTION 3: Connection not open for ${connection.botId}`);
                    }
                    resolve();
                }, waitTime);
            });
        }
        await actionPromise;
    } catch (actionError) {
        console.error(`Error sending actions to rival ${targetRival.name}:`, actionError);
    }

    // Increment timing based on usual logic (success)
    incrementTiming(mode, connection, 'success');
    console.log(`Timing incremented for ${mode} mode after action.`);

    // Clear active connection and any pending connection promise immediately to allow a new connection attempt
    // Ensure cleanup is fully completed before attempting new connection, sending QUIT command
    console.log(`⚡ ACTION 3 complete. Immediately sending QUIT and awaiting cleanup for fast relogin [${connection.botId}]`);
    await connection.cleanup(true);
    
    // Ensure activeConnection and currentConnectionPromise are nullified after cleanup
    activeConnection = null;
    currentConnectionPromise = null;
    monitoringMode = true; // Assume monitoring mode will be re-established by the new connection

    // Introduce a small delay to allow the system to fully process the closure
    // This helps ensure the socket is completely terminated before a new connection is attempted.
    await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay

    // Immediately attempt to get a new connection, prioritizing warm connections
    console.log(`⚡ Immediately activating new connection, prioritizing warm connections.`);
    try {
        const reconnectTimerLabel = `reconnectAfterAction_${Date.now()}`;
        console.time(reconnectTimerLabel);
        if (config.dualRCToggle) {
            // When dualRCToggle is enabled, use getPrisonConnection for warm connection
            console.log(`⚡ Dual RC Toggle enabled. Attempting to get warm prison connection...`);
            await getPrisonConnection(); // getPrisonConnection already calls getConnection(true)
        } else {
            // Fallback to regular getConnection with alternating backoff if dualRCToggle is false
            const delay = isOddReconnectAttempt ? 500 : 1500;
            console.log(`⚡ Dual RC Toggle disabled. Quick reconnect attempt (odd/even: ${isOddReconnectAttempt ? 'odd' : 'even'}) with fixed backoff: ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            isOddReconnectAttempt = !isOddReconnectAttempt;
            // Force a new connection after an action, bypassing reuse logic
            await getConnection(true, true, true); 
        }
        console.timeEnd(reconnectTimerLabel);
    } catch (error) {
        console.error("Failed to initiate new connection after rival handling:", error.message || error);
    } finally {
        activeRivalTarget = null;
        isRivalProcessingInProgress = false; // Reset flag after processing is complete
    }
}

async function handlePrisonAutomation(connection) {
    if (connection.prisonState !== 'IDLE') {
        console.log(`Prison automation already in progress for connection ${connection.botId}, skipping...`);
        return;
    }
    
    try {
        connection.prisonState = 'JOINING_PRISON_CHANNEL';
        console.log(`🔒 Starting prison automation for connection ${connection.botId}`);
        console.log(`🔒 Joining prison channel for ${connection.botId}...`);
        connection.send(`JOIN`);
        
        if (connection.prisonState === 'JOINING_PRISON_CHANNEL') {
            console.log(`🔒 Sending ACTION 29 for ${connection.botId}...`);
            connection.prisonState = 'WAITING_FOR_BROWSER_MESSAGE';
            connection.send(`ACTION 29 ${connection.botId}`);
            connection.prisonTimeout = setTimeout(() => {
                console.log(`Prison automation timed out for connection ${connection.botId}`);
                connection.prisonState = 'IDLE';
                connection.prisonTimeout = null;
            }, 3000);
        }
    } catch (error) {
        console.error(`Error during prison automation for connection ${connection.botId}:`, error);
        connection.prisonState = 'IDLE';
        if (connection.prisonTimeout) clearTimeout(connection.prisonTimeout);
    }
}

Promise.all([
    optimizedConnectionPoolMaintenance().catch(err => console.error("Initial pool setup failed:", err)),
    optimizedPrisonPoolMaintenance().catch(err => console.error("Initial prison pool setup failed:", err))
]).then(() => console.log("🚀 Optimized connection pools initialized"));

setInterval(() => {
    if (!poolMaintenanceInProgress && !prisonMaintenanceInProgress) {
        const healthyRegular = connectionPool.filter(conn => conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData).length;
        const healthyPrison = prisonConnectionPool.filter(conn => conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData).length;
        if (healthyRegular < POOL_MIN_SIZE) optimizedConnectionPoolMaintenance().catch(err => console.error("Scheduled pool maintenance error:", err));
        if (healthyPrison < PRISON_POOL_MIN_SIZE) optimizedPrisonPoolMaintenance().catch(err => console.error("Scheduled prison pool maintenance error:", err));
    }
}, POOL_HEALTH_CHECK_INTERVAL);

setInterval(() => {
    const healthyRegular = connectionPool.filter(conn => conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData).length;
    const healthyPrison = prisonConnectionPool.filter(conn => conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData).length;
    console.log(`📊 Optimized Pool Status - Regular: ${healthyRegular}/${connectionPool.length} (target: ${POOL_TARGET_SIZE}), Prison: ${healthyPrison}/${prisonConnectionPool.length} (target: ${PRISON_POOL_TARGET_SIZE})`);
}, 30000);

// Removed global timing state logging as it's now per-connection

async function recoverUser() {
    console.log("Starting recovery with alternating RCs");
    try {
        await optimizedConnectionPoolMaintenance();
        await getMonitoringConnection();
        console.log("Initial monitoring connection established successfully");
    } catch (error) {
        console.error("Failed to establish initial monitoring connection:", error.message || error);
        setTimeout(recoverUser, 500);
    }
}

async function maintainMonitoringConnection() {
    if (monitoringMode && (!activeConnection || !activeConnection.state === CONNECTION_STATES.READY)) {
        console.log("Maintaining monitoring connection...");
        try {
            await getMonitoringConnection();
        } catch (error) {
            console.error("Failed to maintain monitoring connection:", error.message || error);
            setTimeout(maintainMonitoringConnection, 1000);
        }
    }
}

setInterval(maintainMonitoringConnection, 10000);

recoverUser();

process.on('SIGINT', async () => {
    console.log("Shutting down...");
    await Promise.allSettled(connectionPool.map(conn => conn.cleanup(true)));
    if (activeConnection) await Promise.resolve(activeConnection.cleanup(true));
    process.exit(0);
});

process.on('uncaughtException', async (error) => {
    console.error('Uncaught exception:', error.message || error);
    if (activeConnection) {
        await activeConnection.cleanup();
        activeConnection = null;
    }
    setTimeout(() => {
        if (monitoringMode) getMonitoringConnection().catch(err => console.error("Failed to get new monitoring connection after error:", err.message || err));
        else getConnection(true).catch(err => console.error("Failed to get new connection after error:", err.message || err));
    }, 500);
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    if (activeConnection) {
        await activeConnection.cleanup();
        activeConnection = null;
    }
    setTimeout(() => {
        if (monitoringMode) getMonitoringConnection().catch(err => console.error("Failed to get new monitoring connection after error:", err.message || err));
        else getConnection(true).catch(err => console.error("Failed to get new connection after error:", err.message || err));
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
