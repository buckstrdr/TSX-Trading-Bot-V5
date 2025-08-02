// TEMACalculator.js - Triple Exponential Moving Average Calculator
// Using technicalindicators library v3.1.0 for accurate calculations
// TEMA = 3 * EMA1 - 3 * EMA2 + EMA3

const { EMA } = require('technicalindicators');

class TEMACalculator {
    constructor(period = 9) {
        this.period = period;
        this.temaValue = null;
        this.initialized = false;
        this.updateCount = 0;
        this.lastPrice = null;
        this.debug = true;
        
        // Initialize three EMA indicators for TEMA calculation
        this.ema1 = new EMA({ period, values: [] });
        this.ema2 = new EMA({ period, values: [] });
        this.ema3 = new EMA({ period, values: [] });
        
        // Track intermediate values for debugging
        this.ema1Value = null;
        this.ema2Value = null;
        this.ema3Value = null;
        
        console.log(`[TEMA Calculator] Initialized with period: ${period}`);
        console.log(`[TEMA Calculator] Using technicalindicators library v3.1.0`);
        console.log(`[TEMA Calculator] Formula: TEMA = 3 * EMA1 - 3 * EMA2 + EMA3`);
    }
    
    // Initialize with historical data
    async initializeWithHistorical(historicalData) {
        try {
            console.log(`[TEMA Calculator] Starting bootstrap with ${historicalData?.length || 0} data points`);
            
            if (!historicalData || historicalData.length === 0) {
                console.log('[TEMA Calculator] No historical data provided');
                return false;
            }

            // Extract prices from historical data
            const prices = this.extractPrices(historicalData);
            if (prices.length === 0) {
                console.log('[TEMA Calculator] No valid prices extracted from historical data');
                return false;
            }

            // TEMA needs at least 3 * period - 2 data points for full calculation
            const minRequired = (3 * this.period) - 2;
            if (prices.length < minRequired) {
                console.log(`[TEMA Calculator] Insufficient data - need at least ${minRequired} points for TEMA${this.period}, got ${prices.length}`);
                return false;
            }
            
            console.log(`[TEMA Calculator] Extracted ${prices.length} valid prices`);
            console.log(`[TEMA Calculator] Price range: ${Math.min(...prices).toFixed(2)} - ${Math.max(...prices).toFixed(2)}`);
            
            // Calculate TEMA using the full price history
            const temaResults = this.calculate(prices);
            if (temaResults.length === 0) {
                console.log('[TEMA Calculator] No TEMA values calculated from historical data');
                return false;
            }
            
            // Get the latest TEMA value
            this.temaValue = temaResults[temaResults.length - 1];
            
            // Re-initialize EMAs with historical data for real-time updates
            this.ema1 = new EMA({ period: this.period, values: prices });
            this.ema2 = new EMA({ period: this.period, values: [] });
            this.ema3 = new EMA({ period: this.period, values: [] });
            
            // Initialize EMA2 with EMA1 values
            const ema1Results = EMA.calculate({ period: this.period, values: prices });
            ema1Results.forEach(value => {
                this.ema2.nextValue(value);
            });
            
            // Initialize EMA3 with EMA2 values
            const ema2Results = EMA.calculate({ period: this.period, values: ema1Results });
            ema2Results.forEach(value => {
                this.ema3.nextValue(value);
            });
            
            // Set current intermediate values
            if (ema1Results.length > 0) this.ema1Value = ema1Results[ema1Results.length - 1];
            if (ema2Results.length > 0) this.ema2Value = ema2Results[ema2Results.length - 1];
            const ema3Results = EMA.calculate({ period: this.period, values: ema2Results });
            if (ema3Results.length > 0) this.ema3Value = ema3Results[ema3Results.length - 1];
            
            this.initialized = true;
            this.lastPrice = prices[prices.length - 1];
            
            console.log(`[TEMA Calculator] ✅ Bootstrap SUCCESS using technicalindicators library!`);
            console.log(`[TEMA Calculator] TEMA${this.period}: ${this.temaValue.toFixed(4)}`);
            console.log(`[TEMA Calculator] EMA1: ${this.ema1Value?.toFixed(4) || 'null'}`);
            console.log(`[TEMA Calculator] EMA2: ${this.ema2Value?.toFixed(4) || 'null'}`);
            console.log(`[TEMA Calculator] EMA3: ${this.ema3Value?.toFixed(4) || 'null'}`);
            console.log(`[TEMA Calculator] Last price: ${this.lastPrice.toFixed(2)}`);
            
            return true;
        } catch (error) {
            console.error('[TEMA Calculator] Bootstrap failed:', error.message);
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
    
    // Update TEMA with new price
    nextValue(price) {
        if (price === undefined || price === null || isNaN(price) || price <= 0) {
            return null;
        }

        // Step 1: Update EMA1 with the new price
        const ema1Value = this.ema1.nextValue(price);
        if (ema1Value === undefined) return null;
        this.ema1Value = ema1Value;
        
        // Step 2: Update EMA2 with the EMA1 value
        const ema2Value = this.ema2.nextValue(ema1Value);
        if (ema2Value === undefined) return null;
        this.ema2Value = ema2Value;
        
        // Step 3: Update EMA3 with the EMA2 value
        const ema3Value = this.ema3.nextValue(ema2Value);
        if (ema3Value === undefined) return null;
        this.ema3Value = ema3Value;
        
        // Step 4: Calculate TEMA = 3 * EMA1 - 3 * EMA2 + EMA3
        const tema = (3 * ema1Value) - (3 * ema2Value) + ema3Value;
        
        const previousTEMA = this.temaValue;
        this.temaValue = tema;
        this.updateCount++;
        this.lastPrice = price;

        // Log significant changes
        if (this.debug && (this.updateCount % 10 === 0 || (previousTEMA && Math.abs(tema - previousTEMA) > 0.01))) {
            const timestamp = new Date().toLocaleTimeString();
            const change = previousTEMA ? (tema - previousTEMA).toFixed(4) : '0.0000';
            console.log(`📈 [TEMA UPDATE ${this.updateCount}] @ ${timestamp} Price: ${price.toFixed(2)}`);
            console.log(`   TEMA${this.period}: ${tema.toFixed(4)} (${change > 0 ? '+' : ''}${change})`);
            console.log(`   EMA1: ${ema1Value.toFixed(4)}, EMA2: ${ema2Value.toFixed(4)}, EMA3: ${ema3Value.toFixed(4)}`);
        }
        
        return tema;
    }

    // Update method (alias for nextValue for consistency)
    update(price) {
        const result = this.nextValue(price);
        
        return {
            updated: result !== null,
            reason: result !== null ? 'price_update' : 'invalid_price',
            updateCount: this.updateCount,
            temaValue: result,
            details: this.getTEMAValues()
        };
    }
    
    // Calculate TEMA from array of prices
    calculate(prices) {
        if (!Array.isArray(prices) || prices.length === 0) {
            console.error('[TEMA Calculator] Invalid prices array provided');
            return [];
        }

        const minRequired = (3 * this.period) - 2;
        if (prices.length < minRequired) {
            console.warn(`[TEMA Calculator] Insufficient data for TEMA${this.period}: need ${minRequired}, got ${prices.length}`);
            return [];
        }

        try {
            // Calculate EMA1 (EMA of prices)
            const ema1Results = EMA.calculate({ period: this.period, values: prices });
            if (ema1Results.length === 0) return [];
            
            // Calculate EMA2 (EMA of EMA1)
            const ema2Results = EMA.calculate({ period: this.period, values: ema1Results });
            if (ema2Results.length === 0) return [];
            
            // Calculate EMA3 (EMA of EMA2)
            const ema3Results = EMA.calculate({ period: this.period, values: ema2Results });
            if (ema3Results.length === 0) return [];
            
            // Calculate TEMA values
            const temaResults = [];
            const startIndex = ema1Results.length - ema3Results.length;
            
            for (let i = 0; i < ema3Results.length; i++) {
                const ema1 = ema1Results[startIndex + i];
                const ema2 = ema2Results[i];
                const ema3 = ema3Results[i];
                
                const tema = (3 * ema1) - (3 * ema2) + ema3;
                temaResults.push(tema);
            }
            
            return temaResults;
        } catch (error) {
            console.error(`[TEMA Calculator] Error calculating TEMA${this.period}:`, error.message);
            return [];
        }
    }

    // Get current TEMA value
    getTEMA() {
        return this.temaValue;
    }

    // Get all TEMA-related values
    getTEMAValues() {
        return {
            tema: this.temaValue,
            [`tema${this.period}`]: this.temaValue,
            ema1: this.ema1Value,
            ema2: this.ema2Value,
            ema3: this.ema3Value,
            period: this.period,
            initialized: this.initialized,
            updateCount: this.updateCount,
            lastPrice: this.lastPrice,
            updateMethod: 'technicalindicators_library_v3.1.0'
        };
    }

    // Get TEMA signals (price relative to TEMA)
    getTEMASignals() {
        if (!this.initialized || !this.lastPrice || this.temaValue === null) {
            return { signal: 'not_initialized' };
        }

        const price = this.lastPrice;
        const tema = this.temaValue;
        const distance = ((price - tema) / tema * 100);
        
        let signal = 'neutral';
        if (price > tema) {
            signal = 'above';
        } else if (price < tema) {
            signal = 'below';
        }

        // TEMA trend analysis
        let trend = 'unknown';
        if (this.ema1Value && this.ema2Value && this.ema3Value) {
            if (this.ema1Value > this.ema2Value && this.ema2Value > this.ema3Value) {
                trend = 'strong_bullish';
            } else if (this.ema1Value > this.ema2Value) {
                trend = 'bullish';
            } else if (this.ema1Value < this.ema2Value && this.ema2Value < this.ema3Value) {
                trend = 'strong_bearish';
            } else if (this.ema1Value < this.ema2Value) {
                trend = 'bearish';
            } else {
                trend = 'sideways';
            }
        }
        
        return {
            signal,
            trend,
            distance: distance.toFixed(2),
            tema: tema.toFixed(4),
            price: price.toFixed(2),
            strength: Math.abs(distance) > 1 ? 'strong' : 'weak'
        };
    }

    // Get enhanced status for debugging
    getStatus() {
        const status = {
            library: 'technicalindicators v3.1.0',
            initialized: this.initialized,
            period: this.period,
            updateCount: this.updateCount,
            lastPrice: this.lastPrice ? this.lastPrice.toFixed(2) : 'null',
            debugEnabled: this.debug,
            tema: this.temaValue ? this.temaValue.toFixed(4) : 'null',
            ema1: this.ema1Value ? this.ema1Value.toFixed(4) : 'null',
            ema2: this.ema2Value ? this.ema2Value.toFixed(4) : 'null',
            ema3: this.ema3Value ? this.ema3Value.toFixed(4) : 'null'
        };

        // Add signals if initialized
        if (this.initialized) {
            status.signals = this.getTEMASignals();
        }

        return status;
    }

    // Change period (requires reset)
    setPeriod(newPeriod) {
        if (typeof newPeriod !== 'number' || newPeriod <= 0) {
            console.error('[TEMA Calculator] Invalid period provided');
            return false;
        }

        this.period = newPeriod;
        this.reset();
        
        console.log(`[TEMA Calculator] Period changed to ${newPeriod} - calculator reset`);
        return true;
    }

    // Reset calculator
    reset() {
        console.log('[TEMA Calculator] 🔄 Resetting calculator...');
        
        this.ema1 = new EMA({ period: this.period, values: [] });
        this.ema2 = new EMA({ period: this.period, values: [] });
        this.ema3 = new EMA({ period: this.period, values: [] });
        
        this.temaValue = null;
        this.ema1Value = null;
        this.ema2Value = null;
        this.ema3Value = null;
        this.initialized = false;
        this.updateCount = 0;
        this.lastPrice = null;
        
        console.log('[TEMA Calculator] ✅ Reset complete - technicalindicators instances reinitialized');
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

        // Check if all EMAs are working
        if (!this.ema1 || !this.ema2 || !this.ema3) {
            issues.push('Missing EMA indicators');
        }

        // Check if TEMA calculation is working
        if (this.initialized && this.temaValue === null) {
            issues.push('TEMA calculation not working');
        }
        
        return {
            healthy: issues.length === 0,
            issues: issues,
            library: 'technicalindicators v3.1.0',
            period: this.period,
            updateCount: this.updateCount,
            hasValidTEMA: this.temaValue !== null
        };
    }

    // Toggle debugging
    setDebug(enabled) {
        this.debug = enabled;
        console.log(`[TEMA Calculator] Debug mode: ${enabled ? 'ENABLED' : 'DISABLED'} (technicalindicators v3.1.0)`);
    }
}

module.exports = TEMACalculator;