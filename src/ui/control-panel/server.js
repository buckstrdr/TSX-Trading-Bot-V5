// TSX Trading Bot V5 - Control Panel Server
// Manages all services including trading bots, configuration UI, and core services

const express = require('express');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const yaml = require('js-yaml');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.CONTROL_PANEL_PORT || 8080;

// Base paths
const V5_BASE = path.join(__dirname, '..', '..', '..');
const CONFIG_PATH = path.join(V5_BASE, 'config');
const BOTS_CONFIG_PATH = path.join(CONFIG_PATH, 'bots');

// Track system state
let systemState = {
    status: 'stopped', // 'stopped', 'starting', 'running', 'stopping'
    services: {
        // Core services
        redis: false,
        connectionManager: false,
        tradingAggregator: false,
        
        // V5 services
        configurationUI: false,
        manualTrading: false,
        
        // Trading bots
        bots: {
            BOT_1: false,
            BOT_2: false,
            BOT_3: false,
            BOT_4: false,
            BOT_5: false,
            BOT_6: false
        },
        
        // Placeholder for future
        simulation: false
    },
    // Safety switch for demo-only mode
    demoOnlyMode: true, // Default to safe mode - only allow practice accounts
    lastAction: null,
    lastError: null,
    startTime: null,
    logs: []
};

// Bot configurations cache
let botConfigs = {};

// Service operation tracking
let serviceOperationInProgress = false;

// Middleware
app.use(express.json());

// CORS headers for API routes
app.use('/api/*', (req, res, next) => {
    res.header('Content-Type', 'application/json');
    res.header('Cache-Control', 'no-cache');
    next();
});

// Logging function
function log(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, message, type };
    systemState.logs.push(logEntry);
    
    // Keep only last 100 logs
    if (systemState.logs.length > 100) {
        systemState.logs.shift();
    }
    
    // Emit to connected clients
    io.emit('log', logEntry);
    
    console.log(`[${timestamp}] ${message}`);
}

// Load bot configurations
async function loadBotConfigs() {
    try {
        const botIds = ['BOT_1', 'BOT_2', 'BOT_3', 'BOT_4', 'BOT_5', 'BOT_6'];
        for (const botId of botIds) {
            const configPath = path.join(BOTS_CONFIG_PATH, `${botId}.yaml`);
            try {
                const content = await fs.promises.readFile(configPath, 'utf8');
                botConfigs[botId] = yaml.load(content);
            } catch (error) {
                log(`Failed to load config for ${botId}: ${error.message}`, 'warn');
                botConfigs[botId] = { enabled: false, port: 3003 + parseInt(botId.split('_')[1]) };
            }
        }
    } catch (error) {
        log(`Failed to load bot configurations: ${error.message}`, 'error');
    }
}

// Execute command with proper Windows handling
function executeCommand(command, description, stdio = 'pipe', ignoreErrors = false) {
    return new Promise((resolve, reject) => {
        log(`Executing: ${description}`, 'info');
        
        // For batch files, use spawn for better compatibility
        if (command.endsWith('.bat')) {
            const batPath = path.join(V5_BASE, command);
            const isStartOperation = description.toLowerCase().includes('start');
            
            const child = spawn('cmd.exe', ['/c', batPath], {
                cwd: V5_BASE,
                stdio: isStartOperation ? 'ignore' : ['ignore', 'pipe', 'pipe'],
                shell: false,
                detached: isStartOperation
            });
            
            let stdout = '';
            let stderr = '';
            
            if (!isStartOperation) {
                child.stdout.on('data', (data) => {
                    stdout += data.toString();
                });
                
                child.stderr.on('data', (data) => {
                    stderr += data.toString();
                });
            }
            
            child.on('close', (code) => {
                log(`${description} process closed with code ${code}`, 'info');
                
                const isNonFatalExitCode = (isStartOperation && code === 1) || 
                                         (description.toLowerCase().includes('stop') && code !== 0);
                
                if (code !== 0 && !ignoreErrors && !isNonFatalExitCode) {
                    log(`${description} error: Exit code ${code}`, 'error');
                    reject(new Error(`Command failed with exit code ${code}`));
                    return;
                }
                
                log(`${description} completed successfully`, 'success');
                resolve(stdout || 'completed');
            });
            
            child.on('error', (error) => {
                log(`${description} spawn error: ${error.message}`, 'error');
                reject(error);
            });
            
            if (isStartOperation) {
                child.unref();
                log(`${description} launched in background`, 'success');
                resolve('started');
            }
            
        } else {
            // For non-batch commands, use exec
            exec(command, { 
                cwd: V5_BASE,
                shell: true
            }, (error, stdout, stderr) => {
                if (error && !ignoreErrors) {
                    reject(error);
                    return;
                }
                resolve(stdout || 'completed');
            });
        }
    });
}

// Check if a process is running on a port
async function isPortInUse(port) {
    try {
        const result = await new Promise((resolve, reject) => {
            exec(`netstat -ano | findstr :${port} 2>nul`, { 
                shell: 'cmd.exe'
            }, (error, stdout) => {
                if (error || !stdout) {
                    resolve(false);
                } else {
                    resolve(stdout.includes('LISTENING'));
                }
            });
        });
        return result;
    } catch (error) {
        return false;
    }
}

// Check health endpoint
async function checkHealth(url) {
    return new Promise((resolve) => {
        try {
            const urlParts = new URL(url);
            const options = {
                hostname: urlParts.hostname,
                port: urlParts.port,
                path: urlParts.pathname,
                method: 'GET',
                timeout: 3000
            };

            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200 || res.statusCode === 206) {
                        resolve(true);
                    } else {
                        resolve(false);
                    }
                });
            });

            req.on('error', () => resolve(false));
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });

            req.end();
        } catch (e) {
            resolve(false);
        }
    });
}

// Start all services
async function startAll() {
    if (systemState.status === 'running' || systemState.status === 'starting') {
        throw new Error('System is already running or starting');
    }
    
    systemState.status = 'starting';
    systemState.lastAction = 'start';
    systemState.lastError = null;
    io.emit('statusUpdate', systemState);
    
    try {
        // Execute the V5 start-all.bat
        log('Starting all V5 services...', 'info');
        await executeCommand('scripts\\control\\start-all.bat', 'Start All V5 Services');
        
        systemState.status = 'running';
        systemState.startTime = new Date();
        
        // Check status after services start
        setTimeout(async () => {
            await checkServiceStatus();
            log('All services started! 🚀', 'success');
        }, 5000);
        
    } catch (error) {
        systemState.status = 'stopped';
        systemState.lastError = error.message;
        log(`Failed to start all services: ${error.message}`, 'error');
        throw error;
    } finally {
        io.emit('statusUpdate', systemState);
    }
}

// Stop all services
async function stopAll() {
    if (systemState.status === 'stopped' || systemState.status === 'stopping') {
        throw new Error('System is already stopped or stopping');
    }
    
    systemState.status = 'stopping';
    systemState.lastAction = 'stop';
    systemState.lastError = null;
    io.emit('statusUpdate', systemState);
    
    try {
        log('Stopping all V5 services...', 'info');
        await executeCommand('scripts\\control\\stop-all.bat', 'Stop All V5 Services', 'ignore', true);
        
        systemState.status = 'stopped';
        systemState.startTime = null;
        
        setTimeout(async () => {
            await checkServiceStatus();
            log('All services stopped! 🛑', 'success');
        }, 3000);
        
    } catch (error) {
        log(`Warning during stop: ${error.message}`, 'warn');
        systemState.status = 'stopped';
        systemState.startTime = null;
    } finally {
        io.emit('statusUpdate', systemState);
    }
}

// Start individual service
async function startService(serviceName, options = {}) {
    if (serviceOperationInProgress) {
        log('Another service operation is in progress, please wait...', 'warn');
        return;
    }
    
    serviceOperationInProgress = true;
    log(`Starting ${serviceName}...`, 'info');
    
    try {
        let command;
        
        // Map service names to start commands
        switch(serviceName) {
            case 'redis':
                command = 'scripts\\services\\start-redis.bat';
                break;
            case 'fakeApiServer':
                command = 'scripts\\services\\start-fake-api.bat';
                break;
            case 'connectionManager':
                // Write configuration file for Connection Manager
                if (options.microOnly !== undefined) {
                    const configPath = path.join(V5_BASE, 'connection-manager', 'runtime-config.json');
                    const config = {
                        microOnly: options.microOnly,
                        timestamp: new Date().toISOString()
                    };
                    await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
                    log(`Connection Manager configuration written: microOnly=${options.microOnly}`, 'info');
                }
                command = 'scripts\\services\\start-connection-manager.bat';
                break;
            case 'configurationUI':
                command = 'scripts\\services\\start-config-ui.bat';
                break;
            case 'manualTrading':
                command = 'scripts\\services\\start-manual-trading.bat';
                break;
            case 'tradingAggregator':
                command = 'scripts\\services\\start-aggregator.bat';
                break;
            case 'simulation':
                log('Simulation service not yet implemented', 'warn');
                return;
            default:
                // Check if it's a bot
                if (serviceName.startsWith('BOT_')) {
                    // For now, just start the bot server
                    command = `scripts\\bots\\start-bot-${serviceName.split('_')[1]}.bat`;
                } else {
                    throw new Error(`Unknown service: ${serviceName}`);
                }
        }
        
        await executeCommand(command, `Start ${serviceName}`);
        log(`${serviceName} started`, 'success');
        
        setTimeout(async () => {
            await checkServiceStatus();
        }, 3000);
        
    } catch (error) {
        log(`Failed to start ${serviceName}: ${error.message}`, 'error');
        throw error;
    } finally {
        serviceOperationInProgress = false;
    }
}

// Stop individual service
async function stopService(serviceName) {
    if (serviceOperationInProgress) {
        log('Another service operation is in progress, please wait...', 'warn');
        return;
    }
    
    serviceOperationInProgress = true;
    log(`Stopping ${serviceName}...`, 'info');
    
    try {
        let command;
        
        // Map service names to stop commands
        switch(serviceName) {
            case 'redis':
                command = 'scripts\\services\\stop-redis.bat';
                break;
            case 'fakeApiServer':
                command = 'scripts\\services\\stop-fake-api.bat';
                break;
            case 'connectionManager':
                command = 'scripts\\services\\stop-connection-manager.bat';
                // Clean up runtime configuration file
                const configPath = path.join(V5_BASE, 'connection-manager', 'runtime-config.json');
                try {
                    await fs.promises.unlink(configPath);
                    log('Connection Manager runtime configuration cleaned up', 'info');
                } catch (err) {
                    // File might not exist, which is fine
                }
                break;
            case 'configurationUI':
                command = 'scripts\\services\\stop-config-ui.bat';
                break;
            case 'manualTrading':
                command = 'scripts\\services\\stop-manual-trading.bat';
                break;
            case 'tradingAggregator':
                command = 'scripts\\services\\stop-aggregator.bat';
                break;
            case 'simulation':
                log('Simulation service not yet implemented', 'warn');
                return;
            default:
                // Check if it's a bot
                if (serviceName.startsWith('BOT_')) {
                    command = `scripts\\bots\\stop-bot-${serviceName.split('_')[1]}.bat`;
                } else {
                    throw new Error(`Unknown service: ${serviceName}`);
                }
        }
        
        await executeCommand(command, `Stop ${serviceName}`, 'ignore', true);
        log(`${serviceName} stopped`, 'success');
        
        setTimeout(async () => {
            await checkServiceStatus();
        }, 3000);
        
    } catch (error) {
        log(`Error stopping ${serviceName}: ${error.message}`, 'warn');
    } finally {
        serviceOperationInProgress = false;
    }
}

// Check service status
async function checkServiceStatus() {
    try {
        log('Checking service status...', 'debug');
        
        // Check Redis
        const redisRunning = await new Promise((resolve) => {
            exec('"C:\\Program Files\\Redis\\redis-cli" ping 2>nul', (error, stdout) => {
                resolve(!error && stdout.trim() === 'PONG');
            });
        });
        systemState.services.redis = redisRunning;
        
        // Check Connection Manager (original port 7500)
        systemState.services.connectionManager = await checkHealth('http://localhost:7500/health');
        
        // Check Trading Aggregator (port 7600)
        systemState.services.tradingAggregator = await checkHealth('http://localhost:7600/health');
        
        // Check Configuration UI (port 3000)
        systemState.services.configurationUI = await isPortInUse(3000);
        
        // Check Manual Trading (port 3003)
        systemState.services.manualTrading = await isPortInUse(3003);
        
        // Check Trading Bots (ports 3004-3009)
        for (let i = 1; i <= 6; i++) {
            const botId = `BOT_${i}`;
            const port = 3003 + i;
            const config = botConfigs[botId];
            
            // Always check if bot server is running regardless of enabled state
            const isRunning = await isPortInUse(port);
            
            // Try to get bot status if server is running
            if (isRunning) {
                try {
                    // Get detailed status from bot
                    const statusData = await new Promise((resolve) => {
                        const options = {
                            hostname: 'localhost',
                            port: port,
                            path: '/status',
                            method: 'GET',
                            timeout: 2000
                        };
                        
                        const req = http.request(options, (res) => {
                            let data = '';
                            res.on('data', (chunk) => data += chunk);
                            res.on('end', () => {
                                if (res.statusCode === 200) {
                                    try {
                                        const parsed = JSON.parse(data);
                                        resolve(parsed);
                                    } catch (e) {
                                        resolve(null);
                                    }
                                } else {
                                    resolve(null);
                                }
                            });
                        });
                        
                        req.on('error', () => resolve(null));
                        req.on('timeout', () => {
                            req.destroy();
                            resolve(null);
                        });
                        req.end();
                    });
                    
                    if (statusData && statusData.status) {
                        systemState.services.bots[botId] = {
                            running: true,
                            status: statusData.status,
                            port: port
                        };
                    } else {
                        systemState.services.bots[botId] = { running: true, status: 'connected', port };
                    }
                } catch (error) {
                    // If we can't get status, just mark as connected
                    systemState.services.bots[botId] = { running: true, status: 'connected', port };
                }
            } else {
                systemState.services.bots[botId] = { running: false, status: 'stopped', port };
            }
        }
        
        // Update overall status
        const anyServiceRunning = Object.values(systemState.services).some(service => {
            if (typeof service === 'object') {
                return Object.values(service).some(s => s);
            }
            return service;
        });
        
        const allCoreRunning = systemState.services.redis && 
                              systemState.services.connectionManager;
        
        if (systemState.status !== 'starting' && systemState.status !== 'stopping') {
            if (allCoreRunning) {
                systemState.status = 'running';
            } else if (anyServiceRunning) {
                systemState.status = 'partial';
            } else {
                systemState.status = 'stopped';
            }
        }
        
        io.emit('statusUpdate', systemState);
    } catch (error) {
        log(`Error checking service status: ${error.message}`, 'error');
    }
}

// API Routes
app.get('/api/status', (req, res) => {
    res.json(systemState);
});

app.get('/api/status/check', async (req, res) => {
    try {
        await checkServiceStatus();
        res.json(systemState);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/start', async (req, res) => {
    try {
        await startAll();
        res.json({ success: true, message: 'All services started successfully' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/stop', async (req, res) => {
    try {
        await stopAll();
        res.json({ success: true, message: 'All services stopped successfully' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/service/:name/start', async (req, res) => {
    try {
        const { name } = req.params;
        const options = req.body || {};
        await startService(name, options);
        res.json({ success: true, message: `${name} started successfully` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/service/:name/stop', async (req, res) => {
    try {
        const { name } = req.params;
        await stopService(name);
        res.json({ success: true, message: `${name} stopped successfully` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Bot open endpoint - starts bot server and opens UI in Chrome
app.post('/api/bot/:botId/open', async (req, res) => {
    try {
        const { botId } = req.params;
        const botNumber = botId.split('_')[1];
        const botPort = 3003 + parseInt(botNumber);
        
        // First check if bot is already running
        const isRunning = await isPortInUse(botPort);
        
        if (!isRunning) {
            // Start the bot service if not running
            log(`Starting ${botId} server before opening UI...`, 'info');
            await startService(botId);
            
            // Wait a bit for the server to start
            await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
            log(`${botId} server already running on port ${botPort}`, 'info');
        }
        
        // Now open Chrome with the bot UI
        const chromeCommand = `start chrome --new-window --user-data-dir="%TEMP%\\chrome-bot-${botNumber}" http://localhost:${botPort}`;
        
        exec(chromeCommand, { shell: 'cmd.exe' }, (error) => {
            if (error) {
                log(`Failed to open Chrome for ${botId}: ${error.message}`, 'warn');
            } else {
                log(`Opened Chrome for ${botId} on port ${botPort}`, 'success');
            }
        });
        
        res.json({ success: true, message: `${botId} opened successfully` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Bot close endpoint - stops bot server
app.post('/api/bot/:botId/close', async (req, res) => {
    try {
        const { botId } = req.params;
        const botNumber = botId.split('_')[1];
        const botPort = 3003 + parseInt(botNumber);
        
        log(`Closing ${botId} on port ${botPort}...`, 'info');
        
        // First try to stop using the normal service stop
        try {
            await stopService(botId);
        } catch (e) {
            log(`Normal stop failed, trying port-based kill...`, 'warn');
        }
        
        // Also kill by port to ensure it's stopped
        await new Promise((resolve, reject) => {
            // Find and kill process by port
            exec(`netstat -ano | findstr :${botPort}`, (error, stdout, stderr) => {
                if (error || !stdout) {
                    log(`No process found on port ${botPort}`, 'info');
                    resolve();
                    return;
                }
                
                // Extract PIDs from netstat output
                const lines = stdout.split('\n');
                const pids = new Set();
                
                lines.forEach(line => {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length > 4 && parts[1].includes(`:${botPort}`)) {
                        const pid = parts[parts.length - 1];
                        if (pid && !isNaN(pid) && pid !== '0') {
                            pids.add(pid);
                        }
                    }
                });
                
                if (pids.size === 0) {
                    log(`No PIDs found for port ${botPort}`, 'info');
                    resolve();
                    return;
                }
                
                // Kill each PID
                const pidArray = Array.from(pids);
                log(`Killing PIDs for ${botId}: ${pidArray.join(', ')}`, 'info');
                
                pidArray.forEach(pid => {
                    exec(`taskkill /F /PID ${pid}`, (killError) => {
                        if (!killError) {
                            log(`Killed process ${pid} for ${botId}`, 'success');
                        }
                    });
                });
                
                setTimeout(resolve, 1000); // Give it a second to clean up
            });
        });
        
        // Update service state
        systemState.services.bots[botId] = false;
        io.emit('statusUpdate', systemState);
        
        res.json({ success: true, message: `${botId} closed successfully` });
    } catch (error) {
        log(`Failed to close ${botId}: ${error.message}`, 'error');
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/logs', (req, res) => {
    res.json(systemState.logs);
});

app.get('/api/bots/config', (req, res) => {
    res.json(botConfigs);
});

// Demo-only mode API endpoints
app.get('/api/demo-mode', (req, res) => {
    res.json({ demoOnlyMode: systemState.demoOnlyMode });
});

app.post('/api/demo-mode', (req, res) => {
    try {
        const { demoOnlyMode } = req.body;
        
        if (typeof demoOnlyMode !== 'boolean') {
            return res.status(400).json({ success: false, error: 'demoOnlyMode must be a boolean' });
        }
        
        const previousMode = systemState.demoOnlyMode;
        systemState.demoOnlyMode = demoOnlyMode;
        
        const modeText = demoOnlyMode ? 'Demo Only Mode (Practice accounts only)' : 'Live Trading Mode (All accounts allowed)';
        log(`${previousMode !== demoOnlyMode ? 'Switched to' : 'Confirmed'} ${modeText}`, 'info');
        
        // Broadcast update to connected clients
        io.emit('statusUpdate', systemState);
        
        res.json({ 
            success: true, 
            demoOnlyMode, 
            message: `Trading mode set to: ${modeText}`
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Shutdown endpoint - stops all services and exits the control panel
app.post('/api/shutdown', async (req, res) => {
    try {
        log('Shutdown requested - stopping all services...', 'info');
        
        // First stop all services
        await stopAll();
        
        // Send response before shutting down
        res.json({ success: true, message: 'Control Panel shutting down...' });
        
        // Execute the stop batch file to ensure config server also stops
        const stopBatchPath = path.join(V5_BASE, 'STOP-CONTROL-PANEL.bat');
        exec(`"${stopBatchPath}"`, (error) => {
            if (error) {
                log(`Error executing stop batch: ${error.message}`, 'error');
            }
        });
        
        // Give time for response to be sent and batch to execute
        setTimeout(() => {
            log('Control Panel shutting down. Goodbye!', 'info');
            process.exit(0);
        }, 2000);
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// WebSocket connection
io.on('connection', (socket) => {
    log('Web client connected', 'info');
    
    socket.emit('statusUpdate', systemState);
    socket.emit('logs', systemState.logs);
    socket.emit('botConfigs', botConfigs);
    
    checkServiceStatus().catch(error => {
        log(`Status check error: ${error.message}`, 'error');
    });
    
    socket.on('disconnect', () => {
        log('Web client disconnected', 'info');
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        uptime: process.uptime(),
        systemState: systemState.status 
    });
});

// Catch-all for API routes
app.all('/api/*', (req, res) => {
    res.status(404).json({ 
        error: 'API endpoint not found',
        path: req.path,
        method: req.method
    });
});

// Parse JSON body
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Serve V5 UI shared assets
app.use('/src/ui/shared', express.static(path.join(__dirname, '..', 'shared')));

// Periodic status check
setInterval(async () => {
    if (systemState.status === 'starting' || systemState.status === 'stopping' || 
        systemState.status === 'running' || systemState.status === 'partial') {
        await checkServiceStatus();
    }
}, 5000);

// Start the server
server.listen(PORT, async () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║           TSX Trading Bot V5 Control Panel                ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║   Web Interface: http://localhost:${PORT}                    ║
║                                                           ║
║   Features:                                               ║
║   • Start/Stop all services with one click               ║
║   • Individual bot management (BOT_1 to BOT_6)           ║
║   • Configuration UI management                          ║
║   • Real-time status monitoring                          ║
║   • Service health indicators                            ║
║   • Live log streaming                                   ║
║                                                           ║
║   Services:                                              ║
║   • Redis (Cache & Messaging)                            ║
║   • Connection Manager (TopStep API)                     ║
║   • Configuration UI (Bot Settings)                      ║
║   • Manual Trading (Port 3003)                           ║
║   • Trading Bots 1-6 (Ports 3004-3009)                  ║
║   • Simulation (Coming Soon)                             ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
    `);
    
    log(`Control Panel V5 started on port ${PORT}`, 'success');
    
    // Load bot configurations
    await loadBotConfigs();
    log('Bot configurations loaded', 'info');
});

// Graceful shutdown
process.on('SIGINT', async () => {
    log('Shutting down Control Panel...', 'info');
    
    if (systemState.status === 'running') {
        log('Stopping all services before exit...', 'info');
        await stopAll();
    }
    
    process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    log(`Uncaught exception: ${error.message}`, 'error');
    console.error(error);
});

process.on('unhandledRejection', (reason, promise) => {
    log(`Unhandled rejection: ${reason}`, 'error');
    console.error(reason);
});