// connection-manager/services/BotConnectionTracker.js
// Simple tracker for the 6 fixed trading bots

class BotConnectionTracker {
    constructor() {
        // Fixed bot configuration - simple and direct
        this.bots = {
            BOT_1: { connected: false, lastSeen: null, account: null, instrument: null, strategy: null },
            BOT_2: { connected: false, lastSeen: null, account: null, instrument: null, strategy: null },
            BOT_3: { connected: false, lastSeen: null, account: null, instrument: null, strategy: null },
            BOT_4: { connected: false, lastSeen: null, account: null, instrument: null, strategy: null },
            BOT_5: { connected: false, lastSeen: null, account: null, instrument: null, strategy: null },
            BOT_6: { connected: false, lastSeen: null, account: null, instrument: null, strategy: null }
        };
        
        console.log('🤖 Bot Connection Tracker initialized for 6 fixed bots');
    }
    
    // Bot connects with its configuration
    connectBot(botId, config = {}) {
        if (!this.bots[botId]) {
            console.log(`❌ Unknown bot ID: ${botId}. Valid IDs: BOT_1 through BOT_6`);
            return false;
        }
        
        this.bots[botId] = {
            connected: true,
            lastSeen: Date.now(),
            account: config.account || null,
            instrument: config.instrument || null,
            strategy: config.strategy || null
        };
        
        console.log(`✅ ${botId} connected`);
        if (config.account && config.instrument) {
            console.log(`   Trading ${config.instrument} on account ${config.account} using ${config.strategy}`);
        }
        
        return true;
    }
    
    // Bot disconnects
    disconnectBot(botId) {
        if (!this.bots[botId]) {
            return false;
        }
        
        this.bots[botId].connected = false;
        console.log(`📤 ${botId} disconnected`);
        
        return true;
    }
    
    // Update bot heartbeat
    updateHeartbeat(botId) {
        if (this.bots[botId] && this.bots[botId].connected) {
            this.bots[botId].lastSeen = Date.now();
            return true;
        }
        return false;
    }
    
    // Get bot status
    getBotStatus(botId) {
        return this.bots[botId] || null;
    }
    
    // Get all bot statuses
    getAllBotStatuses() {
        return { ...this.bots };
    }
    
    // Get connected bot count
    getConnectedCount() {
        return Object.values(this.bots).filter(bot => bot.connected).length;
    }
    
    // Get list of connected bots
    getConnectedBots() {
        return Object.entries(this.bots)
            .filter(([_, bot]) => bot.connected)
            .map(([botId, bot]) => ({ botId, ...bot }));
    }
    
    // Check if a specific account/instrument combo is already being traded
    isAccountInstrumentInUse(account, instrument) {
        return Object.entries(this.bots).some(([botId, bot]) => 
            bot.connected && 
            bot.account === account && 
            bot.instrument === instrument
        );
    }
    
    // Get summary for logging
    getSummary() {
        const connected = this.getConnectedCount();
        return `${connected}/6 bots connected`;
    }
}

module.exports = BotConnectionTracker;