// connection-manager/services/MarketDataService.js
// Manages market data connections and distribution
// Extracted and refactored from the original marketData.js module

const EventEmitter = require('events');
const { HubConnectionBuilder, HttpTransportType } = require('@microsoft/signalr');
const HeartbeatLogger = require('./HeartbeatLogger');

class MarketDataService extends EventEmitter {
    constructor(authModule, eventBroadcaster, config = {}) {
        super();
        
        this.authModule = authModule;
        this.eventBroadcaster = eventBroadcaster;
        
        this.config = {
            marketHubUrl: config.marketHubUrl || 'https://rtc.topstepx.com/hubs/market',
            userHubUrl: config.userHubUrl || 'https://rtc.topstepx.com/hubs/user',
            reconnectDelayMs: config.reconnectDelayMs || 5000,
            connectionTimeoutMs: config.connectionTimeoutMs || 10000,
            maxRetries: config.maxRetries || 3,
            heartbeatInterval: config.heartbeatInterval || 30000,
            ...config
        };
        
        // Connections
        this.marketConnection = null;
        this.userConnection = null;
        
        // State
        this.isConnected = false;
        this.isUserConnected = false;
        this.subscribedInstruments = new Set();
        this.activeAccounts = new Set();
        
        // Cache for last sent values to detect changes
        this.lastSentData = new Map(); // instrument -> { quotes: {}, trades: {}, depth: {} }
        
        // Metrics
        this.metrics = {
            quotesReceived: 0,
            tradesReceived: 0,
            depthUpdates: 0,
            connectionAttempts: 0,
            reconnections: 0,
            errors: 0,
            lastDataTime: null,
            dataDistributed: 0,
            // Change detection metrics
            quotesFiltered: 0,
            tradesFiltered: 0,
            depthFiltered: 0,
            totalFiltered: 0
        };
        
        // Initialize heartbeat logger
        this.heartbeat = new HeartbeatLogger('MarketDataService', 30000);
        this.heartbeat.start();
        
        console.log('📊 Market Data Service initialized');
        
        // Status check interval
        this.statusInterval = null;
        this.lastStatusTime = Date.now();
    }
    
    async initialize() {
        try {
            console.log('📊 Initializing Market Data Service...');
            
            // Ensure authentication
            const authResult = await this.authModule.ensureValidToken();
            if (!authResult.success) {
                throw new Error('Authentication required for market data connection');
            }
            
            // Connect to market data hub
            await this.connectToMarketHub();
            
            // Connect to user hub for order updates
            await this.connectToUserHub();
            
            console.log('✅ Market Data Service initialized');
            return true;
            
        } catch (error) {
            console.error('❌ Failed to initialize Market Data Service:', error);
            throw error;
        }
    }
    
    async connectToMarketHub() {
        try {
            console.log('📡 Connecting to market data hub...');
            
            const marketHubUrl = `${this.config.marketHubUrl}?access_token=${this.authModule.getToken()}`;
            
            this.marketConnection = new HubConnectionBuilder()
                .withUrl(marketHubUrl, {
                    skipNegotiation: true,
                    transport: HttpTransportType.WebSockets,
                    timeout: this.config.connectionTimeoutMs,
                })
                .withAutomaticReconnect([0, 2000, 10000, 30000])
                .build();
            
            // Only log the main events we care about
            console.log('📊 Setting up market hub event handlers...');
            
            this.setupMarketEventHandlers();
            
            await this.marketConnection.start();
            
            this.isConnected = true;
            this.metrics.connectionAttempts++;
            
            // Update heartbeat system health
            this.heartbeat.updateSystemHealth({ connected: true });
            
            console.log('✅ Connected to market data hub');
            
            // Start a simple heartbeat to show we're waiting for data
            setInterval(() => {
                const now = Date.now();
                const timeSinceLastData = this.metrics.lastDataTime ? now - this.metrics.lastDataTime : 'Never';
                const quotes = this.metrics.quotesReceived;
                const trades = this.metrics.tradesReceived;
                if (quotes === 0 && trades === 0) {
                    console.log(`⏳ Waiting for market data... (${this.subscribedInstruments.size} instruments subscribed, last data: ${timeSinceLastData})`);
                }
            }, 30000); // Every 30 seconds
            
            // Resubscribe to any previously subscribed instruments
            if (this.subscribedInstruments.size > 0) {
                for (const instrument of this.subscribedInstruments) {
                    await this.subscribeToInstrument(instrument);
                }
            }
            
            return true;
            
        } catch (error) {
            console.error('❌ Failed to connect to market hub:', error);
            this.metrics.errors++;
            throw error;
        }
    }
    
    async connectToUserHub() {
        try {
            console.log('📡 Connecting to user hub for order updates...');
            console.log('🔍 User hub configuration:', {
                url: this.config.userHubUrl,
                hasToken: !!this.authModule.getToken(),
                tokenLength: this.authModule.getToken()?.length
            });
            
            const userHubUrl = `${this.config.userHubUrl}?access_token=${this.authModule.getToken()}`;
            
            this.userConnection = new HubConnectionBuilder()
                .withUrl(userHubUrl, {
                    skipNegotiation: true,
                    transport: HttpTransportType.WebSockets,
                    timeout: this.config.connectionTimeoutMs,
                })
                .withAutomaticReconnect([0, 2000, 10000, 30000])
                .build();
            
            // Add logging to track connection state changes
            this.userConnection.onclose((error) => {
                console.log('📡 [USER HUB] Connection closed:', {
                    error,
                    timestamp: new Date().toISOString()
                });
            });
            
            // Setup event handlers before starting connection
            this.setupUserEventHandlers();
            
            console.log('🔄 Starting user hub connection...');
            await this.userConnection.start();
            
            // Wait for connection to be fully established
            let retries = 0;
            while (this.userConnection.state !== 'Connected' && retries < 10) {
                console.log(`⏳ Waiting for user hub connection to be ready... (state: ${this.userConnection.state}, retry: ${retries + 1}/10)`);
                await new Promise(resolve => setTimeout(resolve, 500));
                retries++;
            }
            
            if (this.userConnection.state === 'Connected') {
                this.isUserConnected = true;
                
                console.log('✅ Connected to user hub successfully:', {
                    state: this.userConnection.state,
                    connectionId: this.userConnection.connectionId,
                    timestamp: new Date().toISOString()
                });
                
                // Small delay to ensure connection is fully ready
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Subscribe to order updates for active accounts
                if (this.activeAccounts.size > 0) {
                    console.log(`📊 Subscribing to ${this.activeAccounts.size} active accounts...`);
                    for (const accountId of this.activeAccounts) {
                        await this.subscribeToAccountEvents(accountId);
                    }
                } else {
                    console.log('ℹ️  No active accounts to subscribe to yet');
                }
            } else {
                throw new Error(`User hub connection failed - state: ${this.userConnection.state}`);
            }
            
            return true;
            
        } catch (error) {
            console.error('❌ Failed to connect to user hub:', {
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            // Don't throw - user hub connection is not critical for market data
            return false;
        }
    }
    
    setupUserEventHandlers() {
        // Connection lifecycle events
        this.userConnection.onclose(() => {
            console.log('📡 User connection closed');
            this.isUserConnected = false;
        });
        
        this.userConnection.onreconnecting(() => {
            console.log('🔄 Reconnecting to user hub...');
        });
        
        this.userConnection.onreconnected(() => {
            console.log('✅ Reconnected to user hub');
            this.isUserConnected = true;
            console.log('📊 User hub connection state:', {
                state: this.userConnection.state,
                connectionId: this.userConnection.connectionId
            });
        });
        
        // COMPREHENSIVE EVENT LOGGING - Log ALL events from user hub
        console.log('🔍 Setting up comprehensive event logging for user hub...');
        
        // Add a generic event handler to catch ANY event
        // This is a debugging approach to discover what events TopStep sends
        const eventNames = [
            // Common SignalR event patterns
            'message', 'Message',
            'data', 'Data',
            'event', 'Event',
            'notification', 'Notification',
            'update', 'Update',
            // Order-specific patterns
            'order', 'Order',
            'orders', 'Orders',
            'orderFilled', 'OrderFilled',
            'orderExecuted', 'OrderExecuted',
            'fill', 'Fill',
            'filled', 'Filled',
            'execution', 'Execution',
            'trade', 'Trade',
            'trades', 'Trades',
            // Account patterns
            'account', 'Account',
            'accounts', 'Accounts',
            'position', 'Position',
            'positions', 'Positions',
            // Status patterns
            'status', 'Status',
            'state', 'State',
            'change', 'Change',
            // TopStep specific patterns
            'topstep', 'TopStep',
            'gateway', 'Gateway',
            'user', 'User'
        ];
        
        // Register handlers for all possible event names
        eventNames.forEach(eventName => {
            this.userConnection.on(eventName, (...args) => {
                console.log(`🎯 [USER HUB] Event '${eventName}' received:`, {
                    args: JSON.stringify(args, null, 2),
                    timestamp: new Date().toISOString()
                });
            });
        });
        
        // Known order/position events
        this.userConnection.on('OrderUpdate', (accountId, data) => {
            console.log(`📋 [USER HUB] OrderUpdate event received:`, {
                accountId,
                data: JSON.stringify(data, null, 2),
                timestamp: new Date().toISOString()
            });
            this.handleOrderUpdate(accountId, data);
        });
        
        this.userConnection.on('PositionUpdate', (accountId, data) => {
            console.log(`📊 [USER HUB] PositionUpdate event received:`, {
                accountId,
                data: JSON.stringify(data, null, 2),
                timestamp: new Date().toISOString()
            });
            this.handlePositionUpdate(accountId, data);
        });
        
        // Potential fill/execution events with different names
        this.userConnection.on('Fill', (...args) => {
            console.log(`💰 [USER HUB] Fill event received:`, {
                args: JSON.stringify(args, null, 2),
                timestamp: new Date().toISOString()
            });
        });
        
        this.userConnection.on('OrderFill', (...args) => {
            console.log(`💰 [USER HUB] OrderFill event received:`, {
                args: JSON.stringify(args, null, 2),
                timestamp: new Date().toISOString()
            });
        });
        
        this.userConnection.on('Execution', (...args) => {
            console.log(`⚡ [USER HUB] Execution event received:`, {
                args: JSON.stringify(args, null, 2),
                timestamp: new Date().toISOString()
            });
        });
        
        this.userConnection.on('OrderExecution', (...args) => {
            console.log(`⚡ [USER HUB] OrderExecution event received:`, {
                args: JSON.stringify(args, null, 2),
                timestamp: new Date().toISOString()
            });
        });
        
        this.userConnection.on('TradeExecution', (...args) => {
            console.log(`📈 [USER HUB] TradeExecution event received:`, {
                args: JSON.stringify(args, null, 2),
                timestamp: new Date().toISOString()
            });
        });
        
        // Account-related events
        this.userConnection.on('AccountUpdate', (...args) => {
            console.log(`💼 [USER HUB] AccountUpdate event received:`, {
                args: JSON.stringify(args, null, 2),
                timestamp: new Date().toISOString()
            });
        });
        
        this.userConnection.on('BalanceUpdate', (...args) => {
            console.log(`💵 [USER HUB] BalanceUpdate event received:`, {
                args: JSON.stringify(args, null, 2),
                timestamp: new Date().toISOString()
            });
        });
        
        // TopStep Gateway Events (as documented in API reference)
        this.userConnection.on('GatewayUserAccount', (data) => {
            console.log(`💼 [USER HUB] GatewayUserAccount event received:`, {
                data: JSON.stringify(data, null, 2),
                timestamp: new Date().toISOString()
            });
            // Handle account updates
            if (data && data.id) {
                this.eventBroadcaster.publish('ACCOUNT_UPDATE', {
                    accountId: data.id,
                    balance: data.balance,
                    canTrade: data.canTrade,
                    name: data.name,
                    timestamp: new Date().toISOString()
                });
            }
        });
        
        this.userConnection.on('GatewayUserPosition', (data) => {
            console.log(`📊 [USER HUB] GatewayUserPosition event received:`, {
                data: JSON.stringify(data, null, 2),
                timestamp: new Date().toISOString()
            });
            // Handle position updates
            if (data && data.accountId) {
                this.handlePositionUpdate(data.accountId, data);
                this.eventBroadcaster.publish('POSITION_UPDATE', {
                    accountId: data.accountId,
                    positionId: data.id,
                    contractId: data.contractId,
                    type: data.type === 1 ? 'LONG' : 'SHORT',
                    size: data.size,
                    averagePrice: data.averagePrice,
                    timestamp: new Date().toISOString()
                });
            }
        });
        
        this.userConnection.on('GatewayUserOrder', (data) => {
            console.log(`📋 [USER HUB] GatewayUserOrder event received:`, {
                data: JSON.stringify(data, null, 2),
                timestamp: new Date().toISOString()
            });
            // Handle order updates
            if (data && data.accountId) {
                this.handleOrderUpdate(data.accountId, data);
                
                // Check if order is filled
                if (data.status === 2) { // OrderStatus.Filled = 2
                    this.eventBroadcaster.publish('ORDER_FILLED', {
                        accountId: data.accountId,
                        orderId: data.id,
                        contractId: data.contractId,
                        side: data.side === 0 ? 'BUY' : 'SELL',
                        fillVolume: data.fillVolume,
                        filledPrice: data.filledPrice,
                        timestamp: new Date().toISOString()
                    });
                }
            }
        });
        
        this.userConnection.on('GatewayUserTrade', (data) => {
            console.log(`📈 [USER HUB] GatewayUserTrade event received:`, {
                data: JSON.stringify(data, null, 2),
                timestamp: new Date().toISOString()
            });
            // Handle trade execution events
            if (data && data.accountId) {
                this.eventBroadcaster.publish('TRADE_EXECUTED', {
                    accountId: data.accountId,
                    tradeId: data.id,
                    orderId: data.orderId,
                    contractId: data.contractId,
                    side: data.side === 0 ? 'BUY' : 'SELL',
                    size: data.size,
                    price: data.price,
                    profitAndLoss: data.profitAndLoss,
                    fees: data.fees,
                    timestamp: new Date().toISOString()
                });
            }
        });
        
        // Status events
        this.userConnection.on('OrderStatusUpdate', (...args) => {
            console.log(`📝 [USER HUB] OrderStatusUpdate event received:`, {
                args: JSON.stringify(args, null, 2),
                timestamp: new Date().toISOString()
            });
        });
        
        this.userConnection.on('OrderStatus', (...args) => {
            console.log(`📝 [USER HUB] OrderStatus event received:`, {
                args: JSON.stringify(args, null, 2),
                timestamp: new Date().toISOString()
            });
        });
        
        // Generic event names that might be used
        this.userConnection.on('Update', (...args) => {
            console.log(`🔄 [USER HUB] Update event received:`, {
                args: JSON.stringify(args, null, 2),
                timestamp: new Date().toISOString()
            });
        });
        
        this.userConnection.on('Message', (...args) => {
            console.log(`💬 [USER HUB] Message event received:`, {
                args: JSON.stringify(args, null, 2),
                timestamp: new Date().toISOString()
            });
        });
        
        this.userConnection.on('Notification', (...args) => {
            console.log(`🔔 [USER HUB] Notification event received:`, {
                args: JSON.stringify(args, null, 2),
                timestamp: new Date().toISOString()
            });
        });
        
        // Error handling
        this.userConnection.on('Error', (error) => {
            console.error('❌ [USER HUB] Error event:', {
                error,
                timestamp: new Date().toISOString()
            });
        });
        
        // Connection state logging
        console.log('📊 User hub event handlers configured. Connection state:', {
            state: this.userConnection.state,
            connectionId: this.userConnection.connectionId,
            registeredHandlers: Object.keys(this.userConnection._callbacks || {})
        });
        
        // Set up a periodic check to see if we're receiving any data
        let lastEventTime = Date.now();
        setInterval(() => {
            if (this.isUserConnected) {
                const timeSinceLastEvent = Date.now() - lastEventTime;
                console.log('🔍 [USER HUB] Connection health check:', {
                    connected: this.isUserConnected,
                    state: this.userConnection.state,
                    connectionId: this.userConnection.connectionId,
                    activeAccounts: Array.from(this.activeAccounts),
                    timeSinceLastEvent: `${Math.floor(timeSinceLastEvent / 1000)}s`,
                    timestamp: new Date().toISOString()
                });
                
                // If no events for 5 minutes, try to re-subscribe
                if (timeSinceLastEvent > 300000 && this.activeAccounts.size > 0) {
                    console.log('⚠️  No events received for 5 minutes, attempting to re-subscribe...');
                    for (const accountId of this.activeAccounts) {
                        this.subscribeToAccountEvents(accountId).catch(err => {
                            console.error('❌ Re-subscription failed:', err);
                        });
                    }
                    lastEventTime = Date.now(); // Reset to prevent continuous re-subscription
                }
            }
        }, 30000); // Every 30 seconds
        
        // Update lastEventTime when any event is received
        const originalEmit = this.eventBroadcaster.publish.bind(this.eventBroadcaster);
        this.eventBroadcaster.publish = function(eventType, data) {
            if (eventType === 'ORDER_FILLED' || eventType === 'POSITION_UPDATE') {
                lastEventTime = Date.now();
            }
            return originalEmit(eventType, data);
        };
    }
    
    async subscribeToAccountEvents(accountId) {
        try {
            // Check both the flag and the actual connection state
            const isConnected = this.isUserConnected && this.userConnection && this.userConnection.state === 'Connected';
            
            if (!isConnected) {
                console.log(`⚠️  Cannot subscribe to account ${accountId} - user hub not connected`, {
                    isUserConnected: this.isUserConnected,
                    connectionState: this.userConnection ? this.userConnection.state : 'No connection object',
                    connectionId: this.userConnection ? this.userConnection.connectionId : null
                });
                
                // Try to connect if not connected
                if (this.userConnection && this.userConnection.state === 'Disconnected') {
                    console.log('🔄 Attempting to reconnect user hub...');
                    await this.connectToUserHub();
                }
                
                return false;
            }
            
            console.log(`📊 Subscribing to order events for account ${accountId}...`);
            console.log('🔍 Subscription details:', {
                accountId,
                connectionState: this.userConnection.state,
                connectionId: this.userConnection.connectionId,
                timestamp: new Date().toISOString()
            });
            
            // TopStep requires subscribing to multiple specific channels for account data
            // Based on working implementation in trading-bot-core/modules/marketData.js
            console.log(`📊 Subscribing to TopStep account channels...`);
            
            // Subscribe to general account updates (no parameters)
            await this.userConnection.invoke('SubscribeAccounts');
            console.log(`✅ Subscribed to SubscribeAccounts`);
            
            // Subscribe to order updates for specific account
            await this.userConnection.invoke('SubscribeOrders', accountId);
            console.log(`✅ Subscribed to SubscribeOrders for account ${accountId}`);
            
            // Subscribe to position updates for specific account
            await this.userConnection.invoke('SubscribePositions', accountId);
            console.log(`✅ Subscribed to SubscribePositions for account ${accountId}`);
            
            // Subscribe to trade updates for specific account
            await this.userConnection.invoke('SubscribeTrades', accountId);
            console.log(`✅ Subscribed to SubscribeTrades for account ${accountId}`);
            
            // Try invoking a start method if it exists
            try {
                await this.userConnection.invoke('StartAccountDataStream', accountId);
                console.log(`✅ Started account data stream for ${accountId}`);
            } catch (startError) {
                console.log(`ℹ️  No StartAccountDataStream method available (this is normal):`, startError.message);
            }
            
            // Try invoking a generic start method
            try {
                await this.userConnection.invoke('Start');
                console.log(`✅ Invoked Start method`);
            } catch (startError) {
                console.log(`ℹ️  No Start method available (this is normal):`, startError.message);
            }
            
            // Try to request current orders
            try {
                await this.userConnection.invoke('RequestOrders', accountId);
                console.log(`✅ Requested current orders for ${accountId}`);
            } catch (requestError) {
                console.log(`ℹ️  No RequestOrders method available (this is normal):`, requestError.message);
            }
            
            this.activeAccounts.add(accountId);
            
            console.log(`✅ Successfully subscribed to account ${accountId} events`);
            console.log('📊 Active accounts:', Array.from(this.activeAccounts));
            
            // Log available methods on the connection
            console.log('🔍 Available SignalR methods:', {
                connectionId: this.userConnection.connectionId,
                state: this.userConnection.state,
                // SignalR doesn't expose available methods, but we can log what we know
                knownMethods: [
                    'SubscribeAccounts',
                    'SubscribeOrders',
                    'SubscribePositions',
                    'SubscribeTrades',
                    'UnsubscribeAccounts',
                    'UnsubscribeOrders',
                    'UnsubscribePositions',
                    'UnsubscribeTrades'
                ]
            });
            
            return true;
            
        } catch (error) {
            console.error(`❌ Failed to subscribe to account ${accountId}:`, {
                error: error.message,
                stack: error.stack,
                accountId,
                connectionState: this.userConnection?.state,
                timestamp: new Date().toISOString()
            });
            return false;
        }
    }
    
    async handleOrderUpdate(accountId, orderData) {
        try {
            console.log(`📋 [ORDER UPDATE] Received for account ${accountId}:`, {
                timestamp: new Date().toISOString(),
                accountId,
                orderData: JSON.stringify(orderData, null, 2),
                dataType: typeof orderData,
                hasStatus: 'status' in orderData,
                statusValue: orderData?.status,
                statusType: typeof orderData?.status
            });
            
            // Log all fields in the order data for debugging
            if (orderData && typeof orderData === 'object') {
                console.log('📋 Order fields:', Object.keys(orderData));
                // Log specific field values for debugging
                console.log('📋 Order field values:', {
                    id: orderData.id,
                    orderId: orderData.orderId,
                    orderID: orderData.orderID,
                    status: orderData.status,
                    orderStatus: orderData.orderStatus,
                    state: orderData.state,
                    orderState: orderData.orderState,
                    filledQuantity: orderData.filledQuantity,
                    filledQty: orderData.filledQty,
                    filled: orderData.filled,
                    executedQuantity: orderData.executedQuantity,
                    executedQty: orderData.executedQty
                });
            }
            
            // Check various status formats that might indicate a fill
            // TopStep might use numeric status codes:
            // 0 = Pending, 1 = Working, 2 = Filled, 3 = Cancelled, 4 = Rejected
            const isFilled = orderData.status === 'Filled' || 
                           orderData.status === 2 || 
                           orderData.status === 'FILLED' ||
                           orderData.status === 'Complete' ||
                           orderData.orderStatus === 'Filled' ||
                           orderData.orderStatus === 2 ||
                           orderData.state === 'Filled' ||
                           orderData.state === 2 ||
                           orderData.orderState === 'Filled' ||
                           orderData.orderState === 2 ||
                           // Check if we have filled quantity > 0
                           (orderData.filledQuantity && orderData.filledQuantity > 0) ||
                           (orderData.filledQty && orderData.filledQty > 0) ||
                           (orderData.filled && orderData.filled > 0) ||
                           (orderData.executedQuantity && orderData.executedQuantity > 0) ||
                           (orderData.executedQty && orderData.executedQty > 0);
            
            console.log('📋 Fill check:', {
                isFilled,
                status: orderData.status,
                orderStatus: orderData.orderStatus,
                state: orderData.state,
                hasFilledQuantity: 'filledQuantity' in orderData,
                filledQuantity: orderData.filledQuantity
            });
            
            if (isFilled) {
                console.log(`✅ Order FILLED: ${orderData.orderId || orderData.id || 'UNKNOWN_ID'}`);
                
                // Extract position ID and other fill details
                const fillEvent = {
                    orderId: orderData.orderId || orderData.id,
                    accountId: accountId,
                    instrument: orderData.contractId || orderData.symbol || orderData.contract,
                    side: orderData.side === 0 ? 'BUY' : orderData.side === 1 ? 'SELL' : orderData.side,
                    filledPrice: orderData.averageFillPrice || orderData.fillPrice || orderData.price || orderData.avgFillPrice,
                    filledQuantity: orderData.filledQuantity || orderData.quantity || orderData.size || orderData.filledQty,
                    positionId: orderData.positionId || orderData.position?.id || orderData.posId,
                    timestamp: orderData.timestamp || orderData.time || Date.now(),
                    rawData: orderData // Include raw data for debugging
                };
                
                // If we don't have a positionId, search for the position
                if (!fillEvent.positionId) {
                    console.log('🔍 No positionId in order data, searching for position...');
                    try {
                        // Search for open positions for this account
                        const positionId = await this.searchForPosition(accountId, fillEvent.instrument, fillEvent.side);
                        if (positionId) {
                            fillEvent.positionId = positionId;
                            console.log(`✅ Found positionId: ${positionId}`);
                        } else {
                            console.log('⚠️  No matching position found');
                        }
                    } catch (error) {
                        console.error('❌ Failed to search for position:', error.message);
                    }
                }
                
                // Log the fill event details
                console.log(`📊 Publishing ORDER_FILLED event:`, JSON.stringify(fillEvent, null, 2));
                
                // Publish ORDER_FILLED event to market:data channel
                this.eventBroadcaster.publish('ORDER_FILLED', fillEvent);
                
                // Also emit locally for ConnectionManager to handle bracket orders
                this.emit('ORDER_FILLED', fillEvent);
            } else {
                console.log('📋 Order update is not a fill, status:', orderData.status || orderData.orderStatus || orderData.state);
            }
            
        } catch (error) {
            console.error('❌ Error handling order update:', {
                error: error.message,
                stack: error.stack,
                accountId,
                orderData,
                timestamp: new Date().toISOString()
            });
        }
    }
    
    handlePositionUpdate(accountId, positionData) {
        try {
            console.log(`📊 [POSITION UPDATE] Received for account ${accountId}:`, {
                timestamp: new Date().toISOString(),
                accountId,
                positionData: JSON.stringify(positionData, null, 2),
                dataType: typeof positionData
            });
            
            // Log all fields in the position data for debugging
            if (positionData && typeof positionData === 'object') {
                console.log('📊 Position fields:', Object.keys(positionData));
            }
            
            // Create position update event with all possible field names
            const positionEvent = {
                accountId: accountId,
                positionId: positionData.id || positionData.positionId || positionData.posId,
                instrument: positionData.contractId || positionData.symbol || positionData.contract,
                quantity: positionData.quantity || positionData.size || positionData.qty || positionData.position,
                side: positionData.side === 0 ? 'BUY' : positionData.side === 1 ? 'SELL' : positionData.side,
                averagePrice: positionData.averagePrice || positionData.avgPrice || positionData.price,
                realizedPnL: positionData.realizedPnL || positionData.realizedPL || positionData.realized,
                unrealizedPnL: positionData.unrealizedPnL || positionData.unrealizedPL || positionData.unrealized,
                timestamp: positionData.timestamp || positionData.time || Date.now(),
                rawData: positionData // Include raw data for debugging
            };
            
            console.log(`📊 Publishing POSITION_UPDATE event:`, JSON.stringify(positionEvent, null, 2));
            
            // Publish position update event
            this.eventBroadcaster.publish('POSITION_UPDATE', positionEvent);
            
        } catch (error) {
            console.error('❌ Error handling position update:', {
                error: error.message,
                stack: error.stack,
                accountId,
                positionData,
                timestamp: new Date().toISOString()
            });
        }
    }
    
    setupMarketEventHandlers() {
        // Connection lifecycle events
        this.marketConnection.onclose(() => {
            console.log('📡 Market connection closed');
            this.isConnected = false;
            this.heartbeat.updateSystemHealth({ connected: false });
            this.emit('connectionLost');
        });
        
        this.marketConnection.onreconnecting(() => {
            console.log('🔄 Reconnecting to market data...');
            this.emit('reconnecting');
        });
        
        this.marketConnection.onreconnected(() => {
            console.log('✅ Reconnected to market data');
            this.isConnected = true;
            this.metrics.reconnections++;
            this.heartbeat.updateSystemHealth({ connected: true });
            // Clear cached data on reconnection to ensure fresh data is sent
            this.clearCachedData();
            this.emit('reconnected');
        });
        
        // Market data events using correct event names
        this.marketConnection.on('GatewayQuote', (id, data) => {
            this.handleQuote(data, id); // Pass the instrument ID as second parameter
        });
        
        this.marketConnection.on('GatewayTrade', (id, data) => {
            this.handleTrade(data, id); // Pass the instrument ID as second parameter
        });
        
        this.marketConnection.on('GatewayDepth', (id, data) => {
            this.handleDepth(data, id); // Pass the instrument ID as second parameter
        });
        
        // Market data events are handled by specific handlers above
        
        // Error handling
        this.marketConnection.on('Error', (error) => {
            console.error('❌ Market hub error:', error);
            this.metrics.errors++;
        });
    }
    
    async subscribeToInstrument(instrument) {
        try {
            if (!this.isConnected) {
                console.log(`⚠️  Cannot subscribe to ${instrument} - not connected`);
                throw new Error('Market data service not connected');
            }
            
            if (this.subscribedInstruments.has(instrument)) {
                console.log(`📊 Already subscribed to ${instrument}`);
                return true;
            }
            
            console.log(`📊 Subscribing to market data for ${instrument}...`);
            
            // Subscribe to different data types using correct method names
            try {
                await this.marketConnection.invoke('SubscribeContractQuotes', instrument);
                console.log(`✅ Subscribed to quotes for ${instrument}`);
            } catch (error) {
                console.error(`❌ Failed to subscribe to quotes for ${instrument}:`, error.message);
                throw error;
            }
            
            try {
                await this.marketConnection.invoke('SubscribeContractTrades', instrument);
                console.log(`✅ Subscribed to trades for ${instrument}`);
            } catch (error) {
                console.error(`❌ Failed to subscribe to trades for ${instrument}:`, error.message);
                throw error;
            }
            
            try {
                await this.marketConnection.invoke('SubscribeContractMarketDepth', instrument);
                console.log(`✅ Subscribed to market depth for ${instrument}`);
            } catch (error) {
                console.error(`❌ Failed to subscribe to market depth for ${instrument}:`, error.message);
                throw error;
            }
            
            this.subscribedInstruments.add(instrument);
            
            console.log(`✅ Subscribed to ${instrument}`);
            return true;
            
        } catch (error) {
            console.error(`❌ Failed to subscribe to ${instrument}:`, error);
            return false;
        }
    }
    
    async unsubscribeFromInstrument(instrument) {
        try {
            if (!this.isConnected) {
                return false;
            }
            
            if (!this.subscribedInstruments.has(instrument)) {
                return true;
            }
            
            console.log(`📊 Unsubscribing from ${instrument}...`);
            
            await this.marketConnection.invoke('UnsubscribeContractQuotes', instrument);
            
            this.subscribedInstruments.delete(instrument);
            
            // Clean up cached data for this instrument
            this.lastSentData.delete(instrument);
            
            console.log(`✅ Unsubscribed from ${instrument}`);
            return true;
            
        } catch (error) {
            console.error(`❌ Failed to unsubscribe from ${instrument}:`, error);
            return false;
        }
    }
    
    /**
     * Check if market data has changed compared to last sent values
     * @param {string} instrument - The instrument symbol
     * @param {string} type - Data type: 'QUOTE', 'TRADE', or 'DEPTH'
     * @param {object} newData - The new data to compare
     * @returns {boolean} - True if data has changed
     */
    hasDataChanged(instrument, type, newData) {
        // Get or create cache entry for this instrument
        if (!this.lastSentData.has(instrument)) {
            this.lastSentData.set(instrument, {
                quotes: {},
                trades: {},
                depth: { bids: [], asks: [] }
            });
            return true; // First data is always considered changed
        }
        
        const lastData = this.lastSentData.get(instrument);
        
        switch (type) {
            case 'QUOTE':
                const lastQuote = lastData.quotes;
                // Check if any quote values have changed
                return (
                    lastQuote.bid !== newData.bid ||
                    lastQuote.ask !== newData.ask ||
                    lastQuote.bidSize !== newData.bidSize ||
                    lastQuote.askSize !== newData.askSize
                );
                
            case 'TRADE':
                const lastTrade = lastData.trades;
                // Always send trades as they represent actual executions
                // But still check for duplicate consecutive trades
                return (
                    lastTrade.price !== newData.price ||
                    lastTrade.size !== newData.size ||
                    lastTrade.side !== newData.side ||
                    lastTrade.timestamp !== newData.timestamp
                );
                
            case 'DEPTH':
                // For depth, do a deep comparison of bid/ask arrays
                const lastDepth = lastData.depth;
                return (
                    JSON.stringify(lastDepth.bids) !== JSON.stringify(newData.bids) ||
                    JSON.stringify(lastDepth.asks) !== JSON.stringify(newData.asks)
                );
                
            default:
                return true; // Unknown type, send it
        }
    }
    
    /**
     * Update the cache with the latest sent data
     * @param {string} instrument - The instrument symbol
     * @param {string} type - Data type: 'QUOTE', 'TRADE', or 'DEPTH'
     * @param {object} data - The data that was sent
     */
    updateLastSentData(instrument, type, data) {
        if (!this.lastSentData.has(instrument)) {
            this.lastSentData.set(instrument, {
                quotes: {},
                trades: {},
                depth: { bids: [], asks: [] }
            });
        }
        
        const cache = this.lastSentData.get(instrument);
        
        switch (type) {
            case 'QUOTE':
                cache.quotes = { ...data };
                break;
            case 'TRADE':
                cache.trades = { ...data };
                break;
            case 'DEPTH':
                cache.depth = {
                    bids: data.bids ? [...data.bids] : [],
                    asks: data.asks ? [...data.asks] : []
                };
                break;
        }
    }
    
    /**
     * Clear all cached market data
     * Called on reconnection to ensure fresh data is sent
     */
    clearCachedData() {
        console.log('🔄 Clearing cached market data for all instruments');
        this.lastSentData.clear();
    }
    
    handleQuote(quote, instrument) {
        try {
            // Debug logging disabled to reduce spam
            // console.log(`🔵 [DEBUG] handleQuote called`);
            // console.log(`🔵 [DEBUG] Instrument: ${instrument}`);
            // console.log(`🔵 [DEBUG] Quote data:`, JSON.stringify(quote, null, 2));
            
            this.metrics.quotesReceived++;
            this.metrics.lastDataTime = Date.now();
            
            // Use the instrument ID provided by SignalR
            // Convert TopStep internal format to our contract format if needed
            const contractId = instrument || quote.contractId || quote.contract;
            
            // Format quote data - handle both bestBid/bestAsk and bid/ask formats
            const quoteData = {
                bid: quote.bestBid || quote.bid,
                ask: quote.bestAsk || quote.ask,
                bidSize: quote.bestBidSize || quote.bidSize,
                askSize: quote.bestAskSize || quote.askSize,
                timestamp: quote.timestamp || quote.lastUpdated || Date.now()
            };
            
            // console.log(`🔵 [DEBUG] Formatted quote data:`, JSON.stringify(quoteData, null, 2));
            
            // Check if the quote has actually changed
            if (!this.hasDataChanged(contractId, 'QUOTE', quoteData)) {
                // Data hasn't changed, skip distribution
                this.metrics.quotesFiltered++;
                this.metrics.totalFiltered++;
                return;
            }
            
            // Log quote event to heartbeat (replaces frequent individual logs)
            this.heartbeat.logEvent('QUOTE', contractId, { bid: quoteData.bid, ask: quoteData.ask });
            
            // Update cache with new values
            this.updateLastSentData(contractId, 'QUOTE', quoteData);
            
            // Format market data for distribution
            const marketData = {
                instrument: contractId,
                type: 'QUOTE',
                data: quoteData
            };
            
            // Emit for local distribution
            this.emit('marketData', marketData);
            
            // Publish to Redis - EventBroadcaster will wrap it
            this.eventBroadcaster.publish('market:data', marketData);
            
            this.metrics.dataDistributed++;
            
        } catch (error) {
            console.error('❌ Error handling quote:', error);
        }
    }
    
    handleTrade(tradeArray, instrument) {
        try {
            // Debug logging disabled to reduce spam
            // console.log(`🟢 [DEBUG] handleTrade called`);
            // console.log(`🟢 [DEBUG] Instrument: ${instrument}`);
            // console.log(`🟢 [DEBUG] Trade data:`, JSON.stringify(tradeArray, null, 2));
            
            this.metrics.tradesReceived++;
            this.metrics.lastDataTime = Date.now();
            
            // DIAGNOSTIC: Only log in debug mode to reduce spam
            // console.log(`🔍 RAW TRADE DATA for debugging:`, JSON.stringify(tradeArray, null, 2));
            
            // CRITICAL FIX: TopStep sends trade data as an ARRAY, not single object
            if (!Array.isArray(tradeArray) || tradeArray.length === 0) {
                console.error(`❌ CRITICAL: Invalid trade array format:`, tradeArray);
                return;
            }
            
            // Process each trade in the array
            tradeArray.forEach((trade, index) => {
                // Use the instrument ID provided by SignalR
                const contractId = instrument || trade.contractId || trade.contract;
                
                // Format trade data - handle TopStep SignalR field variations
                // FIXED: Use actual TopStep field names from individual trade object: price, volume, type, timestamp
                const tradeData = {
                    price: trade.price || trade.lastPrice || trade.last || trade.tradePrice,
                    size: trade.volume || trade.lastSize || trade.size || trade.tradeSize,
                    side: trade.type === 0 ? 'BUY' : trade.type === 1 ? 'SELL' : (trade.side || trade.tradeSide || trade.direction || (trade.aggressor === 'buyer' ? 'BUY' : trade.aggressor === 'seller' ? 'SELL' : 'UNKNOWN')),
                    timestamp: trade.timestamp || trade.lastUpdated || trade.tradeTime || Date.now()
                };

                // CRITICAL VALIDATION: Prevent undefined values from being processed in live trading
                if (!tradeData.price || tradeData.price === undefined || tradeData.price <= 0) {
                    console.error(`❌ CRITICAL: Invalid trade price for ${contractId}: ${tradeData.price}`, { trade, tradeData });
                    return; // Skip this trade
                }
                
                if (!tradeData.size || tradeData.size === undefined || tradeData.size <= 0) {
                    console.error(`❌ CRITICAL: Invalid trade size for ${contractId}: ${tradeData.size}`, { trade, tradeData });
                    return; // Skip this trade
                }
                
                if (!tradeData.side || tradeData.side === undefined || tradeData.side === 'UNKNOWN') {
                    console.warn(`⚠️  WARNING: Unknown trade side for ${contractId}: ${tradeData.side}`, { trade, tradeData });
                    // Still process but with warning - side might be determined from context
                }
                
                // Check if this is a duplicate trade
                if (!this.hasDataChanged(contractId, 'TRADE', tradeData)) {
                    // Duplicate trade, skip distribution
                    this.metrics.tradesFiltered++;
                    this.metrics.totalFiltered++;
                    return;
                }
                
                // Log trade event to heartbeat (replaces frequent individual logs)
                this.heartbeat.logEvent('TRADE', contractId, { price: tradeData.price, size: tradeData.size, side: tradeData.side });
                
                // Update cache with new trade
                this.updateLastSentData(contractId, 'TRADE', tradeData);
                
                // Format market data for distribution
                const marketData = {
                    instrument: contractId,
                    type: 'TRADE',
                    data: tradeData
                };
                
                // Emit for local distribution
                this.emit('marketData', marketData);
                
                // Publish to Redis for trading chart
                // Publish to Redis - EventBroadcaster will wrap it
                this.eventBroadcaster.publish('market:data', marketData);
                
                this.metrics.dataDistributed++;
            }); // End forEach loop
            
        } catch (error) {
            console.error('❌ Error handling trade:', error);
        }
    }
    
    handleDepth(depth, instrument) {
        try {
            this.metrics.depthUpdates++;
            this.metrics.lastDataTime = Date.now();
            
            // Use the instrument ID provided by SignalR
            const contractId = instrument || depth.contractId || depth.contract;
            
            // Format depth data
            const depthData = {
                bids: depth.bids || [],
                asks: depth.asks || [],
                timestamp: depth.timestamp || Date.now()
            };
            
            // Check if depth has actually changed
            if (!this.hasDataChanged(contractId, 'DEPTH', depthData)) {
                // Depth hasn't changed, skip distribution
                this.metrics.depthFiltered++;
                this.metrics.totalFiltered++;
                return;
            }
            
            // Log depth event to heartbeat (replaces frequent individual logs)
            this.heartbeat.logEvent('DEPTH', contractId, { bids: depthData.bids.length, asks: depthData.asks.length });
            
            // Update cache with new depth
            this.updateLastSentData(contractId, 'DEPTH', depthData);
            
            // Format market data for distribution
            const marketData = {
                instrument: contractId,
                type: 'DEPTH',
                data: depthData
            };
            
            // Emit for local distribution
            this.emit('marketData', marketData);
            
            // Publish to Redis for trading chart
            // Publish to Redis - EventBroadcaster will wrap it
            this.eventBroadcaster.publish('market:data', marketData);
            
            this.metrics.dataDistributed++;
            
        } catch (error) {
            console.error('❌ Error handling depth:', error);
        }
    }
    
    async disconnect() {
        try {
            console.log('📊 Disconnecting Market Data Service...');
            
            if (this.marketConnection) {
                await this.marketConnection.stop();
            }
            
            if (this.userConnection) {
                await this.userConnection.stop();
            }
            
            this.isConnected = false;
            this.isUserConnected = false;
            this.subscribedInstruments.clear();
            this.activeAccounts.clear();
            
            // Stop heartbeat logging
            if (this.heartbeat) {
                this.heartbeat.stop();
            }
            
            console.log('✅ Market Data Service disconnected');
            
        } catch (error) {
            console.error('❌ Error disconnecting Market Data Service:', error);
        }
    }
    
    getMetrics() {
        const totalReceived = this.metrics.quotesReceived + this.metrics.tradesReceived + this.metrics.depthUpdates;
        const filterRate = totalReceived > 0 ? (this.metrics.totalFiltered / totalReceived * 100).toFixed(2) : 0;
        
        return {
            ...this.metrics,
            connected: this.isConnected,
            subscribedInstruments: Array.from(this.subscribedInstruments),
            instrumentCount: this.subscribedInstruments.size,
            // Efficiency metrics
            totalReceived,
            filterRate: `${filterRate}%`,
            efficiency: {
                quotesFilterRate: this.metrics.quotesReceived > 0 ? 
                    `${(this.metrics.quotesFiltered / this.metrics.quotesReceived * 100).toFixed(2)}%` : '0%',
                tradesFilterRate: this.metrics.tradesReceived > 0 ? 
                    `${(this.metrics.tradesFiltered / this.metrics.tradesReceived * 100).toFixed(2)}%` : '0%',
                depthFilterRate: this.metrics.depthUpdates > 0 ? 
                    `${(this.metrics.depthFiltered / this.metrics.depthUpdates * 100).toFixed(2)}%` : '0%'
            }
        };
    }
    
    isHealthy() {
        const now = Date.now();
        const dataAge = this.metrics.lastDataTime ? now - this.metrics.lastDataTime : Infinity;
        
        return {
            connected: this.isConnected,
            receivingData: dataAge < 30000, // Data within last 30 seconds
            dataAge,
            metrics: this.getMetrics()
        };
    }
    
    startStatusMonitoring() {
        // Clear any existing interval
        if (this.statusInterval) {
            clearInterval(this.statusInterval);
        }
        
        // Check status every 30 seconds
        this.statusInterval = setInterval(() => {
            const quotes = this.metrics.quotesReceived;
            const trades = this.metrics.tradesReceived;
            const subs = this.subscribedInstruments.size;
            
            if (quotes === 0 && trades === 0 && subs > 0) {
                console.log(`⏳ No market data received yet (${subs} instruments subscribed)`);
            } else if (quotes > 0 || trades > 0) {
                console.log(`📊 Market data flowing: ${quotes} quotes, ${trades} trades`);
            }
        }, 30000);
    }
}

module.exports = MarketDataService;