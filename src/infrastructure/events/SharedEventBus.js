/**
 * SharedEventBus - Adapted from EventBroadcaster for V4 Architecture
 * Handles inter-service communication using Redis Pub/Sub
 * Supports both legacy channels and new bot-specific channels
 */

const EventEmitter = require('events');
const redis = require('redis');

class SharedEventBus extends EventEmitter {
    constructor(redisConfig = {}, logger = null) {
        super();
        
        this.config = {
            host: redisConfig.host || 'localhost',
            port: redisConfig.port || 6379,
            retryStrategy: (times) => {
                const delay = Math.min(times * 50, 2000);
                return delay;
            },
            ...redisConfig
        };
        
        this.logger = logger || console;
        this.publisher = null;
        this.subscriber = null;
        this.isConnected = false;
        
        // Legacy channels (maintained for compatibility)
        this.channels = {
            connectionStatus: 'connection:status',
            marketData: 'market:data',
            instanceControl: 'instance:control',
            orderManagement: 'order:management',
            systemEvents: 'system:events',
            accountRequest: 'account-request',
            accountResponse: 'account-response',
            historicalData: 'historical:data:response',
            instrumentRequest: 'instrument-request',
            instrumentResponse: 'instrument-response'
        };
        
        // New bot-specific channel patterns for V4
        this.botChannelPatterns = {
            orders: 'bot{id}:orders',
            positions: 'bot{id}:positions',
            status: 'bot{id}:status',
            control: 'bot{id}:control',
            events: 'bot{id}:events'
        };
        
        // Global channels for V4
        this.globalChannels = {
            marketData: 'market:data',
            marketTrades: 'market:trades',
            marketQuotes: 'market:quotes',
            systemEvents: 'system:events',
            systemHealth: 'system:health',
            systemAlerts: 'system:alerts',
            accountUpdates: 'account:updates',
            accountBalance: 'account:balance',
            accountStatus: 'account:status',
            positionUpdates: 'position:updates'
        };
        
        // Track subscribed channels
        this.subscribedChannels = new Set();
        
        this.logger.info('📢 SharedEventBus initialized');
    }
    
    /**
     * Connect to Redis and setup base subscriptions
     */
    async connect() {
        try {
            // Create Redis clients
            this.publisher = redis.createClient(this.config);
            this.subscriber = redis.createClient(this.config);
            
            // Setup error handlers
            this.publisher.on('error', (err) => {
                this.logger.error('❌ Redis publisher error:', err);
                this.emit('error', { type: 'publisher', error: err });
            });
            
            this.subscriber.on('error', (err) => {
                this.logger.error('❌ Redis subscriber error:', err);
                this.emit('error', { type: 'subscriber', error: err });
            });
            
            // Connect clients
            await this.publisher.connect();
            await this.subscriber.connect();
            
            // Setup legacy subscriptions for backward compatibility
            await this.setupLegacySubscriptions();
            
            this.isConnected = true;
            this.logger.info('✅ SharedEventBus connected to Redis');
            
            return true;
            
        } catch (error) {
            this.logger.error('❌ Failed to connect SharedEventBus:', error);
            throw error;
        }
    }
    
    /**
     * Setup legacy subscriptions for backward compatibility
     */
    async setupLegacySubscriptions() {
        // Subscribe to instance control channel
        await this.subscribeToChannel(this.channels.instanceControl, (message) => {
            try {
                const data = JSON.parse(message);
                this.handleInstanceControlMessage(data);
            } catch (error) {
                this.logger.error('❌ Error parsing instance control message:', error);
            }
        });
        
        // Subscribe to order management channel
        await this.subscribeToChannel(this.channels.orderManagement, (message) => {
            try {
                const data = JSON.parse(message);
                this.handleOrderManagementMessage(data);
            } catch (error) {
                this.logger.error('❌ Error parsing order management message:', error);
            }
        });
        
        // Subscribe to system events
        await this.subscribeToChannel(this.channels.systemEvents, (message) => {
            try {
                const data = JSON.parse(message);
                this.handleSystemEventMessage(data);
            } catch (error) {
                this.logger.error('❌ Error parsing system event message:', error);
            }
        });
        
        // Subscribe to account requests
        await this.subscribeToChannel(this.channels.accountRequest, (message) => {
            try {
                const data = JSON.parse(message);
                this.emit('account-request', data);
            } catch (error) {
                this.logger.error('❌ Error parsing account request message:', error);
            }
        });
        
        // Subscribe to instrument requests
        await this.subscribeToChannel(this.channels.instrumentRequest, (message) => {
            try {
                const data = JSON.parse(message);
                this.emit('instrument-request', data);
            } catch (error) {
                this.logger.error('❌ Error parsing instrument request message:', error);
            }
        });
    }
    
    /**
     * Subscribe to a specific channel
     */
    async subscribeToChannel(channel, handler) {
        if (this.subscribedChannels.has(channel)) {
            this.logger.warn(`⚠️ Already subscribed to channel: ${channel}`);
            return;
        }
        
        this.logger.info(`📡 Subscribing to channel: ${channel}`);
        await this.subscriber.subscribe(channel, handler);
        this.subscribedChannels.add(channel);
        this.logger.info(`✅ Subscribed to channel: ${channel}`);
    }
    
    /**
     * Subscribe to bot-specific channels
     * @param {string} botId - The bot identifier (e.g., 'BOT_1', 'BOT_2', etc.)
     */
    async subscribeToBotChannels(botId) {
        const channels = this.getBotChannels(botId);
        
        for (const [type, channel] of Object.entries(channels)) {
            await this.subscribeToChannel(channel, (message) => {
                try {
                    const data = JSON.parse(message);
                    this.emit(`bot:${type}`, { botId, data });
                } catch (error) {
                    this.logger.error(`❌ Error parsing bot ${type} message:`, error);
                }
            });
        }
    }
    
    /**
     * Subscribe to global V4 channels
     */
    async subscribeToGlobalChannels() {
        for (const [type, channel] of Object.entries(this.globalChannels)) {
            await this.subscribeToChannel(channel, (message) => {
                try {
                    const data = JSON.parse(message);
                    this.emit(`global:${type}`, data);
                } catch (error) {
                    this.logger.error(`❌ Error parsing global ${type} message:`, error);
                }
            });
        }
    }
    
    /**
     * Get bot-specific channels for a given bot ID
     */
    getBotChannels(botId) {
        const channels = {};
        for (const [type, pattern] of Object.entries(this.botChannelPatterns)) {
            channels[type] = pattern.replace('{id}', botId.toLowerCase());
        }
        return channels;
    }
    
    /**
     * Handle legacy instance control messages
     */
    handleInstanceControlMessage(data) {
        const { type, payload } = data;
        
        const eventMap = {
            'REGISTER_INSTANCE': 'REGISTER_INSTANCE',
            'DEREGISTER_INSTANCE': 'DEREGISTER_INSTANCE',
            'SUBSCRIBE_MARKET_DATA': 'SUBSCRIBE_MARKET_DATA',
            'UNSUBSCRIBE_MARKET_DATA': 'UNSUBSCRIBE_MARKET_DATA',
            'GET_ACCOUNTS': 'GET_ACCOUNTS',
            'REQUEST_CONFIG': 'REQUEST_CONFIG',
            'GET_ACCOUNT_BALANCE': 'GET_ACCOUNT_BALANCE',
            'GET_OPEN_POSITIONS': 'GET_OPEN_POSITIONS',
            'GET_ORDERS': 'GET_ORDERS',
            'REQUEST_HISTORICAL_DATA': 'REQUEST_HISTORICAL_DATA'
        };
        
        if (eventMap[type]) {
            this.emit(eventMap[type], payload);
        }
    }
    
    /**
     * Handle legacy order management messages
     */
    handleOrderManagementMessage(data) {
        const { type, payload } = data;
        
        const eventMap = {
            'PLACE_ORDER': 'PLACE_ORDER',
            'CANCEL_ORDER': 'CANCEL_ORDER',
            'MODIFY_ORDER': 'MODIFY_ORDER'
        };
        
        if (eventMap[type]) {
            this.emit(eventMap[type], payload);
        }
    }
    
    /**
     * Handle legacy system event messages
     */
    handleSystemEventMessage(data) {
        const { type, payload } = data;
        
        const eventMap = {
            'SHUTDOWN_REQUEST': 'SHUTDOWN_REQUEST',
            'HEALTH_CHECK': 'HEALTH_CHECK'
        };
        
        if (eventMap[type]) {
            this.emit(eventMap[type], payload);
        }
    }
    
    /**
     * Publish a message to appropriate channel
     */
    async publish(eventType, data, options = {}) {
        if (!this.isConnected) {
            this.logger.error('❌ Cannot publish - SharedEventBus not connected');
            return false;
        }
        
        try {
            let channel;
            
            // Check if this is a bot-specific event
            if (options.botId && options.botChannel) {
                const botChannels = this.getBotChannels(options.botId);
                channel = botChannels[options.botChannel];
            } 
            // Check if this is a global V4 channel
            else if (options.globalChannel) {
                channel = this.globalChannels[options.globalChannel];
            }
            // Otherwise use legacy channel mapping
            else {
                channel = this.mapEventTypeToChannel(eventType);
            }
            
            const messageObject = {
                type: eventType,
                payload: data,
                timestamp: Date.now(),
                source: options.source || 'SharedEventBus'
            };
            
            const message = JSON.stringify(messageObject);
            
            // Debug logging for important events
            if (this.shouldLogEvent(eventType)) {
                this.logger.info(`📤 SharedEventBus publishing ${eventType}:`);
                this.logger.info(`   - Channel: ${channel}`);
                this.logger.debug(`   - Message:`, messageObject);
            }
            
            await this.publisher.publish(channel, message);
            
            return true;
            
        } catch (error) {
            this.logger.error(`❌ Failed to publish ${eventType}:`, error);
            return false;
        }
    }
    
    /**
     * Publish to a bot-specific channel
     */
    async publishToBotChannel(botId, channelType, eventType, data) {
        return this.publish(eventType, data, {
            botId,
            botChannel: channelType,
            source: botId
        });
    }
    
    /**
     * Publish to a global channel
     */
    async publishToGlobalChannel(channelType, eventType, data) {
        return this.publish(eventType, data, {
            globalChannel: channelType,
            source: 'Global'
        });
    }
    
    /**
     * Map legacy event types to channels
     */
    mapEventTypeToChannel(eventType) {
        // Legacy channel mapping
        const channelMap = {
            'CONNECTION_STATUS': this.channels.connectionStatus,
            'PAUSE_TRADING': this.channels.connectionStatus,
            'RESUME_TRADING': this.channels.connectionStatus,
            'SHUTDOWN': this.channels.connectionStatus,
            'RECONCILIATION_REQUIRED': this.channels.connectionStatus,
            'MARKET_DATA': this.channels.marketData,
            'ORDER_FILLED': this.channels.marketData,
            'POSITION_UPDATE': this.channels.marketData,
            'REGISTRATION_RESPONSE': this.channels.instanceControl,
            'ACCOUNTS_RESPONSE': this.channels.instanceControl,
            'ACCOUNT_RESPONSE': this.channels.instanceControl,
            'CONFIG_RESPONSE': this.channels.instanceControl,
            'MARKET_DATA_SUBSCRIPTION_RESPONSE': this.channels.instanceControl,
            'ACCOUNT_BALANCE_RESPONSE': this.channels.instanceControl,
            'ORDER_RESPONSE': this.channels.orderManagement,
            'ORDER_CANCELLATION_RESPONSE': this.channels.orderManagement,
            'ORDER_STATUS_UPDATE': this.channels.orderManagement,
            'HISTORICAL_DATA_RESPONSE': this.channels.historicalData,
            'account-response': this.channels.accountResponse,
            'instrument-response': this.channels.instrumentResponse
        };
        
        return channelMap[eventType] || this.channels.systemEvents;
    }
    
    /**
     * Determine if an event should be logged
     */
    shouldLogEvent(eventType) {
        const importantEvents = [
            'ORDER_RESPONSE', 'ORDER_FILLED', 'POSITION_UPDATE',
            'MARKET_DATA', 'CONNECTION_STATUS', 'ERROR'
        ];
        return importantEvents.includes(eventType);
    }
    
    /**
     * Disconnect from Redis
     */
    async disconnect() {
        try {
            if (this.publisher) {
                await this.publisher.quit();
            }
            
            if (this.subscriber) {
                await this.subscriber.quit();
            }
            
            this.isConnected = false;
            this.subscribedChannels.clear();
            this.logger.info('✅ SharedEventBus disconnected');
            
        } catch (error) {
            this.logger.error('❌ Error disconnecting SharedEventBus:', error);
        }
    }
    
    /**
     * Get connection and channel statistics
     */
    getStats() {
        return {
            connected: this.isConnected,
            subscribedChannels: Array.from(this.subscribedChannels),
            channelCount: this.subscribedChannels.size,
            publisherStatus: this.publisher?.isOpen ? 'connected' : 'disconnected',
            subscriberStatus: this.subscriber?.isOpen ? 'connected' : 'disconnected'
        };
    }
}

module.exports = SharedEventBus;