/**
 * Comprehensive Error Handling System
 * Provides error boundaries, fallback strategies, and recovery mechanisms
 */

class ErrorHandler {
    constructor() {
        this.errorCounts = new Map(); // Function -> error count
        this.fallbackStrategies = new Map(); // Function -> fallback function
        this.circuitBreakers = new Map(); // Function -> circuit breaker state
        this.errorHistory = []; // Recent error history
        
        this.config = {
            MAX_ERROR_HISTORY: 100,
            CIRCUIT_BREAKER_THRESHOLD: 5,
            CIRCUIT_BREAKER_TIMEOUT: 30000, // 30 seconds
            FALLBACK_TIMEOUT: 5000 // 5 seconds
        };
        
        this.initializeErrorHandling();
    }
    
    initializeErrorHandling() {
        // Setup global error handlers with recovery
        process.removeAllListeners('uncaughtException');
        process.removeAllListeners('unhandledRejection');
        
        process.on('uncaughtException', (error) => {
            this.handleCriticalError('uncaughtException', error);
        });
        
        process.on('unhandledRejection', (reason, promise) => {
            this.handleCriticalError('unhandledRejection', reason, { promise });
        });
        
        console.log('🛡️ Enhanced Error Handler initialized');
    }
    
    /**
     * Wrap functions with comprehensive error handling
     */
    wrapWithErrorHandling(func, funcName, fallbackStrategy = null) {
        return async (...args) => {
            const circuitBreaker = this.getCircuitBreaker(funcName);
            
            // Check circuit breaker
            if (circuitBreaker.isOpen) {
                if (Date.now() - circuitBreaker.lastFailure > this.config.CIRCUIT_BREAKER_TIMEOUT) {
                    circuitBreaker.isOpen = false;
                    circuitBreaker.failureCount = 0;
                    console.log(`🔄 Circuit breaker reset for ${funcName}`);
                } else {
                    console.warn(`🚨 Circuit breaker OPEN for ${funcName}, using fallback`);
                    return this.executeFallback(funcName, fallbackStrategy, args);
                }
            }
            
            try {
                const result = await Promise.race([
                    func.apply(this, args),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Function timeout')), this.config.FALLBACK_TIMEOUT)
                    )
                ]);
                
                // Reset error count on success
                this.errorCounts.set(funcName, 0);
                circuitBreaker.failureCount = 0;
                
                return result;
                
            } catch (error) {
                this.recordError(funcName, error);
                
                // Update circuit breaker
                circuitBreaker.failureCount++;
                circuitBreaker.lastFailure = Date.now();
                
                if (circuitBreaker.failureCount >= this.config.CIRCUIT_BREAKER_THRESHOLD) {
                    circuitBreaker.isOpen = true;
                    console.warn(`🚨 Circuit breaker OPENED for ${funcName} after ${circuitBreaker.failureCount} failures`);
                }
                
                // Execute fallback strategy
                return this.executeFallback(funcName, fallbackStrategy, args, error);
            }
        };
    }
    
    /**
     * Get or create circuit breaker for function
     */
    getCircuitBreaker(funcName) {
        if (!this.circuitBreakers.has(funcName)) {
            this.circuitBreakers.set(funcName, {
                isOpen: false,
                failureCount: 0,
                lastFailure: 0
            });
        }
        return this.circuitBreakers.get(funcName);
    }
    
    /**
     * Execute fallback strategy
     */
    async executeFallback(funcName, fallbackStrategy, args, originalError = null) {
        try {
            if (fallbackStrategy && typeof fallbackStrategy === 'function') {
                console.log(`🔄 Executing fallback strategy for ${funcName}`);
                return await fallbackStrategy.apply(this, args);
            }
            
            // Default fallback strategies by function type
            return this.getDefaultFallback(funcName, args, originalError);
            
        } catch (fallbackError) {
            console.error(`❌ Fallback failed for ${funcName}:`, fallbackError.message);
            throw fallbackError;
        }
    }
    
    /**
     * Get default fallback strategies
     */
    getDefaultFallback(funcName, args, originalError) {
        switch (funcName) {
            case 'getCurrentTiming':
                // Safe fallback timing
                const mode = args[0] || 'defense';
                const isAttack = mode === 'attack';
                const safeTiming = isAttack ? 1600 : 1700;
                console.log(`🛡️ Using safe fallback timing: ${safeTiming}ms`);
                return safeTiming;
                
            case 'predictOptimalTiming':
                // Conservative AI fallback
                const aiMode = args[3] || 'defense';
                const isAIAttack = aiMode === 'attack';
                const aiSafeTiming = isAIAttack ? 1550 : 1650;
                console.log(`🧠 AI predictor fallback: ${aiSafeTiming}ms`);
                return aiSafeTiming;
                
            case 'createConnection':
                // Return null connection that can be handled upstream
                console.log(`🔗 Connection creation fallback: returning null`);
                return null;
                
            case 'performMemoryCleanup':
                // Silent fallback for memory cleanup
                console.log(`🧹 Memory cleanup fallback: operation skipped`);
                return true;
                
            default:
                // Generic fallback
                if (originalError) {
                    console.warn(`⚠️ Generic fallback for ${funcName}:`, originalError.message);
                }
                return null;
        }
    }
    
    /**
     * Record error for analysis
     */
    recordError(funcName, error) {
        const errorCount = (this.errorCounts.get(funcName) || 0) + 1;
        this.errorCounts.set(funcName, errorCount);
        
        const errorRecord = {
            timestamp: Date.now(),
            funcName,
            message: error.message,
            stack: error.stack,
            count: errorCount
        };
        
        this.errorHistory.push(errorRecord);
        
        // Keep error history manageable
        if (this.errorHistory.length > this.config.MAX_ERROR_HISTORY) {
            this.errorHistory = this.errorHistory.slice(-this.config.MAX_ERROR_HISTORY);
        }
        
        console.error(`❌ Error in ${funcName} (count: ${errorCount}):`, error.message);
        
        // Log stack trace for critical functions
        if (['getCurrentTiming', 'predictOptimalTiming', 'handleRivals'].includes(funcName)) {
            console.error(`Stack trace:`, error.stack);
        }
    }
    
    /**
     * Handle critical system errors
     */
    handleCriticalError(errorType, error, context = {}) {
        console.error(`🚨 CRITICAL ${errorType}:`, error.message || error);
        
        const criticalRecord = {
            timestamp: Date.now(),
            type: errorType,
            message: error.message || String(error),
            stack: error.stack,
            context
        };
        
        this.errorHistory.push(criticalRecord);
        
        try {
            // Attempt recovery strategies
            if (errorType === 'unhandledRejection' && this.isAIError(error)) {
                console.log(`🔄 Attempting AI predictor recovery...`);
                this.recoverAIPredictor();
            }
            
            if (errorType === 'uncaughtException' && this.isConnectionError(error)) {
                console.log(`🔄 Attempting connection recovery...`);
                this.recoverConnections();
            }
            
        } catch (recoveryError) {
            console.error(`❌ Recovery failed:`, recoveryError.message);
        }
        
        // Don't exit the process - attempt to continue
        console.log(`🔄 Continuing operation despite ${errorType}`);
    }
    
    /**
     * Check if error is AI-related
     */
    isAIError(error) {
        const aiKeywords = ['AI', 'predictor', 'model', 'prediction', 'neural', 'ensemble'];
        const message = error.message || String(error);
        return aiKeywords.some(keyword => message.toLowerCase().includes(keyword.toLowerCase()));
    }
    
    /**
     * Check if error is connection-related
     */
    isConnectionError(error) {
        const connKeywords = ['socket', 'connection', 'websocket', 'network', 'timeout', 'ECONNRESET'];
        const message = error.message || String(error);
        return connKeywords.some(keyword => message.toLowerCase().includes(keyword.toLowerCase()));
    }
    
    /**
     * Recover AI predictor
     */
    async recoverAIPredictor() {
        try {
            // Set global aiPredictorEnabled to false temporarily
            global.aiPredictorEnabled = false;
            console.log(`⚠️ AI predictor temporarily disabled for recovery`);
            
            // Re-enable after 30 seconds
            setTimeout(() => {
                global.aiPredictorEnabled = true;
                console.log(`🔄 AI predictor re-enabled after recovery period`);
            }, 30000);
            
        } catch (error) {
            console.error(`❌ AI recovery failed:`, error.message);
        }
    }
    
    /**
     * Recover connections
     */
    async recoverConnections() {
        try {
            console.log(`🔄 Initiating connection recovery...`);
            
            // Force connection cleanup and restart
            if (global.activeConnection) {
                try {
                    await global.activeConnection.cleanup();
                } catch (e) {
                    console.log(`Connection cleanup error (expected):`, e.message);
                }
                global.activeConnection = null;
            }
            
            // Clear connection pool
            if (global.connectionPool && Array.isArray(global.connectionPool)) {
                for (const conn of global.connectionPool) {
                    try {
                        await conn.cleanup();
                    } catch (e) {
                        // Ignore cleanup errors
                    }
                }
                global.connectionPool.length = 0;
            }
            
            console.log(`✅ Connection recovery completed`);
            
        } catch (error) {
            console.error(`❌ Connection recovery failed:`, error.message);
        }
    }
    
    /**
     * Get error statistics
     */
    getErrorStats() {
        const stats = {
            totalErrors: this.errorHistory.length,
            errorsByFunction: {},
            circuitBreakerStatus: {},
            recentErrors: this.errorHistory.slice(-10).map(e => ({
                timestamp: new Date(e.timestamp).toISOString(),
                function: e.funcName || e.type,
                message: e.message
            }))
        };
        
        // Count errors by function
        for (const [funcName, count] of this.errorCounts.entries()) {
            stats.errorsByFunction[funcName] = count;
        }
        
        // Circuit breaker status
        for (const [funcName, breaker] of this.circuitBreakers.entries()) {
            stats.circuitBreakerStatus[funcName] = {
                isOpen: breaker.isOpen,
                failureCount: breaker.failureCount,
                lastFailure: breaker.lastFailure ? new Date(breaker.lastFailure).toISOString() : null
            };
        }
        
        return stats;
    }
    
    /**
     * Register a custom fallback strategy
     */
    registerFallback(funcName, fallbackFunction) {
        this.fallbackStrategies.set(funcName, fallbackFunction);
        console.log(`🛡️ Registered custom fallback for ${funcName}`);
    }
    
    /**
     * Clear error history and reset counters
     */
    reset() {
        this.errorCounts.clear();
        this.errorHistory = [];
        this.circuitBreakers.clear();
        console.log(`🔄 Error handler reset completed`);
    }
    
    /**
     * Shutdown cleanup
     */
    shutdown() {
        // Log final error summary
        const stats = this.getErrorStats();
        if (stats.totalErrors > 0) {
            console.log(`📊 Final error summary:`, {
                total: stats.totalErrors,
                byFunction: stats.errorsByFunction
            });
        }
        
        console.log(`🛡️ Error Handler shutdown completed`);
    }
}

module.exports = ErrorHandler;
