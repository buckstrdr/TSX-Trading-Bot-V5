/**
 * Test P&L Module - Verify P&L module works with aggregator before integration
 */

const PnLModule = require('./src/core/pnl/PnLModule');

async function testPnLModule() {
    console.log('🧪 Testing P&L Module...');
    
    try {
        // Initialize P&L module
        const pnlModule = new PnLModule({
            redis: { host: 'localhost', port: 6379 },
            enableDebugLogging: true,
            refreshInterval: 10000 // 10 seconds for testing
        });
        
        // Set up event listeners
        pnlModule.on('connected', () => {
            console.log('✅ P&L Module connected');
        });
        
        pnlModule.on('error', (error) => {
            console.error('❌ P&L Module error:', error.message);
        });
        
        pnlModule.on('refreshCompleted', () => {
            console.log('🔄 P&L refresh completed');
        });
        
        // Initialize the module
        const connected = await pnlModule.initialize();
        if (!connected) {
            throw new Error('Failed to connect P&L module');
        }
        
        console.log('✅ P&L Module initialized successfully');
        
        // Wait a moment for connections to stabilize
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Test 1: Get account P&L (this should work if connection manager supports it)
        console.log('\n🧪 Test 1: Get Account P&L');
        try {
            const accountPnL = await pnlModule.getAccountPnL('140-18803-001');
            console.log('✅ Account P&L retrieved:', accountPnL);
        } catch (error) {
            console.log('⚠️ Account P&L test failed (expected):', error.message);
        }
        
        // Test 2: Search trades for today
        console.log('\n🧪 Test 2: Search Trades');
        try {
            const trades = await pnlModule.getTradeData({
                accountId: '140-18803-001',
                symbol: 'MGC'
            });
            console.log('✅ Trade search completed:', trades.length, 'trades found');
            if (trades.length > 0) {
                console.log('📊 Sample trade:', trades[0]);
            }
        } catch (error) {
            console.log('⚠️ Trade search test failed (expected):', error.message);
        }
        
        // Test 3: Get position P&L (if we had a position)
        console.log('\n🧪 Test 3: Get Position P&L');
        try {
            const positionPnL = await pnlModule.getPositionPnL('test_position_123', '140-18803-001');
            console.log('✅ Position P&L retrieved:', positionPnL);
        } catch (error) {
            console.log('⚠️ Position P&L test failed (expected):', error.message);
        }
        
        // Test 4: Check module status
        console.log('\n📊 P&L Module Status:');
        const status = pnlModule.getStatus();
        console.log(status);
        
        // Test 5: Get daily P&L summary
        console.log('\n📊 Daily P&L Summary:');
        const summary = pnlModule.getDailyPnLSummary();
        console.log(summary);
        
        // Keep running for a bit to test periodic refresh
        console.log('\n⏰ Running for 30 seconds to test periodic refresh...');
        await new Promise(resolve => setTimeout(resolve, 30000));
        
        // Cleanup
        console.log('\n🧹 Cleaning up...');
        await pnlModule.disconnect();
        console.log('✅ Test completed successfully');
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error('Stack:', error.stack);
        process.exit(1);
    }
}

// Handle cleanup on exit
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down test...');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Shutting down test...');
    process.exit(0);
});

// Run the test
testPnLModule().catch(error => {
    console.error('❌ Unhandled test error:', error.message);
    process.exit(1);
});