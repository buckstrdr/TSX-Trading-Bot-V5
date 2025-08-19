/**
 * Live P&L Monitoring Test
 * Connects to the real P&L system and monitors actual position P&L updates
 */

const redis = require('redis');
const PnLModule = require('./src/core/pnl/PnLModule');

async function testLivePnLMonitoring() {
    console.log('📊 Starting Live P&L Monitoring Test...');
    
    try {
        // Create P&L module instance
        const pnlModule = new PnLModule({
            refreshInterval: 3000, // 3 seconds for testing
            requestTimeout: 15000,
            enableDebugLogging: true
        });
        
        // Initialize P&L module
        console.log('🔌 Initializing P&L Module...');
        await pnlModule.initialize();
        
        // Also create direct Redis subscriber to monitor P&L responses
        const subscriber = redis.createClient({ host: 'localhost', port: 6379 });
        await subscriber.connect();
        
        console.log('👂 Subscribing to P&L responses for monitoring...');
        await subscriber.subscribe('pnl:responses', (message) => {
            try {
                const data = JSON.parse(message);
                if (data.success && data.accountSummary) {
                    console.log('💰 [LIVE P&L UPDATE]', {
                        accountId: data.accountSummary.accountId,
                        balance: data.accountSummary.balance,
                        dailyPnL: data.accountSummary.dailyPnL,
                        timestamp: new Date().toLocaleTimeString()
                    });
                }
            } catch (error) {
                console.error('❌ Parse error:', error.message);
            }
        });
        
        // Test with real practice accounts
        const testAccounts = ['PRACTICEJUL1615111535', 'EXPRESSMAY2114064450'];
        
        console.log('\n📋 Starting continuous P&L monitoring...');
        console.log('This will run for 60 seconds to show live updates');
        
        let updateCount = 0;
        const startTime = Date.now();
        
        // Run continuous monitoring for 60 seconds
        const monitoringInterval = setInterval(async () => {
            updateCount++;
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            
            console.log(`\n🔄 Update ${updateCount} (${elapsed}s elapsed)`);
            
            // Test account P&L requests
            for (const accountId of testAccounts) {
                try {
                    console.log(`📤 Requesting P&L for ${accountId}...`);
                    const accountPnL = await pnlModule.getAccountPnL(accountId);
                    
                    console.log(`✅ ${accountId}:`, {
                        dailyPnL: accountPnL.dailyPnL || 'N/A',
                        balance: accountPnL.balance || 'N/A',
                        totalPnL: accountPnL.totalPnL || 'N/A'
                    });
                    
                    // Search for recent trades
                    const trades = await pnlModule.getTradeData({
                        accountId: accountId,
                        startDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // Last 24 hours
                        endDate: new Date().toISOString()
                    });
                    
                    if (trades.length > 0) {
                        console.log(`📈 Found ${trades.length} recent trades for ${accountId}`);
                        // Show first trade
                        const trade = trades[0];
                        console.log('   Sample trade:', {
                            symbol: trade.symbol || trade.instrument,
                            side: trade.side,
                            quantity: trade.quantity,
                            price: trade.price || trade.fillPrice,
                            pnl: trade.pnl || trade.realizedPnL || 'N/A'
                        });
                    } else {
                        console.log(`📊 No recent trades for ${accountId}`);
                    }
                    
                } catch (error) {
                    console.error(`❌ Error for ${accountId}:`, error.message);
                }
                
                // Wait between accounts to avoid overwhelming the API
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            // Show P&L module status
            const status = pnlModule.getStatus();
            console.log('📊 P&L Module Status:', {
                connected: status.connected,
                cachedPositions: status.positions,
                cachedTrades: status.trades,
                pendingRequests: status.pendingRequests
            });
            
        }, 5000); // Every 5 seconds
        
        // Stop after 60 seconds
        setTimeout(async () => {
            console.log('\n⏹️ Stopping monitoring test...');
            clearInterval(monitoringInterval);
            
            // Final summary
            const summary = pnlModule.getDailyPnLSummary();
            console.log('\n📋 Final P&L Summary:', summary);
            
            // Cleanup
            await pnlModule.disconnect();
            await subscriber.quit();
            
            console.log('✅ Live P&L monitoring test completed!');
            process.exit(0);
            
        }, 60000); // 60 seconds
        
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

// Run the test
testLivePnLMonitoring().catch(error => {
    console.error('❌ Unhandled test error:', error.message);
    process.exit(1);
});