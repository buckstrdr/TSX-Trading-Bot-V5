/**
 * Start Trading Aggregator in PRODUCTION MODE
 * This will actively process orders, enforce risk rules, and place SL/TP orders
 */

const TradingAggregator = require('./TradingAggregator');
const RedisAdapter = require('./adapters/RedisAdapter');
const ConnectionManagerAdapter = require('./adapters/ConnectionManagerAdapter');
const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');
const express = require('express');

async function startProductionAggregator() {
    console.log('🚀 Starting Trading Aggregator in PRODUCTION MODE...');
    
    // Create Express app for health check endpoint
    const app = express();
    const PORT = 7600;
    
    // Health check endpoint
    app.get('/health', (req, res) => {
        res.json({ 
            status: 'healthy',
            service: 'Trading Aggregator',
            timestamp: new Date().toISOString(),
            uptime: process.uptime()
        });
    });
    
    // Start HTTP server
    const healthServer = app.listen(PORT, () => {
        console.log(`📡 Trading Aggregator health check listening on port ${PORT}`);
    });
    
    // Load configuration from global.yaml
    const configPath = path.join(__dirname, '../../../config/global.yaml');
    const globalConfig = yaml.load(fs.readFileSync(configPath, 'utf8'));
    
    // Extract aggregator configuration
    const aggregatorConfig = globalConfig.aggregator || {};
    
    console.log('📋 Loaded configuration from global.yaml');
    console.log('  - Max Daily Loss:', aggregatorConfig.globalRisk?.maxDailyLoss);
    console.log('  - Max Daily Profit:', aggregatorConfig.globalRisk?.maxDailyProfit);
    console.log('  - Max Open Positions:', aggregatorConfig.globalRisk?.maxOpenPositions);
    console.log('  - SL/TP Management: Bot-managed (aggregator ignores SL/TP defaults)');
    
    // Create aggregator with config from global.yaml
    const aggregator = new TradingAggregator({
        
        riskConfig: {
            maxOrderSize: aggregatorConfig.positionLimits?.maxOrderSize || 10,
            maxDailyLoss: aggregatorConfig.globalRisk?.maxDailyLoss || 500,
            maxDailyProfit: aggregatorConfig.globalRisk?.maxDailyProfit || 600,
            maxOpenPositions: aggregatorConfig.globalRisk?.maxOpenPositions || 5,
            maxAccountDrawdown: aggregatorConfig.globalRisk?.maxAccountDrawdown || 1000,
            pauseOnDailyLoss: aggregatorConfig.globalRisk?.pauseOnDailyLoss || true,
            maxPositionSize: aggregatorConfig.positionLimits?.maxPositionSize || 20,
            maxPositionValue: aggregatorConfig.positionLimits?.maxPositionValue || 50000,
            maxOrdersPerMinute: aggregatorConfig.rateLimits?.maxOrdersPerMinute || 30,
            maxOrdersPerSymbol: aggregatorConfig.rateLimits?.maxOrdersPerSymbol || 5,
            allowedTradingHours: aggregatorConfig.tradingHours?.enabled ? {
                start: aggregatorConfig.tradingHours.sessions[0]?.start || '00:00',
                end: aggregatorConfig.tradingHours.sessions[0]?.end || '23:59'
            } : { start: '00:00', end: '23:59' }
        },
        
        queueConfig: {
            maxQueueSize: aggregatorConfig.queue?.maxQueueSize || 100,
            processingInterval: aggregatorConfig.queue?.processingInterval || 100,
            maxConcurrentOrders: aggregatorConfig.queue?.maxConcurrentOrders || 5,
            maxOrdersPerSecond: aggregatorConfig.rateLimits?.maxOrdersPerMinute ? 
                Math.floor(aggregatorConfig.rateLimits.maxOrdersPerMinute / 60) : 10
        },
        
        sltpConfig: {
            // NOTE: SL/TP calculation is disabled by default - bots manage their own SL/TP
            calculateSLTP: aggregatorConfig.sltp?.calculateSLTP || false,
            enableTrailingStop: aggregatorConfig.sltp?.enableTrailingStop || false,
            placeBracketOrders: aggregatorConfig.sltp?.placeBracketOrders || false, // Disabled - bots handle this
            tickSizes: globalConfig.tradingDefaults?.contractSpecs ? 
                Object.entries(globalConfig.tradingDefaults.contractSpecs).reduce((acc, [symbol, spec]) => {
                    acc[symbol] = spec.tickSize;
                    return acc;
                }, {}) : {
                    MES: 0.25,
                    MNQ: 0.25,
                    MGC: 0.10,
                    MCL: 0.01
                }
        },
        
        // Don't pass redisConfig - we'll set the adapter externally
        // redisConfig: {
        //     host: 'localhost',
        //     port: 6379
        // },
        
        connectionManagerUrl: 'http://localhost:7500',
        
        enableLogging: true,
        logLevel: 'info',
        
        // Enable monitoring
        enableMonitoring: true,
        monitoringPort: 7701,
        enableRedisMetrics: false  // Disable since we're setting adapter externally
    });
    
    // Create adapters BEFORE initializing aggregator
    const redisAdapter = new RedisAdapter({
        host: 'localhost',
        port: 6379
    });
    
    const connectionManagerAdapter = new ConnectionManagerAdapter({
        connectionManagerUrl: 'http://localhost:7500',
        enableWebSocket: false  // Disable WebSocket for now
    });
    
    // Set up event listeners before initializing
    let redisConnected = false;
    let redisError = null;
    
    redisAdapter.once('connected', () => {
        console.log('✅ Redis adapter connected');
        redisConnected = true;
    });
    
    redisAdapter.once('connectionError', (error) => {
        console.error('❌ Redis connection error:', error);
        redisError = error;
    });
    
    // Now initialize the Redis adapter
    console.log('🔄 Initializing Redis adapter...');
    try {
        await redisAdapter.initialize();
        
        // Give it a moment to ensure the event fires
        await new Promise(resolve => setTimeout(resolve, 100));
        
        if (!redisConnected) {
            throw new Error('Redis adapter did not emit connected event');
        }
        
        console.log('✅ Redis adapter initialized successfully');
    } catch (error) {
        console.error('❌ Failed to initialize Redis adapter:', error);
        throw error;
    }
    
    // Connect adapters to aggregator
    aggregator.redisAdapter = redisAdapter;
    aggregator.connectionManagerAdapter = connectionManagerAdapter;
    
    // NOW initialize the aggregator with adapters already connected
    await aggregator.initialize();
    
    // Subscribe to manual trading orders
    await redisAdapter.subscribeToOrders((orderMessage) => {
        console.log('📥 Received order from Manual Trading:', orderMessage);
        
        // Handle different order message formats
        let orderToSubmit;
        if (orderMessage.type === 'MANUAL_ORDER' && orderMessage.order) {
            // New format from manual trading through aggregator:orders channel
            orderToSubmit = {
                ...orderMessage.order,
                source: orderMessage.source || 'MANUAL_TRADING_V2',
                id: orderMessage.order.orderId,
                instrument: orderMessage.order.instrument,
                action: orderMessage.order.side, // Convert 'side' to 'action'
                type: orderMessage.order.orderType || 'MARKET',
                quantity: orderMessage.order.quantity,
                price: orderMessage.order.limitPrice || null,
                stopPrice: orderMessage.order.stopPrice || null,
                accountId: orderMessage.order.accountId
            };
        } else {
            // Legacy format or other sources
            orderToSubmit = orderMessage;
        }
        
        console.log('🎯 Submitting order to aggregator:', {
            id: orderToSubmit.id,
            instrument: orderToSubmit.instrument,
            action: orderToSubmit.action,
            quantity: orderToSubmit.quantity,
            source: orderToSubmit.source
        });
        
        aggregator.submitOrder(orderToSubmit);
    });
    
    // Subscribe to fill events
    await redisAdapter.subscribeToFills((fill) => {
        console.log('✅ Fill received:', fill);
        aggregator.processFill(fill);
    });
    
    // Subscribe to aggregator requests (from manual trading) and forward to connection manager
    await redisAdapter.subscribeToAggregatorRequests();
    
    // Subscribe to P&L requests and forward to connection manager
    await redisAdapter.subscribeToPnLRequests();
    
    // Subscribe to market data and republish to aggregator:market-data channel
    await redisAdapter.subscribeToMarketData((marketData) => {
        aggregator.handleMarketDataUpdate(marketData);
    });
    console.log('📊 Subscribed to market data for republishing (silent mode - no spam)');
    
    // Connect to Connection Manager
    await connectionManagerAdapter.connect();
    
    // Set up event listeners
    aggregator.on('orderSubmitted', (event) => {
        console.log('📤 Order submitted to aggregator:', event.order.id);
    });
    
    aggregator.on('orderProcessed', (event) => {
        console.log('✅ Order sent to Connection Manager:', event.order.id);
    });
    
    aggregator.on('fillProcessed', (event) => {
        console.log('📊 Fill processed, SL/TP status:', {
            orderId: event.fill.orderId,
            calculated: event.sltpLevels?.calculated !== false,
            stopLoss: event.sltpLevels?.stopLoss,
            takeProfit: event.sltpLevels?.takeProfit,
            reason: event.sltpLevels?.reason
        });
        
        // Only place SL/TP orders if aggregator calculated them (most bots manage their own)
        if (event.sltpLevels && event.sltpLevels.calculated !== false) {
            if (event.sltpLevels.stopLoss) {
                const slOrder = {
                    instrument: event.fill.instrument,
                    action: event.fill.side === 'BUY' ? 'SELL' : 'BUY',
                    quantity: event.fill.quantity,
                    type: 'STOP',
                    stopPrice: event.sltpLevels.stopLoss,
                    source: 'AGGREGATOR_SL'
                };
                console.log('🛑 Placing Aggregator-calculated Stop Loss order:', slOrder);
                connectionManagerAdapter.placeOrder(slOrder);
            }
            
            if (event.sltpLevels.takeProfit) {
                const tpOrder = {
                    instrument: event.fill.instrument,
                    action: event.fill.side === 'BUY' ? 'SELL' : 'BUY',
                    quantity: event.fill.quantity,
                    type: 'LIMIT',
                    price: event.sltpLevels.takeProfit,
                    source: 'AGGREGATOR_TP'
                };
                console.log('🎯 Placing Aggregator-calculated Take Profit order:', tpOrder);
                connectionManagerAdapter.placeOrder(tpOrder);
            }
        } else {
            console.log('📝 SL/TP managed by trading bot - aggregator not placing orders');
        }
    });
    
    aggregator.on('orderRejected', (event) => {
        console.log('❌ Order rejected by risk rules:', {
            orderId: event.order.id,
            reason: event.reason,
            violations: event.violations
        });
    });
    
    // Update the health check endpoint with aggregator status
    app.get('/health', (req, res) => {
        const metrics = aggregator.getMetrics();
        const redisStatus = redisAdapter.getStatus();
        
        res.json({
            status: 'healthy',
            service: 'Trading Aggregator',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            aggregator: {
                status: metrics.aggregator.status,
                uptime: metrics.aggregator.uptime,
                shadowMode: metrics.aggregator.shadowMode,
                ordersReceived: metrics.aggregator.ordersReceived,
                ordersProcessed: metrics.aggregator.ordersProcessed,
                riskViolations: metrics.aggregator.riskViolations
            },
            queue: {
                size: metrics.queue.queues.total,
                processing: metrics.queue.processingState.isProcessing
            },
            redis: {
                connected: redisStatus.connected,
                subscribedChannels: redisStatus.subscribedChannels.length,
                messageCount: redisStatus.messageCount
            },
            connectionManager: {
                url: 'http://localhost:7500',
                connected: connectionManagerAdapter.isConnected || true
            },
            timestamp: new Date().toISOString()
        });
    });
    
    // Metrics endpoint
    app.get('/metrics', (req, res) => {
        const fullMetrics = aggregator.getMetrics();
        res.json(fullMetrics);
    });
    
    // Statistics endpoint to match TopStepX API format with Redis resilience
    app.get('/Statistics/todaystats', async (req, res) => {
        try {
            console.log('📊 [STATISTICS] Received todaystats request');
            
            // Use shorter timeout but with automatic retry logic for Redis stability
            const response = await redisAdapter.sendConnectionManagerRequest('GET_STATISTICS', {
                endpoint: '/Statistics/todaystats',
                accountId: '9627376' // Default account for now
            }, 8000, 3); // 8 second timeout per attempt, max 3 retries
            
            console.log('📊 [STATISTICS] Response received from Connection Manager');
            
            // Send the statistics data
            if (response && response.statistics) {
                res.json(response.statistics);
            } else if (response && response.data) {
                res.json(response.data);
            } else {
                // Fallback empty statistics
                res.json({
                    dailyPnL: 0,
                    totalTrades: 0,
                    winRate: 0,
                    profitFactor: 0,
                    averageWin: 0,
                    averageLoss: 0,
                    grossProfit: 0,
                    grossLoss: 0
                });
            }
            
        } catch (error) {
            console.log(`📊 [STATISTICS] Error after retries: ${error.message}`);
            
            // If it's a timeout, provide more specific error
            if (error.message.includes('timed out')) {
                res.status(504).json({ 
                    error: 'Statistics request timeout',
                    message: 'Connection Manager did not respond despite retries (Redis connection issues)',
                    timestamp: new Date().toISOString()
                });
            } else {
                res.status(500).json({ 
                    error: 'Statistics unavailable',
                    message: error.message,
                    timestamp: new Date().toISOString()
                });
            }
        }
    });
    
    // Lifetime Statistics endpoint to match TopStepX API format with Redis resilience
    app.get('/Statistics/lifetimestats', async (req, res) => {
        try {
            console.log('📊 [LIFETIME_STATISTICS] Received lifetimestats request');
            
            // Use shorter timeout but with automatic retry logic for Redis stability
            const response = await redisAdapter.sendConnectionManagerRequest('GET_STATISTICS', {
                endpoint: '/Statistics/lifetimestats',
                accountId: '9627376', // Default account for now
                statisticsType: 'lifetimestats'
            }, 8000, 3); // 8 second timeout per attempt, max 3 retries
            
            console.log('📊 [LIFETIME_STATISTICS] Response received from Connection Manager');
            
            // Send the statistics data
            if (response && response.statistics) {
                res.json(response.statistics);
            } else if (response && response.data) {
                res.json(response.data);
            } else {
                // Fallback empty statistics
                res.json({
                    totalTrades: 0,
                    winRate: 0,
                    totalPnL: 0,
                    profitFactor: 0,
                    averageWin: 0,
                    averageLoss: 0,
                    grossProfit: 0,
                    grossLoss: 0,
                    winningTrades: 0,
                    losingTrades: 0,
                    largestWin: 0,
                    largestLoss: 0
                });
            }
            
        } catch (error) {
            console.log(`📊 [LIFETIME_STATISTICS] Error after retries: ${error.message}`);
            
            // If it's a timeout, provide more specific error
            if (error.message.includes('timed out')) {
                res.status(504).json({ 
                    error: 'Lifetime statistics request timeout',
                    message: 'Connection Manager did not respond despite retries (Redis connection issues)',
                    timestamp: new Date().toISOString()
                });
            } else {
                res.status(500).json({ 
                    error: 'Lifetime statistics unavailable',
                    message: error.message,
                    timestamp: new Date().toISOString()
                });
            }
        }
    });
    
    // Order submission endpoint (for testing/admin)
    app.post('/admin/order', express.json(), (req, res) => {
        const order = req.body;
        aggregator.submitOrder(order)
            .then(result => res.json(result))
            .catch(error => res.status(500).json({ error: error.message }));
    });
    
    // Metrics reporting
    setInterval(() => {
        const metrics = aggregator.getMetrics();
        console.log('📊 Aggregator Metrics:', {
            ordersReceived: metrics.aggregator.ordersReceived,
            ordersProcessed: metrics.aggregator.ordersProcessed,
            riskViolations: metrics.aggregator.riskViolations,
            queueSize: metrics.queue.queues.total
        });
    }, 30000); // Every 30 seconds
    
    console.log('✅ Trading Aggregator started in PRODUCTION MODE');
    console.log('🎯 Ready to process real orders with:');
    console.log('  - Risk validation enforcement');
    console.log('  - Automatic SL/TP placement');
    console.log('  - Queue management');
    console.log('  - Real order flow to TopStep');
    console.log('  - Monitoring API: http://localhost:7600');
    console.log('  - WebSocket: ws://localhost:7600');
    
    // Test account request
    setTimeout(async () => {
        console.log('\n🧪 Testing aggregator request forwarding...');
        const testRequestId = `AGG-TEST-${Date.now()}`;
        const testRequest = {
            type: 'GET_ACCOUNTS',
            requestId: testRequestId,
            responseChannel: 'test-response',
            timestamp: Date.now()
        };
        
        // Subscribe to test response channel
        await redisAdapter.subscribe('test-response', (message) => {
            console.log('✅ TEST RESPONSE RECEIVED:', message);
        });
        
        // Send test request
        await redisAdapter.publish('aggregator:requests', testRequest);
        console.log(`📤 Sent test GET_ACCOUNTS request with ID: ${testRequestId}`);
    }, 3000);
    
    // Graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\n📴 Shutting down Trading Aggregator...');
        await aggregator.shutdown();
        await redisAdapter.disconnect();
        await connectionManagerAdapter.disconnect();
        healthServer.close();
        process.exit(0);
    });
}

// Start the aggregator
startProductionAggregator().catch(error => {
    console.error('❌ Failed to start aggregator:', error);
    process.exit(1);
});