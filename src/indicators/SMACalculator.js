// SMACalculator.js - Simple Moving Average Calculator
// Using technicalindicators library v3.1.0 for accurate calculations
// Supports multiple periods and real-time updates

const { SMA } = require('technicalindicators');

class SMACalculator {
    constructor(periods = [10, 20, 50, 200]) {
        this.periods = Array.isArray(periods) ? periods : [periods];
        this.indicators = {};
        this.smaValues = {};
        this.initialized = false;
        this.updateCount = 0;
        this.lastPrice = null;
        this.debug = true;
        
        // Initialize indicators for each period
        this.initializeIndicators();
        
        console.log(`[SMA Calculator] Initialized with periods: ${this.periods.join(', ')}`);
        console.log(`[SMA Calculator] Using technicalindicators library v3.1.0`);
    }
    
    // Initialize SMA indicators for each period
    initializeIndicators() {
        this.periods.forEach(period => {
            this.indicators[period] = new SMA({ period, values: [] });
            this.smaValues[period] = null;
        });
    }
    
    // Initialize with historical data
    async initializeWithHistorical(historicalData) {
        try {
            console.log(`[SMA Calculator] Starting bootstrap with ${historicalData?.length || 0} data points`);
            
            if (!historicalData || historicalData.length === 0) {
                console.log('[SMA Calculator] No historical data provided');
                return false;
            }

            // Extract prices from historical data
            const prices = this.extractPrices(historicalData);
            if (prices.length === 0) {
                console.log('[SMA Calculator] No valid prices extracted from historical data');
                return false;
            }

            const maxPeriod = Math.max(...this.periods);
            if (prices.length < maxPeriod) {
                console.log(`[SMA Calculator] Insufficient data - need at least ${maxPeriod} points for SMA${maxPeriod}`);
                return false;
            }
            
            console.log(`[SMA Calculator] Extracted ${prices.length} valid prices`);
            console.log(`[SMA Calculator] Price range: ${Math.min(...prices).toFixed(2)} - ${Math.max(...prices).toFixed(2)}`);
            
            // Calculate SMAs for each period using the library
            this.periods.forEach(period => {
                const smaResults = SMA.calculate({ period, values: prices });
                if (smaResults.length > 0) {
                    this.smaValues[period] = smaResults[smaResults.length - 1];
                    // Re-initialize indicator with historical data for real-time updates
                    this.indicators[period] = new SMA({ period, values: prices });
                }
            });
            
            this.initialized = true;
            this.lastPrice = prices[prices.length - 1];
            
            console.log(`[SMA Calculator] ✅ Bootstrap SUCCESS using technicalindicators library!`);
            this.periods.forEach(period => {
                if (this.smaValues[period] !== null) {
                    console.log(`[SMA Calculator] SMA${period}: ${this.smaValues[period].toFixed(4)}`);
                }
            });
            console.log(`[SMA Calculator] Last price: ${this.lastPrice.toFixed(2)}`);
            
            return true;
        } catch (error) {
            console.error('[SMA Calculator] Bootstrap failed:', error.message);
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
    
    // Update SMAs with new price
    update(price) {
        if (price === undefined || price === null || isNaN(price) || price <= 0) {
            return { updated: false, reason: 'invalid_price' };
        }

        const results = {};
        const previousValues = { ...this.smaValues };
        
        // Update each SMA indicator
        this.periods.forEach(period => {
            const newValue = this.indicators[period].nextValue(price);
            if (newValue !== undefined) {
                this.smaValues[period] = newValue;
                results[period] = newValue;
            }
        });
        
        this.updateCount++;
        this.lastPrice = price;

        // Log significant changes
        if (this.debug && this.updateCount % 10 === 0) {
            const timestamp = new Date().toLocaleTimeString();
            console.log(`📊 [SMA UPDATE ${this.updateCount}] @ ${timestamp} Price: ${price.toFixed(2)}`);
            this.periods.forEach(period => {
                if (this.smaValues[period] !== null) {
                    const change = previousValues[period] ? 
                        (this.smaValues[period] - previousValues[period]).toFixed(4) : '0.0000';
                    console.log(`   SMA${period}: ${this.smaValues[period].toFixed(4)} (${change > 0 ? '+' : ''}${change})`);
                }
            });
        }
        
        return { 
            updated: true, 
            reason: 'price_update',
            updateCount: this.updateCount,
            smaValues: this.getSMAValues(),
            results
        };
    }
    
    // Calculate SMAs from array of prices
    calculate(prices) {
        if (!Array.isArray(prices) || prices.length === 0) {
            console.error('[SMA Calculator] Invalid prices array provided');
            return {};
        }

        const results = {};
        
        this.periods.forEach(period => {
            if (prices.length >= period) {
                try {
                    const smaResults = SMA.calculate({ period, values: prices });
                    results[period] = smaResults;
                } catch (error) {
                    console.error(`[SMA Calculator] Error calculating SMA${period}:`, error.message);
                    results[period] = [];
                }
            } else {
                console.warn(`[SMA Calculator] Insufficient data for SMA${period}: need ${period}, got ${prices.length}`);
                results[period] = [];
            }
        });
        
        return results;
    }

    // Get SMA value for a specific period
    getSMA(period) {
        return this.smaValues[period] || null;
    }

    // Get all current SMA values
    getSMAValues() {
        const values = { ...this.smaValues };
        
        // Add metadata
        values.initialized = this.initialized;
        values.updateCount = this.updateCount;
        values.lastPrice = this.lastPrice;
        values.periods = [...this.periods];
        values.updateMethod = 'technicalindicators_library_v3.1.0';
        
        return values;
    }

    // Get SMA signals (price relative to SMAs)
    getSMASignals() {
        if (!this.initialized || !this.lastPrice) {
            return { signal: 'not_initialized' };
        }

        const signals = {};
        const price = this.lastPrice;
        
        this.periods.forEach(period => {
            const smaValue = this.smaValues[period];
            if (smaValue !== null) {
                if (price > smaValue) {
                    signals[`sma${period}`] = 'above';
                } else if (price < smaValue) {
                    signals[`sma${period}`] = 'below';
                } else {
                    signals[`sma${period}`] = 'at';
                }
                signals[`sma${period}_distance`] = ((price - smaValue) / smaValue * 100).toFixed(2);
            }
        });

        // Overall trend based on SMA alignment
        const smaAligned = this.checkSMAAlignment();
        signals.overall_trend = smaAligned.trend;
        signals.alignment_strength = smaAligned.strength;
        
        return signals;
    }

    // Check SMA alignment for trend determination
    checkSMAAlignment() {
        const validSMAs = this.periods
            .filter(period => this.smaValues[period] !== null)
            .sort((a, b) => a - b)
            .map(period => ({ period, value: this.smaValues[period] }));

        if (validSMAs.length < 2) {
            return { trend: 'insufficient_data', strength: 0 };
        }

        // Check if SMAs are in ascending order (bullish) or descending order (bearish)
        let bullishCount = 0;
        let bearishCount = 0;
        
        for (let i = 0; i < validSMAs.length - 1; i++) {
            if (validSMAs[i].value < validSMAs[i + 1].value) {
                bullishCount++;
            } else if (validSMAs[i].value > validSMAs[i + 1].value) {
                bearishCount++;
            }
        }

        const totalComparisons = validSMAs.length - 1;
        const bullishStrength = bullishCount / totalComparisons;
        const bearishStrength = bearishCount / totalComparisons;

        if (bullishStrength >= 0.7) {
            return { trend: 'bullish', strength: bullishStrength };
        } else if (bearishStrength >= 0.7) {
            return { trend: 'bearish', strength: bearishStrength };
        } else {
            return { trend: 'neutral', strength: Math.max(bullishStrength, bearishStrength) };
        }
    }

    // Get enhanced status for debugging
    getStatus() {
        const status = {
            library: 'technicalindicators v3.1.0',
            initialized: this.initialized,
            periods: [...this.periods],
            updateCount: this.updateCount,
            lastPrice: this.lastPrice ? this.lastPrice.toFixed(2) : 'null',
            debugEnabled: this.debug
        };

        // Add current SMA values
        this.periods.forEach(period => {
            status[`sma${period}`] = this.smaValues[period] ? this.smaValues[period].toFixed(4) : 'null';
        });

        // Add signals if initialized
        if (this.initialized) {
            status.signals = this.getSMASignals();
        }

        return status;
    }

    // Add a new period to track
    addPeriod(period) {
        if (typeof period !== 'number' || period <= 0) {
            console.error('[SMA Calculator] Invalid period provided');
            return false;
        }

        if (this.periods.includes(period)) {
            console.log(`[SMA Calculator] Period ${period} already tracked`);
            return true;
        }

        this.periods.push(period);
        this.indicators[period] = new SMA({ period, values: [] });
        this.smaValues[period] = null;

        console.log(`[SMA Calculator] Added SMA${period} to tracking`);
        return true;
    }

    // Remove a period from tracking
    removePeriod(period) {
        const index = this.periods.indexOf(period);
        if (index === -1) {
            console.log(`[SMA Calculator] Period ${period} not tracked`);
            return false;
        }

        this.periods.splice(index, 1);
        delete this.indicators[period];
        delete this.smaValues[period];

        console.log(`[SMA Calculator] Removed SMA${period} from tracking`);
        return true;
    }

    // Reset calculator
    reset() {
        console.log('[SMA Calculator] 🔄 Resetting calculator...');
        
        this.initializeIndicators();
        this.initialized = false;
        this.updateCount = 0;
        this.lastPrice = null;
        
        console.log('[SMA Calculator] ✅ Reset complete - technicalindicators instances reinitialized');
    }

    // Health check
    performHealthCheck() {
        const issues = [];
        
        if (!this.initialized) {
            issues.push('Not initialized');
        }

        if (this.periods.length === 0) {
            issues.push('No periods configured');
        }

        // Check if all indicators are working
        this.periods.forEach(period => {
            if (!this.indicators[period]) {
                issues.push(`Missing indicator for period ${period}`);
            }
        });
        
        return {
            healthy: issues.length === 0,
            issues: issues,
            library: 'technicalindicators v3.1.0',
            periodsCount: this.periods.length,
            updateCount: this.updateCount
        };
    }

    // Toggle debugging
    setDebug(enabled) {
        this.debug = enabled;
        console.log(`[SMA Calculator] Debug mode: ${enabled ? 'ENABLED' : 'DISABLED'} (technicalindicators v3.1.0)`);
    }
}

module.exports = SMACalculator;