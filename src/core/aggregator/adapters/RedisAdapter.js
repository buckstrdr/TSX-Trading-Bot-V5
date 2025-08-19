/**
 * RedisAdapter - Production Redis pub/sub integration for Trading Aggregator
 * Integrates with existing manual-trading and connection-manager Redis channels
 * Supports shadow mode for testing and production mode for live trading
 */

const EventEmitter = require('events');
const { createClient } = require('redis');

class RedisAdapter extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            host: config.host || 'localhost',
            port: config.port || 6379,
            password: config.password || null,
            db: config.db || 0,
            
            // Production Redis channel configuration matching existing system
            channels: {
                // Subscription channels (from manual-trading and connection-manager)
                aggregatorOrders: 'aggregator:orders',
                aggregatorRequests: 'aggregator:requests', // New channel for manual trading requests
                aggregatorPnLRequests: 'aggregator:pnl_requests', // P&L module requests
                marketData: 'market:data',
                connectionManagerFills: 'connection-manager:fills',
                orderManagement: 'order:management',
                userData: 'user:data',
                
                // Publishing channels (to connection-manager and manual-trading)
                connectionManagerRequests: 'connection-manager:requests',
                aggregatorStatus: 'aggregator:status',
                aggregatorMetrics: 'aggregator:metrics',
                aggregatorMarketData: 'aggregator:market-data', // New channel for republished market data
                pnlResponses: 'pnl:responses', // P&L module responses
                instanceControl: 'instance:control'
            },
            
            // Connection settings
            reconnectInterval: config.reconnectInterval || 5000,
            maxRetries: config.maxRetries || 10,
            heartbeatInterval: config.heartbeatInterval || 30000,
            
            // Connection settings (removed shadow mode)
        };
        
        this.state = {
            connected: false,
            subscribedChannels: new Set(),
            messageCount: 0,
            lastMessage: null,
            reconnectAttempts: 0,
            startTime: Date.now()
        };
        
        // Redis clients (subscriber and publisher)
        this.subscriber = null;
        this.publisher = null;
        
        // Message handlers and request tracking
        this.messageHandlers = new Map();
        this.pendingRequests = new Map();
        this.pendingForwardRequests = new Map(); // Track requests that need response forwarding
        this.requestId = 0;
        
        // Error handling and metrics
        this.errorCount = 0;
        this.lastError = null;
        this.messageStats = {
            received: 0,
            published: 0,
            errors: 0
        };
        
        // Don't auto-initialize - let the startup script control this
        // this.initialize();
    }
    
    /**
     * Initialize Redis connections with production-ready error handling
     */
    async initialize() {
        this.log('🔄 Initializing Redis connections...');
        
        try {
            // Always connect to real Redis - no shadow mode
            
            await this.createRedisClients();
            await this.setupEventHandlers();
            await this.connectClients();
            
            this.state.connected = true;
            this.state.reconnectAttempts = 0;
            this.log('✅ Redis connections established successfully');
            this.emit('connected', { 
                host: this.config.host, 
                port: this.config.port,
                production: true 
            });
            
            this.startHeartbeat();
            
        } catch (error) {
            this.handleConnectionError(error);
        }
    }
    
    /**
     * Create Redis publisher and subscriber clients
     */
    async createRedisClients() {
        this.log('📡 Creating Redis clients...');
        
        const redisUrl = `redis://${this.config.host}:${this.config.port}`;
        const redisConfig = {
            url: redisUrl,
            database: this.config.db,
            socket: {
                reconnectStrategy: (retries) => {
                    if (retries > this.config.maxRetries) {
                        return new Error('Max retries reached');
                    }
                    return Math.min(retries * 100, 3000);
                }
            }
        };
        
        if (this.config.password) {
            redisConfig.password = this.config.password;
        }
        
        // Create publisher client
        this.publisher = createClient(redisConfig);
        
        // Create subscriber client (separate connection required for pub/sub)
        this.subscriber = this.publisher.duplicate();
    }
    
    /**
     * Setup Redis client event handlers
     */
    setupEventHandlers() {
        // Publisher event handlers
        this.publisher.on('connect', () => {
            this.log('📤 Redis publisher connected');
        });
        
        this.publisher.on('ready', () => {
            this.log('✅ Redis publisher ready');
        });
        
        this.publisher.on('error', (error) => {
            this.log(`❌ Redis publisher error: ${error.message}`, 'ERROR');
            this.handleConnectionError(error);
        });
        
        this.publisher.on('end', () => {
            this.log('📤 Redis publisher connection ended');
        });
        
        // Subscriber event handlers
        this.subscriber.on('connect', () => {
            this.log('📥 Redis subscriber connected');
        });
        
        this.subscriber.on('ready', () => {
            this.log('✅ Redis subscriber ready');
        });
        
        this.subscriber.on('error', (error) => {
            this.log(`❌ Redis subscriber error: ${error.message}`, 'ERROR');
            this.handleConnectionError(error);
        });
        
        this.subscriber.on('end', () => {
            this.log('📥 Redis subscriber connection ended');
        });
        
        // The new redis client doesn't use 'on' for subscribe/unsubscribe events
        // Message handling is done through the subscribe method itself
    }
    
    /**
     * Connect both Redis clients
     */
    async connectClients() {
        this.log('🔗 Connecting Redis clients...');
        
        try {
            await Promise.all([
                this.publisher.connect(),
                this.subscriber.connect()
            ]);
            this.log('✅ Both Redis clients connected');
        } catch (error) {
            this.log(`❌ Failed to connect Redis clients: ${error.message}`, 'ERROR');
            throw error;
        }
    }
    
    /**
     * Subscribe to a Redis channel with error handling
     */
    async subscribe(channel, handler) {
        if (!this.state.connected) {
            throw new Error('Redis not connected - call initialize() first');
        }
        
        try {
            // Register the message handler first
            this.messageHandlers.set(channel, handler);
            
            // Always use real Redis subscription
            
            // Subscribe to the channel with the new redis client API
            // The new client requires passing the handler directly to subscribe
            await this.subscriber.subscribe(channel, (message) => {
                this.handleMessage(channel, message);
            });
            this.state.subscribedChannels.add(channel);
            
            this.log(`✅ Subscribed to channel: ${channel}`);
            this.emit('subscribed', { channel });
            
        } catch (error) {
            this.log(`❌ Failed to subscribe to ${channel}: ${error.message}`, 'ERROR');
            this.messageHandlers.delete(channel);
            this.emit('subscriptionError', { channel, error: error.message });
            throw error;
        }
    }
    
    /**
     * Publish message to Redis channel with comprehensive error handling
     */
    async publish(channel, message) {
        if (!this.state.connected) {
            throw new Error('Redis not connected - call initialize() first');
        }
        
        try {
            // Prepare message with aggregator metadata
            const enrichedMessage = {
                ...message,
                timestamp: new Date().toISOString(),
                source: 'TRADING_AGGREGATOR',
                aggregatorId: process.env.AGGREGATOR_ID || 'default',
                messageId: this.generateRequestId()
            };
            
            const serializedMessage = JSON.stringify(enrichedMessage);
            
            // Always publish to real Redis
            
            // Publish to Redis
            await this.publisher.publish(channel, serializedMessage);
            this.messageStats.published++;
            
            // Comment out debug logging to prevent spam
            // this.log(`📤 Published to ${channel}: ${message.type || 'message'}`, 'DEBUG');
            this.emit('published', { channel, message: enrichedMessage });
            
        } catch (error) {
            this.log(`❌ Failed to publish to ${channel}: ${error.message}`, 'ERROR');
            this.messageStats.errors++;
            this.emit('publishError', { channel, message, error: error.message });
            throw error;
        }
    }
    
    /**
     * Publish raw message without aggregator metadata (for response forwarding)
     */
    async publishRaw(channel, message) {
        if (!this.state.connected) {
            throw new Error('Redis not connected - call initialize() first');
        }
        
        try {
            const serializedMessage = typeof message === 'string' ? message : JSON.stringify(message);
            await this.publisher.publish(channel, serializedMessage);
            this.messageStats.published++;
            // this.log(`📤 Published raw to ${channel}`, 'DEBUG');
            
        } catch (error) {
            this.log(`❌ Failed to publish raw to ${channel}: ${error.message}`, 'ERROR');
            this.messageStats.errors++;
            throw error;
        }
    }
    
    /**
     * Subscribe to order events from manual-trading and other components
     */
    async subscribeToOrders(handler) {
        this.log('📋 Setting up order subscription...');
        
        // Subscribe to aggregator-specific order channel
        await this.subscribe(this.config.channels.aggregatorOrders, (message) => {
            try {
                const orderData = JSON.parse(message);
                this.log(`📋 Received order: ${orderData.type || 'unknown'}`, 'DEBUG');
                handler(orderData);
            } catch (error) {
                this.handleParseError('aggregator:orders', message, error);
            }
        });
        
        // Also subscribe to order management channel for compatibility
        await this.subscribe(this.config.channels.orderManagement, (message) => {
            try {
                const orderData = JSON.parse(message);
                
                // Skip ORDER_RESPONSE messages - these are responses, not new orders
                if (orderData.type === 'ORDER_RESPONSE') {
                    this.log(`📋 Skipping ORDER_RESPONSE message for order ${orderData.payload?.orderId || 'unknown'}`, 'DEBUG');
                    return;
                }
                
                // Only process orders from manual-trading or external sources
                if (orderData.source !== 'TRADING_AGGREGATOR') {
                    this.log(`📋 Received order from ${orderData.source || 'unknown'}`, 'DEBUG');
                    handler(orderData);
                }
            } catch (error) {
                this.handleParseError('order:management', message, error);
            }
        });
    }
    
    /**
     * Publish order updates to connection-manager for execution
     */
    async publishOrderForExecution(order) {
        await this.publish(this.config.channels.connectionManagerRequests, {
            type: 'PLACE_ORDER',
            requestId: this.generateRequestId(),
            order: {
                ...order,
                aggregatorProcessed: true,
                timestamp: new Date().toISOString()
            }
        });
    }
    
    /**
     * Subscribe to fill events from connection-manager
     */
    async subscribeToFills(handler) {
        this.log('💰 Setting up fill event subscription...');
        
        // Subscribe to connection-manager fills
        await this.subscribe(this.config.channels.connectionManagerFills, (message) => {
            try {
                const fillData = JSON.parse(message);
                this.log(`💰 Received fill: ${fillData.orderId || 'unknown'}`, 'DEBUG');
                handler(fillData);
            } catch (error) {
                this.handleParseError('connection-manager:fills', message, error);
            }
        });
        
        // Also monitor user data channel for fill events
        await this.subscribe(this.config.channels.userData, (message) => {
            try {
                const userData = JSON.parse(message);
                if (userData.type === 'ORDER_FILLED' || userData.type === 'FILL') {
                    this.log(`💰 Received fill from user data: ${userData.orderId || 'unknown'}`, 'DEBUG');
                    handler(userData);
                }
            } catch (error) {
                this.handleParseError('user:data', message, error);
            }
        });
        
        // Also monitor market data channel for ORDER_FILLED events from Connection Manager
        await this.subscribe(this.config.channels.marketData, (message) => {
            try {
                const marketData = JSON.parse(message);
                if (marketData.type === 'ORDER_FILLED' || marketData.type === 'FILL') {
                    this.log(`💰 Received fill from market data: ${marketData.orderId || 'unknown'}`, 'DEBUG');
                    handler(marketData);
                }
            } catch (error) {
                this.handleParseError('market:data', message, error);
            }
        });
    }
    
    /**
     * Publish order status updates
     */
    async publishOrderUpdate(order, status) {
        await this.publish(this.config.channels.aggregatorStatus, {
            type: 'ORDER_UPDATE',
            orderId: order.id,
            status,
            order: {
                ...order,
                aggregatorProcessed: true
            },
            timestamp: new Date().toISOString()
        });
    }
    
    /**
     * Publish fill updates with SL/TP levels
     */
    async publishFillUpdate(fill, sltpLevels) {
        await this.publish(this.config.channels.aggregatorStatus, {
            type: 'FILL_PROCESSED',
            orderId: fill.orderId,
            fill: {
                ...fill,
                aggregatorProcessed: true
            },
            sltpLevels,
            timestamp: new Date().toISOString()
        });
    }
    
    /**
     * Subscribe to market data for position updates
     */
    async subscribeToMarketData(handler) {
        this.log('📊 Setting up market data subscription...');
        
        await this.subscribe(this.config.channels.marketData, (message) => {
            try {
                const marketData = JSON.parse(message);
                
                // V4 Connection Manager format: { type: 'MARKET_DATA', payload: { instrument, type, data } }
                if (marketData.type === 'MARKET_DATA' && marketData.payload) {
                    const payload = marketData.payload;
                    // Check if payload has the expected structure
                    if (payload.type && ['QUOTE', 'TRADE', 'DEPTH'].includes(payload.type)) {
                        handler(marketData);
                    } else {
                        handler(marketData);
                    }
                }
                // Also handle direct format (in case format changes)
                else if (marketData.type && ['QUOTE', 'TRADE', 'DEPTH'].includes(marketData.type)) {
                    handler(marketData);
                }
                // Legacy formats
                else if (marketData.type === 'MARKET_DATA' || marketData.type === 'PRICE_UPDATE') {
                    handler(marketData);
                }
            } catch (error) {
                this.handleParseError('market:data', message, error);
            }
        });
    }
    
    /**
     * Publish aggregator status updates
     */
    async publishStatusUpdate(status, details = {}) {
        await this.publish(this.config.channels.aggregatorStatus, {
            type: 'AGGREGATOR_STATUS',
            status,
            details,
            uptime: Date.now() - this.state.startTime,
            messageStats: this.messageStats
        });
    }
    
    /**
     * Publish aggregator metrics
     */
    async publishMetrics(metrics) {
        await this.publish(this.config.channels.aggregatorMetrics, {
            type: 'AGGREGATOR_METRICS',
            metrics,
            timestamp: new Date().toISOString(),
            uptime: Date.now() - this.state.startTime
        });
    }
    
    /**
     * Subscribe to control messages for aggregator management
     */
    async subscribeToControl(handler) {
        this.log('🎮 Setting up control channel subscription...');
        
        await this.subscribe(this.config.channels.instanceControl, (message) => {
            try {
                const controlData = JSON.parse(message);
                // Only process control messages for aggregator
                if (controlData.target === 'AGGREGATOR' || controlData.target === 'ALL') {
                    this.log(`🎮 Received control message: ${controlData.command || 'unknown'}`, 'DEBUG');
                    handler(controlData);
                }
            } catch (error) {
                this.handleParseError('instance:control', message, error);
            }
        });
    }
    
    /**
     * Subscribe to aggregator requests (from manual trading) and forward to connection manager
     */
    async subscribeToAggregatorRequests() {
        this.log('🔄 Setting up aggregator request forwarding...');
        
        // First, set up subscription to connection-manager responses
        await this.subscribe('connection-manager:response', async (message) => {
            try {
                const response = JSON.parse(message);
                this.log(`📨 Received connection-manager response: ${response.type || 'unknown'}, requestId: ${response.requestId}`);
                
                // Add debug logging for CLOSE_POSITION response
                if (response.type === 'CLOSE_POSITION') {
                    this.log(`🔍 [DEBUG] CLOSE_POSITION response received: success=${response.success}, error=${response.error}`);
                }
                
                // First check for direct sendConnectionManagerRequest requests
                const directRequest = this.pendingRequests.get(response.requestId);
                if (directRequest) {
                    console.log(`✅ [connection-manager:response] Found direct pending request for ${response.requestId}`);
                    
                    // Clear timeout and remove from pending
                    clearTimeout(directRequest.timeout);
                    this.pendingRequests.delete(response.requestId);
                    
                    // Resolve with the response
                    if (response.success === false) {
                        directRequest.reject(new Error(response.error || 'Request failed'));
                    } else {
                        directRequest.resolve(response);
                    }
                    return; // Done with this response
                }
                
                // Check if we have a pending forwarding request for this response
                const pendingRequest = this.pendingForwardRequests.get(response.requestId);
                if (pendingRequest && pendingRequest.responseChannel) {
                    // Special handling for P&L extraction from position responses
                    if (pendingRequest.type === 'GET_ACCOUNT_PNL' && response.type === 'GET_POSITIONS') {
                        this.log(`📥 Processing P&L extraction from position response (ID: ${response.requestId})`);
                        await this.processPnLExtraction(response, pendingRequest);
                    } else {
                        // Forward the raw response without aggregator metadata
                        const responseStr = JSON.stringify(response);
                        await this.publisher.publish(pendingRequest.responseChannel, responseStr);
                        this.log(`✅ Forwarded response to ${pendingRequest.responseChannel} (raw publish)`);
                        
                        // Add debug for statistics responses
                        if (response.type === 'GET_STATISTICS') {
                            this.log(`📊 [STATISTICS] Response forwarded: requestId=${response.requestId}, channel=${pendingRequest.responseChannel}, hasStats=${!!response.statistics}`);
                        }
                        
                        // Add debug for CLOSE_POSITION
                        if (response.type === 'CLOSE_POSITION') {
                            this.log(`🔍 [DEBUG] CLOSE_POSITION response forwarded to ${pendingRequest.responseChannel}`);
                        }
                    }
                    
                    // Clean up
                    this.pendingForwardRequests.delete(response.requestId);
                } else {
                    this.log(`⚠️ No pending request found for ${response.requestId}, pendingRequests: ${this.pendingRequests.size}, pendingForwardRequests: ${this.pendingForwardRequests.size}`);
                    
                    // Debug: Log all pending request IDs
                    if (this.pendingForwardRequests.size > 0) {
                        const pendingIds = Array.from(this.pendingForwardRequests.keys());
                        this.log(`🔍 [DEBUG] Current forward request IDs: ${pendingIds.join(', ')}`);
                    }
                    if (this.pendingRequests.size > 0) {
                        const directIds = Array.from(this.pendingRequests.keys());
                        this.log(`🔍 [DEBUG] Current direct request IDs: ${directIds.join(', ')}`);
                    }
                }
            } catch (error) {
                this.handleParseError('connection-manager:response', message, error);
            }
        });
        
        // Now set up subscription to aggregator requests
        await this.subscribe(this.config.channels.aggregatorRequests, async (message) => {
            try {
                const requestData = JSON.parse(message);
                this.log(`🔄 Received aggregator request: ${requestData.type || 'unknown'}, requestId: ${requestData.requestId}`);
                
                // Handle responses for requests that need forwarding back
                const responseNeededTypes = ['GET_POSITIONS', 'GET_ACCOUNTS', 'GET_CONTRACTS', 'UPDATE_SLTP', 'CLOSE_POSITION', 'GET_WORKING_ORDERS', 'GET_ACTIVE_CONTRACTS', 'GET_STATISTICS'];
                if (responseNeededTypes.includes(requestData.type) && requestData.responseChannel) {
                    this.log(`📌 Storing pending request ${requestData.requestId} for response forwarding to ${requestData.responseChannel}`);
                    // Store the request info for response forwarding
                    this.pendingForwardRequests.set(requestData.requestId, {
                        responseChannel: requestData.responseChannel,
                        timestamp: Date.now(),
                        type: requestData.type
                    });
                    
                    // Add debug logging for specific request types
                    if (requestData.type === 'CLOSE_POSITION') {
                        this.log(`🔍 [DEBUG] CLOSE_POSITION request stored: requestId=${requestData.requestId}, responseChannel=${requestData.responseChannel}`);
                    }
                    if (requestData.type === 'GET_STATISTICS') {
                        this.log(`📊 [STATISTICS] Request stored: requestId=${requestData.requestId}, responseChannel=${requestData.responseChannel}, accountId=${requestData.accountId}`);
                    }
                    
                    // Clean up old pending requests after timeout
                    setTimeout(() => {
                        const req = this.pendingForwardRequests.get(requestData.requestId);
                        if (req) {
                            this.log(`⏰ Timeout: Removing pending request ${requestData.requestId} after 35s`);
                        }
                        this.pendingForwardRequests.delete(requestData.requestId);
                    }, 35000);
                }
                
                // Forward the request to connection manager
                await this.publish(this.config.channels.connectionManagerRequests, requestData);
                
            } catch (error) {
                this.handleParseError('aggregator:requests', message, error);
            }
        });
    }
    
    /**
     * Subscribe to P&L requests from P&L module and handle with position data extraction
     */
    async subscribeToPnLRequests() {
        this.log('💰 Setting up P&L request handling...');
        
        await this.subscribe(this.config.channels.aggregatorPnLRequests, async (message) => {
            try {
                const request = JSON.parse(message);
                this.log(`📊 Received P&L request: ${request.type} (ID: ${request.requestId})`);
                
                // Handle P&L requests by getting position data which includes P&L
                switch (request.type) {
                    case 'GET_ACCOUNT_PNL':
                        // Request positions which include P&L data
                        const positionRequest = {
                            type: 'GET_POSITIONS',
                            requestId: request.requestId,
                            responseChannel: 'pnl:positions_response',
                            accountId: request.accountId,
                            timestamp: Date.now()
                        };
                        
                        // Store the request info for P&L extraction when response comes back
                        this.pendingForwardRequests.set(request.requestId, {
                            responseChannel: 'pnl:responses',
                            timestamp: Date.now(),
                            type: 'GET_ACCOUNT_PNL',
                            originalRequest: request
                        });
                        
                        await this.publish(this.config.channels.connectionManagerRequests, positionRequest);
                        this.log(`📤 Requested positions for P&L extraction: ${request.requestId}`);
                        break;
                        
                    default:
                        this.log(`❌ Unknown P&L request type: ${request.type}`);
                        
                        // Send error response back to P&L module
                        const errorResponse = {
                            requestId: request.requestId,
                            success: false,
                            error: `Unknown P&L request type: ${request.type}`,
                            timestamp: Date.now()
                        };
                        await this.publishRaw(this.config.channels.pnlResponses, JSON.stringify(errorResponse));
                        return;
                }
                
            } catch (error) {
                this.handleParseError('aggregator:pnl_requests', message, error);
            }
        });
        
        // P&L extraction is now handled in the main connection-manager response handler above
        
    }
    
    /**
     * Process P&L extraction from position response
     */
    async processPnLExtraction(response, pendingRequest) {
        let totalDailyPnL = 0;
        let totalUnrealizedPnL = 0;
        let totalRealizedPnL = 0;
        
        // DEBUG: Log the full response to see what we're getting
        this.log(`🔍 [DEBUG P&L] Full response:`, JSON.stringify(response, null, 2));
        
        // Extract P&L from position data
        if (response.success && response.positions && Array.isArray(response.positions)) {
            response.positions.forEach(position => {
                // Extract P&L with proper commission calculation
                // TopStepX userapi uses 'profitAndLoss' field for live P&L
                const unrealizedPnL = position.profitAndLoss || position.unrealizedPnL || position.unrealizedPL || position.unrealized || 0;
                const realizedPnL = position.realizedPnL || position.realizedPL || position.realized || 0;
                
                totalUnrealizedPnL += unrealizedPnL;
                totalRealizedPnL += realizedPnL;
                
                this.log(`📊 Position ${position.positionId || 'unknown'}: Unrealized=${unrealizedPnL}, Realized=${realizedPnL}`);
            });
            
            // Calculate total daily P&L including commission
            totalDailyPnL = totalUnrealizedPnL + totalRealizedPnL;
            
            // Account for $1.24 round-trip commission per trade
            // This is already included in the API P&L data, but we can validate
            this.log(`💰 Calculated P&L: Daily=${totalDailyPnL}, Unrealized=${totalUnrealizedPnL}, Realized=${totalRealizedPnL}`);
        }
        
        // Send P&L response to P&L module with full position data included
        const pnlResponse = {
            requestId: response.requestId,
            success: response.success,
            pnl: {
                dailyPnL: totalDailyPnL,
                unrealizedPnL: totalUnrealizedPnL,
                realizedPnL: totalRealizedPnL,
                commission: 1.24, // Round-trip commission
                timestamp: Date.now(),
                // Include full position data for rich UI integration
                positions: response.positions || []
            },
            // Also include positions at top level for easy access
            positions: response.positions || [],
            timestamp: Date.now()
        };
        
        await this.publishRaw(this.config.channels.pnlResponses, JSON.stringify(pnlResponse));
        this.log(`✅ Sent P&L response: Daily=${totalDailyPnL}, ${response.positions?.length || 0} positions included`);
    }
    
    /**
     * Send request to connection-manager and wait for response with automatic retry on Redis connection issues
     */
    async sendConnectionManagerRequest(requestType, data, timeout = 30000, maxRetries = 3) {
        let lastError;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`📤 [sendConnectionManagerRequest] Attempt ${attempt}/${maxRetries}: ${requestType}`);
                
                const result = await this.sendConnectionManagerRequestOnce(requestType, data, timeout, attempt);
                
                if (attempt > 1) {
                    console.log(`✅ [sendConnectionManagerRequest] ${requestType} succeeded on attempt ${attempt}`);
                }
                
                return result;
                
            } catch (error) {
                lastError = error;
                const isRetryableError = error.message.includes('timed out') || 
                                       error.message.includes('ECONNRESET') ||
                                       error.message.includes('connection lost');
                
                if (isRetryableError && attempt < maxRetries) {
                    const retryDelay = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // Exponential backoff, max 5s
                    console.log(`🔄 [sendConnectionManagerRequest] ${requestType} attempt ${attempt} failed (${error.message}), retrying in ${retryDelay}ms...`);
                    
                    // Wait before retry
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                } else {
                    console.log(`❌ [sendConnectionManagerRequest] ${requestType} failed after ${attempt} attempts: ${error.message}`);
                    break;
                }
            }
        }
        
        throw lastError;
    }
    
    /**
     * Internal method: Send single request to connection-manager (no retry logic)
     */
    async sendConnectionManagerRequestOnce(requestType, data, timeout, attemptNumber = 1) {
        return new Promise((resolve, reject) => {
            const requestId = this.generateRequestId();
            
            console.log(`📤 [sendConnectionManagerRequestOnce] Creating request: ${requestType}, ID: ${requestId} (attempt ${attemptNumber})`);
            
            // Set up timeout
            const timeoutHandle = setTimeout(() => {
                console.log(`⏰ [sendConnectionManagerRequestOnce] Request ${requestId} timed out after ${timeout}ms`);
                this.pendingRequests.delete(requestId);
                reject(new Error(`Request ${requestType} timed out after ${timeout}ms`));
            }, timeout);
            
            // Store pending request - the response will come through the existing connection-manager:response handler
            this.pendingRequests.set(requestId, {
                resolve,
                reject,
                timeout: timeoutHandle,
                type: requestType
            });
            
            console.log(`📝 [sendConnectionManagerRequestOnce] Stored pending request ${requestId}, total pending: ${this.pendingRequests.size}`);
            
            // Send request directly to connection manager
            this.publish(this.config.channels.connectionManagerRequests, {
                type: requestType,
                requestId,
                ...data
            }).catch(reject);
        });
    }
    
    /**
     * Handle incoming Redis message with comprehensive error handling
     */
    handleMessage(channel, message) {
        this.state.messageCount++;
        this.state.lastMessage = new Date();
        this.messageStats.received++;
        
        const handler = this.messageHandlers.get(channel);
        if (handler) {
            try {
                handler(message);
            } catch (error) {
                this.log(`❌ Handler error for channel ${channel}: ${error.message}`, 'ERROR');
                this.messageStats.errors++;
                this.emit('handlerError', { channel, message, error: error.message });
            }
        } else {
            this.log(`⚠️ No handler for channel: ${channel}`, 'DEBUG');
            this.emit('unhandledMessage', { channel, message });
        }
    }
    
    /**
     * Handle parse errors with detailed logging
     */
    handleParseError(channel, message, error) {
        this.log(`❌ Parse error on ${channel}: ${error.message}`, 'ERROR');
        this.log(`   Raw message: ${message.substring(0, 200)}...`, 'DEBUG');
        this.messageStats.errors++;
        this.emit('parseError', { channel, message, error: error.message });
    }
    
    /**
     * Handle connection errors with auto-reconnect
     */
    handleConnectionError(error) {
        this.log(`❌ Redis connection error: ${error.message}`, 'ERROR');
        this.state.connected = false;
        this.errorCount++;
        this.lastError = {
            message: error.message,
            timestamp: new Date().toISOString()
        };
        
        this.emit('connectionError', { error: error.message });
        
        if (this.state.reconnectAttempts < this.config.maxRetries) {
            this.scheduleReconnect();
        } else {
            this.log(`❌ Max reconnection attempts (${this.config.maxRetries}) reached`, 'ERROR');
            this.emit('maxReconnectAttemptsReached');
        }
    }
    
    
    /**
     * Generate unique request ID
     */
    generateRequestId() {
        return `AGG-${Date.now()}-${++this.requestId}`;
    }
    
    /**
     * Start heartbeat for connection monitoring
     */
    startHeartbeat() {
        if (this.heartbeatInterval) return;
        
        this.heartbeatInterval = setInterval(() => {
            if (this.state.connected) {
                this.publishStatusUpdate('HEALTHY', {
                    uptime: Date.now() - this.state.startTime,
                    messageStats: this.messageStats,
                    subscribedChannels: Array.from(this.state.subscribedChannels)
                }).catch(error => {
                    this.log(`❌ Failed to send heartbeat: ${error.message}`, 'ERROR');
                });
            }
        }, this.config.heartbeatInterval);
    }
    
    /**
     * Logging utility
     */
    log(message, level = 'INFO') {
        const timestamp = new Date().toISOString();
        const prefix = this.config.shadowMode ? '[SHADOW]' : '[REDIS]';
        console.log(`[${timestamp}] ${prefix} [${level}] ${message}`);
    }
    
    /**
     * Start simulation for shadow mode with realistic trading data
     */
    startSimulation() {
        this.log('🔍 Starting shadow mode simulation...');
        
        // Simulate periodic market data for common futures instruments
        this.simulationInterval = setInterval(() => {
            if (this.state.subscribedChannels.has(this.config.channels.marketData)) {
                const instruments = ['MES', 'MNQ', 'MGC', 'MCL', 'M2K'];
                const instrument = instruments[Math.floor(Math.random() * instruments.length)];
                
                this.simulateMessage(this.config.channels.marketData, JSON.stringify({
                    type: 'MARKET_DATA',
                    instrument,
                    bid: this.generatePrice(instrument),
                    ask: this.generatePrice(instrument, 0.25),
                    last: this.generatePrice(instrument, 0.125),
                    volume: Math.floor(Math.random() * 1000),
                    timestamp: new Date().toISOString(),
                    source: 'SIMULATED'
                }));
            }
        }, 2000);
        
        // Simulate order fill events
        setTimeout(() => {
            if (this.state.subscribedChannels.has(this.config.channels.userData)) {
                this.simulateMessage(this.config.channels.userData, JSON.stringify({
                    type: 'ORDER_FILLED',
                    orderId: 'SIM-' + Date.now(),
                    instrument: 'MES',
                    side: 'BUY',
                    quantity: 1,
                    fillPrice: 4500.25,
                    timestamp: new Date().toISOString(),
                    source: 'SIMULATED'
                }));
            }
        }, 10000);
        
        this.log('✅ Shadow mode simulation started');
    }
    
    /**
     * Generate realistic prices for instruments
     */
    generatePrice(instrument, offset = 0) {
        const basePrices = {
            'MES': 4500,
            'MNQ': 15000,
            'MGC': 2000,
            'MCL': 70,
            'M2K': 2000
        };
        
        const basePrice = basePrices[instrument] || 1000;
        return basePrice + offset + (Math.random() - 0.5) * 10;
    }
    
    /**
     * Simulate message reception with realistic delays
     */
    simulateMessage(channel, message) {
        const delay = 10 + Math.random() * 50; // 10-60ms delay
        setTimeout(() => {
            this.handleMessage(channel, message);
        }, delay);
    }
    
    /**
     * Schedule reconnection with exponential backoff
     */
    scheduleReconnect() {
        if (this.reconnecting) return;
        
        this.reconnecting = true;
        this.state.reconnectAttempts++;
        
        const backoffDelay = Math.min(
            this.config.reconnectInterval * Math.pow(2, this.state.reconnectAttempts - 1),
            30000 // Max 30 seconds
        );
        
        this.log(`🔄 Scheduling reconnect attempt ${this.state.reconnectAttempts} in ${backoffDelay}ms`);
        
        setTimeout(() => {
            this.reconnecting = false;
            this.initialize();
        }, backoffDelay);
    }
    
    /**
     * Unsubscribe from channel with proper cleanup
     */
    async unsubscribe(channel) {
        if (!this.state.connected) return;
        
        try {
            if (!this.config.shadowMode && this.subscriber) {
                await this.subscriber.unsubscribe(channel);
            }
            
            this.messageHandlers.delete(channel);
            this.state.subscribedChannels.delete(channel);
            
            this.log(`📤 Unsubscribed from channel: ${channel}`);
            this.emit('unsubscribed', { channel });
            
        } catch (error) {
            this.log(`❌ Failed to unsubscribe from ${channel}: ${error.message}`, 'ERROR');
            this.emit('unsubscribeError', { channel, error: error.message });
        }
    }
    
    /**
     * Get comprehensive Redis adapter status
     */
    getStatus() {
        return {
            connected: this.state.connected,
            shadowMode: this.config.shadowMode,
            subscribedChannels: Array.from(this.state.subscribedChannels),
            messageCount: this.state.messageCount,
            lastMessage: this.state.lastMessage,
            uptime: Date.now() - this.state.startTime,
            reconnectAttempts: this.state.reconnectAttempts,
            errorCount: this.errorCount,
            lastError: this.lastError,
            messageStats: this.messageStats,
            pendingRequests: this.pendingRequests.size,
            config: {
                host: this.config.host,
                port: this.config.port,
                channels: this.config.channels
            }
        };
    }
    
    /**
     * Get detailed message statistics
     */
    getStatistics() {
        return {
            ...this.messageStats,
            subscribedChannels: this.state.subscribedChannels.size,
            lastActivity: this.state.lastMessage,
            uptime: Date.now() - this.state.startTime,
            averageMessagesPerMinute: this.messageStats.received / ((Date.now() - this.state.startTime) / 60000),
            errorRate: this.messageStats.errors / Math.max(this.messageStats.received, 1)
        };
    }
    
    /**
     * Gracefully disconnect from Redis with cleanup
     */
    async disconnect() {
        this.log('🔌 Disconnecting from Redis...');
        
        this.state.connected = false;
        
        // Clean up intervals
        if (this.simulationInterval) {
            clearInterval(this.simulationInterval);
            this.simulationInterval = null;
        }
        
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        
        // Clear pending requests
        for (const [requestId, request] of this.pendingRequests) {
            clearTimeout(request.timeout);
            request.reject(new Error('Redis adapter disconnected'));
        }
        this.pendingRequests.clear();
        
        // Close Redis connections
        try {
            if (!this.config.shadowMode) {
                if (this.subscriber) {
                    await this.subscriber.quit();
                    this.subscriber = null;
                }
                if (this.publisher) {
                    await this.publisher.quit();
                    this.publisher = null;
                }
            }
        } catch (error) {
            this.log(`⚠️ Error during Redis disconnect: ${error.message}`, 'WARN');
        }
        
        this.log('✅ Redis adapter disconnected');
        this.emit('disconnected');
    }
}

module.exports = RedisAdapter;