const WebSocket = require('ws');
const fs = require('fs').promises;
const fsSync = require('fs');
const CryptoJS = require('crypto-js');
//const fetch = require('node-fetch'); // Added for HTTP requests
const path = require('path');
const https = require('https');
const { URL } = require('url');
// Configuration
let config;
let rivalNames = [];
let recoveryCode;
let userMap = {};
let reconnectAttempt = 0;
let currentMode = null;

// Connection pool settings
const MAX_POOL_SIZE = 2;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BACKOFF_BASE = 100;
const connectionPool = [];
let activeConnection = null;
let poolWarmupInProgress = false;

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
        delete require.cache[require.resolve('./config4.json')];
        config = require('./config4.json');
        rivalNames = Array.isArray(config.rival) ? config.rival : config.rival.split(',').map(name => name.trim());
        recoveryCode = config.RC;
        
        currentAttackTime = config.startAttackTime;
        currentDefenceTime = config.startDefenceTime;
        
        console.log("Configuration updated:", { 
            rivalNames, 
            recoveryCode,
            attackSettings: {
                start: config.startAttackTime,
                stop: config.stopAttackTime,
                interval: config.attackIntervalTime,
                current: currentAttackTime
            },
            defenceSettings: {
                start: config.startDefenceTime,
                stop: config.stopDefenceTime,
                interval: config.defenceIntervalTime,
                current: currentDefenceTime
            }
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

function createConnection() {
    const conn = {
        socket: null,
        state: CONNECTION_STATES.CLOSED,
        hash: null,
        botId: null,
        password: null, // Store password for HTTP requests
        lastUsed: Date.now(),
        authenticating: false,
        initPromise: null,
        reconnectAttempt: 0,
        createdAt: Date.now(),
        connectionTimeout: null,
        registrationData: null,
        prisonState: 'IDLE', // State for prison automation
        prisonTimeout: null, // Timeout for prison automation
        
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
            if (this.initPromise) {
                return this.initPromise;
            }
            
            this.initPromise = new Promise((resolve, reject) => {
                try {
                    if (this.socket) {
                        this.cleanup();
                    }
                    
                    this.state = CONNECTION_STATES.CONNECTING;
                    this.authenticating = true;
                    console.log(`Initializing new connection (stopAtHash: ${stopAtHash})...`);
                    
                    this.socket = new WebSocket("wss://cs.mobstudio.ru:6672/", {
                        rejectUnauthorized: false,
                        handshakeTimeout: 3000
                    });
                    
                    this.connectionTimeout = setTimeout(() => {
                        console.log("Connection initialization timeout");
                        this.authenticating = false;
                        this.cleanup();
                        reject(new Error("Connection initialization timeout"));
                    }, 5000);
                    
                    this.socket.on('open', () => {
                        this.state = CONNECTION_STATES.CONNECTED;
                        console.log("WebSocket connected, initializing identity");
                        this.send(":ru IDENT 352 -2 4030 1 2 :GALA");
                    });
                    
                    this.socket.on('message', (data) => {
                        const message = data.toString().trim();
                        
                        if (stopAtHash && this.state === CONNECTION_STATES.HASH_RECEIVED) {
                            console.log(`Warm pool connection [${this.botId || 'connecting'}] received message but stopping at hash: ${message}`);
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
                        this.state = CONNECTION_STATES.CLOSED;
                        const index = connectionPool.indexOf(this);
                        if (index !== -1) {
                            connectionPool.splice(index, 1);
                        }
                        if (this === activeConnection) {
                            console.log("Active connection closed");
                            console.log("Getting new connection immediately");
                            activeConnection = null;
                            Promise.resolve().then(() => {
                                return getConnection(true).catch(err => {
                                    console.error("Failed to get new connection after close:", err);
                                    return tryReconnectWithBackoff();
                                });
                            });
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
            }).finally(() => {
                this.initPromise = null;
            });
            
            return this.initPromise;
        },
        
        handleMessage: function(message, resolve, reject, stopAtHash = false) {
    try {
        console.log(`Received [${this.botId || 'connecting'}]: ${message}`);
        this.lastReceivedMessage = message;
        
        // Exact match for prison keywords
        const prisonWords = ["PRISON", "Prison", "Тюрьма"];
        if (prisonWords.some(word => message.split(/\s+/).includes(word))) {
            console.log(`🔒 Exact prison keyword detected: "${message}"`);
            handlePrisonAutomation(this);
            return;
        }
        
        const colonIndex = message.indexOf(" :");
        let payload = colonIndex !== -1 ? message.substring(colonIndex + 2) : "";
        const parts = message.split(/\s+/);
        
        // Handle messages with prefix (like :Надзиратель KICK ...)
        let command = parts[0];
        let commandIndex = 0;
        
        // If the first part starts with :, the actual command is the second part
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
                    if (stopAtHash) {
                        console.log(`Warm pool connection reached HASH_RECEIVED state`);
                    }
                }
                break;
            case "REGISTER":
                if (parts.length >= commandIndex + 4) {
                    this.botId = parts[commandIndex + 1];
                    this.password = parts[commandIndex + 2]; // Store password
                    const nick = parts[commandIndex + 3];
                    if (stopAtHash) {
                        this.registrationData = message;
                        console.log(`Stored registration data for warm pool connection [${this.botId}]`);
                        clearTimeout(this.connectionTimeout);
                        this.authenticating = false;
                        resolve(this);
                        return;
                    }
                    if (this.hash) {
                        this.send(`USER ${this.botId} ${this.password} ${nick} ${this.hash}`);
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
                reconnectAttempt = 0;
                if (this.connectionTimeout) {
                    clearTimeout(this.connectionTimeout);
                    this.connectionTimeout = null;
                }
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
                if (parts.length >= commandIndex + 2) {
                    remove_user(parts[commandIndex + 1]);
                }
                break;
            case "KICK":
                        console.log(`🔓 KICK command detected: ${message}`);
                        if (parts.length >= commandIndex + 3) {
                                const kickedUserId = parts[commandIndex + 2];

                                // Check if this is a prison release by looking for "released" in the message
                                const isReleasedFromPrison = message.toLowerCase().includes("released") || message.toLowerCase().includes("освободили");

                                console.log(`Processing KICK for user ID: ${kickedUserId}, bot ID: ${this.botId}, prison state: ${this.prisonState}, is prison release: ${isReleasedFromPrison}`);

                                // Only proceed if this is our bot being kicked AND it's a prison release
                                if (isReleasedFromPrison) {
                                        console.log(`🎉 Bot ${this.botId} was released from prison, now joining planet...`);
                                        setTimeout(() => {
                                        this.send(`JOIN ${config.planetName}`);
                                        }, 2000);

                                        // Set a very short timeout to send QUIT and trigger fast relogin
                                        setTimeout(() => {
                                                console.log(`⚡ Sending QUIT command for fast relogin [${this.botId}]`);
                                                this.send("QUIT");
                                                this.prisonState = 'IDLE';

                                                // Clean up current connection
                                                this.cleanup();
                                                if (activeConnection === this) {
                                                        activeConnection = null;
                                                }

                                                // Immediately trigger fast reconnection
                                                console.log("⚡ Starting immediate fast relogin after prison quit");
                                                Promise.resolve().then(async () => {
                                                        try {
                                                                console.time('prisonRelogin');
                                                                await getConnection(true); // Use warm connection for fastest reconnect
                                                                console.timeEnd('prisonRelogin');
                                                                console.log(`✅ Fast relogin completed after prison release`);
                                                        } catch (error) {
                                                                console.error("Failed to fast relogin after prison:", error.message || error);
                                                                // Fallback to regular reconnection
                                                                tryReconnectWithBackoff().catch(retryError => {
                                                                        console.error("Prison relogin fallback failed:", retryError.message || retryError);
                                                                });
                                                        }
                                                });
                                        }, 3000); // Very short delay - just 100ms to ensure JOIN command is sent first
                                } else {
                                        console.log(`KICK command ignored - either not our bot (${kickedUserId} vs ${this.botId}) or not a prison release (contains 'released': ${isReleasedFromPrison})`);
                                }
                        }
                        break;
            case "451":
            case "452":
                console.log(`Critical error ${command} [${this.botId || 'connecting'}]: ${message}`);
                if (this.authenticating) {
                    this.authenticating = false;
                    clearTimeout(this.connectionTimeout);
                    this.cleanup();
                    console.log(`⚡ Got ${command} error, trying immediate recovery with warm connection...`);
                    reject(new Error(`Critical error ${command}`));
                    Promise.resolve().then(() => {
                        return getConnection(true).catch(err => {
                            console.error(`Failed to get warm connection after ${command} error:`, err);
                            return tryReconnectWithBackoff();
                        });
                    });
                    return;
                }
                this.cleanup();
                break;
            case "850":
                if (payload.includes("3 секунд(ы)")) {
                    if (currentMode) {
                        if (currentMode === 'attack') {
                            currentAttackTime += config.attackIntervalTime;
                            if (currentAttackTime > config.stopAttackTime) {
                                currentAttackTime = config.startAttackTime;
                            }
                            console.log(`Hit 3-second rule in attack mode, increased attack time to: ${currentAttackTime}ms`);
                        } else if (currentMode === 'defence') {
                            currentDefenceTime += config.defenceIntervalTime;
                            if (currentDefenceTime > config.stopDefenceTime) {
                                currentDefenceTime = config.startDefenceTime;
                            }
                            console.log(`Hit 3-second rule in defence mode, increased defence time to: ${currentDefenceTime}ms`);
                        }
                    }
                }
                break;
        }
                
                // Handle prison automation response
                        if (this.prisonState === 'WAITING_FOR_BROWSER_MESSAGE' && message.startsWith("BROWSER 1")) {
            const urlMatch = message.match(/https:\/\/galaxy\.mobstudio\.ru\/services\/\?a=jail_info&usercur=(\d+)&/);
            if (urlMatch && urlMatch[1] === this.botId) {
                console.log(`Received BROWSER 1 message for jail_info: ${message}`);
                if (this.prisonTimeout) {
                    clearTimeout(this.prisonTimeout);
                    this.prisonTimeout = null;
                }
                performJailFree(this).then(() => {
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
                    }, 5000);
                    const parts = this.registrationData.split(/\s+/);
                    if (parts.length >= 4) {
                        this.botId = parts[1];
                        this.password = parts[2]; // Store password
                        const nick = parts[3];
                        if (this.hash) {
                            this.send(`USER ${this.botId} ${this.password} ${nick} ${this.hash}`);
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
                                    reconnectAttempt = 0;
                                    if (this.connectionTimeout) {
                                        clearTimeout(this.connectionTimeout);
                                        this.connectionTimeout = null;
                                    }
                                    console.log(`⚡ Warm connection [${this.botId}] SUCCESSFULLY activated and READY`);
                                    this.socket.onmessage = originalOnMessage;
                                    resolve(this);
                                    return;
                                }
                                if (originalOnMessage) {
                                    originalOnMessage(event);
                                }
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
        
        cleanup: function() {
            try {
                if (this.connectionTimeout) {
                    clearTimeout(this.connectionTimeout);
                    this.connectionTimeout = null;
                }
                if (this.prisonTimeout) {
                    clearTimeout(this.prisonTimeout);
                    this.prisonTimeout = null;
                }
                if (this.socket) {
                    this.socket.removeAllListeners();
                    if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(this.socket.readyState)) {
                        this.socket.terminate();
                    }
                    this.socket = null;
                }
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
        let name = tokens[i];
        let hasPrefix = false;
        
        if (name.length > 1 && (name.startsWith('@') || name.startsWith('+'))) {
            name = name.substring(1);
            hasPrefix = true;
        }
        
        i++;
        
        if (i < tokens.length && !isNaN(tokens[i])) {
            const id = tokens[i];
            userMap[name] = id;
            console.log(`Added to userMap [${connection.botId}]: ${name} -> ${id}`);
            if (rivalNames.includes(name)) {
                detectedRivals.push(name);
                console.log(`Detected rival [${connection.botId}]: ${name} with ID ${id}`);
            }
            i++;
        } else if (hasPrefix) {
            i--;
        }
    }
    
    if (detectedRivals.length > 0) {
        console.log(`Detected rivals in 353 [${connection.botId}]: ${detectedRivals.join(', ')} - Defence mode activated`);
        handleRivals(detectedRivals, 'defence', connection);
    } else {
        console.log(`No rivals detected in 353 [${connection.botId}], continuing to monitor`);
    }
    
    return detectedRivals.length > 0;
}

function handleJoinCommand(parts, connection) {
    if (parts.length >= 4) {
        let prefix = "";
        let name = "";
        let id = "";
        
        if (parts.length >= 5 && !isNaN(parts[3])) {
            prefix = parts[1];
            name = parts[2];
            id = parts[3];
        } else {
            name = parts[1];
            id = parts[2];
        }
        
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

async function warmConnectionPool() {
    if (poolWarmupInProgress) {
        console.log(`Pool warmup skipped: already in progress`);
        return;
    }
    
    try {
        poolWarmupInProgress = true;
        console.log(`Warming connection pool (current size: ${connectionPool.length}/${MAX_POOL_SIZE})`);
        
        const now = Date.now();
        const STALE_THRESHOLD = 5 * 60 * 1000;
        for (let i = connectionPool.length - 1; i >= 0; i--) {
            const conn = connectionPool[i];
            if (now - conn.lastUsed > STALE_THRESHOLD || 
                (conn.state !== CONNECTION_STATES.HASH_RECEIVED && conn.state !== CONNECTION_STATES.READY)) {
                console.log(`Pruning connection ${conn.botId || 'none'} from pool (State: ${conn.state}, Age: ${(now - conn.createdAt)/1000}s)`);
                conn.cleanup();
                connectionPool.splice(i, 1);
            }
        }
        
        const connectionsToAdd = Math.max(0, MAX_POOL_SIZE - connectionPool.length);
        if (connectionsToAdd > 0) {
            console.log(`Adding ${connectionsToAdd} new warm connection(s) to pool`);
            const batchSize = 5;
            for (let batch = 0; batch < Math.ceil(connectionsToAdd / batchSize); batch++) {
                const batchPromises = [];
                const batchStart = batch * batchSize;
                const batchEnd = Math.min((batch + 1) * batchSize, connectionsToAdd);
                for (let i = batchStart; i < batchEnd; i++) {
                    const conn = createConnection();
                    batchPromises.push((async () => {
                        try {
                            console.log(`Initializing pool connection ${i+1}/${connectionsToAdd} (warm mode)`);
                            await conn.initialize(true);
                            if (conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData) {
                                connectionPool.push(conn);
                                console.log(`Added new warm connection to pool (total: ${connectionPool.length}/${MAX_POOL_SIZE})`);
                                return true;
                            } else {
                                console.warn(`Connection reached end of initialization but state is ${conn.state}, not adding to pool`);
                                conn.cleanup();
                                return false;
                            }
                        } catch (error) {
                            console.error(`Failed to initialize connection for pool:`, error.message || error);
                            conn.cleanup();
                            return false;
                        }
                    })());
                }
                await Promise.allSettled(batchPromises);
            }
        }
        console.log(`Connection pool warm-up complete. Pool size: ${connectionPool.length}/${MAX_POOL_SIZE}`);
    } catch (err) {
        console.error("Error in warmConnectionPool:", err);
    } finally {
        poolWarmupInProgress = false;
    }
}

async function getConnection(activateFromPool = true) {
    console.log(`Getting connection (activateFromPool: ${activateFromPool})...`);
    if (activeConnection && activeConnection.state === CONNECTION_STATES.READY) {
        console.log(`Reusing existing active connection ${activeConnection.botId}`);
        return activeConnection;
    }
    
    const warmConnections = connectionPool.filter(conn => 
        conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData);
    console.log(`Warm connections available: ${warmConnections.length}/${connectionPool.length}`);
    
    let chosenConn = null;
    if (activateFromPool && warmConnections.length > 0) {
        let oldestIdx = -1;
        let oldestTime = Date.now();
        for (let i = 0; i < connectionPool.length; i++) {
            const conn = connectionPool[i];
            if (conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData) {
                if (conn.createdAt < oldestTime) {
                    oldestTime = conn.createdAt;
                    oldestIdx = i;
                }
            }
        }
        if (oldestIdx !== -1) {
            chosenConn = connectionPool[oldestIdx];
            connectionPool.splice(oldestIdx, 1);
            console.log(`⚡ Using warm connection from pool (pool size now: ${connectionPool.length}/${MAX_POOL_SIZE})`);
            try {
                console.time('warmActivation');
                await chosenConn.activateWarmConnection();
                console.timeEnd('warmActivation');
                activeConnection = chosenConn;
                Promise.resolve().then(() => {
                    warmConnectionPool().catch(err => {
                        console.error("Error warming connection pool after using connection:", err);
                    });
                });
                return chosenConn;
            } catch (error) {
                console.error("Failed to activate warm connection:", error.message || error);
                chosenConn.cleanup();
            }
        } else {
            console.log("No suitable warm connections in pool");
        }
    } else if (!activateFromPool) {
        console.log("Not using pool for this connection (monitoring mode)");
    }
    
    console.log("Creating new active connection");
    const newConn = createConnection();
    try {
        await newConn.initialize(false);
        activeConnection = newConn;
        return newConn;
    } catch (error) {
        console.error("Failed to create new connection:", error.message || error);
        Promise.resolve().then(() => {
            warmConnectionPool().catch(err => {
                console.error("Error warming connection pool after connection failure:", err);
            });
        });
        throw error;
    }
}

async function getMonitoringConnection() {
    return getConnection(false);
}

async function tryReconnectWithBackoff() {
    reconnectAttempt++;
    const backoffTime = Math.min(RECONNECT_BACKOFF_BASE * Math.pow(1.5, reconnectAttempt - 1), 3000);
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

async function handleRivals(rivals, mode, connection) {
    if (!connection.botId || rivals.length === 0) {
        console.log(`No rivals to handle or bot ID not set`);
        return;
    }
    
    currentMode = mode;
    const waitTime = mode === 'attack' ? currentAttackTime : currentDefenceTime;
    console.log(`Handling rivals in ${mode} mode with wait time: ${waitTime}ms [${connection.botId}]`);
    
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
    connection.cleanup();
    if (activeConnection === connection) {
        activeConnection = null;
    }
    
    monitoringMode = true;
    
    console.log("⚡ Actions completed, immediately activating new connection");
    Promise.resolve().then(async () => {
        try {
            console.time('reconnectAfterAction');
            await getConnection(true);
            console.timeEnd('reconnectAfterAction');
        } catch (error) {
            console.error("Failed to get new connection after rival handling:", error.message || error);
            tryReconnectWithBackoff().catch(retryError => {
                console.error("All reconnection attempts failed:", retryError.message || retryError);
            });
        }
    });
}

async function handlePrisonAutomation(connection) {
    if (connection.prisonState !== 'IDLE') {
        console.log(`Prison automation already in progress for connection ${connection.botId}, skipping...`);
        return;
    }
    
    try {
        connection.prisonState = 'WAITING_FOR_BROWSER_MESSAGE';
        console.log(`�� Starting prison automation for connection ${connection.botId}`);
        
        connection.send(`ACTION 29 ${connection.botId}`);
        
        connection.prisonTimeout = setTimeout(() => {
            console.log(`Prison automation timed out for connection ${connection.botId}`);
            connection.prisonState = 'IDLE';
            connection.prisonTimeout = null;
        }, 5000); // Increased timeout to account for waiting for KICK
    } catch (error) {
        console.error(`Error during prison automation for connection ${connection.botId}:`, error);
        connection.prisonState = 'IDLE';
        if (connection.prisonTimeout) {
            clearTimeout(connection.prisonTimeout);
            connection.prisonTimeout = null;
        }
    }
}

async function performJailFree(connection) {
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
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
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
        
        // Set a timeout for the request
        req.setTimeout(10000);
        
        // Write the form data to the request body
        req.write(formData);
        req.end();
    });
}

warmConnectionPool().catch(err => {
    console.error("Error during initial connection pool warm-up:", err);
});

setInterval(() => {
    if (!poolWarmupInProgress) {
        warmConnectionPool().catch(err => {
            console.error("Error warming connection pool:", err);
        });
    }
}, 20000);

async function recoverUser(password) {
    console.log("Starting recovery with code:", password);
    await warmConnectionPool().catch(err => {
        console.error("Initial pool warm-up failed:", err.message || err);
    });
    try {
        await getMonitoringConnection();
        console.log("Initial monitoring connection established successfully");
    } catch (error) {
        console.error("Failed to establish initial monitoring connection:", error.message || error);
        setTimeout(() => {
            recoverUser(password);
        }, 1000);
    }
}

async function maintainMonitoringConnection() {
    if (monitoringMode && (!activeConnection || activeConnection.state !== CONNECTION_STATES.READY)) {
        console.log("Maintaining monitoring connection...");
        try {
            await getMonitoringConnection();
        } catch (error) {
            console.error("Failed to maintain monitoring connection:", error.message || error);
            setTimeout(() => {
                maintainMonitoringConnection();
            }, 5000);
        }
    }
}

setInterval(() => {
    maintainMonitoringConnection();
}, 30000);

recoverUser(recoveryCode);

process.on('SIGINT', () => {
    console.log("Shutting down...");
    connectionPool.forEach(conn => {
        conn.cleanup();
    });
    if (activeConnection) {
        activeConnection.cleanup();
    }
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error.message || error);
    if (activeConnection) {
        activeConnection.cleanup();
        activeConnection = null;
    }
    setTimeout(() => {
        if (monitoringMode) {
            getMonitoringConnection().catch(err => {
                console.error("Failed to get new monitoring connection after uncaught exception:", err.message || err);
            });
        } else {
            getConnection(true).catch(err => {
                console.error("Failed to get new connection after uncaught exception:", err.message || err);
            });
        }
    }, 1000);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    if (activeConnection) {
        activeConnection.cleanup();
        activeConnection = null;
    }
    setTimeout(() => {
        if (monitoringMode) {
            getMonitoringConnection().catch(err => {
                console.error("Failed to get new monitoring connection after unhandled rejection:", err.message || err);
            });
        } else {
            getConnection(true).catch(err => {
                console.error("Failed to get new connection after unhandled rejection:", err.message || err);
            });
        }
    }, 1000);
});