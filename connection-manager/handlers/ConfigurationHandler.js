const EventEmitter = require('events');

class ConfigurationHandler extends EventEmitter {
    constructor(configManagerClient, eventBroadcaster, instanceRegistry) {
        super();
        this.configManagerClient = configManagerClient;
        this.eventBroadcaster = eventBroadcaster;
        this.instanceRegistry = instanceRegistry;
        this.configCache = new Map();
        this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    }
    
    async handleConfigRequest(message) {
        const { instanceId, requestId, requestType } = message.payload;
        const correlationId = message.correlationId || this.generateCorrelationId();
        
        console.log(`📋 Config Request: ${requestType} for ${instanceId} [${correlationId}]`);
        
        try {
            let configData;
            
            switch (requestType) {
                case 'GET_CONFIG':
                    configData = await this.getConfiguration(instanceId, correlationId);
                    break;
                    
                case 'VALIDATE_CONFIG':
                    configData = await this.validateConfiguration(message.payload.config, correlationId);
                    break;
                    
                case 'REFRESH_CONFIG':
                    this.clearConfigCache(instanceId);
                    configData = await this.getConfiguration(instanceId, correlationId);
                    break;
                    
                default:
                    throw new Error(`Unknown config request type: ${requestType}`);
            }
            
            // Send success response
            await this.sendConfigResponse({
                instanceId,
                requestId,
                correlationId,
                success: true,
                data: configData,
                timestamp: Date.now()
            });
            
        } catch (error) {
            console.error(`❌ Config Request Failed: ${error.message}`);
            
            // Send error response
            await this.sendConfigResponse({
                instanceId,
                requestId,
                correlationId,
                success: false,
                error: error.message,
                errorCode: error.code || 'CONFIG_ERROR',
                timestamp: Date.now()
            });
        }
    }
    
    async getConfiguration(instanceId, correlationId) {
        // Check cache first
        const cached = this.getCachedConfig(instanceId);
        if (cached) {
            console.log(`📦 Using cached config for ${instanceId}`);
            return cached;
        }
        
        // Fetch from Config Manager
        const config = await this.configManagerClient.getInstanceConfiguration(instanceId, correlationId);
        
        // Ensure field compatibility for Trading Bot
        const compatibleConfig = this.ensureFieldCompatibility(config);
        
        // Cache the configuration
        this.cacheConfig(instanceId, compatibleConfig);
        
        // Emit config loaded event
        this.emit('configLoaded', { instanceId, config: compatibleConfig });
        
        return compatibleConfig;
    }
    
    ensureFieldCompatibility(config) {
        // Handle field name differences between Config Manager and Trading Bot
        if (config) {
            // Map dollarRiskPerTrade to maxRiskPerTrade for backward compatibility
            if (config.dollarRiskPerTrade && !config.maxRiskPerTrade) {
                config.maxRiskPerTrade = config.dollarRiskPerTrade;
            }
            // Also ensure dollarRiskPerTrade exists if only maxRiskPerTrade is present
            if (config.maxRiskPerTrade && !config.dollarRiskPerTrade) {
                config.dollarRiskPerTrade = config.maxRiskPerTrade;
            }
        }
        return config;
    }
    
    async validateConfiguration(config, correlationId) {
        return await this.configManagerClient.validateConfiguration(config, correlationId);
    }
    
    async sendConfigResponse(response) {
        await this.eventBroadcaster.publish('instance:control', {
            type: 'CONFIG_RESPONSE',
            payload: response,
            timestamp: Date.now()
        });
    }
    
    getCachedConfig(instanceId) {
        const cached = this.configCache.get(instanceId);
        if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
            return cached.config;
        }
        return null;
    }
    
    cacheConfig(instanceId, config) {
        this.configCache.set(instanceId, {
            config,
            timestamp: Date.now()
        });
    }
    
    clearConfigCache(instanceId) {
        if (instanceId) {
            this.configCache.delete(instanceId);
        } else {
            this.configCache.clear();
        }
    }
    
    generateCorrelationId() {
        return `cfg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    
    // Handle configuration updates from Config Manager
    async handleConfigUpdate(update) {
        const { instanceId, config } = update;
        
        // Clear cache for updated instance
        this.clearConfigCache(instanceId);
        
        // Ensure field compatibility
        const compatibleConfig = this.ensureFieldCompatibility(config);
        
        // Notify connected trading bot
        const instance = this.instanceRegistry.getInstance(instanceId);
        if (instance && instance.status === 'active') {
            await this.eventBroadcaster.publish('instance:control', {
                type: 'CONFIG_UPDATE',
                payload: {
                    instanceId,
                    config: compatibleConfig,
                    timestamp: Date.now()
                }
            });
        }
    }
}

module.exports = ConfigurationHandler;