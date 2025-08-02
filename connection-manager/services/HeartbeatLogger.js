// connection-manager/services/HeartbeatLogger.js
// Aggregates frequent events and logs periodic summaries to reduce log spam

class HeartbeatLogger {
    constructor(name, intervalMs = 30000) {
        this.name = name;
        this.intervalMs = intervalMs;
        
        // Metrics tracking
        this.metrics = {
            events: new Map(), // eventType -> count
            contracts: new Set(), // active contracts receiving data
            errors: [],
            warnings: [],
            lastActivity: null,
            startTime: Date.now(),
            systemHealth: {
                connected: false,
                latency: null,
                memoryUsage: null,
                cpuUsage: null
            }
        };
        
        // Heartbeat timer
        this.timer = null;
        this.isRunning = false;
        
        console.log(`❤️ HeartbeatLogger initialized for ${this.name} (${intervalMs}ms interval)`);
    }
    
    /**
     * Log an event for aggregation (non-blocking)
     * @param {string} eventType - Type of event (e.g., 'QUOTE', 'TRADE', 'PUBLISH')
     * @param {string} contract - Contract or channel identifier (optional)
     * @param {object} metadata - Additional metadata (optional)
     */
    logEvent(eventType, contract = null, metadata = {}) {
        try {
            // Increment event counter
            const currentCount = this.metrics.events.get(eventType) || 0;
            this.metrics.events.set(eventType, currentCount + 1);
            
            // Track active contracts
            if (contract) {
                this.metrics.contracts.add(contract);
            }
            
            // Update last activity
            this.metrics.lastActivity = Date.now();
            
        } catch (error) {
            // Fail silently to not impact performance
            console.error(`❌ HeartbeatLogger.logEvent failed: ${error.message}`);
        }
    }
    
    /**
     * Log an error immediately (bypass aggregation)
     * @param {string|Error} error - Error message or Error object
     * @param {object} context - Additional context
     */
    logError(error, context = {}) {
        const errorMsg = error instanceof Error ? error.message : error;
        const timestamp = new Date().toISOString();
        
        // Log immediately
        console.error(`❌ [${this.name}] ${errorMsg}`, context);
        
        // Track for heartbeat summary
        this.metrics.errors.push({
            message: errorMsg,
            timestamp,
            context
        });
        
        // Keep only last 10 errors to prevent memory growth
        if (this.metrics.errors.length > 10) {
            this.metrics.errors = this.metrics.errors.slice(-10);
        }
    }
    
    /**
     * Log a warning immediately (bypass aggregation)
     * @param {string} warning - Warning message
     * @param {object} context - Additional context
     */
    logWarning(warning, context = {}) {
        const timestamp = new Date().toISOString();
        
        // Log immediately
        console.warn(`⚠️ [${this.name}] ${warning}`, context);
        
        // Track for heartbeat summary
        this.metrics.warnings.push({
            message: warning,
            timestamp,
            context
        });
        
        // Keep only last 10 warnings to prevent memory growth
        if (this.metrics.warnings.length > 10) {
            this.metrics.warnings = this.metrics.warnings.slice(-10);
        }
    }
    
    /**
     * Update system health metrics
     * @param {object} healthData - Health metrics
     */
    updateSystemHealth(healthData = {}) {
        this.metrics.systemHealth = {
            ...this.metrics.systemHealth,
            ...healthData,
            lastUpdate: Date.now()
        };
    }
    
    /**
     * Start periodic heartbeat logging
     */
    start() {
        if (this.isRunning) {
            console.log(`⚠️ HeartbeatLogger for ${this.name} is already running`);
            return;
        }
        
        this.isRunning = true;
        this.timer = setInterval(() => {
            this.logHeartbeat();
        }, this.intervalMs);
        
        console.log(`✅ HeartbeatLogger started for ${this.name}`);
    }
    
    /**
     * Stop periodic heartbeat logging
     */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        
        this.isRunning = false;
        console.log(`🛑 HeartbeatLogger stopped for ${this.name}`);
        
        // Log final summary
        this.logHeartbeat();
    }
    
    /**
     * Generate and log heartbeat summary
     */
    logHeartbeat() {
        try {
            const now = Date.now();
            const windowSeconds = Math.floor(this.intervalMs / 1000);
            const uptimeSeconds = Math.floor((now - this.metrics.startTime) / 1000);
            
            // Generate summary
            const eventSummary = Array.from(this.metrics.events.entries())
                .map(([type, count]) => `${count} ${type.toLowerCase()}`)
                .join(' | ');
            
            const contractList = Array.from(this.metrics.contracts);
            const contractSummary = contractList.length > 0 
                ? `${contractList.slice(0, 5).join(', ')}${contractList.length > 5 ? ` (+${contractList.length - 5} more)` : ''} (${contractList.length} total)`
                : 'None';
            
            const healthStatus = this.metrics.systemHealth.connected ? '✅ Connected' : '❌ Disconnected';
            const latencyInfo = this.metrics.systemHealth.latency ? ` | ⚡ ${this.metrics.systemHealth.latency}ms avg` : '';
            
            const recentErrors = this.metrics.errors.filter(e => 
                now - new Date(e.timestamp).getTime() < this.intervalMs
            ).length;
            
            const recentWarnings = this.metrics.warnings.filter(w => 
                now - new Date(w.timestamp).getTime() < this.intervalMs
            ).length;
            
            const memoryInfo = this.metrics.systemHealth.memoryUsage 
                ? ` | 📋 ${Math.round(this.metrics.systemHealth.memoryUsage / 1024 / 1024)}MB`
                : '';
            
            const cpuInfo = this.metrics.systemHealth.cpuUsage
                ? ` | 🔄 ${Math.round(this.metrics.systemHealth.cpuUsage)}%`
                : '';
            
            // Log heartbeat summary
            console.log(`❤️ HEARTBEAT - ${this.name} (${windowSeconds}s window, ${uptimeSeconds}s uptime)`);
            if (eventSummary) {
                console.log(`  📊 Events: ${eventSummary}`);
            }
            console.log(`  📈 Active Contracts: ${contractSummary}`);
            console.log(`  🔗 System Health: ${healthStatus}${latencyInfo}${memoryInfo}${cpuInfo}`);
            console.log(`  ⚠️ Issues: ${recentWarnings} warnings | ${recentErrors} errors`);
            
            // Reset counters for next window
            this.resetCounters();
            
        } catch (error) {
            console.error(`❌ Failed to log heartbeat for ${this.name}:`, error.message);
        }
    }
    
    /**
     * Reset event counters for next window
     */
    resetCounters() {
        this.metrics.events.clear();
        // Keep contracts set to track active subscriptions
        // Don't clear errors/warnings as they're managed with size limits
    }
    
    /**
     * Get current metrics (for debugging/monitoring)
     */
    getMetrics() {
        return {
            name: this.name,
            intervalMs: this.intervalMs,
            isRunning: this.isRunning,
            events: Object.fromEntries(this.metrics.events),
            activeContracts: Array.from(this.metrics.contracts),
            errorCount: this.metrics.errors.length,
            warningCount: this.metrics.warnings.length,
            lastActivity: this.metrics.lastActivity,
            uptime: Date.now() - this.metrics.startTime,
            systemHealth: this.metrics.systemHealth
        };
    }
    
    /**
     * Check if heartbeat logger is healthy
     */
    isHealthy() {
        const now = Date.now();
        const timeSinceActivity = this.metrics.lastActivity ? now - this.metrics.lastActivity : null;
        
        return {
            running: this.isRunning,
            recentActivity: timeSinceActivity ? timeSinceActivity < (this.intervalMs * 2) : false,
            errorRate: this.metrics.errors.length,
            warningRate: this.metrics.warnings.length
        };
    }
}

module.exports = HeartbeatLogger;