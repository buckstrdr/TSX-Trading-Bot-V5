const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');
const Ajv = require('ajv');
const chokidar = require('chokidar');
const EventEmitter = require('events');
const winston = require('winston');

/**
 * ConfigurationManager - Handles YAML configuration with hot reload and validation
 * 
 * Features:
 * - YAML file parsing and validation
 * - JSON Schema validation
 * - Hot reload support with file watching
 * - Version control and rollback
 * - Environment variable support
 */
class ConfigurationManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.configPath = options.configPath || path.join(process.cwd(), 'config');
    this.botId = options.botId;
    this.schema = options.schema;
    this.ajv = new Ajv({ allErrors: true, useDefaults: true });
    this.currentConfig = null;
    this.configHistory = [];
    this.maxHistorySize = options.maxHistorySize || 10;
    this.watcher = null;
    this.isWatching = false;
    
    // Setup logger
    this.logger = winston.createLogger({
      level: options.logLevel || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
          return `[${timestamp}] [ConfigurationManager] ${level}: ${message}`;
        })
      ),
      transports: [
        new winston.transports.Console()
      ]
    });
  }

  /**
   * Initialize the configuration manager
   */
  async initialize() {
    try {
      // Load initial configuration
      await this.loadConfiguration();
      
      // Start watching for changes if enabled
      if (this.isWatching) {
        this.startWatching();
      }
      
      this.logger.info('ConfigurationManager initialized successfully');
      return true;
    } catch (error) {
      this.logger.error(`Failed to initialize ConfigurationManager: ${error.message}`);
      throw error;
    }
  }

  /**
   * Load configuration from YAML files
   */
  async loadConfiguration() {
    try {
      // Load global config
      const globalConfig = await this.loadYamlFile(path.join(this.configPath, 'global.yaml'));
      
      // Load bot-specific config if botId is provided
      let botConfig = {};
      if (this.botId) {
        const botConfigPath = path.join(this.configPath, 'bots', `${this.botId}.yaml`);
        if (await this.fileExists(botConfigPath)) {
          botConfig = await this.loadYamlFile(botConfigPath);
        }
      }
      
      // Merge configurations (bot config overrides global)
      let mergedConfig = this.deepMerge(globalConfig || {}, botConfig);
      
      // Apply environment variable overrides
      mergedConfig = this.applyEnvironmentOverrides(mergedConfig);
      
      // Validate configuration against schema
      if (this.schema) {
        this.validateConfiguration(mergedConfig);
      }
      
      // Store in history before updating current
      if (this.currentConfig) {
        this.addToHistory(this.currentConfig);
      }
      
      this.currentConfig = mergedConfig;
      this.emit('configLoaded', mergedConfig);
      this.logger.info('Configuration loaded successfully');
      
      return mergedConfig;
    } catch (error) {
      this.logger.error(`Failed to load configuration: ${error.message}`);
      throw error;
    }
  }

  /**
   * Load and parse a YAML file
   */
  async loadYamlFile(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return yaml.load(content);
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.logger.warn(`Configuration file not found: ${filePath}`);
        return null;
      }
      throw error;
    }
  }

  /**
   * Check if a file exists
   */
  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Deep merge two objects
   */
  deepMerge(target, source) {
    const output = Object.assign({}, target);
    
    if (this.isObject(target) && this.isObject(source)) {
      Object.keys(source).forEach(key => {
        if (this.isObject(source[key])) {
          if (!(key in target)) {
            Object.assign(output, { [key]: source[key] });
          } else {
            output[key] = this.deepMerge(target[key], source[key]);
          }
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }
    
    return output;
  }

  /**
   * Check if value is an object
   */
  isObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
  }

  /**
   * Apply environment variable overrides
   * Environment variables should follow the pattern: BOT_CONFIG_<PATH>
   * Example: BOT_CONFIG_TRADING_MAXPOSITIONS=5
   */
  applyEnvironmentOverrides(config) {
    const envPrefix = 'BOT_CONFIG_';
    const result = { ...config };
    
    Object.keys(process.env)
      .filter(key => key.startsWith(envPrefix))
      .forEach(key => {
        const configPath = key
          .substring(envPrefix.length)
          .toLowerCase()
          .split('_');
        
        let current = result;
        for (let i = 0; i < configPath.length - 1; i++) {
          if (!current[configPath[i]]) {
            current[configPath[i]] = {};
          }
          current = current[configPath[i]];
        }
        
        const value = process.env[key];
        const lastKey = configPath[configPath.length - 1];
        
        // Try to parse as JSON, fallback to string
        try {
          current[lastKey] = JSON.parse(value);
        } catch {
          current[lastKey] = value;
        }
      });
    
    return result;
  }

  /**
   * Validate configuration against schema
   */
  validateConfiguration(config) {
    if (!this.schema) {
      return true;
    }
    
    const validate = this.ajv.compile(this.schema);
    const valid = validate(config);
    
    if (!valid) {
      const errors = validate.errors
        .map(err => `${err.instancePath} ${err.message}`)
        .join(', ');
      throw new Error(`Configuration validation failed: ${errors}`);
    }
    
    return true;
  }

  /**
   * Start watching configuration files for changes
   */
  startWatching() {
    if (this.watcher) {
      return;
    }
    
    const watchPaths = [
      path.join(this.configPath, 'global.yaml')
    ];
    
    if (this.botId) {
      watchPaths.push(path.join(this.configPath, 'bots', `${this.botId}.yaml`));
    }
    
    this.watcher = chokidar.watch(watchPaths, {
      persistent: true,
      ignoreInitial: true
    });
    
    this.watcher.on('change', async (filePath) => {
      this.logger.info(`Configuration file changed: ${filePath}`);
      try {
        await this.loadConfiguration();
        this.emit('configReloaded', this.currentConfig);
      } catch (error) {
        this.logger.error(`Failed to reload configuration: ${error.message}`);
        this.emit('configReloadError', error);
      }
    });
    
    this.isWatching = true;
    this.logger.info('Configuration file watching started');
  }

  /**
   * Stop watching configuration files
   */
  async stopWatching() {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      this.isWatching = false;
      this.logger.info('Configuration file watching stopped');
    }
  }

  /**
   * Add configuration to history
   */
  addToHistory(config) {
    this.configHistory.push({
      timestamp: new Date(),
      config: JSON.parse(JSON.stringify(config))
    });
    
    // Limit history size
    if (this.configHistory.length > this.maxHistorySize) {
      this.configHistory.shift();
    }
  }

  /**
   * Rollback to a previous configuration version
   */
  rollback(steps = 1) {
    if (steps > this.configHistory.length) {
      throw new Error(`Cannot rollback ${steps} steps, only ${this.configHistory.length} versions available`);
    }
    
    const targetIndex = this.configHistory.length - steps;
    const targetConfig = this.configHistory[targetIndex].config;
    
    // Validate the target configuration
    if (this.schema) {
      this.validateConfiguration(targetConfig);
    }
    
    // Store current config in history
    this.addToHistory(this.currentConfig);
    
    // Apply the rollback
    this.currentConfig = targetConfig;
    this.emit('configRolledBack', {
      steps,
      config: targetConfig
    });
    
    this.logger.info(`Configuration rolled back ${steps} version(s)`);
    return targetConfig;
  }

  /**
   * Get current configuration
   */
  getConfig() {
    return this.currentConfig;
  }

  /**
   * Get configuration value by path
   * Example: getValue('trading.maxPositions')
   */
  getValue(path, defaultValue = undefined) {
    if (!this.currentConfig) {
      return defaultValue;
    }
    
    const keys = path.split('.');
    let current = this.currentConfig;
    
    for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
        current = current[key];
      } else {
        return defaultValue;
      }
    }
    
    return current;
  }

  /**
   * Set configuration value by path
   * Example: setValue('trading.maxPositions', 5)
   */
  async setValue(path, value) {
    const keys = path.split('.');
    const newConfig = JSON.parse(JSON.stringify(this.currentConfig || {}));
    
    let current = newConfig;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!current[keys[i]]) {
        current[keys[i]] = {};
      }
      current = current[keys[i]];
    }
    
    current[keys[keys.length - 1]] = value;
    
    // Validate new configuration
    if (this.schema) {
      this.validateConfiguration(newConfig);
    }
    
    // Store in history
    if (this.currentConfig) {
      this.addToHistory(this.currentConfig);
    }
    
    this.currentConfig = newConfig;
    this.emit('configUpdated', {
      path,
      value,
      config: newConfig
    });
    
    return newConfig;
  }

  /**
   * Get configuration history
   */
  getHistory() {
    return this.configHistory.map(entry => ({
      timestamp: entry.timestamp,
      config: JSON.parse(JSON.stringify(entry.config))
    }));
  }

  /**
   * Enable hot reload
   */
  enableHotReload() {
    this.startWatching();
  }

  /**
   * Disable hot reload
   */
  async disableHotReload() {
    await this.stopWatching();
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    await this.stopWatching();
    this.removeAllListeners();
    this.configHistory = [];
    this.currentConfig = null;
  }
}

module.exports = ConfigurationManager;