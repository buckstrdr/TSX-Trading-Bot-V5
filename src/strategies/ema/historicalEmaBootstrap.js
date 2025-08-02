// EMA Bootstrap Function - Modified for Distributed Architecture
// Uses HistoricalDataModuleDistributed for data access

const HistoricalDataModuleDistributed = require('../modules/historicalDataModuleDistributed');

class HistoricalEMABootstrap {
    constructor(connectionClient, config = {}) {
        this.connectionClient = connectionClient;
        this.config = {
            targetBars: 200,           // Collect 200 bars for good EMA calculation
            minBarsForBootstrap: 50,  // Minimum bars needed for EMA19
            daysBack: 30,              // Look back 30 days for data
            ...config
        };
        
        // Initialize distributed historical data module
        this.historicalDataModule = new HistoricalDataModuleDistributed(connectionClient, config);
        
        this.ema9 = null;
        this.ema19 = null;
        this.isBootstrapped = false;
        this.historicalBars = [];
        
        console.log('📈 Historical EMA Bootstrap initialized (Distributed Mode)');
        console.log(`🎯 Target: ${this.config.targetBars} bars`);
    }
    
    async bootstrapEMAs(contractId) {
        console.log('\n🚀 STARTING EMA BOOTSTRAP WITH HISTORICAL DATA');
        console.log(`📊 Contract: ${contractId}`);
        
        try {
            // Step 1: Check connection to manager and historical data module
            if (!this.historicalDataModule.isReady()) {
                throw new Error('Historical data module not ready for EMA bootstrap');
            }
            
            console.log('✅ Connection and historical data module confirmed');
            
            // Step 2: Get historical data through connection client
            const historicalData = await this.fetchHistoricalData(contractId);
            if (!historicalData || historicalData.length === 0) {
                throw new Error('No historical data available for EMA bootstrap');
            }
            
            console.log(`✅ Retrieved ${historicalData.length} historical bars`);
            
            // Step 3: Calculate EMAs
            const emaResults = this.calculateEMAs(historicalData);
            if (!emaResults.success) {
                throw new Error('EMA calculation failed');
            }
            
            console.log('✅ EMA calculation complete');
            console.log(`📈 Bootstrapped EMA9: $${this.ema9.toFixed(2)}`);
            console.log(`📈 Bootstrapped EMA19: $${this.ema19.toFixed(2)}`);
            console.log(`📊 Spread: $${Math.abs(this.ema9 - this.ema19).toFixed(2)}`);
            
            this.isBootstrapped = true;
            
            return {
                success: true,
                ema9: this.ema9,
                ema19: this.ema19,
                spread: Math.abs(this.ema9 - this.ema19),
                barsUsed: historicalData.length,
                latestPrice: historicalData[historicalData.length - 1].close,
                contractId: contractId,
                bootstrapTime: new Date().toISOString()
            };
            
        } catch (error) {
            console.error('❌ EMA bootstrap failed:', error.message);
            return {
                success: false,
                error: error.message,
                ema9: null,
                ema19: null
            };
        }
    }
    
    async fetchHistoricalData(contractId) {
        console.log('📊 Fetching historical data through distributed module...');
        
        try {
            // Use EMA bootstrap specific method from historical data module
            const bars = await this.historicalDataModule.fetchEmaBootstrapData(
                contractId, 
                19, // EMA19 period
                {
                    unit: 2, // Minutes
                    unitNumber: 1,
                    multiplier: Math.max(3, Math.ceil(this.config.targetBars / 19)) // Ensure enough data
                }
            );
            
            if (bars && bars.length > 0) {
                console.log(`✅ Got ${bars.length} bars for EMA bootstrap`);
                
                // Convert to expected format if needed
                const formattedBars = bars.map(bar => ({
                    timestamp: bar.t || bar.timestamp,
                    open: parseFloat(bar.o || bar.open),
                    high: parseFloat(bar.h || bar.high),
                    low: parseFloat(bar.l || bar.low),
                    close: parseFloat(bar.c || bar.close),
                    volume: parseInt(bar.v || bar.volume) || 0
                }));
                
                // Sort by timestamp (oldest first)
                const sortedBars = formattedBars.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
                
                console.log(`📊 Data range: ${new Date(sortedBars[0].timestamp).toLocaleString()} to ${new Date(sortedBars[sortedBars.length - 1].timestamp).toLocaleString()}`);
                
                this.historicalBars = sortedBars;
                return sortedBars;
            } else {
                throw new Error('No bars returned from historical data module');
            }
            
        } catch (error) {
            console.log(`❌ EMA bootstrap data fetch failed: ${error.message}`);
            
            // Fallback: Try regular historical data with fallback
            console.log('🔄 Attempting fallback to general historical data...');
            
            try {
                const fallbackResult = await this.historicalDataModule.fetchBarsWithFallback(contractId, {
                    targetBars: this.config.targetBars,
                    daysBack: this.config.daysBack,
                    preferredUnit: 2 // Minutes
                });
                
                if (fallbackResult && fallbackResult.bars && fallbackResult.bars.length > 0) {
                    console.log(`✅ Fallback successful: Got ${fallbackResult.bars.length} ${fallbackResult.unitName} bars`);
                    
                    // Convert to expected format
                    const formattedBars = fallbackResult.bars.map(bar => ({
                        timestamp: bar.t || bar.timestamp,
                        open: parseFloat(bar.o || bar.open),
                        high: parseFloat(bar.h || bar.high),
                        low: parseFloat(bar.l || bar.low),
                        close: parseFloat(bar.c || bar.close),
                        volume: parseInt(bar.v || bar.volume) || 0
                    }));
                    
                    // Sort by timestamp (oldest first)
                    const sortedBars = formattedBars.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
                    
                    this.historicalBars = sortedBars;
                    return sortedBars;
                } else {
                    throw new Error('Fallback also failed to retrieve data');
                }
                
            } catch (fallbackError) {
                console.error(`❌ Fallback failed: ${fallbackError.message}`);
                throw new Error(`Both primary and fallback historical data fetch failed: ${error.message}`);
            }
        }
    }
    
    calculateEMAs(bars) {
        console.log(`🧮 Calculating EMAs from ${bars.length} bars...`);
        
        if (bars.length < this.config.minBarsForBootstrap) {
            console.log(`❌ Insufficient bars: ${bars.length} < ${this.config.minBarsForBootstrap}`);
            return { success: false, error: 'Insufficient historical data' };
        }
        
        // Extract closing prices
        const prices = bars.map(bar => bar.close);
        console.log(`📊 Price range: $${Math.min(...prices).toFixed(2)} - $${Math.max(...prices).toFixed(2)}`);
        
        // Initialize EMAs with first price
        this.ema9 = prices[0];
        this.ema19 = prices[0];
        
        const alpha9 = 2 / (9 + 1);
        const alpha19 = 2 / (19 + 1);
        
        // Calculate EMAs
        for (let i = 1; i < prices.length; i++) {
            const price = prices[i];
            
            this.ema9 = (alpha9 * price) + ((1 - alpha9) * this.ema9);
            this.ema19 = (alpha19 * price) + ((1 - alpha19) * this.ema19);
            
            // Log progress every 10 bars
            if ((i + 1) % 10 === 0 || i === prices.length - 1) {
                const timeStr = new Date(bars[i].timestamp).toLocaleTimeString();
                console.log(`   Bar ${i + 1}: ${timeStr} - Price=$${price.toFixed(2)} EMA9=$${this.ema9.toFixed(2)} EMA19=$${this.ema19.toFixed(2)}`);
            }
        }
        
        const spread = Math.abs(this.ema9 - this.ema19);
        
        console.log(`\n✅ EMA Calculation Complete:`);
        console.log(`   📈 Final EMA9: $${this.ema9.toFixed(2)}`);
        console.log(`   📈 Final EMA19: $${this.ema19.toFixed(2)}`);
        console.log(`   📊 Spread: $${spread.toFixed(2)}`);
        console.log(`   📊 Bars used: ${bars.length}`);
        
        if (spread > 0.5) {
            console.log(`   🎯 Excellent! EMAs well separated - ready for signal generation!`);
        } else {
            console.log(`   ⚠️  EMAs close together - signals may be less reliable`);
        }
        
        return { success: true, ema9: this.ema9, ema19: this.ema19, spread };
    }
    
    // Update EMAs with new live price (call this on each new price update)
    updateWithLivePrice(price) {
        if (!this.isBootstrapped || !price) return null;
        
        const alpha9 = 2 / (9 + 1);
        const alpha19 = 2 / (19 + 1);
        
        this.ema9 = (alpha9 * price) + ((1 - alpha9) * this.ema9);
        this.ema19 = (alpha19 * price) + ((1 - alpha19) * this.ema19);
        
        return {
            ema9: this.ema9,
            ema19: this.ema19,
            spread: Math.abs(this.ema9 - this.ema19),
            latestPrice: price
        };
    }
    
    // Get current EMA values
    getCurrentEMAs() {
        return {
            ema9: this.ema9,
            ema19: this.ema19,
            spread: this.ema9 && this.ema19 ? Math.abs(this.ema9 - this.ema19) : 0,
            isBootstrapped: this.isBootstrapped,
            barsUsed: this.historicalBars.length,
            ready: this.isReady()
        };
    }
    
    // Check if EMAs are ready for trading
    isReady() {
        return this.isBootstrapped && this.ema9 && this.ema19;
    }
    
    // Get historical bars for rolling window EMA calculation
    getHistoricalBars() {
        if (this.historicalBars.length === 0) {
            console.log('⚠️  No historical bars available for rolling window');
            return null;
        }
        
        return {
            success: true,
            bars: this.historicalBars,
            count: this.historicalBars.length,
            method: 'ROLLING_WINDOW_READY'
        };
    }
    
    // Get bootstrap status
    getStatus() {
        return {
            isBootstrapped: this.isBootstrapped,
            ema9: this.ema9,
            ema19: this.ema19,
            spread: this.ema9 && this.ema19 ? Math.abs(this.ema9 - this.ema19) : 0,
            barsUsed: this.historicalBars.length,
            ready: this.isReady()
        };
    }
}

module.exports = HistoricalEMABootstrap;