// ADXCalculator.js - Average Directional Index Calculator with DI+ and DI-
// Using technicalindicators library v3.1.0 for accurate calculations
// ADX measures trend strength, DI+ and DI- measure directional movement

const { ADX } = require('technicalindicators');

class ADXCalculator {
    constructor(period = 14) {
        this.period = period;
        this.adx = new ADX({ period });
        this.initialized = false;
        this.updateCount = 0;
        this.debug = true;
        
        // Current values
        this.currentADX = null;
        this.currentPlusDI = null;
        this.currentMinusDI = null;
        this.lastCandle = null;
        
        // Historical data storage for analysis
        this.adxHistory = [];
        this.plusDIHistory = [];
        this.minusDIHistory = [];
        this.maxHistoryLength = 100; // Keep last 100 values for analysis
        
        console.log(`[ADX Calculator] Initialized with period: ${period}`);
        console.log(`[ADX Calculator] Using technicalindicators library v3.1.0`);
        console.log(`[ADX Calculator] ADX measures trend strength (0-100)`);
        console.log(`[ADX Calculator] DI+ and DI- measure directional movement`);
    }
    
    // Initialize with historical candle data
    async initializeWithHistorical(historicalCandles) {
        try {
            console.log(`[ADX Calculator] Starting bootstrap with ${historicalCandles?.length || 0} candles`);
            
            if (!historicalCandles || historicalCandles.length === 0) {
                console.log('[ADX Calculator] No historical candles provided');
                return false;
            }

            // Extract OHLC data from historical candles
            const ohlcData = this.extractOHLCData(historicalCandles);
            if (ohlcData.high.length === 0) {
                console.log('[ADX Calculator] No valid OHLC data extracted from historical candles');
                return false;
            }

            // ADX needs at least 2 * period data points for calculation
            const minRequired = 2 * this.period;
            if (ohlcData.high.length < minRequired) {
                console.log(`[ADX Calculator] Insufficient data - need at least ${minRequired} candles for ADX${this.period}, got ${ohlcData.high.length}`);
                return false;
            }
            
            console.log(`[ADX Calculator] Extracted ${ohlcData.high.length} valid candles`);
            console.log(`[ADX Calculator] High range: ${Math.min(...ohlcData.high).toFixed(2)} - ${Math.max(...ohlcData.high).toFixed(2)}`);
            console.log(`[ADX Calculator] Low range: ${Math.min(...ohlcData.low).toFixed(2)} - ${Math.max(...ohlcData.low).toFixed(2)}`);
            
            // Calculate ADX using the library
            const adxResults = this.calculate(historicalCandles);
            if (adxResults.length === 0) {
                console.log('[ADX Calculator] No ADX values calculated from historical data');
                return false;
            }
            
            // Get the latest values
            const latestResult = adxResults[adxResults.length - 1];
            this.currentADX = latestResult.adx;
            this.currentPlusDI = latestResult.pdi;
            this.currentMinusDI = latestResult.mdi;
            
            // Store history (keep last maxHistoryLength values)
            const startIndex = Math.max(0, adxResults.length - this.maxHistoryLength);
            this.adxHistory = adxResults.slice(startIndex).map(r => r.adx);
            this.plusDIHistory = adxResults.slice(startIndex).map(r => r.pdi);
            this.minusDIHistory = adxResults.slice(startIndex).map(r => r.mdi);
            
            // Re-initialize ADX with historical data for real-time updates
            this.adx = new ADX({ period: this.period });
            historicalCandles.forEach(candle => {
                const ohlc = this.extractSingleOHLC(candle);
                if (ohlc) {
                    this.adx.nextValue(ohlc);
                }
            });
            
            this.initialized = true;
            this.lastCandle = historicalCandles[historicalCandles.length - 1];
            
            console.log(`[ADX Calculator] ✅ Bootstrap SUCCESS using technicalindicators library!`);
            console.log(`[ADX Calculator] ADX${this.period}: ${this.currentADX?.toFixed(4) || 'null'}`);
            console.log(`[ADX Calculator] DI+: ${this.currentPlusDI?.toFixed(4) || 'null'}`);
            console.log(`[ADX Calculator] DI-: ${this.currentMinusDI?.toFixed(4) || 'null'}`);
            console.log(`[ADX Calculator] Trend Strength: ${this.getTrendStrength()}`);
            
            return true;
        } catch (error) {
            console.error('[ADX Calculator] Bootstrap failed:', error.message);
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
    
    // Update ADX with new candle data
    update(candle) {
        if (!candle) {
            return { updated: false, reason: 'no_candle_data' };
        }

        const ohlc = this.extractSingleOHLC(candle);
        if (!ohlc) {
            return { updated: false, reason: 'invalid_candle_data' };
        }

        // Get previous values for comparison
        const previousADX = this.currentADX;
        const previousPlusDI = this.currentPlusDI;
        const previousMinusDI = this.currentMinusDI;

        // Update ADX with new candle
        const result = this.adx.nextValue(ohlc);
        
        if (result && typeof result === 'object') {
            this.currentADX = result.adx;
            this.currentPlusDI = result.pdi;
            this.currentMinusDI = result.mdi;
            
            // Update history (keep only last maxHistoryLength values)
            if (this.currentADX !== null) {
                this.adxHistory.push(this.currentADX);
                if (this.adxHistory.length > this.maxHistoryLength) {
                    this.adxHistory.shift();
                }
            }
            
            if (this.currentPlusDI !== null) {
                this.plusDIHistory.push(this.currentPlusDI);
                if (this.plusDIHistory.length > this.maxHistoryLength) {
                    this.plusDIHistory.shift();
                }
            }
            
            if (this.currentMinusDI !== null) {
                this.minusDIHistory.push(this.currentMinusDI);
                if (this.minusDIHistory.length > this.maxHistoryLength) {
                    this.minusDIHistory.shift();
                }
            }
            
            this.updateCount++;
            this.lastCandle = candle;

            // Log significant changes
            if (this.debug && (this.updateCount % 10 === 0 || this.hasSignificantChange(previousADX, previousPlusDI, previousMinusDI))) {
                const timestamp = new Date().toLocaleTimeString();
                console.log(`📊 [ADX UPDATE ${this.updateCount}] @ ${timestamp}`);
                console.log(`   Candle: H:${ohlc.high.toFixed(2)} L:${ohlc.low.toFixed(2)} C:${ohlc.close.toFixed(2)}`);
                console.log(`   ADX: ${this.currentADX?.toFixed(4) || 'null'} (${this.getTrendStrength()})`);
                console.log(`   DI+: ${this.currentPlusDI?.toFixed(4) || 'null'}`);
                console.log(`   DI-: ${this.currentMinusDI?.toFixed(4) || 'null'}`);
                console.log(`   Direction: ${this.getDirection()}`);
            }

            return {
                updated: true,
                reason: 'candle_update',
                updateCount: this.updateCount,
                adxValues: this.getADXValues()
            };
        }
        
        return { updated: false, reason: 'calculation_failed' };
    }

    // Check if there's a significant change in ADX values
    hasSignificantChange(prevADX, prevPlusDI, prevMinusDI) {
        if (!prevADX || !prevPlusDI || !prevMinusDI) return true;
        
        const adxChange = Math.abs((this.currentADX || 0) - prevADX);
        const plusDIChange = Math.abs((this.currentPlusDI || 0) - prevPlusDI);
        const minusDIChange = Math.abs((this.currentMinusDI || 0) - prevMinusDI);
        
        return adxChange > 2 || plusDIChange > 1 || minusDIChange > 1;
    }
    
    // Calculate ADX from array of candles
    calculate(candles) {
        if (!Array.isArray(candles) || candles.length === 0) {
            console.error('[ADX Calculator] Invalid candles array provided');
            return [];
        }

        const ohlcData = this.extractOHLCData(candles);
        const minRequired = 2 * this.period;
        
        if (ohlcData.high.length < minRequired) {
            console.warn(`[ADX Calculator] Insufficient data for ADX${this.period}: need ${minRequired}, got ${ohlcData.high.length}`);
            return [];
        }

        try {
            return ADX.calculate({
                period: this.period,
                high: ohlcData.high,
                low: ohlcData.low,
                close: ohlcData.close
            });
        } catch (error) {
            console.error(`[ADX Calculator] Error calculating ADX${this.period}:`, error.message);
            return [];
        }
    }

    // Get latest ADX values
    getLatestValues() {
        if (!this.currentADX || !this.currentPlusDI || !this.currentMinusDI) {
            return null;
        }
        
        return {
            adx: this.currentADX,
            plusDI: this.currentPlusDI,  // DI+
            minusDI: this.currentMinusDI // DI-
        };
    }

    // Get all ADX-related values with metadata
    getADXValues() {
        return {
            adx: this.currentADX,
            [`adx${this.period}`]: this.currentADX,
            plusDI: this.currentPlusDI,
            minusDI: this.currentMinusDI,
            pdi: this.currentPlusDI, // Alias
            mdi: this.currentMinusDI, // Alias
            period: this.period,
            initialized: this.initialized,
            updateCount: this.updateCount,
            trendStrength: this.getTrendStrength(),
            direction: this.getDirection(),
            signal: this.getADXSignals(),
            updateMethod: 'technicalindicators_library_v3.1.0'
        };
    }

    // Get trend strength based on ADX value
    getTrendStrength() {
        if (!this.currentADX) return 'unknown';
        
        if (this.currentADX >= 50) {
            return 'very_strong';
        } else if (this.currentADX >= 25) {
            return 'strong';
        } else if (this.currentADX >= 20) {
            return 'moderate';
        } else {
            return 'weak';
        }
    }

    // Get directional movement based on DI+ and DI-
    getDirection() {
        if (!this.currentPlusDI || !this.currentMinusDI) return 'unknown';
        
        const difference = Math.abs(this.currentPlusDI - this.currentMinusDI);
        
        if (difference < 2) {
            return 'neutral';
        } else if (this.currentPlusDI > this.currentMinusDI) {
            return difference > 5 ? 'strong_bullish' : 'bullish';
        } else {
            return difference > 5 ? 'strong_bearish' : 'bearish';
        }
    }

    // Get comprehensive ADX signals
    getADXSignals() {
        if (!this.initialized || !this.currentADX || !this.currentPlusDI || !this.currentMinusDI) {
            return { signal: 'not_initialized' };
        }

        const trendStrength = this.getTrendStrength();
        const direction = this.getDirection();
        const crossover = this.checkDICrossover();
        const adxTrend = this.getADXTrend();
        
        // Generate main signal
        let mainSignal = 'neutral';
        if (trendStrength === 'strong' || trendStrength === 'very_strong') {
            if (direction.includes('bullish')) {
                mainSignal = 'strong_buy';
            } else if (direction.includes('bearish')) {
                mainSignal = 'strong_sell';
            }
        } else if (trendStrength === 'moderate') {
            if (direction === 'bullish') {
                mainSignal = 'buy';
            } else if (direction === 'bearish') {
                mainSignal = 'sell';
            }
        }
        
        return {
            signal: mainSignal,
            trendStrength,
            direction,
            adx: this.currentADX.toFixed(2),
            plusDI: this.currentPlusDI.toFixed(2),
            minusDI: this.currentMinusDI.toFixed(2),
            crossover,
            adxTrend,
            confidence: this.calculateConfidence()
        };
    }

    // Check for DI crossovers
    checkDICrossover() {
        if (this.plusDIHistory.length < 2 || this.minusDIHistory.length < 2) {
            return 'none';
        }
        
        const currentPlusDI = this.plusDIHistory[this.plusDIHistory.length - 1];
        const previousPlusDI = this.plusDIHistory[this.plusDIHistory.length - 2];
        const currentMinusDI = this.minusDIHistory[this.minusDIHistory.length - 1];
        const previousMinusDI = this.minusDIHistory[this.minusDIHistory.length - 2];
        
        // Check for bullish crossover (DI+ crosses above DI-)
        if (previousPlusDI <= previousMinusDI && currentPlusDI > currentMinusDI) {
            return 'bullish_crossover';
        }
        
        // Check for bearish crossover (DI+ crosses below DI-)
        if (previousPlusDI >= previousMinusDI && currentPlusDI < currentMinusDI) {
            return 'bearish_crossover';
        }
        
        return 'none';
    }

    // Get ADX trend (rising or falling)
    getADXTrend() {
        if (this.adxHistory.length < 3) return 'unknown';
        
        const recent = this.adxHistory.slice(-3);
        const slope = (recent[2] - recent[0]) / 2;
        
        if (slope > 1) {
            return 'rising';
        } else if (slope < -1) {
            return 'falling';
        } else {
            return 'sideways';
        }
    }

    // Calculate signal confidence
    calculateConfidence() {
        if (!this.initialized) return 0;
        
        let confidence = 0;
        
        // ADX value contributes to confidence
        if (this.currentADX >= 25) confidence += 40;
        else if (this.currentADX >= 20) confidence += 25;
        else confidence += 10;
        
        // Directional clarity contributes to confidence
        const diDifference = Math.abs(this.currentPlusDI - this.currentMinusDI);
        if (diDifference >= 10) confidence += 30;
        else if (diDifference >= 5) confidence += 20;
        else confidence += 10;
        
        // ADX trend contributes to confidence
        const adxTrend = this.getADXTrend();
        if (adxTrend === 'rising') confidence += 20;
        else if (adxTrend === 'sideways') confidence += 10;
        else confidence += 5;
        
        // Recent crossover contributes to confidence
        const crossover = this.checkDICrossover();
        if (crossover !== 'none') confidence += 10;
        
        return Math.min(100, confidence);
    }

    // Get enhanced status for debugging
    getStatus() {
        const status = {
            library: 'technicalindicators v3.1.0',
            initialized: this.initialized,
            period: this.period,
            updateCount: this.updateCount,
            debugEnabled: this.debug,
            adx: this.currentADX ? this.currentADX.toFixed(4) : 'null',
            plusDI: this.currentPlusDI ? this.currentPlusDI.toFixed(4) : 'null',
            minusDI: this.currentMinusDI ? this.currentMinusDI.toFixed(4) : 'null',
            historyLength: this.adxHistory.length
        };

        // Add signals if initialized
        if (this.initialized) {
            status.signals = this.getADXSignals();
        }

        return status;
    }

    // Change period (requires reset)
    setPeriod(newPeriod) {
        if (typeof newPeriod !== 'number' || newPeriod <= 0) {
            console.error('[ADX Calculator] Invalid period provided');
            return false;
        }

        this.period = newPeriod;
        this.reset();
        
        console.log(`[ADX Calculator] Period changed to ${newPeriod} - calculator reset`);
        return true;
    }

    // Reset calculator
    reset() {
        console.log('[ADX Calculator] 🔄 Resetting calculator...');
        
        this.adx = new ADX({ period: this.period });
        this.currentADX = null;
        this.currentPlusDI = null;
        this.currentMinusDI = null;
        this.lastCandle = null;
        this.initialized = false;
        this.updateCount = 0;
        
        // Clear history
        this.adxHistory = [];
        this.plusDIHistory = [];
        this.minusDIHistory = [];
        
        console.log('[ADX Calculator] ✅ Reset complete - technicalindicators instance reinitialized');
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

        if (!this.adx) {
            issues.push('Missing ADX indicator instance');
        }

        // Check if ADX calculation is working
        if (this.initialized && (this.currentADX === null || this.currentPlusDI === null || this.currentMinusDI === null)) {
            issues.push('ADX calculation not working properly');
        }
        
        return {
            healthy: issues.length === 0,
            issues: issues,
            library: 'technicalindicators v3.1.0',
            period: this.period,
            updateCount: this.updateCount,
            hasValidADX: this.currentADX !== null,
            historySize: this.adxHistory.length
        };
    }

    // Toggle debugging
    setDebug(enabled) {
        this.debug = enabled;
        console.log(`[ADX Calculator] Debug mode: ${enabled ? 'ENABLED' : 'DISABLED'} (technicalindicators v3.1.0)`);
    }
}

module.exports = ADXCalculator;