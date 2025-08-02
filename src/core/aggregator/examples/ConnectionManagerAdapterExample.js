/**
 * ConnectionManagerAdapter Usage Example
 * Demonstrates how to use the live trading adapter with V4 Connection Manager
 * WebSocketEngineer-1 - July 24, 2025
 */

const ConnectionManagerAdapter = require('../adapters/ConnectionManagerAdapter');

class TradingExample {
    constructor() {
        // Initialize adapter with configuration
        this.adapter = new ConnectionManagerAdapter({
            connectionManagerUrl: 'http://localhost:7500',
            webSocketUrl: 'ws://localhost:7500',
            shadowMode: false, // Set to true for testing without real trades
            enableWebSocket: true,
            enableDebugLogging: true,
            maxRetries: 5,
            reconnectInterval: 5000
        });
        
        this.setupEventListeners();
    }
    
    /**
     * Setup event listeners for trading events
     */
    setupEventListeners() {
        // Connection events
        this.adapter.on('connected', (data) => {
            console.log('🟢 Connected to Connection Manager:', data);
            this.onConnected();
        });
        
        this.adapter.on('disconnected', () => {
            console.log('🔴 Disconnected from Connection Manager');
        });
        
        this.adapter.on('connectionError', (error) => {
            console.log('❌ Connection error:', error);
        });
        
        // Trading events
        this.adapter.on('fill', (fillData) => {
            console.log('🎯 Order filled:', fillData);
            this.handleOrderFill(fillData);
        });
        
        this.adapter.on('orderStatus', (statusData) => {
            console.log('📋 Order status update:', statusData);
        });
        
        this.adapter.on('positionUpdate', (positionData) => {
            console.log('📊 Position update:', positionData);
        });
        
        this.adapter.on('marketData', (marketData) => {
            console.log('📈 Market data:', marketData);
        });
        
        // Error events
        this.adapter.on('sendError', (error) => {
            console.log('❌ Order send error:', error);
        });
    }
    
    /**
     * Start the trading example
     */
    async start() {
        try {
            console.log('🚀 Starting ConnectionManager Adapter Example...');
            
            // Connect to Connection Manager
            const connected = await this.adapter.connect();
            
            if (!connected) {
                console.log('❌ Failed to connect to Connection Manager');
                return;
            }
            
            console.log('✅ Connection Manager Adapter Example started successfully');
            
        } catch (error) {
            console.log('❌ Failed to start example:', error.message);
        }
    }
    
    /**
     * Called when connection is established
     */
    async onConnected() {
        try {
            // Subscribe to market data for instruments we're interested in
            const instruments = ['MES', 'MNQ', 'MGC'];
            const subscription = await this.adapter.subscribeMarketData(instruments);
            console.log('📊 Market data subscription:', subscription);
            
            // Get current positions
            const positions = await this.adapter.getPositions();
            console.log('📊 Current positions:', positions);
            
            // Example: Place a test order (only do this if you want to trade!)
            // Uncomment the line below ONLY if you want to place a real order
            // await this.placeExampleOrder();
            
        } catch (error) {
            console.log('❌ Error in onConnected:', error.message);
        }
    }
    
    /**
     * Example order placement (BE CAREFUL - THIS PLACES REAL ORDERS!)
     */
    async placeExampleOrder() {
        const order = {
            id: `TEST_${Date.now()}`,
            instrument: 'MES', // Micro E-mini S&P 500
            action: 'BUY',
            quantity: 1,
            orderType: 'MARKET',
            account: null, // Will use default account
            botId: 'EXAMPLE_BOT'
        };
        
        console.log('📤 Placing example order:', order);
        const result = await this.adapter.sendOrder(order);
        console.log('📋 Order result:', result);
    }
    
    /**
     * Handle order fill events
     */
    handleOrderFill(fillData) {
        console.log(`🎯 Order filled: ${fillData.instrument} ${fillData.quantity} @ ${fillData.fillPrice}`);
        
        // Your fill handling logic here
        // For example: update positions, calculate P&L, place SL/TP orders, etc.
    }
    
    /**
     * Get adapter status
     */
    getStatus() {
        return this.adapter.getStatus();
    }
    
    /**
     * Get current positions
     */
    async getCurrentPositions() {
        return await this.adapter.getPositions();
    }
    
    /**
     * Get pending orders
     */
    getPendingOrders() {
        return this.adapter.getPendingOrders();
    }
    
    /**
     * Get market data
     */
    getMarketData(instrument = null) {
        return this.adapter.getMarketData(instrument);
    }
    
    /**
     * Stop the example and disconnect
     */
    async stop() {
        console.log('🛑 Stopping ConnectionManager Adapter Example...');
        await this.adapter.disconnect();
        console.log('✅ Example stopped');
    }
}

// Example usage
if (require.main === module) {
    const example = new TradingExample();
    
    // Start the example
    example.start().catch(error => {
        console.log('❌ Example failed:', error.message);
    });
    
    // Graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\n🛑 Received SIGINT, shutting down gracefully...');
        await example.stop();
        process.exit(0);
    });
    
    // Show status every 30 seconds
    setInterval(() => {
        const status = example.getStatus();
        console.log('📊 Adapter Status:', {
            connected: status.connected,
            wsConnected: status.wsConnected,
            pendingOrders: status.pendingOrders,
            activePositions: status.activePositions,
            subscribedInstruments: status.subscribedInstruments
        });
    }, 30000);
}

module.exports = TradingExample;