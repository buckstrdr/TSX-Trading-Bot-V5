/**
 * Manual Trading Integration Layer
 * Routes manual trading orders through the aggregator for risk validation and SL/TP calculation
 * Maintains backward compatibility with existing manual trading workflow
 */

const EventEmitter = require('events');
const TradingAggregator = require('../TradingAggregator');

class ManualTradingIntegration extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Integration settings
            shadowMode: config.shadowMode !== false, // Default to shadow mode for safety
            manualTradingServerUrl: config.manualTradingServerUrl || 'http://localhost:3003',
            connectionManagerUrl: config.connectionManagerUrl || 'http://localhost:7500',
            redisConfig: config.redisConfig || { host: 'localhost', port: 6379 },
            
            // Aggregator configuration
            aggregatorConfig: config.aggregatorConfig || {},
            
            // Integration options
            interceptOrders: config.interceptOrders !== false, // Intercept orders by default
            enableRiskValidation: config.enableRiskValidation !== false,
            enableSLTPCalculation: config.enableSLTPCalculation !== false,
            preserveOriginalWorkflow: config.preserveOriginalWorkflow !== false,
            
            // Logging
            enableLogging: config.enableLogging !== false,
            logLevel: config.logLevel || 'info'
        };
        
        // Initialize aggregator with integration-specific config
        this.aggregator = new TradingAggregator({
            ...this.config.aggregatorConfig,
            shadowMode: this.config.shadowMode,
            connectionManagerUrl: this.config.connectionManagerUrl,
            redisConfig: this.config.redisConfig,
            enableLogging: this.config.enableLogging,
            logLevel: this.config.logLevel
        });
        
        // State tracking
        this.state = {
            status: 'INITIALIZING',
            interceptedOrders: new Map(),
            originalOrders: new Map(),
            fillEvents: new Map(),
            startTime: new Date(),
            metrics: {
                ordersIntercepted: 0,
                ordersProcessed: 0,
                ordersPassed: 0,
                ordersRejected: 0,
                riskViolations: 0,
                sltpCalculated: 0
            }
        };
        
        // Redis integration for order interception
        this.redisClient = null;
        this.redisSubscriber = null;
        
        // Initialize
        this.initialize();
    }
    
    /**
     * Initialize the integration layer
     */
    async initialize() {
        try {
            this.log('info', 'Initializing Manual Trading Integration Layer', {
                shadowMode: this.config.shadowMode,
                interceptOrders: this.config.interceptOrders,
                enableRiskValidation: this.config.enableRiskValidation,
                enableSLTPCalculation: this.config.enableSLTPCalculation
            });
            
            // Initialize aggregator
            await this.waitForAggregatorReady();
            
            // Set up aggregator event listeners
            this.setupAggregatorListeners();
            
            // Initialize Redis for order interception
            if (this.config.interceptOrders) {
                await this.initializeRedis();
                this.setupOrderInterception();
            }
            
            this.state.status = 'READY';
            this.emit('ready', {
                shadowMode: this.config.shadowMode,
                interceptOrders: this.config.interceptOrders
            });
            
            this.log('info', 'Manual Trading Integration Layer ready', {
                status: this.state.status,
                aggregatorStatus: this.aggregator.state.status
            });
            
        } catch (error) {
            this.state.status = 'ERROR';
            this.log('error', 'Failed to initialize integration layer', { error: error.message });
            throw error;
        }
    }
    
    /**
     * Wait for aggregator to be ready
     */
    async waitForAggregatorReady() {
        return new Promise((resolve, reject) => {
            if (this.aggregator.state.status === 'READY') {
                resolve();
                return;
            }
            
            const timeout = setTimeout(() => {
                reject(new Error('Aggregator initialization timeout'));
            }, 30000);
            
            this.aggregator.once('ready', () => {
                clearTimeout(timeout);
                resolve();
            });
            
            this.aggregator.once('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
        });
    }
    
    /**
     * Set up aggregator event listeners
     */
    setupAggregatorListeners() {
        // Order submitted to aggregator
        this.aggregator.on('orderSubmitted', (event) => {
            this.log('info', 'Order submitted to aggregator', {
                orderId: event.order.id,
                queueId: event.queueId,
                priority: event.priority
            });
            
            this.emit('orderProcessing', {
                originalOrderId: event.order.metadata.originalOrderId,
                aggregatorOrderId: event.order.id,
                queueId: event.queueId,
                status: 'PROCESSING'
            });
        });
        
        // Order rejected by aggregator
        this.aggregator.on('orderRejected', (event) => {
            this.state.metrics.ordersRejected++;
            if (event.reason === 'RISK_VIOLATION') {
                this.state.metrics.riskViolations++;
            }
            
            this.log('warn', 'Order rejected by aggregator', {
                orderId: event.order.id,
                reason: event.reason,
                violations: event.violations
            });
            
            this.handleOrderRejection(event);
        });
        
        // Order processed by aggregator
        this.aggregator.on('orderProcessed', (event) => {
            this.state.metrics.ordersProcessed++;
            
            this.log('info', 'Order processed by aggregator', {
                orderId: event.order.id,
                shadowMode: event.shadowMode
            });
            
            this.handleOrderProcessed(event);
        });
        
        // Fill processed by aggregator
        this.aggregator.on('fillProcessed', (event) => {
            this.state.metrics.sltpCalculated++;
            
            this.log('info', 'Fill processed with SL/TP calculation', {
                orderId: event.fill.orderId,
                fillPrice: event.fill.fillPrice,
                stopLoss: event.sltpLevels.stopLoss,
                takeProfit: event.sltpLevels.takeProfit,
                riskReward: event.sltpLevels.riskRewardRatio.toFixed(2)
            });
            
            this.handleFillProcessed(event);
        });
        
        // Aggregator metrics
        this.aggregator.on('metrics', (metrics) => {
            this.emit('metrics', {
                integration: this.getMetrics(),
                aggregator: metrics
            });
        });
    }
    
    /**
     * Initialize Redis for order interception
     */
    async initializeRedis() {
        const redis = require('redis');
        
        // Create Redis client
        this.redisClient = redis.createClient(this.config.redisConfig);
        
        // Create Redis subscriber
        this.redisSubscriber = redis.createClient(this.config.redisConfig);
        
        // Connect clients
        await Promise.all([
            this.redisClient.connect(),
            this.redisSubscriber.connect()
        ]);
        
        this.log('info', 'Redis clients connected for order interception');
    }
    
    /**
     * Set up order interception
     */
    setupOrderInterception() {
        // Subscribe to order management channel to intercept orders
        this.redisSubscriber.subscribe('order:management', (message) => {
            this.handleInterceptedOrder(message);
        });
        
        this.log('info', 'Order interception set up on order:management channel');
    }
    
    /**
     * Handle intercepted order from manual trading
     */
    async handleInterceptedOrder(message) {
        try {
            const orderMessage = JSON.parse(message);
            
            // Only intercept PLACE_ORDER messages from MANUAL_TRADING_V2
            if (orderMessage.type !== 'PLACE_ORDER' || 
                orderMessage.payload.instanceId !== 'MANUAL_TRADING_V2') {
                // Let other orders pass through
                return;
            }
            
            this.state.metrics.ordersIntercepted++;
            
            const originalOrder = orderMessage.payload;
            
            this.log('info', 'Intercepted manual trading order', {
                orderId: originalOrder.orderId,
                instrument: originalOrder.instrument,
                side: originalOrder.side,
                quantity: originalOrder.quantity
            });
            
            // Store original order
            this.state.originalOrders.set(originalOrder.orderId, originalOrder);
            
            // Convert to aggregator format
            const aggregatorOrder = this.convertToAggregatorFormat(originalOrder);
            
            // Submit to aggregator for processing
            const result = await this.aggregator.submitOrder(aggregatorOrder);
            
            if (result.success) {
                // Track the relationship between original and aggregator orders
                this.state.interceptedOrders.set(result.orderId, {
                    originalOrderId: originalOrder.orderId,
                    aggregatorOrderId: result.orderId,
                    queueId: result.queueId,
                    interceptedAt: new Date(),
                    status: 'INTERCEPTED'
                });
                
                this.log('info', 'Order successfully intercepted and queued', {
                    originalOrderId: originalOrder.orderId,
                    aggregatorOrderId: result.orderId,
                    queueId: result.queueId
                });
            } else {
                // If aggregator rejects, let original order proceed
                this.passOrderToConnectionManager(originalOrder, result.reason);
            }
            
        } catch (error) {
            this.log('error', 'Error handling intercepted order', {
                error: error.message,
                message: message.substring(0, 200)
            });
        }
    }
    
    /**
     * Convert manual trading order to aggregator format
     */
    convertToAggregatorFormat(originalOrder) {
        return {
            id: `MT_${originalOrder.orderId}`,
            source: 'MANUAL_TRADING_V2',
            instrument: originalOrder.instrument,
            action: originalOrder.side, // BUY/SELL
            type: originalOrder.orderType || 'MARKET',
            quantity: parseInt(originalOrder.quantity),
            price: parseFloat(originalOrder.limitPrice) || null,
            stopLoss: parseFloat(originalOrder.stopPrice) || null,
            takeProfit: parseFloat(originalOrder.limitPrice) || null,
            urgent: true, // Manual trading orders are typically urgent
            metadata: {
                originalOrderId: originalOrder.orderId,
                accountId: originalOrder.accountId,
                instanceId: originalOrder.instanceId,
                timestamp: originalOrder.timestamp
            }
        };
    }
    
    /**
     * Handle order rejection from aggregator
     */
    async handleOrderRejection(event) {
        const originalOrderId = event.order.metadata.originalOrderId;
        const originalOrder = this.state.originalOrders.get(originalOrderId);
        
        if (!originalOrder) {
            this.log('error', 'Cannot find original order for rejection', {
                aggregatorOrderId: event.order.id
            });
            return;
        }
        
        // Update interception status
        const interception = this.state.interceptedOrders.get(event.order.id);
        if (interception) {
            interception.status = 'REJECTED';
            interception.rejectionReason = event.reason;
            interception.violations = event.violations;
        }
        
        if (this.config.preserveOriginalWorkflow) {
            // Let original order proceed despite rejection
            this.log('info', 'Passing rejected order to Connection Manager (preserve workflow)', {
                originalOrderId,
                reason: event.reason
            });
            
            await this.passOrderToConnectionManager(originalOrder, event.reason);
        } else {
            // Block the order and notify manual trading
            this.log('warn', 'Blocking order due to aggregator rejection', {
                originalOrderId,
                reason: event.reason,
                violations: event.violations
            });
            
            await this.notifyManualTradingRejection(originalOrder, event);
        }
    }
    
    /**
     * Handle order processed by aggregator
     */
    async handleOrderProcessed(event) {
        const originalOrderId = event.order.metadata.originalOrderId;
        const originalOrder = this.state.originalOrders.get(originalOrderId);
        
        if (!originalOrder) {
            this.log('error', 'Cannot find original order for processing', {
                aggregatorOrderId: event.order.id
            });
            return;
        }
        
        // Update interception status
        const interception = this.state.interceptedOrders.get(event.order.id);
        if (interception) {
            interception.status = 'PROCESSED';
            interception.processedAt = new Date();
        }
        
        this.state.metrics.ordersPassed++;
        
        // Pass the processed order to Connection Manager
        await this.passOrderToConnectionManager(originalOrder, 'AGGREGATOR_APPROVED');
    }
    
    /**
     * Handle fill processed by aggregator
     */
    async handleFillProcessed(event) {
        const originalOrderId = event.fill.source; // Assuming fill source contains original order ID
        
        // Store fill event for later use
        this.state.fillEvents.set(event.fill.orderId, {
            fill: event.fill,
            sltpLevels: event.sltpLevels,
            processedAt: new Date()
        });
        
        // Notify manual trading about the enhanced fill with SL/TP
        await this.notifyManualTradingFill(event);
    }
    
    /**
     * Pass order to Connection Manager
     */
    async passOrderToConnectionManager(originalOrder, reason = null) {
        try {
            const orderMessage = {
                type: 'PLACE_ORDER',
                payload: originalOrder
            };
            
            // Add aggregator processing metadata
            if (reason) {
                orderMessage.payload.aggregatorStatus = reason;
                orderMessage.payload.processedByAggregator = true;
            }
            
            // Publish to Connection Manager
            await this.redisClient.publish('order:management', JSON.stringify(orderMessage));
            
            this.log('info', 'Order passed to Connection Manager', {
                orderId: originalOrder.orderId,
                reason: reason || 'PROCESSED'
            });
            
        } catch (error) {
            this.log('error', 'Error passing order to Connection Manager', {
                orderId: originalOrder.orderId,
                error: error.message
            });
        }
    }
    
    /**
     * Notify manual trading of order rejection
     */
    async notifyManualTradingRejection(originalOrder, rejectionEvent) {
        try {
            const rejectionMessage = {
                type: 'ORDER_REJECTED',
                payload: {
                    orderId: originalOrder.orderId,
                    reason: rejectionEvent.reason,
                    violations: rejectionEvent.violations,
                    timestamp: new Date().toISOString()
                }
            };
            
            // Publish to manual trading response channel
            await this.redisClient.publish('order:management', JSON.stringify(rejectionMessage));
            
            this.log('info', 'Rejection notification sent to manual trading', {
                orderId: originalOrder.orderId,
                reason: rejectionEvent.reason
            });
            
        } catch (error) {
            this.log('error', 'Error notifying manual trading of rejection', {
                orderId: originalOrder.orderId,
                error: error.message
            });
        }
    }
    
    /**
     * Notify manual trading of enhanced fill with SL/TP
     */
    async notifyManualTradingFill(fillEvent) {
        try {
            const enhancedFillMessage = {
                type: 'ENHANCED_FILL',
                payload: {
                    fill: fillEvent.fill,
                    sltpLevels: fillEvent.sltpLevels,
                    calculatedAt: new Date().toISOString(),
                    source: 'AGGREGATOR'
                }
            };
            
            // Publish enhanced fill information
            await this.redisClient.publish('fill:enhanced', JSON.stringify(enhancedFillMessage));
            
            this.log('info', 'Enhanced fill notification sent', {
                orderId: fillEvent.fill.orderId,
                stopLoss: fillEvent.sltpLevels.stopLoss,
                takeProfit: fillEvent.sltpLevels.takeProfit
            });
            
        } catch (error) {
            this.log('error', 'Error notifying enhanced fill', {
                orderId: fillEvent.fill.orderId,
                error: error.message
            });
        }
    }
    
    /**
     * Get integration metrics
     */
    getMetrics() {
        return {
            integration: {
                status: this.state.status,
                uptime: Date.now() - this.state.startTime.getTime(),
                ...this.state.metrics
            },
            interception: {
                activeInterceptions: this.state.interceptedOrders.size,
                storedOriginalOrders: this.state.originalOrders.size,
                storedFillEvents: this.state.fillEvents.size
            },
            config: {
                shadowMode: this.config.shadowMode,
                interceptOrders: this.config.interceptOrders,
                enableRiskValidation: this.config.enableRiskValidation,
                enableSLTPCalculation: this.config.enableSLTPCalculation,
                preserveOriginalWorkflow: this.config.preserveOriginalWorkflow
            }
        };
    }
    
    /**
     * Log message
     */
    log(level, message, data = {}) {
        if (!this.config.enableLogging) return;
        
        const logEntry = {
            timestamp: new Date().toISOString(),
            level,
            component: 'ManualTradingIntegration',
            message,
            ...data
        };
        
        console.log(JSON.stringify(logEntry));
    }
    
    /**
     * Enable/disable order interception
     */
    setOrderInterception(enabled) {
        this.config.interceptOrders = enabled;
        
        if (enabled && !this.redisSubscriber) {
            this.initializeRedis().then(() => {
                this.setupOrderInterception();
            });
        }
        
        this.log('info', `Order interception ${enabled ? 'enabled' : 'disabled'}`);
    }
    
    /**
     * Get order status
     */
    getOrderStatus(orderId) {
        // Check if it's an intercepted order
        for (const [aggregatorOrderId, interception] of this.state.interceptedOrders) {
            if (interception.originalOrderId === orderId) {
                return {
                    originalOrderId: orderId,
                    aggregatorOrderId,
                    status: interception.status,
                    queueId: interception.queueId,
                    interceptedAt: interception.interceptedAt,
                    processedAt: interception.processedAt,
                    rejectionReason: interception.rejectionReason
                };
            }
        }
        
        return null;
    }
    
    /**
     * Shutdown integration layer
     */
    async shutdown() {
        this.state.status = 'SHUTTING_DOWN';
        
        // Shutdown aggregator
        if (this.aggregator) {
            await this.aggregator.shutdown();
        }
        
        // Close Redis connections
        if (this.redisClient) {
            await this.redisClient.quit();
        }
        
        if (this.redisSubscriber) {
            await this.redisSubscriber.quit();
        }
        
        this.state.status = 'STOPPED';
        this.emit('shutdown');
        
        this.log('info', 'Manual Trading Integration Layer shutdown complete');
    }
}

module.exports = ManualTradingIntegration;