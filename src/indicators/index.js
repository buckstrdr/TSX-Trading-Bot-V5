// index.js - Technical Indicators Library Entry Point
// Exports all indicator calculators for TSX Trading Bot V4
// Using technicalindicators library v3.1.0 for enhanced accuracy

// Import all indicator calculators
const EMACalculator = require('./EMACalculator');
const SMACalculator = require('./SMACalculator');
const TEMACalculator = require('./TEMACalculator');
const ADXCalculator = require('./ADXCalculator');
const ATRCalculator = require('./ATRCalculator');
const VWAPCalculator = require('./VWAPCalculator');

// Technical Analysis Engine - Combines multiple indicators
class TechnicalAnalysisEngine {
    constructor() {
        this.indicators = {};
        this.initialized = false;
        this.updateCount = 0;
        this.debug = true;
        
        console.log('[Technical Analysis Engine] Initialized with all indicator calculators');
        console.log('[Technical Analysis Engine] Available indicators: EMA, SMA, TEMA, ADX, ATR, VWAP');
    }
    
    // Initialize all indicators with configuration
    async initializeIndicators(config = {}) {
        const defaultConfig = {
            ema: { fastPeriod: 9, slowPeriod: 19, candleInterval: 60, updateMode: 'CANDLE_BASED' },
            sma: { periods: [10, 20, 50, 200] },
            tema: { period: 9 },
            adx: { period: 14 },
            atr: { period: 14 },
            vwap: { timeframes: ['5min', '15min', '30min'] }
        };
        
        const finalConfig = { ...defaultConfig, ...config };
        
        try {
            // Initialize EMA Calculator
            this.indicators.ema = new EMACalculator(
                finalConfig.ema.candleInterval,
                finalConfig.ema.updateMode,
                finalConfig.ema.fastPeriod,
                finalConfig.ema.slowPeriod
            );
            
            // Initialize SMA Calculator
            this.indicators.sma = new SMACalculator(finalConfig.sma.periods);
            
            // Initialize TEMA Calculator
            this.indicators.tema = new TEMACalculator(finalConfig.tema.period);
            
            // Initialize ADX Calculator
            this.indicators.adx = new ADXCalculator(finalConfig.adx.period);
            
            // Initialize ATR Calculator
            this.indicators.atr = new ATRCalculator(finalConfig.atr.period);
            
            // Initialize VWAP Calculator
            this.indicators.vwap = new VWAPCalculator(finalConfig.vwap.timeframes);
            
            console.log('[Technical Analysis Engine] ✅ All indicators initialized successfully');
            console.log('[Technical Analysis Engine] Configuration:', JSON.stringify(finalConfig, null, 2));
            
            return true;
        } catch (error) {
            console.error('[Technical Analysis Engine] Failed to initialize indicators:', error.message);
            return false;
        }
    }
    
    // Initialize all indicators with historical data
    async initializeWithHistoricalData(historicalData) {
        if (!this.indicators.ema) {
            console.error('[Technical Analysis Engine] Indicators not initialized. Call initializeIndicators() first.');
            return false;
        }
        
        try {
            console.log('[Technical Analysis Engine] Initializing all indicators with historical data...');
            
            // Initialize each indicator with historical data
            const results = await Promise.all([
                this.indicators.ema.initializeWithHistorical(historicalData),
                this.indicators.sma.initializeWithHistorical(historicalData),
                this.indicators.tema.initializeWithHistorical(historicalData),
                this.indicators.adx.initializeWithHistorical(historicalData),
                this.indicators.atr.initializeWithHistorical(historicalData),
                this.indicators.vwap.initializeWithHistorical(historicalData)
            ]);
            
            const successCount = results.filter(r => r).length;
            
            if (successCount === results.length) {
                this.initialized = true;
                console.log('[Technical Analysis Engine] ✅ All indicators initialized with historical data');
                return true;
            } else {
                console.error(`[Technical Analysis Engine] Only ${successCount}/${results.length} indicators initialized successfully`);
                return false;
            }
        } catch (error) {
            console.error('[Technical Analysis Engine] Failed to initialize with historical data:', error.message);
            return false;
        }
    }
    
    // Update all indicators with new price data
    updateWithPrice(price, volume = 1000, timestamp = Date.now()) {
        if (!this.initialized) {
            return { updated: false, reason: 'not_initialized' };
        }
        
        const updates = {};
        let anyUpdated = false;
        
        try {
            // Update EMA
            const emaResult = this.indicators.ema.update(price, volume, timestamp);
            updates.ema = emaResult;
            if (emaResult.updated) anyUpdated = true;
            
            // Update SMA
            const smaResult = this.indicators.sma.update(price);
            updates.sma = smaResult;
            if (smaResult.updated) anyUpdated = true;
            
            // Update TEMA
            const temaResult = this.indicators.tema.update(price);
            updates.tema = temaResult;
            if (temaResult.updated) anyUpdated = true;
            
            // Update VWAP
            const vwapResult = this.indicators.vwap.addDataPoint(price, volume, timestamp);
            updates.vwap = vwapResult;
            if (vwapResult.updated) anyUpdated = true;
            
            if (anyUpdated) {
                this.updateCount++;
                
                // Log updates periodically
                if (this.debug && this.updateCount % 20 === 0) {
                    const time = new Date(timestamp).toLocaleTimeString();
                    console.log(`📊 [Technical Analysis Update ${this.updateCount}] @ ${time} Price: ${price.toFixed(2)}`);
                    this.logCurrentValues();
                }
            }
            
            return {
                updated: anyUpdated,
                updateCount: this.updateCount,
                updates,
                analysis: this.getComprehensiveAnalysis()
            };
        } catch (error) {
            console.error('[Technical Analysis Engine] Error updating indicators:', error.message);
            return { updated: false, reason: 'update_error', error: error.message };
        }
    }
    
    // Update all indicators with new candle data
    updateWithCandle(candle) {
        if (!this.initialized) {
            return { updated: false, reason: 'not_initialized' };
        }
        
        const updates = {};
        let anyUpdated = false;
        
        try {
            // Extract candle data
            const price = candle.c || candle.close || candle.Close;
            const volume = candle.v || candle.volume || candle.Volume || 1000;
            const timestamp = candle.timestamp || candle.time || candle.t || Date.now();
            
            if (!price || price <= 0) {
                return { updated: false, reason: 'invalid_candle_data' };
            }
            
            // Update price-based indicators
            const priceUpdate = this.updateWithPrice(price, volume, timestamp);
            updates.price_based = priceUpdate;
            if (priceUpdate.updated) anyUpdated = true;
            
            // Update candle-based indicators (ADX, ATR)
            const adxResult = this.indicators.adx.update(candle);
            updates.adx = adxResult;
            if (adxResult.updated) anyUpdated = true;
            
            const atrResult = this.indicators.atr.update(candle);
            updates.atr = atrResult;
            if (atrResult.updated) anyUpdated = true;
            
            return {
                updated: anyUpdated,
                updateCount: this.updateCount,
                updates,
                analysis: this.getComprehensiveAnalysis()
            };
        } catch (error) {
            console.error('[Technical Analysis Engine] Error updating with candle:', error.message);
            return { updated: false, reason: 'candle_update_error', error: error.message };
        }
    }
    
    // Get comprehensive analysis from all indicators
    getComprehensiveAnalysis() {
        if (!this.initialized) {
            return { status: 'not_initialized' };
        }
        
        const analysis = {
            timestamp: new Date().toISOString(),
            updateCount: this.updateCount,
            indicators: {},
            signals: {},
            summary: {}
        };
        
        try {
            // Get values from each indicator
            analysis.indicators.ema = this.indicators.ema.getEMAValues();
            analysis.indicators.sma = this.indicators.sma.getSMAValues();
            analysis.indicators.tema = this.indicators.tema.getTEMAValues();
            analysis.indicators.adx = this.indicators.adx.getADXValues();
            analysis.indicators.atr = this.indicators.atr.getATRValues();
            analysis.indicators.vwap = this.indicators.vwap.getVWAPValues();
            
            // Get signals from each indicator
            analysis.signals.ema = this.indicators.ema.getEMASignal();
            analysis.signals.sma = this.indicators.sma.getSMASignals();
            analysis.signals.tema = this.indicators.tema.getTEMASignals();
            analysis.signals.adx = this.indicators.adx.getADXSignals();
            analysis.signals.atr = this.indicators.atr.getATRSignals();
            analysis.signals.vwap = this.indicators.vwap.getVWAPSignals();
            
            // Generate summary analysis
            analysis.summary = this.generateSummaryAnalysis(analysis);
            
        } catch (error) {
            console.error('[Technical Analysis Engine] Error generating analysis:', error.message);
            analysis.error = error.message;
        }
        
        return analysis;
    }
    
    // Generate summary analysis combining all indicators
    generateSummaryAnalysis(analysis) {
        const summary = {
            trend: 'unknown',
            strength: 'unknown',
            volatility: 'unknown',
            momentum: 'unknown',
            signals: [],
            confidence: 0
        };
        
        try {
            // Analyze trend based on moving averages
            const emaSignal = analysis.signals.ema;
            const smaSignals = analysis.signals.sma;
            
            let bullishCount = 0;
            let bearishCount = 0;
            let totalSignals = 0;
            
            // EMA trend
            if (emaSignal === 'bullish') bullishCount++;
            else if (emaSignal === 'bearish') bearishCount++;
            totalSignals++;
            
            // SMA trends
            if (smaSignals && smaSignals.overall_trend) {
                if (smaSignals.overall_trend === 'bullish') bullishCount++;
                else if (smaSignals.overall_trend === 'bearish') bearishCount++;
                totalSignals++;
            }
            
            // TEMA trend
            if (analysis.signals.tema && analysis.signals.tema.trend) {
                if (analysis.signals.tema.trend.includes('bullish')) bullishCount++;
                else if (analysis.signals.tema.trend.includes('bearish')) bearishCount++;
                totalSignals++;
            }
            
            // Determine overall trend
            if (bullishCount > bearishCount && bullishCount / totalSignals > 0.6) {
                summary.trend = 'bullish';
            } else if (bearishCount > bullishCount && bearishCount / totalSignals > 0.6) {
                summary.trend = 'bearish';
            } else {
                summary.trend = 'neutral';
            }
            
            // Analyze strength using ADX
            if (analysis.signals.adx && analysis.signals.adx.trendStrength) {
                summary.strength = analysis.signals.adx.trendStrength;
            }
            
            // Analyze volatility using ATR
            if (analysis.signals.atr && analysis.signals.atr.level) {
                summary.volatility = analysis.signals.atr.level;
            }
            
            // Analyze momentum using TEMA
            if (analysis.signals.tema && analysis.signals.tema.trend) {
                summary.momentum = analysis.signals.tema.trend;
            }
            
            // Generate action signals
            if (summary.trend === 'bullish' && summary.strength !== 'weak') {
                summary.signals.push('potential_long_opportunity');
            }
            if (summary.trend === 'bearish' && summary.strength !== 'weak') {
                summary.signals.push('potential_short_opportunity');
            }
            if (summary.volatility === 'very_low') {
                summary.signals.push('low_volatility_breakout_watch');
            }
            if (summary.volatility === 'very_high') {
                summary.signals.push('high_volatility_caution');
            }
            
            // Calculate confidence score
            let confidence = 50; // Base confidence
            if (summary.strength === 'strong' || summary.strength === 'very_strong') confidence += 20;
            if (bullishCount / totalSignals > 0.7 || bearishCount / totalSignals > 0.7) confidence += 15;
            if (summary.volatility === 'moderate') confidence += 10;
            if (analysis.signals.adx && analysis.signals.adx.confidence) confidence += analysis.signals.adx.confidence * 0.15;
            
            summary.confidence = Math.min(100, Math.max(0, confidence));
            
        } catch (error) {
            console.error('[Technical Analysis Engine] Error in summary analysis:', error.message);
            summary.error = error.message;
        }
        
        return summary;
    }
    
    // Log current values of all indicators
    logCurrentValues() {
        if (!this.initialized) return;
        
        try {
            const ema = this.indicators.ema.getEMAValues();
            const sma = this.indicators.sma.getSMAValues();
            const tema = this.indicators.tema.getTEMAValues();
            const adx = this.indicators.adx.getADXValues();
            const atr = this.indicators.atr.getATRValues();
            
            console.log(`   EMA: Fast=${ema.emaFast?.toFixed(4) || 'null'} Slow=${ema.emaSlow?.toFixed(4) || 'null'} Signal=${this.indicators.ema.getEMASignal()}`);
            console.log(`   SMA: ${Object.keys(sma).filter(k => k.startsWith('20') || k.startsWith('50')).map(k => `${k}=${sma[k]?.toFixed(4) || 'null'}`).join(' ')}`);
            console.log(`   TEMA: ${tema.tema?.toFixed(4) || 'null'}`);
            console.log(`   ADX: ${adx.adx?.toFixed(2) || 'null'} DI+=${adx.plusDI?.toFixed(2) || 'null'} DI-=${adx.minusDI?.toFixed(2) || 'null'}`);
            console.log(`   ATR: ${atr.atr?.toFixed(4) || 'null'} (${atr.volatilityLevel || 'unknown'})`);
        } catch (error) {
            console.error('[Technical Analysis Engine] Error logging values:', error.message);
        }
    }
    
    // Get individual indicator
    getIndicator(name) {
        return this.indicators[name] || null;
    }
    
    // Get all indicators
    getAllIndicators() {
        return { ...this.indicators };
    }
    
    // Get engine status
    getStatus() {
        const status = {
            library: 'technicalindicators_v3.1.0_enhanced',
            initialized: this.initialized,
            updateCount: this.updateCount,
            debugEnabled: this.debug,
            indicatorsCount: Object.keys(this.indicators).length,
            availableIndicators: Object.keys(this.indicators)
        };
        
        // Add health check for each indicator
        if (this.initialized) {
            status.indicatorHealth = {};
            Object.keys(this.indicators).forEach(name => {
                if (this.indicators[name].performHealthCheck) {
                    status.indicatorHealth[name] = this.indicators[name].performHealthCheck();
                }
            });
        }
        
        return status;
    }
    
    // Perform comprehensive health check
    performHealthCheck() {
        const healthCheck = {
            healthy: true,
            issues: [],
            indicatorHealth: {}
        };
        
        if (!this.initialized) {
            healthCheck.healthy = false;
            healthCheck.issues.push('Engine not initialized');
        }
        
        // Check each indicator
        Object.keys(this.indicators).forEach(name => {
            if (this.indicators[name].performHealthCheck) {
                const indicatorHealth = this.indicators[name].performHealthCheck();
                healthCheck.indicatorHealth[name] = indicatorHealth;
                
                if (!indicatorHealth.healthy) {
                    healthCheck.healthy = false;
                    healthCheck.issues.push(`${name}: ${indicatorHealth.issues.join(', ')}`);
                }
            }
        });
        
        return healthCheck;
    }
    
    // Reset all indicators
    resetAll() {
        console.log('[Technical Analysis Engine] 🔄 Resetting all indicators...');
        
        Object.keys(this.indicators).forEach(name => {
            if (this.indicators[name].reset) {
                this.indicators[name].reset();
            }
        });
        
        this.initialized = false;
        this.updateCount = 0;
        
        console.log('[Technical Analysis Engine] ✅ All indicators reset');
    }
    
    // Toggle debugging for all indicators
    setDebug(enabled) {
        this.debug = enabled;
        
        Object.keys(this.indicators).forEach(name => {
            if (this.indicators[name].setDebug) {
                this.indicators[name].setDebug(enabled);
            }
        });
        
        console.log(`[Technical Analysis Engine] Debug mode: ${enabled ? 'ENABLED' : 'DISABLED'} for all indicators`);
    }
}

// Export individual calculators and the combined engine
module.exports = {
    // Individual calculators
    EMACalculator,
    SMACalculator,
    TEMACalculator,
    ADXCalculator,
    ATRCalculator,
    VWAPCalculator,
    
    // Combined engine
    TechnicalAnalysisEngine,
    
    // Convenience factory functions
    createEMA: (fastPeriod = 9, slowPeriod = 19, candleInterval = 60, updateMode = 'CANDLE_BASED') => 
        new EMACalculator(candleInterval, updateMode, fastPeriod, slowPeriod),
    
    createSMA: (periods = [10, 20, 50, 200]) => 
        new SMACalculator(periods),
    
    createTEMA: (period = 9) => 
        new TEMACalculator(period),
    
    createADX: (period = 14) => 
        new ADXCalculator(period),
    
    createATR: (period = 14) => 
        new ATRCalculator(period),
    
    createVWAP: (timeframes = ['5min', '15min', '30min']) => 
        new VWAPCalculator(timeframes),
    
    createTechnicalAnalysisEngine: (config) => {
        const engine = new TechnicalAnalysisEngine();
        if (config) {
            engine.initializeIndicators(config);
        }
        return engine;
    },
    
    // Library info
    version: '1.0.0',
    technicalIndicatorsVersion: '3.1.0',
    description: 'Enhanced Technical Indicators Library for TSX Trading Bot V4'
};