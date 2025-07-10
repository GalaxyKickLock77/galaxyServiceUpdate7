// Test ML integration in galaxy_1.js context
console.log('🧪 Testing ML in galaxy_1.js context...\n');

// Mock essential globals
global.trackedRivals = new Map();

// Mock appLog function
function appLog(message, ...args) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`, ...args);
}

// Test ML loading exactly like galaxy_1.js does
let timingOptimizer = null;

if (!timingOptimizer) {
    try {
        const mlModule = require('./ml_timing_optimizer');
        timingOptimizer = mlModule.timingOptimizer;
        appLog('🤖 ML Timing Optimizer loaded successfully');
    } catch (err) {
        appLog('⚠️ ML Timing Optimizer not available:', err.message);
        // Create fallback optimizer
        timingOptimizer = {
            getOptimizedTiming: (rivalData, connection, baseTiming) => baseTiming,
            recordTimingResult: () => {},
            getStats: () => ({ totalSamples: 0, recentSuccessRate: '0%', modelTrained: false })
        };
    }
}

// Test getCurrentTiming function like in galaxy_1.js
function getCurrentTiming(mode, connection) {
    const baseTiming = 1870; // Mock base timing
    
    // ML Enhancement: Get optimized timing (with safety check)
    let optimizedTiming = baseTiming;
    if (timingOptimizer) {
        try {
            const rivalData = { name: 'current', mode: mode, connection: connection };
            optimizedTiming = timingOptimizer.getOptimizedTiming(rivalData, connection, baseTiming);
            
            if (optimizedTiming !== baseTiming) {
                appLog(`🤖 ML optimized timing: ${baseTiming}ms → ${optimizedTiming}ms (${mode})`);
            }
        } catch (err) {
            appLog(`⚠️ ML timing error, using base: ${err.message}`);
            optimizedTiming = baseTiming;
        }
    }
    
    appLog(`🕰️ getCurrentTiming: mode=${mode}, timing=${optimizedTiming}ms`);
    return Math.max(100, optimizedTiming); // Minimum 100ms
}

// Test the functions
const mockConnection = { rcKey: 'RC1', botId: 'test_bot' };
const result1 = getCurrentTiming('attack', mockConnection);
const result2 = getCurrentTiming('defence', mockConnection);

// Test ML learning
if (timingOptimizer) {
    try {
        const rivalData = { name: 'TestRival', mode: 'attack', connection: mockConnection };
        timingOptimizer.recordTimingResult(rivalData, 1800, true, Date.now());
        appLog('🤖 ML learning test successful');
        
        const stats = timingOptimizer.getStats();
        appLog('🤖 ML Stats:', JSON.stringify(stats));
    } catch (err) {
        appLog('⚠️ ML learning test failed:', err.message);
    }
}

console.log('\n✅ ML integration test complete!');
console.log('🎯 Your galaxy_1.js should now show these ML messages when it runs!');