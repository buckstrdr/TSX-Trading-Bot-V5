/**
 * Test Time Strategy - Simple 5-minute interval testing strategy
 * 
 * Purpose: Test trade placement infrastructure in isolation
 * Logic: Every 5 minutes (xx:00, xx:05, etc.), look at previous 1-minute candle
 *        and place a trade in same direction. Close after 3 minutes regardless of P&L.
 * 
 * This strategy is designed to verify:
 * - Signal generation timing
 * - Order placement mechanics
 * - Position management
 * - Automatic position closure
 * - Position persistence across restarts
 */

const fs = require('fs').promises;
const path = require('path');

class TestTimeStrategy {
    constructor(config = {}, mainBot = null) {
        this.name = 'TEST_TIME_STRATEGY';
        this.version = '1.0';
        this.mainBot = mainBot;
        
        // Strategy parameters
        this.params = {
            // Timing configuration
            intervalMinutes: 5,              // Trade every 5 minutes
            tradeDurationMinutes: 3,         // Hold for 3 minutes
            candleLookbackMinutes: 1,        // Look at previous 1-minute candle
            
            // Risk configuration from bot config - CORRECTED FOR MGC
            dollarRiskPerTrade: config.dollarRiskPerTrade || 50,
            dollarPerPoint: 10,              // MGC: $10 per point ($1 price move = $10 value)
            maxRiskPoints: 5.0,              // $50 ÷ $10 = 5.0 points max risk
            riskRewardRatio: 1,              // 1:1 for testing (will close at time, not target)
            
            // Position sizing
            positionSize: 1,                 // Fixed 1 contract for testing
            
            // Test mode settings
            enableLogging: true,
            logPrefix: '[TEST-TIME]'
        };
        
        // State tracking
        this.state = {
            lastTradeTime: null,
            currentPosition: null,
            positionOpenTime: null,
            nextTradeTime: null,
            tradesPlaced: 0,
            isReady: false,
            lastCloseTime: null,  // Track when last position was closed
            closeCooldownMs: 5000  // 5 second cooldown after closing position
        };
        
        // Candle tracking for 1-minute analysis
        this.candles = [];
        this.currentCandle = null;
        this.lastCandleTime = null;
        
        this.log(`📊 Test Time Strategy v${this.version} initialized`);
        this.log(`⏰ Interval: Every ${this.params.intervalMinutes} minutes`);
        this.log(`⏱️  Duration: Hold for ${this.params.tradeDurationMinutes} minutes`);
        this.log(`📈 Analysis: Previous ${this.params.candleLookbackMinutes}-minute candle`);
        this.log(`💰 Risk: $${this.params.dollarRiskPerTrade} per trade`);
        
        // Position persistence file path
        this.stateFilePath = path.join(__dirname, '..', '..', '..', 'data', 'strategy-state', `${this.name}_state.json`);
        
        // Calculate next trade time
        this.calculateNextTradeTime();
        
        this.state.isReady = true;
        
        // Initialize position state loading (async)
        this.initializeAsync();
    }
    
    /**
     * Calculate the next trade time (xx:00, xx:05, xx:10, etc.)
     */
    calculateNextTradeTime() {
        const now = new Date();
        const minutes = now.getMinutes();
        const seconds = now.getSeconds();
        
        // Round up to next 5-minute interval
        const nextInterval = Math.ceil(minutes / this.params.intervalMinutes) * this.params.intervalMinutes;
        
        const nextTradeTime = new Date(now);
        nextTradeTime.setMinutes(nextInterval);
        nextTradeTime.setSeconds(0);
        nextTradeTime.setMilliseconds(0);
        
        // If we're past the current hour, move to next hour
        if (nextInterval >= 60) {
            nextTradeTime.setHours(nextTradeTime.getHours() + 1);
            nextTradeTime.setMinutes(0);
        }
        
        this.state.nextTradeTime = nextTradeTime;
        
        this.log(`⏰ Next trade scheduled for: ${nextTradeTime.toLocaleTimeString()}`);
    }
    
    /**
     * Process market data - main entry point
     */
    processMarketData(price, volume = 1000, timestamp = null) {
        if (!timestamp) timestamp = new Date();
        
        // Update candle data
        this.updateCandle(price, volume, timestamp);
        
        // Check if ready to trade
        if (!this.state.isReady) {
            return {
                ready: false,
                signal: null,
                debug: { reason: 'Strategy not ready' }
            };
        }
        
        // Check for existing position closure
        const closureSignal = this.checkPositionClosure(timestamp);
        if (closureSignal) {
            return {
                ready: true,
                signal: closureSignal,
                debug: { reason: 'Position closure due to time limit' }
            };
        }
        
        // Check for new trade signal
        const tradeSignal = this.checkTradeSignal(timestamp);
        if (tradeSignal) {
            return {
                ready: true,
                signal: tradeSignal,
                debug: { reason: 'New trade signal generated' }
            };
        }
        
        return {
            ready: true,
            signal: null,
            debug: { 
                reason: 'Monitoring',
                nextTradeTime: this.state.nextTradeTime,
                currentPosition: this.state.currentPosition ? 'OPEN' : 'NONE',
                candlesTracked: this.candles.length
            }
        };
    }
    
    /**
     * Update candle data for 1-minute analysis
     */
    updateCandle(price, volume, timestamp) {
        const candleTime = new Date(timestamp);
        candleTime.setSeconds(0, 0); // Round to minute
        const candleTimeMs = candleTime.getTime();
        
        // Start new candle if time changed
        if (!this.lastCandleTime || candleTimeMs !== this.lastCandleTime) {
            // Close previous candle
            if (this.currentCandle && this.currentCandle.close !== null) {
                this.candles.push({ ...this.currentCandle });
                
                // Keep only last 10 candles for analysis
                if (this.candles.length > 10) {
                    this.candles = this.candles.slice(-10);
                }
                
                this.log(`📊 Candle closed: O:${this.currentCandle.open.toFixed(2)} H:${this.currentCandle.high.toFixed(2)} L:${this.currentCandle.low.toFixed(2)} C:${this.currentCandle.close.toFixed(2)}`);
            }
            
            // Start new candle
            this.currentCandle = {
                timestamp: candleTimeMs,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: volume
            };
            this.lastCandleTime = candleTimeMs;
        } else {
            // Update current candle
            if (this.currentCandle) {
                this.currentCandle.high = Math.max(this.currentCandle.high, price);
                this.currentCandle.low = Math.min(this.currentCandle.low, price);
                this.currentCandle.close = price;
                this.currentCandle.volume += volume;
            }
        }
    }
    
    /**
     * Check if it's time to place a new trade
     */
    checkTradeSignal(timestamp) {
        // Don't trade if position is already open
        if (this.state.currentPosition) {
            return null;
        }
        
        // Don't trade if we just closed a position (cooldown period)
        if (this.state.lastCloseTime && 
            (timestamp.getTime() - this.state.lastCloseTime.getTime()) < this.state.closeCooldownMs) {
            return null;
        }
        
        // Use system time for more reliable timing instead of market data timestamps
        const now = new Date();
        const currentMinutes = now.getMinutes();
        const currentSeconds = now.getSeconds();
        
        // Check if it's time to trade (every 5 minutes) with flexible window
        const isTradeInterval = (currentMinutes % this.params.intervalMinutes === 0);
        const isWithinWindow = (currentSeconds <= 45); // Extended window to 45 seconds for reliability
        
        if (!isTradeInterval || !isWithinWindow) {
            // Only log occasionally to avoid spam
            if (currentSeconds % 10 === 0) {
                this.log(`⏰ Waiting for trade window - current: ${currentMinutes.toString().padStart(2, '0')}:${currentSeconds.toString().padStart(2, '0')}, next: ${(Math.ceil(currentMinutes / this.params.intervalMinutes) * this.params.intervalMinutes).toString().padStart(2, '0')}:00`);
            }
            return null;
        }
        
        // Prevent duplicate trades in the same minute by checking if we already traded this interval
        if (this.state.lastTradeTime) {
            const lastTradeMinutes = this.state.lastTradeTime.getMinutes();
            const lastTradeInterval = Math.floor(lastTradeMinutes / this.params.intervalMinutes) * this.params.intervalMinutes;
            const currentInterval = Math.floor(currentMinutes / this.params.intervalMinutes) * this.params.intervalMinutes;
            
            if (lastTradeInterval === currentInterval && 
                this.state.lastTradeTime.getHours() === now.getHours()) {
                return null; // Already traded this interval
            }
        }
        
        // Use completed candles if available, otherwise use current candle for immediate execution
        let candlesToAnalyze;
        let referenceCandle;
        
        if (this.candles.length >= 2) {
            // Use last 2 completed candles
            candlesToAnalyze = [this.candles[this.candles.length - 2], this.candles[this.candles.length - 1]];
            referenceCandle = candlesToAnalyze[candlesToAnalyze.length - 1];
            this.log(`📊 Using ${candlesToAnalyze.length} completed candles for analysis`);
        } else if (this.candles.length === 1) {
            // Use 1 completed candle
            candlesToAnalyze = [this.candles[0]];
            referenceCandle = candlesToAnalyze[0];
            this.log(`📊 Using 1 completed candle for analysis`);
        } else if (this.currentCandle) {
            // Use current candle being built (for immediate execution)
            candlesToAnalyze = [this.currentCandle];
            referenceCandle = this.currentCandle;
            this.log(`📊 Using current candle for immediate analysis (no completed candles yet)`);
        } else {
            // No data at all - generate random direction to keep testing active
            this.log(`⚠️ No candle data available - generating random trade for testing`);
            const randomDirection = Math.random() > 0.5 ? 'LONG' : 'SHORT';
            const currentPrice = 3382; // Use a reasonable default price
            
            // Create a synthetic reference candle
            referenceCandle = {
                open: currentPrice,
                close: currentPrice,
                high: currentPrice,
                low: currentPrice,
                timestamp: now.getTime(),
                volume: 1000
            };
            
            const signal = this.generateTestSignal(randomDirection, referenceCandle, now);
            
            // Update state
            this.state.lastTradeTime = now;
            this.state.currentPosition = randomDirection;
            this.state.positionOpenTime = now;
            this.state.tradesPlaced++;
            
            this.log(`🎲 RANDOM TRADE #${this.state.tradesPlaced} - ${randomDirection} (no candle data)`);
            return signal;
        }
        
        // Determine trade direction based on candles
        const analysisResult = this.analyzeMultipleCandleDirection(candlesToAnalyze);
        
        let direction;
        if (analysisResult.direction === 'NEUTRAL') {
            // If neutral, pick a random direction to keep testing active
            direction = Math.random() > 0.5 ? 'LONG' : 'SHORT';
            this.log(`🎲 Candles neutral - choosing RANDOM direction: ${direction}`);
            this.log(`📊 Analyzed ${candlesToAnalyze.length} candle(s) - all neutral, forcing trade`);
        } else {
            // REVERSE the trade direction (contrarian strategy)
            direction = analysisResult.direction === 'LONG' ? 'SHORT' : 'LONG';
            this.log(`🔄 REVERSED: Candles were ${analysisResult.direction}, trading ${direction}`);
            this.log(`📊 Analyzed ${candlesToAnalyze.length} candle(s) - clear direction found`);
        }
        
        const signal = this.generateTestSignal(direction, referenceCandle, now);
        
        // Update state
        this.state.lastTradeTime = now;
        this.state.currentPosition = direction;
        this.state.positionOpenTime = now;
        this.state.tradesPlaced++;
        
        // Save position state for persistence (non-blocking)
        this.savePositionState().catch(err => this.log(`⚠️ Failed to save position state: ${err.message}`));
        
        this.log(`🎯 TRADE #${this.state.tradesPlaced} - ${direction} signal generated based on ${candlesToAnalyze.length} candle(s)`);
        this.log(`📊 Latest candle: O:${referenceCandle.open.toFixed(2)} C:${referenceCandle.close.toFixed(2)} → ${direction}`);
        this.log(`⏱️  Position will close in ${this.params.tradeDurationMinutes} minutes`);
        
        return signal;
    }
    
    /**
     * Analyze candle direction
     */
    analyzeCandleDirection(candle) {
        const priceDiff = candle.close - candle.open;
        const threshold = 0.1; // Minimum price movement to avoid noise
        
        if (priceDiff > threshold) {
            return 'LONG';  // Bullish candle
        } else if (priceDiff < -threshold) {
            return 'SHORT'; // Bearish candle
        } else {
            return 'NEUTRAL'; // Too small to trade
        }
    }
    
    /**
     * Analyze multiple candles to determine overall direction
     */
    analyzeMultipleCandleDirection(candles) {
        if (!candles || candles.length === 0) {
            return { direction: 'NEUTRAL', confidence: 0, analysis: 'No candles provided' };
        }
        
        const analysis = {
            longCandles: 0,
            shortCandles: 0,
            neutralCandles: 0,
            totalMovement: 0,
            details: []
        };
        
        // Analyze each candle
        candles.forEach((candle, index) => {
            const direction = this.analyzeCandleDirection(candle);
            const movement = candle.close - candle.open;
            
            analysis.details.push({
                index,
                direction,
                movement: movement.toFixed(2),
                open: candle.open.toFixed(2),
                close: candle.close.toFixed(2)
            });
            
            analysis.totalMovement += movement;
            
            switch (direction) {
                case 'LONG':
                    analysis.longCandles++;
                    break;
                case 'SHORT':
                    analysis.shortCandles++;
                    break;
                case 'NEUTRAL':
                    analysis.neutralCandles++;
                    break;
            }
        });
        
        // Determine overall direction
        let overallDirection;
        let confidence;
        
        if (analysis.longCandles > analysis.shortCandles) {
            overallDirection = 'LONG';
            confidence = analysis.longCandles / candles.length;
        } else if (analysis.shortCandles > analysis.longCandles) {
            overallDirection = 'SHORT';
            confidence = analysis.shortCandles / candles.length;
        } else {
            // Equal number of bullish and bearish candles, or all neutral
            if (Math.abs(analysis.totalMovement) > 0.2) {
                // Use total movement to break tie
                overallDirection = analysis.totalMovement > 0 ? 'LONG' : 'SHORT';
                confidence = 0.5; // Low confidence due to mixed signals
            } else {
                overallDirection = 'NEUTRAL';
                confidence = 0;
            }
        }
        
        this.log(`📊 Multi-candle analysis: ${candles.length} candle(s) → ${overallDirection} (confidence: ${(confidence * 100).toFixed(0)}%)`);
        this.log(`📈 Breakdown: ${analysis.longCandles} LONG, ${analysis.shortCandles} SHORT, ${analysis.neutralCandles} NEUTRAL`);
        this.log(`💹 Total movement: ${analysis.totalMovement.toFixed(2)} points`);
        
        return {
            direction: overallDirection,
            confidence,
            analysis: analysis.details,
            summary: {
                longCandles: analysis.longCandles,
                shortCandles: analysis.shortCandles,
                neutralCandles: analysis.neutralCandles,
                totalMovement: analysis.totalMovement
            }
        };
    }
    
    /**
     * Generate test signal
     */
    generateTestSignal(direction, referenceCandle, timestamp) {
        const currentPrice = referenceCandle.close;
        
        // Simple fixed risk approach for testing - CORRECTED FOR MGC
        const riskPoints = 5.0; // $50 ÷ $10 = 5.0 points risk for testing
        const entryPrice = currentPrice;
        
        let stopLoss, takeProfit;
        
        if (direction === 'LONG') {
            stopLoss = entryPrice - riskPoints;
            takeProfit = entryPrice + riskPoints; // 1:1 R:R for testing
        } else { // SHORT
            stopLoss = entryPrice + riskPoints;
            takeProfit = entryPrice - riskPoints;
        }
        
        // Calculate dollar amounts
        const dollarRisk = riskPoints * this.params.positionSize * this.params.dollarPerPoint;
        const dollarReward = riskPoints * this.params.positionSize * this.params.dollarPerPoint;
        
        const signal = {
            // Core signal properties
            direction: direction,
            confidence: 'TEST',
            entryPrice: entryPrice,
            stopLoss: stopLoss,
            takeProfit: takeProfit,
            instrument: 'MGC', // Set instrument for aggregator
            
            // Risk metrics
            riskPoints: riskPoints,
            rewardPoints: riskPoints,
            riskRewardRatio: 1,
            
            // Position sizing
            positionSize: this.params.positionSize,
            dollarRisk: dollarRisk,
            dollarReward: dollarReward,
            
            // Metadata
            timestamp: timestamp,
            reason: `Test strategy: ${direction} based on previous candle movement`,
            subStrategy: 'TIME_BASED_TEST',
            
            // Required fields
            signalStrength: 1.0,
            strategyName: 'TEST_TIME_STRATEGY',
            strategyVersion: '1.0',
            
            // Test-specific data
            testData: {
                tradeNumber: this.state.tradesPlaced,
                referenceCandle: {
                    open: referenceCandle.open,
                    close: referenceCandle.close,
                    direction: direction
                },
                plannedDuration: this.params.tradeDurationMinutes,
                plannedCloseTime: new Date(timestamp.getTime() + (this.params.tradeDurationMinutes * 60 * 1000))
            }
        };
        
        return signal;
    }
    
    /**
     * Check if current position should be closed due to time limit
     */
    checkPositionClosure(timestamp) {
        if (!this.state.currentPosition || !this.state.positionOpenTime) {
            return null;
        }
        
        // Calculate how long position has been open
        const positionDurationMs = timestamp - this.state.positionOpenTime;
        const targetDurationMs = this.params.tradeDurationMinutes * 60 * 1000;
        
        // Close if position has been open for the target duration
        if (positionDurationMs >= targetDurationMs) {
            const signal = this.generateCloseSignal(timestamp);
            
            // Reset position state and set close cooldown
            this.state.currentPosition = null;
            this.state.positionOpenTime = null;
            this.state.lastCloseTime = timestamp; // Record when position was closed
            
            // Clear saved position state (non-blocking)
            this.clearPositionState().catch(err => this.log(`⚠️ Failed to clear position state: ${err.message}`));
            
            this.log(`⏰ POSITION CLOSED - Time limit reached (${this.params.tradeDurationMinutes} minutes)`);
            
            return signal;
        }
        
        return null;
    }
    
    /**
     * Generate position close signal
     */
    generateCloseSignal(timestamp) {
        // Use CLOSE_POSITION request format (same as manual trading)
        return {
            direction: 'CLOSE_POSITION', // Special directive for proper position closure
            confidence: 'TEST',
            instrument: 'MGC', // Set instrument for aggregator
            positionSize: this.params.positionSize,
            reason: `Test strategy: Time-based closure after ${this.params.tradeDurationMinutes} minutes`,
            timestamp: timestamp,
            strategyName: 'TEST_TIME_STRATEGY',
            strategyVersion: '1.0',
            closeType: 'full', // Full position closure
            testData: {
                closeReason: 'TIME_LIMIT',
                durationMinutes: this.params.tradeDurationMinutes,
                originalPosition: this.state.currentPosition
            }
        };
    }
    
    /**
     * Strategy ready check
     */
    isStrategyReady() {
        return this.state.isReady;
    }
    
    /**
     * Get strategy status
     */
    getStatusSummary() {
        return {
            module: 'Strategy',
            status: this.state.isReady ? 'READY' : 'INITIALIZING',
            name: this.name,
            version: this.version,
            strategyType: 'TIME_BASED_TEST',
            isReady: this.state.isReady,
            debug: {
                nextTradeTime: this.state.nextTradeTime,
                currentPosition: this.state.currentPosition,
                tradesPlaced: this.state.tradesPlaced,
                candlesTracked: this.candles.length
            }
        };
    }
    
    /**
     * Reset strategy
     */
    reset() {
        this.state = {
            lastTradeTime: null,
            currentPosition: null,
            positionOpenTime: null,
            nextTradeTime: null,
            tradesPlaced: 0,
            isReady: true,
            lastCloseTime: null,
            closeCooldownMs: 5000
        };
        this.candles = [];
        this.currentCandle = null;
        this.lastCandleTime = null;
        this.calculateNextTradeTime();
        this.log(`🔄 Test Time Strategy reset complete`);
    }
    
    /**
     * Logging helper
     */
    log(message) {
        if (this.params.enableLogging) {
            const timestamp = new Date().toLocaleTimeString();
            console.log(`${this.params.logPrefix} [${timestamp}] ${message}`);
        }
    }
    
    /**
     * Async initialization for position state loading
     */
    async initializeAsync() {
        try {
            // Load any existing position state on startup
            await this.loadPositionState();
            this.log(`🚀 Strategy async initialization complete`);
        } catch (error) {
            this.log(`❌ Error during async initialization: ${error.message}`);
        }
    }
    
    /**
     * Save position state to file for persistence across restarts
     */
    async savePositionState() {
        try {
            // Ensure directory exists
            const dir = path.dirname(this.stateFilePath);
            await fs.mkdir(dir, { recursive: true });
            
            const stateData = {
                currentPosition: this.state.currentPosition,
                positionOpenTime: this.state.positionOpenTime ? this.state.positionOpenTime.toISOString() : null,
                lastTradeTime: this.state.lastTradeTime ? this.state.lastTradeTime.toISOString() : null,
                tradesPlaced: this.state.tradesPlaced,
                lastCloseTime: this.state.lastCloseTime ? this.state.lastCloseTime.toISOString() : null,
                savedAt: new Date().toISOString(),
                version: this.version
            };
            
            await fs.writeFile(this.stateFilePath, JSON.stringify(stateData, null, 2), 'utf8');
            this.log(`💾 Position state saved: ${this.state.currentPosition ? `${this.state.currentPosition} position` : 'No position'}`);
            
        } catch (error) {
            this.log(`❌ Failed to save position state: ${error.message}`);
        }
    }
    
    /**
     * Load position state from file on startup
     */
    async loadPositionState() {
        try {
            const stateContent = await fs.readFile(this.stateFilePath, 'utf8');
            const stateData = JSON.parse(stateContent);
            
            // Restore state if valid
            if (stateData.currentPosition) {
                this.state.currentPosition = stateData.currentPosition;
                this.state.positionOpenTime = stateData.positionOpenTime ? new Date(stateData.positionOpenTime) : null;
                this.state.lastTradeTime = stateData.lastTradeTime ? new Date(stateData.lastTradeTime) : null;
                this.state.tradesPlaced = stateData.tradesPlaced || 0;
                this.state.lastCloseTime = stateData.lastCloseTime ? new Date(stateData.lastCloseTime) : null;
                
                this.log(`📂 Loaded position state: ${this.state.currentPosition} position opened at ${this.state.positionOpenTime?.toLocaleTimeString()}`);
                
                // Verify position still exists with aggregator
                await this.verifyPositionWithAggregator();
            } else {
                this.log(`📂 Loaded state: No active position`);
            }
            
        } catch (error) {
            if (error.code === 'ENOENT') {
                this.log(`📂 No existing state file found, starting fresh`);
            } else {
                this.log(`❌ Failed to load position state: ${error.message}`);
            }
        }
    }
    
    /**
     * Verify that our saved position still exists in the aggregator/broker
     */
    async verifyPositionWithAggregator() {
        try {
            if (!this.mainBot || !this.mainBot.aggregatorClient) {
                this.log(`⚠️ No aggregator client available for position verification`);
                // Don't clear position if we can't verify - maintain position for manual recovery
                this.log(`🔒 Keeping saved position state for manual verification`);
                return;
            }
            
            this.log(`🔍 Querying live positions from broker for verification...`);
            
            // FIXED: Query live positions from broker via aggregator request instead of local cache
            // Create position request (same format as manual trading uses)
            const redis = require('redis');
            const { v4: uuidv4 } = require('uuid');
            
            const publisher = redis.createClient({ host: 'localhost', port: 6379 });
            const subscriber = redis.createClient({ host: 'localhost', port: 6379 });
            
            await publisher.connect();
            await subscriber.connect();
            
            const requestId = `manual-pos-${this.mainBot.config.accountId || '9627376'}-${Date.now()}`;
            const responseChannel = 'position-response';
            
            // Set up position verification with 10 second timeout
            const positionPromise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    this.log(`⚠️ Position verification timeout - keeping saved position for safety`);
                    subscriber.unsubscribe(responseChannel);
                    publisher.quit();
                    subscriber.quit();
                    resolve('TIMEOUT'); // Don't reject on timeout, keep position
                }, 10000);
                
                subscriber.subscribe(responseChannel, async (message) => {
                    try {
                        const response = JSON.parse(message);
                        
                        // Check if this response is for our request
                        if (response.requestId === requestId) {
                            clearTimeout(timeout);
                            await subscriber.unsubscribe(responseChannel);
                            await publisher.quit();
                            await subscriber.quit();
                            
                            this.log(`📨 Received position verification response:`, response);
                            resolve(response);
                        }
                        // Ignore responses for other requests
                        
                    } catch (error) {
                        clearTimeout(timeout);
                        await subscriber.unsubscribe(responseChannel);
                        await publisher.quit();
                        await subscriber.quit();
                        reject(error);
                    }
                });
            });
            
            // Send position query request (same format as manual trading)
            const positionRequest = {
                type: 'GET_POSITIONS',
                requestId: requestId,
                accountId: parseInt(this.mainBot.config.accountId || '9627376'),
                responseChannel: responseChannel,
                timestamp: Date.now()
            };
            
            await publisher.publish('aggregator:requests', JSON.stringify(positionRequest));
            this.log(`📤 Sent position verification request: ${requestId}`);
            
            // Wait for response
            const positionResponse = await positionPromise;
            
            if (positionResponse === 'TIMEOUT') {
                // Keep position on timeout - better safe than sorry
                this.log(`⏰ Position verification timed out - maintaining saved position for safety`);
                return;
            }
            
            // Check if we have matching positions
            const positions = positionResponse.positions || [];
            const hasMatchingPosition = positions.some(pos => {
                return pos.instrument === 'MGC' || 
                       pos.contractId?.includes('MGC') || 
                       pos.symbol?.includes('MGC');
            });
            
            if (hasMatchingPosition) {
                this.log(`✅ Position verified with broker: ${this.state.currentPosition} position still active`);
                
                // Check if position should be closed due to time (in case bot was down past close time)
                if (this.state.positionOpenTime) {
                    const now = new Date();
                    const positionAge = now - this.state.positionOpenTime;
                    const targetDuration = this.params.tradeDurationMinutes * 60 * 1000;
                    
                    if (positionAge >= targetDuration) {
                        this.log(`⏰ Position exceeded target duration (${Math.floor(positionAge / 60000)} min), will close on next tick`);
                    } else {
                        const remainingTime = Math.floor((targetDuration - positionAge) / 60000);
                        this.log(`⏱️ Position will close in ${remainingTime} minutes`);
                    }
                }
                
            } else {
                this.log(`⚠️ No matching MGC position found in broker response`);
                this.log(`📋 Positions found:`, positions);
                
                // Only clear if we got a valid response with no positions
                if (Array.isArray(positions)) {
                    this.log(`🗑️ Clearing saved position state - confirmed no matching position in broker`);
                    this.state.currentPosition = null;
                    this.state.positionOpenTime = null;
                    await this.savePositionState();
                } else {
                    this.log(`⚠️ Invalid position response - keeping saved state for safety`);
                }
            }
            
        } catch (error) {
            this.log(`❌ Error verifying position with aggregator: ${error.message}`);
            // Don't clear position on error - keep it for safety
            this.log(`🔒 Keeping saved position state due to verification error`);
        }
    }
    
    /**
     * Clear position state (called when position is closed)
     */
    async clearPositionState() {
        this.state.currentPosition = null;
        this.state.positionOpenTime = null;
        return await this.savePositionState();
    }
}

module.exports = TestTimeStrategy;