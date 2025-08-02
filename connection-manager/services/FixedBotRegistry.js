// connection-manager/services/FixedBotRegistry.js
// Simplified registry for 6 fixed bots - wraps the simple bot tracker
// to work with existing ConnectionManager code

const BotConnectionTracker = require('./BotConnectionTracker');

class FixedBotRegistry {
    constructor() {
        this.botTracker = new BotConnectionTracker();
        console.log('📋 Fixed Bot Registry initialized for BOT_1 through BOT_6');
    }
    
    // Validate that it's one of our 6 fixed bots
    validateRegistration(registration) {
        const { instanceId, account, instrument, strategy } = registration;
        
        // Check if it's a valid bot ID
        if (!['BOT_1', 'BOT_2', 'BOT_3', 'BOT_4', 'BOT_5', 'BOT_6'].includes(instanceId)) {
            return {
                valid: false,
                reason: `Invalid bot ID: ${instanceId}. Must be BOT_1 through BOT_6`
            };
        }
        
        // Check if already connected
        const botStatus = this.botTracker.getBotStatus(instanceId);
        if (botStatus && botStatus.connected) {
            return {
                valid: false,
                reason: `${instanceId} is already connected`
            };
        }
        
        // Check for account-instrument conflict
        if (this.botTracker.isAccountInstrumentInUse(account, instrument)) {
            return {
                valid: false,
                reason: `Account ${account} is already trading ${instrument}`
            };
        }
        
        return { valid: true };
    }
    
    // Register one of the 6 fixed bots
    registerInstance(registration) {
        const { instanceId, account, instrument, strategy } = registration;
        
        return this.botTracker.connectBot(instanceId, {
            account,
            instrument,
            strategy
        });
    }
    
    // Deregister bot
    deregisterInstance(instanceId) {
        return this.botTracker.disconnectBot(instanceId);
    }
    
    // Get bot info
    getInstance(instanceId) {
        const status = this.botTracker.getBotStatus(instanceId);
        if (!status || !status.connected) return null;
        
        return {
            instanceId,
            ...status,
            status: 'ACTIVE'
        };
    }
    
    // Get all bots
    getAllInstances() {
        const allBots = this.botTracker.getAllBotStatuses();
        return Object.entries(allBots).map(([botId, bot]) => ({
            instanceId: botId,
            ...bot,
            status: bot.connected ? 'ACTIVE' : 'INACTIVE'
        }));
    }
    
    // Get active bots
    getActiveInstances() {
        return this.botTracker.getConnectedBots().map(bot => ({
            instanceId: bot.botId,
            ...bot,
            status: 'ACTIVE'
        }));
    }
    
    // Get active count
    getActiveCount() {
        return this.botTracker.getConnectedCount();
    }
    
    // Get bots by instrument
    getInstancesByInstrument(instrument) {
        return this.getActiveInstances().filter(bot => bot.instrument === instrument);
    }
    
    // Update heartbeat
    updateHeartbeat(instanceId) {
        return this.botTracker.updateHeartbeat(instanceId);
    }
}

module.exports = FixedBotRegistry;