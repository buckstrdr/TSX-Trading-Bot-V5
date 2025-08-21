/**
 * Standalone Trading Bot with Integrated UI
 * Complete bot implementation with web interface
 * This will be the template for all 6 bot copies
 */

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const yaml = require('js-yaml');
const fs = require('fs').promises;
const TradingBot = require('./TradingBot');

// Configuration
const BOT_ID = process.env.BOT_ID || 'BOT_1';
const CONFIG_PATH = path.join(__dirname, `../../../config/bots/${BOT_ID}.yaml`);

class StandaloneTradingBot {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.io = socketIo(this.server, {
            cors: {
                origin: "*",
                methods: ["GET", "POST"]
            }
        });
        
        this.bot = null;
        this.config = null;
        this.state = {
            botId: BOT_ID,
            status: 'initializing',
            account: null,
            position: null,
            trades: [],
            signals: [],
            strategy: null,  // Will be populated when config is loaded
            metrics: {
                totalTrades: 0,
                winningTrades: 0,
                losingTrades: 0,
                winRate: 0,
                totalPnL: 0,
                largestWin: 0,
                largestLoss: 0,
                averageWin: 0,
                averageLoss: 0,
                profitFactor: 0,
                sharpeRatio: 0,
                maxDrawdown: 0,
                currentDrawdown: 0
            },
            marketData: {
                lastPrice: null,
                bid: null,
                ask: null,
                volume: null,
                timestamp: null
            },
            logs: []
        };
        
        this.setupMiddleware();
        this.setupRoutes();
        this.setupWebSocket();
    }

    setupMiddleware() {
        this.app.use(express.json());
        this.app.use(express.static(path.join(__dirname, 'public')));
        
        // Serve shared UI assets
        this.app.use('/shared', express.static(path.join(__dirname, '../../ui/shared')));
        
        // Serve config page
        this.app.get('/config.html', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'config.html'));
        });
    }

    setupRoutes() {
        // Health check
        this.app.get('/health', (req, res) => {
            res.json({
                botId: BOT_ID,
                status: this.state.status,
                uptime: process.uptime(),
                timestamp: new Date().toISOString()
            });
        });

        // Get current state
        this.app.get('/api/state', (req, res) => {
            res.json(this.state);
        });

        // Get configuration
        this.app.get('/api/config', (req, res) => {
            res.json(this.config || {});
        });

        // Update configuration
        this.app.post('/api/config', async (req, res) => {
            try {
                const newConfig = req.body;
                
                // Save to YAML file
                const yamlContent = yaml.dump(newConfig);
                await fs.writeFile(CONFIG_PATH, yamlContent);
                
                // Reload bot with new config
                await this.reloadBot();
                
                res.json({ success: true, message: 'Configuration updated' });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Bot control endpoints
        this.app.post('/api/start', async (req, res) => {
            try {
                const { account } = req.body;
                await this.startBot(account);
                res.json({ success: true, message: 'Bot started' });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.post('/api/stop', async (req, res) => {
            try {
                await this.stopBot();
                res.json({ success: true, message: 'Bot stopped' });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.app.post('/api/pause', (req, res) => {
            if (this.bot) {
                this.bot.pause();
                this.state.status = 'paused';
                this.broadcast('status', this.state.status);
                res.json({ success: true });
            } else {
                res.status(400).json({ error: 'Bot not running' });
            }
        });

        this.app.post('/api/resume', (req, res) => {
            if (this.bot) {
                this.bot.resume();
                this.state.status = 'running';
                this.broadcast('status', this.state.status);
                res.json({ success: true });
            } else {
                res.status(400).json({ error: 'Bot not running' });
            }
        });

        // Get trade history
        this.app.get('/api/trades', (req, res) => {
            const limit = parseInt(req.query.limit) || 100;
            res.json(this.state.trades.slice(-limit));
        });

        // Get logs
        this.app.get('/api/logs', (req, res) => {
            const limit = parseInt(req.query.limit) || 100;
            res.json(this.state.logs.slice(-limit));
        });

        // Clear logs
        this.app.post('/api/logs/clear', (req, res) => {
            this.state.logs = [];
            res.json({ success: true });
        });

        // Manual trade override (for testing)
        this.app.post('/api/trade/manual', async (req, res) => {
            try {
                if (!this.bot) {
                    throw new Error('Bot not running');
                }
                
                const { side, quantity } = req.body;
                // Implement manual trade logic here
                res.json({ success: true, message: 'Manual trade submitted' });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
    }

    setupWebSocket() {
        this.io.on('connection', (socket) => {
            console.log(`Client connected to ${BOT_ID}`);
            
            // Send current state
            socket.emit('state', this.state);
            
            socket.on('disconnect', () => {
                console.log(`Client disconnected from ${BOT_ID}`);
            });
            
            // Handle client commands
            socket.on('command', async (cmd, callback) => {
                try {
                    const result = await this.handleCommand(cmd);
                    callback({ success: true, result });
                } catch (error) {
                    callback({ success: false, error: error.message });
                }
            });
        });
    }

    async handleCommand(cmd) {
        switch (cmd.type) {
            case 'start':
                return await this.startBot(cmd.account);
            case 'stop':
                return await this.stopBot();
            case 'pause':
                return this.bot?.pause();
            case 'resume':
                return this.bot?.resume();
            default:
                throw new Error(`Unknown command: ${cmd.type}`);
        }
    }

    async loadConfiguration() {
        try {
            const configContent = await fs.readFile(CONFIG_PATH, 'utf8');
            this.config = yaml.load(configContent);
            
            // Update state with strategy information
            if (this.config.strategy) {
                this.state.strategy = {
                    type: this.config.strategy.type,
                    parameters: this.config.strategy.parameters || {}
                };
                this.log('info', `Strategy loaded: ${this.config.strategy.type}`);
            }
            
            this.log('info', `Configuration loaded for ${BOT_ID}`);
            
            // Broadcast full state update to all connected clients
            this.broadcast('state', this.state);
            
            return this.config;
        } catch (error) {
            this.log('error', `Failed to load configuration: ${error.message}`);
            throw error;
        }
    }

    async startBot(account) {
        try {
            if (this.bot && this.state.status === 'running') {
                throw new Error('Bot is already running');
            }

            this.state.account = account || this.config.account || 'DEMO';
            this.state.status = 'starting';
            this.broadcast('status', this.state.status);

            // Create bot instance
            this.bot = new TradingBot({
                botId: BOT_ID,
                account: this.state.account,
                configPath: CONFIG_PATH
            });

            // Set up bot event listeners
            this.setupBotListeners();

            // Initialize and start
            await this.bot.initialize();
            await this.bot.start();

            this.state.status = 'running';
            this.broadcast('status', this.state.status);
            this.log('info', `Bot started with account: ${this.state.account}`);

        } catch (error) {
            this.state.status = 'error';
            this.broadcast('status', this.state.status);
            this.log('error', `Failed to start bot: ${error.message}`);
            throw error;
        }
    }

    async stopBot() {
        try {
            if (!this.bot) {
                throw new Error('Bot is not running');
            }

            this.state.status = 'stopping';
            this.broadcast('status', this.state.status);

            await this.bot.stop();
            this.bot = null;

            this.state.status = 'stopped';
            this.state.position = null;
            this.broadcast('status', this.state.status);
            this.log('info', 'Bot stopped');

        } catch (error) {
            this.log('error', `Failed to stop bot: ${error.message}`);
            throw error;
        }
    }

    async reloadBot() {
        const wasRunning = this.state.status === 'running';
        const account = this.state.account;

        if (wasRunning) {
            await this.stopBot();
        }

        await this.loadConfiguration();

        if (wasRunning) {
            await this.startBot(account);
        }
    }

    setupBotListeners() {
        if (!this.bot) return;

        this.bot.on('market-data', (data) => {
            this.state.marketData = {
                lastPrice: data.price,
                bid: data.bid,
                ask: data.ask,
                volume: data.volume,
                timestamp: data.timestamp
            };
            this.broadcast('market-data', this.state.marketData);
        });

        this.bot.on('signal', (signal) => {
            this.state.signals.push({
                ...signal,
                timestamp: new Date()
            });
            this.broadcast('signal', signal);
            this.log('info', `Signal generated: ${signal.side} ${signal.quantity}`);
        });

        this.bot.on('trade', (trade) => {
            this.state.trades.push({
                ...trade,
                timestamp: new Date()
            });
            this.updateMetrics();
            this.broadcast('trade', trade);
            this.log('info', `Trade executed: ${trade.side} ${trade.quantity} @ ${trade.price}`);
        });

        this.bot.on('position-update', (position) => {
            this.state.position = position;
            this.broadcast('position', position);
        });

        this.bot.on('error', (error) => {
            this.log('error', `Bot error: ${error.message}`);
            this.broadcast('error', error.message);
        });

        this.bot.on('log', (log) => {
            this.log(log.level, log.message);
        });
    }

    updateMetrics() {
        const trades = this.state.trades;
        const metrics = this.state.metrics;

        metrics.totalTrades = trades.length;
        metrics.winningTrades = trades.filter(t => t.pnl > 0).length;
        metrics.losingTrades = trades.filter(t => t.pnl < 0).length;
        
        if (metrics.totalTrades > 0) {
            metrics.winRate = (metrics.winningTrades / metrics.totalTrades) * 100;
            metrics.totalPnL = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
            
            const wins = trades.filter(t => t.pnl > 0).map(t => t.pnl);
            const losses = trades.filter(t => t.pnl < 0).map(t => Math.abs(t.pnl));
            
            if (wins.length > 0) {
                metrics.largestWin = Math.max(...wins);
                metrics.averageWin = wins.reduce((a, b) => a + b, 0) / wins.length;
            }
            
            if (losses.length > 0) {
                metrics.largestLoss = Math.max(...losses);
                metrics.averageLoss = losses.reduce((a, b) => a + b, 0) / losses.length;
                metrics.profitFactor = metrics.averageWin / metrics.averageLoss;
            }
        }

        this.broadcast('metrics', metrics);
    }

    log(level, message) {
        const logEntry = {
            timestamp: new Date(),
            level,
            message
        };
        
        this.state.logs.push(logEntry);
        
        // Keep only last 1000 logs
        if (this.state.logs.length > 1000) {
            this.state.logs = this.state.logs.slice(-1000);
        }
        
        this.broadcast('log', logEntry);
        
        // Console output
        console.log(`[${BOT_ID}] [${level.toUpperCase()}] ${message}`);
    }

    broadcast(event, data) {
        this.io.emit(event, data);
    }

    async start() {
        try {
            // Load configuration
            await this.loadConfiguration();
            
            // Get port from config
            const port = this.config.port || 3004;
            
            // Start server
            this.server.listen(port, () => {
                console.log(`${BOT_ID} server running on http://localhost:${port}`);
                this.state.status = 'ready';
            });
            
        } catch (error) {
            console.error(`Failed to start ${BOT_ID} server:`, error);
            process.exit(1);
        }
    }

    async shutdown() {
        console.log(`Shutting down ${BOT_ID}...`);
        
        try {
            if (this.bot) {
                await this.stopBot();
            }
            
            this.io.close();
            this.server.close();
            
            console.log(`${BOT_ID} shut down successfully`);
            process.exit(0);
        } catch (error) {
            console.error(`Error during shutdown:`, error);
            process.exit(1);
        }
    }
}

// Create and start the bot
const bot = new StandaloneTradingBot();

// Handle process signals
process.on('SIGTERM', () => bot.shutdown());
process.on('SIGINT', () => bot.shutdown());

// Start the bot server
bot.start();