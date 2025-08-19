/**
 * TradingAggregator - Main aggregation service that coordinates all trading operations
 * Manages order flow from multiple sources through risk validation and execution
 * 
 * IMPORTANT: SL/TP management is handled by individual trading bots, not the aggregator.
 * The aggregator only enforces global risk limits (daily loss, max positions, etc.)
 */

const EventEmitter = require('events');
const RiskManager = require('./core/RiskManager');
const QueueManager = require('./core/QueueManager');
const SLTPCalculator = require('./core/SLTPCalculator');
const BotRegistry = require('./core/BotRegistry');
const RedisAdapter = require('./adapters/RedisAdapter');
const ConnectionManagerAdapter = require('./adapters/ConnectionManagerAdapter');
const MetricsCollector = require('./monitoring/MetricsCollector');
const MonitoringServer = require('./monitoring/MonitoringServer');
const RedisMetricsPublisher = require('./monitoring/RedisMetricsPublisher');
const FileLogger = require('../../../shared/utils/FileLogger');

class TradingAggregator extends EventEmitter {
    constructor(config = {}) {
        super();
        
        // Initialize FileLogger
        this.fileLogger = new FileLogger('TradingAggregator', 'logs');
        this.fileLogger.info('Trading Aggregator starting up', {
            timestamp: new Date().toISOString()
        });
        
        this.config = {
            // REMOVED: Shadow mode - Now always enforces risk controls for safety
            // Risk enforcement is ALWAYS active in production
            enforceRisk: true,
            
            // Component configs
            riskConfig: config.riskConfig || {},
            queueConfig: config.queueConfig || {},
            sltpConfig: config.sltpConfig || {},
            registryConfig: config.registryConfig || {},
            
            // Aggregator settings
            enableLogging: config.enableLogging !== false,
            logLevel: config.logLevel || 'info',
            metricsInterval: config.metricsInterval || 60000, // 1 minute
            
            // Integration settings
            redisConfig: config.redisConfig || null,
            connectionManagerUrl: config.connectionManagerUrl || null,
            
            // Monitoring settings
            enableMonitoring: config.enableMonitoring !== false,
            monitoringPort: config.monitoringPort || 7700,
            enableRedisMetrics: config.enableRedisMetrics !== false
        };
        
        // Initialize core components
        this.riskManager = new RiskManager({
            ...this.config.riskConfig
            // REMOVED: shadowMode parameter - Always enforce risk
            // Note: ConnectionManagerAdapter will be set during initialization
        });
        
        this.queueManager = new QueueManager({
            ...this.config.queueConfig
            // REMOVED: shadowMode parameter - Always enforce risk
        });
        
        this.sltpCalculator = new SLTPCalculator(this.config.sltpConfig);
        this.botRegistry = new BotRegistry(this.config.registryConfig);
        
        // State tracking
        this.state = {
            status: 'INITIALIZING',
            startTime: new Date(),
            orders: new Map(),
            fills: new Map(),
            positions: new Map(),
            metrics: {
                ordersReceived: 0,
                ordersProcessed: 0,
                ordersFailed: 0,
                fillsProcessed: 0,
                riskViolations: 0
            }
        };
        
        // Integration adapters
        this.redisAdapter = null;
        this.connectionManagerAdapter = null;
        
        // Monitoring components
        this.metricsCollector = null;
        this.monitoringServer = null;
        this.redisMetricsPublisher = null;
        
        // Don't auto-initialize - let the caller control when to initialize
    }
    
    /**
     * Initialize the aggregator
     */
    async initialize() {
        try {
            // Set up queue manager listeners
            this.queueManager.on('processOrder', this.handleProcessOrder.bind(this));
            this.queueManager.on('orderProcessingFailed', this.handleOrderFailure.bind(this));
            
            // Start metrics reporting
            if (this.config.enableLogging) {
                this.metricsInterval = setInterval(() => {
                    this.reportMetrics();
                }, this.config.metricsInterval);
            }
            
            // Initialize integrations if configured
            if (this.config.redisConfig) {
                await this.initializeRedis();
            }
            
            if (this.config.connectionManagerUrl) {
                await this.initializeConnectionManager();
            }
            
            // Initialize monitoring if enabled
            if (this.config.enableMonitoring) {
                await this.initializeMonitoring();
            }
            
            this.state.status = 'READY';
            this.emit('ready', { riskEnforced: true });
            
            this.log('info', 'Trading Aggregator initialized', {
                riskEnforced: true,
                components: {
                    riskManager: 'initialized',
                    queueManager: 'initialized',
                    sltpCalculator: 'initialized',
                    botRegistry: 'initialized'
                }
            });
            
        } catch (error) {
            this.state.status = 'ERROR';
            this.log('error', 'Failed to initialize aggregator', { error: error.message });
            throw error;
        }
    }
    
    /**
     * Initialize monitoring components
     */
    async initializeMonitoring() {
        try {
            // Initialize metrics collector
            this.metricsCollector = new MetricsCollector({
                collectionInterval: 1000,
                historySize: 300,
                enableDetailedTracking: true
            });
            
            // Start metrics collection
            this.metricsCollector.start();
            
            // Initialize monitoring server
            this.monitoringServer = new MonitoringServer({
                port: this.config.monitoringPort,
                host: 'localhost',
                corsOrigins: ['http://localhost:3001', 'http://localhost:3000'],
                logFile: 'aggregator.log'
            });
            
            // Attach aggregator to monitoring server
            this.monitoringServer.attachAggregator(this, this.metricsCollector);
            
            // Start monitoring server
            await this.monitoringServer.start();
            
            // Initialize Redis metrics publisher if enabled
            if (this.config.enableRedisMetrics && this.config.redisConfig) {
                this.redisMetricsPublisher = new RedisMetricsPublisher({
                    ...this.config.redisConfig,
                    metricsInterval: 1000,
                    summaryInterval: 60000
                });
                
                await this.redisMetricsPublisher.initialize();
                this.redisMetricsPublisher.attach(this.metricsCollector, this);
            }
            
            this.log('info', 'Monitoring components initialized', {
                metricsCollector: 'started',
                monitoringServer: `http://localhost:${this.config.monitoringPort}`,
                redisMetricsPublisher: this.redisMetricsPublisher ? 'enabled' : 'disabled'
            });
            
        } catch (error) {
            this.log('error', 'Failed to initialize monitoring', { error: error.message });
            // Don't throw - monitoring is optional
        }
    }
    
    /**
     * Submit an order to the aggregator
     */
    async submitOrder(order) {
        const submitTime = Date.now();
        
        try {
            this.log('info', 'Starting order submission', {
                orderId: order?.id || 'NO_ID',
                hasOrder: !!order,
                orderKeys: order ? Object.keys(order) : 'NO_ORDER'
            });
            
            this.state.metrics.ordersReceived++;
            
            // Ensure order has required fields
            const normalizedOrder = this.normalizeOrder(order);
            
            this.log('info', 'Order normalized successfully', {
                orderId: normalizedOrder.id,
                hasMetadata: !!normalizedOrder.metadata
            });
            
            // Record order received in metrics
            if (this.metricsCollector) {
                this.metricsCollector.recordOrderReceived(normalizedOrder);
            }
            
            // Register source if needed
            if (normalizedOrder.source) {
                this.botRegistry.recordOrder(normalizedOrder.source, normalizedOrder, { 
                    success: true 
                });
            }
            
            // Risk validation - ALWAYS ENFORCED
            const riskValidation = await this.riskManager.validateOrder(normalizedOrder);
            
            if (!riskValidation.valid) {
                // CRITICAL SAFETY: Always block risk violations - NO BYPASS
                this.state.metrics.riskViolations++;
                
                // Record rejection in metrics
                if (this.metricsCollector) {
                    this.metricsCollector.recordOrderRejected(normalizedOrder, 'RISK_VIOLATION', riskValidation.violations);
                }
                
                this.emit('orderRejected', {
                    order: normalizedOrder,
                    reason: 'RISK_VIOLATION',
                    violations: riskValidation.violations
                });
                
                this.log('warn', 'Order BLOCKED by risk controls', {
                    orderId: normalizedOrder.id,
                    violations: riskValidation.violations
                });
                
                return {
                    success: false,
                    orderId: normalizedOrder.id,
                    reason: 'RISK_VIOLATION',
                    violations: riskValidation.violations
                };
            }
            
            // Add to queue
            const queueResult = this.queueManager.enqueue(normalizedOrder);
            
            if (!queueResult.success) {
                // Record rejection in metrics
                if (this.metricsCollector) {
                    this.metricsCollector.recordOrderRejected(normalizedOrder, queueResult.reason, []);
                }
                
                this.emit('orderRejected', {
                    order: normalizedOrder,
                    reason: queueResult.reason
                });
                
                return {
                    success: false,
                    orderId: normalizedOrder.id,
                    reason: queueResult.reason
                };
            }
            
            // Update queue metrics
            if (this.metricsCollector) {
                this.metricsCollector.recordQueueDepth(this.queueManager.getTotalQueueSize());
            }
            
            // Track order
            this.state.orders.set(normalizedOrder.id, {
                ...normalizedOrder,
                status: 'QUEUED',
                queueId: queueResult.queueId,
                riskValidation,
                submittedAt: new Date()
            });
            
            this.emit('orderSubmitted', {
                order: normalizedOrder,
                queueId: queueResult.queueId,
                priority: queueResult.priority,
                riskEnforced: true
            });
            
            return {
                success: true,
                orderId: normalizedOrder.id,
                queueId: queueResult.queueId,
                priority: queueResult.priority,
                estimatedProcessingTime: queueResult.estimatedProcessingTime
            };
            
        } catch (error) {
            this.log('error', 'Error submitting order', { 
                order: order?.id || 'NO_ID', 
                error: error.message 
            });
            
            return {
                success: false,
                orderId: order?.id || 'UNKNOWN',
                error: error.message
            };
        }
    }
    
    /**
     * Handle order processing from queue
     */
    async handleProcessOrder(event) {
        const { order, queueMetrics } = event;
        const processingStartTime = Date.now();
        
        try {
            this.state.metrics.ordersProcessed++;
            
            // Update order status
            const trackedOrder = this.state.orders.get(order.id);
            if (trackedOrder) {
                trackedOrder.status = 'PROCESSING';
                trackedOrder.processingStarted = new Date();
            }
            
            // Record processing metrics
            if (this.metricsCollector && trackedOrder) {
                const waitTime = processingStartTime - trackedOrder.submittedAt.getTime();
                this.metricsCollector.recordOrderProcessed(order, waitTime);
            }
            
            // Always execute order in production mode
            await this.executeOrder(order);
            
            this.emit('orderProcessed', {
                order,
                queueMetrics,
                riskEnforced: true
            });
            
        } catch (error) {
            this.handleOrderFailure({ order, error });
        }
    }
    
    /**
     * Execute order through connection manager
     */
    async executeOrder(order) {
        if (!this.connectionManagerAdapter) {
            throw new Error('Connection Manager adapter not initialized');
        }
        
        try {
            this.log('info', 'Executing order through Connection Manager', {
                orderId: order.id,
                instrument: order.instrument,
                action: order.action,
                quantity: order.quantity,
                type: order.type
            });
            
            // Store SL/TP values before sending to Connection Manager
            if (order.stopLoss || order.takeProfit) {
                if (!this.state.pendingSLTP) {
                    this.state.pendingSLTP = new Map();
                }
                this.state.pendingSLTP.set(order.id, {
                    orderId: order.id,
                    stopLoss: order.stopLoss,
                    takeProfit: order.takeProfit,
                    side: order.action,
                    instrument: order.instrument,
                    accountId: order.accountId,
                    timestamp: Date.now()
                });
                
                // Enhanced SL/TP logging
                if (this.fileLogger) {
                    this.fileLogger.logSLTP('Storing SL/TP for Order', {
                        orderId: order.id,
                        instrument: order.instrument,
                        side: order.action,
                        stopLoss: order.stopLoss,
                        takeProfit: order.takeProfit,
                        accountId: order.accountId,
                        source: order.source || 'unknown'
                    });
                }
                
                this.log('info', 'Stored SL/TP values for later application', {
                    orderId: order.id,
                    stopLoss: order.stopLoss,
                    takeProfit: order.takeProfit
                });
            }

            // Send order to connection manager WITH points data for fill-based SL/TP calculation
            const orderPayload = {
                id: order.id,
                instrument: order.instrument,
                action: order.action, // BUY/SELL
                quantity: order.quantity,
                type: order.type,
                price: order.price,
                accountId: order.accountId,
                source: order.source || 'AGGREGATOR',
                urgent: order.urgent || false,
                metadata: order.metadata || {},
            };
            
            // Include points data if available for fill-based calculation
            if (order.metadata?.stopLoss?.type === 'points') {
                orderPayload.stopLoss = { points: order.metadata.stopLoss.value };
            }
            if (order.metadata?.takeProfit?.type === 'points') {
                orderPayload.takeProfit = { points: order.metadata.takeProfit.value };
            }
            
            // Pass through direct SL/TP fields from Manual Trading Server
            if (order.stopPrice !== undefined) {
                orderPayload.stopPrice = order.stopPrice;
            }
            if (order.stopLossPoints !== undefined) {
                orderPayload.stopLossPoints = order.stopLossPoints;
            }
            if (order.limitPrice !== undefined) {
                orderPayload.limitPrice = order.limitPrice;
            }
            if (order.takeProfitPoints !== undefined) {
                orderPayload.takeProfitPoints = order.takeProfitPoints;
            }
            
            const result = await this.connectionManagerAdapter.sendOrder(orderPayload);
            
            if (result.success) {
                this.log('info', 'Order sent successfully', {
                    orderId: order.id,
                    result
                });
                
                // Update order status
                const trackedOrder = this.state.orders.get(order.id);
                if (trackedOrder) {
                    trackedOrder.status = 'SENT_TO_BROKER';
                    trackedOrder.sentAt = new Date();
                }
                
                // Publish order update via Redis
                if (this.redisAdapter) {
                    await this.redisAdapter.publishOrderUpdate(order, 'SENT_TO_BROKER');
                }
                
            } else {
                throw new Error(`Order execution failed: ${result.error || result.reason}`);
            }
            
        } catch (error) {
            this.log('error', 'Order execution failed', {
                orderId: order.id,
                error: error.message
            });
            
            // Update order status to failed
            const trackedOrder = this.state.orders.get(order.id);
            if (trackedOrder) {
                trackedOrder.status = 'EXECUTION_FAILED';
                trackedOrder.error = error.message;
                trackedOrder.failedAt = new Date();
            }
            
            throw error;
        }
    }
    
    /**
     * Process a fill event
     */
    async processFill(fill) {
        const fillProcessingStart = Date.now();
        
        try {
            this.state.metrics.fillsProcessed++;
            
            // Check if we have pending SL/TP from manual trading (stored during order submission)
            const originalOrder = this.state.orders.get(fill.orderId);
            let sltpLevels = null;
            
            // Handle manual trading SL/TP calculation from points
            if (originalOrder && (originalOrder.stopLossPoints || originalOrder.takeProfitPoints)) {
                this.log('info', '[SLTP-FILL] Processing manual trading SL/TP from fill', {
                    orderId: fill.orderId,
                    fillPrice: fill.fillPrice,
                    side: fill.side,
                    stopLossPoints: originalOrder.stopLossPoints,
                    takeProfitPoints: originalOrder.takeProfitPoints
                });
                
                // Calculate SL/TP based on actual fill price using points
                sltpLevels = this.sltpCalculator.calculateFromPoints(fill, originalOrder.stopLossPoints, originalOrder.takeProfitPoints);
                
                this.log('info', '[SLTP-FILL] Manual trading SL/TP calculated from fill', {
                    orderId: fill.orderId,
                    fillPrice: fill.fillPrice,
                    calculatedSL: sltpLevels.stopLoss,
                    calculatedTP: sltpLevels.takeProfit,
                    slAmount: sltpLevels.stopLossAmount,
                    tpAmount: sltpLevels.takeProfitAmount
                });
                
                // Enhanced SL/TP logging for manual trading
                if (this.fileLogger) {
                    this.fileLogger.logSLTP('Manual Trading SL/TP from Fill', {
                        orderId: fill.orderId,
                        fillPrice: fill.fillPrice,
                        side: fill.side,
                        stopLossPoints: originalOrder.stopLossPoints,
                        takeProfitPoints: originalOrder.takeProfitPoints,
                        calculatedSL: sltpLevels.stopLoss,
                        calculatedTP: sltpLevels.takeProfit,
                        method: 'points'
                    });
                }
                
                // Send calculated SL/TP back to Connection Manager for bracket order creation
                if (sltpLevels.stopLoss || sltpLevels.takeProfit) {
                    this.log('info', '[SLTP-FILL] Sending calculated SL/TP to Connection Manager', {
                        orderId: fill.orderId,
                        stopLoss: sltpLevels.stopLoss,
                        takeProfit: sltpLevels.takeProfit
                    });
                    
                    // CRITICAL FIX: Actually send the calculated SL/TP to Connection Manager
                    try {
                        const sltpUpdateData = {
                            orderId: fill.orderId,
                            instrument: fill.instrument,
                            accountId: originalOrder.accountId || fill.accountId,
                            stopLoss: sltpLevels.stopLoss,
                            takeProfit: sltpLevels.takeProfit,
                            fillPrice: fill.fillPrice,
                            side: fill.side,
                            quantity: fill.quantity
                        };
                        
                        // Send SL/TP as separate orders after fill using sendOrder method
                        const results = [];
                        
                        // 🚨 CRITICAL FIX: Validate fill quantity before creating SL/TP orders
                        const quantityValidation = this.validateQuantityForSLTP(fill, originalOrder);
                        if (!quantityValidation.isValid) {
                            const errorMsg = `SL/TP quantity validation failed: ${quantityValidation.reason}`;
                            this.log('error', '❌ CRITICAL: Cannot create SL/TP orders with invalid quantity', {
                                orderId: fill.orderId,
                                fillQuantity: fill.quantity,
                                originalQuantity: originalOrder.quantity,
                                reason: quantityValidation.reason
                            });
                            
                            // Enhanced error logging for debugging
                            if (this.fileLogger) {
                                this.fileLogger.logSLTP('SL/TP Order Creation Failed - Invalid Quantity', {
                                    orderId: fill.orderId,
                                    fillQuantity: fill.quantity,
                                    originalQuantity: originalOrder.quantity,
                                    status: 'FAILED',
                                    reason: quantityValidation.reason
                                });
                            }
                            throw new Error(errorMsg); // Throw error instead of silent return
                        }
                        
                        const validQuantity = quantityValidation.quantity;
                        
                        // Send Stop Loss order if calculated
                        if (sltpLevels.stopLoss) {
                            const stopLossOrder = {
                                orderId: `${fill.orderId}-SL-${Date.now()}`,
                                instrument: fill.instrument,
                                action: fill.side === 'BUY' ? 'SELL' : 'BUY', // Opposite side
                                quantity: validQuantity, // 🚨 FIXED: Use validated quantity
                                type: 'STOP',
                                stopPrice: sltpLevels.stopLoss,
                                accountId: originalOrder.accountId || fill.accountId,
                                source: 'AGGREGATOR_SLTP',
                                metadata: {
                                    originalOrderId: fill.orderId,
                                    sltpType: 'STOP_LOSS',
                                    calculatedFromFill: true
                                }
                            };
                            
                            const slResult = await this.connectionManagerAdapter.sendOrder(stopLossOrder);
                            results.push({ type: 'STOP_LOSS', result: slResult });
                        }
                        
                        // Send Take Profit order if calculated
                        if (sltpLevels.takeProfit) {
                            const takeProfitOrder = {
                                orderId: `${fill.orderId}-TP-${Date.now()}`,
                                instrument: fill.instrument,
                                action: fill.side === 'BUY' ? 'SELL' : 'BUY', // Opposite side
                                quantity: validQuantity, // 🚨 FIXED: Use validated quantity
                                type: 'LIMIT',
                                price: sltpLevels.takeProfit,
                                accountId: originalOrder.accountId || fill.accountId,
                                source: 'AGGREGATOR_SLTP',
                                metadata: {
                                    originalOrderId: fill.orderId,
                                    sltpType: 'TAKE_PROFIT',
                                    calculatedFromFill: true
                                }
                            };
                            
                            const tpResult = await this.connectionManagerAdapter.sendOrder(takeProfitOrder);
                            results.push({ type: 'TAKE_PROFIT', result: tpResult });
                        }
                        
                        const result = { success: true, orders: results };
                        
                        if (result.success) {
                            this.log('info', '✅ Successfully sent SL/TP bracket order to Connection Manager', {
                                orderId: fill.orderId,
                                result: result
                            });
                            
                            // Enhanced SL/TP logging for successful bracket order
                            if (this.fileLogger) {
                                this.fileLogger.logSLTP('SL/TP Bracket Order Sent Successfully', {
                                    orderId: fill.orderId,
                                    fillPrice: fill.fillPrice,
                                    stopLoss: sltpLevels.stopLoss,
                                    takeProfit: sltpLevels.takeProfit,
                                    result: result,
                                    status: 'SUCCESS'
                                });
                            }
                        } else {
                            this.log('error', '❌ Failed to send SL/TP bracket order', {
                                orderId: fill.orderId,
                                error: result.error || 'Unknown error'
                            });
                        }
                    } catch (error) {
                        this.log('error', '❌ Exception sending SL/TP bracket order', {
                            orderId: fill.orderId,
                            error: error.message
                        });
                    }
                }
            }
            // Calculate SL/TP based on fill (if bot didn't provide them)
            // Note: Most bots manage their own SL/TP, so this is optional
            else if (!fill.stopLoss && !fill.takeProfit && this.config.sltpConfig?.calculateSLTP === true) {
                sltpLevels = this.sltpCalculator.calculateFromFill(fill);
                
                // Record SL/TP calculation in metrics
                if (this.metricsCollector) {
                    this.metricsCollector.recordSLTPCalculation({
                        ...sltpLevels,
                        orderId: fill.orderId
                    });
                }
            }
            
            // Store fill information
            this.state.fills.set(fill.orderId, {
                ...fill,
                sltpLevels: sltpLevels || { calculated: false, reason: 'Bot-managed SL/TP' },
                processedAt: new Date()
            });
            
            // Update position tracking
            this.updatePosition(fill);
            
            // Update risk manager
            this.riskManager.updatePosition(fill.orderId, {
                instrument: fill.instrument,
                quantity: fill.quantity,
                side: fill.side,
                fillPrice: fill.fillPrice
            });
            
            // Record fill latency
            if (this.metricsCollector) {
                const order = this.state.orders.get(fill.orderId);
                if (order && order.submittedAt) {
                    const fillLatency = fillProcessingStart - order.submittedAt.getTime();
                    this.metricsCollector.recordFill(fill, fillLatency);
                }
            }
            
            this.emit('fillProcessed', {
                fill,
                sltpLevels: sltpLevels || { calculated: false, reason: 'Bot-managed SL/TP' },
                riskEnforced: true
            });
            
        } catch (error) {
            this.log('error', 'Error processing fill', {
                fillId: fill.orderId,
                error: error.message
            });
        }
    }
    
    /**
     * Update position tracking
     */
    updatePosition(fill) {
        const positionKey = `${fill.instrument}_${fill.source || 'UNKNOWN'}`;
        const existingPosition = this.state.positions.get(positionKey) || {
            instrument: fill.instrument,
            quantity: 0,
            avgPrice: 0,
            realized: 0,
            unrealized: 0
        };
        
        // Update position quantity and average price
        if (fill.side === 'BUY') {
            const totalCost = (existingPosition.quantity * existingPosition.avgPrice) + 
                            (fill.quantity * fill.fillPrice);
            existingPosition.quantity += fill.quantity;
            existingPosition.avgPrice = existingPosition.quantity > 0 
                ? totalCost / existingPosition.quantity 
                : 0;
        } else {
            // SELL
            if (existingPosition.quantity > 0) {
                // Closing long position
                const closedQty = Math.min(existingPosition.quantity, fill.quantity);
                const pnl = ((fill.fillPrice - existingPosition.avgPrice) * closedQty) - 1.24; // Include $1.24 round-trip commission
                existingPosition.realized += pnl;
                existingPosition.quantity -= closedQty;
            }
        }
        
        this.state.positions.set(positionKey, existingPosition);
    }
    
    /**
     * Handle incoming order from Redis (manual trading or other sources)
     */
    async handleIncomingOrder(orderMessage) {
        try {
            this.log('info', 'Received order from Redis', {
                type: orderMessage.type,
                source: orderMessage.source || 'unknown',
                timestamp: orderMessage.timestamp
            });
            
            // Extract order payload based on message type
            if (orderMessage.type === 'MANUAL_ORDER' && orderMessage.order) {
                // New format from manual trading
                const order = {
                    id: orderMessage.order.orderId || `AGG-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    source: orderMessage.source || 'manual-trading-v2',
                    instrument: orderMessage.order.instrument,
                    action: orderMessage.order.side, // side field contains BUY/SELL
                    quantity: orderMessage.order.quantity,
                    type: orderMessage.order.orderType || 'MARKET',
                    price: orderMessage.order.limitPrice || null,
                    // Convert manual trading's stopPrice/limitPrice to SL/TP structure
                    stopLoss: orderMessage.order.stopLossPoints ? {
                        type: 'points',
                        value: orderMessage.order.stopLossPoints
                    } : null,
                    takeProfit: orderMessage.order.takeProfitPoints ? {
                        type: 'points',
                        value: orderMessage.order.takeProfitPoints
                    } : null,
                    accountId: orderMessage.order.accountId,
                };
                
                // DEBUG: Log SL/TP extraction
                this.log('info', '[SLTP-DEBUG] SL/TP Extraction Analysis', {
                    orderId: order.id,
                    rawStopLossPoints: orderMessage.order.stopLossPoints,
                    rawTakeProfitPoints: orderMessage.order.takeProfitPoints,
                    hasStopLossPoints: !!orderMessage.order.stopLossPoints,
                    hasTakeProfitPoints: !!orderMessage.order.takeProfitPoints,
                    extractedStopLoss: order.stopLoss,
                    extractedTakeProfit: order.takeProfit,
                    allOrderKeys: Object.keys(orderMessage.order || {}),
                    stopLossLogic: `${orderMessage.order.stopLossPoints} ? {type: 'points', value: ${orderMessage.order.stopLossPoints}} : null = ${JSON.stringify(order.stopLoss)}`,
                    takeProfitLogic: `${orderMessage.order.takeProfitPoints} ? {type: 'points', value: ${orderMessage.order.takeProfitPoints}} : null = ${JSON.stringify(order.takeProfit)}`
                });
                
                const finalOrder = {
                    ...order,
                    metadata: {
                        originalOrderId: orderMessage.order.orderId,
                        source: orderMessage.source,
                        timestamp: orderMessage.timestamp || new Date().toISOString(),
                        instanceId: orderMessage.order.instanceId || 'MANUAL_TRADING',
                        stopPrice: orderMessage.order.stopPrice,
                        limitPrice: orderMessage.order.limitPrice
                    }
                };
                
                this.log('info', 'Extracted order from MANUAL_ORDER message', {
                    orderId: finalOrder.id,
                    instrument: order.instrument,
                    action: order.action,
                    quantity: order.quantity,
                    accountId: order.accountId,
                    hasMetadata: !!order.metadata
                });
                
                // Log SL/TP details specifically
                if (order.metadata.stopLoss || order.metadata.takeProfit) {
                    this.logger.logSLTP('Manual Order SL/TP Extracted', {
                        orderId: order.id,
                        stopLoss: order.metadata.stopLoss,
                        takeProfit: order.metadata.takeProfit,
                        stopLossPoints: orderMessage.order.stopLossPoints,
                        takeProfitPoints: orderMessage.order.takeProfitPoints
                    });
                }
                
                // Submit order through normal aggregator flow
                const result = await this.submitOrder(finalOrder);
                
                this.log('info', 'Manual order processed', {
                    orderId: finalOrder.id,
                    success: result.success,
                    source: finalOrder.source,
                    instrument: finalOrder.instrument,
                    action: finalOrder.action,
                    quantity: finalOrder.quantity
                });
                
                return result;
            } else if (orderMessage.type === 'PLACE_ORDER' && orderMessage.payload) {
                // Legacy format for backward compatibility
                const order = {
                    id: orderMessage.payload.orderId || `AGG-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    source: orderMessage.source || 'manual-trading',
                    instrument: orderMessage.payload.instrument,
                    action: orderMessage.payload.action,
                    quantity: orderMessage.payload.quantity,
                    type: orderMessage.payload.orderType || 'MARKET',
                    price: orderMessage.payload.price || null,
                    stopLoss: orderMessage.payload.stopLossPoints ? {
                        type: 'points',
                        value: orderMessage.payload.stopLossPoints
                    } : null,
                    takeProfit: orderMessage.payload.takeProfitPoints ? {
                        type: 'points',
                        value: orderMessage.payload.takeProfitPoints
                    } : null,
                    account: orderMessage.payload.account || orderMessage.payload.accountId,
                    metadata: {
                        originalOrderId: orderMessage.payload.orderId,
                        source: orderMessage.source,
                        timestamp: orderMessage.timestamp || new Date().toISOString()
                    }
                };

                // Debug logging for PLACE_ORDER SL/TP extraction
                this.log('info', '[SLTP-DEBUG] PLACE_ORDER SL/TP Extraction Analysis', {
                    orderId: order.id,
                    rawStopLossPoints: orderMessage.payload.stopLossPoints,
                    rawTakeProfitPoints: orderMessage.payload.takeProfitPoints,
                    extractedStopLoss: order.stopLoss,
                    extractedTakeProfit: order.takeProfit,
                    hasStopLoss: !!order.stopLoss,
                    hasTakeProfit: !!order.takeProfit,
                    orderType: orderMessage.type,
                    source: 'PLACE_ORDER path'
                });
                
                // Submit order through normal aggregator flow
                const result = await this.submitOrder(order);
                
                this.log('info', 'Legacy order processed', {
                    orderId: order.id,
                    success: result.success,
                    source: order.source
                });
                
                return result;
            } else {
                this.log('warn', 'Unknown order message type - IGNORING', {
                    type: orderMessage.type,
                    source: orderMessage.source,
                    messageKeys: Object.keys(orderMessage)
                });
                return { success: false, error: 'Unknown message type', type: orderMessage.type };
            }
        } catch (error) {
            this.log('error', 'Failed to handle incoming order', {
                error: error.message,
                orderMessage
            });
            throw error;
        }
    }
    
    /**
     * Handle order failure
     */
    handleOrderFailure(event) {
        const { order, error } = event;
        
        this.state.metrics.ordersFailed++;
        
        const trackedOrder = this.state.orders.get(order.id);
        if (trackedOrder) {
            trackedOrder.status = 'FAILED';
            trackedOrder.error = error.message;
            trackedOrder.failedAt = new Date();
        }
        
        if (order.source) {
            this.botRegistry.recordOrder(order.source, order, { 
                success: false, 
                error: error.message 
            });
        }
        
        this.emit('orderFailed', {
            order,
            error: error.message,
            riskEnforced: true
        });
    }
    
    /**
     * Normalize order data
     */
    normalizeOrder(order) {
        // Handle undefined/null order
        if (!order) {
            this.log('warn', 'Attempted to normalize undefined/null order');
            return {
                id: this.generateOrderId(),
                source: 'UNKNOWN',
                instrument: 'UNKNOWN',
                action: 'UNKNOWN',
                type: 'MARKET',
                quantity: 0,
                price: null,
                stopLoss: null,
                takeProfit: null,
                accountId: null,
                urgent: false,
                metadata: { error: 'Invalid order data' },
                timestamp: new Date()
            };
        }
        
        return {
            id: order.id || this.generateOrderId(),
            source: order.source || 'UNKNOWN',
            instrument: order.instrument || order.symbol,
            action: order.action || order.side, // BUY/SELL
            type: order.type || 'MARKET', // MARKET/LIMIT
            quantity: parseInt(order.quantity || order.qty) || 0,
            price: parseFloat(order.price) || null,
            stopLoss: order.stopLoss || null,
            takeProfit: order.takeProfit || null,
            accountId: order.accountId || order.account,
            urgent: order.urgent || false,
            metadata: order.metadata || {},
            timestamp: new Date(),
            // CRITICAL FIX: Preserve SL/TP price and points fields from Manual Trading
            stopPrice: order.stopPrice !== undefined ? parseFloat(order.stopPrice) : undefined,
            stopLossPoints: order.stopLossPoints !== undefined ? parseFloat(order.stopLossPoints) : undefined,
            limitPrice: order.limitPrice !== undefined ? parseFloat(order.limitPrice) : undefined,
            takeProfitPoints: order.takeProfitPoints !== undefined ? parseFloat(order.takeProfitPoints) : undefined
        };
    }
    
    /**
     * Simulate market price for testing
     */
    simulateMarketPrice(instrument) {
        // Simple price simulation
        const basePrices = {
            MES: 4500,
            MNQ: 15000,
            MGC: 1800,
            MCL: 75,
            M2K: 2000,
            MYM: 35000
        };
        
        const base = basePrices[instrument] || 100;
        const variation = (Math.random() - 0.5) * 0.002; // 0.2% variation
        
        return base * (1 + variation);
    }
    
    /**
     * Initialize Redis integration
     */
    async initializeRedis() {
        try {
            // Skip if adapter already provided externally
            if (this.redisAdapter) {
                this.log('info', 'Using externally provided Redis adapter');
            } else {
                this.redisAdapter = new RedisAdapter({
                    ...this.config.redisConfig
                    // REMOVED: shadowMode parameter
                });
            }
            
            // Set up event handlers
            this.redisAdapter.on('connected', (info) => {
                this.log('info', 'Redis adapter connected', info);
                if (this.metricsCollector) {
                    this.metricsCollector.updateConnectionStatus('redis', 'connected');
                }
            });
            
            this.redisAdapter.on('connectionError', (error) => {
                this.log('error', 'Redis connection error', error);
                if (this.metricsCollector) {
                    this.metricsCollector.updateConnectionStatus('redis', 'error');
                }
            });
            
            this.redisAdapter.on('parseError', (error) => {
                this.log('error', 'Redis message parse error', error);
            });
            
            // Subscribe to orders from manual trading and other sources
            await this.redisAdapter.subscribeToOrders(async (orderMessage) => {
                await this.handleIncomingOrder(orderMessage);
            });
            
            // Subscribe to fill events from connection manager
            await this.redisAdapter.subscribeToFills((fillData) => {
                this.handleExternalFill(fillData);
            });
            
            // Subscribe to market data for position updates
            await this.redisAdapter.subscribeToMarketData((marketData) => {
                this.handleMarketDataUpdate(marketData);
            });
            
            // Subscribe to control messages
            await this.redisAdapter.subscribeToControl((controlData) => {
                this.handleControlMessage(controlData);
            });
            
            // Subscribe to aggregator requests (from manual trading) and forward to connection manager
            await this.redisAdapter.subscribeToAggregatorRequests();
            
            // Subscribe to P&L requests from P&L module and forward to connection manager
            this.log('info', 'About to subscribe to P&L requests...');
            await this.redisAdapter.subscribeToPnLRequests();
            this.log('info', 'P&L subscription completed successfully');
            
            this.log('info', 'Redis adapter initialized with subscriptions');
            
        } catch (error) {
            this.log('error', 'Failed to initialize Redis adapter', { error: error.message });
            throw error;
        }
    }
    
    /**
     * Initialize Connection Manager integration
     */
    async initializeConnectionManager() {
        try {
            // Skip if adapter already provided externally
            if (this.connectionManagerAdapter) {
                this.log('info', 'Using externally provided Connection Manager adapter');
            } else {
                this.connectionManagerAdapter = new ConnectionManagerAdapter({
                    connectionManagerUrl: this.config.connectionManagerUrl
                    // REMOVED: shadowMode parameter
                });
            }
            
            // Pass ConnectionManagerAdapter to RiskManager for real account balance access
            this.riskManager.connectionManagerAdapter = this.connectionManagerAdapter;
            
            // Set up event handlers
            this.connectionManagerAdapter.on('connected', (info) => {
                this.log('info', 'Connection Manager adapter connected', info);
                if (this.metricsCollector) {
                    this.metricsCollector.updateConnectionStatus('connectionManager', 'connected');
                }
            });
            
            this.connectionManagerAdapter.on('connectionError', (error) => {
                this.log('error', 'Connection Manager connection error', error);
                if (this.metricsCollector) {
                    this.metricsCollector.updateConnectionStatus('connectionManager', 'error');
                }
            });
            
            this.connectionManagerAdapter.on('fill', (fillData) => {
                this.handleExternalFill(fillData);
            });
            
            this.connectionManagerAdapter.on('orderStatus', (statusData) => {
                this.handleOrderStatusUpdate(statusData);
            });
            
            this.connectionManagerAdapter.on('positionUpdate', (positionData) => {
                this.handlePositionUpdate(positionData);
            });
            
            this.connectionManagerAdapter.on('marketData', (marketData) => {
                this.handleMarketDataUpdate(marketData);
            });
            
            // Connect to the connection manager
            await this.connectionManagerAdapter.connect();
            
            this.log('info', 'Connection Manager adapter initialized');
            
        } catch (error) {
            this.log('error', 'Failed to initialize Connection Manager adapter', { error: error.message });
            throw error;
        }
    }
    
    /**
     * Get aggregator metrics
     */
    getMetrics() {
        const queueMetrics = this.queueManager.getMetrics();
        const riskReport = this.riskManager.getRiskReport();
        const registryStats = this.botRegistry.getStatistics();
        const sltpStats = this.sltpCalculator.getStatistics();
        
        return {
            aggregator: {
                status: this.state.status,
                uptime: Date.now() - this.state.startTime.getTime(),
                riskEnforced: true,
                ...this.state.metrics
            },
            queue: queueMetrics,
            risk: riskReport,
            registry: registryStats,
            sltp: sltpStats,
            positions: Array.from(this.state.positions.values())
        };
    }
    
    /**
     * Report metrics
     */
    reportMetrics() {
        const metrics = this.getMetrics();
        
        this.emit('metrics', metrics);
        
        if (this.config.logLevel === 'debug') {
            this.log('debug', 'Metrics Report', metrics);
        }
    }
    
    /**
     * Log message
     */
    log(level, message, data = {}) {
        if (!this.config.enableLogging) return;
        
        const logEntry = {
            timestamp: new Date().toISOString(),
            level,
            component: 'TradingAggregator',
            message,
            ...data
        };
        
        // Also log to file
        if (this.fileLogger) {
            this.fileLogger.log(level, message, data);
        }
        
        // In production, this would go to a proper logging service
        console.log(JSON.stringify(logEntry));
    }
    
    /**
     * Generate order ID
     */
    generateOrderId() {
        return `AGG_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    /**
     * Handle external fill event from connection manager or Redis
     */
    async handleExternalFill(fillData) {
        try {
            this.log('info', 'Received external fill event', {
                orderId: fillData.orderId,
                instrument: fillData.instrument,
                fillPrice: fillData.fillPrice,
                quantity: fillData.quantity
            });
            
            // Process the fill through our standard fill processing
            await this.processFill(fillData);
            
            // Check if we have pending SL/TP for this order
            if (this.state.pendingSLTP?.has(fillData.orderId)) {
                this.log('info', 'Fill received for order with pending SL/TP', {
                    orderId: fillData.orderId,
                    hasPendingSLTP: true
                });
                
                // Request position update after a short delay to ensure position is created
                setTimeout(() => {
                    this.requestPositionForSLTP(fillData.orderId);
                }, 500); // Reduced from 2000ms to 500ms
            }
            
        } catch (error) {
            this.log('error', 'Error processing external fill', {
                fillData,
                error: error.message
            });
        }
    }
    
    /**
     * Handle order status updates from connection manager
     */
    handleOrderStatusUpdate(statusData) {
        const { orderId, status, topstepOrderId } = statusData;
        
        this.log('info', 'Order status update received', {
            orderId,
            status,
            topstepOrderId
        });
        
        // Update order status if we're tracking it
        const trackedOrder = this.state.orders.get(orderId);
        if (trackedOrder) {
            trackedOrder.status = status;
            trackedOrder.lastUpdated = new Date();
            if (topstepOrderId) {
                trackedOrder.topstepOrderId = topstepOrderId;
            }
            
            this.emit('orderStatusChanged', {
                orderId,
                status,
                order: trackedOrder
            });
            
            // Don't handle SL/TP here - wait for fill event instead
            if (status === 'ORDER_SENT' && this.state.pendingSLTP?.has(orderId)) {
                this.log('info', 'Order sent successfully, waiting for fill event to apply SL/TP', {
                    orderId,
                    topstepOrderId
                });
            }
        }
    }
    
    /**
     * Handle position updates from connection manager
     */
    handlePositionUpdate(positionData) {
        this.log('info', 'Position update received', positionData);
        
        // Update position tracking
        // This could integrate with risk manager position tracking
        this.emit('positionUpdate', positionData);
    }
    
    /**
     * Handle market data updates with proper channel separation
     */
    async handleMarketDataUpdate(marketData) {
        // Update position P&L calculations if needed
        this.emit('marketDataUpdate', marketData);
        
        // Only log market data in debug mode to avoid spam
        if (this.config.logLevel === 'debug' && this.config.logMarketData !== false) {
            this.log('debug', 'Handling market data update', {
                type: marketData.type,
                payloadType: marketData.payload?.type,
                instrument: marketData.payload?.instrument
            });
        }
        
        // CRITICAL FIX: Separate position updates from market data
        if (this.redisAdapter) {
            try {
                // Check if this is a position update that should go to position channel instead
                const isPositionUpdate = marketData.type === 'POSITION_UPDATE' || 
                                       (marketData.payload && marketData.payload.type === 'POSITION_UPDATE');
                
                if (isPositionUpdate) {
                    // Route position updates to dedicated position channel
                    this.log('info', 'Routing position update to dedicated position channel', {
                        type: marketData.type,
                        payloadType: marketData.payload?.type
                    });
                    
                    // Publish to position-specific channel
                    const positionData = {
                        ...marketData,
                        processedBy: 'aggregator',
                        timestamp: Date.now(),
                        channel: 'position-updates'
                    };
                    
                    await this.redisAdapter.publish('aggregator:position-updates', positionData);
                    this.emit('positionUpdateRouted', positionData);
                    
                } else {
                    // Only republish actual market data (QUOTE, TRADE, DEPTH) to market data channel
                    const isMarketData = marketData.type === 'MARKET_DATA' ||
                                       (marketData.payload && ['QUOTE', 'TRADE', 'DEPTH'].includes(marketData.payload.type));
                    
                    if (isMarketData) {
                        // Extract the actual market data from the wrapper
                        let dataToPublish;
                        
                        // If it's wrapped in { type: 'MARKET_DATA', payload: {...} }
                        if (marketData.type === 'MARKET_DATA' && marketData.payload) {
                            dataToPublish = {
                                ...marketData.payload,
                                processedBy: 'aggregator',
                                timestamp: Date.now(),
                                channel: 'market-data'
                            };
                        } else {
                            // Otherwise publish as-is
                            dataToPublish = {
                                ...marketData,
                                processedBy: 'aggregator',
                                timestamp: Date.now(),
                                channel: 'market-data'
                            };
                        }
                        
                        await this.redisAdapter.publish(this.redisAdapter.config.channels.aggregatorMarketData, dataToPublish);
                        this.emit('marketDataRepublished', dataToPublish);
                        
                        // Only log republishing in debug mode
                        if (this.config.logLevel === 'debug' && this.config.logMarketData !== false) {
                            this.log('debug', 'Republished market data', {
                                channel: this.redisAdapter.config.channels.aggregatorMarketData,
                                type: dataToPublish.type,
                                instrument: dataToPublish.instrument
                            });
                        }
                    } else {
                        // Unknown data type - log for debugging
                        this.log('warn', 'Unknown data type received in market data update', {
                            type: marketData.type,
                            payloadType: marketData.payload?.type,
                            keys: Object.keys(marketData)
                        });
                    }
                }
                
            } catch (error) {
                this.log('error', 'Failed to process market data update', { error: error.message });
            }
        }
    }
    
    /**
     * Handle control messages from Redis
     */
    handleControlMessage(controlData) {
        const { command, data } = controlData;
        
        this.log('info', 'Control message received', {
            command,
            data
        });
        
        switch (command) {
            case 'HEARTBEAT':
                // Respond to heartbeat if needed
                break;
                
            case 'SHUTDOWN':
                this.log('info', 'Shutdown command received');
                this.shutdown();
                break;
                
            case 'PAUSE_PROCESSING':
                this.queueManager.pauseProcessing();
                break;
                
            case 'RESUME_PROCESSING':
                this.queueManager.resumeProcessing();
                break;
                
            default:
                this.log('warn', 'Unknown control command', { command });
        }
    }
    
    /**
     * Request position data for SL/TP update
     */
    async requestPositionForSLTP(orderId) {
        try {
            const pendingSLTP = this.state.pendingSLTP?.get(orderId);
            if (!pendingSLTP) {
                this.log('warn', 'No pending SL/TP found for order', { orderId });
                return;
            }
            
            const trackedOrder = this.state.orders.get(orderId);
            if (!trackedOrder || !trackedOrder.accountId) {
                this.log('warn', 'No tracked order or accountId found', { orderId });
                return;
            }
            
            this.log('info', 'Requesting positions from Connection Manager', {
                orderId,
                accountId: trackedOrder.accountId
            });
            
            // Request positions from Connection Manager
            const positions = await this.connectionManagerAdapter.getPositions(trackedOrder.accountId);
            
            if (!positions || positions.length === 0) {
                this.log('warn', 'No positions found, retrying in 1 second', { orderId });
                // Retry after 1 second
                setTimeout(() => {
                    this.requestPositionForSLTP(orderId);
                }, 1000); // Reduced from 2000ms
                return;
            }
            
            // Find matching position by instrument
            const matchingPosition = positions.find(pos => 
                pos.symbol === pendingSLTP.instrument || 
                pos.instrument === pendingSLTP.instrument
            );
            
            if (matchingPosition) {
                this.log('info', 'Found matching position, applying SL/TP', {
                    orderId,
                    positionId: matchingPosition.id,
                    instrument: matchingPosition.symbol || matchingPosition.instrument
                });
                
                await this.applySLTPToPosition(orderId, matchingPosition);
            } else {
                this.log('warn', 'No matching position found, retrying', {
                    orderId,
                    instrument: pendingSLTP.instrument,
                    positionsFound: positions.length
                });
                
                // Retry after 1 second
                setTimeout(() => {
                    this.requestPositionForSLTP(orderId);
                }, 1000); // Reduced from 2000ms
            }
            
        } catch (error) {
            this.log('error', 'Error requesting position for SL/TP', {
                orderId,
                error: error.message
            });
            
            // Retry on error
            setTimeout(() => {
                this.requestPositionForSLTP(orderId);
            }, 3000);
        }
    }
    
    /**
     * Apply SL/TP to position
     */
    async applySLTPToPosition(orderId, position) {
        try {
            const pendingSLTP = this.state.pendingSLTP?.get(orderId);
            if (!pendingSLTP) {
                this.log('warn', 'No pending SL/TP found for order', { orderId });
                return;
            }
            
            const fillPrice = position.avgPrice || position.price;
            if (!fillPrice) {
                this.log('error', 'No fill price found in position', {
                    orderId,
                    position
                });
                return;
            }
            
            // Calculate SL/TP prices from points/dollars
            const { stopLossPrice, takeProfitPrice } = this.calculateSLTPPrices(
                pendingSLTP.instrument,
                pendingSLTP.side,
                fillPrice,
                pendingSLTP.stopLoss,
                pendingSLTP.takeProfit
            );
            
            this.log('info', 'Calculated SL/TP prices', {
                orderId,
                fillPrice,
                stopLossPrice,
                takeProfitPrice,
                stopLoss: pendingSLTP.stopLoss,
                takeProfit: pendingSLTP.takeProfit
            });
            
            // Send SL/TP update through Connection Manager for proper logging
            const updateData = {
                accountId: pendingSLTP.accountId,
                positionId: position.id,
                stopLoss: stopLossPrice,
                takeProfit: takeProfitPrice
            };
            
            const result = await this.sendSLTPUpdate(updateData);
            
            if (result.success) {
                this.log('info', '✅ Successfully applied SL/TP to position', {
                    orderId,
                    positionId: position.id,
                    stopLossPrice,
                    takeProfitPrice
                });
                
                // Remove from pending
                this.state.pendingSLTP.delete(orderId);
                
                // Emit event
                this.emit('sltpApplied', {
                    orderId,
                    positionId: position.id,
                    stopLossPrice,
                    takeProfitPrice
                });
            } else {
                this.log('error', 'Failed to apply SL/TP', {
                    orderId,
                    result
                });
            }
            
        } catch (error) {
            this.log('error', 'Error applying SL/TP to position', {
                orderId,
                error: error.message
            });
        }
    }
    
    /**
     * Get point value for an instrument
     * TODO: This should retrieve from actual contract data
     */
    getPointValueForInstrument(instrument) {
        // WARNING: This should be getting the actual point value from contract data
        // For now, we'll return null which will cause SL/TP calculations to fail
        // This forces the system to use proper contract data
        this.log('warn', `⚠️ getPointValueForInstrument called but contract data not available for ${instrument}`);
        this.log('warn', '⚠️ SL/TP calculations will fail until contract data is properly passed through the system');
        return null;
    }
    
    /**
     * Calculate SL/TP prices from points or dollar values
     */
    calculateSLTPPrices(instrument, side, fillPrice, stopLoss, takeProfit) {
        let stopLossPrice = null;
        let takeProfitPrice = null;
        
        // Get point value for the instrument from contract data
        // This should be passed in or retrieved from the contract data
        const pointValue = this.getPointValueForInstrument(instrument);
        
        if (!pointValue) {
            this.log('error', `Cannot calculate SL/TP prices - no point value available for ${instrument}`);
            return { stopLossPrice: null, takeProfitPrice: null };
        }
        
        const isBuy = side === 'BUY';
        
        // Calculate stop loss price
        if (stopLoss) {
            if (stopLoss.type === 'points') {
                // For points, subtract from fill price for longs, add for shorts
                stopLossPrice = isBuy 
                    ? fillPrice - stopLoss.value
                    : fillPrice + stopLoss.value;
            } else if (stopLoss.type === 'dollars') {
                // For dollars, convert to points then to price
                const points = stopLoss.value / pointValue;
                stopLossPrice = isBuy 
                    ? fillPrice - points
                    : fillPrice + points;
            }
        }
        
        // Calculate take profit price
        if (takeProfit) {
            if (takeProfit.type === 'points') {
                // For points, add to fill price for longs, subtract for shorts
                takeProfitPrice = isBuy 
                    ? fillPrice + takeProfit.value
                    : fillPrice - takeProfit.value;
            } else if (takeProfit.type === 'dollars') {
                // For dollars, convert to points then to price
                const points = takeProfit.value / pointValue;
                takeProfitPrice = isBuy 
                    ? fillPrice + points
                    : fillPrice - points;
            }
        }
        
        return { stopLossPrice, takeProfitPrice };
    }
    
    /**
     * Send SL/TP update through Connection Manager
     */
    async sendSLTPUpdate(updateData) {
        try {
            this.log('info', 'Sending SL/TP update through Connection Manager', updateData);
            
            // Send through Connection Manager adapter for proper logging and centralized control
            const result = await this.connectionManagerAdapter.updatePositionSLTP({
                accountId: updateData.accountId,
                positionId: updateData.positionId,
                stopLoss: updateData.stopLoss,
                takeProfit: updateData.takeProfit
            });
            
            this.log('info', 'SL/TP update response from Connection Manager', result);
            
            return result;
            
        } catch (error) {
            this.log('error', 'Failed to send SL/TP update', {
                error: error.message
            });
            
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Shutdown aggregator
     */
    async shutdown() {
        this.state.status = 'SHUTTING_DOWN';
        
        // Stop queue processing
        this.queueManager.stopProcessing();
        
        // Clear intervals
        if (this.metricsInterval) {
            clearInterval(this.metricsInterval);
        }
        
        // Stop monitoring components
        if (this.metricsCollector) {
            this.metricsCollector.stop();
        }
        
        if (this.monitoringServer) {
            await this.monitoringServer.stop();
        }
        
        if (this.redisMetricsPublisher) {
            await this.redisMetricsPublisher.disconnect();
        }
        
        // Disconnect adapters
        if (this.redisAdapter) {
            await this.redisAdapter.disconnect();
        }
        
        if (this.connectionManagerAdapter) {
            this.connectionManagerAdapter.disconnect();
        }
        
        // Report final metrics
        this.reportMetrics();
        
        this.state.status = 'STOPPED';
        this.emit('shutdown');
    }

    /**
     * Validate quantity for SL/TP order creation
     * Fixes the vulnerability at lines 574-596
     */
    validateQuantityForSLTP(fill, originalOrder) {
        const fillQuantity = fill?.quantity;
        const originalQuantity = originalOrder?.quantity;
        
        // Determine the valid quantity
        let validQuantity;
        if (fillQuantity !== null && fillQuantity !== undefined && !isNaN(fillQuantity)) {
            validQuantity = fillQuantity;
        } else if (originalQuantity !== null && originalQuantity !== undefined && !isNaN(originalQuantity)) {
            validQuantity = originalQuantity;
        } else {
            return {
                isValid: false,
                reason: `Invalid quantities - fill: ${fillQuantity}, original: ${originalQuantity}`
            };
        }

        if (validQuantity <= 0) {
            return {
                isValid: false,
                reason: `Quantity must be positive, got: ${validQuantity}`
            };
        }

        return {
            isValid: true,
            quantity: validQuantity
        };
    }

    /**
     * Handle SL/TP order creation with proper validation
     * Replaces the vulnerable code at lines 574-596
     */
    async handleSLTPCreation(fill, originalOrder, sltpLevels) {
        // Validate quantity first
        const quantityValidation = this.validateQuantityForSLTP(fill, originalOrder);
        if (!quantityValidation.isValid) {
            throw new Error(`SL/TP quantity validation failed: ${quantityValidation.reason}`);
        }

        const validQuantity = quantityValidation.quantity;
        const results = [];

        // Send Stop Loss order
        if (sltpLevels.stopLoss) {
            const slOrder = {
                instrument: originalOrder.instrument,
                side: fill.side === 'BUY' ? 'SELL' : 'BUY',
                quantity: validQuantity,
                price: sltpLevels.stopLoss,
                type: 'STOP',
                parentOrderId: fill.orderId
            };

            const slResult = await this.connectionManager.sendOrder(slOrder);
            results.push({ type: 'STOP_LOSS', result: slResult });
        }

        // Send Take Profit order
        if (sltpLevels.takeProfit) {
            const tpOrder = {
                instrument: originalOrder.instrument,
                side: fill.side === 'BUY' ? 'SELL' : 'BUY',
                quantity: validQuantity,
                price: sltpLevels.takeProfit,
                type: 'LIMIT',
                parentOrderId: fill.orderId
            };

            const tpResult = await this.connectionManager.sendOrder(tpOrder);
            results.push({ type: 'TAKE_PROFIT', result: tpResult });
        }

        return results;
    }
}

module.exports = TradingAggregator;