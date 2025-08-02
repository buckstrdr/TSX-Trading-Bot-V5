/**
 * AggregatorClient - Connects TradingBot to the Aggregator for automated order execution
 * Follows the same pattern as the manual trading integration
 */

const EventEmitter = require('events');
const redis = require('redis');
const { v4: uuidv4 } = require('uuid');

class AggregatorClient extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            botId: config.botId || 'UNKNOWN_BOT',
            accountId: config.accountId || 'default',
            redisConfig: config.redisConfig || { host: 'localhost', port: 6379 },
            connectionManagerUrl: config.connectionManagerUrl || 'http://localhost:7500',
            aggregatorUrl: config.aggregatorUrl || 'http://localhost:7700',
            retryAttempts: config.retryAttempts || 3,
            retryDelay: config.retryDelay || 1000,
            requestTimeout: config.requestTimeout || 30000,
            enableLogging: config.enableLogging !== false
        };
        
        // Redis clients
        this.publisher = null;
        this.subscriber = null;
        
        // Connection state
        this.connected = false;
        this.connecting = false;
        
        // Order tracking
        this.pendingOrders = new Map();
        this.orderResponses = new Map();
        
        // Position tracking
        this.positions = new Map();
        
        // Metrics
        this.metrics = {
            ordersSubmitted: 0,
            ordersAccepted: 0,
            ordersRejected: 0,
            ordersFilled: 0,
            connectionAttempts: 0,
            lastConnected: null
        };
    }
    
    /**
     * Connect to the aggregator via Redis
     */
    async connect() {
        if (this.connected) {
            this.log('warn', 'Already connected to aggregator');
            return;
        }
        
        if (this.connecting) {
            this.log('warn', 'Connection already in progress');
            return;
        }
        
        this.connecting = true;
        this.metrics.connectionAttempts++;
        
        try {
            // Create Redis clients
            this.publisher = redis.createClient(this.config.redisConfig);
            this.subscriber = redis.createClient(this.config.redisConfig);
            
            // Set up error handlers
            this.publisher.on('error', (err) => this.handleRedisError('publisher', err));
            this.subscriber.on('error', (err) => this.handleRedisError('subscriber', err));
            
            // Connect both clients
            await Promise.all([
                this.publisher.connect(),
                this.subscriber.connect()
            ]);
            
            // Subscribe to response channels
            await this.setupSubscriptions();
            
            this.connected = true;
            this.connecting = false;
            this.metrics.lastConnected = new Date();
            
            this.log('info', 'Connected to aggregator via Redis');
            this.emit('connected');
            
        } catch (error) {
            this.connecting = false;
            this.log('error', 'Failed to connect to aggregator', { error: error.message });
            throw error;
        }
    }
    
    /**
     * Set up Redis subscriptions
     */
    async setupSubscriptions() {
        // Subscribe to bot-specific response channel
        const botResponseChannel = `bot:${this.config.botId}:responses`;
        await this.subscriber.subscribe(botResponseChannel, (message) => {
            this.handleBotResponse(message);
        });
        
        // Subscribe to position updates
        const positionChannel = `positions:${this.config.accountId}`;
        await this.subscriber.subscribe(positionChannel, (message) => {
            this.handlePositionUpdate(message);
        });
        
        // Subscribe to fill notifications
        const fillChannel = `fills:${this.config.accountId}`;
        await this.subscriber.subscribe(fillChannel, (message) => {
            this.handleFillNotification(message);
        });
        
        this.log('info', 'Subscribed to aggregator channels', {
            channels: [botResponseChannel, positionChannel, fillChannel]
        });
    }
    
    /**
     * Submit order to aggregator
     */
    async submitOrder(signal) {
        if (!this.connected) {
            throw new Error('Not connected to aggregator');
        }
        
        const orderId = `${this.config.botId}_${uuidv4()}`;
        const timestamp = new Date();
        
        // Create order in PLACE_ORDER format expected by aggregator
        const order = {
            orderId: orderId,
            instrument: signal.instrument,
            action: signal.direction, // BUY/SELL  
            quantity: parseInt(signal.positionSize) || 1, // Ensure integer, default to 1
            orderType: 'MARKET', // Always market orders for now
            price: signal.entryPrice, // For reference
            stopLossPoints: signal.stopLoss ? Math.abs(signal.entryPrice - signal.stopLoss) : null,
            takeProfitPoints: signal.takeProfit ? Math.abs(signal.takeProfit - signal.entryPrice) : null,
            accountId: this.config.accountId,
            account: this.config.accountId, // Aggregator uses 'account' field
            // Additional metadata
            source: this.config.botId,
            urgent: true, // Bot signals are typically urgent
            metadata: {
                botId: this.config.botId,
                signalId: signal.id,
                strategyName: signal.strategyName,
                confidence: signal.confidence,
                reason: signal.reason,
                timestamp: timestamp.toISOString(),
                dollarRisk: signal.dollarRisk,
                riskRewardRatio: signal.riskRewardRatio
            }
        };
        
        // Store pending order
        this.pendingOrders.set(orderId, {
            order,
            signal,
            submittedAt: timestamp,
            status: 'PENDING'
        });
        
        // Create order submission message (using PLACE_ORDER type expected by aggregator)
        const orderMessage = {
            type: 'PLACE_ORDER',
            payload: order,
            requestId: orderId,
            timestamp: timestamp.toISOString(),
            source: this.config.botId
        };
        
        try {
            // Publish to aggregator
            await this.publisher.publish('aggregator:orders', JSON.stringify(orderMessage));
            
            this.metrics.ordersSubmitted++;
            this.log('info', 'Order submitted to aggregator', {
                orderId,
                instrument: order.instrument,
                action: order.action,
                quantity: order.quantity
            });
            
            // For now, assume order was accepted since aggregator doesn't send responses
            // We'll rely on position updates and fill notifications for actual status
            this.metrics.ordersAccepted++;
            
            // Emit success immediately
            this.emit('orderAccepted', {
                orderId,
                aggregatorOrderId: orderId,
                queueId: `queue_${Date.now()}`
            });
            
            return {
                success: true,
                orderId,
                aggregatorOrderId: orderId,
                message: 'Order submitted to aggregator'
            };
            
        } catch (error) {
            this.log('error', 'Failed to submit order', {
                orderId,
                error: error.message
            });
            
            // Update pending order status
            const pending = this.pendingOrders.get(orderId);
            if (pending) {
                pending.status = 'FAILED';
                pending.error = error.message;
            }
            
            throw error;
        }
    }
    
    /**
     * Wait for order response with timeout
     */
    async waitForOrderResponse(orderId) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.orderResponses.delete(orderId);
                reject(new Error(`Order response timeout for ${orderId}`));
            }, this.config.requestTimeout);
            
            // Store resolver for when response arrives
            this.orderResponses.set(orderId, {
                resolve: (response) => {
                    clearTimeout(timeout);
                    this.orderResponses.delete(orderId);
                    resolve(response);
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    this.orderResponses.delete(orderId);
                    reject(error);
                },
                timeout
            });
        });
    }
    
    /**
     * Handle bot-specific responses
     */
    handleBotResponse(message) {
        try {
            const response = JSON.parse(message);
            
            switch (response.type) {
                case 'ORDER_RESPONSE':
                    this.handleOrderResponse(response);
                    break;
                    
                case 'ORDER_UPDATE':
                    this.handleOrderUpdate(response);
                    break;
                    
                case 'ERROR':
                    this.handleErrorResponse(response);
                    break;
                    
                default:
                    this.log('warn', 'Unknown response type', { type: response.type });
            }
            
        } catch (error) {
            this.log('error', 'Error parsing bot response', {
                error: error.message,
                message: message.substring(0, 200)
            });
        }
    }
    
    /**
     * Handle order response from aggregator
     */
    handleOrderResponse(response) {
        const orderId = response.orderId;
        const resolver = this.orderResponses.get(orderId);
        
        if (resolver) {
            resolver.resolve(response);
        } else {
            this.log('warn', 'Received response for unknown order', { orderId });
        }
        
        // Update pending order
        const pending = this.pendingOrders.get(orderId);
        if (pending) {
            pending.status = response.success ? 'ACCEPTED' : 'REJECTED';
            pending.response = response;
        }
    }
    
    /**
     * Handle order update
     */
    handleOrderUpdate(update) {
        const orderId = update.orderId;
        const pending = this.pendingOrders.get(orderId);
        
        if (pending) {
            pending.status = update.status;
            pending.lastUpdate = new Date();
        }
        
        this.emit('orderUpdate', update);
    }
    
    /**
     * Handle error response
     */
    handleErrorResponse(response) {
        const orderId = response.orderId;
        const resolver = this.orderResponses.get(orderId);
        
        if (resolver) {
            resolver.reject(new Error(response.error));
        }
        
        this.emit('error', {
            orderId,
            error: response.error
        });
    }
    
    /**
     * Handle position update
     */
    handlePositionUpdate(message) {
        try {
            const update = JSON.parse(message);
            
            // Update internal position tracking
            if (update.positions) {
                update.positions.forEach(pos => {
                    this.positions.set(pos.id, pos);
                });
            }
            
            this.emit('positionUpdate', update);
            
        } catch (error) {
            this.log('error', 'Error parsing position update', {
                error: error.message
            });
        }
    }
    
    /**
     * Handle fill notification
     */
    handleFillNotification(message) {
        try {
            const fill = JSON.parse(message);
            
            // Update metrics
            this.metrics.ordersFilled++;
            
            // Update pending order if found
            const pending = Array.from(this.pendingOrders.values())
                .find(p => p.order.id === fill.orderId);
            
            if (pending) {
                pending.status = 'FILLED';
                pending.fill = fill;
            }
            
            this.emit('orderFilled', fill);
            
        } catch (error) {
            this.log('error', 'Error parsing fill notification', {
                error: error.message
            });
        }
    }
    
    /**
     * Handle Redis errors
     */
    handleRedisError(client, error) {
        this.log('error', `Redis ${client} error`, { error: error.message });
        
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
            this.connected = false;
            this.emit('disconnected', { reason: error.message });
        }
    }
    
    /**
     * Get current positions
     */
    getPositions() {
        return Array.from(this.positions.values());
    }
    
    /**
     * Get position by ID
     */
    getPosition(positionId) {
        return this.positions.get(positionId);
    }
    
    /**
     * Get metrics
     */
    getMetrics() {
        return {
            ...this.metrics,
            pendingOrders: this.pendingOrders.size,
            activePositions: this.positions.size,
            connected: this.connected
        };
    }
    
    /**
     * Disconnect from aggregator
     */
    async disconnect() {
        this.connected = false;
        
        if (this.publisher) {
            await this.publisher.quit();
            this.publisher = null;
        }
        
        if (this.subscriber) {
            await this.subscriber.quit();
            this.subscriber = null;
        }
        
        // Clear pending orders
        for (const [orderId, resolver] of this.orderResponses) {
            resolver.reject(new Error('Client disconnected'));
        }
        this.orderResponses.clear();
        
        this.log('info', 'Disconnected from aggregator');
        this.emit('disconnected', { reason: 'Client shutdown' });
    }
    
    /**
     * Log message
     */
    log(level, message, data = {}) {
        if (!this.config.enableLogging) return;
        
        const logEntry = {
            timestamp: new Date().toISOString(),
            level,
            component: 'AggregatorClient',
            botId: this.config.botId,
            message,
            ...data
        };
        
        console.log(`[${logEntry.level.toUpperCase()}] ${logEntry.component}: ${message}`, data);
    }
}

module.exports = AggregatorClient;