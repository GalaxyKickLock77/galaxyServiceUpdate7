// Smart Adaptive AI Timing Predictor - Fast Learning & Unpredictable
// Fixes: Fast leaving rivals, slow learning, predictable patterns

class SmartAdaptiveAITimingPredictor {
    constructor() {
        this.isEnabled = false;
        this.rivalData = new Map();
        this.globalStats = {
            totalPredictions: 0,
            successfulKicks: 0,
            threeSecondErrors: 0,
            averageSuccessfulTiming: 1500,
            timingDistribution: new Map(),
            competitivePressure: 0 // How predictable we've become
        };
        
        // Rapid learning parameters
        this.RAPID_LEARNING = {
            minDataPoints: 2,        // Reduced from 5+ for faster decisions
            quickLearnWeight: 3.0,   // Higher weight for recent data
            newRivalBoost: 2.0,      // Boost learning for new rivals
            patternMatchThreshold: 0.7 // Similarity threshold for pattern matching
        };
        
        // Departure detection parameters
        this.DEPARTURE_DETECTION = {
            quickDepartureThreshold: 45000,  // 45s sessions = quick
            departureWarningTime: 30000,     // Start watching after 30s
            preemptiveKickWindow: 5000,      // 5s window for preemptive kicks
            aggressiveThreshold: 0.6         // 60% quick departure rate = aggressive
        };
        
        // Unpredictability parameters
        this.STEALTH_MODE = {
            randomnessLevel: 0.1,      // 10% randomness by default
            maxRandomOffset: 100,      // Max ±100ms random offset
            patternBreakInterval: 5,   // Break pattern every 5 kicks
            adaptiveRandomness: true   // Increase randomness under pressure
        };
        
        this.SAFE_WINDOW = { min: 1200, max: 2000 };
        this.kickCounter = 0; // Track kicks for pattern breaking
        
        this.log('🧠 Smart Adaptive AI Timing Predictor initialized');
    }

    log(message) {
        console.log(message);
    }

    setEnabled(enabled) {
        this.isEnabled = enabled;
        this.log(`🎯 Smart Adaptive AI ${enabled ? 'ENABLED' : 'DISABLED'}`);
    }

    // Enhanced rival login with rapid pattern detection
    recordRivalLogin(rivalName, timestamp) {
        const data = this.getRivalData(rivalName);
        
        // Calculate session gap and detect patterns quickly
        let sessionGap = null;
        if (data.lastLogout) {
            sessionGap = timestamp - data.lastLogout;
            
            // Rapid pattern detection - learn from just 2-3 sessions
            if (data.sessions.length >= 1) {
                this.updateRapidBehaviorProfile(data, sessionGap);
            }
        }
        
        // Start new session with enhanced tracking
        data.currentSession = {
            loginTime: timestamp,
            sessionGap: sessionGap,
            kickAttempts: [],
            behaviorPattern: this.rapidBehaviorAnalysis(data, timestamp),
            departureRisk: this.calculateDepartureRisk(data, timestamp)
        };
        
        // Set departure monitoring
        if (data.currentSession.departureRisk > 0.5) {
            this.scheduleDepartureMonitoring(rivalName, timestamp);
        }
        
        this.log(`👋 Login: ${rivalName} (gap: ${sessionGap ? Math.round(sessionGap/1000) + 's' : 'first'}, risk: ${Math.round(data.currentSession.departureRisk * 100)}%)`);
    }

    // Update rapid behavior profile for faster learning
    updateRapidBehaviorProfile(data, sessionGap) {
        if (!sessionGap) return; // Skip if no session gap
        
        if (!data.rapidProfile) {
            data.rapidProfile = {
                sessionGaps: [sessionGap],
                avgSessionGap: sessionGap,
                sessionCount: 1,
                lastUpdate: Date.now()
            };
        } else {
            if (!data.rapidProfile.sessionGaps) {
                data.rapidProfile.sessionGaps = [];
            }
            data.rapidProfile.sessionGaps.push(sessionGap);
            if (data.rapidProfile.sessionGaps.length > 5) {
                data.rapidProfile.sessionGaps = data.rapidProfile.sessionGaps.slice(-5);
            }
            data.rapidProfile.avgSessionGap = 
                data.rapidProfile.sessionGaps.reduce((sum, gap) => sum + gap, 0) / data.rapidProfile.sessionGaps.length;
            data.rapidProfile.sessionCount++;
            data.rapidProfile.lastUpdate = Date.now();
        }
    }

    // Enhanced rival logout with departure pattern learning
    recordRivalLogout(rivalName, timestamp) {
        const data = this.getRivalData(rivalName);
        data.lastLogout = timestamp;
        
        if (data.currentSession) {
            const sessionDuration = timestamp - data.currentSession.loginTime;
            data.currentSession.duration = sessionDuration;
            data.currentSession.logoutTime = timestamp;
            
            // Rapid learning from session patterns
            this.rapidSessionLearning(data, sessionDuration);
            
            // Store completed session (keep more recent data)
            data.sessions.push({ ...data.currentSession });
            if (data.sessions.length > 15) { // Reduced from 20 for faster processing
                data.sessions = data.sessions.slice(-15);
            }
            
            data.currentSession = null;
            
            this.log(`👋 Logout: ${rivalName} (session: ${Math.round(sessionDuration/1000)}s)`);
        }
    }

    // Rapid behavior analysis with minimal data
    rapidBehaviorAnalysis(data, currentTime) {
        if (data.sessions.length === 0) {
            return { type: 'new', confidence: 0.8, learningMode: 'rapid' }; // High confidence for rapid learning
        }
        
        // Use just last 3 sessions for rapid analysis
        const recentSessions = data.sessions.slice(-3);
        const avgSessionDuration = recentSessions.reduce((sum, s) => sum + (s.duration || 0), 0) / recentSessions.length;
        
        // Quick classification with higher confidence
        let behaviorType = 'normal';
        let confidence = Math.min(recentSessions.length / 2, 1); // Faster confidence building
        
        if (avgSessionDuration < this.DEPARTURE_DETECTION.quickDepartureThreshold) {
            behaviorType = 'quick_departure';
            confidence += 0.3; // Boost confidence for departure detection
        } else if (avgSessionDuration > 300000) {
            behaviorType = 'patient';
        }
        
        return {
            type: behaviorType,
            avgSessionDuration,
            confidence: Math.min(confidence, 1),
            learningMode: recentSessions.length < 3 ? 'rapid' : 'normal'
        };
    }

    // Calculate departure risk for preemptive actions
    calculateDepartureRisk(data, currentTime) {
        if (data.sessions.length < 2) return 0.3; // Default moderate risk for new rivals
        
        const recentSessions = data.sessions.slice(-5);
        const quickDepartures = recentSessions.filter(s => s.duration < this.DEPARTURE_DETECTION.quickDepartureThreshold).length;
        const departureRate = quickDepartures / recentSessions.length;
        
        // Additional risk factors
        let riskMultiplier = 1.0;
        
        // Time-based risk (some rivals leave at specific times)
        const hour = new Date(currentTime).getHours();
        if (hour >= 22 || hour <= 6) riskMultiplier += 0.2; // Late night/early morning
        
        // Session gap risk (quick returns often mean quick departures)
        if (data.currentSession && data.currentSession.sessionGap < 60000) {
            riskMultiplier += 0.3; // Quick return = higher departure risk
        }
        
        return Math.min(departureRate * riskMultiplier, 1.0);
    }

    // Schedule departure monitoring for fast leaving rivals
    scheduleDepartureMonitoring(rivalName, loginTime) {
        // This would integrate with the main bot to monitor for departure signs
        // For now, we'll track it in the data structure
        const data = this.getRivalData(rivalName);
        data.departureMonitoring = {
            startTime: loginTime,
            warningTime: loginTime + this.DEPARTURE_DETECTION.departureWarningTime,
            active: true
        };
        
        this.log(`⚠️ Departure monitoring: ${rivalName} (high risk)`);
    }

    // Rapid session learning - learn from every session
    rapidSessionLearning(data, sessionDuration) {
        // Update behavior profile immediately
        if (!data.rapidProfile) {
            data.rapidProfile = {
                avgSessionDuration: sessionDuration,
                sessionCount: 1,
                departurePattern: sessionDuration < this.DEPARTURE_DETECTION.quickDepartureThreshold ? 'quick' : 'normal'
            };
        } else {
            // Weighted average with higher weight for recent sessions
            const weight = this.RAPID_LEARNING.quickLearnWeight;
            data.rapidProfile.avgSessionDuration = 
                (data.rapidProfile.avgSessionDuration * data.rapidProfile.sessionCount + sessionDuration * weight) / 
                (data.rapidProfile.sessionCount + weight);
            data.rapidProfile.sessionCount++;
            
            // Update departure pattern
            if (sessionDuration < this.DEPARTURE_DETECTION.quickDepartureThreshold) {
                data.rapidProfile.departurePattern = 'quick';
            }
        }
    }

    // Enhanced prediction with rapid learning and unpredictability
    async predictOptimalTiming(rivalData, connection, manualTiming) {
        if (!this.isEnabled || !rivalData) {
            return manualTiming || 1500;
        }

        const rivalName = rivalData.name;
        const data = this.getRivalData(rivalName);
        
        // Rapid base prediction (needs less data)
        let prediction = this.rapidBasePrediction(data, rivalName);
        
        // Apply rapid behavioral adjustments
        prediction = this.applyRapidBehavioralAdjustments(prediction, data);
        
        // Apply competitive learning with faster adaptation
        prediction = this.applyRapidCompetitiveLearning(prediction, data);
        
        // Apply departure urgency adjustments
        prediction = this.applyDepartureUrgency(prediction, data);
        
        // Apply smart unpredictability
        prediction = this.applySmartRandomness(prediction, data, rivalName);
        
        // Apply safety constraints
        prediction = this.applySafetyConstraints(prediction, manualTiming, rivalName);
        
        // Calculate confidence with rapid learning
        const confidence = this.calculateRapidConfidence(data);
        
        this.kickCounter++;
        this.updateCompetitivePressure(rivalName);
        
        this.log(`🎯 Smart AI: ${rivalName} -> ${prediction}ms (conf: ${Math.round(confidence * 100)}%, kick: ${this.kickCounter})`);
        
        return prediction;
    }

    // Rapid base prediction - learns faster with less data
    rapidBasePrediction(data, rivalName) {
        const successfulKicks = data.kickResults.filter(r => r.success && !r.has3sError);
        
        if (successfulKicks.length === 0) {
            // Use pattern matching from similar rivals for faster learning
            const similarRival = this.findSimilarRival(data, rivalName);
            if (similarRival) {
                this.log(`🔍 Pattern match: Using ${similarRival.name} pattern for ${rivalName}`);
                return similarRival.avgSuccessfulTiming;
            }
            return this.globalStats.averageSuccessfulTiming;
        }
        
        // Rapid weighted average with higher weight for recent successes
        let weightedSum = 0;
        let totalWeight = 0;
        const now = Date.now();
        
        successfulKicks.forEach((kick, index) => {
            // Higher recency weight and position weight for rapid learning
            const recency = Math.max(0.3, 1 - (now - kick.timestamp) / (3 * 60 * 60 * 1000)); // 3 hours decay
            const position = (index + 1) / successfulKicks.length; // Later kicks more important
            const weight = recency * position * this.RAPID_LEARNING.quickLearnWeight;
            
            weightedSum += kick.timing * weight;
            totalWeight += weight;
        });
        
        return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : this.globalStats.averageSuccessfulTiming;
    }

    // Find similar rival patterns for rapid learning
    findSimilarRival(targetData, targetName) {
        let bestMatch = null;
        let bestSimilarity = 0;
        
        for (const [rivalName, rivalData] of this.rivalData.entries()) {
            if (rivalName === targetName || rivalData.kickResults.length < 3) continue;
            
            const similarity = this.calculateRivalSimilarity(targetData, rivalData);
            if (similarity > bestSimilarity && similarity > this.RAPID_LEARNING.patternMatchThreshold) {
                bestSimilarity = similarity;
                const successfulKicks = rivalData.kickResults.filter(r => r.success && !r.has3sError);
                if (successfulKicks.length > 0) {
                    bestMatch = {
                        name: rivalName,
                        avgSuccessfulTiming: successfulKicks.reduce((sum, k) => sum + k.timing, 0) / successfulKicks.length,
                        similarity: similarity
                    };
                }
            }
        }
        
        return bestMatch;
    }

    // Calculate similarity between rivals for pattern matching
    calculateRivalSimilarity(data1, data2) {
        let similarity = 0;
        let factors = 0;
        
        // Session duration similarity
        if (data1.rapidProfile && data2.rapidProfile) {
            const durationDiff = Math.abs(data1.rapidProfile.avgSessionDuration - data2.rapidProfile.avgSessionDuration);
            const maxDuration = Math.max(data1.rapidProfile.avgSessionDuration, data2.rapidProfile.avgSessionDuration);
            similarity += (1 - durationDiff / maxDuration);
            factors++;
        }
        
        // Departure pattern similarity
        if (data1.rapidProfile && data2.rapidProfile) {
            if (data1.rapidProfile.departurePattern === data2.rapidProfile.departurePattern) {
                similarity += 1;
            }
            factors++;
        }
        
        return factors > 0 ? similarity / factors : 0;
    }

    // Apply rapid behavioral adjustments
    applyRapidBehavioralAdjustments(prediction, data) {
        if (!data.currentSession) return prediction;
        
        const sessionAge = Date.now() - data.currentSession.loginTime;
        const pattern = data.currentSession.behaviorPattern;
        
        // Rapid adjustment based on behavior type
        if (pattern.type === 'quick_departure' && pattern.confidence > 0.5) {
            // Be more aggressive with quick departure rivals
            const urgencyAdjustment = -Math.min(200, sessionAge / 1000); // Up to -200ms based on session age
            this.log(`⚡ Quick departure adj: ${Math.round(urgencyAdjustment)}ms`);
            return prediction + urgencyAdjustment;
        }
        
        // Alertness-based adjustment (faster calculation)
        if (data.rapidProfile && data.rapidProfile.avgSessionDuration > 0) {
            const expectedAlertness = this.calculateRapidAlertness(sessionAge, data.rapidProfile.avgSessionDuration);
            const adjustment = (1 - expectedAlertness) * 150; // Reduced max adjustment for faster response
            
            if (adjustment > 10) { // Only log significant adjustments
                this.log(`🧠 Rapid behavioral adj: +${Math.round(adjustment)}ms (alertness: ${Math.round(expectedAlertness * 100)}%)`);
            }
            return prediction + adjustment;
        }
        
        return prediction;
    }

    // Calculate alertness with rapid assessment
    calculateRapidAlertness(sessionAge, avgSessionDuration) {
        const sessionProgress = sessionAge / avgSessionDuration;
        
        // Simplified alertness model for faster calculation
        if (sessionProgress < 0.1) return 0.95; // Very alert at start
        if (sessionProgress > 0.8) return 0.85; // Alert near expected end
        if (sessionProgress > 0.2 && sessionProgress < 0.6) return 0.3; // Less alert in middle
        
        return 0.6; // Default alertness
    }

    // Apply rapid competitive learning
    applyRapidCompetitiveLearning(prediction, data) {
        // Look at recent competitive data (last hour instead of 2 hours)
        const recentCompetitive = data.kickResults.filter(r => 
            r.timestamp > Date.now() - (60 * 60 * 1000) && // Last hour only
            (r.reason === 'rival_faster' || r.isRivalKick)
        );
        
        if (recentCompetitive.length === 0) return prediction;
        
        // Rapid competitive analysis
        const rivalSpeeds = recentCompetitive
            .filter(r => r.rivalTiming)
            .map(r => r.rivalTiming);
        
        if (rivalSpeeds.length > 0) {
            const avgRivalSpeed = rivalSpeeds.reduce((sum, speed) => sum + speed, 0) / rivalSpeeds.length;
            // More aggressive competitive adjustment
            const competitiveAdjustment = Math.max(-400, avgRivalSpeed - prediction - 150); // Be 150ms faster than rival
            
            if (competitiveAdjustment < -10) {
                this.log(`⚔️ Rapid competitive adj: ${Math.round(competitiveAdjustment)}ms (rival avg: ${Math.round(avgRivalSpeed)}ms)`);
            }
            return prediction + competitiveAdjustment;
        }
        
        return prediction;
    }

    // Apply departure urgency for fast leaving rivals
    applyDepartureUrgency(prediction, data) {
        if (!data.currentSession || !data.departureMonitoring) return prediction;
        
        const sessionAge = Date.now() - data.currentSession.loginTime;
        const departureRisk = data.currentSession.departureRisk;
        
        // If high departure risk and approaching warning time
        if (departureRisk > this.DEPARTURE_DETECTION.aggressiveThreshold && 
            sessionAge > this.DEPARTURE_DETECTION.departureWarningTime * 0.7) {
            
            const urgencyAdjustment = -Math.min(300, departureRisk * 400); // Up to -300ms for high risk
            this.log(`🚨 Departure urgency: ${Math.round(urgencyAdjustment)}ms (risk: ${Math.round(departureRisk * 100)}%)`);
            return prediction + urgencyAdjustment;
        }
        
        return prediction;
    }

    // Apply smart randomness to avoid predictability
    applySmartRandomness(prediction, data, rivalName) {
        // Calculate current randomness level based on competitive pressure
        let randomnessLevel = this.STEALTH_MODE.randomnessLevel;
        
        if (this.STEALTH_MODE.adaptiveRandomness) {
            // Increase randomness if we're being predictable
            randomnessLevel += this.globalStats.competitivePressure * 0.2;
            randomnessLevel = Math.min(randomnessLevel, 0.4); // Max 40% randomness
        }
        
        // Pattern breaking - add more randomness every N kicks
        if (this.kickCounter % this.STEALTH_MODE.patternBreakInterval === 0) {
            randomnessLevel *= 2; // Double randomness for pattern breaking
            this.log(`🎭 Pattern break: Increased randomness for kick #${this.kickCounter}`);
        }
        
        // Apply controlled randomness
        if (Math.random() < randomnessLevel) {
            const maxOffset = this.STEALTH_MODE.maxRandomOffset;
            const randomOffset = (Math.random() - 0.5) * 2 * maxOffset; // ±maxOffset
            
            this.log(`🎲 Stealth mode: ${Math.round(randomOffset)}ms random offset (${Math.round(randomnessLevel * 100)}% chance)`);
            return prediction + randomOffset;
        }
        
        return prediction;
    }

    // Calculate rapid confidence with less data needed
    calculateRapidConfidence(data) {
        const totalData = data.kickResults.length;
        const recentData = data.kickResults.filter(r => r.timestamp > Date.now() - (12 * 60 * 60 * 1000)).length; // 12 hours
        const sessionData = data.sessions.length;
        
        // Rapid confidence building
        const dataQuantity = Math.min(totalData / 5, 1); // Need only 5 data points for full confidence
        const dataRecency = Math.min(recentData / 3, 1); // Need only 3 recent data points
        const sessionKnowledge = Math.min(sessionData / 3, 1); // Need only 3 sessions
        
        // Boost confidence for rapid learning mode
        let confidence = (dataQuantity + dataRecency + sessionKnowledge) / 3;
        if (data.currentSession && data.currentSession.behaviorPattern.learningMode === 'rapid') {
            confidence += 0.2; // Boost confidence in rapid learning mode
        }
        
        return Math.min(confidence, 1);
    }

    // Update competitive pressure tracking
    updateCompetitivePressure(rivalName) {
        // Track how predictable we're becoming
        const data = this.getRivalData(rivalName);
        const recentKicks = data.kickResults.slice(-5);
        
        if (recentKicks.length >= 3) {
            // Check for timing patterns that could be predictable
            const timings = recentKicks.map(r => r.timing);
            const avgTiming = timings.reduce((sum, t) => sum + t, 0) / timings.length;
            const variance = timings.reduce((sum, t) => sum + Math.pow(t - avgTiming, 2), 0) / timings.length;
            
            // Low variance = high predictability = high competitive pressure
            const predictability = Math.max(0, 1 - variance / 10000); // Normalize variance
            this.globalStats.competitivePressure = 
                (this.globalStats.competitivePressure * 0.9) + (predictability * 0.1); // Smooth update
        }
    }

    // Enhanced preemptive kick with rapid departure detection
    async predictPreemptiveKick(rivalData, logoutEvent) {
        if (!this.isEnabled || !rivalData) return null;
        
        const data = this.getRivalData(rivalData.name);
        
        // Rapid preemptive decision - need less historical data
        if (data.sessions.length >= 1) { // Reduced from 3
            const recentSessions = data.sessions.slice(-3);
            const quickDepartures = recentSessions.filter(s => s.duration < this.DEPARTURE_DETECTION.quickDepartureThreshold).length;
            const quickDepartureRate = quickDepartures / recentSessions.length;
            
            // More aggressive preemptive kicks
            if (quickDepartureRate > 0.4) { // Reduced from 0.6
                this.log(`⚡ Rapid preemptive: ${rivalData.name} (${Math.round(quickDepartureRate * 100)}% quick departure rate)`);
                return 3; // Even faster preemptive kick
            }
        }
        
        // Check current session departure risk
        if (data.currentSession && data.currentSession.departureRisk > 0.7) {
            this.log(`🚨 High risk preemptive: ${rivalData.name} (${Math.round(data.currentSession.departureRisk * 100)}% risk)`);
            return 2; // Ultra-fast preemptive kick
        }
        
        return null;
    }

    // Apply enhanced 3s error learning with rapid adaptation
    apply3sErrorLearning(prediction, data) {
        const recent3sErrors = data.kickResults.filter(r => 
            r.has3sError && 
            r.timestamp > Date.now() - (15 * 60 * 1000) // Reduced to 15 minutes for faster adaptation
        );
        
        if (recent3sErrors.length === 0) return prediction;
        
        // Rapid error learning - more aggressive adjustments
        const errorTimings = recent3sErrors.map(r => r.timing);
        const avgErrorTiming = errorTimings.reduce((sum, t) => sum + t, 0) / errorTimings.length;
        
        // Adaptive safety margin with rapid learning
        const errorRate = recent3sErrors.length / Math.max(1, data.kickResults.length);
        const safetyMargin = 80 + (errorRate * 250) + (recent3sErrors.length * 30); // More aggressive margin
        
        const adjustment = Math.max(0, avgErrorTiming + safetyMargin - prediction);
        
        if (adjustment > 0) {
            this.log(`⚠️ Rapid 3s learning: +${Math.round(adjustment)}ms (${recent3sErrors.length} errors, margin: ${Math.round(safetyMargin)}ms)`);
        }
        
        return prediction + adjustment;
    }

    // Enhanced safety constraints
    applySafetyConstraints(prediction, manualTiming, rivalName = null) {
        if (rivalName) {
            const data = this.getRivalData(rivalName);
            prediction = this.apply3sErrorLearning(prediction, data);
        }
        
        let safePrediction = Math.max(this.SAFE_WINDOW.min, 
                                    Math.min(this.SAFE_WINDOW.max, Math.round(prediction)));
        
        // Blend with manual timing (60% AI, 40% manual for more adaptability)
        if (manualTiming && !isNaN(manualTiming) && manualTiming > 0) {
            const blended = Math.round(safePrediction * 0.6 + manualTiming * 0.4);
            return Math.max(this.SAFE_WINDOW.min, Math.min(this.SAFE_WINDOW.max, blended));
        }
        
        return safePrediction;
    }

    // Enhanced kick result recording with rapid learning
    async recordKickResult(rivalName, timing, success, has3sError = false, executionTime = 0) {
        const result = {
            rivalName,
            timing,
            success,
            has3sError,
            executionTime,
            timestamp: Date.now(),
            reason: has3sError ? '3s_error' : (success ? 'success' : 'failed'),
            kickNumber: this.kickCounter
        };

        const data = this.getRivalData(rivalName);
        data.kickResults.push(result);
        
        // Keep more recent results for rapid learning
        if (data.kickResults.length > 30) { // Reduced from 50
            data.kickResults = data.kickResults.slice(-30);
        }

        // Update global stats
        this.globalStats.totalPredictions++;
        if (success && !has3sError) {
            this.globalStats.successfulKicks++;
            this.updateSuccessfulTimingAverage(timing);
        }
        if (has3sError) {
            this.globalStats.threeSecondErrors++;
        }

        // Rapid timing distribution update
        const timingBucket = Math.floor(timing / 25) * 25; // 25ms buckets for finer granularity
        if (!this.globalStats.timingDistribution.has(timingBucket)) {
            this.globalStats.timingDistribution.set(timingBucket, { attempts: 0, successes: 0 });
        }
        const bucket = this.globalStats.timingDistribution.get(timingBucket);
        bucket.attempts++;
        if (success && !has3sError) bucket.successes++;

        const emoji = has3sError ? '❌' : (success ? '✅' : '⚠️');
        this.log(`${emoji} ${success ? 'Success' : (has3sError ? '3s error' : 'Failed')}: ${rivalName} at ${timing}ms`);
    }

    // Update global successful timing average with rapid adaptation
    updateSuccessfulTimingAverage(newTiming) {
        const currentAvg = this.globalStats.averageSuccessfulTiming;
        const totalSuccesses = this.globalStats.successfulKicks;
        
        // Higher weight for recent successes in rapid learning
        const weight = Math.min(totalSuccesses, 10); // Cap weight for faster adaptation
        this.globalStats.averageSuccessfulTiming = Math.round(
            (currentAvg * (weight - 1) + newTiming) / weight
        );
    }

    // Get or create rival data with rapid profile initialization
    getRivalData(rivalName) {
        if (!this.rivalData.has(rivalName)) {
            this.rivalData.set(rivalName, {
                kickResults: [],
                sessions: [],
                currentSession: null,
                lastLogout: null,
                createdAt: Date.now(),
                rapidProfile: null, // For rapid learning
                departureMonitoring: null // For departure detection
            });
        }
        return this.rivalData.get(rivalName);
    }

    // Enhanced statistics with rapid learning metrics
    getStats() {
        const accuracy = this.globalStats.totalPredictions > 0 
            ? (this.globalStats.successfulKicks / this.globalStats.totalPredictions) * 100 
            : 0;
        
        const errorRate = this.globalStats.totalPredictions > 0
            ? (this.globalStats.threeSecondErrors / this.globalStats.totalPredictions) * 100
            : 0;

        return {
            totalPredictions: this.globalStats.totalPredictions,
            successfulKicks: this.globalStats.successfulKicks,
            threeSecondErrors: this.globalStats.threeSecondErrors,
            accuracy: Math.round(accuracy * 10) / 10,
            errorRate: errorRate.toFixed(1) + '%',
            averageSuccessfulTiming: this.globalStats.averageSuccessfulTiming,
            competitivePressure: Math.round(this.globalStats.competitivePressure * 100) + '%',
            trackedRivals: this.rivalData.size,
            activeSessions: Array.from(this.rivalData.values()).filter(d => d.currentSession).length,
            rapidLearningRivals: Array.from(this.rivalData.values()).filter(d => d.rapidProfile).length,
            departureMonitoring: Array.from(this.rivalData.values()).filter(d => d.departureMonitoring && d.departureMonitoring.active).length
        };
    }

    // Record when bot got kicked by rival (enhanced)
    async recordBotGotKicked(rivalData, ourTiming, rivalTiming) {
        if (!this.isEnabled || !rivalData) return;
        
        const data = this.getRivalData(rivalData.name);
        data.kickResults.push({
            timestamp: Date.now(),
            timing: ourTiming,
            rivalTiming: rivalTiming,
            success: false,
            reason: 'rival_faster',
            has3sError: false
        });
        
        // Rapid competitive learning - immediate adjustment
        if (!data.competitiveProfile) {
            data.competitiveProfile = { rivalSpeeds: [rivalTiming], avgSpeed: rivalTiming };
        } else {
            data.competitiveProfile.rivalSpeeds.push(rivalTiming);
            if (data.competitiveProfile.rivalSpeeds.length > 10) {
                data.competitiveProfile.rivalSpeeds = data.competitiveProfile.rivalSpeeds.slice(-10);
            }
            data.competitiveProfile.avgSpeed = 
                data.competitiveProfile.rivalSpeeds.reduce((sum, s) => sum + s, 0) / data.competitiveProfile.rivalSpeeds.length;
        }
        
        this.log(`🏃 Bot kicked by: ${rivalData.name} (rival: ${rivalTiming}ms, us: ${ourTiming}ms, rival avg: ${Math.round(data.competitiveProfile.avgSpeed)}ms)`);
    }

    // Record rival kick attempt (enhanced)
    async recordRivalKickAttempt(rivalData, timing, success) {
        if (!this.isEnabled || !rivalData) return;
        
        const data = this.getRivalData(rivalData.name);
        data.kickResults.push({
            timestamp: Date.now(),
            timing: timing,
            success: success,
            reason: success ? 'rival_success' : 'rival_failed',
            has3sError: false,
            isRivalKick: true
        });
        
        this.log(`${success ? '✅' : '❌'} Rival kick: ${rivalData.name} at ${timing}ms`);
    }

    // Enhanced cleanup with rapid learning data
    cleanOldData() {
        const maxAge = 5 * 24 * 60 * 60 * 1000; // 5 days (reduced from 7)
        const now = Date.now();

        for (const [rivalName, data] of this.rivalData.entries()) {
            data.kickResults = data.kickResults.filter(result => now - result.timestamp < maxAge);
            data.sessions = data.sessions.filter(session => now - session.loginTime < maxAge);
            
            // Clean rapid profile if no recent data
            if (data.rapidProfile && data.kickResults.length === 0) {
                data.rapidProfile = null;
            }
            
            // Clean departure monitoring if inactive
            if (data.departureMonitoring && !data.currentSession) {
                data.departureMonitoring = null;
            }
            
            if (data.kickResults.length === 0 && data.sessions.length === 0) {
                this.rivalData.delete(rivalName);
            }
        }
        
        this.log(`🧹 Smart AI: Cleaned old data, tracking ${this.rivalData.size} rivals`);
    }
}

module.exports = { AITimingPredictor: SmartAdaptiveAITimingPredictor };