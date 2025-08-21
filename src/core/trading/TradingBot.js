/**
 * TradingBot - Core trading bot that bridges strategy and aggregator
 * 
 * This bot:
 * 1. Uses direct YAML file configuration (no ConfigurationManager)
 * 2. Integrates with existing RiskManager for risk controls
 * 3. Manages a single trading strategy instance
 * 4. Processes market data and generates signals
 * 5. Sends signals to aggregator (when connected) or logs for testing
 * 6. Provides comprehensive monitoring and debugging
 */

const EventEmitter = require('events');
// ConfigurationManager removed - using direct YAML file read/write only
const RiskManager = require('../aggregator/core/RiskManager');
const FileLogger = require('../../../shared/utils/FileLogger');
const AggregatorClient = require('./AggregatorClient');
const PnLModule = require('../pnl/PnLModule');

class TradingBot extends EventEmitter {
    constructor(botIdOrConfig = {}) {
        super();
        
        // Handle both botId string and config object
        if (typeof botIdOrConfig === 'string') {
            this.botId = botIdOrConfig;
            this.config = {};
        } else {
            this.botId = botIdOrConfig.botId || botIdOrConfig.id || `bot_${Date.now()}`;
            this.config = botIdOrConfig;
        }
        
        this.name = this.config.name || `TradingBot_${this.botId}`;
        
        // Core components - will be initialized
        this.riskManager = null;
        this.strategy = null;
        this.aggregatorClient = null;
        this.logger = null;
        
        // State management
        this.state = {
            status: 'INITIALIZING',
            startTime: new Date(),
            isReady: false,
            
            // Position tracking
            currentPosition: null,
            positionHistory: [],
            
            // Signal tracking
            lastSignal: null,
            signalsGenerated: 0,
            signalsExecuted: 0,
            signalsFailed: 0,
            
            // Market data
            lastPrice: null,
            lastVolume: null,
            lastTimestamp: null,
            marketDataCount: 0,
            
            // Trading statistics
            tradeCount: 0,
            winCount: 0,
            lossCount: 0,
            dailyPnL: 0,
            totalPnL: 0
        };
        
        // Market data simulation (for testing)
        this.marketDataSimulator = null;
        this.simulationInterval = null;
        
        // Runtime configuration (populated after config load)
        this.runtimeConfig = null;
    }
    
    /**
     * Initialize the trading bot
     */
    async initialize() {
        try {
            this.state.status = 'INITIALIZING';
            
            // Initialize configuration manager
            await this.initializeConfiguration();
            
            // Initialize logger with config
            this.initializeLogger();
            
            // Initialize risk manager
            await this.initializeRiskManager();
            
            // Initialize strategy
            await this.initializeStrategy();
            
            // Initialize aggregator connection (if enabled)
            if (this.runtimeConfig.aggregatorEnabled) {
                await this.initializeAggregator();
            }
            
            // Initialize market data source
            await this.initializeMarketData();
            
            this.state.status = 'READY';
            this.state.isReady = true;
            
            this.emit('ready', {
                botId: this.botId,
                strategy: this.runtimeConfig.strategyType,
                testMode: this.runtimeConfig.testMode
            });
            
            this.log('info', 'TradingBot initialized successfully', {
                botId: this.botId,
                strategy: this.strategy ? 'loaded' : 'failed',
                aggregator: this.aggregatorClient ? 'connected' : 'standalone',
                riskManager: this.riskManager ? 'active' : 'disabled'
            });
            
        } catch (error) {
            this.state.status = 'ERROR';
            this.handleError('initialization', error);
            throw error;
        }
    }
    
    /**
     * Initialize configuration from YAML file (passed from bot-launcher)
     */
    async initializeConfiguration() {
        try {
            // Direct config from bot-launcher YAML file is REQUIRED
            if (!this.config || !this.config.instrument || !this.config.strategy) {
                throw new Error(`Bot configuration is missing required fields. Ensure the YAML file contains 'instrument' and 'strategy' sections.`);
            }
            
            console.log('Using config provided directly from YAML file');
            const config = this.config;
            
            // Build runtime configuration by merging layers
            this.runtimeConfig = {
                // Bot identification
                botId: this.botId,
                name: this.name,
                enabled: config.enabled !== false,
                port: config.port,
                
                // Strategy configuration
                strategyType: this.mapStrategyType(config.strategy?.type || 'EMA_9_RETRACEMENT_SCALPING'),
                strategyConfig: this.buildStrategyConfig(config),
                
                // Instrument configuration
                instrument: config.instrument || 'MES',
                contractSpecs: config.tradingDefaults?.contractSpecs?.[config.instrument] || 
                              config.tradingDefaults?.contractSpecs?.MES,
                
                // Risk management (from config hierarchy)
                riskConfig: {
                    dollarRiskPerTrade: config.risk?.dollarRiskPerTrade || 
                                       config.tradingDefaults?.defaultRisk?.dollarRiskPerTrade || 200,
                    maxDailyLoss: config.risk?.maxDailyLoss || 
                                 config.tradingDefaults?.defaultRisk?.maxDailyLoss || 800,
                    maxDailyProfit: config.tradingDefaults?.defaultRisk?.maxDailyProfit || 600,
                    maxOpenPositions: config.tradingDefaults?.defaultRisk?.maxOpenPositions || 1,
                    maxConsecutiveLosses: config.risk?.maxConsecutiveLosses || 3
                },
                
                // Market data settings
                marketDataSource: this.config.marketDataSource || 'SIMULATED',
                tickIntervalMs: this.config.tickIntervalMs || 2000,
                
                // Trading hours
                tradingHours: config.tradingHours,
                
                // Aggregator integration
                aggregatorEnabled: config.aggregator?.enabled && !this.config.testMode,
                
                // Logging
                enableLogging: config.logging?.outputs?.file !== false,
                logLevel: config.logging?.level || 'INFO',
                
                // Test mode override
                testMode: this.config.testMode !== false
            };
            
            // No config change monitoring - bot must be restarted for config changes
            
            this.log('info', 'Configuration loaded successfully', {
                strategyType: this.runtimeConfig.strategyType,
                instrument: this.runtimeConfig.instrument,
                riskPerTrade: this.runtimeConfig.riskConfig.dollarRiskPerTrade,
                testMode: this.runtimeConfig.testMode
            });
            
        } catch (error) {
            console.error(`Failed to initialize configuration for bot ${this.botId}:`, error.message);
            throw error;
        }
    }
    
    /**
     * Get instrument multiplier (dollar per point) based on instrument
     */
    getInstrumentMultiplier(instrument) {
        // Extract symbol from full instrument name (e.g., "F.US.MGC" -> "MGC")
        const symbol = instrument?.includes('.') ? 
            instrument.split('.').pop() : 
            instrument;
            
        const multipliers = {
            'MGC': 10,    // Micro Gold
            'MES': 5,     // Micro E-mini S&P 500
            'MNQ': 2,     // Micro E-mini Nasdaq
            'M2K': 5,     // Micro E-mini Russell
            'MYM': 0.5,   // Micro E-mini Dow
            'MCL': 10,    // Micro Crude Oil
            'M6E': 12.5   // Micro EUR/USD
        };
        
        return multipliers[symbol] || 10; // Default to 10 if not found
    }
    
    /**
     * Map YAML strategy type to our internal strategy types
     */
    mapStrategyType(yamlStrategyType) {
        const strategyMap = {
            'EMA_CROSS': 'EMA_9_RETRACEMENT_SCALPING',
            'EMA_RETRACE': 'EMA_9_RETRACEMENT_SCALPING',
            'EMA_9_RETRACEMENT_SCALPING': 'EMA_9_RETRACEMENT_SCALPING',
            'ORB_RUBBER_BAND': 'ORB_RUBBER_BAND',
            'EMA_RETRACEMENT': 'EMA_9_RETRACEMENT_SCALPING',
            'TEST_TIME': 'TEST_TIME_STRATEGY',
            'TEST_TIME_STRATEGY': 'TEST_TIME_STRATEGY',
            'PDHPDLStrategy': 'PDH_PDL_COMPREHENSIVE'
        };
        
        return strategyMap[yamlStrategyType] || 'EMA_9_RETRACEMENT_SCALPING';
    }
    
    /**
     * Build strategy-specific configuration from YAML config
     */
    buildStrategyConfig(config) {
        const strategyType = this.mapStrategyType(config.strategy?.type);
        
        if (strategyType === 'EMA_9_RETRACEMENT_SCALPING') {
            return {
                mode: config.strategy?.parameters?.mode ?? 'STANDARD',
                periods: {
                    fast: config.strategy?.parameters?.fastEMA ?? config.strategy?.parameters?.emaFast ?? 9,
                    slow: config.strategy?.parameters?.slowEMA ?? config.strategy?.parameters?.emaSlow ?? 21
                },
                dollarRiskPerTrade: config.risk?.dollarRiskPerTrade ?? 200,
                riskRewardRatio: config.strategy?.parameters?.riskRewardRatio ?? config.exits?.profitTarget?.value ?? 2,
                maxRiskPoints: config.strategy?.parameters?.maxRiskPoints ?? 3.0,
                minEMASpread: config.strategy?.parameters?.minEMASpread ?? 0.5,
                candleIntervalSeconds: config.strategy?.parameters?.candleIntervalSeconds ?? 60,
                emaUpdateMode: config.strategy?.parameters?.emaUpdateMode ?? 'CANDLE_BASED',
                postWinCandleTimeout: config.strategy?.parameters?.postWinCandleTimeout ?? 180, // Now in seconds
                postLossCandleTimeout: config.strategy?.parameters?.postLossCandleTimeout ?? 600, // Now in seconds
                maxBarsSinceEMA: config.strategy?.parameters?.maxBarsSinceEMA ?? 15,
                stopLossOffset: config.strategy?.parameters?.stopLossOffset ?? 0,
                stopLossBuffer: config.strategy?.parameters?.stopLossBuffer ?? 2,
                // Calculate dollarPerPoint based on instrument
                dollarPerPoint: this.getInstrumentMultiplier(config.instrument)
            };
        } else if (strategyType === 'ORB_RUBBER_BAND') {
            return {
                openingRangeDuration: config.strategy?.parameters?.openingRangeDuration || 30,
                orbBreakoutPercent: config.strategy?.parameters?.orbBreakoutPercent || 10,
                orbMaxBreakoutPercent: config.strategy?.parameters?.orbMaxBreakoutPercent || 30,
                orbVolumeThreshold: config.strategy?.parameters?.orbVolumeThreshold || 120,
                candleIntervalMinutes: config.strategy?.parameters?.candleIntervalMinutes || 5,
                rubberBandCandleWindow: config.strategy?.parameters?.rubberBandCandleWindow || 3,
                rubberBandReversalPercent: config.strategy?.parameters?.rubberBandReversalPercent || 50,
                rubberBandVolumeThreshold: config.strategy?.parameters?.rubberBandVolumeThreshold || 150,
                reverseOnORReEntry: config.strategy?.parameters?.reverseOnORReEntry !== false,
                volumePeriod: config.strategy?.parameters?.volumePeriod || 20,
                dollarRiskPerTrade: config.risk?.dollarRiskPerTrade || 200,
                riskRewardRatio: config.strategy?.parameters?.riskRewardRatio || config.exits?.profitTarget?.value || 2,
                maxRiskPoints: config.strategy?.parameters?.maxRiskPoints || 3.0,
                signalCooldownMs: config.strategy?.parameters?.signalCooldownMs || 300000,
                stopLossORPercent: config.strategy?.parameters?.stopLossORPercent || 100,
                stopLossBufferTicks: config.strategy?.parameters?.stopLossBufferTicks || 2,
                // Position management
                oneTradeAtTime: config.strategy?.parameters?.oneTradeAtTime !== false,
                maxTradeDurationMinutes: config.strategy?.parameters?.maxTradeDurationMinutes || 480,
                // Session config
                londonOpenTime: config.strategy?.parameters?.londonOpenTime || '02:00',
                nyOpenTime: config.strategy?.parameters?.nyOpenTime || '09:30',
                activeSession: config.strategy?.parameters?.activeSession || 'BOTH',
                // Calculate dollarPerPoint based on instrument
                dollarPerPoint: this.getInstrumentMultiplier(config.instrument)
            };
        } else if (strategyType === 'TEST_TIME_STRATEGY') {
            return {
                // Test strategy timing parameters
                intervalMinutes: config.strategy?.parameters?.intervalMinutes || 5,
                tradeDurationMinutes: config.strategy?.parameters?.tradeDurationMinutes || 3,
                candleLookbackMinutes: config.strategy?.parameters?.candleLookbackMinutes || 1,
                
                // Risk configuration
                dollarRiskPerTrade: config.risk?.dollarRiskPerTrade || 50,
                maxRiskPoints: config.strategy?.parameters?.maxRiskPoints || 3.0,
                riskRewardRatio: 1, // Fixed 1:1 for testing
                
                // Position sizing
                positionSize: config.strategy?.parameters?.positionSize || 1,
                
                // Calculate dollarPerPoint based on instrument
                dollarPerPoint: this.getInstrumentMultiplier(config.instrument),
                
                // Logging
                enableLogging: true
            };
        } else if (strategyType === 'PDH_PDL_COMPREHENSIVE') {
            return {
                // Risk Management (handled by bot framework)
                dollarRiskPerTrade: config.strategy?.dollarRiskPerTrade ?? 100,
                dollarPerPoint: config.strategy?.dollarPerPoint ?? this.getInstrumentMultiplier(config.instrument),
                maxRiskPoints: config.strategy?.maxRiskPoints ?? 3.0,
                riskRewardRatio: config.strategy?.riskRewardRatio ?? 2.0,
                
                // PDH/PDL Specific Parameters
                volumeConfirmationMultiplier: config.strategy?.volumeConfirmationMultiplier ?? 1.5,
                breakoutBufferTicks: config.strategy?.breakoutBufferTicks ?? 2,
                
                // MGC-specific stop configurations
                mgcBreakoutStopTicks: config.strategy?.mgcBreakoutStopTicks ?? 10,
                mgcFadeStopTicks: config.strategy?.mgcFadeStopTicks ?? 8,
                mgcLiquiditySweepStopTicks: config.strategy?.mgcLiquiditySweepStopTicks ?? 6,
                
                // Strategy Selection
                enableBreakoutStrategy: config.strategy?.enableBreakoutStrategy !== false,
                enableFadeStrategy: config.strategy?.enableFadeStrategy !== false,
                enableLiquiditySweepStrategy: config.strategy?.enableLiquiditySweepStrategy !== false,
                
                // Time-Based Settings
                enableTimeDecay: config.strategy?.enableTimeDecay !== false,
                stopNewSignalsAt: config.strategy?.stopNewSignalsAt ?? "20:55",
                
                // Market Structure Filters
                requireVwapAlignment: config.strategy?.requireVwapAlignment !== false,
                minVolumeRatio: config.strategy?.minVolumeRatio ?? 1.5,
                enableMarketStructureFilter: config.strategy?.enableMarketStructureFilter !== false,
                
                // Volume Profile Configuration
                enableVolumeProfile: config.strategy?.enableVolumeProfile !== false,
                volumeProfileBins: config.strategy?.volumeProfileBins ?? 50,
                pocThreshold: config.strategy?.pocThreshold ?? 0.70,
                hvnThreshold: config.strategy?.hvnThreshold ?? 1.5,
                lvnThreshold: config.strategy?.lvnThreshold ?? 0.5,
                
                // Cumulative Delta Configuration
                enableCumulativeDelta: config.strategy?.enableCumulativeDelta !== false,
                cumulativeDeltaThreshold: config.strategy?.cumulativeDeltaThreshold ?? 0,
                cumulativeDeltaPeriod: config.strategy?.cumulativeDeltaPeriod ?? 20,
                
                // ADX Configuration
                adxPeriod: config.strategy?.adxPeriod ?? 14,
                adxTrendingThreshold: config.strategy?.adxTrendingThreshold ?? 25,
                adxRangingThreshold: config.strategy?.adxRangingThreshold ?? 20,
                
                // Liquidity Sweep Configuration
                enableLiquiditySweeps: config.strategy?.enableLiquiditySweeps !== false,
                liquiditySweepPenetrationTicks: config.strategy?.liquiditySweepPenetrationTicks ?? 3,
                liquiditySweepReversalTicks: config.strategy?.liquiditySweepReversalTicks ?? 5,
                liquiditySweepMaxBars: config.strategy?.liquiditySweepMaxBars ?? 3,
                
                // Time-Based Optimization
                enableTimeBasedOptimization: config.strategy?.enableTimeBasedOptimization !== false,
                
                // Contract Specifications
                tickSize: config.strategy?.tickSize ?? 0.1,
                candlePeriodMs: config.strategy?.candlePeriodMs ?? 300000,
                
                // Signal Quality Settings
                signalCooldownMs: config.strategy?.signalCooldownMs ?? 300000,
                minSignalConfidence: config.strategy?.minSignalConfidence ?? "MEDIUM",
                maxSignalsPerDay: config.strategy?.maxSignalsPerDay ?? 6,
                maxCandleHistory: config.strategy?.maxCandleHistory ?? 200,
                indicatorLookback: config.strategy?.indicatorLookback ?? 50
            };
        }
        
        return {};
    }
    
    /**
     * Initialize logger with configuration
     */
    initializeLogger() {
        this.logger = new FileLogger(`TradingBot_${this.botId}`, 'logs');
        
        this.log('info', `TradingBot ${this.name} configuration loaded`, {
            botId: this.botId,
            instrument: this.runtimeConfig.instrument,
            strategyType: this.runtimeConfig.strategyType,
            testMode: this.runtimeConfig.testMode,
            enabled: this.runtimeConfig.enabled
        });
    }
    
    /**
     * Initialize risk manager with configuration
     */
    async initializeRiskManager() {
        try {
            // Get risk configuration from runtime config
            const riskConfig = {
                ...this.runtimeConfig.riskConfig,
                // Map to RiskManager expected parameters
                maxDailyLoss: this.runtimeConfig.riskConfig.maxDailyLoss,
                maxDailyProfit: this.runtimeConfig.riskConfig.maxDailyProfit,
                maxOpenPositions: this.runtimeConfig.riskConfig.maxOpenPositions,
                maxOrderSize: 10, // From global config
                minOrderSize: 1,
                allowedTradingHours: this.runtimeConfig.tradingHours?.enabled ? 
                    (this.runtimeConfig.tradingHours?.sessions?.[0] ? {
                        start: this.runtimeConfig.tradingHours.sessions[0].start,
                        end: this.runtimeConfig.tradingHours.sessions[0].end
                    } : { start: '09:30', end: '16:00' }) : null
            };
            
            this.riskManager = new RiskManager(riskConfig);
            
            this.log('info', 'Risk manager initialized', {
                maxDailyLoss: riskConfig.maxDailyLoss,
                maxDailyProfit: riskConfig.maxDailyProfit,
                maxOpenPositions: riskConfig.maxOpenPositions,
                dollarRiskPerTrade: riskConfig.dollarRiskPerTrade
            });
            
        } catch (error) {
            this.log('error', 'Failed to initialize risk manager', { error: error.message });
            throw error;
        }
    }
    
    /**
     * Initialize strategy based on configuration
     */
    async initializeStrategy() {
        const strategyType = this.runtimeConfig.strategyType;
        
        try {
            let StrategyClass;
            
            // Load strategy class
            if (strategyType === 'EMA_9_RETRACEMENT_SCALPING') {
                const EMAStrategy = require('../../strategies/ema/emaStrategy');
                StrategyClass = EMAStrategy;
            } else if (strategyType === 'ORB_RUBBER_BAND') {
                const ORBStrategy = require('../../strategies/orb-rubber-band/ORBRubberBandStrategy');
                StrategyClass = ORBStrategy;
            } else if (strategyType === 'TEST_TIME_STRATEGY') {
                const TestTimeStrategy = require('../../strategies/test/testTimeStrategy');
                StrategyClass = TestTimeStrategy;
            } else if (strategyType === 'PDH_PDL_COMPREHENSIVE') {
                const PDHPDLStrategy = require('../../strategies/PDHPDLStrategy-Comprehensive');
                StrategyClass = PDHPDLStrategy;
            } else {
                throw new Error(`Unknown strategy type: ${strategyType}`);
            }
            
            // Create strategy instance with bot reference
            this.strategy = new StrategyClass(this.runtimeConfig.strategyConfig, this);
            
            // Set up strategy event handlers
            this.setupStrategyEventHandlers();
            
            this.log('info', `Strategy ${strategyType} loaded successfully`, {
                config: this.runtimeConfig.strategyConfig
            });
            
        } catch (error) {
            this.log('error', 'Failed to initialize strategy', {
                strategyType,
                error: error.message
            });
            throw error;
        }
    }
    
    /**
     * Set up strategy event handlers
     */
    setupStrategyEventHandlers() {
        // Strategy events would be handled here if strategies emit them
        // For now, we'll handle signals through processMarketData return values
    }
    
    /**
     * Set up aggregator event handlers
     */
    setupAggregatorEventHandlers() {
        if (!this.aggregatorClient) return;
        
        // Order accepted by aggregator
        this.aggregatorClient.on('orderAccepted', (event) => {
            this.log('info', 'Order accepted by aggregator', {
                orderId: event.orderId,
                aggregatorOrderId: event.aggregatorOrderId,
                queueId: event.queueId
            });
            this.state.signalsExecuted++;
        });
        
        // Order rejected by aggregator
        this.aggregatorClient.on('orderRejected', (event) => {
            this.log('warn', 'Order rejected by aggregator', {
                orderId: event.orderId,
                reason: event.reason,
                violations: event.violations
            });
            this.state.signalsFailed++;
        });
        
        // Order filled
        this.aggregatorClient.on('orderFilled', (fill) => {
            this.log('info', 'Order filled', {
                orderId: fill.orderId,
                fillPrice: fill.fillPrice,
                quantity: fill.quantity
            });
            this.handleOrderFilled(fill);
        });
        
        // Position updates
        this.aggregatorClient.on('positionUpdate', (update) => {
            this.handlePositionUpdate(update);
        });
        
        // Aggregator disconnected
        this.aggregatorClient.on('disconnected', (event) => {
            this.log('warn', 'Aggregator disconnected', { reason: event.reason });
        });
        
        // Aggregator errors
        this.aggregatorClient.on('error', (event) => {
            this.log('error', 'Aggregator error', event);
        });
    }
    
    /**
     * Initialize aggregator connection
     */
    async initializeAggregator() {
        if (!this.config.testMode) {
            try {
                // Get aggregator config from runtime config
                const aggregatorConfig = {
                    botId: this.botId,
                    accountId: this.config.accountId || this.runtimeConfig.accountId || 'default',
                    redisConfig: this.config.aggregator?.redisConfig || { host: 'localhost', port: 6379 },
                    connectionManagerUrl: this.config.aggregator?.connectionManagerUrl || 'http://localhost:7500',
                    aggregatorUrl: this.config.aggregator?.aggregatorUrl || 'http://localhost:7700',
                    enableLogging: this.runtimeConfig.enableLogging
                };
                
                this.aggregatorClient = new AggregatorClient(aggregatorConfig);
                
                // Set up aggregator event handlers
                this.setupAggregatorEventHandlers();
                
                // Connect to aggregator
                await this.aggregatorClient.connect();
                
                this.log('info', 'Aggregator client connected successfully');
                
            } catch (error) {
                this.log('error', 'Failed to initialize aggregator connection', { error: error.message });
                // Don't throw - allow bot to run without aggregator
                this.aggregatorClient = null;
            }
        } else {
            this.log('info', 'Test mode: Aggregator connection skipped');
        }
    }
    
    /**
     * Initialize market data source
     */
    async initializeMarketData() {
        if (this.runtimeConfig.marketDataSource === 'SIMULATED') {
            this.initializeSimulatedMarketData();
        } else {
            // Initialize live market data connection through aggregator
            this.log('info', 'Initializing live market data connection', {
                instrument: this.runtimeConfig.instrument,
                aggregatorEnabled: this.runtimeConfig.aggregatorEnabled
            });
            
            if (this.aggregatorClient) {
                // Subscribe to live market data through aggregator
                this.subscribeToLiveMarketData();
            } else {
                this.log('warn', 'No aggregator client available for live market data');
            }
        }
    }
    
    /**
     * Initialize simulated market data for testing
     */
    initializeSimulatedMarketData() {
        // Base prices for different instruments
        const basePrices = {
            'MES': 4500,
            'MNQ': 15000,
            'MGC': 1800,
            'MCL': 75,
            'M2K': 2000,
            'MYM': 35000
        };
        
        // Extract instrument symbol from full contract name
        const instrumentSymbol = this.runtimeConfig.instrument.includes('.') ? 
            this.runtimeConfig.instrument.split('.')[4] : // CON.F.US.MES.U25 -> MES
            this.runtimeConfig.instrument; // MES -> MES
            
        let currentPrice = basePrices[instrumentSymbol] || 100;
        let trend = Math.random() > 0.5 ? 1 : -1; // Initial trend direction
        let trendCounter = 0;
        const trendDuration = 10 + Math.random() * 20; // 10-30 ticks per trend
        
        this.marketDataSimulator = {
            currentPrice,
            trend,
            trendCounter,
            trendDuration,
            
            generateNextTick: () => {
                // Change trend occasionally
                if (this.marketDataSimulator.trendCounter >= this.marketDataSimulator.trendDuration) {
                    this.marketDataSimulator.trend = Math.random() > 0.5 ? 1 : -1;
                    this.marketDataSimulator.trendCounter = 0;
                    this.marketDataSimulator.trendDuration = 10 + Math.random() * 20;
                }
                
                // Generate price movement with trend bias
                const randomMove = (Math.random() - 0.5) * 2; // -1 to 1
                const trendMove = this.marketDataSimulator.trend * 0.3; // Trend bias
                const totalMove = (randomMove + trendMove) * 0.5; // Scale movement
                
                this.marketDataSimulator.currentPrice += totalMove;
                this.marketDataSimulator.trendCounter++;
                
                // Generate volume (random between 500-2000)
                const volume = 500 + Math.random() * 1500;
                
                return {
                    price: this.marketDataSimulator.currentPrice,
                    volume: Math.round(volume),
                    timestamp: new Date()
                };
            }
        };
        
        this.log('info', 'Simulated market data initialized', {
            instrument: this.runtimeConfig.instrument,
            instrumentSymbol: instrumentSymbol,
            startPrice: currentPrice,
            tickInterval: this.runtimeConfig.tickIntervalMs
        });
    }
    
    /**
     * Subscribe to live market data through aggregator
     */
    subscribeToLiveMarketData() {
        this.log('info', 'Live trading mode - subscribing to market data feed', {
            instrument: this.runtimeConfig.instrument,
            note: 'Market data will be received from Connection Manager via aggregator'
        });
        
        // Subscribe to market data events from aggregator client
        if (this.aggregatorClient) {
            this.aggregatorClient.on('marketData', (marketData) => {
                this.handleLiveMarketData(marketData);
            });
            this.log('info', 'Subscribed to live market data feed via aggregator');
        } else {
            this.log('warn', 'No aggregator client available for market data subscription');
        }
    }
    
    /**
     * Handle incoming live market data
     */
    handleLiveMarketData(marketData) {
        try {
            // Handle the flat market data structure from AggregatorClient
            if (marketData && marketData.type === 'MARKET_DATA') {
                // Only process data for our instrument (MGC matches CON.F.US.MGC.Z25)
                if (marketData.instrument && marketData.instrument.includes('MGC')) {
                    let price = null;
                    let volume = 1000; // default volume
                    let timestamp = marketData.timestamp ? new Date(marketData.timestamp) : new Date();
                    
                    // Extract price from the flat structure
                    if (marketData.last && !isNaN(marketData.last)) {
                        // Use the 'last' price (calculated from bid/ask or trade price)
                        price = marketData.last;
                    } else if (marketData.bid && marketData.ask) {
                        // Calculate mid price from bid/ask
                        price = (marketData.bid + marketData.ask) / 2;
                    } else if (marketData.bid && !isNaN(marketData.bid)) {
                        price = marketData.bid;
                    } else if (marketData.ask && !isNaN(marketData.ask)) {
                        price = marketData.ask;
                    }
                    
                    // Extract volume if available (from trade data)
                    if (marketData.size && !isNaN(marketData.size)) {
                        volume = marketData.size;
                    }
                    
                    // Process the live market data through the strategy ONLY if bot is running
                    if (price && !isNaN(price) && this.state.status === 'RUNNING') {
                        this.processMarketData(price, volume, timestamp);
                    } else if (price && !isNaN(price)) {
                        // Just update last price for monitoring, but don't process strategy signals
                        this.state.lastPrice = price;
                        this.state.lastVolume = volume;
                        this.state.lastTimestamp = timestamp;
                        this.state.marketDataCount++;
                        
                        // Log market data received for debugging
                        this.log('debug', 'Market data received', {
                            instrument: marketData.instrument,
                            price: price,
                            bid: marketData.bid,
                            ask: marketData.ask,
                            volume: volume,
                            status: this.state.status
                        });
                    }
                }
            } else {
                // Log unexpected market data structure for debugging
                // Only log unexpected data occasionally
                if (Math.random() < 0.01) {
                    this.log('warn', 'Unexpected market data structure sample', {
                        type: marketData ? marketData.type : 'undefined'
                    });
                }
            }
        } catch (error) {
            // Only log errors occasionally to prevent spam
            if (Math.random() < 0.1) {
                this.log('error', 'Market data processing error sample', {
                    error: error.message
                });
            }
        }
    }
    
    /**
     * Start the trading bot
     */
    async start() {
        if (!this.state.isReady) {
            throw new Error('Bot not ready. Call initialize() first.');
        }
        
        if (this.state.status === 'RUNNING') {
            this.log('warn', 'Bot already running');
            return;
        }
        
        this.state.status = 'RUNNING';
        
        // Start market data simulation if enabled
        if (this.runtimeConfig.marketDataSource === 'SIMULATED') {
            this.startSimulatedMarketData();
        }
        
        this.emit('started', { botId: this.botId });
        this.log('info', 'TradingBot started');
    }
    
    /**
     * Start simulated market data feed
     */
    startSimulatedMarketData() {
        if (this.simulationInterval) {
            clearInterval(this.simulationInterval);
        }
        
        this.simulationInterval = setInterval(() => {
            if (this.state.status === 'RUNNING' && !this.config.emergencyStop) {
                const tick = this.marketDataSimulator.generateNextTick();
                this.processMarketData(tick.price, tick.volume, tick.timestamp);
            }
        }, this.runtimeConfig.tickIntervalMs);
        
        this.log('info', 'Simulated market data feed started');
    }
    
    /**
     * Process incoming market data
     */
    async processMarketData(price, volume, timestamp) {
        try {
            // Update state
            this.state.lastPrice = price;
            this.state.lastVolume = volume;
            this.state.lastTimestamp = timestamp;
            this.state.marketDataCount++;
            
            // Emergency stop check
            if (this.config.emergencyStop) {
                return;
            }
            
            // Daily loss limit check
            if (this.state.dailyPnL <= -Math.abs(this.runtimeConfig.riskConfig.maxDailyLoss)) {
                this.log('warn', 'Daily loss limit reached, stopping trading', {
                    dailyPnL: this.state.dailyPnL,
                    limit: this.runtimeConfig.riskConfig.maxDailyLoss
                });
                this.config.emergencyStop = true;
                return;
            }
            
            // Process through strategy
            if (this.strategy) {
                const result = this.strategy.processMarketData(price, volume, timestamp);
                
                if (result && result.signal) {
                    await this.handleSignal(result.signal, result);
                }
                
                // Log periodic updates (every 100 ticks in test mode)
                if (this.runtimeConfig.testMode && this.state.marketDataCount % 100 === 0) {
                    this.logPeriodicUpdate(result);
                }
            }
            
        } catch (error) {
            this.handleError('market_data_processing', error);
        }
    }
    
    /**
     * Handle trading signals from strategy
     */
    async handleSignal(signal, context) {
        try {
            this.state.lastSignal = signal;
            this.state.signalsGenerated++;
            
            this.log('info', `Signal generated: ${signal.direction} ${signal.strategyName}`, {
                price: signal.entryPrice,
                stopLoss: signal.stopLoss,
                takeProfit: signal.takeProfit,
                positionSize: signal.positionSize,
                dollarRisk: signal.dollarRisk,
                confidence: signal.confidence,
                DEBUG_direction: signal.direction,
                DEBUG_isClosePosition: signal.direction === 'CLOSE_POSITION'
            });
            
            // Handle CLOSE_POSITION signals differently (no risk validation needed)
            if (signal.direction === 'CLOSE_POSITION') {
                this.log('info', 'Processing CLOSE_POSITION signal', {
                    instrument: signal.instrument,
                    closeType: signal.closeType || 'full',
                    reason: signal.reason
                });
                
                // Send directly to aggregator or simulate execution
                if (this.runtimeConfig.aggregatorEnabled && this.aggregatorClient) {
                    await this.sendSignalToAggregator(signal, null);
                } else {
                    await this.simulateClosePosition(signal);
                }
                return;
            }
            
            // Convert signal to order format for risk validation (regular trades only)
            const order = this.convertSignalToOrder(signal);
            
            // Risk validation using existing RiskManager
            const riskValidation = await this.riskManager.validateOrder(order);
            
            if (!riskValidation.valid) {
                this.log('warn', 'Signal blocked by risk manager', {
                    orderId: order.id,
                    violations: riskValidation.violations,
                    riskMetrics: riskValidation.riskMetrics
                });
                this.state.signalsFailed++;
                return;
            }
            
            // Send to aggregator or simulate execution
            if (this.runtimeConfig.aggregatorEnabled && this.aggregatorClient) {
                await this.sendSignalToAggregator(signal, order);
            } else {
                await this.simulateSignalExecution(signal, order);
            }
            
        } catch (error) {
            this.state.signalsFailed++;
            this.handleError('signal_handling', error);
        }
    }
    
    /**
     * Convert strategy signal to order format for risk validation
     */
    convertSignalToOrder(signal) {
        return {
            id: `${this.botId}_${Date.now()}`,
            source: this.botId,
            instrument: this.runtimeConfig.instrument,
            action: signal.direction, // BUY/SELL
            quantity: signal.positionSize,
            type: 'MARKET',
            price: signal.entryPrice,
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
            accountId: this.runtimeConfig.accountId || 'default',
            urgent: false,
            metadata: {
                strategyName: signal.strategyName,
                confidence: signal.confidence,
                reason: signal.reason,
                botId: this.botId
            },
            timestamp: new Date()
        };
    }
    
    /**
     * Send signal to aggregator
     */
    async sendSignalToAggregator(signal, order) {
        if (!this.aggregatorClient) {
            this.log('warn', 'No aggregator client available, simulating execution');
            await this.simulateSignalExecution(signal, order);
            return;
        }
        
        try {
            // Submit order to aggregator
            const result = await this.aggregatorClient.submitOrder(signal);
            
            this.log('info', 'Signal submitted to aggregator', {
                orderId: result.orderId,
                success: result.success,
                aggregatorOrderId: result.aggregatorOrderId,
                queueId: result.queueId
            });
            
            // The aggregator will handle the rest via events
            
        } catch (error) {
            this.log('error', 'Failed to submit signal to aggregator', {
                error: error.message,
                signal: signal
            });
            this.state.signalsFailed++;
            
            // Fall back to simulation if aggregator fails
            if (this.runtimeConfig.testMode) {
                await this.simulateSignalExecution(signal, order);
            }
        }
    }
    
    /**
     * Simulate position closure for testing
     */
     async simulateClosePosition(signal) {
        console.log('[SIMULATE CLOSE POSITION] Called with signal:', signal);
        console.log('[SIMULATE CLOSE POSITION] Current bot position:', this.state.currentPosition);
        console.log('[SIMULATE CLOSE POSITION] Strategy position:', this.strategy?.state?.currentPosition);
        
        if (this.state.currentPosition && this.state.currentPosition.status === 'OPEN') {
            const currentPrice = this.state.lastPrice;
            this.closePosition(this.state.currentPosition, currentPrice, 'STRATEGY_CLOSE');
            
            this.log('info', 'Simulated position closed by strategy', {
                positionId: this.state.currentPosition.id,
                closePrice: currentPrice,
                reason: signal.reason
            });
        } else {
            this.log('warn', 'No open position to close', {
                signal: signal.direction,
                reason: signal.reason,
                botCurrentPosition: this.state.currentPosition,
                strategyCurrentPosition: this.strategy?.state?.currentPosition
            });
        }
    }

    /**
     * Simulate signal execution for testing
     */
    async simulateSignalExecution(signal) {
        // Create simulated position
        const position = {
            id: `pos_${Date.now()}`,
            signalId: signal.id || `sig_${Date.now()}`,
            instrument: this.runtimeConfig.instrument,
            direction: signal.direction,
            entryPrice: signal.entryPrice,
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
            positionSize: signal.positionSize,
            openTime: new Date(),
            status: 'OPEN',
            unrealizedPnL: 0
        };
        
        this.state.currentPosition = position;
        this.state.signalsExecuted++;
        this.state.tradeCount++;
        
        this.log('info', 'Simulated position opened', {
            positionId: position.id,
            direction: position.direction,
            size: position.positionSize,
            entry: position.entryPrice
        });
        
        this.emit('positionOpened', { position, signal });
        
        // Schedule position monitoring
        this.monitorPosition(position);
    }
    
    /**
     * Monitor open position for stop loss / take profit
     */
    monitorPosition(position) {
        const monitorInterval = setInterval(() => {
            if (!this.state.currentPosition || this.state.currentPosition.id !== position.id) {
                clearInterval(monitorInterval);
                return;
            }
            
            const currentPrice = this.state.lastPrice;
            if (!currentPrice) return;
            
            // Calculate unrealized P&L (includes $1.24 round-trip commission)
            let unrealizedPnL = 0;
            if (position.direction === 'LONG') {
                unrealizedPnL = ((currentPrice - position.entryPrice) * position.positionSize * 10) - 1.24; // $10 per point minus commission
            } else {
                unrealizedPnL = ((position.entryPrice - currentPrice) * position.positionSize * 10) - 1.24; // $10 per point minus commission
            }
            
            position.unrealizedPnL = unrealizedPnL;
            
            // Check stop loss
            let shouldClose = false;
            let closeReason = '';
            let closePrice = currentPrice;
            
            if (position.direction === 'LONG') {
                if (currentPrice <= position.stopLoss) {
                    shouldClose = true;
                    closeReason = 'STOP_LOSS';
                    closePrice = position.stopLoss;
                } else if (currentPrice >= position.takeProfit) {
                    shouldClose = true;
                    closeReason = 'TAKE_PROFIT';
                    closePrice = position.takeProfit;
                }
            } else { // SHORT
                if (currentPrice >= position.stopLoss) {
                    shouldClose = true;
                    closeReason = 'STOP_LOSS';
                    closePrice = position.stopLoss;
                } else if (currentPrice <= position.takeProfit) {
                    shouldClose = true;
                    closeReason = 'TAKE_PROFIT';
                    closePrice = position.takeProfit;
                }
            }
            
            if (shouldClose) {
                this.closePosition(position, closePrice, closeReason);
                clearInterval(monitorInterval);
            }
            
        }, 1000); // Check every second
    }
    
    /**
     * Close position
     */
    closePosition(position, closePrice, reason) {
        // Calculate realized P&L (includes $1.24 round-trip commission)
        let realizedPnL = 0;
        if (position.direction === 'LONG') {
            realizedPnL = ((closePrice - position.entryPrice) * position.positionSize * 10) - 1.24; // $10 per point minus commission
        } else {
            realizedPnL = ((position.entryPrice - closePrice) * position.positionSize * 10) - 1.24; // $10 per point minus commission
        }
        
        position.closePrice = closePrice;
        position.closeTime = new Date();
        position.closeReason = reason;
        position.realizedPnL = realizedPnL;
        position.status = 'CLOSED';
        
        // Update bot statistics
        this.state.dailyPnL += realizedPnL;
        this.state.totalPnL += realizedPnL;
        
        if (realizedPnL > 0) {
            this.state.winCount++;
        } else {
            this.state.lossCount++;
        }
        
        // Move to history and clear current position
        this.state.positionHistory.push({ ...position });
        this.state.currentPosition = null;
        
        this.log('info', `Position closed: ${reason}`, {
            positionId: position.id,
            closePrice: closePrice,
            realizedPnL: realizedPnL.toFixed(2),
            holdTime: position.closeTime - position.openTime
        });
        
        this.emit('positionClosed', { position, reason });
    }
    
    /**
     * Handle order filled event from aggregator
     */
    handleOrderFilled(fill) {
        // Update trade statistics
        this.state.tradeCount++;
        
        // Create position from fill
        const position = {
            id: fill.positionId || `pos_${Date.now()}`,
            orderId: fill.orderId,
            instrument: fill.instrument,
            direction: fill.side,
            entryPrice: fill.fillPrice,
            positionSize: fill.quantity,
            openTime: new Date(fill.timestamp),
            status: 'OPEN',
            unrealizedPnL: 0
        };
        
        this.state.currentPosition = position;
        this.emit('positionOpened', { position, fill });
    }
    
    /**
     * Handle position update from aggregator
     */
    handlePositionUpdate(update) {
        if (!update.positions || update.positions.length === 0) {
            // No positions - check if we had one open
            if (this.state.currentPosition && this.state.currentPosition.status === 'OPEN') {
                // Position was closed
                const closedPosition = this.state.currentPosition;
                closedPosition.status = 'CLOSED';
                closedPosition.closeTime = new Date();
                
                // Move to history
                this.state.positionHistory.push(closedPosition);
                this.state.currentPosition = null;
                
                this.log('info', 'Position closed by aggregator', {
                    positionId: closedPosition.id
                });
            }
            return;
        }
        
        // Update current position with aggregator data
        const aggregatorPosition = update.positions[0]; // Assuming single position
        if (this.state.currentPosition) {
            this.state.currentPosition.unrealizedPnL = aggregatorPosition.unrealizedPnL || 0;
            
            // Update statistics if position closed
            if (aggregatorPosition.status === 'CLOSED' && this.state.currentPosition.status === 'OPEN') {
                this.state.currentPosition.status = 'CLOSED';
                this.state.currentPosition.closeTime = new Date();
                this.state.currentPosition.realizedPnL = aggregatorPosition.realizedPnL || 0;
                
                // Update bot statistics
                const realizedPnL = aggregatorPosition.realizedPnL || 0;
                this.state.dailyPnL += realizedPnL;
                this.state.totalPnL += realizedPnL;
                
                if (realizedPnL > 0) {
                    this.state.winCount++;
                } else {
                    this.state.lossCount++;
                }
                
                // Move to history
                this.state.positionHistory.push({ ...this.state.currentPosition });
                this.state.currentPosition = null;
                
                this.log('info', 'Position closed', {
                    positionId: aggregatorPosition.id,
                    realizedPnL: realizedPnL
                });
                
                this.emit('positionClosed', { position: aggregatorPosition });
            }
        }
    }
    
    /**
     * Stop the trading bot
     */
    async stop() {
        this.state.status = 'STOPPING';
        
        // Clear simulation interval
        if (this.simulationInterval) {
            clearInterval(this.simulationInterval);
            this.simulationInterval = null;
        }
        
        // Close any open positions (in test mode)
        if (this.state.currentPosition && this.runtimeConfig.testMode) {
            this.closePosition(this.state.currentPosition, this.state.lastPrice, 'BOT_STOP');
        }
        
        // Disconnect from aggregator
        if (this.aggregatorClient) {
            await this.aggregatorClient.disconnect();
        }
        
        this.state.status = 'STOPPED';
        this.emit('stopped', { botId: this.botId });
        this.log('info', 'TradingBot stopped');
    }
    
    /**
     * Log periodic updates
     */
    logPeriodicUpdate(strategyResult) {
        const winRate = this.state.tradeCount > 0 ? 
            (this.state.winCount / this.state.tradeCount * 100).toFixed(1) : '0.0';
        
        this.log('info', 'Periodic update', {
            ticks: this.state.marketDataCount,
            price: this.state.lastPrice?.toFixed(2),
            signals: this.state.signalsGenerated,
            trades: this.state.tradeCount,
            winRate: `${winRate}%`,
            dailyPnL: this.state.dailyPnL.toFixed(2),
            currentPosition: this.state.currentPosition ? 'OPEN' : 'NONE',
            strategyReady: strategyResult?.ready,
            strategyState: strategyResult?.stateMachine?.currentState || 'N/A'
        });
    }
    
    /**
     * Get bot status
     */
    getStatus() {
        const winRate = this.state.tradeCount > 0 ? 
            (this.state.winCount / this.state.tradeCount * 100) : 0;
        
        return {
            // Bot info
            id: this.botId,
            name: this.name,
            status: this.state.status,
            uptime: Date.now() - this.state.startTime.getTime(),
            
            // Configuration
            instrument: this.runtimeConfig?.instrument || 'N/A',
            strategyType: this.runtimeConfig?.strategyType || 'N/A',
            testMode: this.runtimeConfig?.testMode || false,
            
            // Market data
            lastPrice: this.state.lastPrice,
            marketDataCount: this.state.marketDataCount,
            
            // Trading performance
            signalsGenerated: this.state.signalsGenerated,
            signalsExecuted: this.state.signalsExecuted,
            signalsFailed: this.state.signalsFailed,
            tradeCount: this.state.tradeCount || 0,
            winCount: this.state.winCount || 0,
            lossCount: this.state.lossCount || 0,
            winRate: winRate,
            dailyPnL: this.state.dailyPnL || 0,
            totalPnL: this.state.totalPnL || 0,
            
            // Current state
            currentPosition: this.state.currentPosition,
            emergencyStop: this.config.emergencyStop,
            
            // Strategy info
            strategy: this.strategy ? {
                ready: this.strategy.isStrategyReady ? this.strategy.isStrategyReady() : true,
                status: this.strategy.getStatusSummary ? this.strategy.getStatusSummary() : null
            } : null
        };
    }
    
    /**
     * Log message with context
     */
    log(level, message, data = {}) {
        if (!this.runtimeConfig?.enableLogging) return;
        
        const logEntry = {
            timestamp: new Date().toISOString(),
            level,
            botId: this.botId,
            botName: this.name,
            message,
            ...data
        };
        
        // Log to file
        if (this.logger) {
            this.logger.log(level, message, data);
        }
        
        // Also log to console in test mode
        if (this.runtimeConfig?.testMode || level === 'error') {
            console.log(`[${this.name}] ${message}`, data);
        }
    }
    
    /**
     * Handle errors
     */
    handleError(context, error) {
        this.log('error', `Error in ${context}`, {
            error: error.message,
            stack: error.stack
        });
        
        this.emit('error', { context, error, botId: this.botId });
    }
    
    /**
     * Emergency stop
     */
    emergencyStop(reason = 'Manual stop') {
        this.config.emergencyStop = true;
        this.log('warn', 'Emergency stop activated', { reason });
        this.emit('emergencyStop', { botId: this.botId, reason });
    }
    
    /**
     * Reset daily statistics
     */
    resetDailyStats() {
        this.state.dailyPnL = 0;
        this.log('info', 'Daily statistics reset');
    }
    
    /**
     * Get position history
     */
    getPositionHistory(limit = 50) {
        return this.state.positionHistory.slice(-limit);
    }
}

module.exports = TradingBot;