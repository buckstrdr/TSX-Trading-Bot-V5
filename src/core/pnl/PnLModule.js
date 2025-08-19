/**
 * P&L Module - Handles profit/loss calculations using API endpoints
 * Architecture: P&L Module <-> Aggregator <-> Connection Manager <-> API
 * Replaces manual P&L calculations with live API data
 */

const EventEmitter = require('events');
const redis = require('redis');

class PnLModule extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            redis: config.redis || { host: 'localhost', port: 6379 },
            refreshInterval: config.refreshInterval || 5000, // 5 seconds
            requestTimeout: config.requestTimeout || 10000, // 10 seconds
            enableDebugLogging: config.enableDebugLogging || true
        };
        
        this.state = {
            connected: false,
            positions: new Map(), // positionId -> position data
            trades: new Map(), // tradeId -> trade data
            dailyPnL: 0,
            accountPnL: new Map() // accountId -> daily P&L
        };
        
        // Redis clients for communication with aggregator
        this.redisClient = null;
        this.subscriber = null;
        
        // Active requests tracking
        this.pendingRequests = new Map();
        
        console.log('💰 P&L Module initialized');
        console.log(`   Refresh interval: ${this.config.refreshInterval}ms`);
        console.log(`   Request timeout: ${this.config.requestTimeout}ms`);
    }
    
    /**
     * Initialize P&L module and connect to Redis
     */
    async initialize() {
        try {
            this.log('🔌 Initializing P&L Module...');
            
            // Initialize Redis clients
            this.redisClient = redis.createClient({
                socket: {
                    host: this.config.redis.host,
                    port: this.config.redis.port
                }
            });
            
            this.subscriber = redis.createClient({
                socket: {
                    host: this.config.redis.host,
                    port: this.config.redis.port
                }
            });
            
            // Connect Redis clients
            await this.redisClient.connect();
            await this.subscriber.connect();
            
            // Subscribe to P&L response channel with proper Redis v4 pattern
            await this.subscriber.subscribe('pnl:responses', (message) => {
                this.handleResponse(message);
            });
            
            this.state.connected = true;
            this.log('✅ P&L Module connected to Redis');
            
            // Start periodic refresh
            this.startPeriodicRefresh();
            
            this.emit('connected');
            return true;
            
        } catch (error) {
            this.log(`❌ P&L Module initialization failed: ${error.message}`);
            this.emit('error', error);
            return false;
        }
    }
    
    /**
     * Request position P&L data from API through aggregator
     */
    async getPositionPnL(positionId, accountId) {
        if (!this.state.connected) {
            throw new Error('P&L Module not connected');
        }
        
        try {
            const requestId = this.generateRequestId('position_pnl');
            
            // Create request
            const request = {
                type: 'GET_POSITION_PNL',
                requestId: requestId,
                positionId: positionId,
                accountId: accountId,
                timestamp: Date.now()
            };
            
            this.log(`📤 Requesting position P&L for position ${positionId}`);
            
            // Send request to aggregator
            await this.redisClient.publish('aggregator:pnl_requests', JSON.stringify(request));
            
            // Wait for response
            const response = await this.waitForResponse(requestId);
            
            if (response.success) {
                // Cache position data
                this.state.positions.set(positionId, response.position);
                this.log(`✅ Position P&L retrieved: ${response.position.unrealizedPnL}`);
                
                return response.position;
            } else {
                throw new Error(response.error || 'Failed to get position P&L');
            }
            
        } catch (error) {
            this.log(`❌ Get position P&L failed: ${error.message}`);
            throw error;
        }
    }
    
    /**
     * Request trade data from search endpoint through aggregator
     */
    async getTradeData(searchParams = {}) {
        if (!this.state.connected) {
            throw new Error('P&L Module not connected');
        }
        
        try {
            const requestId = this.generateRequestId('trade_search');
            
            // Create search request
            const request = {
                type: 'SEARCH_TRADES',
                requestId: requestId,
                searchParams: {
                    accountId: searchParams.accountId,
                    symbol: searchParams.symbol,
                    startDate: searchParams.startDate || this.getTodayStart(),
                    endDate: searchParams.endDate || new Date().toISOString(),
                    status: searchParams.status || 'FILLED',
                    ...searchParams
                },
                timestamp: Date.now()
            };
            
            this.log(`📤 Searching trades with params:`, request.searchParams);
            
            // Send request to aggregator
            await this.redisClient.publish('aggregator:pnl_requests', JSON.stringify(request));
            
            // Wait for response
            const response = await this.waitForResponse(requestId);
            
            if (response.success) {
                // Cache trade data
                if (response.trades && Array.isArray(response.trades)) {
                    response.trades.forEach(trade => {
                        this.state.trades.set(trade.id || trade.tradeId, trade);
                    });
                }
                
                this.log(`✅ Retrieved ${response.trades?.length || 0} trades`);
                return response.trades || [];
            } else {
                throw new Error(response.error || 'Failed to search trades');
            }
            
        } catch (error) {
            this.log(`❌ Trade search failed: ${error.message}`);
            throw error;
        }
    }
    
    /**
     * Get current account P&L for the day
     */
    async getAccountPnL(accountId) {
        if (!this.state.connected) {
            throw new Error('P&L Module not connected');
        }
        
        try {
            const requestId = this.generateRequestId('account_pnl');
            
            // Create account P&L request
            const request = {
                type: 'GET_ACCOUNT_PNL',
                requestId: requestId,
                accountId: accountId,
                date: new Date().toISOString().split('T')[0], // Today's date
                timestamp: Date.now()
            };
            
            this.log(`📤 Requesting account P&L for account: ${accountId}, requestId: ${requestId}`);
            
            // Send request to aggregator
            await this.redisClient.publish('aggregator:pnl_requests', JSON.stringify(request));
            
            // Wait for response
            const response = await this.waitForResponse(requestId);
            
            if (response.success) {
                // Cache account P&L
                this.state.accountPnL.set(accountId, response.pnl);
                this.state.dailyPnL = response.pnl.dailyPnL || 0;
                
                // Include positions in the response for rich UI integration
                const enrichedPnL = {
                    ...response.pnl,
                    // Include positions from both pnl.positions and top-level positions
                    positions: response.positions || response.pnl.positions || []
                };
                
                this.log(`✅ Account P&L retrieved: ${response.pnl.dailyPnL}, ${enrichedPnL.positions.length} positions included`);
                this.log(`🔍 [DEBUG] Response structure:`, {
                    hasResponsePositions: !!(response.positions),
                    hasResponsePnLPositions: !!(response.pnl.positions),
                    responsePositionsLength: response.positions?.length || 0,
                    responsePnLPositionsLength: response.pnl.positions?.length || 0,
                    enrichedPositionsLength: enrichedPnL.positions.length,
                    responseKeys: Object.keys(response),
                    pnlKeys: Object.keys(response.pnl)
                });
                return enrichedPnL;
            } else {
                throw new Error(response.error || 'Failed to get account P&L');
            }
            
        } catch (error) {
            this.log(`❌ Get account P&L failed: ${error.message}`);
            throw error;
        }
    }
    
    /**
     * Get cached position P&L or fetch from API
     */
    async getCachedPositionPnL(positionId, accountId, maxAge = 5000) {
        const cached = this.state.positions.get(positionId);
        
        if (cached && (Date.now() - cached.lastUpdate < maxAge)) {
            this.log(`📊 Using cached P&L for position ${positionId}: ${cached.unrealizedPnL}`);
            return cached;
        }
        
        // Fetch fresh data
        return await this.getPositionPnL(positionId, accountId);
    }
    
    /**
     * Get daily P&L summary
     */
    getDailyPnLSummary() {
        const summary = {
            dailyPnL: this.state.dailyPnL,
            accountPnL: Object.fromEntries(this.state.accountPnL),
            activePositions: this.state.positions.size,
            totalTrades: this.state.trades.size,
            lastUpdate: new Date().toISOString()
        };
        
        return summary;
    }
    
    /**
     * Handle response from aggregator
     */
    handleResponse(message) {
        try {
            const response = JSON.parse(message);
            const { requestId } = response;
            
            if (requestId && this.pendingRequests.has(requestId)) {
                const { resolve, reject, timeout } = this.pendingRequests.get(requestId);
                
                // Clear timeout
                if (timeout) {
                    clearTimeout(timeout);
                }
                
                // Remove from pending requests
                this.pendingRequests.delete(requestId);
                
                // Resolve or reject based on response
                if (response.success) {
                    resolve(response);
                } else {
                    reject(new Error(response.error || 'Request failed'));
                }
            }
            
        } catch (error) {
            this.log(`❌ Response handling error: ${error.message}`);
        }
    }
    
    /**
     * Wait for response to a request
     */
    waitForResponse(requestId) {
        return new Promise((resolve, reject) => {
            // Set timeout
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error('Request timeout'));
            }, this.config.requestTimeout);
            
            // Store request promise
            this.pendingRequests.set(requestId, {
                resolve,
                reject,
                timeout,
                timestamp: Date.now()
            });
        });
    }
    
    /**
     * Generate unique request ID
     */
    generateRequestId(type) {
        return `pnl_${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    /**
     * Get start of today for date filtering
     */
    getTodayStart() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return today.toISOString();
    }
    
    /**
     * Start periodic refresh of P&L data
     */
    startPeriodicRefresh() {
        this.refreshInterval = setInterval(async () => {
            try {
                // Refresh active positions P&L
                for (const [positionId, position] of this.state.positions) {
                    if (position.accountId) {
                        await this.getPositionPnL(positionId, position.accountId);
                    }
                }
                
                // Refresh account P&L for all active accounts
                const activeAccounts = new Set();
                this.state.positions.forEach(position => {
                    if (position.accountId) {
                        activeAccounts.add(position.accountId);
                    }
                });
                
                for (const accountId of activeAccounts) {
                    await this.getAccountPnL(accountId);
                }
                
                this.emit('refreshCompleted');
                
            } catch (error) {
                this.log(`⚠️ Periodic refresh error: ${error.message}`);
                this.emit('refreshError', error);
            }
        }, this.config.refreshInterval);
        
        this.log(`🔄 Started periodic P&L refresh every ${this.config.refreshInterval}ms`);
    }
    
    /**
     * Stop periodic refresh
     */
    stopPeriodicRefresh() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
            this.log('⏹️ Stopped periodic P&L refresh');
        }
    }
    
    /**
     * Disconnect P&L module
     */
    async disconnect() {
        try {
            this.log('🔌 Disconnecting P&L Module...');
            
            this.state.connected = false;
            
            // Stop periodic refresh
            this.stopPeriodicRefresh();
            
            // Clear pending requests
            this.pendingRequests.forEach(({ timeout }) => {
                if (timeout) {
                    clearTimeout(timeout);
                }
            });
            this.pendingRequests.clear();
            
            // Close Redis connections
            if (this.subscriber) {
                await this.subscriber.unsubscribe('pnl:responses');
                await this.subscriber.quit();
                this.subscriber = null;
            }
            
            if (this.redisClient) {
                await this.redisClient.quit();
                this.redisClient = null;
            }
            
            this.emit('disconnected');
            this.log('✅ P&L Module disconnected');
            
        } catch (error) {
            this.log(`❌ Disconnect error: ${error.message}`);
            this.emit('error', error);
        }
    }
    
    /**
     * Get module status
     */
    getStatus() {
        return {
            connected: this.state.connected,
            positions: this.state.positions.size,
            trades: this.state.trades.size,
            dailyPnL: this.state.dailyPnL,
            activeAccounts: this.state.accountPnL.size,
            pendingRequests: this.pendingRequests.size,
            config: {
                refreshInterval: this.config.refreshInterval,
                requestTimeout: this.config.requestTimeout
            }
        };
    }
    
    /**
     * Clear cached data
     */
    clearCache() {
        this.state.positions.clear();
        this.state.trades.clear();
        this.state.accountPnL.clear();
        this.state.dailyPnL = 0;
        
        this.log('🗑️ P&L cache cleared');
        this.emit('cacheCleared');
    }
    
    /**
     * Logging utility
     */
    log(message, data = null) {
        if (this.config.enableDebugLogging) {
            const timestamp = new Date().toISOString();
            if (data) {
                console.log(`[${timestamp}] [PnLModule] ${message}`, data);
            } else {
                console.log(`[${timestamp}] [PnLModule] ${message}`);
            }
        }
    }
}

module.exports = PnLModule;