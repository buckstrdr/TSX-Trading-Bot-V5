// connection-manager/services/ConfigurationService.js
// Configuration Service for Connection Manager
// Manages global and instance-specific configurations

const DistributedConfigManager = require('../../shared/modules/config/DistributedConfigManager');
const EventEmitter = require('events');
const path = require('path');

class ConfigurationService extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            configPath: config.configPath || './config',
            enableConfigBroadcast: config.enableConfigBroadcast !== false,
            enableInstanceProvisioning: config.enableInstanceProvisioning !== false,
            ...config
        };
        
        // Initialize distributed config manager
        this.configManager = new DistributedConfigManager({
            globalConfigPath: path.join(this.config.configPath, 'global'),
            instanceConfigPath: path.join(this.config.configPath, 'instances'),
            enableFileWatching: true,
            enableConfigSync: true
        });
        
        // Instance provisioning queue
        this.provisioningQueue = new Map();
        this.provisionedInstances = new Set();
        
        // Configuration templates for different bot types
        this.instanceTemplates = new Map();
        this.initializeInstanceTemplates();
        
        // Setup event handlers
        this.setupEventHandlers();
        
        console.log('⚙️  Configuration Service initialized');
        console.log(`   Config path: ${this.config.configPath}`);
        console.log(`   Fixed bot configurations: BOT_1 through BOT_6`);
    }
    
    async initialize() {
        try {
            console.log('⚙️  Initializing Configuration Service...');
            
            // Load existing configurations from files
            await this.configManager.loadConfigurationsFromFiles();
            
            // Initialize default global configurations if needed
            await this.ensureDefaultGlobalConfigs();
            
            console.log('✅ Configuration Service initialized successfully');
            
            // Emit ready event
            this.emit('ready');
            
        } catch (error) {
            console.error('❌ Configuration Service initialization failed:', error);
            throw error;
        }
    }
    
    initializeInstanceTemplates() {
        // VWAP Bot Template
        this.instanceTemplates.set('VWAP_BOT', {
            strategy: {
                active: 'VWAP',
                vwap: {
                    primaryThreshold: 0.15,
                    secondaryThreshold: 0.10,
                    filterThreshold: 0.30,
                    enableRegimeFilter: true,
                    minVolumeRatio: 1.2,
                    signalCooldownMs: 300000
                }
            },
            risk: {
                maxDailyLoss: 300,
                maxDailyProfit: 600,
                enableProfitTarget: false,
                maxPositionSize: 1,
                stopLossPercent: 0.25,
                riskPerTrade: 50
            }
        });
        
        // EMA Bot Template
        this.instanceTemplates.set('EMA_BOT', {
            strategy: {
                active: 'EMA',
                ema: {
                    mode: 'CONSERVATIVE',
                    fastPeriod: 9,
                    slowPeriod: 19,
                    enableMomentumFilter: true,
                    crossoverConfirmation: true
                }
            },
            risk: {
                maxDailyLoss: 250,
                maxDailyProfit: 500,
                enableProfitTarget: false,
                maxPositionSize: 1,
                stopLossPercent: 0.20,
                riskPerTrade: 40
            }
        });
        
        // Test Bot Template
        this.instanceTemplates.set('TEST_BOT', {
            strategy: {
                active: 'VWAP',
                vwap: {
                    primaryThreshold: 0.25,  // More conservative for testing
                    secondaryThreshold: 0.15,
                    filterThreshold: 0.40,
                    enableRegimeFilter: true
                }
            },
            risk: {
                maxDailyLoss: 100,  // Lower risk for testing
                maxDailyProfit: 200,
                enableProfitTarget: true,
                maxPositionSize: 1,
                stopLossPercent: 0.15,
                riskPerTrade: 25
            }
        });
    }
    
    setupEventHandlers() {
        // Handle configuration change events
        this.configManager.on('globalConfigUpdated', (data) => {
            this.handleGlobalConfigUpdate(data);
        });
        
        this.configManager.on('instanceConfigUpdated', (data) => {
            this.handleInstanceConfigUpdate(data);
        });
        
        this.configManager.on('instanceConfigCreated', (data) => {
            this.handleInstanceConfigCreated(data);
        });
    }
    
    // Instance provisioning methods
    async provisionInstance(instanceRequest) {
        const { instanceId, account, instrument, botType, customConfig } = instanceRequest;
        
        try {
            console.log(`⚙️  Provisioning instance: ${instanceId}`);
            
            // Validate instance request
            const validation = this.validateInstanceRequest(instanceRequest);
            if (!validation.valid) {
                throw new Error(`Invalid instance request: ${validation.errors.join(', ')}`);
            }
            
            // Check if instance already exists
            if (this.provisionedInstances.has(instanceId)) {
                throw new Error(`Instance already provisioned: ${instanceId}`);
            }
            
            // Get template configuration
            const template = this.getInstanceTemplate(botType);
            
            // Create instance configuration
            const instanceConfig = {
                ...template,
                instanceId,
                account,
                instrument,
                ...customConfig
            };
            
            // Create configuration through distributed config manager
            const createdConfig = await this.configManager.createInstanceConfig(instanceId, instanceConfig);
            
            // Mark as provisioned
            this.provisionedInstances.add(instanceId);
            
            console.log(`✅ Instance provisioned successfully: ${instanceId}`);
            
            // Emit provisioning complete event
            this.emit('instanceProvisioned', {
                instanceId,
                config: createdConfig,
                account,
                instrument,
                botType
            });
            
            return {
                success: true,
                instanceId,
                config: createdConfig
            };
            
        } catch (error) {
            console.error(`❌ Instance provisioning failed for ${instanceId}:`, error);
            
            return {
                success: false,
                instanceId,
                error: error.message
            };
        }
    }
    
    async updateInstanceConfiguration(instanceId, updates) {
        try {
            console.log(`⚙️  Updating instance configuration: ${instanceId}`);
            
            // Update through distributed config manager
            const updatedConfig = await this.configManager.updateInstanceConfig(instanceId, updates);
            
            console.log(`✅ Instance configuration updated: ${instanceId}`);
            
            return {
                success: true,
                instanceId,
                config: updatedConfig
            };
            
        } catch (error) {
            console.error(`❌ Instance configuration update failed for ${instanceId}:`, error);
            
            return {
                success: false,
                instanceId,
                error: error.message
            };
        }
    }
    
    // Configuration retrieval methods
    async getInstanceConfiguration(instanceId) {
        try {
            console.log(`🔍 Looking for configuration for instance: ${instanceId}`);
            
            // First try to get from Config Manager API
            try {
                const axios = require('axios');
                const response = await axios.get(`http://localhost:3001/api/instances`, {
                    timeout: 5000
                });
                
                if (response.data && Array.isArray(response.data)) {
                    const instance = response.data.find(inst => inst.instanceId === instanceId);
                    if (instance) {
                        console.log(`✅ Found instance configuration from Config Manager`);
                        return {
                            instanceId: instance.instanceId,
                            account: instance.account,
                            instrument: instance.instrument,
                            strategy: instance.strategy,
                            enabled: instance.enabled,
                            dollarRiskPerTrade: instance.dollarRiskPerTrade,
                            maxDailyLoss: instance.maxDailyLoss,
                            maxDailyProfit: instance.maxDailyProfit
                        };
                    }
                }
            } catch (apiError) {
                console.warn(`⚠️  Could not fetch from Config Manager API: ${apiError.message}`);
            }
            
            // Fallback to local config manager
            let config = this.configManager.getInstanceConfig(instanceId);
            if (config) {
                console.log(`✅ Found instance configuration locally`);
                return config;
            }
            
            // If not found and instanceId starts with 'bot-', try bot-template
            if (instanceId.startsWith('bot-') && instanceId !== 'bot-template') {
                console.log(`📋 Using bot-template configuration for ${instanceId}`);
                config = this.configManager.getInstanceConfig('bot-template');
                if (config) {
                    // Clone and update the instanceId
                    config = { ...config, instanceId };
                    return config;
                }
            }
            
            console.log(`❌ No configuration found for instance: ${instanceId}`);
            return null;
        } catch (error) {
            console.error(`❌ Failed to get instance configuration for ${instanceId}:`, error);
            return null;
        }
    }
    
    getGlobalConfiguration(section = null) {
        return this.configManager.getGlobalConfig(section);
    }
    
    getAllInstanceConfigurations() {
        const instances = this.configManager.getAllInstanceIds();
        const configurations = {};
        
        for (const instanceId of instances) {
            try {
                configurations[instanceId] = this.configManager.getInstanceConfig(instanceId);
            } catch (error) {
                console.error(`❌ Failed to get configuration for ${instanceId}:`, error);
            }
        }
        
        return configurations;
    }
    
    // Global configuration management
    async updateGlobalConfiguration(section, updates) {
        try {
            console.log(`⚙️  Updating global configuration section: ${section}`);
            
            const updatedConfig = await this.configManager.updateGlobalConfig(section, updates);
            
            console.log(`✅ Global configuration updated: ${section}`);
            
            return {
                success: true,
                section,
                config: updatedConfig
            };
            
        } catch (error) {
            console.error(`❌ Global configuration update failed for ${section}:`, error);
            
            return {
                success: false,
                section,
                error: error.message
            };
        }
    }
    
    // Template management
    getInstanceTemplate(botType) {
        if (!this.instanceTemplates.has(botType)) {
            console.log(`⚠️  Unknown bot type: ${botType}, using default template`);
            return this.instanceTemplates.get('VWAP_BOT');
        }
        
        return this.instanceTemplates.get(botType);
    }
    
    addInstanceTemplate(botType, template) {
        this.instanceTemplates.set(botType, template);
        console.log(`⚙️  Instance template added: ${botType}`);
    }
    
    getAvailableTemplates() {
        return Array.from(this.instanceTemplates.keys());
    }
    
    // Validation methods
    validateInstanceRequest(request) {
        const errors = [];
        
        if (!request.instanceId) {
            errors.push('instanceId is required');
        }
        
        if (!request.account) {
            errors.push('account is required');
        }
        
        if (!request.instrument) {
            errors.push('instrument is required');
        }
        
        if (!request.botType) {
            errors.push('botType is required');
        }
        
        if (request.botType && !this.instanceTemplates.has(request.botType)) {
            errors.push(`Unknown bot type: ${request.botType}`);
        }
        
        return {
            valid: errors.length === 0,
            errors
        };
    }
    
    // Event handlers
    handleGlobalConfigUpdate(data) {
        console.log(`📡 Global configuration updated: ${data.section}`);
        
        if (this.config.enableConfigBroadcast) {
            this.emit('broadcastGlobalConfigUpdate', data);
        }
    }
    
    handleInstanceConfigUpdate(data) {
        console.log(`📡 Instance configuration updated: ${data.instanceId}`);
        
        if (this.config.enableConfigBroadcast) {
            this.emit('broadcastInstanceConfigUpdate', data);
        }
    }
    
    handleInstanceConfigCreated(data) {
        console.log(`📡 Instance configuration created: ${data.instanceId}`);
        
        if (this.config.enableConfigBroadcast) {
            this.emit('broadcastInstanceConfigCreated', data);
        }
    }
    
    // Default configurations
    async ensureDefaultGlobalConfigs() {
        // Update global configurations with any missing defaults
        const globalConfig = this.configManager.getAllGlobalConfig();
        
        // Check if monitoring configuration needs updates
        if (!globalConfig.monitoring || !globalConfig.monitoring.enablePerformanceMetrics) {
            await this.configManager.updateGlobalConfig('monitoring', {
                healthCheckInterval: 30000,
                metricsCollectionInterval: 60000,
                enablePerformanceMetrics: true,
                alertThresholds: {
                    highCpuPercent: 80,
                    highMemoryPercent: 85,
                    lowDiskSpaceGB: 5
                }
            });
        }
        
        // Ensure position reconciliation configuration is present
        if (!globalConfig.reconciliation) {
            await this.configManager.updateGlobalConfig('reconciliation', {
                reconciliationIntervalMs: 30000,
                maxDiscrepancyThreshold: 0.01,
                enableAutoCorrection: true,
                positionTimeoutMs: 300000,
                forceReconciliationThreshold: 5
            });
        }
    }
    
    // Instance management
    removeInstance(instanceId) {
        try {
            this.configManager.deleteInstanceConfig(instanceId);
            this.provisionedInstances.delete(instanceId);
            
            console.log(`🗑️  Instance removed: ${instanceId}`);
            
            this.emit('instanceRemoved', { instanceId });
            
            return { success: true, instanceId };
            
        } catch (error) {
            console.error(`❌ Failed to remove instance ${instanceId}:`, error);
            return { success: false, instanceId, error: error.message };
        }
    }
    
    // Status and monitoring
    getServiceStatus() {
        const configStatus = this.configManager.getConfigStatus();
        
        return {
            service: 'ConfigurationService',
            status: 'ACTIVE',
            configManager: configStatus,
            provisionedInstances: Array.from(this.provisionedInstances),
            availableTemplates: this.getAvailableTemplates(),
            configBroadcastEnabled: this.config.enableConfigBroadcast,
            instanceProvisioningEnabled: this.config.enableInstanceProvisioning
        };
    }
    
    // Cleanup
    async cleanup() {
        console.log('⚙️  Configuration Service cleanup...');
        
        if (this.configManager) {
            this.configManager.cleanup();
        }
        
        this.provisioningQueue.clear();
        this.provisionedInstances.clear();
        
        console.log('✅ Configuration Service cleanup complete');
    }
}

module.exports = ConfigurationService;