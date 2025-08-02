// connection-manager/services/PositionReconciliationService.js
// Position Reconciliation Service for Distributed Trading Architecture
// Ensures position consistency between Connection Manager and bot instances

const EventEmitter = require('events');

class PositionReconciliationService extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            reconciliationIntervalMs: 30000,  // 30 seconds
            maxDiscrepancyThreshold: 0.01,    // $0.01 threshold for position discrepancies
            forceReconciliationThreshold: 5,  // Force reconciliation after 5 discrepancies
            positionTimeoutMs: 300000,        // 5 minutes timeout for stale positions
            enableAutoCorrection: true,       // Auto-correct minor discrepancies
            logLevel: 'INFO',
            ...config
        };
        
        // Position tracking
        this.masterPositions = new Map();     // Authoritative position state
        this.instancePositions = new Map();   // Per-instance position states
        this.reconciliationStats = {
            totalReconciliations: 0,
            discrepanciesFound: 0,
            autoCorrections: 0,
            manualInterventions: 0,
            lastReconciliation: null
        };
        
        // Pending reconciliation requests
        this.pendingReconciliations = new Set();
        this.reconciliationHistory = [];
        
        this.isRunning = false;
        this.reconciliationTimer = null;
        
        console.log('🔄 Position Reconciliation Service initialized');
        console.log(`   Interval: ${this.config.reconciliationIntervalMs / 1000}s`);
        console.log(`   Auto-correction: ${this.config.enableAutoCorrection ? 'ENABLED' : 'DISABLED'}`);
    }
    
    start() {
        if (this.isRunning) {
            console.log('⚠️  Position Reconciliation Service already running');
            return;
        }
        
        this.isRunning = true;
        this.scheduleReconciliation();
        
        console.log('▶️  Position Reconciliation Service started');
    }
    
    stop() {
        if (!this.isRunning) {
            console.log('⚠️  Position Reconciliation Service not running');
            return;
        }
        
        this.isRunning = false;
        
        if (this.reconciliationTimer) {
            clearTimeout(this.reconciliationTimer);
            this.reconciliationTimer = null;
        }
        
        console.log('⏹️  Position Reconciliation Service stopped');
    }
    
    scheduleReconciliation() {
        if (!this.isRunning) return;
        
        this.reconciliationTimer = setTimeout(async () => {
            try {
                await this.performReconciliation();
            } catch (error) {
                console.error('❌ Scheduled reconciliation failed:', error);
            } finally {
                this.scheduleReconciliation(); // Schedule next reconciliation
            }
        }, this.config.reconciliationIntervalMs);
    }
    
    // Update master position state (called by Connection Manager)
    updateMasterPosition(positionData) {
        try {
            const { orderId, instanceId, ...positionInfo } = positionData;
            
            if (!orderId) {
                throw new Error('Position update missing orderId');
            }
            
            this.masterPositions.set(orderId, {
                orderId,
                instanceId,
                ...positionInfo,
                lastUpdate: Date.now(),
                source: 'MASTER'
            });
            
            if (this.config.logLevel === 'DEBUG') {
                console.log(`🔄 Master position updated: ${orderId} (${instanceId})`);
            }
            
            // Emit position update event
            this.emit('masterPositionUpdated', { orderId, instanceId, positionInfo });
            
        } catch (error) {
            console.error('❌ Error updating master position:', error);
        }
    }
    
    // Update instance position state (called by bot instances)
    updateInstancePosition(instanceId, positionData) {
        try {
            const { orderId, ...positionInfo } = positionData;
            
            if (!orderId || !instanceId) {
                throw new Error('Position update missing orderId or instanceId');
            }
            
            // Store per-instance position data
            if (!this.instancePositions.has(instanceId)) {
                this.instancePositions.set(instanceId, new Map());
            }
            
            this.instancePositions.get(instanceId).set(orderId, {
                orderId,
                instanceId,
                ...positionInfo,
                lastUpdate: Date.now(),
                source: 'INSTANCE'
            });
            
            if (this.config.logLevel === 'DEBUG') {
                console.log(`🔄 Instance position updated: ${orderId} (${instanceId})`);
            }
            
            // Emit position update event
            this.emit('instancePositionUpdated', { orderId, instanceId, positionInfo });
            
        } catch (error) {
            console.error('❌ Error updating instance position:', error);
        }
    }
    
    // Perform comprehensive position reconciliation
    async performReconciliation() {
        const reconciliationId = `RECON_${Date.now()}`;
        const startTime = Date.now();
        
        console.log(`🔄 Starting position reconciliation: ${reconciliationId}`);
        
        try {
            const results = {
                reconciliationId,
                startTime,
                masterPositions: this.masterPositions.size,
                instancePositions: 0,
                discrepancies: [],
                corrections: [],
                errors: []
            };
            
            // Count total instance positions
            for (const [instanceId, positions] of this.instancePositions) {
                results.instancePositions += positions.size;
            }
            
            // Check for discrepancies
            await this.checkPositionDiscrepancies(results);
            
            // Clean up stale positions
            await this.cleanupStalePositions(results);
            
            // Apply auto-corrections if enabled
            if (this.config.enableAutoCorrection && results.discrepancies.length > 0) {
                await this.applyAutoCorrections(results);
            }
            
            // Update statistics
            this.reconciliationStats.totalReconciliations++;
            this.reconciliationStats.discrepanciesFound += results.discrepancies.length;
            this.reconciliationStats.autoCorrections += results.corrections.length;
            this.reconciliationStats.lastReconciliation = Date.now();
            
            // Store reconciliation history
            results.endTime = Date.now();
            results.duration = results.endTime - results.startTime;
            this.reconciliationHistory.push(results);
            
            // Keep only last 50 reconciliation records
            if (this.reconciliationHistory.length > 50) {
                this.reconciliationHistory.shift();
            }
            
            // Log results
            this.logReconciliationResults(results);
            
            // Emit reconciliation complete event
            this.emit('reconciliationComplete', results);
            
            return results;
            
        } catch (error) {
            console.error('❌ Position reconciliation failed:', error);
            this.emit('reconciliationError', { reconciliationId, error: error.message });
            throw error;
        }
    }
    
    async checkPositionDiscrepancies(results) {
        console.log('🔍 Checking for position discrepancies...');
        
        // Check each master position against instance positions
        for (const [orderId, masterPosition] of this.masterPositions) {
            const instanceId = masterPosition.instanceId;
            
            if (!this.instancePositions.has(instanceId)) {
                results.discrepancies.push({
                    type: 'MISSING_INSTANCE',
                    orderId,
                    instanceId,
                    description: `Instance ${instanceId} has no position data`,
                    severity: 'HIGH'
                });
                continue;
            }
            
            const instancePositionMap = this.instancePositions.get(instanceId);
            const instancePosition = instancePositionMap.get(orderId);
            
            if (!instancePosition) {
                results.discrepancies.push({
                    type: 'MISSING_POSITION',
                    orderId,
                    instanceId,
                    description: `Position ${orderId} missing from instance ${instanceId}`,
                    severity: 'HIGH'
                });
                continue;
            }
            
            // Compare position details
            const discrepancy = this.comparePositions(masterPosition, instancePosition);
            if (discrepancy) {
                results.discrepancies.push({
                    ...discrepancy,
                    orderId,
                    instanceId
                });
            }
        }
        
        // Check for orphaned instance positions
        for (const [instanceId, positionMap] of this.instancePositions) {
            for (const [orderId, instancePosition] of positionMap) {
                if (!this.masterPositions.has(orderId)) {
                    results.discrepancies.push({
                        type: 'ORPHANED_POSITION',
                        orderId,
                        instanceId,
                        description: `Instance position ${orderId} not found in master`,
                        severity: 'MEDIUM'
                    });
                }
            }
        }
        
        console.log(`🔍 Found ${results.discrepancies.length} discrepancies`);
    }
    
    comparePositions(masterPosition, instancePosition) {
        const discrepancies = [];
        
        // Compare critical fields
        const criticalFields = ['size', 'entryPrice', 'direction', 'status'];
        
        for (const field of criticalFields) {
            const masterValue = masterPosition[field];
            const instanceValue = instancePosition[field];
            
            if (masterValue !== instanceValue) {
                // Special handling for numeric fields
                if (typeof masterValue === 'number' && typeof instanceValue === 'number') {
                    const diff = Math.abs(masterValue - instanceValue);
                    if (diff > this.config.maxDiscrepancyThreshold) {
                        discrepancies.push({
                            field,
                            masterValue,
                            instanceValue,
                            difference: diff
                        });
                    }
                } else {
                    discrepancies.push({
                        field,
                        masterValue,
                        instanceValue
                    });
                }
            }
        }
        
        if (discrepancies.length > 0) {
            return {
                type: 'FIELD_MISMATCH',
                description: `Position data mismatch in fields: ${discrepancies.map(d => d.field).join(', ')}`,
                severity: discrepancies.some(d => ['size', 'direction'].includes(d.field)) ? 'HIGH' : 'MEDIUM',
                details: discrepancies
            };
        }
        
        return null;
    }
    
    async cleanupStalePositions(results) {
        const now = Date.now();
        const staleThreshold = now - this.config.positionTimeoutMs;
        
        // Remove stale master positions
        for (const [orderId, position] of this.masterPositions) {
            if (position.lastUpdate < staleThreshold) {
                this.masterPositions.delete(orderId);
                console.log(`🧹 Removed stale master position: ${orderId}`);
            }
        }
        
        // Remove stale instance positions
        for (const [instanceId, positionMap] of this.instancePositions) {
            for (const [orderId, position] of positionMap) {
                if (position.lastUpdate < staleThreshold) {
                    positionMap.delete(orderId);
                    console.log(`🧹 Removed stale instance position: ${orderId} (${instanceId})`);
                }
            }
            
            // Remove empty instance maps
            if (positionMap.size === 0) {
                this.instancePositions.delete(instanceId);
            }
        }
    }
    
    async applyAutoCorrections(results) {
        console.log('🔧 Applying auto-corrections...');
        
        for (const discrepancy of results.discrepancies) {
            try {
                if (discrepancy.severity === 'LOW' || 
                    (discrepancy.severity === 'MEDIUM' && discrepancy.type === 'FIELD_MISMATCH')) {
                    
                    const correction = await this.attemptAutoCorrection(discrepancy);
                    if (correction) {
                        results.corrections.push(correction);
                        console.log(`✅ Auto-corrected: ${discrepancy.orderId} - ${correction.action}`);
                    }
                }
            } catch (error) {
                console.error(`❌ Auto-correction failed for ${discrepancy.orderId}:`, error);
                results.errors.push({
                    orderId: discrepancy.orderId,
                    error: error.message
                });
            }
        }
    }
    
    async attemptAutoCorrection(discrepancy) {
        const { orderId, instanceId, type, details } = discrepancy;
        
        if (type === 'FIELD_MISMATCH' && details) {
            // For field mismatches, use master as source of truth
            const masterPosition = this.masterPositions.get(orderId);
            if (masterPosition) {
                // Update instance position with master data
                this.updateInstancePosition(instanceId, masterPosition);
                
                return {
                    orderId,
                    instanceId,
                    action: 'SYNC_FROM_MASTER',
                    details: `Updated fields: ${details.map(d => d.field).join(', ')}`
                };
            }
        }
        
        if (type === 'ORPHANED_POSITION') {
            // Remove orphaned instance position
            const instancePositions = this.instancePositions.get(instanceId);
            if (instancePositions) {
                instancePositions.delete(orderId);
                
                return {
                    orderId,
                    instanceId,
                    action: 'REMOVE_ORPHANED',
                    details: 'Removed orphaned instance position'
                };
            }
        }
        
        return null;
    }
    
    // Force reconciliation for specific position
    async forceReconciliation(orderId, reason = 'Manual request') {
        console.log(`🔄 Force reconciliation for position: ${orderId} (${reason})`);
        
        if (this.pendingReconciliations.has(orderId)) {
            console.log(`⚠️  Reconciliation already pending for: ${orderId}`);
            return false;
        }
        
        this.pendingReconciliations.add(orderId);
        
        try {
            const masterPosition = this.masterPositions.get(orderId);
            if (!masterPosition) {
                console.log(`❌ Position not found in master: ${orderId}`);
                return false;
            }
            
            const instanceId = masterPosition.instanceId;
            
            // Emit reconciliation request
            this.emit('forceReconciliation', {
                orderId,
                instanceId,
                masterPosition,
                reason
            });
            
            console.log(`✅ Force reconciliation requested: ${orderId}`);
            return true;
            
        } finally {
            this.pendingReconciliations.delete(orderId);
        }
    }
    
    logReconciliationResults(results) {
        const { reconciliationId, duration, masterPositions, instancePositions, discrepancies, corrections } = results;
        
        console.log(`\n📊 RECONCILIATION RESULTS: ${reconciliationId}`);
        console.log(`⏱️  Duration: ${duration}ms`);
        console.log(`📋 Master positions: ${masterPositions}`);
        console.log(`📋 Instance positions: ${instancePositions}`);
        console.log(`⚠️  Discrepancies: ${discrepancies.length}`);
        console.log(`🔧 Auto-corrections: ${corrections.length}`);
        
        if (discrepancies.length > 0) {
            console.log('\n🔍 DISCREPANCY SUMMARY:');
            const grouped = this.groupDiscrepanciesByType(discrepancies);
            Object.entries(grouped).forEach(([type, count]) => {
                console.log(`   ${type}: ${count}`);
            });
        }
        
        if (corrections.length > 0) {
            console.log('\n🔧 CORRECTIONS APPLIED:');
            corrections.forEach(correction => {
                console.log(`   ${correction.orderId}: ${correction.action}`);
            });
        }
        
        console.log(''); // Empty line for separation
    }
    
    groupDiscrepanciesByType(discrepancies) {
        return discrepancies.reduce((acc, disc) => {
            acc[disc.type] = (acc[disc.type] || 0) + 1;
            return acc;
        }, {});
    }
    
    // Get reconciliation statistics
    getReconciliationStats() {
        return {
            ...this.reconciliationStats,
            currentPositions: {
                master: this.masterPositions.size,
                instances: Array.from(this.instancePositions.values())
                    .reduce((total, posMap) => total + posMap.size, 0)
            },
            instanceBreakdown: Array.from(this.instancePositions.entries())
                .map(([instanceId, posMap]) => ({
                    instanceId,
                    positionCount: posMap.size
                })),
            recentReconciliations: this.reconciliationHistory.slice(-10)
        };
    }
    
    // Get current position status
    getPositionStatus(orderId) {
        const masterPosition = this.masterPositions.get(orderId);
        if (!masterPosition) {
            return { found: false, message: 'Position not found in master' };
        }
        
        const instanceId = masterPosition.instanceId;
        const instancePositions = this.instancePositions.get(instanceId);
        const instancePosition = instancePositions?.get(orderId);
        
        return {
            found: true,
            orderId,
            instanceId,
            master: masterPosition,
            instance: instancePosition || null,
            synchronized: !!instancePosition,
            lastReconciliation: this.reconciliationStats.lastReconciliation
        };
    }
    
    // Health check
    getHealthStatus() {
        const now = Date.now();
        const timeSinceLastReconciliation = this.reconciliationStats.lastReconciliation ? 
            now - this.reconciliationStats.lastReconciliation : null;
        
        const isHealthy = this.isRunning && 
            (!timeSinceLastReconciliation || timeSinceLastReconciliation < this.config.reconciliationIntervalMs * 2);
        
        return {
            healthy: isHealthy,
            running: this.isRunning,
            masterPositions: this.masterPositions.size,
            instanceCount: this.instancePositions.size,
            totalInstancePositions: Array.from(this.instancePositions.values())
                .reduce((total, posMap) => total + posMap.size, 0),
            lastReconciliation: this.reconciliationStats.lastReconciliation,
            timeSinceLastReconciliation,
            pendingReconciliations: this.pendingReconciliations.size,
            stats: this.reconciliationStats
        };
    }
}

module.exports = PositionReconciliationService;