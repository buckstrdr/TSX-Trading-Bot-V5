/**
 * PDH/PDL Daily Flip Strategy - Comprehensive Implementation
 * Based on detailed concept document requirements
 * Compatible with TSX Trading Bot V5 Framework
 * 
 * Implements all critical components from concept document:
 * - Proper RTH filtering (8:30 AM - 3:15 PM CT)
 * - Volume Profile analysis (POC, HVN, LVN)
 * - Cumulative Delta calculation
 * - ADX market structure analysis
 * - Liquidity Sweep detection
 * - Time-based strategy optimization
 * - MGC-specific parameters
 * 
 * Target: 60-70% win rates documented in concept research
 */

const fs = require('fs').promises;
const path = require('path');

class PDHPDLStrategy {
    constructor(config = {}, mainBot = null) {
        this.name = 'PDH_PDL_COMPREHENSIVE';
        this.version = '2.0';
        this.mainBot = mainBot;
        
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
            
            // Volume Profile Configuration
            enableVolumeProfile: config.enableVolumeProfile !== false,
            volumeProfileBins: config.volumeProfileBins || 50,
            pocThreshold: config.pocThreshold || 0.70, // 70% of volume for POC zone
            hvnThreshold: config.hvnThreshold || 1.5,  // 1.5x average volume for HVN
            lvnThreshold: config.lvnThreshold || 0.5,  // 0.5x average volume for LVN
            
            // PDH/PDL Specific Parameters
            volumeConfirmationMultiplier: config.volumeConfirmationMultiplier || 1.5,
            breakoutBufferTicks: config.breakoutBufferTicks || 2,
            
            // MGC-specific stop configurations (from concept document)
            mgcBreakoutStopTicks: config.mgcBreakoutStopTicks || 10,  // 8-12 range
            mgcFadeStopTicks: config.mgcFadeStopTicks || 8,           // 5-10 range
            mgcLiquiditySweepStopTicks: config.mgcLiquiditySweepStopTicks || 6,
            
            // Cumulative Delta Configuration
            enableCumulativeDelta: config.enableCumulativeDelta !== false,
            cumulativeDeltaThreshold: config.cumulativeDeltaThreshold || 0, // Must be positive for long
            cumulativeDeltaPeriod: config.cumulativeDeltaPeriod || 20,
            
            // ADX Configuration for Market Structure
            adxPeriod: config.adxPeriod || 14,
            adxTrendingThreshold: config.adxTrendingThreshold || 25,    // ADX > 25 = trending
            adxRangingThreshold: config.adxRangingThreshold || 20,      // ADX < 20 = ranging
            
            // Liquidity Sweep Configuration  
            enableLiquiditySweeps: config.enableLiquiditySweeps !== false,
            liquiditySweepPenetrationTicks: config.liquiditySweepPenetrationTicks || 3,
            liquiditySweepReversalTicks: config.liquiditySweepReversalTicks || 5,
            liquiditySweepMaxBars: config.liquiditySweepMaxBars || 3,
            
            // Strategy Selection
            enableBreakoutStrategy: config.enableBreakoutStrategy !== false,
            enableFadeStrategy: config.enableFadeStrategy !== false,
            enableLiquiditySweepStrategy: config.enableLiquiditySweepStrategy !== false,
            
            // Time-Based Optimization (from concept document)
            enableTimeBasedOptimization: config.enableTimeBasedOptimization !== false,
            nyMorningSessionStart: '09:30',  // 9:30 AM ET (best for breakouts)
            nyMorningSessionEnd: '11:30',    // 11:30 AM ET
            londonNyOverlapStart: '08:30',   // 8:30 AM ET (max volatility)
            londonNyOverlapEnd: '10:30',     // 10:30 AM ET
            nyAfternoonStart: '14:00',       // 2:00 PM ET (best for fades)
            nyAfternoonEnd: '15:00',         // 3:00 PM ET
            
            // Time-based position sizing (from concept document)
            enableTimeDecay: config.enableTimeDecay !== false,
            stopNewSignalsAt: config.stopNewSignalsAt || '20:55', // 8:55 PM CT
            
            // General settings
            candlePeriodMs: config.candlePeriodMs || 300000, // 5 minutes
            maxCandleHistory: config.maxCandleHistory || 200,
            indicatorLookback: config.indicatorLookback || 50,
            maxSignalsPerDay: config.maxSignalsPerDay || 6,
            signalCooldownMs: config.signalCooldownMs || 300000 // 5 minutes
        };
        
        // Strategy state
        this.state = {
            // Position and signal tracking
            currentPosition: null,
            lastSignalTime: null,
            lastPositionBlockLog: null,
            signalsToday: 0,
            
            // PDH/PDL levels with RTH validation
            pdhPdlLevels: {
                pdh: null,
                pdl: null,
                range: null,
                midpoint: null,
                calculatedAt: null,
                tradeDate: null,
                rthDataPoints: 0,
                validRthCalculation: false
            },
            
            // Volume Profile data
            volumeProfile: {
                poc: null,              // Point of Control
                pocZone: {             // POC zone (70% volume)
                    upper: null,
                    lower: null
                },
                hvnLevels: [],         // High Volume Nodes
                lvnLevels: [],         // Low Volume Nodes
                lastCalculated: null,
                totalVolume: 0
            },
            
            // Technical indicators
            indicators: {
                vwap: null,
                atr: null,
                adx: null,
                adxTrend: 'NEUTRAL',   // TRENDING, RANGING, NEUTRAL
                volumeAvg: null,
                cumulativeDelta: null,
                lastUpdate: null
            },
            
            // Market structure and session analysis
            marketStructure: 'NEUTRAL', // TRENDING_UP, TRENDING_DOWN, RANGE_BOUND
            sessionPhase: 'PRE_MARKET', // NY_MORNING, LONDON_NY_OVERLAP, NY_AFTERNOON, etc.
            optimalStrategyType: 'NONE', // BREAKOUT, FADE, LIQUIDITY_SWEEP
            
            // Liquidity sweep tracking
            liquiditySweeps: {
                pdhSweeps: [],         // Recent PDH sweep attempts
                pdlSweeps: [],         // Recent PDL sweep attempts
                lastSweepTime: null
            },
            
            // Signal strength scoring (1-10 scale)
            signalStrengths: {
                breakout: 0,
                fade: 0,
                liquiditySweep: 0,
                overall: 0
            },
            
            // Strategy readiness and performance
            isReady: false,
            dataPointsCollected: 0,
            rthDataPointsToday: 0,
            initializationTime: Date.now()
        };
        
        // Market data tracking
        this.candles = [];
        this.currentCandle = null;
        this.lastCandleTime = null;
        
        // Enhanced data tracking for advanced calculations
        this.priceVolumeData = [];     // For volume profile calculation
        this.tickData = [];            // For cumulative delta (simulated from candle data)
        this.adxData = {               // For ADX calculation
            trueRange: [],
            plusDM: [],
            minusDM: []
        };
        
        console.log(`📊 ${this.name} v${this.version} initialized`);
        console.log(`🥇 Target: MGC (Micro Gold Futures)`);
        console.log(`💰 Risk per trade: $${this.params.dollarRiskPerTrade}`);
        console.log(`⏰ RTH Session: ${this.params.rthStartHour}:${this.params.rthStartMinute} - ${this.params.rthEndHour}:${this.params.rthEndMinute} CT`);
        console.log(`📈 Volume Profile: ${this.params.enableVolumeProfile ? 'ENABLED' : 'DISABLED'}`);
        console.log(`🔄 Cumulative Delta: ${this.params.enableCumulativeDelta ? 'ENABLED' : 'DISABLED'}`);
        console.log(`🌊 Liquidity Sweeps: ${this.params.enableLiquiditySweeps ? 'ENABLED' : 'DISABLED'}`);
        
        // Auto-bootstrap with historical data
        this.initializeWithHistoricalData();
    }
    
    /**
     * Bootstrap strategy with historical data for immediate signal generation
     * Uses Connection Manager API to load last 60 5-minute candles + previous day data
     */
    async initializeWithHistoricalData() {
        try {
            console.log(`🚀 [BOOTSTRAP] Starting historical data initialization...`);
            
            // Calculate time windows - need at least 48 hours to ensure we get previous trading day
            const now = new Date();
            const endTime = new Date(now);
            const startTime = new Date(now.getTime() - (48 * 60 * 60 * 1000)); // 48 hours ago
            
            console.log(`📅 [BOOTSTRAP] Requesting historical data from ${startTime.toISOString()} to ${endTime.toISOString()}`);
            
            // Prepare API request for historical bars
            const requestData = {
                contractId: "F.US.MGC",  // MGC futures contract
                live: false,             // Always FALSE for historical bars (practice & express accounts)
                startTime: startTime.toISOString(),
                endTime: endTime.toISOString(),
                unit: 2,                 // 2 = Minute
                unitNumber: 5,           // 5-minute candles
                limit: 1000,             // Get last 1000 bars (should cover 48+ hours)
                includePartialBar: false // Don't include current incomplete bar
            };
            
            console.log(`🔍 [BOOTSTRAP] API Request:`, JSON.stringify(requestData, null, 2));
            
            // Make HTTP request to Connection Manager
            const response = await this.fetchHistoricalData(requestData);
            
            if (response && response.success && response.bars && response.bars.length > 0) {
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
                
                // Process historical bars through existing market data pipeline for other indicators
                let processedCount = 0;
                for (const bar of response.bars) {
                    const timestamp = new Date(bar.t);
                    const price = bar.c; // Use close price
                    const volume = bar.v || 1000; // Use actual volume or fallback
                    
                    // Process through existing market data method (without signals)
                    await this.processHistoricalBar(price, volume, timestamp);
                    processedCount++;
                    
                    // Log progress every 50 bars
                    if (processedCount % 50 === 0) {
                        console.log(`📊 [BOOTSTRAP] Processed ${processedCount}/${response.bars.length} bars - Data Points: ${this.state.dataPointsCollected}, RTH: ${this.state.rthDataPointsToday}`);
                    }
                }
                
                console.log(`🎯 [BOOTSTRAP] Complete! Processed ${processedCount} bars`);
                console.log(`📊 [BOOTSTRAP] Final state - Data Points: ${this.state.dataPointsCollected}, RTH Points: ${this.state.rthDataPointsToday}`);
                console.log(`✨ [BOOTSTRAP] Strategy Ready: ${this.isStrategyReady()}`);
                
                if (this.isStrategyReady()) {
                    console.log(`🚀 [BOOTSTRAP] SUCCESS! Strategy is ready for immediate signal generation`);
                    console.log(`📈 [BOOTSTRAP] PDH: ${this.state.pdhPdlLevels.pdh}, PDL: ${this.state.pdhPdlLevels.pdl}`);
                } else {
                    console.log(`⚠️ [BOOTSTRAP] Strategy not ready yet - may need more RTH data or valid PDH/PDL calculation`);
                }
                
            } else {
                console.log(`❌ [BOOTSTRAP] Failed to retrieve historical data:`, response);
                console.log(`⚠️ [BOOTSTRAP] Strategy will collect data from live feed (slower initialization)`);
            }
            
        } catch (error) {
            console.error(`💥 [BOOTSTRAP] Error during initialization:`, error);
            console.log(`⚠️ [BOOTSTRAP] Falling back to live data collection`);
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
     * HTTP client to fetch historical data from Connection Manager
     */
    async fetchHistoricalData(requestData) {
        const http = require('http');
        const querystring = require('querystring');
        
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify(requestData);
            
            const options = {
                hostname: 'localhost',
                port: 7500,  // Connection Manager port
                path: '/api/History/retrieveBars',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };
            
            console.log(`🌐 [BOOTSTRAP] Making HTTP request to http://localhost:7500/api/History/retrieveBars`);
            
            const req = http.request(options, (res) => {
                let data = '';
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        console.log(`📡 [BOOTSTRAP] API Response: ${res.statusCode} - Success: ${response.success}`);
                        resolve(response);
                    } catch (error) {
                        console.error(`🔥 [BOOTSTRAP] Error parsing response:`, error);
                        reject(error);
                    }
                });
            });
            
            req.on('error', (error) => {
                console.error(`💥 [BOOTSTRAP] HTTP request error:`, error);
                reject(error);
            });
            
            req.write(postData);
            req.end();
        });
    }
    
    /**
     * Process historical bar data without generating trading signals
     * Similar to processMarketData but optimized for initialization
     */
    async processHistoricalBar(price, volume, timestamp) {
        try {
            // Update candle data and track RTH periods
            const candleChanged = this.updateCandle(price, volume, timestamp);
            
            // Update session analysis for time-based calculations
            this.updateSessionAnalysis(timestamp);
            
            // Update comprehensive analysis when candle changes
            if (candleChanged) {
                await this.updateComprehensiveAnalysis(timestamp);
            }
            
            // No signal generation during bootstrap - just data collection
            return {
                ready: this.isStrategyReady(),
                bootstrap: true,
                dataPoints: this.state.dataPointsCollected,
                rthDataPoints: this.state.rthDataPointsToday
            };
            
        } catch (error) {
            console.error(`💥 [BOOTSTRAP] Error processing historical bar:`, error);
            return { ready: false, bootstrap: true, error: error.message };
        }
    }
    
    /**
     * Main strategy method - processes real-time market data
     * Enhanced with comprehensive signal generation
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
            
            // Update candle data and track RTH periods
            const candleChanged = this.updateCandle(price, volume, timestamp);
            
            // Update session phase and optimal strategy type
            this.updateSessionAnalysis(timestamp);
            
            // Check if we have sufficient data for strategy
            if (!this.isStrategyReady()) {
                return {
                    ready: false,
                    signal: null,
                    debug: { 
                        reason: 'Strategy initializing', 
                        dataPoints: this.state.dataPointsCollected,
                        rthDataPoints: this.state.rthDataPointsToday
                    }
                };
            }
            
            // Update all calculations when candle changes
            if (candleChanged) {
                await this.updateComprehensiveAnalysis(timestamp);
            }
            
            // Generate trading signal using comprehensive analysis
            const signal = await this.generateComprehensiveSignal(price, timestamp);
            
            // Analyze current market environment
            const environment = this.analyzeMarketEnvironment(price, timestamp);
            
            return {
                ready: true,
                signal: signal,
                environment: environment,
                debug: {
                    reason: signal ? `${signal.subStrategy} signal (${signal.confidence})` : 'Monitoring',
                    sessionPhase: this.state.sessionPhase,
                    optimalStrategy: this.state.optimalStrategyType,
                    adxTrend: this.state.indicators.adxTrend,
                    pdh: this.state.pdhPdlLevels.pdh?.toFixed(2),
                    pdl: this.state.pdhPdlLevels.pdl?.toFixed(2),
                    poc: this.state.volumeProfile.poc?.toFixed(2),
                    cumulativeDelta: this.state.indicators.cumulativeDelta
                }
            };
            
        } catch (error) {
            console.log(`❌ ${this.name} Error: ${error.message}`);
            console.log(`🔍 Stack: ${error.stack}`);
            return {
                ready: false,
                signal: null,
                debug: { reason: 'Processing error', error: error.message }
            };
        }
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
                // Mark candle as RTH if it occurred during regular trading hours
                this.currentCandle.isRTH = this.currentCandle.isRTH || false;
                
                this.candles.push({ ...this.currentCandle });
                
                // Track RTH data points
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
                isRTH: isRTH,
                cumulativeDelta: 0 // Will be calculated
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
            
            // Update RTH status if this tick is within RTH
            if (isRTH) {
                this.currentCandle.isRTH = true;
            }
            
            return false; // Same candle
        }
    }
    
    /**
     * Check if timestamp is within Regular Trading Hours (8:30 AM - 3:15 PM CT)
     * Critical for accurate PDH/PDL calculation
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
     * Update session analysis and optimal strategy type
     * Based on time-of-day optimization from concept document
     */
    updateSessionAnalysis(timestamp) {
        const date = new Date(timestamp);
        const hour = date.getHours();
        const minute = date.getMinutes();
        const timeString = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
        
        // Determine session phase (convert CT to ET for NY sessions)
        const etHour = hour + 1; // Simplified CT to ET conversion
        const etTimeString = `${etHour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
        
        if (etTimeString >= '09:30' && etTimeString < '11:30') {
            this.state.sessionPhase = 'NY_MORNING';
            this.state.optimalStrategyType = 'BREAKOUT'; // Best for breakouts per concept
        } else if (etTimeString >= '08:30' && etTimeString < '10:30') {
            this.state.sessionPhase = 'LONDON_NY_OVERLAP';
            this.state.optimalStrategyType = 'LIQUIDITY_SWEEP'; // Max volatility per concept
        } else if (etTimeString >= '14:00' && etTimeString < '15:00') {
            this.state.sessionPhase = 'NY_AFTERNOON';
            this.state.optimalStrategyType = 'FADE'; // Best for fades per concept
        } else if (hour >= 15 && hour < 21) {
            this.state.sessionPhase = 'EVENING';
            this.state.optimalStrategyType = 'FADE'; // Lower volume, mean reversion
        } else {
            this.state.sessionPhase = 'AFTER_HOURS';
            this.state.optimalStrategyType = 'NONE';
        }
    }
    
    /**
     * Comprehensive analysis update when candle closes
     * Updates PDH/PDL, indicators, volume profile, etc.
     */
    async updateComprehensiveAnalysis(timestamp) {
        try {
            // Update PDH/PDL levels using proper RTH filtering
            await this.updateRTHPDHPDLLevels(timestamp);
            
            // Update all technical indicators
            await this.updateAllTechnicalIndicators();
            
            // Update volume profile analysis
            if (this.params.enableVolumeProfile) {
                await this.updateVolumeProfile();
            }
            
            // Update liquidity sweep tracking
            if (this.params.enableLiquiditySweeps) {
                await this.updateLiquiditySweepTracking();
            }
            
            // Update market structure based on ADX
            this.updateMarketStructure();
            
        } catch (error) {
            console.log(`⚠️ Error in comprehensive analysis: ${error.message}`);
        }
    }
    
    /**
     * Calculate PDH/PDL levels using proper RTH filtering
     * Critical improvement from basic implementation
     */
    async updateRTHPDHPDLLevels(timestamp) {
        const currentDate = new Date(timestamp).toDateString();
        
        // Only recalculate if we have a new trading day
        if (this.state.pdhPdlLevels.tradeDate === currentDate) {
            return;
        }
        
        // Skip if PDH/PDL was already bootstrapped from historical data for today
        if (this.state.pdhPdlLevels.bootstrapped && this.state.pdhPdlLevels.tradeDate === currentDate) {
            console.log(`📊 [PDH/PDL] Using bootstrapped values - PDH: ${this.state.pdhPdlLevels.pdh?.toFixed(2)}, PDL: ${this.state.pdhPdlLevels.pdl?.toFixed(2)}`);
            return;
        }
        
        try {
            // Get previous trading day's RTH data only
            const rthCandles = this.getRTHCandlesFromPreviousDay(timestamp);
            
            if (rthCandles.length >= 20) { // Sufficient RTH data
                const pdh = Math.max(...rthCandles.map(c => c.high));
                const pdl = Math.min(...rthCandles.map(c => c.low));
                const range = pdh - pdl;
                const midpoint = (pdh + pdl) / 2;
                
                this.state.pdhPdlLevels = {
                    pdh: pdh,
                    pdl: pdl,
                    range: range,
                    midpoint: midpoint,
                    calculatedAt: timestamp,
                    tradeDate: currentDate,
                    rthDataPoints: rthCandles.length,
                    validRthCalculation: true
                };
                
                if (!this.isQuietModeActive()) {
                    console.log(`📈 RTH PDH/PDL Updated:`);
                    console.log(`   PDH: ${pdh.toFixed(2)} | PDL: ${pdl.toFixed(2)} | Range: ${range.toFixed(2)}`);
                    console.log(`   RTH Data Points: ${rthCandles.length} | Valid: ${this.state.pdhPdlLevels.validRthCalculation}`);
                }
            } else {
                console.log(`⚠️ Insufficient RTH data for PDH/PDL: ${rthCandles.length} candles`);
                this.state.pdhPdlLevels.validRthCalculation = false;
            }
        } catch (error) {
            console.log(`❌ Error calculating RTH PDH/PDL: ${error.message}`);
            this.state.pdhPdlLevels.validRthCalculation = false;
        }
    }
    
    /**
     * Get RTH candles from previous trading day
     */
    getRTHCandlesFromPreviousDay(currentTimestamp) {
        // Filter candles that were marked as RTH
        const rthCandles = this.candles.filter(candle => candle.isRTH);
        
        // In a more sophisticated implementation, we would:
        // 1. Determine the actual previous trading day
        // 2. Get candles only from that specific date's RTH session
        // 3. Handle holidays and weekends properly
        
        // For now, use the most recent RTH candles (last 50-100 RTH periods)
        const recentRthCandles = rthCandles.slice(-78); // ~6.5 hours of 5-min RTH candles
        
        return recentRthCandles;
    }
    
    /**
     * Update all technical indicators
     */
    async updateAllTechnicalIndicators() {
        if (this.candles.length < this.params.indicatorLookback) return;
        
        try {
            // Calculate VWAP (Volume Weighted Average Price)
            this.state.indicators.vwap = this.calculateVWAP();
            
            // Calculate ATR (Average True Range)
            this.state.indicators.atr = this.calculateATR(14);
            
            // Calculate ADX (Average Directional Index) - Critical for market structure
            this.state.indicators.adx = this.calculateADX(this.params.adxPeriod);
            
            // Calculate average volume
            this.state.indicators.volumeAvg = this.calculateAverageVolume(20);
            
            // Calculate Cumulative Delta if enabled
            if (this.params.enableCumulativeDelta) {
                this.state.indicators.cumulativeDelta = this.calculateCumulativeDelta();
            }
            
            this.state.indicators.lastUpdate = Date.now();
        } catch (error) {
            console.log(`⚠️ Error updating technical indicators: ${error.message}`);
        }
    }
    
    /**
     * Calculate ADX (Average Directional Index)
     * Critical for determining trending vs ranging markets
     */
    calculateADX(period = 14) {
        if (this.candles.length < period + 1) return null;
        
        const recentCandles = this.candles.slice(-(period + 10)); // Extra data for calculation
        
        // Calculate True Range, +DM, -DM
        const trueRanges = [];
        const plusDMs = [];
        const minusDMs = [];
        
        for (let i = 1; i < recentCandles.length; i++) {
            const current = recentCandles[i];
            const previous = recentCandles[i - 1];
            
            // True Range
            const tr = Math.max(
                current.high - current.low,
                Math.abs(current.high - previous.close),
                Math.abs(current.low - previous.close)
            );
            trueRanges.push(tr);
            
            // Directional Movement
            const plusDM = Math.max(current.high - previous.high, 0);
            const minusDM = Math.max(previous.low - current.low, 0);
            
            // Only count if it's the dominant direction
            if (plusDM > minusDM && plusDM > 0) {
                plusDMs.push(plusDM);
                minusDMs.push(0);
            } else if (minusDM > plusDM && minusDM > 0) {
                plusDMs.push(0);
                minusDMs.push(minusDM);
            } else {
                plusDMs.push(0);
                minusDMs.push(0);
            }
        }
        
        if (trueRanges.length < period) return null;
        
        // Calculate smoothed averages
        const atr = this.calculateSMA(trueRanges.slice(-period), period);
        const plusDI = (this.calculateSMA(plusDMs.slice(-period), period) / atr) * 100;
        const minusDI = (this.calculateSMA(minusDMs.slice(-period), period) / atr) * 100;
        
        // Calculate DX and ADX
        const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
        const adx = dx; // Simplified - should be smoothed average of DX values
        
        // Update trend classification based on ADX thresholds
        if (adx > this.params.adxTrendingThreshold) {
            this.state.indicators.adxTrend = 'TRENDING';
        } else if (adx < this.params.adxRangingThreshold) {
            this.state.indicators.adxTrend = 'RANGING';
        } else {
            this.state.indicators.adxTrend = 'NEUTRAL';
        }
        
        return adx;
    }
    
    /**
     * Calculate Cumulative Delta
     * Critical for order flow analysis mentioned in concept document
     */
    calculateCumulativeDelta() {
        if (this.candles.length < this.params.cumulativeDeltaPeriod) return null;
        
        // Simplified cumulative delta calculation from OHLC data
        // In a real implementation, this would use tick-by-tick bid/ask data
        let cumulativeDelta = 0;
        
        const recentCandles = this.candles.slice(-this.params.cumulativeDeltaPeriod);
        
        recentCandles.forEach(candle => {
            // Estimate buying vs selling pressure from price action
            const bodySize = Math.abs(candle.close - candle.open);
            const totalRange = candle.high - candle.low;
            
            if (totalRange > 0) {
                // Green candle = buying pressure
                if (candle.close > candle.open) {
                    const buyingPressure = (bodySize / totalRange) * candle.volume;
                    cumulativeDelta += buyingPressure;
                }
                // Red candle = selling pressure
                else if (candle.close < candle.open) {
                    const sellingPressure = (bodySize / totalRange) * candle.volume;
                    cumulativeDelta -= sellingPressure;
                }
                // Doji = neutral
            }
        });
        
        return cumulativeDelta;
    }
    
    /**
     * Professional Volume Profile analysis using advanced methods from volume_profile_guide.md
     * Implements sophisticated POC, HVN clustering, and LVN gap detection
     */
    async updateVolumeProfile() {
        if (this.candles.length < 50) return;
        
        try {
            const recentCandles = this.candles.slice(-100);
            
            // Build price-volume map with tick-level precision
            const volumeByPrice = new Map();
            const tickSize = this.contractSpecs.tickSize;
            let totalVolume = 0;
            
            // Collect volume at each tick-rounded price level
            recentCandles.forEach(candle => {
                // Distribute volume across OHLC range (more accurate than midpoint)
                const priceRange = candle.high - candle.low;
                if (priceRange > 0) {
                    const volumePerTick = candle.volume / (priceRange / tickSize);
                    
                    for (let price = candle.low; price <= candle.high; price += tickSize) {
                        const roundedPrice = Math.round(price / tickSize) * tickSize;
                        const currentVol = volumeByPrice.get(roundedPrice) || 0;
                        volumeByPrice.set(roundedPrice, currentVol + volumePerTick);
                        totalVolume += volumePerTick;
                    }
                } else {
                    // Single tick candle - all volume at one price
                    const roundedPrice = Math.round(candle.close / tickSize) * tickSize;
                    const currentVol = volumeByPrice.get(roundedPrice) || 0;
                    volumeByPrice.set(roundedPrice, currentVol + candle.volume);
                    totalVolume += candle.volume;
                }
            });
            
            // Convert to sorted price array for analysis
            const priceArray = Array.from(volumeByPrice.entries())
                .sort((a, b) => a[0] - b[0])
                .map(([price, volume]) => ({ price, volume }));
                
            if (priceArray.length < 10) return; // Insufficient data
            
            // 1. Calculate Professional POC
            const poc = this.calculateProfessionalPOC(priceArray, totalVolume);
            
            // 2. Find HVN Clusters (not just individual levels)
            const hvnClusters = this.findHVNClusters(priceArray, totalVolume);
            
            // 3. Find LVN Gaps (continuous low-volume zones)
            const lvnGaps = this.findLVNGaps(priceArray, totalVolume);
            
            // 4. Calculate POC zone based on volume-weighted method
            const pocZone = this.calculatePOCZone(poc, priceArray, totalVolume);
            
            // Update volume profile state with professional analysis
            this.state.volumeProfile = {
                // POC data
                poc: poc.price,
                pocStrength: poc.strength,
                pocPercentOfTotal: poc.percentOfTotal,
                pocZone: pocZone,
                
                // HVN clusters with detailed analysis
                hvnLevels: hvnClusters.slice(0, 8), // Top 8 HVN clusters
                
                // LVN gaps with classification
                lvnLevels: lvnGaps.slice(0, 8), // Top 8 LVN gaps
                
                // Profile metadata
                lastCalculated: Date.now(),
                totalVolume: totalVolume,
                priceRange: {
                    high: Math.max(...priceArray.map(p => p.price)),
                    low: Math.min(...priceArray.map(p => p.price))
                },
                profileQuality: this.assessProfileQuality(priceArray, totalVolume)
            };
            
            if (!this.isQuietModeActive()) {
                console.log(`📊 Professional Volume Profile Updated:`);
                console.log(`   POC: ${poc.price.toFixed(2)} (${poc.strength}, ${poc.percentOfTotal}% of volume)`);
                console.log(`   HVN Clusters: ${hvnClusters.length} | LVN Gaps: ${lvnGaps.length}`);
                console.log(`   Profile Quality: ${this.state.volumeProfile.profileQuality}`);
            }
            
        } catch (error) {
            console.log(`⚠️ Error updating professional volume profile: ${error.message}`);
        }
    }
    
    /**
     * Calculate POC with both simple and volume-weighted methods
     */
    calculateProfessionalPOC(priceArray, totalVolume) {
        // Method 1: Simple highest volume
        const simplePOC = priceArray.reduce((max, current) => 
            current.volume > max.volume ? current : max
        );
        
        // Method 2: Volume-weighted POC (more accurate for wide ranges)
        let cumulativeVolume = 0;
        let volumeWeightedPOC = null;
        
        for (const level of priceArray) {
            cumulativeVolume += level.volume;
            if (cumulativeVolume >= totalVolume / 2) {
                volumeWeightedPOC = level;
                break;
            }
        }
        
        // Use the more reliable method
        const poc = volumeWeightedPOC || simplePOC;
        const avgVolume = totalVolume / priceArray.length;
        const volumeRatio = poc.volume / avgVolume;
        
        // Calculate POC strength
        let strength;
        if (volumeRatio > 3) strength = 'VERY_STRONG';
        else if (volumeRatio > 2) strength = 'STRONG';
        else if (volumeRatio > 1.5) strength = 'MODERATE';
        else strength = 'WEAK';
        
        return {
            price: poc.price,
            volume: poc.volume,
            percentOfTotal: ((poc.volume / totalVolume) * 100).toFixed(1),
            strength: strength,
            volumeRatio: volumeRatio
        };
    }
    
    /**
     * Find HVN clusters using peak detection and expansion
     */
    findHVNClusters(priceArray, totalVolume) {
        const avgVolume = totalVolume / priceArray.length;
        const hvnThreshold = avgVolume * 1.7; // 70% above average
        const clusters = [];
        
        // Find peaks in volume distribution
        for (let i = 1; i < priceArray.length - 1; i++) {
            const current = priceArray[i];
            const prev = priceArray[i - 1];
            const next = priceArray[i + 1];
            
            // Check if this is a local peak and above threshold
            if (current.volume > hvnThreshold &&
                current.volume > prev.volume &&
                current.volume > next.volume) {
                
                // Expand cluster around the peak
                const cluster = this.expandHVNCluster(priceArray, i, hvnThreshold);
                
                if (cluster) {
                    clusters.push({
                        centerPrice: current.price,
                        peakVolume: current.volume,
                        clusterHigh: cluster.high,
                        clusterLow: cluster.low,
                        totalClusterVolume: cluster.volume,
                        percentOfDayVolume: ((cluster.volume / totalVolume) * 100).toFixed(1),
                        priceRange: cluster.high - cluster.low,
                        priceRangeInTicks: Math.round((cluster.high - cluster.low) / this.contractSpecs.tickSize),
                        significance: this.rateHVNSignificance(cluster, totalVolume),
                        type: 'HVN_CLUSTER'
                    });
                    
                    // Skip processed cluster
                    i = cluster.endIndex;
                }
            }
        }
        
        return clusters.sort((a, b) => b.totalClusterVolume - a.totalClusterVolume);
    }
    
    /**
     * Expand HVN cluster around peak
     */
    expandHVNCluster(priceArray, peakIndex, threshold) {
        let startIdx = peakIndex;
        let endIdx = peakIndex;
        let clusterVolume = priceArray[peakIndex].volume;
        
        // Expand left while volume remains significant (70% of threshold)
        while (startIdx > 0 && priceArray[startIdx - 1].volume > threshold * 0.7) {
            startIdx--;
            clusterVolume += priceArray[startIdx].volume;
        }
        
        // Expand right while volume remains significant
        while (endIdx < priceArray.length - 1 && 
               priceArray[endIdx + 1].volume > threshold * 0.7) {
            endIdx++;
            clusterVolume += priceArray[endIdx].volume;
        }
        
        // Only return clusters with minimum size
        if (endIdx - startIdx >= 2) {
            return {
                high: priceArray[endIdx].price,
                low: priceArray[startIdx].price,
                volume: clusterVolume,
                endIndex: endIdx
            };
        }
        
        return null;
    }
    
    /**
     * Rate HVN significance based on volume and price range
     */
    rateHVNSignificance(cluster, totalVolume) {
        const percentOfTotal = cluster.volume / totalVolume;
        const priceSpanInTicks = (cluster.high - cluster.low) / this.contractSpecs.tickSize;
        
        if (percentOfTotal > 0.2 && priceSpanInTicks < 10) return 'MAJOR'; // Tight, high volume
        if (percentOfTotal > 0.15) return 'SIGNIFICANT';
        if (percentOfTotal > 0.1) return 'MODERATE';
        return 'MINOR';
    }
    
    /**
     * Find LVN gaps (continuous low-volume zones)
     */
    findLVNGaps(priceArray, totalVolume) {
        const avgVolume = totalVolume / priceArray.length;
        const lvnThreshold = avgVolume * 0.3; // 30% of average
        const gaps = [];
        
        let inLVN = false;
        let currentGap = null;
        
        for (let i = 0; i < priceArray.length; i++) {
            const level = priceArray[i];
            
            if (level.volume < lvnThreshold) {
                if (!inLVN) {
                    // Start of new LVN gap
                    inLVN = true;
                    currentGap = {
                        startPrice: level.price,
                        endPrice: level.price,
                        minVolume: level.volume,
                        totalVolume: level.volume,
                        levels: 1,
                        startIndex: i
                    };
                } else {
                    // Continue LVN gap
                    currentGap.endPrice = level.price;
                    currentGap.minVolume = Math.min(currentGap.minVolume, level.volume);
                    currentGap.totalVolume += level.volume;
                    currentGap.levels++;
                }
            } else if (inLVN) {
                // End of LVN gap
                inLVN = false;
                
                // Only record significant gaps (at least 3 price levels)
                if (currentGap.levels >= 3) {
                    const gapSize = currentGap.endPrice - currentGap.startPrice;
                    const gapSizeInTicks = Math.round(gapSize / this.contractSpecs.tickSize);
                    
                    gaps.push({
                        highBoundary: currentGap.endPrice,
                        lowBoundary: currentGap.startPrice,
                        centerPrice: (currentGap.endPrice + currentGap.startPrice) / 2,
                        gapSize: gapSize,
                        gapSizeInTicks: gapSizeInTicks,
                        avgVolume: currentGap.totalVolume / currentGap.levels,
                        minVolume: currentGap.minVolume,
                        strength: this.rateLVNStrength(currentGap, avgVolume),
                        type: this.classifyLVNType(i, currentGap, priceArray),
                        significance: gapSizeInTicks > 5 && currentGap.avgVolume < avgVolume * 0.2 ? 'HIGH' : 'NORMAL'
                    });
                }
                currentGap = null;
            }
        }
        
        return gaps.sort((a, b) => b.gapSizeInTicks - a.gapSizeInTicks);
    }
    
    /**
     * Rate LVN gap strength
     */
    rateLVNStrength(gap, avgVolume) {
        const volumeRatio = gap.avgVolume / avgVolume;
        const gapSizeInTicks = gap.gapSize / this.contractSpecs.tickSize;
        
        if (volumeRatio < 0.1 && gapSizeInTicks > 10) return 'EXTREME'; // Large void
        if (volumeRatio < 0.2 && gapSizeInTicks > 5) return 'STRONG';
        if (volumeRatio < 0.3) return 'MODERATE';
        return 'WEAK';
    }
    
    /**
     * Classify LVN type based on surrounding volume
     */
    classifyLVNType(index, gap, priceArray) {
        const startIdx = Math.max(0, gap.startIndex - 5);
        const endIdx = Math.min(priceArray.length - 1, index + 5);
        
        const prevHigh = startIdx < gap.startIndex ? 
            Math.max(...priceArray.slice(startIdx, gap.startIndex).map(l => l.volume)) : 0;
        const nextHigh = index < endIdx ? 
            Math.max(...priceArray.slice(index, endIdx).map(l => l.volume)) : 0;
        
        if (prevHigh > gap.avgVolume * 3 && nextHigh > gap.avgVolume * 3) {
            return 'SEPARATION'; // LVN between two HVN areas
        } else if (prevHigh > nextHigh * 2) {
            return 'REJECTION_UP'; // Price rejected higher prices
        } else if (nextHigh > prevHigh * 2) {
            return 'REJECTION_DOWN'; // Price rejected lower prices
        }
        return 'NEUTRAL';
    }
    
    /**
     * Calculate POC zone using volume-weighted method
     */
    calculatePOCZone(poc, priceArray, totalVolume) {
        // Find price levels around POC that contain 70% of volume
        const targetVolume = totalVolume * this.params.pocThreshold;
        let cumulativeVolume = poc.volume;
        
        // Find POC index
        let pocIndex = priceArray.findIndex(p => p.price === poc.price);
        if (pocIndex === -1) pocIndex = Math.floor(priceArray.length / 2);
        
        let upperIndex = pocIndex;
        let lowerIndex = pocIndex;
        
        // Expand zone to capture target volume
        while (cumulativeVolume < targetVolume && 
               (upperIndex < priceArray.length - 1 || lowerIndex > 0)) {
            
            const canExpandUp = upperIndex < priceArray.length - 1;
            const canExpandDown = lowerIndex > 0;
            
            if (canExpandUp && canExpandDown) {
                // Expand in direction with higher volume
                if (priceArray[upperIndex + 1].volume > priceArray[lowerIndex - 1].volume) {
                    upperIndex++;
                    cumulativeVolume += priceArray[upperIndex].volume;
                } else {
                    lowerIndex--;
                    cumulativeVolume += priceArray[lowerIndex].volume;
                }
            } else if (canExpandUp) {
                upperIndex++;
                cumulativeVolume += priceArray[upperIndex].volume;
            } else if (canExpandDown) {
                lowerIndex--;
                cumulativeVolume += priceArray[lowerIndex].volume;
            } else {
                break;
            }
        }
        
        return {
            upper: priceArray[upperIndex].price,
            lower: priceArray[lowerIndex].price,
            center: poc.price,
            volumeCaptured: cumulativeVolume,
            percentCaptured: ((cumulativeVolume / totalVolume) * 100).toFixed(1)
        };
    }
    
    /**
     * Assess overall profile quality
     */
    assessProfileQuality(priceArray, totalVolume) {
        const dataPoints = priceArray.length;
        const volumeConcentration = Math.max(...priceArray.map(p => p.volume)) / totalVolume;
        
        if (dataPoints > 30 && volumeConcentration > 0.15) return 'HIGH';
        if (dataPoints > 20 && volumeConcentration > 0.10) return 'GOOD';
        if (dataPoints > 10) return 'FAIR';
        return 'POOR';
    }
    
    /**
     * Update liquidity sweep tracking
     * Critical for identifying false breakouts and reversals
     */
    async updateLiquiditySweepTracking() {
        if (!this.state.pdhPdlLevels.pdh || !this.state.pdhPdlLevels.pdl) return;
        if (this.candles.length < 10) return;
        
        try {
            const currentPrice = this.candles[this.candles.length - 1].close;
            const currentTime = Date.now();
            const recentCandles = this.candles.slice(-this.params.liquiditySweepMaxBars);
            
            // Check for PDH liquidity sweep
            const pdhSweep = this.detectPDHLiquiditySweep(recentCandles, this.state.pdhPdlLevels.pdh);
            if (pdhSweep) {
                this.state.liquiditySweeps.pdhSweeps.push({
                    ...pdhSweep,
                    timestamp: currentTime
                });
                
                // Keep only recent sweeps (last hour)
                const oneHourAgo = currentTime - (60 * 60 * 1000);
                this.state.liquiditySweeps.pdhSweeps = this.state.liquiditySweeps.pdhSweeps
                    .filter(sweep => sweep.timestamp > oneHourAgo);
            }
            
            // Check for PDL liquidity sweep
            const pdlSweep = this.detectPDLLiquiditySweep(recentCandles, this.state.pdhPdlLevels.pdl);
            if (pdlSweep) {
                this.state.liquiditySweeps.pdlSweeps.push({
                    ...pdlSweep,
                    timestamp: currentTime
                });
                
                // Keep only recent sweeps (last hour)
                const oneHourAgo = currentTime - (60 * 60 * 1000);
                this.state.liquiditySweeps.pdlSweeps = this.state.liquiditySweeps.pdlSweeps
                    .filter(sweep => sweep.timestamp > oneHourAgo);
            }
            
            this.state.liquiditySweeps.lastSweepTime = currentTime;
            
        } catch (error) {
            console.log(`⚠️ Error updating liquidity sweep tracking: ${error.message}`);
        }
    }
    
    /**
     * Detect PDH liquidity sweep pattern
     * 65-70% success rate per concept document
     */
    detectPDHLiquiditySweep(recentCandles, pdhLevel) {
        if (recentCandles.length < 3) return null;
        
        const penetrationThreshold = pdhLevel + (this.params.liquiditySweepPenetrationTicks * this.contractSpecs.tickSize);
        const reversalThreshold = pdhLevel - (this.params.liquiditySweepReversalTicks * this.contractSpecs.tickSize);
        
        // Look for pattern: price penetrates PDH, then reverses back below
        let penetrated = false;
        let reversed = false;
        let penetrationCandle = null;
        let reversalCandle = null;
        
        for (let i = 0; i < recentCandles.length; i++) {
            const candle = recentCandles[i];
            
            // Check for penetration above PDH
            if (!penetrated && candle.high > penetrationThreshold) {
                penetrated = true;
                penetrationCandle = candle;
            }
            
            // Check for reversal back below PDH after penetration
            if (penetrated && !reversed && candle.close < reversalThreshold) {
                reversed = true;
                reversalCandle = candle;
                break;
            }
        }
        
        if (penetrated && reversed) {
            return {
                type: 'PDH_LIQUIDITY_SWEEP',
                level: pdhLevel,
                penetrationPrice: penetrationCandle.high,
                reversalPrice: reversalCandle.close,
                confidence: 0.70, // 70% success rate from concept document
                direction: 'BEARISH', // PDH sweep is bearish reversal signal
                strength: this.calculateSweepStrength(penetrationCandle, reversalCandle)
            };
        }
        
        return null;
    }
    
    /**
     * Detect PDL liquidity sweep pattern
     * 65-70% success rate per concept document
     */
    detectPDLLiquiditySweep(recentCandles, pdlLevel) {
        if (recentCandles.length < 3) return null;
        
        const penetrationThreshold = pdlLevel - (this.params.liquiditySweepPenetrationTicks * this.contractSpecs.tickSize);
        const reversalThreshold = pdlLevel + (this.params.liquiditySweepReversalTicks * this.contractSpecs.tickSize);
        
        // Look for pattern: price penetrates PDL, then reverses back above
        let penetrated = false;
        let reversed = false;
        let penetrationCandle = null;
        let reversalCandle = null;
        
        for (let i = 0; i < recentCandles.length; i++) {
            const candle = recentCandles[i];
            
            // Check for penetration below PDL
            if (!penetrated && candle.low < penetrationThreshold) {
                penetrated = true;
                penetrationCandle = candle;
            }
            
            // Check for reversal back above PDL after penetration
            if (penetrated && !reversed && candle.close > reversalThreshold) {
                reversed = true;
                reversalCandle = candle;
                break;
            }
        }
        
        if (penetrated && reversed) {
            return {
                type: 'PDL_LIQUIDITY_SWEEP',
                level: pdlLevel,
                penetrationPrice: penetrationCandle.low,
                reversalPrice: reversalCandle.close,
                confidence: 0.65, // 65% success rate from concept document
                direction: 'BULLISH', // PDL sweep is bullish reversal signal
                strength: this.calculateSweepStrength(penetrationCandle, reversalCandle)
            };
        }
        
        return null;
    }
    
    /**
     * Calculate liquidity sweep strength
     */
    calculateSweepStrength(penetrationCandle, reversalCandle) {
        const penetrationVolume = penetrationCandle.volume;
        const reversalVolume = reversalCandle.volume;
        const avgVolume = this.state.indicators.volumeAvg || 1000;
        
        // Strong sweep has low volume on penetration, high volume on reversal
        const volumeRatio = reversalVolume / Math.max(penetrationVolume, 1);
        const normalizedVolume = (penetrationVolume + reversalVolume) / (2 * avgVolume);
        
        if (volumeRatio > 2.0 && normalizedVolume > 1.5) {
            return 'STRONG';
        } else if (volumeRatio > 1.5 && normalizedVolume > 1.0) {
            return 'MEDIUM';
        } else {
            return 'WEAK';
        }
    }
    
    /**
     * Update market structure based on ADX and other indicators
     */
    updateMarketStructure() {
        const adx = this.state.indicators.adx;
        const cumulativeDelta = this.state.indicators.cumulativeDelta;
        
        if (!adx) {
            this.state.marketStructure = 'NEUTRAL';
            return;
        }
        
        // ADX-based structure classification
        if (adx > this.params.adxTrendingThreshold) {
            // Trending market - use cumulative delta to determine direction
            if (cumulativeDelta && cumulativeDelta > this.params.cumulativeDeltaThreshold) {
                this.state.marketStructure = 'TRENDING_UP';
            } else if (cumulativeDelta && cumulativeDelta < -this.params.cumulativeDeltaThreshold) {
                this.state.marketStructure = 'TRENDING_DOWN';
            } else {
                this.state.marketStructure = 'TRENDING_NEUTRAL';
            }
        } else if (adx < this.params.adxRangingThreshold) {
            this.state.marketStructure = 'RANGE_BOUND';
        } else {
            this.state.marketStructure = 'NEUTRAL';
        }
    }
    
    /**
     * Generate comprehensive trading signal
     * Incorporates all advanced components from concept document
     */
    async generateComprehensiveSignal(currentPrice, timestamp) {
        try {
            // Update signal strength scores first
            this.updateSignalStrengths(currentPrice);
            
            // Check basic requirements
            if (!this.state.pdhPdlLevels.validRthCalculation) return null;
            if (this.state.optimalStrategyType === 'NONE') return null;
            if (this.isPositionBlocked()) return null;
            
            // Time-based signal restrictions
            if (!this.isWithinTradingHours(timestamp)) return null;
            
            // Generate signals based on optimal strategy for current session
            let signal = null;
            
            switch (this.state.optimalStrategyType) {
                case 'BREAKOUT':
                    if (this.params.enableBreakoutStrategy) {
                        signal = this.generateBreakoutSignal(currentPrice, timestamp);
                        if (signal) {
                            signal.signalStrength = this.state.signalStrengths.breakout;
                        }
                    }
                    break;
                    
                case 'FADE':
                    if (this.params.enableFadeStrategy) {
                        signal = this.generateFadeSignal(currentPrice, timestamp);
                        if (signal) {
                            signal.signalStrength = this.state.signalStrengths.fade;
                        }
                    }
                    break;
                    
                case 'LIQUIDITY_SWEEP':
                    if (this.params.enableLiquiditySweepStrategy) {
                        signal = this.generateLiquiditySweepSignal(currentPrice, timestamp);
                        if (signal) {
                            signal.signalStrength = this.state.signalStrengths.liquiditySweep;
                        }
                    }
                    break;
            }
            
            // Apply comprehensive signal validation
            if (signal) {
                signal = this.validateSignalWithAdvancedFilters(signal, currentPrice, timestamp);
            }
            
            return signal;
            
        } catch (error) {
            console.log(`⚠️ Error generating comprehensive signal: ${error.message}`);
            return null;
        }
    }
    
    /**
     * Generate breakout signal with comprehensive analysis
     */
    generateBreakoutSignal(currentPrice, timestamp) {
        const { pdh, pdl } = this.state.pdhPdlLevels;
        const atr = this.state.indicators.atr;
        const volumeRatio = this.getCurrentVolumeRatio();
        const vwap = this.state.indicators.vwap;
        
        // PDH breakout (long signal)
        if (currentPrice > pdh + (this.params.breakoutBufferTicks * this.contractSpecs.tickSize)) {
            // Volume confirmation required
            if (volumeRatio >= this.params.volumeConfirmationMultiplier) {
                // VWAP alignment check (optional)
                if (!this.params.requireVwapAlignment || (vwap && currentPrice > vwap)) {
                    
                    const stopLoss = Math.max(
                        pdh - (atr * 1.5), // ATR-based stop
                        currentPrice - (this.params.mgcBreakoutStopTicks * this.contractSpecs.tickSize) // Fixed stop
                    );
                    
                    const riskPoints = currentPrice - stopLoss;
                    const takeProfit = currentPrice + (riskPoints * this.params.riskRewardRatio);
                    
                    return {
                        direction: 'LONG',
                        confidence: this.calculateBreakoutConfidence(currentPrice, pdh, volumeRatio),
                        entryPrice: currentPrice,
                        stopLoss: stopLoss,
                        takeProfit: takeProfit,
                        instrument: this.contractSpecs.symbol,
                        
                        // Risk metrics
                        riskPoints: riskPoints,
                        rewardPoints: takeProfit - currentPrice,
                        riskRewardRatio: this.params.riskRewardRatio,
                        
                        // Position sizing (basic)
                        positionSize: 1,
                        dollarRisk: riskPoints * this.params.dollarPerPoint,
                        dollarReward: (takeProfit - currentPrice) * this.params.dollarPerPoint,
                        
                        // Signal metadata
                        timestamp: Date.now(),
                        reason: `PDH breakout: ${currentPrice.toFixed(2)} > ${pdh.toFixed(2)}, Vol: ${volumeRatio.toFixed(1)}x`,
                        strategyName: this.name,
                        strategyVersion: this.version,
                        signalStrength: volumeRatio / this.params.volumeConfirmationMultiplier,
                        
                        // Strategy specific
                        subStrategy: 'BREAKOUT',
                        breakoutLevel: pdh,
                        indicators: {
                            pdh: pdh,
                            pdl: pdl,
                            vwap: vwap,
                            atr: atr,
                            volumeRatio: volumeRatio,
                            adx: this.state.indicators.adx,
                            cumulativeDelta: this.state.indicators.cumulativeDelta
                        },
                        environment: {
                            sessionTime: this.state.sessionPhase,
                            marketStructure: this.state.marketStructure,
                            optimalStrategy: this.state.optimalStrategyType
                        }
                    };
                }
            }
        }
        
        // PDL breakout (short signal) - similar logic but inverted
        if (currentPrice < pdl - (this.params.breakoutBufferTicks * this.contractSpecs.tickSize)) {
            if (volumeRatio >= this.params.volumeConfirmationMultiplier) {
                if (!this.params.requireVwapAlignment || (vwap && currentPrice < vwap)) {
                    
                    const stopLoss = Math.min(
                        pdl + (atr * 1.5),
                        currentPrice + (this.params.mgcBreakoutStopTicks * this.contractSpecs.tickSize)
                    );
                    
                    const riskPoints = stopLoss - currentPrice;
                    const takeProfit = currentPrice - (riskPoints * this.params.riskRewardRatio);
                    
                    return {
                        direction: 'SHORT',
                        confidence: this.calculateBreakoutConfidence(currentPrice, pdl, volumeRatio),
                        entryPrice: currentPrice,
                        stopLoss: stopLoss,
                        takeProfit: takeProfit,
                        instrument: this.contractSpecs.symbol,
                        
                        riskPoints: riskPoints,
                        rewardPoints: currentPrice - takeProfit,
                        riskRewardRatio: this.params.riskRewardRatio,
                        
                        positionSize: 1,
                        dollarRisk: riskPoints * this.params.dollarPerPoint,
                        dollarReward: (currentPrice - takeProfit) * this.params.dollarPerPoint,
                        
                        timestamp: Date.now(),
                        reason: `PDL breakout: ${currentPrice.toFixed(2)} < ${pdl.toFixed(2)}, Vol: ${volumeRatio.toFixed(1)}x`,
                        strategyName: this.name,
                        strategyVersion: this.version,
                        signalStrength: volumeRatio / this.params.volumeConfirmationMultiplier,
                        
                        subStrategy: 'BREAKOUT',
                        breakoutLevel: pdl,
                        indicators: {
                            pdh: pdh,
                            pdl: pdl,
                            vwap: vwap,
                            atr: atr,
                            volumeRatio: volumeRatio,
                            adx: this.state.indicators.adx,
                            cumulativeDelta: this.state.indicators.cumulativeDelta
                        },
                        environment: {
                            sessionTime: this.state.sessionPhase,
                            marketStructure: this.state.marketStructure,
                            optimalStrategy: this.state.optimalStrategyType
                        }
                    };
                }
            }
        }
        
        return null;
    }
    
    /**
     * Generate fade signal for rejections at PDH/PDL levels
     */
    generateFadeSignal(currentPrice, timestamp) {
        const { pdh, pdl } = this.state.pdhPdlLevels;
        
        // Check for recent rejection patterns
        if (this.candles.length < 3) return null;
        
        const recentCandles = this.candles.slice(-3);
        const lastCandle = recentCandles[recentCandles.length - 1];
        
        // PDH fade (short signal) - price touched PDH but rejected
        if (this.isPDHRejectionPattern(recentCandles, pdh)) {
            const stopLoss = pdh + (this.params.mgcFadeStopTicks * this.contractSpecs.tickSize);
            const riskPoints = stopLoss - currentPrice;
            const takeProfit = Math.max(pdl, currentPrice - (riskPoints * this.params.riskRewardRatio));
            
            return {
                direction: 'SHORT',
                confidence: this.calculateFadeConfidence(recentCandles, pdh, 'SHORT'),
                entryPrice: currentPrice,
                stopLoss: stopLoss,
                takeProfit: takeProfit,
                instrument: this.contractSpecs.symbol,
                
                riskPoints: riskPoints,
                rewardPoints: currentPrice - takeProfit,
                riskRewardRatio: (currentPrice - takeProfit) / riskPoints,
                
                positionSize: 1,
                dollarRisk: riskPoints * this.params.dollarPerPoint,
                dollarReward: (currentPrice - takeProfit) * this.params.dollarPerPoint,
                
                timestamp: Date.now(),
                reason: `PDH fade: Rejection at ${pdh.toFixed(2)}, Entry: ${currentPrice.toFixed(2)}`,
                strategyName: this.name,
                strategyVersion: this.version,
                signalStrength: 0.75, // Fade signals typically have good win rate
                
                subStrategy: 'FADE',
                fadeLevel: pdh,
                indicators: this.getIndicatorSnapshot(),
                environment: this.getEnvironmentSnapshot()
            };
        }
        
        // PDL fade (long signal) - price touched PDL but rejected
        if (this.isPDLRejectionPattern(recentCandles, pdl)) {
            const stopLoss = pdl - (this.params.mgcFadeStopTicks * this.contractSpecs.tickSize);
            const riskPoints = currentPrice - stopLoss;
            const takeProfit = Math.min(pdh, currentPrice + (riskPoints * this.params.riskRewardRatio));
            
            return {
                direction: 'LONG',
                confidence: this.calculateFadeConfidence(recentCandles, pdl, 'LONG'),
                entryPrice: currentPrice,
                stopLoss: stopLoss,
                takeProfit: takeProfit,
                instrument: this.contractSpecs.symbol,
                
                riskPoints: riskPoints,
                rewardPoints: takeProfit - currentPrice,
                riskRewardRatio: (takeProfit - currentPrice) / riskPoints,
                
                positionSize: 1,
                dollarRisk: riskPoints * this.params.dollarPerPoint,
                dollarReward: (takeProfit - currentPrice) * this.params.dollarPerPoint,
                
                timestamp: Date.now(),
                reason: `PDL fade: Rejection at ${pdl.toFixed(2)}, Entry: ${currentPrice.toFixed(2)}`,
                strategyName: this.name,
                strategyVersion: this.version,
                signalStrength: 0.75,
                
                subStrategy: 'FADE',
                fadeLevel: pdl,
                indicators: this.getIndicatorSnapshot(),
                environment: this.getEnvironmentSnapshot()
            };
        }
        
        return null;
    }
    
    /**
     * Generate liquidity sweep signals
     * High success rate per concept document (65-70%)
     */
    generateLiquiditySweepSignal(currentPrice, timestamp) {
        // Check for recent liquidity sweeps
        const recentPDHSweeps = this.state.liquiditySweeps.pdhSweeps.filter(
            sweep => Date.now() - sweep.timestamp < (30 * 60 * 1000) // Last 30 minutes
        );
        
        const recentPDLSweeps = this.state.liquiditySweeps.pdlSweeps.filter(
            sweep => Date.now() - sweep.timestamp < (30 * 60 * 1000) // Last 30 minutes
        );
        
        // PDH liquidity sweep signal (short after false breakout)
        if (recentPDHSweeps.length > 0) {
            const latestSweep = recentPDHSweeps[recentPDHSweeps.length - 1];
            
            if (latestSweep.strength === 'STRONG' || latestSweep.strength === 'MEDIUM') {
                const stopLoss = latestSweep.level + (this.params.mgcLiquiditySweepStopTicks * this.contractSpecs.tickSize);
                const riskPoints = stopLoss - currentPrice;
                const takeProfit = currentPrice - (riskPoints * this.params.riskRewardRatio);
                
                return {
                    direction: 'SHORT',
                    confidence: 'HIGH', // High confidence based on concept document success rates
                    entryPrice: currentPrice,
                    stopLoss: stopLoss,
                    takeProfit: takeProfit,
                    instrument: this.contractSpecs.symbol,
                    
                    riskPoints: riskPoints,
                    rewardPoints: currentPrice - takeProfit,
                    riskRewardRatio: (currentPrice - takeProfit) / riskPoints,
                    
                    positionSize: 1,
                    dollarRisk: riskPoints * this.params.dollarPerPoint,
                    dollarReward: (currentPrice - takeProfit) * this.params.dollarPerPoint,
                    
                    timestamp: Date.now(),
                    reason: `PDH liquidity sweep reversal: ${latestSweep.strength} strength`,
                    strategyName: this.name,
                    strategyVersion: this.version,
                    signalStrength: latestSweep.confidence,
                    
                    subStrategy: 'LIQUIDITY_SWEEP',
                    sweepData: latestSweep,
                    indicators: this.getIndicatorSnapshot(),
                    environment: this.getEnvironmentSnapshot()
                };
            }
        }
        
        // PDL liquidity sweep signal (long after false breakdown)
        if (recentPDLSweeps.length > 0) {
            const latestSweep = recentPDLSweeps[recentPDLSweeps.length - 1];
            
            if (latestSweep.strength === 'STRONG' || latestSweep.strength === 'MEDIUM') {
                const stopLoss = latestSweep.level - (this.params.mgcLiquiditySweepStopTicks * this.contractSpecs.tickSize);
                const riskPoints = currentPrice - stopLoss;
                const takeProfit = currentPrice + (riskPoints * this.params.riskRewardRatio);
                
                return {
                    direction: 'LONG',
                    confidence: 'HIGH',
                    entryPrice: currentPrice,
                    stopLoss: stopLoss,
                    takeProfit: takeProfit,
                    instrument: this.contractSpecs.symbol,
                    
                    riskPoints: riskPoints,
                    rewardPoints: takeProfit - currentPrice,
                    riskRewardRatio: (takeProfit - currentPrice) / riskPoints,
                    
                    positionSize: 1,
                    dollarRisk: riskPoints * this.params.dollarPerPoint,
                    dollarReward: (takeProfit - currentPrice) * this.params.dollarPerPoint,
                    
                    timestamp: Date.now(),
                    reason: `PDL liquidity sweep reversal: ${latestSweep.strength} strength`,
                    strategyName: this.name,
                    strategyVersion: this.version,
                    signalStrength: latestSweep.confidence,
                    
                    subStrategy: 'LIQUIDITY_SWEEP',
                    sweepData: latestSweep,
                    indicators: this.getIndicatorSnapshot(),
                    environment: this.getEnvironmentSnapshot()
                };
            }
        }
        
        return null;
    }
    
    /**
     * Validate signal with advanced filters
     * Applies volume profile, cumulative delta, ADX filters
     */
    validateSignalWithAdvancedFilters(signal, currentPrice, timestamp) {
        if (!signal) return null;
        
        try {
            // Volume Profile validation
            if (this.params.enableVolumeProfile && this.state.volumeProfile.poc) {
                // Check if signal aligns with volume profile
                const pocZone = this.state.volumeProfile.pocZone;
                const isNearPOC = currentPrice >= pocZone.lower && currentPrice <= pocZone.upper;
                
                // Signals near POC have higher probability of success
                if (isNearPOC) {
                    signal.signalStrength *= 1.2; // Boost confidence
                    signal.reason += ' (Near POC)';
                }
                
                // Check if signal is near Low Volume Nodes (gaps - good for breakouts)
                const nearLVN = this.state.volumeProfile.lvnLevels.some(lvn => 
                    Math.abs(currentPrice - lvn.price) < (2 * this.contractSpecs.tickSize)
                );
                
                if (nearLVN && signal.subStrategy === 'BREAKOUT') {
                    signal.signalStrength *= 1.15;
                    signal.reason += ' (LVN Gap)';
                }
            }
            
            // Cumulative Delta validation
            if (this.params.enableCumulativeDelta && this.state.indicators.cumulativeDelta !== null) {
                const cumulativeDelta = this.state.indicators.cumulativeDelta;
                
                // Long signals should have positive cumulative delta
                if (signal.direction === 'LONG' && cumulativeDelta <= this.params.cumulativeDeltaThreshold) {
                    signal.signalStrength *= 0.8; // Reduce confidence
                    signal.reason += ' (Weak Order Flow)';
                }
                
                // Short signals should have negative cumulative delta
                if (signal.direction === 'SHORT' && cumulativeDelta >= -this.params.cumulativeDeltaThreshold) {
                    signal.signalStrength *= 0.8;
                    signal.reason += ' (Weak Order Flow)';
                }
            }
            
            // ADX Market Structure validation
            if (this.state.indicators.adxTrend) {
                // Breakout signals work best in trending markets
                if (signal.subStrategy === 'BREAKOUT') {
                    if (this.state.indicators.adxTrend === 'TRENDING') {
                        signal.signalStrength *= 1.25;
                        signal.reason += ' (Trending Market)';
                    } else if (this.state.indicators.adxTrend === 'RANGING') {
                        signal.signalStrength *= 0.75;
                        signal.reason += ' (Ranging Market)';
                    }
                }
                
                // Fade signals work best in ranging markets
                if (signal.subStrategy === 'FADE') {
                    if (this.state.indicators.adxTrend === 'RANGING') {
                        signal.signalStrength *= 1.2;
                        signal.reason += ' (Ranging Market)';
                    } else if (this.state.indicators.adxTrend === 'TRENDING') {
                        signal.signalStrength *= 0.8;
                        signal.reason += ' (Trending Market)';
                    }
                }
            }
            
            // Time-based validation (from concept document optimization)
            const timeBoost = this.getTimeBasedSignalBoost(timestamp, signal.subStrategy);
            signal.signalStrength *= timeBoost;
            
            if (timeBoost > 1.0) {
                signal.reason += ' (Optimal Time)';
            } else if (timeBoost < 1.0) {
                signal.reason += ' (Suboptimal Time)';
            }
            
            // Final confidence classification
            if (signal.signalStrength >= 1.2) {
                signal.confidence = 'HIGH';
            } else if (signal.signalStrength >= 0.9) {
                signal.confidence = 'MEDIUM';
            } else {
                signal.confidence = 'LOW';
            }
            
            // Filter out very low confidence signals
            if (signal.signalStrength < 0.6) {
                return null;
            }
            
            return signal;
            
        } catch (error) {
            console.log(`⚠️ Error validating signal: ${error.message}`);
            return signal; // Return original signal if validation fails
        }
    }
    
    /**
     * Get time-based signal boost from concept document optimization
     */
    getTimeBasedSignalBoost(timestamp, subStrategy) {
        if (!this.params.enableTimeBasedOptimization) return 1.0;
        
        const date = new Date(timestamp);
        const etHour = date.getHours() + 1; // Simplified CT to ET
        const etMinute = date.getMinutes();
        const etTimeString = `${etHour.toString().padStart(2, '0')}:${etMinute.toString().padStart(2, '0')}`;
        
        switch (subStrategy) {
            case 'BREAKOUT':
                // Best during NY morning session (9:30-11:30 AM ET)
                if (etTimeString >= '09:30' && etTimeString < '11:30') {
                    return 1.3; // 30% boost during optimal time
                }
                // Good during London/NY overlap (8:30-10:30 AM ET)
                if (etTimeString >= '08:30' && etTimeString < '10:30') {
                    return 1.15;
                }
                break;
                
            case 'FADE':
                // Best during NY afternoon (2:00-3:00 PM ET)
                if (etTimeString >= '14:00' && etTimeString < '15:00') {
                    return 1.25;
                }
                // Good during evening session (lower volatility)
                if (etHour >= 15 && etHour < 18) {
                    return 1.1;
                }
                break;
                
            case 'LIQUIDITY_SWEEP':
                // Best during high volatility periods (London/NY overlap)
                if (etTimeString >= '08:30' && etTimeString < '10:30') {
                    return 1.4; // 40% boost during max volatility
                }
                break;
        }
        
        // Reduce signals during low-activity periods
        if (etHour < 8 || etHour > 18) {
            return 0.7; // 30% reduction outside main hours
        }
        
        return 1.0; // Neutral time period
    }
    
    // Utility Methods
    
    calculateBreakoutConfidence(price, level, volumeRatio) {
        const distance = Math.abs(price - level);
        const distanceInTicks = distance / this.contractSpecs.tickSize;
        
        let confidence = 'MEDIUM';
        
        if (volumeRatio >= 2.0 && distanceInTicks >= 5) {
            confidence = 'HIGH';
        } else if (volumeRatio < 1.2 || distanceInTicks < 2) {
            confidence = 'LOW';
        }
        
        return confidence;
    }
    
    calculateFadeConfidence(candles, level, direction) {
        // Check for strong rejection pattern (long wicks)
        const lastCandle = candles[candles.length - 1];
        const bodySize = Math.abs(lastCandle.close - lastCandle.open);
        const totalRange = lastCandle.high - lastCandle.low;
        const wickRatio = (totalRange - bodySize) / totalRange;
        
        if (wickRatio > 0.6) { // 60% of range is wicks
            return 'HIGH';
        } else if (wickRatio > 0.4) {
            return 'MEDIUM';
        }
        
        return 'LOW';
    }
    
    isPDHRejectionPattern(candles, pdh) {
        const tolerance = 2 * this.contractSpecs.tickSize;
        
        return candles.some(candle => {
            // Price touched or exceeded PDH but closed below it
            return candle.high >= pdh - tolerance && candle.close < pdh - tolerance;
        });
    }
    
    isPDLRejectionPattern(candles, pdl) {
        const tolerance = 2 * this.contractSpecs.tickSize;
        
        return candles.some(candle => {
            // Price touched or went below PDL but closed above it
            return candle.low <= pdl + tolerance && candle.close > pdl + tolerance;
        });
    }
    
    getCurrentVolumeRatio() {
        if (!this.currentCandle || !this.state.indicators.volumeAvg) return 1.0;
        
        return this.currentCandle.volume / this.state.indicators.volumeAvg;
    }
    
    getIndicatorSnapshot() {
        return {
            pdh: this.state.pdhPdlLevels.pdh,
            pdl: this.state.pdhPdlLevels.pdl,
            vwap: this.state.indicators.vwap,
            atr: this.state.indicators.atr,
            adx: this.state.indicators.adx,
            cumulativeDelta: this.state.indicators.cumulativeDelta,
            volumeAvg: this.state.indicators.volumeAvg,
            poc: this.state.volumeProfile.poc
        };
    }
    
    getEnvironmentSnapshot() {
        return {
            sessionTime: this.state.sessionPhase,
            marketStructure: this.state.marketStructure,
            optimalStrategy: this.state.optimalStrategyType,
            adxTrend: this.state.indicators.adxTrend
        };
    }
    
    // Framework Required Methods
    
    isStrategyReady() {
        return this.state.dataPointsCollected >= 50 && 
               this.state.rthDataPointsToday >= 10 &&
               this.state.pdhPdlLevels.validRthCalculation;
    }
    
    isWithinTradingHours(timestamp) {
        if (this.params.enableTimeDecay) {
            const date = new Date(timestamp);
            const hour = date.getHours();
            const minute = date.getMinutes();
            const timeString = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
            
            // Stop new signals near close
            if (timeString >= this.params.stopNewSignalsAt) {
                return false;
            }
        }
        
        return true;
    }
    
    isPositionBlocked() {
        // Check if bot has existing position
        if (this.mainBot?.modules?.positionManagement?.hasPosition()) {
            return true;
        }
        
        // Check signal cooldown
        if (this.state.lastSignalTime) {
            const timeSinceLastSignal = Date.now() - this.state.lastSignalTime;
            if (timeSinceLastSignal < this.params.signalCooldownMs) {
                return true;
            }
        }
        
        // Check daily signal limit
        if (this.state.signalsToday >= this.params.maxSignalsPerDay) {
            return true;
        }
        
        return false;
    }
    
    isQuietModeActive() {
        return this.mainBot?.modules?.healthMonitoring?.isQuietMode() || false;
    }
    
    analyzeMarketEnvironment(price, timestamp) {
        return {
            sessionPhase: this.state.sessionPhase,
            marketStructure: this.state.marketStructure,
            optimalStrategyType: this.state.optimalStrategyType,
            adxTrend: this.state.indicators.adxTrend,
            volumeProfile: {
                poc: this.state.volumeProfile.poc,
                nearPOC: this.state.volumeProfile.poc ? 
                    Math.abs(price - this.state.volumeProfile.poc) < (5 * this.contractSpecs.tickSize) : false
            },
            liquiditySweeps: {
                recentPDHSweeps: this.state.liquiditySweeps.pdhSweeps.length,
                recentPDLSweeps: this.state.liquiditySweeps.pdlSweeps.length
            }
        };
    }
    
    getStatusSummary() {
        return {
            strategyName: this.name,
            version: this.version,
            ready: this.isStrategyReady(),
            dataPoints: this.state.dataPointsCollected,
            rthDataPoints: this.state.rthDataPointsToday,
            
            pdhPdlLevels: {
                pdh: this.state.pdhPdlLevels.pdh?.toFixed(2),
                pdl: this.state.pdhPdlLevels.pdl?.toFixed(2),
                valid: this.state.pdhPdlLevels.validRthCalculation
            },
            
            indicators: {
                vwap: this.state.indicators.vwap?.toFixed(2),
                atr: this.state.indicators.atr?.toFixed(2),
                adx: this.state.indicators.adx?.toFixed(1),
                adxTrend: this.state.indicators.adxTrend,
                cumulativeDelta: this.state.indicators.cumulativeDelta?.toFixed(0)
            },
            
            volumeProfile: {
                enabled: this.params.enableVolumeProfile,
                poc: this.state.volumeProfile.poc?.toFixed(2),
                hvnLevels: this.state.volumeProfile.hvnLevels.length,
                lvnLevels: this.state.volumeProfile.lvnLevels.length
            },
            
            // Signal strength scoring
            signalStrengths: {
                breakout: this.state.signalStrengths.breakout,
                fade: this.state.signalStrengths.fade,
                liquiditySweep: this.state.signalStrengths.liquiditySweep,
                overall: this.state.signalStrengths.overall
            },
            
            session: {
                phase: this.state.sessionPhase,
                optimalStrategy: this.state.optimalStrategyType,
                marketStructure: this.state.marketStructure
            },
            
            performance: {
                signalsToday: this.state.signalsToday,
                maxSignals: this.params.maxSignalsPerDay
            }
        };
    }
    
    reset() {
        // Reset state for bot restart
        this.state.currentPosition = null;
        this.state.lastSignalTime = null;
        this.state.signalsToday = 0;
        this.state.isReady = false;
        this.state.dataPointsCollected = 0;
        this.state.rthDataPointsToday = 0;
        
        // Reset signal strengths
        this.state.signalStrengths = {
            breakout: 0,
            fade: 0,
            liquiditySweep: 0,
            overall: 0
        };
        
        this.candles = [];
        this.currentCandle = null;
        this.lastCandleTime = null;
        this.priceVolumeData = [];
        this.tickData = [];
        
        console.log(`🔄 ${this.name} reset completed`);
    }
    
    /**
     * Signal Strength Scoring System (1-10 scale)
     * Continuously evaluates how close each signal type is to triggering
     */
    
    /**
     * Update all signal strength scores
     */
    updateSignalStrengths(price) {
        this.state.signalStrengths.breakout = this.calculateBreakoutScore(price);
        this.state.signalStrengths.fade = this.calculateFadeScore(price);
        this.state.signalStrengths.liquiditySweep = this.calculateLiquiditySweepScore(price);
        
        // Overall score is the highest individual signal
        this.state.signalStrengths.overall = Math.max(
            this.state.signalStrengths.breakout,
            this.state.signalStrengths.fade,
            this.state.signalStrengths.liquiditySweep
        );
    }
    
    /**
     * Calculate Breakout signal strength (0-10)
     */
    calculateBreakoutScore(price) {
        if (!this.state.pdhPdlLevels.validRthCalculation) return 0;
        
        const { pdh, pdl } = this.state.pdhPdlLevels;
        const breakoutBuffer = this.params.breakoutBufferTicks * this.contractSpecs.tickSize;
        
        // Distance to breakout levels
        const distanceToPDH = pdh - price;
        const distanceToPDL = price - pdl;
        
        let score = 0;
        
        // PDH Breakout potential
        if (distanceToPDH <= 0) {
            score = Math.max(score, 10); // Above PDH = breakout occurring
        } else if (distanceToPDH <= breakoutBuffer) {
            score = Math.max(score, 9 - Math.floor(distanceToPDH / breakoutBuffer));
        } else if (distanceToPDH <= breakoutBuffer * 3) {
            score = Math.max(score, 7 - Math.floor((distanceToPDH - breakoutBuffer) / breakoutBuffer));
        } else if (distanceToPDH <= breakoutBuffer * 6) {
            score = Math.max(score, 4 - Math.floor((distanceToPDH - breakoutBuffer * 3) / (breakoutBuffer * 3) * 2));
        }
        
        // PDL Breakout potential (similar logic, inverted)
        if (distanceToPDL <= 0) {
            score = Math.max(score, 10);
        } else if (distanceToPDL <= breakoutBuffer) {
            score = Math.max(score, 9 - Math.floor(distanceToPDL / breakoutBuffer));
        } else if (distanceToPDL <= breakoutBuffer * 3) {
            score = Math.max(score, 7 - Math.floor((distanceToPDL - breakoutBuffer) / breakoutBuffer));
        } else if (distanceToPDL <= breakoutBuffer * 6) {
            score = Math.max(score, 4 - Math.floor((distanceToPDL - breakoutBuffer * 3) / (breakoutBuffer * 3) * 2));
        }
        
        // Boost for volume confirmation (would need real volume data)
        const volumeRatio = this.getCurrentVolumeRatio();
        if (volumeRatio >= this.params.volumeConfirmationMultiplier) {
            score = Math.min(10, score + 2);
        }
        
        return Math.max(1, score);
    }
    
    /**
     * Calculate Fade signal strength (0-10)
     */
    calculateFadeScore(price) {
        if (!this.state.pdhPdlLevels.validRthCalculation) return 0;
        
        const { pdh, pdl } = this.state.pdhPdlLevels;
        
        // Distance to fade levels
        const distanceToPDH = Math.abs(price - pdh);
        const distanceToPDL = Math.abs(price - pdl);
        const minDistance = Math.min(distanceToPDH, distanceToPDL);
        
        let score = 0;
        
        if (minDistance <= 0.5) {
            score = 10; // Right at level
        } else if (minDistance <= 1.0) {
            score = 8; // Very close
        } else if (minDistance <= 2.0) {
            score = 6; // Close
        } else if (minDistance <= 4.0) {
            score = 4; // Moderate
        } else if (minDistance <= 8.0) {
            score = 2; // Approaching
        } else {
            score = 1; // Distant
        }
        
        // Boost based on rejection patterns in recent candles
        if (this.candles.length >= 3) {
            const recentCandles = this.candles.slice(-3);
            if (this.isPDHRejectionPattern(recentCandles, pdh) || 
                this.isPDLRejectionPattern(recentCandles, pdl)) {
                score = Math.min(10, score + 2);
            }
        }
        
        return score;
    }
    
    /**
     * Calculate Liquidity Sweep signal strength (0-10)
     */
    calculateLiquiditySweepScore(price) {
        const recentPDHSweeps = this.state.liquiditySweeps?.pdhSweeps?.filter(
            sweep => Date.now() - sweep.timestamp < (30 * 60 * 1000)
        ) || [];
        
        const recentPDLSweeps = this.state.liquiditySweeps?.pdlSweeps?.filter(
            sweep => Date.now() - sweep.timestamp < (30 * 60 * 1000)
        ) || [];
        
        let score = 0;
        
        // Score based on recent sweeps
        if (recentPDHSweeps.length > 0) {
            const latestSweep = recentPDHSweeps[recentPDHSweeps.length - 1];
            if (latestSweep.strength === 'STRONG') score = Math.max(score, 10);
            if (latestSweep.strength === 'MEDIUM') score = Math.max(score, 8);
            if (latestSweep.strength === 'WEAK') score = Math.max(score, 5);
        }
        
        if (recentPDLSweeps.length > 0) {
            const latestSweep = recentPDLSweeps[recentPDLSweeps.length - 1];
            if (latestSweep.strength === 'STRONG') score = Math.max(score, 10);
            if (latestSweep.strength === 'MEDIUM') score = Math.max(score, 8);
            if (latestSweep.strength === 'WEAK') score = Math.max(score, 5);
        }
        
        // Decay score based on time since sweep
        const latestSweepTime = Math.max(
            recentPDHSweeps[0]?.timestamp || 0,
            recentPDLSweeps[0]?.timestamp || 0
        );
        
        if (latestSweepTime > 0) {
            const timeFactor = Math.max(0.3, 1 - (Date.now() - latestSweepTime) / (30 * 60 * 1000));
            score = Math.floor(score * timeFactor);
        }
        
        return Math.max(0, score);
    }
    
    /**
     * Get signal strength display for monitoring
     */
    getSignalStrengthDisplay() {
        return {
            timestamp: new Date().toISOString(),
            scores: {
                breakout: `${this.state.signalStrengths.breakout}/10`,
                fade: `${this.state.signalStrengths.fade}/10`,
                liquiditySweep: `${this.state.signalStrengths.liquiditySweep}/10`,
                overall: `${this.state.signalStrengths.overall}/10`
            },
            alerts: this.generateStrengthAlerts(),
            summary: {
                maxStrength: this.state.signalStrengths.overall,
                alertLevel: this.state.signalStrengths.overall >= 8 ? 'HIGH' : 
                           this.state.signalStrengths.overall >= 6 ? 'MEDIUM' : 'LOW'
            }
        };
    }
    
    /**
     * Generate alerts for high signal strength
     */
    generateStrengthAlerts() {
        const alerts = [];
        
        if (this.state.signalStrengths.breakout >= 8) {
            alerts.push(`🔥 Breakout: ${this.state.signalStrengths.breakout}/10 - Signal imminent!`);
        }
        if (this.state.signalStrengths.fade >= 8) {
            alerts.push(`🔥 Fade: ${this.state.signalStrengths.fade}/10 - Signal imminent!`);
        }
        if (this.state.signalStrengths.liquiditySweep >= 8) {
            alerts.push(`🔥 Liquidity Sweep: ${this.state.signalStrengths.liquiditySweep}/10 - Signal imminent!`);
        }
        
        return alerts;
    }
    
    // Helper calculation methods
    
    calculateVWAP() {
        if (this.candles.length < 20) return null;
        
        const recent = this.candles.slice(-50);
        let totalVolumePrice = 0;
        let totalVolume = 0;
        
        recent.forEach(candle => {
            const typicalPrice = (candle.high + candle.low + candle.close) / 3;
            totalVolumePrice += typicalPrice * candle.volume;
            totalVolume += candle.volume;
        });
        
        return totalVolume > 0 ? totalVolumePrice / totalVolume : null;
    }
    
    calculateATR(period) {
        if (this.candles.length < period + 1) return null;
        
        const recent = this.candles.slice(-(period + 1));
        const trueRanges = [];
        
        for (let i = 1; i < recent.length; i++) {
            const current = recent[i];
            const previous = recent[i - 1];
            
            const tr = Math.max(
                current.high - current.low,
                Math.abs(current.high - previous.close),
                Math.abs(current.low - previous.close)
            );
            
            trueRanges.push(tr);
        }
        
        return this.calculateSMA(trueRanges, period);
    }
    
    calculateAverageVolume(period) {
        if (this.candles.length < period) return null;
        
        const recent = this.candles.slice(-period);
        const totalVolume = recent.reduce((sum, candle) => sum + candle.volume, 0);
        
        return totalVolume / period;
    }
    
    calculateSMA(data, period) {
        if (data.length < period) return null;
        
        const recent = data.slice(-period);
        const sum = recent.reduce((total, value) => total + value, 0);
        
        return sum / period;
    }
}

module.exports = PDHPDLStrategy;