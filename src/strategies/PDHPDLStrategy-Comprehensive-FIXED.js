/**
 * PDH/PDL Daily Flip Strategy - ARCHITECTURALLY CORRECT Implementation
 * Fixed to use proper Redis pub/sub communication instead of direct HTTP calls
 * 
 * CORRECT FLOW: Strategy -> Bot -> Aggregator -> Connection Manager -> TSX API
 * All communication through Redis channels, NO direct HTTP calls
 */

const fs = require('fs').promises;
const path = require('path');

class PDHPDLStrategy {
    constructor(config = {}, mainBot = null) {
        this.name = 'PDH_PDL_COMPREHENSIVE';
        this.version = '3.0'; // Version 3 fixes architectural violations
        this.mainBot = mainBot; // CRITICAL: Bot reference for proper communication
        
        // MGC Micro Gold Futures specifications
        this.contractSpecs = {
            symbol: 'MGC',
            tickSize: 0.1,           // $0.10 per tick
            tickValue: 1.0,          // $1.00 per tick
            marginDay: 50,           // ~$50 day trading margin
            contractValue: 1000,     // 1000 troy ounces
            currency: 'USD'
        };
        
        // Strategy parameters from concept document
        this.params = {
            // Risk management (handled by bot framework)
            dollarRiskPerTrade: config.dollarRiskPerTrade || 100,
            dollarPerPoint: config.dollarPerPoint || 10,
            maxRiskPoints: config.maxRiskPoints || 3.0,
            riskRewardRatio: config.riskRewardRatio || 2.0,
            
            // RTH Session Configuration (Critical)
            rthStartHour: 8,         // 8:30 AM CT
            rthStartMinute: 30,
            rthEndHour: 15,          // 3:15 PM CT  
            rthEndMinute: 15,
            timezone: 'America/Chicago', // Central Time
            
            // PDH/PDL Specific Parameters
            volumeConfirmationMultiplier: config.volumeConfirmationMultiplier || 1.5,
            breakoutBufferTicks: config.breakoutBufferTicks || 2,
            
            // MGC-specific stop configurations
            mgcBreakoutStopTicks: config.mgcBreakoutStopTicks || 10,
            mgcFadeStopTicks: config.mgcFadeStopTicks || 8,
            
            // General settings
            candlePeriodMs: config.candlePeriodMs || 300000, // 5 minutes
            maxCandleHistory: config.maxCandleHistory || 200,
            maxSignalsPerDay: config.maxSignalsPerDay || 6,
            signalCooldownMs: config.signalCooldownMs || 300000
        };
        
        // Strategy state
        this.state = {
            currentPosition: null,
            lastSignalTime: null,
            signalsToday: 0,
            dataPointsCollected: 0,
            rthDataPointsToday: 0,
            
            // PDH/PDL levels with RTH validation
            pdhPdlLevels: {
                pdh: null,
                pdl: null,
                range: null,
                midpoint: null,
                calculatedAt: null,
                tradeDate: null,
                rthDataPoints: 0,
                validRthCalculation: false,
                bootstrapped: false
            },
            
            // Historical data request tracking
            historicalDataRequested: false,
            historicalDataRequestId: null,
            historicalDataReceived: false
        };
        
        // Data storage
        this.candles = [];
        this.currentCandle = null;
        this.lastCandleTime = null;
        
        console.log(`📊 ${this.name} v${this.version} initialized`);
        console.log(`🥇 Target: MGC (Micro Gold Futures)`);
        console.log(`💰 Risk per trade: $${this.params.dollarRiskPerTrade}`);
        console.log(`⏰ RTH Session: ${this.params.rthStartHour}:${this.params.rthStartMinute} - ${this.params.rthEndHour}:${this.params.rthEndMinute} CT`);
        console.log(`🔧 ARCHITECTURE: Using proper Redis pub/sub communication`);
        
        // Request historical data through proper channels
        this.requestHistoricalDataThroughBot();
    }
    
    /**
     * REQUEST HISTORICAL DATA THROUGH PROPER CHANNELS
     * This is the CORRECT way - through the bot, not direct HTTP
     */
    async requestHistoricalDataThroughBot() {
        try {
            console.log(`🚀 [BOOTSTRAP] Requesting historical data through proper channels...`);
            
            // Check if we have access to the bot
            if (!this.mainBot) {
                console.log(`⚠️ [BOOTSTRAP] No bot reference available - waiting for bot to provide historical data`);
                return;
            }
            
            // Calculate time windows - need at least 48 hours to ensure we get previous trading day
            const now = new Date();
            const endTime = new Date(now);
            const startTime = new Date(now.getTime() - (48 * 60 * 60 * 1000)); // 48 hours ago
            
            console.log(`📅 [BOOTSTRAP] Requesting historical data from ${startTime.toISOString()} to ${endTime.toISOString()}`);
            
            // Generate unique request ID
            this.state.historicalDataRequestId = `pdh_pdl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            
            // Prepare request data for proper Redis channel communication
            const requestData = {
                type: 'REQUEST_HISTORICAL_DATA',
                instanceId: this.mainBot.instanceId || 'bot_1',
                requestId: this.state.historicalDataRequestId,
                instrument: 'F.US.MGC',  // MGC futures contract
                startTime: startTime.toISOString(),
                endTime: endTime.toISOString(),
                unit: 2,                 // 2 = Minute
                unitNumber: 5,           // 5-minute candles
                limit: 1000,             // Get last 1000 bars (should cover 48+ hours)
                includePartialBar: false // Don't include current incomplete bar
            };
            
            console.log(`🔍 [BOOTSTRAP] Sending historical data request through bot:`, JSON.stringify(requestData, null, 2));
            
            // Request through bot's aggregator client or event system
            if (this.mainBot.aggregatorClient) {
                console.log(`📡 [BOOTSTRAP] Sending request through aggregator client`);
                await this.mainBot.aggregatorClient.requestHistoricalData(requestData);
                this.state.historicalDataRequested = true;
            } else if (this.mainBot.eventBus) {
                console.log(`📡 [BOOTSTRAP] Sending request through event bus`);
                await this.mainBot.eventBus.emit('REQUEST_HISTORICAL_DATA', requestData);
                this.state.historicalDataRequested = true;
            } else {
                console.log(`❌ [BOOTSTRAP] Bot doesn't have aggregator client or event bus - cannot request historical data`);
                console.log(`⚠️ [BOOTSTRAP] Strategy will collect data from live feed (slower initialization)`);
            }
            
        } catch (error) {
            console.error(`💥 [BOOTSTRAP] Error requesting historical data:`, error);
            console.log(`⚠️ [BOOTSTRAP] Falling back to live data collection`);
        }
    }
    
    /**
     * Process historical data response received through proper channels
     * This will be called by the bot when it receives HISTORICAL_DATA_RESPONSE
     */
    async processHistoricalDataResponse(response) {
        try {
            console.log(`📊 [BOOTSTRAP] Received historical data response`);
            
            // Verify this is our request
            if (response.requestId !== this.state.historicalDataRequestId) {
                console.log(`⚠️ [BOOTSTRAP] Response ID mismatch - ignoring`);
                return;
            }
            
            if (!response.success || !response.bars || response.bars.length === 0) {
                console.log(`❌ [BOOTSTRAP] Failed to receive valid historical data`);
                return;
            }
            
            console.log(`✅ [BOOTSTRAP] Received ${response.bars.length} historical bars`);
            
            // CRITICAL FIX: Calculate PDH/PDL from historical data BEFORE processing into candles
            const pdhPdlResult = this.calculatePDHPDLFromHistoricalBars(response.bars);
            
            if (pdhPdlResult.success) {
                // Directly set PDH/PDL levels from historical calculation
                this.state.pdhPdlLevels = {
                    pdh: pdhPdlResult.pdh,
                    pdl: pdhPdlResult.pdl,
                    range: pdhPdlResult.range,
                    midpoint: pdhPdlResult.midpoint,
                    calculatedAt: new Date(),
                    tradeDate: new Date().toDateString(),
                    rthDataPoints: pdhPdlResult.rthDataPoints,
                    validRthCalculation: true,
                    bootstrapped: true  // Mark as bootstrapped from historical data
                };
                
                console.log(`🎯 [BOOTSTRAP] PDH/PDL Calculated from Historical Data:`);
                console.log(`   📈 PDH: ${pdhPdlResult.pdh.toFixed(2)}`);
                console.log(`   📉 PDL: ${pdhPdlResult.pdl.toFixed(2)}`);
                console.log(`   📊 Range: ${pdhPdlResult.range.toFixed(2)}`);
                console.log(`   🎯 Midpoint: ${pdhPdlResult.midpoint.toFixed(2)}`);
                console.log(`   📅 Previous Trading Day: ${pdhPdlResult.tradingDate}`);
                console.log(`   ✅ RTH Data Points Used: ${pdhPdlResult.rthDataPoints}`);
            }
            
            // Process historical bars for other indicators
            let processedCount = 0;
            for (const bar of response.bars) {
                const timestamp = new Date(bar.t);
                const price = bar.c; // Use close price
                const volume = bar.v || 1000; // Use actual volume or fallback
                
                // Update candle data without generating signals
                this.updateCandle(price, volume, timestamp);
                processedCount++;
                
                // Log progress every 50 bars
                if (processedCount % 50 === 0) {
                    console.log(`📊 [BOOTSTRAP] Processed ${processedCount}/${response.bars.length} bars`);
                }
            }
            
            this.state.historicalDataReceived = true;
            console.log(`🎯 [BOOTSTRAP] Complete! Processed ${processedCount} bars`);
            console.log(`✨ [BOOTSTRAP] Strategy Ready: ${this.isStrategyReady()}`);
            
            if (this.isStrategyReady()) {
                console.log(`🚀 [BOOTSTRAP] SUCCESS! Strategy is ready for immediate signal generation`);
                console.log(`📈 [BOOTSTRAP] PDH: ${this.state.pdhPdlLevels.pdh}, PDL: ${this.state.pdhPdlLevels.pdl}`);
            }
            
        } catch (error) {
            console.error(`💥 [BOOTSTRAP] Error processing historical data response:`, error);
        }
    }
    
    /**
     * Calculate PDH/PDL directly from historical bars
     * This is the FIX for the bootstrap issue - calculates from raw historical data
     * before it gets truncated by the candle array size limit
     */
    calculatePDHPDLFromHistoricalBars(bars) {
        try {
            console.log(`🔍 [BOOTSTRAP] Calculating PDH/PDL from ${bars.length} historical bars`);
            
            // Group bars by trading day (considering RTH only)
            const tradingDays = {};
            
            for (const bar of bars) {
                const timestamp = new Date(bar.t);
                
                // Check if this bar is within RTH
                if (!this.isWithinRTH(timestamp)) {
                    continue; // Skip non-RTH bars
                }
                
                // Get the trading day (date string)
                const tradingDay = timestamp.toDateString();
                
                if (!tradingDays[tradingDay]) {
                    tradingDays[tradingDay] = {
                        date: tradingDay,
                        bars: [],
                        high: -Infinity,
                        low: Infinity
                    };
                }
                
                // Add bar to this trading day
                tradingDays[tradingDay].bars.push(bar);
                
                // Update high/low for this trading day
                tradingDays[tradingDay].high = Math.max(tradingDays[tradingDay].high, bar.h);
                tradingDays[tradingDay].low = Math.min(tradingDays[tradingDay].low, bar.l);
            }
            
            // Get sorted trading days
            const sortedDays = Object.keys(tradingDays).sort((a, b) => 
                new Date(a).getTime() - new Date(b).getTime()
            );
            
            console.log(`📅 [BOOTSTRAP] Found ${sortedDays.length} trading days in historical data`);
            
            // Find the most recent complete trading day (not today)
            const today = new Date().toDateString();
            let previousTradingDay = null;
            
            for (let i = sortedDays.length - 1; i >= 0; i--) {
                const day = sortedDays[i];
                if (day !== today && tradingDays[day].bars.length >= 20) { // Need at least 20 RTH bars
                    previousTradingDay = tradingDays[day];
                    break;
                }
            }
            
            if (!previousTradingDay) {
                console.log(`❌ [BOOTSTRAP] No complete previous trading day found in historical data`);
                return { success: false };
            }
            
            const pdh = previousTradingDay.high;
            const pdl = previousTradingDay.low;
            const range = pdh - pdl;
            const midpoint = (pdh + pdl) / 2;
            
            console.log(`✅ [BOOTSTRAP] Found previous trading day: ${previousTradingDay.date}`);
            console.log(`   - RTH Bars: ${previousTradingDay.bars.length}`);
            console.log(`   - High: ${pdh.toFixed(2)}, Low: ${pdl.toFixed(2)}`);
            
            return {
                success: true,
                pdh: pdh,
                pdl: pdl,
                range: range,
                midpoint: midpoint,
                tradingDate: previousTradingDay.date,
                rthDataPoints: previousTradingDay.bars.length
            };
            
        } catch (error) {
            console.error(`💥 [BOOTSTRAP] Error calculating PDH/PDL from historical bars:`, error);
            return { success: false };
        }
    }
    
    /**
     * Check if strategy is ready for signal generation
     */
    isStrategyReady() {
        return this.state.pdhPdlLevels.validRthCalculation && 
               this.state.pdhPdlLevels.pdh !== null && 
               this.state.pdhPdlLevels.pdl !== null;
    }
    
    /**
     * Check if timestamp is within Regular Trading Hours (8:30 AM - 3:15 PM CT)
     */
    isWithinRTH(timestamp) {
        const date = new Date(timestamp);
        
        // Convert to Central Time (simplified - in production use proper timezone library)
        const hour = date.getHours();
        const minute = date.getMinutes();
        const timeInMinutes = hour * 60 + minute;
        
        const rthStart = this.params.rthStartHour * 60 + this.params.rthStartMinute; // 8:30 AM = 510 minutes
        const rthEnd = this.params.rthEndHour * 60 + this.params.rthEndMinute;     // 3:15 PM = 915 minutes
        
        // Check if it's a weekday (simplified)
        const dayOfWeek = date.getDay();
        const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
        
        return isWeekday && timeInMinutes >= rthStart && timeInMinutes <= rthEnd;
    }
    
    /**
     * Update candle data with RTH tracking
     */
    updateCandle(price, volume, timestamp) {
        const candleTime = new Date(timestamp);
        candleTime.setSeconds(0, 0); // Round to minute
        const candleTimeMs = candleTime.getTime();
        
        // Check if we need to start a new candle (5-minute periods)
        const candlePeriod = Math.floor(candleTimeMs / this.params.candlePeriodMs) * this.params.candlePeriodMs;
        
        // Check if this data point is within RTH
        const isRTH = this.isWithinRTH(timestamp);
        
        if (!this.lastCandleTime || candlePeriod !== this.lastCandleTime) {
            // Close previous candle
            if (this.currentCandle && this.currentCandle.close !== null) {
                this.currentCandle.isRTH = this.currentCandle.isRTH || false;
                this.candles.push({ ...this.currentCandle });
                
                if (this.currentCandle.isRTH) {
                    this.state.rthDataPointsToday++;
                }
                
                // Maintain candle history limit
                if (this.candles.length > this.params.maxCandleHistory) {
                    this.candles = this.candles.slice(-this.params.maxCandleHistory);
                }
            }
            
            // Start new candle
            this.currentCandle = {
                timestamp: candlePeriod,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: volume,
                isRTH: isRTH
            };
            this.lastCandleTime = candlePeriod;
            
            this.state.dataPointsCollected++;
            return true; // Candle changed
        } else {
            // Update current candle
            this.currentCandle.high = Math.max(this.currentCandle.high, price);
            this.currentCandle.low = Math.min(this.currentCandle.low, price);
            this.currentCandle.close = price;
            this.currentCandle.volume += volume;
            
            if (isRTH) {
                this.currentCandle.isRTH = true;
            }
            
            return false; // Same candle
        }
    }
    
    /**
     * Main strategy method - processes real-time market data
     */
    async processMarketData(price, volume = 1000, timestamp = null) {
        try {
            if (!timestamp) timestamp = new Date();
            
            // Validate inputs
            if (price === null || price === undefined || isNaN(price)) {
                return {
                    ready: false,
                    signal: null,
                    debug: { reason: 'Invalid price data' }
                };
            }
            
            // Update candle data
            const candleChanged = this.updateCandle(price, volume, timestamp);
            
            // Check if we have sufficient data for strategy
            if (!this.isStrategyReady()) {
                return {
                    ready: false,
                    signal: null,
                    debug: { 
                        reason: 'Strategy initializing', 
                        dataPoints: this.state.dataPointsCollected,
                        rthDataPoints: this.state.rthDataPointsToday,
                        pdhPdlValid: this.state.pdhPdlLevels.validRthCalculation,
                        bootstrapped: this.state.pdhPdlLevels.bootstrapped
                    }
                };
            }
            
            // Simple signal generation for testing
            let signal = null;
            
            // Check for PDH breakout
            if (price > this.state.pdhPdlLevels.pdh + (this.params.breakoutBufferTicks * this.contractSpecs.tickSize)) {
                signal = {
                    type: 'BUY',
                    strategy: 'PDH_BREAKOUT',
                    entry: price,
                    stopLoss: this.state.pdhPdlLevels.pdh - (this.params.mgcBreakoutStopTicks * this.contractSpecs.tickSize),
                    takeProfit: price + (this.params.mgcBreakoutStopTicks * 2 * this.contractSpecs.tickSize),
                    confidence: 'HIGH',
                    timestamp: timestamp
                };
            }
            // Check for PDL breakout
            else if (price < this.state.pdhPdlLevels.pdl - (this.params.breakoutBufferTicks * this.contractSpecs.tickSize)) {
                signal = {
                    type: 'SELL',
                    strategy: 'PDL_BREAKOUT',
                    entry: price,
                    stopLoss: this.state.pdhPdlLevels.pdl + (this.params.mgcBreakoutStopTicks * this.contractSpecs.tickSize),
                    takeProfit: price - (this.params.mgcBreakoutStopTicks * 2 * this.contractSpecs.tickSize),
                    confidence: 'HIGH',
                    timestamp: timestamp
                };
            }
            
            return {
                ready: true,
                signal: signal,
                debug: {
                    currentPrice: price,
                    pdh: this.state.pdhPdlLevels.pdh,
                    pdl: this.state.pdhPdlLevels.pdl,
                    bootstrapped: this.state.pdhPdlLevels.bootstrapped
                }
            };
            
        } catch (error) {
            console.error(`❌ Error in processMarketData:`, error);
            return {
                ready: false,
                signal: null,
                debug: { reason: 'Processing error', error: error.message }
            };
        }
    }
}

module.exports = PDHPDLStrategy;