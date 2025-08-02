// connection-manager/index.js
// Entry point for the Connection Manager service

// Set process title for Windows
if (process.platform === 'win32') {
    process.title = 'TSX-Connection-Manager';
}

// Enable silent mode support
require('../shared/utils/silentConsole');

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const ConnectionManager = require('./core/ConnectionManager');
const express = require('express');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const FileLogger = require('../shared/utils/FileLogger');

class ConnectionManagerApp {
    constructor() {
        this.connectionManager = null;
        this.app = null;
        this.server = null;
        this.config = this.loadConfiguration();
        
        // Initialize FileLogger
        this.logger = new FileLogger('ConnectionManager', 'logs');
        this.logger.info('Connection Manager starting up', {
            config: {
                port: this.config.port,
                apiUrl: this.config.urls.api,
                corsOrigins: this.config.corsOrigins
            }
        });
        
        // Manual Trading service tracking
        this.manualTradingLastHeartbeat = null;
        this.manualTradingAccount = null;
        
        // Track active connections for proper cleanup
        this.connections = new Set();
        
        // Handle process signals
        this.setupProcessHandlers();
    }
    
    loadConfiguration() {
        // Load from environment variables - always use production/real API
        const config = {
            port: process.env.CONNECTION_MANAGER_PORT || 7500,
            username: process.env.TOPSTEP_USERNAME_REAL,
            apiKey: process.env.TOPSTEP_API_KEY_REAL,
            urls: {
                api: 'https://api.topstepx.com',
                marketHub: 'https://rtc.topstepx.com/hubs/market',
                userHub: 'https://rtc.topstepx.com/hubs/user'
            },
            startTradingAggregator: process.env.START_TRADING_AGGREGATOR === 'true',
            tradingAggregatorPath: '../trading-aggregator',
            corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000').split(','),
            restartBotFleetDelayMs: parseInt(process.env.RESTART_BOT_FLEET_DELAY_MS) || 60000, // 1 minute default
            microOnly: true // Default to true for backward compatibility
        };
        
        // Load runtime configuration if available
        try {
            const runtimeConfigPath = path.join(__dirname, 'runtime-config.json');
            if (fs.existsSync(runtimeConfigPath)) {
                const runtimeConfig = JSON.parse(fs.readFileSync(runtimeConfigPath, 'utf8'));
                console.log('[ConfigLoad] Loaded runtime configuration:', runtimeConfig);
                config.microOnly = runtimeConfig.microOnly;
            }
        } catch (error) {
            console.log('[ConfigLoad] No runtime configuration found, using defaults');
        }
        
        // Log loaded configuration (without sensitive data)
        console.log(`[ConfigLoad] Starting Connection Manager:`, {
            port: config.port,
            urls: config.urls,
            corsOrigins: config.corsOrigins,
            username: config.username ? '***' : 'NOT SET',
            apiKey: config.apiKey ? '***' : 'NOT SET',
            startTradingAggregator: config.startTradingAggregator,
            microOnly: config.microOnly
        });
        
        return config;
    }
    
    setupProcessHandlers() {
        const shutdown = async (signal) => {
            console.log(`\n[${signal}] Graceful shutdown initiated...`);
            
            if (this.isShuttingDown) {
                console.log(`[${signal}] Shutdown already in progress, ignoring duplicate signal`);
                return;
            }
            
            this.isShuttingDown = true;
            
            try {
                // Stop accepting new connections
                if (this.server) {
                    console.log('Closing HTTP server...');
                    this.server.close();
                }
                
                // Close existing connections
                console.log(`Closing ${this.connections.size} active connections...`);
                for (const connection of this.connections) {
                    connection.destroy();
                }
                
                // Shutdown connection manager
                if (this.connectionManager) {
                    console.log('Shutting down connection manager...');
                    await this.connectionManager.shutdown();
                }
                
                console.log('Shutdown complete');
                process.exit(0);
            } catch (error) {
                console.error('Error during shutdown:', error);
                process.exit(1);
            }
        };
        
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
        
        // Windows-specific handling
        if (process.platform === 'win32') {
            process.on('SIGHUP', () => shutdown('SIGHUP'));
        }
    }
    
    async initialize() {
        // Setup Express app
        this.app = express();
        this.app.use(cors({ origin: this.config.corsOrigins }));
        this.app.use(express.json());
        
        // Health check
        this.app.get('/health', (req, res) => {
            const health = this.connectionManager && this.connectionManager.healthMonitor 
                ? this.connectionManager.healthMonitor.getHealth() 
                : { status: 'initializing' };
            res.json(health);
        });
        
        // Status endpoint
        this.app.get('/status', (req, res) => {
            if (!this.connectionManager) {
                return res.json({
                    status: 'initializing',
                    message: 'Connection Manager is starting up'
                });
            }
            
            res.json(this.connectionManager.getStatus());
        });
        
        // Get current account for specific service
        this.app.get('/current-account/:service', (req, res) => {
            const { service } = req.params;
            const account = this.connectionManager.getCurrentAccount(service);
            
            if (!account) {
                return res.status(404).json({
                    error: `No account found for service: ${service}`
                });
            }
            
            res.json(account);
        });
        
        // Account balance endpoint for aggregator
        this.app.get('/account/balance', async (req, res) => {
            try {
                console.log('[ConnectionManager] Fetching account balance for aggregator');
                const requestedAccountId = req.query.accountId ? parseInt(req.query.accountId) : null;
                
                // Get the cached accounts from connection manager
                let accounts = this.connectionManager.cachedAccounts || [];
                
                if (!accounts || accounts.length === 0) {
                    // Try to fetch accounts if none cached
                    console.log('[ConnectionManager] No cached accounts, fetching from API...');
                    const fetchResult = await this.connectionManager.fetchAccountsFromTopStep();
                    if (fetchResult && fetchResult.accounts) {
                        accounts.push(...fetchResult.accounts);
                    }
                }
                
                if (!accounts || accounts.length === 0) {
                    return res.status(404).json({
                        error: 'No accounts available',
                        message: 'No trading accounts found'
                    });
                }
                
                // Find the requested account or use the first one
                let selectedAccount = accounts[0];
                if (requestedAccountId) {
                    const foundAccount = accounts.find(acc => acc.id === requestedAccountId);
                    if (foundAccount) {
                        selectedAccount = foundAccount;
                        console.log(`[ConnectionManager] Found requested account: ${requestedAccountId}`);
                    } else {
                        console.log(`[ConnectionManager] Account ${requestedAccountId} not found, using first account`);
                    }
                }
                
                const accountBalance = {
                    totalBalance: parseFloat(selectedAccount.balance) || 50000.00,
                    availableBalance: parseFloat(selectedAccount.balance) || 50000.00,
                    currency: 'USD', // TopStep uses USD
                    lastUpdated: new Date().toISOString(),
                    accountNumber: selectedAccount.displayName || selectedAccount.name || `Account-${selectedAccount.id}`,
                    accountId: selectedAccount.id,
                    accountName: selectedAccount.displayName || selectedAccount.name
                };
                
                console.log('[ConnectionManager] Returning account balance:', accountBalance);
                res.json(accountBalance);
            } catch (error) {
                console.error('[ConnectionManager] Failed to fetch account balance:', error.message);
                res.status(500).json({
                    error: 'Failed to fetch account balance',
                    message: error.message
                });
            }
        });
        
        // Command endpoint for trading bots
        this.app.post('/command', async (req, res) => {
            const { command, params } = req.body;
            
            console.log(`[Command] Received: ${command}`, params);
            
            try {
                let result;
                
                switch(command) {
                    case 'switchAccount':
                        result = await this.connectionManager.switchAccount(params.accountId, params.service);
                        break;
                        
                    case 'startTrading':
                        result = await this.connectionManager.startTrading(params.accountId, params.service);
                        break;
                        
                    case 'stopTrading':
                        result = await this.connectionManager.stopTrading(params.service);
                        break;
                        
                    case 'pauseTrading':
                        result = await this.connectionManager.pauseTrading(params.service);
                        break;
                        
                    case 'resumeTrading':
                        result = await this.connectionManager.resumeTrading(params.service);
                        break;
                        
                    case 'reconnect':
                        result = await this.connectionManager.reconnect();
                        break;
                        
                    case 'getStatus':
                        result = this.connectionManager.getStatus();
                        break;
                        
                    default:
                        return res.status(400).json({
                            error: `Unknown command: ${command}`
                        });
                }
                
                res.json({ success: true, result });
                
            } catch (error) {
                console.error(`[Command] Error executing ${command}:`, error);
                res.status(500).json({
                    error: error.message,
                    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
                });
            }
        });
        
        // Get positions endpoint for aggregator
        this.app.get('/api/positions', async (req, res) => {
            try {
                const accountId = req.query.account || req.query.accountId;
                console.log('[ConnectionManager] Fetching positions', accountId ? `for account ${accountId}` : 'for all accounts');
                
                // Get positions from TopStep via Connection Manager
                const result = await this.connectionManager.getPositions(accountId);
                
                if (result.success) {
                    res.json({
                        success: true,
                        positions: result.positions || [],
                        accountId: accountId
                    });
                } else {
                    res.status(500).json({
                        success: false,
                        error: result.error || 'Failed to fetch positions',
                        positions: []
                    });
                }
            } catch (error) {
                console.error('[ConnectionManager] Failed to fetch positions:', error.message);
                res.status(500).json({
                    success: false,
                    error: error.message,
                    positions: []
                });
            }
        });
        
        // SL/TP update endpoint
        this.app.post('/api/position/update-sltp', async (req, res) => {
            const { accountId, positionId, stopLoss, takeProfit } = req.body;
            
            try {
                this.logger.logSLTP('SL/TP Update Request', {
                    accountId,
                    positionId,
                    stopLoss,
                    takeProfit
                });
                
                // Make the actual API call to TopStep userapi
                const axios = require('axios');
                const response = await axios.post(
                    'https://userapi.topstepx.com/Order/editStopLossAccount',
                    {
                        accountId,
                        positionId,
                        stopLoss,
                        takeProfit
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'User-Agent': 'TSX-Trading-Bot-V4/1.0'
                        }
                    }
                );
                
                this.logger.logSLTP('SL/TP Update Response', {
                    status: response.status,
                    data: response.data
                });
                
                res.json({
                    success: response.status === 200,
                    data: response.data
                });
                
            } catch (error) {
                this.logger.error('Failed to update SL/TP', {
                    error: error.message,
                    response: error.response?.data
                });
                
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });
        
        // Manual Trading service endpoints
        this.app.post('/api/manual-trading/heartbeat', (req, res) => {
            const { accountId } = req.body;
            
            this.manualTradingLastHeartbeat = Date.now();
            this.manualTradingAccount = accountId;
            
            console.log(`[ManualTrading] Heartbeat received for account: ${accountId}`);
            
            res.json({
                success: true,
                timestamp: this.manualTradingLastHeartbeat
            });
        });
        
        this.app.get('/api/manual-trading/status', (req, res) => {
            const now = Date.now();
            const isActive = this.manualTradingLastHeartbeat && 
                           (now - this.manualTradingLastHeartbeat) < 35000; // 35 seconds timeout
            
            res.json({
                active: isActive,
                account: isActive ? this.manualTradingAccount : null,
                lastHeartbeat: this.manualTradingLastHeartbeat,
                timeSinceLastHeartbeat: this.manualTradingLastHeartbeat ? 
                    now - this.manualTradingLastHeartbeat : null
            });
        });
        
        // WebSocket endpoint for trading bots
        this.app.get('/ws', (req, res) => {
            res.status(426).json({
                error: 'WebSocket upgrade required',
                headers: {
                    'Upgrade': 'websocket',
                    'Connection': 'Upgrade'
                }
            });
        });
        
        // Create HTTP server
        this.server = http.createServer(this.app);
        
        // Track connections for graceful shutdown
        this.server.on('connection', (connection) => {
            this.connections.add(connection);
            connection.on('close', () => {
                this.connections.delete(connection);
            });
        });
        
        // Initialize ConnectionManager with server
        this.connectionManager = new ConnectionManager(this.config, this.server);
        this.connectionManager.logger = this.logger; // Pass logger reference
        await this.connectionManager.initialize();
        
        // Start server
        await new Promise((resolve, reject) => {
            this.server.listen(this.config.port, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        console.log(`[Startup] Connection Manager listening on port ${this.config.port}`);
        console.log(`[Startup] WebSocket endpoint: ws://localhost:${this.config.port}/ws`);
        console.log(`[Startup] Health check: http://localhost:${this.config.port}/health`);
        
        // Start the Trading Aggregator if configured
        if (this.config.startTradingAggregator) {
            this.startTradingAggregator();
        }
    }
    
    startTradingAggregator() {
        console.log('[TradingAggregator] Starting Trading Aggregator service...');
        
        const { spawn } = require('child_process');
        const path = require('path');
        
        const aggregatorPath = path.join(__dirname, this.config.tradingAggregatorPath);
        const aggregatorProcess = spawn('node', ['index.js'], {
            cwd: aggregatorPath,
            env: { ...process.env },
            stdio: 'inherit'
        });
        
        aggregatorProcess.on('error', (error) => {
            console.error('[TradingAggregator] Failed to start:', error);
        });
        
        aggregatorProcess.on('exit', (code, signal) => {
            console.log(`[TradingAggregator] Process exited with code ${code} and signal ${signal}`);
        });
    }
    
    async start() {
        try {
            await this.initialize();
        } catch (error) {
            console.error('[Startup] Failed to start Connection Manager:', error);
            process.exit(1);
        }
    }
}

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    console.error(error.stack);
    
    // Log to file if logger is available
    if (global.connectionManagerApp && global.connectionManagerApp.logger) {
        global.connectionManagerApp.logger.error('Uncaught Exception', {
            error: error.message,
            stack: error.stack
        });
    }
    
    // Don't exit on Redis errors - attempt to recover
    if (error.message && error.message.includes('Redis') || error.code === 'ECONNRESET') {
        console.log('🔄 Attempting to recover from Redis error...');
        return;
    }
    
    // For other critical errors, exit gracefully
    console.log('💀 Fatal error - exiting in 5 seconds...');
    setTimeout(() => {
        process.exit(1);
    }, 5000);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    
    // Log to file if logger is available
    if (global.connectionManagerApp && global.connectionManagerApp.logger) {
        global.connectionManagerApp.logger.error('Unhandled Rejection', {
            reason: reason?.message || reason,
            stack: reason?.stack
        });
    }
    
    // Don't exit on Redis rejections - attempt to recover
    if (reason && (reason.message?.includes('Redis') || reason.code === 'ECONNRESET')) {
        console.log('🔄 Attempting to recover from Redis rejection...');
        return;
    }
});

// Start the application
const app = new ConnectionManagerApp();
global.connectionManagerApp = app; // Make available for error handlers
app.start();