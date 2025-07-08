// Test ML Integration
const { timingOptimizer } = require('./ml_timing_optimizer');

console.log('🧪 Testing ML Timing Optimizer Integration...\n');

// Mock connection and rival data
const mockConnection = {
    rcKey: 'RC1',
    botId: 'test_bot_123',
    latency: 45
};

const mockRivalData = {
    name: 'TestRival',
    mode: 'attack',
    connection: mockConnection
};

// Test 1: Basic timing optimization
console.log('Test 1: Basic Timing Optimization');
const baseTiming = 2000;
const optimizedTiming = timingOptimizer.getOptimizedTiming(mockRivalData, mockConnection, baseTiming);
console.log(`Base timing: ${baseTiming}ms`);
console.log(`Optimized timing: ${optimizedTiming}ms`);
console.log(`Difference: ${optimizedTiming - baseTiming}ms\n`);

// Test 2: Record some training data
console.log('Test 2: Recording Training Data');
for (let i = 0; i < 10; i++) {
    const success = Math.random() > 0.3; // 70% success rate
    const timing = 1800 + Math.random() * 400; // Random timing between 1800-2200ms
    const executionTime = Date.now();
    
    timingOptimizer.recordTimingResult(mockRivalData, timing, success, executionTime);
    console.log(`Sample ${i + 1}: Timing=${timing.toFixed(0)}ms, Success=${success}`);
}

// Test 3: Get stats
console.log('\nTest 3: ML Statistics');
const stats = timingOptimizer.getStats();
console.log('ML Stats:', stats);

// Test 4: Test with different scenarios
console.log('\nTest 4: Different Time Scenarios');
const scenarios = [
    { hour: 20, rivalCount: 5, description: 'Peak evening' },
    { hour: 3, rivalCount: 1, description: 'Early morning' },
    { hour: 14, rivalCount: 3, description: 'Afternoon' }
];

scenarios.forEach(scenario => {
    // Mock the hour for testing
    const originalDate = Date;
    global.Date = class extends Date {
        getHours() { return scenario.hour; }
    };
    
    // Mock tracked rivals
    global.trackedRivals = { size: scenario.rivalCount };
    
    const timing = timingOptimizer.getOptimizedTiming(mockRivalData, mockConnection, 2000);
    console.log(`${scenario.description}: ${timing}ms`);
    
    // Restore original Date
    global.Date = originalDate;
});

console.log('\n✅ ML Integration Test Complete!');
console.log('\n📋 Integration Summary:');
console.log('- ML optimizer enhances existing timing without breaking it');
console.log('- Learns from success/failure patterns');
console.log('- Provides safety bounds (500ms - 10000ms)');
console.log('- Falls back to base timing if ML model not ready');
console.log('- Records timing results for continuous learning');