const WebSocket = require('ws');
const fs = require('fs').promises;
const fsSync = require('fs');
const CryptoJS = require('crypto-js');
const path = require('path');
const https = require('https');
const { URL } = require('url');

// Optimized Connection Pool Settings
const POOL_MIN_SIZE = 2;
const POOL_MAX_SIZE = 2;
const POOL_TARGET_SIZE = 2;
const POOL_HEALTH_CHECK_INTERVAL = 10000; // 10 seconds for frequent checks
const CONNECTION_MAX_AGE = 2 * 60 * 1000; // 2 minutes
const CONNECTION_IDLE_TIMEOUT = 1 * 60 * 1000; // 1 minute

// Prison Pool Settings
const PRISON_POOL_MIN_SIZE = 3;
const PRISON_POOL_MAX_SIZE = 5;
const PRISON_POOL_TARGET_SIZE = 3;
const PRISON_CONNECTION_MAX_AGE = 1 * 60 * 1000; // 1 minute for rapid turnover

let poolMaintenanceInProgress = false;
let prisonMaintenanceInProgress = false;

// Configuration
let config;
let rivalNames = [];
let recoveryCode;
let userMap = {};
let reconnectAttempt = 0;
let currentMode = null;

// Connection pool settings
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BACKOFF_BASE = 50; // Ultra-fast backoff base
const connectionPool = [];
let activeConnection = null;

// Prison pool settings
const prisonConnectionPool = [];

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

function updateConfigValues() {
    try {
        delete require.cache[require.resolve('./config1.json')];
        config = require('./config1.json');
        rivalNames = Array.isArray(config.rival) ? config.rival : config.rival.split(',').map(name => name.trim());
        recoveryCode = config.RC;
        
        currentAttackTime = config.startAttackTime;
        currentDefenceTime = config.startDefenceTime;
        
        console.log("Configuration updated:", { 
            rivalNames, 
            recoveryCode,
            attackSettings: { start: config.startAttackTime, stop: config.stopAttackTime, interval: config.attackIntervalTime, current: currentAttackTime },
            defenceSettings: { start: config.startDefenceTime, stop: config.stopDefenceTime, interval: config.defenceIntervalTime, current: currentDefenceTime }
        });
    } catch (error) {
        console.error("Error updating config:", error);
    }
}

updateConfigValues();

fsSync.watch('config1.json', (eventType) => {
    if (eventType === 'change') {
        console.log('Config file changed, updating values...');
        updateConfigValues();
    }
});

function genHash(code) {
    const hash = CryptoJS.MD5(code);
    let str = hash.toString(CryptoJS.enc.Hex);
    str = str.split("").reverse().join("0").substr(5, 10);
    return str;
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
            
            if (age > CONNECTION_MAX_AGE || idleTime > CONNECTION_IDLE_TIMEOUT || 
                (conn.state !== CONNECTION_STATES.HASH_RECEIVED && conn.state !== CONNECTION_STATES.READY) || !conn.registrationData) {
                console.log(`Pruning connection ${conn.botId || 'none'} (Age: ${Math.round(age/1000)}s, Idle: ${Math.round(idleTime/1000)}s, State: ${conn.state})`);
                conn.cleanup();
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
                    conn.cleanup();
                    return false;
                }
            } catch (error) {
                console.error(`❌ Failed to create pool connection:`, error.message || error);
                conn.cleanup();
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
            const idleTime = now - conn.lastUsed;
            
            if (age > PRISON_CONNECTION_MAX_AGE  || idleTime > CONNECTION_IDLE_TIMEOUT || 
                (conn.state !== CONNECTION_STATES.HASH_RECEIVED && conn.state !== CONNECTION_STATES.READY) || !conn.registrationData) {
                console.log(`Pruning PRISON connection ${conn.botId || 'none'} (Age: ${Math.round(age/1000)}s)`);
                conn.cleanup();
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
                    conn.cleanup();
                    return false;
                }
            } catch (error) {
                console.error(`❌ Failed to create PRISON connection:`, error.message || error);
                conn.cleanup();
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
                console.timeEnd('prisonWarmActivation');
                activeConnection = chosenConn;
                Promise.resolve().then(() => optimizedPrisonPoolMaintenance().catch(err => console.error("Error re-warming prison pool:", err)));
                return chosenConn;
            } catch (error) {
                console.error("Failed to activate PRISON connection:", error.message || error);
                chosenConn.cleanup();
                throw error;
            }
        }
    }
    
    console.log("No PRISON connections available, falling back to regular pool");
    return getConnection(true);
}

async function getConnection(activateFromPool = true) {
    console.log(`Getting connection (activateFromPool: ${activateFromPool})...`);
    if (activeConnection && activeConnection.state === CONNECTION_STATES.READY && 
        activeConnection.socket && activeConnection.socket.readyState === WebSocket.OPEN) {
        console.log(`Reusing existing active connection ${activeConnection.botId}`);
        activeConnection.lastUsed = Date.now();
        return activeConnection;
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
                    console.timeEnd('connectionActivation');
                    activeConnection = chosenConn;
                    if (connectionPool.length < POOL_MIN_SIZE) {
                        console.log(`Pool running low (${connectionPool.length}), triggering maintenance`);
                        Promise.resolve().then(() => optimizedConnectionPoolMaintenance().catch(err => console.error("Error in triggered pool maintenance:", err)));
                    }
                    return chosenConn;
                } catch (error) {
                    console.error("Failed to activate pool connection:", error.message || error);
                    chosenConn.cleanup();
                }
            }
        }
    }
    
    console.log("Creating new connection (pool unavailable or disabled)");
    const newConn = createConnection();
    try {
        console.time('newConnectionCreation');
        await newConn.initialize(false);
        console.timeEnd('newConnectionCreation');
        activeConnection = newConn;
        Promise.resolve().then(() => optimizedConnectionPoolMaintenance().catch(err => console.error("Error in post-creation pool maintenance:", err)));
        return newConn;
    } catch (error) {
        console.error("Failed to create new connection:", error.message || error);
        newConn.cleanup();
        throw error;
    }
}

async function getMonitoringConnection() {
    return getConnection(false);
}

async function tryReconnectWithBackoff() {
    reconnectAttempt++;
    const backoffTime = Math.min(RECONNECT_BACKOFF_BASE * Math.pow(1.5, reconnectAttempt - 1), 1000);
    console.log(`⚡ Quick reconnect attempt ${reconnectAttempt} with ${backoffTime}ms backoff...`);
    return new Promise((resolve, reject) => {
        setTimeout(async () => {
            try {
                const conn = await getConnection(true);
                resolve(conn);
            } catch (error) {
                console.error(`Reconnect attempt ${reconnectAttempt} failed:`, error.message || error);
                if (reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
                    try {
                        const conn = await tryReconnectWithBackoff();
                        resolve(conn);
                    } catch (err) {
                        reject(err);
                    }
                } else {
                    console.error(`Giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`);
                    reconnectAttempt = 0;
                    reject(new Error("Maximum reconnection attempts reached"));
                }
            }
        }, backoffTime);
    });
}

function createConnection() {
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
            if (this.initPromise) return this.initPromise;
            
            this.initPromise = new Promise((resolve, reject) => {
                try {
                    if (this.socket) this.cleanup();
                    this.state = CONNECTION_STATES.CONNECTING;
                    this.authenticating = true;
                    console.log(`Initializing new connection (stopAtHash: ${stopAtHash})...`);
                    
                    this.socket = new WebSocket("wss://cs.mobstudio.ru:6672/", { rejectUnauthorized: false, handshakeTimeout: 1000 });
                    this.connectionTimeout = setTimeout(() => {
                        console.log("Connection initialization timeout");
                        this.authenticating = false;
                        this.cleanup();
                        reject(new Error("Connection initialization timeout"));
                    }, 3000);
                    
                    this.socket.on('open', () => {
                        this.state = CONNECTION_STATES.CONNECTED;
                        console.log("WebSocket connected, initializing identity");
                        this.send(":ru IDENT 352 -2 4030 1 2 :GALA");
                    });
                    
                    this.socket.on('message', (data) => {
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
                        this.handleMessage(message, resolve, reject, stopAtHash);
                    });
                    
                    this.socket.on('close', () => {
                        console.log(`WebSocket [${this.botId || 'connecting'}] closed (state: ${this.state})`);
                        if (this.authenticating) {
                            this.authenticating = false;
                            clearTimeout(this.connectionTimeout);
                            reject(new Error("Connection closed during authentication"));
                        }
                        this.cleanup(); // Reset state like disconnectFromServer
                        const index = connectionPool.indexOf(this);
                        if (index !== -1) connectionPool.splice(index, 1);
                        if (this === activeConnection) {
                            console.log("Active connection closed, getting new connection immediately");
                            activeConnection = null;
                            Promise.resolve().then(() => getConnection(true).catch(err => tryReconnectWithBackoff().catch(e => console.error("Reconnect failed:", e))));
                        }
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
        
        handleMessage: function(message, resolve, reject, stopAtHash = false) {
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
                    case "PING":
                        this.send("PONG");
                        break;
                    case "HAAAPSI":
                        if (parts.length >= commandIndex + 2) {
                            const code = parts[commandIndex + 1];
                            this.hash = genHash(code);
                            console.log(`Generated hash [${this.botId || 'connecting'}]: ${this.hash}`);
                            this.send(`RECOVER ${recoveryCode}`);
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
                                this.send(`RECOVER ${recoveryCode}`);
                                console.log(`Authenticated with USER command [${this.botId}]`);
                            }
                        }
                        break;
                    case "999":
                        this.state = CONNECTION_STATES.AUTHENTICATED;
                        console.log(`Connection [${this.botId}] authenticated, sending setup commands...`);
                        this.send("FWLISTVER 0");
                        this.send("ADDONS 0 0");
                        this.send("MYADDONS 0 0");
                        this.send("PHONE 0 0 0 2 :Node.js");
                        this.send("JOIN");
                        currentAttackTime = config.startAttackTime;
                        currentDefenceTime = config.startDefenceTime;
                        this.state = CONNECTION_STATES.READY;
                        this.authenticating = false;
                        this.userCommandRetryCount = 0;
                        reconnectAttempt = 0;
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
                                
                                // PARALLEL EXECUTION - Start both JOIN and HTTP request simultaneously
                                const parallelTasks = [];
                                
                                // Task 1: JOIN command with minimal delay
                                const joinTask = new Promise((resolve, reject) => {
                                    let joinAttempts = 0;
                                    const maxJoinAttempts = 10;
                                    
                                    const attemptJoin = () => {
                                        joinAttempts++;
                                        console.log(`JOIN attempt ${joinAttempts}/${maxJoinAttempts} for ${this.botId}`);
                                        
                                        // Set up listener for KICK message with 3-second rule
                                        const kickListener = (event) => {
                                            const message = event.data.toString().trim();
                                            console.log(`JOIN attempt ${joinAttempts} received: ${message}`);
                                            
                                            // Check for the specific 3-second rule KICK message
                                            if (message.includes("KICK") && message.includes("Нельзя перелетать чаще одного раза в 3 с.")) {
                                                console.log(`🚫 3-second rule detected on JOIN attempt ${joinAttempts}`);
                                                this.socket.removeEventListener('message', kickListener);
                                                if (joinAttempts < maxJoinAttempts) {
                                                    console.log(`⏳ Retrying JOIN in 200ms... (attempt ${joinAttempts + 1}/${maxJoinAttempts})`);
                                                    setTimeout(() => {
                                                        attemptJoin();
                                                    }, 200); // Wait 200ms before retry
                                                } else {
                                                    console.log(`❌ Max JOIN attempts (${maxJoinAttempts}) reached for ${this.botId}`);
                                                    reject(new Error(`JOIN failed after ${maxJoinAttempts} attempts due to 3-second rule`));
                                                }
                                            } else if (message.includes("JOIN") && !message.includes("KICK")) {
                                                // Successful JOIN detected
                                                console.log(`✅ JOIN successful for ${this.botId} on attempt ${joinAttempts}`);
                                                this.socket.removeEventListener('message', kickListener);
                                                resolve('join_complete');
                                            }
                                        };
                                        
                                        // Add listener before sending JOIN
                                        this.socket.addEventListener('message', kickListener);
                                        
                                        // Send JOIN command
                                        setTimeout(() => {
                                            this.send(`JOIN ${config.planetName}`);
                                            console.log(`JOIN command sent for ${this.botId} (attempt ${joinAttempts})`);
                                            
                                            // Set timeout for this attempt (in case no response)
                                            setTimeout(() => {
                                                if (joinAttempts === maxJoinAttempts) {
                                                    this.socket.removeEventListener('message', kickListener);
                                                    resolve('join_timeout'); // Don't fail the entire process
                                                }
                                            }, 5000); // 5 second timeout per attempt
                                        }, joinAttempts === 1 ? 2000 : 100); // First attempt after 2s, subsequent attempts after 100ms
                                    };
                                    
                                    // Start the first attempt
                                    attemptJoin();
                                });
                                parallelTasks.push(joinTask);
                                
                                // Task 2: HTTP jail_free request (if we have the data ready)
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
                                
                                // Execute all tasks in parallel and handle completion
                                Promise.allSettled(parallelTasks).then((results) => {
                                    console.log(`Parallel tasks completed for ${this.botId}:`, results.map(r => r.value || r.reason));
                                    
                                    // Short delay then QUIT for fast relogin
                                    setTimeout(() => {
                                        console.log(`⚡ Sending QUIT command for fast relogin [${this.botId}]`);
                                        this.send("QUIT");
                                        this.prisonState = 'IDLE';
                                        
                                        // Clean up and trigger fast reconnection
                                        this.cleanup();
                                        if (activeConnection === this) {
                                            activeConnection = null;
                                        }
                                        
                                        // Use dedicated prison connection pool for fastest reconnect
                                        console.log("⚡ Using dedicated prison connection for relogin");
                                        Promise.resolve().then(async () => {
                                            try {
                                                console.time('prisonRelogin');
                                                await getPrisonConnection(); // Use dedicated prison pool
                                                console.timeEnd('prisonRelogin');
                                                console.log(`✅ Fast prison relogin completed`);
                                            } catch (error) {
                                                console.error("Failed to get prison connection:", error.message || error);
                                                // Fallback to regular connection
                                                getConnection(true).catch(retryError => {
                                                    console.error("Prison relogin fallback failed:", retryError.message || retryError);
                                                });
                                            }
                                        });
                                    }, 3000); // Reduced QUIT delay
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
                            Promise.resolve().then(() => getConnection(true).catch(err => tryReconnectWithBackoff().catch(e => console.error(`Failed after 451 error:`, e))));
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
                            console.log(`⚡ Got 452 error after ${this.userCommandRetryCount} retries, closed connection, removed from pool, and trying immediate recovery...`);
                            reject(new Error(`Critical error 452 after retries`));
                            Promise.resolve().then(() => getConnection(true).catch(err => tryReconnectWithBackoff().catch(e => console.error(`Failed after 452 error:`, e))));
                            return;
                        } else {
                            this.cleanup();
                        }
                        break;
                    case "850":
                        if (payload.includes("3 секунд(ы)")) {
                            if (currentMode === 'attack') {
                                currentAttackTime += config.attackIntervalTime;
                                if (currentAttackTime > config.stopAttackTime) currentAttackTime = config.startAttackTime;
                                console.log(`Hit 3-second rule in attack mode, increased attack time to: ${currentAttackTime}ms`);
                            } else if (currentMode === 'defence') {
                                currentDefenceTime += config.defenceIntervalTime;
                                if (currentDefenceTime > config.stopDefenceTime) currentDefenceTime = config.startDefenceTime;
                                console.log(`Hit 3-second rule in defence mode, increased defence time to: ${currentDefenceTime}ms`);
                            }
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
                    console.log(`⚡ Fast-activating warm connection [${this.botId || 'pending'}]...`);
                    this.authenticating = true;
                    this.connectionTimeout = setTimeout(() => {
                        console.log("Connection activation timeout");
                        this.authenticating = false;
                        reject(new Error("Connection activation timeout"));
                    }, 1000);
                    const parts = this.registrationData.split(/\s+/);
                    if (parts.length >= 4) {
                        this.botId = parts[1];
                        this.password = parts[2];
                        this.nick = parts[3];
                        if (this.hash) {
                            this.send(`USER ${this.botId} ${this.password} ${this.nick} ${this.hash}`);
                            console.log(`Activated warm connection with USER command [${this.botId}]`);
                            const originalOnMessage = this.socket.onmessage;
                            this.socket.onmessage = (event) => {
                                const message = event.data.toString().trim();
                                console.log(`Activation received: ${message}`);
                                if (message.startsWith("999")) {
                                    this.state = CONNECTION_STATES.AUTHENTICATED;
                                    console.log(`Warm connection [${this.botId}] authenticated, sending setup commands...`);
                                    this.send("FWLISTVER 0");
                                    this.send("ADDONS 0 0");
                                    this.send("MYADDONS 0 0");
                                    this.send("PHONE 0 0 0 2 :Node.js");
                                    this.send("JOIN");
                                    this.state = CONNECTION_STATES.READY;
                                    this.authenticating = false;
                                    this.userCommandRetryCount = 0;
                                    reconnectAttempt = 0;
                                    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
                                    console.log(`⚡ Warm connection [${this.botId}] SUCCESSFULLY activated and READY`);
                                    this.socket.onmessage = originalOnMessage;
                                    resolve(this);
                                    return;
                                }
                                if (originalOnMessage) originalOnMessage(event);
                            };
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
        
        cleanup: function(sendQuit = false) {
            try {
                if (sendQuit && this.socket && this.socket.readyState === WebSocket.OPEN) {
                    this.send("QUIT :ds");
                    // Wait a bit for the message to be sent
                    setTimeout(() => {
                        if (this.socket) this.socket.terminate();
                    }, 100);
                } else if (this.socket) {
                    this.socket.terminate();
                }
                if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
                if (this.prisonTimeout) clearTimeout(this.prisonTimeout);
                this.socket = null;
                this.state = CONNECTION_STATES.CLOSED;
                this.authenticating = false;
            } catch (err) {
                console.error(`Error in cleanup [${this.botId || 'connecting'}]:`, err);
            }
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
    
    const tokens = payload.split(' ');
    let i = 0;
    let detectedRivals = [];
    
    while (i < tokens.length) {
        let token = tokens[i];
        let name = token;
        let hasPrefix = false;
        if (token.length > 1 && (token.startsWith('@') || token.startsWith('+'))) {
            name = token.substring(1);
            hasPrefix = true;
        }
        console.log(`Processing token: "${token}" -> name: "${name}", hasPrefix: ${hasPrefix}`);
        i++;
        if (i < tokens.length && !isNaN(tokens[i]) && tokens[i] !== '') {
            const id = tokens[i];
            userMap[name] = id;
            console.log(`Added to userMap [${connection.botId}]: ${name} -> ${id}`);
            if (rivalNames.includes(name)) {
                detectedRivals.push(name);
                console.log(`✅ Detected rival [${connection.botId}]: ${name} with ID ${id}`);
            }
            i++;
        } else {
            if (rivalNames.includes(name)) {
                console.log(`⚠️ Found rival name "${name}" without immediate ID`);
                let foundId = null;
                for (let j = i; j < Math.min(i + 10, tokens.length); j++) {
                    if (!isNaN(tokens[j]) && tokens[j] !== '' && tokens[j].length > 5) {
                        foundId = tokens[j];
                        break;
                    }
                }
                if (foundId) {
                    userMap[name] = foundId;
                    detectedRivals.push(name);
                    console.log(`✅ Found rival [${connection.botId}]: ${name} with delayed ID ${foundId}`);
                }
            }
        }
    }
    
    if (detectedRivals.length > 0) {
        console.log(`Detected rivals in 353 [${connection.botId}]: ${detectedRivals.join(', ')} - Defence mode activated`);
        handleRivals(detectedRivals, 'defence', connection);
    } else {
        console.log(`No rivals detected in 353 [${connection.botId}], continuing to monitor`);
        console.log(`Available names in userMap: ${Object.keys(userMap).join(', ')}`);
        console.log(`Looking for rivals: ${rivalNames.join(', ')}`);
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
            handleRivals([name], 'attack', connection);
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
    if (!connection.botId || rivals.length === 0) {
        console.log(`No rivals to handle or bot ID not set`);
        return;
    }
    
    currentMode = mode;
    const waitTime = mode === 'attack' ? currentAttackTime : currentDefenceTime;
    console.log(`Handling rivals in ${mode} mode with waitTime: ${waitTime}ms [${connection.botId}]`);
    monitoringMode = false;
    
    for (const rival of rivals) {
        const id = userMap[rival];
        if (id) {
            await new Promise(resolve => {
                setTimeout(() => {
                    console.log(`Sending ACTION 3 to ${rival} (ID: ${id}) [${connection.botId}]`);
                    connection.send(`ACTION 3 ${id}`);
                    resolve();
                }, waitTime);
            });
            console.log(`Actions sent to ${rival} (ID: ${id}) with ${waitTime}ms delay [${connection.botId}]`);
        }
    }
    
    console.log(`Reloading WebSocket connection [${connection.botId}]`);
    connection.cleanup(true); // Send QUIT before closing
    if (activeConnection === connection) activeConnection = null;
    monitoringMode = true;
    
    console.log("⚡ Actions completed, waiting 500ms before activating new connection");
    setTimeout(() => {
        Promise.resolve().then(async () => {
            try {
                console.time('reconnectAfterAction');
                await getConnection(true);
                console.timeEnd('reconnectAfterAction');
            } catch (error) {
                console.error("Failed to get new connection after rival handling:", error.message || error);
                tryReconnectWithBackoff().catch(retryError => console.error("All reconnection attempts failed:", retryError.message || retryError));
            }
        });
    }, 1500);
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
        if (connection.prisonTimeout) clearTimeout(this.prisonTimeout);
    }
}

// Initial pool creation
Promise.all([
    optimizedConnectionPoolMaintenance().catch(err => console.error("Initial pool setup failed:", err)),
    optimizedPrisonPoolMaintenance().catch(err => console.error("Initial prison pool setup failed:", err))
]).then(() => console.log("🚀 Optimized connection pools initialized"));

// Smart maintenance scheduling
setInterval(() => {
    if (!poolMaintenanceInProgress && !prisonMaintenanceInProgress) {
        const healthyRegular = connectionPool.filter(conn => conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData).length;
        const healthyPrison = prisonConnectionPool.filter(conn => conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData).length;
        if (healthyRegular < POOL_MIN_SIZE) optimizedConnectionPoolMaintenance().catch(err => console.error("Scheduled pool maintenance failed:", err));
        if (healthyPrison < PRISON_POOL_MIN_SIZE) optimizedPrisonPoolMaintenance().catch(err => console.error("Scheduled prison maintenance failed:", err));
    }
}, POOL_HEALTH_CHECK_INTERVAL);

// Enhanced pool status logging
setInterval(() => {
    const healthyRegular = connectionPool.filter(conn => conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData).length;
    const healthyPrison = prisonConnectionPool.filter(conn => conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData).length;
    console.log(`📊 Optimized Pool Status - Regular: ${healthyRegular}/${connectionPool.length} (target: ${POOL_TARGET_SIZE}), Prison: ${healthyPrison}/${prisonConnectionPool.length} (target: ${PRISON_POOL_TARGET_SIZE})`);
}, 30000);

async function recoverUser(password) {
    console.log("Starting recovery with code:", password);
    try {
        await optimizedConnectionPoolMaintenance();
        await getMonitoringConnection();
        console.log("Initial monitoring connection established successfully");
    } catch (error) {
        console.error("Failed to establish initial monitoring connection:", error.message || error);
        setTimeout(() => recoverUser(password), 500);
    }
}

async function maintainMonitoringConnection() {
    if (monitoringMode && (!activeConnection || activeConnection.state !== CONNECTION_STATES.READY)) {
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

recoverUser(recoveryCode);

process.on('SIGINT', () => {
    console.log("Shutting down...");
    connectionPool.forEach(conn => conn.cleanup(true)); // Send QUIT for graceful shutdown
    if (activeConnection) activeConnection.cleanup(true);
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error.message || error);
    if (activeConnection) {
        activeConnection.cleanup();
        activeConnection = null;
    }
    setTimeout(() => {
        if (monitoringMode) getMonitoringConnection().catch(err => console.error("Failed to get new monitoring connection after uncaught exception:", err.message || err));
        else getConnection(true).catch(err => console.error("Failed to get new connection after uncaught exception:", err.message || err));
    }, 500);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    if (activeConnection) {
        activeConnection.cleanup();
        activeConnection = null;
    }
    setTimeout(() => {
        if (monitoringMode) getMonitoringConnection().catch(err => console.error("Failed to get new monitoring connection after unhandled rejection:", err.message || err));
        else getConnection(true).catch(err => console.error("Failed to get new connection after unhandled rejection:", err.message || err));
    }, 500);
});