// EMACalculator.js - Refactored to use technicalindicators library
// Maintains backward compatibility with existing interface
// Enhanced with Node.js technicalindicators v3.1.0

const { EMA } = require('technicalindicators');

class EMACalculator {
    constructor(candleIntervalSeconds = 60, updateMode = 'CANDLE_BASED', fastPeriod = 9, slowPeriod = 19) {
        // Store the configurable periods
        this.periods = { fast: fastPeriod, slow: slowPeriod };
        
        // Initialize EMA indicators from technicalindicators library
        this.indicators = {};
        this.indicators[this.periods.fast] = new EMA({ period: this.periods.fast, values: [] });
        this.indicators[this.periods.slow] = new EMA({ period: this.periods.slow, values: [] });
        
        this.emaValues = {};
        this.emaValues[this.periods.fast] = null;
        this.emaValues[this.periods.slow] = null;
        
        this.initialized = false;
        this.historicalCandles = [];
        this.bootstrapComplete = false;
        this.updateCount = 0;
        this.lastPrice = null;
        this.debug = true;
        
        // CANDLE TRACKING - This is the key fix
        this.currentCandle = null;
        this.lastCandleTime = null;
        this.candleUpdateCount = 0;
        
        // Configurable candle interval (in seconds)
        this.candleIntervalSeconds = candleIntervalSeconds;
        this.candleIntervalMs = candleIntervalSeconds * 1000;
        
        // NEW: Update mode configuration
        this.updateMode = updateMode; // 'CANDLE_BASED' or 'TICK_BASED'
        this.tickUpdateCount = 0;
        this.maxTicksPerCandle = 100; // Prevent excessive updates
        
        console.log(`[EMA Calculator] Initialized with ${updateMode} mode - ${candleIntervalSeconds}s candles`);
        console.log(`[EMA Calculator] Using technicalindicators library v3.1.0`);
        console.log(`[EMA Calculator] Configurable periods: Fast EMA${fastPeriod}, Slow EMA${slowPeriod}`);
    }

    // Initialize EMAs with historical data
    async initializeWithHistorical(historicalData) {
        try {
            console.log(`[EMA Calculator] Starting bootstrap with ${historicalData?.length || 0} data points`);
            
            if (!historicalData || historicalData.length < this.periods.slow) {
                console.log(`[EMA Calculator] Insufficient data - need at least ${this.periods.slow} points for EMA${this.periods.slow}`);
                return false;
            }

            this.historicalCandles = historicalData;
            
            // Extract and validate prices first
            const prices = this.extractPrices(historicalData);
            if (prices.length < this.periods.slow) {
                console.log('[EMA Calculator] After price extraction, insufficient valid prices');
                return false;
            }
            
            console.log(`[EMA Calculator] Extracted ${prices.length} valid prices`);
            console.log(`[EMA Calculator] Price range: ${Math.min(...prices).toFixed(2)} - ${Math.max(...prices).toFixed(2)}`);
            
            // Calculate EMAs using technicalindicators library
            const fastEMAResults = EMA.calculate({ period: this.periods.fast, values: prices });
            const slowEMAResults = EMA.calculate({ period: this.periods.slow, values: prices });
            
            if (fastEMAResults.length === 0 || slowEMAResults.length === 0) {
                console.error('[EMA Calculator] Failed to calculate EMAs from historical data');
                return false;
            }
            
            // Get the latest values
            this.emaValues[this.periods.fast] = fastEMAResults[fastEMAResults.length - 1];
            this.emaValues[this.periods.slow] = slowEMAResults[slowEMAResults.length - 1];
            
            // Re-initialize indicators with historical data for real-time updates
            this.indicators[this.periods.fast] = new EMA({ period: this.periods.fast, values: prices });
            this.indicators[this.periods.slow] = new EMA({ period: this.periods.slow, values: prices });
            
            // Validate EMAs are different
            const spread = Math.abs(this.emaValues[this.periods.fast] - this.emaValues[this.periods.slow]);
            if (spread < 0.01) {
                console.error(`[EMA Calculator] ❌ CRITICAL: EMAs too close! EMA${this.periods.fast}=${this.emaValues[this.periods.fast].toFixed(4)}, EMA${this.periods.slow}=${this.emaValues[this.periods.slow].toFixed(4)}, Spread=${spread.toFixed(4)}`);
                return false;
            }
            
            this.initialized = true;
            this.bootstrapComplete = true;
            this.lastPrice = prices[prices.length - 1];
            
            console.log(`[EMA Calculator] ✅ Bootstrap SUCCESS using technicalindicators library!`);
            console.log(`[EMA Calculator] EMA${this.periods.fast}: ${this.emaValues[this.periods.fast].toFixed(4)}`);
            console.log(`[EMA Calculator] EMA${this.periods.slow}: ${this.emaValues[this.periods.slow].toFixed(4)}`);
            console.log(`[EMA Calculator] Spread: ${spread.toFixed(4)} (should be > 0.01)`);
            console.log(`[EMA Calculator] Last price: ${this.lastPrice.toFixed(2)}`);
            console.log(`[EMA Calculator] 🎯 CANDLE MODE: Will only update on completed ${this.candleIntervalSeconds}-second candles`);
            
            return true;
        } catch (error) {
            console.error('[EMA Calculator] Bootstrap failed:', error.message);
            return false;
        }
    }

    // Extract prices from historical data
    extractPrices(data) {
        const prices = [];
        
        for (let i = 0; i < data.length; i++) {
            const item = data[i];
            let price = null;
            
            if (typeof item === 'number') {
                price = item;
            } else if (item && typeof item === 'object') {
                price = item.c || item.close || item.price || item.last || 
                       item.Close || item.Price || item.Last ||
                       (item.data && item.data.lastPrice);
            }
            
            if (price !== null && price !== undefined && !isNaN(price) && price > 0) {
                prices.push(parseFloat(price));
            }
        }
        
        return prices;
    }

    // NEW: Main update method that routes to appropriate handler
    update(price, volume, timestamp) {
        if (this.updateMode === 'TICK_BASED') {
            return this.updateWithTick(price, timestamp);
        } else {
            return this.updateWithCandle(price, volume, timestamp);
        }
    }
    
    // NEW: Tick-based update method using technicalindicators library
    updateWithTick(price, timestamp) {
        if (!this.initialized) {
            return { updated: false, reason: 'not_initialized' };
        }

        if (price === undefined || price === null || isNaN(price) || price <= 0) {
            return { updated: false, reason: 'invalid_price' };
        }

        // Update EMAs using technicalindicators library
        const previousEMAFast = this.emaValues[this.periods.fast];
        const previousEMASlow = this.emaValues[this.periods.slow];
        const previousSpread = Math.abs(previousEMAFast - previousEMASlow);

        // Get next values from technicalindicators library
        const newFastEMA = this.indicators[this.periods.fast].nextValue(price);
        const newSlowEMA = this.indicators[this.periods.slow].nextValue(price);

        if (newFastEMA !== undefined) this.emaValues[this.periods.fast] = newFastEMA;
        if (newSlowEMA !== undefined) this.emaValues[this.periods.slow] = newSlowEMA;

        this.updateCount++;
        this.tickUpdateCount++;
        this.lastPrice = price;

        // Log significant changes only (to avoid spam)
        const newSpread = Math.abs(this.emaValues[this.periods.fast] - this.emaValues[this.periods.slow]);
        const spreadChange = Math.abs(newSpread - previousSpread);
        
        if (spreadChange > 0.1 || this.tickUpdateCount % 100 === 0) {
            const time = new Date(timestamp).toLocaleTimeString();
            console.log(`📈 [TICK ${this.tickUpdateCount}] @ ${time} (technicalindicators)`);
            console.log(`   EMA${this.periods.fast}: ${this.emaValues[this.periods.fast].toFixed(4)}, EMA${this.periods.slow}: ${this.emaValues[this.periods.slow].toFixed(4)}`);
            console.log(`   Spread: ${newSpread.toFixed(4)} (${spreadChange > 0.01 ? 'CHANGED' : 'stable'})`);
        }

        return { 
            updated: true, 
            reason: 'tick_update',
            tickCount: this.tickUpdateCount,
            emaValues: this.getEMAValues()
        };
    }
    
    // FIXED: Only update EMAs when a new candle completes using technicalindicators library
    updateWithCandle(price, volume, timestamp) {
        if (!this.initialized) {
            return { updated: false, reason: 'not_initialized' };
        }

        if (price === undefined || price === null || isNaN(price) || price <= 0) {
            return { updated: false, reason: 'invalid_price' };
        }

        const currentTime = new Date(timestamp);
        const timeMs = currentTime.getTime();
        // Round down to nearest candle interval
        const candleTimeStr = Math.floor(timeMs / this.candleIntervalMs) * this.candleIntervalMs;

        // Check if this is a new candle
        if (!this.lastCandleTime || candleTimeStr !== this.lastCandleTime) {
            // NEW CANDLE - Update EMAs with the previous candle's close price
            if (this.currentCandle && this.currentCandle.close !== null) {
                const candleClosePrice = this.currentCandle.close;
                
                // Log every 6th candle (every minute with 10-second candles) to show it's working
                if (this.candleUpdateCount % 6 === 0) {
                    console.log(`⏱️ [${new Date().toLocaleTimeString()}] ${this.candleIntervalSeconds}s candle completed - Updating EMAs with technicalindicators...`);
                }
                
                this.updateEMAsWithPrice(candleClosePrice);
                this.candleUpdateCount++;
            }
            
            // Start new candle
            this.currentCandle = {
                timestamp: candleTimeStr,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: volume || 1000
            };
            this.lastCandleTime = candleTimeStr;
            
            return { 
                updated: true, 
                reason: 'new_candle_completed',
                candleCount: this.candleUpdateCount,
                emaValues: this.getEMAValues()
            };
        } else {
            // SAME CANDLE - Just update candle data, don't update EMAs
            this.currentCandle.high = Math.max(this.currentCandle.high, price);
            this.currentCandle.low = Math.min(this.currentCandle.low, price);
            this.currentCandle.close = price;
            this.currentCandle.volume += (volume || 0);
            
            return { 
                updated: false, 
                reason: 'same_candle_updating',
                currentCandle: { ...this.currentCandle }
            };
        }
    }

    // Internal method to update EMAs with a single price using technicalindicators library
    updateEMAsWithPrice(price) {
        const previousEMAFast = this.emaValues[this.periods.fast];
        const previousEMASlow = this.emaValues[this.periods.slow];
        const previousSpread = Math.abs(previousEMAFast - previousEMASlow);

        // Get next values from technicalindicators library
        const newFastEMA = this.indicators[this.periods.fast].nextValue(price);
        const newSlowEMA = this.indicators[this.periods.slow].nextValue(price);

        if (newFastEMA !== undefined) this.emaValues[this.periods.fast] = newFastEMA;
        if (newSlowEMA !== undefined) this.emaValues[this.periods.slow] = newSlowEMA;

        this.updateCount++;
        this.lastPrice = price;

        // Check if spread changed significantly (more than 0.01 points)
        const newSpread = Math.abs(this.emaValues[this.periods.fast] - this.emaValues[this.periods.slow]);
        const spreadChange = Math.abs(newSpread - previousSpread);
        
        if (spreadChange > 0.01) {
            const timestamp = new Date().toLocaleTimeString();
            console.log(`📊 [EMA SPREAD CHANGE at ${timestamp}] ${previousSpread.toFixed(2)} → ${newSpread.toFixed(2)} (${(newSpread - previousSpread) > 0 ? '+' : ''}${(newSpread - previousSpread).toFixed(2)} points) [technicalindicators]`);
            console.log(`   EMA${this.periods.fast}: ${previousEMAFast.toFixed(2)} → ${this.emaValues[this.periods.fast].toFixed(2)}`);  
            console.log(`   EMA${this.periods.slow}: ${previousEMASlow.toFixed(2)} → ${this.emaValues[this.periods.slow].toFixed(2)}`);
            console.log(`   Signal: ${this.getEMASignal().toUpperCase()}`);
        }
    }

    // Legacy method for compatibility - redirects to unified update method
    updateEMAs(newPrice) {
        console.log(`[EMA Calculator] ⚠️ Legacy updateEMAs() called - use update() instead`);
        const timestamp = new Date();
        const result = this.update(newPrice, 1000, timestamp);
        return result.updated;
    }

    // Get current EMA values with enhanced metadata
    getEMAValues() {
        const emaFast = this.emaValues[this.periods.fast];
        const emaSlow = this.emaValues[this.periods.slow];
        const spread = (emaFast && emaSlow) ? 
            Math.abs(emaFast - emaSlow) : 0;
            
        // Return with both old names (for compatibility) and descriptive names
        return {
            ema9: emaFast,  // Compatibility
            ema19: emaSlow, // Compatibility
            emaFast: emaFast,
            emaSlow: emaSlow,
            [`ema${this.periods.fast}`]: emaFast,
            [`ema${this.periods.slow}`]: emaSlow,
            spread: spread,
            initialized: this.initialized,
            bootstrapComplete: this.bootstrapComplete,
            updateCount: this.updateCount,
            candleUpdateCount: this.candleUpdateCount,
            lastPrice: this.lastPrice,
            isHealthy: spread > 0.01,
            currentCandle: this.currentCandle,
            updateMethod: 'technicalindicators_library_v3.1.0',
            periods: { ...this.periods }
        };
    }

    // Get EMA signal
    getEMASignal() {
        if (!this.initialized) {
            return 'not_initialized';
        }

        const emaFast = this.emaValues[this.periods.fast];
        const emaSlow = this.emaValues[this.periods.slow];
        const spread = Math.abs(emaFast - emaSlow);

        if (spread < 0.01) {
            return 'too_close';
        }

        if (emaFast > emaSlow) {
            return 'bullish';
        } else if (emaFast < emaSlow) {
            return 'bearish';
        } else {
            return 'neutral';
        }
    }

    // Enhanced status for debugging
    getStatus() {
        const emaValues = this.getEMAValues();
        
        return {
            library: 'technicalindicators v3.1.0',
            initialized: this.initialized,
            bootstrapComplete: this.bootstrapComplete,
            ema9: emaValues.ema9 ? emaValues.ema9.toFixed(4) : 'null',  // Compatibility
            ema19: emaValues.ema19 ? emaValues.ema19.toFixed(4) : 'null', // Compatibility
            [`ema${this.periods.fast}`]: emaValues.emaFast ? emaValues.emaFast.toFixed(4) : 'null',
            [`ema${this.periods.slow}`]: emaValues.emaSlow ? emaValues.emaSlow.toFixed(4) : 'null',
            spread: emaValues.spread.toFixed(4),
            signal: this.getEMASignal(),
            historicalDataPoints: this.historicalCandles.length,
            updateCount: this.updateCount,
            candleUpdateCount: this.candleUpdateCount,
            tickUpdateCount: this.tickUpdateCount,
            lastPrice: this.lastPrice ? this.lastPrice.toFixed(2) : 'null',
            isHealthy: emaValues.isHealthy,
            debugEnabled: this.debug,
            updateMode: this.updateMode, // Show current mode
            currentCandle: this.currentCandle,
            configuredPeriods: { ...this.periods }
        };
    }
    
    // Method to switch update modes
    setUpdateMode(mode) {
        if (mode === 'TICK_BASED' || mode === 'CANDLE_BASED') {
            this.updateMode = mode;
            console.log(`[EMA Calculator] Switched to ${mode} update mode`);
            return true;
        }
        return false;
    }

    // Method to calculate EMAs for a specific period (for flexibility)
    calculate(prices, period) {
        try {
            return EMA.calculate({ period, values: prices });
        } catch (error) {
            console.error(`[EMA Calculator] Error calculating EMA${period}:`, error.message);
            return [];
        }
    }

    // Method to get EMA for a specific period
    getEMA(period) {
        return this.emaValues[period] || null;
    }

    // Reset
    reset() {
        console.log('[EMA Calculator] 🔄 Resetting calculator...');
        
        this.emaValues = {};
        this.emaValues[this.periods.fast] = null;
        this.emaValues[this.periods.slow] = null;
        
        // Re-initialize technicalindicators instances
        this.indicators[this.periods.fast] = new EMA({ period: this.periods.fast, values: [] });
        this.indicators[this.periods.slow] = new EMA({ period: this.periods.slow, values: [] });
        
        this.initialized = false;
        this.bootstrapComplete = false;
        this.historicalCandles = [];
        this.updateCount = 0;
        this.candleUpdateCount = 0;
        this.lastPrice = null;
        this.currentCandle = null;
        this.lastCandleTime = null;
        
        console.log('[EMA Calculator] ✅ Reset complete - technicalindicators instances reinitialized');
    }

    // Force EMA values (emergency override) - updated for configurable periods
    forceEMAValues(emaFast, emaSlow) {
        if (typeof emaFast === 'number' && typeof emaSlow === 'number' && 
            !isNaN(emaFast) && !isNaN(emaSlow) && emaFast > 0 && emaSlow > 0) {
            
            console.log(`[EMA Calculator] 🚨 FORCE OVERRIDE: Setting EMA${this.periods.fast}=${emaFast.toFixed(4)}, EMA${this.periods.slow}=${emaSlow.toFixed(4)}`);
            this.emaValues[this.periods.fast] = emaFast;
            this.emaValues[this.periods.slow] = emaSlow;
            this.initialized = true;
            this.bootstrapComplete = true;
            return true;
        }
        return false;
    }

    // Health check
    performHealthCheck() {
        const issues = [];
        
        if (!this.initialized) {
            issues.push('Not initialized');
        }
        
        const spread = this.emaValues[this.periods.fast] && this.emaValues[this.periods.slow] ? 
            Math.abs(this.emaValues[this.periods.fast] - this.emaValues[this.periods.slow]) : 0;
        
        if (spread < 0.01) {
            issues.push(`EMA spread too small: ${spread.toFixed(4)}`);
        }
        
        return {
            healthy: issues.length === 0,
            issues: issues,
            library: 'technicalindicators v3.1.0'
        };
    }

    // Toggle debugging
    setDebug(enabled) {
        this.debug = enabled;
        console.log(`[EMA Calculator] Debug mode: ${enabled ? 'ENABLED' : 'DISABLED'} (technicalindicators v3.1.0)`);
    }
}

module.exports = EMACalculator;