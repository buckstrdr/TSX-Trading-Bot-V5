/**
 * MonitoringServer - HTTP and WebSocket server for aggregator monitoring
 * Provides REST endpoints and real-time WebSocket streaming
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const winston = require('winston');
const path = require('path');
const fs = require('fs');

class MonitoringServer {
    constructor(config = {}) {
        this.config = {
            port: config.port || 7700,
            host: config.host || 'localhost',
            corsOrigins: config.corsOrigins || ['http://localhost:3001', 'http://localhost:3000', 'http://localhost:8080'],
            wsHeartbeatInterval: config.wsHeartbeatInterval || 30000,
            enableLogging: config.enableLogging !== false,
            logFile: config.logFile || 'aggregator.log'
        };
        
        this.app = express();
        this.server = null;
        this.wss = null;
        this.metricsCollector = null;
        this.aggregator = null;
        this.logger = null;
        
        // WebSocket client tracking
        this.wsClients = new Map();
        this.clientIdCounter = 0;
        
        // Initialize components
        this.initializeLogger();
        this.setupMiddleware();
        this.setupRoutes();
        this.setupWebSocket();
    }
    
    /**
     * Initialize Winston logger for aggregator-specific logging
     */
    initializeLogger() {
        const logDir = path.join(__dirname, '../../../../logs');
        
        // Create logs directory if it doesn't exist
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        
        this.logger = winston.createLogger({
            level: 'info',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            ),
            transports: [
                // File transport for aggregator-specific logs
                new winston.transports.File({
                    filename: path.join(logDir, this.config.logFile),
                    maxsize: 10485760, // 10MB
                    maxFiles: 5
                }),
                // Console transport for development
                new winston.transports.Console({
                    format: winston.format.combine(
                        winston.format.colorize(),
                        winston.format.simple()
                    )
                })
            ]
        });
        
        this.logger.info('Monitoring server logger initialized', {
            logFile: this.config.logFile,
            logDir
        });
    }
    
    /**
     * Setup Express middleware
     */
    setupMiddleware() {
        // CORS
        this.app.use(cors({
            origin: this.config.corsOrigins,
            credentials: true
        }));
        
        // JSON parsing
        this.app.use(express.json());
        
        // Request logging
        this.app.use((req, res, next) => {
            const start = Date.now();
            
            res.on('finish', () => {
                this.logger.info('HTTP Request', {
                    method: req.method,
                    url: req.url,
                    status: res.statusCode,
                    duration: Date.now() - start,
                    ip: req.ip
                });
            });
            
            next();
        });
        
        // Error handling
        this.app.use((err, req, res, next) => {
            this.logger.error('HTTP Error', {
                error: err.message,
                stack: err.stack,
                url: req.url,
                method: req.method
            });
            
            res.status(500).json({
                error: 'Internal server error',
                message: err.message
            });
        });
    }
    
    /**
     * Setup REST API routes
     */
    setupRoutes() {
        // Health check with comprehensive status
        this.app.get('/health', (req, res) => {
            const health = {
                status: 'healthy',
                uptime: process.uptime(),
                timestamp: new Date().toISOString(),
                aggregator: null,
                components: {},
                checks: []
            };
            
            // Check aggregator status
            if (this.aggregator) {
                health.aggregator = {
                    status: this.aggregator.state.status,
                    shadowMode: this.aggregator.config.shadowMode,
                    ordersActive: this.aggregator.state.orders.size,
                    positionsOpen: this.aggregator.state.positions.size
                };
                
                // Component health checks
                health.components = {
                    riskManager: this.aggregator.riskManager ? 'healthy' : 'unavailable',
                    queueManager: this.aggregator.queueManager ? 'healthy' : 'unavailable',
                    sltpCalculator: this.aggregator.sltpCalculator ? 'healthy' : 'unavailable',
                    metricsCollector: this.metricsCollector ? 'healthy' : 'unavailable',
                    redis: this.aggregator.redisAdapter ? 'connected' : 'disconnected',
                    connectionManager: this.aggregator.connectionManagerAdapter ? 'connected' : 'disconnected'
                };
                
                // Perform health checks
                const checks = [];
                
                // Check queue depth
                if (this.aggregator.queueManager) {
                    const queueDepth = this.aggregator.queueManager.getTotalQueueSize();
                    checks.push({
                        name: 'queue_depth',
                        status: queueDepth < 100 ? 'healthy' : 'warning',
                        value: queueDepth,
                        threshold: 100
                    });
                }
                
                // Check memory usage
                const memUsage = process.memoryUsage();
                const memUsageMB = memUsage.heapUsed / 1024 / 1024;
                checks.push({
                    name: 'memory_usage',
                    status: memUsageMB < 500 ? 'healthy' : 'warning',
                    value: memUsageMB.toFixed(2),
                    threshold: 500,
                    unit: 'MB'
                });
                
                // Check risk violations
                if (this.metricsCollector) {
                    const snapshot = this.metricsCollector.getSnapshot();
                    const violationRate = snapshot.timeWindows.oneMinute.orders > 0
                        ? snapshot.timeWindows.oneMinute.violations / snapshot.timeWindows.oneMinute.orders
                        : 0;
                    
                    checks.push({
                        name: 'risk_violation_rate',
                        status: violationRate < 0.1 ? 'healthy' : 'critical',
                        value: (violationRate * 100).toFixed(2),
                        threshold: 10,
                        unit: '%'
                    });
                }
                
                health.checks = checks;
                
                // Overall health status
                const hasWarning = checks.some(c => c.status === 'warning');
                const hasCritical = checks.some(c => c.status === 'critical');
                
                if (hasCritical) {
                    health.status = 'critical';
                } else if (hasWarning) {
                    health.status = 'warning';
                }
            }
            
            res.json(health);
        });
        
        // Main metrics endpoint
        this.app.get('/api/metrics', (req, res) => {
            if (!this.metricsCollector) {
                return res.status(503).json({ error: 'Metrics collector not initialized' });
            }
            
            const snapshot = this.metricsCollector.getSnapshot();
            const aggregatorMetrics = this.aggregator ? this.aggregator.getMetrics() : null;
            
            res.json({
                timestamp: snapshot.timestamp,
                monitoring: snapshot.metrics,
                aggregator: aggregatorMetrics,
                timeWindows: snapshot.timeWindows,
                system: {
                    uptime: process.uptime(),
                    memory: process.memoryUsage(),
                    cpu: process.cpuUsage()
                }
            });
        });
        
        // Historical metrics
        this.app.get('/api/metrics/history', (req, res) => {
            if (!this.metricsCollector) {
                return res.status(503).json({ error: 'Metrics collector not initialized' });
            }
            
            const history = this.metricsCollector.getHistory();
            res.json(history);
        });
        
        // Specific metric categories
        this.app.get('/api/metrics/orders', (req, res) => {
            if (!this.metricsCollector) {
                return res.status(503).json({ error: 'Metrics collector not initialized' });
            }
            
            const snapshot = this.metricsCollector.getSnapshot();
            res.json({
                timestamp: snapshot.timestamp,
                orders: snapshot.metrics.orders,
                timeWindows: {
                    oneMinute: snapshot.timeWindows.oneMinute.orders,
                    fiveMinutes: snapshot.timeWindows.fiveMinutes.orders,
                    oneHour: snapshot.timeWindows.oneHour.orders
                }
            });
        });
        
        this.app.get('/api/metrics/risk', (req, res) => {
            if (!this.metricsCollector) {
                return res.status(503).json({ error: 'Metrics collector not initialized' });
            }
            
            const snapshot = this.metricsCollector.getSnapshot();
            const riskReport = this.aggregator ? this.aggregator.riskManager.getRiskReport() : null;
            
            res.json({
                timestamp: snapshot.timestamp,
                monitoring: snapshot.metrics.risk,
                riskManager: riskReport
            });
        });
        
        this.app.get('/api/metrics/queue', (req, res) => {
            if (!this.metricsCollector) {
                return res.status(503).json({ error: 'Metrics collector not initialized' });
            }
            
            const snapshot = this.metricsCollector.getSnapshot();
            const queueMetrics = this.aggregator ? this.aggregator.queueManager.getMetrics() : null;
            
            res.json({
                timestamp: snapshot.timestamp,
                monitoring: snapshot.metrics.queue,
                queueManager: queueMetrics
            });
        });
        
        this.app.get('/api/metrics/sltp', (req, res) => {
            if (!this.metricsCollector) {
                return res.status(503).json({ error: 'Metrics collector not initialized' });
            }
            
            const snapshot = this.metricsCollector.getSnapshot();
            const sltpStats = this.aggregator ? this.aggregator.sltpCalculator.getStatistics() : null;
            
            res.json({
                timestamp: snapshot.timestamp,
                monitoring: snapshot.metrics.sltp,
                calculator: sltpStats
            });
        });
        
        // System logs endpoint
        this.app.get('/api/logs', (req, res) => {
            const limit = parseInt(req.query.limit) || 100;
            const level = req.query.level || 'info';
            
            // In production, this would query the log storage
            // For now, return a message
            res.json({
                message: 'Log retrieval endpoint',
                config: {
                    limit,
                    level,
                    logFile: this.config.logFile
                }
            });
        });
        
        // Control endpoints
        this.app.post('/api/control/reset-metrics', (req, res) => {
            if (this.metricsCollector) {
                this.metricsCollector.reset();
                this.logger.info('Metrics reset via API');
                res.json({ success: true, message: 'Metrics reset' });
            } else {
                res.status(503).json({ error: 'Metrics collector not initialized' });
            }
        });
        
        // WebSocket info endpoint
        this.app.get('/api/websocket/info', (req, res) => {
            res.json({
                url: `ws://${this.config.host}:${this.config.port}`,
                clients: this.wsClients.size,
                subscriptions: Array.from(this.wsClients.values()).map(client => ({
                    id: client.id,
                    subscriptions: Array.from(client.subscriptions),
                    connected: client.readyState === WebSocket.OPEN
                }))
            });
        });
    }
    
    /**
     * Setup WebSocket server for real-time metrics streaming
     */
    setupWebSocket() {
        this.server = http.createServer(this.app);
        this.wss = new WebSocket.Server({ server: this.server });
        
        this.wss.on('connection', (ws, req) => {
            const clientId = ++this.clientIdCounter;
            const client = {
                id: clientId,
                ws,
                subscriptions: new Set(['all']), // Default subscription
                lastPing: Date.now()
            };
            
            this.wsClients.set(clientId, client);
            
            this.logger.info('WebSocket client connected', {
                clientId,
                ip: req.socket.remoteAddress,
                totalClients: this.wsClients.size
            });
            
            // Send welcome message
            this.sendToClient(client, {
                type: 'welcome',
                clientId,
                timestamp: Date.now()
            });
            
            // Setup message handler
            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    this.handleWebSocketMessage(client, message);
                } catch (error) {
                    this.logger.error('WebSocket message error', {
                        clientId,
                        error: error.message
                    });
                }
            });
            
            // Setup close handler
            ws.on('close', () => {
                this.wsClients.delete(clientId);
                this.logger.info('WebSocket client disconnected', {
                    clientId,
                    totalClients: this.wsClients.size
                });
            });
            
            // Setup error handler
            ws.on('error', (error) => {
                this.logger.error('WebSocket error', {
                    clientId,
                    error: error.message
                });
            });
            
            // Setup ping/pong
            ws.on('pong', () => {
                client.lastPing = Date.now();
            });
        });
        
        // Start heartbeat interval
        this.startWebSocketHeartbeat();
    }
    
    /**
     * Handle WebSocket messages from clients
     */
    handleWebSocketMessage(client, message) {
        switch (message.type) {
            case 'subscribe':
                if (message.channels && Array.isArray(message.channels)) {
                    message.channels.forEach(channel => {
                        client.subscriptions.add(channel);
                    });
                    
                    this.sendToClient(client, {
                        type: 'subscribed',
                        channels: message.channels
                    });
                    
                    this.logger.info('WebSocket client subscribed', {
                        clientId: client.id,
                        channels: message.channels
                    });
                }
                break;
                
            case 'unsubscribe':
                if (message.channels && Array.isArray(message.channels)) {
                    message.channels.forEach(channel => {
                        client.subscriptions.delete(channel);
                    });
                    
                    this.sendToClient(client, {
                        type: 'unsubscribed',
                        channels: message.channels
                    });
                }
                break;
                
            case 'ping':
                this.sendToClient(client, {
                    type: 'pong',
                    timestamp: Date.now()
                });
                break;
                
            default:
                this.logger.warn('Unknown WebSocket message type', {
                    clientId: client.id,
                    type: message.type
                });
        }
    }
    
    /**
     * Send message to specific client
     */
    sendToClient(client, data) {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(data));
        }
    }
    
    /**
     * Broadcast to all subscribed clients
     */
    broadcast(channel, data) {
        const message = {
            type: 'metrics',
            channel,
            data,
            timestamp: Date.now()
        };
        
        let sent = 0;
        this.wsClients.forEach(client => {
            if (client.subscriptions.has(channel) || client.subscriptions.has('all')) {
                if (client.ws.readyState === WebSocket.OPEN) {
                    client.ws.send(JSON.stringify(message));
                    sent++;
                }
            }
        });
        
        if (sent > 0) {
            this.metricsCollector?.updateConnectionStatus('websocket', 'connected');
            if (this.metricsCollector?.metrics?.connections?.websocket) {
                this.metricsCollector.metrics.connections.websocket.messagesOut++;
            }
        }
    }
    
    /**
     * Start WebSocket heartbeat
     */
    startWebSocketHeartbeat() {
        setInterval(() => {
            this.wsClients.forEach((client, id) => {
                if (client.ws.readyState === WebSocket.OPEN) {
                    // Check if client is alive
                    if (Date.now() - client.lastPing > this.config.wsHeartbeatInterval * 2) {
                        this.logger.warn('WebSocket client timeout', { clientId: id });
                        client.ws.terminate();
                        this.wsClients.delete(id);
                    } else {
                        client.ws.ping();
                    }
                }
            });
            
            // Update WebSocket client count
            if (this.metricsCollector) {
                this.metricsCollector.metrics.connections.websocket.clients = this.wsClients.size;
            }
        }, this.config.wsHeartbeatInterval);
    }
    
    /**
     * Attach aggregator and metrics collector
     */
    attachAggregator(aggregator, metricsCollector) {
        this.aggregator = aggregator;
        this.metricsCollector = metricsCollector;
        
        // Subscribe to metrics collector events
        metricsCollector.on('metrics', (metrics) => {
            this.broadcast('metrics', metrics);
        });
        
        metricsCollector.on('orderReceived', (data) => {
            this.broadcast('orders', data);
        });
        
        metricsCollector.on('orderProcessed', (data) => {
            this.broadcast('orders', data);
        });
        
        metricsCollector.on('orderRejected', (data) => {
            this.broadcast('orders', data);
        });
        
        metricsCollector.on('riskViolation', (data) => {
            this.broadcast('risk', data);
        });
        
        metricsCollector.on('sltpCalculated', (data) => {
            this.broadcast('sltp', data);
        });
        
        // Subscribe to aggregator events
        aggregator.on('metrics', (metrics) => {
            this.broadcast('aggregator', metrics);
        });
        
        this.logger.info('Attached aggregator and metrics collector');
    }
    
    /**
     * Start the monitoring server
     */
    async start() {
        return new Promise((resolve) => {
            this.server.listen(this.config.port, this.config.host, () => {
                this.logger.info('Monitoring server started', {
                    host: this.config.host,
                    port: this.config.port,
                    endpoints: [
                        `http://${this.config.host}:${this.config.port}/health`,
                        `http://${this.config.host}:${this.config.port}/api/metrics`,
                        `ws://${this.config.host}:${this.config.port}`
                    ]
                });
                resolve();
            });
        });
    }
    
    /**
     * Stop the monitoring server
     */
    async stop() {
        // Close WebSocket connections
        this.wsClients.forEach(client => {
            client.ws.close();
        });
        
        // Close WebSocket server
        if (this.wss) {
            this.wss.close();
        }
        
        // Close HTTP server
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    this.logger.info('Monitoring server stopped');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }
}

module.exports = MonitoringServer;