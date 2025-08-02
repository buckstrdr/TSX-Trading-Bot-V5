#!/usr/bin/env node
/**
 * Enhanced Manual Trading Server v2 - Complete Edition
 * Features: 
 * - Order tracking with stop loss and take profit
 * - Position management with real-time P&L
 * - Loads existing positions/orders on startup
 * - Enhanced UI with SL/TP inputs
 */

// Set process title for Windows
if (process.platform === 'win32') {
    process.title = 'TSX-Manual-Trading';
}

// Enable silent mode support
require('../shared/utils/silentConsole');

const express = require('express');
const redis = require('redis');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const FileLogger = require('../shared/utils/FileLogger');

class ManualTradingServerV2 {
    constructor() {
        this.app = express();
        this.port = 3003;
        this.connectionManager = 'http://localhost:7500';
        this.redisClient = null;
        this.redisSubscriber = null;
        this.server = null;
        this.priceFetchInterval = null;
        
        // Initialize FileLogger
        this.fileLogger = new FileLogger('ManualTrading', 'logs');
        this.fileLogger.info('Manual Trading Server v2 starting up', {
            port: this.port,
            connectionManager: this.connectionManager
        });
        this.accountRefreshInterval = null;
        
        // Position and order tracking
        this.positions = new Map();
        this.orders = new Map();
        this.orderHistory = [];
        
        // Account data
        this.accounts = [];
        this.selectedAccount = null;
        
        // 🚨 ONE TRADE AT A TIME LOCK - Critical Safety Feature
        this.tradingLocked = false;
        this.currentOperation = null;
        
        // Market data for P&L calculation
        this.marketPrices = new Map();
        this.lastPriceUpdate = new Map();
        this.lastLoggedUpdate = new Map(); // Track last time we logged for each instrument
        
        // Auth token for TopStep API
        this.authToken = process.env.TOPSTEP_AUTH_TOKEN || '';
        
        // Instrument validation
        this.validInstruments = new Map(); // Map of symbol -> active contracts
        this.instruments = new Map(); // Initialize instruments map
        this.instrumentMonths = {
            'MGC': ['G', 'J', 'M', 'Q', 'V', 'Z'], // Gold
            'MNQ': ['H', 'M', 'U', 'Z'], // NASDAQ
            'MES': ['H', 'M', 'U', 'Z'], // S&P 500
            'MCL': ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'], // Crude Oil
            'M2K': ['H', 'M', 'U', 'Z'], // Russell 2000
            'MYM': ['H', 'M', 'U', 'Z'], // Dow
            'M6E': ['H', 'M', 'U', 'Z'], // Euro
            'M6B': ['H', 'M', 'U', 'Z'], // British Pound
            'MBT': ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'] // Bitcoin
        };
    }

    log(message, level = 'INFO', data = null) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [MANUAL-TRADING-V2] [${level}] ${message}`);
        
        // Also log to file
        if (this.fileLogger) {
            const logLevel = level.toLowerCase();
            if (data) {
                this.fileLogger.log(logLevel, message, data);
            } else {
                this.fileLogger.log(logLevel, message);
            }
        }
    }

    async init() {
        this.log('🚀 Starting Enhanced Manual Trading Server v2');
        
        // Add early logging to debug startup issues
        this.log('Current directory: ' + process.cwd());
        this.log('Node version: ' + process.version);
        
        // CLEAR ALL DATA MAPS ON STARTUP TO PREVENT STALE DATA
        this.log('🧹 Clearing all data maps to prevent stale data...');
        this.positions.clear();
        this.orders.clear();
        this.marketPrices.clear();
        this.lastPriceUpdate.clear();
        this.lastLoggedUpdate.clear();
        this.validInstruments.clear();
        this.instruments.clear();
        this.accounts = [];
        this.selectedAccount = null;
        this.log('✅ All data maps cleared');
        
        // Setup Express
        this.log('Setting up Express...');
        this.app.use(express.json());
        this.app.use(express.static(path.join(__dirname, 'public')));
        
        // Serve V5 UI shared assets
        this.app.use('/src/ui/shared', express.static(path.join(__dirname, '..', 'src', 'ui', 'shared')));
        
        this.log('✅ Express setup complete');
        
        // Setup Redis
        this.log('Setting up Redis connection...');
        await this.connectRedis();
        
        // Manual Trading is a fixed service - no instance registration needed
        
        // Load accounts and existing data
        // Force fresh data on startup to ensure we have latest account information
        await this.loadAccounts(true);
        
        // Load available contracts via aggregator
        await this.loadContracts();
        
        // Broadcast initial account list
        await this.broadcastAccountListChange();
        
        // Start periodic account refresh (every 30 seconds)
        this.startAccountRefreshInterval();
        
        // Start heartbeat to Connection Manager (every 30 seconds)
        this.startConnectionManagerHeartbeat();
        
        // Skip loadValidInstruments - we're loading contracts through aggregator instead
        // This was causing the contract dropdown to be cleared
        // try {
        //     await this.loadValidInstruments(); // Load valid instruments on startup
        // } catch (error) {
        //     this.log(`Error loading instruments, using defaults: ${error.message}`, 'WARN');
        //     this.loadDefaultInstruments();
        // }
        
        await this.loadExistingPositions();
        await this.loadExistingOrders();
        
        // Setup tracking and subscriptions
        await this.setupOrderTracking();
        await this.setupMarketDataSubscription();
        
        // Start position sync interval (every 30 seconds to catch missed changes)
        this.startPositionSyncInterval();
        
        // MARKET DATA VERIFICATION
        console.log('⏳ Waiting 20 seconds to verify market data flow from aggregator...');
        console.log('   (Connection Manager checks for data for 20 seconds to ensure we capture low volatility stocks)');
        await new Promise(resolve => setTimeout(resolve, 20000));
        
        console.log('🔍 Verifying market data reception for all instruments...');
        console.log(`📊 Total instruments loaded: ${this.instruments.size}`);
        
        // Check which instruments have received prices
        const instrumentsWithPrices = [];
        const instrumentsWithoutPrices = [];
        
        // Also log what's in marketPrices
        console.log(`📊 Market prices Map has ${this.marketPrices.size} entries:`);
        if (this.marketPrices.size > 0) {
            const samplePrices = [];
            let count = 0;
            for (const [key, price] of this.marketPrices) {
                if (count < 5) {
                    samplePrices.push(`${key}: $${price.toFixed(2)}`);
                    count++;
                }
            }
            console.log(`   Sample prices: ${samplePrices.join(', ')}`);
        }
        
        for (const [symbol, instrument] of this.instruments) {
            const hasPrice = this.marketPrices.has(symbol);
            const price = this.marketPrices.get(symbol);
            
            if (hasPrice && price) {
                instrumentsWithPrices.push(`${symbol}: $${price.toFixed(2)}`);
            } else {
                instrumentsWithoutPrices.push(symbol);
            }
        }
        
        console.log('📊 Market Data Verification Results:');
        console.log(`   ✅ Instruments with prices: ${instrumentsWithPrices.length}`);
        for (const inst of instrumentsWithPrices) {
            console.log(`      ✅ ${inst}`);
        }
        
        if (instrumentsWithoutPrices.length > 0) {
            console.log(`   ❌ Instruments without prices: ${instrumentsWithoutPrices.length}`);
            for (const symbol of instrumentsWithoutPrices) {
                console.log(`      ❌ ${symbol}: No price data`);
            }
            console.log('   ⚠️  This may be normal if markets are closed or contracts are inactive.');
        } else {
            console.log('✅ All instruments are receiving market data!');
        }
        
        // Start price fetching interval
        this.startPriceFetchInterval();
        
        // Start periodic market data health check (every minute)
        this.startMarketDataHealthCheck();
        
        // Setup routes
        this.setupRoutes();
        
        // Start server
        this.server = this.app.listen(this.port, () => {
            this.log(`✅ Enhanced Manual Trading Server running on http://localhost:${this.port}`);
            this.log(`📊 Features: Order tracking, position management, SL/TP, real-time P&L, instrument validation`);
        });
        
        // Setup enhanced graceful shutdown
        this.setupGracefulShutdown();
    }

    async connectRedis() {
        this.log('Connecting to Redis...');
        try {
            // Publisher client
            this.log('Creating Redis publisher client...');
            this.redisClient = redis.createClient({
                host: 'localhost',
                port: 6379
            });
            
            // Subscriber client
            this.log('Creating Redis subscriber client...');
            this.redisSubscriber = redis.createClient({
                host: 'localhost',
                port: 6379
            });
            
            // Add error handlers
            this.redisClient.on('error', (err) => {
                this.log('Redis Publisher Error: ' + err.message, 'ERROR');
            });
            
            this.redisSubscriber.on('error', (err) => {
                this.log('Redis Subscriber Error: ' + err.message, 'ERROR');
            });
            
            // Add ready handlers
            this.redisClient.on('ready', () => {
                this.log('✅ Redis publisher connected and ready');
            });
            
            this.redisSubscriber.on('ready', () => {
                this.log('✅ Redis subscriber connected and ready');
            });
            
            // Log subscription events
            this.redisSubscriber.on('subscribe', (channel, count) => {
                this.log(`✅ Successfully subscribed to channel: ${channel} (total subscriptions: ${count})`);
            });
            
            this.redisSubscriber.on('message', (channel, message) => {
                // Message received on Redis channel
            });
            
            this.log('Connecting to Redis publisher...');
            await this.redisClient.connect();
            this.log('✅ Connected to Redis publisher');
            
            this.log('Connecting to Redis subscriber...');
            await this.redisSubscriber.connect();
            this.log('✅ Connected to Redis subscriber');
            
            this.log('✅ Connected to Redis (publisher and subscriber)');
        } catch (error) {
            this.log(`Failed to connect to Redis: ${error.message}`, 'ERROR');
            this.log(`Stack: ${error.stack}`, 'ERROR');
            throw error;
        }
    }

    // Removed instance registration - Manual Trading is a fixed service, not a dynamic instance
    // The Connection Manager tracks Manual Trading service status through health checks
    /*
    async registerInstance() {
        // Instance registration removed - using fixed service tracking instead
    }
    */

    async subscribeToMarketData(instruments) {
        // Manual trading no longer subscribes directly to market data.
        // All market data flows through the aggregator via the 'aggregator:market-data' channel.
        // This function is kept for backward compatibility but does nothing.
        this.log(`Market data subscription request for ${instruments.length} instruments (handled via aggregator)`);
    }

    async loadExistingPositions(silent = false) {
        if (!silent) {
            this.log('Loading existing positions from Connection Manager...');
        }
        
        try {
            if (!this.accounts || this.accounts.length === 0) {
                if (!silent) this.log('⚠️ No accounts loaded, cannot load positions');
                return;
            }
            
            // Clear existing positions 
            this.positions.clear();
            if (!silent) this.log('🔍 [DEBUG] Cleared all existing positions');
            
            // Load positions for ALL accounts
            // Keep track of current positions to detect closed ones
            const currentPositionKeys = new Set();
            let totalPositions = 0;
            if (!silent) this.log(`🚨 [CRITICAL] Starting to load positions for ${this.accounts.length} accounts: ${this.accounts.map(a => a.id).join(', ')}`);
            
            for (let i = 0; i < this.accounts.length; i++) {
                const account = this.accounts[i];
                if (!silent) {
                    this.log(`🔍 [DEBUG] Loading positions for account ${i + 1}/${this.accounts.length}: ${account.name || account.id} (${account.id})`);
                    // Enhanced logging for debugging
                    this.log(`🔍 [DEBUG] Account details:`, JSON.stringify(account, null, 2));
                    this.log(`🔍 [DEBUG] Account ID being used: ${account.id}`);
                }
                
                // Keep the existing single-account logic but loop through all accounts

                // Request positions via Redis using Connection Manager
                const requestId = `manual-pos-${account.id}-${Date.now()}`;
            
            // Subscribe to response first
            const positionPromise = new Promise(async (resolve, reject) => {
                let subscriptionHandler = null;
                let isResolved = false;
                
                const timeout = setTimeout(() => {
                    if (!silent) this.log('⏰ Position request timeout - no response from Connection Manager in 10 seconds', 'WARN');
                    isResolved = true;
                    if (subscriptionHandler) {
                        this.redisSubscriber.unsubscribe('position-response');
                    }
                    resolve(null);
                }, 10000); // 10 second timeout
                
                if (!silent) console.log('[POSITION-RESPONSE] 📡 Setting up subscription handler...');
                subscriptionHandler = (message) => {
                    if (isResolved) return; // Ignore messages after resolution
                    
                    if (!silent) {
                        console.log('[POSITION-RESPONSE] 🎯 Message received on channel!');
                        console.log('[POSITION-RESPONSE] Raw message:', message);
                    }
                    try {
                        const data = JSON.parse(message);
                        this.log('📨 Raw position response received:', JSON.stringify(data, null, 2));
                        
                        // Handle different response formats
                        let positionData = data;
                        
                        // Check if this is our response
                        if (positionData.requestId === requestId) {
                            isResolved = true;
                            clearTimeout(timeout);
                            this.redisSubscriber.unsubscribe('position-response');
                            
                            if (positionData.success === false) {
                                this.log(`❌ Position request failed: ${positionData.error}`, 'ERROR');
                                resolve([]);
                            } else {
                                this.log(`✅ Position request successful, received ${positionData.positions?.length || 0} positions`);
                                resolve(positionData.positions || []);
                            }
                        } else {
                            this.log(`🔍 [DEBUG] Ignoring response for different requestId: ${positionData.requestId} (expected: ${requestId})`);
                        }
                    } catch (e) {
                        this.log(`Error parsing position response: ${e.message}`, 'ERROR');
                        this.log(`Raw message that failed to parse: ${message}`);
                    }
                };
                
                // Subscribe to the channel
                console.log('[POSITION-RESPONSE] 📡 Subscribing to position-response channel...');
                await this.redisSubscriber.subscribe('position-response', subscriptionHandler);
                console.log('[POSITION-RESPONSE] ✅ Successfully subscribed to position-response channel');
            });
            
            // Publish request for positions
            const requestPayload = {
                type: 'GET_POSITIONS',
                requestId: requestId,
                accountId: account.id,
                responseChannel: 'position-response',
                timestamp: Date.now()
            };
            
            this.log(`📤 Publishing position request:`, JSON.stringify(requestPayload, null, 2));
            // Should go through aggregator instead of direct to connection manager
            await this.redisClient.publish('aggregator:requests', JSON.stringify(requestPayload));
            
            this.log(`📤 Published position request with ID: ${requestId}, waiting for response...`);
            
            // Wait for response
            const positions = await positionPromise;
            
            if (!positions) {
                this.log('⚠️ No response from Connection Manager for positions - timeout or no connection', 'WARN');
                this.log('💡 Check if Connection Manager is running and listening to connection-manager:requests channel');
                return;
            }
            
            if (positions && positions.length > 0) {
                this.log(`📊 Found ${positions.length} existing positions from Connection Manager`);
                
                // Clear local positions to ensure we only show what's actually open
                // This prevents stale positions from persisting
                this.positions.clear();
                this.log('🧹 Cleared local positions before loading fresh data');
                
                // Process each position
                positions.forEach((position, index) => {
                    this.log(`🔍 [DEBUG] Processing position ${index + 1}:`, JSON.stringify(position, null, 2));
                    
                    // DEBUG: Show ALL field names and values to find the correct direction field
                    this.log(`🔍 [DEBUG] ALL FIELDS:`, Object.keys(position).map(key => `${key}: ${position[key]}`).join(', '));
                    
                    // Build the position key with accountId and side
                    const instrument = position.contractId || position.instrument;
                    
                    // TopStep userapi sends 'side' field directly
                    const positionSize = position.positionSize || position.size || 0;
                    const quantity = Math.abs(positionSize);
                    
                    this.log(`🔍 [DEBUG] Field analysis: positionSize=${position.positionSize}, size=${position.size}, type=${position.type}, side=${position.side}`);
                    
                    if (quantity === 0) {
                        this.log(`📭 [DEBUG] Skipping flat position for ${instrument}`);
                        return; // Skip flat positions
                    }
                    
                    // Use the side field from the API response
                    // TopStep userapi returns side as 0 (BUY/LONG) or 1 (SELL/SHORT)
                    let side;
                    if (position.side !== undefined) {
                        side = position.side === 0 ? 'LONG' : 'SHORT';
                        this.log(`🔍 [DEBUG] Using side field: ${position.side} → ${side}`);
                    } else {
                        // Fallback to signed position size if side field is missing
                        side = positionSize > 0 ? 'LONG' : 'SHORT';
                        this.log(`⚠️ [DEBUG] No side field, using positionSize: ${positionSize} → ${side}`);
                    }
                    
                    // Use instrument as the position key (reverting to original behavior)
                    const positionKey = instrument;
                    
                    this.log(`🔍 [DEBUG] Position determined: ${side} ${quantity} @ ${position.averagePrice}`);
                    
                    this.positions.set(positionKey, {
                        positionId: position.id,
                        instrument: position.contractId || position.instrument,
                        side: side,  // STORE THE SIDE!
                        quantity: quantity,
                        avgPrice: position.averagePrice,
                        realizedPnL: position.realizedPnL || 0,
                        unrealizedPnL: position.unrealizedPnL || 0,
                        currentPrice: null, // Will be updated by market data
                        stopLoss: position.stopLoss,
                        takeProfit: position.takeProfit,
                        timestamp: position.creationTimestamp || Date.now(),
                        accountId: position.accountId || accountId  // STORE THE ACCOUNT ID WITH THE POSITION!
                    });
                    
                    // Track this position as active
                    currentPositionKeys.add(positionKey);
                    
                    // Update current price if we have market data
                    const currentMarketPrice = this.marketPrices.get(positionKey);
                    if (currentMarketPrice) {
                        const positionToUpdate = this.positions.get(positionKey);
                        if (positionToUpdate) {
                            positionToUpdate.currentPrice = currentMarketPrice;
                            this.updatePositionPnL(positionKey);
                        }
                    }
                    
                    this.log(`📊 Loaded position: ${positionKey} ${side} ${quantity} @ ${position.averagePrice} SL:${position.stopLoss} TP:${position.takeProfit}`);
                });
                
                this.log(`✅ Loaded ${positions.length} positions from Connection Manager`);
                totalPositions += positions.length;
            }
            
                this.log(`✅ [DEBUG] Completed loading positions for account ${i + 1}/${this.accounts.length}: ${account.id}`);
                
                // Add small delay between account requests to avoid overwhelming Connection Manager
                if (i < this.accounts.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            } // End of for loop
            
            this.log(`🚨 [CRITICAL] FINISHED loading positions: ${totalPositions} total positions across ${this.accounts.length} accounts`);
            
            // Remove positions that are no longer in the Connection Manager response
            const removedPositions = [];
            for (const [key, position] of this.positions.entries()) {
                if (!currentPositionKeys.has(key)) {
                    this.log(`🗑️ Removing closed position: ${key}`);
                    this.positions.delete(key);
                    removedPositions.push(key);
                }
            }
            
            if (removedPositions.length > 0) {
                this.log(`🧹 Cleaned up ${removedPositions.length} closed positions: ${removedPositions.join(', ')}`);
            }
            
            this.log(`🔍 [DEBUG] Total positions in memory: ${this.positions.size}`);
            
        } catch (error) {
            this.log(`Failed to load existing positions: ${error.message}`, 'ERROR');
            this.log(`Error stack: ${error.stack}`, 'ERROR');
            // Continue anyway - we'll track new positions through order updates
        }
    }

    async loadExistingOrders() {
        this.log('Loading existing orders...');
        
        try {
            // Clear any stale orders from previous sessions
            this.orders.clear();
            
            // Subscribe to user data channel for working orders updates
            await this.redisSubscriber.subscribe('user:data', async (message) => {
                try {
                    const data = JSON.parse(message);
                    
                    // Handle working orders updates
                    if (data.type === 'WORKING_ORDERS' || data.type === 'ORDER_UPDATE') {
                        this.log(`Received ${data.type} update`, 'DEBUG');
                        
                        if (data.orders && Array.isArray(data.orders)) {
                            // Update our order tracking with working orders
                            data.orders.forEach(order => {
                                const orderKey = `${order.accountId}_${order.orderId || order.id}`;
                                const existingOrder = this.orders.get(orderKey);
                                
                                // Update or add the order
                                this.orders.set(orderKey, {
                                    ...existingOrder,
                                    ...order,
                                    timestamp: order.timestamp || Date.now(),
                                    status: order.status || 'WORKING'
                                });
                            });
                            
                            this.log(`Updated ${data.orders.length} working orders`);
                            await this.broadcastOrdersUpdate();
                        }
                    }
                    
                    // Handle individual order status updates
                    if (data.type === 'ORDER_STATUS_UPDATE' && data.order) {
                        const order = data.order;
                        const orderKey = `${order.accountId}_${order.orderId || order.id}`;
                        
                        // Update the order status
                        const existingOrder = this.orders.get(orderKey);
                        if (existingOrder) {
                            this.orders.set(orderKey, {
                                ...existingOrder,
                                ...order,
                                status: order.status,
                                timestamp: Date.now()
                            });
                            
                            this.log(`Updated order ${order.orderId} status to ${order.status}`);
                            await this.broadcastOrdersUpdate();
                        }
                    }
                } catch (error) {
                    this.log(`Error handling user data: ${error.message}`, 'ERROR');
                }
            });
            
            // Request working orders through Trading Aggregator
            this.log('📝 Requesting working orders through Trading Aggregator...');
            const requestId = `MT-WORK-${Date.now()}`;
            const responseChannel = `manual-trading:working-orders-response:${requestId}`;
            
            // Set up response listener first
            const workingOrdersPromise = new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    this.log('⚠️ Working orders request timed out', 'WARN');
                    this.redisSubscriber.unsubscribe(responseChannel);
                    resolve(null);
                }, 10000);
                
                this.redisSubscriber.subscribe(responseChannel, (message) => {
                    try {
                        clearTimeout(timeout);
                        const response = JSON.parse(message);
                        this.redisSubscriber.unsubscribe(responseChannel);
                        
                        if (response.success && response.orders) {
                            this.log(`📝 Received ${response.orders.length} working orders`);
                            // Process the working orders
                            response.orders.forEach(order => {
                                this.workingOrders.set(order.orderId, order);
                            });
                            resolve(response.orders);
                        } else {
                            this.log('⚠️ Failed to get working orders', 'WARN');
                            resolve(null);
                        }
                    } catch (err) {
                        this.log(`Failed to parse working orders response: ${err.message}`, 'ERROR');
                        resolve(null);
                    }
                });
            });
            
            await this.redisClient.publish('aggregator:requests', JSON.stringify({
                type: 'GET_WORKING_ORDERS',
                requestId: requestId,
                responseChannel: responseChannel,
                instanceId: 'MANUAL_TRADING',  // Fixed service identifier
                timestamp: Date.now()
            }));
            
            await workingOrdersPromise;
            
            this.log('📝 Order tracking initialized - listening for order updates');
            this.log('ℹ️ Note: Working orders will be loaded as Connection Manager sends updates');
            
        } catch (error) {
            this.log(`Error initializing order tracking: ${error.message}`, 'WARN');
            // Continue anyway - we'll track new orders
        }
    }

    async setupOrderTracking() {
        this.log('Setting up order tracking...');
        
        // Subscribe to order management channel for responses
        await this.redisSubscriber.subscribe('order:management', async (message) => {
            try {
                const data = JSON.parse(message);
                
                // Debug logging - log ALL messages to see what's being received
                this.log(`Received message on order:management channel:`, 'DEBUG');
                this.log(`  - Raw message: ${message}`, 'DEBUG');
                this.log(`  - Parsed type: ${data.type}`, 'DEBUG');
                
                // Debug logging for ORDER_RESPONSE specifically
                if (data.type === 'ORDER_RESPONSE') {
                    this.log(`Received ORDER_RESPONSE message:`, 'DEBUG');
                    this.log(`  - Type: ${data.type}`, 'DEBUG');
                    this.log(`  - Has payload: ${!!data.payload}`, 'DEBUG');
                    if (data.payload) {
                        this.log(`  - InstanceId: ${data.payload.instanceId}`, 'DEBUG');
                        this.log(`  - OrderId: ${data.payload.orderId}`, 'DEBUG');
                        this.log(`  - Success: ${data.payload.success}`, 'DEBUG');
                        this.log(`  - TopStepOrderId: ${data.payload.topStepOrderId}`, 'DEBUG');
                        this.log(`  - Checking instanceId match: '${data.payload.instanceId}' === 'MANUAL_TRADING' = ${data.payload.instanceId === 'MANUAL_TRADING'}`, 'DEBUG');
                    }
                }
                
                // Check if this is an order response for our instance
                if (data.type === 'ORDER_RESPONSE' && data.payload && data.payload.instanceId === 'MANUAL_TRADING') {
                    this.log(`Processing ORDER_RESPONSE for our instance`, 'INFO');
                    await this.handleOrderResponse(data.payload);
                }
            } catch (error) {
                this.log(`Error handling order response: ${error.message}`, 'ERROR');
            }
        });
        
        // Subscribe to aggregator's market data channel for fills and position updates
        await this.redisSubscriber.subscribe('aggregator:market-data', async (message) => {
            try {
                // Silent operation - market data logging disabled
                // console.log('🔴 Manual Trading received message on aggregator:market-data channel:');
                // console.log('   - Raw message:', message);
                
                const data = JSON.parse(message);
                // console.log('   - Parsed data:', data);
                // console.log('   - Message type:', data.type);
                
                if (data.type === 'ORDER_FILLED') {
                    console.log('🎯 Received ORDER_FILLED event, processing...');
                    await this.handleOrderFill(data.payload);
                } else if (data.type === 'POSITION_UPDATE') {
                    console.log('📊 Received POSITION_UPDATE event, processing...');
                    await this.handlePositionUpdate(data.payload);
                } else if (data.type === 'BRACKET_ORDER_COMPLETE') {
                    console.log('📋 Received BRACKET_ORDER_COMPLETE event');
                    await this.handleBracketOrderComplete(data.payload);
                } else if (data.type === 'MARKET_DATA') {
                    // Handle market data updates from Connection Manager
                    await this.handleMarketData(data, 'market:data');
                } else {
                    // console.log(`ℹ️ Received other market:data event type: ${data.type}`);
                }
            } catch (error) {
                this.log(`Error handling market data: ${error.message}`, 'ERROR');
                console.error('Full error:', error);
            }
        });
        
        this.log('✅ Order tracking setup complete');
    }

    async setupMarketDataSubscription() {
        this.log('Setting up market data subscription...');
        this.log('📊 Market data heartbeat will log once per minute per instrument');
        
        // Subscribe to the main market:data channel for real-time price updates
        await this.redisSubscriber.subscribe('market:data', async (message) => {
            try {
                await this.handleMarketData(JSON.parse(message), 'market:data');
            } catch (error) {
                this.log(`Error handling market data: ${error.message}`, 'ERROR');
            }
        });
        
        // Also subscribe to legacy channels for backward compatibility
        const legacyChannels = [
            'market:data:realtime',
            'prices:MGC'
        ];
        
        for (const channel of legacyChannels) {
            await this.redisSubscriber.subscribe(channel, async (message) => {
                try {
                    await this.handleMarketData(JSON.parse(message), channel);
                } catch (error) {
                    // Try simple format
                    const match = message.match(/^([A-Z]+):(\d+\.?\d*)$/);
                    if (match) {
                        await this.handleMarketData({
                            symbol: match[1],
                            price: parseFloat(match[2])
                        }, channel);
                    }
                }
            });
        }
        
        this.log('✅ Market data subscription setup complete');
    }

    async handleMarketData(data, channel) {
        let symbol, price;
        
        // Debug log to see what we're receiving - log first 3 of each instrument
        if (!this.debugLoggedInstruments) {
            this.debugLoggedInstruments = new Map();
        }
        
        // Extract instrument for debug logging
        const debugInstrument = data.instrument || data.payload?.instrument || data.symbol || data.ticker || 'unknown';
        const debugCount = this.debugLoggedInstruments.get(debugInstrument) || 0;
        
        if (debugCount < 3) {
            console.log(`🔍 [DEBUG] Market data for ${debugInstrument} (sample ${debugCount + 1}/3):`, JSON.stringify(data, null, 2));
            this.debugLoggedInstruments.set(debugInstrument, debugCount + 1);
        }
        
        // Handle aggregator republished format (has processedBy: 'aggregator')
        if (data.processedBy === 'aggregator' && data.instrument) {
            symbol = data.instrument;
            
            // Aggregator format has the data directly in the object
            if (data.type === 'QUOTE' && data.data) {
                const marketData = data.data;
                // Use mid price from bid/ask
                if (marketData.bid && marketData.ask) {
                    price = (marketData.bid + marketData.ask) / 2;
                } else {
                    price = marketData.bid || marketData.ask || marketData.price;
                }
            } else if (data.type === 'TRADE' && data.data) {
                const marketData = data.data;
                price = marketData.price || marketData.last || marketData.lastPrice;
            } else if (data.type === 'DEPTH' && data.data) {
                const marketData = data.data;
                // For depth, use best bid/ask mid price
                if (marketData.bestBid && marketData.bestAsk) {
                    price = (marketData.bestBid + marketData.bestAsk) / 2;
                }
            }
        }
        // Handle EventBroadcaster format (type + payload)
        else if (data.payload && data.payload.instrument) {
            // Connection Manager sends market data with payload.type = 'QUOTE', 'TRADE', or 'DEPTH'
            if (data.payload.type === 'QUOTE' || data.payload.type === 'TRADE' || data.payload.type === 'DEPTH') {
                symbol = data.payload.instrument;
                const marketData = data.payload.data || data.payload;
                
                // Extract price from various fields
                price = marketData.lastPrice || marketData.last || marketData.price || 
                       marketData.mark || marketData.bestBid || 
                       ((marketData.bestBid && marketData.bestAsk) ? (marketData.bestBid + marketData.bestAsk) / 2 : null);
            }
        }
        // Handle Connection Manager market data format
        else if (data.instrument && data.data) {
            symbol = data.instrument;
            const marketData = data.data;
            
            // Extract price from various fields
            price = marketData.lastPrice || marketData.last || marketData.price || 
                   marketData.mark || marketData.bestBid || 
                   ((marketData.bestBid && marketData.bestAsk) ? (marketData.bestBid + marketData.bestAsk) / 2 : null);
        }
        // Handle legacy formats
        else if (data.symbol && data.price !== undefined) {
            symbol = data.symbol;
            price = data.price;
        } else if (data.ticker && data.last !== undefined) {
            symbol = data.ticker;
            price = data.last;
        } else if (data.instrument && data.marketData) {
            symbol = data.instrument;
            price = data.marketData.price || data.marketData.last;
        } else if (data.instrument && data.bid && data.ask) {
            symbol = data.instrument;
            price = (data.bid + data.ask) / 2; // Mid price
        } else {
            // Check if it's a direct symbol:price format
            const keys = Object.keys(data);
            if (keys.length === 1 && typeof data[keys[0]] === 'number') {
                // console.log(`📊 [DEBUG] Detected direct symbol:price format`);
                symbol = keys[0];
                price = data[keys[0]];
            }
        }
        
        
        if (symbol && price) {
            // Extract base symbol from contract ID if needed
            let baseSymbol = symbol;
            if (symbol.includes('CON.F.US.')) {
                // Extract symbol from contract ID like CON.F.US.MGC.Q25
                const parts = symbol.split('.');
                if (parts.length >= 4) {
                    // Extract F.US.XXX format from CON.F.US.XXX.YYY
                    baseSymbol = `${parts[1]}.${parts[2]}.${parts[3]}`; // F.US.MNQ
                }
            }
            
            // Store price under base symbol for API access
            this.marketPrices.set(baseSymbol, price);
            this.lastPriceUpdate.set(baseSymbol, Date.now());
            
            // Also store under full contract ID for completeness
            this.marketPrices.set(symbol, price);
            this.lastPriceUpdate.set(symbol, Date.now());
            
            // Only update instruments that were loaded from contracts - DO NOT add new ones
            if (this.instruments.has(baseSymbol)) {
                // Update last update time
                const instrument = this.instruments.get(baseSymbol);
                instrument.lastUpdate = Date.now();
            }
            
            // Check if we already have this instrument from loaded contracts
            if (this.validInstruments.has(baseSymbol)) {
                // Update the contract ID mapping if this is a new contract month
                const contracts = this.validInstruments.get(baseSymbol);
                const hasContract = contracts.some(c => c.contractId === symbol);
                if (!hasContract && symbol !== baseSymbol) {
                    // This is a new contract month for an existing symbol
                    // Find the first contract to copy details from
                    const templateContract = contracts[0];
                    if (templateContract) {
                        contracts.push({
                            contractId: symbol,
                            symbol: baseSymbol,
                            name: templateContract.name,
                            exchange: templateContract.exchange,
                            tickSize: templateContract.tickSize,
                            pointValue: templateContract.pointValue,
                            currency: templateContract.currency,
                            isActive: true
                        });
                        this.log(`✅ Added new contract month ${symbol} for ${baseSymbol}`);
                    }
                }
            }
            
            // Log market data heartbeat once per minute per instrument
            const now = Date.now();
            const lastLogged = this.lastLoggedUpdate.get(baseSymbol) || 0;
            const ONE_MINUTE = 60 * 1000;
            
            if (now - lastLogged > ONE_MINUTE) {
                this.log(`📊 Market data heartbeat - ${baseSymbol}: $${price.toFixed(2)}`);
                this.lastLoggedUpdate.set(baseSymbol, now);
            }
            
            
            // Update position P&L if we have a position
            if (this.positions.has(baseSymbol)) {
                this.updatePositionPnL(baseSymbol);
            }
            
            // Silenced per-update logging - only heartbeat logs are shown
            // this.log(`Market data update: ${baseSymbol} = $${price.toFixed(2)} (contract: ${symbol})`);
        }
    }

    startPriceFetchInterval() {
        this.log('Starting price fetch interval for stale data...');
        
        // Also start a position price update interval
        setInterval(() => {
            for (const [positionKey, position] of this.positions.entries()) {
                // Try to get current price using various keys
                let currentPrice = this.marketPrices.get(position.instrument);
                if (!currentPrice) {
                    // Try base symbol
                    const baseSymbol = position.instrument?.split('.').pop()?.replace(/[0-9]/g, '');
                    currentPrice = this.marketPrices.get(baseSymbol);
                }
                if (currentPrice && position.currentPrice !== currentPrice) {
                    position.currentPrice = currentPrice;
                    this.updatePositionPnL(positionKey);
                }
            }
        }, 1000); // Update every second
        
        this.priceFetchInterval = setInterval(async () => {
            const now = Date.now();
            
            for (const [symbol, position] of this.positions) {
                if (position.quantity === 0) continue;
                
                const lastUpdate = this.lastPriceUpdate.get(symbol) || 0;
                const age = now - lastUpdate;
                
                // Fetch price if older than 5 seconds
                if (age > 5000) {
                    // Connection Manager doesn't provide HTTP market data endpoints
                    // Market data comes via Redis pub/sub, so we'll just wait for the next update
                    // No action needed here - Redis subscription will update prices when available
                }
            }
        }, 2000); // Check every 2 seconds
    }
    
    startMarketDataHealthCheck() {
        // Run health check every minute
        setInterval(() => {
            const now = Date.now();
            const ONE_MINUTE = 60 * 1000;
            let activeCount = 0;
            let staleCount = 0;
            let noDataCount = 0;
            
            console.log('📊 === Market Data Health Check ===');
            console.log(`   Time: ${new Date().toLocaleString()}`);
            console.log(`   Total instruments: ${this.instruments.size}`);
            
            for (const [symbol, instrument] of this.instruments) {
                const hasPrice = this.marketPrices.has(symbol);
                const price = this.marketPrices.get(symbol);
                const lastUpdate = this.lastPriceUpdate.get(symbol);
                
                if (!hasPrice || !price) {
                    noDataCount++;
                } else if (lastUpdate && (now - lastUpdate) < ONE_MINUTE) {
                    activeCount++;
                } else {
                    staleCount++;
                }
            }
            
            console.log(`   ✅ Active (data < 1min): ${activeCount}`);
            console.log(`   ⚠️  Stale (data > 1min): ${staleCount}`);
            console.log(`   ❌ No data: ${noDataCount}`);
            
            // Show details for instruments without recent data
            if (staleCount > 0 || noDataCount > 0) {
                console.log('   📋 Instruments needing attention:');
                for (const [symbol, instrument] of this.instruments) {
                    const hasPrice = this.marketPrices.has(symbol);
                    const lastUpdate = this.lastPriceUpdate.get(symbol);
                    
                    if (!hasPrice) {
                        console.log(`      ❌ ${symbol}: No data received`);
                    } else if (lastUpdate && (now - lastUpdate) > ONE_MINUTE) {
                        const ageSeconds = Math.floor((now - lastUpdate) / 1000);
                        console.log(`      ⚠️  ${symbol}: Last update ${ageSeconds}s ago`);
                    }
                }
            }
            
            console.log('📊 === End Health Check ===\n');
        }, 60000); // Every minute
    }

    getContractMultiplier(instrument) {
        // Extract base symbol from instrument ID (e.g., CON.F.US.MGC.Q25 -> MGC)
        let baseSymbol = instrument;
        if (instrument.includes('.')) {
            const parts = instrument.split('.');
            // Get the symbol part (e.g., MGC from CON.F.US.MGC.Q25)
            baseSymbol = parts[3] || instrument;
        }
        
        // Micro futures contract multipliers
        const multipliers = {
            'MGC': 10,     // Micro Gold - $10 per point
            'MNQ': 2,      // Micro NASDAQ - $2 per point
            'MES': 5,      // Micro S&P 500 - $5 per point
            'MCL': 10,     // Micro Crude Oil - $10 per point
            'M2K': 5,      // Micro Russell 2000 - $5 per point
            'MYM': 0.50,   // Micro Dow - $0.50 per point
            'M6E': 12.50,  // Micro Euro - $12.50 per point
            'M6B': 6.25,   // Micro British Pound - $6.25 per point
            'MBT': 10      // Micro Bitcoin - $10 per point
        };
        
        return multipliers[baseSymbol] || 1;
    }

    getEstimatedPrice(baseSymbol) {
        // Typical price ranges for instruments (used when market data unavailable)
        // These are rough estimates for price calculation only
        const estimatedPrices = {
            'MGC': 2000,    // Gold around $2000/oz
            'MNQ': 15000,   // NASDAQ around 15000
            'MES': 4500,    // S&P 500 around 4500
            'MCL': 80,      // Crude Oil around $80
            'M2K': 2000,    // Russell 2000 around 2000
            'MYM': 35000,   // Dow around 35000
            'M6E': 1.10,    // Euro around 1.10
            'M6B': 1.25,    // GBP around 1.25
            'MBT': 50000    // Bitcoin around $50000
        };
        
        return estimatedPrices[baseSymbol] || 1000; // Default fallback
    }

    updatePositionPnL(positionKey) {
        const position = this.positions.get(positionKey);
        if (!position || position.quantity === 0) return;
        
        // Try to get current price using various keys
        let currentPrice = this.marketPrices.get(position.instrument);
        if (!currentPrice) {
            // Try base symbol
            const baseSymbol = position.instrument.split('.').pop()?.replace(/[0-9]/g, '');
            currentPrice = this.marketPrices.get(baseSymbol);
        }
        if (!currentPrice) return;
        
        position.currentPrice = currentPrice;
        
        // Get contract multiplier
        const multiplier = this.getContractMultiplier(position.instrument);
        
        // Calculate unrealized P&L based on position direction
        if (position.side === 'LONG') {
            // Long position: profit when price goes up
            position.unrealizedPnL = (currentPrice - position.avgPrice) * position.quantity * multiplier;
        } else {
            // Short position: profit when price goes down
            position.unrealizedPnL = (position.avgPrice - currentPrice) * position.quantity * multiplier;
        }
        
        // Silent operation - P&L updates logged internally
        // this.log(`P&L Update - ${positionKey}: Qty=${position.quantity}, AvgPrice=$${position.avgPrice.toFixed(2)}, CurrentPrice=$${currentPrice.toFixed(2)}, UnrealizedP&L=$${position.unrealizedPnL.toFixed(2)}`);
    }

    async handleOrderResponse(data) {
        this.log(`handleOrderResponse called with data:`, 'DEBUG');
        this.log(`  - OrderId: ${data.orderId}`, 'DEBUG');
        this.log(`  - Success: ${data.success}`, 'DEBUG');
        this.log(`  - TopStepOrderId: ${data.topStepOrderId}`, 'DEBUG');
        this.log(`  - Error: ${data.error}`, 'DEBUG');
        
        if (data.success && data.orderId) {
            // Update our order with TopStep order ID
            const order = this.orders.get(data.orderId);
            if (order) {
                order.topstepOrderId = data.topStepOrderId;
                order.status = 'PENDING';
                this.log(`Order ${data.orderId} submitted to TopStep with ID: ${data.topStepOrderId}`);
                
                // Connection Manager now handles all bracket order logic
                
                // Broadcast the order update to UI
                this.broadcastOrderUpdate(order);
            } else {
                this.log(`Warning: Order ${data.orderId} not found in local orders map`, 'WARN');
            }
        } else {
            // Handle order errors
            const order = this.orders.get(data.orderId);
            if (order) {
                order.status = 'FAILED';
                order.error = data.error;
                this.log(`Order ${data.orderId} failed: ${data.error}`, 'ERROR');
                
                // Broadcast the order update to UI
                this.broadcastOrderUpdate(order);
            } else {
                this.log(`Warning: Failed order ${data.orderId} not found in local orders map`, 'WARN');
            }
        }
    }

    async handleOrderFill(data) {
        console.log('🎯 handleOrderFill called with data:', JSON.stringify(data, null, 2));
        this.log(`🎯 ORDER FILL RECEIVED - This should trigger position update`);
        this.log(`Order fill received: ${JSON.stringify(data)}`);
        
        const { orderId, filledPrice, filledQuantity, instrument, positionId, accountId } = data;
        console.log(`   - Order ID: ${orderId}`);
        console.log(`   - Account ID: ${accountId}`);
        console.log(`   - Position ID: ${positionId}`);
        console.log(`   - Filled Price: ${filledPrice}`);
        console.log(`   - Filled Quantity: ${filledQuantity}`);
        
        // Try to find the order - check both with and without account prefix
        let order = this.orders.get(orderId);
        if (!order && accountId) {
            // Try with account prefix
            const orderKey = `${accountId}_${orderId}`;
            order = this.orders.get(orderKey);
            console.log(`   - Trying with account prefix: ${orderKey}`);
        }
        
        if (order) {
            console.log('✅ Found matching order in orders map');
            order.status = 'FILLED';
            order.filledTime = Date.now();
            order.filledPrice = filledPrice;
            order.positionId = positionId; // Store position ID from TopStep
            
            // Update position with actual fill price AND accountId
            await this.updatePosition(instrument, order.side, filledQuantity, filledPrice, accountId);
            
            // SL/TP is now handled by Trading Aggregator automatically
            // It stores the points from the order and applies them after the fill
            if (positionId && (order.stopLoss || order.takeProfit)) {
                console.log('🎯 Order has SL/TP values - Trading Aggregator will handle application');
                console.log(`   - Stop Loss: ${order.stopLoss} points`);
                console.log(`   - Take Profit: ${order.takeProfit} points`);
            }
            
            // Position was just updated, no need for additional broadcast here
            // The updatePosition method already handles the broadcast
            
            // Update the position record with basic fill information
            const positionSide = order.side === 'BUY' ? 'LONG' : 'SHORT';
            const positionKey = instrument;
            const position = this.positions.get(positionKey);
            if (position && positionId) {
                position.positionId = positionId;
                position.orderId = orderId;  // Store orderId for future manual SL/TP updates
            }
        }
    }

    /**
     * Handle SL/TP update after order fill
     * This method applies SL/TP values that were stored with the order
     */
    async handleFillAndUpdateSLTP(order, positionId, filledPrice) {
        try {
            console.log('🎯 handleFillAndUpdateSLTP called for position:', positionId);
            this.log(`Applying SL/TP for position ${positionId} from order ${order.orderId}`);
            
            const { stopLoss, takeProfit, side, instrument } = order;
            
            // Calculate actual stop loss and take profit prices from the stored values
            let stopLossPrice = null;
            let takeProfitPrice = null;
            
            if (stopLoss) {
                if (side === 'BUY') {
                    // Long position: stop loss below entry price
                    stopLossPrice = filledPrice - stopLoss;
                } else {
                    // Short position: stop loss above entry price  
                    stopLossPrice = filledPrice + stopLoss;
                }
                console.log(`📉 Calculated Stop Loss: $${stopLossPrice.toFixed(2)} (${stopLoss} points from entry $${filledPrice.toFixed(2)})`);
            }
            
            if (takeProfit) {
                if (side === 'BUY') {
                    // Long position: take profit above entry price
                    takeProfitPrice = filledPrice + takeProfit;
                } else {
                    // Short position: take profit below entry price
                    takeProfitPrice = filledPrice - takeProfit;
                }
                console.log(`📈 Calculated Take Profit: $${takeProfitPrice.toFixed(2)} (${takeProfit} points from entry $${filledPrice.toFixed(2)})`);
            }
            
            // Update position using the existing TopStep API integration
            if (stopLossPrice || takeProfitPrice) {
                console.log('📤 Calling updateStopLossTakeProfit...');
                const result = await this.updateStopLossTakeProfit(positionId, stopLossPrice, takeProfitPrice);
                
                // Update local position data
                const position = this.positions.get(instrument);
                if (position) {
                    if (stopLossPrice) position.stopLoss = stopLossPrice;
                    if (takeProfitPrice) position.takeProfit = takeProfitPrice;
                    console.log('✅ Updated local position with SL/TP values');
                }
                
                console.log('✅ SL/TP successfully applied after fill');
                this.log(`SL/TP applied to position ${positionId}: SL=${stopLossPrice?.toFixed(2) || 'none'}, TP=${takeProfitPrice?.toFixed(2) || 'none'}`);
                
                // Refresh positions after SL/TP update completes
                console.log('🔄 Refreshing positions after SL/TP update...');
                setTimeout(async () => {
                    try {
                        await this.loadExistingPositions();
                        console.log('✅ Positions refreshed successfully after SL/TP update');
                    } catch (error) {
                        console.error('❌ Error refreshing positions after SL/TP update:', error);
                    }
                }, 1000); // 1 second delay to ensure SL/TP is fully processed
            } else {
                console.log('⚠️ No SL/TP values to apply');
            }
            
        } catch (error) {
            console.error('❌ Error applying SL/TP after fill:', error);
            this.log(`Failed to apply SL/TP after fill: ${error.message}`, 'ERROR');
        }
    }

    async handleBracketOrderComplete(data) {
        const { instanceId, orderId, positionId, stopLoss, takeProfit, success, error } = data;
        
        // Only process if it's for our instance
        if (instanceId !== 'MANUAL_TRADING') {
            return;
        }
        
        if (success) {
            this.log(`✅ [BRACKET] SL/TP successfully applied by Connection Manager`);
            this.log(`   - Order ID: ${orderId}`);
            this.log(`   - Position ID: ${positionId}`);
            this.log(`   - Stop Loss: ${stopLoss || 'none'}`);
            this.log(`   - Take Profit: ${takeProfit || 'none'}`);
            
            // Update local position data if we have it
            const order = this.orders.get(orderId);
            if (order && order.instrument) {
                const position = this.positions.get(order.instrument);
                if (position) {
                    if (stopLoss) position.stopLoss = stopLoss;
                    if (takeProfit) position.takeProfit = takeProfit;
                    position.positionId = positionId;
                    this.log(`📊 Updated local position data with SL/TP values`);
                }
            }
        } else {
            this.log(`❌ [BRACKET] Failed to apply SL/TP: ${error}`, 'ERROR');
            this.log(`   - Order ID: ${orderId}`);
        }
    }

    async handlePositionUpdate(data) {
        this.log(`📊 POSITION UPDATE RECEIVED - This should update/close positions`);
        this.log(`Position update received: ${JSON.stringify(data)}`);
        
        const { instrument, netPosition, avgPrice, accountId, side } = data;
        
        // If we don't have the side, try to infer it from the net position
        const positionSide = side || (netPosition > 0 ? 'LONG' : 'SHORT');
        const positionKey = instrument;
        
        let position = this.positions.get(positionKey);
        if (!position) {
            position = {
                instrument,
                accountId,  // STORE THE ACCOUNT ID WITH NEW POSITIONS!
                side: positionSide,
                quantity: 0,
                avgPrice: 0,
                realizedPnL: 0,
                unrealizedPnL: 0,
                currentPrice: null,
                totalBought: 0,
                totalSold: 0,
                avgBuyPrice: 0,
                avgSellPrice: 0
            };
            this.positions.set(positionKey, position);
        }
        
        position.quantity = Math.abs(netPosition);  // Store absolute value
        position.avgPrice = avgPrice || position.avgPrice;
        
        // If position is closed, remove it from the map
        if (netPosition === 0) {
            this.log(`Position ${instrument} is now closed, removing from active positions`);
            this.positions.delete(positionKey);
        } else {
            // Calculate P&L with current market data
            this.updatePositionPnL(positionKey);
        }
    }

    updatePosition(instrument, side, quantity, price, accountId) {
        // Convert order side (BUY/SELL) to position side (LONG/SHORT)
        const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';
        const positionKey = instrument;
        
        let position = this.positions.get(positionKey);
        
        if (!position) {
            position = {
                instrument,
                accountId,  // STORE THE ACCOUNT ID!
                side: positionSide,
                quantity: 0,
                avgPrice: 0,
                realizedPnL: 0,
                unrealizedPnL: 0,
                currentPrice: null,
                totalBought: 0,
                totalSold: 0,
                avgBuyPrice: 0,
                avgSellPrice: 0
            };
            this.positions.set(positionKey, position);
        }
        
        if (side === 'BUY') {
            // Update average buy price
            const newTotalBought = position.totalBought + quantity;
            position.avgBuyPrice = ((position.totalBought * position.avgBuyPrice) + (quantity * price)) / newTotalBought;
            position.totalBought = newTotalBought;
            
            // Update position
            position.quantity += quantity;
            
            // Update average price based on position direction
            if (position.quantity > 0) {
                position.avgPrice = position.avgBuyPrice;
            }
        } else {
            // Update average sell price
            const newTotalSold = position.totalSold + quantity;
            position.avgSellPrice = ((position.totalSold * position.avgSellPrice) + (quantity * price)) / newTotalSold;
            position.totalSold = newTotalSold;
            
            // Update position
            position.quantity -= quantity;
            
            // Update average price based on position direction
            if (position.quantity < 0) {
                position.avgPrice = position.avgSellPrice;
            }
            
            // Calculate realized P&L if closing or reducing position
            if (position.totalBought > 0 && price && position.avgBuyPrice) {
                const realizedQuantity = Math.min(quantity, position.totalBought);
                const multiplier = this.getContractMultiplier(instrument);
                position.realizedPnL += (price - position.avgBuyPrice) * realizedQuantity * multiplier;
            }
        }
        
        this.log(`Position updated: ${instrument} ${position.quantity > 0 ? 'LONG' : position.quantity < 0 ? 'SHORT' : 'FLAT'} ${Math.abs(position.quantity)} @ ${position.avgPrice?.toFixed(2) || 'N/A'}`);
        
        // Remove position from map if quantity is zero (position closed)
        if (position.quantity === 0) {
            this.log(`Position closed for ${instrument}. Realized P&L: $${position.realizedPnL.toFixed(2)}`);
            this.positions.delete(instrument);
            // Broadcast position closed
            this.broadcastSSE({
                type: 'position-closed',
                instrument: instrument,
                accountId: accountId
            });
        } else {
            // Update P&L only if position still exists
            this.updatePositionPnL(instrument);
            // Broadcast position update
            this.broadcastPositionUpdate(instrument, position);
        }
    }

    async loadContracts() {
        this.log('Loading available contracts through Aggregator...');
        
        try {
            // Request contracts via Redis through aggregator
            const requestId = `manual-contracts-${Date.now()}`;
            
            // Subscribe to response first
            const contractPromise = new Promise((resolve) => {
                const timeout = setTimeout(() => resolve(null), 10000);
                
                this.redisSubscriber.subscribe('contract-response', (message) => {
                    try {
                        const response = JSON.parse(message);
                        if (response.requestId === requestId) {
                            clearTimeout(timeout);
                            resolve(response);
                        }
                    } catch (error) {
                        this.log(`Error parsing contract response: ${error.message}`, 'ERROR');
                    }
                });
            });
            
            // Send request to aggregator
            await this.redisClient.publish('aggregator:requests', JSON.stringify({
                type: 'GET_CONTRACTS',
                requestId: requestId,
                responseChannel: 'contract-response'
            }));
            
            const response = await contractPromise;
            
            if (response && response.success && response.contracts) {
                this.log(`✅ Loaded ${response.contracts.length} contracts via Aggregator`);
                
                // Clear BOTH maps to prevent stale data
                this.validInstruments.clear();
                this.instruments.clear();
                this.log(`🧹 Cleared both validInstruments and instruments maps`);
                
                // Process each contract
                response.contracts.forEach(contract => {
                    // Debug log to see what we're getting
                    if (response.contracts.indexOf(contract) === 0) {
                        this.log(`🔍 First contract structure: ${JSON.stringify(contract)}`);
                    }
                    const symbol = contract.symbol || contract.symbolId;
                    if (!this.validInstruments.has(symbol)) {
                        this.validInstruments.set(symbol, []);
                    }
                    
                    // Add contract with full details FROM API ONLY
                    this.validInstruments.get(symbol).push({
                        contractId: contract.contractId,
                        symbol: symbol,
                        name: contract.name,
                        exchange: contract.exchange,
                        tickSize: contract.tickSize,
                        pointValue: contract.pointValue,
                        currency: contract.currency,
                        expirationDate: contract.expirationDate,
                        isActive: contract.isActive !== false
                    });
                    
                    // Also add to instruments map for immediate use
                    if (!this.instruments.has(symbol)) {
                        this.instruments.set(symbol, {
                            symbol: symbol,
                            name: contract.name,
                            exchange: contract.exchange,
                            type: 'Future',
                            tickSize: contract.tickSize,
                            pointValue: contract.pointValue,
                            currency: contract.currency,
                            lastUpdate: Date.now()
                        });
                    }
                    
                    this.log(`  ✅ ${symbol}: ${contract.contractId} (tick: ${contract.tickSize}, point: ${contract.pointValue})`);
                });
                
                // Update any instruments that were added before contracts loaded
                for (const [symbol, instrument] of this.instruments) {
                    if (instrument.pendingContractLoad || instrument.notInContracts) {
                        const contracts = this.validInstruments.get(symbol);
                        if (contracts && contracts.length > 0) {
                            const contract = contracts[0];
                            // Update with proper contract details FROM API ONLY
                            instrument.name = contract.name;
                            instrument.exchange = contract.exchange;
                            instrument.tickSize = contract.tickSize;
                            instrument.pointValue = contract.pointValue;
                            instrument.currency = contract.currency;
                            delete instrument.pendingContractLoad;
                            delete instrument.notInContracts;
                            this.log(`📝 Updated ${symbol} with contract details`);
                        }
                    }
                }
                
                // Log final state
                this.log(`✅ Final validInstruments size: ${this.validInstruments.size}`);
                this.log(`✅ Final instruments size: ${this.instruments.size}`);
                
                // Unsubscribe from response channel
                await this.redisSubscriber.unsubscribe('contract-response');
                
                return response.contracts;
            } else {
                this.log('❌ Failed to load contracts via Aggregator - no response or invalid data', 'ERROR');
                if (response) {
                    this.log(`❌ Response details: success=${response.success}, contracts=${response.contracts}`, 'ERROR');
                } else {
                    this.log('❌ No response received from aggregator', 'ERROR');
                }
                // Unsubscribe from response channel
                await this.redisSubscriber.unsubscribe('contract-response');
                return [];
            }
            
        } catch (error) {
            this.log(`❌ Error loading contracts: ${error.message}`, 'ERROR');
            try {
                await this.redisSubscriber.unsubscribe('contract-response');
            } catch (unsubError) {
                // Ignore unsubscribe errors
            }
            return [];
        }
    }
    
    async loadAccounts(forceFresh = false) {
        this.log(`Loading accounts through Aggregator... ${forceFresh ? '(forcing fresh data)' : ''}`);
        
        try {
            // Request accounts via Redis using the correct format for Connection Manager
            const requestId = `manual-acc-${Date.now()}`;
            
            // Subscribe to response first
            const accountPromise = new Promise((resolve) => {
                const timeout = setTimeout(() => resolve(null), 10000); // Increased timeout
                
                this.redisSubscriber.subscribe('account-response', (message) => {
                    try {
                        const data = JSON.parse(message);
                        console.log('📨 Raw account response received:', JSON.stringify(data, null, 2));
                        
                        // Handle both direct message and EventBroadcaster wrapped message
                        let accountData;
                        if (data.type === 'account-response' && data.payload) {
                            // EventBroadcaster wrapped message
                            accountData = data.payload;
                        } else {
                            // Direct message
                            accountData = data;
                        }
                        
                        if (accountData.requestId === requestId) {
                            clearTimeout(timeout);
                            console.log('✅ Found matching request ID, resolving with accounts:', accountData.accounts);
                            resolve(accountData.accounts);
                        }
                    } catch (e) {
                        console.error('❌ Error parsing account response:', e);
                    }
                });
            });
            
            // Request accounts through aggregator for consistent data flow
            // Add forceFresh flag to request fresh data from API instead of cache
            await this.redisClient.publish('aggregator:requests', JSON.stringify({
                type: 'GET_ACCOUNTS',
                requestId: requestId,
                forceFresh: forceFresh,
                responseChannel: 'account-response'  // Tell aggregator where to forward the response
            }));
            
            const accounts = await accountPromise;
            
            if (accounts && accounts.length > 0) {
                this.accounts = accounts;
                this.selectedAccount = accounts[0];
                this.log(`✅ Loaded ${accounts.length} accounts via Redis. Selected: ${this.selectedAccount.name || this.selectedAccount.id} (ID: ${this.selectedAccount.id})`);
                
                // Register account with Connection Manager for order event subscriptions
                await this.registerAccountWithConnectionManager(this.selectedAccount.id);
                
                // Log account details for debugging
                accounts.forEach((acc, index) => {
                    this.log(`  Account ${index + 1}: ${acc.name || acc.id} - Balance: $${acc.balance?.toFixed(2) || '0.00'} - CanTrade: ${acc.canTrade}`);
                });
            } else {
                this.log('⚠️ No accounts received from Connection Manager', 'WARN');
                this.log('💡 Make sure Connection Manager is authenticated with TopStep API');
                
                // No mock accounts - use empty array
                this.accounts = [];
                this.selectedAccount = null;
                this.log('❌ No accounts available - Connection Manager must be authenticated');
            }
        } catch (error) {
            this.log(`Failed to load accounts: ${error.message}`, 'ERROR');
            
            // No mock accounts - use empty array
            this.log('❌ Failed to load accounts - check Redis connection and Connection Manager');
            this.accounts = [];
            this.selectedAccount = null;
        }
    }

    startAccountRefreshInterval() {
        this.log('📊 Starting periodic account refresh (every 30 seconds)...');
        
        this.accountRefreshInterval = setInterval(async () => {
            try {
                // Store previous state
                const previousAccounts = [...this.accounts];
                const previousAccountIds = previousAccounts.map(acc => acc.id);
                const previousSelectedAccount = this.selectedAccount;
                
                // Refresh accounts
                await this.loadAccounts();
                
                // Get current account IDs
                const currentAccountIds = this.accounts.map(acc => acc.id);
                
                // Detect disappeared accounts (locked accounts that no longer appear)
                const disappearedAccounts = previousAccounts.filter(
                    prevAcc => !currentAccountIds.includes(prevAcc.id)
                );
                
                // Detect new accounts
                const newAccounts = this.accounts.filter(
                    currAcc => !previousAccountIds.includes(currAcc.id)
                );
                
                // Check if account list changed
                const accountListChanged = disappearedAccounts.length > 0 || 
                                         newAccounts.length > 0 || 
                                         previousAccounts.length !== this.accounts.length;
                
                if (accountListChanged) {
                    this.log(`🔄 Account list changed:`);
                    
                    // Log disappeared accounts (likely locked)
                    if (disappearedAccounts.length > 0) {
                        disappearedAccounts.forEach(acc => {
                            this.log(`❌ Account disappeared (likely locked): ${acc.name || acc.id} - Balance: $${acc.balance?.toFixed(2) || '0.00'}`, 'WARN');
                        });
                    }
                    
                    // Log new accounts
                    if (newAccounts.length > 0) {
                        newAccounts.forEach(acc => {
                            this.log(`✅ New account appeared: ${acc.name || acc.id} - Balance: $${acc.balance?.toFixed(2) || '0.00'}`);
                        });
                    }
                    
                    // Check if selected account disappeared
                    if (previousSelectedAccount && disappearedAccounts.some(acc => acc.id === previousSelectedAccount.id)) {
                        this.log(`🚨 WARNING: Selected account ${previousSelectedAccount.name || previousSelectedAccount.id} has disappeared!`, 'ERROR');
                        
                        // Select first available account if any exist
                        if (this.accounts.length > 0) {
                            this.selectedAccount = this.accounts[0];
                            this.log(`🔄 Auto-selected new account: ${this.selectedAccount.name || this.selectedAccount.id}`);
                        } else {
                            this.selectedAccount = null;
                            this.log(`⚠️ No accounts available for trading!`, 'WARN');
                        }
                    }
                    
                    // Notify about account list change via Redis
                    await this.broadcastAccountListChange();
                    
                    this.log(`📊 Account summary: ${previousAccounts.length} → ${this.accounts.length} accounts`);
                }
                
            } catch (error) {
                this.log(`❌ Failed to refresh accounts: ${error.message}`, 'ERROR');
            }
        }, 30000); // 30 seconds
        
        this.log('✅ Account refresh interval started');
    }
    
    startConnectionManagerHeartbeat() {
        this.log('💓 Starting Connection Manager heartbeat (every 30 seconds)...');
        
        // Send initial heartbeat
        this.sendHeartbeatToConnectionManager();
        
        // Send periodic heartbeats
        this.heartbeatInterval = setInterval(() => {
            this.sendHeartbeatToConnectionManager();
        }, 30000);
        
        this.log('✅ Connection Manager heartbeat started');
    }
    
    async sendHeartbeatToConnectionManager() {
        // Manual trading should not communicate directly with connection manager
        // All communication should go through the aggregator
        // This function is kept for backward compatibility but does nothing
    }
    
    startPositionSyncInterval() {
        // Silent position sync every 2 seconds to catch any missed changes
        // This is a safety net - real-time updates come from events and market data
        this.positionSyncInterval = setInterval(async () => {
            try {
                // Use silent mode to avoid log spam
                await this.loadExistingPositions(true);
            } catch (error) {
                // Silent fail - don't log errors to avoid spam
                // Only log if it's a critical error
                if (error.message && error.message.includes('ECONNREFUSED')) {
                    // Connection lost - log once
                    if (!this.lastConnectionError || Date.now() - this.lastConnectionError > 60000) {
                        this.log('⚠️ Lost connection to aggregator/connection manager', 'WARN');
                        this.lastConnectionError = Date.now();
                    }
                }
            }
        }, 30000); // Every 30 seconds
    }

    async registerAccountWithConnectionManager(accountId) {
        // Manual trading should not register directly with connection manager
        // All communication should go through the aggregator
        // This function is kept for backward compatibility but does nothing
        this.log(`✅ Account ${accountId} registered for order event subscriptions`);
    }

    async broadcastAccountListChange() {
        try {
            // Broadcast account list change notification via Redis
            await this.redisClient.publish('accounts:updated', JSON.stringify({
                type: 'accounts-list-changed',
                timestamp: new Date().toISOString(),
                accounts: this.accounts.map(acc => ({
                    id: acc.id,
                    name: acc.name,
                    balance: acc.balance,
                    canTrade: acc.canTrade
                })),
                selectedAccountId: this.selectedAccount?.id || null,
                source: 'manual-trading-v2'
            }));
            
            this.log('📡 Broadcasted account list change notification');
        } catch (error) {
            this.log(`❌ Failed to broadcast account list change: ${error.message}`, 'ERROR');
        }
    }

    async broadcastOrdersUpdate() {
        try {
            // Convert orders map to array for broadcasting
            const ordersArray = Array.from(this.orders.values());
            
            // Broadcast all orders update via Redis
            await this.redisClient.publish('orders:updated', JSON.stringify({
                type: 'orders-update',
                timestamp: new Date().toISOString(),
                orders: ordersArray,
                totalOrders: ordersArray.length,
                source: 'manual-trading-v2'
            }));
            
            this.log(`📡 Broadcasted ${ordersArray.length} orders update`);
        } catch (error) {
            this.log(`❌ Failed to broadcast orders update: ${error.message}`, 'ERROR');
        }
    }

    broadcastOrderUpdate(order) {
        try {
            // Broadcast individual order update via Redis
            this.redisClient.publish('orders:updated', JSON.stringify({
                type: 'order-update',
                timestamp: new Date().toISOString(),
                order: order,
                source: 'manual-trading-v2'
            }));
            
            this.log(`📡 Broadcasted order update for ${order.orderId}`);
        } catch (error) {
            this.log(`❌ Failed to broadcast order update: ${error.message}`, 'ERROR');
        }
    }
    
    broadcastPositionUpdate(instrument, position) {
        try {
            // Broadcast position update via Redis
            this.redisClient.publish('positions:updated', JSON.stringify({
                type: 'position-update',
                timestamp: new Date().toISOString(),
                instrument: instrument,
                position: position,
                source: 'manual-trading-v2'
            }));
            
            // Also broadcast via SSE to connected clients
            this.broadcastSSE({
                type: 'position-update',
                instrument: instrument,
                position: position
            });
            
            this.log(`📡 Broadcasted position update for ${instrument}`);
        } catch (error) {
            this.log(`❌ Failed to broadcast position update: ${error.message}`, 'ERROR');
        }
    }
    
    broadcastSSE(data) {
        if (!this.sseClients) return;
        
        const message = `data: ${JSON.stringify(data)}\n\n`;
        const deadClients = [];
        
        this.sseClients.forEach(client => {
            try {
                client.write(message);
            } catch (error) {
                // Client disconnected
                deadClients.push(client);
            }
        });
        
        // Clean up disconnected clients
        deadClients.forEach(client => this.sseClients.delete(client));
    }

    async loadValidInstruments() {
        this.log('🔄 Loading valid instruments...');
        this.log(`📊 Current validInstruments size: ${this.validInstruments.size}`);
        
        // Re-enabled Connection Manager integration with fixed request type
        try {
            // Request instruments through Trading Aggregator
            const requestId = `manual-inst-${Date.now()}`;
            const responseChannel = `manual-trading:instrument-response:${requestId}`;
            
            // Create promise for instrument response with proper async handling
            const instrumentPromise = new Promise(async (resolve, reject) => {
                let timeout;
                
                try {
                    // Subscribe to response channel
                    this.redisSubscriber.subscribe(responseChannel, (message) => {
                        try {
                            const data = JSON.parse(message);
                            this.log('📨 Raw instrument response received:', JSON.stringify(data, null, 2));
                            
                            // Handle both direct message and EventBroadcaster wrapped message
                            let instrumentData;
                            if (data.type === 'instrument-response' && data.payload) {
                                // EventBroadcaster wrapped message
                                instrumentData = data.payload;
                            } else {
                                // Direct message
                                instrumentData = data;
                            }
                            
                            if (instrumentData.requestId === requestId) {
                                this.log('✅ Found matching request ID, processing instruments...');
                                clearTimeout(timeout);
                                this.redisSubscriber.unsubscribe(responseChannel);
                                resolve(instrumentData.contracts || instrumentData.instruments || []);
                            }
                        } catch (e) {
                            this.log(`❌ Error parsing instrument response: ${e.message}`, 'ERROR');
                        }
                    });
                    this.log(`✅ Subscribed to ${responseChannel} channel`);
                    
                    // Set timeout AFTER setting up the listener and subscription
                    timeout = setTimeout(() => {
                        this.log('⚠️ Instrument request timed out, using default instruments');
                        this.redisSubscriber.unsubscribe(responseChannel);
                        resolve(null);
                    }, 10000);
                    
                    // Now publish the request through Trading Aggregator
                    await this.redisClient.publish('aggregator:requests', JSON.stringify({
                        type: 'GET_ACTIVE_CONTRACTS',  // Fixed: Use correct request type
                        requestId: requestId,
                        responseChannel: responseChannel,
                        timestamp: Date.now()
                    }));
                    this.log(`📤 Published instrument request through aggregator with ID: ${requestId}`);
                    
                } catch (err) {
                    this.log(`Failed to setup instrument request: ${err.message}`, 'ERROR');
                    if (timeout) clearTimeout(timeout);
                    this.redisSubscriber.unsubscribe(responseChannel);
                    resolve(null);
                }
            });
            
            const contracts = await instrumentPromise;
            
            if (contracts && Array.isArray(contracts)) {
                // Clear existing and populate with new data
                this.validInstruments.clear();
                
                contracts.forEach(contract => {
                    const symbol = contract.symbol || contract.instrument;
                    if (!this.validInstruments.has(symbol)) {
                        this.validInstruments.set(symbol, []);
                    }
                    // Store the full contract info including contractId
                    this.validInstruments.get(symbol).push({
                        contractId: contract.contractId,
                        symbol: symbol,
                        name: contract.name,
                        exchange: contract.exchange,
                        tickSize: contract.tickSize,
                        pointValue: contract.pointValue,
                        expirationDate: contract.expirationDate,
                        rolloverDate: contract.rolloverDate
                    });
                });
                
                this.log(`✅ Loaded ${contracts.length} valid contracts from Connection Manager`);
                this.log(`📈 Total unique instruments: ${this.validInstruments.size}`);
                
                // Log summary
                for (const [symbol, contractList] of this.validInstruments) {
                    this.log(`  📄 ${symbol}: ${contractList.length} active contracts`);
                    contractList.forEach((contract, i) => {
                        if (i < 2) { // Only log first 2 contracts per symbol to avoid spam
                            this.log(`    └─ ${contract.contractId} (exp: ${contract.expirationDate})`);
                        }
                    });
                }
                
                // Subscribe to market data for all loaded instruments
                const allContracts = [];
                for (const [symbol, contractList] of this.validInstruments) {
                    for (const contract of contractList) {
                        allContracts.push(contract.contractId);
                    }
                }
                
                // Subscribe to market data asynchronously (don't wait)
                this.subscribeToMarketData(allContracts).catch(error => {
                    this.log(`Error subscribing to market data: ${error.message}`, 'WARN');
                });
            } else {
                this.log('⚠️ No instruments received from Connection Manager', 'WARN');
                this.log('💡 Using default instrument configuration');
                
                // Provide default instruments based on current date
                this.loadDefaultInstruments();
            }
        } catch (error) {
            this.log(`Failed to load instruments: ${error.message}`, 'ERROR');
            this.loadDefaultInstruments();
        }
    }

    loadDefaultInstruments() {
        // Calculate current and next month codes
        const now = new Date();
        const currentYear = now.getFullYear().toString().slice(-2);
        const nextMonthDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const nextYear = nextMonthDate.getFullYear().toString().slice(-2);
        
        const monthCodes = ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'];
        const currentMonthCode = monthCodes[now.getMonth()];
        const nextMonthCode = monthCodes[nextMonthDate.getMonth()];
        
        // Set default active contracts for each instrument
        const defaultInstruments = {
            'MGC': [currentMonthCode + currentYear, nextMonthCode + nextYear],
            'MNQ': [currentMonthCode + currentYear, nextMonthCode + nextYear],
            'MES': [currentMonthCode + currentYear, nextMonthCode + nextYear],
            'MCL': [currentMonthCode + currentYear, nextMonthCode + nextYear],
            'M2K': [currentMonthCode + currentYear, nextMonthCode + nextYear],
            'MYM': [currentMonthCode + currentYear, nextMonthCode + nextYear],
            'M6E': [currentMonthCode + currentYear, nextMonthCode + nextYear],
            'M6B': [currentMonthCode + currentYear, nextMonthCode + nextYear],
            'MBT': [currentMonthCode + currentYear, nextMonthCode + nextYear],
            'MSI': [currentMonthCode + currentYear, nextMonthCode + nextYear],
            'M6A': [currentMonthCode + currentYear, nextMonthCode + nextYear],
            'MHG': [currentMonthCode + currentYear, nextMonthCode + nextYear],
            'MNG': [currentMonthCode + currentYear, nextMonthCode + nextYear],
            'MET': [currentMonthCode + currentYear, nextMonthCode + nextYear]
        };
        
        this.validInstruments.clear();
        
        for (const [symbol, months] of Object.entries(defaultInstruments)) {
            const contracts = months.map(monthYear => ({
                symbol: symbol,
                contractId: `CON.F.US.${symbol}.${monthYear}`,
                monthYear: monthYear,
                isActive: true
            }));
            
            this.validInstruments.set(symbol, contracts);
        }
        
        this.log('✅ Loaded default instruments for current and next month');
        this.log(`📈 Total default instruments: ${this.validInstruments.size}`);
        
        // Log default instrument summary
        for (const [symbol, contractList] of this.validInstruments) {
            this.log(`  📄 ${symbol}: ${contractList.length} default contracts`);
        }
        
        // Subscribe to market data for all loaded instruments
        const allContracts = [];
        for (const [symbol, contractList] of this.validInstruments) {
            for (const contract of contractList) {
                allContracts.push(contract.contractId);
            }
        }
        
        // Subscribe to market data asynchronously (don't wait)
        this.subscribeToMarketData(allContracts).catch(error => {
            this.log(`Error subscribing to market data: ${error.message}`, 'WARN');
        });
    }

    buildContractId(symbol, monthYear) {
        // Build TopStep contract ID format: CON.F.US.SYMBOL.MONTHYEAR
        return `CON.F.US.${symbol}.${monthYear}`;
    }

    getActiveContractForSymbol(symbol) {
        const contracts = this.validInstruments.get(symbol);
        if (!contracts || contracts.length === 0) {
            // If no valid contracts, return current month as fallback
            const now = new Date();
            const monthCodes = ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'];
            const monthYear = monthCodes[now.getMonth()] + now.getFullYear().toString().slice(-2);
            return this.buildContractId(symbol, monthYear);
        }
        
        // Return the first active contract (typically current month)
        return contracts[0].contractId || this.buildContractId(symbol, contracts[0].monthYear);
    }

    // Method for manual SL/TP updates only - NOT for automatic application after fills
    // SL/TP are now handled in one step during order placement
    async updateStopLossTakeProfit(positionId, stopLoss, takeProfit, maxRetries = 3) {
        // Enhanced logging for test validation
        this.log(`📋 [SL/TP-UPDATE] Starting SL/TP update for positionId: ${positionId}`);
        this.log(`📋 [SL/TP-UPDATE] Request values - SL: ${stopLoss}, TP: ${takeProfit}`);
        
        const payload = {
            'positionId': positionId,
            'stopLoss': stopLoss !== undefined && stopLoss !== null ? Math.round(stopLoss * 100) / 100 : null,
            'takeProfit': takeProfit !== undefined && takeProfit !== null ? Math.round(takeProfit * 100) / 100 : null
        };
        
        // Log the exact request being sent (matching Python debug format)
        this.log(`[DEBUG] Payload SL/TP: ${JSON.stringify(payload)}`);
        this.log(`📋 [SL/TP-UPDATE] Routing through Connection Manager (max retries: ${maxRetries})`);
        
        let lastError = null;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                this.log(`🔄 [SL/TP-RETRY] Attempt ${attempt}/${maxRetries}`);
                const startTime = Date.now();
                const requestId = `manual-sltp-${Date.now()}-${attempt}`;
                const responseChannel = `sltp-response:${requestId}`;
                
                // Subscribe to unique response channel first
                const slTpPromise = new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        this.redisSubscriber.unsubscribe(responseChannel);
                        reject(new Error('SL/TP update request timeout'));
                    }, 15000); // 15 second timeout for SL/TP updates
                    
                    this.redisSubscriber.subscribe(responseChannel, (message) => {
                        try {
                            const data = JSON.parse(message);
                            this.log('📨 Raw SL/TP response received:', JSON.stringify(data, null, 2));
                            
                            clearTimeout(timeout);
                            this.redisSubscriber.unsubscribe(responseChannel);
                            
                            if (data.success) {
                                resolve(data.result || { success: true });
                            } else {
                                reject(new Error(data.error || 'SL/TP update failed'));
                            }
                        } catch (e) {
                            clearTimeout(timeout);
                            this.redisSubscriber.unsubscribe(responseChannel);
                            this.log(`Error parsing SL/TP response: ${e.message}`, 'ERROR');
                            reject(e);
                        }
                    });
                });
                
                this.log(`✅ Subscribed to unique response channel: ${responseChannel}`);
                
                // Publish request for SL/TP update through Trading Aggregator
                await this.redisClient.publish('aggregator:requests', JSON.stringify({
                    type: 'UPDATE_SLTP',
                    requestId: requestId,
                    responseChannel: responseChannel,
                    positionId: positionId,
                    stopLoss: payload.stopLoss,
                    takeProfit: payload.takeProfit,
                    attempt: attempt,
                    timestamp: Date.now()
                }));
                
                this.log(`📤 Published SL/TP update request with ID: ${requestId} (attempt ${attempt})`);
                
                // Wait for response
                const result = await slTpPromise;
                const duration = Date.now() - startTime;
                
                this.log(`[✅ SL/TP] SL: ${stopLoss} | TP: ${takeProfit} placed OK . (attempt ${attempt})`);
                this.log(`[📦 RESPONSE] ${JSON.stringify(result)}`);
                this.log(`✅ [BRACKET-TEST] Connection Manager Success (${duration}ms) on attempt ${attempt}`);
                
                // Update local position data if we have it
                if (this.positions) {
                    for (const [instrument, position] of this.positions) {
                        if (position.positionId === positionId) {
                            if (stopLoss !== undefined && stopLoss !== null) {
                                position.stopLoss = stopLoss;
                            }
                            if (takeProfit !== undefined && takeProfit !== null) {
                                position.takeProfit = takeProfit;
                            }
                            this.log(`📊 Updated local position data for ${instrument}`);
                            
                            // Broadcast position update to force UI refresh
                            this.broadcastPositionUpdate(instrument, position);
                            break;
                        }
                    }
                }
                
                return result;
                
            } catch (error) {
                lastError = error;
                this.log(`❌ [ERROR SL/TP] Attempt ${attempt}/${maxRetries} failed: ${error.message}`, 'ERROR');
                
                if (attempt < maxRetries) {
                    // Exponential backoff: 1s, 2s, 4s
                    const delayMs = Math.pow(2, attempt - 1) * 1000;
                    this.log(`⏳ [SL/TP-RETRY] Waiting ${delayMs}ms before retry...`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                } else {
                    this.log(`❌ [SL/TP-FINAL] All ${maxRetries} attempts failed. Last error: ${error.message}`, 'ERROR');
                }
            }
        }
        
        // If we get here, all retries failed
        this.log(`Failed to update SL/TP via Connection Manager after ${maxRetries} attempts: ${lastError.message}`, 'ERROR');
        throw lastError;
    }

    setupRoutes() {
        // Get accounts (with demo mode filtering)
        this.app.get('/api/accounts', async (req, res) => {
            try {
                this.log(`📊 /api/accounts requested. Total accounts in memory: ${this.accounts.length}`);
                if (this.accounts.length > 0) {
                    this.accounts.forEach((acc, index) => {
                        this.log(`  Account ${index + 1}: ${acc.name || 'NO NAME'} (ID: ${acc.id})`);
                    });
                }
                
                // Check demo mode status from control panel
                let filteredAccounts = this.accounts;
                
                try {
                    const http = require('http');
                    const demoModeResponse = await new Promise((resolve, reject) => {
                        const request = http.get('http://localhost:8080/api/demo-mode', (response) => {
                            let data = '';
                            response.on('data', chunk => data += chunk);
                            response.on('end', () => {
                                try {
                                    const parsed = JSON.parse(data);
                                    resolve(parsed);
                                } catch (e) {
                                    reject(e);
                                }
                            });
                        });
                        request.on('error', reject);
                        request.setTimeout(3000, () => {
                            request.destroy();
                            reject(new Error('Timeout'));
                        });
                    });
                    
                    // Filter accounts based on demo mode
                    if (demoModeResponse.demoOnlyMode) {
                        // Only allow practice accounts (names starting with "practice")
                        filteredAccounts = this.accounts.filter(account => {
                            const accountName = (account.name || '').toLowerCase();
                            const isPractice = accountName.startsWith('practice');
                            this.log(`🔍 Checking account: name="${account.name}", lowercase="${accountName}", isPractice=${isPractice}`);
                            return isPractice;
                        });
                        
                        this.log(`🛡️ Demo mode active: Filtered to ${filteredAccounts.length} practice accounts out of ${this.accounts.length} total accounts`);
                    } else {
                        // Live trading mode - allow all accounts
                        this.log(`⚠️ Live trading mode active: All ${this.accounts.length} accounts available`);
                    }
                } catch (error) {
                    // If we can't reach control panel, default to safe mode (demo only)
                    filteredAccounts = this.accounts.filter(account => {
                        const accountName = (account.name || '').toLowerCase();
                        return accountName.startsWith('practice');
                    });
                    this.log(`🛡️ Control panel unavailable - defaulting to demo mode: ${filteredAccounts.length} practice accounts`, 'WARN');
                }
                
                res.json(filteredAccounts);
            } catch (error) {
                this.log(`❌ Error filtering accounts: ${error.message}`, 'ERROR');
                res.status(500).json({ error: 'Failed to load accounts' });
            }
        });
        
        // Get active instruments
        this.app.get('/api/instruments/active', async (req, res) => {
            try {
                this.log('🔍 /api/instruments/active requested');
                this.log(`📊 Available instruments: validInstruments=${this.validInstruments.size}, instruments=${this.instruments.size}`);
                
                // Convert instruments Map to the format expected by UI
                const instruments = [];
                
                // Define instrument multipliers for UI display
                const instrumentMultipliers = {
                    'MGC': 10,  // Micro Gold - $10/pt
                    'MNQ': 2,   // Micro NASDAQ - $2/pt
                    'MES': 5,   // Micro S&P 500 - $5/pt
                    'MCL': 10,  // Micro Crude Oil - $10/pt
                    'M2K': 5,   // Micro Russell 2000 - $5/pt
                    'MYM': 0.5,   // Micro Dow - $0.50/pt
                    'M6E': 12.5, // Micro Euro - $12.5/pt
                    'M6B': 6.25, // Micro British Pound - $6.25/pt
                    'MBT': 0.1,  // Micro Bitcoin - $0.1/pt (corrected)
                    'MSI': 50,   // Micro Silver - $50/pt
                    'M6A': 10,   // Micro AUD/USD - $10/pt
                    'MHG': 12.5, // Micro Copper - $12.5/pt
                    'MNG': 250,  // Micro Natural Gas - $250/pt
                    'MET': 0.1,  // Micro Ether - $0.1/pt
                    'MCLE': 100, // Micro WTI Crude Oil E-mini - $100/pt
                    'SIL': 50,   // Silver - $50/pt
                    'MX6': 10,   // Micro AUD/USD - $10/pt
                    'GMET': 10   // Gold Metals - $10/pt
                };
                
                // Use validInstruments as the source of truth for all available instruments
                for (const [symbol, contractList] of this.validInstruments) {
                    // Get the instrument data from the instruments map if available
                    const instrumentData = this.instruments.get(symbol) || {};
                    
                    // Build contracts array from the contract list
                    const contracts = contractList.map(contract => {
                        let monthYear = '';
                        if (contract.contractId && contract.contractId.includes('.')) {
                            const parts = contract.contractId.split('.');
                            monthYear = parts[parts.length - 1] || '';
                        }
                        
                        return {
                            contractId: contract.contractId,
                            monthYear: monthYear,
                            expiration: contract.expirationDate || null,
                            isValid: contract.isActive !== false
                        };
                    });
                    
                    instruments.push({
                        symbol: symbol,
                        baseSymbol: symbol, // For backward compatibility
                        multiplier: contractList[0]?.pointValue || instrumentMultipliers[symbol],
                        tickSize: contractList[0]?.tickSize,
                        contracts: contracts,
                        defaultContract: contracts[0]?.contractId || symbol,
                        isValid: true
                    });
                    
                    this.log(`  ✅ ${symbol}: ${contracts.length} contracts, default: ${contracts[0]?.contractId || symbol}`);
                }
                
                this.log(`📤 Returning ${instruments.length} instruments to UI`);
                
                // If no instruments loaded from validInstruments, fallback to instruments map
                if (instruments.length === 0 && this.instruments.size > 0) {
                    this.log('⚠️ No validInstruments, falling back to instruments map', 'WARN');
                    
                    // Use the instruments map as fallback
                    for (const [symbol, instrumentData] of this.instruments) {
                        const contractId = instrumentData.contractId || symbol;
                        let monthYear = '';
                        if (contractId && contractId.includes('.')) {
                            const parts = contractId.split('.');
                            monthYear = parts[parts.length - 1] || '';
                        }
                        
                        instruments.push({
                            symbol: symbol,
                            baseSymbol: symbol,
                            multiplier: instrumentData.pointValue || instrumentMultipliers[symbol],
                            tickSize: instrumentData.tickSize,
                            contracts: [{
                                contractId: contractId,
                                monthYear: monthYear,
                                expiration: null,
                                isValid: true
                            }],
                            defaultContract: contractId,
                            isValid: true
                        });
                    }
                    
                    this.log(`📤 Using fallback: ${instruments.length} instruments from instruments map`);
                } else if (instruments.length === 0) {
                    this.log('⚠️ No instruments available in either map', 'WARN');
                }
                
                res.json({
                    success: true,
                    instruments: instruments
                });
            } catch (error) {
                this.log(`❌ Error in /api/instruments/active: ${error.message}`, 'ERROR');
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });
        
        // Get contracts for specific instrument
        this.app.get('/api/instruments/:symbol/contracts', async (req, res) => {
            try {
                const { symbol } = req.params;
                
                // Mock contract data for testing
                const mockContracts = {
                    'MGC': [
                        {
                            baseSymbol: 'MGC',
                            contractId: 'MGCZ24',
                            expiration: '2024-12-27',
                            tickSize: 0.1,
                            multiplier: 10,
                            isValid: true
                        },
                        {
                            baseSymbol: 'MGC',
                            contractId: 'MGCG25',
                            expiration: '2025-02-26',
                            tickSize: 0.1,
                            multiplier: 10,
                            isValid: true
                        }
                    ],
                    'MNQ': [
                        {
                            baseSymbol: 'MNQ',
                            contractId: 'MNQZ24',
                            expiration: '2024-12-20',
                            tickSize: 0.25,
                            multiplier: 2,
                            isValid: true
                        },
                        {
                            baseSymbol: 'MNQ',
                            contractId: 'MNQH25',
                            expiration: '2025-03-21',
                            tickSize: 0.25,
                            multiplier: 2,
                            isValid: true
                        }
                    ]
                };
                
                const contracts = mockContracts[symbol] || [];
                
                res.json({
                    success: true,
                    contracts: contracts
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });
        
        // Server-Sent Events endpoint for real-time updates
        this.app.get('/api/events', (req, res) => {
            // Set up SSE headers
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*'
            });
            
            // Send initial connection message
            res.write('data: {"type":"connected"}\n\n');
            
            // Store the response object for broadcasting
            if (!this.sseClients) {
                this.sseClients = new Set();
            }
            this.sseClients.add(res);
            
            // Clean up on disconnect
            req.on('close', () => {
                this.sseClients.delete(res);
            });
        });
        
        // Get current positions
        this.app.get('/api/positions', async (req, res) => {
            const positions = Array.from(this.positions.values());
            
            // Only log if not a silent request
            const silent = req.query.silent === 'true';
            if (!silent) {
                // Debug: Log what we're sending
                this.log(`📤 Sending ${positions.length} positions to client`);
                positions.forEach((pos, idx) => {
                    this.log(`  Position ${idx + 1}: instrument=${pos.instrument}, side=${pos.side}, accountId=${pos.accountId}, quantity=${pos.quantity}`);
                });
            }
            
            // Connection Manager doesn't provide HTTP market data endpoints
            // Current prices come via Redis market data subscription
            // Positions will show current price when market data is received
            
            res.json(positions);
        });
        
        // Refresh positions from Connection Manager
        this.app.post('/api/positions/refresh', async (req, res) => {
            try {
                const silent = req.query.silent === 'true' || req.body.silent === true;
                
                if (!silent) {
                    this.log('🔄 Refreshing positions from Connection Manager...');
                }
                
                // Clear existing positions
                this.positions.clear();
                
                // Request fresh positions from Connection Manager
                await this.loadExistingPositions(silent);
                
                // Return updated positions
                const positions = Array.from(this.positions.values());
                res.json({
                    success: true,
                    positions: positions,
                    count: positions.length
                });
            } catch (error) {
                this.log(`❌ Failed to refresh positions: ${error.message}`, 'ERROR');
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });
        
        // Get order history
        this.app.get('/api/orders', (req, res) => {
            const orders = Array.from(this.orders.values());
            res.json(orders.slice(-50)); // Last 50 orders
        });
        
        // Get current market prices
        this.app.get('/api/prices', (req, res) => {
            const prices = {};
            for (const [symbol, price] of this.marketPrices.entries()) {
                prices[symbol] = {
                    price: price,
                    timestamp: this.lastPriceUpdate.get(symbol)
                };
            }
            
            // Add debug info
            if (Object.keys(prices).length === 0) {
                this.log(`⚠️ No prices available in marketPrices Map`, 'WARN');
                this.log(`   - Map size: ${this.marketPrices.size}`, 'DEBUG');
                this.log(`   - Service identifier: MANUAL_TRADING`, 'DEBUG');
            }
            
            res.json(prices);
        });
        
        // Get current price for specific instrument
        this.app.get('/api/prices/:symbol', async (req, res) => {
            const { symbol } = req.params;
            
            // Try to find price by symbol first
            let price = this.marketPrices.get(symbol);
            let timestamp = this.lastPriceUpdate.get(symbol);
            
            // If not found, try to find by contract ID pattern
            if (price === undefined) {
                // Look for any contract ID that contains the symbol
                for (const [contractId, contractPrice] of this.marketPrices.entries()) {
                    if (contractId.includes(symbol)) {
                        price = contractPrice;
                        timestamp = this.lastPriceUpdate.get(contractId);
                        break;
                    }
                }
            }
            
            if (price !== undefined) {
                const response = {
                    symbol: symbol,
                    price: price,
                    timestamp: timestamp || Date.now()
                };
                this.log(`Price response for ${symbol}: $${price}`);
                res.json(response);
            } else {
                // Try to fetch from Connection Manager as fallback
                try {
                    const cmUrl = `http://localhost:7500/api/market-data/${symbol}`;
                    this.log(`No local price for ${symbol}, trying Connection Manager...`);
                    
                    const axios = require('axios');
                    const cmResponse = await axios.get(cmUrl, { timeout: 2000 });
                    
                    if (cmResponse.data && cmResponse.data.price) {
                        // Cache it locally for future requests
                        this.marketPrices.set(symbol, cmResponse.data.price);
                        this.lastPriceUpdate.set(symbol, Date.now());
                        
                        const response = {
                            symbol: symbol,
                            price: cmResponse.data.price,
                            timestamp: Date.now()
                        };
                        this.log(`Got price from Connection Manager for ${symbol}: $${cmResponse.data.price}`);
                        res.json(response);
                        return;
                    }
                } catch (error) {
                    this.log(`Failed to fetch price from Connection Manager: ${error.message}`, 'WARN');
                }
                
                this.log(`No price found for ${symbol}. Available: ${Array.from(this.marketPrices.keys()).join(', ')}`, 'WARN');
                res.status(404).json({
                    success: false,
                    error: `No price data available for ${symbol}`
                });
            }
        });
        
        // Place new order (with demo mode safety check)
        this.app.post('/api/order', async (req, res) => {
            try {
                const orderData = {
                    ...req.body,
                    accountId: req.body.accountId
                };
                
                // Safety check: Verify demo mode compliance before placing order
                try {
                    const http = require('http');
                    const demoModeResponse = await new Promise((resolve, reject) => {
                        const request = http.get('http://localhost:8080/api/demo-mode', (response) => {
                            let data = '';
                            response.on('data', chunk => data += chunk);
                            response.on('end', () => {
                                try {
                                    const parsed = JSON.parse(data);
                                    resolve(parsed);
                                } catch (e) {
                                    reject(e);
                                }
                            });
                        });
                        request.on('error', reject);
                        request.setTimeout(3000, () => {
                            request.destroy();
                            reject(new Error('Timeout'));
                        });
                    });
                    
                    // Check if demo mode is active and order is for a live account
                    if (demoModeResponse.demoOnlyMode) {
                        // Find the account for this order
                        const targetAccount = this.accounts.find(acc => acc.id == orderData.accountId);
                        if (targetAccount) {
                            const accountName = (targetAccount.name || '').toLowerCase();
                            if (!accountName.startsWith('practice')) {
                                this.log(`🛡️ Demo mode: BLOCKED order attempt on live account ${targetAccount.name} (ID: ${targetAccount.id})`, 'WARN');
                                return res.status(403).json({ 
                                    success: false, 
                                    error: 'Demo mode is active. Orders can only be placed on practice accounts.' 
                                });
                            }
                        }
                    }
                } catch (error) {
                    // If we can't reach control panel, default to safe mode (block all live accounts)
                    const targetAccount = this.accounts.find(acc => acc.id == orderData.accountId);
                    if (targetAccount) {
                        const accountName = (targetAccount.name || '').toLowerCase();
                        if (!accountName.startsWith('practice')) {
                            this.log(`🛡️ Control panel unavailable - BLOCKED order on live account ${targetAccount.name} for safety`, 'WARN');
                            return res.status(403).json({ 
                                success: false, 
                                error: 'Control panel unavailable. Orders blocked on live accounts for safety.' 
                            });
                        }
                    }
                }
                
                const result = await this.placeOrder(orderData);
                res.json(result);
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });
        
        // Update stop loss and take profit
        this.app.post('/api/update-sl-tp', async (req, res) => {
            try {
                const { positionId, stopLoss, takeProfit, maxRetries } = req.body;
                this.log(`🎯 [API] SL/TP update request: positionId=${positionId}, SL=${stopLoss}, TP=${takeProfit}, retries=${maxRetries || 3}`);
                
                if (!positionId) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Position ID is required' 
                    });
                }
                
                // Allow null values to clear SL/TP, but require at least one parameter to be provided
                if (stopLoss === undefined && takeProfit === undefined) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'At least one of stopLoss or takeProfit must be provided' 
                    });
                }
                
                // Find the position to update local data
                let foundPosition = null;
                for (const [instrument, position] of this.positions) {
                    if (position.positionId === positionId) {
                        foundPosition = position;
                        break;
                    }
                }
                
                if (!foundPosition) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Position not found. Please refresh and try again.' 
                    });
                }
                
                // Use positionId directly with TopStep API (with retry support)
                const result = await this.updateStopLossTakeProfit(positionId, stopLoss, takeProfit, maxRetries || 3);
                
                // Update local position data
                if (foundPosition) {
                    if (stopLoss !== undefined) foundPosition.stopLoss = stopLoss;
                    if (takeProfit !== undefined) foundPosition.takeProfit = takeProfit;
                }
                
                res.json({ success: true, result });
            } catch (error) {
                res.status(500).json({ 
                    success: false, 
                    error: error.message 
                });
            }
        });

        // Retry failed SL/TP update with new values
        this.app.post('/api/retry-sl-tp', async (req, res) => {
            try {
                const { positionId, newStopLoss, newTakeProfit, maxRetries } = req.body;
                this.log(`🔄 [API] SL/TP RETRY request: positionId=${positionId}, newSL=${newStopLoss}, newTP=${newTakeProfit}, retries=${maxRetries || 3}`);
                
                if (!positionId) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Position ID is required' 
                    });
                }
                
                // Find the position
                let foundPosition = null;
                for (const [instrument, position] of this.positions) {
                    if (position.positionId === positionId) {
                        foundPosition = position;
                        break;
                    }
                }
                
                if (!foundPosition) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Position not found. Please refresh and try again.' 
                    });
                }
                
                // Log current SL/TP values for reference
                this.log(`📊 [RETRY-INFO] Current SL/TP: SL=${foundPosition.stopLoss}, TP=${foundPosition.takeProfit}`);
                this.log(`📊 [RETRY-INFO] Requested new SL/TP: SL=${newStopLoss}, TP=${newTakeProfit}`);
                
                // Use new values or keep existing ones if not provided
                const finalStopLoss = newStopLoss !== undefined ? newStopLoss : foundPosition.stopLoss;
                const finalTakeProfit = newTakeProfit !== undefined ? newTakeProfit : foundPosition.takeProfit;
                
                // Attempt the retry with new or existing values
                const result = await this.updateStopLossTakeProfit(positionId, finalStopLoss, finalTakeProfit, maxRetries || 3);
                
                // Update local position data on success
                if (foundPosition) {
                    if (finalStopLoss !== undefined) foundPosition.stopLoss = finalStopLoss;
                    if (finalTakeProfit !== undefined) foundPosition.takeProfit = finalTakeProfit;
                }
                
                res.json({ 
                    success: true, 
                    result,
                    appliedValues: {
                        stopLoss: finalStopLoss,
                        takeProfit: finalTakeProfit
                    }
                });
            } catch (error) {
                res.status(500).json({ 
                    success: false, 
                    error: error.message 
                });
            }
        });
        
        // Close position (full or partial)
        this.app.post('/api/close-position', async (req, res) => {
            try {
                const { instrument, accountId, side, quantity, closeType } = req.body;
                this.log(`📤 Close position request received: instrument=${instrument}, accountId=${accountId}, side=${side}, quantity=${quantity}, closeType=${closeType}`);
                const result = await this.closePosition(instrument, quantity, closeType, accountId, side);
                res.json(result);
            } catch (error) {
                this.log(`❌ Close position error: ${error.message}`, 'ERROR');
                res.status(500).json({ success: false, error: error.message });
            }
        });
        
        // Debug endpoint to manually reload positions
        this.app.post('/api/debug/reload-positions', async (req, res) => {
            try {
                this.log('🔧 [DEBUG] Manual position reload requested');
                await this.loadExistingPositions();
                res.json({ 
                    success: true, 
                    message: 'Position reload attempted - check logs for details',
                    positionCount: this.positions.size,
                    positions: Array.from(this.positions.entries()).map(([key, pos]) => ({
                        key,
                        instrument: pos.instrument,
                        quantity: pos.quantity,
                        avgPrice: pos.avgPrice
                    }))
                });
            } catch (error) {
                res.status(500).json({ 
                    success: false, 
                    error: error.message 
                });
            }
        });

        // Test mode endpoint for UI development
        this.app.post('/api/test-mode', (req, res) => {
            const { action, data } = req.body;
            
            if (action === 'mock-order') {
                // Simulate order processing for UI testing
                this.log(`Test mode: simulating ${data.side} ${data.quantity} ${data.instrument}`, 'TEST');
                res.json({ 
                    success: true, 
                    orderId: `TEST_ORDER_${Date.now()}`,
                    message: 'Mock order processed successfully'
                });
            } else if (action === 'mock-sltp') {
                // Simulate SL/TP update for UI testing
                this.log(`Test mode: simulating SL/TP update for ${data.positionId}`, 'TEST');
                res.json({
                    success: true,
                    message: 'Mock SL/TP update processed successfully'
                });
            } else {
                res.status(400).json({ success: false, error: 'Unknown test action' });
            }
        });
        
        // 🚨 Trading Status Endpoint - Critical Safety Feature
        this.app.get('/api/trading-status', (req, res) => {
            res.json(this.getTradingStatus());
        });
        
        // 🔓 Emergency Unlock Endpoint (for testing/debugging only)
        this.app.post('/api/emergency-unlock', (req, res) => {
            this.emergencyUnlock();
            res.json({ success: true, message: 'Trading force unlocked' });
        });
        
        // Main web interface
        this.app.get('/', (req, res) => {
            res.send(this.generateWebInterface());
        });
    }

    async placeOrder(orderData) {
        // 🚨 ONE TRADE AT A TIME LOCK - CRITICAL SAFETY CHECK
        if (this.tradingLocked) {
            console.log(`🚨 [SAFETY] Order rejected - trading locked. Current operation: ${this.currentOperation}`);
            throw new Error(`Trading locked: ${this.currentOperation} in progress. Please wait.`);
        }
        
        // Lock trading immediately
        this.tradingLocked = true;
        this.currentOperation = 'PLACE_ORDER';
        console.log(`🔒 [SAFETY] Trading locked for PLACE_ORDER operation`);
        
        try {
            const { instrument, side, quantity, stopLoss, takeProfit, accountId } = orderData;
        
        // Log order placement with SL/TP details
        if (this.fileLogger) {
            this.fileLogger.logSLTP('Manual Order Placement Started', {
                instrument,
                side,
                quantity,
                stopLoss,
                takeProfit,
                accountId,
                hasStopLoss: !!stopLoss && stopLoss.enabled,
                hasTakeProfit: !!takeProfit && takeProfit.enabled,
                stopLossPoints: stopLoss?.points || null,
                takeProfitPoints: takeProfit?.points || null
            });
        }
        
        // Use the account ID from the request, not the default selected account
        if (!accountId) {
            throw new Error('No account ID provided in order request');
        }
        
        // Validate the account exists
        const account = this.accounts.find(acc => acc.id === parseInt(accountId));
        if (!account) {
            throw new Error(`Invalid account ID: ${accountId}`);
        }
        
        // Handle both full contract IDs and base symbols
        let contractId = instrument;
        let baseSymbol;
        
        // Check if this is a full contract ID (e.g., CON.F.US.MGC.Q25)
        if (instrument.startsWith('CON.F.US.')) {
            // Extract base symbol from contract ID
            const parts = instrument.split('.');
            if (parts.length >= 4) {
                // Extract F.US.XXX format from CON.F.US.XXX.YYY
                baseSymbol = `${parts[1]}.${parts[2]}.${parts[3]}`; // e.g., F.US.MGC from CON.F.US.MGC.Q25
            }
        } else {
            // It's already a base symbol
            baseSymbol = instrument;
            contractId = this.getActiveContractForSymbol(instrument);
        }
        
        // Validate base symbol
        if (!this.validInstruments.has(baseSymbol)) {
            this.log(`❌ validInstruments size: ${this.validInstruments.size}`, 'ERROR');
            this.log(`❌ instruments size: ${this.instruments.size}`, 'ERROR');
            
            // If validInstruments is empty but instruments has data, use instruments as fallback
            if (this.validInstruments.size === 0 && this.instruments.has(baseSymbol)) {
                this.log(`⚠️ Using instruments map as fallback for ${baseSymbol}`, 'WARN');
                // Create a temporary entry in validInstruments
                const instrumentData = this.instruments.get(baseSymbol);
                this.validInstruments.set(baseSymbol, [{
                    contractId: contractId,
                    symbol: baseSymbol,
                    name: instrumentData.name || baseSymbol,
                    exchange: instrumentData.exchange || 'US',
                    tickSize: instrumentData.tickSize,
                    pointValue: instrumentData.pointValue,
                    currency: instrumentData.currency || 'USD',
                    isActive: true
                }]);
            } else {
                throw new Error(`Invalid instrument: ${baseSymbol}. Available instruments: ${Array.from(this.validInstruments.keys()).join(', ')}`);
            }
        }
        
        // Validate contract is active
        const contracts = this.validInstruments.get(baseSymbol);
        const isValidContract = contracts.some(c => c.contractId === contractId);
        
        if (!isValidContract) {
            this.log(`⚠️ Contract ${contractId} may not be active, proceeding anyway`, 'WARN');
        }
        
        const orderId = `manual-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        // Create order record
        const order = {
            orderId,
            accountId: parseInt(accountId), // Use the account ID from the request
            instrument,
            contractId, // Store the full contract ID
            side,
            quantity,
            orderType: 'MARKET',
            status: 'PENDING',
            createdTime: Date.now(),
            stopLoss: stopLoss || null,
            takeProfit: takeProfit || null
        };
        
        this.orders.set(orderId, order);
        this.orderHistory.push(order);
        
        // CRITICAL FIX: Send ONLY points values - let Connection Manager calculate from FILL PRICE
        // This ensures SL/TP is based on actual execution price, not estimated price
        
        this.log(`📋 [FILL-BASED] Fill-Based SL/TP Processing:`);
        this.log(`   - Instrument: ${contractId} (base: ${baseSymbol})`);
        this.log(`   - Side: ${side}, Quantity: ${quantity}`);
        this.log(`   - OrderId: ${orderId}`);
        this.log(`   - SL/TP will be calculated from ACTUAL FILL PRICE by Connection Manager`);
        
        // Log SL/TP points (no price calculation here)
        if (stopLoss && stopLoss.enabled && stopLoss.points) {
            this.log(`📋 [FILL-BASED] Stop Loss: ${stopLoss.points} points (will calculate from fill price)`);
        } else {
            this.log(`📋 [FILL-BASED] Stop Loss: disabled`);
        }
        
        if (takeProfit && takeProfit.enabled && takeProfit.points) {
            this.log(`📋 [FILL-BASED] Take Profit: ${takeProfit.points} points (will calculate from fill price)`);
        } else {
            this.log(`📋 [FILL-BASED] Take Profit: disabled`);
        }

        // Send order to Connection Manager with full contract ID AND SL/TP values
        const orderPayload = {
            instanceId: 'MANUAL_TRADING',  // Fixed service identifier
            orderId,
            accountId: parseInt(accountId), // Use the account ID from the request
            instrument: contractId, // Send full contract ID to Connection Manager
            side,
            quantity,
            orderType: 'MARKET',
            timestamp: Date.now()
        };
        
        // CRITICAL FIX: Include ONLY points values - Connection Manager will calculate prices from fill
        if (stopLoss && stopLoss.enabled && stopLoss.points) {
            orderPayload.stopLossPoints = stopLoss.points;
        }
        if (takeProfit && takeProfit.enabled && takeProfit.points) {
            orderPayload.takeProfitPoints = takeProfit.points;
        }
        
        // Log the complete order payload for testing validation
        this.log(`📋 [BRACKET] Order Payload to Connection Manager:`);
        this.log(`   ${JSON.stringify(orderPayload, null, 2)}`);
        
        // Route through Trading Aggregator instead of direct to Connection Manager
        const aggregatorMessage = {
            type: 'MANUAL_ORDER',
            source: 'manual-trading-v2',
            timestamp: new Date().toISOString(),
            order: orderPayload
        };
        
        this.log(`📋 [AGGREGATOR] Redis Message Structure:`);
        this.log(`   - Channel: aggregator:orders`);
        this.log(`   - Type: MANUAL_ORDER`);
        this.log(`   - Source: manual-trading-v2`);
        this.log(`   - Order fields: ${Object.keys(orderPayload).join(', ')}`);
        
        await this.redisClient.publish('aggregator:orders', JSON.stringify(aggregatorMessage));
        
        this.log(`📤 Order placed: ${orderId} - ${side} ${quantity} ${contractId}`);
        
        // Log that Connection Manager will handle bracket orders
        const hasStopLoss = stopLoss && stopLoss.enabled && stopLoss.points;
        const hasTakeProfit = takeProfit && takeProfit.enabled && takeProfit.points;
        
        if (hasStopLoss || hasTakeProfit) {
            this.log(`📋 [FILL-BASED] Bracket Order Details (Points-Based):`);
            this.log(`   - Stop Loss: ${hasStopLoss ? `${stopLoss.points} points` : 'none'}`);
            this.log(`   - Take Profit: ${hasTakeProfit ? `${takeProfit.points} points` : 'none'}`);
            this.log(`✅ [FILL-BASED] Connection Manager will calculate from ACTUAL FILL PRICE`);
        } else {
            this.log(`📋 [FILL-BASED] No bracket orders - market order only`);
        }
        
        return { success: true, orderId, contractId };
        } catch (error) {
            console.log(`❌ [SAFETY] Order failed: ${error.message}`);
            throw error;
        } finally {
            // 🔓 ALWAYS unlock trading when operation completes
            this.tradingLocked = false;
            this.currentOperation = null;
            console.log(`🔓 [SAFETY] Trading unlocked - PLACE_ORDER operation complete`);
        }
    }

    async closePosition(instrument, quantity, closeType, accountId, side) {
        // 🚨 ONE TRADE AT A TIME LOCK - CRITICAL SAFETY CHECK
        if (this.tradingLocked) {
            console.log(`🚨 [SAFETY] Close position rejected - trading locked. Current operation: ${this.currentOperation}`);
            throw new Error(`Trading locked: ${this.currentOperation} in progress. Please wait.`);
        }
        
        // Lock trading immediately
        this.tradingLocked = true;
        this.currentOperation = 'CLOSE_POSITION';
        console.log(`🔒 [SAFETY] Trading locked for CLOSE_POSITION operation`);
        
        try {
            // Use instrument as position key
            const positionKey = instrument;
            const position = this.positions.get(positionKey);
            
            if (!position || position.quantity === 0) {
                throw new Error(`No open position for ${instrument} (${side}) in account ${accountId}`);
            }
            
            // CRITICAL: Use the account ID from the position itself
            const posAccountId = position.accountId || accountId;
            if (!posAccountId) {
                throw new Error('No account ID stored with position');
            }
            
            this.log(`📤 Closing position: ${closeType} close for ${instrument}`);
            this.log(`📤 Using position's account ID: ${accountId} (NOT selected account: ${this.selectedAccount?.id})`);
            
            try {
            // Send close position request to Connection Manager via Redis
            const requestId = `close-pos-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            
            const closeRequest = {
                type: 'CLOSE_POSITION',
                requestId: requestId,
                accountId: accountId,  // Use the account ID from the position!
                contractId: instrument,  // Send the FULL contract ID as required by TopStep API
                closeType: closeType, // 'full' or 'partial'
                size: closeType === 'partial' ? (quantity || 1) : undefined,
                responseChannel: `close-position-response:${requestId}`, // Use unique response channel
                timestamp: Date.now()
            };
            
            this.log(`📤 Publishing close position request: ${JSON.stringify(closeRequest, null, 2)}`);
            
            // Subscribe to unique response channel for this request
            return new Promise((resolve, reject) => {
                const responseChannel = `close-position-response:${requestId}`;
                const timeout = setTimeout(() => {
                    this.redisSubscriber.unsubscribe(responseChannel);
                    reject(new Error('Close position request timeout after 10 seconds'));
                }, 10000);
                
                // Subscribe to unique response channel for this specific request
                this.redisSubscriber.subscribe(responseChannel, (message) => {
                    try {
                        const response = JSON.parse(message);
                        clearTimeout(timeout);
                        
                        this.log(`📨 Close position response received: ${JSON.stringify(response, null, 2)}`);
                        
                        // Unsubscribe from the response channel
                        this.redisSubscriber.unsubscribe(responseChannel);
                        
                        // Handle response directly without payload wrapper
                        if (response.success) {
                            // Update positions after successful close
                            this.positions.delete(instrument);
                            this.log(`✅ Position closed successfully for ${instrument}`);
                            resolve(response.data || { success: true });
                        } else {
                            this.log(`❌ Close position failed: ${response.error}`);
                            reject(new Error(response.error || 'Close position failed'));
                        }
                    } catch (error) {
                        clearTimeout(timeout);
                        this.redisSubscriber.unsubscribe(responseChannel);
                        this.log(`❌ Error parsing close position response: ${error.message}`);
                        reject(new Error(`Failed to parse response: ${error.message}`));
                    }
                });
                
                this.log(`✅ Subscribed to unique response channel: ${responseChannel}`);
                
                // Publish the close request through aggregator for proper risk management
                this.redisClient.publish('aggregator:requests', JSON.stringify(closeRequest));
            });
            
            } catch (error) {
                this.log(`❌ Error closing position: ${error.message}`);
                throw error;
            }
        } catch (error) {
            this.log(`❌ Error in closePosition: ${error.message}`);
            throw error;
        } finally {
            // 🔓 ALWAYS unlock trading when operation completes
            this.tradingLocked = false;
            this.currentOperation = null;
            console.log(`🔓 [SAFETY] Trading unlocked - CLOSE_POSITION operation complete`);
        }
    }

    // 🚨 Trading Status Check Method
    getTradingStatus() {
        return {
            locked: this.tradingLocked,
            currentOperation: this.currentOperation,
            canTrade: !this.tradingLocked
        };
    }

    // 🔓 Emergency Unlock Method (for testing only)
    emergencyUnlock() {
        console.log(`🚨 [EMERGENCY] Force unlocking trading. Previous state: locked=${this.tradingLocked}, operation=${this.currentOperation}`);
        this.tradingLocked = false;
        this.currentOperation = null;
        console.log(`🔓 [EMERGENCY] Trading force unlocked`);
    }

    generateWebInterface() {
        return `
<!DOCTYPE html>
<html>
<head>
    <title>Manual Trading v2 - Enhanced</title>
    <link rel="stylesheet" href="/src/ui/shared/premium-dark-theme.css">
    <link rel="stylesheet" href="/src/ui/shared/components.css">
    <style>
        /* Manual Trading Specific Styles */
        .panel {
            margin-bottom: var(--spacing-xl);
        }
        
        .controls {
            display: flex;
            gap: var(--spacing-md);
            align-items: center;
            margin-bottom: var(--spacing-lg);
            flex-wrap: wrap;
        }
        
        .button-rounded {
            padding: 12px 24px;
            font-size: 16px;
            font-weight: 600;
            border-radius: 12px;
            min-width: 120px;
        }
        
        button.buy, .action-buy {
            background: var(--accent-success);
            color: white;
        }
        
        button.buy:hover, .action-buy:hover {
            background: #059669;
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(16, 185, 129, 0.4);
        }
        
        button.sell, .action-sell {
            background: var(--accent-danger);
            color: white;
        }
        
        button.sell:hover, .action-sell:hover {
            background: #dc2626;
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(239, 68, 68, 0.4);
        }
        
        button.close {
            background: var(--accent-danger);
            color: white;
        }
        
        button.close:hover {
            background: #dc2626;
        }
        
        button.quick-close {
            background: #f59e0b;
            color: white;
            font-size: 0.875rem;
        }
        
        button.quick-close:hover {
            background: #d97706;
        }
        
        button.sltp {
            background: var(--accent-primary);
            font-size: 0.75rem;
            padding: 6px 12px;
        }
        
        button.sltp:hover {
            background: var(--accent-primary-hover);
            transform: translateY(-1px);
        }
        /* Table styles handled by premium-dark-theme.css */
        
        .position.long, .profit {
            color: var(--accent-success);
        }
        
        .position.short, .loss {
            color: var(--accent-danger);
        }
        
        /* Tabs using tab-nav from components.css */
        .tabs {
            display: flex;
            gap: var(--spacing-xs);
            border-bottom: 1px solid var(--border-default);
            margin-bottom: var(--spacing-lg);
        }
        
        .tab-button {
            padding: var(--spacing-sm) var(--spacing-lg);
            background: transparent;
            border: none;
            color: var(--text-secondary);
            font-weight: 500;
            cursor: pointer;
            position: relative;
            transition: all var(--transition-fast);
        }
        
        .tab-button:hover {
            color: var(--text-primary);
        }
        
        .tab-button.active {
            color: var(--accent-primary);
        }
        
        .tab-button.active::after {
            content: '';
            position: absolute;
            bottom: -1px;
            left: 0;
            right: 0;
            height: 2px;
            background: var(--accent-primary);
        }
        /* Modal styles extending from components.css */
        .modal {
            display: none;
            position: fixed;
            z-index: 1000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            align-items: center;
            justify-content: center;
            animation: fadeIn var(--transition-fast);
        }
        
        .modal.show {
            display: flex;
        }
        
        .modal-content {
            background: var(--bg-secondary);
            border: 1px solid var(--border-default);
            border-radius: var(--radius-xl);
            padding: var(--spacing-lg);
            max-width: 600px;
            width: 90%;
            max-height: 95vh;
            overflow-y: auto;
            animation: slideUp var(--transition-slow);
        }
        
        #orderModal .modal-content {
            max-height: fit-content;
            overflow-y: visible;
        }
        
        #orderModal h2 {
            margin: 0 0 var(--spacing-sm) 0;
        }
        
        #orderModal .form-group {
            margin-bottom: var(--spacing-sm);
        }
        
        .sltp-inputs {
            margin-top: var(--spacing-xs);
        }
        
        .price-display {
            margin-top: var(--spacing-xs) !important;
        }
        
        .close-modal {
            background: transparent;
            border: none;
            color: var(--text-secondary);
            float: right;
            font-size: 1.5rem;
            cursor: pointer;
            padding: var(--spacing-xs);
            line-height: 1;
            transition: color var(--transition-fast);
        }
        
        .close-modal:hover {
            color: var(--text-primary);
        }
        
        /* Form styles already in premium-dark-theme.css */
        .order-buttons {
            display: flex;
            gap: var(--spacing-md);
            margin-top: var(--spacing-lg);
            justify-content: center;
        }
        
        .order-buttons button {
            flex: 0 1 auto;
        }
        
        .order-buttons .button-secondary {
            background: var(--bg-secondary);
            color: var(--text-primary);
            border: 1px solid var(--border-default);
        }
        
        .order-buttons .button-secondary:hover {
            background: var(--bg-tertiary);
            border-color: var(--border-hover);
        }
        /* SL/TP Styles */
        .sltp-section {
            margin: var(--spacing-md) 0;
            padding: var(--spacing-sm) var(--spacing-md);
            border: 1px solid var(--border-default);
            border-radius: var(--radius-md);
        }
        
        .sltp-section h4 {
            margin: 0 0 var(--spacing-sm) 0;
            display: flex;
            align-items: center;
            gap: var(--spacing-sm);
            font-size: 1rem;
        }
        
        .sltp-section.stop-loss {
            border-color: var(--accent-danger);
            background: rgba(239, 68, 68, 0.05);
        }
        
        .sltp-section.take-profit {
            border-color: var(--accent-success);
            background: rgba(16, 185, 129, 0.05);
        }
        
        .sltp-checkbox {
            width: auto !important;
            margin-right: var(--spacing-sm);
        }
        
        .sltp-inputs {
            display: flex;
            gap: var(--spacing-sm);
            align-items: center;
        }
        
        .sltp-mode {
            display: flex;
            gap: var(--spacing-sm);
            margin: var(--spacing-sm) 0;
        }
        
        .mode-button {
            padding: 6px 16px;
            background: var(--bg-tertiary);
            border: 1px solid var(--border-default);
            border-radius: var(--radius-sm);
            cursor: pointer;
            transition: all var(--transition-fast);
            color: var(--text-secondary);
            font-weight: 500;
        }
        
        .mode-button:hover {
            background: var(--bg-hover);
            color: var(--text-primary);
        }
        
        .mode-button.active {
            background: var(--accent-primary);
            color: white;
            border-color: var(--accent-primary);
        }
        .risk-reward {
            margin-top: var(--spacing-sm);
            padding: var(--spacing-sm);
            background: var(--bg-tertiary);
            border-radius: var(--radius-md);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .risk-reward-item {
            text-align: center;
        }
        
        .risk-reward-value {
            font-size: 1.25rem;
            font-weight: 600;
            margin-top: var(--spacing-xs);
        }
        
        .modal-section {
            margin: var(--spacing-lg) 0;
            padding: var(--spacing-md);
            background: var(--bg-tertiary);
            border-radius: var(--radius-md);
        }
        
        .info-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: var(--spacing-sm);
            margin: var(--spacing-sm) 0;
            padding: var(--spacing-sm);
            background: var(--bg-tertiary);
            border-radius: var(--radius-md);
        }
        
        .info-item {
            text-align: center;
        }
        
        .info-label {
            display: block;
            font-size: 0.75rem;
            color: var(--text-secondary);
            margin-bottom: var(--spacing-xs);
        }
        
        .info-value {
            font-size: 1rem;
            font-weight: 600;
            color: var(--accent-primary);
        }
        
        .loading {
            color: var(--text-secondary);
            font-style: italic;
        }
        
        .instrument-info {
            padding: var(--spacing-sm);
            background: var(--bg-tertiary);
            border-radius: var(--radius-sm);
            margin-top: var(--spacing-sm);
            font-size: 0.875rem;
        }
        
        .instrument-info-item {
            display: flex;
            justify-content: space-between;
            margin: var(--spacing-xs) 0;
        }
        
        /* Badge styles from premium-dark-theme.css */
        .status-badge.valid {
            background: rgba(16, 185, 129, 0.1);
            color: var(--accent-success);
        }
        
        .status-badge.invalid {
            background: rgba(239, 68, 68, 0.1);
            color: var(--accent-danger);
        }
        
        /* Account position cards */
        .account-positions-card {
            margin-bottom: 20px;
            border: 1px solid var(--border-color, #333);
            border-radius: 8px;
            padding: 15px;
            background: var(--bg-secondary, #1a1a1a);
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        }
        
        .account-positions-card h3 {
            margin-top: 0;
            margin-bottom: 15px;
            color: var(--text-primary, #fff);
            font-size: 1.2em;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--border-color, #333);
        }
        
        .account-positions-card table {
            width: 100%;
            margin-top: 10px;
        }
        
        .account-pnl-summary {
            padding: 10px 15px;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 6px;
            margin-bottom: 15px;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        
        .account-pnl-summary .profit {
            color: var(--accent-success, #10b981);
        }
        
        .account-pnl-summary .loss {
            color: var(--accent-danger, #ef4444);
        }
        
        /* Price display component from components.css */
        .price-display {
            padding: var(--spacing-sm) var(--spacing-md);
            background: var(--bg-tertiary);
            border-radius: var(--radius-sm);
            border-left: 3px solid currentColor;
            font-weight: 600;
        }
        
        .price-display span {
            font-size: 0.875rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <header class="text-center mb-xl">
            <h1>🎯 Manual Trading v2 - Enhanced</h1>
        </header>
        
        <div class="card">
            <h3>Account & Trading Controls</h3>
            <div class="controls">
                <select id="accountSelect" style="min-width: 200px;">
                    <option value="">Select Account...</option>
                </select>
                <select id="contractSelect" style="min-width: 250px;">
                    <option value="">Loading contracts...</option>
                </select>
                <input type="number" id="quantityInput" value="1" min="1" placeholder="Quantity">
                <button class="button buy" id="buyButton">BUY</button>
                <button class="button sell" id="sellButton">SELL</button>
            </div>
            <div id="instrumentInfo" class="instrument-info" style="display:none;">
                <div class="instrument-info-item">
                    <span>Contract ID:</span>
                    <span id="contractId">-</span>
                </div>
                <div class="instrument-info-item">
                    <span>Tick Size:</span>
                    <span id="tickSize">-</span>
                </div>
                <div class="instrument-info-item">
                    <span>Multiplier:</span>
                    <span id="multiplier">-</span>
                </div>
                <div class="instrument-info-item">
                    <span>Expiration:</span>
                    <span id="expiration">-</span>
                </div>
                <div class="instrument-info-item">
                    <span>Status:</span>
                    <span id="validationStatus" class="status-badge">-</span>
                </div>
            </div>
        </div>
        
        <div class="card mt-lg">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <h3>Open Positions</h3>
                <button onclick="refreshPositions()" class="button button-primary">↻ Refresh</button>
            </div>
            <div id="positions">
                <p>Loading positions...</p>
            </div>
        </div>
        
    </div>
    
    <!-- Close Position Modal -->
    <div id="closeModal" class="modal">
        <div class="modal-content">
            <span class="close-modal" id="closeModalBtn1">&times;</span>
            <h2>Close Position</h2>
            <div id="closePositionInfo"></div>
            <div class="form-group">
                <label>Close Type:</label>
                <select id="closeType">
                    <option value="full">Full Position</option>
                    <option value="partial">Partial Close</option>
                </select>
            </div>
            <div class="form-group" id="partialQtyGroup" style="display:none;">
                <label>Quantity to Close:</label>
                <input type="number" id="partialQty" value="1" min="1">
            </div>
            <div class="order-buttons">
                <button class="button close" id="confirmCloseBtn">Confirm Close</button>
                <button class="button button-secondary" id="cancelCloseBtn">Cancel</button>
            </div>
        </div>
    </div>
    
    <!-- Order Entry Modal -->
    <div id="orderModal" class="modal">
        <div class="modal-content">
            <span class="close-modal" id="closeModalBtn2">&times;</span>
            <h2 id="orderModalTitle">Place Order</h2>
            
            <div class="info-grid">
                <div class="info-item">
                    <span class="info-label">Instrument:</span>
                    <span class="info-value" id="modalInstrument">MGC</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Quantity:</span>
                    <span class="info-value" id="modalQuantity">1</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Current Price:</span>
                    <span class="info-value" id="modalCurrentPrice">Loading...</span>
                </div>
            </div>
            
            <!-- Stop Loss Section -->
            <div class="sltp-section stop-loss">
                <h4>
                    <input type="checkbox" id="enableSL" class="sltp-checkbox">
                    🛡️ Stop Loss
                </h4>
                <div id="slContent" style="display:none;">
                    <div class="sltp-mode">
                        <button class="mode-button active" id="slPointsBtn">Points from Entry</button>
                        <button class="mode-button" id="slDollarsBtn">Dollar Risk</button>
                    </div>
                    <div class="sltp-inputs">
                        <input type="number" id="slValue" placeholder="Enter points" step="0.1">
                        <span id="slCalculated">= $0.00 risk</span>
                    </div>
                    <div class="price-display" id="slPriceDisplay" style="margin-top: 8px; font-size: 14px; color: #f44336;">
                        <span>Price Level: <span id="slPriceLevel">-</span></span>
                    </div>
                </div>
            </div>
            
            <!-- Take Profit Section -->
            <div class="sltp-section take-profit">
                <h4>
                    <input type="checkbox" id="enableTP" class="sltp-checkbox">
                    🎯 Take Profit
                </h4>
                <div id="tpContent" style="display:none;">
                    <div class="sltp-mode">
                        <button class="mode-button active" id="tpPointsBtn">Points from Entry</button>
                        <button class="mode-button" id="tpDollarsBtn">Dollar Target</button>
                    </div>
                    <div class="sltp-inputs">
                        <input type="number" id="tpValue" placeholder="Enter points" step="0.1">
                        <span id="tpCalculated">= $0.00 profit</span>
                    </div>
                    <div class="price-display" id="tpPriceDisplay" style="margin-top: 8px; font-size: 14px; color: #4CAF50;">
                        <span>Price Level: <span id="tpPriceLevel">-</span></span>
                    </div>
                </div>
            </div>
            
            <!-- Risk/Reward Display -->
            <div class="risk-reward" id="riskRewardDisplay" style="display:none;">
                <div class="risk-reward-item">
                    <div>Risk</div>
                    <div class="risk-reward-value loss" id="riskAmount">$0</div>
                </div>
                <div class="risk-reward-item">
                    <div>Reward</div>
                    <div class="risk-reward-value profit" id="rewardAmount">$0</div>
                </div>
                <div class="risk-reward-item">
                    <div>R:R Ratio</div>
                    <div class="risk-reward-value" id="rrRatio">-</div>
                </div>
            </div>
            
            <div class="order-buttons">
                <button id="confirmOrderBtn" class="button button-rounded">Place Order</button>
                <button id="cancelOrderBtn" class="button button-secondary">Cancel</button>
            </div>
        </div>
    </div>
    
    <!-- SL/TP Update Modal - DISABLED -->
    <!-- 
    <div id="sltpModal" class="modal">
        <div class="modal-content">
            <span class="close-modal" id="closeModalBtn3">&times;</span>
            <h2>Update Stop Loss / Take Profit</h2>
            
            <div class="modal-section">
                <div class="info-grid">
                    <div class="info-item">
                        <span class="info-label">Instrument:</span>
                        <span class="info-value" id="sltpInstrument">-</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">Position:</span>
                        <span class="info-value" id="sltpPosition">-</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">Entry Price:</span>
                        <span class="info-value" id="sltpEntryPrice">-</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">Current Price:</span>
                        <span class="info-value" id="sltpCurrentPrice">-</span>
                    </div>
                </div>
            </div>
            
            <div class="form-group">
                <label>Stop Loss Price:</label>
                <input type="number" id="sltpStopLoss" step="0.01" placeholder="Leave empty to keep current">
            </div>
            
            <div class="form-group">
                <label>Take Profit Price:</label>
                <input type="number" id="sltpTakeProfit" step="0.01" placeholder="Leave empty to keep current">
            </div>
            
            <div class="order-buttons">
                <button class="button button-primary" id="confirmSLTPBtn">Update SL/TP</button>
                <button class="button button-secondary" id="cancelSLTPBtn">Cancel</button>
            </div>
        </div>
    </div>
    -->
    
    <script>
        let accounts = [];
        let positions = new Map();
        let instruments = new Map();
        let contracts = new Map();
        let selectedContract = null;
        let currentCloseInstrument = null;
        let currentCloseAccountId = null;
        let currentCloseSide = null;
        let currentOrderSide = null;
        let slMode = 'points';
        let tpMode = 'points';
        let currentSLTPPosition = null;
        
        // Contract multipliers
        const contractMultipliers = {
            'MGC': 10,     // Micro Gold - $10 per point
            'MNQ': 2,      // Micro NASDAQ - $2 per point
            'MES': 5,      // Micro S&P 500 - $5 per point
            'MCL': 10,     // Micro Crude Oil - $10 per point
            'M2K': 5,      // Micro Russell 2000 - $5 per point
            'MYM': 0.50,   // Micro Dow - $0.50 per point
            'M6E': 12.50,  // Micro Euro - $12.50 per point
            'M6B': 6.25,   // Micro British Pound - $6.25 per point
            'MBT': 0.1,    // Micro Bitcoin - $0.1 per point (corrected)
            'MSI': 50,     // Micro Silver - $50 per point
            'M6A': 10,     // Micro AUD/USD - $10 per point
            'MHG': 12.5,   // Micro Copper - $12.5 per point
            'MNG': 250,    // Micro Natural Gas - $250 per point
            'MET': 0.1     // Micro Ether - $0.1 per point
        };
        
        // Load active contracts from API
        async function loadInstruments() {
            const contractSelect = document.getElementById('contractSelect');
            contractSelect.innerHTML = '<option value="">Loading contracts...</option>';
            
            try {
                const response = await fetch('/api/instruments/active');
                if (!response.ok) {
                    throw new Error(\`HTTP error! status: \${response.status}\`);
                }
                const data = await response.json();
                console.log('Instruments API response:', data);
                
                if (!data.success || !data.instruments) {
                    throw new Error(data.error || 'Failed to load instruments');
                }
                
                // Clear and populate instruments map
                instruments.clear();
                contracts.clear();
                
                // Build single dropdown with all contracts
                contractSelect.innerHTML = '<option value="">Select Contract...</option>';
                
                data.instruments.forEach(inst => {
                    instruments.set(inst.symbol, inst);
                    
                    // Add each contract to the dropdown
                    if (inst.contracts && inst.contracts.length > 0) {
                        inst.contracts.forEach(contract => {
                            const option = document.createElement('option');
                            option.value = contract.contractId;
                            option.textContent = \`\${contract.monthYear} (\${inst.symbol}) - $\${inst.multiplier}/pt\`;
                            option.dataset.symbol = inst.symbol;
                            option.dataset.multiplier = inst.multiplier;
                            option.dataset.tickSize = inst.tickSize;
                            
                            contracts.set(contract.contractId, {
                                ...contract,
                                symbol: inst.symbol,
                                multiplier: inst.multiplier,
                                tickSize: inst.tickSize
                            });
                            
                            contractSelect.appendChild(option);
                        });
                    }
                });
                
                // Set up contract change handler
                contractSelect.addEventListener('change', onContractChange);
                
            } catch (error) {
                console.error('Failed to load contracts:', error);
                contractSelect.innerHTML = '<option value="">Failed to load contracts</option>';
            }
        }
        
        // Handle contract selection change
        function onContractChange() {
            const contractSelect = document.getElementById('contractSelect');
            const selectedValue = contractSelect.value;
            const instrumentInfo = document.getElementById('instrumentInfo');
            
            if (!selectedValue) {
                instrumentInfo.style.display = 'none';
                selectedContract = null;
                return;
            }
            
            selectedContract = selectedValue;
            const contractData = contracts.get(selectedValue);
            
            if (contractData) {
                updateInstrumentInfo(contractData.symbol, selectedValue);
                instrumentInfo.style.display = 'block';
            }
        }
        
        // Update instrument info display
        function updateInstrumentInfo(symbol, contractId) {
            const instrumentData = instruments.get(symbol);
            if (!instrumentData) return;
            
            document.getElementById('contractId').textContent = contractId || 'N/A';
            document.getElementById('tickSize').textContent = '0.10'; // Default tick size
            document.getElementById('multiplier').textContent = \`$\${instrumentData.multiplier}/pt\`;
            document.getElementById('expiration').textContent = 'Current Month';
            
            const validationStatus = document.getElementById('validationStatus');
            validationStatus.textContent = 'VALID';
            validationStatus.className = 'status-badge valid';
        }
        
        
        // Get instrument description
        function getInstrumentDescription(symbol) {
            const descriptions = {
                'MGC': 'Micro Gold ($10/pt)',
                'MNQ': 'Micro NASDAQ ($2/pt)',
                'MES': 'Micro S&P 500 ($5/pt)',
                'MCL': 'Micro Crude Oil ($10/pt)',
                'M2K': 'Micro Russell 2000 ($5/pt)',
                'MYM': 'Micro Dow ($0.50/pt)',
                'M6E': 'Micro Euro ($12.50/pt)',
                'M6B': 'Micro British Pound ($6.25/pt)',
                'MBT': 'Micro Bitcoin ($10/pt)'
            };
            return descriptions[symbol] || symbol;
        }
        
        // Get current market price for calculations
        async function getCurrentMarketPrice(contractId) {
            if (!contractId || !contracts.has(contractId)) return null;
            
            const contractData = contracts.get(contractId);
            const symbol = contractData.symbol;
            
            // Try to get real market price from the server
            try {
                const response = await fetch(\`/api/prices/\${symbol}\`);
                if (response.ok) {
                    const data = await response.json();
                    if (data && data.price) {
                        return data.price;
                    }
                }
            } catch (error) {
                console.error('Error fetching market price:', error);
            }
            
            // Fallback: Try to get from positions data
            for (let position of positions.values()) {
                if (position.instrument === contractId && position.currentPrice) {
                    return position.currentPrice;
                }
            }
            
            // No real price available
            console.warn(\`No real market price available for \${symbol}\`);
            return null;
        }
        
        // Initialize
        async function init() {
            await loadAccounts();
            await loadInstruments();
            await updatePositions();
            
            // Update positions every 1 second (silently)
            // This only fetches from server memory, doesn't trigger aggregator requests
            setInterval(() => updatePositions(true), 1000);
            
            // Refresh accounts every 30 seconds to catch account list changes
            setInterval(async () => {
                const currentSelectedId = document.getElementById('accountSelect').value;
                await loadAccounts();
                
                // Try to maintain selected account if it still exists
                const accountSelect = document.getElementById('accountSelect');
                if (currentSelectedId && Array.from(accountSelect.options).some(opt => opt.value === currentSelectedId)) {
                    accountSelect.value = currentSelectedId;
                }
            }, 30000);
            
            // Setup Server-Sent Events for real-time position updates
            const eventSource = new EventSource('/api/events');
            
            eventSource.addEventListener('message', function(event) {
                const data = JSON.parse(event.data);
                
                // Handle position updates and closes
                if (data.type === 'position-update' || data.type === 'position-closed') {
                    // Refresh positions when we receive an update event
                    updatePositions(true);
                }
            });
            
            eventSource.addEventListener('error', function(event) {
                console.error('SSE connection error:', event);
                // Reconnection is automatic
            });
            
            // Setup event listeners
            document.getElementById('closeType').addEventListener('change', function() {
                document.getElementById('partialQtyGroup').style.display = 
                    this.value === 'partial' ? 'block' : 'none';
            });
            
            document.getElementById('enableSL').addEventListener('change', function() {
                document.getElementById('slContent').style.display = this.checked ? 'block' : 'none';
                updateRiskReward();
            });
            
            document.getElementById('enableTP').addEventListener('change', function() {
                document.getElementById('tpContent').style.display = this.checked ? 'block' : 'none';
                updateRiskReward();
            });
            
            document.getElementById('slValue').addEventListener('input', updateRiskReward);
            document.getElementById('tpValue').addEventListener('input', updateRiskReward);
            document.getElementById('quantityInput').addEventListener('input', updateRiskReward);
            
            // Add button event listeners
            document.getElementById('buyButton').addEventListener('click', () => showOrderModal('BUY'));
            document.getElementById('sellButton').addEventListener('click', () => showOrderModal('SELL'));
            
            // Add SL/TP mode button listeners after modal is created
            document.getElementById('slPointsBtn').addEventListener('click', () => setSLMode('points'));
            document.getElementById('slDollarsBtn').addEventListener('click', () => setSLMode('dollars'));
            document.getElementById('tpPointsBtn').addEventListener('click', () => setTPMode('points'));
            document.getElementById('tpDollarsBtn').addEventListener('click', () => setTPMode('dollars'));
            
            // Add modal close button listeners
            document.getElementById('closeModalBtn1').addEventListener('click', () => closeModal('closeModal'));
            document.getElementById('closeModalBtn2').addEventListener('click', () => closeModal('orderModal'));
            // document.getElementById('closeModalBtn3').addEventListener('click', () => closeModal('sltpModal')); // DISABLED SL/TP
            
            // Add confirm/cancel button listeners
            document.getElementById('confirmCloseBtn').addEventListener('click', confirmClose);
            document.getElementById('cancelCloseBtn').addEventListener('click', () => closeModal('closeModal'));
            document.getElementById('confirmOrderBtn').addEventListener('click', confirmOrder);
            document.getElementById('cancelOrderBtn').addEventListener('click', () => closeModal('orderModal'));
            // DISABLED SL/TP functionality
            // document.getElementById('confirmSLTPBtn').addEventListener('click', confirmSLTP);
            // document.getElementById('cancelSLTPBtn').addEventListener('click', () => closeModal('sltpModal'));
            
            // Add event delegation for dynamic position buttons
            const positionsContainer = document.getElementById('positions');
            console.log('[DEBUG] Positions container found:', positionsContainer);
            
            if (positionsContainer) {
                positionsContainer.addEventListener('click', (e) => {
                    console.log('[BUTTON DEBUG] Click detected on positions container');
                    console.log('[BUTTON DEBUG] Target element:', e.target);
                    console.log('[BUTTON DEBUG] Target tagName:', e.target.tagName);
                    console.log('[BUTTON DEBUG] Target classes:', Array.from(e.target.classList));
                    console.log('[BUTTON DEBUG] Target dataset:', e.target.dataset);
                    console.log('[BUTTON DEBUG] Target innerHTML:', e.target.innerHTML);
                    
                    if (e.target.classList.contains('position-close-btn')) {
                        e.preventDefault();
                        e.stopPropagation();
                        const instrument = e.target.dataset.instrument;
                        const accountId = e.target.dataset.accountid;
                        const side = e.target.dataset.side;
                        console.log('[BUTTON DEBUG] Close button clicked for instrument:', instrument, 'account:', accountId, 'side:', side);
                        showCloseModal(instrument, accountId, side);
                    } else if (e.target.classList.contains('position-quick-close-btn')) {
                        e.preventDefault();
                        e.stopPropagation();
                        const instrument = e.target.dataset.instrument;
                        const accountId = e.target.dataset.accountid;
                        const side = e.target.dataset.side;
                        console.log('[BUTTON DEBUG] Quick close button clicked for instrument:', instrument, 'account:', accountId, 'side:', side);
                        quickClosePosition(instrument, accountId, side);
                    } /* DISABLED SL/TP functionality
                    else if (e.target.classList.contains('position-sltp-btn')) {
                        e.preventDefault();
                        e.stopPropagation();
                        const instrument = e.target.dataset.instrument;
                        console.log('[BUTTON DEBUG] SL/TP button clicked for instrument:', instrument);
                        showSLTPModal(instrument);
                    } */ else {
                        console.log('[BUTTON DEBUG] Click on positions container, but not on a known button');
                        console.log('[BUTTON DEBUG] Available classes:', Array.from(e.target.classList));
                    }
                });
                console.log('[DEBUG] Event listener added to positions container');
            } else {
                console.error('[ERROR] Positions container not found!');
            }
        }
        
        async function loadAccounts() {
            try {
                const resp = await fetch('/api/accounts');
                if (!resp.ok) {
                    throw new Error(\`HTTP error! status: \${resp.status}\`);
                }
                accounts = await resp.json();
                console.log('Loaded accounts:', accounts);
            
                const select = document.getElementById('accountSelect');
                // Always keep the default option
                let optionsHTML = '<option value="">Select Account...</option>';
                optionsHTML += accounts.map(acc => 
                    \`<option value="\${acc.id}">\${acc.name || acc.id} - $\${acc.balance?.toFixed(2) || '0.00'}</option>\`
                ).join('');
                
                select.innerHTML = optionsHTML;
                
                if (accounts.length > 0) {
                    select.value = accounts[0].id;
                }
            } catch (error) {
                console.error('Failed to load accounts:', error);
                const select = document.getElementById('accountSelect');
                select.innerHTML = '<option value="">Failed to load accounts</option>';
            }
        }
        
        async function refreshPositions() {
            // Force a fresh load from Connection Manager
            const resp = await fetch('/api/positions/refresh', { method: 'POST' });
            const result = await resp.json();
            if (result.success) {
                // Now update the display
                await updatePositions();
            } else {
                alert('Failed to refresh positions: ' + (result.error || 'Unknown error'));
            }
        }
        
        async function updatePositions(silent = false) {
            // For silent updates, just fetch current positions without triggering server refresh
            // This prevents spamming the aggregator and connection manager
            
            // Fetch the current positions from server memory
            const resp = await fetch('/api/positions' + (silent ? '?silent=true' : ''));
            const positionsList = await resp.json();
            
            positions.clear();
            positionsList.forEach(pos => {
                // Use instrument as position key (matching server-side)
                const positionKey = pos.instrument;
                positions.set(positionKey, pos);
            });
            
            const positionsDiv = document.getElementById('positions');
            if (positionsList.length === 0 || positionsList.every(p => p.quantity === 0)) {
                positionsDiv.innerHTML = '<p>No open positions</p>';
            } else {
                // Group positions by account
                const positionsByAccount = {};
                positionsList.forEach(pos => {
                    if (pos.quantity !== 0 && pos.instrument && pos.instrument !== 'undefined') {
                        if (!positionsByAccount[pos.accountId]) {
                            positionsByAccount[pos.accountId] = [];
                        }
                        positionsByAccount[pos.accountId].push(pos);
                    }
                });
                
                // Create HTML for each account card
                let html = '';
                for (const [accountId, accountPositions] of Object.entries(positionsByAccount)) {
                    // Find account details
                    const account = accounts.find(acc => acc.id == accountId || acc.accountId == accountId);
                    const accountName = account ? (account.name || account.id) : accountId;
                    
                    // Calculate unrealized P&L for this account
                    let totalUnrealizedPnL = 0;
                    accountPositions.forEach(pos => {
                        if (pos.unrealizedPnL) {
                            totalUnrealizedPnL += pos.unrealizedPnL;
                        }
                    });
                    
                    // Get account balance
                    const accountBalance = account && account.balance ? account.balance : 0;
                    const totalEquity = accountBalance + totalUnrealizedPnL;
                    const totalEquityClass = totalEquity > accountBalance ? 'profit' : totalEquity < accountBalance ? 'loss' : '';
                    const unrealizedPnLClass = totalUnrealizedPnL > 0 ? 'profit' : totalUnrealizedPnL < 0 ? 'loss' : '';
                    
                    html += '<div class="account-positions-card">';
                    html += '<h3>Account: ' + accountName + ' (ID: ' + accountId + ')</h3>';
                    html += '<div class="account-pnl-summary" style="padding: 15px; background: rgba(0,0,0,0.3); border-radius: 4px; margin-bottom: 15px; border: 1px solid rgba(255,255,255,0.1);">';
                    
                    // Account Balance
                    html += '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">';
                    html += '<span style="font-weight: 500;">Account Balance:</span>';
                    html += '<span style="font-weight: bold;">$' + accountBalance.toFixed(2) + '</span>';
                    html += '</div>';
                    
                    // Unrealized P&L
                    html += '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">';
                    html += '<span style="font-weight: 500;">Unrealized P&L:</span>';
                    html += '<span class="' + unrealizedPnLClass + '" style="font-weight: bold;">$' + totalUnrealizedPnL.toFixed(2) + '</span>';
                    html += '</div>';
                    
                    // Separator line
                    html += '<hr style="margin: 10px 0; border: none; border-top: 1px solid rgba(255,255,255,0.1);">';
                    
                    // Total (Balance + Unrealized P&L)
                    html += '<div style="display: flex; justify-content: space-between; align-items: center;">';
                    html += '<span style="font-weight: 600; font-size: 1.2em;">Total Equity:</span>';
                    html += '<span class="' + totalEquityClass + '" style="font-weight: bold; font-size: 1.3em;">$' + totalEquity.toFixed(2) + '</span>';
                    html += '</div>';
                    
                    html += '</div>';
                    html += '<table><tr><th>Account</th><th>Instrument</th><th>Position</th><th>Avg Price</th><th>Current</th><th>Unrealized P&L</th><th>SL</th><th>TP</th><th>Actions</th></tr>';
                    
                    accountPositions.forEach(pos => {
                        // Use the side field from the position data, not quantity sign
                        const posClass = pos.side === 'LONG' ? 'long' : 'short';
                        const posText = pos.side || 'UNKNOWN';
                        const pnlClass = pos.unrealizedPnL > 0 ? 'profit' : pos.unrealizedPnL < 0 ? 'loss' : '';
                        const avgPrice = pos.avgPrice ? pos.avgPrice.toFixed(2) : 'Calculating...';
                        const currentPrice = pos.currentPrice ? pos.currentPrice.toFixed(2) : 'Awaiting data';
                        const pnl = pos.unrealizedPnL ? '$' + pos.unrealizedPnL.toFixed(2) : 'Pending market data';
                        const sl = pos.stopLoss ? pos.stopLoss.toFixed(2) : '-';
                        const tp = pos.takeProfit ? pos.takeProfit.toFixed(2) : '-';
                        
                        html += '<tr>' +
                            '<td>' + accountId + '</td>' +
                            '<td>' + pos.instrument + '</td>' +
                            '<td class="position ' + posClass + '">' + posText + ' ' + Math.abs(pos.quantity) + '</td>' +
                            '<td>' + avgPrice + '</td>' +
                            '<td>' + currentPrice + '</td>' +
                            '<td class="' + pnlClass + '">' + pnl + '</td>' +
                            '<td>' + sl + '</td>' +
                            '<td>' + tp + '</td>' +
                            '<td>' +
                                '<button type="button" data-instrument="' + pos.instrument + '" data-accountid="' + pos.accountId + '" data-side="' + pos.side + '" class="button close position-close-btn">Close</button>' +
                                '<button type="button" data-instrument="' + pos.instrument + '" data-accountid="' + pos.accountId + '" data-side="' + pos.side + '" class="button quick-close position-quick-close-btn" style="margin-left: 8px;">Quick Close</button>' +
                            '</td>' +
                        '</tr>';
                    });
                    
                    html += '</table>';
                    html += '</div>';
                }
                
                positionsDiv.innerHTML = html;
            }
        }
        
        
        
        function showOrderModal(side) {
            if (!selectedContract) {
                alert('Please select a contract first');
                return;
            }
            
            const contractData = contracts.get(selectedContract);
            if (!contractData) {
                alert('Invalid contract selected');
                return;
            }
            
            currentOrderSide = side;
            const modal = document.getElementById('orderModal');
            const quantity = document.getElementById('quantityInput').value;
            
            document.getElementById('orderModalTitle').textContent = side + ' Order';
            document.getElementById('modalInstrument').textContent = \`\${contractData.monthYear} (\${contractData.symbol})\`;
            document.getElementById('modalQuantity').textContent = quantity;
            
            // Update current price display
            document.getElementById('modalCurrentPrice').textContent = 'Loading...';
            getCurrentMarketPrice(selectedContract).then(currentPrice => {
                document.getElementById('modalCurrentPrice').textContent = currentPrice ? currentPrice.toFixed(2) : 'Unavailable';
            });
            
            const btn = document.getElementById('confirmOrderBtn');
            btn.className = side === 'BUY' ? 'button button-rounded buy' : 'button button-rounded sell';
            btn.textContent = side + ' ' + quantity + ' ' + selectedContract;
            
            // Set SL/TP defaults
            document.getElementById('enableSL').checked = true;
            document.getElementById('enableTP').checked = true;
            document.getElementById('slContent').style.display = 'block';
            document.getElementById('tpContent').style.display = 'block';
            document.getElementById('slValue').value = '5';  // Default 5 points for SL
            document.getElementById('tpValue').value = '10'; // Default 10 points for TP
            setSLMode('points');
            setTPMode('points');
            updateRiskReward();
            
            modal.style.display = 'flex';
        }
        
        function setSLMode(mode) {
            slMode = mode;
            const buttons = document.querySelectorAll('#slContent .mode-button');
            buttons.forEach(btn => btn.classList.remove('active'));
            buttons[mode === 'points' ? 0 : 1].classList.add('active');
            
            const input = document.getElementById('slValue');
            input.placeholder = mode === 'points' ? 'Enter points' : 'Enter dollar amount';
            updateRiskReward();
        }
        
        function setTPMode(mode) {
            tpMode = mode;
            const buttons = document.querySelectorAll('#tpContent .mode-button');
            buttons.forEach(btn => btn.classList.remove('active'));
            buttons[mode === 'points' ? 0 : 1].classList.add('active');
            
            const input = document.getElementById('tpValue');
            input.placeholder = mode === 'points' ? 'Enter points' : 'Enter dollar amount';
            updateRiskReward();
        }
        
        async function updateRiskReward() {
            if (!selectedContract) return;
            
            const quantity = parseInt(document.getElementById('quantityInput').value) || 1;
            const contractData = contracts.get(selectedContract);
            const multiplier = contractData?.multiplier || 1;
            
            const enableSL = document.getElementById('enableSL').checked;
            const enableTP = document.getElementById('enableTP').checked;
            
            // Get current market price for calculations
            document.getElementById('modalCurrentPrice').textContent = 'Loading...';
            const currentPrice = await getCurrentMarketPrice(selectedContract);
            document.getElementById('modalCurrentPrice').textContent = currentPrice ? currentPrice.toFixed(2) : 'Unavailable';
            
            let riskDollars = 0;
            let rewardDollars = 0;
            let slPriceLevel = null;
            let tpPriceLevel = null;
            
            if (enableSL) {
                const slValue = parseFloat(document.getElementById('slValue').value) || 0;
                if (slMode === 'points' && slValue > 0) {
                    riskDollars = slValue * quantity * multiplier;
                    document.getElementById('slCalculated').textContent = \`= $\${riskDollars.toFixed(2)} risk\`;
                    
                    // Calculate actual price level for SL
                    if (currentPrice && currentOrderSide) {
                        if (currentOrderSide === 'BUY') {
                            slPriceLevel = currentPrice - slValue; // SL below entry for long
                        } else {
                            slPriceLevel = currentPrice + slValue; // SL above entry for short
                        }
                        document.getElementById('slPriceLevel').textContent = slPriceLevel.toFixed(2);
                        document.getElementById('slPriceDisplay').style.display = 'block';
                    }
                } else if (slMode === 'dollars' && slValue > 0) {
                    riskDollars = slValue;
                    const points = slValue / (quantity * multiplier);
                    document.getElementById('slCalculated').textContent = \`= \${points.toFixed(1)} points\`;
                    
                    // Calculate price level from dollar risk
                    if (currentPrice && currentOrderSide) {
                        if (currentOrderSide === 'BUY') {
                            slPriceLevel = currentPrice - points;
                        } else {
                            slPriceLevel = currentPrice + points;
                        }
                        document.getElementById('slPriceLevel').textContent = slPriceLevel.toFixed(2);
                        document.getElementById('slPriceDisplay').style.display = 'block';
                    }
                } else {
                    document.getElementById('slPriceLevel').textContent = '-';
                    document.getElementById('slPriceDisplay').style.display = 'none';
                }
            } else {
                document.getElementById('slPriceLevel').textContent = '-';
                document.getElementById('slPriceDisplay').style.display = 'none';
            }
            
            if (enableTP) {
                const tpValue = parseFloat(document.getElementById('tpValue').value) || 0;
                if (tpMode === 'points' && tpValue > 0) {
                    rewardDollars = tpValue * quantity * multiplier;
                    document.getElementById('tpCalculated').textContent = \`= $\${rewardDollars.toFixed(2)} profit\`;
                    
                    // Calculate actual price level for TP
                    if (currentPrice && currentOrderSide) {
                        if (currentOrderSide === 'BUY') {
                            tpPriceLevel = currentPrice + tpValue; // TP above entry for long
                        } else {
                            tpPriceLevel = currentPrice - tpValue; // TP below entry for short
                        }
                        document.getElementById('tpPriceLevel').textContent = tpPriceLevel.toFixed(2);
                        document.getElementById('tpPriceDisplay').style.display = 'block';
                    }
                } else if (tpMode === 'dollars' && tpValue > 0) {
                    rewardDollars = tpValue;
                    const points = tpValue / (quantity * multiplier);
                    document.getElementById('tpCalculated').textContent = \`= \${points.toFixed(1)} points\`;
                    
                    // Calculate price level from dollar target
                    if (currentPrice && currentOrderSide) {
                        if (currentOrderSide === 'BUY') {
                            tpPriceLevel = currentPrice + points;
                        } else {
                            tpPriceLevel = currentPrice - points;
                        }
                        document.getElementById('tpPriceLevel').textContent = tpPriceLevel.toFixed(2);
                        document.getElementById('tpPriceDisplay').style.display = 'block';
                    }
                } else {
                    document.getElementById('tpPriceLevel').textContent = '-';
                    document.getElementById('tpPriceDisplay').style.display = 'none';
                }
            } else {
                document.getElementById('tpPriceLevel').textContent = '-';
                document.getElementById('tpPriceDisplay').style.display = 'none';
            }
            
            if (enableSL || enableTP) {
                document.getElementById('riskRewardDisplay').style.display = 'flex';
                document.getElementById('riskAmount').textContent = \`$\${riskDollars.toFixed(2)}\`;
                document.getElementById('rewardAmount').textContent = \`$\${rewardDollars.toFixed(2)}\`;
                
                if (riskDollars > 0 && rewardDollars > 0) {
                    const ratio = rewardDollars / riskDollars;
                    document.getElementById('rrRatio').textContent = \`1:\${ratio.toFixed(2)}\`;
                } else {
                    document.getElementById('rrRatio').textContent = '-';
                }
            } else {
                document.getElementById('riskRewardDisplay').style.display = 'none';
            }
        }
        
        async function confirmOrder() {
            const quantity = document.getElementById('quantityInput').value;
            const accountId = document.getElementById('accountSelect').value;
            
            if (!selectedContract) {
                alert('Please select a contract first');
                return;
            }
            
            // Enhanced account validation
            if (!accountId) {
                alert('Please select an account. If no accounts are visible, check Connection Manager status.');
                return;
            }
            
            // Validate account exists in our accounts list
            const selectedAccount = accounts.find(acc => acc.id === parseInt(accountId));
            if (!selectedAccount) {
                alert('Selected account is invalid. Please refresh the page and try again.');
                return;
            }
            
            // Check if this is a mock/test account
            if (selectedAccount.isDemo || selectedAccount.status === 'TESTING') {
                if (!confirm('You are using a test/mock account. This order will be simulated. Continue?')) {
                    return;
                }
            }
            
            const orderData = {
                instrument: selectedContract,
                side: currentOrderSide,
                quantity: parseInt(quantity),
                accountId: parseInt(accountId)  // CRITICAL: Send the selected account ID
            };
            
            // Add SL/TP if enabled
            if (document.getElementById('enableSL').checked) {
                const slValue = parseFloat(document.getElementById('slValue').value);
                if (slValue) {
                    // Get contract data to find the multiplier
                    const contractData = contracts.get(selectedContract);
                    const multiplier = contractData?.multiplier || 1;
                    let slPoints;
                    
                    if (slMode === 'points') {
                        slPoints = slValue;
                    } else {
                        // Convert dollars to points
                        slPoints = slValue / (parseInt(quantity) * multiplier);
                    }
                    
                    orderData.stopLoss = {
                        enabled: true,
                        points: slPoints,
                        inputType: slMode,
                        inputValue: slValue
                    };
                }
            }
            
            if (document.getElementById('enableTP').checked) {
                const tpValue = parseFloat(document.getElementById('tpValue').value);
                if (tpValue) {
                    // Get contract data to find the multiplier
                    const contractData = contracts.get(selectedContract);
                    const multiplier = contractData?.multiplier || 1;
                    let tpPoints;
                    
                    if (tpMode === 'points') {
                        tpPoints = tpValue;
                    } else {
                        // Convert dollars to points
                        tpPoints = tpValue / (parseInt(quantity) * multiplier);
                    }
                    
                    orderData.takeProfit = {
                        enabled: true,
                        points: tpPoints,
                        inputType: tpMode,
                        inputValue: tpValue
                    };
                }
            }
            
            // Get current market price and calculate actual stop/limit prices
            try {
                // Get the symbol from the selected contract
                const contractData = contracts.get(selectedContract);
                const symbol = contractData ? contractData.symbol : selectedContract.match(/[A-Z]+/)[0];
                
                // Fetch current market price
                const priceResp = await fetch(\`/api/prices/\${symbol}\`);
                if (priceResp.ok) {
                    const priceData = await priceResp.json();
                    const currentPrice = priceData.price;
                    
                    // Calculate actual stop loss and take profit prices if SL/TP are enabled
                    if (orderData.stopLoss && orderData.stopLoss.enabled) {
                        const slPoints = orderData.stopLoss.points;
                        let stopPrice;
                        
                        if (currentOrderSide === 'BUY') {
                            stopPrice = currentPrice - slPoints;
                        } else { // SELL
                            stopPrice = currentPrice + slPoints;
                        }
                        
                        orderData.stopPrice = stopPrice;
                        console.log(\`Calculated stop price: \${stopPrice} (\${currentOrderSide}, entry: \${currentPrice}, SL points: \${slPoints})\`);
                    }
                    
                    if (orderData.takeProfit && orderData.takeProfit.enabled) {
                        const tpPoints = orderData.takeProfit.points;
                        let limitPrice;
                        
                        if (currentOrderSide === 'BUY') {
                            limitPrice = currentPrice + tpPoints;
                        } else { // SELL
                            limitPrice = currentPrice - tpPoints;
                        }
                        
                        orderData.limitPrice = limitPrice;
                        console.log(\`Calculated limit price: \${limitPrice} (\${currentOrderSide}, entry: \${currentPrice}, TP points: \${tpPoints})\`);
                    }
                    
                    // Also add the current market price for reference
                    orderData.entryPrice = currentPrice;
                } else {
                    console.warn(\`Could not fetch current price for \${symbol}, proceeding without price calculations\`);
                }
            } catch (priceError) {
                console.error('Error fetching current price:', priceError.message);
                // Continue with the order placement even if price fetch fails
            }
            
            try {
                const resp = await fetch('/api/order', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(orderData)
                });
                
                const result = await resp.json();
                if (result.success) {
                    closeModal('orderModal');
                    // Position updates now happen via SSE when order is filled
                } else {
                    alert('Order failed: ' + result.error);
                }
            } catch (error) {
                alert('Error placing order: ' + error.message);
            }
        }
        
        function showCloseModal(instrument, accountId, side) {
            // Use instrument as position key
            const positionKey = instrument;
            const position = positions.get(positionKey);
            if (!position) {
                console.error('Position not found for key:', positionKey);
                return;
            }
            
            currentCloseInstrument = instrument;
            currentCloseAccountId = accountId;
            currentCloseSide = side;
            
            const info = document.getElementById('closePositionInfo');
            const posClass = position.quantity > 0 ? 'long' : 'short';
            const posText = position.quantity > 0 ? 'LONG' : 'SHORT';
            
            info.innerHTML = 
                '<p>Instrument: <strong>' + instrument + '</strong></p>' +
                '<p>Position: <strong class="position ' + posClass + '">' + posText + ' ' + Math.abs(position.quantity) + '</strong></p>' +
                '<p>Average Price: <strong>$' + (position.avgPrice?.toFixed(2) || 'N/A') + '</strong></p>' +
                '<p>Unrealized P&L: <strong class="' + (position.unrealizedPnL >= 0 ? 'profit' : 'loss') + '">' +
                    '$' + (position.unrealizedPnL?.toFixed(2) || '0.00') +
                '</strong></p>';
            
            document.getElementById('closeModal').style.display = 'flex';
        }
        
        function showSLTPModal(instrument) {
            const position = positions.get(instrument);
            if (!position) return;
            
            currentSLTPPosition = position;
            
            document.getElementById('sltpInstrument').textContent = instrument;
            document.getElementById('sltpPosition').textContent = 
                (position.quantity > 0 ? 'LONG ' : 'SHORT ') + Math.abs(position.quantity);
            document.getElementById('sltpEntryPrice').textContent = 
                position.avgPrice ? '$' + position.avgPrice.toFixed(2) : '-';
            document.getElementById('sltpCurrentPrice').textContent = 
                position.currentPrice ? '$' + position.currentPrice.toFixed(2) : '-';
            
            // Pre-fill current values if they exist
            document.getElementById('sltpStopLoss').value = position.stopLoss || '';
            document.getElementById('sltpTakeProfit').value = position.takeProfit || '';
            
            document.getElementById('sltpModal').style.display = 'flex';
        }
        
        function testSLTPModal() {
            // Create a mock position for testing SL/TP modal functionality
            const contractId = selectedContract || 'CON.F.US.MGC.N25';
            
            currentSLTPPosition = {
                instrument: contractId,
                quantity: 2,
                avgPrice: 2000.50,
                currentPrice: 2002.25,
                stopLoss: null,
                takeProfit: null,
                positionId: 'TEST_POSITION_' + Date.now()
            };
            
            document.getElementById('sltpInstrument').textContent = contractId + ' (TEST)';
            document.getElementById('sltpPosition').textContent = 'LONG 2 (Mock Position)';
            document.getElementById('sltpEntryPrice').textContent = '$2000.50';
            document.getElementById('sltpCurrentPrice').textContent = '$2002.25';
            
            // Clear current values for testing
            document.getElementById('sltpStopLoss').value = '';
            document.getElementById('sltpTakeProfit').value = '';
            
            document.getElementById('sltpModal').style.display = 'flex';
        }
        
        
        async function confirmSLTP() {
            if (!currentSLTPPosition || !currentSLTPPosition.positionId) {
                alert('Position ID not available. The position might need to be reopened.');
                return;
            }
            
            const stopLoss = parseFloat(document.getElementById('sltpStopLoss').value) || undefined;
            const takeProfit = parseFloat(document.getElementById('sltpTakeProfit').value) || undefined;
            
            if (stopLoss === undefined && takeProfit === undefined) {
                alert('Please enter at least one value');
                return;
            }
            
            // Check if this is a test position
            if (currentSLTPPosition.positionId.startsWith('TEST_POSITION_')) {
                alert('Test successful! SL/TP modal is working correctly.\\n\\nStop Loss: ' + (stopLoss ? '$' + stopLoss.toFixed(2) : 'Not set') + '\\nTake Profit: ' + (takeProfit ? '$' + takeProfit.toFixed(2) : 'Not set'));
                closeModal('sltpModal');
                return;
            }
            
            try {
                const resp = await fetch('/api/update-sl-tp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        positionId: currentSLTPPosition.positionId,
                        stopLoss,
                        takeProfit
                    })
                });
                
                const result = await resp.json();
                if (result.success) {
                    closeModal('sltpModal');
                    updatePositions();
                } else {
                    alert('Failed to update SL/TP: ' + result.error);
                }
            } catch (error) {
                alert('Error updating SL/TP: ' + error.message);
            }
        }
        
        async function confirmClose() {
            const closeType = document.getElementById('closeType').value;
            const quantity = closeType === 'partial' ? 
                parseInt(document.getElementById('partialQty').value) : null;
            
            try {
                const resp = await fetch('/api/close-position', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        instrument: currentCloseInstrument,
                        accountId: currentCloseAccountId,
                        side: currentCloseSide,
                        quantity,
                        closeType
                    })
                });
                
                const result = await resp.json();
                if (result.success) {
                    closeModal('closeModal');
                    updatePositions();
                } else {
                    alert('Close failed: ' + result.error);
                }
            } catch (error) {
                alert('Error closing position: ' + error.message);
            }
        }
        
        async function quickClosePosition(instrument, accountId, side) {
            console.log('quickClosePosition called with instrument:', instrument, 'account:', accountId, 'side:', side);
            try {
                console.log('Sending close request to /api/close-position');
                const resp = await fetch('/api/close-position', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        instrument: instrument,
                        accountId: accountId,
                        side: side,
                        quantity: null,
                        closeType: 'full'
                    })
                });
                
                const result = await resp.json();
                console.log('Close position response:', result);
                if (result.success) {
                    updatePositions();
                    console.log('Quick closed position: ' + instrument);
                } else {
                    alert('Quick close failed: ' + result.error);
                }
            } catch (error) {
                console.error('Error in quickClosePosition:', error);
                alert('Error closing position: ' + error.message);
            }
        }
        
        function closeModal(modalId) {
            document.getElementById(modalId).style.display = 'none';
        }
        
        
        
        
        
        
        // Refresh instruments from server
        async function refreshInstruments() {
            console.log('Refreshing instruments...');
            await loadInstruments();
            alert('Instruments refreshed successfully');
        }
        
        // Start the app
        init();
    </script>
</body>
</html>
        `;
    }

    setupGracefulShutdown() {
        // Try to set up keyboard input for graceful shutdown (may not work in all environments)
        try {
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(true);
                process.stdin.resume();
                process.stdin.setEncoding('utf8');
                
                process.stdin.on('data', (key) => {
                    // Handle 'q' key press
                    if (key.toLowerCase() === 'q') {
                        console.log('\n🛑 Graceful shutdown initiated...');
                        this.shutdown();
                    }
                    // Handle Ctrl+C as backup
                    else if (key === '\u0003') {
                        console.log('\n🛑 Shutdown signal received: SIGINT');
                        this.shutdown();
                    }
                });
            }
        } catch (error) {
            // Ignore errors in non-TTY environments (like Windows batch)
        }
        
        // Handle standard signals - these work in all environments
        process.on('SIGINT', () => {
            console.log('\n🛑 Shutdown signal received: SIGINT');
            this.shutdown();
        });
        
        process.on('SIGTERM', () => {
            console.log('\n🛑 Shutdown signal received: SIGTERM');
            this.shutdown();
        });
        
        // Windows-specific: Handle CTRL_CLOSE_EVENT
        if (process.platform === 'win32') {
            process.on('SIGHUP', () => {
                console.log('\n🛑 Window close detected');
                this.shutdown();
            });
        }
    }

    async shutdown() {
        this.log('Shutting down gracefully...');
        
        // Clear heartbeat interval first
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        
        if (this.priceFetchInterval) {
            clearInterval(this.priceFetchInterval);
        }
        
        if (this.accountRefreshInterval) {
            clearInterval(this.accountRefreshInterval);
        }
        
        if (this.positionSyncInterval) {
            clearInterval(this.positionSyncInterval);
        }
        
        if (this.redisClient) {
            await this.redisClient.quit();
        }
        
        if (this.redisSubscriber) {
            await this.redisSubscriber.quit();
        }
        
        if (this.server) {
            this.server.close();
        }
        
        this.log('Shutdown complete');
        process.exit(0);
    }
}

// Better error handling
process.on('uncaughtException', (error) => {
    console.error('[MANUAL-TRADING-V2] Uncaught Exception:', error.message);
    console.error('[MANUAL-TRADING-V2] Stack:', error.stack);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[MANUAL-TRADING-V2] Unhandled Rejection at:', promise);
    console.error('[MANUAL-TRADING-V2] Reason:', reason);
    process.exit(1);
});

// Create and start server
console.log('[MANUAL-TRADING-V2] Creating server instance...');
const server = new ManualTradingServerV2();
console.log('[MANUAL-TRADING-V2] Starting server initialization...');
server.init().then(() => {
    console.log('[MANUAL-TRADING-V2] Server initialization completed successfully');
}).catch(error => {
    console.error('[MANUAL-TRADING-V2] Failed to start server:', error.message);
    console.error('[MANUAL-TRADING-V2] Stack:', error.stack);
    process.exit(1);
});

// Export for testing
module.exports = ManualTradingServerV2;