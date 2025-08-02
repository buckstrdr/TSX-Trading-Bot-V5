// ATRCalculator.js - Average True Range Calculator
// Using technicalindicators library v3.1.0 for accurate calculations
// ATR measures market volatility by analyzing price ranges

const { ATR } = require('technicalindicators');

class ATRCalculator {
    constructor(period = 14) {
        this.period = period;
        this.atr = new ATR({ period });
        this.initialized = false;
        this.updateCount = 0;
        this.debug = true;
        
        // Current values
        this.currentATR = null;
        this.lastCandle = null;
        
        // Historical data storage for analysis
        this.atrHistory = [];
        this.trueRangeHistory = [];
        this.maxHistoryLength = 100; // Keep last 100 values for analysis
        
        console.log(`[ATR Calculator] Initialized with period: ${period}`);
        console.log(`[ATR Calculator] Using technicalindicators library v3.1.0`);
        console.log(`[ATR Calculator] ATR measures market volatility through True Range analysis`);
    }
    
    // Initialize with historical candle data
    async initializeWithHistorical(historicalCandles) {
        try {
            console.log(`[ATR Calculator] Starting bootstrap with ${historicalCandles?.length || 0} candles`);
            
            if (!historicalCandles || historicalCandles.length === 0) {
                console.log('[ATR Calculator] No historical candles provided');
                return false;
            }

            // Extract OHLC data from historical candles
            const ohlcData = this.extractOHLCData(historicalCandles);
            if (ohlcData.high.length === 0) {
                console.log('[ATR Calculator] No valid OHLC data extracted from historical candles');
                return false;
            }

            // ATR needs at least period + 1 data points for calculation
            const minRequired = this.period + 1;
            if (ohlcData.high.length < minRequired) {
                console.log(`[ATR Calculator] Insufficient data - need at least ${minRequired} candles for ATR${this.period}, got ${ohlcData.high.length}`);
                return false;
            }
            
            console.log(`[ATR Calculator] Extracted ${ohlcData.high.length} valid candles`);
            console.log(`[ATR Calculator] High range: ${Math.min(...ohlcData.high).toFixed(2)} - ${Math.max(...ohlcData.high).toFixed(2)}`);
            console.log(`[ATR Calculator] Low range: ${Math.min(...ohlcData.low).toFixed(2)} - ${Math.max(...ohlcData.low).toFixed(2)}`);
            
            // Calculate ATR using the library
            const atrResults = this.calculate(historicalCandles);
            if (atrResults.length === 0) {
                console.log('[ATR Calculator] No ATR values calculated from historical data');
                return false;
            }
            
            // Get the latest ATR value
            this.currentATR = atrResults[atrResults.length - 1];
            
            // Store history (keep last maxHistoryLength values)
            const startIndex = Math.max(0, atrResults.length - this.maxHistoryLength);
            this.atrHistory = atrResults.slice(startIndex);
            
            // Calculate True Range values for additional analysis
            this.calculateTrueRangeHistory(historicalCandles.slice(startIndex));
            
            // Re-initialize ATR with historical data for real-time updates
            this.atr = new ATR({ period: this.period });
            historicalCandles.forEach(candle => {
                const ohlc = this.extractSingleOHLC(candle);
                if (ohlc) {
                    this.atr.nextValue(ohlc);
                }
            });
            
            this.initialized = true;
            this.lastCandle = historicalCandles[historicalCandles.length - 1];
            
            console.log(`[ATR Calculator] ✅ Bootstrap SUCCESS using technicalindicators library!`);
            console.log(`[ATR Calculator] ATR${this.period}: ${this.currentATR?.toFixed(4) || 'null'}`);
            console.log(`[ATR Calculator] Volatility Level: ${this.getVolatilityLevel()}`);
            console.log(`[ATR Calculator] ATR Trend: ${this.getATRTrend()}`);
            
            return true;
        } catch (error) {
            console.error('[ATR Calculator] Bootstrap failed:', error.message);
            return false;
        }
    }

    // Extract OHLC data from historical candles
    extractOHLCData(candles) {
        const high = [];
        const low = [];
        const close = [];
        
        for (let i = 0; i < candles.length; i++) {
            const ohlc = this.extractSingleOHLC(candles[i]);
            if (ohlc) {
                high.push(ohlc.high);
                low.push(ohlc.low);
                close.push(ohlc.close);
            }
        }
        
        return { high, low, close };
    }

    // Extract OHLC from a single candle/data point
    extractSingleOHLC(candle) {
        if (!candle) return null;
        
        let high, low, close;
        
        if (typeof candle === 'object') {
            high = candle.h || candle.high || candle.High;
            low = candle.l || candle.low || candle.Low;
            close = candle.c || candle.close || candle.Close;
            
            // If we don't have OHLC, try to use a single price as all values
            if (!high && !low && !close) {
                const price = candle.price || candle.last || candle.Price || candle.Last ||
                             (candle.data && candle.data.lastPrice);
                if (price) {
                    high = low = close = parseFloat(price);
                }
            }
        }
        
        // Validate the extracted values
        if (high !== undefined && low !== undefined && close !== undefined &&
            !isNaN(high) && !isNaN(low) && !isNaN(close) &&
            high > 0 && low > 0 && close > 0) {
            return {
                high: parseFloat(high),
                low: parseFloat(low),
                close: parseFloat(close)
            };
        }
        
        return null;
    }

    // Calculate True Range history for analysis
    calculateTrueRangeHistory(candles) {
        this.trueRangeHistory = [];
        
        for (let i = 1; i < candles.length; i++) {
            const current = this.extractSingleOHLC(candles[i]);
            const previous = this.extractSingleOHLC(candles[i - 1]);
            
            if (current && previous) {
                const tr = this.calculateTrueRange(current, previous);
                this.trueRangeHistory.push(tr);
            }
        }
    }

    // Calculate True Range for a single candle
    calculateTrueRange(current, previous) {
        const range1 = current.high - current.low;
        const range2 = Math.abs(current.high - previous.close);
        const range3 = Math.abs(current.low - previous.close);
        
        return Math.max(range1, range2, range3);
    }
    
    // Update ATR with new candle data
    update(candle) {
        if (!candle) {
            return { updated: false, reason: 'no_candle_data' };
        }

        const ohlc = this.extractSingleOHLC(candle);
        if (!ohlc) {
            return { updated: false, reason: 'invalid_candle_data' };
        }

        // Get previous ATR for comparison
        const previousATR = this.currentATR;

        // Update ATR with new candle
        const newATR = this.atr.nextValue(ohlc);
        
        if (newATR !== undefined) {
            this.currentATR = newATR;
            
            // Update history (keep only last maxHistoryLength values)
            this.atrHistory.push(newATR);
            if (this.atrHistory.length > this.maxHistoryLength) {
                this.atrHistory.shift();
            }
            
            // Calculate and store True Range for this candle
            if (this.lastCandle) {
                const previousOHLC = this.extractSingleOHLC(this.lastCandle);
                if (previousOHLC) {
                    const tr = this.calculateTrueRange(ohlc, previousOHLC);
                    this.trueRangeHistory.push(tr);
                    if (this.trueRangeHistory.length > this.maxHistoryLength) {
                        this.trueRangeHistory.shift();
                    }
                }
            }
            
            this.updateCount++;
            this.lastCandle = candle;

            // Log significant changes
            if (this.debug && (this.updateCount % 10 === 0 || this.hasSignificantChange(previousATR))) {
                const timestamp = new Date().toLocaleTimeString();
                const change = previousATR ? ((newATR - previousATR) / previousATR * 100).toFixed(2) : '0.00';
                console.log(`📊 [ATR UPDATE ${this.updateCount}] @ ${timestamp}`);
                console.log(`   Candle: H:${ohlc.high.toFixed(2)} L:${ohlc.low.toFixed(2)} C:${ohlc.close.toFixed(2)}`);
                console.log(`   ATR: ${newATR.toFixed(4)} (${change > 0 ? '+' : ''}${change}%)`);
                console.log(`   Volatility: ${this.getVolatilityLevel()}`);
                console.log(`   Trend: ${this.getATRTrend()}`);
            }

            return {
                updated: true,
                reason: 'candle_update',
                updateCount: this.updateCount,
                atrValues: this.getATRValues()
            };
        }
        
        return { updated: false, reason: 'calculation_failed' };
    }

    // Check if there's a significant change in ATR
    hasSignificantChange(previousATR) {
        if (!previousATR || !this.currentATR) return true;
        
        const changePercent = Math.abs((this.currentATR - previousATR) / previousATR * 100);
        return changePercent > 5; // Consider 5% change as significant
    }
    
    // Calculate ATR from array of candles
    calculate(candles) {
        if (!Array.isArray(candles) || candles.length === 0) {
            console.error('[ATR Calculator] Invalid candles array provided');
            return [];
        }

        const ohlcData = this.extractOHLCData(candles);
        const minRequired = this.period + 1;
        
        if (ohlcData.high.length < minRequired) {
            console.warn(`[ATR Calculator] Insufficient data for ATR${this.period}: need ${minRequired}, got ${ohlcData.high.length}`);
            return [];
        }

        try {
            return ATR.calculate({
                period: this.period,
                high: ohlcData.high,
                low: ohlcData.low,
                close: ohlcData.close
            });
        } catch (error) {
            console.error(`[ATR Calculator] Error calculating ATR${this.period}:`, error.message);
            return [];
        }
    }

    // Get current ATR value
    getCurrentATR() {
        return this.currentATR;
    }

    // Get all ATR-related values with metadata
    getATRValues() {
        return {
            atr: this.currentATR,
            [`atr${this.period}`]: this.currentATR,
            period: this.period,
            initialized: this.initialized,
            updateCount: this.updateCount,
            volatilityLevel: this.getVolatilityLevel(),
            atrTrend: this.getATRTrend(),
            percentileRank: this.getPercentileRank(),
            signals: this.getATRSignals(),
            updateMethod: 'technicalindicators_library_v3.1.0'
        };
    }

    // Get volatility level based on ATR value
    getVolatilityLevel() {
        if (!this.currentATR || this.atrHistory.length < 20) return 'unknown';
        
        // Calculate percentile of current ATR vs recent history
        const recentHistory = this.atrHistory.slice(-50); // Last 50 values
        const percentile = this.getPercentileRank();
        
        if (percentile >= 80) {
            return 'very_high';
        } else if (percentile >= 60) {
            return 'high';
        } else if (percentile >= 40) {
            return 'moderate';
        } else if (percentile >= 20) {
            return 'low';
        } else {
            return 'very_low';
        }
    }

    // Get ATR trend (rising, falling, or sideways)
    getATRTrend() {
        if (this.atrHistory.length < 5) return 'unknown';
        
        const recent = this.atrHistory.slice(-5);
        const slope = (recent[4] - recent[0]) / 4;
        const currentATR = this.currentATR || 0;
        const slopePercent = (slope / currentATR) * 100;
        
        if (slopePercent > 2) {
            return 'rising';
        } else if (slopePercent < -2) {
            return 'falling';
        } else {
            return 'sideways';
        }
    }

    // Get percentile rank of current ATR
    getPercentileRank() {
        if (!this.currentATR || this.atrHistory.length < 10) return 50;
        
        const recentHistory = this.atrHistory.slice(-50); // Last 50 values
        const smallerCount = recentHistory.filter(atr => atr < this.currentATR).length;
        return (smallerCount / recentHistory.length) * 100;
    }

    // Get comprehensive ATR signals
    getATRSignals() {
        if (!this.initialized || !this.currentATR) {
            return { signal: 'not_initialized' };
        }

        const volatilityLevel = this.getVolatilityLevel();
        const atrTrend = this.getATRTrend();
        const percentileRank = this.getPercentileRank();
        
        // Generate volatility-based signals
        let volatilitySignal = 'normal';
        if (volatilityLevel === 'very_high' || volatilityLevel === 'high') {
            volatilitySignal = 'high_volatility';
        } else if (volatilityLevel === 'very_low' || volatilityLevel === 'low') {
            volatilitySignal = 'low_volatility';
        }
        
        // Generate trend-based signals
        let trendSignal = 'stable';
        if (atrTrend === 'rising') {
            trendSignal = 'increasing_volatility';
        } else if (atrTrend === 'falling') {
            trendSignal = 'decreasing_volatility';
        }
        
        // Generate breakout potential signal
        let breakoutSignal = 'none';
        if (volatilityLevel === 'very_low' && atrTrend === 'rising') {
            breakoutSignal = 'potential_breakout';
        } else if (volatilityLevel === 'very_high' && atrTrend === 'falling') {
            breakoutSignal = 'volatility_exhaustion';
        }
        
        return {
            volatility: volatilitySignal,
            trend: trendSignal,
            breakout: breakoutSignal,
            atr: this.currentATR.toFixed(4),
            percentile: percentileRank.toFixed(1),
            level: volatilityLevel,
            direction: atrTrend,
            tradingImplication: this.getTradingImplication(volatilityLevel, atrTrend)
        };
    }

    // Get trading implications based on ATR analysis
    getTradingImplication(volatilityLevel, atrTrend) {
        if (volatilityLevel === 'very_low') {
            if (atrTrend === 'rising') {
                return 'prepare_for_breakout';
            } else {
                return 'consolidation_phase';
            }
        } else if (volatilityLevel === 'very_high') {
            if (atrTrend === 'falling') {
                return 'volatility_decline_opportunity';
            } else {
                return 'high_risk_environment';
            }
        } else if (volatilityLevel === 'moderate') {
            return 'normal_trading_conditions';
        } else {
            return 'monitor_conditions';
        }
    }

    // Get enhanced status for debugging
    getStatus() {
        const status = {
            library: 'technicalindicators v3.1.0',
            initialized: this.initialized,
            period: this.period,
            updateCount: this.updateCount,
            debugEnabled: this.debug,
            atr: this.currentATR ? this.currentATR.toFixed(4) : 'null',
            historyLength: this.atrHistory.length,
            trueRangeHistoryLength: this.trueRangeHistory.length
        };

        // Add signals if initialized
        if (this.initialized) {
            status.signals = this.getATRSignals();
            status.statistics = this.getATRStatistics();
        }

        return status;
    }

    // Get ATR statistics
    getATRStatistics() {
        if (this.atrHistory.length === 0) return null;
        
        const history = this.atrHistory;
        const sorted = [...history].sort((a, b) => a - b);
        
        return {
            min: sorted[0].toFixed(4),
            max: sorted[sorted.length - 1].toFixed(4),
            median: sorted[Math.floor(sorted.length / 2)].toFixed(4),
            average: (history.reduce((sum, val) => sum + val, 0) / history.length).toFixed(4),
            current: this.currentATR.toFixed(4),
            percentile_25: sorted[Math.floor(sorted.length * 0.25)].toFixed(4),
            percentile_75: sorted[Math.floor(sorted.length * 0.75)].toFixed(4)
        };
    }

    // Change period (requires reset)
    setPeriod(newPeriod) {
        if (typeof newPeriod !== 'number' || newPeriod <= 0) {
            console.error('[ATR Calculator] Invalid period provided');
            return false;
        }

        this.period = newPeriod;
        this.reset();
        
        console.log(`[ATR Calculator] Period changed to ${newPeriod} - calculator reset`);
        return true;
    }

    // Reset calculator
    reset() {
        console.log('[ATR Calculator] 🔄 Resetting calculator...');
        
        this.atr = new ATR({ period: this.period });
        this.currentATR = null;
        this.lastCandle = null;
        this.initialized = false;
        this.updateCount = 0;
        
        // Clear history
        this.atrHistory = [];
        this.trueRangeHistory = [];
        
        console.log('[ATR Calculator] ✅ Reset complete - technicalindicators instance reinitialized');
    }

    // Health check
    performHealthCheck() {
        const issues = [];
        
        if (!this.initialized) {
            issues.push('Not initialized');
        }

        if (this.period <= 0) {
            issues.push('Invalid period');
        }

        if (!this.atr) {
            issues.push('Missing ATR indicator instance');
        }

        // Check if ATR calculation is working
        if (this.initialized && this.currentATR === null) {
            issues.push('ATR calculation not working');
        }

        // Check history consistency
        if (this.initialized && this.atrHistory.length === 0) {
            issues.push('No ATR history available');
        }
        
        return {
            healthy: issues.length === 0,
            issues: issues,
            library: 'technicalindicators v3.1.0',
            period: this.period,
            updateCount: this.updateCount,
            hasValidATR: this.currentATR !== null,
            historySize: this.atrHistory.length,
            trueRangeHistorySize: this.trueRangeHistory.length
        };
    }

    // Toggle debugging
    setDebug(enabled) {
        this.debug = enabled;
        console.log(`[ATR Calculator] Debug mode: ${enabled ? 'ENABLED' : 'DISABLED'} (technicalindicators v3.1.0)`);
    }
}

module.exports = ATRCalculator;