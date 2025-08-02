/**
 * AuthenticationService - Simplified authentication for V4
 * Based on the working authentication module from Connection Manager
 * Handles TopStep API authentication with auto-refresh
 */

const axios = require('axios');
const EventEmitter = require('events');

class AuthenticationService extends EventEmitter {
    constructor(config = {}, logger = null) {
        super();
        
        this.config = {
            apiBaseUrl: config.apiBaseUrl || 'https://api.topstepx.com',
            tokenExpiryDuration: config.tokenExpiryDuration || 60 * 60 * 1000, // 1 hour
            autoRefresh: config.autoRefresh !== false, // Default enabled
            refreshBuffer: config.refreshBuffer || 5 * 60 * 1000, // 5 minutes before expiry
            maxRetryAttempts: config.maxRetryAttempts || 3,
            retryDelay: config.retryDelay || 30000, // 30 seconds
            ...config
        };
        
        this.logger = logger || console;
        this.instanceId = config.instanceId || 'AUTH';
        
        // State
        this.token = null;
        this.tokenExpiry = null;
        this.refreshInProgress = false;
        this.refreshTimer = null;
        this.isInitialized = false;
        
        // Credentials (will be loaded from environment)
        this.credentials = null;
        
        this.logger.info(`🔐 [${this.instanceId}] Authentication service initialized`);
    }
    
    /**
     * Initialize the authentication service
     */
    async initialize() {
        if (this.isInitialized) {
            return true;
        }
        
        try {
            // Load credentials from environment
            this.loadCredentials();
            
            // Perform initial authentication
            const result = await this.authenticate();
            
            if (!result.success) {
                throw new Error(`Initial authentication failed: ${result.error}`);
            }
            
            this.isInitialized = true;
            this.logger.info(`✅ [${this.instanceId}] Authentication service ready`);
            
            return true;
            
        } catch (error) {
            this.logger.error(`❌ [${this.instanceId}] Failed to initialize authentication:`, error);
            throw error;
        }
    }
    
    /**
     * Load credentials from environment variables
     */
    loadCredentials() {
        const username = process.env.TOPSTEP_USERNAME || process.env.TRADING_USERNAME;
        const apiKey = process.env.TOPSTEP_API_KEY || process.env.TRADING_API_KEY;
        
        if (!username || !apiKey) {
            // Try loading from .env file if not in environment
            try {
                require('dotenv').config();
                
                const envUsername = process.env.TOPSTEP_USERNAME || process.env.TRADING_USERNAME;
                const envApiKey = process.env.TOPSTEP_API_KEY || process.env.TRADING_API_KEY;
                
                if (!envUsername || !envApiKey) {
                    throw new Error('Missing required credentials');
                }
                
                this.credentials = { username: envUsername, apiKey: envApiKey };
            } catch (error) {
                throw new Error(
                    'Missing required credentials. Please set TOPSTEP_USERNAME and TOPSTEP_API_KEY environment variables.'
                );
            }
        } else {
            this.credentials = { username, apiKey };
        }
        
        this.logger.info(`✅ [${this.instanceId}] Credentials loaded for user: ${this.maskUsername(username)}`);
    }
    
    /**
     * Authenticate with TopStep API
     */
    async authenticate() {
        try {
            if (!this.credentials) {
                throw new Error('No credentials available');
            }
            
            this.logger.info(`🔐 [${this.instanceId}] Authenticating with TopStep API...`);
            
            const response = await axios.post(
                `${this.config.apiBaseUrl}/api/Auth/loginKey`,
                {
                    userName: this.credentials.username,
                    apiKey: this.credentials.apiKey
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'text/plain'
                    },
                    timeout: 15000
                }
            );
            
            if (response.data) {
                // TopStep returns token as string or object
                if (typeof response.data === 'string') {
                    this.token = response.data;
                } else if (response.data.token) {
                    this.token = response.data.token;
                } else {
                    throw new Error('Invalid authentication response format');
                }
                
                // Set token expiry
                this.tokenExpiry = Date.now() + this.config.tokenExpiryDuration;
                
                this.logger.info(`✅ [${this.instanceId}] Authentication successful`);
                this.logger.info(`   Token expires at: ${new Date(this.tokenExpiry).toLocaleString()}`);
                
                // Schedule automatic refresh if enabled
                if (this.config.autoRefresh) {
                    this.scheduleTokenRefresh();
                }
                
                // Emit authentication success event
                this.emit('authenticated', {
                    token: this.token,
                    expiresAt: this.tokenExpiry
                });
                
                return {
                    success: true,
                    token: this.token,
                    expiresAt: this.tokenExpiry
                };
            } else {
                throw new Error('Authentication failed - no token received');
            }
            
        } catch (error) {
            this.logger.error(`❌ [${this.instanceId}] Authentication failed:`, error.message);
            
            // Emit authentication failure event
            this.emit('authenticationFailed', {
                error: error.message,
                details: error.response?.data
            });
            
            return {
                success: false,
                error: error.message,
                details: error.response?.data
            };
        }
    }
    
    /**
     * Refresh the authentication token
     */
    async refreshToken() {
        if (this.refreshInProgress) {
            // Wait for ongoing refresh
            while (this.refreshInProgress) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return this.isTokenValid();
        }
        
        this.refreshInProgress = true;
        try {
            const result = await this.authenticate();
            this.refreshInProgress = false;
            return result;
        } catch (error) {
            this.refreshInProgress = false;
            throw error;
        }
    }
    
    /**
     * Check if token is valid
     */
    isTokenValid() {
        return this.token && this.tokenExpiry && Date.now() < this.tokenExpiry - 60000; // 1 minute buffer
    }
    
    /**
     * Ensure valid token is available
     */
    async ensureValidToken() {
        if (!this.isTokenValid()) {
            this.logger.info(`🔄 [${this.instanceId}] Token expired or invalid, refreshing...`);
            return await this.refreshToken();
        }
        return { success: true, token: this.token };
    }
    
    /**
     * Get the current token
     */
    getToken() {
        return this.token;
    }
    
    /**
     * Get auth headers for API requests
     */
    getAuthHeaders() {
        return {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };
    }
    
    /**
     * Schedule automatic token refresh
     */
    scheduleTokenRefresh() {
        // Cancel any existing timer
        this.cancelTokenRefresh();
        
        if (!this.tokenExpiry || !this.config.autoRefresh) {
            return;
        }
        
        // Calculate when to refresh (buffer time before expiry)
        const refreshTime = this.tokenExpiry - this.config.refreshBuffer - Date.now();
        
        if (refreshTime <= 0) {
            // Token expires soon, refresh immediately
            this.logger.info(`⚡ [${this.instanceId}] Token expires soon, refreshing immediately`);
            this.performAutomaticRefresh();
            return;
        }
        
        this.logger.info(`⏰ [${this.instanceId}] Scheduled token refresh in ${Math.round(refreshTime / 1000)}s`);
        
        this.refreshTimer = setTimeout(() => {
            this.performAutomaticRefresh();
        }, refreshTime);
    }
    
    /**
     * Cancel scheduled token refresh
     */
    cancelTokenRefresh() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
    }
    
    /**
     * Perform automatic token refresh with retry logic
     */
    async performAutomaticRefresh(attempt = 1) {
        try {
            this.logger.info(`🔄 [${this.instanceId}] Performing automatic token refresh (attempt ${attempt}/${this.config.maxRetryAttempts})`);
            
            const result = await this.refreshToken();
            
            if (result.success) {
                this.logger.info(`✅ [${this.instanceId}] Automatic token refresh successful`);
                this.emit('tokenRefreshed', {
                    token: this.token,
                    expiresAt: this.tokenExpiry
                });
                return result;
            } else {
                throw new Error(result.error || 'Token refresh failed');
            }
            
        } catch (error) {
            this.logger.error(`❌ [${this.instanceId}] Automatic token refresh failed (attempt ${attempt}):`, error.message);
            
            if (attempt < this.config.maxRetryAttempts) {
                const delay = this.config.retryDelay * attempt; // Exponential backoff
                this.logger.info(`🔄 [${this.instanceId}] Retrying token refresh in ${delay / 1000}s...`);
                
                setTimeout(() => {
                    this.performAutomaticRefresh(attempt + 1);
                }, delay);
            } else {
                this.logger.error(`💥 [${this.instanceId}] All token refresh attempts failed. Manual intervention required.`);
                this.clearToken();
                this.emit('authenticationLost', {
                    reason: 'Token refresh failed after all retry attempts'
                });
            }
        }
    }
    
    /**
     * Clear authentication token
     */
    clearToken() {
        this.token = null;
        this.tokenExpiry = null;
        this.cancelTokenRefresh();
        this.logger.info(`🔒 [${this.instanceId}] Authentication token cleared`);
    }
    
    /**
     * Get authentication status
     */
    getStatus() {
        return {
            isAuthenticated: this.isTokenValid(),
            hasToken: !!this.token,
            tokenExpiry: this.tokenExpiry,
            refreshInProgress: this.refreshInProgress,
            autoRefreshEnabled: this.config.autoRefresh,
            nextRefreshAt: this.refreshTimer ? 
                new Date(this.tokenExpiry - this.config.refreshBuffer).toISOString() : null
        };
    }
    
    /**
     * Mask username for logging
     */
    maskUsername(username) {
        if (!username) return 'NOT SET';
        if (username.length <= 2) return '*'.repeat(username.length);
        return username[0] + '*'.repeat(username.length - 2) + username[username.length - 1];
    }
    
    /**
     * Shutdown the authentication service
     */
    async shutdown() {
        this.logger.info(`🛑 [${this.instanceId}] Shutting down authentication service...`);
        
        this.cancelTokenRefresh();
        this.clearToken();
        this.credentials = null;
        this.isInitialized = false;
        
        this.logger.info(`✅ [${this.instanceId}] Authentication service shutdown complete`);
    }
}

module.exports = AuthenticationService;