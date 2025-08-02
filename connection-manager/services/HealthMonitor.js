// connection-manager/services/HealthMonitor.js
// Monitors the health of all connection manager components

const EventEmitter = require('events');

class HealthMonitor extends EventEmitter {
    constructor(connectionManager) {
        super();
        
        this.connectionManager = connectionManager;
        this.checkInterval = null;
        this.healthCheckIntervalMs = 30000; // 30 seconds
        
        this.health = {
            overall: 'UNKNOWN',
            lastCheck: null,
            components: {
                authentication: { status: 'UNKNOWN', lastCheck: null },
                marketData: { status: 'UNKNOWN', lastCheck: null },
                eventBroadcaster: { status: 'UNKNOWN', lastCheck: null },
                botTracker: { status: 'UNKNOWN', lastCheck: null }
            },
            alerts: []
        };
        
        console.log('🏥 Health Monitor initialized');
    }
    
    start() {
        console.log('🏥 Starting health monitoring...');
        
        // Run initial health check
        this.performHealthCheck();
        
        // Schedule periodic health checks
        this.checkInterval = setInterval(() => {
            this.performHealthCheck();
        }, this.healthCheckIntervalMs);
    }
    
    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        console.log('🏥 Health monitoring stopped');
    }
    
    async performHealthCheck() {
        const checkTime = Date.now();
        this.health.lastCheck = checkTime;
        
        // Clear previous alerts
        this.health.alerts = [];
        
        // Check authentication
        this.checkAuthentication();
        
        // Check market data service
        this.checkMarketData();
        
        // Check event broadcaster
        this.checkEventBroadcaster();
        
        // Check bot tracker
        this.checkBotTracker();
        
        // Determine overall health
        this.determineOverallHealth();
        
        // Emit health status
        this.emit('healthCheck', this.getHealth());
    }
    
    checkAuthentication() {
        try {
            const auth = this.connectionManager.authModule;
            if (!auth) {
                this.updateComponentHealth('authentication', 'ERROR', 'Auth module not initialized');
                return;
            }
            
            const tokenInfo = auth.getTokenInfo();
            const detailedStatus = auth.getDetailedStatus ? auth.getDetailedStatus() : auth.getStatus();
            
            if (tokenInfo.isValid) {
                this.updateComponentHealth('authentication', 'HEALTHY', {
                    hasToken: true,
                    timeUntilExpiry: tokenInfo.timeUntilExpiry,
                    autoRefreshEnabled: detailedStatus.autoRefreshEnabled,
                    refreshScheduled: detailedStatus.refreshScheduled,
                    nextRefreshAt: detailedStatus.nextRefreshAt
                });
            } else if (detailedStatus.refreshInProgress) {
                this.updateComponentHealth('authentication', 'WARNING', {
                    message: 'Token refresh in progress',
                    hasToken: detailedStatus.hasToken,
                    autoRefreshEnabled: detailedStatus.autoRefreshEnabled
                });
            } else {
                this.updateComponentHealth('authentication', 'WARNING', 'Token expired or invalid');
            }
            
        } catch (error) {
            this.updateComponentHealth('authentication', 'ERROR', error.message);
        }
    }
    
    checkMarketData() {
        try {
            const marketData = this.connectionManager.marketDataService;
            if (!marketData) {
                this.updateComponentHealth('marketData', 'ERROR', 'Market data service not initialized');
                return;
            }
            
            const health = marketData.isHealthy();
            if (health.connected && health.receivingData) {
                this.updateComponentHealth('marketData', 'HEALTHY', {
                    metrics: health.metrics
                });
            } else if (health.connected && !health.receivingData) {
                this.updateComponentHealth('marketData', 'WARNING', 'Connected but no recent data');
            } else {
                this.updateComponentHealth('marketData', 'ERROR', 'Not connected');
            }
            
        } catch (error) {
            this.updateComponentHealth('marketData', 'ERROR', error.message);
        }
    }
    
    checkEventBroadcaster() {
        try {
            const broadcaster = this.connectionManager.eventBroadcaster;
            if (!broadcaster) {
                this.updateComponentHealth('eventBroadcaster', 'ERROR', 'Event broadcaster not initialized');
                return;
            }
            
            const stats = broadcaster.getChannelStats();
            if (stats.connected) {
                this.updateComponentHealth('eventBroadcaster', 'HEALTHY', stats);
            } else {
                this.updateComponentHealth('eventBroadcaster', 'ERROR', 'Not connected to Redis');
            }
            
        } catch (error) {
            this.updateComponentHealth('eventBroadcaster', 'ERROR', error.message);
        }
    }
    
    checkBotTracker() {
        try {
            const instanceRegistry = this.connectionManager.instanceRegistry;
            if (!instanceRegistry) {
                this.updateComponentHealth('botTracker', 'ERROR', 'Instance registry not initialized');
                return;
            }
            
            const status = {
                connectedBots: instanceRegistry.getActiveCount ? instanceRegistry.getActiveCount() : 0,
                totalBots: 6,
                summary: instanceRegistry.getAllBotStatuses ? instanceRegistry.getAllBotStatuses() : {}
            };
            this.updateComponentHealth('botTracker', 'HEALTHY', status);
            
        } catch (error) {
            this.updateComponentHealth('botTracker', 'ERROR', error.message);
        }
    }
    
    updateComponentHealth(component, status, details) {
        this.health.components[component] = {
            status,
            lastCheck: Date.now(),
            details: typeof details === 'string' ? { message: details } : details
        };
        
        // Add alert if not healthy
        if (status === 'ERROR' || status === 'WARNING') {
            this.health.alerts.push({
                component,
                status,
                message: typeof details === 'string' ? details : 'Component not healthy',
                timestamp: Date.now()
            });
        }
    }
    
    determineOverallHealth() {
        const components = Object.values(this.health.components);
        const hasError = components.some(c => c.status === 'ERROR');
        const hasWarning = components.some(c => c.status === 'WARNING');
        
        if (hasError) {
            this.health.overall = 'ERROR';
        } else if (hasWarning) {
            this.health.overall = 'WARNING';
        } else if (components.every(c => c.status === 'HEALTHY')) {
            this.health.overall = 'HEALTHY';
        } else {
            this.health.overall = 'UNKNOWN';
        }
    }
    
    getHealth() {
        return {
            ...this.health,
            uptime: this.connectionManager.isRunning ? 
                Date.now() - this.connectionManager.startTime : 0,
            timestamp: Date.now()
        };
    }
    
    getComponentHealth(component) {
        return this.health.components[component] || null;
    }
    
    isHealthy() {
        return this.health.overall === 'HEALTHY';
    }
    
    getAlerts() {
        return this.health.alerts;
    }
}

module.exports = HealthMonitor;