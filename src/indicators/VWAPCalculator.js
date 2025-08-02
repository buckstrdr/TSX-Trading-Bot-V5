// VWAPCalculator.js - Volume Weighted Average Price Calculator
// Custom implementation compatible with technicalindicators library style
// VWAP is calculated as sum(price * volume) / sum(volume) for a given period

class VWAPCalculator {
    constructor(timeframes = ['5min', '15min', '30min']) {
        this.timeframes = Array.isArray(timeframes) ? timeframes : [timeframes];
        this.initialized = false;
        this.updateCount = 0;
        this.debug = true;
        
        // VWAP data for each timeframe
        this.vwapData = {};
        this.currentVWAP = {};
        
        // Initialize timeframes
        this.initializeTimeframes();
        
        console.log(`[VWAP Calculator] Initialized with timeframes: ${this.timeframes.join(', ')}`);
        console.log(`[VWAP Calculator] Custom implementation compatible with technicalindicators style`);
        console.log(`[VWAP Calculator] VWAP = sum(price * volume) / sum(volume)`);
    }
    
    // Initialize VWAP data structures for each timeframe
    initializeTimeframes() {
        this.timeframes.forEach(timeframe => {
            this.vwapData[timeframe] = {
                dataPoints: [],
                cumulativePriceVolume: 0,
                cumulativeVolume: 0,
                sessionStart: null,
                lastReset: null
            };
            this.currentVWAP[timeframe] = null;
        });
    }
    
    // Initialize with historical data
    async initializeWithHistorical(historicalData) {
        try {
            console.log(`[VWAP Calculator] Starting bootstrap with ${historicalData?.length || 0} data points`);
            
            if (!historicalData || historicalData.length === 0) {
                console.log('[VWAP Calculator] No historical data provided');
                return false;
            }

            // Extract price-volume data from historical data
            const priceVolumeData = this.extractPriceVolumeData(historicalData);
            if (priceVolumeData.length === 0) {
                console.log('[VWAP Calculator] No valid price-volume data extracted from historical data');
                return false;
            }
            
            console.log(`[VWAP Calculator] Extracted ${priceVolumeData.length} valid price-volume pairs`);
            console.log(`[VWAP Calculator] Price range: ${Math.min(...priceVolumeData.map(d => d.price)).toFixed(2)} - ${Math.max(...priceVolumeData.map(d => d.price)).toFixed(2)}`);
            console.log(`[VWAP Calculator] Volume range: ${Math.min(...priceVolumeData.map(d => d.volume)).toFixed(0)} - ${Math.max(...priceVolumeData.map(d => d.volume)).toFixed(0)}`);
            
            // Process historical data for each timeframe
            this.timeframes.forEach(timeframe => {
                this.processHistoricalDataForTimeframe(priceVolumeData, timeframe);
            });
            
            this.initialized = true;
            
            console.log(`[VWAP Calculator] ✅ Bootstrap SUCCESS!`);
            this.timeframes.forEach(timeframe => {
                if (this.currentVWAP[timeframe] !== null) {
                    console.log(`[VWAP Calculator] VWAP ${timeframe}: ${this.currentVWAP[timeframe].toFixed(4)}`);
                }
            });
            
            return true;
        } catch (error) {
            console.error('[VWAP Calculator] Bootstrap failed:', error.message);
            return false;
        }
    }

    // Extract price-volume data from historical data
    extractPriceVolumeData(data) {
        const priceVolumeData = [];
        
        for (let i = 0; i < data.length; i++) {
            const item = data[i];
            const extracted = this.extractSinglePriceVolume(item);
            if (extracted) {
                priceVolumeData.push(extracted);
            }
        }
        
        return priceVolumeData;
    }

    // Extract price and volume from a single data point
    extractSinglePriceVolume(item) {
        if (!item) return null;
        
        let price = null;
        let volume = null;
        let timestamp = null;
        
        if (typeof item === 'object') {
            // Extract price
            price = item.c || item.close || item.price || item.last || 
                   item.Close || item.Price || item.Last ||
                   (item.data && item.data.lastPrice);
            
            // Extract volume
            volume = item.v || item.volume || item.Volume || item.vol ||
                    (item.data && item.data.volume) || 1000; // Default volume if not provided
            
            // Extract timestamp
            timestamp = item.timestamp || item.time || item.t || 
                       item.Timestamp || item.Time || Date.now();
        } else if (typeof item === 'number') {
            price = item;
            volume = 1000; // Default volume
            timestamp = Date.now();
        }
        
        // Validate extracted values
        if (price !== null && volume !== null && 
            !isNaN(price) && !isNaN(volume) && 
            price > 0 && volume > 0) {
            return {
                price: parseFloat(price),
                volume: parseFloat(volume),
                timestamp: timestamp
            };
        }
        
        return null;
    }

    // Process historical data for a specific timeframe
    processHistoricalDataForTimeframe(data, timeframe) {
        const timeframeMs = this.getTimeframeMs(timeframe);
        if (!timeframeMs) return;
        
        let currentSessionStart = null;
        let cumulativePriceVolume = 0;
        let cumulativeVolume = 0;
        
        for (const dataPoint of data) {
            const timestamp = new Date(dataPoint.timestamp);
            const sessionStart = this.getSessionStart(timestamp, timeframeMs);
            
            // Check if we're in a new session
            if (currentSessionStart === null || sessionStart.getTime() !== currentSessionStart.getTime()) {
                // New session - reset cumulative values
                currentSessionStart = sessionStart;
                cumulativePriceVolume = 0;
                cumulativeVolume = 0;
            }
            
            // Add to cumulative values
            cumulativePriceVolume += dataPoint.price * dataPoint.volume;
            cumulativeVolume += dataPoint.volume;
            
            // Calculate VWAP
            const vwap = cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : dataPoint.price;
            
            // Store data
            this.vwapData[timeframe].dataPoints.push({
                ...dataPoint,
                vwap: vwap,
                sessionStart: currentSessionStart
            });
        }
        
        // Set current values
        if (this.vwapData[timeframe].dataPoints.length > 0) {
            const lastDataPoint = this.vwapData[timeframe].dataPoints[this.vwapData[timeframe].dataPoints.length - 1];
            this.currentVWAP[timeframe] = lastDataPoint.vwap;
            this.vwapData[timeframe].cumulativePriceVolume = cumulativePriceVolume;
            this.vwapData[timeframe].cumulativeVolume = cumulativeVolume;
            this.vwapData[timeframe].sessionStart = currentSessionStart;
        }
    }

    // Get timeframe in milliseconds
    getTimeframeMs(timeframe) {
        const timeframeMap = {
            '1min': 60 * 1000,
            '5min': 5 * 60 * 1000,
            '15min': 15 * 60 * 1000,
            '30min': 30 * 60 * 1000,
            '1hour': 60 * 60 * 1000,
            '4hour': 4 * 60 * 60 * 1000,
            '1day': 24 * 60 * 60 * 1000
        };
        
        return timeframeMap[timeframe] || null;
    }

    // Get session start time for a given timestamp and timeframe
    getSessionStart(timestamp, timeframeMs) {
        const time = timestamp.getTime();
        const sessionStartTime = Math.floor(time / timeframeMs) * timeframeMs;
        return new Date(sessionStartTime);
    }
    
    // Add data point (main update method)
    addDataPoint(price, volume, timestamp) {
        const dataPoint = this.extractSinglePriceVolume({ price, volume, timestamp });
        if (!dataPoint) {
            return { updated: false, reason: 'invalid_data' };
        }

        const results = {};
        let updated = false;
        
        // Update VWAP for each timeframe
        this.timeframes.forEach(timeframe => {
            const result = this.updateTimeframe(timeframe, dataPoint);
            results[timeframe] = result;
            if (result.updated) updated = true;
        });
        
        if (updated) {
            this.updateCount++;
            
            // Log updates
            if (this.debug && this.updateCount % 10 === 0) {
                const time = new Date(timestamp).toLocaleTimeString();
                console.log(`📊 [VWAP UPDATE ${this.updateCount}] @ ${time} Price: ${price.toFixed(2)} Volume: ${volume.toFixed(0)}`);
                this.timeframes.forEach(timeframe => {
                    if (this.currentVWAP[timeframe] !== null) {
                        console.log(`   VWAP ${timeframe}: ${this.currentVWAP[timeframe].toFixed(4)}`);
                    }
                });
            }
        }
        
        return {
            updated,
            reason: updated ? 'data_point_added' : 'no_updates',
            updateCount: this.updateCount,
            vwapValues: this.getVWAPValues(),
            results
        };
    }

    // Update VWAP for a specific timeframe
    updateTimeframe(timeframe, dataPoint) {
        const timeframeMs = this.getTimeframeMs(timeframe);
        if (!timeframeMs) {
            return { updated: false, reason: 'invalid_timeframe' };
        }
        
        const timestamp = new Date(dataPoint.timestamp);
        const sessionStart = this.getSessionStart(timestamp, timeframeMs);
        const data = this.vwapData[timeframe];
        
        // Check if we're in a new session
        if (!data.sessionStart || sessionStart.getTime() !== data.sessionStart.getTime()) {
            // New session - reset
            data.sessionStart = sessionStart;
            data.cumulativePriceVolume = 0;
            data.cumulativeVolume = 0;
            data.lastReset = timestamp;
        }
        
        // Add to cumulative values
        data.cumulativePriceVolume += dataPoint.price * dataPoint.volume;
        data.cumulativeVolume += dataPoint.volume;
        
        // Calculate new VWAP
        const newVWAP = data.cumulativeVolume > 0 ? 
            data.cumulativePriceVolume / data.cumulativeVolume : dataPoint.price;
        
        const previousVWAP = this.currentVWAP[timeframe];
        this.currentVWAP[timeframe] = newVWAP;
        
        // Store data point
        data.dataPoints.push({
            ...dataPoint,
            vwap: newVWAP,
            sessionStart: data.sessionStart
        });
        
        // Keep only recent data points (limit memory usage)
        const maxDataPoints = 1000;
        if (data.dataPoints.length > maxDataPoints) {
            data.dataPoints = data.dataPoints.slice(-maxDataPoints);
        }
        
        return {
            updated: true,
            previousVWAP,
            newVWAP,
            sessionReset: !previousVWAP || sessionStart.getTime() !== (data.lastReset?.getTime() || 0)
        };
    }

    // Get VWAP for a specific timeframe
    getVWAP(timeframe) {
        return this.currentVWAP[timeframe] || null;
    }

    // Get all VWAP values
    getVWAPValues() {
        const values = { ...this.currentVWAP };
        
        // Add metadata
        values.initialized = this.initialized;
        values.updateCount = this.updateCount;
        values.timeframes = [...this.timeframes];
        values.updateMethod = 'custom_vwap_implementation';
        
        return values;
    }

    // Get VWAP signals
    getVWAPSignals() {
        if (!this.initialized) {
            return { signal: 'not_initialized' };
        }

        const signals = {};
        
        this.timeframes.forEach(timeframe => {
            const vwap = this.currentVWAP[timeframe];
            const data = this.vwapData[timeframe];
            
            if (vwap && data.dataPoints.length > 0) {
                const lastDataPoint = data.dataPoints[data.dataPoints.length - 1];
                const currentPrice = lastDataPoint.price;
                
                // Price relative to VWAP
                let signal = 'neutral';
                const deviation = ((currentPrice - vwap) / vwap) * 100;
                
                if (deviation > 1) {
                    signal = 'above_strong';
                } else if (deviation > 0.2) {
                    signal = 'above';
                } else if (deviation < -1) {
                    signal = 'below_strong';
                } else if (deviation < -0.2) {
                    signal = 'below';
                }
                
                signals[timeframe] = {
                    signal,
                    vwap: vwap.toFixed(4),
                    currentPrice: currentPrice.toFixed(2),
                    deviation: deviation.toFixed(2),
                    volume: lastDataPoint.volume,
                    sessionStart: data.sessionStart?.toISOString() || null
                };
            }
        });
        
        return signals;
    }

    // Get VWAP statistics for a timeframe
    getVWAPStatistics(timeframe) {
        if (!this.vwapData[timeframe] || this.vwapData[timeframe].dataPoints.length === 0) {
            return null;
        }
        
        const data = this.vwapData[timeframe];
        const dataPoints = data.dataPoints;
        const prices = dataPoints.map(d => d.price);
        const vwaps = dataPoints.map(d => d.vwap);
        
        // Calculate deviations
        const deviations = dataPoints.map(d => ((d.price - d.vwap) / d.vwap) * 100);
        const sortedDeviations = [...deviations].sort((a, b) => a - b);
        
        return {
            timeframe,
            dataPointsCount: dataPoints.length,
            currentVWAP: this.currentVWAP[timeframe]?.toFixed(4) || 'null',
            cumulativeVolume: data.cumulativeVolume.toFixed(0),
            sessionStart: data.sessionStart?.toISOString() || null,
            priceRange: {
                min: Math.min(...prices).toFixed(2),
                max: Math.max(...prices).toFixed(2),
                current: prices[prices.length - 1]?.toFixed(2) || 'null'
            },
            vwapRange: {
                min: Math.min(...vwaps).toFixed(4),
                max: Math.max(...vwaps).toFixed(4)
            },
            deviationStats: {
                min: sortedDeviations[0]?.toFixed(2) || 'null',
                max: sortedDeviations[sortedDeviations.length - 1]?.toFixed(2) || 'null',
                median: sortedDeviations[Math.floor(sortedDeviations.length / 2)]?.toFixed(2) || 'null',
                current: deviations[deviations.length - 1]?.toFixed(2) || 'null'
            }
        };
    }

    // Reset VWAP calculation
    reset() {
        console.log('[VWAP Calculator] 🔄 Resetting calculator...');
        
        this.initializeTimeframes();
        this.initialized = false;
        this.updateCount = 0;
        
        console.log('[VWAP Calculator] ✅ Reset complete - all timeframes reinitialized');
    }

    // Reset specific timeframe
    resetTimeframe(timeframe) {
        if (!this.timeframes.includes(timeframe)) {
            console.error(`[VWAP Calculator] Timeframe ${timeframe} not tracked`);
            return false;
        }
        
        this.vwapData[timeframe] = {
            dataPoints: [],
            cumulativePriceVolume: 0,
            cumulativeVolume: 0,
            sessionStart: null,
            lastReset: null
        };
        this.currentVWAP[timeframe] = null;
        
        console.log(`[VWAP Calculator] Reset timeframe: ${timeframe}`);
        return true;
    }

    // Add timeframe
    addTimeframe(timeframe) {
        if (this.timeframes.includes(timeframe)) {
            console.log(`[VWAP Calculator] Timeframe ${timeframe} already tracked`);
            return true;
        }
        
        if (!this.getTimeframeMs(timeframe)) {
            console.error(`[VWAP Calculator] Invalid timeframe: ${timeframe}`);
            return false;
        }
        
        this.timeframes.push(timeframe);
        this.vwapData[timeframe] = {
            dataPoints: [],
            cumulativePriceVolume: 0,
            cumulativeVolume: 0,
            sessionStart: null,
            lastReset: null
        };
        this.currentVWAP[timeframe] = null;
        
        console.log(`[VWAP Calculator] Added timeframe: ${timeframe}`);
        return true;
    }

    // Remove timeframe
    removeTimeframe(timeframe) {
        const index = this.timeframes.indexOf(timeframe);
        if (index === -1) {
            console.log(`[VWAP Calculator] Timeframe ${timeframe} not tracked`);
            return false;
        }
        
        this.timeframes.splice(index, 1);
        delete this.vwapData[timeframe];
        delete this.currentVWAP[timeframe];
        
        console.log(`[VWAP Calculator] Removed timeframe: ${timeframe}`);
        return true;
    }

    // Get enhanced status
    getStatus() {
        const status = {
            library: 'custom_vwap_implementation',
            initialized: this.initialized,
            timeframes: [...this.timeframes],
            updateCount: this.updateCount,
            debugEnabled: this.debug
        };
        
        // Add current VWAP values
        this.timeframes.forEach(timeframe => {
            status[`vwap_${timeframe}`] = this.currentVWAP[timeframe] ? 
                this.currentVWAP[timeframe].toFixed(4) : 'null';
        });
        
        // Add signals if initialized
        if (this.initialized) {
            status.signals = this.getVWAPSignals();
        }
        
        return status;
    }

    // Health check
    performHealthCheck() {
        const issues = [];
        
        if (!this.initialized) {
            issues.push('Not initialized');
        }
        
        if (this.timeframes.length === 0) {
            issues.push('No timeframes configured');
        }
        
        // Check each timeframe
        this.timeframes.forEach(timeframe => {
            if (!this.vwapData[timeframe]) {
                issues.push(`Missing data for timeframe ${timeframe}`);
            }
            
            if (!this.getTimeframeMs(timeframe)) {
                issues.push(`Invalid timeframe ${timeframe}`);
            }
        });
        
        return {
            healthy: issues.length === 0,
            issues: issues,
            library: 'custom_vwap_implementation',
            timeframesCount: this.timeframes.length,
            updateCount: this.updateCount
        };
    }

    // Toggle debugging
    setDebug(enabled) {
        this.debug = enabled;
        console.log(`[VWAP Calculator] Debug mode: ${enabled ? 'ENABLED' : 'DISABLED'} (custom implementation)`);
    }
}

module.exports = VWAPCalculator;