// ORBRubberBandStrategy.js
// Opening Range Breakout + Failed Breakout Reversal (Rubber Band) Strategy
// For TSX Trading Bot
//
// STRATEGY LOGIC:
// 1. Wait for Opening Range to be established
// 2. On breakout with volume confirmation, signal LONG/SHORT
// 3. Monitor for failed breakout (rubber band setup)
// 4. If price reverses back into OR or by threshold %, close breakout and reverse
//
// ARCHITECTURE NOTE: This strategy module only generates trading signals.
// The Trading Bot Core processes these signals and sends them to the
// Connection Manager, which handles all TopStep API interactions.

const { SMACalculator } = require('../../indicators');

class ORBRubberBandStrategy {
    constructor(config = {}, mainBot = null) {
        this.name = 'ORB_RUBBER_BAND_STRATEGY';
        this.version = '2.0';
        this.mainBot = mainBot;
        
        // Strategy parameters
        this.params = {
            // Opening Range configuration
            openingRangeDuration: config.openingRangeDuration || 30, // minutes
            orbBreakoutPercent: config.orbBreakoutPercent || 10, // % of OR to trigger breakout
            orbMaxBreakoutPercent: config.orbMaxBreakoutPercent || 30, // max % of OR for valid breakout
            orbVolumeThreshold: config.orbVolumeThreshold || 120, // % of 20-period volume MA
            
            // Rubber Band (Failed Breakout) configuration
            candleIntervalMinutes: config.candleIntervalMinutes || 5, // minutes per candle
            rubberBandCandleWindow: config.rubberBandCandleWindow || 3, // candles to detect reversal
            rubberBandReversalPercent: config.rubberBandReversalPercent || 50, // % reversal of breakout move
            rubberBandVolumeThreshold: config.rubberBandVolumeThreshold || 150, // % of 20-period volume MA
            reverseOnORReEntry: config.reverseOnORReEntry !== false, // true = reverse if price re-enters OR
            
            // Volume tracking
            volumePeriod: config.volumePeriod || 20, // periods for volume MA
            
            // Risk management
            dollarRiskPerTrade: config.dollarRiskPerTrade || 100,
            dollarPerPoint: 10, // Should come from instrument settings
            riskRewardRatio: config.riskRewardRatio || 2,
            maxRiskPoints: config.maxRiskPoints || 3.0,
            
            // Position management
            oneTradeAtTime: config.oneTradeAtTime !== false,
            maxTradeDurationMinutes: config.maxTradeDurationMinutes || 480, // 480 minutes (8 hours)
            
            // Session configuration
            londonOpenTime: config.londonOpenTime || '02:00', // ET
            nyOpenTime: config.nyOpenTime || '09:30', // ET
            activeSession: config.activeSession || 'BOTH',
            
            // Signal settings
            signalCooldownMs: config.signalCooldownMs || 300000, // 5 minutes
            
            ...config
        };
        
        // State management
        this.state = {
            // Opening Range
            openingRange: {
                high: null,
                low: null,
                established: false,
                establishedTime: null,
                session: null
            },
            
            // Volume tracking
            volumeHistory: [], // Rolling window of volume
            volumeMA: 0,
            currentVolume: 0,
            
            // ORB breakout tracking
            orbBreakout: {
                active: false,
                direction: null, // 'LONG' or 'SHORT'
                entryPrice: null,
                breakoutTime: null,
                breakoutCandle: 0,
                breakoutHigh: null,
                breakoutLow: null,
                signalId: null // To track and potentially close position
            },
            
            // Rubber Band tracking
            rubberBandSetup: {
                monitoring: false,
                reversalDetected: false,
                reversalPrice: null,
                reversalTime: null
            },
            
            // Position tracking
            currentPosition: null,
            lastSignalTime: null,
            candleCount: 0,
            lastCandleTime: null, // Track when last candle was formed
            
            // Session tracking
            currentSession: null,
            sessionStartTime: null
        };
        
        // Performance tracking
        this.stats = {
            orbBreakouts: 0,
            rubberBandReversals: 0,
            signalsGenerated: 0,
            volumeRejections: 0
        };
        
        // Initialize SMA Calculator for volume moving average
        this.volumeSMA = new SMACalculator([this.params.volumePeriod]);
        
        console.log(`📊 ${this.name} v${this.version} initialized`);
        console.log(`⏰ OR Duration: ${this.params.openingRangeDuration} minutes`);
        console.log(`🎯 ORB Threshold: ${this.params.orbBreakoutPercent}% - ${this.params.orbMaxBreakoutPercent}% of OR`);
        console.log(`📊 ORB Volume Required: ${this.params.orbVolumeThreshold}% of ${this.params.volumePeriod}MA (using SMACalculator)`);
        console.log(`🕐 Candle Interval: ${this.params.candleIntervalMinutes} minutes`);
        console.log(`🔄 Rubber Band Window: ${this.params.rubberBandCandleWindow} candles (${this.params.rubberBandCandleWindow * this.params.candleIntervalMinutes} minutes)`);
        console.log(`📈 Rubber Band Reversal: ${this.params.rubberBandReversalPercent}% or OR re-entry`);
    }
    
    // Main method to process market data
    processMarketData(price, volume = 1000, timestamp = null) {
        if (!timestamp) timestamp = new Date();
        
        // Update volume tracking
        this.updateVolume(volume);
        
        // Update session state
        this.updateSessionState(timestamp);
        
        // Update opening range if within OR period
        if (this.isWithinOpeningRangePeriod(timestamp)) {
            this.updateOpeningRange(price, timestamp);
            return this.createEmptyResponse('Building OR');
        }
        
        // Update candle count based on time intervals after OR established
        if (this.state.openingRange.established) {
            this.updateCandleCount(timestamp);
        }
        
        // Check for active breakout monitoring
        if (this.state.orbBreakout.active && this.state.rubberBandSetup.monitoring) {
            // Check if rubber band reversal triggered
            const rubberBandSignal = this.checkRubberBandReversal(price, volume, timestamp);
            if (rubberBandSignal) {
                return {
                    ready: true,
                    signal: rubberBandSignal,
                    state: this.getStateSnapshot(),
                    stats: { ...this.stats }
                };
            }
        }
        
        // Check for new ORB breakout (only if no active position)
        if (this.state.openingRange.established && !this.state.orbBreakout.active) {
            if (this.canGenerateSignal()) {
                const breakoutSignal = this.checkORBBreakout(price, volume, timestamp);
                if (breakoutSignal) {
                    return {
                        ready: true,
                        signal: breakoutSignal,
                        state: this.getStateSnapshot(),
                        stats: { ...this.stats }
                    };
                }
            }
        }
        
        // Update breakout extremes if active
        if (this.state.orbBreakout.active) {
            this.updateBreakoutExtremes(price);
        }
        
        return this.createEmptyResponse('Monitoring');
    }
    
    // Update volume tracking using SMA Calculator
    updateVolume(volume) {
        this.state.currentVolume = volume;
        
        // Update SMA calculator with new volume data
        const smaResult = this.volumeSMA.update(volume);
        
        // Get the volume MA from SMA calculator
        const smaValues = this.volumeSMA.getSMAValues();
        this.state.volumeMA = smaValues[this.params.volumePeriod] || 0;
        
        // Keep legacy volumeHistory for backward compatibility (optional)
        this.state.volumeHistory.push(volume);
        if (this.state.volumeHistory.length > this.params.volumePeriod) {
            this.state.volumeHistory.shift();
        }
    }
    
    // Check if volume meets threshold
    isVolumeConfirmed(volume, thresholdPercent) {
        if (this.state.volumeMA === 0) return true; // No volume history yet
        
        const threshold = this.state.volumeMA * (thresholdPercent / 100);
        const confirmed = volume >= threshold;
        
        if (!confirmed) {
            this.stats.volumeRejections++;
            console.log(`📊 Volume rejection: ${volume} < ${threshold.toFixed(0)} (${thresholdPercent}% of MA)`);
        }
        
        return confirmed;
    }
    
    // Check for ORB breakout with volume confirmation
    checkORBBreakout(price, volume, timestamp) {
        const { high, low } = this.state.openingRange;
        const range = high - low;
        const minThreshold = range * (this.params.orbBreakoutPercent / 100);
        const maxThreshold = range * (this.params.orbMaxBreakoutPercent / 100);
        
        // Check for breakout above OR high
        if (price > high + minThreshold && price <= high + maxThreshold) {
            // Verify volume confirmation
            if (!this.isVolumeConfirmed(volume, this.params.orbVolumeThreshold)) {
                return null;
            }
            
            // Generate LONG signal
            const signal = this.generateBreakoutSignal('LONG', price, timestamp);
            if (signal) {
                this.state.orbBreakout = {
                    active: true,
                    direction: 'LONG',
                    entryPrice: price,
                    breakoutTime: timestamp,
                    breakoutCandle: this.state.candleCount,
                    breakoutHigh: price,
                    breakoutLow: price,
                    signalId: signal.id
                };
                
                // Start monitoring for rubber band
                this.state.rubberBandSetup.monitoring = true;
                
                this.stats.orbBreakouts++;
                const breakoutPercent = ((price - high) / range * 100).toFixed(1);
                console.log(`🚀 ORB Breakout LONG at ${price.toFixed(2)} (${breakoutPercent}% of OR) with volume confirmation`);
                
                return signal;
            }
        }
        // Check for breakout below OR low
        else if (price < low - minThreshold && price >= low - maxThreshold) {
            // Verify volume confirmation
            if (!this.isVolumeConfirmed(volume, this.params.orbVolumeThreshold)) {
                return null;
            }
            
            // Generate SHORT signal
            const signal = this.generateBreakoutSignal('SHORT', price, timestamp);
            if (signal) {
                this.state.orbBreakout = {
                    active: true,
                    direction: 'SHORT',
                    entryPrice: price,
                    breakoutTime: timestamp,
                    breakoutCandle: this.state.candleCount,
                    breakoutHigh: price,
                    breakoutLow: price,
                    signalId: signal.id
                };
                
                // Start monitoring for rubber band
                this.state.rubberBandSetup.monitoring = true;
                
                this.stats.orbBreakouts++;
                const breakoutPercent = ((low - price) / range * 100).toFixed(1);
                console.log(`🚀 ORB Breakout SHORT at ${price.toFixed(2)} (${breakoutPercent}% of OR) with volume confirmation`);
                
                return signal;
            }
        }
        
        // Log if breakout is too extended
        if (price > high + maxThreshold) {
            console.log(`⚠️ Breakout too extended: ${((price - high) / range * 100).toFixed(1)}% > ${this.params.orbMaxBreakoutPercent}% max`);
        } else if (price < low - maxThreshold) {
            console.log(`⚠️ Breakout too extended: ${((low - price) / range * 100).toFixed(1)}% > ${this.params.orbMaxBreakoutPercent}% max`);
        }
        
        return null;
    }
    
    // Update candle count based on time intervals
    updateCandleCount(timestamp) {
        const candleIntervalMs = this.params.candleIntervalMinutes * 60 * 1000;
        
        if (!this.state.lastCandleTime) {
            // First candle after OR established
            this.state.lastCandleTime = timestamp;
            this.state.candleCount = 1;
            return;
        }
        
        const timeSinceLastCandle = timestamp - this.state.lastCandleTime;
        const newCandles = Math.floor(timeSinceLastCandle / candleIntervalMs);
        
        if (newCandles > 0) {
            this.state.candleCount += newCandles;
            this.state.lastCandleTime = timestamp - (timeSinceLastCandle % candleIntervalMs);
        }
    }
    
    // Check for rubber band reversal (failed breakout)
    checkRubberBandReversal(price, volume, timestamp) {
        if (!this.state.rubberBandSetup.monitoring) return null;
        
        const { direction, entryPrice, breakoutTime } = this.state.orbBreakout;
        const { high, low } = this.state.openingRange;
        
        // Check if within time window (convert candle window to time)
        const windowDurationMs = this.params.rubberBandCandleWindow * this.params.candleIntervalMinutes * 60 * 1000;
        const timeSinceBreakout = timestamp - breakoutTime;
        
        if (timeSinceBreakout > windowDurationMs) {
            // Window expired, stop monitoring
            this.state.rubberBandSetup.monitoring = false;
            const minutesElapsed = Math.floor(timeSinceBreakout / 60000);
            console.log(`⏰ Rubber band window expired after ${minutesElapsed} minutes (${this.params.rubberBandCandleWindow} x ${this.params.candleIntervalMinutes} min candles)`);
            return null;
        }
        
        let reversalTriggered = false;
        let reversalReason = '';
        
        if (direction === 'LONG') {
            // For LONG breakout, check for reversal down
            
            // Check 1: Price re-enters OR
            if (this.params.reverseOnORReEntry && price <= high) {
                reversalTriggered = true;
                reversalReason = 'Price re-entered OR';
            }
            
            // Check 2: Price reversed by threshold %
            const breakoutMove = this.state.orbBreakout.breakoutHigh - high;
            const currentRetracement = this.state.orbBreakout.breakoutHigh - price;
            const retracementPercent = (currentRetracement / breakoutMove) * 100;
            
            if (retracementPercent >= this.params.rubberBandReversalPercent) {
                reversalTriggered = true;
                reversalReason = `Retraced ${retracementPercent.toFixed(1)}% of breakout`;
            }
        } else { // SHORT
            // For SHORT breakout, check for reversal up
            
            // Check 1: Price re-enters OR
            if (this.params.reverseOnORReEntry && price >= low) {
                reversalTriggered = true;
                reversalReason = 'Price re-entered OR';
            }
            
            // Check 2: Price reversed by threshold %
            const breakoutMove = low - this.state.orbBreakout.breakoutLow;
            const currentRetracement = price - this.state.orbBreakout.breakoutLow;
            const retracementPercent = (currentRetracement / breakoutMove) * 100;
            
            if (retracementPercent >= this.params.rubberBandReversalPercent) {
                reversalTriggered = true;
                reversalReason = `Retraced ${retracementPercent.toFixed(1)}% of breakout`;
            }
        }
        
        if (reversalTriggered) {
            // Verify volume confirmation
            if (!this.isVolumeConfirmed(volume, this.params.rubberBandVolumeThreshold)) {
                return null;
            }
            
            // Generate rubber band reversal signal
            const reversalDirection = direction === 'LONG' ? 'SHORT' : 'LONG';
            const signal = this.generateRubberBandSignal(reversalDirection, price, timestamp, reversalReason);
            
            if (signal) {
                // Reset states
                this.state.orbBreakout.active = false;
                this.state.rubberBandSetup.monitoring = false;
                this.state.rubberBandSetup.reversalDetected = true;
                this.state.rubberBandSetup.reversalPrice = price;
                this.state.rubberBandSetup.reversalTime = timestamp;
                
                this.stats.rubberBandReversals++;
                console.log(`🔄 Rubber Band ${reversalDirection} at ${price.toFixed(2)} - ${reversalReason}`);
                
                return signal;
            }
        }
        
        return null;
    }
    
    // Update breakout extremes
    updateBreakoutExtremes(price) {
        if (!this.state.orbBreakout.active) return;
        
        if (price > this.state.orbBreakout.breakoutHigh) {
            this.state.orbBreakout.breakoutHigh = price;
        }
        if (price < this.state.orbBreakout.breakoutLow) {
            this.state.orbBreakout.breakoutLow = price;
        }
    }
    
    // Generate breakout signal
    generateBreakoutSignal(direction, price, timestamp) {
        // Check cooldown
        if (this.isInCooldown()) return null;
        
        const tradeParams = this.calculateTradeParameters(price, direction, 'BREAKOUT');
        
        if (!this.passesRiskFilter(tradeParams)) {
            return null;
        }
        
        const signal = {
            id: `ORB_${Date.now()}`,
            type: 'ORB_BREAKOUT',
            direction: direction,
            confidence: 'HIGH',
            entryPrice: tradeParams.entryPrice,
            stopLoss: tradeParams.stopLoss,
            takeProfit: tradeParams.takeProfit,
            
            riskPoints: tradeParams.riskPoints,
            rewardPoints: tradeParams.rewardPoints,
            riskRewardRatio: tradeParams.riskRewardRatio,
            
            positionSize: tradeParams.positionSize,
            dollarRisk: tradeParams.actualDollarRisk,
            dollarReward: tradeParams.actualDollarReward,
            
            timestamp: Date.now(),
            reason: `ORB ${direction} breakout with volume confirmation`,
            strategyName: this.name,
            strategyVersion: this.version,
            session: this.state.currentSession,
            signalStrength: 1.0,
            environment: { session: this.state.currentSession },
            
            indicators: {
                openingRangeHigh: this.state.openingRange.high,
                openingRangeLow: this.state.openingRange.low,
                breakoutThreshold: this.params.orbBreakoutPercent,
                volume: this.state.currentVolume,
                volumeMA: this.state.volumeMA,
                volumeRatio: this.state.volumeMA > 0 ? (this.state.currentVolume / this.state.volumeMA) : 1
            }
        };
        
        this.state.lastSignalTime = Date.now();
        this.stats.signalsGenerated++;
        
        return signal;
    }
    
    // Generate rubber band reversal signal
    generateRubberBandSignal(direction, price, timestamp, reason) {
        const tradeParams = this.calculateTradeParameters(price, direction, 'RUBBER_BAND');
        
        if (!this.passesRiskFilter(tradeParams)) {
            return null;
        }
        
        const signal = {
            id: `RB_${Date.now()}`,
            type: 'RUBBER_BAND_REVERSAL',
            direction: direction,
            confidence: 'VERY_HIGH',
            entryPrice: tradeParams.entryPrice,
            stopLoss: tradeParams.stopLoss,
            takeProfit: tradeParams.takeProfit,
            
            riskPoints: tradeParams.riskPoints,
            rewardPoints: tradeParams.rewardPoints,
            riskRewardRatio: tradeParams.riskRewardRatio,
            
            positionSize: tradeParams.positionSize,
            dollarRisk: tradeParams.actualDollarRisk,
            dollarReward: tradeParams.actualDollarReward,
            
            timestamp: Date.now(),
            reason: `Failed breakout reversal - ${reason}`,
            strategyName: this.name,
            strategyVersion: this.version,
            session: this.state.currentSession,
            signalStrength: 1.2, // Higher confidence for reversals
            environment: { session: this.state.currentSession },
            
            indicators: {
                openingRangeHigh: this.state.openingRange.high,
                openingRangeLow: this.state.openingRange.low,
                originalBreakoutPrice: this.state.orbBreakout.entryPrice,
                reversalPrice: price,
                volume: this.state.currentVolume,
                volumeMA: this.state.volumeMA,
                volumeRatio: this.state.volumeMA > 0 ? (this.state.currentVolume / this.state.volumeMA) : 1
            },
            
            // Important: Include the breakout position ID to close
            closePositionId: this.state.orbBreakout.signalId
        };
        
        this.state.lastSignalTime = Date.now();
        this.stats.signalsGenerated++;
        
        return signal;
    }
    
    // Calculate trade parameters
    calculateTradeParameters(price, direction, signalType) {
        const dollarRisk = this.params.dollarRiskPerTrade;
        const riskRewardRatio = this.params.riskRewardRatio;
        const pointValue = this.params.dollarPerPoint;
        const { high, low } = this.state.openingRange;
        
        let entryPrice, stopLoss, riskPoints, takeProfit, rewardPoints;
        
        entryPrice = price;
        
        if (signalType === 'BREAKOUT') {
            // For breakouts, stop at OR level
            if (direction === 'LONG') {
                stopLoss = low - 0.25; // Small buffer below OR low
                riskPoints = entryPrice - stopLoss;
                takeProfit = entryPrice + (riskPoints * riskRewardRatio);
                rewardPoints = takeProfit - entryPrice;
            } else { // SHORT
                stopLoss = high + 0.25; // Small buffer above OR high
                riskPoints = stopLoss - entryPrice;
                takeProfit = entryPrice - (riskPoints * riskRewardRatio);
                rewardPoints = entryPrice - takeProfit;
            }
        } else { // RUBBER_BAND
            // For rubber band, tighter stops
            if (direction === 'LONG') {
                // Stop below recent low
                stopLoss = this.state.orbBreakout.breakoutLow - 0.5;
                riskPoints = entryPrice - stopLoss;
                takeProfit = entryPrice + (riskPoints * riskRewardRatio);
                rewardPoints = takeProfit - entryPrice;
            } else { // SHORT
                // Stop above recent high
                stopLoss = this.state.orbBreakout.breakoutHigh + 0.5;
                riskPoints = stopLoss - entryPrice;
                takeProfit = entryPrice - (riskPoints * riskRewardRatio);
                rewardPoints = entryPrice - takeProfit;
            }
        }
        
        // Calculate position size
        const exactPositionSize = dollarRisk / (Math.abs(riskPoints) * pointValue);
        let positionSize = Math.round(exactPositionSize);
        positionSize = Math.max(1, positionSize);
        
        // Calculate actual dollar risk
        const actualDollarRisk = positionSize * Math.abs(riskPoints) * pointValue;
        const actualDollarReward = positionSize * Math.abs(rewardPoints) * pointValue;
        
        return {
            entryPrice,
            stopLoss,
            takeProfit,
            riskPoints: Math.abs(riskPoints),
            rewardPoints: Math.abs(rewardPoints),
            positionSize,
            actualDollarRisk,
            actualDollarReward,
            direction,
            riskRewardRatio
        };
    }
    
    // Check if we can generate a signal
    canGenerateSignal() {
        if (!this.params.oneTradeAtTime) return true;
        
        if (this.mainBot && this.mainBot.modules && this.mainBot.modules.positionManagement) {
            const positions = this.mainBot.modules.positionManagement.getAllPositions();
            return !positions || positions.length === 0;
        }
        
        return true;
    }
    
    // Update current session state
    updateSessionState(timestamp) {
        const time = timestamp.toLocaleTimeString('en-US', { 
            hour12: false, 
            timeZone: 'America/New_York' 
        });
        
        const [hours, minutes] = time.split(':').map(Number);
        const currentMinutes = hours * 60 + minutes;
        
        // Parse session times
        const [londonHour, londonMin] = this.params.londonOpenTime.split(':').map(Number);
        const londonMinutes = londonHour * 60 + londonMin;
        
        const [nyHour, nyMin] = this.params.nyOpenTime.split(':').map(Number);
        const nyMinutes = nyHour * 60 + nyMin;
        
        // Determine current session
        let newSession = null;
        if (currentMinutes >= londonMinutes && currentMinutes < nyMinutes) {
            newSession = 'LONDON';
        } else if (currentMinutes >= nyMinutes && currentMinutes < 16 * 60) { // 4 PM close
            newSession = 'NY';
        }
        
        // Handle session change
        if (newSession !== this.state.currentSession) {
            if (newSession) {
                console.log(`🔔 Session change: ${this.state.currentSession || 'NONE'} → ${newSession}`);
                this.resetForNewSession(newSession, timestamp);
            }
            this.state.currentSession = newSession;
        }
    }
    
    // Reset state for new session
    resetForNewSession(session, timestamp) {
        this.state.openingRange = {
            high: null,
            low: null,
            established: false,
            establishedTime: null,
            session: session
        };
        
        this.state.orbBreakout = {
            active: false,
            direction: null,
            entryPrice: null,
            breakoutTime: null,
            breakoutCandle: 0,
            breakoutHigh: null,
            breakoutLow: null,
            signalId: null
        };
        
        this.state.rubberBandSetup = {
            monitoring: false,
            reversalDetected: false,
            reversalPrice: null,
            reversalTime: null
        };
        
        this.state.sessionStartTime = timestamp;
        this.state.candleCount = 0;
        this.state.lastCandleTime = null; // Reset candle tracking
        this.state.volumeHistory = []; // Reset volume history for new session
        this.state.volumeMA = 0;
        
        // Reset SMA calculator for new session
        this.volumeSMA.reset();
        
        console.log(`📍 New ${session} session started at ${timestamp.toLocaleTimeString()}`);
    }
    
    // Check if we're within the opening range period
    isWithinOpeningRangePeriod(timestamp) {
        if (!this.state.sessionStartTime || this.state.openingRange.established) {
            return false;
        }
        
        const elapsed = timestamp - this.state.sessionStartTime;
        const elapsedMinutes = elapsed / (1000 * 60);
        
        return elapsedMinutes <= this.params.openingRangeDuration;
    }
    
    // Update opening range levels
    updateOpeningRange(price, timestamp) {
        if (!this.state.currentSession) return;
        
        // Initialize OR levels
        if (this.state.openingRange.high === null) {
            this.state.openingRange.high = price;
            this.state.openingRange.low = price;
            console.log(`📊 Opening Range initialized at ${price.toFixed(2)}`);
        } else {
            // Update high/low
            if (price > this.state.openingRange.high) {
                this.state.openingRange.high = price;
            }
            if (price < this.state.openingRange.low) {
                this.state.openingRange.low = price;
            }
        }
        
        // Check if OR period is complete
        const elapsed = timestamp - this.state.sessionStartTime;
        const elapsedMinutes = elapsed / (1000 * 60);
        
        if (elapsedMinutes >= this.params.openingRangeDuration && !this.state.openingRange.established) {
            this.state.openingRange.established = true;
            this.state.openingRange.establishedTime = timestamp;
            
            const range = this.state.openingRange.high - this.state.openingRange.low;
            console.log(`✅ ${this.state.currentSession} Opening Range established:`);
            console.log(`   High: ${this.state.openingRange.high.toFixed(2)}`);
            console.log(`   Low: ${this.state.openingRange.low.toFixed(2)}`);
            console.log(`   Range: ${range.toFixed(2)} points`);
        }
    }
    
    // Risk filter
    passesRiskFilter(tradeParams) {
        const maxRiskPoints = this.params.maxRiskPoints;
        const minRiskPoints = 0.5;
        
        if (tradeParams.riskPoints > maxRiskPoints) {
            console.log(`🚫 Risk Filter: ${tradeParams.riskPoints.toFixed(2)} pts > ${maxRiskPoints} pts max`);
            return false;
        }
        
        if (tradeParams.riskPoints < minRiskPoints) {
            console.log(`🚫 Risk Filter: ${tradeParams.riskPoints.toFixed(2)} pts < ${minRiskPoints} pts minimum`);
            return false;
        }
        
        return true;
    }
    
    // Check if in cooldown period
    isInCooldown() {
        if (!this.state.lastSignalTime) return false;
        return (Date.now() - this.state.lastSignalTime) < this.params.signalCooldownMs;
    }
    
    // Create empty response
    createEmptyResponse(reason) {
        return {
            ready: true,
            signal: null,
            state: this.getStateSnapshot(),
            stats: { ...this.stats },
            debug: { reason }
        };
    }
    
    // Get current state snapshot
    getStateSnapshot() {
        return {
            openingRange: { ...this.state.openingRange },
            orbBreakout: { ...this.state.orbBreakout },
            rubberBandSetup: { ...this.state.rubberBandSetup },
            currentSession: this.state.currentSession,
            inCooldown: this.isInCooldown(),
            volumeMA: this.state.volumeMA,
            currentVolume: this.state.currentVolume,
            candleCount: this.state.candleCount,
            lastCandleTime: this.state.lastCandleTime,
            candleIntervalMinutes: this.params.candleIntervalMinutes
        };
    }
    
    // Get strategy parameters
    getParameters() {
        return { ...this.params };
    }
    
    // Get status summary
    getStatusSummary() {
        return {
            module: 'Strategy',
            status: 'READY',
            name: this.name,
            version: this.version,
            strategyType: 'ORB_RUBBER_BAND',
            state: this.getStateSnapshot(),
            stats: { ...this.stats }
        };
    }
    
    // Reset strategy
    reset() {
        this.state = {
            openingRange: {
                high: null,
                low: null,
                established: false,
                establishedTime: null,
                session: null
            },
            volumeHistory: [],
            volumeMA: 0,
            currentVolume: 0,
            orbBreakout: {
                active: false,
                direction: null,
                entryPrice: null,
                breakoutTime: null,
                breakoutCandle: 0,
                breakoutHigh: null,
                breakoutLow: null,
                signalId: null
            },
            rubberBandSetup: {
                monitoring: false,
                reversalDetected: false,
                reversalPrice: null,
                reversalTime: null
            },
            currentPosition: null,
            lastSignalTime: null,
            candleCount: 0,
            lastCandleTime: null,
            currentSession: null,
            sessionStartTime: null
        };
        
        // Reset SMA calculator
        this.volumeSMA.reset();
        
        console.log(`🔄 ${this.name} reset complete`);
    }
    
    // Get debug information
    getDebugInfo() {
        return {
            strategy: {
                name: this.name,
                version: this.version,
                params: this.params
            },
            state: this.state,
            stats: this.stats
        };
    }
}

module.exports = ORBRubberBandStrategy;