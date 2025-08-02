/**
 * Bot Launcher - Entry point for individual bot instances
 * This script is spawned as a separate process for each bot
 */

const TradingBot = require('./TradingBot');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const yaml = require('js-yaml');
const fs = require('fs').promises;
const fsSync = require('fs');
const redis = require('redis');

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

// Bot instance
let bot = null;
let botState = {
    status: 'initializing',  // Will change to 'connected' when server starts, 'trading' when trading starts
    connected: false,
    position: null,
    trades: [],
    metrics: {
        totalTrades: 0,
        winRate: 0,
        pnl: 0,
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

app.get('/status', (req, res) => {
    res.json(botState);
});

// Alias for status (some UI components use /api/state)
app.get('/api/state', (req, res) => {
    res.json(botState);
});

// Initialize bot function
async function initializeBot() {
    if (!bot) {
        // Load config directly from the YAML file
        console.log(`Loading config from: ${configPath}`);
        const configContent = await fs.readFile(configPath, 'utf8');
        const config = yaml.load(configContent);
        
        // Add the botId and account to the config
        config.botId = botId;
        config.account = account;
        
        // Create bot instance with the loaded configuration
        bot = new TradingBot(config);
        
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
        
        // Add the botId and account to the config
        config.botId = botId;
        config.account = account;
        
        // Create bot instance with the loaded configuration
        bot = new TradingBot(config);

        // Set up bot event listeners
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
    const wins = botState.trades.filter(t => t.pnl > 0).length;
    const losses = botState.trades.filter(t => t.pnl < 0).length;
    
    if (botState.trades.length > 0) {
        botState.metrics.winRate = (wins / botState.trades.length) * 100;
        botState.metrics.pnl = botState.trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    }
    
    io.emit('metrics', botState.metrics);
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