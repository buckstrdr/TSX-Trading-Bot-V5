/**
 * RedisConnectionManager.js
 * 
 * Manages Redis connections with pooling, channel management, and automatic reconnection.
 * Supports bot-specific namespacing for multi-bot environments.
 */

const redis = require('redis');
const EventEmitter = require('events');

class RedisConnectionManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            host: config.host || 'localhost',
            port: config.port || 6379,
            minConnections: config.minConnections || 2,
            maxConnections: config.maxConnections || 10,
            retryStrategy: config.retryStrategy || this.defaultRetryStrategy,
            enableMetrics: config.enableMetrics !== false,
            messageQueueSize: config.messageQueueSize || 1000,
            ...config
        };
        
        // Connection pools
        this.publisherPool = [];
        this.subscriberPool = [];
        this.availablePublishers = [];
        
        // Channel management
        this.channels = new Map(); // channel -> Set of callbacks
        this.channelSubscribers = new Map(); // channel -> subscriber client
        
        // Message queue for disconnected state
        this.messageQueue = [];
        this.isConnected = false;
        
        // Metrics
        this.metrics = {
            publishedMessages: 0,
            receivedMessages: 0,
            reconnections: 0,
            errors: 0,
            queuedMessages: 0,
            poolSize: 0,
            activeSubscriptions: 0
        };
        
        // Reconnection state
        this.reconnectTimer = null;
        this.reconnectAttempts = 0;
        
        console.log('🔧 RedisConnectionManager initialized');
    }
    
    /**
     * Default retry strategy with exponential backoff
     */
    defaultRetryStrategy(times) {
        if (times > 10) {
            // After 10 attempts, give up
            return undefined;
        }
        // Exponential backoff: 100ms, 200ms, 400ms, 800ms...
        return Math.min(times * 100, 3000);
    }
    
    /**
     * Initialize connection pools
     */
    async connect() {
        try {
            console.log('🔄 Initializing Redis connection pools...');
            
            // Create minimum number of publishers
            for (let i = 0; i < this.config.minConnections; i++) {
                await this.createPublisher();
            }
            
            // Create initial subscriber
            await this.createSubscriber();
            
            this.isConnected = true;
            this.reconnectAttempts = 0;
            
            // Process queued messages
            await this.processMessageQueue();
            
            console.log(`✅ RedisConnectionManager connected with ${this.publisherPool.length} publishers`);
            this.emit('connected');
            
            return true;
        } catch (error) {
            console.error('❌ Failed to connect RedisConnectionManager:', error);
            this.scheduleReconnect();
            throw error;
        }
    }
    
    /**
     * Create a new publisher connection
     */
    async createPublisher() {
        if (this.publisherPool.length >= this.config.maxConnections) {
            return null;
        }
        
        const client = redis.createClient({
            host: this.config.host,
            port: this.config.port,
            retry_strategy: this.config.retryStrategy
        });
        
        // Setup error handlers
        client.on('error', (err) => {
            this.metrics.errors++;
            console.error('❌ Redis publisher error:', err);
            this.emit('error', { type: 'publisher', error: err });
        });
        
        client.on('ready', () => {
            console.log('✅ Redis publisher ready');
            this.availablePublishers.push(client);
        });
        
        client.on('end', () => {
            this.removePublisher(client);
            this.checkConnectionHealth();
        });
        
        await client.connect();
        this.publisherPool.push(client);
        this.metrics.poolSize = this.publisherPool.length;
        
        return client;
    }
    
    /**
     * Create a new subscriber connection
     */
    async createSubscriber() {
        const client = redis.createClient({
            host: this.config.host,
            port: this.config.port,
            retry_strategy: this.config.retryStrategy
        });
        
        // Setup error handlers
        client.on('error', (err) => {
            this.metrics.errors++;
            console.error('❌ Redis subscriber error:', err);
            this.emit('error', { type: 'subscriber', error: err });
        });
        
        client.on('ready', () => {
            console.log('✅ Redis subscriber ready');
        });
        
        client.on('end', () => {
            this.removeSubscriber(client);
            this.checkConnectionHealth();
        });
        
        await client.connect();
        this.subscriberPool.push(client);
        
        return client;
    }
    
    /**
     * Get an available publisher from the pool
     */
    async getPublisher() {
        // Return available publisher or create new one if needed
        if (this.availablePublishers.length > 0) {
            return this.availablePublishers.pop();
        }
        
        // Try to create new publisher if under limit
        if (this.publisherPool.length < this.config.maxConnections) {
            const newPublisher = await this.createPublisher();
            if (newPublisher) {
                return this.availablePublishers.pop();
            }
        }
        
        // Use round-robin on existing publishers
        const index = this.metrics.publishedMessages % this.publisherPool.length;
        return this.publisherPool[index];
    }
    
    /**
     * Return publisher to pool
     */
    releasePublisher(client) {
        if (!this.availablePublishers.includes(client)) {
            this.availablePublishers.push(client);
        }
    }
    
    /**
     * Subscribe to a channel with bot-specific namespacing
     */
    async subscribe(channel, callback, botId = null) {
        const namespacedChannel = botId ? `${botId}:${channel}` : channel;
        
        // Store callback
        if (!this.channels.has(namespacedChannel)) {
            this.channels.set(namespacedChannel, new Set());
        }
        this.channels.get(namespacedChannel).add(callback);
        
        // Check if already subscribed
        if (this.channelSubscribers.has(namespacedChannel)) {
            return true;
        }
        
        try {
            // Get or create subscriber
            let subscriber = this.subscriberPool[0];
            if (!subscriber) {
                subscriber = await this.createSubscriber();
            }
            
            // Subscribe to channel
            await subscriber.subscribe(namespacedChannel, (message) => {
                this.handleMessage(namespacedChannel, message);
            });
            
            this.channelSubscribers.set(namespacedChannel, subscriber);
            this.metrics.activeSubscriptions = this.channelSubscribers.size;
            
            console.log(`✅ Subscribed to channel: ${namespacedChannel}`);
            return true;
            
        } catch (error) {
            console.error(`❌ Failed to subscribe to ${namespacedChannel}:`, error);
            throw error;
        }
    }
    
    /**
     * Unsubscribe from a channel
     */
    async unsubscribe(channel, callback = null, botId = null) {
        const namespacedChannel = botId ? `${botId}:${channel}` : channel;
        
        if (!this.channels.has(namespacedChannel)) {
            return true;
        }
        
        // Remove specific callback or all callbacks
        if (callback) {
            this.channels.get(namespacedChannel).delete(callback);
            if (this.channels.get(namespacedChannel).size > 0) {
                return true; // Still have other listeners
            }
        }
        
        // Remove channel subscription
        this.channels.delete(namespacedChannel);
        
        const subscriber = this.channelSubscribers.get(namespacedChannel);
        if (subscriber) {
            try {
                await subscriber.unsubscribe(namespacedChannel);
                this.channelSubscribers.delete(namespacedChannel);
                this.metrics.activeSubscriptions = this.channelSubscribers.size;
                console.log(`✅ Unsubscribed from channel: ${namespacedChannel}`);
            } catch (error) {
                console.error(`❌ Failed to unsubscribe from ${namespacedChannel}:`, error);
            }
        }
        
        return true;
    }
    
    /**
     * Publish a message to a channel
     */
    async publish(channel, data, botId = null) {
        const namespacedChannel = botId ? `${botId}:${channel}` : channel;
        
        // Queue message if not connected
        if (!this.isConnected) {
            if (this.messageQueue.length < this.config.messageQueueSize) {
                this.messageQueue.push({ channel: namespacedChannel, data, timestamp: Date.now() });
                this.metrics.queuedMessages = this.messageQueue.length;
                return false;
            }
            throw new Error('Redis not connected and message queue full');
        }
        
        try {
            const publisher = await this.getPublisher();
            const message = this.serializeMessage(data);
            
            await publisher.publish(namespacedChannel, message);
            
            this.releasePublisher(publisher);
            this.metrics.publishedMessages++;
            
            return true;
            
        } catch (error) {
            console.error(`❌ Failed to publish to ${namespacedChannel}:`, error);
            
            // Queue message for retry
            if (this.messageQueue.length < this.config.messageQueueSize) {
                this.messageQueue.push({ channel: namespacedChannel, data, timestamp: Date.now() });
                this.metrics.queuedMessages = this.messageQueue.length;
            }
            
            throw error;
        }
    }
    
    /**
     * Handle incoming messages
     */
    handleMessage(channel, message) {
        this.metrics.receivedMessages++;
        
        try {
            const data = this.deserializeMessage(message);
            
            // Notify all callbacks for this channel
            const callbacks = this.channels.get(channel);
            if (callbacks) {
                callbacks.forEach(callback => {
                    try {
                        callback(data, channel);
                    } catch (error) {
                        console.error(`❌ Error in message callback for ${channel}:`, error);
                        this.emit('error', { type: 'callback', channel, error });
                    }
                });
            }
            
            // Emit message event
            this.emit('message', { channel, data });
            
        } catch (error) {
            console.error(`❌ Error handling message from ${channel}:`, error);
            this.emit('error', { type: 'message', channel, error });
        }
    }
    
    /**
     * Serialize message for transmission
     */
    serializeMessage(data) {
        if (typeof data === 'string') {
            return data;
        }
        return JSON.stringify(data);
    }
    
    /**
     * Deserialize received message
     */
    deserializeMessage(message) {
        try {
            return JSON.parse(message);
        } catch {
            return message; // Return as-is if not JSON
        }
    }
    
    /**
     * Process queued messages after reconnection
     */
    async processMessageQueue() {
        if (this.messageQueue.length === 0) {
            return;
        }
        
        console.log(`📤 Processing ${this.messageQueue.length} queued messages...`);
        
        const messages = [...this.messageQueue];
        this.messageQueue = [];
        this.metrics.queuedMessages = 0;
        
        for (const { channel, data } of messages) {
            try {
                await this.publish(channel, data);
            } catch (error) {
                console.error(`❌ Failed to send queued message to ${channel}:`, error);
            }
        }
    }
    
    /**
     * Remove publisher from pool
     */
    removePublisher(client) {
        const index = this.publisherPool.indexOf(client);
        if (index > -1) {
            this.publisherPool.splice(index, 1);
            this.metrics.poolSize = this.publisherPool.length;
        }
        
        const availIndex = this.availablePublishers.indexOf(client);
        if (availIndex > -1) {
            this.availablePublishers.splice(availIndex, 1);
        }
    }
    
    /**
     * Remove subscriber from pool
     */
    removeSubscriber(client) {
        const index = this.subscriberPool.indexOf(client);
        if (index > -1) {
            this.subscriberPool.splice(index, 1);
        }
        
        // Remove channel associations
        for (const [channel, subscriber] of this.channelSubscribers.entries()) {
            if (subscriber === client) {
                this.channelSubscribers.delete(channel);
            }
        }
        this.metrics.activeSubscriptions = this.channelSubscribers.size;
    }
    
    /**
     * Check connection health and reconnect if needed
     */
    checkConnectionHealth() {
        const hasPublishers = this.publisherPool.length > 0;
        const hasSubscribers = this.subscriberPool.length > 0;
        
        if (!hasPublishers || !hasSubscribers) {
            this.isConnected = false;
            this.emit('disconnected');
            this.scheduleReconnect();
        }
    }
    
    /**
     * Schedule reconnection attempt
     */
    scheduleReconnect() {
        if (this.reconnectTimer) {
            return; // Already scheduled
        }
        
        this.reconnectAttempts++;
        const delay = this.config.retryStrategy(this.reconnectAttempts);
        
        if (delay === undefined) {
            console.error('❌ Max reconnection attempts reached');
            this.emit('reconnectFailed');
            return;
        }
        
        console.log(`🔄 Scheduling reconnection attempt ${this.reconnectAttempts} in ${delay}ms...`);
        
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                await this.connect();
                this.metrics.reconnections++;
            } catch (error) {
                console.error('❌ Reconnection failed:', error);
                this.scheduleReconnect();
            }
        }, delay);
    }
    
    /**
     * Get current metrics
     */
    getMetrics() {
        return {
            ...this.metrics,
            isConnected: this.isConnected,
            publisherPoolSize: this.publisherPool.length,
            subscriberPoolSize: this.subscriberPool.length,
            availablePublishers: this.availablePublishers.length,
            queuedMessages: this.messageQueue.length,
            activeChannels: this.channels.size
        };
    }
    
    /**
     * Disconnect all connections
     */
    async disconnect() {
        console.log('🔌 Disconnecting RedisConnectionManager...');
        
        // Clear reconnection timer
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        
        // Disconnect all publishers
        for (const publisher of this.publisherPool) {
            try {
                await publisher.quit();
            } catch (error) {
                console.error('❌ Error disconnecting publisher:', error);
            }
        }
        
        // Disconnect all subscribers
        for (const subscriber of this.subscriberPool) {
            try {
                await subscriber.quit();
            } catch (error) {
                console.error('❌ Error disconnecting subscriber:', error);
            }
        }
        
        // Clear pools and state
        this.publisherPool = [];
        this.subscriberPool = [];
        this.availablePublishers = [];
        this.channels.clear();
        this.channelSubscribers.clear();
        this.isConnected = false;
        
        console.log('✅ RedisConnectionManager disconnected');
        this.emit('disconnected');
    }
}

module.exports = RedisConnectionManager;