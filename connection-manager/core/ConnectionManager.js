// connection-manager/core/ConnectionManager.js
// Centralized connection management for TopStep API
// Manages authentication, WebSocket connections, and data distribution

const EventEmitter = require('events');
const AuthenticationModule = require('../../shared/modules/auth/authentication');
const MarketDataService = require('../services/MarketDataService');
const FixedBotRegistry = require('../services/FixedBotRegistry');
const HealthMonitor = require('../services/HealthMonitor');
const EventBroadcaster = require('../services/EventBroadcaster');
const PositionReconciliationService = require('../services/PositionReconciliationService');
const ConfigurationService = require('../services/ConfigurationService');
const HistoricalDataService = require('../services/HistoricalDataService');
const OrderMutex = require('../../shared/modules/concurrency/OrderMutex');
const ContractMonths = require('../../shared/modules/contracts/ContractMonths');

class ConnectionManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            apiBaseUrl: config.urls?.api || config.apiBaseUrl || 'https://api.topstepx.com',
            marketHubUrl: config.urls?.marketHub || config.marketHubUrl || 'https://rtc.topstepx.com/hubs/market',
            userHubUrl: config.urls?.userHub || config.userHubUrl || 'https://rtc.topstepx.com/hubs/user',
            redisConfig: config.redisConfig || { host: 'localhost', port: 6379 },
            monitoringPort: config.monitoringPort || config.port || 7500,
            reconnectDelayMs: config.reconnectDelayMs || 5000,
            maxReconnectAttempts: config.maxReconnectAttempts || 5,
            heartbeatInterval: config.heartbeatInterval || 30000,
            ...config
        };
        
        // Logger reference (will be set by parent app)
        this.logger = null;
        
        // Core components
        this.authModule = null;
        this.marketDataService = null;
        this.instanceRegistry = null;
        this.healthMonitor = null;
        this.eventBroadcaster = null;
        this.positionReconciliationService = null;
        this.configurationService = null;
        this.historicalDataService = null;
        this.orderMutex = null;
        
        // Connection state
        this.state = 'INITIALIZING';
        this.isRunning = false;
        this.startTime = null;
        
        // Metrics
        this.metrics = {
            startTime: null,
            uptime: 0,
            totalInstances: 0,
            activeInstances: 0,
            messagesDistributed: 0,
            reconnectionCount: 0,
            lastError: null
        };
        
        // Cached data for validation
        this.cachedAccounts = null;
        this.lastAccountFetch = null;
        // Test instrument will be set dynamically from API contracts
        this.testInstrument = null;
        this.apiValidated = false;
        
        // Contract cache
        this.contractCache = new Map();
        
        console.log('🌐 Connection Manager Initializing...');
        console.log(`   API URL: ${this.config.apiBaseUrl}`);
        console.log(`   Monitoring Port: ${this.config.monitoringPort}`);
    }
    
    async initialize() {
        try {
            console.log('🚀 Starting Connection Manager...');
            
            // Initialize authentication with automatic token refresh
            this.authModule = new AuthenticationModule({
                apiBaseUrl: this.config.apiBaseUrl,
                instanceId: 'CONNECTION_MANAGER',
                autoRefresh: true,                    // Enable automatic token refresh
                refreshBuffer: 5 * 60 * 1000,        // Refresh 5 minutes before expiry
                maxRetryAttempts: 5,                 // More retry attempts for critical service
                retryDelay: 15000                    // 15 second retry delay
            });
            
            // Initialize fixed bot registry for BOT_1 through BOT_6
            this.instanceRegistry = new FixedBotRegistry();
            
            // Initialize event broadcaster
            this.eventBroadcaster = new EventBroadcaster(this.config.redisConfig);
            await this.eventBroadcaster.connect();
            
            // Initialize health monitor
            this.healthMonitor = new HealthMonitor(this);
            
            // Initialize configuration service
            this.configurationService = new ConfigurationService({
                configPath: this.config.configPath || './config',
                enableConfigBroadcast: this.config.enableConfigBroadcast !== false,
                enableInstanceProvisioning: this.config.enableInstanceProvisioning !== false
            });
            await this.configurationService.initialize();
            
            // Initialize position reconciliation service
            this.positionReconciliationService = new PositionReconciliationService({
                reconciliationIntervalMs: this.config.reconciliationIntervalMs || 30000,
                enableAutoCorrection: this.config.enableAutoCorrection !== false,
                logLevel: this.config.logLevel || 'INFO'
            });
            
            // Initialize market data service
            this.marketDataService = new MarketDataService(
                this.authModule,
                this.eventBroadcaster,
                {
                    marketHubUrl: this.config.marketHubUrl,
                    userHubUrl: this.config.userHubUrl
                }
            );
            
            // Initialize historical data service
            this.historicalDataService = new HistoricalDataService(
                this.authModule,
                this.eventBroadcaster,
                {
                    maxRetries: this.config.historicalDataMaxRetries || 3,
                    cacheDuration: this.config.historicalDataCacheDuration || 300000,
                    maxConcurrentRequests: this.config.historicalDataMaxConcurrentRequests || 5
                }
            );
            
            // Initialize order mutex for server-side concurrency control
            this.orderMutex = new OrderMutex({
                lockTimeout: this.config.orderLockTimeout || 30000,
                queueTimeout: this.config.orderQueueTimeout || 60000,
                maxQueueSize: this.config.orderMaxQueueSize || 100,
                logLevel: this.config.logLevel || 'info'
            });
            
            // Setup event handlers
            this.setupEventHandlers();
            
            // Authenticate with TopStep
            const authResult = await this.authModule.authenticate();
            if (!authResult.success) {
                throw new Error(`Authentication failed: ${authResult.error}`);
            }
            
            console.log('✅ Authentication successful');
            
            // Validate API integration with account fetch and market data test
            await this.validateApiIntegration();
            
            // Start services
            // Try to initialize market data service but don't fail if it can't connect
            try {
                await this.marketDataService.initialize();
                console.log('✅ Market Data Service connected');
                
                // ENHANCED FIX: Discover and subscribe to all active contracts
                console.log('📊 Discovering active contracts from open positions...');
                const activeContracts = await this.discoverActiveContracts();
                
                // Track subscribed symbols
                const subscribedSymbols = new Set();
                
                if (activeContracts.length > 0) {
                    console.log(`📊 Found ${activeContracts.length} active contracts: ${activeContracts.join(', ')}`);
                    
                    // Subscribe to all active contracts
                    for (const contract of activeContracts) {
                        try {
                            console.log(`📊 Subscribing to market data for ${contract}...`);
                            await this.marketDataService.subscribeToInstrument(contract);
                            console.log(`✅ Subscribed to market data for ${contract}`);
                            
                            // Extract symbol from contract ID (e.g., CON.F.US.MGC.Z25 -> MGC)
                            const parts = contract.split('.');
                            if (parts.length >= 4) {
                                subscribedSymbols.add(parts[3]);
                            }
                        } catch (subError) {
                            console.error(`❌ Failed to subscribe to ${contract}:`, subError.message);
                        }
                    }
                }
                
                // Log the total subscribed contracts
                if (subscribedSymbols.size > 0) {
                    console.log(`✅ Successfully subscribed to ${subscribedSymbols.size} unique symbols from TopStep API`);
                } else {
                    console.log('⚠️ No contracts subscribed - check TopStep API response');
                }
                
                // VERIFICATION: Wait a moment then check if we're receiving market data for all contracts
                console.log('⏳ Waiting 5 seconds to verify market data flow...');
                await new Promise(resolve => setTimeout(resolve, 5000));
                
                console.log('🔍 Verifying market data reception for all subscribed contracts...');
                const receivedDataContracts = new Set();
                const noDataContracts = [];
                
                // Track which contracts have received data
                const dataCheckHandler = (marketData) => {
                    if (marketData.instrument) {
                        receivedDataContracts.add(marketData.instrument);
                        // Extract symbol for tracking
                        const parts = marketData.instrument.split('.');
                        if (parts.length >= 4) {
                            receivedDataContracts.add(parts[3]); // Add symbol too
                        }
                    }
                };
                
                // Listen for market data briefly
                this.marketDataService.on('marketData', dataCheckHandler);
                
                // Wait 15 seconds to collect data from low-volume contracts
                await new Promise(resolve => setTimeout(resolve, 15000));
                
                // Remove the handler
                this.marketDataService.removeListener('marketData', dataCheckHandler);
                
                // Check which contracts have received data
                console.log('📊 Market Data Verification Results:');
                console.log(`   ✅ Contracts receiving data: ${receivedDataContracts.size}`);
                
                // List all subscribed contracts and their data status
                for (const symbol of subscribedSymbols) {
                    const hasData = receivedDataContracts.has(symbol) || 
                                  Array.from(receivedDataContracts).some(contract => 
                                      contract.includes(`.${symbol}.`));
                    
                    if (hasData) {
                        console.log(`   ✅ ${symbol}: Receiving market data`);
                    } else {
                        console.log(`   ❌ ${symbol}: No market data received`);
                        noDataContracts.push(symbol);
                    }
                }
                
                if (noDataContracts.length > 0) {
                    console.log(`⚠️  WARNING: ${noDataContracts.length} contracts not receiving data: ${noDataContracts.join(', ')}`);
                    console.log('   This may be normal if markets are closed or contracts are inactive.');
                } else {
                    console.log('✅ All subscribed contracts are receiving market data!');
                }
                
            } catch (marketError) {
                console.warn('⚠️  Market Data Service could not connect (this is normal outside market hours)');
                console.warn('   The Connection Manager will continue without live market data');
                console.warn(`   Error: ${marketError.message}`);
                // Don't throw - allow Connection Manager to start without market data
            }
            this.healthMonitor.start();
            this.positionReconciliationService.start();
            
            // Update state
            this.state = 'CONNECTED';
            this.isRunning = true;
            this.startTime = Date.now();
            this.metrics.startTime = this.startTime;
            
            // Broadcast connection status
            await this.broadcastConnectionStatus('CONNECTED');
            
            console.log('✅ Connection Manager started successfully');
            console.log('🤖 Fixed bot connections ready (BOT_1 through BOT_6)');
            
            return true;
            
        } catch (error) {
            console.error('❌ Failed to initialize Connection Manager:', error);
            this.state = 'ERROR';
            this.metrics.lastError = {
                timestamp: Date.now(),
                message: error.message
            };
            throw error;
        }
    }
    
    setupEventHandlers() {
        // Handle instance registration requests
        this.eventBroadcaster.on('REGISTER_INSTANCE', async (data) => {
            await this.handleInstanceRegistration(data);
        });
        
        // Handle instance deregistration
        this.eventBroadcaster.on('DEREGISTER_INSTANCE', async (data) => {
            await this.handleInstanceDeregistration(data);
        });
        
        // Handle market data subscriptions
        this.eventBroadcaster.on('SUBSCRIBE_MARKET_DATA', async (data) => {
            await this.handleMarketDataSubscription(data);
        });
        
        // Handle account fetching requests
        this.eventBroadcaster.on('GET_ACCOUNTS', async (data) => {
            console.log('🔍 Received GET_ACCOUNTS request from:', data.instanceId);
            await this.handleGetAccounts(data);
        });
        
        // Handle account requests from Config Manager via Redis
        this.eventBroadcaster.on('account-request', async (data) => {
            console.log('📦 Received account request from Config Manager:', data);
            await this.handleConfigManagerAccountRequest(data);
        });
        
        // Handle configuration requests
        this.eventBroadcaster.on('REQUEST_CONFIG', async (data) => {
            console.log('🔍 Received REQUEST_CONFIG from:', data.instanceId);
            await this.handleConfigRequest(data);
        });
        
        // Handle order placement requests
        this.eventBroadcaster.on('PLACE_ORDER', async (data) => {
            console.log('🔥 [DEBUG] PLACE_ORDER event received, calling handleOrderRequest...');
            try {
                await this.handleOrderRequest(data);
                console.log('🔥 [DEBUG] handleOrderRequest completed successfully');
            } catch (error) {
                console.error('🔥 [DEBUG] ERROR in PLACE_ORDER event handler:', error);
                console.error('🔥 [DEBUG] ERROR details:', {
                    message: error.message,
                    stack: error.stack
                });
            }
        });
        
        // Handle order management channel (used by Trading Aggregator)
        this.eventBroadcaster.on('order:management', async (data) => {
            console.log('🔥 [DEBUG] order:management event received:', data);
            try {
                if (data.type === 'PLACE_ORDER' && data.payload) {
                    console.log('🔥 [DEBUG] Processing PLACE_ORDER from order:management channel');
                    await this.handleOrderRequest(data.payload);
                    console.log('🔥 [DEBUG] handleOrderRequest completed successfully from order:management');
                } else {
                    console.log('🔥 [DEBUG] Unknown message type in order:management:', data.type);
                }
            } catch (error) {
                console.error('🔥 [DEBUG] ERROR in order:management event handler:', error);
                console.error('🔥 [DEBUG] ERROR details:', {
                    message: error.message,
                    stack: error.stack
                });
            }
        });
        
        // Handle order cancellation requests
        this.eventBroadcaster.on('CANCEL_ORDER', async (data) => {
            await this.handleOrderCancellation(data);
        });
        
        // Handle position updates from bot instances
        this.eventBroadcaster.on('POSITION_UPDATE', async (data) => {
            await this.handlePositionUpdate(data);
        });
        
        // Handle reconciliation requests
        this.eventBroadcaster.on('REQUEST_RECONCILIATION', async (data) => {
            await this.handleReconciliationRequest(data);
        });
        
        // Handle account balance requests
        this.eventBroadcaster.on('GET_ACCOUNT_BALANCE', async (data) => {
            await this.handleAccountBalanceRequest(data);
        });
        
        // Handle authentication status requests
        this.eventBroadcaster.on('GET_AUTH_STATUS', async (data) => {
            await this.handleAuthStatusRequest(data);
        });
        
        // Handle historical data requests
        this.eventBroadcaster.on('REQUEST_HISTORICAL_DATA', async (data) => {
            await this.handleHistoricalDataRequest(data);
        });
        
        // Handle SL/TP update requests from Trading Aggregator
        this.eventBroadcaster.on('connection-manager:requests', async (data) => {
            if (data.type === 'UPDATE_SLTP') {
                await this.handleSLTPUpdateRequest(data);
            }
        });
        
        // Handle instrument requests
        this.eventBroadcaster.on('instrument-request', async (data) => {
            console.log('🔍 Received instrument request:', data);
            await this.handleInstrumentRequest(data);
        });
        
        // Handle account requests
        this.eventBroadcaster.on('ACCOUNT_REQUEST', async (data) => {
            await this.handleAccountRequest(data);
        });
        
        // Handle account selection notifications
        this.eventBroadcaster.on('ACCOUNT_SELECTED', async (data) => {
            await this.handleAccountSelected(data);
        });
        
        // Handle account balance updates
        this.eventBroadcaster.on('BALANCE_UPDATE', async (data) => {
            await this.handleBalanceUpdate(data);
        });
        
        // Handle account cleared notifications
        this.eventBroadcaster.on('ACCOUNT_CLEARED', async (data) => {
            await this.handleAccountCleared(data);
        });
        
        // Handle connection manager requests (GET_POSITIONS, UPDATE_SLTP, etc.)
        this.eventBroadcaster.on('connection-manager:requests', async (data) => {
            await this.handleConnectionManagerRequest(data);
        });
        
        // Handle account registration for order event subscriptions
        this.eventBroadcaster.on('REGISTER_ACCOUNT', async (data) => {
            await this.handleAccountRegistration(data);
        });
        
        // Configuration service events
        this.configurationService.on('broadcastGlobalConfigUpdate', (data) => {
            this.broadcastGlobalConfigUpdate(data);
        });
        
        this.configurationService.on('broadcastInstanceConfigUpdate', (data) => {
            this.broadcastInstanceConfigUpdate(data);
        });
        
        // Market data service events
        this.marketDataService.on('marketData', (data) => {
            this.distributeMarketData(data);
        });
        
        this.marketDataService.on('connectionLost', () => {
            this.handleConnectionLoss();
        });
        
        // No longer listening for ORDER_FILLED events - we trigger bracket orders
        // immediately after successful order placement
        
        this.marketDataService.on('reconnected', () => {
            this.handleReconnection();
        });
    }
    
    async handleInstanceRegistration(data) {
        try {
            const { instanceId, account, instrument, strategy } = data;
            
            console.log(`📝 Registration request from instance ${instanceId}`);
            console.log(`   Account: ${account}`);
            console.log(`   Instrument: ${instrument}`);
            console.log(`   Strategy: ${strategy}`);
            
            // Validate registration
            const validation = this.instanceRegistry.validateRegistration({
                instanceId,
                account,
                instrument,
                strategy
            });
            
            if (!validation.valid) {
                console.error(`❌ Registration rejected: ${validation.reason}`);
                await this.eventBroadcaster.publish('REGISTRATION_RESPONSE', {
                    instanceId,
                    success: false,
                    reason: validation.reason
                });
                return;
            }
            
            // Register instance
            this.instanceRegistry.registerInstance({
                instanceId,
                account,
                instrument,
                strategy,
                registeredAt: Date.now()
            });
            
            // Subscribe to market data for this instrument
            await this.marketDataService.subscribeToInstrument(instrument);
            
            // Update metrics
            this.metrics.totalInstances++;
            this.metrics.activeInstances = this.instanceRegistry.getActiveCount();
            
            // Send success response
            await this.eventBroadcaster.publish('REGISTRATION_RESPONSE', {
                instanceId,
                success: true,
                connectionInfo: {
                    state: this.state,
                    uptime: Date.now() - this.startTime
                }
            });
            
            console.log(`✅ Instance ${instanceId} registered successfully`);
            
        } catch (error) {
            console.error('❌ Error handling instance registration:', error);
        }
    }
    
    async handleInstanceDeregistration(data) {
        try {
            const { instanceId } = data;
            
            console.log(`📝 Deregistration request from instance ${instanceId}`);
            
            const instance = this.instanceRegistry.getInstance(instanceId);
            if (instance) {
                // Unsubscribe from market data if no other instances need it
                const remainingInstances = this.instanceRegistry.getInstancesByInstrument(instance.instrument);
                if (remainingInstances.length === 1) { // Only this instance
                    await this.marketDataService.unsubscribeFromInstrument(instance.instrument);
                }
                
                // Deregister instance
                this.instanceRegistry.deregisterInstance(instanceId);
                
                // Update metrics
                this.metrics.activeInstances = this.instanceRegistry.getActiveCount();
                
                console.log(`✅ Instance ${instanceId} deregistered`);
            }
            
        } catch (error) {
            console.error('❌ Error handling instance deregistration:', error);
        }
    }
    
    async handleMarketDataSubscription(data) {
        try {
            const { instanceId, instrument, subscribe, requestId, types } = data;
            
            // Validate instrument
            if (!instrument || instrument === 'undefined') {
                console.error(`❌ Invalid instrument received from ${instanceId}: ${instrument}`);
                if (requestId) {
                    await this.eventBroadcaster.publish('MARKET_DATA_SUBSCRIPTION_RESPONSE', {
                        instanceId,
                        requestId,
                        success: false,
                        instrument,
                        error: 'Invalid instrument: ' + instrument
                    });
                }
                return;
            }
            
            let success = false;
            let error = null;
            
            try {
                if (subscribe !== false) {
                    await this.marketDataService.subscribeToInstrument(instrument);
                    console.log(`✅ Instance ${instanceId} subscribed to ${instrument}`);
                    success = true;
                } else {
                    // Check if other instances still need this data
                    const instances = this.instanceRegistry.getInstancesByInstrument(instrument);
                    if (instances.length === 0) {
                        await this.marketDataService.unsubscribeFromInstrument(instrument);
                        console.log(`✅ Unsubscribed from ${instrument} (no instances need it)`);
                    }
                    success = true;
                }
            } catch (err) {
                error = err.message;
                console.error(`❌ Market data subscription error: ${error}`);
            }
            
            // Send response back to instance if requestId is provided
            if (requestId) {
                console.log(`📤 Sending MARKET_DATA_SUBSCRIPTION_RESPONSE for request ${requestId}`);
                await this.eventBroadcaster.publish('MARKET_DATA_SUBSCRIPTION_RESPONSE', {
                    instanceId,
                    requestId,
                    success,
                    instrument,
                    error
                });
                console.log(`✅ Response sent for ${instrument} subscription (${success ? 'success' : 'failed'})`);
            } else {
                console.log(`⚠️  No requestId provided for market data subscription`);
            }
            
        } catch (error) {
            console.error('❌ Error handling market data subscription:', error);
        }
    }
    
    async handleOrderRequest(data) {
        console.log('🚀 BASIC TEST - handleOrderRequest called');
        try {
            console.log('🔥 [DEBUG] handleOrderRequest ENTRY - data received:', JSON.stringify(data, null, 2));
            
            const { instanceId, orderId, orderType, instrument, side, quantity, price, stopPrice, limitPrice, stopLossPoints, takeProfitPoints, accountId } = data;
            
            console.log('🔥 [DEBUG] Extracted variables:', {
                instanceId, orderId, orderType, instrument, side, quantity, price, stopPrice, limitPrice, stopLossPoints, takeProfitPoints, accountId
            });
        
        // Log incoming order with SL/TP details
        if (this.logger) {
            this.logger.logSLTP('Order Received from Instance', {
                instanceId,
                orderId,
                orderType,
                instrument,
                side,
                quantity,
                price,
                stopPrice,
                limitPrice,
                stopLossPoints,
                takeProfitPoints,
                accountId,
                hasStopLoss: !!stopLossPoints || !!stopPrice,
                hasTakeProfit: !!takeProfitPoints || !!limitPrice
            });
        }
        
        // Use mutex to prevent concurrent order placement for same account
        const lockName = `cm_order_${accountId}_${orderType}`;
        const identifier = `${instanceId}_${orderId}`;
        
        console.log('🔥 [DEBUG] About to acquire mutex lock:', { lockName, identifier });
        
        return await this.orderMutex.withLock(lockName, identifier, async () => {
        console.log('🔥 [DEBUG] MUTEX ACQUIRED - entering try block');
        try {
            console.log(`📋 Order request from instance ${instanceId}`);
            console.log(`   Order ID: ${orderId}`);
            console.log(`   Type: ${orderType} | Side: ${side}`);
            console.log(`   Instrument: ${instrument} | Quantity: ${quantity}`);
            if (price) console.log(`   Price: ${price}`);
            if (limitPrice) console.log(`   Limit Price: ${limitPrice}`);
            if (stopPrice) console.log(`   Stop Price: ${stopPrice}`);
            if (stopLossPoints) console.log(`   Stop Loss Points: ${stopLossPoints}`);
            if (takeProfitPoints) console.log(`   Take Profit Points: ${takeProfitPoints}`);
            
            // Check if this is a bracket order (has SL/TP)
            const hasBracket = (limitPrice !== null && limitPrice !== undefined) || 
                              (stopPrice !== null && stopPrice !== undefined) ||
                              (stopLossPoints !== null && stopLossPoints !== undefined) ||
                              (takeProfitPoints !== null && takeProfitPoints !== undefined);
            if (hasBracket) {
                console.log(`📋 [BRACKET] Bracket order detected - Connection Manager will handle two-step process`);
                if (stopLossPoints || takeProfitPoints) {
                    console.log(`📋 [FILL-BASED] Using fill-based calculation mode`);
                    console.log(`   - Stop Loss: ${stopLossPoints ? `${stopLossPoints} points` : 'none'}`);
                    console.log(`   - Take Profit: ${takeProfitPoints ? `${takeProfitPoints} points` : 'none'}`);
                } else {
                    console.log(`📋 [PRICE-BASED] Using price-based calculation mode`);
                    console.log(`   - Stop Loss: ${stopPrice || 'none'}`);
                    console.log(`   - Take Profit: ${limitPrice || 'none'}`);
                }
                // Store bracket info for later application
                if (!this.pendingBrackets) {
                    this.pendingBrackets = new Map();
                }
            }
            
            // Validate order request
            const validation = this.validateOrderRequest(data);
            if (!validation.valid) {
                console.error(`❌ Order validation failed: ${validation.reason}`);
                await this.sendOrderResponse(instanceId, orderId, false, validation.reason);
                return;
            }
            
            // Ensure authentication is valid
            const authStatus = this.authModule.getStatus();
            if (!authStatus.isAuthenticated) {
                console.error('❌ Not authenticated with TopStep');
                await this.sendOrderResponse(instanceId, orderId, false, 'Not authenticated');
                return;
            }
            
            // Ensure we're subscribed to account events for order fills
            if (this.marketDataService && accountId) {
                await this.marketDataService.subscribeToAccountEvents(accountId);
            }
            
            // Place the order based on type
            console.log(`🔄 About to place ${orderType} order...`);
            let result;
            switch (orderType) {
                case 'MARKET':
                    console.log(`📤 Calling placeMarketOrder for ${orderId}...`);
                    result = await this.placeMarketOrder(data);
                    console.log(`📥 placeMarketOrder result for ${orderId}:`, result);
                    break;
                case 'LIMIT':
                    result = await this.placeLimitOrder(data);
                    break;
                case 'STOP':
                    result = await this.placeStopOrder(data);
                    break;
                default:
                    result = { success: false, error: `Unknown order type: ${orderType}` };
            }
            console.log(`🎯 Final order result for ${orderId}: success=${result.success}`);
            if (result.error) console.log(`🎯 Order error: ${result.error}`);
            
            // Send response back to instance
            await this.sendOrderResponse(instanceId, orderId, result.success, result.error, result.topStepOrderId);
            
            // If successful and has bracket orders, store them for later application
            if (result.success && hasBracket) {
                const bracketInfo = {
                    // Store both price-based and point-based values
                    stopLoss: stopPrice,
                    takeProfit: limitPrice,
                    stopLossPoints: stopLossPoints,
                    takeProfitPoints: takeProfitPoints,
                    side: side,  // Store side for point calculation
                    orderId: orderId,
                    instanceId: instanceId,
                    instrument: instrument,
                    accountId: accountId,
                    retryCount: 0,
                    maxRetries: 10,
                    fallbackTimeout: null
                };
                
                this.pendingBrackets.set(result.topStepOrderId.toString(), bracketInfo);
                console.log(`📋 [BRACKET] Stored pending bracket orders for TopStep order ${result.topStepOrderId}`);
                
                if (stopLossPoints || takeProfitPoints) {
                    console.log(`📋 [FILL-BASED] Bracket values (to calculate from fill price):`);
                    console.log(`   - Stop Loss: ${stopLossPoints ? `${stopLossPoints} points` : 'none'}`);
                    console.log(`   - Take Profit: ${takeProfitPoints ? `${takeProfitPoints} points` : 'none'}`);
                } else {
                    console.log(`📋 [PRICE-BASED] Bracket values (pre-calculated):`);
                    console.log(`   - Stop Loss: ${stopPrice || 'none'}`);
                    console.log(`   - Take Profit: ${limitPrice || 'none'}`);
                }
                
                // Since we have success=true and the order ID, start checking for position
                // We don't need to wait for ORDER_FILLED events
                console.log(`📋 [BRACKET] Order placed successfully, starting position check in 3 seconds...`);
                setTimeout(async () => {
                    await this.checkAndApplyBracketOrders(result.topStepOrderId);
                }, 3000); // 3 second delay to allow position creation
            }
            
            // If successful, update position reconciliation service and broadcast
            if (result.success && this.positionReconciliationService) {
                const positionData = {
                    orderId: result.topStepOrderId,
                    instanceId,
                    instrument,
                    side,
                    quantity,
                    orderType,
                    status: 'PENDING',
                    timestamp: Date.now()
                };
                
                // Update master position
                this.updateMasterPosition(positionData);
                
                // Broadcast position update to all instances
                await this.eventBroadcaster.publish('POSITION_UPDATE', {
                    instanceId,
                    position: positionData,
                    timestamp: Date.now()
                });
                
                console.log(`📡 Broadcasted POSITION_UPDATE for order ${result.topStepOrderId}`);
            }
            
            // Update metrics
            if (result.success) {
                console.log(`✅ Order ${orderId} placed successfully (TopStep ID: ${result.topStepOrderId})`);
                
                // Fetch position after order placement and notify Trading Aggregator
                setTimeout(async () => {
                    try {
                        console.log(`🔍 Fetching positions after order ${orderId} placement...`);
                        const positions = await this.getPositions(data.accountId);
                        
                        if (positions && positions.length > 0) {
                            // Find the most recent position for this instrument
                            const matchingPosition = positions.find(pos => 
                                (pos.contractId === data.instrument || pos.symbol === data.instrument) &&
                                Math.abs(pos.positionSize) > 0
                            );
                            
                            if (matchingPosition) {
                                console.log(`📊 Found position for ${orderId}: ID=${matchingPosition.id}, Size=${matchingPosition.positionSize}`);
                                
                                // Publish fill event to Trading Aggregator
                                const fillEvent = {
                                    type: 'ORDER_FILLED',
                                    orderId: orderId,
                                    positionId: matchingPosition.id,
                                    accountId: data.accountId,
                                    instrument: data.instrument,
                                    side: data.side,
                                    quantity: Math.abs(matchingPosition.positionSize),
                                    fillPrice: matchingPosition.averagePrice,
                                    timestamp: Date.now()
                                };
                                
                                await this.eventBroadcaster.publishEvent('market:data', fillEvent);
                                console.log(`📤 Published fill event for order ${orderId}`);
                            } else {
                                console.log(`⚠️ No matching position found for order ${orderId}, retrying in 2 seconds...`);
                                // Retry once more
                                setTimeout(async () => {
                                    try {
                                        const retryPositions = await this.getPositions(data.accountId);
                                        const retryPosition = retryPositions.find(pos => 
                                            (pos.contractId === data.instrument || pos.symbol === data.instrument) &&
                                            Math.abs(pos.positionSize) > 0
                                        );
                                        if (retryPosition) {
                                            const retryFillEvent = {
                                                type: 'ORDER_FILLED',
                                                orderId: orderId,
                                                positionId: retryPosition.id,
                                                accountId: data.accountId,
                                                instrument: data.instrument,
                                                side: data.side,
                                                quantity: Math.abs(retryPosition.positionSize),
                                                fillPrice: retryPosition.averagePrice,
                                                timestamp: Date.now()
                                            };
                                            await this.eventBroadcaster.publishEvent('market:data', retryFillEvent);
                                            console.log(`📤 Published retry fill event for order ${orderId}`);
                                        } else {
                                            console.log(`❌ Still no position found for order ${orderId} after retry`);
                                        }
                                    } catch (retryError) {
                                        console.error(`❌ Error in position retry for order ${orderId}:`, retryError.message);
                                    }
                                }, 2000);
                            }
                        } else {
                            console.log(`⚠️ No positions found for account ${data.accountId} after order ${orderId}`);
                        }
                    } catch (error) {
                        console.error(`❌ Error fetching position after order ${orderId}:`, error.message);
                    }
                }, 3000); // Wait 3 seconds for order to fill
            } else {
                console.error(`❌ Order ${orderId} failed: ${result.error}`);
            }
            
        } catch (error) {
            console.error('❌ Error handling order request:', error);
            console.error('❌ Error details:', {
                message: error.message,
                stack: error.stack,
                instanceId: data.instanceId,
                orderId: data.orderId,
                orderType: data.orderType,
                instrument: data.instrument,
                errorName: error.name
            });
            await this.sendOrderResponse(data.instanceId, data.orderId, false, error.message);
        }
        });
        
        } catch (outerError) {
            console.error('🔥 [DEBUG] OUTER CATCH - Error in handleOrderRequest before mutex:', outerError);
            console.error('🔥 [DEBUG] OUTER CATCH - Error details:', {
                message: outerError.message,
                stack: outerError.stack,
                data: data
            });
        }
    }
    
    async handleConfigRequest(data) {
        try {
            const { instanceId, requestId, requestType } = data;
            console.log(`⚙️ Configuration request from instance ${instanceId} (type: ${requestType})`);
            
            // Get configuration from ConfigurationService
            const globalConfig = await this.configurationService.getGlobalConfiguration();
            let instanceConfig = await this.configurationService.getInstanceConfiguration(instanceId);
            
            // If no instance config exists, try default config
            if (!instanceConfig) {
                console.log(`⚠️  No configuration found for instance ${instanceId}, trying default...`);
                instanceConfig = await this.configurationService.getInstanceConfiguration('default');
            }
            
            // Log what we're sending
            console.log(`📤 Sending configuration response:`);
            console.log(`   Global sections: ${globalConfig ? Object.keys(globalConfig).join(', ') : 'none'}`);
            console.log(`   Instance config: ${instanceConfig ? 'found' : 'not found'}`);
            
            // Send response back to requesting instance
            await this.eventBroadcaster.publish('CONFIG_RESPONSE', {
                instanceId,
                requestId,
                requestType,
                success: true,
                config: {
                    global: globalConfig || {},
                    instance: instanceConfig || {}
                }
            });
            
            console.log(`✅ Sent configuration to instance ${instanceId}`);
            
        } catch (error) {
            console.error('❌ Error handling config request:', error);
            await this.eventBroadcaster.publish('CONFIG_RESPONSE', {
                instanceId: data.instanceId,
                requestId: data.requestId,
                requestType: data.requestType,
                success: false,
                error: error.message
            });
        }
    }
    
    async handleConfigManagerAccountRequest(data) {
        try {
            const { requestId, type, forceFresh } = data;
            console.log(`🏦 Processing Config Manager account request, type: ${type}, requestId: ${requestId}, forceFresh: ${forceFresh}`);
            
            if (type === 'GET_ACCOUNTS') {
                // Check if we have cached accounts first (unless forceFresh is true)
                if (!forceFresh && this.cachedAccounts && this.cachedAccounts.length > 0) {
                    console.log(`✅ Using cached accounts: ${this.cachedAccounts.length} accounts`);
                    
                    // Send cached accounts immediately
                    await this.eventBroadcaster.publish('account-response', {
                        requestId,
                        accounts: this.cachedAccounts,
                        success: true,
                        error: null,
                        timestamp: Date.now()
                    });
                    
                    console.log(`✅ Sent cached account data to Config Manager`);
                    return;
                }
                
                // Otherwise fetch accounts from TopStep API (or if forceFresh is true)
                console.log(forceFresh ? '🔄 Force refresh requested - fetching fresh data from API' : '🔍 No cached accounts - fetching from API');
                const accounts = await this.fetchAccountsFromTopStep(forceFresh);
                console.log(`📤 Account fetch result:`, accounts);
                console.log(`📤 Sending ${accounts.accounts?.length || 0} accounts to Config Manager`);
                
                // Publish response on the channel Config Manager expects
                await this.eventBroadcaster.publish('account-response', {
                    requestId,
                    accounts: accounts.accounts || [],
                    success: accounts.success,
                    error: accounts.error || null,
                    timestamp: Date.now()
                });
                
                console.log(`✅ Sent account data to Config Manager for request ${requestId}`);
            }
            
        } catch (error) {
            console.error('❌ Error handling Config Manager account request:', error);
            // If we have cached accounts, send them even if there's an error
            if (this.cachedAccounts && this.cachedAccounts.length > 0) {
                console.log('⚠️ Using cached accounts due to error');
                await this.eventBroadcaster.publish('account-response', {
                    requestId: data.requestId,
                    accounts: this.cachedAccounts,
                    success: true,
                    error: null,
                    cached: true,
                    timestamp: Date.now()
                });
                return;
            }
            
            // Send error response
            await this.eventBroadcaster.publish('account-response', {
                requestId: data.requestId,
                accounts: [],
                success: false,
                error: error.message,
                timestamp: Date.now()
            });
        }
    }
    
    async handleGetAccounts(data) {
        try {
            const { instanceId, requestId } = data;
            console.log(`🏦 Processing account fetch request from instance ${instanceId}, requestId: ${requestId}`);
            
            // Fetch accounts from TopStep API
            console.log('🔍 Fetching accounts from TopStep API...');
            const accounts = await this.fetchAccountsFromTopStep();
            console.log(`🔍 Received ${accounts.accounts?.length || 0} accounts from TopStep`);
            
            // Send response back to requesting instance
            console.log(`🔍 Sending response back to instance ${instanceId}...`);
            await this.eventBroadcaster.publish('ACCOUNTS_RESPONSE', {
                instanceId,
                requestId,
                success: accounts.success,
                accounts: accounts.accounts || [],
                error: accounts.error || null
            });
            
            console.log(`✅ Sent ${accounts.accounts?.length || 0} accounts to instance ${instanceId}`);
            
        } catch (error) {
            console.error('❌ Error handling account request:', error);
            await this.eventBroadcaster.publish('ACCOUNTS_RESPONSE', {
                instanceId: data.instanceId,
                requestId: data.requestId,
                success: false,
                accounts: [],
                error: error.message
            });
        }
    }
    
    async handleAccountRequest(data) {
        try {
            const { instanceId, requestId, requestType } = data;
            console.log(`🏦 Processing account request from instance ${instanceId} (type: ${requestType})`);
            
            let response = { success: false };
            
            switch (requestType) {
                case 'GET_ACCOUNTS':
                    response = await this.fetchAccountsFromTopStep();
                    break;
                    
                case 'GET_ACCOUNT_DETAILS':
                    if (data.accountId) {
                        response = await this.fetchAccountDetails(data.accountId);
                    } else {
                        response = { success: false, error: 'Account ID required' };
                    }
                    break;
                    
                default:
                    response = { success: false, error: `Unknown request type: ${requestType}` };
            }
            
            // Send response back to requesting instance
            await this.eventBroadcaster.publish('ACCOUNT_RESPONSE', {
                instanceId,
                requestId,
                requestType,
                success: response.success,
                accounts: response.accounts || [],
                account: response.account || null,
                error: response.error || null
            });
            
            console.log(`✅ Sent account response to instance ${instanceId} (success: ${response.success})`);
            
        } catch (error) {
            console.error('❌ Error handling account request:', error);
            await this.eventBroadcaster.publish('ACCOUNT_RESPONSE', {
                instanceId: data.instanceId,
                requestId: data.requestId,
                requestType: data.requestType,
                success: false,
                accounts: [],
                account: null,
                error: error.message
            });
        }
    }
    
    async fetchAccountDetails(accountId) {
        try {
            console.log(`🔍 Fetching details for account ${accountId}...`);
            
            const tokenResult = await this.authModule.ensureValidToken();
            if (!tokenResult.success) {
                throw new Error('Authentication required');
            }
            
            const axios = require('axios');
            const response = await axios.post(`${this.config.apiBaseUrl}/api/Account/search`, {
                onlyActiveAccounts: true
            }, {
                headers: this.authModule.getAuthHeaders(),
                timeout: 15000
            });
            
            if (response.data && Array.isArray(response.data.accounts)) {
                const account = response.data.accounts.find(acc => acc.id === accountId);
                if (account) {
                    console.log(`✅ Found account details for ${accountId}`);
                    return {
                        success: true,
                        account: account
                    };
                } else {
                    return {
                        success: false,
                        error: `Account ${accountId} not found`
                    };
                }
            }
            
            return {
                success: false,
                error: 'No accounts found in response'
            };
            
        } catch (error) {
            console.error(`❌ Failed to fetch account details for ${accountId}:`, error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    async handleAccountSelected(data) {
        try {
            const { instanceId, accountId, accountName, balance, canTrade } = data;
            console.log(`🏦 Account selected by instance ${instanceId}: ${accountName} (${accountId})`);
            
            // Update instance registry with selected account
            const instance = this.instanceRegistry.getInstance(instanceId);
            if (instance) {
                instance.selectedAccount = {
                    accountId,
                    accountName,
                    balance,
                    canTrade,
                    selectedAt: Date.now()
                };
                console.log(`✅ Updated instance ${instanceId} with selected account`);
            }
            
        } catch (error) {
            console.error('❌ Error handling account selection:', error);
        }
    }
    
    async handleBalanceUpdate(data) {
        try {
            const { instanceId, accountId, newBalance } = data;
            console.log(`💰 Balance update from instance ${instanceId}: Account ${accountId} = $${newBalance.toFixed(2)}`);
            
            // Update instance registry
            const instance = this.instanceRegistry.getInstance(instanceId);
            if (instance && instance.selectedAccount && instance.selectedAccount.accountId === accountId) {
                instance.selectedAccount.balance = newBalance;
                instance.selectedAccount.lastUpdated = Date.now();
                console.log(`✅ Updated balance for instance ${instanceId}`);
            }
            
        } catch (error) {
            console.error('❌ Error handling balance update:', error);
        }
    }
    
    async handleAccountCleared(data) {
        try {
            const { instanceId } = data;
            console.log(`🔄 Account cleared by instance ${instanceId}`);
            
            // Update instance registry
            const instance = this.instanceRegistry.getInstance(instanceId);
            if (instance) {
                instance.selectedAccount = null;
                console.log(`✅ Cleared account for instance ${instanceId}`);
            }
            
        } catch (error) {
            console.error('❌ Error handling account clearing:', error);
        }
    }
    
    async handleAccountRegistration(data) {
        try {
            const { accountId, instanceId } = data;
            console.log(`📝 Account registration from ${instanceId}: ${accountId}`);
            
            // Subscribe to order events for this account
            if (this.marketDataService && accountId) {
                await this.marketDataService.subscribeToAccountEvents(accountId);
                console.log(`✅ Subscribed to order events for account ${accountId}`);
            }
        } catch (error) {
            console.error('❌ Error handling account registration:', error);
        }
    }
    
    async handleConnectionManagerRequest(data) {
        try {
            const { type, requestId } = data;
            console.log(`📨 Processing connection manager request: ${type}, requestId: ${requestId}`);
            
            switch (type) {
                case 'GET_POSITIONS':
                    await this.handleGetPositionsRequest(data);
                    break;
                    
                case 'UPDATE_SLTP':
                    await this.handleUpdateSltpRequest(data);
                    break;
                    
                case 'CLOSE_POSITION':
                    await this.handleClosePositionRequest(data);
                    break;
                    
                case 'GET_ACCOUNTS':
                    await this.handleGetAccountsRequest(data);
                    break;
                    
                case 'GET_CONTRACTS':
                    await this.handleGetContractsRequest(data);
                    break;
                    
                case 'GET_WORKING_ORDERS':
                    await this.handleGetWorkingOrdersRequest(data);
                    break;
                    
                case 'GET_ACTIVE_CONTRACTS':
                    await this.handleGetActiveContractsRequest(data);
                    break;
                    
                case 'GET_STATISTICS':
                    await this.handleGetStatisticsRequest(data);
                    break;
                    
                case 'SEARCH_TRADES':
                    await this.handleSearchTradesRequest(data);
                    break;
                    
                case 'GET_TRADES':
                    await this.handleGetTradesRequest(data);
                    break;
                    
                case 'GET_ACCOUNT_SUMMARY':
                    await this.handleGetAccountSummaryRequest(data);
                    break;
                    
                case 'REQUEST_HISTORICAL_DATA':
                    // Extract payload and forward to historical data handler
                    const historicalRequest = data.payload || data;
                    console.log(`📊 Forwarding historical data request from connection-manager:requests`);
                    await this.handleHistoricalDataRequest(historicalRequest);
                    break;
                    
                default:
                    console.error(`❌ Unknown request type: ${type}`);
                    // Send error response
                    const errorData = {
                        requestId,
                        type,
                        success: false,
                        error: `Unknown request type: ${type}`,
                        timestamp: Date.now()
                    };
                    await this.eventBroadcaster.publisher.publish('connection-manager:response', JSON.stringify(errorData));
            }
            
        } catch (error) {
            console.error('❌ Error handling connection manager request:', error);
            if (data.requestId) {
                const errorData = {
                    requestId: data.requestId,
                    type: data.type,
                    success: false,
                    error: error.message,
                    timestamp: Date.now()
                };
                await this.eventBroadcaster.publisher.publish('connection-manager:response', JSON.stringify(errorData));
            }
        }
    }
    
    async handleGetPositionsRequest(data) {
        try {
            const { requestId, accountId } = data;
            console.log(`📊 Fetching positions for account ${accountId}...`);
            console.log(`🔍 Request data:`, JSON.stringify(data, null, 2));
            
            // Ensure authentication is valid
            const tokenResult = await this.authModule.ensureValidToken();
            if (!tokenResult.success) {
                throw new Error('Authentication required');
            }
            
            // Log auth token (first 20 chars for debugging)
            const token = this.authModule.getToken();
            console.log(`🔐 Auth token: ${token ? token.substring(0, 20) + '...' : 'NO TOKEN'}`);
            
            const axios = require('axios');
            
            // Use the same API endpoint as the working Python bot
            const url = `https://userapi.topstepx.com/Position?accountId=${accountId}`;
            console.log(`🔍 Requesting positions from: ${url}`);
            
            const response = await axios.get(url, {
                headers: this.authModule.getAuthHeaders(),
                timeout: 15000
            });
            
            console.log(`📊 TopStep API response status: ${response.status}`);
            console.log(`📊 TopStep API response data:`, JSON.stringify(response.data, null, 2));
            
            // Handle both possible response formats
            const positions = Array.isArray(response.data) ? response.data : 
                           (response.data && Array.isArray(response.data.positions)) ? response.data.positions : 
                           [];
            
            if (positions.length > 0) {
                console.log(`✅ Found ${positions.length} positions for account ${accountId}`);
                
                // Log each position detail
                positions.forEach((pos, index) => {
                    // Use positionSize from userapi endpoint (should be signed)
                    const positionSize = pos.positionSize || pos.size || 0;
                    const side = positionSize > 0 ? 'LONG' : 'SHORT';
                    console.log(`   Position ${index + 1}: ${pos.contractId} - Qty: ${Math.abs(positionSize)}, Side: ${side}, Entry: ${pos.averagePrice}`);
                    console.log(`   Raw position data:`, JSON.stringify(pos, null, 2));
                });
                
                // Send response back via standard channel
                const responseData = {
                    requestId,
                    type: 'GET_POSITIONS',
                    success: true,
                    positions: positions,
                    accountId,
                    timestamp: Date.now()
                };
                await this.eventBroadcaster.publisher.publish('connection-manager:response', JSON.stringify(responseData));
                
                console.log(`✅ Sent position response for request ${requestId}`);
                
            } else {
                // No positions found
                console.log(`📊 No positions found for account ${accountId}`);
                const emptyResponse = {
                    requestId,
                    type: 'GET_POSITIONS',
                    success: true,
                    positions: [],
                    accountId,
                    timestamp: Date.now()
                };
                await this.eventBroadcaster.publisher.publish('connection-manager:response', JSON.stringify(emptyResponse));
            }
            
        } catch (error) {
            console.error(`❌ Failed to fetch positions:`, error.message);
            if (error.response) {
                console.error(`   Status: ${error.response.status}`);
                console.error(`   Response:`, JSON.stringify(error.response.data));
                
                // For 404, it might mean no positions, not an error
                if (error.response.status === 404) {
                    console.log(`ℹ️  API returned 404 - treating as no positions for account ${data.accountId}`);
                    const notFoundResponse = {
                        requestId: data.requestId,
                        type: 'GET_POSITIONS',
                        success: true,
                        positions: [],
                        accountId: data.accountId,
                        timestamp: Date.now()
                    };
                    await this.eventBroadcaster.publisher.publish('connection-manager:response', JSON.stringify(notFoundResponse));
                    return;
                }
            }
            
            // Send error response for other errors
            const errorData = {
                requestId: data.requestId,
                type: 'GET_POSITIONS',
                success: false,
                positions: [],
                error: error.message,
                timestamp: Date.now()
            };
            await this.eventBroadcaster.publisher.publish('connection-manager:response', JSON.stringify(errorData));
        }
    }
    
    async handleUpdateSltpRequest(data) {
        try {
            const { requestId, positionId, stopLoss, takeProfit } = data;
            console.log(`💰 Updating SL/TP for position ${positionId}...`);
            console.log(`   Stop Loss: ${stopLoss || 'Not set'}`);
            console.log(`   Take Profit: ${takeProfit || 'Not set'}`);
            
            // Ensure authentication is valid
            const tokenResult = await this.authModule.ensureValidToken();
            if (!tokenResult.success) {
                throw new Error('Authentication required');
            }
            
            const axios = require('axios');
            const payload = {
                positionId: positionId,
                stopLoss: stopLoss ? parseFloat(stopLoss) : null,
                takeProfit: takeProfit ? parseFloat(takeProfit) : null
            };
            
            console.log(`[DEBUG] Payload SL/TP:`, JSON.stringify(payload, null, 2));
            
            const response = await axios.post(
                `https://userapi.topstepx.com/Order/editStopLossAccount`,
                payload,
                {
                    headers: this.authModule.getAuthHeaders(),
                    timeout: 15000
                }
            );
            
            if (response.status === 200) {
                console.log(`[✅ SL/TP] SL: ${stopLoss || 'None'} | TP: ${takeProfit || 'None'} placed OK .`);
                
                // Send success response
                const successData = {
                    requestId,
                    type: 'UPDATE_SLTP',
                    success: true,
                    positionId,
                    stopLoss,
                    takeProfit,
                    timestamp: Date.now()
                };
                await this.eventBroadcaster.publisher.publish('connection-manager:response', JSON.stringify(successData));
                
            } else {
                throw new Error(`Unexpected response status: ${response.status}`);
            }
            
        } catch (error) {
            console.error(`[❌ ERROR SL/TP] ${error.message}`);
            if (error.response) {
                console.error(`[❌ DETAIL] Status: ${error.response.status}, Data:`, error.response.data);
            }
            
            // Send error response
            const errorData = {
                requestId: data.requestId,
                type: 'UPDATE_SLTP',
                success: false,
                error: error.message,
                timestamp: Date.now()
            };
            await this.eventBroadcaster.publisher.publish('connection-manager:response', JSON.stringify(errorData));
        }
    }
    
    async handleClosePositionRequest(data) {
        try {
            const { requestId, accountId, contractId, closeType, size } = data;
            console.log(`🔄 Processing CLOSE_POSITION request for contract: ${contractId} (${closeType})`);
            console.log(`   Account: ${accountId}, Size: ${size || 'full'}`);
            console.log(`🔍 [CLAUDE DEBUG] Step 1: Initial logging complete`);
            
            // Debug: Log incoming data types
            console.log(`🔍 [CLAUDE DEBUG] Step 2: About to log data types`);
            console.log(`🔍 [DEBUG] Data types received:`);
            console.log(`   - accountId type: ${typeof accountId}, value: ${accountId}`);
            console.log(`   - contractId type: ${typeof contractId}, value: ${contractId}`);
            console.log(`   - closeType: ${closeType}`);
            console.log(`   - size type: ${typeof size}, value: ${size}`);
            console.log(`   - Full request data:`, JSON.stringify(data, null, 2));
            
            console.log(`🔍 [CLAUDE DEBUG] Step 3: Data types logged, getting auth token`);
            
            // Get authentication token
            const token = this.authModule.getToken();
            console.log(`🔍 [CLAUDE DEBUG] Step 4: Auth token retrieved: ${token ? 'YES' : 'NO'}`);
            if (!token) {
                throw new Error('No authentication token available');
            }
            
            // Debug: Log auth headers
            const authHeaders = this.authModule.getAuthHeaders();
            console.log(`🔐 [DEBUG] Auth headers being used:`, {
                ...authHeaders,
                'Authorization': authHeaders['Authorization'] ? authHeaders['Authorization'].substring(0, 30) + '...' : 'NO AUTH'
            });
            
            let apiUrl;
            let payload;
            
            if (closeType === 'full' || !size) {
                // Full close - use close position API
                apiUrl = 'https://api.topstepx.com/api/Position/closeContract';
                payload = {
                    accountId: accountId,
                    contractId: contractId
                };
            } else {
                // Partial close - use partial close position API
                apiUrl = 'https://api.topstepx.com/api/Position/partialCloseContract';
                payload = {
                    accountId: accountId,
                    contractId: contractId,
                    size: parseInt(size)
                };
            }
            
            console.log(`🔍 [CLAUDE DEBUG] Step 5: About to make TopStep API call`);
            console.log(`📤 Making TopStep API call to: ${apiUrl}`);
            console.log(`📤 Payload:`, JSON.stringify(payload, null, 2));
            console.log(`📤 [DEBUG] Payload details:`);
            console.log(`   - accountId in payload: type=${typeof payload.accountId}, value=${payload.accountId}`);
            console.log(`   - contractId in payload: type=${typeof payload.contractId}, value=${payload.contractId}`);
            if (payload.size !== undefined) {
                console.log(`   - size in payload: type=${typeof payload.size}, value=${payload.size}`);
            }
            
            const axios = require('axios');
            
            // Debug: Log the full request configuration
            const requestConfig = {
                method: 'POST',
                url: apiUrl,
                data: payload,
                headers: this.authModule.getAuthHeaders(),
                timeout: 15000
            };
            console.log(`🔍 [DEBUG] Full axios request config:`, {
                ...requestConfig,
                headers: {
                    ...requestConfig.headers,
                    'Authorization': requestConfig.headers['Authorization'] ? requestConfig.headers['Authorization'].substring(0, 30) + '...' : 'NO AUTH'
                }
            });
            
            const response = await axios.post(apiUrl, payload, {
                headers: this.authModule.getAuthHeaders(),
                timeout: 15000
            });
            
            console.log(`✅ TopStep close position API response:`, response.data);
            console.log(`🔍 [DEBUG] Response details:`);
            console.log(`   - Status: ${response.status}`);
            console.log(`   - Status Text: ${response.statusText}`);
            console.log(`   - Headers:`, response.headers);
            console.log(`   - Data type: ${typeof response.data}`);
            console.log(`   - Full response data:`, JSON.stringify(response.data, null, 2));
            
            // Check if TopStep API actually succeeded
            const topStepSuccess = response.data && response.data.success === true;
            
            if (topStepSuccess) {
                // Send success response back through aggregator
                const responseData = {
                    requestId: requestId,
                    type: 'CLOSE_POSITION',
                    success: true,
                    data: response.data,
                    timestamp: Date.now()
                };
                await this.eventBroadcaster.publisher.publish('connection-manager:response', JSON.stringify(responseData));
                
                console.log(`✅ Sent close position success response for request ${requestId}`);
            } else {
                // TopStep API returned an error, send error response
                const errorCode = response.data?.errorCode || 'unknown';
                const errorMessage = response.data?.errorMessage || `TopStep API error code ${errorCode}`;
                
                console.error(`❌ TopStep close position failed - Error code: ${errorCode}, Message: ${errorMessage}`);
                
                const errorResponse = {
                    requestId: requestId,
                    type: 'CLOSE_POSITION',
                    success: false,
                    error: `TopStep API Error ${errorCode}: ${errorMessage}`,
                    timestamp: Date.now()
                };
                await this.eventBroadcaster.publisher.publish('connection-manager:response', JSON.stringify(errorResponse));
                
                console.log(`❌ Sent close position error response for request ${requestId}`);
            }
            
        } catch (error) {
            console.error('❌ Error handling CLOSE_POSITION request:', error);
            console.error('🔍 [DEBUG] Full error object:', {
                message: error.message,
                code: error.code,
                statusCode: error.response?.status,
                statusText: error.response?.statusText,
                config: error.config ? {
                    url: error.config.url,
                    method: error.config.method,
                    data: error.config.data,
                    headers: {
                        ...error.config.headers,
                        'Authorization': error.config.headers?.['Authorization'] ? error.config.headers['Authorization'].substring(0, 30) + '...' : 'NO AUTH'
                    }
                } : null
            });
            
            let errorDetails = error.message;
            if (error.response) {
                console.error(`❌ TopStep API error - Status: ${error.response.status}`);
                console.error(`❌ TopStep API error - Status Text: ${error.response.statusText}`);
                if (error.response.data) {
                    console.error(`❌ Error response data:`, JSON.stringify(error.response.data, null, 2));
                    errorDetails = `API Error ${error.response.status}: ${JSON.stringify(error.response.data)}`;
                }
                if (error.response.headers) {
                    console.error(`❌ Response headers:`, error.response.headers);
                }
            }
            
            // Send error response back through aggregator
            const errorData = {
                requestId: data.requestId,
                type: 'CLOSE_POSITION',
                success: false,
                error: errorDetails,
                timestamp: Date.now()
            };
            await this.eventBroadcaster.publisher.publish('connection-manager:response', JSON.stringify(errorData));
            
            console.log(`❌ Sent close position error response for request ${data.requestId}`);
        }
    }
    
    async handleGetAccountsRequest(data) {
        try {
            const { requestId, forceFresh, responseChannel } = data;
            console.log(`📊 Processing GET_ACCOUNTS request, requestId: ${requestId}, forceFresh: ${forceFresh}, responseChannel: ${responseChannel}`);
            
            // Fetch accounts using existing method
            const accountsResult = await this.fetchAccountsFromTopStep(forceFresh);
            
            // Always respond to connection-manager:response channel so aggregator can forward
            const channel = 'connection-manager:response';
            
            if (accountsResult.success) {
                console.log(`✅ Successfully fetched ${accountsResult.accounts.length} accounts`);
                
                // Send success response
                const responseData = {
                    requestId: requestId,
                    type: 'GET_ACCOUNTS',
                    success: true,
                    accounts: accountsResult.accounts,
                    count: accountsResult.count,
                    cached: accountsResult.cached,
                    timestamp: Date.now()
                };
                
                // Pass data as second parameter and channel as third parameter
                await this.eventBroadcaster.publisher.publish(channel, JSON.stringify(responseData));
                
                console.log(`✅ Sent account data to channel: ${channel}`);
            } else {
                console.error(`❌ Failed to fetch accounts: ${accountsResult.error}`);
                
                // Send error response
                const errorData = {
                    requestId: requestId,
                    type: 'GET_ACCOUNTS',
                    success: false,
                    error: accountsResult.error,
                    details: accountsResult.details,
                    accounts: [],
                    timestamp: Date.now()
                };
                
                // Pass data as second parameter and channel as third parameter
                await this.eventBroadcaster.publisher.publish(channel, JSON.stringify(errorData));
                
                console.log(`❌ Sent error response to channel: ${channel}`);
            }
            
        } catch (error) {
            console.error('❌ Error handling GET_ACCOUNTS request:', error);
            
            // Send error response on standard channel
            const channel = 'connection-manager:response';
            const errorData = {
                requestId: data.requestId,
                type: 'GET_ACCOUNTS',
                success: false,
                error: error.message,
                accounts: [],
                timestamp: Date.now()
            };
            
            // Publish directly to Redis channel
            await this.eventBroadcaster.publisher.publish(channel, JSON.stringify(errorData));
        }
    }
    
    async handleGetContractsRequest(data) {
        try {
            const { requestId, responseChannel } = data;
            console.log(`📊 Processing GET_CONTRACTS request, requestId: ${requestId}, responseChannel: ${responseChannel}`);
            
            // Get active contracts with full details
            const contractsResult = await this.getActiveContracts();
            
            // Always use standard response channel
            const channel = 'connection-manager:response';
            
            if (contractsResult.success && contractsResult.contracts) {
                console.log(`✅ Successfully fetched ${contractsResult.contracts.length} contracts with full details`);
                
                // Send success response with full contract details
                const responseData = {
                    requestId: requestId,
                    type: 'GET_CONTRACTS',
                    success: true,
                    contracts: contractsResult.contracts,
                    count: contractsResult.contracts.length,
                    timestamp: Date.now()
                };
                
                await this.eventBroadcaster.publisher.publish(channel, JSON.stringify(responseData));
                console.log(`✅ Sent contract data to channel: ${channel}`);
            } else {
                console.error(`❌ Failed to fetch contracts: ${contractsResult.error}`);
                
                // Send error response
                const errorData = {
                    requestId: requestId,
                    type: 'GET_CONTRACTS',
                    success: false,
                    error: contractsResult.error || 'Failed to fetch contracts',
                    contracts: [],
                    timestamp: Date.now()
                };
                
                await this.eventBroadcaster.publisher.publish(channel, JSON.stringify(errorData));
                console.log(`❌ Sent error response to channel: ${channel}`);
            }
            
        } catch (error) {
            console.error('❌ Error handling GET_CONTRACTS request:', error);
            
            // Send error response on standard channel
            const channel = 'connection-manager:response';
            const errorData = {
                requestId: data.requestId,
                type: 'GET_CONTRACTS',
                success: false,
                error: error.message,
                contracts: [],
                timestamp: Date.now()
            };
            
            await this.eventBroadcaster.publisher.publish(channel, JSON.stringify(errorData));
        }
    }
    
    async handleGetWorkingOrdersRequest(data) {
        try {
            const { requestId, responseChannel, instanceId } = data;
            console.log(`📋 Processing GET_WORKING_ORDERS request, requestId: ${requestId}, instanceId: ${instanceId}`);
            
            // Get working orders from order manager
            const workingOrders = [];
            
            // Collect working orders from all accounts
            if (this.orderManager && this.orderManager.workingOrders) {
                for (const [orderId, order] of this.orderManager.workingOrders) {
                    if (order.status === 'WORKING' || order.status === 'PENDING') {
                        workingOrders.push({
                            orderId: order.orderId,
                            accountId: order.accountId,
                            contractId: order.contractId,
                            side: order.side,
                            quantity: order.quantity,
                            orderType: order.orderType,
                            price: order.price,
                            status: order.status,
                            timestamp: order.timestamp
                        });
                    }
                }
            }
            
            console.log(`✅ Found ${workingOrders.length} working orders`);
            
            // Send response
            const channel = 'connection-manager:response';
            const responseData = {
                requestId: requestId,
                type: 'GET_WORKING_ORDERS',
                success: true,
                orders: workingOrders,
                count: workingOrders.length,
                timestamp: Date.now()
            };
            
            await this.eventBroadcaster.publisher.publish(channel, JSON.stringify(responseData));
            
        } catch (error) {
            console.error('❌ Error handling GET_WORKING_ORDERS request:', error);
            
            const channel = 'connection-manager:response';
            const errorData = {
                requestId: data.requestId,
                type: 'GET_WORKING_ORDERS',
                success: false,
                error: error.message,
                orders: [],
                timestamp: Date.now()
            };
            
            await this.eventBroadcaster.publisher.publish(channel, JSON.stringify(errorData));
        }
    }
    
    async handleGetStatisticsRequest(data) {
        try {
            const { requestId, accountId, statisticsType = 'todaystats' } = data;
            console.log(`📈 Processing GET_STATISTICS request, requestId: ${requestId}, accountId: ${accountId}, type: ${statisticsType}`);
            
            const axios = require('axios');
            
            // Call TopStepX Statistics API with correct format per Swagger documentation
            let response;
            
            if (statisticsType === 'todaystats') {
                // todaystats uses accountId as query parameter
                const url = `https://userapi.topstepx.com/Statistics/todaystats?accountId=${accountId}`;
                console.log(`🔍 Requesting todaystats from: ${url}`);
                
                response = await axios.post(url, {}, {
                    headers: this.authModule.getAuthHeaders(),
                    timeout: 15000
                });
            } else {
                // lifetimestats and other endpoints use tradingAccountId in POST body
                const url = `https://userapi.topstepx.com/Statistics/${statisticsType}`;
                console.log(`🔍 Requesting ${statisticsType} from: ${url}`);
                
                const requestPayload = {
                    tradingAccountId: parseInt(accountId, 10)  // Ensure it's a number as per API spec
                };
                
                console.log(`🔍 Request payload:`, JSON.stringify(requestPayload, null, 2));
                
                response = await axios.post(url, requestPayload, {
                    headers: this.authModule.getAuthHeaders(),
                    timeout: 15000
                });
            }
            
            console.log(`📊 TopStep Statistics API response status: ${response.status}`);
            console.log(`📊 RAW Statistics response data (FULL):`, JSON.stringify(response.data, null, 2));
            console.log(`📊 Response headers:`, JSON.stringify(response.headers, null, 2));
            
            // Transform the statistics data - TopStepX API returns array of daily stats
            const statisticsArray = response.data || [];
            let transformedStats;
            
            if (Array.isArray(statisticsArray) && statisticsArray.length > 0) {
                // Aggregate all daily statistics
                const aggregated = statisticsArray.reduce((acc, day) => {
                    return {
                        totalTrades: acc.totalTrades + (day.totalTrades || 0),
                        totalPnL: acc.totalPnL + (day.totalPnL || 0),
                        winningTrades: acc.winningTrades + (day.winningTrades || 0),
                        losingTrades: acc.losingTrades + (day.losingTrades || 0),
                        totalFees: acc.totalFees + (day.totalFees || 0),
                        grossProfit: acc.grossProfit + Math.max(day.totalPnL || 0, 0),
                        grossLoss: acc.grossLoss + Math.min(day.totalPnL || 0, 0)
                    };
                }, {
                    totalTrades: 0,
                    totalPnL: 0,
                    winningTrades: 0,
                    losingTrades: 0,
                    totalFees: 0,
                    grossProfit: 0,
                    grossLoss: 0
                });
                
                // Calculate derived statistics
                const winRate = aggregated.totalTrades > 0 ? (aggregated.winningTrades / aggregated.totalTrades * 100) : 0;
                const profitFactor = Math.abs(aggregated.grossLoss) > 0 ? (aggregated.grossProfit / Math.abs(aggregated.grossLoss)) : 0;
                const averageWin = aggregated.winningTrades > 0 ? (aggregated.grossProfit / aggregated.winningTrades) : 0;
                const averageLoss = aggregated.losingTrades > 0 ? Math.abs(aggregated.grossLoss / aggregated.losingTrades) : 0;
                
                // Find largest win/loss from daily data
                const largestWin = Math.max(...statisticsArray.map(day => Math.max(day.totalPnL || 0, 0)));
                const largestLoss = Math.abs(Math.min(...statisticsArray.map(day => Math.min(day.totalPnL || 0, 0))));
                
                transformedStats = {
                    totalTrades: aggregated.totalTrades,
                    winRate: Math.round(winRate * 100) / 100, // Round to 2 decimal places
                    totalPnL: Math.round(aggregated.totalPnL * 100) / 100,
                    profitFactor: Math.round(profitFactor * 100) / 100,
                    averageWin: Math.round(averageWin * 100) / 100,
                    averageLoss: Math.round(averageLoss * 100) / 100,
                    grossProfit: Math.round(aggregated.grossProfit * 100) / 100,
                    grossLoss: Math.round(aggregated.grossLoss * 100) / 100,
                    winningTrades: aggregated.winningTrades,
                    losingTrades: aggregated.losingTrades,
                    largestWin: Math.round(largestWin * 100) / 100,
                    largestLoss: Math.round(largestLoss * 100) / 100
                };
            } else {
                // Empty array or no data - return zeros
                transformedStats = {
                    totalTrades: 0,
                    winRate: 0,
                    totalPnL: 0,
                    profitFactor: 0,
                    averageWin: 0,
                    averageLoss: 0,
                    grossProfit: 0,
                    grossLoss: 0,
                    winningTrades: 0,
                    losingTrades: 0,
                    largestWin: 0,
                    largestLoss: 0
                };
            }
            
            console.log(`✅ Transformed statistics:`, transformedStats);
            
            // Send response back via standard channel
            const responseData = {
                requestId,
                type: 'GET_STATISTICS',
                success: true,
                statistics: transformedStats,
                accountId,
                statisticsType,
                timestamp: Date.now()
            };
            await this.eventBroadcaster.publisher.publish('connection-manager:response', JSON.stringify(responseData));
            
            console.log(`✅ Sent statistics response for request ${requestId}`);
            
        } catch (error) {
            console.error(`❌ Failed to fetch statistics:`, error.message);
            if (error.response) {
                console.error(`   Status: ${error.response.status}`);
                console.error(`   Response:`, JSON.stringify(error.response.data));
            }
            
            // Send error response
            const errorData = {
                requestId: data.requestId,
                type: 'GET_STATISTICS',
                success: false,
                statistics: null,
                error: error.message,
                timestamp: Date.now()
            };
            await this.eventBroadcaster.publisher.publish('connection-manager:response', JSON.stringify(errorData));
        }
    }

    async handleGetActiveContractsRequest(data) {
        try {
            const { requestId, responseChannel } = data;
            console.log(`📊 Processing GET_ACTIVE_CONTRACTS request, requestId: ${requestId}`);
            
            // Use existing getActiveContracts method
            const contractsResult = await this.getActiveContracts();
            
            // Send response
            const channel = 'connection-manager:response';
            
            if (contractsResult.success && contractsResult.contracts) {
                console.log(`✅ Successfully fetched ${contractsResult.contracts.length} active contracts`);
                
                const responseData = {
                    requestId: requestId,
                    type: 'GET_ACTIVE_CONTRACTS',
                    success: true,
                    contracts: contractsResult.contracts,
                    count: contractsResult.contracts.length,
                    timestamp: Date.now()
                };
                
                await this.eventBroadcaster.publisher.publish(channel, JSON.stringify(responseData));
            } else {
                console.error(`❌ Failed to fetch active contracts: ${contractsResult.error}`);
                
                const errorData = {
                    requestId: requestId,
                    type: 'GET_ACTIVE_CONTRACTS',
                    success: false,
                    error: contractsResult.error || 'Failed to fetch active contracts',
                    contracts: [],
                    timestamp: Date.now()
                };
                
                await this.eventBroadcaster.publisher.publish(channel, JSON.stringify(errorData));
            }
            
        } catch (error) {
            console.error('❌ Error handling GET_ACTIVE_CONTRACTS request:', error);
            
            const channel = 'connection-manager:response';
            const errorData = {
                requestId: data.requestId,
                type: 'GET_ACTIVE_CONTRACTS',
                success: false,
                error: error.message,
                contracts: [],
                timestamp: Date.now()
            };
            
            await this.eventBroadcaster.publisher.publish(channel, JSON.stringify(errorData));
        }
    }
    
    async validateApiIntegration() {
        try {
            console.log('🔍 Step 1: Fetching and caching trading accounts...');
            const accountsResult = await this.fetchAccountsFromTopStep();
            
            if (!accountsResult.success || accountsResult.accounts.length === 0) {
                throw new Error(`Account fetch failed: ${accountsResult.error}`);
            }
            
            console.log(`✅ Found ${accountsResult.accounts.length} trading accounts`);
            accountsResult.accounts.forEach((account, index) => {
                const balance = account.balance ? `$${account.balance.toLocaleString()}` : 'N/A';
                console.log(`   ${index + 1}. ${account.id} - ${account.name || 'Account'} (Balance: ${balance})`);
            });
            
            // Subscribe to account updates for all accounts
            console.log('🔍 Subscribing to account updates...');
            for (const account of accountsResult.accounts) {
                if (this.marketDataService && this.marketDataService.subscribeToAccountEvents) {
                    await this.marketDataService.subscribeToAccountEvents(account.id);
                    console.log(`✅ Subscribed to account ${account.id} (${account.name})`);
                }
            }
            
            // Also fetch initial positions for each account
            console.log('🔍 Fetching initial positions...');
            for (const account of accountsResult.accounts) {
                try {
                    const positionsResponse = await this.authModule.apiRequest('/api/Position/searchOpen', {
                        method: 'POST',
                        data: { accountId: account.id }
                    });
                    
                    if (positionsResponse.data?.positions?.length > 0) {
                        console.log(`📊 Account ${account.id} has ${positionsResponse.data.positions.length} open positions:`);
                        positionsResponse.data.positions.forEach(pos => {
                            const side = pos.type === 1 ? 'LONG' : 'SHORT';
                            console.log(`   - ${pos.contractId}: ${side} ${pos.size} @ ${pos.averagePrice}`);
                        });
                    } else {
                        console.log(`📊 Account ${account.id} has no open positions`);
                    }
                } catch (error) {
                    console.error(`❌ Failed to fetch positions for account ${account.id}:`, error.message);
                }
            }
            
            // Get a test instrument from the active contracts
            const apiContracts = await this.fetchContractsFromTopStep();
            if (apiContracts && apiContracts.length > 0) {
                this.testInstrument = apiContracts[0]; // Use first available contract
                console.log(`🔍 Step 2: Testing market data access with ${this.testInstrument}...`);
            } else {
                console.log('⚠️ No contracts available from API to test market data');
                this.testInstrument = null;
            }
            
            if (this.testInstrument) {
                await this.testMarketDataAccess();
            }
            
            // Test 3: Test historical data access
            console.log('🔍 Step 3: Testing historical data access...');
            await this.testHistoricalDataAccess();
            
            this.apiValidated = true;
            console.log('✅ TopStep API integration validated successfully');
            console.log('   - Account fetching: Working');
            console.log('   - Live market data: Working');
            console.log('   - Historical data: Working');
            
        } catch (error) {
            console.error('❌ API integration validation failed:', error.message);
            throw new Error(`API validation failed: ${error.message}`);
        }
    }
    
    async handleInstrumentRequest(data) {
        try {
            const { requestId, type, symbol, contractId } = data;
            console.log(`🏦 Processing instrument request, type: ${type}, requestId: ${requestId}`);
            
            let response = { success: false };
            
            switch (type) {
                case 'SEARCH_CONTRACTS':
                    response = await this.searchActiveContracts(symbol);
                    break;
                    
                case 'VALIDATE_CONTRACT':
                    response = await this.validateContract(contractId);
                    break;
                    
                case 'GET_ACTIVE_CONTRACTS':
                    response = await this.getActiveContracts();
                    break;
                    
                default:
                    response = { success: false, error: `Unknown request type: ${type}` };
            }
            
            // Send response
            await this.eventBroadcaster.publish('instrument-response', {
                requestId,
                type,
                ...response,
                timestamp: Date.now()
            });
            
            console.log(`✅ Sent instrument response for request ${requestId}`);
            
        } catch (error) {
            console.error('❌ Error handling instrument request:', error);
            await this.eventBroadcaster.publish('instrument-response', {
                requestId: data.requestId,
                type: data.type,
                success: false,
                error: error.message,
                timestamp: Date.now()
            });
        }
    }
    
    async searchActiveContracts(symbol) {
        try {
            console.log(`🔍 Searching for active contracts with symbol: ${symbol}`);
            
            const tokenResult = await this.authModule.ensureValidToken();
            if (!tokenResult.success) {
                throw new Error('Authentication required');
            }
            
            const axios = require('axios');
            
            // TopStep uses a contract search endpoint
            const response = await axios.post(`${this.config.apiBaseUrl}/api/Contract/search`, {
                symbol: symbol,
                onlyActive: true,
                includeExpired: false
            }, {
                headers: this.authModule.getAuthHeaders(),
                timeout: 15000
            });
            
            if (response.data && Array.isArray(response.data.contracts)) {
                const contracts = response.data.contracts.map(contract => ({
                    contractId: contract.id,
                    symbol: contract.symbol,
                    name: contract.name,
                    exchange: contract.exchange,
                    expirationDate: contract.expirationDate,
                    isActive: contract.isActive,
                    tickSize: contract.tickSize,
                    pointValue: contract.multiplier || contract.pointValue, // Handle both multiplier and pointValue
                    currency: contract.currency,
                    contractType: contract.contractType,
                    underlyingSymbol: contract.underlyingSymbol
                }));
                
                console.log(`✅ Found ${contracts.length} active contracts for ${symbol}`);
                
                // Cache the results
                this.cacheContracts(contracts);
                
                return {
                    success: true,
                    contracts: contracts,
                    count: contracts.length
                };
            }
            
            return {
                success: true,
                contracts: [],
                count: 0
            };
            
        } catch (error) {
            console.error(`❌ Failed to search contracts for ${symbol}:`, error.message);
            
            // If the search endpoint doesn't exist, try to get known contracts
            if (error.response && error.response.status === 404) {
                console.log('❌ Contract search endpoint not available - no fallback contracts');
                return { success: false, contracts: [], source: 'api_error' };
            }
            
            return {
                success: false,
                error: error.message,
                contracts: []
            };
        }
    }
    
    async validateContract(contractId) {
        try {
            console.log(`🔍 Validating contract: ${contractId}`);
            
            // First check cache
            const cachedContract = this.getCachedContract(contractId);
            if (cachedContract) {
                console.log(`✅ Contract ${contractId} found in cache`);
                return {
                    success: true,
                    valid: true,
                    contract: cachedContract,
                    cached: true
                };
            }
            
            // Try to get contract details from TopStep
            const tokenResult = await this.authModule.ensureValidToken();
            if (!tokenResult.success) {
                throw new Error('Authentication required');
            }
            
            const axios = require('axios');
            
            // Try to get contract info by subscribing to market data
            // This validates if the contract exists
            try {
                await this.marketDataService.subscribeToInstrument(contractId);
                await this.marketDataService.unsubscribeFromInstrument(contractId);
                
                console.log(`✅ Contract ${contractId} is valid`);
                
                // Cache as valid contract
                this.cacheContract({
                    contractId: contractId,
                    isValid: true,
                    validatedAt: Date.now()
                });
                
                return {
                    success: true,
                    valid: true,
                    contract: {
                        contractId: contractId,
                        isValid: true
                    }
                };
                
            } catch (subscribeError) {
                console.log(`❌ Contract ${contractId} validation failed:`, subscribeError.message);
                return {
                    success: true,
                    valid: false,
                    error: 'Contract not found or inactive'
                };
            }
            
        } catch (error) {
            console.error(`❌ Failed to validate contract ${contractId}:`, error.message);
            return {
                success: false,
                error: error.message,
                valid: false
            };
        }
    }
    
    async getActiveContracts() {
        try {
            console.log('🔍 Getting all active contracts');
            
            // First try to get contracts from TopStep API
            const topStepContracts = await this.fetchContractsFromTopStep();
            
            if (topStepContracts && topStepContracts.length > 0) {
                console.log(`✅ Found ${topStepContracts.length} active contracts from TopStep API`);
                return {
                    success: true,
                    contracts: topStepContracts,
                    count: topStepContracts.length
                };
            }
            
            // No fallback - only use what TopStep provides
            console.log('❌ Failed to fetch from TopStep API - no fallback contracts');
            
            return {
                success: false,
                error: 'TopStep API unavailable',
                contracts: []
            };
            
        } catch (error) {
            console.error('❌ Failed to get active contracts:', error.message);
            return {
                success: false,
                error: error.message,
                contracts: []
            };
        }
    }

    async fetchContractsFromTopStep() {
        try {
            console.log('📡 Fetching available contracts from TopStep API...');
            
            const axios = require('axios');
            
            // Use the correct endpoint: POST /api/Contract/available
            const response = await axios.post(
                `${this.authModule.baseURL}/api/Contract/available`,
                { live: false }, // Request available contracts (not just live)
                {
                    headers: this.authModule.getAuthHeaders(),
                    timeout: 5000
                }
            );
            
            // Check if response has the correct format with 'contracts' array
            if (response.data && response.data.contracts && Array.isArray(response.data.contracts)) {
                const contracts = response.data.contracts;
                console.log(`📊 Received ${contracts.length} contracts from TopStep API`);
                
                // Apply filtering based on configuration
                let filteredContracts;
                if (this.config.microOnly === true) {
                    // Filter for micro contracts and active contracts only
                    filteredContracts = contracts.filter(contract => 
                        contract.activeContract === true && 
                        contract.symbolId && (
                            contract.symbolId.includes('.M') || // Micro contracts
                            contract.symbolId.includes('.GM') || // E-Micro contracts
                            contract.name?.includes('Micro') ||
                            contract.description?.includes('Micro')
                        )
                    );
                    
                    console.log(`🎯 Micro Only Filter Enabled: Found ${filteredContracts.length} active micro contracts:`, 
                        filteredContracts.map(c => `${c.id} (${c.name})`).join(', '));
                } else {
                    // Show all active contracts
                    filteredContracts = contracts.filter(contract => contract.activeContract === true);
                    
                    console.log(`📊 Micro Only Filter Disabled: Found ${filteredContracts.length} active contracts:`, 
                        filteredContracts.map(c => `${c.id} (${c.name})`).join(', '));
                }
                
                // Log first few contracts for debugging
                console.log('📋 Sample contracts from TopStep API:');
                filteredContracts.slice(0, 5).forEach(contract => {
                    const pointValue = contract.tickValue / contract.tickSize;
                    console.log(`  - ${contract.id}: ${contract.name} (tickSize: ${contract.tickSize}, tickValue: $${contract.tickValue}, pointValue: $${pointValue.toFixed(2)}/pt)`);
                });
                
                // Return full contract objects with all properties
                return filteredContracts.map(contract => ({
                    contractId: contract.id,
                    symbol: contract.symbolId || contract.symbol,
                    name: contract.name,
                    exchange: contract.exchange,
                    tickSize: contract.tickSize,
                    pointValue: contract.tickValue / contract.tickSize, // Calculate dollar per point from tickValue/tickSize
                    currency: contract.currency,
                    expirationDate: contract.expirationDate,
                    isActive: contract.activeContract,
                    contractType: contract.contractType,
                    description: contract.description
                }));
            } else if (response.data && Array.isArray(response.data)) {
                // Handle legacy format where response.data is directly an array
                console.log(`📊 Received ${response.data.length} contracts from TopStep API (legacy format)`);
                return response.data.map(contract => ({
                    contractId: contract.id || contract.contractId,
                    symbol: contract.symbolId || contract.symbol,
                    name: contract.name,
                    exchange: contract.exchange || 'US',
                    tickSize: contract.tickSize,
                    pointValue: contract.tickValue / contract.tickSize, // Calculate dollar per point from tickValue/tickSize
                    currency: contract.currency || 'USD',
                    expirationDate: contract.expirationDate,
                    isActive: contract.activeContract !== false,
                    contractType: contract.contractType,
                    description: contract.description
                }));
            }
            
            return null;
        } catch (error) {
            console.error('❌ Failed to fetch contracts from TopStep:', error.message);
            return null;
        }
    }
    
    
    // Contract caching methods
    cacheContracts(contracts) {
        if (!this.contractCache) {
            this.contractCache = new Map();
        }
        
        const now = Date.now();
        for (const contract of contracts) {
            this.contractCache.set(contract.contractId, {
                ...contract,
                cachedAt: now,
                expiresAt: now + (60 * 60 * 1000) // 1 hour TTL
            });
        }
        
        console.log(`📦 Cached ${contracts.length} contracts`);
    }
    
    cacheContract(contract) {
        if (!this.contractCache) {
            this.contractCache = new Map();
        }
        
        const now = Date.now();
        this.contractCache.set(contract.contractId, {
            ...contract,
            cachedAt: now,
            expiresAt: now + (60 * 60 * 1000) // 1 hour TTL
        });
    }
    
    getCachedContract(contractId) {
        if (!this.contractCache || !this.contractCache.has(contractId)) {
            return null;
        }
        
        const cached = this.contractCache.get(contractId);
        const now = Date.now();
        
        // Check if cache is still valid
        if (cached.expiresAt < now) {
            this.contractCache.delete(contractId);
            return null;
        }
        
        return cached;
    }
    
    async testMarketDataAccess() {
        let quoteTimeout = null;  // Move this outside try block so it's accessible in catch
        
        try {
            console.log(`📡 Testing live market data for ${this.testInstrument}...`);
            const { HubConnectionBuilder, HttpTransportType } = require('@microsoft/signalr');
            
            // Test SignalR WebSocket connection to market hub
            const marketHubUrl = this.config.marketHubUrl;
            
            const connection = new HubConnectionBuilder()
                .withUrl(marketHubUrl, {
                    skipNegotiation: true,
                    transport: HttpTransportType.WebSockets,
                    accessTokenFactory: () => this.authModule.getToken(),
                })
                .build();
            
            // Set up promise to capture first quote
            let quoteReceived = false;
            const quotePromise = new Promise((resolve, reject) => {
                quoteTimeout = setTimeout(() => {
                    reject(new Error('No quote received within 5 seconds'));
                }, 5000);
                
                connection.on('GatewayQuote', (id, data) => {
                    if (!quoteReceived) {
                        quoteReceived = true;
                        clearTimeout(quoteTimeout);
                        resolve(data);
                    }
                });
                
                connection.on('Error', (error) => {
                    clearTimeout(quoteTimeout);
                    reject(error);
                });
            });
            
            // Add a catch handler to prevent unhandled rejection
            quotePromise.catch(() => {
                // Ignore - this will be handled later
            });
            
            // Connect and subscribe
            await connection.start();
            console.log('✅ SignalR WebSocket connected to market hub');
            
            // Subscribe to test instrument using correct method name
            await connection.invoke('SubscribeContractQuotes', this.testInstrument);
            console.log(`📊 Subscribed to ${this.testInstrument} quotes`);
            
            try {
                // Wait for first quote
                const quote = await Promise.race([
                    quotePromise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('No quote received within 5 seconds')), 5000))
                ]);
                console.log(`✅ Live market data received via SignalR:`);
                console.log(`   Symbol: ${quote.symbol || this.testInstrument}`);
                
                // Extract price using actual field names from TopStep API
                const price = quote.lastPrice || quote.last || quote.price || quote.mark || quote.bestBid;
                console.log(`   Last Price: ${price || 'N/A'}`);
                console.log(`   Bid: ${quote.bestBid || quote.bid || 'N/A'} | Ask: ${quote.bestAsk || quote.ask || 'N/A'}`);
                console.log(`   Volume: ${quote.volume || 'N/A'}`);
                console.log(`   Change: ${quote.change || 'N/A'} (${quote.changePercent ? (quote.changePercent * 100).toFixed(2) + '%' : 'N/A'})`);
                
                if (quote.timestamp || quote.lastUpdated) {
                    const timestamp = quote.lastUpdated || quote.timestamp;
                    console.log(`   Time: ${new Date(timestamp).toLocaleString()}`);
                }
            } catch (quoteError) {
                console.log(`⚠️  Live quote test: ${quoteError.message}`);
            }
            
            // Clean up connection
            await connection.stop();
            console.log('✅ SignalR WebSocket test completed');
            
        } catch (error) {
            // Clear any pending timeout to prevent unhandled rejection
            if (quoteTimeout) {
                clearTimeout(quoteTimeout);
            }
            
            console.log(`⚠️  Live market data test warning: ${error.message}`);
            // Don't fail validation - just check token availability
            const token = this.authModule.getToken();
            if (!token) {
                throw new Error('No authentication token available for WebSocket');
            }
            console.log('✅ Authentication token available for WebSocket connections');
        }
    }
    
    async testHistoricalDataAccess() {
        try {
            console.log(`📊 Testing historical data for ${this.testInstrument}...`);
            const axios = require('axios');
            
            // Test getting 10 5-minute bars from 1 week ago using correct endpoint
            const endTime = new Date();
            const startTime = new Date(endTime.getTime() - (7 * 24 * 60 * 60 * 1000)); // 1 week ago
            
            const response = await axios.post(`${this.authModule.baseURL}/api/History/retrieveBars`, {
                contractId: this.testInstrument,
                live: false,
                startTime: startTime.toISOString(),
                endTime: endTime.toISOString(),
                unit: 2, // Minutes
                unitNumber: 5, // 5-minute bars (proven to work)
                limit: 10,
                includePartialBar: true
            }, {
                headers: this.authModule.getAuthHeaders(),
                timeout: 10000
            });
            
            if (response.data && response.data.bars && response.data.bars.length > 0) {
                console.log(`✅ Historical data available - ${response.data.bars.length} bars retrieved`);
                const latestBar = response.data.bars[response.data.bars.length - 1];
                console.log(`   Latest bar: O:${latestBar.o} H:${latestBar.h} L:${latestBar.l} C:${latestBar.c} V:${latestBar.v}`);
                console.log(`   Time: ${new Date(latestBar.t).toLocaleString()}`);
            } else {
                console.log('⚠️  No historical data found (may be outside market hours)');
            }
            
        } catch (error) {
            // Don't fail validation for historical data outside market hours
            console.log(`⚠️  Historical data test warning: ${error.message}`);
            if (error.response) {
                console.log(`   Status: ${error.response.status}`);
                console.log(`   Response: ${JSON.stringify(error.response.data, null, 2)}`);
            }
        }
    }
    
    async fetchAccountsFromTopStep(forceFresh = false) {
        try {
            // Check if we have cached accounts (valid for 5 minutes) - skip cache if forceFresh is true
            const now = Date.now();
            if (!forceFresh && this.cachedAccounts && this.lastAccountFetch && (now - this.lastAccountFetch) < 300000) {
                console.log('✅ Using cached accounts');
                return {
                    success: true,
                    accounts: this.cachedAccounts,
                    count: this.cachedAccounts.length,
                    cached: true
                };
            }
            
            // Ensure authentication is valid
            const authStatus = this.authModule.getStatus();
            console.log('🔐 Auth status check:', authStatus);
            if (!authStatus.isAuthenticated) {
                console.error('❌ Not authenticated with TopStep - auth status:', authStatus);
                throw new Error('Not authenticated with TopStep');
            }
            
            console.log('🔍 Fetching available accounts from TopStep API...');
            
            const axios = require('axios');
            const response = await axios.post(`${this.authModule.baseURL}/api/Account/search`, {
                onlyActiveAccounts: true
            }, {
                headers: this.authModule.getAuthHeaders(),
                timeout: 15000
            });
            
            if (response.data && Array.isArray(response.data.accounts)) {
                const tradableAccounts = response.data.accounts.filter(account => account.canTrade);
                
                // Cache the results
                this.cachedAccounts = tradableAccounts;
                this.lastAccountFetch = now;
                
                console.log(`✅ Found ${tradableAccounts.length} tradeable accounts`);
                return {
                    success: true,
                    accounts: tradableAccounts,
                    count: tradableAccounts.length,
                    cached: false
                };
            }
            
            return {
                success: false,
                error: 'No accounts found in response',
                accounts: []
            };
            
        } catch (error) {
            console.error('❌ Failed to fetch accounts:', error.response?.data || error.message);
            return {
                success: false,
                error: error.message,
                details: error.response?.data,
                accounts: []
            };
        }
    }
    
    /**
     * Discover active contracts by examining open positions across all accounts
     * This gives us the contracts that are currently being traded
     */
    async discoverActiveContracts() {
        try {
            console.log('📊 Discovering available contracts for market data subscription...');
            
            // PRIMARY: Get ALL available contracts from TopStep API (not just ones with positions)
            // This ensures traders get market data for all tradeable instruments
            const topStepContracts = await this.fetchContractsFromTopStep();
            
            if (topStepContracts && topStepContracts.length > 0) {
                console.log(`📊 Got ${topStepContracts.length} active contracts from TopStep API`);
                
                // Extract contract IDs from contract objects
                const contractIds = topStepContracts.map(contract => 
                    typeof contract === 'string' ? contract : contract.contractId
                );
                
                console.log(`✅ Contract discovery complete: ${contractIds.length} contracts found`);
                console.log(`📊 Contracts available for trading: ${contractIds.slice(0, 5).join(', ')}${contractIds.length > 5 ? ` (and ${contractIds.length - 5} more)` : ''}`);
                
                return contractIds;
            }
            
            // FALLBACK: If API fails, check open positions as backup
            console.warn('⚠️  TopStep contract API unavailable, falling back to position-based discovery...');
            
            // Get all accounts
            const accountsResult = await this.fetchAccountsFromTopStep();
            if (!accountsResult.success || accountsResult.accounts.length === 0) {
                console.warn('⚠️  No accounts available for contract discovery');
                return [];
            }
            
            const activeContracts = new Set();
            
            // Check open positions for each account to find active contracts (fallback only)
            for (const account of accountsResult.accounts) {
                try {
                    console.log(`🔍 Checking positions for account ${account.id}...`);
                    
                    const positionsResponse = await this.authModule.apiRequest('/api/Position/searchOpen', {
                        method: 'POST',
                        data: { accountId: account.id }
                    });
                    
                    if (positionsResponse.data?.positions?.length > 0) {
                        console.log(`📊 Account ${account.id} has ${positionsResponse.data.positions.length} open positions`);
                        
                        // Extract contract IDs from positions
                        positionsResponse.data.positions.forEach(position => {
                            if (position.contractId) {
                                activeContracts.add(position.contractId);
                                console.log(`   ✅ Found active contract: ${position.contractId}`);
                            }
                        });
                    } else {
                        console.log(`📊 Account ${account.id} has no open positions`);
                    }
                    
                } catch (error) {
                    console.error(`❌ Failed to fetch positions for account ${account.id}:`, error.message);
                    // Continue with other accounts
                }
            }
            
            const contractsArray = Array.from(activeContracts);
            console.log(`✅ Fallback contract discovery complete: ${contractsArray.length} contracts found`);
            return contractsArray;
            
        } catch (error) {
            console.error('❌ Failed to discover active contracts:', error.message);
            // Do not return any hardcoded contracts - only use what TopStep provides
            return [];
        }
    }
    
    async distributeMarketData(data) {
        try {
            // In V4 architecture, we broadcast all market data to Redis
            // Services like Manual Trading will filter what they need based on their subscriptions
            
            // Note: Change detection is already done in MarketDataService
            // This method is only called when data has actually changed
            
            // Silent operation - market data distributed without logging
            // Uncomment below for debugging:
            // if (data.type === 'QUOTE') {
            //     console.log(`📡 Distributing changed QUOTE for ${data.instrument}`);
            // } else if (data.type === 'TRADE') {
            //     console.log(`📡 Distributing TRADE for ${data.instrument}`);
            // } else if (data.type === 'DEPTH') {
            //     console.log(`📡 Distributing changed DEPTH for ${data.instrument}`);
            // }
            
            // Broadcast to Redis for all services
            // Pass the entire market data structure that includes instrument, type, and data
            await this.eventBroadcaster.publish('MARKET_DATA', data);
            
            this.metrics.messagesDistributed++;
            
        } catch (error) {
            console.error('❌ Error distributing market data:', error);
        }
    }
    
    async handleConnectionLoss() {
        console.log('⚠️  Connection lost to TopStep API');
        
        // Don't handle connection loss during shutdown
        if (this.state === 'SHUTTING_DOWN' || this.state === 'STOPPED') {
            return;
        }
        
        this.state = 'RECONNECTING';
        
        await this.broadcastConnectionStatus('CONNECTION_LOST');
        
        // All trading bots should pause
        if (this.eventBroadcaster) {
            try {
                await this.eventBroadcaster.publish('PAUSE_TRADING', {
                    reason: 'Connection lost to broker',
                    timestamp: Date.now()
                });
            } catch (error) {
                // Ignore errors during shutdown
                if (this.state !== 'SHUTTING_DOWN' && this.state !== 'STOPPED') {
                    console.error('❌ Failed to publish PAUSE_TRADING:', error);
                }
            }
        }
    }
    
    async handleReconnection() {
        console.log('✅ Reconnected to TopStep API');
        this.state = 'CONNECTED';
        this.metrics.reconnectionCount++;
        
        await this.broadcastConnectionStatus('RECONNECTED');
        
        // Request position reconciliation from all bots
        await this.eventBroadcaster.publish('RECONCILIATION_REQUIRED', {
            timestamp: Date.now()
        });
        
        // Resume trading after reconciliation delay
        setTimeout(async () => {
            console.log('▶️ Resuming trading after reconciliation');
            await this.eventBroadcaster.publish('RESUME_TRADING', {
                reason: 'Connection restored and positions reconciled',
                timestamp: Date.now()
            });
        }, 5000); // 5 second delay for reconciliation
    }
    
    async broadcastConnectionStatus(status) {
        await this.eventBroadcaster.publish('CONNECTION_STATUS', {
            status,
            timestamp: Date.now(),
            uptime: this.isRunning ? Date.now() - this.startTime : 0,
            instances: this.metrics.activeInstances
        });
    }
    
    getStatus() {
        return {
            state: this.state,
            uptime: this.isRunning ? Date.now() - this.startTime : 0,
            instances: {
                total: this.metrics.totalInstances,
                active: this.metrics.activeInstances,
                list: this.instanceRegistry ? this.instanceRegistry.getAllInstances() : []
            },
            metrics: {
                messagesDistributed: this.metrics.messagesDistributed,
                reconnectionCount: this.metrics.reconnectionCount
            },
            health: this.healthMonitor ? this.healthMonitor.getHealth() : null
        };
    }
    
    /**
     * Manual control commands for trading bot fleet
     */
    async pauseAllTrading(reason = 'Manual pause requested') {
        console.log(`⏸️  Pausing all trading: ${reason}`);
        
        await this.eventBroadcaster.publish('PAUSE_TRADING', {
            reason,
            manual: true,
            timestamp: Date.now()
        });
        
        console.log('✅ Pause trading command sent to all instances');
    }
    
    async resumeAllTrading(reason = 'Manual resume requested') {
        console.log(`▶️  Resuming all trading: ${reason}`);
        
        await this.eventBroadcaster.publish('RESUME_TRADING', {
            reason,
            manual: true,
            timestamp: Date.now()
        });
        
        console.log('✅ Resume trading command sent to all instances');
    }
    
    async shutdownAllBots(reason = 'Shutdown requested') {
        console.log(`🛑 Shutting down all bots: ${reason}`);
        
        await this.eventBroadcaster.publish('SHUTDOWN', {
            reason,
            timestamp: Date.now()
        });
        
        // Give bots time to shutdown gracefully
        console.log('⏳ Waiting 5 seconds for bots to shutdown...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        console.log('✅ Shutdown command sent to all instances');
    }
    
    async shutdown() {
        console.log('🛑 Shutting down Connection Manager...');
        
        // Set state early to prevent connection loss events during shutdown
        this.state = 'SHUTTING_DOWN';
        
        // Notify all instances
        await this.broadcastConnectionStatus('SHUTTING_DOWN');
        
        // Stop services
        if (this.healthMonitor) {
            this.healthMonitor.stop();
        }
        
        if (this.positionReconciliationService) {
            this.positionReconciliationService.stop();
        }
        
        if (this.configurationService) {
            await this.configurationService.cleanup();
        }
        
        if (this.marketDataService) {
            await this.marketDataService.disconnect();
        }
        
        if (this.eventBroadcaster) {
            await this.eventBroadcaster.disconnect();
        }
        
        // Clear auth
        if (this.authModule) {
            this.authModule.cleanup();
        }
        
        this.state = 'STOPPED';
        this.isRunning = false;
        
        console.log('✅ Connection Manager shutdown complete');
    }
    
    // Position Reconciliation Methods
    
    // Update master position (called when orders are placed/filled)
    updateMasterPosition(positionData) {
        if (this.positionReconciliationService) {
            this.positionReconciliationService.updateMasterPosition(positionData);
        }
    }
    
    // Handle position update from bot instance
    async handlePositionUpdate(data) {
        const { instanceId, position } = data;
        
        if (this.positionReconciliationService) {
            this.positionReconciliationService.updateInstancePosition(instanceId, position);
        }
        
        // Broadcast to other instances if needed
        await this.eventBroadcaster.publish('POSITION_UPDATE', {
            instanceId,
            position,
            timestamp: Date.now()
        });
    }
    
    // Force reconciliation for specific position
    async forcePositionReconciliation(orderId, reason = 'Manual request') {
        if (!this.positionReconciliationService) {
            return { success: false, error: 'Position reconciliation service not available' };
        }
        
        try {
            const result = await this.positionReconciliationService.forceReconciliation(orderId, reason);
            return { success: true, result };
        } catch (error) {
            console.error('❌ Force reconciliation failed:', error);
            return { success: false, error: error.message };
        }
    }
    
    // Get position reconciliation status
    getPositionReconciliationStatus() {
        if (!this.positionReconciliationService) {
            return { available: false, message: 'Position reconciliation service not available' };
        }
        
        return {
            available: true,
            status: this.positionReconciliationService.getHealthStatus(),
            stats: this.positionReconciliationService.getReconciliationStats()
        };
    }
    
    // Get specific position status
    getPositionStatus(orderId) {
        if (!this.positionReconciliationService) {
            return { available: false, message: 'Position reconciliation service not available' };
        }
        
        return this.positionReconciliationService.getPositionStatus(orderId);
    }
    
    // Calculate SL/TP prices from points based on fill price
    calculateSLTPFromPoints(fillPrice, side, stopLossPoints, takeProfitPoints) {
        // Validate fill price
        if (!fillPrice || isNaN(fillPrice) || fillPrice <= 0) {
            throw new Error(`Invalid fill price for SL/TP calculation: ${fillPrice}`);
        }

        // Validate points values when they are provided
        if (stopLossPoints !== null && stopLossPoints !== undefined) {
            if (isNaN(stopLossPoints) || stopLossPoints < 0) {
                throw new Error(`Invalid points values for SL/TP calculation: stopLossPoints=${stopLossPoints}`);
            }
        }

        if (takeProfitPoints !== null && takeProfitPoints !== undefined) {
            if (isNaN(takeProfitPoints) || takeProfitPoints < 0) {
                throw new Error(`Invalid points values for SL/TP calculation: takeProfitPoints=${takeProfitPoints}`);
            }
        }

        const result = {};
        
        if (stopLossPoints !== null && stopLossPoints !== undefined) {
            if (side === 'BUY') {
                // For BUY orders: SL is below fill price
                result.stopLoss = fillPrice - stopLossPoints;
            } else {
                // For SELL orders: SL is above fill price
                result.stopLoss = fillPrice + stopLossPoints;
            }
        }
        
        if (takeProfitPoints !== null && takeProfitPoints !== undefined) {
            if (side === 'BUY') {
                // For BUY orders: TP is above fill price
                result.takeProfit = fillPrice + takeProfitPoints;
            } else {
                // For SELL orders: TP is below fill price
                result.takeProfit = fillPrice - takeProfitPoints;
            }
        }
        
        return result;
    }
    
    // Check if order has filled and apply bracket orders
    async checkAndApplyBracketOrders(topStepOrderId) {
        console.log(`📋 [BRACKET] Checking position status for order ${topStepOrderId}`);
        
        const bracketInfo = this.pendingBrackets.get(topStepOrderId.toString());
        if (!bracketInfo) {
            console.log(`📋 [BRACKET] No pending bracket orders found for ${topStepOrderId}`);
            return;
        }
        
        try {
            // Query positions to find the one with this order ID
            const axios = require('axios');
            
            console.log(`📋 [BRACKET] Making position search request:`, {
                url: `https://userapi.topstepx.com/Position?accountId=${bracketInfo.accountId}`,
                method: 'GET',
                accountId: bracketInfo.accountId,
                headers: this.authModule.getAuthHeaders()
            });
            
            // Use the same endpoint as the working position fetching system
            const response = await axios.get(
                `https://userapi.topstepx.com/Position?accountId=${bracketInfo.accountId}`,
                {
                    headers: this.authModule.getAuthHeaders(),
                    timeout: 10000
                }
            );
            
            console.log(`📋 [BRACKET] Position search response:`, {
                status: response.status,
                dataType: typeof response.data,
                isArray: Array.isArray(response.data),
                dataLength: Array.isArray(response.data) ? response.data.length : 'N/A'
            });
            
            // Check for positions in the response (userapi returns array directly)
            const positions = response.data;
            
            if (!positions || !Array.isArray(positions) || positions.length === 0) {
                console.log(`📋 [BRACKET] No positions found - order may still be pending`);
                console.log(`📋 [BRACKET] Raw response data:`, response.data);
                // Retry once more after another delay
                setTimeout(async () => {
                    await this.retryBracketOrderCheck(topStepOrderId);
                }, 2000);
                return;
            }
            
            console.log(`📋 [BRACKET] Found ${positions.length} positions`);
            
            // Log all positions for debugging
            positions.forEach((pos, index) => {
                console.log(`📋 [BRACKET] Position ${index + 1}:`, {
                    id: pos.id,
                    openOrderId: pos.openOrderId,
                    orderId: pos.orderId,
                    contractId: pos.contractId,
                    instrument: pos.instrument,
                    symbol: pos.symbol,
                    side: pos.side,
                    quantity: pos.quantity,
                    openTime: pos.openTime || pos.createdTime || pos.timestamp,
                    // Log all fields to see what's available
                    allFields: Object.keys(pos)
                });
            });
            
            // Since positions don't contain order ID, we'll use the most recent position
            // that matches our instrument and was created recently
            const now = Date.now();
            
            // Convert instrument to contractId for proper matching (MGC -> CON.F.US.MGC.Z25)
            const expectedContractId = await this.getContractIdForInstrument(bracketInfo.instrument);
            
            const recentPositions = positions.filter(pos => {
                // Check if position matches our instrument (using contractId)
                const matchesInstrument = pos.contractId === expectedContractId;
                
                // Check if position was created recently (within last 30 seconds)
                // Note: userapi returns 'entryTime' instead of 'creationTimestamp'
                const createdTime = pos.entryTime ? new Date(pos.entryTime).getTime() : 
                                   pos.creationTimestamp ? new Date(pos.creationTimestamp).getTime() : 0;
                const isRecent = (now - createdTime) < 30000;
                
                console.log(`📋 [BRACKET] Checking position ${pos.id}:`, {
                    contractId: pos.contractId,
                    matchesInstrument,
                    entryTime: pos.entryTime,
                    creationTimestamp: pos.creationTimestamp,
                    isRecent,
                    timeDiff: now - createdTime
                });
                
                return matchesInstrument && isRecent;
            });
            
            if (recentPositions.length === 0) {
                console.log(`📋 [BRACKET] No recent positions found for ${bracketInfo.instrument} - may still be pending`);
                // Retry once more
                setTimeout(async () => {
                    await this.retryBracketOrderCheck(topStepOrderId);
                }, 2000);
                return;
            }
            
            // Use the most recent position
            const position = recentPositions.sort((a, b) => {
                const timeA = new Date(a.creationTimestamp || 0).getTime();
                const timeB = new Date(b.creationTimestamp || 0).getTime();
                return timeB - timeA; // Sort descending (newest first)
            })[0];
            
            console.log(`📋 [BRACKET] ✅ FOUND POSITION!`, {
                positionId: position.id,
                openOrderId: position.openOrderId,
                orderId: position.orderId,
                contractId: position.contractId,
                side: position.side,
                quantity: position.quantity
            });
            
            // Apply SL/TP using the position ID with fill-based calculation
            let finalStopLoss = null;
            let finalTakeProfit = null;
            
            if (bracketInfo.stopLossPoints || bracketInfo.takeProfitPoints) {
                // New mode: calculate from fill price
                console.log(`📋 [FILL-BASED] Calculating SL/TP from fill price`);
                console.log(`   - Fill Price: ${position.averagePrice}`);
                console.log(`   - Side: ${bracketInfo.side}`);
                console.log(`   - Stop Loss Points: ${bracketInfo.stopLossPoints || 'none'}`);
                console.log(`   - Take Profit Points: ${bracketInfo.takeProfitPoints || 'none'}`);
                
                const calculated = this.calculateSLTPFromPoints(
                    position.averagePrice,
                    bracketInfo.side,
                    bracketInfo.stopLossPoints,
                    bracketInfo.takeProfitPoints
                );
                
                finalStopLoss = calculated.stopLoss;
                finalTakeProfit = calculated.takeProfit;
                
                console.log(`📋 [FILL-BASED] Calculated SL/TP:`);
                console.log(`   - Stop Loss: ${finalStopLoss ? `$${finalStopLoss.toFixed(2)}` : 'none'}`);
                console.log(`   - Take Profit: ${finalTakeProfit ? `$${finalTakeProfit.toFixed(2)}` : 'none'}`);
                
            } else if (bracketInfo.stopLoss || bracketInfo.takeProfit) {
                // Legacy mode: use pre-calculated prices
                console.log(`📋 [PRICE-BASED] Using pre-calculated SL/TP`);
                finalStopLoss = bracketInfo.stopLoss;
                finalTakeProfit = bracketInfo.takeProfit;
                
                console.log(`📋 [PRICE-BASED] SL/TP values:`);
                console.log(`   - Stop Loss: ${finalStopLoss ? `$${finalStopLoss.toFixed(2)}` : 'none'}`);
                console.log(`   - Take Profit: ${finalTakeProfit ? `$${finalTakeProfit.toFixed(2)}` : 'none'}`);
            }
            
            if (finalStopLoss !== null || finalTakeProfit !== null) {
                console.log(`📋 [BRACKET] Applying SL/TP to position ${position.id}`);
                console.log(`   - Position ID: ${position.id}`);
                console.log(`   - Using endpoint: https://api.topstepx.com/api/Order/editStopLossAccount`);
                
                const updateResult = await this.updatePositionSLTP(
                    position.id, 
                    finalStopLoss, 
                    finalTakeProfit
                );
                
                if (updateResult.success) {
                    console.log(`✅ [BRACKET] Successfully applied SL/TP to position ${position.id}`);
                    
                    // Notify the originating instance
                    await this.eventBroadcaster.publish('BRACKET_ORDER_COMPLETE', {
                        instanceId: bracketInfo.instanceId,
                        orderId: bracketInfo.orderId,
                        positionId: position.id,
                        stopLoss: finalStopLoss,
                        takeProfit: finalTakeProfit,
                        success: true,
                        timestamp: Date.now()
                    });
                } else {
                    console.error(`❌ [BRACKET] Failed to apply SL/TP: ${updateResult.error}`);
                    
                    // Notify failure
                    await this.eventBroadcaster.publish('BRACKET_ORDER_COMPLETE', {
                        instanceId: bracketInfo.instanceId,
                        orderId: bracketInfo.orderId,
                        success: false,
                        error: updateResult.error,
                        timestamp: Date.now()
                    });
                }
            }
            
            // Clean up
            this.cleanupPendingBracket(topStepOrderId);
            
        } catch (error) {
            console.error(`❌ [BRACKET] Error checking position: ${error.message}`);
            if (error.response) {
                console.error(`❌ [BRACKET] Error details:`, {
                    status: error.response.status,
                    statusText: error.response.statusText,
                    data: error.response.data,
                    headers: error.response.headers
                });
            }
            // Retry once more
            setTimeout(async () => {
                await this.retryBracketOrderCheck(topStepOrderId);
            }, 2000);
        }
    }
    
    // Retry bracket order check with exponential backoff
    async retryBracketOrderCheck(topStepOrderId) {
        const bracketInfo = this.pendingBrackets.get(topStepOrderId.toString());
        if (!bracketInfo) {
            return; // Already processed
        }
        
        // Increment retry count
        bracketInfo.retryCount = (bracketInfo.retryCount || 0) + 1;
        
        console.log(`📋 [BRACKET] Retry ${bracketInfo.retryCount}/${bracketInfo.maxRetries} for order ${topStepOrderId}`);
        
        // Check if we've exceeded max retries
        if (bracketInfo.retryCount >= bracketInfo.maxRetries) {
            console.error(`❌ [BRACKET] Max retries exceeded for order ${topStepOrderId}`);
            
            // Notify failure
            await this.eventBroadcaster.publish('BRACKET_ORDER_COMPLETE', {
                instanceId: bracketInfo.instanceId,
                orderId: bracketInfo.orderId,
                success: false,
                error: `Failed to find position after ${bracketInfo.maxRetries} retries`,
                timestamp: Date.now()
            });
            
            // Clean up
            this.cleanupPendingBracket(topStepOrderId);
            return;
        }
        
        try {
            const axios = require('axios');
            
            // Skip order status check since TopStep Order API endpoints are inconsistent
            // Instead, rely on position checking to determine if order has filled
            console.log(`📋 [BRACKET] Checking positions for filled order ${topStepOrderId}...`);
            
            // Now check for positions using same endpoint as working position queries
            const response = await axios.get(
                `https://userapi.topstepx.com/Position?accountId=${bracketInfo.accountId}`,
                {
                    headers: this.authModule.getAuthHeaders(),
                    timeout: 10000
                }
            );
            
            // Check for positions in the response (userapi returns array directly)
            const positions = response.data;
            
            if (!positions || !Array.isArray(positions) || positions.length === 0) {
                throw new Error('No positions found after retry');
            }
            
            console.log(`📋 [BRACKET] Found ${positions.length} open positions`);
            
            // Log all positions for debugging
            positions.forEach((pos, index) => {
                console.log(`📋 [BRACKET] Position ${index + 1}:`, {
                    id: pos.id,
                    openOrderId: pos.openOrderId,
                    orderId: pos.orderId,
                    contractId: pos.contractId,
                    instrument: pos.instrument,
                    side: pos.side,
                    quantity: pos.quantity,
                    openTime: pos.openTime || pos.createdTime || pos.timestamp
                });
            });
            
            // Convert instrument to contractId for proper matching (MGC -> CON.F.US.MGC.Z25)
            const expectedContractId = await this.getContractIdForInstrument(bracketInfo.instrument);
            
            // Look for position by order ID or by matching instrument and recent creation
            const position = positions.find(pos => {
                // Direct order ID match
                if (pos.openOrderId === topStepOrderId || 
                    pos.orderId === topStepOrderId ||
                    pos.id === topStepOrderId) {
                    console.log(`📋 [BRACKET] Found position by order ID match`);
                    return true;
                }
                
                // Match by instrument and recent creation (within last 60 seconds + retry time)
                // Note: expectedContractId should be calculated outside this callback
                if (pos.contractId === expectedContractId) {
                    const posTime = new Date(pos.creationTimestamp || pos.openTime || pos.createdTime || pos.timestamp).getTime();
                    const orderTime = Date.now() - (60000 + (bracketInfo.retryCount * 5000)); // Adjust for retry time
                    if (posTime > orderTime) {
                        console.log(`📋 [BRACKET] Found potential position by instrument and time (${bracketInfo.instrument} -> ${expectedContractId})`);
                        return true;
                    }
                }
                
                return false;
            });
            
            if (!position) {
                throw new Error(`Position not found for order ${topStepOrderId} after retry`);
            }
            
            // Apply SL/TP with fill-based calculation
            let finalStopLoss = null;
            let finalTakeProfit = null;
            
            if (bracketInfo.stopLossPoints || bracketInfo.takeProfitPoints) {
                // New mode: calculate from fill price
                console.log(`📋 [FILL-BASED-RETRY] Calculating SL/TP from fill price`);
                console.log(`   - Fill Price: ${position.averagePrice}`);
                console.log(`   - Side: ${bracketInfo.side}`);
                
                const calculated = this.calculateSLTPFromPoints(
                    position.averagePrice,
                    bracketInfo.side,
                    bracketInfo.stopLossPoints,
                    bracketInfo.takeProfitPoints
                );
                
                finalStopLoss = calculated.stopLoss;
                finalTakeProfit = calculated.takeProfit;
                
            } else if (bracketInfo.stopLoss || bracketInfo.takeProfit) {
                // Legacy mode: use pre-calculated prices
                console.log(`📋 [PRICE-BASED-RETRY] Using pre-calculated SL/TP`);
                finalStopLoss = bracketInfo.stopLoss;
                finalTakeProfit = bracketInfo.takeProfit;
            }
            
            if (finalStopLoss !== null || finalTakeProfit !== null) {
                const updateResult = await this.updatePositionSLTP(
                    position.id, 
                    finalStopLoss, 
                    finalTakeProfit
                );
                
                if (updateResult.success) {
                    console.log(`✅ [BRACKET] Successfully applied SL/TP on retry`);
                } else {
                    console.error(`❌ [BRACKET] Failed to apply SL/TP on retry: ${updateResult.error}`);
                }
                
                // Notify result
                await this.eventBroadcaster.publish('BRACKET_ORDER_COMPLETE', {
                    instanceId: bracketInfo.instanceId,
                    orderId: bracketInfo.orderId,
                    positionId: position ? position.id : null,
                    stopLoss: finalStopLoss,
                    takeProfit: finalTakeProfit,
                    success: updateResult.success,
                    error: updateResult.error,
                    timestamp: Date.now()
                });
            }
            
            // Clean up
            this.cleanupPendingBracket(topStepOrderId);
            
        } catch (error) {
            console.error(`❌ [BRACKET] Failed after retry: ${error.message}`);
            
            // Notify failure
            await this.eventBroadcaster.publish('BRACKET_ORDER_COMPLETE', {
                instanceId: bracketInfo.instanceId,
                orderId: bracketInfo.orderId,
                success: false,
                error: `Failed to find position after retries: ${error.message}`,
                timestamp: Date.now()
            });
            
            // Clean up
            this.cleanupPendingBracket(topStepOrderId);
        }
    }
    
    // Clean up pending bracket order and its timeout
    cleanupPendingBracket(orderId) {
        const bracketInfo = this.pendingBrackets.get(orderId.toString());
        if (bracketInfo) {
            if (bracketInfo.fallbackTimeout) {
                clearTimeout(bracketInfo.fallbackTimeout);
                console.log(`🧹 [BRACKET] Cleared fallback timeout for order ${orderId}`);
            }
            this.pendingBrackets.delete(orderId.toString());
            console.log(`🧹 [BRACKET] Cleaned up pending bracket for order ${orderId}`);
        }
    }
    
    // Update position SL/TP
    async updatePositionSLTP(positionId, stopLoss, takeProfit) {
        try {
            const axios = require('axios');
            const payload = {
                positionId: positionId,
                stopLoss: stopLoss ? Math.round(stopLoss * 100) / 100 : null,
                takeProfit: takeProfit ? Math.round(takeProfit * 100) / 100 : null
            };
            
            console.log(`📋 [BRACKET] Sending SL/TP update request:`, {
                url: 'https://userapi.topstepx.com/Order/editStopLossAccount',
                method: 'POST',
                payload: payload,
                headers: this.authModule.getAuthHeaders()
            });
            
            const response = await axios.post(
                `https://userapi.topstepx.com/Order/editStopLossAccount`,
                payload,
                {
                    headers: this.authModule.getAuthHeaders(),
                    timeout: 10000
                }
            );
            
            console.log(`✅ [BRACKET] SL/TP update successful!`);
            console.log(`   - Response status: ${response.status}`);
            console.log(`   - Response data:`, response.data);
            console.log(`   - Stop Loss: ${stopLoss || 'none'} | Take Profit: ${takeProfit || 'none'}`);
            console.log(`   - Position ID: ${positionId}`);
            
            return { success: true, response: response.data };
            
        } catch (error) {
            console.error(`[❌ ERROR SL/TP]`, error.message);
            if (error.response) {
                console.error(`[❌ DETAIL]`, error.response.data);
            }
            return { 
                success: false, 
                error: error.response?.data?.message || error.message 
            };
        }
    }
    
    // Handle reconciliation request from bot instance
    async handleReconciliationRequest(data) {
        const { instanceId, orderId, reason } = data;
        
        console.log(`🔄 Reconciliation requested by ${instanceId} for position ${orderId}: ${reason}`);
        
        if (!this.positionReconciliationService) {
            await this.eventBroadcaster.send(instanceId, 'RECONCILIATION_RESPONSE', {
                orderId,
                success: false,
                error: 'Position reconciliation service not available'
            });
            return;
        }
        
        try {
            const result = await this.positionReconciliationService.forceReconciliation(orderId, reason);
            const positionStatus = this.positionReconciliationService.getPositionStatus(orderId);
            
            // Send response back to requesting instance
            await this.eventBroadcaster.send(instanceId, 'RECONCILIATION_RESPONSE', {
                orderId,
                success: true,
                result,
                positionStatus
            });
            
        } catch (error) {
            console.error('❌ Reconciliation request failed:', error);
            
            await this.eventBroadcaster.send(instanceId, 'RECONCILIATION_RESPONSE', {
                orderId,
                success: false,
                error: error.message
            });
        }
    }
    
    async handleAccountBalanceRequest(data) {
        try {
            const { accountId, requestId, instanceId } = data;
            console.log(`💰 Account balance request from ${instanceId} for account ${accountId}`);
            
            // Get fresh account data
            let accounts = this.cachedAccounts;
            if (!accounts || accounts.length === 0) {
                // Try to fetch fresh accounts if not cached
                try {
                    const accountsResult = await this.authModule.fetchUserAccounts();
                    accounts = accountsResult.accounts || [];
                    this.cachedAccounts = accounts;
                } catch (error) {
                    console.error('❌ Failed to fetch accounts:', error);
                    accounts = [];
                }
            }
            
            const account = accounts.find(acc => String(acc.id) === String(accountId));
            
            if (account) {
                await this.eventBroadcaster.publish('ACCOUNT_BALANCE_RESPONSE', {
                    instanceId,
                    requestId,
                    success: true,
                    accountId,
                    balance: account.balance,
                    currency: account.currency || 'USD',
                    canTrade: account.canTrade
                });
                console.log(`✅ Sent balance response for account ${accountId}: $${account.balance}`);
            } else {
                await this.eventBroadcaster.publish('ACCOUNT_BALANCE_RESPONSE', {
                    instanceId,
                    requestId,
                    success: false,
                    accountId,
                    error: 'Account not found'
                });
                console.log(`❌ Account ${accountId} not found in cached accounts`);
            }
        } catch (error) {
            console.error('❌ Error handling account balance request:', error);
            if (data.requestId) {
                await this.eventBroadcaster.publish('ACCOUNT_BALANCE_RESPONSE', {
                    instanceId: data.instanceId,
                    requestId: data.requestId,
                    success: false,
                    error: error.message
                });
            }
        }
    }
    
    async handleAuthStatusRequest(data) {
        try {
            const { instanceId, requestId } = data;
            console.log(`🔐 Auth status request from ${instanceId}`);
            
            // Get current auth status from auth module
            const authStatus = this.authModule.getStatus();
            
            // Prepare auth status response
            const authData = {
                isAuthenticated: authStatus.isAuthenticated,
                tokens: authStatus.isAuthenticated ? {
                    // Only send what's needed, not the actual token
                    hasToken: true,
                    expiresAt: authStatus.tokenExpiry
                } : null,
                expiresAt: authStatus.tokenExpiry,
                lastAuthTime: authStatus.tokenExpiry ? authStatus.tokenExpiry - this.authModule.tokenExpiryDuration : null
            };
            
            // Send auth status response
            await this.eventBroadcaster.publish('AUTH_UPDATE', {
                instanceId,
                requestId,
                authStatus: authData,
                success: true
            });
            
            console.log(`✅ Sent auth status to ${instanceId}: ${authStatus.isAuthenticated ? 'authenticated' : 'not authenticated'}`);
            
        } catch (error) {
            console.error('❌ Error handling auth status request:', error);
            if (data.requestId && data.instanceId) {
                await this.eventBroadcaster.publish('AUTH_UPDATE', {
                    instanceId: data.instanceId,
                    requestId: data.requestId,
                    success: false,
                    error: error.message,
                    authStatus: {
                        isAuthenticated: false
                    }
                });
            }
        }
    }
    
    async handleHistoricalDataRequest(data) {
        try {
            const { instanceId, requestId, instrument, interval, periodMinutes, startTime, endTime, unit, unitNumber, limit, includePartialBar } = data;
            console.log(`📊 Historical data request from ${instanceId} for ${instrument}`);
            console.log(`   Request ID: ${requestId}`);
            console.log(`   Parameters received:`, { interval, periodMinutes, unit, unitNumber, limit, startTime, endTime });
            
            // Validate request parameters
            if (!instrument) {
                console.error('❌ Missing instrument in historical data request');
                await this.eventBroadcaster.publish('HISTORICAL_DATA_RESPONSE', {
                    instanceId,
                    requestId,
                    success: false,
                    error: 'Missing instrument parameter'
                });
                return;
            }
            
            // Use direct parameters if provided, otherwise convert from interval/periodMinutes
            let topStepParams;
            if (unit !== undefined && unitNumber !== undefined) {
                // Use direct TopStep format parameters
                topStepParams = {
                    unit,
                    unitNumber,
                    limit: limit || 500,
                    includePartialBar: includePartialBar !== undefined ? includePartialBar : true
                };
                
                // Add time range if provided
                if (startTime) {
                    topStepParams.startTime = startTime;
                }
                if (endTime) {
                    topStepParams.endTime = endTime;
                }
                
                console.log(`📊 Using direct TopStep parameters:`, topStepParams);
            } else {
                // Convert from legacy interval/periodMinutes format
                topStepParams = this.convertToTopStepParams(interval, periodMinutes, startTime, endTime);
                console.log(`📊 Converted parameters:`, topStepParams);
            }
            
            // Prepare request data for HistoricalDataService
            const serviceRequestData = {
                requestId,
                instanceId,
                contractId: instrument,
                ...topStepParams
            };
            
            // Forward to HistoricalDataService
            await this.historicalDataService.handleHistoricalDataRequest(serviceRequestData);
            
        } catch (error) {
            console.error('❌ Error handling historical data request:', error);
            if (data.requestId && data.instanceId) {
                await this.eventBroadcaster.publish('HISTORICAL_DATA_RESPONSE', {
                    instanceId: data.instanceId,
                    requestId: data.requestId,
                    success: false,
                    error: error.message
                });
            }
        }
    }
    
    convertToTopStepParams(interval, periodMinutes, startTime, endTime) {
        // Convert interval and period to TopStep API format
        let unit, unitNumber;
        
        switch (interval) {
            case 'minute':
            case 'minutes':
                unit = 2; // Minutes
                unitNumber = periodMinutes || 1;
                break;
            case 'hour':
            case 'hours':
                unit = 3; // Hours
                unitNumber = Math.floor((periodMinutes || 60) / 60);
                break;
            case 'day':
            case 'daily':
                unit = 4; // Daily
                unitNumber = 1;
                break;
            default:
                unit = 2; // Default to minutes
                unitNumber = periodMinutes || 1;
        }
        
        const params = {
            unit,
            unitNumber,
            limit: 500, // Default limit
            includePartialBar: true
        };
        
        // Add time range if provided
        if (startTime) {
            params.startTime = startTime;
        }
        if (endTime) {
            params.endTime = endTime;
        }
        
        return params;
    }
    
    // Order Placement Methods
    
    validateOrderRequest(data) {
        const { orderType, instrument, side, quantity, price, stopPrice, limitPrice, accountId } = data;
        
        // Check required fields
        if (!orderType || !instrument || !side || !quantity || !accountId) {
            return { valid: false, reason: 'Missing required fields' };
        }
        
        // Validate order type
        if (!['MARKET', 'LIMIT', 'STOP'].includes(orderType)) {
            return { valid: false, reason: `Invalid order type: ${orderType}` };
        }
        
        // Validate side
        if (!['BUY', 'SELL'].includes(side)) {
            return { valid: false, reason: `Invalid side: ${side}` };
        }
        
        // Validate quantity
        if (!Number.isInteger(quantity) || quantity <= 0) {
            return { valid: false, reason: `Invalid quantity: ${quantity}` };
        }
        
        // Validate price for limit orders (accept either price or limitPrice)
        if (orderType === 'LIMIT') {
            const orderPrice = limitPrice || price;
            if (!orderPrice || orderPrice <= 0) {
                return { valid: false, reason: 'Limit order requires valid limitPrice or price' };
            }
        }
        
        // Validate stop price for stop orders
        if (orderType === 'STOP' && (!stopPrice || stopPrice <= 0)) {
            return { valid: false, reason: 'Stop order requires valid stop price' };
        }
        
        // Validate account exists
        if (this.cachedAccounts && !this.cachedAccounts.some(acc => acc.id === accountId)) {
            return { valid: false, reason: `Invalid account ID: ${accountId}` };
        }
        
        return { valid: true };
    }
    
    /**
     * Get contract ID for instrument symbol (e.g., MGC -> CON.F.US.MGC.Z25)
     */
    async getContractIdForInstrument(instrument) {
        // Check if we have cached mapping
        if (this.contractCache.has(instrument)) {
            return this.contractCache.get(instrument);
        }
        
        // If not cached, refresh from TopStep API
        console.log(`🔍 Contract not cached for ${instrument}, fetching from TopStep API...`);
        const contracts = await this.fetchContractsFromTopStep();
        
        if (contracts && contracts.length > 0) {
            // Update cache with symbol -> contract mappings
            for (const contract of contracts) {
                const contractId = typeof contract === 'string' ? contract : contract.contractId;
                if (contractId && contractId.includes('.')) {
                    // Extract symbol from contract ID (e.g., CON.F.US.MGC.Z25 -> MGC)
                    const parts = contractId.split('.');
                    if (parts.length >= 4) {
                        const symbol = parts[3];
                        this.contractCache.set(symbol, contractId);
                        console.log(`📋 Cached contract mapping: ${symbol} -> ${contractId}`);
                    }
                }
            }
            
            // Return the requested contract if found
            return this.contractCache.get(instrument) || null;
        }
        
        console.error(`❌ Failed to find contract for instrument: ${instrument}`);
        return null;
    }
    
    async placeMarketOrder(orderData) {
        try {
            const axios = require('axios');
            const { accountId, instrument, side, quantity } = orderData;
            
            // Convert instrument symbol to contract ID (e.g., MGC -> CON.F.US.MGC.Z25)
            const contractId = await this.getContractIdForInstrument(instrument);
            if (!contractId) {
                throw new Error(`Contract not found for instrument: ${instrument}`);
            }
            
            // Convert side to TopStep format (0 = BUY, 1 = SELL)
            const sideInt = side === 'BUY' ? 0 : 1;
            
            const topStepOrderData = {
                accountId: accountId,
                contractId: contractId,  // Use mapped contract ID instead of symbol
                type: 2, // Market order
                side: sideInt,
                size: quantity,
                limitPrice: null,
                stopPrice: null,
                trailPrice: null,
                customTag: null,
                linkedOrderId: null
            };
            
            console.log(`🔍 Sending market order to TopStep API...`);
            
            const response = await axios.post(
                `${this.authModule.baseURL}/api/Order/place`,
                topStepOrderData,
                {
                    headers: this.authModule.getAuthHeaders(),
                    timeout: 15000
                }
            );
            
            if (response.data && response.data.orderId) {
                return {
                    success: true,
                    topStepOrderId: response.data.orderId,
                    response: response.data
                };
            } else {
                throw new Error('Invalid response from order placement API');
            }
            
        } catch (error) {
            console.error('❌ Market order placement failed:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.message || error.message,
                details: error.response?.data
            };
        }
    }
    
    async placeLimitOrder(orderData) {
        try {
            const axios = require('axios');
            const { accountId, instrument, side, quantity, price, limitPrice } = orderData;
            
            // Convert side to TopStep format
            const sideInt = side === 'BUY' ? 0 : 1;
            
            // Use limitPrice if provided, otherwise fall back to price
            const orderPrice = limitPrice || price;
            
            // Round price to valid tick size
            const adjustedPrice = await this.roundToTickSize(orderPrice, instrument);
            
            // Convert instrument symbol to contract ID
            const contractId = await this.getContractIdForInstrument(instrument);
            if (!contractId) {
                throw new Error(`Contract not found for instrument: ${instrument}`);
            }
            
            const topStepOrderData = {
                accountId: accountId,
                contractId: contractId,
                type: 1, // Limit order
                side: sideInt,
                size: quantity,
                limitPrice: adjustedPrice,
                stopPrice: null,
                trailPrice: null,
                customTag: null,
                linkedOrderId: null
            };
            
            console.log(`🔍 Sending limit order to TopStep API...`);
            if (adjustedPrice !== orderPrice) {
                console.log(`   Price adjusted for tick size: ${orderPrice} → ${adjustedPrice}`);
            }
            
            const response = await axios.post(
                `${this.authModule.baseURL}/api/Order/place`,
                topStepOrderData,
                {
                    headers: this.authModule.getAuthHeaders(),
                    timeout: 15000
                }
            );
            
            if (response.data && response.data.orderId) {
                return {
                    success: true,
                    topStepOrderId: response.data.orderId,
                    response: response.data
                };
            } else {
                throw new Error('Invalid response from order placement API');
            }
            
        } catch (error) {
            console.error('❌ Limit order placement failed:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.message || error.message,
                details: error.response?.data
            };
        }
    }
    
    async placeStopOrder(orderData) {
        try {
            const axios = require('axios');
            const { accountId, instrument, side, quantity, stopPrice } = orderData;
            
            // Convert side to TopStep format
            const sideInt = side === 'BUY' ? 0 : 1;
            
            // Round stop price to valid tick size
            const adjustedStopPrice = await this.roundToTickSize(stopPrice, instrument);
            
            // Convert instrument symbol to contract ID
            const contractId = await this.getContractIdForInstrument(instrument);
            if (!contractId) {
                throw new Error(`Contract not found for instrument: ${instrument}`);
            }
            
            const topStepOrderData = {
                accountId: accountId,
                contractId: contractId,
                type: 4, // Stop order
                side: sideInt,
                size: quantity,
                limitPrice: null,
                stopPrice: adjustedStopPrice,
                trailPrice: null,
                customTag: null,
                linkedOrderId: null
            };
            
            console.log(`🔍 Sending stop order to TopStep API...`);
            if (adjustedStopPrice !== stopPrice) {
                console.log(`   Stop price adjusted for tick size: ${stopPrice} → ${adjustedStopPrice}`);
            }
            
            const response = await axios.post(
                `${this.authModule.baseURL}/api/Order/place`,
                topStepOrderData,
                {
                    headers: this.authModule.getAuthHeaders(),
                    timeout: 15000
                }
            );
            
            if (response.data && response.data.orderId) {
                return {
                    success: true,
                    topStepOrderId: response.data.orderId,
                    response: response.data
                };
            } else {
                throw new Error('Invalid response from order placement API');
            }
            
        } catch (error) {
            console.error('❌ Stop order placement failed:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.message || error.message,
                details: error.response?.data
            };
        }
    }
    
    async sendOrderResponse(instanceId, orderId, success, error = null, topStepOrderId = null) {
        const responseData = {
            instanceId,
            orderId,
            success,
            error,
            topStepOrderId,
            timestamp: Date.now()
        };
        
        console.log(`📤 Sending ORDER_RESPONSE:`, responseData);
        console.log(`   - To channel: order:management`);
        console.log(`   - InstanceId: ${instanceId}`);
        console.log(`   - OrderId: ${orderId}`);
        console.log(`   - Success: ${success}`);
        console.log(`   - TopStepOrderId: ${topStepOrderId}`);
        
        await this.eventBroadcaster.publish('ORDER_RESPONSE', responseData);
        
        console.log(`✅ ORDER_RESPONSE published to order:management channel`);
    }
    
    // Price rounding for tick size compliance
    async roundToTickSize(price, contractId) {
        let tickSize = 0.01; // Default to 1 cent
        
        try {
            // Try to get tick size from cached contract data
            const cachedContract = this.getCachedContract(contractId);
            if (cachedContract && cachedContract.tickSize) {
                tickSize = parseFloat(cachedContract.tickSize);
            } else {
                // Fetch contract details from API if not cached
                const contractResult = await this.getActiveContracts();
                if (contractResult.success && contractResult.contracts) {
                    const contract = contractResult.contracts.find(c => c.id === contractId);
                    if (contract && contract.tickSize) {
                        tickSize = parseFloat(contract.tickSize);
                        // Cache it for future use
                        this.cacheContract({
                            contractId: contract.id,
                            tickSize: contract.tickSize,
                            tickValue: contract.tickValue,
                            name: contract.name
                        });
                    }
                }
            }
        } catch (error) {
            console.warn(`⚠️ Failed to get tick size for ${contractId}, using default: ${error.message}`);
        }
        
        const rounded = Math.round(price / tickSize) * tickSize;
        return parseFloat(rounded.toFixed(tickSize < 0.01 ? 4 : 2));
    }
    
    // Order Cancellation
    async handleOrderCancellation(data) {
        try {
            const { instanceId, orderId, topStepOrderId } = data;
            
            console.log(`🚫 Order cancellation request from instance ${instanceId}`);
            console.log(`   Order ID: ${orderId}`);
            console.log(`   TopStep Order ID: ${topStepOrderId || 'Not provided'}`);
            
            if (!topStepOrderId) {
                await this.sendOrderCancellationResponse(instanceId, orderId, false, 'TopStep order ID required');
                return;
            }
            
            const axios = require('axios');
            const response = await axios.post(
                `${this.authModule.baseURL}/api/Order/cancel`,
                { orderId: topStepOrderId },
                {
                    headers: this.authModule.getAuthHeaders(),
                    timeout: 15000
                }
            );
            
            if (response.data && response.data.success) {
                console.log(`✅ Order ${orderId} cancelled successfully`);
                await this.sendOrderCancellationResponse(instanceId, orderId, true);
            } else {
                throw new Error('Order cancellation API returned failure');
            }
            
        } catch (error) {
            console.error('❌ Order cancellation failed:', error.response?.data || error.message);
            await this.sendOrderCancellationResponse(
                data.instanceId,
                data.orderId,
                false,
                error.response?.data?.message || error.message
            );
        }
    }
    
    async sendOrderCancellationResponse(instanceId, orderId, success, error = null) {
        await this.eventBroadcaster.publish('ORDER_CANCELLATION_RESPONSE', {
            instanceId,
            orderId,
            success,
            error,
            timestamp: Date.now()
        });
    }
    
    // Configuration Management Methods
    
    // Provision new bot instance
    async provisionBotInstance(instanceRequest) {
        if (!this.configurationService) {
            return { success: false, error: 'Configuration service not available' };
        }
        
        try {
            const result = await this.configurationService.provisionInstance(instanceRequest);
            
            if (result.success) {
                console.log(`✅ Bot instance provisioned: ${result.instanceId}`);
                
                // Broadcast instance provisioned event
                await this.broadcastInstanceProvisioned(result);
            }
            
            return result;
            
        } catch (error) {
            console.error('❌ Instance provisioning failed:', error);
            return { success: false, error: error.message };
        }
    }
    
    // Update instance configuration
    async updateInstanceConfiguration(instanceId, updates) {
        if (!this.configurationService) {
            return { success: false, error: 'Configuration service not available' };
        }
        
        try {
            const result = await this.configurationService.updateInstanceConfiguration(instanceId, updates);
            
            if (result.success) {
                console.log(`✅ Instance configuration updated: ${instanceId}`);
            }
            
            return result;
            
        } catch (error) {
            console.error('❌ Instance configuration update failed:', error);
            return { success: false, error: error.message };
        }
    }
    
    // Update global configuration
    async updateGlobalConfiguration(section, updates) {
        if (!this.configurationService) {
            return { success: false, error: 'Configuration service not available' };
        }
        
        try {
            const result = await this.configurationService.updateGlobalConfiguration(section, updates);
            
            if (result.success) {
                console.log(`✅ Global configuration updated: ${section}`);
            }
            
            return result;
            
        } catch (error) {
            console.error('❌ Global configuration update failed:', error);
            return { success: false, error: error.message };
        }
    }
    
    // Configuration broadcasting methods
    async broadcastGlobalConfigUpdate(data) {
        await this.eventBroadcaster.broadcast('GLOBAL_CONFIG_UPDATED', {
            section: data.section,
            config: data.config,
            timestamp: Date.now()
        });
        
        console.log(`📡 Global configuration update broadcasted: ${data.section}`);
    }
    
    async broadcastInstanceConfigUpdate(data) {
        await this.eventBroadcaster.send(data.instanceId, 'INSTANCE_CONFIG_UPDATED', {
            config: data.config,
            changes: data.changes,
            timestamp: Date.now()
        });
        
        console.log(`📡 Instance configuration update sent: ${data.instanceId}`);
    }
    
    async broadcastInstanceProvisioned(data) {
        await this.eventBroadcaster.broadcast('INSTANCE_PROVISIONED', {
            instanceId: data.instanceId,
            config: data.config,
            timestamp: Date.now()
        });
        
        console.log(`📡 Instance provisioned event broadcasted: ${data.instanceId}`);
    }
    
    // Get configuration service status
    getConfigurationStatus() {
        if (!this.configurationService) {
            return { available: false, message: 'Configuration service not available' };
        }
        
        return {
            available: true,
            status: this.configurationService.getServiceStatus()
        };
    }
    
    // Get positions from TopStep API
    async getPositions(accountId = null) {
        try {
            console.log(`📊 [Positions] Fetching positions${accountId ? ` for account ${accountId}` : ' for all accounts'}`);
            
            // Ensure we have authentication
            const tokenResult = await this.authModule.ensureValidToken();
            if (!tokenResult.success) {
                throw new Error('Authentication required');
            }
            
            const axios = require('axios');
            let positions = [];
            
            if (accountId) {
                // Get positions for specific account using multiple endpoints and parameters
                console.log(`📊 [Positions] Fetching positions for account ${accountId}`);
                
                // Try multiple endpoints and parameters for complete position data
                const endpoints = [
                    `https://userapi.topstepx.com/Position?accountId=${accountId}&includeWorkingOrders=true`,
                    `https://userapi.topstepx.com/Position?accountId=${accountId}`,
                    `https://api.topstepx.com/api/Position?accountId=${accountId}`
                ];
                
                let response = null;
                let usedEndpoint = null;
                
                for (const url of endpoints) {
                    try {
                        console.log(`🔍 Trying endpoint: ${url}`);
                        response = await axios.get(url, {
                            headers: this.authModule.getAuthHeaders(),
                            timeout: 10000
                        });
                        usedEndpoint = url;
                        break;
                    } catch (error) {
                        console.log(`⚠️ Endpoint failed: ${url} - ${error.message}`);
                        continue;
                    }
                }
                
                if (!response) {
                    throw new Error('All position endpoints failed');
                }
                
                console.log(`✅ [Positions] Successfully used endpoint: ${usedEndpoint}`);
                console.log(`📊 [Positions] API Response Status: ${response.status}`);
                console.log(`📊 [Positions] API Response Data:`, JSON.stringify(response.data, null, 2));
                
                positions = Array.isArray(response.data) ? response.data : [response.data].filter(Boolean);
            } else {
                // Get positions for all accounts
                const accounts = this.cachedAccounts || [];
                console.log(`📊 [Positions] Fetching positions for ${accounts.length} accounts`);
                
                for (const account of accounts) {
                    try {
                        const url = `https://userapi.topstepx.com/Position?accountId=${account.id}`;
                        console.log(`🔍 Requesting positions from: ${url}`);
                        
                        const response = await axios.get(url, {
                            headers: this.authModule.getAuthHeaders(),
                            timeout: 10000
                        });
                        
                        const accountPositions = Array.isArray(response.data) ? response.data : [response.data].filter(Boolean);
                        positions.push(...accountPositions);
                    } catch (error) {
                        console.error(`📊 [Positions] Failed to fetch positions for account ${account.id}:`, error.message);
                    }
                }
            }
            
            // Format positions for aggregator with enhanced field mapping
            const formattedPositions = positions.map(pos => ({
                // Core position identification
                id: pos.id || pos.positionId || null,
                accountId: pos.accountId,
                
                // Instrument details
                instrument: pos.contractId || pos.contractName || pos.instrument,
                symbol: pos.symbolName || pos.symbolId || pos.symbol || pos.contractName,
                
                // Position details
                side: pos.side || (pos.positionSize > 0 ? 'BUY' : pos.positionSize < 0 ? 'SELL' : 'UNKNOWN'),
                quantity: Math.abs(pos.positionSize || pos.quantity || 0),
                avgPrice: pos.averagePrice || pos.fillPrice || 0,
                
                // P&L information (using the rich userapi data)
                currentPrice: pos.currentPrice || pos.lastPrice || 0,
                unrealizedPnL: pos.profitAndLoss || pos.unrealizedPnl || pos.unrealizedPnL || 0,
                realizedPnL: pos.realizedPnL || pos.realizedPnl || 0,
                
                // Risk management
                stopLoss: pos.stopLoss || null,
                takeProfit: pos.takeProfit || null,
                stopLossOrderId: pos.stopLossOrderId || null,
                takeProfitOrderId: pos.takeProfitOrderId || null,
                
                // Additional fields
                toMake: pos.toMake || null,
                risk: pos.risk || null,
                orderId: pos.orderId || null,
                openTime: pos.entryTime || pos.openTime || pos.createdAt || new Date().toISOString(),
                
                // Raw data for debugging
                _raw: pos
            }));
            
            console.log(`📊 [Positions] Found ${formattedPositions.length} open positions`);
            
            return {
                success: true,
                positions: formattedPositions
            };
            
        } catch (error) {
            console.error('📊 [Positions] Failed to fetch positions:', error.message);
            if (error.response) {
                console.error('📊 [Positions] Response error:', error.response.data);
            }
            
            return {
                success: false,
                error: error.message,
                positions: []
            };
        }
    }
    
    // Get position by ID using SignalR (for faster real-time updates)
    async getPositionById(positionId) {
        try {
            console.log(`📊 [Position] Fetching position ${positionId} via SignalR`);
            
            if (!this.marketDataService || !this.marketDataService.userHub) {
                console.log('📊 [Position] SignalR not available, falling back to REST API');
                // Fallback to REST API if SignalR not available
                return await this.getPositionByIdREST(positionId);
            }
            
            // Use SignalR to get position by ID
            const result = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('SignalR position request timeout'));
                }, 5000);
                
                // Set up one-time listener for position response
                const responseHandler = (position) => {
                    clearTimeout(timeout);
                    if (position && position.positionId === positionId) {
                        resolve({
                            success: true,
                            position: this.formatPosition(position)
                        });
                    }
                };
                
                // Listen for position update
                this.marketDataService.userHub.once('PositionUpdate', responseHandler);
                
                // Request position via SignalR
                this.marketDataService.userHub.invoke('GetPositionById', positionId)
                    .catch(error => {
                        clearTimeout(timeout);
                        this.marketDataService.userHub.off('PositionUpdate', responseHandler);
                        reject(error);
                    });
            });
            
            console.log(`📊 [Position] Retrieved position ${positionId} via SignalR`);
            return result;
            
        } catch (error) {
            console.error(`📊 [Position] SignalR failed for position ${positionId}:`, error.message);
            // Fallback to REST API
            return await this.getPositionByIdREST(positionId);
        }
    }
    
    // Get position by ID using REST API (fallback)
    async getPositionByIdREST(positionId) {
        try {
            console.log(`📊 [Position] Fetching position ${positionId} via REST API`);
            
            const axios = require('axios');
            const response = await axios.get(
                `https://api.topstepx.com/api/Positions/${positionId}`,
                {
                    headers: this.authModule.getAuthHeaders(),
                    timeout: 10000
                }
            );
            
            if (response.data) {
                return {
                    success: true,
                    position: this.formatPosition(response.data)
                };
            } else {
                throw new Error('No position data received');
            }
            
        } catch (error) {
            console.error(`📊 [Position] REST API failed for position ${positionId}:`, error.message);
            return {
                success: false,
                error: error.message,
                position: null
            };
        }
    }
    
    // Format position data
    formatPosition(pos) {
        return {
            id: pos.positionId,
            accountId: pos.accountId,
            instrument: pos.contractName || pos.instrument,
            symbol: pos.symbol || pos.contractName,
            side: pos.side || (pos.quantity > 0 ? 'BUY' : 'SELL'),
            quantity: Math.abs(pos.quantity || 0),
            avgPrice: pos.averagePrice || pos.fillPrice || 0,
            currentPrice: pos.lastPrice || 0,
            unrealizedPnL: pos.unrealizedPnl || 0,
            realizedPnL: pos.realizedPnl || 0,
            stopLoss: pos.stopLoss || null,
            takeProfit: pos.takeProfit || null,
            orderId: pos.orderId || null,
            openTime: pos.openTime || pos.createdAt || new Date().toISOString()
        };
    }
    
    // Handle market data subscription requests
    async handleMarketDataSubscription(data) {
        try {
            const { instrument, types, subscribe, source } = data;
            console.log(`📊 Market data subscription request from ${source || 'unknown'}:`);
            console.log(`   Instrument: ${instrument}`);
            console.log(`   Types: ${types ? types.join(', ') : 'all'}`);
            console.log(`   Action: ${subscribe ? 'SUBSCRIBE' : 'UNSUBSCRIBE'}`);
            
            if (!this.marketDataService) {
                console.error('❌ Market Data Service not initialized');
                return;
            }
            
            if (subscribe) {
                // Subscribe to the instrument
                const success = await this.marketDataService.subscribeToInstrument(instrument);
                if (success) {
                    console.log(`✅ Successfully subscribed to ${instrument} for ${source || 'unknown'}`);
                } else {
                    console.error(`❌ Failed to subscribe to ${instrument}`);
                }
            } else {
                // Unsubscribe from the instrument
                const success = await this.marketDataService.unsubscribeFromInstrument(instrument);
                if (success) {
                    console.log(`✅ Successfully unsubscribed from ${instrument} for ${source || 'unknown'}`);
                } else {
                    console.error(`❌ Failed to unsubscribe from ${instrument}`);
                }
            }
            
        } catch (error) {
            console.error('❌ Error handling market data subscription:', error);
        }
    }

    /**
     * Handle SL/TP update requests from Trading Aggregator
     */
    async handleSLTPUpdateRequest(data) {
        const { requestId, positionId, stopLoss, takeProfit, attempt } = data;
        
        try {
            console.log(`🎯 [SL/TP UPDATE] Received request: positionId=${positionId}, SL=${stopLoss}, TP=${takeProfit} (attempt ${attempt})`);
            
            if (!positionId) {
                throw new Error('Position ID is required for SL/TP update');
            }

            // Build the payload for the userapi editStopLossAccount endpoint
            const payload = {
                positionId: positionId,
                stopLoss: stopLoss !== undefined && stopLoss !== null ? Math.round(stopLoss * 100) / 100 : null,
                takeProfit: takeProfit !== undefined && takeProfit !== null ? Math.round(takeProfit * 100) / 100 : null
            };

            console.log(`📤 [SL/TP UPDATE] Calling userapi with payload:`, payload);

            // Make the API call to update SL/TP
            const response = await this.authModule.makeAuthenticatedRequest({
                url: 'https://userapi.topstepx.com/Order/editStopLossAccount',
                method: 'POST',
                data: payload
            });

            if (response.success) {
                console.log(`✅ [SL/TP UPDATE] Successfully updated position ${positionId}`);
                
                // Send success response back to Trading Aggregator
                await this.eventBroadcaster.publishEvent('sltp-response', {
                    type: 'sltp-response',
                    payload: {
                        requestId: requestId,
                        success: true,
                        result: response.data,
                        positionId: positionId,
                        appliedStopLoss: stopLoss,
                        appliedTakeProfit: takeProfit
                    }
                });
            } else {
                throw new Error(response.error || 'SL/TP update failed');
            }

        } catch (error) {
            console.error(`❌ [SL/TP UPDATE] Failed to update position ${positionId}:`, error.message);
            
            // Send error response back to Trading Aggregator
            await this.eventBroadcaster.publishEvent('sltp-response', {
                type: 'sltp-response', 
                payload: {
                    requestId: requestId,
                    success: false,
                    error: error.message,
                    positionId: positionId
                }
            });
        }
    }

    /**
     * Handle SEARCH_TRADES request - Search for trades within a date range and filter
     */
    async handleSearchTradesRequest(data) {
        try {
            const { requestId, searchParams, responseChannel } = data;
            console.log(`📊 Processing SEARCH_TRADES request, requestId: ${requestId}, responseChannel: ${responseChannel}`);
            
            // Ensure authentication is valid
            const tokenResult = await this.authModule.ensureValidToken();
            if (!tokenResult.success) {
                throw new Error('Authentication required');
            }
            
            // Prepare search parameters
            const {
                accountId,
                symbol,
                startDate,
                endDate,
                status = 'FILLED'
            } = searchParams || {};
            
            if (!accountId) {
                throw new Error('Account ID is required for trade search');
            }
            
            // Call TopStep API to search for trades
            const axios = require('axios');
            const response = await axios.post(`${this.authModule.baseURL}/api/v1/trades/search`, {
                accountId: parseInt(accountId),
                symbol,
                startDate,
                endDate,
                status
            }, {
                headers: this.authModule.getAuthHeaders(),
                timeout: 10000
            });
            
            const trades = response.data || [];
            console.log(`✅ Found ${trades.length} trades for account ${accountId}`);
            
            // Send response back to the specified channel
            const responseData = {
                requestId,
                type: 'SEARCH_TRADES',
                success: true,
                trades,
                count: trades.length,
                searchParams: searchParams,
                timestamp: Date.now()
            };
            
            const channel = responseChannel || 'connection-manager:response';
            await this.eventBroadcaster.publisher.publish(channel, JSON.stringify(responseData));
            console.log(`📤 Sent SEARCH_TRADES response to ${channel}`);
            
        } catch (error) {
            console.error(`❌ Failed to search trades:`, error.message);
            
            // Send error response
            const errorData = {
                requestId: data.requestId,
                type: 'SEARCH_TRADES',
                success: false,
                error: error.message,
                trades: [],
                timestamp: Date.now()
            };
            const channel = data.responseChannel || 'connection-manager:response';
            await this.eventBroadcaster.publisher.publish(channel, JSON.stringify(errorData));
        }
    }

    /**
     * Handle GET_TRADES request - Get specific trades for a position
     */
    async handleGetTradesRequest(data) {
        try {
            const { requestId, accountId, positionId, responseChannel } = data;
            console.log(`📊 Processing GET_TRADES request, requestId: ${requestId}, positionId: ${positionId}, responseChannel: ${responseChannel}`);
            
            // Ensure authentication is valid
            const tokenResult = await this.authModule.ensureValidToken();
            if (!tokenResult.success) {
                throw new Error('Authentication required');
            }
            
            if (!accountId) {
                throw new Error('Account ID is required');
            }
            
            // For now, use the same search endpoint but filter by position if available
            const axios = require('axios');
            let trades = [];
            
            if (positionId) {
                // Try to get trades for specific position (this endpoint may not exist)
                try {
                    const response = await axios.get(`${this.authModule.baseURL}/api/v1/positions/${positionId}/trades`, {
                        headers: this.authModule.getAuthHeaders(),
                        timeout: 10000
                    });
                    trades = response.data || [];
                } catch (positionError) {
                    console.log('⚠️ Position-specific trades endpoint not available, using general search');
                    // Fallback to general trade search for today
                    const today = new Date();
                    const startOfDay = new Date(today.setHours(0, 0, 0, 0));
                    
                    const searchResponse = await axios.post(`${this.authModule.baseURL}/api/v1/trades/search`, {
                        accountId: parseInt(accountId),
                        startDate: startOfDay.toISOString(),
                        endDate: new Date().toISOString(),
                        status: 'FILLED'
                    }, {
                        headers: this.authModule.getAuthHeaders(),
                        timeout: 10000
                    });
                    
                    trades = searchResponse.data || [];
                }
            } else {
                // Get recent trades for account
                const today = new Date();
                const startOfDay = new Date(today.setHours(0, 0, 0, 0));
                
                const response = await axios.post(`${this.authModule.baseURL}/api/v1/trades/search`, {
                    accountId: parseInt(accountId),
                    startDate: startOfDay.toISOString(),
                    endDate: new Date().toISOString(),
                    status: 'FILLED'
                }, {
                    headers: this.authModule.getAuthHeaders(),
                    timeout: 10000
                });
                
                trades = response.data || [];
            }
            
            console.log(`✅ Found ${trades.length} trades for account ${accountId}`);
            
            // Send response back to the specified channel
            const responseData = {
                requestId,
                type: 'GET_TRADES',
                success: true,
                trades,
                count: trades.length,
                accountId,
                positionId,
                timestamp: Date.now()
            };
            
            const channel = responseChannel || 'connection-manager:response';
            await this.eventBroadcaster.publisher.publish(channel, JSON.stringify(responseData));
            console.log(`📤 Sent GET_TRADES response to ${channel}`);
            
        } catch (error) {
            console.error(`❌ Failed to get trades:`, error.message);
            
            // Send error response
            const errorData = {
                requestId: data.requestId,
                type: 'GET_TRADES',
                success: false,
                error: error.message,
                trades: [],
                timestamp: Date.now()
            };
            const channel = data.responseChannel || 'connection-manager:response';
            await this.eventBroadcaster.publisher.publish(channel, JSON.stringify(errorData));
            console.log(`📤 Sent GET_TRADES error response to ${channel}`);
        }
    }

    /**
     * Handle GET_ACCOUNT_SUMMARY request - Get account summary including P&L
     */
    async handleGetAccountSummaryRequest(data) {
        try {
            const { requestId, accountId, date, responseChannel } = data;
            console.log(`📊 Processing GET_ACCOUNT_SUMMARY request, requestId: ${requestId}, accountId: ${accountId}, responseChannel: ${responseChannel}`);
            
            // Use existing account fetch functionality
            const accountsResult = await this.fetchAccountsFromTopStep(false);
            
            if (!accountsResult.success) {
                throw new Error(accountsResult.error || 'Failed to fetch account information');
            }
            
            // Find the specific account if provided
            let accountSummary;
            if (accountId) {
                const account = accountsResult.accounts.find(acc => 
                    acc.id.toString() === accountId.toString() || acc.name === accountId
                );
                
                if (!account) {
                    throw new Error(`Account ${accountId} not found`);
                }
                
                accountSummary = {
                    accountId: account.id,
                    accountName: account.name,
                    balance: account.balance,
                    canTrade: account.canTrade,
                    isVisible: account.isVisible,
                    simulated: account.simulated,
                    dailyPnL: 0, // Would need additional API call to get P&L
                    currency: 'USD',
                    lastUpdated: new Date().toISOString()
                };
            } else {
                // Return summary for all accounts
                accountSummary = accountsResult.accounts.map(account => ({
                    accountId: account.id,
                    accountName: account.name,
                    balance: account.balance,
                    canTrade: account.canTrade,
                    isVisible: account.isVisible,
                    simulated: account.simulated,
                    dailyPnL: 0, // Would need additional API call to get P&L
                    currency: 'USD',
                    lastUpdated: new Date().toISOString()
                }));
            }
            
            console.log(`✅ Retrieved account summary for ${accountId || 'all accounts'}`);
            
            // Send response back to the specified channel
            const responseData = {
                requestId,
                type: 'GET_ACCOUNT_SUMMARY',
                success: true,
                accountSummary,
                accountId,
                date: date || new Date().toISOString().split('T')[0],
                timestamp: Date.now()
            };
            
            const channel = responseChannel || 'connection-manager:response';
            await this.eventBroadcaster.publisher.publish(channel, JSON.stringify(responseData));
            console.log(`📤 Sent GET_ACCOUNT_SUMMARY response to ${channel}`);
            
        } catch (error) {
            console.error(`❌ Failed to get account summary:`, error.message);
            
            // Send error response
            const errorData = {
                requestId: data.requestId,
                type: 'GET_ACCOUNT_SUMMARY',
                success: false,
                error: error.message,
                accountSummary: null,
                timestamp: Date.now()
            };
            const channel = data.responseChannel || 'connection-manager:response';
            await this.eventBroadcaster.publisher.publish(channel, JSON.stringify(errorData));
            console.log(`📤 Sent GET_ACCOUNT_SUMMARY error response to ${channel}`);
        }
    }
}

module.exports = ConnectionManager;