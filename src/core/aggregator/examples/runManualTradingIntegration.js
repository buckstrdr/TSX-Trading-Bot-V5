#!/usr/bin/env node
/**
 * Manual Trading Integration Runner
 * Example script showing how to run the Manual Trading Integration Layer
 */

const ManualTradingIntegration = require('./ManualTradingIntegration');

class ManualTradingIntegrationRunner {
    constructor() {
        this.integration = null;
    }
    
    async start() {
        try {
            console.log('🚀 Starting Manual Trading Integration Layer...');
            
            // Configuration
            const config = {
                // Default to shadow mode for safety
                shadowMode: process.env.SHADOW_MODE !== 'false',
                
                // Integration options
                interceptOrders: process.env.INTERCEPT_ORDERS !== 'false',
                enableRiskValidation: process.env.ENABLE_RISK_VALIDATION !== 'false',
                enableSLTPCalculation: process.env.ENABLE_SLTP_CALCULATION !== 'false',
                preserveOriginalWorkflow: process.env.PRESERVE_ORIGINAL_WORKFLOW !== 'false',
                
                // Connection settings
                connectionManagerUrl: process.env.CONNECTION_MANAGER_URL || 'http://localhost:7500',
                manualTradingServerUrl: process.env.MANUAL_TRADING_SERVER_URL || 'http://localhost:3003',
                
                // Redis configuration
                redisConfig: {
                    host: process.env.REDIS_HOST || 'localhost',
                    port: parseInt(process.env.REDIS_PORT || '6379'),
                    db: parseInt(process.env.REDIS_DB || '0')
                },
                
                // Aggregator configuration
                aggregatorConfig: {
                    // Risk settings
                    riskConfig: {
                        maxPositionSize: parseInt(process.env.MAX_POSITION_SIZE || '10'),
                        maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS || '1000'),
                        maxOpenOrders: parseInt(process.env.MAX_OPEN_ORDERS || '5'),
                        allowedInstruments: (process.env.ALLOWED_INSTRUMENTS || 'MGC,MNQ,MES,MCL,M2K,MYM').split(',')
                    },
                    
                    // Queue settings
                    queueConfig: {
                        maxQueueSize: parseInt(process.env.MAX_QUEUE_SIZE || '100'),
                        priorityLevels: 3,
                        processingDelayMs: parseInt(process.env.PROCESSING_DELAY_MS || '100')
                    },
                    
                    // SL/TP calculation settings
                    sltpConfig: {
                        defaultRiskRewardRatio: parseFloat(process.env.DEFAULT_RISK_REWARD || '2.0'),
                        maxRiskPercent: parseFloat(process.env.MAX_RISK_PERCENT || '2.0'),
                        instrumentMultipliers: {
                            'MGC': 100,  // Gold
                            'MNQ': 20,   // NASDAQ
                            'MES': 50,   // S&P 500
                            'MCL': 1000, // Crude Oil
                            'M2K': 50,   // Russell 2000
                            'MYM': 5     // Dow
                        },
                        tickSizes: {
                            'MGC': 0.1,
                            'MNQ': 0.25,
                            'MES': 0.25,
                            'MCL': 0.01,
                            'M2K': 0.05,
                            'MYM': 1.0
                        }
                    }
                },
                
                // Logging
                enableLogging: process.env.ENABLE_LOGGING !== 'false',
                logLevel: process.env.LOG_LEVEL || 'info'
            };
            
            console.log('⚙️  Configuration:', {
                shadowMode: config.shadowMode,
                interceptOrders: config.interceptOrders,
                enableRiskValidation: config.enableRiskValidation,
                enableSLTPCalculation: config.enableSLTPCalculation,
                preserveOriginalWorkflow: config.preserveOriginalWorkflow
            });
            
            // Create integration instance
            this.integration = new ManualTradingIntegration(config);
            
            // Set up event listeners
            this.setupEventListeners();
            
            // Wait for initialization
            await this.waitForReady();
            
            console.log('✅ Manual Trading Integration Layer is ready!');
            console.log('📊 Intercepting manual trading orders and routing through aggregator');
            
            if (config.shadowMode) {
                console.log('🔍 Running in SHADOW MODE - orders will be processed but not executed');
            }
            
            // Report metrics every 30 seconds
            this.startMetricsReporting();
            
        } catch (error) {
            console.error('❌ Failed to start Manual Trading Integration:', error.message);
            process.exit(1);
        }
    }
    
    setupEventListeners() {
        // Integration ready
        this.integration.on('ready', (event) => {
            console.log('🎯 Integration ready:', event);
        });
        
        // Order processing events
        this.integration.on('orderProcessing', (event) => {
            console.log('🔄 Order processing:', {
                originalOrderId: event.originalOrderId,
                aggregatorOrderId: event.aggregatorOrderId,
                status: event.status
            });
        });
        
        // Metrics events
        this.integration.on('metrics', (metrics) => {
            if (process.env.LOG_LEVEL === 'debug') {
                console.log('📊 Metrics update:', JSON.stringify(metrics, null, 2));
            }
        });
        
        // Error handling
        this.integration.on('error', (error) => {
            console.error('❌ Integration error:', error);
        });
        
        // Shutdown event
        this.integration.on('shutdown', () => {
            console.log('🛑 Integration shutdown complete');
        });
    }
    
    async waitForReady() {
        return new Promise((resolve, reject) => {
            if (this.integration.state.status === 'READY') {
                resolve();
                return;
            }
            
            const timeout = setTimeout(() => {
                reject(new Error('Integration initialization timeout'));
            }, 60000); // 60 second timeout
            
            this.integration.once('ready', () => {
                clearTimeout(timeout);
                resolve();
            });
            
            this.integration.once('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
        });
    }
    
    startMetricsReporting() {
        setInterval(() => {
            const metrics = this.integration.getMetrics();
            
            console.log('\n📊 === INTEGRATION METRICS ===');
            console.log(`Status: ${metrics.integration.status}`);
            console.log(`Uptime: ${Math.round(metrics.integration.uptime / 1000)}s`);
            console.log(`Orders Intercepted: ${metrics.integration.ordersIntercepted}`);
            console.log(`Orders Processed: ${metrics.integration.ordersProcessed}`);
            console.log(`Orders Passed: ${metrics.integration.ordersPassed}`);
            console.log(`Orders Rejected: ${metrics.integration.ordersRejected}`);
            console.log(`Risk Violations: ${metrics.integration.riskViolations}`);
            console.log(`SL/TP Calculated: ${metrics.integration.sltpCalculated}`);
            console.log(`Active Interceptions: ${metrics.interception.activeInterceptions}`);
            console.log('=================================\n');
            
        }, 30000); // Every 30 seconds
    }
    
    async shutdown() {
        console.log('🛑 Shutting down Manual Trading Integration...');
        
        if (this.integration) {
            await this.integration.shutdown();
        }
        
        console.log('✅ Shutdown complete');
        process.exit(0);
    }
}

// Handle shutdown signals
const runner = new ManualTradingIntegrationRunner();

process.on('SIGINT', async () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    await runner.shutdown();
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    await runner.shutdown();
});

process.on('uncaughtException', async (error) => {
    console.error('💥 Uncaught Exception:', error);
    await runner.shutdown();
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
    await runner.shutdown();
});

// Start the integration
runner.start().catch(async (error) => {
    console.error('💥 Startup failed:', error);
    await runner.shutdown();
});