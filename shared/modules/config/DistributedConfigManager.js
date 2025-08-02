// shared-modules/config/DistributedConfigManager.js
// Distributed Configuration Management for Trading Bot Architecture
// Supports instance-based settings with shared global configuration

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class DistributedConfigManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = {
            globalConfigPath: options.globalConfigPath || './config/global',
            instanceConfigPath: options.instanceConfigPath || './config/instances',
            enableFileWatching: options.enableFileWatching !== false,
            enableConfigSync: options.enableConfigSync !== false,
            ...options
        };
        
        // Configuration storage
        this.globalConfig = new Map();
        this.instanceConfigs = new Map();
        this.configTemplates = new Map();
        
        // File watchers for configuration changes
        this.watchers = new Map();
        
        // Configuration validation rules
        this.validationRules = new Map();
        
        // Configuration change subscribers
        this.subscribers = new Map();
        
        // Default global configuration
        this.initializeDefaultGlobalConfig();
        
        // Default instance configuration template
        this.initializeInstanceTemplate();
        
        console.log('🔧 Distributed Configuration Manager initialized');
        console.log(`   Global config path: ${this.options.globalConfigPath}`);
        console.log(`   Bot config path: ${this.options.instanceConfigPath}`);
    }
    
    initializeDefaultGlobalConfig() {
        // Shared configuration that applies to all instances
        this.globalConfig.set('api', {
            baseUrl: 'https://api.topstepx.com',
            timeout: 15000,
            retryAttempts: 3,
            retryDelay: 1000
        });
        
        this.globalConfig.set('redis', {
            url: 'redis://localhost:6379',
            maxRetries: 5,
            retryDelay: 1000
        });
        
        this.globalConfig.set('logging', {
            level: 'INFO',
            maxLogFiles: 30,
            enableConsole: true,
            enableFile: true
        });
        
        this.globalConfig.set('security', {
            enableEncryption: true,
            sessionTimeout: 3600000, // 1 hour
            maxLoginAttempts: 5
        });
        
        this.globalConfig.set('monitoring', {
            healthCheckInterval: 30000,
            metricsCollectionInterval: 60000,
            enablePerformanceMetrics: true
        });
        
        this.globalConfig.set('reconciliation', {
            reconciliationIntervalMs: 30000,
            maxDiscrepancyThreshold: 0.01,
            enableAutoCorrection: true,
            positionTimeoutMs: 300000
        });
    }
    
    initializeInstanceTemplate() {
        // Template for instance-specific configuration
        this.configTemplates.set('instance', {
            // Instance identification
            instanceId: null, // Must be unique
            account: null,    // Trading account
            instrument: 'CON.F.US.MGC.Q25', // Default instrument
            
            // Strategy configuration
            strategy: {
                active: 'VWAP',
                vwap: {
                    primaryThreshold: 0.15,
                    secondaryThreshold: 0.10,
                    filterThreshold: 0.30,
                    enableRegimeFilter: true
                },
                ema: {
                    mode: 'CONSERVATIVE',
                    fastPeriod: 9,
                    slowPeriod: 19,
                    enableMomentumFilter: true
                }
            },
            
            // Risk management (instance-specific)
            risk: {
                maxDailyLoss: 300,
                maxDailyProfit: 600,
                enableProfitTarget: false,
                maxPositionSize: 1,
                stopLossPercent: 0.25,
                enableTrailingStop: true,
                riskPerTrade: 50
            },
            
            // Contract specifications (can be instance-specific)
            contractSpecs: {
                contractSize: 10,        // 10 troy ounces per contract
                tickSize: 0.10,          // Minimum price movement $0.10
                tickValue: 1.00,         // Each tick worth $1.00
                pointValue: 10.00,       // Each $1 price move = $10 profit/loss
                currency: 'USD',
                contractType: 'FUTURES'
            },
            
            // Session configuration
            session: {
                enableQuietHours: true,
                quietHoursMultiplier: 2.5,
                enableSessionOptimization: true,
                timeZone: 'America/New_York'
            },
            
            // Position management
            positions: {
                enablePositionSync: true,
                syncIntervalMs: 2000,
                enableReconciliation: true,
                maxHoldingTimeMs: 1200000 // 20 minutes
            },
            
            // Instance-specific monitoring
            monitoring: {
                enableInstanceMetrics: true,
                reportingInterval: 60000,
                enableHealthBroadcast: true
            }
        });
    }
    
    // Create instance configuration
    async createInstanceConfig(instanceId, baseConfig = {}) {
        if (!instanceId) {
            throw new Error('Instance ID is required');
        }
        
        if (this.instanceConfigs.has(instanceId)) {
            throw new Error(`Instance configuration already exists: ${instanceId}`);
        }
        
        // Merge template with provided configuration
        const template = this.configTemplates.get('instance');
        const instanceConfig = this.deepMerge(template, baseConfig);
        
        // Set instance ID
        instanceConfig.instanceId = instanceId;
        
        // Validate configuration
        const validation = this.validateInstanceConfig(instanceConfig);
        if (!validation.valid) {
            throw new Error(`Invalid instance configuration: ${validation.errors.join(', ')}`);
        }
        
        // Store configuration
        this.instanceConfigs.set(instanceId, instanceConfig);
        
        // Save to file if file watching is enabled
        if (this.options.enableFileWatching) {
            await this.saveInstanceConfigToFile(instanceId, instanceConfig);
        }
        
        // Emit configuration created event
        this.emit('instanceConfigCreated', { instanceId, config: instanceConfig });
        
        console.log(`✅ Instance configuration created: ${instanceId}`);
        return instanceConfig;
    }
    
    // Get configuration for specific instance
    getInstanceConfig(instanceId) {
        if (!this.instanceConfigs.has(instanceId)) {
            throw new Error(`Instance configuration not found: ${instanceId}`);
        }
        
        const instanceConfig = this.instanceConfigs.get(instanceId);
        const globalConfig = this.getAllGlobalConfig();
        
        // Merge global and instance configurations
        return {
            global: globalConfig,
            instance: instanceConfig,
            merged: this.mergeConfigs(globalConfig, instanceConfig)
        };
    }
    
    // Update instance configuration
    async updateInstanceConfig(instanceId, updates) {
        if (!this.instanceConfigs.has(instanceId)) {
            throw new Error(`Instance configuration not found: ${instanceId}`);
        }
        
        const currentConfig = this.instanceConfigs.get(instanceId);
        const updatedConfig = this.deepMerge(currentConfig, updates);
        
        // Validate updated configuration
        const validation = this.validateInstanceConfig(updatedConfig);
        if (!validation.valid) {
            throw new Error(`Invalid configuration update: ${validation.errors.join(', ')}`);
        }
        
        // Store updated configuration
        this.instanceConfigs.set(instanceId, updatedConfig);
        
        // Save to file if file watching is enabled
        if (this.options.enableFileWatching) {
            await this.saveInstanceConfigToFile(instanceId, updatedConfig);
        }
        
        // Emit configuration updated event
        this.emit('instanceConfigUpdated', { instanceId, config: updatedConfig, changes: updates });
        
        console.log(`🔄 Instance configuration updated: ${instanceId}`);
        return updatedConfig;
    }
    
    // Get global configuration
    getGlobalConfig(section = null) {
        if (section) {
            return this.globalConfig.get(section);
        }
        return this.getAllGlobalConfig();
    }
    
    getAllGlobalConfig() {
        const config = {};
        for (const [key, value] of this.globalConfig) {
            config[key] = value;
        }
        return config;
    }
    
    // Update global configuration
    async updateGlobalConfig(section, updates) {
        if (!this.globalConfig.has(section)) {
            throw new Error(`Global configuration section not found: ${section}`);
        }
        
        const currentConfig = this.globalConfig.get(section);
        const updatedConfig = this.deepMerge(currentConfig, updates);
        
        // Store updated configuration
        this.globalConfig.set(section, updatedConfig);
        
        // Save to file if file watching is enabled
        if (this.options.enableFileWatching) {
            await this.saveGlobalConfigToFile();
        }
        
        // Emit configuration updated event
        this.emit('globalConfigUpdated', { section, config: updatedConfig, changes: updates });
        
        // Notify all instances of global configuration change
        this.notifyInstancesOfGlobalChange(section, updatedConfig);
        
        console.log(`🔄 Global configuration updated: ${section}`);
        return updatedConfig;
    }
    
    // Load configurations from files
    async loadConfigurationsFromFiles() {
        try {
            console.log('📂 Loading configurations from files...');
            
            // Load global configuration
            await this.loadGlobalConfigFromFile();
            
            // Load instance configurations
            await this.loadInstanceConfigsFromFile();
            
            // Setup file watchers if enabled
            if (this.options.enableFileWatching) {
                this.setupFileWatchers();
            }
            
            console.log('✅ Configurations loaded successfully');
            
        } catch (error) {
            console.error('❌ Failed to load configurations:', error);
            throw error;
        }
    }
    
    async loadGlobalConfigFromFile() {
        const globalConfigFile = path.join(this.options.globalConfigPath, 'global.json');
        
        if (fs.existsSync(globalConfigFile)) {
            try {
                const configData = JSON.parse(fs.readFileSync(globalConfigFile, 'utf8'));
                
                // Merge with existing global configuration
                for (const [section, config] of Object.entries(configData)) {
                    this.globalConfig.set(section, config);
                }
                
                console.log(`📂 Global configuration loaded: ${globalConfigFile}`);
                
            } catch (error) {
                console.error(`❌ Failed to load global configuration: ${error.message}`);
            }
        }
    }
    
    async loadInstanceConfigsFromFile() {
        const instanceConfigDir = this.options.instanceConfigPath;
        
        if (!fs.existsSync(instanceConfigDir)) {
            fs.mkdirSync(instanceConfigDir, { recursive: true });
            return;
        }
        
        const configFiles = fs.readdirSync(instanceConfigDir)
            .filter(file => file.endsWith('.json'));
        
        for (const configFile of configFiles) {
            try {
                const instanceId = path.basename(configFile, '.json');
                const configPath = path.join(instanceConfigDir, configFile);
                const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                
                this.instanceConfigs.set(instanceId, configData);
                console.log(`📂 Instance configuration loaded: ${instanceId}`);
                
            } catch (error) {
                console.error(`❌ Failed to load instance configuration ${configFile}: ${error.message}`);
            }
        }
    }
    
    async saveGlobalConfigToFile() {
        const globalConfigDir = this.options.globalConfigPath;
        const globalConfigFile = path.join(globalConfigDir, 'global.json');
        
        // Ensure directory exists
        if (!fs.existsSync(globalConfigDir)) {
            fs.mkdirSync(globalConfigDir, { recursive: true });
        }
        
        try {
            const configData = this.getAllGlobalConfig();
            fs.writeFileSync(globalConfigFile, JSON.stringify(configData, null, 2));
            console.log(`💾 Global configuration saved: ${globalConfigFile}`);
            
        } catch (error) {
            console.error(`❌ Failed to save global configuration: ${error.message}`);
        }
    }
    
    async saveInstanceConfigToFile(instanceId, config) {
        const instanceConfigDir = this.options.instanceConfigPath;
        const configFile = path.join(instanceConfigDir, `${instanceId}.json`);
        
        // Ensure directory exists
        if (!fs.existsSync(instanceConfigDir)) {
            fs.mkdirSync(instanceConfigDir, { recursive: true });
        }
        
        try {
            fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
            console.log(`💾 Instance configuration saved: ${instanceId}`);
            
        } catch (error) {
            console.error(`❌ Failed to save instance configuration ${instanceId}: ${error.message}`);
        }
    }
    
    // Configuration validation
    validateInstanceConfig(config) {
        const errors = [];
        
        // Required fields
        if (!config.instanceId) {
            errors.push('instanceId is required');
        }
        
        if (!config.account) {
            errors.push('account is required');
        }
        
        if (!config.instrument) {
            errors.push('instrument is required');
        }
        
        // Strategy validation
        if (!config.strategy || !config.strategy.active) {
            errors.push('strategy.active is required');
        }
        
        // Risk management validation
        if (!config.risk) {
            errors.push('risk configuration is required');
        } else {
            if (config.risk.maxDailyLoss <= 0) {
                errors.push('risk.maxDailyLoss must be positive');
            }
            
            if (config.risk.maxPositionSize <= 0) {
                errors.push('risk.maxPositionSize must be positive');
            }
        }
        
        // Contract specs validation
        if (!config.contractSpecs) {
            errors.push('contractSpecs is required');
        } else {
            if (!config.contractSpecs.pointValue || config.contractSpecs.pointValue <= 0) {
                errors.push('contractSpecs.pointValue must be positive');
            }
        }
        
        return {
            valid: errors.length === 0,
            errors
        };
    }
    
    // Configuration merging utilities
    mergeConfigs(globalConfig, instanceConfig) {
        const merged = { ...instanceConfig };
        
        // Add global configurations that don't conflict with instance settings
        merged._global = globalConfig;
        
        return merged;
    }
    
    deepMerge(target, source) {
        const result = { ...target };
        
        for (const key in source) {
            if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                result[key] = this.deepMerge(result[key] || {}, source[key]);
            } else {
                result[key] = source[key];
            }
        }
        
        return result;
    }
    
    // Instance management
    getAllInstanceIds() {
        return Array.from(this.instanceConfigs.keys());
    }
    
    deleteInstanceConfig(instanceId) {
        if (!this.instanceConfigs.has(instanceId)) {
            throw new Error(`Instance configuration not found: ${instanceId}`);
        }
        
        this.instanceConfigs.delete(instanceId);
        
        // Delete file if file watching is enabled
        if (this.options.enableFileWatching) {
            const configFile = path.join(this.options.instanceConfigPath, `${instanceId}.json`);
            if (fs.existsSync(configFile)) {
                fs.unlinkSync(configFile);
            }
        }
        
        this.emit('instanceConfigDeleted', { instanceId });
        console.log(`🗑️  Instance configuration deleted: ${instanceId}`);
    }
    
    // File watching
    setupFileWatchers() {
        // Watch global configuration file
        const globalConfigFile = path.join(this.options.globalConfigPath, 'global.json');
        if (fs.existsSync(globalConfigFile)) {
            const watcher = fs.watch(globalConfigFile, () => {
                console.log('📂 Global configuration file changed, reloading...');
                this.loadGlobalConfigFromFile();
            });
            this.watchers.set('global', watcher);
        }
        
        // Watch instance configuration directory
        const instanceConfigDir = this.options.instanceConfigPath;
        if (fs.existsSync(instanceConfigDir)) {
            const watcher = fs.watch(instanceConfigDir, (eventType, filename) => {
                if (filename && filename.endsWith('.json')) {
                    const instanceId = path.basename(filename, '.json');
                    console.log(`📂 Instance configuration file changed: ${instanceId}, reloading...`);
                    this.loadInstanceConfigsFromFile();
                }
            });
            this.watchers.set('instances', watcher);
        }
    }
    
    // Notification system
    notifyInstancesOfGlobalChange(section, config) {
        this.emit('globalConfigChanged', { section, config });
    }
    
    // Health and status
    getConfigStatus() {
        return {
            globalConfigSections: Array.from(this.globalConfig.keys()),
            instanceCount: this.instanceConfigs.size,
            instances: Array.from(this.instanceConfigs.keys()),
            fileWatchingEnabled: this.options.enableFileWatching,
            watcherCount: this.watchers.size
        };
    }
    
    // Cleanup
    cleanup() {
        // Stop file watchers
        for (const [name, watcher] of this.watchers) {
            watcher.close();
            console.log(`📂 File watcher stopped: ${name}`);
        }
        this.watchers.clear();
        
        console.log('🔧 Distributed Configuration Manager cleanup complete');
    }
}

module.exports = DistributedConfigManager;