/**
 * Historical Data Service - Connection Manager
 * Handles historical data requests from distributed trading bots
 * Fetches data from TopStep API and returns to requesting bots
 */

const axios = require('axios');
const EventEmitter = require('events');

class HistoricalDataService extends EventEmitter {
    constructor(authModule, eventBroadcaster, config = {}) {
        super();
        
        this.authModule = authModule;
        this.eventBroadcaster = eventBroadcaster;
        
        // Determine API URL based on profile
        const apiProfile = process.env.API_PROFILE || 'production';
        let baseURL = config.apiBaseUrl || 'https://api.topstepx.com';
        
        // Override with profile-specific URL if not provided in config
        if (!config.apiBaseUrl) {
            if (apiProfile === 'fake') {
                baseURL = 'http://localhost:8888';
                console.log('📊 Using Fake API for Historical Data Service');
            } else {
                console.log('📊 Using Production API for Historical Data Service');
            }
        }
        
        this.config = {
            baseURL,
            maxRetries: 3,
            retryDelay: 1000,
            defaultLimit: 500,
            cacheDuration: 300000, // 5 minutes cache
            maxConcurrentRequests: 5,
            requestTimeout: 30000, // 30 seconds timeout per request
            ...config
        };
        
        // Cache for recent requests
        this.cache = new Map();
        
        // Request queue management
        this.activeRequests = new Set();
        this.requestQueue = [];
        
        // Statistics
        this.stats = {
            requestsReceived: 0,
            requestsProcessed: 0,
            requestsFailed: 0,
            cacheHits: 0,
            cacheMisses: 0
        };
        
        console.log(`📚 Historical Data Service initialized`);
        console.log(`   API Profile: ${apiProfile}`);
        console.log(`   Base URL: ${this.config.baseURL}`);
        
        // Start queue processor
        this.processQueueInterval = setInterval(() => {
            this.processRequestQueue();
        }, 100);
    }
    
    /**
     * Handle historical data request from a bot
     */
    async handleHistoricalDataRequest(data) {
        console.log(`🔍 Raw historical data request received:`, data);
        
        const { requestId, instanceId, contractId, instrument, ...params } = data;
        
        // Use instrument if contractId is not provided
        const finalContractId = contractId || instrument;
        
        this.stats.requestsReceived++;
        
        console.log(`📊 Received historical data request ${requestId} from ${instanceId}`);
        console.log(`📈 Contract: ${finalContractId}, Unit: ${this.getUnitName(params.unit || 2)}`);
        console.log(`📊 Parameters:`, params);
        
        try {
            // Check cache first
            const cacheKey = this.getCacheKey(finalContractId, params);
            if (this.cache.has(cacheKey)) {
                const cached = this.cache.get(cacheKey);
                if (Date.now() - cached.timestamp < this.config.cacheDuration) {
                    console.log(`📦 Cache hit for ${finalContractId} historical data`);
                    this.stats.cacheHits++;
                    
                    await this.sendHistoricalDataResponse(instanceId, requestId, {
                        success: true,
                        bars: cached.data,
                        source: 'cache'
                    });
                    return;
                }
            }
            
            this.stats.cacheMisses++;
            
            // Queue the request for processing
            this.queueRequest({
                requestId,
                instanceId,
                contractId: finalContractId,
                params,
                timestamp: Date.now()
            });
            
        } catch (error) {
            console.error(`❌ Error handling historical data request:`, error);
            await this.sendHistoricalDataResponse(instanceId, requestId, {
                success: false,
                error: error.message
            });
        }
    }
    
    /**
     * Queue request for processing
     */
    queueRequest(request) {
        this.requestQueue.push(request);
        console.log(`📝 Queued historical data request (${this.requestQueue.length} pending)`);
    }
    
    /**
     * Process queued requests
     */
    async processRequestQueue() {
        if (this.requestQueue.length === 0 || this.activeRequests.size >= this.config.maxConcurrentRequests) {
            return;
        }
        
        const request = this.requestQueue.shift();
        if (!request) return;
        
        const { requestId, instanceId, contractId, params } = request;
        
        this.activeRequests.add(requestId);
        
        // Add timeout handling
        const timeoutId = setTimeout(async () => {
            if (this.activeRequests.has(requestId)) {
                console.error(`❌ Request ${requestId} timed out after ${this.config.requestTimeout}ms`);
                await this.sendHistoricalDataResponse(instanceId, requestId, {
                    success: false,
                    error: 'Request timeout'
                });
                this.activeRequests.delete(requestId);
                this.stats.requestsFailed++;
            }
        }, this.config.requestTimeout);
        
        try {
            // Fetch data from TopStep API
            const bars = await this.fetchHistoricalDataFromAPI(contractId, params);
            
            // Clear timeout since we succeeded
            clearTimeout(timeoutId);
            
            // Cache the result
            const cacheKey = this.getCacheKey(contractId, params);
            this.cache.set(cacheKey, {
                data: bars,
                timestamp: Date.now()
            });
            
            // Send response
            await this.sendHistoricalDataResponse(instanceId, requestId, {
                success: true,
                data: bars, // Use 'data' instead of 'bars' for consistency
                bars, // Keep both for backward compatibility
                source: 'api'
            });
            
            this.stats.requestsProcessed++;
            console.log(`✅ Successfully processed historical data request ${requestId}`);
            
        } catch (error) {
            console.error(`❌ Failed to process historical data request ${requestId}:`, error);
            
            // Clear timeout
            clearTimeout(timeoutId);
            
            await this.sendHistoricalDataResponse(instanceId, requestId, {
                success: false,
                error: error.message
            });
            
            this.stats.requestsFailed++;
        } finally {
            this.activeRequests.delete(requestId);
        }
    }
    
    /**
     * Fetch historical data from TopStep API
     */
    async fetchHistoricalDataFromAPI(contractId, params, retryCount = 0) {
        try {
            // Ensure authentication
            const authResult = await this.authModule.ensureValidToken();
            if (!authResult.success) {
                throw new Error('Authentication required for historical data');
            }
            
            console.log(`🌐 Fetching historical data from API for ${contractId}`);
            console.log(`   Using endpoint: ${this.config.baseURL}/api/History/retrieveBars`);
            
            const requestBody = {
                contractId,
                live: false, // Always false for historical data
                unit: params.unit || 2,
                unitNumber: params.unitNumber || 1,
                limit: params.limit || this.config.defaultLimit,
                includePartialBar: params.includePartialBar || false
            };
            
            // Format timestamps if provided - TopStep API requires ISO format without milliseconds
            if (params.startTime) {
                requestBody.startTime = new Date(params.startTime).toISOString().replace(/\.\d{3}Z$/, 'Z');
            }
            if (params.endTime) {
                requestBody.endTime = new Date(params.endTime).toISOString().replace(/\.\d{3}Z$/, 'Z');
            }
            
            console.log(`📅 API Request: ${JSON.stringify({
                contractId: requestBody.contractId,
                unit: this.getUnitName(requestBody.unit),
                unitNumber: requestBody.unitNumber,
                limit: requestBody.limit,
                startTime: requestBody.startTime,
                endTime: requestBody.endTime
            }, null, 2)}`);
            
            const response = await axios.post(
                `${this.config.baseURL}/api/History/retrieveBars`,
                requestBody,
                {
                    headers: {
                        'Authorization': `Bearer ${this.authModule.getToken()}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    timeout: 15000
                }
            );
            
            if (response.data.success && response.data.bars) {
                // Sort bars by timestamp (oldest first)
                const sortedBars = response.data.bars.sort((a, b) => new Date(a.t) - new Date(b.t));
                console.log(`📊 Retrieved ${sortedBars.length} bars from API`);
                return sortedBars;
            } else {
                throw new Error(`API error: ${response.data.errorCode || 'No data available'}`);
            }
            
        } catch (error) {
            if (error.response) {
                console.error(`❌ API error:`, error.response.status, error.response.data);
            }
            
            if (retryCount < this.config.maxRetries) {
                console.log(`🔄 Retrying historical data request (${retryCount + 1}/${this.config.maxRetries})...`);
                await this.delay(this.config.retryDelay * (retryCount + 1));
                return this.fetchHistoricalDataFromAPI(contractId, params, retryCount + 1);
            }
            
            throw error;
        }
    }
    
    /**
     * Send historical data response to requesting bot
     */
    async sendHistoricalDataResponse(instanceId, requestId, response) {
        try {
            // Publish to the channel that ConnectionClient is subscribed to
            await this.eventBroadcaster.publish('HISTORICAL_DATA_RESPONSE', {
                instanceId,
                requestId,
                timestamp: Date.now(),
                ...response
            });
            
            console.log(`📤 Sent historical data response for request ${requestId} to ${instanceId}`);
            
        } catch (error) {
            console.error(`❌ Failed to send historical data response:`, error);
        }
    }
    
    /**
     * Get unit name from unit code
     */
    getUnitName(unit) {
        const units = {
            1: 'Second',
            2: 'Minute',
            3: 'Hour',
            4: 'Daily',
            5: 'Weekly',
            6: 'Monthly',
            7: 'Yearly'
        };
        return units[unit] || 'Unknown';
    }
    
    /**
     * Get cache key for request
     */
    getCacheKey(contractId, params) {
        const { unit, unitNumber, limit, startTime, endTime } = params;
        return `${contractId}_${unit}_${unitNumber}_${limit}_${startTime || 'auto'}_${endTime || 'now'}`;
    }
    
    /**
     * Clear cache
     */
    clearCache() {
        const size = this.cache.size;
        this.cache.clear();
        console.log(`🧹 Cleared ${size} cached historical data entries`);
    }
    
    /**
     * Clear old cache entries
     */
    cleanupCache() {
        const now = Date.now();
        const expiredKeys = [];
        
        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.timestamp > this.config.cacheDuration) {
                expiredKeys.push(key);
            }
        }
        
        expiredKeys.forEach(key => this.cache.delete(key));
        
        if (expiredKeys.length > 0) {
            console.log(`🧹 Cleaned up ${expiredKeys.length} expired cache entries`);
        }
    }
    
    /**
     * Delay helper
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    /**
     * Get service statistics
     */
    getStatistics() {
        return {
            ...this.stats,
            cacheSize: this.cache.size,
            activeRequests: this.activeRequests.size,
            queueLength: this.requestQueue.length,
            cacheHitRate: this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses) || 0
        };
    }
    
    /**
     * Get service status
     */
    getStatus() {
        return {
            service: 'HistoricalDataService',
            healthy: this.authModule.isAuthenticated(),
            cacheSize: this.cache.size,
            activeRequests: this.activeRequests.size,
            queueLength: this.requestQueue.length,
            statistics: this.getStatistics()
        };
    }
    
    /**
     * Shutdown service
     */
    async shutdown() {
        console.log('🛑 Shutting down Historical Data Service...');
        
        if (this.processQueueInterval) {
            clearInterval(this.processQueueInterval);
        }
        
        // Wait for active requests to complete (max 30 seconds)
        let waitCount = 0;
        while (this.activeRequests.size > 0 && waitCount < 300) {
            await this.delay(100);
            waitCount++;
        }
        
        this.clearCache();
        console.log('✅ Historical Data Service shutdown complete');
    }
}

module.exports = HistoricalDataService;