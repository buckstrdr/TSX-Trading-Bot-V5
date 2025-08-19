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
        this.lastPingTime = null;
        this.lastPongTime = null;
        this.connectionMonitorInterval = null;
        this.reconnectTimeouts = [];
        
        // Connection health monitoring
        this.healthConfig = {
            pingInterval: 30000,        // Ping every 30 seconds
            pongTimeout: 10000,         // Wait 10 seconds for pong response
            maxReconnectAttempts: 10,   // Maximum reconnection attempts
            reconnectBackoffStart: 1000,// Start with 1 second delay
            reconnectBackoffMax: 30000, // Maximum 30 second delay
            connectionTimeout: 15000    // Connection attempt timeout
        };
        
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
            reconnectionAttempts: 0,
            connectionDrops: 0,
            lastConnected: null,
            lastDisconnected: null,
            totalUptime: 0
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
            
            // Start connection health monitoring
            this.startConnectionMonitoring();
            
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
        this.log('info', 'Subscribing to position updates', { 
            channel: positionChannel,
            accountId: this.config.accountId,
            accountIdType: typeof this.config.accountId
        });
        await this.subscriber.subscribe(positionChannel, (message) => {
            this.handlePositionUpdate(message);
        });
        
        // Subscribe to fill notifications
        const fillChannel = `fills:${this.config.accountId}`;
        await this.subscriber.subscribe(fillChannel, (message) => {
            this.handleFillNotification(message);
        });
        
        // Subscribe to live market data from aggregator (actual price data only)
        const marketDataChannel = 'market:data';
        await this.subscriber.subscribe(marketDataChannel, (message) => {
            this.handleMarketData(message);
        });
        
        // Subscribe to separated position updates channel from aggregator
        const aggregatorPositionChannel = 'aggregator:position-updates';
        await this.subscriber.subscribe(aggregatorPositionChannel, (message) => {
            this.handleAggregatorPositionUpdate(message);
        });
        
        this.log('info', 'Subscribed to aggregator channels with proper separation', {
            channels: [botResponseChannel, positionChannel, fillChannel, marketDataChannel, aggregatorPositionChannel],
            marketDataChannel: marketDataChannel,
            positionUpdateChannel: aggregatorPositionChannel
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
        
        // Handle CLOSE_POSITION directive (copy manual trading approach)
        if (signal.direction === 'CLOSE_POSITION') {
            return await this.submitClosePosition(signal, orderId, timestamp);
        }
        
        // Create order payload in MANUAL_ORDER format (same as manual trading)
        const orderPayload = {
            instanceId: this.config.botId, // Bot identifier
            orderId: orderId,
            accountId: parseInt(this.config.accountId), // Convert to integer like manual trading
            instrument: signal.instrument,
            side: signal.direction === 'LONG' ? 'BUY' : signal.direction === 'SHORT' ? 'SELL' : signal.direction, // Map LONG/SHORT to BUY/SELL
            quantity: parseInt(signal.positionSize) || 1,
            orderType: 'MARKET',
            timestamp: Date.now()
        };
        
        // Add SL/TP points if available (match manual trading format)
        if (signal.stopLoss) {
            orderPayload.stopLossPoints = Math.abs(signal.entryPrice - signal.stopLoss);
        }
        if (signal.takeProfit) {
            orderPayload.takeProfitPoints = Math.abs(signal.takeProfit - signal.entryPrice);
        }
        
        // Store pending order
        this.pendingOrders.set(orderId, {
            order: orderPayload,
            signal,
            submittedAt: timestamp,
            status: 'PENDING'
        });
        
        // Create aggregator message (using MANUAL_ORDER type like manual trading)
        const orderMessage = {
            type: 'MANUAL_ORDER',
            source: this.config.botId,
            timestamp: timestamp.toISOString(),
            order: orderPayload
        };
        
        try {
            // Publish to aggregator
            await this.publisher.publish('aggregator:orders', JSON.stringify(orderMessage));
            
            this.metrics.ordersSubmitted++;
            this.log('info', 'Order submitted to aggregator', {
                orderId,
                instrument: orderPayload.instrument,
                side: orderPayload.side,
                quantity: orderPayload.quantity
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
     * Submit close position request (copy manual trading approach)
     */
    async submitClosePosition(signal, requestId, timestamp) {
        try {
            // Map instrument to TopStep contract ID (same as manual trading)
            const contractIdMap = {
                'MGC': 'CON.F.US.MGC.Z25',
                'MNQ': 'CON.F.US.MNQ.Z25',
                'MES': 'CON.F.US.MES.Z25',
                'M2K': 'CON.F.US.M2K.Z25'
            };
            const topStepContractId = contractIdMap[signal.instrument] || signal.instrument;
            
            // Create CLOSE_POSITION request (same format as manual trading)
            const closeRequest = {
                type: 'CLOSE_POSITION',
                requestId: requestId,
                accountId: parseInt(this.config.accountId),
                contractId: topStepContractId, // Use TopStep contract ID, not instrument name
                closeType: signal.closeType || 'full', // Default to full close
                size: signal.closeType === 'partial' ? signal.positionSize : undefined,
                responseChannel: `bot-close-response:${requestId}`, // Bot-specific response channel
                timestamp: Date.now()
            };
            
            this.log('info', 'Close position request submitted', {
                requestId,
                instrument: signal.instrument,
                contractId: topStepContractId,
                closeType: closeRequest.closeType
            });
            
            // Subscribe to response channel
            return new Promise((resolve, reject) => {
                const responseChannel = `bot-close-response:${requestId}`;
                const timeout = setTimeout(() => {
                    reject(new Error('Close position request timeout after 10 seconds'));
                }, 10000);
                
                // Subscribe to response
                this.subscriber.subscribe(responseChannel, (message) => {
                    try {
                        const response = JSON.parse(message);
                        clearTimeout(timeout);
                        this.subscriber.unsubscribe(responseChannel);
                        
                        if (response.success) {
                            this.log('info', 'Position closed successfully', {
                                requestId,
                                instrument: signal.instrument
                            });
                            resolve({
                                success: true,
                                requestId,
                                message: 'Position closed successfully'
                            });
                        } else {
                            this.log('error', 'Close position failed', {
                                requestId,
                                error: response.error
                            });
                            reject(new Error(response.error || 'Close position failed'));
                        }
                    } catch (error) {
                        clearTimeout(timeout);
                        this.subscriber.unsubscribe(responseChannel);
                        reject(new Error(`Failed to parse close response: ${error.message}`));
                    }
                });
                
                // Publish to aggregator:requests (same as manual trading)
                this.publisher.publish('aggregator:requests', JSON.stringify(closeRequest));
            });
            
        } catch (error) {
            this.log('error', 'Failed to submit close position', {
                requestId,
                error: error.message
            });
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
            
            // Log position updates for debugging
            this.log('info', 'Position update received', {
                accountId: this.config.accountId,
                updateType: update.type || 'unknown',
                hasPositions: !!update.positions,
                positionCount: update.positions ? update.positions.length : 0
            });
            
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
     * Handle live market data (PRICE DATA ONLY - no position updates)
     */
    handleMarketData(message) {
        try {
            const marketData = JSON.parse(message);
            
            // Sample logging: Only log 1% of market data messages to prevent overload
            if (Math.random() < 0.01) {
                this.log('debug', 'Market data sample (1% sampling)', {
                    type: marketData.type,
                    instrument: marketData.instrument,
                    hasPayload: !!marketData.payload
                });
            }
            
            // Only process actual market price data - position updates now go to separate channel
            // Check for payload-wrapped data (new format from aggregator)
            if (marketData.payload && marketData.payload.type === 'QUOTE' && marketData.payload.data) {
                // Process QUOTE messages with bid/ask data (wrapped format)
                const quoteData = marketData.payload;
                if (quoteData.data.bid !== undefined && quoteData.data.ask !== undefined) {
                    const quote = {
                        type: 'MARKET_DATA',
                        instrument: quoteData.instrument,
                        bid: quoteData.data.bid,
                        ask: quoteData.data.ask,
                        last: quoteData.data.last || ((quoteData.data.bid + quoteData.data.ask) / 2),
                        timestamp: quoteData.data.timestamp || new Date().toISOString()
                    };
                    
                    // Only log quote processing occasionally to reduce verbosity
                    if (Math.random() < 0.005) { // 0.5% sampling rate
                        this.log('debug', 'Quote sample', {
                            instrument: quote.instrument,
                            bid: quote.bid,
                            ask: quote.ask
                        });
                    }
                    
                    this.emit('marketData', quote);
                } else {
                    // Skip incomplete quote data - no logging to reduce noise
                }
                
            } else if (marketData.type === 'QUOTE' && marketData.data) {
                // Process QUOTE messages with bid/ask data (direct format - legacy support)
                // Only process if we have valid bid AND ask data
                if (marketData.data.bid !== undefined && marketData.data.ask !== undefined) {
                    const quote = {
                        type: 'MARKET_DATA',
                        instrument: marketData.instrument,
                        bid: marketData.data.bid,
                        ask: marketData.data.ask,
                        last: marketData.data.last || ((marketData.data.bid + marketData.data.ask) / 2),
                        timestamp: marketData.data.timestamp || new Date().toISOString()
                    };
                    
                    // Only log quote processing occasionally to reduce verbosity
                    if (Math.random() < 0.005) { // 0.5% sampling rate
                        this.log('debug', 'Quote sample (legacy)', {
                            instrument: quote.instrument,
                            bid: quote.bid,
                            ask: quote.ask
                        });
                    }
                    
                    this.emit('marketData', quote);
                } else {
                    // Skip incomplete quote data - no logging to reduce noise
                }
                
            } else if (marketData.payload && marketData.payload.type === 'TRADE' && marketData.payload.data) {
                // Process TRADE messages with price data (wrapped format)
                const tradeData = marketData.payload;
                if (tradeData.data.price !== undefined && !isNaN(tradeData.data.price)) {
                    const trade = {
                        type: 'MARKET_DATA',
                        instrument: tradeData.instrument,
                        last: tradeData.data.price,
                        size: tradeData.data.size,
                        side: tradeData.data.side,
                        timestamp: tradeData.data.timestamp || new Date().toISOString()
                    };
                    
                    // Only log trade processing occasionally to reduce verbosity
                    if (Math.random() < 0.005) { // 0.5% sampling rate
                        this.log('debug', 'Trade sample (wrapped)', {
                            instrument: trade.instrument,
                            price: trade.last
                        });
                    }
                    
                    this.emit('marketData', trade);
                } else {
                    // Skip invalid trade data - no logging to reduce noise
                }
                
            } else if (marketData.type === 'TRADE' && marketData.data) {
                // Process TRADE messages with price data (direct format - legacy support)
                // Only process if we have valid price data
                if (marketData.data.price !== undefined && !isNaN(marketData.data.price)) {
                    const trade = {
                        type: 'MARKET_DATA',
                        instrument: marketData.instrument,
                        last: marketData.data.price,
                        size: marketData.data.size,
                        side: marketData.data.side,
                        timestamp: marketData.data.timestamp || new Date().toISOString()
                    };
                    
                    // Only log trade processing occasionally to reduce verbosity
                    if (Math.random() < 0.005) { // 0.5% sampling rate
                        this.log('debug', 'Trade sample (direct)', {
                            instrument: trade.instrument,
                            price: trade.last
                        });
                    }
                    
                    this.emit('marketData', trade);
                } else {
                    // Skip invalid trade data - no logging to reduce noise
                }
                
            } else if (marketData.type === 'POSITION_UPDATE') {
                // LEGACY SUPPORT: Still handle position updates on market channel for backward compatibility
                this.log('warn', 'Position update received on market data channel (should be on position channel)', {
                    accountId: this.config.accountId,
                    hasPayload: !!marketData.payload,
                    hasPosition: !!(marketData.payload && marketData.payload.position)
                });
                
                const positionUpdate = {
                    positions: marketData.payload && marketData.payload.position ? [marketData.payload.position] : [],
                    type: 'position-update',
                    source: 'market-data-channel'
                };
                
                this.emit('positionUpdate', positionUpdate);
                
            } else {
                // Only log unknown message types occasionally to reduce noise
                if (Math.random() < 0.01) { // 1% sampling
                    this.log('warn', 'Non-price data sample', {
                        type: marketData.type
                    });
                }
            }
            
        } catch (error) {
            // Only log parsing errors occasionally
            if (Math.random() < 0.1) { // 10% sampling for errors
                this.log('error', 'Market data parse error sample', {
                    error: error.message
                });
            }
        }
    }

    /**
     * Handle position updates from dedicated aggregator position channel
     */
    handleAggregatorPositionUpdate(message) {
        try {
            const positionData = JSON.parse(message);
            
            this.log('info', 'Position update received from dedicated position channel', {
                type: positionData.type,
                processedBy: positionData.processedBy,
                hasPayload: !!positionData.payload,
                hasPosition: !!(positionData.payload && positionData.payload.position)
            });
            
            // Extract position data from the aggregator format
            let positionUpdate;
            
            if (positionData.type === 'POSITION_UPDATE' && positionData.payload) {
                positionUpdate = {
                    positions: positionData.payload.position ? [positionData.payload.position] : [],
                    type: 'position-update',
                    source: 'aggregator-position-channel',
                    processedBy: positionData.processedBy || 'aggregator',
                    timestamp: positionData.timestamp
                };
            } else {
                // Handle other position data formats
                positionUpdate = {
                    ...positionData,
                    type: 'position-update',
                    source: 'aggregator-position-channel'
                };
            }
            
            this.emit('positionUpdate', positionUpdate);
            
        } catch (error) {
            this.log('error', 'Error parsing aggregator position update', {
                error: error.message,
                message: message.substring(0, 200)
            });
        }
    }
    
    /**
     * Handle Redis errors
     */
    handleRedisError(client, error) {
        this.log('error', `Redis ${client} error`, { error: error.message });
        
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'ECONNRESET') {
            this.handleConnectionLoss('Redis error', error.message);
        }
    }
    
    /**
     * Start connection health monitoring
     */
    startConnectionMonitoring() {
        // Clear any existing monitoring
        this.stopConnectionMonitoring();
        
        this.log('info', 'Starting connection health monitoring', {
            pingInterval: this.healthConfig.pingInterval,
            pongTimeout: this.healthConfig.pongTimeout
        });
        
        // Set up periodic ping to check connection health
        this.connectionMonitorInterval = setInterval(() => {
            this.performHealthCheck();
        }, this.healthConfig.pingInterval);
        
        // Perform initial health check
        setTimeout(() => this.performHealthCheck(), 5000);
    }
    
    /**
     * Stop connection health monitoring
     */
    stopConnectionMonitoring() {
        if (this.connectionMonitorInterval) {
            clearInterval(this.connectionMonitorInterval);
            this.connectionMonitorInterval = null;
        }
        
        // Clear any pending reconnect timeouts
        this.reconnectTimeouts.forEach(timeout => clearTimeout(timeout));
        this.reconnectTimeouts = [];
    }
    
    /**
     * Perform health check using Redis PING command
     */
    async performHealthCheck() {
        if (!this.connected || !this.publisher) {
            return;
        }
        
        try {
            this.lastPingTime = new Date();
            
            // Use Redis PING command to check connection health
            const startTime = Date.now();
            const result = await this.publisher.ping();
            const responseTime = Date.now() - startTime;
            
            if (result === 'PONG') {
                this.lastPongTime = new Date();
                this.log('debug', 'Connection health check passed', {
                    responseTime: `${responseTime}ms`,
                    lastPing: this.lastPingTime.toISOString()
                });
            } else {
                this.log('warn', 'Unexpected ping response', { result, responseTime });
            }
            
        } catch (error) {
            this.log('error', 'Health check failed', { 
                error: error.message,
                lastPing: this.lastPingTime?.toISOString()
            });
            
            // Connection is likely dead, trigger reconnection
            this.handleConnectionLoss('Health check failure', error.message);
        }
    }
    
    /**
     * Handle connection loss and trigger reconnection
     */
    handleConnectionLoss(reason, details) {
        if (!this.connected) {
            return; // Already handling disconnection
        }
        
        this.connected = false;
        this.metrics.connectionDrops++;
        this.metrics.lastDisconnected = new Date();
        
        this.log('warn', 'Connection lost, initiating reconnection', {
            reason,
            details,
            connectionDrops: this.metrics.connectionDrops
        });
        
        // Stop monitoring during reconnection
        this.stopConnectionMonitoring();
        
        // Emit disconnection event
        this.emit('disconnected', { reason, details });
        
        // Start reconnection process
        this.attemptReconnection();
    }
    
    /**
     * Attempt to reconnect with exponential backoff
     */
    async attemptReconnection() {
        let attempt = 0;
        
        const reconnect = async () => {
            if (this.connected) {
                this.log('info', 'Connection restored before reconnection attempt');
                return;
            }
            
            attempt++;
            this.metrics.reconnectionAttempts++;
            
            if (attempt > this.healthConfig.maxReconnectAttempts) {
                this.log('error', 'Maximum reconnection attempts reached', {
                    maxAttempts: this.healthConfig.maxReconnectAttempts,
                    totalAttempts: this.metrics.reconnectionAttempts
                });
                this.emit('reconnectionFailed', { attempts: attempt });
                return;
            }
            
            this.log('info', `Reconnection attempt ${attempt}/${this.healthConfig.maxReconnectAttempts}`);
            
            try {
                // Close existing connections if they exist
                await this.cleanupConnections();
                
                // Attempt to reconnect
                await this.connect();
                
                this.log('info', 'Reconnection successful', {
                    attempt,
                    totalDrops: this.metrics.connectionDrops,
                    totalReconnects: this.metrics.reconnectionAttempts
                });
                
                this.emit('reconnected', { attempts: attempt });
                
            } catch (error) {
                this.log('warn', `Reconnection attempt ${attempt} failed`, {
                    error: error.message,
                    nextAttemptIn: this.calculateBackoffDelay(attempt)
                });
                
                // Schedule next reconnection attempt with exponential backoff
                const delay = this.calculateBackoffDelay(attempt);
                const timeout = setTimeout(() => {
                    reconnect();
                }, delay);
                
                this.reconnectTimeouts.push(timeout);
            }
        };
        
        // Start first reconnection attempt immediately
        reconnect();
    }
    
    /**
     * Calculate exponential backoff delay
     */
    calculateBackoffDelay(attempt) {
        const delay = Math.min(
            this.healthConfig.reconnectBackoffStart * Math.pow(2, attempt - 1),
            this.healthConfig.reconnectBackoffMax
        );
        
        // Add jitter to prevent thundering herd
        const jitter = Math.random() * 0.3 * delay;
        return Math.floor(delay + jitter);
    }
    
    /**
     * Clean up existing connections
     */
    async cleanupConnections() {
        const cleanupPromises = [];
        
        if (this.publisher) {
            cleanupPromises.push(
                this.publisher.quit().catch(err => 
                    this.log('warn', 'Error cleaning up publisher', { error: err.message })
                )
            );
            this.publisher = null;
        }
        
        if (this.subscriber) {
            cleanupPromises.push(
                this.subscriber.quit().catch(err => 
                    this.log('warn', 'Error cleaning up subscriber', { error: err.message })
                )
            );
            this.subscriber = null;
        }
        
        await Promise.all(cleanupPromises);
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
        const now = new Date();
        const uptime = this.metrics.lastConnected ? 
            now.getTime() - this.metrics.lastConnected.getTime() : 0;
        
        return {
            ...this.metrics,
            pendingOrders: this.pendingOrders.size,
            activePositions: this.positions.size,
            connected: this.connected,
            connectionHealth: {
                lastPing: this.lastPingTime?.toISOString(),
                lastPong: this.lastPongTime?.toISOString(),
                currentUptime: uptime,
                pingInterval: this.healthConfig.pingInterval,
                reconnectAttempts: this.metrics.reconnectionAttempts,
                connectionDrops: this.metrics.connectionDrops,
                monitoringActive: !!this.connectionMonitorInterval
            }
        };
    }
    
    /**
     * Disconnect from aggregator
     */
    async disconnect() {
        this.connected = false;
        
        // Stop connection monitoring
        this.stopConnectionMonitoring();
        
        // Clean up connections
        await this.cleanupConnections();
        
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