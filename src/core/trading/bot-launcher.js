/**
 * Bot Launcher - Entry point for individual bot instances
 * This script is spawned as a separate process for each bot
 */

const TradingBot = require('./TradingBot');
const PnLModule = require('../pnl/PnLModule');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const yaml = require('js-yaml');
const fs = require('fs').promises;
const fsSync = require('fs');
const redis = require('redis');
const axios = require('axios');

// Parse command line arguments
const args = process.argv.slice(2);
const botId = args[args.indexOf('--botId') + 1];
const account = args[args.indexOf('--account') + 1];
const rawConfigPath = args[args.indexOf('--config') + 1];

// Convert to absolute path to ensure consistent file location
const configPath = path.resolve(rawConfigPath);

if (!botId || !account) {
    console.error('Missing required arguments: --botId and --account');
    process.exit(1);
}

console.log(`Starting ${botId} with account ${account}`);
console.log(`Config file path (resolved): ${configPath}`);

// Simple rate limiter for console output to prevent flooding
let messageCount = 0;
let lastReset = Date.now();
const originalLog = console.log;

// Override console.log to rate limit output
console.log = (...args) => {
    const now = Date.now();
    if (now - lastReset > 1000) {
        messageCount = 0;
        lastReset = now;
    }
    
    // Skip market data and quote messages entirely
    const message = args.join(' ');
    if (message.includes('Quote data') || 
        message.includes('Market data') || 
        message.includes('QUOTE') ||
        message.includes('TRADE') ||
        message.includes('bid:') ||
        message.includes('ask:')) {
        return; // Skip these messages
    }
    
    // Rate limit other messages
    if (messageCount < 20) {
        originalLog(...args);
        messageCount++;
    }
};

// Create Express app for bot's individual UI/API
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(express.json());

// Log all incoming requests for debugging
app.use((req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve shared UI assets
app.use('/shared', express.static(path.join(__dirname, '../../ui/shared')));

// Serve config page explicitly
app.get('/config.html', (req, res) => {
    try {
        const configPath = path.join(__dirname, 'public', 'config.html');
        console.log(`Serving config page from: ${configPath}`);
        
        // Check if file exists
        if (!fsSync.existsSync(configPath)) {
            console.error(`Config file not found at: ${configPath}`);
            return res.status(404).send('Config page not found');
        }
        
        res.sendFile(configPath);
    } catch (error) {
        console.error('Error serving config page:', error);
        res.status(500).send('Error loading config page');
    }
});

// API Routes
app.get('/api/config', async (req, res) => {
    try {
        console.log(`[CONFIG GET] Loading from: ${configPath}`);
        console.log(`[CONFIG GET] File exists: ${fsSync.existsSync(configPath)}`);
        
        // Always load config from file to ensure we get the latest
        const configContent = await fs.readFile(configPath, 'utf8');
        const config = yaml.load(configContent);
        
        console.log(`[CONFIG GET] Loaded - instrument: ${config.instrument}, riskPerTrade: ${config.risk?.dollarRiskPerTrade}`);
        
        res.json(config);
    } catch (error) {
        console.error('Error loading config:', error);
        res.status(500).json({ error: 'Failed to load configuration' });
    }
});

app.post('/api/config', async (req, res) => {
    try {
        console.log(`[CONFIG SAVE] Saving to: ${configPath}`);
        console.log(`[CONFIG SAVE] Received - instrument: ${req.body.instrument}, riskPerTrade: ${req.body.risk?.dollarRiskPerTrade}`);
        
        // Simply update the config file
        const yamlStr = yaml.dump(req.body);
        await fs.writeFile(configPath, yamlStr, 'utf8');
        
        console.log(`[CONFIG SAVE] File written to: ${configPath}`);
        console.log(`[CONFIG SAVE] File exists: ${fsSync.existsSync(configPath)}`);
        
        // Verify the save by reading it back
        const verifyContent = await fs.readFile(configPath, 'utf8');
        const verifyConfig = yaml.load(verifyContent);
        console.log(`[CONFIG SAVE] Verified - instrument: ${verifyConfig.instrument}, riskPerTrade: ${verifyConfig.risk?.dollarRiskPerTrade}`);
        
        res.json({ success: true, message: 'Configuration saved successfully' });
    } catch (error) {
        console.error('Error saving config:', error);
        res.status(500).json({ error: 'Failed to save configuration' });
    }
});

// Get available instruments from aggregator
app.get('/api/instruments', async (req, res) => {
    let publisher = null;
    let subscriber = null;
    
    try {
        const { v4: uuidv4 } = require('uuid');
        
        // Create Redis clients
        publisher = redis.createClient({ host: 'localhost', port: 6379 });
        subscriber = redis.createClient({ host: 'localhost', port: 6379 });
        
        await publisher.connect();
        await subscriber.connect();
        
        const requestId = uuidv4();
        const responseChannel = `manual-trading:response:${requestId}`;
        
        // Set up response listener
        const responsePromise = new Promise((resolve, reject) => {
            let isResolved = false;
            
            const timeout = setTimeout(async () => {
                if (!isResolved) {
                    isResolved = true;
                    try {
                        await subscriber.unsubscribe(responseChannel);
                    } catch (e) {
                        // Ignore unsubscribe errors
                    }
                    reject(new Error('Timeout waiting for instruments'));
                }
            }, 5000);
            
            subscriber.subscribe(responseChannel, async (message) => {
                if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timeout);
                    try {
                        await subscriber.unsubscribe(responseChannel);
                    } catch (e) {
                        // Ignore unsubscribe errors
                    }
                    try {
                        const response = JSON.parse(message);
                        console.log('[INSTRUMENTS API] Received response from aggregator:', response);
                        
                        // Handle different response formats
                        let instruments = [];
                        if (response.contracts) {
                            instruments = response.contracts;
                        } else if (response.instruments) {
                            instruments = response.instruments;
                        } else if (Array.isArray(response)) {
                            instruments = response;
                        }
                        
                        console.log('[INSTRUMENTS API] Extracted instruments:', instruments);
                        resolve(instruments);
                    } catch (err) {
                        console.error('[INSTRUMENTS API] Error parsing response:', err);
                        reject(err);
                    }
                }
            });
        });
        
        // Publish request through aggregator
        const request = {
            type: 'GET_ACTIVE_CONTRACTS',
            requestId: requestId,
            responseChannel: responseChannel,
            timestamp: Date.now()
        };
        console.log('[INSTRUMENTS API] Publishing request to aggregator:', request);
        await publisher.publish('aggregator:requests', JSON.stringify(request));
        
        // Wait for response
        const instruments = await responsePromise;
        
        // Return the instruments
        res.json(instruments);
    } catch (error) {
        console.error('Error fetching instruments:', error);
        res.status(500).json({ error: 'Failed to fetch instruments' });
    } finally {
        // Clean up Redis connections in finally block
        if (publisher) {
            try {
                await publisher.quit();
            } catch (e) {
                // Ignore cleanup errors
            }
        }
        if (subscriber) {
            try {
                await subscriber.quit();
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    }
});

// Get available accounts from aggregator
app.get('/api/accounts', async (req, res) => {
    let publisher = null;
    let subscriber = null;
    
    try {
        // Create Redis connections
        publisher = redis.createClient({ host: 'localhost', port: 6379 });
        subscriber = redis.createClient({ host: 'localhost', port: 6379 });
        
        await publisher.connect();
        await subscriber.connect();
        
        const requestId = `bot_${botId}_accounts_${Date.now()}`;
        const responseChannel = 'account-response';
        
        console.log('[ACCOUNTS API] Creating accounts request with ID:', requestId);
        
        // Set up promise to wait for response
        let promiseResolve, promiseReject;
        let timeout;
        let isResolved = false;
        
        const responsePromise = new Promise((resolve, reject) => {
            promiseResolve = resolve;
            promiseReject = reject;
            
            timeout = setTimeout(() => {
                console.log('[ACCOUNTS API] Request timed out');
                if (!isResolved) {
                    isResolved = true;
                    resolve([]); // Return empty array on timeout
                }
            }, 5000);
        });
        
        // Subscribe to response channel
        await subscriber.subscribe(responseChannel, async (message) => {
            try {
                const response = JSON.parse(message);
                console.log('[ACCOUNTS API] Received response from aggregator:', response);
                
                // Check if this response is for our request
                if (response.requestId === requestId && response.type === 'GET_ACCOUNTS') {
                    if (!isResolved) {
                        isResolved = true;
                        clearTimeout(timeout);
                        
                        const accounts = response.accounts || [];
                        console.log('[ACCOUNTS API] Extracted accounts:', accounts);
                        
                        // Unsubscribe after getting our response
                        try {
                            await subscriber.unsubscribe(responseChannel);
                        } catch (e) {
                            // Ignore unsubscribe errors
                        }
                        
                        promiseResolve(accounts);
                    }
                } else {
                    console.log('[ACCOUNTS API] Response is for different request or type:', response.requestId, response.type);
                }
            } catch (err) {
                console.error('[ACCOUNTS API] Error parsing response:', err);
                if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timeout);
                    promiseReject(err);
                }
            }
        });
        
        // Publish request through aggregator
        const request = {
            type: 'GET_ACCOUNTS',
            requestId: requestId,
            responseChannel: responseChannel,
            timestamp: Date.now()
        };
        console.log('[ACCOUNTS API] Publishing request to aggregator:', request);
        await publisher.publish('aggregator:requests', JSON.stringify(request));
        
        // Wait for response
        const accounts = await responsePromise;
        
        // Return the accounts
        res.json(accounts);
    } catch (error) {
        console.error('[ACCOUNTS API] Error fetching accounts:', error.message);
        console.error('[ACCOUNTS API] Full error:', error);
        res.status(500).json({ error: 'Failed to fetch accounts', details: error.message });
    } finally {
        // Clean up Redis connections in finally block
        if (publisher) {
            try {
                await publisher.quit();
            } catch (e) {
                // Ignore cleanup errors
            }
        }
        if (subscriber) {
            try {
                await subscriber.quit();
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    }
});

// Function to fetch TopStepX account statistics directly
async function fetchTopStepXStatistics(accountId) {
    try {
        console.log(`[TOPSTEP API] Fetching statistics for account ${accountId}...`);
        
        // Call TopStepX userapi directly for today's statistics
        const response = await axios.post('https://userapi.topstepx.com/Statistics/todaystats', {
            tradingAccountId: accountId  // Use correct parameter name
        }, {
            timeout: 15000,  // Match Connection Manager timeout
            headers: {
                'Content-Type': 'application/json'
                // Note: Missing authentication headers - this is likely why we get empty responses
            }
        });
        
        console.log(`[TOPSTEP API] Raw response:`, response.data);
        
        if (response.data && response.status === 200) {
            const stats = response.data;
            
            // Transform TopStepX statistics to match bot UI expectations
            const transformedMetrics = {
                totalTrades: stats.numberOfTrades || stats.totalTrades || 0,
                winRate: parseFloat(stats.winRate || ((stats.winningTrades || 0) / Math.max(stats.numberOfTrades || 1, 1) * 100)) || 0,
                totalPnL: parseFloat(stats.netPnL || stats.totalPnL || stats.realizedPnL || 0),
                profitFactor: parseFloat(stats.profitFactor || ((stats.grossProfit || 0) / Math.max(Math.abs(stats.grossLoss || 1), 1))) || 0,
                averageWin: parseFloat(stats.avgWinningTrade || stats.averageWin || 0),
                averageLoss: Math.abs(parseFloat(stats.avgLosingTrade || stats.averageLoss || 0)),
                drawdown: parseFloat(stats.maxDrawdown || stats.drawdown || 0),
                grossProfit: parseFloat(stats.grossProfit || 0),
                grossLoss: Math.abs(parseFloat(stats.grossLoss || 0)),
                winningTrades: parseInt(stats.winningTrades || 0),
                losingTrades: parseInt(stats.losingTrades || 0),
                largestWin: parseFloat(stats.largestWinningTrade || stats.largestWin || 0),
                largestLoss: Math.abs(parseFloat(stats.largestLosingTrade || stats.largestLoss || 0))
            };
            
            console.log(`[TOPSTEP API] ✅ Transformed metrics:`, transformedMetrics);
            
            return {
                success: true,
                metrics: transformedMetrics,
                source: 'topstepx-direct'
            };
        } else {
            throw new Error(`Invalid response from TopStepX API: ${response.status}`);
        }
        
    } catch (error) {
        console.error(`[TOPSTEP API] ❌ Error fetching statistics:`, error.message);
        
        // Return fallback empty metrics if API call fails
        return {
            success: false,
            error: error.message,
            metrics: {
                totalTrades: 0,
                winRate: 0,
                totalPnL: 0,
                profitFactor: 0,
                averageWin: 0,
                averageLoss: 0,
                drawdown: 0
            },
            source: 'fallback'
        };
    }
}

// Bot instance
let bot = null;
let pnlModule = null;
let botState = {
    status: 'initializing',  // Will change to 'connected' when server starts, 'trading' when trading starts
    connected: false,
    position: null,
    trades: [],
    strategy: null,  // Will be populated when config is loaded
    metrics: {
        totalTrades: 0,
        winRate: 0,
        totalPnL: 0,
        profitFactor: 0,
        averageWin: 0,
        averageLoss: 0,
        drawdown: 0
    }
};

// API Routes
app.get('/health', (req, res) => {
    res.json({
        botId,
        account,
        status: botState.status,
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

app.get('/status', async (req, res) => {
    try {
        // Get TopStepX account statistics directly
        const accountId = bot?.config?.accountId || '9627376';
        const topStepStats = await fetchTopStepXStatistics(accountId);
        
        // Merge TopStepX account statistics with bot state
        const enrichedState = {
            ...botState,
            metrics: topStepStats.metrics || botState.metrics
        };
        
        res.json(enrichedState);
    } catch (error) {
        console.error('Error fetching TopStepX statistics:', error);
        // Fallback to internal metrics if API call fails
        res.json(botState);
    }
});

// API endpoint for trade history
app.get('/api/trades', (req, res) => {
    res.json(botState.trades || []);
});

// API endpoint for statistics from TopStepX via aggregator -> connection manager
app.get('/api/statistics', async (req, res) => {
    let publisher = null;
    let subscriber = null;
    
    try {
        const { v4: uuidv4 } = require('uuid');
        
        // Create Redis clients
        publisher = redis.createClient({ host: 'localhost', port: 6379 });
        subscriber = redis.createClient({ host: 'localhost', port: 6379 });
        
        await publisher.connect();
        await subscriber.connect();
        
        const requestId = uuidv4();
        const responseChannel = `statistics:response:${requestId}`;
        
        // Set up response listener with timeout
        const responsePromise = new Promise((resolve, reject) => {
            let isResolved = false;
            
            const timeout = setTimeout(async () => {
                if (!isResolved) {
                    isResolved = true;
                    try {
                        await subscriber.unsubscribe(responseChannel);
                    } catch (e) {
                        // Ignore unsubscribe errors
                    }
                    reject(new Error('Timeout waiting for statistics'));
                }
            }, 10000); // 10 second timeout
            
            subscriber.subscribe(responseChannel, async (message) => {
                if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timeout);
                    try {
                        await subscriber.unsubscribe(responseChannel);
                    } catch (e) {
                        // Ignore unsubscribe errors
                    }
                    try {
                        const response = JSON.parse(message);
                        console.log('[STATISTICS API] Received response from aggregator:', response);
                        
                        if (response.success && response.statistics) {
                            resolve(response.statistics);
                        } else {
                            reject(new Error(response.error || 'Failed to fetch statistics'));
                        }
                    } catch (err) {
                        console.error('[STATISTICS API] Error parsing response:', err);
                        reject(err);
                    }
                }
            });
        });
        
        // Get accountId from bot config
        const accountId = bot?.config?.accountId || account || '9627376';
        
        // Publish request through aggregator to connection manager
        const request = {
            type: 'GET_STATISTICS',
            requestId: requestId,
            responseChannel: responseChannel,
            accountId: accountId,
            statisticsType: 'todaystats', // or 'daystats'
            timestamp: Date.now()
        };
        
        console.log('[STATISTICS API] Publishing request to aggregator:', request);
        await publisher.publish('aggregator:requests', JSON.stringify(request));
        
        // Wait for response
        const statistics = await responsePromise;
        
        // Transform statistics to match UI expectations
        const transformedStats = {
            totalTrades: statistics.totalTrades || statistics.numberOfTrades || 0,
            winRate: statistics.winRate || (statistics.winningTrades / Math.max(statistics.totalTrades, 1) * 100) || 0,
            totalPnL: statistics.totalPnL || statistics.netPnL || statistics.realizedPnL || 0,
            profitFactor: statistics.profitFactor || (statistics.grossProfit / Math.max(Math.abs(statistics.grossLoss), 1)) || 0,
            averageWin: statistics.averageWin || statistics.avgWinningTrade || 0,
            averageLoss: Math.abs(statistics.averageLoss || statistics.avgLosingTrade || 0),
            grossProfit: statistics.grossProfit || 0,
            grossLoss: statistics.grossLoss || 0,
            winningTrades: statistics.winningTrades || 0,
            losingTrades: statistics.losingTrades || 0,
            largestWin: statistics.largestWin || 0,
            largestLoss: statistics.largestLoss || 0
        };
        
        console.log('[STATISTICS API] Transformed statistics:', transformedStats);
        res.json(transformedStats);
        
    } catch (error) {
        console.error('Error fetching statistics:', error);
        res.status(500).json({ 
            error: 'Failed to fetch statistics', 
            details: error.message 
        });
    } finally {
        // Clean up Redis connections
        if (publisher) {
            try {
                await publisher.quit();
            } catch (e) {
                // Ignore cleanup errors
            }
        }
        if (subscriber) {
            try {
                await subscriber.quit();
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    }
});

// Alias for status (some UI components use /api/state)
app.get('/api/state', (req, res) => {
    // Sync current state from bot and strategy before returning
    if (bot && bot.state && bot.strategy) {
        // Update market data
        botState.marketData = {
            lastPrice: bot.state.lastPrice,
            lastVolume: bot.state.lastVolume,
            lastTimestamp: bot.state.lastTimestamp,
            bid: '--',
            ask: '--',
            volume: bot.state.lastVolume || '--'
        };
        
        // Update signal strength data from strategy if available
        if (bot.strategy && typeof bot.strategy.getSignalStrengthDisplay === 'function') {
            try {
                const signalData = bot.strategy.getSignalStrengthDisplay();
                
                // Add debug info for strategy readiness
                if (bot.strategy.getStrategyStatus && typeof bot.strategy.getStrategyStatus === 'function') {
                    const strategyStatus = bot.strategy.getStrategyStatus();
                    console.log('[STRATEGY DEBUG] Status:', JSON.stringify(strategyStatus, null, 2));
                } else if (bot.strategy.state) {
                    console.log('[STRATEGY DEBUG] Data Points:', bot.strategy.state.dataPointsCollected || 'unknown');
                    console.log('[STRATEGY DEBUG] RTH Points:', bot.strategy.state.rthDataPointsToday || 'unknown');
                    console.log('[STRATEGY DEBUG] PDH/PDL Valid:', bot.strategy.state.pdhPdlLevels?.validRthCalculation || 'unknown');
                }
                
                if (signalData && botState.strategy) {
                    botState.strategy.signalStrength = {
                        breakout: signalData.scores?.breakout ? parseInt(signalData.scores.breakout.split('/')[0]) : 0,
                        fade: signalData.scores?.fade ? parseInt(signalData.scores.fade.split('/')[0]) : 0,
                        sweep: signalData.scores?.liquiditySweep ? parseInt(signalData.scores.liquiditySweep.split('/')[0]) : 0,
                        overall: signalData.scores?.overall ? parseInt(signalData.scores.overall.split('/')[0]) : 0,
                        alerts: signalData.alerts || []
                    };
                }
            } catch (error) {
                console.log('[SIGNAL ERROR] Error getting signal strength:', error.message);
            }
        }
        
        // Sync position from strategy state
        if (bot.strategy.state && bot.strategy.state.currentPosition) {
            botState.position = {
                side: bot.strategy.state.currentPosition.toLowerCase(),
                quantity: 1,
                entryPrice: bot.state.lastPrice || 0,
                unrealizedPnL: 0
            };
            console.log(`[API STATE] Found strategy position: ${bot.strategy.state.currentPosition}`);
        } else {
            botState.position = null;
        }
        
        // Update status
        if (bot.state.status === 'RUNNING') {
            botState.status = 'trading';
        } else if (bot.state.status === 'READY') {
            botState.status = 'connected';
        }
        
        console.log(`[API STATE] Returning state:`, {
            status: botState.status,
            position: botState.position,
            hasBot: !!bot,
            hasStrategy: !!bot.strategy,
            strategyState: bot.strategy.state?.currentPosition
        });
    }
    
    res.json(botState);
});

// Initialize bot function
async function initializeBot() {
    if (!bot) {
        // Load config directly from the YAML file
        console.log(`Loading config from: ${configPath}`);
        const configContent = await fs.readFile(configPath, 'utf8');
        const config = yaml.load(configContent);
        
        // Update botState with strategy information
        if (config.strategy) {
            botState.strategy = {
                type: config.strategy.type,
                parameters: config.strategy.parameters || {}
            };
            console.log(`[CONFIG] Strategy loaded: ${config.strategy.type}`);
        }
        
        // Add the botId and account to the config
        config.botId = botId;
        config.account = account;
        
        // Create bot instance with the loaded configuration
        bot = new TradingBot(config);
        
        // Initialize P&L module for real-time P&L tracking from API
        console.log(`[P&L] Initializing P&L Module for ${account}...`);
        pnlModule = new PnLModule({
            refreshInterval: 30000, // Refresh every 30 seconds
            requestTimeout: 15000,
            enableDebugLogging: false
        });
        await pnlModule.initialize();
        console.log(`[P&L] ✅ P&L Module connected to live API system`);
        
        // Set up event listeners
        bot.on('status-change', (status) => {
            botState.status = status;
            io.emit('status', status);
            if (process.send) {
                process.send({ type: 'status', status });
            }
        });

        bot.on('trade', (trade) => {
            botState.trades.push(trade);
            botState.metrics.totalTrades++;
            updateMetrics();
            io.emit('trade', trade);
            if (process.send) {
                process.send({ type: 'trade', trade });
            }
        });

        bot.on('position-update', (position) => {
            botState.position = position;
            io.emit('position', position);
        });

        bot.on('error', (error) => {
            console.error(`Bot error:`, error);
            io.emit('error', error.message);
            if (process.send) {
                process.send({ type: 'error', error: error.message });
            }
        });
        
        await bot.initialize();
    }
}

// Bot control endpoints
app.post('/api/start', async (req, res) => {
    try {
        if (!bot) {
            // Initialize bot if not already done
            await initializeBot();
        }
        if (bot && bot.start) {
            await bot.start();
            botState.status = 'trading';  // Changed from 'running' to 'trading'
            res.json({ success: true, message: 'Bot started trading' });
        } else {
            res.status(400).json({ error: 'Bot not initialized' });
        }
    } catch (error) {
        console.error('Error starting bot:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/stop', async (req, res) => {
    try {
        if (bot && bot.stop) {
            await bot.stop();
            botState.status = 'connected';  // Changed from 'stopped' to 'connected' - server still running
            res.json({ success: true, message: 'Bot stopped trading' });
        } else {
            res.status(400).json({ error: 'Bot not running' });
        }
    } catch (error) {
        console.error('Error stopping bot:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/pause', async (req, res) => {
    try {
        if (bot && bot.pause) {
            bot.pause();
            botState.status = 'paused';  // Keep paused status
            res.json({ success: true, message: 'Bot paused' });
        } else {
            res.status(400).json({ error: 'Bot not running' });
        }
    } catch (error) {
        console.error('Error pausing bot:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/resume', async (req, res) => {
    try {
        if (bot && bot.resume) {
            bot.resume();
            botState.status = 'trading';  // Changed from 'running' to 'trading'
            res.json({ success: true, message: 'Bot resumed trading' });
        } else {
            res.status(400).json({ error: 'Bot not paused' });
        }
    } catch (error) {
        console.error('Error resuming bot:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/command', async (req, res) => {
    const { command, params } = req.body;
    
    try {
        switch (command) {
            case 'pause':
                if (bot) bot.pause();
                botState.status = 'paused';
                break;
            case 'resume':
                if (bot) bot.resume();
                botState.status = 'running';
                break;
            case 'stop':
                await gracefulShutdown();
                break;
            default:
                throw new Error(`Unknown command: ${command}`);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// WebSocket connection for real-time updates
io.on('connection', (socket) => {
    console.log(`Client connected to ${botId}`);
    socket.emit('state', botState);
    
    socket.on('disconnect', () => {
        console.log(`Client disconnected from ${botId}`);
    });
});

// Catch-all route handler for better error messages
app.use((req, res) => {
    console.error(`404 - Route not found: ${req.method} ${req.url}`);
    res.status(404).json({
        error: 'Route not found',
        path: req.url,
        method: req.method,
        availableRoutes: [
            'GET /',
            'GET /config.html',
            'GET /api/config',
            'POST /api/config',
            'GET /api/instruments',
            'GET /health',
            'GET /status',
            'GET /api/state',
            'POST /api/start',
            'POST /api/stop',
            'POST /api/pause',
            'POST /api/resume',
            'POST /command'
        ]
    });
});

// Initialize and start the bot
async function startBot() {
    try {
        // Load config directly from the YAML file
        console.log(`Loading config from: ${configPath}`);
        const configContent = await fs.readFile(configPath, 'utf8');
        console.log(`[STARTUP] Raw YAML content (first 200 chars):`, configContent.substring(0, 200));
        const config = yaml.load(configContent);
        console.log(`[STARTUP] Loaded config - instrument: ${config.instrument}, riskPerTrade: ${config.risk?.dollarRiskPerTrade}`);
        
        // Update botState with strategy information
        if (config.strategy) {
            botState.strategy = {
                type: config.strategy.type,
                parameters: config.strategy.parameters || {}
            };
            console.log(`[STARTUP] Strategy loaded: ${config.strategy.type}`);
        }
        
        // Add the botId and account to the config
        config.botId = botId;
        config.account = account;
        
        // Create bot instance with the loaded configuration
        bot = new TradingBot(config);

        // Initialize P&L module for real-time P&L tracking from API
        if (!pnlModule) {
            console.log(`[P&L] Initializing P&L Module for ${config.accountId}...`);
            pnlModule = new PnLModule({
                refreshInterval: 30000, // Refresh every 30 seconds
                requestTimeout: 15000,
                enableDebugLogging: false
            });
            await pnlModule.initialize();
            console.log(`[P&L] ✅ P&L Module connected to live API system`);
        }

        // Set up bot event listeners
        bot.on('started', (data) => {
            botState.status = 'trading';
            io.emit('status', 'trading');
            io.emit('state', botState);
            if (process.send) {
                process.send({ type: 'status', status: 'trading' });
            }
        });

        bot.on('stopped', (data) => {
            botState.status = 'connected';
            io.emit('status', 'connected');
            io.emit('state', botState);
            if (process.send) {
                process.send({ type: 'status', status: 'connected' });
            }
        });

        bot.on('trade', (trade) => {
            botState.trades.push(trade);
            botState.metrics.totalTrades++;
            updateMetrics();
            io.emit('trade', trade);
            io.emit('state', botState);
            if (process.send) {
                process.send({ type: 'trade', trade });
            }
        });

        bot.on('positionOpened', (data) => {
            console.log(`[POSITION OPENED] Recording entry for trade tracking:`, data);
            
            // Extract position data (could be from signal or fill)
            const position = data.position;
            
            botState.position = position;
            
            // Store entry data for trade calculation when position closes
            botState.currentTradeEntry = {
                side: position.side,
                entryPrice: position.openPrice || position.entryPrice,
                quantity: position.quantity || position.positionSize || 1,
                openTime: position.openTime || new Date().toISOString(),
                symbol: position.symbol || bot.config?.instrument || 'MGC'
            };
            
            console.log(`[POSITION OPENED] Stored entry data:`, botState.currentTradeEntry);
            
            io.emit('position', position);
            io.emit('state', botState);
        });

        bot.on('positionClosed', (data) => {
            console.log(`[POSITION CLOSED] Processing trade completion:`, data);
            
            // Create trade record from the closed position data
            if (data.position && botState.currentTradeEntry) {
                const position = data.position;
                
                const trade = {
                    timestamp: position.closeTime || new Date().toISOString(),
                    side: position.side.toUpperCase(),
                    quantity: position.quantity,
                    price: position.closePrice,
                    pnl: position.realizedPnL || 0,
                    entryPrice: position.openPrice,
                    exitPrice: position.closePrice,
                    symbol: position.symbol || 'MGC'
                };
                
                console.log(`[TRADE COMPLETED] Created trade record:`, trade);
                
                // Add to botState trades and update metrics
                botState.trades.push(trade);
                updateMetrics();
                
                // Clear current trade entry
                botState.currentTradeEntry = null;
                
                // Emit trade and updated state
                io.emit('trade', trade);
                io.emit('state', botState);
            } else if (botState.currentTradeEntry) {
                // Fallback: calculate from stored entry if position data incomplete
                console.log(`[TRADE COMPLETED] Using fallback calculation from entry data`);
                const multiplier = 10; // MGC: $10 per point
                const entryPrice = botState.currentTradeEntry.entryPrice;
                const exitPrice = bot.state.lastPrice;
                const quantity = botState.currentTradeEntry.quantity;
                
                // Calculate P&L using same formula as position display (includes $1.24 commission)
                let pnl = 0;
                if (botState.currentTradeEntry.side.toLowerCase() === 'long') {
                    pnl = ((exitPrice - entryPrice) * quantity * multiplier) - 1.24; // Subtract round-trip commission
                } else {
                    pnl = ((entryPrice - exitPrice) * quantity * multiplier) - 1.24; // Subtract round-trip commission
                }
                
                const trade = {
                    timestamp: new Date().toISOString(),
                    side: botState.currentTradeEntry.side.toUpperCase(),
                    quantity: quantity,
                    price: exitPrice,
                    pnl: pnl,
                    entryPrice: entryPrice,
                    exitPrice: exitPrice,
                    symbol: botState.currentTradeEntry.symbol
                };
                
                // Add to botState trades and update metrics
                botState.trades.push(trade);
                updateMetrics();
                
                // Clear current trade entry
                botState.currentTradeEntry = null;
                
                // Emit trade and updated state
                io.emit('trade', trade);
                io.emit('state', botState);
            }
            
            botState.position = null;
            io.emit('position', null);
        });

        bot.on('error', (error) => {
            console.error(`Bot error:`, error);
            io.emit('error', error.message);
            if (process.send) {
                process.send({ type: 'error', error: error.message });
            }
        });

        // Track previous position state for trade completion detection
        let previousPositionState = null;
        
        // Add periodic state updates to ensure UI stays synced
        setInterval(async () => {
            console.log(`[PERIODIC] Running periodic update at ${new Date().toISOString()}`);
            console.log(`[PERIODIC] Condition check - bot: ${!!bot}, bot.state: ${!!(bot && bot.state)}, bot.strategy: ${!!(bot && bot.strategy)}`);
            if (bot && bot.state && bot.strategy) {
                // Update botState with current market data from bot
                botState.marketData = {
                    lastPrice: bot.state.lastPrice,
                    lastVolume: bot.state.lastVolume,
                    lastTimestamp: bot.state.lastTimestamp,
                    bid: '--',
                    ask: '--',
                    volume: bot.state.lastVolume || '--'
                };
                
                // Get current strategy position state
                const currentStrategyPosition = bot.strategy.state?.currentPosition;
                
                // Update signal strength data from strategy if available
                if (bot.strategy && typeof bot.strategy.getSignalStrengthDisplay === 'function') {
                    try {
                        const signalData = bot.strategy.getSignalStrengthDisplay();
                        if (signalData && botState.strategy) {
                            botState.strategy.signalStrength = {
                                breakout: signalData.scores?.breakout ? parseInt(signalData.scores.breakout.split('/')[0]) : 0,
                                fade: signalData.scores?.fade ? parseInt(signalData.scores.fade.split('/')[0]) : 0,
                                sweep: signalData.scores?.liquiditySweep ? parseInt(signalData.scores.liquiditySweep.split('/')[0]) : 0,
                                overall: signalData.scores?.overall ? parseInt(signalData.scores.overall.split('/')[0]) : 0,
                                alerts: signalData.alerts || []
                            };
                        }
                    } catch (error) {
                        console.log('[SIGNAL ERROR]:', error.message);
                    }
                }
                
                // Sync position from strategy state - TEMPORARY: Always fetch position data for debugging
                if (currentStrategyPosition || true) { // TEMP: Always try to fetch position data
                    console.log(`[UI SYNC] Strategy has position: ${currentStrategyPosition}`);
                    
                    // Get entry price from stored position data or current price
                    let entryPrice = bot.state.lastPrice || 0;
                    if (botState.position && currentStrategyPosition && botState.position.side === currentStrategyPosition.toLowerCase()) {
                        // Keep existing entry price if same position
                        entryPrice = botState.position.entryPrice;
                    }
                    
                    // Get rich position data directly from Connection Manager via P&L module
                    let positionData = null;
                    let unrealizedPnL = 0;
                    let averagePrice = entryPrice;
                    let stopLoss = null;
                    let takeProfit = null;
                    let quantity = 1;
                    
                    try {
                        console.log(`[POSITION] 🔍 Bot Configuration Check:`, {
                            botConfigAccountId: bot.config.accountId,
                            botConfigAccount: bot.config.account, 
                            botId: bot.config.botId,
                            instrument: bot.config.instrument,
                            configKeys: Object.keys(bot.config)
                        });
                        
                        const accountId = bot.config.accountId || bot.config.account || '9627376';
                        console.log(`[POSITION] Requesting full position data from API for account ${accountId}...`);
                        
                        // Request account P&L which includes position details
                        const accountPnL = await pnlModule.getAccountPnL(accountId);
                        unrealizedPnL = accountPnL.dailyPnL || 0;
                        
                        // Enhanced debugging - log the complete API response structure
                        console.log(`[POSITION] 🔍 Complete API Response Structure:`, {
                            hasPositions: !!(accountPnL.positions),
                            positionsLength: accountPnL.positions?.length || 0,
                            accountPnLKeys: Object.keys(accountPnL),
                            fullResponse: JSON.stringify(accountPnL, null, 2)
                        });
                        
                        // If we have position data in the response, extract rich fields
                        if (accountPnL.positions && accountPnL.positions.length > 0) {
                            console.log(`[POSITION] 🔍 Found ${accountPnL.positions.length} positions in API response:`);
                            
                            // Log all positions for debugging
                            accountPnL.positions.forEach((pos, index) => {
                                console.log(`[POSITION] Position ${index + 1}:`, {
                                    instrument: pos.instrument,
                                    contractId: pos.contractId,
                                    symbol: pos.symbol,
                                    side: pos.side,
                                    positionSize: pos.positionSize,
                                    averagePrice: pos.averagePrice,
                                    stopLoss: pos.stopLoss,
                                    takeProfit: pos.takeProfit,
                                    profitAndLoss: pos.profitAndLoss,
                                    allFields: Object.keys(pos)
                                });
                            });
                            
                            // Try multiple matching strategies to find MGC position
                            let position = null;
                            
                            // Strategy 1: Match by instrument containing MGC
                            position = accountPnL.positions.find(pos => 
                                pos.instrument && pos.instrument.includes('MGC')
                            );
                            
                            if (!position) {
                                // Strategy 2: Match by contractId containing MGC
                                position = accountPnL.positions.find(pos => 
                                    pos.contractId && pos.contractId.includes('MGC')
                                );
                            }
                            
                            if (!position) {
                                // Strategy 3: Match by symbol
                                position = accountPnL.positions.find(pos => 
                                    pos.symbol === 'MGC'
                                );
                            }
                            
                            if (!position) {
                                // Strategy 4: Take first position with non-zero size
                                position = accountPnL.positions.find(pos => 
                                    pos.positionSize && Math.abs(pos.positionSize) > 0
                                );
                            }
                            
                            console.log(`[POSITION] 🎯 Position matching result:`, {
                                foundPosition: !!position,
                                matchedBy: position ? 'Found via matching logic' : 'No position found',
                                positionId: position?.id || 'N/A'
                            });
                            
                            if (position) {
                                positionData = position;
                                averagePrice = position.averagePrice || position.avgPrice || entryPrice;
                                stopLoss = position.stopLoss;
                                takeProfit = position.takeProfit;
                                quantity = Math.abs(position.positionSize || position.quantity || 1);
                                unrealizedPnL = position.profitAndLoss || position.unrealizedPnL || unrealizedPnL;
                                
                                console.log(`[POSITION] ✅ Extracted rich position data:`, {
                                    averagePrice, stopLoss, takeProfit, quantity, unrealizedPnL,
                                    rawAveragePrice: position.averagePrice,
                                    rawAvgPrice: position.avgPrice,
                                    rawStopLoss: position.stopLoss,
                                    rawTakeProfit: position.takeProfit,
                                    rawPositionSize: position.positionSize,
                                    rawProfitAndLoss: position.profitAndLoss
                                });
                            } else {
                                console.log(`[POSITION] ❌ No MGC position found in ${accountPnL.positions.length} positions`);
                            }
                        } else {
                            console.log(`[POSITION] ❌ No positions array in API response`);
                        }
                        
                        console.log(`[POSITION] ✅ API Position Data - Entry: $${averagePrice}, SL: ${stopLoss ? '$' + stopLoss : 'None'}, TP: ${takeProfit ? '$' + takeProfit : 'None'}, P&L: $${unrealizedPnL}`);
                    } catch (error) {
                        console.error(`[POSITION] ❌ API position request failed: ${error.message}`);
                        console.error(`[POSITION] ❌ Using fallback values - position data will be limited`);
                        averagePrice = entryPrice;
                        unrealizedPnL = 0;
                        stopLoss = null;
                        takeProfit = null;
                    }
                    
                    if (currentStrategyPosition && currentStrategyPosition !== 'NONE') {
                        // Only create position object if there's an actual position
                        botState.position = {
                            side: currentStrategyPosition.toLowerCase(),
                            quantity: quantity,
                            entryPrice: averagePrice,
                            unrealizedPnL: unrealizedPnL,
                            // Add rich userapi fields for UI
                            averagePrice: averagePrice,
                            profitAndLoss: unrealizedPnL,
                            stopLoss: stopLoss,
                            takeProfit: takeProfit,
                            // Keep original field names for compatibility
                            positionSize: quantity,
                            instrument: bot.config?.instrument || 'MGC'
                        };
                        console.log(`[UI SYNC] Updated botState.position:`, botState.position);
                    } else {
                        // No position - set to null
                        botState.position = null;
                        console.log(`[UI SYNC] No position - set botState.position to null`);
                    }
                } else {
                    // No position - check if we just closed a position
                    if (previousPositionState && botState.position) {
                        console.log(`[TRADE COMPLETED] Position closed - creating trade record`);
                        
                        // Get realized P&L from API for completed trade
                        const currentPrice = bot.state.lastPrice;
                        const entryPrice = botState.position.entryPrice;
                        const side = botState.position.side.toUpperCase();
                        const quantity = botState.position.quantity;
                        
                        let realizedPnL = 0;
                        try {
                            console.log(`[P&L] Getting final trade P&L from API for completed ${side} position...`);
                            const accountPnL = await pnlModule.getAccountPnL(bot.config.accountId);
                            
                            // For completed trades, use the daily P&L change
                            // In a real implementation, you'd want to track P&L before/after the trade
                            realizedPnL = accountPnL.dailyPnL || 0;
                            console.log(`[P&L] ✅ Trade completed - API P&L: $${realizedPnL}`);
                        } catch (error) {
                            console.error(`[P&L] ❌ API P&L request failed for completed trade: ${error.message}`);
                            // Fallback to manual calculation
                            const multiplier = 10; // MGC: $10 per point
                            if (side === 'LONG') {
                                realizedPnL = ((currentPrice - entryPrice) * quantity * multiplier) - 1.24;
                            } else {
                                realizedPnL = ((entryPrice - currentPrice) * quantity * multiplier) - 1.24;
                            }
                            console.log(`[P&L] 📊 Using fallback manual calculation for trade: $${realizedPnL}`);
                        }
                        
                        // Create trade record
                        const trade = {
                            timestamp: new Date().toISOString(),
                            side: side,
                            quantity: quantity,
                            price: currentPrice,
                            pnl: realizedPnL,
                            entryPrice: entryPrice,
                            exitPrice: currentPrice,
                            symbol: 'MGC'
                        };
                        
                        console.log(`[TRADE COMPLETED] Created trade record:`, trade);
                        
                        // Add to botState trades and update metrics
                        botState.trades.push(trade);
                        updateMetrics();
                        
                        // Emit trade and updated state
                        io.emit('trade', trade);
                        io.emit('state', botState);
                    }
                    
                    botState.position = null;
                }
                
                // Update previous position state for next iteration
                previousPositionState = currentStrategyPosition;
                
                // Update bot status based on actual bot state
                if (bot.state.status === 'RUNNING' && botState.status !== 'trading') {
                    botState.status = 'trading';
                } else if (bot.state.status === 'READY' && botState.status !== 'connected') {
                    botState.status = 'connected';
                }
                
                // Emit state update to all connected clients
                io.emit('state', botState);
                io.emit('marketData', botState.marketData);
                io.emit('position', botState.position);
                io.emit('status', botState.status);
            } else {
                console.log(`[PERIODIC] Condition failed - skipping position data retrieval`);
            }
        }, 1000); // Update every second

        // Initialize the bot
        console.log(`Initializing ${botId}...`);
        await bot.initialize();
        
        // Get the port from bot configuration
        const port = bot.config.port || 3004;
        
        // Start the web server
        server.listen(port, () => {
            console.log(`${botId} server running on port ${port}`);
            console.log(`Config UI available at: http://localhost:${port}/config.html`);
            console.log(`Dashboard available at: http://localhost:${port}/`);
            botState.status = 'connected';  // Changed from 'ready' to 'connected'
            if (process.send) {
                process.send({ type: 'status', status: 'connected', port });  // Changed from 'running' to 'connected'
            }
        });

        // Don't automatically start trading - wait for user to click start
        console.log(`${botId} server ready. Waiting for user to start trading...`);
        botState.status = 'connected';
        
    } catch (error) {
        console.error(`Failed to start ${botId}:`, error);
        botState.status = 'error';
        botState.error = error.message;
        if (process.send) {
            process.send({ type: 'error', error: error.message });
        }
        process.exit(1);
    }
}

// Update bot metrics
function updateMetrics() {
    const trades = botState.trades;
    const totalTrades = trades.length;
    
    // Reset metrics
    botState.metrics = {
        totalTrades: totalTrades,
        winRate: 0,
        totalPnL: 0,
        profitFactor: 0,
        averageWin: 0,
        averageLoss: 0,
        drawdown: 0
    };
    
    if (totalTrades > 0) {
        const winningTrades = trades.filter(t => t.pnl > 0);
        const losingTrades = trades.filter(t => t.pnl < 0);
        
        const totalPnL = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
        const winRate = (winningTrades.length / totalTrades) * 100;
        
        // Calculate average win/loss
        const averageWin = winningTrades.length > 0 ? 
            winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length : 0;
        const averageLoss = losingTrades.length > 0 ? 
            Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0) / losingTrades.length) : 0;
        
        // Calculate profit factor (gross profit / gross loss)
        const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
        const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));
        const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
        
        // Update metrics
        botState.metrics.totalTrades = totalTrades;
        botState.metrics.winRate = winRate;
        botState.metrics.totalPnL = totalPnL;
        botState.metrics.profitFactor = profitFactor;
        botState.metrics.averageWin = averageWin;
        botState.metrics.averageLoss = averageLoss;
        
        console.log(`[METRICS UPDATE] Calculated:`, botState.metrics);
    }
    
    io.emit('metrics', botState.metrics);
    io.emit('state', botState);
}

// Handle IPC messages from parent process
process.on('message', async (msg) => {
    if (msg.type === 'shutdown') {
        await gracefulShutdown();
    } else if (msg.type === 'status-request') {
        if (process.send) {
            process.send({ 
                type: 'status', 
                status: botState.status,
                port: server.address()?.port
            });
        }
    }
});

// Graceful shutdown
async function gracefulShutdown() {
    console.log(`Shutting down ${botId}...`);
    botState.status = 'stopping';
    
    try {
        if (bot) {
            await bot.stop();
        }
        
        if (pnlModule) {
            console.log(`[P&L] Disconnecting P&L module...`);
            await pnlModule.disconnect();
        }
        
        io.close();
        server.close();
        
        console.log(`${botId} shut down successfully`);
        process.exit(0);
    } catch (error) {
        console.error(`Error during shutdown:`, error);
        process.exit(1);
    }
}

// Handle process signals
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error(`Uncaught exception in ${botId}:`, error);
    console.error('Stack trace:', error.stack);
    // Don't immediately shutdown on uncaught exceptions - try to recover
    if (error.code === 'ENOENT' || error.message.includes('ENOENT')) {
        console.error('File not found error - check file paths');
    } else {
        gracefulShutdown();
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`Unhandled rejection in ${botId}:`, reason);
    if (reason instanceof Error) {
        console.error('Stack trace:', reason.stack);
    }
    // Don't immediately shutdown on unhandled rejections - try to recover
});

// Start the bot
startBot();