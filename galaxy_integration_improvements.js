/**
 * Galaxy Service Integration Improvements
 * Comprehensive integration of memory management, error handling, and enhanced AI predictor
 */

const MemoryManager = require('./memory_manager');
const ErrorHandler = require('./error_handler');
const ImprovedSmartAdaptiveTimingPredictor = require('./improved_ai_predictor');
const { performance } = require('perf_hooks');

class GalaxyServiceImprovement {
    constructor() {
        // Initialize core systems
        this.memoryManager = new MemoryManager();
        this.errorHandler = new ErrorHandler();
        this.improvedAIPredictor = new ImprovedSmartAdaptiveTimingPredictor();
        
        // Performance monitoring
        this.performanceMetrics = {
            memoryUsage: new Map(),
            functionTiming: new Map(),
            errorCounts: new Map(),
            lastReport: Date.now()
        };
        
        // Race condition prevention
        this.mutexLocks = new Map();
        this.batchOperations = {
            rivalProcessing: {
                queue: [],
                processing: false,
                batchSize: 10,
                timeout: null
            }
        };
        
        // Resource tracking for cleanup
        this.resources = {
            intervals: new Set(),
            timeouts: new Set(),
            connections: new Set(),
            streams: new Set()
        };
        
        // Configuration validation
        this.configValidator = new ConfigValidator();
        
        console.log('🚀 Galaxy Service Improvement System initialized');
    }
    
    /**
     * Initialize and integrate all systems
     */
    async initialize(galaxyServiceRef) {
        try {
            this.galaxyService = galaxyServiceRef;
            
            // Connect memory manager to actual global maps
            this.connectMemoryManager();
            
            // Wrap critical functions with error handling
            this.wrapCriticalFunctions();
            
            // Start performance monitoring
            this.startPerformanceMonitoring();
            
            // Initialize configuration validation
            await this.initializeConfigValidation();
            
            console.log('✅ Galaxy Service Integration completed successfully');
            
        } catch (error) {
            console.error('❌ Integration initialization failed:', error.message);
            throw error;
        }
    }
    
    /**
     * Connect memory manager to actual global maps
     */
    connectMemoryManager() {
        // Override the getGlobalMaps method to return actual references
        const originalGetGlobalMaps = this.memoryManager.getGlobalMaps;
        this.memoryManager.getGlobalMaps = () => {
            // These would be the actual global variables from galaxy_1.js
            return {
                rivalActivityProfiles: global.rivalActivityProfiles || new Map(),
                trackedRivals: global.trackedRivals || new Map(),
                userMap: global.userMap || new Map(),
                detectionCache: global.detectionCache || new Map()
            };
        };
        
        // Provide safe wrapper functions for adding to maps
        this.safeAddToRivalActivityProfiles = (key, value) => {
            return this.memoryManager.safeAddToMap(
                global.rivalActivityProfiles, 
                key, 
                value, 
                'rivalActivityProfiles'
            );
        };
        
        this.safeAddToTrackedRivals = (key, value) => {
            return this.memoryManager.safeAddToMap(
                global.trackedRivals, 
                key, 
                value, 
                'trackedRivals'
            );
        };
        
        console.log('🔗 Memory manager connected to global maps');
    }
    
    /**
     * Wrap critical functions with comprehensive error handling
     */
    wrapCriticalFunctions() {
        // Create fallback strategies
        const fallbackStrategies = {
            getCurrentTiming: (mode, connection, rivalId, rivalName, loginTime) => {
                const isAttack = mode === 'attack';
                const safeTiming = isAttack ? 1600 : 1700;
                console.log(`🛡️ getCurrentTiming fallback: ${safeTiming}ms`);
                return safeTiming;
            },
            
            handleRivals: (rivals, mode, connection) => {
                console.log(`🛡️ handleRivals fallback: Skipping rival processing due to error`);
                return Promise.resolve();
            },
            
            createConnection: () => {
                console.log(`🛡️ createConnection fallback: Returning null connection`);
                return null;
            }
        };
        
        // Register fallback strategies
        Object.entries(fallbackStrategies).forEach(([funcName, fallback]) => {
            this.errorHandler.registerFallback(funcName, fallback);
        });
        
        // Wrap functions if they exist globally
        if (typeof global.getCurrentTiming === 'function') {
            global.getCurrentTiming = this.errorHandler.wrapWithErrorHandling(
                global.getCurrentTiming,
                'getCurrentTiming',
                fallbackStrategies.getCurrentTiming
            );
        }
        
        if (typeof global.handleRivals === 'function') {
            global.handleRivals = this.errorHandler.wrapWithErrorHandling(
                global.handleRivals,
                'handleRivals',
                fallbackStrategies.handleRivals
            );
        }
        
        console.log('🛡️ Critical functions wrapped with error handling');
    }
    
    /**
     * Start comprehensive performance monitoring
     */
    startPerformanceMonitoring() {
        const monitoringInterval = setInterval(() => {
            this.collectPerformanceMetrics();
        }, 30000); // Every 30 seconds
        
        this.resources.intervals.add(monitoringInterval);
        
        // Memory reporting interval
        const memoryReportInterval = setInterval(() => {
            this.reportMemoryUsage();
        }, 60000); // Every minute
        
        this.resources.intervals.add(memoryReportInterval);
        
        console.log('📊 Performance monitoring started');
    }
    
    /**
     * Collect comprehensive performance metrics
     */
    collectPerformanceMetrics() {
        try {
            // Memory usage from memory manager
            const memoryUsage = this.memoryManager.getMemoryUsage();
            this.performanceMetrics.memoryUsage.set(Date.now(), memoryUsage);
            
            // Error statistics from error handler
            const errorStats = this.errorHandler.getErrorStats();
            this.performanceMetrics.errorCounts.set(Date.now(), errorStats);
            
            // AI predictor performance
            if (this.improvedAIPredictor.initialized) {
                const aiStats = this.improvedAIPredictor.getPerformanceSummary();
                this.performanceMetrics.aiPerformance = aiStats;
            }
            
            // Node.js memory usage
            const nodeMemory = process.memoryUsage();
            this.performanceMetrics.nodeMemory = {
                rss: Math.round(nodeMemory.rss / 1024 / 1024), // MB
                heapUsed: Math.round(nodeMemory.heapUsed / 1024 / 1024), // MB
                heapTotal: Math.round(nodeMemory.heapTotal / 1024 / 1024), // MB
                external: Math.round(nodeMemory.external / 1024 / 1024) // MB
            };
            
        } catch (error) {
            console.error('❌ Performance metrics collection error:', error.message);
        }
    }
    
    /**
     * Report memory usage if concerning
     */
    reportMemoryUsage() {
        try {
            const memoryUsage = this.memoryManager.getMemoryUsage();
            let alertNeeded = false;
            
            for (const [mapName, usage] of Object.entries(memoryUsage)) {
                const percentage = parseFloat(usage.percentage);
                if (percentage > 80) {
                    console.warn(`🚨 Memory alert: ${mapName} at ${usage.percentage} (${usage.current}/${usage.max})`);
                    alertNeeded = true;
                }
            }
            
            // Node.js memory alert
            const nodeMemory = this.performanceMetrics.nodeMemory;
            if (nodeMemory && nodeMemory.heapUsed > 200) { // 200MB threshold
                console.warn(`🚨 Node.js heap usage: ${nodeMemory.heapUsed}MB`);
                alertNeeded = true;
            }
            
            if (!alertNeeded && Date.now() - this.performanceMetrics.lastReport > 600000) { // 10 minutes
                console.log(`💚 System healthy - Memory usage normal`);
                this.performanceMetrics.lastReport = Date.now();
            }
            
        } catch (error) {
            console.error('❌ Memory reporting error:', error.message);
        }
    }
    
    /**
     * Mutex-protected batch processing to prevent race conditions
     */
    async processRivalsBatch(rivals, mode, connection) {
        const batchOp = this.batchOperations.rivalProcessing;
        
        // Add to queue
        batchOp.queue.push(...rivals.map(rival => ({ rival, mode, connection })));
        
        // Process if not already processing
        if (!batchOp.processing && batchOp.queue.length > 0) {
            batchOp.processing = true;
            
            try {
                while (batchOp.queue.length > 0) {
                    const batch = batchOp.queue.splice(0, batchOp.batchSize);
                    await this.processSingleBatch(batch);
                    
                    // Small delay between batches to prevent overwhelming
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
            } catch (error) {
                console.error('❌ Batch processing error:', error.message);
            } finally {
                batchOp.processing = false;
            }
        }
    }
    
    /**
     * Process a single batch of rivals with mutex protection
     */
    async processSingleBatch(batch) {
        const mutexId = 'rivalBatchProcessing';
        
        // Acquire mutex
        if (this.mutexLocks.has(mutexId)) {
            console.warn('⚠️ Mutex lock conflict detected, skipping batch');
            return;
        }
        
        this.mutexLocks.set(mutexId, Date.now());
        
        try {
            for (const { rival, mode, connection } of batch) {
                await this.processSingleRival(rival, mode, connection);
            }
        } catch (error) {
            console.error('❌ Single batch processing error:', error.message);
        } finally {
            this.mutexLocks.delete(mutexId);
        }
    }
    
    /**
     * Process a single rival with enhanced safety
     */
    async processSingleRival(rival, mode, connection) {
        try {
            // Use memory-safe rival tracking
            const rivalData = {
                name: rival.name,
                loginTime: Date.now(),
                mode: mode,
                connection: connection,
                coordinate: rival.coordinate,
                kickTimeout: null,
                presenceCheckTimeout: null
            };
            
            // Safe add to tracked rivals
            const added = this.safeAddToTrackedRivals(rival.id, rivalData);
            
            if (added) {
                // Use improved AI predictor
                const timing = await this.improvedAIPredictor.predictOptimalTiming(
                    rival.id,
                    rival.name,
                    rivalData.loginTime,
                    mode,
                    {
                        sessionDuration: 0,
                        activityLevel: 0.7,
                        networkLatency: connection.lastPingTime || 50
                    }
                );
                
                // Schedule rival kick with enhanced timing
                this.scheduleEnhancedRivalKick(rival.id, rivalData, timing);
                
                console.log(`✅ Processed rival: ${rival.name} with ${timing}ms timing`);
            } else {
                console.warn(`⚠️ Failed to track rival ${rival.name} - memory limit reached`);
            }
            
        } catch (error) {
            console.error(`❌ Error processing rival ${rival.name}:`, error.message);
        }
    }
    
    /**
     * Enhanced rival kick scheduling with performance tracking
     */
    scheduleEnhancedRivalKick(rivalId, rivalData, timing) {
        const startTime = performance.now();
        
        const kickTimeout = setTimeout(() => {
            this.executeEnhancedRivalKick(rivalId, rivalData, startTime);
        }, timing);
        
        this.resources.timeouts.add(kickTimeout);
        rivalData.kickTimeout = kickTimeout;
    }
    
    /**
     * Execute rival kick with performance metrics
     */
    executeEnhancedRivalKick(rivalId, rivalData, scheduleStartTime) {
        try {
            const executionTime = performance.now();
            const timingAccuracy = executionTime - scheduleStartTime - (rivalData.predictedTiming || 1500);
            
            // Record timing accuracy for AI improvement
            if (Math.abs(timingAccuracy) < 50) { // Within 50ms = good
                console.log(`🎯 Accurate timing for ${rivalData.name}: ${timingAccuracy.toFixed(1)}ms drift`);
            } else {
                console.warn(`⚠️ Timing drift for ${rivalData.name}: ${timingAccuracy.toFixed(1)}ms`);
            }
            
            // Execute the actual rival action
            if (typeof global.handleRivals === 'function') {
                global.handleRivals([{
                    name: rivalData.name,
                    id: rivalId,
                    coordinate: rivalData.coordinate
                }], rivalData.mode, rivalData.connection);
            }
            
        } catch (error) {
            console.error(`❌ Enhanced rival kick error for ${rivalData.name}:`, error.message);
        } finally {
            // Clean up timeout reference
            if (rivalData.kickTimeout) {
                this.resources.timeouts.delete(rivalData.kickTimeout);
            }
        }
    }
    
    /**
     * Initialize configuration validation system
     */
    async initializeConfigValidation() {
        try {
            await this.configValidator.initialize();
            
            // Validate current config if available
            if (global.config) {
                const validationResult = this.configValidator.validateConfig(global.config);
                if (!validationResult.isValid) {
                    console.warn('⚠️ Configuration validation warnings:', validationResult.warnings);
                }
            }
            
            console.log('🔧 Configuration validation initialized');
            
        } catch (error) {
            console.error('❌ Configuration validation initialization failed:', error.message);
        }
    }
    
    /**
     * Enhanced graceful shutdown with comprehensive cleanup
     */
    async enhancedShutdown(signal = 'SIGTERM') {
        console.log(`🔄 Starting enhanced graceful shutdown (${signal})...`);
        
        const shutdownTasks = [];
        
        try {
            // 1. Stop all intervals
            for (const interval of this.resources.intervals) {
                clearInterval(interval);
            }
            this.resources.intervals.clear();
            
            // 2. Clear all timeouts
            for (const timeout of this.resources.timeouts) {
                clearTimeout(timeout);
            }
            this.resources.timeouts.clear();
            
            // 3. Shutdown AI predictor with data saving
            shutdownTasks.push(
                this.improvedAIPredictor.shutdown().catch(err => 
                    console.error('AI predictor shutdown error:', err.message)
                )
            );
            
            // 4. Final memory cleanup
            shutdownTasks.push(
                Promise.resolve().then(() => {
                    this.memoryManager.shutdown();
                }).catch(err => 
                    console.error('Memory manager shutdown error:', err.message)
                )
            );
            
            // 5. Error handler final report
            shutdownTasks.push(
                Promise.resolve().then(() => {
                    this.errorHandler.shutdown();
                }).catch(err => 
                    console.error('Error handler shutdown error:', err.message)
                )
            );
            
            // 6. Close any remaining connections
            for (const connection of this.resources.connections) {
                try {
                    if (connection && typeof connection.cleanup === 'function') {
                        await connection.cleanup();
                    }
                } catch (err) {
                    console.warn('Connection cleanup error:', err.message);
                }
            }
            this.resources.connections.clear();
            
            // Wait for all shutdown tasks with timeout
            const shutdownPromise = Promise.allSettled(shutdownTasks);
            const timeoutPromise = new Promise(resolve => setTimeout(resolve, 15000)); // 15 second timeout
            
            await Promise.race([shutdownPromise, timeoutPromise]);
            
            console.log('✅ Enhanced graceful shutdown completed successfully');
            
        } catch (error) {
            console.error('❌ Error during enhanced shutdown:', error.message);
        } finally {
            // Force exit after a reasonable delay
            setTimeout(() => {
                console.log('🏁 Force exit after shutdown completion');
                process.exit(0);
            }, 1000);
        }
    }
    
    /**
     * Get comprehensive system status
     */
    getSystemStatus() {
        try {
            return {
                timestamp: new Date().toISOString(),
                memoryManager: {
                    status: 'active',
                    usage: this.memoryManager.getMemoryUsage()
                },
                errorHandler: {
                    status: 'active',
                    stats: this.errorHandler.getErrorStats()
                },
                aiPredictor: {
                    status: this.improvedAIPredictor.initialized ? 'active' : 'inactive',
                    summary: this.improvedAIPredictor.getPerformanceSummary()
                },
                resources: {
                    intervals: this.resources.intervals.size,
                    timeouts: this.resources.timeouts.size,
                    connections: this.resources.connections.size
                },
                performance: {
                    nodeMemory: this.performanceMetrics.nodeMemory,
                    lastReport: new Date(this.performanceMetrics.lastReport).toISOString()
                }
            };
        } catch (error) {
            return {
                error: error.message,
                timestamp: new Date().toISOString()
            };
        }
    }
}

/**
 * Configuration Validation System
 */
class ConfigValidator {
    constructor() {
        this.validationRules = new Map();
        this.initialized = false;
    }
    
    async initialize() {
        // Define validation rules
        this.validationRules.set('RC1', {
            required: true,
            type: 'string',
            minLength: 10,
            description: 'Primary recovery code'
        });
        
        this.validationRules.set('RC2', {
            required: true,
            type: 'string',
            minLength: 10,
            description: 'Secondary recovery code'
        });
        
        this.validationRules.set('RC1_startAttackTime', {
            required: true,
            type: 'number',
            min: 1000,
            max: 2000,
            description: 'RC1 attack timing'
        });
        
        this.validationRules.set('RC1_startDefenceTime', {
            required: true,
            type: 'number',
            min: 1000,
            max: 2000,
            description: 'RC1 defense timing'
        });
        
        this.validationRules.set('planetName', {
            required: true,
            type: 'string',
            minLength: 1,
            description: 'Target planet name'
        });
        
        this.initialized = true;
        console.log('🔧 Configuration validation rules loaded');
    }
    
    validateConfig(config) {
        const result = {
            isValid: true,
            errors: [],
            warnings: []
        };
        
        try {
            for (const [key, rule] of this.validationRules.entries()) {
                const value = config[key] || config[key + '1']; // Handle suffixed keys
                
                if (rule.required && (value === undefined || value === null)) {
                    result.errors.push(`Missing required config: ${key}`);
                    result.isValid = false;
                    continue;
                }
                
                if (value !== undefined) {
                    if (rule.type === 'number') {
                        const numValue = parseInt(value);
                        if (isNaN(numValue)) {
                            result.errors.push(`${key} must be a number, got: ${typeof value}`);
                            result.isValid = false;
                        } else if (rule.min && numValue < rule.min) {
                            result.warnings.push(`${key} (${numValue}) below recommended minimum: ${rule.min}`);
                        } else if (rule.max && numValue > rule.max) {
                            result.warnings.push(`${key} (${numValue}) above recommended maximum: ${rule.max}`);
                        }
                    }
                    
                    if (rule.type === 'string') {
                        if (typeof value !== 'string') {
                            result.errors.push(`${key} must be a string, got: ${typeof value}`);
                            result.isValid = false;
                        } else if (rule.minLength && value.length < rule.minLength) {
                            result.warnings.push(`${key} length (${value.length}) below recommended minimum: ${rule.minLength}`);
                        }
                    }
                }
            }
            
        } catch (error) {
            result.errors.push(`Validation error: ${error.message}`);
            result.isValid = false;
        }
        
        return result;
    }
}

module.exports = GalaxyServiceImprovement;
