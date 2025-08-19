/**
 * ConnectionManagerAdapter - Live Trading Adapter for V4 Connection Manager
 * Integrates with existing Connection Manager for order execution and market data
 * WebSocketEngineer-1 Implementation - July 24, 2025
 */

const EventEmitter = require('events');
const axios = require('axios');
const WebSocket = require('ws');
const redis = require('redis');

class ConnectionManagerAdapter extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            connectionManagerUrl: config.connectionManagerUrl || 'http://localhost:7500',
            webSocketUrl: config.webSocketUrl || 'ws://localhost:7500',
            reconnectInterval: config.reconnectInterval || 5000,
            timeout: config.timeout || 30000,
            maxRetries: config.maxRetries || 5,
            enableWebSocket: config.enableWebSocket !== false,
            enableDebugLogging: config.enableDebugLogging || false,
            redis: config.redis || { host: 'localhost', port: 6379 }
        };
        
        this.state = {
            connected: false,
            wsConnected: false,
            reconnecting: false,
            lastConnectAttempt: null,
            messageQueue: [],
            retryCount: 0
        };
        
        // WebSocket, HTTP and Redis connections
        this.ws = null;
        this.httpClient = null;
        this.redisClient = null;
        this.reconnectTimer = null;
        this.heartbeatTimer = null;
        
        // Order and position tracking
        this.pendingOrders = new Map();
        this.activePositions = new Map();
        this.marketData = new Map();
        
        console.log('🔌 ConnectionManagerAdapter initialized');
        console.log(`   Target URL: ${this.config.connectionManagerUrl}`);
        console.log(`   WebSocket: ${this.config.webSocketUrl}`);
        console.log(`   Shadow Mode: ${this.config.shadowMode ? 'ENABLED' : 'DISABLED'}`);
    }
    
    /**
     * Initialize connection to Connection Manager
     */
    async connect() {
        try {
            if (this.config.shadowMode) {
                // In shadow mode, simulate connection
                this.state.connected = true;
                this.emit('connected', { shadowMode: true });
                this.log('🎭 Shadow mode active - simulating connection');
                return true;
            }
            
            this.log('🔌 Connecting to Connection Manager...');
            this.state.lastConnectAttempt = new Date();
            
            // Initialize HTTP client
            this.httpClient = axios.create({
                baseURL: this.config.connectionManagerUrl,
                timeout: this.config.timeout,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'TradingAggregator-ConnectionManagerAdapter/1.0'
                }
            });
            
            // Initialize Redis client for order publishing
            this.redisClient = redis.createClient({
                socket: {
                    host: this.config.redis.host,
                    port: this.config.redis.port
                }
            });
            
            await this.redisClient.connect();
            this.log('✅ Redis client connected for order publishing');
            
            // Test HTTP connection
            const healthCheck = await this.httpClient.get('/health');
            if (healthCheck.status === 200 || healthCheck.status === 206) {
                this.state.connected = true;
                this.log(healthCheck.status === 200 ? '✅ HTTP connection established' : '⚠️ HTTP connection established with warnings');
            } else {
                throw new Error(`Health check failed: ${healthCheck.status}`);
            }
            
            // Initialize WebSocket connection if enabled
            if (this.config.enableWebSocket) {
                await this.connectWebSocket();
            }
            
            this.emit('connected', { 
                url: this.config.connectionManagerUrl,
                webSocketEnabled: this.config.enableWebSocket,
                timestamp: new Date()
            });
            
            // Process any queued messages
            this.processMessageQueue();
            
            // Start heartbeat
            this.startHeartbeat();
            
            // Reset retry count on successful connection
            this.state.retryCount = 0;
            
            this.log('🚀 Connection Manager adapter ready');
            return true;
            
        } catch (error) {
            this.log(`❌ Connection failed: ${error.message}`);
            this.emit('connectionError', { error: error.message });
            this.scheduleReconnect();
            return false;
        }
    }
    
    /**
     * Connect to WebSocket for real-time data
     */
    async connectWebSocket() {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(this.config.webSocketUrl);
                
                this.ws.on('open', () => {
                    this.state.wsConnected = true;
                    this.log('🔗 WebSocket connected');
                    this.emit('webSocketConnected');
                    resolve();
                });
                
                this.ws.on('message', (data) => {
                    try {
                        const message = JSON.parse(data.toString());
                        this.handleWebSocketMessage(message);
                    } catch (error) {
                        this.log(`⚠️ WebSocket message parse error: ${error.message}`);
                    }
                });
                
                this.ws.on('close', () => {
                    this.state.wsConnected = false;
                    this.log('🔌 WebSocket disconnected');
                    this.emit('webSocketDisconnected');
                    
                    // Attempt to reconnect WebSocket
                    if (this.state.connected && !this.state.reconnecting) {
                        setTimeout(() => this.connectWebSocket(), this.config.reconnectInterval);
                    }
                });
                
                this.ws.on('error', (error) => {
                    this.log(`❌ WebSocket error: ${error.message}`);
                    this.emit('webSocketError', { error: error.message });
                    reject(error);
                });
                
                // Set connection timeout
                setTimeout(() => {
                    if (!this.state.wsConnected) {
                        reject(new Error('WebSocket connection timeout'));
                    }
                }, 10000);
                
            } catch (error) {
                reject(error);
            }
        });
    }
    
    /**
     * Handle incoming WebSocket messages
     */
    handleWebSocketMessage(message) {
        try {
            const { type, data } = message;
            
            switch (type) {
                case 'FILL':
                case 'ORDER_FILLED':
                    this.handleOrderFill(data);
                    break;
                    
                case 'ORDER_STATUS':
                    this.handleOrderStatus(data);
                    break;
                    
                case 'MARKET_DATA':
                    this.handleMarketData(data);
                    break;
                    
                case 'POSITION_UPDATE':
                    this.handlePositionUpdate(data);
                    break;
                    
                case 'ERROR':
                    this.emit('error', data);
                    break;
                    
                case 'HEARTBEAT':
                    // Connection Manager heartbeat - no action needed
                    break;
                    
                default:
                    this.log(`🔍 Unknown WebSocket message type: ${type}`);
                    this.emit('unknownMessage', message);
            }
            
        } catch (error) {
            this.log(`❌ WebSocket message handling error: ${error.message}`);
            this.emit('messageError', { message, error: error.message });
        }
    }
    
    /**
     * Send order to Connection Manager
     */
    async sendOrder(order) {
        if (!this.state.connected) {
            // Queue message if not connected
            this.state.messageQueue.push({
                type: 'ORDER',
                data: order,
                timestamp: new Date()
            });
            
            this.log(`⏸️ Order queued - not connected: ${order.instrument} ${order.action} ${order.quantity}`);
            return {
                success: false,
                reason: 'NOT_CONNECTED',
                queued: true
            };
        }
        
        try {
            if (this.config.shadowMode) {
                // Simulate order sending
                await this.simulateOrderSend(order);
                return {
                    success: true,
                    orderId: order.id,
                    shadowMode: true
                };
            }
            
            this.log(`📤 Sending order: ${order.instrument} ${order.action} ${order.quantity}`);
            
            // Prepare order payload for Connection Manager (matching manual trading format)
            const orderPayload = {
                instanceId: 'TRADING_AGGREGATOR',
                orderId: order.id,
                accountId: order.accountId || order.account,
                instrument: order.instrument,
                side: order.action, // Convert action to side for Connection Manager
                quantity: order.quantity,
                orderType: order.type || order.orderType || 'MARKET',
                timestamp: Date.now()
            };
            
            // Add optional price fields if specified
            if (order.price) {
                orderPayload.limitPrice = order.price;
            }
            // Map stop loss and take profit fields - support both price and points format
            if (order.stopLoss) {
                if (typeof order.stopLoss === 'object' && order.stopLoss.points) {
                    // Points-based SL/TP (preferred for fill-based calculation)
                    orderPayload.stopLossPoints = order.stopLoss.points;
                } else {
                    // Price-based SL/TP (legacy)
                    orderPayload.stopPrice = order.stopLoss;
                }
            }
            if (order.takeProfit) {
                if (typeof order.takeProfit === 'object' && order.takeProfit.points) {
                    // Points-based SL/TP (preferred for fill-based calculation)
                    orderPayload.takeProfitPoints = order.takeProfit.points;
                } else {
                    // Price-based SL/TP (legacy) - use takeProfitPrice, not limitPrice
                    orderPayload.takeProfitPrice = order.takeProfit;
                }
            }
            
            // CRITICAL FIX: Pass through direct SL/TP fields from Manual Trading (takes precedence)
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
            
            // Send order via Redis to Connection Manager (same as manual trading)
            const redisMessage = {
                type: 'PLACE_ORDER',
                payload: orderPayload,
                source: 'TRADING_AGGREGATOR',  // Prevent feedback loop
                timestamp: new Date().toISOString()
            };
            
            await this.redisClient.publish('order:management', JSON.stringify(redisMessage));
            
            this.log(`📤 Order sent via Redis to Connection Manager`);
            this.log(`   - Channel: order:management`);
            this.log(`   - OrderId: ${order.id}`);
            
            // Simulate successful response for now
            const response = { data: { success: true, orderId: order.id } };
            
            if (response.data && response.data.success) {
                // Track pending order
                this.pendingOrders.set(order.id, {
                    ...order,
                    status: 'PENDING',
                    sentAt: new Date(),
                    connectionManagerOrderId: response.data.orderId
                });
                
                this.log(`✅ Order sent successfully: ${order.id}`);
                
                this.emit('orderSent', {
                    order: orderPayload,
                    response: response.data,
                    timestamp: new Date()
                });
                
                return {
                    success: true,
                    orderId: order.id,
                    connectionManagerOrderId: response.data.orderId,
                    response: response.data
                };
            } else {
                throw new Error(response.data?.error || 'Unknown error from Connection Manager');
            }
            
        } catch (error) {
            this.log(`❌ Order send failed: ${error.message}`);
            
            this.emit('sendError', {
                order,
                error: error.message
            });
            
            return {
                success: false,
                error: error.message,
                details: error.response?.data
            };
        }
    }
    
    /**
     * Send order modification
     */
    async modifyOrder(modification) {
        if (!this.state.connected) {
            this.state.messageQueue.push({
                type: 'MODIFY',
                data: modification,
                timestamp: new Date()
            });
            
            return {
                success: false,
                reason: 'NOT_CONNECTED',
                queued: true
            };
        }
        
        try {
            if (this.config.shadowMode) {
                await this.simulateOrderModify(modification);
                return {
                    success: true,
                    shadowMode: true
                };
            }
            
            // TODO: Implement actual modification
            
            this.emit('orderModified', {
                modification,
                timestamp: new Date()
            });
            
            return { success: true };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Send order cancellation
     */
    async cancelOrder(cancellation) {
        if (!this.state.connected) {
            this.state.messageQueue.push({
                type: 'CANCEL',
                data: cancellation,
                timestamp: new Date()
            });
            
            return {
                success: false,
                reason: 'NOT_CONNECTED',
                queued: true
            };
        }
        
        try {
            if (this.config.shadowMode) {
                await this.simulateOrderCancel(cancellation);
                return {
                    success: true,
                    shadowMode: true
                };
            }
            
            // TODO: Implement actual cancellation
            
            this.emit('orderCancelled', {
                cancellation,
                timestamp: new Date()
            });
            
            return { success: true };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Get positions from Connection Manager
     */
    async getPositions(accountId = null) {
        if (!this.state.connected) {
            return {
                success: false,
                reason: 'NOT_CONNECTED'
            };
        }
        
        try {
            if (this.config.shadowMode) {
                return {
                    success: true,
                    positions: Array.from(this.activePositions.values()),
                    shadowMode: true
                };
            }
            
            this.log(`🔍 Requesting positions${accountId ? ` for account ${accountId}` : ''}`);
            
            const url = accountId ? `/api/positions?accountId=${accountId}` : '/api/positions';
            const response = await this.httpClient.get(url);
            
            if (response.data && response.data.success) {
                // Extract positions array
                const positions = response.data.positions || [];
                
                // Update cached positions
                if (Array.isArray(positions)) {
                    positions.forEach(position => {
                        const key = `${position.accountId}_${position.instrument}_${position.side}`;
                        this.activePositions.set(key, position);
                    });
                }
                
                this.log(`✅ Retrieved ${positions.length} positions`);
                
                return positions; // Return array directly for aggregator
            } else {
                throw new Error(response.data?.error || 'Failed to fetch positions');
            }
            
        } catch (error) {
            this.log(`❌ Get positions failed: ${error.message}`);
            
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Update position SL/TP through Connection Manager
     */
    async updatePositionSLTP(data) {
        if (!this.state.connected) {
            return {
                success: false,
                reason: 'NOT_CONNECTED'
            };
        }
        
        try {
            this.log(`📤 Sending SL/TP update request via Redis: positionId=${data.positionId}, SL=${data.stopLoss}, TP=${data.takeProfit}`);
            
            const requestId = `sltp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            
            // Subscribe to response first
            const responsePromise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('SL/TP update request timeout'));
                }, 15000);
                
                const responseHandler = (message) => {
                    try {
                        const responseData = JSON.parse(message);
                        if (responseData.type === 'sltp-response' && responseData.payload?.requestId === requestId) {
                            clearTimeout(timeout);
                            this.redisClient.unsubscribe('sltp-response');
                            
                            if (responseData.payload.success) {
                                resolve(responseData.payload);
                            } else {
                                reject(new Error(responseData.payload.error || 'SL/TP update failed'));
                            }
                        }
                    } catch (e) {
                        this.log(`Error parsing SL/TP response: ${e.message}`);
                    }
                };
                
                this.redisClient.subscribe('sltp-response');
                this.redisClient.on('message', (channel, message) => {
                    if (channel === 'sltp-response') {
                        responseHandler(message);
                    }
                });
            });
            
            // Send request via Redis
            await this.redisClient.publish('connection-manager:requests', JSON.stringify({
                type: 'UPDATE_SLTP',
                requestId: requestId,
                positionId: data.positionId,
                stopLoss: data.stopLoss,
                takeProfit: data.takeProfit,
                accountId: data.accountId,
                timestamp: Date.now()
            }));
            
            // Wait for response
            const result = await responsePromise;
            this.log(`✅ SL/TP update completed successfully`);
            
            return {
                success: true,
                result: result
            };
            
        } catch (error) {
            this.log(`❌ SL/TP update failed: ${error.message}`);
            
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Subscribe to market data
     */
    async subscribeMarketData(instruments) {
        if (!this.state.connected) {
            return {
                success: false,
                reason: 'NOT_CONNECTED'
            };
        }
        
        try {
            if (this.config.shadowMode) {
                // Start simulated market data
                this.startSimulatedMarketData(instruments);
                return {
                    success: true,
                    instruments,
                    shadowMode: true
                };
            }
            
            this.log(`📊 Subscribing to market data: ${instruments.join(', ')}`);
            
            // Send WebSocket subscription request
            if (this.state.wsConnected) {
                const subscriptionMessage = {
                    type: 'SUBSCRIBE_MARKET_DATA',
                    instruments: instruments,
                    timestamp: new Date().toISOString()
                };
                
                this.ws.send(JSON.stringify(subscriptionMessage));
                
                // Track subscribed instruments
                instruments.forEach(instrument => {
                    this.marketData.set(instrument, {
                        instrument,
                        subscribed: true,
                        lastUpdate: null
                    });
                });
                
                this.log(`✅ Market data subscription sent for ${instruments.length} instruments`);
                
                return {
                    success: true,
                    instruments,
                    method: 'WebSocket'
                };
            } else {
                // Fallback to HTTP polling if WebSocket not available
                this.log('⚠️ WebSocket not connected, market data subscription skipped');
                return {
                    success: false,
                    reason: 'WebSocket not connected'
                };
            }
            
        } catch (error) {
            this.log(`❌ Market data subscription failed: ${error.message}`);
            
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Handle order fill from Connection Manager
     */
    handleOrderFill(data) {
        try {
            this.log(`🎯 Order fill received: ${data.instrument} ${data.quantity} @ ${data.fillPrice}`);
            
            // Update pending order status
            if (data.orderId && this.pendingOrders.has(data.orderId)) {
                const order = this.pendingOrders.get(data.orderId);
                order.status = 'FILLED';
                order.fillPrice = data.fillPrice;
                order.fillTime = new Date(data.fillTime || Date.now());
                
                // Move to positions if fully filled
                const positionKey = `${data.account}_${data.instrument}_${data.side}`;
                this.activePositions.set(positionKey, {
                    account: data.account,
                    instrument: data.instrument,
                    side: data.side,
                    quantity: data.quantity,
                    averagePrice: data.fillPrice,
                    unrealizedPnL: 0,
                    timestamp: new Date()
                });
                
                // Remove from pending orders
                this.pendingOrders.delete(data.orderId);
            }
            
            this.emit('fill', data);
            
        } catch (error) {
            this.log(`❌ Order fill handling error: ${error.message}`);
            this.emit('fillError', { data, error: error.message });
        }
    }
    
    /**
     * Handle order status update from Connection Manager
     */
    handleOrderStatus(data) {
        try {
            this.log(`📋 Order status: ${data.orderId} - ${data.status}`);
            
            // Update pending order status
            if (data.orderId && this.pendingOrders.has(data.orderId)) {
                const order = this.pendingOrders.get(data.orderId);
                order.status = data.status;
                order.lastUpdate = new Date();
                
                // Remove from pending if cancelled or rejected
                if (data.status === 'CANCELLED' || data.status === 'REJECTED') {
                    this.pendingOrders.delete(data.orderId);
                }
            }
            
            this.emit('orderStatus', data);
            
        } catch (error) {
            this.log(`❌ Order status handling error: ${error.message}`);
            this.emit('orderStatusError', { data, error: error.message });
        }
    }
    
    /**
     * Handle market data from Connection Manager
     */
    handleMarketData(data) {
        try {
            // Update market data cache
            if (data.instrument) {
                const existing = this.marketData.get(data.instrument) || {};
                this.marketData.set(data.instrument, {
                    ...existing,
                    ...data,
                    lastUpdate: new Date()
                });
                
                // Update position P&L if we have positions for this instrument
                this.updatePositionPnL(data.instrument, data.last || data.price);
            }
            
            this.emit('marketData', data);
            
        } catch (error) {
            this.log(`❌ Market data handling error: ${error.message}`);
            this.emit('marketDataError', { data, error: error.message });
        }
    }
    
    /**
     * Handle position update from Connection Manager
     */
    handlePositionUpdate(data) {
        try {
            this.log(`📊 Position update: ${data.instrument} ${data.side} ${data.quantity}`);
            
            const positionKey = `${data.account}_${data.instrument}_${data.side}`;
            
            if (data.quantity === 0) {
                // Position closed
                this.activePositions.delete(positionKey);
            } else {
                // Position updated
                const existing = this.activePositions.get(positionKey) || {};
                this.activePositions.set(positionKey, {
                    ...existing,
                    ...data,
                    timestamp: new Date()
                });
            }
            
            this.emit('positionUpdate', data);
            
        } catch (error) {
            this.log(`❌ Position update handling error: ${error.message}`);
            this.emit('positionUpdateError', { data, error: error.message });
        }
    }
    
    /**
     * Update position P&L based on current market price
     */
    updatePositionPnL(instrument, currentPrice) {
        try {
            this.activePositions.forEach((position, key) => {
                if (position.instrument === instrument && currentPrice) {
                    const priceDiff = currentPrice - position.averagePrice;
                    const multiplier = this.getInstrumentMultiplier(instrument);
                    
                    let unrealizedPnL;
                    if (position.side === 'LONG' || position.side === 'BUY') {
                        unrealizedPnL = (priceDiff * position.quantity * multiplier) - 1.24; // Include $1.24 round-trip commission
                    } else {
                        unrealizedPnL = (-priceDiff * position.quantity * multiplier) - 1.24; // Include $1.24 round-trip commission
                    }
                    
                    position.unrealizedPnL = unrealizedPnL;
                    position.currentPrice = currentPrice;
                    position.lastPnLUpdate = new Date();
                }
            });
        } catch (error) {
            this.log(`❌ P&L update error: ${error.message}`);
        }
    }
    
    /**
     * Get instrument multiplier for P&L calculation
     */
    getInstrumentMultiplier(instrument) {
        const multipliers = {
            'MES': 5,     // Micro E-mini S&P 500
            'MNQ': 2,     // Micro E-mini NASDAQ-100
            'MGC': 10,    // Micro Gold
            'MCL': 100,   // Micro Crude Oil
            'M2K': 5,     // Micro Russell 2000
            'MYM': 0.5,   // Micro Dow
            'ES': 50,     // E-mini S&P 500
            'NQ': 20,     // E-mini NASDAQ-100
            'GC': 100,    // Gold
            'CL': 1000,   // Crude Oil
            'RTY': 50,    // Russell 2000
            'YM': 5       // Dow
        };
        
        // Extract base symbol from contract ID
        const baseSymbol = instrument.includes('.') ? 
            instrument.split('.').pop().split('.')[0] : 
            instrument;
            
        return multipliers[baseSymbol] || 1;
    }
    
    /**
     * Start heartbeat to Connection Manager
     */
    startHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }
        
        this.heartbeatTimer = setInterval(async () => {
            if (this.state.connected) {
                try {
                    const response = await this.httpClient.get('/health');
                    if (response.status !== 200 && response.status !== 206) {
                        throw new Error(`Health check failed: ${response.status}`);
                    }
                } catch (error) {
                    this.log(`💔 Heartbeat failed: ${error.message}`);
                    this.emit('heartbeatFailed', { error: error.message });
                    this.scheduleReconnect();
                }
            }
        }, 30000); // 30 second heartbeat
    }
    
    /**
     * Logging utility
     */
    log(message) {
        if (this.config.enableDebugLogging) {
            console.log(`[ConnectionManagerAdapter] ${message}`);
        }
    }
    
    /**
     * Simulate order sending in shadow mode
     */
    async simulateOrderSend(order) {
        // Simulate network delay
        await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 100));
        
        // Simulate order acceptance
        setTimeout(() => {
            this.handleMessage({
                type: 'ORDER_STATUS',
                data: {
                    orderId: order.id,
                    status: 'ACCEPTED',
                    timestamp: new Date()
                }
            });
        }, 100);
        
        // Simulate fill after a delay
        setTimeout(() => {
            const fillPrice = order.price || this.simulatePrice(order.instrument);
            
            this.handleMessage({
                type: 'FILL',
                data: {
                    orderId: order.id,
                    instrument: order.instrument,
                    fillPrice,
                    quantity: order.quantity,
                    side: order.action,
                    fillTime: new Date()
                }
            });
        }, 500 + Math.random() * 1000);
    }
    
    /**
     * Simulate order modification
     */
    async simulateOrderModify(modification) {
        await new Promise(resolve => setTimeout(resolve, 50));
        
        setTimeout(() => {
            this.handleMessage({
                type: 'ORDER_STATUS',
                data: {
                    orderId: modification.orderId,
                    status: 'MODIFIED',
                    modification,
                    timestamp: new Date()
                }
            });
        }, 100);
    }
    
    /**
     * Simulate order cancellation
     */
    async simulateOrderCancel(cancellation) {
        await new Promise(resolve => setTimeout(resolve, 50));
        
        setTimeout(() => {
            this.handleMessage({
                type: 'ORDER_STATUS',
                data: {
                    orderId: cancellation.orderId,
                    status: 'CANCELLED',
                    timestamp: new Date()
                }
            });
        }, 100);
    }
    
    /**
     * Start simulated market data
     */
    startSimulatedMarketData(instruments) {
        // Send market data updates every second
        this.marketDataInterval = setInterval(() => {
            instruments.forEach(instrument => {
                const price = this.simulatePrice(instrument);
                
                this.handleMessage({
                    type: 'MARKET_DATA',
                    data: {
                        instrument,
                        bid: price - 0.25,
                        ask: price + 0.25,
                        last: price,
                        volume: Math.floor(Math.random() * 1000),
                        timestamp: new Date()
                    }
                });
            });
        }, 1000);
    }
    
    /**
     * Simulate price for instrument
     */
    simulatePrice(instrument) {
        const basePrices = {
            MES: 4500,
            MNQ: 15000,
            MGC: 1800,
            MCL: 75,
            M2K: 2000,
            MYM: 35000
        };
        
        const base = basePrices[instrument] || 100;
        const variation = (Math.random() - 0.5) * 0.005;
        
        return base * (1 + variation);
    }
    
    /**
     * Process queued messages
     */
    processMessageQueue() {
        while (this.state.messageQueue.length > 0) {
            const message = this.state.messageQueue.shift();
            
            switch (message.type) {
                case 'ORDER':
                    this.sendOrder(message.data);
                    break;
                case 'MODIFY':
                    this.modifyOrder(message.data);
                    break;
                case 'CANCEL':
                    this.cancelOrder(message.data);
                    break;
            }
        }
    }
    
    /**
     * Disconnect from Connection Manager
     */
    async disconnect() {
        this.log('🔌 Disconnecting from Connection Manager...');
        
        this.state.connected = false;
        this.state.wsConnected = false;
        
        // Clear timers
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        
        // Close WebSocket
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.close();
            this.ws = null;
        }
        
        // Close Redis connection
        if (this.redisClient) {
            await this.redisClient.quit();
            this.redisClient = null;
        }
        
        this.emit('disconnected');
        this.log('✅ Disconnected from Connection Manager');
    }
    
    /**
     * Get connection status
     */
    get isConnected() {
        return this.state.connected;
    }
    
    /**
     * Schedule reconnection attempt
     */
    scheduleReconnect() {
        if (this.state.reconnecting || this.state.retryCount >= this.config.maxRetries) {
            if (this.state.retryCount >= this.config.maxRetries) {
                this.log(`❌ Max reconnection attempts reached (${this.config.maxRetries})`);
                this.emit('maxRetriesReached');
            }
            return;
        }
        
        this.state.reconnecting = true;
        this.state.retryCount++;
        
        const delay = this.config.reconnectInterval * Math.pow(2, this.state.retryCount - 1); // Exponential backoff
        this.log(`🔄 Scheduling reconnect attempt ${this.state.retryCount}/${this.config.maxRetries} in ${delay}ms`);
        
        this.reconnectTimer = setTimeout(async () => {
            this.state.reconnecting = false;
            await this.connect();
        }, delay);
    }
    
    /**
     * Disconnect from Connection Manager
     */
    async disconnect() {
        this.log('🔌 Disconnecting from Connection Manager...');
        
        this.state.connected = false;
        this.state.wsConnected = false;
        
        // Close WebSocket connection
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        
        // Clear timers
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        
        if (this.marketDataInterval) {
            clearInterval(this.marketDataInterval);
            this.marketDataInterval = null;
        }
        
        // Clear HTTP client
        this.httpClient = null;
        
        this.emit('disconnected');
        this.log('✅ Disconnected from Connection Manager');
    }
    
    /**
     * Get adapter status
     */
    getStatus() {
        return {
            connected: this.state.connected,
            wsConnected: this.state.wsConnected,
            reconnecting: this.state.reconnecting,
            retryCount: this.state.retryCount,
            queuedMessages: this.state.messageQueue.length,
            pendingOrders: this.pendingOrders.size,
            activePositions: this.activePositions.size,
            subscribedInstruments: this.marketData.size,
            lastConnectAttempt: this.state.lastConnectAttempt,
            config: {
                url: this.config.connectionManagerUrl,
                webSocketUrl: this.config.webSocketUrl,
                shadowMode: this.config.shadowMode,
                enableWebSocket: this.config.enableWebSocket
            }
        };
    }
    
    /**
     * Get current market data
     */
    getMarketData(instrument = null) {
        if (instrument) {
            return this.marketData.get(instrument) || null;
        }
        return Object.fromEntries(this.marketData);
    }
    
    /**
     * Get pending orders
     */
    getPendingOrders() {
        return Array.from(this.pendingOrders.values());
    }
    
    /**
     * Get active positions
     */
    getActivePositions() {
        return Array.from(this.activePositions.values());
    }
    
    /**
     * Force reconnection
     */
    async forceReconnect() {
        this.log('🔄 Force reconnect requested');
        this.state.retryCount = 0; // Reset retry count
        await this.disconnect();
        await this.connect();
    }
}

module.exports = ConnectionManagerAdapter;