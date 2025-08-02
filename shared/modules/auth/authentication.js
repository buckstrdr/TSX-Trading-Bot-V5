// shared-modules/auth/authentication.js
// Shared authentication module for TopStep API
// Extracted from: C:\Users\salte\modular trading bot\enhanced-vwap-trading-bot\modules\authentication.js

const axios = require('axios');
const CredentialManager = require('./credentialManager');

class AuthenticationModule {
    constructor(config = {}) {
        // Always use production API URL
        this.baseURL = config.apiBaseUrl || 'https://api.topstepx.com';
        this.token = null;
        this.tokenExpiry = null;
        this.refreshInProgress = false;
        this.credentialsInitialized = false;
        this.tokenExpiryDuration = config.tokenExpiryDuration || 60 * 60 * 1000; // 1 hour default
        
        // Instance identification for logging
        this.instanceId = config.instanceId || 'SHARED';
        
        // Automatic token refresh settings
        this.autoRefreshEnabled = config.autoRefresh !== false; // Default enabled
        this.refreshBuffer = config.refreshBuffer || 5 * 60 * 1000; // 5 minutes before expiry
        this.refreshTimer = null;
        this.maxRetryAttempts = config.maxRetryAttempts || 3;
        this.retryDelay = config.retryDelay || 30000; // 30 seconds
        
        console.log(`🔐 [${this.instanceId}] Auth module initialized`);
        console.log(`   Base URL: ${this.baseURL}`);
        console.log(`   Auto-refresh: ${this.autoRefreshEnabled ? 'enabled' : 'disabled'}`);
        if (this.autoRefreshEnabled) {
            console.log(`   Refresh buffer: ${this.refreshBuffer / 1000}s before expiry`);
        }
    }
    
    async initializeCredentials() {
        if (this.credentialsInitialized) return true;
        
        try {
            await CredentialManager.initialize();
            const validation = CredentialManager.validateCredentials();
            
            if (!validation.valid) {
                throw new Error(`Invalid credentials: ${validation.errors.join(', ')}`);
            }
            
            this.credentialsInitialized = true;
            return true;
        } catch (error) {
            console.error(`❌ [${this.instanceId}] Failed to initialize credentials:`, error.message);
            throw error;
        }
    }

    async authenticate() {
        try {
            // Ensure credentials are initialized
            await this.initializeCredentials();
            
            console.log(`🔐 [${this.instanceId}] Authenticating with production API...`);
            
            // Get credentials securely
            const { username, apiKey } = CredentialManager.getAuthCredentials();
            
            const authResponse = await axios.post(`${this.baseURL}/api/Auth/loginKey`, {
                userName: username,
                apiKey: apiKey
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/plain'
                },
                timeout: 15000
            });

            // TopStep X returns the token directly as a string, not an object
            if (authResponse.data) {
                // Handle both string response and object response
                if (typeof authResponse.data === 'string') {
                    this.token = authResponse.data;
                } else if (authResponse.data.token) {
                    this.token = authResponse.data.token;
                } else {
                    throw new Error('Invalid authentication response format');
                }
                
                // Set token expiry
                this.tokenExpiry = Date.now() + this.tokenExpiryDuration;
                console.log(`✅ [${this.instanceId}] Authentication successful`);
                console.log(`   Token expires at: ${new Date(this.tokenExpiry).toLocaleString()}`);
                
                // Schedule automatic refresh if enabled
                if (this.autoRefreshEnabled) {
                    this.scheduleTokenRefresh();
                }
                
                return {
                    success: true,
                    token: this.token,
                    expiresAt: this.tokenExpiry
                };
            } else {
                throw new Error('Authentication failed - invalid response');
            }
        } catch (error) {
            console.error(`❌ [${this.instanceId}] Authentication failed:`, error.response?.data || error.message);
            return {
                success: false,
                error: error.message,
                details: error.response?.data
            };
        }
    }

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

    isTokenValid() {
        return this.token && this.tokenExpiry && Date.now() < this.tokenExpiry - 60000; // 1 minute buffer
    }

    async ensureValidToken() {
        if (!this.isTokenValid()) {
            console.log(`🔄 [${this.instanceId}] Token expired or invalid, refreshing...`);
            return await this.refreshToken();
        }
        return { success: true, token: this.token };
    }

    getToken() {
        return this.token;
    }

    getAuthHeaders() {
        return {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };
    }

    clearToken() {
        this.token = null;
        this.tokenExpiry = null;
        this.cancelTokenRefresh();
        console.log(`🔒 [${this.instanceId}] Authentication token cleared`);
    }
    
    /**
     * Schedule automatic token refresh
     */
    scheduleTokenRefresh() {
        // Cancel any existing timer
        this.cancelTokenRefresh();
        
        if (!this.tokenExpiry || !this.autoRefreshEnabled) {
            return;
        }
        
        // Calculate when to refresh (buffer time before expiry)
        const refreshTime = this.tokenExpiry - this.refreshBuffer - Date.now();
        
        if (refreshTime <= 0) {
            // Token expires soon, refresh immediately
            console.log(`⚡ [${this.instanceId}] Token expires soon, refreshing immediately`);
            this.performAutomaticRefresh();
            return;
        }
        
        console.log(`⏰ [${this.instanceId}] Scheduled token refresh in ${Math.round(refreshTime / 1000)}s`);
        console.log(`   Will refresh at: ${new Date(Date.now() + refreshTime).toLocaleString()}`);
        
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
            console.log(`⏹️ [${this.instanceId}] Cancelled scheduled token refresh`);
        }
    }
    
    /**
     * Perform automatic token refresh with retry logic
     */
    async performAutomaticRefresh(attempt = 1) {
        try {
            console.log(`🔄 [${this.instanceId}] Performing automatic token refresh (attempt ${attempt}/${this.maxRetryAttempts})`);
            
            const result = await this.refreshToken();
            
            if (result.success) {
                console.log(`✅ [${this.instanceId}] Automatic token refresh successful`);
                return result;
            } else {
                throw new Error(result.error || 'Token refresh failed');
            }
            
        } catch (error) {
            console.error(`❌ [${this.instanceId}] Automatic token refresh failed (attempt ${attempt}):`, error.message);
            
            if (attempt < this.maxRetryAttempts) {
                const delay = this.retryDelay * attempt; // Exponential backoff
                console.log(`🔄 [${this.instanceId}] Retrying token refresh in ${delay / 1000}s...`);
                
                setTimeout(() => {
                    this.performAutomaticRefresh(attempt + 1);
                }, delay);
            } else {
                console.error(`💥 [${this.instanceId}] All token refresh attempts failed. Manual intervention required.`);
                this.clearToken();
            }
        }
    }
    
    /**
     * Get detailed status including refresh scheduling
     */
    getDetailedStatus() {
        const baseStatus = this.getStatus();
        return {
            ...baseStatus,
            autoRefreshEnabled: this.autoRefreshEnabled,
            refreshScheduled: !!this.refreshTimer,
            refreshBuffer: this.refreshBuffer,
            timeUntilRefresh: this.refreshTimer ? 
                Math.max(0, (this.tokenExpiry - this.refreshBuffer) - Date.now()) : null,
            nextRefreshAt: this.refreshTimer ? 
                new Date(this.tokenExpiry - this.refreshBuffer).toISOString() : null
        };
    }
    
    // Clean up credentials on shutdown
    cleanup() {
        this.cancelTokenRefresh();
        this.clearToken();
        CredentialManager.clearCredentials();
        console.log(`🔒 [${this.instanceId}] Authentication module cleaned up`);
    }

    getTokenInfo() {
        return {
            hasToken: !!this.token,
            isValid: this.isTokenValid(),
            expiresAt: this.tokenExpiry,
            timeUntilExpiry: this.tokenExpiry ? this.tokenExpiry - Date.now() : 0
        };
    }

    getStatus() {
        return {
            isAuthenticated: this.isTokenValid(),
            hasToken: !!this.token,
            tokenExpiry: this.tokenExpiry,
            credentialsInitialized: this.credentialsInitialized,
            refreshInProgress: this.refreshInProgress,
            instanceId: this.instanceId,
            baseURL: this.baseURL
        };
    }
    
    // Add method to make authenticated API requests
    async apiRequest(endpoint, options = {}) {
        try {
            // Ensure we have a valid token
            await this.ensureValidToken();
            
            const url = endpoint.startsWith('http') ? endpoint : `${this.baseURL}${endpoint}`;
            
            const response = await axios({
                url,
                method: options.method || 'GET',
                headers: {
                    ...this.getAuthHeaders(),
                    ...options.headers
                },
                data: options.data,
                params: options.params,
                timeout: options.timeout || 15000
            });
            
            return response;
        } catch (error) {
            console.error(`❌ [${this.instanceId}] API request failed:`, error.message);
            throw error;
        }
    }

    // Shared token management for Connection Manager
    shareToken() {
        if (!this.isTokenValid()) {
            return null;
        }
        return {
            token: this.token,
            expiresAt: this.tokenExpiry,
            issuedAt: this.tokenExpiry - this.tokenExpiryDuration
        };
    }

    // Import token from Connection Manager
    importToken(tokenData) {
        if (!tokenData || !tokenData.token || !tokenData.expiresAt) {
            throw new Error('Invalid token data provided');
        }
        
        this.token = tokenData.token;
        this.tokenExpiry = tokenData.expiresAt;
        
        console.log(`🔐 [${this.instanceId}] Token imported successfully`);
        return this.getTokenInfo();
    }
}

module.exports = AuthenticationModule;