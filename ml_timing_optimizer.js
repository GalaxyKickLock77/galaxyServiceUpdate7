// ML Timing Optimizer - Random Forest Implementation
// Enhances existing timing without breaking current system

class TimingOptimizer {
    constructor() {
        this.trainingData = [];
        this.model = null;
        this.isTraining = false;
        this.minSamples = 50;
        this.features = ['hour', 'rivalCount', 'connectionLatency', 'channelActivity', 'networkLoad'];
        this.timingHistory = new Map();
        this.successRates = new Map();
        
        // Initialize logging function
        this.log = (typeof appLog !== 'undefined') ? appLog : console.log;
        
        // Load existing data if available
        this.loadHistoricalData();
    }

    // Extract features from current game state
    extractFeatures(rivalData, connection) {
        const now = new Date();
        const hour = now.getHours();
        const rivalCount = (typeof trackedRivals !== 'undefined' && trackedRivals) ? trackedRivals.size : 0;
        const connectionLatency = this.getConnectionLatency(connection);
        const channelActivity = this.getChannelActivity();
        const networkLoad = this.getNetworkLoad();

        return {
            hour,
            rivalCount,
            connectionLatency,
            channelActivity,
            networkLoad,
            rivalName: rivalData.name,
            mode: rivalData.mode
        };
    }

    // Get optimized timing (enhances existing getCurrentTiming)
    getOptimizedTiming(rivalData, connection, baseTiming) {
        try {
            if (!this.model || this.trainingData.length < this.minSamples) {
                // Return base timing with small random optimization
                return baseTiming + this.getQuickOptimization(rivalData);
            }

            const features = this.extractFeatures(rivalData, connection);
            const prediction = this.predict(features);
            
            // Blend ML prediction with base timing (safety first)
            const optimizedTiming = Math.round(baseTiming * 0.7 + prediction * 0.3);
            
            // Safety bounds - never go below 500ms or above 10000ms
            return Math.max(500, Math.min(10000, optimizedTiming));
            
        } catch (err) {
            // Fallback to base timing on any error
            return baseTiming;
        }
    }

    // Quick optimization when ML model isn't ready
    getQuickOptimization(rivalData) {
        const hour = new Date().getHours();
        
        // Peak hours need faster timing
        if (hour >= 18 && hour <= 23) return -100;
        
        // Early morning can be slower
        if (hour >= 2 && hour <= 6) return 200;
        
        // High-priority rivals get faster timing
        if (rivalData.name && rivalData.name.length < 4) return -150;
        
        return 0;
    }

    // Record timing success/failure for learning
    recordTimingResult(rivalData, actualTiming, success, executionTime) {
        const features = this.extractFeatures(rivalData, rivalData.connection);
        
        this.trainingData.push({
            features,
            timing: actualTiming,
            success,
            executionTime,
            timestamp: Date.now()
        });

        // Update success rates
        const key = `${features.hour}_${features.rivalCount}`;
        if (!this.successRates.has(key)) {
            this.successRates.set(key, { total: 0, success: 0 });
        }
        
        const stats = this.successRates.get(key);
        stats.total++;
        if (success) stats.success++;

        // Trigger retraining if we have enough new data
        if (this.trainingData.length % 25 === 0 && this.trainingData.length >= this.minSamples) {
            this.trainModel();
        }

        // Keep data manageable
        if (this.trainingData.length > 1000) {
            this.trainingData = this.trainingData.slice(-800);
        }
    }

    // Simple Random Forest implementation
    trainModel() {
        if (this.isTraining || this.trainingData.length < this.minSamples) return;
        
        this.isTraining = true;
        
        try {
            // Create decision trees (simplified Random Forest)
            this.model = {
                trees: [],
                numTrees: 5
            };

            for (let i = 0; i < this.model.numTrees; i++) {
                const tree = this.buildDecisionTree(this.getBootstrapSample());
                this.model.trees.push(tree);
            }

            this.log(`🤖 ML Model trained with ${this.trainingData.length} samples`);
            
        } catch (err) {
            this.log(`❌ ML Training error: ${err.message}`);
        } finally {
            this.isTraining = false;
        }
    }

    // Bootstrap sampling for Random Forest
    getBootstrapSample() {
        const sample = [];
        const n = this.trainingData.length;
        
        for (let i = 0; i < n; i++) {
            const randomIndex = Math.floor(Math.random() * n);
            sample.push(this.trainingData[randomIndex]);
        }
        
        return sample;
    }

    // Build simple decision tree
    buildDecisionTree(data) {
        if (data.length < 5) {
            return { type: 'leaf', value: this.getAverageTiming(data) };
        }

        const bestSplit = this.findBestSplit(data);
        if (!bestSplit) {
            return { type: 'leaf', value: this.getAverageTiming(data) };
        }

        const leftData = data.filter(d => d.features[bestSplit.feature] <= bestSplit.threshold);
        const rightData = data.filter(d => d.features[bestSplit.feature] > bestSplit.threshold);

        return {
            type: 'node',
            feature: bestSplit.feature,
            threshold: bestSplit.threshold,
            left: this.buildDecisionTree(leftData),
            right: this.buildDecisionTree(rightData)
        };
    }

    // Find best split for decision tree
    findBestSplit(data) {
        let bestSplit = null;
        let bestScore = -Infinity;

        for (const feature of this.features) {
            const values = data.map(d => d.features[feature]).sort((a, b) => a - b);
            
            for (let i = 1; i < values.length; i++) {
                const threshold = (values[i-1] + values[i]) / 2;
                const score = this.calculateSplitScore(data, feature, threshold);
                
                if (score > bestScore) {
                    bestScore = score;
                    bestSplit = { feature, threshold };
                }
            }
        }

        return bestSplit;
    }

    // Calculate split quality score
    calculateSplitScore(data, feature, threshold) {
        const left = data.filter(d => d.features[feature] <= threshold);
        const right = data.filter(d => d.features[feature] > threshold);
        
        if (left.length === 0 || right.length === 0) return -Infinity;
        
        const leftVariance = this.calculateVariance(left.map(d => d.timing));
        const rightVariance = this.calculateVariance(right.map(d => d.timing));
        
        const weightedVariance = (left.length * leftVariance + right.length * rightVariance) / data.length;
        
        return -weightedVariance; // Lower variance is better
    }

    // Predict timing using trained model
    predict(features) {
        if (!this.model || !this.model.trees.length) {
            return 2000; // Default timing
        }

        const predictions = this.model.trees.map(tree => this.predictWithTree(tree, features));
        return predictions.reduce((sum, pred) => sum + pred, 0) / predictions.length;
    }

    // Predict with single decision tree
    predictWithTree(tree, features) {
        if (tree.type === 'leaf') {
            return tree.value;
        }

        if (features[tree.feature] <= tree.threshold) {
            return this.predictWithTree(tree.left, features);
        } else {
            return this.predictWithTree(tree.right, features);
        }
    }

    // Helper functions
    getAverageTiming(data) {
        if (data.length === 0) return 2000;
        const successfulTimings = data.filter(d => d.success).map(d => d.timing);
        if (successfulTimings.length === 0) return 2000;
        return successfulTimings.reduce((sum, t) => sum + t, 0) / successfulTimings.length;
    }

    calculateVariance(values) {
        if (values.length === 0) return 0;
        const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
        return values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    }

    getConnectionLatency(connection) {
        return connection && connection.latency ? connection.latency : 50;
    }

    getChannelActivity() {
        return (typeof trackedRivals !== 'undefined' && trackedRivals) ? Math.min(trackedRivals.size * 10, 100) : 0;
    }

    getNetworkLoad() {
        return Math.random() * 50; // Simplified - could be enhanced with real network metrics
    }

    // Save/load historical data
    saveHistoricalData() {
        try {
            const data = {
                trainingData: this.trainingData.slice(-500), // Keep last 500 samples
                successRates: Array.from(this.successRates.entries())
            };
            // In real implementation, save to file or database
        } catch (err) {
            // Silent fail - not critical
        }
    }

    loadHistoricalData() {
        try {
            // In real implementation, load from file or database
            // For now, start fresh
        } catch (err) {
            // Silent fail - not critical
        }
    }

    // Get optimization stats
    getStats() {
        const totalSamples = this.trainingData.length;
        const recentSuccess = this.trainingData.slice(-50).filter(d => d.success).length;
        const recentTotal = Math.min(50, totalSamples);
        const successRate = recentTotal > 0 ? (recentSuccess / recentTotal * 100).toFixed(1) : 0;

        return {
            totalSamples,
            recentSuccessRate: `${successRate}%`,
            modelTrained: !!this.model,
            isOptimizing: totalSamples >= this.minSamples
        };
    }
}

// Global instance
const timingOptimizer = new TimingOptimizer();

// Export for use in main game code
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TimingOptimizer, timingOptimizer };
}