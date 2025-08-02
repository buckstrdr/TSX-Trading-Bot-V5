// modules/emaStrategy.js
// EMA 9 Retracement Scalping Strategy v2.1
// Based on official strategy specification for Micro Gold Futures

const EMACalculator = require('../../indicators/EMACalculator');

class EMASignalGenerator {
    constructor(params, mainBot = null) {
        this.params = params;
        this.lastSignalTime = null;
        this.mainBot = mainBot; // CRITICAL FIX: Store mainBot reference
        this.lastPositionBlockLog = null; // FUTURES FIX: Track last position block log
        
        // Quiet mode support - NEW FEATURE
        this.suppressVerboseLogging = false;
        this.loggedMessagesCount = 0;
        this.signalCheckCount = 0; // Track how many times generateSignal is called
        this.stateChangeCount = 0; // Track state changes
        
        // Strategy v3.0 state machine
        this.stateMachine = {
            // Current state for each candle
            currentState: 'NEUTRAL',
            
            // Track state for real-time signal generation
            longSetup: {
                hasEnteredZone: false,      // Price went below EMA 9
                entryTime: null,
                entryCandle: null,          // Track which candle we entered on
                candlesSinceEntry: 0,       // Count candles since entry
                lowBelowEMA: null,
                highPrice: null,
                hasRetraced: false,          // Price came back above EMA 9
                retraceTime: null,
                validSetup: false
            },
            
            shortSetup: {
                hasEnteredZone: false,       // Price went above EMA 9
                entryTime: null,
                entryCandle: null,          // Track which candle we entered on
                candlesSinceEntry: 0,       // Count candles since entry
                highAboveEMA: null,
                lowPrice: null,
                hasRetraced: false,          // Price came back below EMA 9
                retraceTime: null,
                validSetup: false
            },
            
            // State history for debugging
            stateHistory: [],
            lastUpdateTime: null
        };
        
        // Strategy mode state tracking
        this.strategyState = {
            mode: params.mode || 'STANDARD',
            waitingForLongPullback: false,
            waitingForShortPullback: false,
            lastTrendDirection: 'NEUTRAL',
            consecutiveInvalidations: 0,
            // Consolidation tracking for maxBarsSinceEMA
            consolidationCandles: 0,
            lastConsolidationCheck: null,
            // Post-trade timeout tracking
            lastTradeCloseTime: null,
            lastTradeWasWin: null  // Track if last trade hit TP or SL
        };
        
        console.log(`📊 EMA 9 Retracement Scalping v3.0 - ${this.params.mode} mode`);
        console.log('🎯 Strategy: Real-time state machine with dynamic risk');
        console.log('📈 Entry: When price retraces back through EMA 9');
        console.log('🛡️  Stop: Dynamic based on EMA 19 distance');
        console.log('🎯 Target: Entry ± (Risk × R:R ratio)');
        
        if (params.mode === 'CONSERVATIVE') {
            console.log('🛡️  Conservative mode: EMA invalidation filter enabled');
            console.log('   Expected: ~45-50 trades/day, 48-50% win rate');
        } else {
            console.log('🚀 Standard v3.0 mode: Real-time signal generation');
            console.log('   Expected: ~139 trades/day, 52.4% win rate');
        }
    }

    // Track position closure for post-trade timeout
    onPositionClosed(timestamp, wasProfit) {
        this.strategyState.lastTradeCloseTime = timestamp;
        this.strategyState.lastTradeWasWin = wasProfit;
        
        const timeoutSeconds = wasProfit ? 
            (this.params.postWinCandleTimeout || 180) : 
            (this.params.postLossCandleTimeout || 600);
            
        console.log(`📊 [POST-TRADE] Position closed - ${wasProfit ? '✅ PROFIT' : '❌ LOSS'}. Waiting ${timeoutSeconds} seconds`);
    }
    
    // Real-time price update for state machine
    updatePriceState(price, ema9, ema19, timestamp, currentCandle = null) {
        const stateUpdate = {
            price,
            ema9,
            ema19,
            timestamp,
            currentCandle,
            previousState: this.stateMachine.currentState
        };
        
        // Determine trend
        const trend = this.analyzeTrendV3(price, ema9, ema19);
        
        // Update state machine based on price action
        if (trend.direction === 'LONG') {
            this.updateLongState(price, ema9, ema19, timestamp, currentCandle);
        } else if (trend.direction === 'SHORT') {
            this.updateShortState(price, ema9, ema19, timestamp, currentCandle);
        } else {
            this.resetStates('NO_TREND');
        }
        
        // Record state change
        if (this.stateMachine.currentState !== stateUpdate.previousState) {
            this.stateMachine.stateHistory.push({
                ...stateUpdate,
                newState: this.stateMachine.currentState,
                time: new Date(timestamp).toLocaleTimeString()
            });
            
            // Keep only last 50 state changes
            if (this.stateMachine.stateHistory.length > 50) {
                this.stateMachine.stateHistory.shift();
            }
        }
        
        // Check for consolidation between EMAs
        this.updateConsolidationTracking(price, ema9, ema19, currentCandle);
        
        this.stateMachine.lastUpdateTime = timestamp;
    }
    
    // Track consolidation between EMAs
    updateConsolidationTracking(price, ema9, ema19, currentCandle) {
        const minEMA = Math.min(ema9, ema19);
        const maxEMA = Math.max(ema9, ema19);
        
        // Check if price is consolidating between the EMAs
        const isBetweenEMAs = price >= minEMA && price <= maxEMA;
        
        if (currentCandle && currentCandle.timestamp !== this.strategyState.lastConsolidationCheck) {
            // New candle - update consolidation count
            if (isBetweenEMAs) {
                this.strategyState.consolidationCandles++;
                if (!this.isQuietModeActive() && this.strategyState.consolidationCandles % 5 === 0) {
                    console.log(`📉 [CONSOLIDATION] Price between EMAs for ${this.strategyState.consolidationCandles} candles`);
                }
            } else {
                // Price broke out of consolidation
                if (this.strategyState.consolidationCandles > 3) {
                    console.log(`🚀 [BREAKOUT] Price broke consolidation after ${this.strategyState.consolidationCandles} candles`);
                }
                this.strategyState.consolidationCandles = 0;
            }
            this.strategyState.lastConsolidationCheck = currentCandle.timestamp;
        }
    }
    
    // Update state machine for LONG setups
    updateLongState(price, ema9, ema19, timestamp, currentCandle) {
        const setup = this.stateMachine.longSetup;
        
        // State 1: Check if price enters the zone (goes below EMA 9)
        if (!setup.hasEnteredZone && price < ema9) {
            setup.hasEnteredZone = true;
            setup.entryTime = timestamp;
            setup.entryCandle = currentCandle ? currentCandle.timestamp : timestamp;
            setup.candlesSinceEntry = 0;
            setup.lowBelowEMA = price;
            setup.highPrice = price;
            this.stateMachine.currentState = 'LONG_ZONE_ENTERED';
            // CR-002: Suppress zone entry logs - only log when signal is actually generated
        }
        
        // State 2: Track extremes while in zone
        if (setup.hasEnteredZone && !setup.hasRetraced) {
            // Check if we've moved to a new candle
            if (currentCandle && currentCandle.timestamp !== setup.entryCandle && 
                currentCandle.timestamp > setup.entryCandle) {
                setup.candlesSinceEntry++;
                setup.entryCandle = currentCandle.timestamp;
                // CR-002: Suppress candle tracking logs
                
                // Reset if we've been in zone for 2 candles without retrace
                if (setup.candlesSinceEntry >= 2) {
                    // CR-002: Suppress timeout logs
                    this.resetLongSetup('CANDLE_TIMEOUT');
                    return;
                }
            }
            
            setup.lowBelowEMA = Math.min(setup.lowBelowEMA, price);
            setup.highPrice = Math.max(setup.highPrice, price);
            
            // Check for retrace (price moves back above EMA 9)
            if (price > ema9) {
                setup.hasRetraced = true;
                setup.retraceTime = timestamp;
                setup.validSetup = true;
                this.stateMachine.currentState = 'LONG_RETRACED';
                // ALWAYS log important state changes like valid setups
                console.log(`✅ [STATE] LONG setup - Price retraced above EMA 9: ${price.toFixed(2)}`);
                console.log(`   Zone Low: ${setup.lowBelowEMA.toFixed(2)}, Current: ${price.toFixed(2)}`);
            }
        }
        
        // Reset if price goes too far from EMA 9 (invalidation)
        if (setup.hasEnteredZone && !setup.hasRetraced && price < ema9 - 5) {
            this.resetLongSetup('PRICE_TOO_FAR');
        }
    }
    
    // Update state machine for SHORT setups
    updateShortState(price, ema9, ema19, timestamp, currentCandle) {
        const setup = this.stateMachine.shortSetup;
        
        // State 1: Check if price enters the zone (goes above EMA 9)
        if (!setup.hasEnteredZone && price > ema9) {
            setup.hasEnteredZone = true;
            setup.entryTime = timestamp;
            setup.entryCandle = currentCandle ? currentCandle.timestamp : timestamp;
            setup.candlesSinceEntry = 0;
            setup.highAboveEMA = price;
            setup.lowPrice = price;
            this.stateMachine.currentState = 'SHORT_ZONE_ENTERED';
            // CR-002: Suppress zone entry logs - only log when signal is actually generated
        }
        
        // State 2: Track extremes while in zone
        if (setup.hasEnteredZone && !setup.hasRetraced) {
            // Check if we've moved to a new candle
            if (currentCandle && currentCandle.timestamp !== setup.entryCandle && 
                currentCandle.timestamp > setup.entryCandle) {
                setup.candlesSinceEntry++;
                setup.entryCandle = currentCandle.timestamp;
                // CR-002: Suppress candle tracking logs
                
                // Reset if we've been in zone for 2 candles without retrace
                if (setup.candlesSinceEntry >= 2) {
                    // CR-002: Suppress timeout logs
                    this.resetShortSetup('CANDLE_TIMEOUT');
                    return;
                }
            }
            
            setup.highAboveEMA = Math.max(setup.highAboveEMA, price);
            setup.lowPrice = Math.min(setup.lowPrice, price);
            
            // Check for retrace (price moves back below EMA 9)
            if (price < ema9) {
                setup.hasRetraced = true;
                setup.retraceTime = timestamp;
                setup.validSetup = true;
                this.stateMachine.currentState = 'SHORT_RETRACED';
                // ALWAYS log important state changes like valid setups
                console.log(`✅ [STATE] SHORT setup - Price retraced below EMA 9: ${price.toFixed(2)}`);
                console.log(`   Zone High: ${setup.highAboveEMA.toFixed(2)}, Current: ${price.toFixed(2)}`);
            }
        }
        
        // Reset if price goes too far from EMA 9 (invalidation)
        if (setup.hasEnteredZone && !setup.hasRetraced && price > ema9 + 5) {
            this.resetShortSetup('PRICE_TOO_FAR');
        }
    }

    generateSignal(emaData, currentPrice, environment) {
        const { ema9, ema19, currentCandle } = emaData;
        
        // FUTURES FIX: Check for existing positions before generating signals
        if (this.mainBot && this.mainBot.modules && this.mainBot.modules.positionManagement) {
            const positions = this.mainBot.modules.positionManagement.getAllPositions();
            if (positions && positions.length > 0) {
                // Calculate total position size
                const totalSize = positions.reduce((sum, pos) => sum + (pos.size || 0), 0);
                
                // Only log once every 30 seconds to avoid spam
                if (!this.lastPositionBlockLog || Date.now() - this.lastPositionBlockLog > 30000) {
                    console.log('🚫 [EMA Strategy] Signal generation blocked - position already exists');
                    console.log(`⚠️  Existing positions: ${positions.length} (${totalSize} contracts)`);
                    this.lastPositionBlockLog = Date.now();
                }
                
                return null;
            }
        }
        
        // Check post-trade timeout in seconds
        if (this.strategyState.lastTradeCloseTime) {
            const timeoutSeconds = this.strategyState.lastTradeWasWin === true ? 
                (this.params.postWinCandleTimeout || 180) : 
                this.strategyState.lastTradeWasWin === false ?
                (this.params.postLossCandleTimeout || 600) :
                0; // No timeout if we don't know the last trade result
                
            const secondsSinceClose = (timestamp - this.strategyState.lastTradeCloseTime) / 1000;
            
            if (secondsSinceClose < timeoutSeconds) {
                if (!this.isQuietModeActive()) {
                    const reason = this.strategyState.lastTradeWasWin ? 'After WIN' : 'After LOSS';
                    const remainingSeconds = Math.round(timeoutSeconds - secondsSinceClose);
                    console.log(`⏳ [POST-TRADE] ${reason}: Waiting ${remainingSeconds} more seconds`);
                }
                return null;
            }
        }
        
        // Check consolidation timeout
        const maxBarsSinceEMA = this.params.maxBarsSinceEMA || 15;
        if (this.strategyState.consolidationCandles >= maxBarsSinceEMA) {
            if (!this.isQuietModeActive()) {
                console.log(`🚫 [CONSOLIDATION] Market too choppy - ${this.strategyState.consolidationCandles} candles between EMAs`);
            }
            return null;
        }
        
        // Increment signal check counter
        this.signalCheckCount++;
        
        // NEW: Check if we should suppress verbose logging during prompts
        const shouldLogVerbose = !this.isQuietModeActive();
        
        // CR-002: Only log actual signals and important state transitions
        // Never log routine state monitoring (NEUTRAL, ZONE_ENTERED, etc.)
        const shouldLogThisCheck = false;  // Disable all routine logging
        
        if (shouldLogVerbose && shouldLogThisCheck) {
            console.log(`\n🎯 [GENERATE SIGNAL] Check #${this.signalCheckCount} at ${new Date().toLocaleTimeString()}`);
            console.log(`   State: ${this.stateMachine.currentState}`);
        } else {
            this.loggedMessagesCount++;
        }
        
        if (!ema9 || !ema19) {
            if (shouldLogVerbose && shouldLogThisCheck) {
                console.log(`   ❌ Missing EMAs - EMA9: ${!!ema9}, EMA19: ${!!ema19}`);
            }
            return null;
        }
        
        if (shouldLogVerbose && shouldLogThisCheck) {
            console.log(`   Price: ${currentPrice.toFixed(2)}`);
            console.log(`   EMAs: 9=${ema9.toFixed(2)}, 19=${ema19.toFixed(2)}`);
            console.log(`   Spread: ${Math.abs(ema9 - ema19).toFixed(2)} points`);
        }

        // Conservative Mode: Check for EMA invalidation
        if (this.params.mode === 'CONSERVATIVE' && currentCandle) {
            const invalidationResult = this.checkEMAInvalidation(currentCandle, ema9, ema19);
            if (invalidationResult.invalidated) {
                this.resetStates('EMA_INVALIDATION');
                return null;
            }
        }

        // Check LONG setup completion
        if (this.stateMachine.longSetup.validSetup) {
            if (shouldLogVerbose) {
                console.log(`🎯 [SIGNAL] Checking LONG setup validity...`);
            }
            
            // Additional trend confirmation
            const trend = this.analyzeTrendV3(currentPrice, ema9, ema19);
            if (trend.direction !== 'LONG') {
                if (shouldLogVerbose) {
                    console.log(`   ❌ Trend no longer LONG`);
                }
                this.resetLongSetup('TREND_CHANGED');
                return null;
            }
            
            // Check EMA distance for trend strength
            const emaDistance = Math.abs(ema9 - ema19);
            if (emaDistance < this.params.minEMASpread) {
                if (shouldLogVerbose) {
                    console.log(`   ❌ EMA spread too narrow: ${emaDistance.toFixed(2)} < ${this.params.minEMASpread}`);
                }
                this.resetLongSetup('WEAK_TREND');
                return null;
            }
            
            // Calculate dynamic position sizing based on actual EMA distance
            const tradeParams = this.calculateDynamicTradeParameters(ema9, ema19, 'LONG');
            
            // Apply risk filter
            if (!this.passesDynamicRiskFilter(tradeParams)) {
                this.resetLongSetup('RISK_FILTER');
                return null;
            }
            
            // Generate signal
            const signal = this.createSignal('LONG', tradeParams, ema9, ema19, currentPrice, environment);
            
            // Reset state after signal generation
            this.resetLongSetup('SIGNAL_GENERATED');
            this.lastSignalTime = Date.now();
            
            return signal;
        }
        
        // Check SHORT setup completion
        if (this.stateMachine.shortSetup.validSetup) {
            if (shouldLogVerbose) {
                console.log(`🎯 [SIGNAL] Checking SHORT setup validity...`);
            }
            
            // Additional trend confirmation
            const trend = this.analyzeTrendV3(currentPrice, ema9, ema19);
            if (trend.direction !== 'SHORT') {
                if (shouldLogVerbose) {
                    console.log(`   ❌ Trend no longer SHORT`);
                }
                this.resetShortSetup('TREND_CHANGED');
                return null;
            }
            
            // Check EMA distance for trend strength
            const emaDistance = Math.abs(ema9 - ema19);
            if (emaDistance < this.params.minEMASpread) {
                if (shouldLogVerbose) {
                    console.log(`   ❌ EMA spread too narrow: ${emaDistance.toFixed(2)} < ${this.params.minEMASpread}`);
                }
                this.resetShortSetup('WEAK_TREND');
                return null;
            }
            
            // Calculate dynamic position sizing based on actual EMA distance
            const tradeParams = this.calculateDynamicTradeParameters(ema9, ema19, 'SHORT');
            
            // Apply risk filter
            if (!this.passesDynamicRiskFilter(tradeParams)) {
                this.resetShortSetup('RISK_FILTER');
                return null;
            }
            
            // Generate signal
            const signal = this.createSignal('SHORT', tradeParams, ema9, ema19, currentPrice, environment);
            
            // Reset state after signal generation
            this.resetShortSetup('SIGNAL_GENERATED');
            this.lastSignalTime = Date.now();
            
            return signal;
        }
        
        return null;
    }

    // v3.0 Trend Analysis
    analyzeTrendV3(currentPrice, ema9, ema19) {
        const minEMA = Math.min(ema9, ema19);
        const maxEMA = Math.max(ema9, ema19);
        
        // Long trend: price > min(ema9, ema19) AND ema9 >= ema19
        const longTrend = currentPrice > minEMA && ema9 >= ema19;
        
        // Short trend: price < max(ema9, ema19) AND ema9 <= ema19  
        const shortTrend = currentPrice < maxEMA && ema9 <= ema19;
        
        if (longTrend) {
            return { 
                isTrending: true, 
                direction: 'LONG',
                trendConfirmed: true,
                trendStrength: this.calculateTrendStrength(currentPrice, ema9, ema19, 'LONG')
            };
        } else if (shortTrend) {
            return { 
                isTrending: true, 
                direction: 'SHORT',
                trendConfirmed: true,
                trendStrength: this.calculateTrendStrength(currentPrice, ema9, ema19, 'SHORT')
            };
        } else {
            return { 
                isTrending: false, 
                direction: 'NEUTRAL',
                trendConfirmed: false,
                trendStrength: 0
            };
        }
    }

    // Calculate DYNAMIC trade parameters based on actual EMA distance
    calculateDynamicTradeParameters(ema9, ema19, direction) {
        // Get risk configuration - CRITICAL FIX: Remove fallback to 100
        const dollarRisk = this.params.dollarRiskPerTrade;
        if (!dollarRisk || dollarRisk <= 0) {
            console.error(`❌ CRITICAL ERROR: Invalid dollarRiskPerTrade: ${dollarRisk}`);
            console.error(`   Please check risk configuration!`);
            throw new Error('Invalid risk configuration - dollarRiskPerTrade not set');
        }
        const riskRewardRatio = this.params.riskRewardRatio || 3;
        const pointValue = this.params.dollarPerPoint;
        
        if (!pointValue || pointValue <= 0) {
            console.error(`❌ CRITICAL ERROR: Invalid dollarPerPoint: ${pointValue}`);
            console.error(`   Please check contract configuration!`);
            throw new Error('Invalid contract configuration - dollarPerPoint not set');
        }
        
        const stopLossOffset = this.params.stopLossOffset || 0; // New parameter for SL offset in ticks
        
        let entryPrice, stopLoss, riskPoints, takeProfit, rewardPoints;
        
        // Entry at EMA 9
        entryPrice = ema9;
        
        // Stop at EMA 19 with optional offset (dynamic distance)
        if (direction === 'LONG') {
            stopLoss = ema19 - (stopLossOffset * 0.1); // Subtract offset for LONG (gives more room below)
        } else {
            stopLoss = ema19 + (stopLossOffset * 0.1); // Add offset for SHORT (gives more room above)
        }
        
        if (direction === 'LONG') {
            riskPoints = entryPrice - stopLoss;
            takeProfit = entryPrice + (riskPoints * riskRewardRatio);
            rewardPoints = takeProfit - entryPrice;
        } else { // SHORT
            riskPoints = stopLoss - entryPrice;
            takeProfit = entryPrice - (riskPoints * riskRewardRatio);
            rewardPoints = entryPrice - takeProfit;
        }
        
        // Calculate position size based on dollar risk and actual stop distance
        // ENHANCED: Smart rounding - up to 50% over budget allowed
        const exactPositionSize = dollarRisk / (Math.abs(riskPoints) * pointValue);
        let positionSize = Math.ceil(exactPositionSize);  // Try rounding up first
        
        // Check if rounding up would exceed 50% over budget
        const roundedUpRisk = positionSize * Math.abs(riskPoints) * pointValue;
        const overRiskPercent = ((roundedUpRisk / dollarRisk - 1) * 100);
        
        if (overRiskPercent > 50) {
            // Too much risk, round down instead
            positionSize = Math.floor(exactPositionSize);
            console.log(`💰 [RISK LIMIT] Rounding DOWN to ${positionSize} contracts (up would be ${overRiskPercent.toFixed(1)}% over budget)`);
        }
        
        positionSize = Math.max(1, positionSize);  // Ensure at least 1 contract
        
        // Calculate actual dollar risk with position size
        const actualDollarRisk = positionSize * Math.abs(riskPoints) * pointValue;
        const actualDollarReward = positionSize * Math.abs(rewardPoints) * pointValue;
        
        if (!this.isQuietModeActive()) {
            const finalOverRisk = ((actualDollarRisk/dollarRisk - 1) * 100);
            console.log(`💰 [DYNAMIC RISK] Calculating position size:`);
            console.log(`   Risk Budget: ${dollarRisk}`);
            console.log(`   Stop Distance: ${Math.abs(riskPoints).toFixed(2)} points`);
            console.log(`   Exact Position: ${exactPositionSize.toFixed(2)} contracts`);
            console.log(`   Final Position: ${positionSize} contracts (${positionSize > exactPositionSize ? 'rounded UP' : 'rounded DOWN'})`);
            console.log(`   Actual Risk: ${actualDollarRisk.toFixed(2)} (${finalOverRisk > 0 ? '+' : ''}${finalOverRisk.toFixed(1)}% vs budget)`);
            if (finalOverRisk > 0) {
                console.log(`   ✅ Within 50% tolerance (${finalOverRisk.toFixed(1)}% ≤ 50%)`);
            }
        }
        
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

    // Dynamic risk filter
    passesDynamicRiskFilter(tradeParams) {
        const maxRiskPoints = this.params.maxRiskPoints || 3.0;
        const minRiskPoints = 0.1;
        const maxOverRiskPercent = 50; // Max 50% over risk budget when rounding up
        
        if (tradeParams.riskPoints > maxRiskPoints) {
            if (!this.isQuietModeActive()) {
                console.log(`🚫 Risk Filter: ${tradeParams.riskPoints.toFixed(2)} pts > ${maxRiskPoints} pts max`);
            }
            return false;
        }
        
        if (tradeParams.riskPoints < minRiskPoints) {
            if (!this.isQuietModeActive()) {
                console.log(`🚫 Risk Filter: ${tradeParams.riskPoints.toFixed(2)} pts < ${minRiskPoints} pts minimum`);
            }
            return false;
        }
        
        // Check if position size is reasonable
        if (tradeParams.positionSize > 10) {
            if (!this.isQuietModeActive()) {
                console.log(`🚫 Risk Filter: Position size ${tradeParams.positionSize} too large (max 10)`);
            }
            return false;
        }
        
        // NEW: Check if rounding up caused excessive risk increase
        const riskBudget = this.params.dollarRiskPerTrade;
        const actualRisk = tradeParams.actualDollarRisk;
        const overRiskPercent = ((actualRisk / riskBudget - 1) * 100);
        
        if (overRiskPercent > maxOverRiskPercent) {
            if (!this.isQuietModeActive()) {
                console.log(`🚫 Risk Filter: Actual risk ${actualRisk.toFixed(2)} is ${overRiskPercent.toFixed(1)}% over budget (max ${maxOverRiskPercent}% allowed)`);
            }
            return false;
        }
        
        return true;
    }

    // Create signal object
    createSignal(direction, tradeParams, ema9, ema19, currentPrice, environment) {
        const signal = {
            // Core signal properties
            direction: direction,
            confidence: 'HIGH',
            entryPrice: tradeParams.entryPrice,
            stopLoss: tradeParams.stopLoss,
            takeProfit: tradeParams.takeProfit,
            
            // Risk metrics
            riskPoints: tradeParams.riskPoints,
            rewardPoints: tradeParams.rewardPoints,
            riskRewardRatio: tradeParams.riskRewardRatio,
            
            // Position sizing
            positionSize: tradeParams.positionSize,
            dollarRisk: tradeParams.actualDollarRisk,
            dollarReward: tradeParams.actualDollarReward,
            
            // Metadata
            timestamp: Date.now(),
            reason: `EMA 9 ${direction} retracement with state validation`,
            subStrategy: this.params.mode,
            environment: environment,
            
            // Required fields
            signalStrength: 1.0,
            strategyName: 'EMA_9_RETRACEMENT_SCALPING',
            strategyVersion: '3.0',
            
            // Indicators
            indicators: {
                ema9: ema9,
                ema19: ema19,
                currentPrice: currentPrice,
                emaSpread: Math.abs(ema9 - ema19),
                stateMachine: {
                    state: this.stateMachine.currentState,
                    longSetup: { ...this.stateMachine.longSetup },
                    shortSetup: { ...this.stateMachine.shortSetup }
                }
            },
            
            // v3.0 specific
            v3Data: {
                dynamicPositionSizing: true,
                actualStopDistance: tradeParams.riskPoints,
                calculatedPositionSize: tradeParams.positionSize,
                stateValidated: true
            }
        };

        // ALWAYS log actual signal generation - this is important!
        console.log(`🎯 EMA v3.0 ${direction} signal generated`);
        console.log(`   Entry: ${tradeParams.entryPrice.toFixed(2)} (EMA 9)`);
        console.log(`   Stop: ${tradeParams.stopLoss.toFixed(2)} (EMA 19)`);
        console.log(`   Target: ${tradeParams.takeProfit.toFixed(2)} (1:${tradeParams.riskRewardRatio} R:R)`);
        console.log(`   Risk: ${tradeParams.riskPoints.toFixed(2)} pts`);
        console.log(`   Position: ${tradeParams.positionSize} contracts`);
        console.log(`   Dollar Risk: ${tradeParams.actualDollarRisk.toFixed(2)}`);
        
        return signal;
    }

    // CRITICAL FIX: Check if quiet mode is active (prompts or manual setting)
    isQuietModeActive() {
        try {
            // Primary check: Health monitoring manager's quiet mode status
            if (this.mainBot && this.mainBot.modules && this.mainBot.modules.healthMonitoring) {
                const quietStatus = this.mainBot.modules.healthMonitoring.getQuietModeStatus();
                if (quietStatus.currentlyQuiet) {
                    return true;
                }
            }
            
            // Secondary check: Keyboard interface prompt state (direct check)
            if (this.mainBot && this.mainBot.modules && this.mainBot.modules.keyboardInterface) {
                const promptState = this.mainBot.modules.keyboardInterface.getPromptState();
                if (promptState.isPromptActive) {
                    return true;
                }
            }
            
            // Tertiary check: Manual trading awaiting confirmation
            if (this.mainBot && this.mainBot.modules && this.mainBot.modules.manualTrading) {
                if (this.mainBot.modules.manualTrading.awaitingConfirmation) {
                    return true;
                }
            }
            
            // Fallback: check if manually set
            return this.suppressVerboseLogging;
        } catch (error) {
            // If error occurs, use fallback to avoid breaking the strategy
            return this.suppressVerboseLogging;
        }
    }
    
    // NEW: Manual quiet mode control
    setQuietMode(enabled) {
        this.suppressVerboseLogging = enabled;
        if (enabled) {
            console.log('🔇 EMA Strategy: Verbose logging suppressed for prompt interaction');
        } else {
            console.log(`🔊 EMA Strategy: Verbose logging resumed (suppressed ${this.loggedMessagesCount} messages)`);
            this.loggedMessagesCount = 0;
        }
    }
    
    // State reset methods - WITH QUIET MODE SUPPORT
    resetStates(reason) {
        // CR-002: Suppress state reset logs unless it's a significant event
        const significantReasons = ['SIGNAL_GENERATED', 'STRATEGY_RESET', 'EMA_INVALIDATION'];
        if (!this.isQuietModeActive() && significantReasons.includes(reason)) {
            console.log(`🔄 [STATE] Resetting states: ${reason}`);
        }
        this.resetLongSetup(reason);
        this.resetShortSetup(reason);
        this.stateMachine.currentState = 'NEUTRAL';
    }
    
    resetLongSetup(reason) {
        // CR-002: Only log significant resets
        const significantReasons = ['SIGNAL_GENERATED', 'STRATEGY_RESET', 'EMA_INVALIDATION'];
        if (this.stateMachine.longSetup.hasEnteredZone && !this.isQuietModeActive() && significantReasons.includes(reason)) {
            console.log(`🔄 [STATE] Resetting LONG setup: ${reason}`);
        }
        this.stateMachine.longSetup = {
            hasEnteredZone: false,
            entryTime: null,
            entryCandle: null,
            candlesSinceEntry: 0,
            lowBelowEMA: null,
            highPrice: null,
            hasRetraced: false,
            retraceTime: null,
            validSetup: false
        };
    }
    
    resetShortSetup(reason) {
        // CR-002: Only log significant resets
        const significantReasons = ['SIGNAL_GENERATED', 'STRATEGY_RESET', 'EMA_INVALIDATION'];
        if (this.stateMachine.shortSetup.hasEnteredZone && !this.isQuietModeActive() && significantReasons.includes(reason)) {
            console.log(`🔄 [STATE] Resetting SHORT setup: ${reason}`);
        }
        this.stateMachine.shortSetup = {
            hasEnteredZone: false,
            entryTime: null,
            entryCandle: null,
            candlesSinceEntry: 0,
            highAboveEMA: null,
            lowPrice: null,
            hasRetraced: false,
            retraceTime: null,
            validSetup: false
        };
    }

    // v2.1 Trend Analysis - Enhanced logic
    analyzeTrendV21(currentPrice, ema9, ema19) {
        // v2.1 trend conditions with improved inclusive comparisons
        const minEMA = Math.min(ema9, ema19);
        const maxEMA = Math.max(ema9, ema19);
        
        // Long trend: price > min(ema9, ema19) AND ema9 >= ema19
        const longTrend = currentPrice > minEMA && ema9 >= ema19;
        
        // Short trend: price < max(ema9, ema19) AND ema9 <= ema19  
        const shortTrend = currentPrice < maxEMA && ema9 <= ema19;
        
        if (longTrend) {
            return { 
                isTrending: true, 
                direction: 'LONG',
                trendConfirmed: true,
                trendStrength: this.calculateTrendStrength(currentPrice, ema9, ema19, 'LONG')
            };
        } else if (shortTrend) {
            return { 
                isTrending: true, 
                direction: 'SHORT',
                trendConfirmed: true,
                trendStrength: this.calculateTrendStrength(currentPrice, ema9, ema19, 'SHORT')
            };
        } else {
            return { 
                isTrending: false, 
                direction: 'NEUTRAL',
                trendConfirmed: false,
                trendStrength: 0
            };
        }
    }

    // Check for retracement entry conditions
    checkRetracementEntry(candle, ema9, direction) {
        // ADD DEBUG LOGGING
        console.log(`🔍 [EMA DEBUG] Checking ${direction} retracement:`);
        console.log(`   Candle: O:${candle.open.toFixed(2)} H:${candle.high.toFixed(2)} L:${candle.low.toFixed(2)} C:${candle.close.toFixed(2)}`);
        console.log(`   EMA 9: ${ema9.toFixed(2)}`);
        
        if (direction === 'LONG') {
            // Long entry: candle LOW touches/goes below EMA 9 AND candle CLOSE is above EMA 9
            const lowTouchesEMA9 = candle.low <= ema9;
            const closeAboveEMA9 = candle.close > ema9;
            
            console.log(`   LONG conditions:`);
            console.log(`   - Low touches EMA9? ${lowTouchesEMA9} (${candle.low.toFixed(2)} <= ${ema9.toFixed(2)})`);
            console.log(`   - Close above EMA9? ${closeAboveEMA9} (${candle.close.toFixed(2)} > ${ema9.toFixed(2)})`);
            console.log(`   - Valid signal? ${lowTouchesEMA9 && closeAboveEMA9}`);
            
            if (lowTouchesEMA9 && closeAboveEMA9) {
                return { 
                    isValid: true, 
                    confidence: 'HIGH',
                    reason: 'Clean retracement to EMA 9 with bullish close',
                    retracementType: 'BULLISH_RETRACEMENT'
                };
            }
        } else if (direction === 'SHORT') {
            // Short entry: candle HIGH touches/goes above EMA 9 AND candle CLOSE is below EMA 9
            const highTouchesEMA9 = candle.high >= ema9;
            const closeBelowEMA9 = candle.close < ema9;
            
            console.log(`   SHORT conditions:`);
            console.log(`   - High touches EMA9? ${highTouchesEMA9} (${candle.high.toFixed(2)} >= ${ema9.toFixed(2)})`);
            console.log(`   - Close below EMA9? ${closeBelowEMA9} (${candle.close.toFixed(2)} < ${ema9.toFixed(2)})`);
            console.log(`   - Valid signal? ${highTouchesEMA9 && closeBelowEMA9}`);
            
            if (highTouchesEMA9 && closeBelowEMA9) {
                return { 
                    isValid: true, 
                    confidence: 'HIGH',
                    reason: 'Clean retracement to EMA 9 with bearish close',
                    retracementType: 'BEARISH_RETRACEMENT'
                };
            }
        }
        
        return { 
            isValid: false, 
            confidence: 'NONE',
            reason: 'No clean retracement detected',
            retracementType: 'NONE'
        };
    }

    // Calculate trade parameters per v2.1 specification
    calculateTradeParametersV21(ema9, ema19, direction) {
        const stopLossOffset = this.params.stopLossOffset || 0; // Use offset from params
        const riskRewardRatio = this.params.riskRewardRatio || 3; // Use RR from params
        let entryPrice, stopLoss, riskPoints, takeProfit, rewardPoints;
        
        // Entry always at EMA 9 value (exact)
        entryPrice = ema9;
        
        // Stop Loss at EMA 19 with optional offset
        if (direction === 'LONG') {
            stopLoss = ema19 - (stopLossOffset * 0.1); // Subtract offset for LONG (gives more room below)
        } else {
            stopLoss = ema19 + (stopLossOffset * 0.1); // Add offset for SHORT (gives more room above)
        }
        
        if (direction === 'LONG') {
            riskPoints = entryPrice - stopLoss;
            takeProfit = entryPrice + (riskPoints * riskRewardRatio); // Use configurable RR
            rewardPoints = takeProfit - entryPrice;
        } else { // SHORT
            riskPoints = stopLoss - entryPrice;
            takeProfit = entryPrice - (riskPoints * riskRewardRatio); // Use configurable RR
            rewardPoints = entryPrice - takeProfit;
        }
        
        return {
            entryPrice,
            stopLoss,
            takeProfit,
            riskPoints: Math.abs(riskPoints),
            rewardPoints: Math.abs(rewardPoints),
            direction
        };
    }

    // v2.1 Risk Filter - 3.0 points maximum
    passesRiskFilterV21(tradeParams) {
        const maxRiskPoints = 3.0; // v2.1 increased from 2.5 to 3.0 points
        
        if (tradeParams.riskPoints > maxRiskPoints) {
            console.log(`🚫 v2.1 Risk Filter: ${tradeParams.riskPoints.toFixed(2)} pts > ${maxRiskPoints} pts max`);
            return false;
        }
        
        // Also ensure minimum viable trade (at least 0.1 points risk)
        if (tradeParams.riskPoints < 0.1) {
            console.log(`🚫 v2.1 Risk Filter: ${tradeParams.riskPoints.toFixed(2)} pts < 0.1 pts minimum`);
            return false;
        }
        
        return true;
    }

    // Conservative Mode: EMA Invalidation Check
    checkEMAInvalidation(candle, ema9, ema19) {
        if (!candle) return { invalidated: false };
        
        const emaMax = Math.max(ema9, ema19);
        const emaMin = Math.min(ema9, ema19);
        
        // Check if current candle crosses BOTH EMAs (high above max AND low below min)
        const crossesBothEMAs = candle.high >= emaMax && candle.low <= emaMin;
        
        if (crossesBothEMAs) {
            this.strategyState.consecutiveInvalidations++;
            
            console.log(`🛡️  EMA Invalidation detected: Candle crosses both EMAs`);
            console.log(`   Candle: H:${candle.high.toFixed(2)} L:${candle.low.toFixed(2)}`);
            console.log(`   EMAs: Max:${emaMax.toFixed(2)} Min:${emaMin.toFixed(2)}`);
            
            return {
                invalidated: true,
                reason: 'BOTH_EMA_CROSS',
                details: {
                    candleHigh: candle.high,
                    candleLow: candle.low,
                    emaMax: emaMax,
                    emaMin: emaMin
                }
            };
        }
        
        return { invalidated: false };
    }

    // Conservative Mode: Reset trend tracking
    resetTrendTracking(reason) {
        console.log(`🛡️  Trend tracking reset: ${reason}`);
        
        this.strategyState.waitingForLongPullback = false;
        this.strategyState.waitingForShortPullback = false;
        this.strategyState.lastTrendDirection = 'NEUTRAL';
    }

    // Conservative Mode: Update trend tracking
    updateTrendTrackingConservative(currentDirection) {
        // If trend direction changed, reset waiting states
        if (this.strategyState.lastTrendDirection !== currentDirection) {
            this.strategyState.lastTrendDirection = currentDirection;
            
            if (currentDirection === 'LONG') {
                this.strategyState.waitingForLongPullback = true;
                this.strategyState.waitingForShortPullback = false;
                console.log('🛡️  Conservative: Now waiting for LONG pullback');
            } else if (currentDirection === 'SHORT') {
                this.strategyState.waitingForShortPullback = true;
                this.strategyState.waitingForLongPullback = false;
                console.log('🛡️  Conservative: Now waiting for SHORT pullback');
            }
        }
    }

    calculateTrendStrength(price, ema9, ema19, direction) {
        const emaSpread = Math.abs(ema9 - ema19);
        const avgEMA = (ema9 + ema19) / 2;
        const spreadPercent = (emaSpread / avgEMA) * 100;
        
        // Distance from EMAs indicates trend strength
        const priceDistance = direction === 'LONG' ? 
            Math.min(price - ema9, price - ema19) : 
            Math.min(ema9 - price, ema19 - price);
            
        return Math.min(spreadPercent + (priceDistance / avgEMA * 100), 100);
    }


    getStrategyStats() {
        return {
            mode: this.params.mode,
            version: '3.0',
            strategyState: { ...this.strategyState },
            stateMachine: {
                currentState: this.stateMachine.currentState,
                longSetup: { ...this.stateMachine.longSetup },
                shortSetup: { ...this.stateMachine.shortSetup },
                stateHistory: this.stateMachine.stateHistory.slice(-10)
            },
            lastSignalTime: this.lastSignalTime,
            expectedMetrics: this.getExpectedMetrics()
        };
    }

    getExpectedMetrics() {
        if (this.params.mode === 'CONSERVATIVE') {
            return {
                tradesPerDay: '45-50',
                winRate: '48-50%',
                avgPnLPerTrade: 'Dynamic',
                description: 'Conservative v3.0 with state validation'
            };
        } else {
            return {
                tradesPerDay: '139+',
                winRate: '52.4%',
                avgPnLPerTrade: 'Dynamic',
                description: 'Standard v3.0 with real-time state machine'
            };
        }
    }
}

class EMAStrategy {
    constructor(config = {}, mainBot = null) {
        this.name = 'EMA_9_RETRACEMENT_SCALPING_STRATEGY';
        this.version = '3.0';
        this.mainBot = mainBot; // CRITICAL FIX: Store mainBot reference
        
        // v3.0 Strategy parameters with dynamic risk
        this.params = {
            // Strategy mode
            mode: config.mode || 'STANDARD',
            
            // EMA periods
            emaPeriod9: config.periods?.fast ?? config.ema?.periods?.fast ?? 9,
            emaPeriod19: config.periods?.slow ?? config.ema?.periods?.slow ?? 19,
            
            // Consolidation and timeout parameters
            maxBarsSinceEMA: config.maxBarsSinceEMA ?? 15,
            postWinCandleTimeout: config.postWinCandleTimeout ?? 3,
            postLossCandleTimeout: config.postLossCandleTimeout ?? 10,
            
            // Dynamic risk management from config
            dollarRiskPerTrade: config.dollarRiskPerTrade ?? 100,
            dollarPerPoint: config.dollarPerPoint ?? 10,
            maxRiskPoints: config.maxRiskPoints ?? 3.0,
            riskRewardRatio: config.riskRewardRatio ?? 3,
            minEMASpread: config.minEMASpread ?? config.ema?.minEMASpread ?? 0.5,  // Minimum EMA spread for valid trend (configurable)
            
            // Position management
            oneTradeAtTime: true,       // Single position only
            maxTradeDurationMs: 30000000, // 500 minutes (8+ hours)
            
            // Additional parameters from YAML
            stopLossBuffer: config.stopLossBuffer ?? 2,
            stopLossOffset: config.stopLossOffset ?? 0,
            candleIntervalSeconds: config.candleIntervalSeconds ?? 60,
            emaUpdateMode: config.emaUpdateMode ?? 'CANDLE_BASED',
            trailingStopEnabled: config.trailingStopEnabled ?? false,
            
            // Signal settings
            minDataPoints: 19,
            entryMethod: 'LIMIT',
            
            // Account protection
            dailyLossLimit: config.maxDollarRiskPerDay || 300,
            maxConsecutiveLosses: 20
            
            // Note: Removed ...config spread to prevent unexpected overrides
            // All parameters should be explicitly mapped above
        };
        
        // Initialize components with update mode from config
        const candleIntervalSeconds = config.candleIntervalSeconds ?? config.ema?.candleIntervalSeconds ?? 60; // Check nested config
        const updateMode = config.emaUpdateMode ?? config.ema?.emaUpdateMode ?? 'CANDLE_BASED'; // Check nested config
        const fastPeriod = config.periods?.fast ?? config.ema?.periods?.fast ?? 9;
        const slowPeriod = config.periods?.slow ?? config.ema?.periods?.slow ?? 19;
        
        this.emaCalculator = new EMACalculator(candleIntervalSeconds, updateMode, fastPeriod, slowPeriod);
        this.signalGenerator = new EMASignalGenerator(this.params, this.mainBot); // CRITICAL FIX: Pass mainBot reference
        
        console.log(`📈 EMA Strategy: Using ${updateMode} calculation mode`);
        console.log(`🕐 EMA Candle Interval: ${candleIntervalSeconds} seconds`);
        console.log(`📊 EMA Periods: Fast=${fastPeriod}, Slow=${slowPeriod}`);
        
        // Track candle data
        this.candles = [];
        this.currentCandle = null;
        this.lastCandleTime = null;
        
        // State tracking
        this.initializationTime = Date.now();
        this.lastSignalTime = null;
        this.isReady = false;
        this.forceReadyAfterMs = 60000;
        this.wasBootstrapped = false;
        
        // Real-time price tracking for state machine
        this.lastProcessedPrice = null;
        this.lastStateUpdate = null;
        
        // Initialize strategyState to prevent undefined errors
        this.strategyState = {
            mode: config.mode || 'STANDARD',
            waitingForLongPullback: false,
            waitingForShortPullback: false,
            lastTrendDirection: 'NEUTRAL',
            consecutiveInvalidations: 0,
            consolidationCandles: 0,
            lastConsolidationCheck: null,
            lastTradeCloseTime: null,
            lastTradeWasWin: null
        };
        
        console.log(`🎯 EMA ${this.params.emaPeriod9} Retracement Scalping Strategy v3.0 initialized`);
        console.log('🔥 ENHANCED: Real-time state machine + Dynamic position sizing');
        console.log(`📊 Active Mode: ${this.params.mode}`);
        console.log(`💰 Risk per trade: ${this.params.dollarRiskPerTrade}`);
        console.log(`🎯 Risk:Reward: 1:${this.params.riskRewardRatio}`);
        console.log(`📏 Max risk: ${this.params.maxRiskPoints} points`);
        console.log(`📉 Max consolidation: ${this.params.maxBarsSinceEMA} candles`);
        console.log(`⏳ Post-win timeout: ${this.params.postWinCandleTimeout} seconds`);
        console.log(`⏳ Post-loss timeout: ${this.params.postLossCandleTimeout} seconds`);
        console.log(`🕐 EMA Candle Interval: ${candleIntervalSeconds} seconds`);
    }

    // Initialize with historical data for EMA bootstrap
    async initializeWithHistoricalData(historicalData) {
        try {
            const success = await this.emaCalculator.initializeWithHistorical(historicalData);
            if (success) {
                this.isReady = true;
                this.wasBootstrapped = true;
                console.log('✅ EMA Strategy v3.0 ready with historical initialization');
                return true;
            }
            return false;
        } catch (error) {
            console.error('[EMA Strategy v3.0] Historical initialization failed:', error.message);
            return false;
        }
    }

    processMarketData(price, volume = 1000, timestamp = null) {
        if (!timestamp) timestamp = new Date();
        
        // Use the unified update method
        const emaUpdateResult = this.emaCalculator.update(price, volume, timestamp);
        
        // Update candle data
        const candleChanged = this.updateCandle(price, volume, timestamp);
        
        const isReady = this.isStrategyReady();
        
        if (!isReady) {
            return {
                ready: false,
                signal: null,
                environment: null,
                emaData: null,
                marketRegime: null,
                subStrategy: this.params.mode,
                debug: {
                    reason: 'Strategy not ready',
                    emaStatus: this.emaCalculator.getStatus(),
                    uptime: Date.now() - this.initializationTime
                }
            };
        }
        
        const emaValues = this.emaCalculator.getEMAValues();
        if (!emaValues.initialized) {
            return {
                ready: true,
                signal: null,
                environment: null,
                emaData: null,
                marketRegime: null,
                subStrategy: this.params.mode,
                debug: { reason: 'EMA calculator not initialized' }
            };
        }

        // CRITICAL v3.0 ENHANCEMENT: Update state machine with EVERY price tick
        this.signalGenerator.updatePriceState(price, emaValues.ema9, emaValues.ema19, timestamp);

        // Create EMA data object
        const emaData = {
            ema9: emaValues.ema9,
            ema19: emaValues.ema19,
            currentPrice: price,
            currentCandle: this.currentCandle,
            dataPoints: this.candles.length,
            isReady: true,
            lastCandle: this.candles.length > 0 ? this.candles[this.candles.length - 1] : null,
            isInitialized: emaValues.initialized
        };
        
        const environment = this.analyzeMarketEnvironment(price, emaData);
        
        let signal = null;
        
        // v3.0: Check for signals on EVERY tick when state is valid
        // Don't wait for candle completion - check state machine
        signal = this.signalGenerator.generateSignal(emaData, price, environment);
        
        if (signal) {
            // ALWAYS log signal generation - this is critical!
            console.log(`\n🔥 [v3.0] REAL-TIME SIGNAL GENERATED!`);
            console.log(`   State: ${this.signalGenerator.stateMachine.currentState}`);
            console.log(`   No need to wait for candle close!`);
        }
        
        return {
            ready: true,
            signal: signal,
            environment: environment,
            emaData: emaData,
            marketRegime: null,
            subStrategy: this.params.mode,
            strategyStats: this.signalGenerator.getStrategyStats(),
            volatility: this.estimateVolatility(emaData),
            stateMachine: {
                currentState: this.signalGenerator.stateMachine.currentState,
                longSetup: this.signalGenerator.stateMachine.longSetup.validSetup,
                shortSetup: this.signalGenerator.stateMachine.shortSetup.validSetup
            },
            debug: {
                reason: signal ? 'v3.0 Real-time signal' : 'Monitoring price state',
                trendAnalysis: this.signalGenerator.analyzeTrendV3(price, emaData.ema9, emaData.ema19),
                mode: this.params.mode,
                version: '3.0'
            }
        };
    }

    updateCandle(price, volume, timestamp) {
        if (price === null || price === undefined || isNaN(price)) {
            console.log('🚨 INVALID PRICE in updateCandle, skipping');
            return false;
        }
        
        const candleTime = new Date(timestamp);
        candleTime.setSeconds(0, 0); // Round to minute
        const candleTimeStr = candleTime.getTime();

        // Start new candle if time changed
        if (!this.lastCandleTime || candleTimeStr !== this.lastCandleTime) {
            // Close previous candle
            if (this.currentCandle) {
                if (this.currentCandle.close !== null && this.currentCandle.close !== undefined && !isNaN(this.currentCandle.close)) {
                    this.candles.push({ ...this.currentCandle });
                    
                    // Keep only last 200 candles for memory management
                    if (this.candles.length > 200) {
                        this.candles = this.candles.slice(-200);
                    }
                }
            }
            
            // Start new candle
            this.currentCandle = {
                timestamp: candleTimeStr,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: volume
            };
            this.lastCandleTime = candleTimeStr;
            
            // CR-002: Suppress candle closed logs - not a significant event
            
            return true; // Candle changed
        } else {
            // Update current candle
            this.currentCandle.high = Math.max(this.currentCandle.high, price);
            this.currentCandle.low = Math.min(this.currentCandle.low, price);
            this.currentCandle.close = price;
            this.currentCandle.volume += volume;
            
            return false; // Same candle
        }
    }

    isStrategyReady() {
        const emaStatus = this.emaCalculator.getStatus();
        
        // If EMA calculator is initialized, strategy is ready
        if (emaStatus.initialized) {
            if (!this.isReady) {
                console.log('🎯 EMA Strategy now READY - EMA calculator initialized');
            }
            this.isReady = true;
            return true;
        }
        
        // Force ready after timeout for live trading
        const uptimeReady = (Date.now() - this.initializationTime) > this.forceReadyAfterMs;
        
        if (uptimeReady && !this.isReady) {
            console.log('🎯 EMA Strategy now READY - timeout reached, starting live data warmup');
            this.isReady = true;
        }
        
        return this.isReady;
    }

    analyzeMarketEnvironment(price, emaData) {
        const { ema9, ema19 } = emaData;
        
        const emaSpread = Math.abs(ema9 - ema19);
        const priceToEma9Distance = Math.abs(price - ema9);
        const priceToEma19Distance = Math.abs(price - ema19);
        
        const trendStrength = this.calculateTrendStrength(price, ema9, ema19);
        
        return {
            currentTime: new Date(),
            emaSpread: emaSpread,
            priceToEma9: priceToEma9Distance,
            priceToEma19: priceToEma19Distance,
            trendStrength: trendStrength,
            sessionInfo: {
                type: 'REGULAR',
                multiplier: 1.0,
                quality: 'NORMAL'
            },
            subStrategy: this.params.mode,
            version: '2.1'
        };
    }

    calculateTrendStrength(price, ema9, ema19) {
        const emaAlignment = Math.abs(ema9 - ema19) / Math.min(ema9, ema19) * 100;
        
        // v2.1 trend determination
        const minEMA = Math.min(ema9, ema19);
        const maxEMA = Math.max(ema9, ema19);
        
        const longTrend = price > minEMA && ema9 >= ema19;
        const shortTrend = price < maxEMA && ema9 <= ema19;
        
        const pricePosition = longTrend ? 'BULLISH' : 
                             shortTrend ? 'BEARISH' : 'NEUTRAL';
        
        return {
            alignment: emaAlignment,
            direction: pricePosition,
            strength: emaAlignment > 0.1 ? 'STRONG' : 'WEAK',
            version: '2.1'
        };
    }

    estimateVolatility(emaData) {
        const emaSpread = Math.abs(emaData.ema9 - emaData.ema19);
        const avgEMA = (emaData.ema9 + emaData.ema19) / 2;
        return emaSpread / avgEMA;
    }

    getCurrentEMAValues() {
        const emaValues = this.emaCalculator.getEMAValues();
        
        return {
            ema9: emaValues.ema9,
            ema19: emaValues.ema19,
            dataPoints: this.candles.length,
            isReady: emaValues.initialized,
            isInitialized: emaValues.initialized,
            subStrategy: this.params.mode,
            version: '3.0',
            signal: this.emaCalculator.getEMASignal(),
            stateMachine: this.signalGenerator.stateMachine.currentState
        };
    }

    getParameters() {
        return { ...this.params };
    }

    getStatusSummary() {
        try {
            const isReady = this.isStrategyReady();
            const emaStatus = this.emaCalculator.getStatus();
            
            return {
                module: 'Strategy',
                status: isReady ? 'READY' : 'BUILDING',
                name: this.name,
                version: this.version,
                strategyType: 'RETRACEMENT_SCALPING_V3',
                subStrategy: this.params.mode,
                isReady: isReady,
                wasBootstrapped: this.wasBootstrapped,
                indicators: {
                    ema9: emaStatus.ema9,
                    ema19: emaStatus.ema19,
                    signal: emaStatus.signal
                },
                stateMachine: {
                    state: this.signalGenerator.stateMachine.currentState,
                    longSetup: this.signalGenerator.stateMachine.longSetup.validSetup,
                    shortSetup: this.signalGenerator.stateMachine.shortSetup.validSetup
                },
                debug: {
                    initTime: this.initializationTime,
                    uptime: Date.now() - this.initializationTime,
                    forceReadyTimeout: this.forceReadyAfterMs,
                    emaCalculatorStatus: emaStatus
                }
            };
        } catch (error) {
            return {
                module: 'Strategy',
                status: 'ERROR',
                error: error.message,
                isReady: false
            };
        }
    }

    reset() {
        this.emaCalculator.reset();
        this.candles = [];
        this.currentCandle = null;
        this.lastCandleTime = null;
        this.isReady = false;
        this.wasBootstrapped = false;
        this.initializationTime = Date.now();
        this.signalGenerator.resetStates('STRATEGY_RESET');
        console.log('🎯 EMA Strategy v3.0 reset complete');
    }

    // Get debug information
    getDebugInfo() {
        return {
            strategy: {
                name: this.name,
                version: this.version,
                mode: this.params.mode,
                isReady: this.isReady,
                wasBootstrapped: this.wasBootstrapped,
                candles: this.candles.length
            },
            calculator: this.emaCalculator.getStatus(),
            signalGenerator: this.signalGenerator.getStrategyStats()
        };
    }
    
    // Called when a position is closed
    onPositionClosed(timestamp, wasProfit) {
        if (this.signalGenerator) {
            this.signalGenerator.onPositionClosed(timestamp, wasProfit);
        }
    }
}

module.exports = EMAStrategy;