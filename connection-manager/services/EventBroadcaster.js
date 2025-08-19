// connection-manager/services/EventBroadcaster.js
// Handles IPC communication using Redis Pub/Sub

const EventEmitter = require('events');
const redis = require('redis');
const HeartbeatLogger = require('./HeartbeatLogger');

class EventBroadcaster extends EventEmitter {
    constructor(redisConfig = {}) {
        super();
        
        this.config = {
            host: redisConfig.host || 'localhost',
            port: redisConfig.port || 6379,
            // Enhanced connection configuration for stability
            socket: {
                reconnectStrategy: (retries) => {
                    const delay = Math.min(retries * 1000, 30000);
                    console.log(`[Redis] Reconnect attempt ${retries}, delay: ${delay}ms`);
                    return delay;
                },
                connectTimeout: 10000,      // 10 second connection timeout
                keepAlive: 5000,           // Send keep-alive every 5 seconds
                noDelay: true              // Disable Nagle's algorithm for lower latency
            },
            // Connection pool settings
            isolationPoolOptions: {
                min: 2,                    // Minimum connections in pool
                max: 10                    // Maximum connections in pool
            },
            // Enable offline queue to buffer commands during disconnection
            enableOfflineQueue: true,
            // Reconnect on error
            reconnectOnError: (err) => {
                const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
                if (targetErrors.includes(err.code)) {
                    console.log(`[Redis] Reconnecting due to ${err.code} error`);
                    return true;
                }
                return false;
            },
            ...redisConfig
        };
        
        this.publisher = null;
        this.subscriber = null;
        this.isConnected = false;
        this.isReconnecting = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 1000; // Start with 1 second
        
        // Initialize heartbeat logger
        this.heartbeat = new HeartbeatLogger('EventBroadcaster', 30000);
        this.heartbeat.start();
        
        // Channel names
        this.channels = {
            connectionStatus: 'connection:status',
            marketData: 'market:data',
            instanceControl: 'instance:control',
            orderManagement: 'order:management',
            systemEvents: 'system:events',
            accountRequest: 'account-request',
            accountResponse: 'account-response',
            historicalData: 'historical:data:response',
            // Connection Manager request/response channels
            connectionManagerRequests: 'connection-manager:requests',
            positionResponse: 'position-response',
            sltpResponse: 'sltp-response'
        };
        
        console.log('📢 Event Broadcaster initialized');
        
        // Add default error handler to prevent unhandled error crashes
        this.on('error', (error) => {
            console.error('❌ [EventBroadcaster] Error event:', error);
        });
    }
    
    async connect() {
        try {
            // Create Redis clients
            this.publisher = redis.createClient(this.config);
            this.subscriber = redis.createClient(this.config);
            
            // Setup event handlers
            this.publisher.on('error', (err) => {
                console.error('❌ Redis publisher error:', err);
                this.heartbeat.logError('Redis publisher error', { error: err.message });
                this.heartbeat.updateSystemHealth({ connected: false });
                this.emit('error', { type: 'publisher', error: err });
                
                // Handle connection reset errors
                if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
                    this.handleDisconnection('publisher');
                }
            });
            
            this.subscriber.on('error', (err) => {
                console.error('❌ Redis subscriber error:', err);
                this.heartbeat.logError('Redis subscriber error', { error: err.message });
                this.heartbeat.updateSystemHealth({ connected: false });
                this.emit('error', { type: 'subscriber', error: err });
                
                // Handle connection reset errors
                if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
                    this.handleDisconnection('subscriber');
                }
            });
            
            // Setup ready handlers
            this.publisher.on('ready', () => {
                console.log('✅ Redis publisher ready');
                this.heartbeat.updateSystemHealth({ publisherConnected: true });
            });
            
            this.subscriber.on('ready', () => {
                console.log('✅ Redis subscriber ready');
                this.heartbeat.updateSystemHealth({ subscriberConnected: true });
            });
            
            // Setup end handlers
            this.publisher.on('end', () => {
                console.log('⚠️ Redis publisher connection ended');
                this.handleDisconnection('publisher');
            });
            
            this.subscriber.on('end', () => {
                console.log('⚠️ Redis subscriber connection ended');
                this.handleDisconnection('subscriber');
            });
            
            // Connect to Redis
            await Promise.all([
                this.publisher.connect(),
                this.subscriber.connect()
            ]);
            
            this.isConnected = true;
            this.heartbeat.updateSystemHealth({ connected: true });
            console.log('✅ Redis connections established');
            
            // Setup Redis subscriptions
            await this.subscribeAll();
            
            // Setup Redis health check ping
            this.setupHealthCheck();
            
        } catch (error) {
            console.error('❌ Failed to connect to Redis:', error);
            throw error;
        }
    }
    
    // Setup periodic health check to detect stale connections
    setupHealthCheck() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }
        
        this.healthCheckInterval = setInterval(async () => {
            if (this.isConnected && this.publisher && !this.isReconnecting) {
                try {
                    // Send a ping to check connection health
                    await this.publisher.ping();
                } catch (error) {
                    console.error('❌ Redis health check failed:', error.message);
                    this.handleDisconnection('health-check');
                }
            }
        }, 30000); // Check every 30 seconds
    }
    
    async subscribe(channel, handler) {
        if (!this.subscriber) {
            throw new Error('Subscriber not initialized');
        }
        
        await this.subscriber.subscribe(channel, (message) => {
            try {
                let data;
                
                // Debug logging removed for cleaner output
                
                if (typeof message === 'string') {
                    data = JSON.parse(message);
                } else if (typeof message === 'object' && message !== null) {
                    // Check if this is a character array (Redis parsing issue)
                    // Look for numeric keys indicating character array
                    const keys = Object.keys(message);
                    const isCharacterArray = keys.length > 0 && 
                                            keys.every(key => /^\d+$/.test(key)) &&
                                            typeof message[0] === 'string';
                                            
                    if (isCharacterArray) {
                        console.log(`🔧 Detected character array with ${keys.length} elements`);
                        // Reconstruct JSON string from character array
                        const jsonString = Object.keys(message)
                            .sort((a, b) => parseInt(a) - parseInt(b))
                            .map(key => message[key])
                            .join('');
                        console.log(`🔧 Reconstructed JSON: ${jsonString.substring(0, 100)}...`);
                        try {
                            data = JSON.parse(jsonString);
                            console.log(`✅ Successfully parsed: type=${data.type}, requestId=${data.requestId}`);
                        } catch (parseError) {
                            console.error(`❌ JSON parse failed:`, parseError.message);
                            console.error(`   Full JSON: ${jsonString}`);
                            throw parseError;
                        }
                    } else {
                        // Message already properly parsed
                        console.log(`🔍 Using message as-is (not character array)`);
                        data = message;
                    }
                } else {
                    throw new Error(`Unexpected message type: ${typeof message}`);
                }
                handler(data);
            } catch (error) {
                console.error(`Error parsing message from ${channel}:`, error);
                // Debug info removed for cleaner output
            }
        });
        
        this.heartbeat.logEvent('SUBSCRIBE', channel);
        console.log(`✅ Subscribed to channel: ${channel}`);
    }
    
    async subscribeAll() {
        const subscriptions = [
            [this.channels.instanceControl, this.handleInstanceControlMessage.bind(this)],
            [this.channels.orderManagement, this.handleOrderManagementMessage.bind(this)],
            [this.channels.marketData, this.handleMarketDataMessage.bind(this)],
            [this.channels.systemEvents, this.handleSystemEventMessage.bind(this)],
            [this.channels.accountRequest, this.handleAccountRequest.bind(this)],
            [this.channels.connectionManagerRequests, this.handleConnectionManagerRequest.bind(this)]
        ];
        
        for (const [channel, handler] of subscriptions) {
            await this.subscribe(channel, handler);
        }
    }
    
    handleAccountRequest(data) {
        // Emit the account request for the connection manager to handle
        console.log(`[AccountRequest] Received account request:`, data);
        this.emit('ACCOUNT_REQUEST', data);
    }
    
    handleConnectionManagerRequest(data) {
        const { type, payload, requestId, responseChannel } = data;
        console.log(`📨 Raw connection manager request message: ${JSON.stringify(data)}`);
        console.log(`📨 Parsed connection manager request: ${JSON.stringify(data, null, 2)}`);
        console.log(`📨 Processing connection manager request: ${type}, requestId: ${requestId}`);
        
        // Emit the request for the connection manager to handle
        // Use the same event name that ConnectionManager is listening for
        this.emit('connection-manager:requests', data);
    }
    
    handleInstanceControlMessage(data) {
        const { type, payload } = data;
        
        switch (type) {
            case 'REGISTRATION_REQUEST':
                this.emit('REGISTRATION_REQUEST', payload);
                break;
            case 'GET_CONFIG':
                this.emit('GET_CONFIG', payload);
                break;
            case 'MARKET_DATA_SUBSCRIBE':
                this.emit('MARKET_DATA_SUBSCRIBE', payload);
                break;
            case 'REQUEST_ACCOUNT_BALANCE':
                this.emit('REQUEST_ACCOUNT_BALANCE', payload);
                break;
            case 'REQUEST_HISTORICAL_DATA':
                this.emit('REQUEST_HISTORICAL_DATA', payload);
                break;
            case 'REGISTER_ACCOUNT':
                this.emit('REGISTER_ACCOUNT', payload);
                break;
            default:
                // Ignore response messages that we send out
                const responseTypes = [
                    'REGISTRATION_RESPONSE', 'ACCOUNTS_RESPONSE', 'ACCOUNT_RESPONSE',
                    'CONFIG_RESPONSE', 'MARKET_DATA_SUBSCRIPTION_RESPONSE',
                    'ACCOUNT_BALANCE_RESPONSE', 'ACCOUNT_REQUEST', 'ACCOUNT_SELECTED',
                    'HISTORICAL_DATA_RESPONSE'
                ];
                if (!responseTypes.includes(type)) {
                    console.log(`Unknown instance control message type: ${type}`);
                }
        }
    }
    
    handleOrderManagementMessage(data) {
        const { type, payload } = data;
        
        switch (type) {
            case 'PLACE_ORDER':
                this.emit('PLACE_ORDER', payload);
                break;
            case 'CANCEL_ORDER':
                this.emit('CANCEL_ORDER', payload);
                break;
            case 'MODIFY_ORDER':
                this.emit('MODIFY_ORDER', payload);
                break;
            case 'ORDER_RESPONSE':
                // Don't emit locally, this is for external subscribers
                break;
            case 'ORDER_CANCELLATION_RESPONSE':
                // Don't emit locally, this is for external subscribers
                break;
            case 'ORDER_STATUS_UPDATE':
                // Don't emit locally, this is for external subscribers
                break;
            default:
                console.log(`Unknown order management message type: ${type}`);
        }
    }
    
    handleMarketDataMessage(data) {
        const { type, payload } = data;
        
        // Handle the actual market data structure from MarketDataService
        // MarketDataService sends: { instrument, type: 'QUOTE'/'TRADE'/'DEPTH', data }
        if (payload && payload.instrument && payload.type && payload.data) {
            // This is actual market data (quotes, trades, depth) from MarketDataService
            const marketDataEvent = {
                instrument: payload.instrument,
                type: payload.type,
                data: payload.data,
                timestamp: data.timestamp
            };
            
            // Emit specific event types for different market data
            this.emit('MARKET_DATA', marketDataEvent);
            this.emit(`MARKET_DATA_${payload.type}`, marketDataEvent); // MARKET_DATA_QUOTE, MARKET_DATA_TRADE, MARKET_DATA_DEPTH
            
            // Log market data reception (reduced frequency to avoid spam)
            if (Math.random() < 0.01) { // Log ~1% of market data messages
                console.log(`📊 Market data: ${payload.instrument} ${payload.type} - ${payload.type === 'QUOTE' ? `${payload.data.bid}/${payload.data.ask}` : payload.type === 'TRADE' ? `${payload.data.price} x ${payload.data.size}` : 'depth update'}`);
            }
            return;
        }
        
        // Handle other event types (order fills, position updates, etc.)
        switch (type) {
            case 'MARKET_DATA':
                // Handle legacy market data events - order fills and position updates
                this.emit('MARKET_DATA', payload);
                break;
            case 'ORDER_FILLED':
                // Handle order fill events
                this.emit('ORDER_FILLED', payload);
                break;
            case 'POSITION_UPDATE':
                // Handle position update events
                this.emit('POSITION_UPDATE', payload);
                break;
            default:
                // Check if this is a market data type we should handle
                if (type === 'QUOTE' || type === 'TRADE' || type === 'DEPTH') {
                    // Direct market data type - treat as market data
                    this.emit('MARKET_DATA', { type, data: payload });
                    this.emit(`MARKET_DATA_${type}`, { type, data: payload });
                } else {
                    // Log other unknown event types for debugging (but not market data types)
                    console.log(`ℹ️ Received event type: ${type}`);
                    // Still emit the event in case someone wants to handle it
                    this.emit(type, payload);
                }
        }
    }

    handleSystemEventMessage(data) {
        const { type, payload } = data;
        
        switch (type) {
            case 'SHUTDOWN_REQUEST':
                this.emit('SHUTDOWN_REQUEST', payload);
                break;
            case 'HEALTH_CHECK':
                this.emit('HEALTH_CHECK', payload);
                break;
            case 'MARKET_DATA':
                // Handle market data events - these are usually order fills and position updates
                this.emit('MARKET_DATA', payload);
                break;
            case 'SLTP_RESPONSE':
                // Handle SL/TP response events
                this.emit('SLTP_RESPONSE', payload);
                break;
            default:
                // Ignore our own outgoing messages and properly handled market data events
                if (!['ACCOUNTS_RESPONSE', 'ACCOUNT_RESPONSE', 'REGISTRATION_RESPONSE', 'CONFIG_RESPONSE', 
                     'PAUSE_TRADING', 'RESUME_TRADING', 'SHUTDOWN', 'CONNECTION_STATUS', 
                     'RECONCILIATION_REQUIRED', 'HISTORICAL_DATA_RESPONSE', 'position-response', 
                     'BRACKET_ORDER_COMPLETE', 'MARKET_DATA', 'SLTP_RESPONSE', 'market:data'].includes(type)) {
                    console.log(`Unknown system event type: ${type}`);
                }
        }
    }
    
    async publish(eventType, data, channel = null) {
        if (!this.publisher || !this.isConnected) {
            console.error(`Cannot publish ${eventType}: Redis not connected`);
            return false;
        }
        
        try {
            // Determine the appropriate channel based on event type
            if (!channel) {
                switch (eventType) {
                    case 'REGISTRATION_RESPONSE':
                    case 'ACCOUNTS_RESPONSE':
                    case 'ACCOUNT_RESPONSE':
                    case 'CONFIG_RESPONSE':
                    case 'MARKET_DATA_SUBSCRIPTION_RESPONSE':
                    case 'ACCOUNT_BALANCE_RESPONSE':
                    case 'ACCOUNT_REQUEST':
                    case 'ACCOUNT_SELECTED':
                    case 'MANUAL_TRADING_HEARTBEAT':
                        channel = this.channels.instanceControl;
                        break;
                    case 'ORDER_RESPONSE':
                    case 'ORDER_CANCELLATION_RESPONSE':
                    case 'ORDER_STATUS_UPDATE':
                        channel = this.channels.orderManagement;
                        break;
                    case 'MARKET_DATA':
                    case 'market:data':  // Handle MarketDataService publications
                    case 'ORDER_FILLED':
                    case 'POSITION_UPDATE':
                        channel = this.channels.marketData;
                        break;
                    case 'HISTORICAL_DATA_RESPONSE':
                        channel = this.channels.historicalData;
                        break;
                    default:
                        if (eventType === 'position-response') {
                            channel = this.channels.positionResponse;
                        } else if (eventType === 'sltp-response') {
                            channel = this.channels.sltpResponse;
                        } else {
                            channel = this.channels.systemEvents;
                        }
                }
            } else {
                // Override channel if explicitly provided
                if (eventType === 'position-response')
                    channel = this.channels.positionResponse;
                else if (channel === 'system:events')
                    channel = this.channels.systemEvents;
            }
            
            const messageObject = {
                type: eventType,
                payload: data,
                timestamp: Date.now()
            };
            const message = JSON.stringify(messageObject);
            
            // Log important events to heartbeat
            if (eventType === 'ORDER_RESPONSE' || eventType === 'ORDER_FILLED' || eventType === 'position-response') {
                this.heartbeat.logEvent('PUBLISH', channel, { eventType, success: data.success, requestId: data.requestId });
            }
            
            // Silent operation for market data to reduce spam
            // Uncomment for debugging:
            // if (channel === this.channels.marketData) {
            //     console.log(`🔵 Publishing to market:data channel - Event Type: ${eventType}`);
            //     console.log(`   - Payload:`, JSON.stringify(data, null, 2));
            // }
            
            await this.publisher.publish(channel, message);
            
            // Track publish metrics in heartbeat
            this.heartbeat.logEvent('PUBLISH', channel, { eventType, messageSize: message.length });
            
            return true;
            
        } catch (error) {
            console.error(`❌ Failed to publish ${eventType}:`, error);
            return false;
        }
    }
    
    // Handle disconnection and attempt reconnection
    handleDisconnection(clientType) {
        console.log(`🔌 Handling ${clientType} disconnection...`);
        
        if (this.isReconnecting) {
            console.log('🔄 Already attempting to reconnect...');
            return;
        }
        
        this.isConnected = false;
        this.heartbeat.updateSystemHealth({ connected: false });
        
        // Start reconnection process
        this.attemptReconnection();
    }
    
    // Attempt to reconnect with exponential backoff
    async attemptReconnection() {
        if (this.isReconnecting) return;
        
        this.isReconnecting = true;
        this.reconnectAttempts++;
        
        if (this.reconnectAttempts > this.maxReconnectAttempts) {
            console.error('❌ Max reconnection attempts reached. Manual intervention required.');
            this.isReconnecting = false;
            return;
        }
        
        // Calculate backoff delay (exponential with max of 30 seconds)
        const backoffDelay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 30000);
        
        console.log(`🔄 Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${backoffDelay}ms...`);
        
        setTimeout(async () => {
            try {
                // Disconnect existing clients cleanly
                await this.disconnect();
                
                // Reconnect
                await this.connect();
                
                console.log('✅ Successfully reconnected to Redis');
                this.isConnected = true;
                this.isReconnecting = false;
                this.reconnectAttempts = 0;
                this.heartbeat.updateSystemHealth({ connected: true });
                
                // Emit reconnection event
                this.emit('reconnected');
                
            } catch (error) {
                console.error('❌ Reconnection failed:', error.message);
                this.isReconnecting = false;
                
                // Try again
                this.attemptReconnection();
            }
        }, backoffDelay);
    }
    
    async disconnect() {
        try {
            this.isConnected = false;
            
            if (this.healthCheckInterval) {
                clearInterval(this.healthCheckInterval);
                this.healthCheckInterval = null;
            }
            
            if (this.publisher) {
                try {
                    await this.publisher.quit();
                } catch (err) {
                    console.log('⚠️ Publisher quit error (may already be disconnected):', err.message);
                }
                this.publisher = null;
            }
            
            if (this.subscriber) {
                try {
                    await this.subscriber.quit();
                } catch (err) {
                    console.log('⚠️ Subscriber quit error (may already be disconnected):', err.message);
                }
                this.subscriber = null;
            }
            
            console.log('🔌 Disconnected from Redis');
            this.heartbeat.updateSystemHealth({ connected: false });
            
        } catch (error) {
            console.error('❌ Error during disconnect:', error);
        }
    }
}

module.exports = EventBroadcaster;