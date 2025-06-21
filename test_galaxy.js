const GalaxyModule = require('./galaxy_1.js');

// --- Mocking Dependencies ---

// Mock WebSocket
class MockWebSocket {
    constructor(url, options) {
        this.url = url;
        this.options = options;
        this.readyState = MockWebSocket.OPEN;
        this.messagesSent = [];
        this.eventListeners = {};
        console.log(`MockWebSocket: Connected to ${url}`);
        setTimeout(() => this.emit('open'), 10); // Simulate async open
    }

    send(message) {
        this.messagesSent.push(message);
        console.log(`MockWebSocket: Sent: ${message.trim()}`);
    }

    terminate() {
        this.readyState = MockWebSocket.CLOSED;
        console.log('MockWebSocket: Terminated');
        this.emit('close');
    }

    addEventListener(event, listener) {
        if (!this.eventListeners[event]) {
            this.eventListeners[event] = [];
        }
        this.eventListeners[event].push(listener);
    }

    removeEventListener(event, listener) {
        if (this.eventListeners[event]) {
            this.eventListeners[event] = this.eventListeners[event].filter(l => l !== listener);
        }
    }

    emit(event, data) {
        if (this.eventListeners[event]) {
            this.eventListeners[event].forEach(listener => listener({ data: data }));
        }
    }
}
MockWebSocket.OPEN = 1;
MockWebSocket.CLOSED = 3;

// Mock https for performJailFreeFast
const mockHttps = {
    request: (options, callback) => {
        console.log(`MockHTTPS: Request to ${options.hostname}${options.path}`);
        const mockRes = {
            on: (event, listener) => {
                if (event === 'data') {
                    // Simulate a successful response
                    setTimeout(() => listener('{"status":"success","message":"Jail free successful"}'), 10);
                } else if (event === 'end') {
                    setTimeout(() => listener(), 20);
                }
            }
        };
        setTimeout(() => callback(mockRes), 5); // Simulate async response
        return {
            write: () => {},
            end: () => {},
            on: (event, listener) => {
                if (event === 'error') {
                    // No-op for successful mock
                }
            },
            setTimeout: () => {},
            destroy: () => {}
        };
    }
};

// Mock fsSync for config loading
const mockFsSync = {
    readFileSync: (path, encoding) => {
        if (path === './config1.json') {
            return JSON.stringify(mockConfig);
        }
        throw new Error(`MockFsSync: File not found: ${path}`);
    },
    watch: (path, options, callback) => {
        console.log(`MockFsSync: Watching ${path}`);
        // No-op for tests, as we control config via _setConfig
        return { close: () => {} };
    },
    statSync: (path) => {
        // Simulate a file that hasn't changed for polling
        return { mtimeMs: Date.now() };
    }
};

// Override global dependencies for testing
let originalWebSocket = global.WebSocket;
let originalHttps = require('https');
let originalFsSync = require('fs');

global.WebSocket = MockWebSocket;
Object.assign(require('https'), mockHttps); // Use Object.assign to replace methods
Object.assign(require('fs'), mockFsSync); // Use Object.assign to replace methods

// --- Test Utilities ---
let testResults = [];
let currentTestName = '';

// Mock setTimeout and setInterval to control time in tests
const originalSetTimeout = global.setTimeout;
const originalSetInterval = global.setInterval;
const originalClearTimeout = global.clearTimeout;
const originalClearInterval = global.clearInterval;

let mockTimers = [];
let mockIntervals = [];
let currentTime = 0;

global.setTimeout = (fn, delay) => {
    const timer = { fn, delay, startTime: currentTime, id: Math.random() };
    mockTimers.push(timer);
    return timer.id;
};

global.setInterval = (fn, delay) => {
    const interval = { fn, delay, startTime: currentTime, id: Math.random() };
    mockIntervals.push(interval);
    return interval.id;
};

global.clearTimeout = (id) => {
    mockTimers = mockTimers.filter(t => t.id !== id);
};

global.clearInterval = (id) => {
    mockIntervals = mockIntervals.filter(i => i.id !== id);
};

async function advanceTime(ms) {
    currentTime += ms;
    // Execute timers that have passed
    const timersToExecute = mockTimers.filter(t => t.startTime + t.delay <= currentTime);
    mockTimers = mockTimers.filter(t => t.startTime + t.delay > currentTime);
    for (const timer of timersToExecute) {
        await Promise.resolve(timer.fn()); // Await to handle async functions
    }

    // Execute intervals that have passed
    for (const interval of mockIntervals) {
        while (interval.startTime + interval.delay <= currentTime) {
            await Promise.resolve(interval.fn()); // Await to handle async functions
            interval.startTime += interval.delay; // Advance interval's last execution time
        }
    }
}

function resetMockTimers() {
    mockTimers = [];
    mockIntervals = [];
    currentTime = 0;
}


function test(name, fn) {
    currentTestName = name;
    console.log(`\n--- Running Test: ${name} ---`);
    GalaxyModule._resetState(); // Reset state before each test
    resetMockTimers(); // Reset mock timers for each test
    try {
        fn();
        testResults.push({ name, status: 'PASSED' });
        console.log(`--- Test PASSED: ${name} ---`);
    } catch (error) {
        testResults.push({ name, status: 'FAILED', error: error.message });
        console.error(`--- Test FAILED: ${name} ---`);
        console.error(error);
    }
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(`Assertion Failed: ${message}`);
    }
}

function assertEquals(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`Assertion Failed: ${message} - Expected: ${expected}, Actual: ${actual}`);
    }
}

function assertMapSize(map, expectedSize, message) {
    if (map.size !== expectedSize) {
        throw new Error(`Assertion Failed: ${message} - Expected map size: ${expectedSize}, Actual: ${map.size}`);
    }
}

function assertMapHas(map, key, message) {
    if (!map.has(key)) {
        throw new Error(`Assertion Failed: ${message} - Map does not have key: ${key}`);
    }
}

function assertMapDoesNotHave(map, key, message) {
    if (map.has(key)) {
        throw new Error(`Assertion Failed: ${message} - Map unexpectedly has key: ${key}`);
    }
}

// Helper to simulate a connection object for testing
function createMockConnection(botId, nick, rcKey = 'RC1', initialState = GalaxyModule.CONNECTION_STATES.READY) {
    const mockConn = GalaxyModule.createConnection();
    mockConn.botId = botId;
    mockConn.nick = nick;
    mockConn.password = 'mockpass';
    mockConn.hash = 'mockhash';
    mockConn.rcKey = rcKey;
    mockConn.state = initialState; // Set initial state
    mockConn.socket = new MockWebSocket('ws://mock');
    mockConn.messagesSent = []; // To capture messages sent by this specific mock connection
    mockConn.send = function(str) {
        this.messagesSent.push(str);
        console.log(`MockConnection [${this.botId}]: Sent: ${str}`);
        return true;
    };
    mockConn.cleanup = async function() {
        console.log(`MockConnection [${this.botId}]: Cleaning up`);
        this.state = GalaxyModule.CONNECTION_STATES.CLOSED;
        if (this.socket) this.socket.terminate();
        return Promise.resolve();
    };
    mockConn.cleanupPromise = Promise.resolve(); // Mock cleanup promise
    GalaxyModule._setActiveConnection(mockConn); // Set as active connection for relevant tests
    return mockConn;
}

// Helper to simulate connection becoming ready
async function simulateConnectionReady(connection) {
    connection.state = GalaxyModule.CONNECTION_STATES.READY;
    console.log(`Simulating connection ${connection.botId} is now READY.`);
    // Trigger any pending rival processing that might have been waiting for this state
    await advanceTime(50); // Allow processPendingRivals debounce to fire
}


// --- Mock Configuration ---
let mockConfig = {
    RC1: "RC1_value",
    RC2: "RC2_value",
    standOnEnemy: false,
    actionOnEnemy: false,
    aiChatToggle: false,
    dualRCToggle: false,
    kickAllToggle: false,
    planetName: "TestPlanet",
    RC1_startAttackTime: 100,
    RC1_stopAttackTime: 1000,
    RC1_attackIntervalTime: 100,
    RC1_startDefenceTime: 50,
    RC1_stopDefenceTime: 500,
    RC1_defenceIntervalTime: 50,
    RC2_startAttackTime: 200,
    RC2_stopAttackTime: 2000,
    RC2_attackIntervalTime: 200,
    RC2_startDefenceTime: 100,
    RC2_stopDefenceTime: 1000,
    RC2_defenceIntervalTime: 100,
    blackListRival: ["Rival1", "Rival3"],
    whiteListMember: ["Friend1"]
};

// --- Test Cases ---

test('kickAllToggle true: should process only one rival and clear pendingRivals', async () => {
    GalaxyModule._setConfig({ ...mockConfig, kickAllToggle: true });
    GalaxyModule._setFounderId('99999999'); // Set a founder ID to allow processing

    const mockConn = createMockConnection('12345678', 'MyBot');
    mockConn.lastActionCommand = '1'; // Simulate a last action command

    // Simulate multiple rivals joining
    GalaxyModule.pendingRivals.set('RivalA', { id: '11111111', connection: mockConn, mode: 'attack' });
    GalaxyModule.pendingRivals.set('RivalB', { id: '22222222', connection: mockConn, mode: 'attack' });
    GalaxyModule.pendingRivals.set('RivalC', { id: '33333333', connection: mockConn, mode: 'attack' });

    // Process pending rivals
    await GalaxyModule.processPendingRivals();
    await advanceTime(100); // Allow handleRivals to complete its internal timeouts

    // Expect only one rival to have been processed and pendingRivals cleared
    assertMapSize(GalaxyModule.pendingRivals, 0, 'pendingRivals should be cleared after processing one rival');
    assertEquals(mockConn.messagesSent.length, 2, 'Should send 2 messages (ACTION lastActionCommand, ACTION 3) for the first rival');
    assert(mockConn.messagesSent[0].includes('ACTION 1 11111111'), 'First action should be for RivalA');
    assert(mockConn.messagesSent[1].includes('ACTION 3 11111111'), 'Second action should be for RivalA');
    assertEquals(GalaxyModule.activeConnection, null, 'Active connection should be null after cleanup');
});

test('kickAllToggle false: should process only blacklisted rivals and clear pendingRivals', async () => {
    GalaxyModule._setConfig({ ...mockConfig, kickAllToggle: false, blackListRival: ["RivalB"] });
    GalaxyModule._setFounderId('99999999');

    const mockConn = createMockConnection('12345678', 'MyBot');
    mockConn.lastActionCommand = '1';

    // Simulate multiple rivals joining, some blacklisted
    GalaxyModule.pendingRivals.set('RivalA', { id: '11111111', connection: mockConn, mode: 'attack' }); // Not blacklisted
    GalaxyModule.pendingRivals.set('RivalB', { id: '22222222', connection: mockConn, mode: 'attack' }); // Blacklisted
    GalaxyModule.pendingRivals.set('RivalC', { id: '33333333', connection: mockConn, mode: 'attack' }); // Not blacklisted

    await GalaxyModule.processPendingRivals();
    await advanceTime(100); // Allow handleRivals to complete its internal timeouts

    // Expect only RivalB to have been processed and pendingRivals cleared
    assertMapSize(GalaxyModule.pendingRivals, 0, 'pendingRivals should be cleared after processing blacklisted rival');
    assertEquals(mockConn.messagesSent.length, 2, 'Should send 2 messages for the blacklisted rival');
    assert(mockConn.messagesSent[0].includes('ACTION 1 22222222'), 'First action should be for RivalB');
    assert(mockConn.messagesSent[1].includes('ACTION 3 22222222'), 'Second action should be for RivalB');
    assertEquals(GalaxyModule.activeConnection, null, 'Active connection should be null after cleanup');
});

test('handleJoinCommand: should add rival to pendingRivals if kickAllToggle is true and not whitelisted/self', async () => {
    GalaxyModule._setConfig({ ...mockConfig, kickAllToggle: true, whiteListMember: [] });
    GalaxyModule._setFounderId('99999999');

    const mockConn = createMockConnection('12345678', 'MyBot');
    GalaxyModule._setActiveConnection(mockConn); // Ensure active connection is set for handleJoinCommand

    // Simulate a JOIN message for a new rival
    await GalaxyModule.handleJoinCommand([':user1', 'JOIN', 'RivalX', '44444444', '@', '123'], mockConn);
    await advanceTime(100); // Allow processPendingRivals and handleRivals to complete

    // processPendingRivals is called internally by handleJoinCommand
    // It should have processed RivalX and cleared the map
    assertMapSize(GalaxyModule.pendingRivals, 0, 'pendingRivals should be cleared after JOIN processing');
    assertEquals(mockConn.messagesSent.length, 2, 'Should send 2 messages for RivalX');
    assert(mockConn.messagesSent[0].includes('ACTION 1 44444444'), 'First action should be for RivalX');
    assert(mockConn.messagesSent[1].includes('ACTION 3 44444444'), 'Second action should be for RivalX');
});

test('handleJoinCommand: should not add whitelisted member to pendingRivals', async () => {
    GalaxyModule._setConfig({ ...mockConfig, kickAllToggle: true, whiteListMember: ["Friend1"] });
    GalaxyModule._setFounderId('99999999');

    const mockConn = createMockConnection('12345678', 'MyBot');
    GalaxyModule._setActiveConnection(mockConn);

    // Simulate a JOIN message for a whitelisted member
    await GalaxyModule.handleJoinCommand([':user1', 'JOIN', 'Friend1', '55555555'], mockConn);
    await advanceTime(100); // Allow any potential processing

    // pendingRivals should remain empty
    assertMapSize(GalaxyModule.pendingRivals, 0, 'pendingRivals should be empty for whitelisted member');
    assertEquals(mockConn.messagesSent.length, 0, 'No messages should be sent for whitelisted member');
});

test('handleJoinCommand: should not add self to pendingRivals', async () => {
    GalaxyModule._setConfig({ ...mockConfig, kickAllToggle: true });
    GalaxyModule._setFounderId('99999999');

    const mockConn = createMockConnection('12345678', 'MyBot');
    GalaxyModule._setActiveConnection(mockConn);

    // Simulate a JOIN message for self
    await GalaxyModule.handleJoinCommand([':user1', 'JOIN', 'MyBot', '12345678'], mockConn);
    await advanceTime(100); // Allow any potential processing

    assertMapSize(GalaxyModule.pendingRivals, 0, 'pendingRivals should be empty for self');
    assertEquals(mockConn.messagesSent.length, 0, 'No messages should be sent for self');
});

test('parse353: should add blacklisted rival to pendingRivals if kickAllToggle is false', async () => {
    GalaxyModule._setConfig({ ...mockConfig, kickAllToggle: false, blackListRival: ["RivalA"] });
    GalaxyModule._setFounderId('99999999');

    const mockConn = createMockConnection('12345678', 'MyBot');
    GalaxyModule._setActiveConnection(mockConn);

    // Simulate a 353 message with a blacklisted rival
    const message = ":server 353 MyBot = #channel :RivalA 11111111 RivalB 22222222";
    await GalaxyModule.parse353(message, mockConn);
    await advanceTime(100); // Allow processPendingRivals and handleRivals to complete

    // processPendingRivals is called internally by parse353
    // It should have processed RivalA and cleared the map
    assertMapSize(GalaxyModule.pendingRivals, 0, 'pendingRivals should be cleared after 353 processing');
    assertEquals(mockConn.messagesSent.length, 2, 'Should send 2 messages for RivalA');
    assert(mockConn.messagesSent[0].includes('ACTION 1 11111111'), 'First action should be for RivalA');
    assert(mockConn.messagesSent[1].includes('ACTION 3 11111111'), 'Second action should be for RivalA');
});

test('parse353: should not add non-blacklisted rival to pendingRivals if kickAllToggle is false', async () => {
    GalaxyModule._setConfig({ ...mockConfig, kickAllToggle: false, blackListRival: ["RivalX"] });
    GalaxyModule._setFounderId('99999999');

    const mockConn = createMockConnection('12345678', 'MyBot');
    GalaxyModule._setActiveConnection(mockConn);

    // Simulate a 353 message with a non-blacklisted rival
    const message = ":server 353 MyBot = #channel :RivalA 11111111 RivalB 22222222";
    await GalaxyModule.parse353(message, mockConn);
    await advanceTime(100); // Allow any potential processing

    assertMapSize(GalaxyModule.pendingRivals, 0, 'pendingRivals should be empty for non-blacklisted rival');
    assertEquals(mockConn.messagesSent.length, 0, 'No messages should be sent');
});

test('handleRivals: should clear pendingRivals if connection already handled by 850 error and kickAllToggle is true', async () => {
    GalaxyModule._setConfig({ ...mockConfig, kickAllToggle: true });
    GalaxyModule._setFounderId('99999999');

    const mockConn = createMockConnection('12345678', 'MyBot');
    mockConn.lastActionCommand = '1';

    // Simulate pending rivals
    GalaxyModule.pendingRivals.set('RivalA', { id: '11111111', connection: mockConn, mode: 'attack' });
    GalaxyModule.pendingRivals.set('RivalB', { id: '22222222', connection: mockConn, mode: 'attack' });

    // Simulate activeConnection becoming null (e.g., due to an 850 error handler)
    GalaxyModule._setActiveConnection(null);

    await GalaxyModule.handleRivals([{ name: 'RivalA', id: '11111111' }], 'attack', mockConn);
    await advanceTime(100); // Allow cleanup and potential re-connection logic

    assertMapSize(GalaxyModule.pendingRivals, 0, 'pendingRivals should be cleared when connection is already handled and kickAllToggle is true');
    assertEquals(mockConn.messagesSent.length, 0, 'No messages should be sent if connection is already handled');
});

test('handleRivals: should clear pendingRivals after successful action and cleanup if kickAllToggle is true', async () => {
    GalaxyModule._setConfig({ ...mockConfig, kickAllToggle: true });
    GalaxyModule._setFounderId('99999999');

    const mockConn = createMockConnection('12345678', 'MyBot');
    mockConn.lastActionCommand = '1';
    GalaxyModule._setActiveConnection(mockConn); // Ensure it's the active connection

    // Simulate pending rivals
    GalaxyModule.pendingRivals.set('RivalA', { id: '11111111', connection: mockConn, mode: 'attack' });
    GalaxyModule.pendingRivals.set('RivalB', { id: '22222222', connection: mockConn, mode: 'attack' });

    await GalaxyModule.handleRivals([{ name: 'RivalA', id: '11111111' }], 'attack', mockConn);
    await advanceTime(100); // Allow cleanup and potential re-connection logic

    assertMapSize(GalaxyModule.pendingRivals, 0, 'pendingRivals should be cleared after successful action and cleanup when kickAllToggle is true');
    assertEquals(mockConn.messagesSent.length, 2, 'Should send 2 messages for RivalA');
    assert(mockConn.messagesSent[0].includes('ACTION 1 11111111'), 'First action should be for RivalA');
    assert(mockConn.messagesSent[1].includes('ACTION 3 11111111'), 'Second action should be for RivalA');
});

test('processPendingRivals: should defer processing if connection is not READY and retry later', async () => {
    GalaxyModule._setConfig({ ...mockConfig, kickAllToggle: true });
    GalaxyModule._setFounderId('99999999');

    const mockConn = createMockConnection('12345678', 'MyBot', 'RC1', GalaxyModule.CONNECTION_STATES.AUTHENTICATED); // Connection not READY
    mockConn.lastActionCommand = '1';

    GalaxyModule.pendingRivals.set('RivalX', { id: '98765432', connection: mockConn, mode: 'attack' });

    // First attempt to process rivals - should defer
    await GalaxyModule.processPendingRivals();
    await advanceTime(100); // Allow debounce to fire

    assertMapSize(GalaxyModule.pendingRivals, 1, 'RivalX should still be in pendingRivals as connection is not READY');
    assertEquals(mockConn.messagesSent.length, 0, 'No messages should be sent yet');

    // Simulate connection becoming READY
    await simulateConnectionReady(mockConn);

    // Advance time to trigger the periodic re-check (5000ms interval)
    await advanceTime(5000);

    assertMapSize(GalaxyModule.pendingRivals, 0, 'RivalX should be processed and removed after connection becomes READY and periodic check runs');
    assertEquals(mockConn.messagesSent.length, 2, 'Should send 2 messages for RivalX after retry');
    assert(mockConn.messagesSent[0].includes('ACTION 1 98765432'), 'First action should be for RivalX after retry');
    assert(mockConn.messagesSent[1].includes('ACTION 3 98765432'), 'Second action should be for RivalX after retry');
    assertEquals(GalaxyModule.activeConnection, null, 'Active connection should be null after cleanup');
});


// --- Report Generation ---
function generateReport() {
    console.log("\n--- Test Report ---");
    let passed = 0;
    let failed = 0;

    testResults.forEach(result => {
        if (result.status === 'PASSED') {
            console.log(`✅ ${result.name}`);
            passed++;
        } else {
            console.error(`❌ ${result.name} - FAILED: ${result.error}`);
            failed++;
        }
    });

    console.log(`\nSummary: ${passed} PASSED, ${failed} FAILED`);

    if (failed > 0) {
        console.log("\n--- Areas for Improvement ---");
        console.log("1. Comprehensive mocking: The current mocks are basic. For production-grade testing, consider a dedicated mocking library (e.g., `sinon`) to mock `WebSocket`, `https`, `fs`, and `setTimeout`/`setInterval` more robustly.");
        console.log("2. Full test coverage: Add more test cases for all functions, edge cases, error handling, and different configuration combinations.");
        console.log("3. Asynchronous testing: Ensure all asynchronous operations (timeouts, promises, WebSocket events) are properly awaited and tested for their side effects.");
        console.log("4. State management: While `_resetState` helps, consider if the module's global state can be further encapsulated or passed as parameters to make functions more pure and easier to test in isolation.");
        console.log("5. Integration tests: Beyond unit tests, consider integration tests that simulate the full flow of messages and interactions with mocked external services.");
    } else {
        console.log("\nAll tests passed! The implemented changes for `kickAllToggle` and `pendingRivals` handling appear to be working as expected.");
    }
}

// Run all tests
(async () => {
    // Temporarily disable console.log from the main module during test execution
    const originalConsoleLog = console.log;
    console.log = () => {}; // Suppress console.log

    // Run tests
    await test('kickAllToggle true: should process only one rival and clear pendingRivals', async () => {
        GalaxyModule._setConfig({ ...mockConfig, kickAllToggle: true });
        GalaxyModule._setFounderId('99999999'); // Set a founder ID to allow processing

        const mockConn = createMockConnection('12345678', 'MyBot');
        mockConn.lastActionCommand = '1'; // Simulate a last action command

        // Simulate multiple rivals joining
        GalaxyModule.pendingRivals.set('RivalA', { id: '11111111', connection: mockConn, mode: 'attack' });
        GalaxyModule.pendingRivals.set('RivalB', { id: '22222222', connection: mockConn, mode: 'attack' });
        GalaxyModule.pendingRivals.set('RivalC', { id: '33333333', connection: mockConn, mode: 'attack' });

        // Process pending rivals
        await GalaxyModule.processPendingRivals();
        await advanceTime(100); // Allow handleRivals to complete its internal timeouts

        // Expect only one rival to have been processed and pendingRivals cleared
        assertMapSize(GalaxyModule.pendingRivals, 0, 'pendingRivals should be cleared after processing one rival');
        assertEquals(mockConn.messagesSent.length, 2, 'Should send 2 messages (ACTION lastActionCommand, ACTION 3) for the first rival');
        assert(mockConn.messagesSent[0].includes('ACTION 1 11111111'), 'First action should be for RivalA');
        assert(mockConn.messagesSent[1].includes('ACTION 3 11111111'), 'Second action should be for RivalA');
        assertEquals(GalaxyModule.activeConnection, null, 'Active connection should be null after cleanup');
    });

    await test('kickAllToggle false: should process only blacklisted rivals and clear pendingRivals', async () => {
        GalaxyModule._setConfig({ ...mockConfig, kickAllToggle: false, blackListRival: ["RivalB"] });
        GalaxyModule._setFounderId('99999999');

        const mockConn = createMockConnection('12345678', 'MyBot');
        mockConn.lastActionCommand = '1';

        // Simulate multiple rivals joining, some blacklisted
        GalaxyModule.pendingRivals.set('RivalA', { id: '11111111', connection: mockConn, mode: 'attack' }); // Not blacklisted
        GalaxyModule.pendingRivals.set('RivalB', { id: '22222222', connection: mockConn, mode: 'attack' }); // Blacklisted
        GalaxyModule.pendingRivals.set('RivalC', { id: '33333333', connection: mockConn, mode: 'attack' }); // Not blacklisted

        await GalaxyModule.processPendingRivals();
        await advanceTime(100); // Allow handleRivals to complete its internal timeouts

        // Expect only RivalB to have been processed and pendingRivals cleared
        assertMapSize(GalaxyModule.pendingRivals, 0, 'pendingRivals should be cleared after processing blacklisted rival');
        assertEquals(mockConn.messagesSent.length, 2, 'Should send 2 messages for the blacklisted rival');
        assert(mockConn.messagesSent[0].includes('ACTION 1 22222222'), 'First action should be for RivalB');
        assert(mockConn.messagesSent[1].includes('ACTION 3 22222222'), 'Second action should be for RivalB');
        assertEquals(GalaxyModule.activeConnection, null, 'Active connection should be null after cleanup');
    });

    await test('handleJoinCommand: should add rival to pendingRivals if kickAllToggle is true and not whitelisted/self', async () => {
        GalaxyModule._setConfig({ ...mockConfig, kickAllToggle: true, whiteListMember: [] });
        GalaxyModule._setFounderId('99999999');

        const mockConn = createMockConnection('12345678', 'MyBot');
        GalaxyModule._setActiveConnection(mockConn); // Ensure active connection is set for handleJoinCommand

        // Simulate a JOIN message for a new rival
        await GalaxyModule.handleJoinCommand([':user1', 'JOIN', 'RivalX', '44444444', '@', '123'], mockConn);
        await advanceTime(100); // Allow processPendingRivals and handleRivals to complete

        // processPendingRivals is called internally by handleJoinCommand
        // It should have processed RivalX and cleared the map
        assertMapSize(GalaxyModule.pendingRivals, 0, 'pendingRivals should be cleared after JOIN processing');
        assertEquals(mockConn.messagesSent.length, 2, 'Should send 2 messages for RivalX');
        assert(mockConn.messagesSent[0].includes('ACTION 1 44444444'), 'First action should be for RivalX');
        assert(mockConn.messagesSent[1].includes('ACTION 3 44444444'), 'Second action should be for RivalX');
    });

    await test('handleJoinCommand: should not add whitelisted member to pendingRivals', async () => {
        GalaxyModule._setConfig({ ...mockConfig, kickAllToggle: true, whiteListMember: ["Friend1"] });
        GalaxyModule._setFounderId('99999999');

        const mockConn = createMockConnection('12345678', 'MyBot');
        GalaxyModule._setActiveConnection(mockConn);

        // Simulate a JOIN message for a whitelisted member
        await GalaxyModule.handleJoinCommand([':user1', 'JOIN', 'Friend1', '55555555'], mockConn);
        await advanceTime(100); // Allow any potential processing

        // pendingRivals should remain empty
        assertMapSize(GalaxyModule.pendingRivals, 0, 'pendingRivals should be empty for whitelisted member');
        assertEquals(mockConn.messagesSent.length, 0, 'No messages should be sent for whitelisted member');
    });

    await test('handleJoinCommand: should not add self to pendingRivals', async () => {
        GalaxyModule._setConfig({ ...mockConfig, kickAllToggle: true });
        GalaxyModule._setFounderId('99999999');

        const mockConn = createMockConnection('12345678', 'MyBot');
        GalaxyModule._setActiveConnection(mockConn);

        // Simulate a JOIN message for self
        await GalaxyModule.handleJoinCommand([':user1', 'JOIN', 'MyBot', '12345678'], mockConn);
        await advanceTime(100); // Allow any potential processing

        assertMapSize(GalaxyModule.pendingRivals, 0, 'pendingRivals should be empty for self');
        assertEquals(mockConn.messagesSent.length, 0, 'No messages should be sent for self');
    });

    await test('parse353: should add blacklisted rival to pendingRivals if kickAllToggle is false', async () => {
        GalaxyModule._setConfig({ ...mockConfig, kickAllToggle: false, blackListRival: ["RivalA"] });
        GalaxyModule._setFounderId('99999999');

        const mockConn = createMockConnection('12345678', 'MyBot');
        GalaxyModule._setActiveConnection(mockConn);

        // Simulate a 353 message with a blacklisted rival
        const message = ":server 353 MyBot = #channel :RivalA 11111111 RivalB 22222222";
        await GalaxyModule.parse353(message, mockConn);
        await advanceTime(100); // Allow processPendingRivals and handleRivals to complete

        // processPendingRivals is called internally by parse353
        // It should have processed RivalA and cleared the map
        assertMapSize(GalaxyModule.pendingRivals, 0, 'pendingRivals should be cleared after 353 processing');
        assertEquals(mockConn.messagesSent.length, 2, 'Should send 2 messages for RivalA');
        assert(mockConn.messagesSent[0].includes('ACTION 1 11111111'), 'First action should be for RivalA');
        assert(mockConn.messagesSent[1].includes('ACTION 3 11111111'), 'Second action should be for RivalA');
    });

    await test('parse353: should not add non-blacklisted rival to pendingRivals if kickAllToggle is false', async () => {
        GalaxyModule._setConfig({ ...mockConfig, kickAllToggle: false, blackListRival: ["RXL"] });
        GalaxyModule._setFounderId('99999999');

        const mockConn = createMockConnection('12345678', 'MyBot');
        GalaxyModule._setActiveConnection(mockConn);

        // Simulate a 353 message with a non-blacklisted rival
        const message = ":server 353 MyBot = #channel :RivalA 11111111 RivalB 22222222";
        await GalaxyModule.parse353(message, mockConn);
        await advanceTime(100); // Allow any potential processing

        assertMapSize(GalaxyModule.pendingRivals, 0, 'pendingRivals should be empty for non-blacklisted rival');
        assertEquals(mockConn.messagesSent.length, 0, 'No messages should be sent');
    });

    await test('handleRivals: should clear pendingRivals if connection already handled by 850 error and kickAllToggle is true', async () => {
        GalaxyModule._setConfig({ ...mockConfig, kickAllToggle: true });
        GalaxyModule._setFounderId('99999999');

        const mockConn = createMockConnection('12345678', 'MyBot');
        mockConn.lastActionCommand = '1';

        // Simulate pending rivals
        GalaxyModule.pendingRivals.set('RivalA', { id: '11111111', connection: mockConn, mode: 'attack' });
        GalaxyModule.pendingRivals.set('RivalB', { id: '22222222', connection: mockConn, mode: 'attack' });

        // Simulate activeConnection becoming null (e.g., due to an 850 error handler)
        GalaxyModule._setActiveConnection(null);

        await GalaxyModule.handleRivals([{ name: 'RivalA', id: '11111111' }], 'attack', mockConn);
        await advanceTime(100); // Allow cleanup and potential re-connection logic

        assertMapSize(GalaxyModule.pendingRivals, 0, 'pendingRivals should be cleared when connection is already handled and kickAllToggle is true');
        assertEquals(mockConn.messagesSent.length, 0, 'No messages should be sent if connection is already handled');
    });

    await test('handleRivals: should clear pendingRivals after successful action and cleanup if kickAllToggle is true', async () => {
        GalaxyModule._setConfig({ ...mockConfig, kickAllToggle: true });
        GalaxyModule._setFounderId('99999999');

        const mockConn = createMockConnection('12345678', 'MyBot');
        mockConn.lastActionCommand = '1';
        GalaxyModule._setActiveConnection(mockConn); // Ensure it's the active connection

        // Simulate pending rivals
        GalaxyModule.pendingRivals.set('RivalA', { id: '11111111', connection: mockConn, mode: 'attack' });
        GalaxyModule.pendingRivals.set('RivalB', { id: '22222222', connection: mockConn, mode: 'attack' });

        await GalaxyModule.handleRivals([{ name: 'RivalA', id: '11111111' }], 'attack', mockConn);
        await advanceTime(100); // Allow cleanup and potential re-connection logic

        assertMapSize(GalaxyModule.pendingRivals, 0, 'pendingRivals should be cleared after successful action and cleanup when kickAllToggle is true');
        assertEquals(mockConn.messagesSent.length, 2, 'Should send 2 messages for RivalA');
        assert(mockConn.messagesSent[0].includes('ACTION 1 11111111'), 'First action should be for RivalA');
        assert(mockConn.messagesSent[1].includes('ACTION 3 11111111'), 'Second action should be for RivalA');
    });

    await test('processPendingRivals: should defer processing if connection is not READY and retry later', async () => {
        GalaxyModule._setConfig({ ...mockConfig, kickAllToggle: true });
        GalaxyModule._setFounderId('99999999');

        const mockConn = createMockConnection('12345678', 'MyBot', 'RC1', GalaxyModule.CONNECTION_STATES.AUTHENTICATED); // Connection not READY
        mockConn.lastActionCommand = '1';

        GalaxyModule.pendingRivals.set('RivalX', { id: '98765432', connection: mockConn, mode: 'attack' });

        // First attempt to process rivals - should defer
        await GalaxyModule.processPendingRivals();
        await advanceTime(100); // Allow debounce to fire

        assertMapSize(GalaxyModule.pendingRivals, 1, 'RivalX should still be in pendingRivals as connection is not READY');
        assertEquals(mockConn.messagesSent.length, 0, 'No messages should be sent yet');

        // Simulate connection becoming READY
        await simulateConnectionReady(mockConn);

        // Advance time to trigger the periodic re-check (5000ms interval)
        await advanceTime(5000);

        assertMapSize(GalaxyModule.pendingRivals, 0, 'RivalX should be processed and removed after connection becomes READY and periodic check runs');
        assertEquals(mockConn.messagesSent.length, 2, 'Should send 2 messages for RivalX after retry');
        assert(mockConn.messagesSent[0].includes('ACTION 1 98765432'), 'First action should be for RivalX after retry');
        assert(mockConn.messagesSent[1].includes('ACTION 3 98765432'), 'Second action should be for RivalX after retry');
        assertEquals(GalaxyModule.activeConnection, null, 'Active connection should be null after cleanup');
    });


    // Restore original console.log
    console.log = originalConsoleLog;

    generateReport();

    // Restore original dependencies after all tests
    global.WebSocket = originalWebSocket;
    Object.assign(require('https'), originalHttps);
    Object.assign(require('fs'), originalFsSync);

    // Restore original timers
    global.setTimeout = originalSetTimeout;
    global.setInterval = originalSetInterval;
    global.clearTimeout = originalClearTimeout;
    global.clearInterval = originalClearInterval;

})();
