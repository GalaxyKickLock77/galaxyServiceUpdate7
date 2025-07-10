// Quick startup test for ML integration
console.log('🧪 Testing ML startup integration...');

// Mock the required globals that galaxy_1.js expects
global.trackedRivals = new Map();

// Test loading the ML module
try {
    const { timingOptimizer } = require('./ml_timing_optimizer');
    console.log('✅ ML module loaded successfully');
    
    // Test basic functionality
    const mockConnection = { rcKey: 'RC1', botId: 'test', latency: 50 };
    const mockRival = { name: 'TestRival', mode: 'attack', connection: mockConnection };
    
    const optimizedTiming = timingOptimizer.getOptimizedTiming(mockRival, mockConnection, 2000);
    console.log(`✅ ML optimization test: 2000ms → ${optimizedTiming}ms`);
    
    const stats = timingOptimizer.getStats();
    console.log('✅ ML stats:', stats);
    
    console.log('\n🎉 ML integration ready for galaxy_1.js!');
    
} catch (err) {
    console.error('❌ ML integration failed:', err.message);
    console.log('🔧 Fallback mode will be used');
}