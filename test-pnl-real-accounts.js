/**
 * Test P&L Module with Real Account Data
 * Tests the complete P&L system using actual TopStep account IDs
 */

const PnLModule = require('./src/core/pnl/PnLModule');

async function testPnLWithRealAccounts() {
    console.log('🧪 Testing P&L Module with Real Account Data...');
    
    try {
        // Initialize P&L module
        const pnlModule = new PnLModule({
            redis: { host: 'localhost', port: 6379 },
            enableDebugLogging: true,
            refreshInterval: 30000, // 30 seconds for less frequent updates
            requestTimeout: 15000 // 15 seconds timeout
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
        
        // Real account IDs from the GET_ACCOUNTS test
        const realAccounts = [
            { id: 'EXPRESSMAY2114064450', name: 'Express May Account' },
            { id: 'PRACTICEJUL1615111535', name: 'Practice July Account' }
        ];
        
        console.log('\n📋 Testing with real accounts:', realAccounts);
        
        // Test 1: Get Account P&L for real accounts
        for (const account of realAccounts) {
            console.log(`\n🧪 Test 1: Get Account P&L for ${account.name} (${account.id})`);
            try {
                const accountPnL = await pnlModule.getAccountPnL(account.id);
                console.log('✅ Account P&L retrieved:', {
                    account: account.id,
                    dailyPnL: accountPnL.dailyPnL,
                    totalPnL: accountPnL.totalPnL,
                    tradeCount: accountPnL.trades?.length || 0,
                    lastUpdate: accountPnL.lastUpdate
                });
                
                if (accountPnL.trades && accountPnL.trades.length > 0) {
                    console.log('📊 Sample trades:', accountPnL.trades.slice(0, 3).map(t => ({
                        symbol: t.symbol,
                        side: t.side,
                        quantity: t.quantity,
                        price: t.price,
                        pnl: t.pnl,
                        timestamp: t.timestamp
                    })));
                }
                
            } catch (error) {
                console.log('⚠️ Account P&L test failed for', account.id, ':', error.message);
            }
        }
        
        // Test 2: Search trades for real accounts with various symbols
        const tradingSymbols = ['MES', 'MNQ', 'MGC', 'MCL', 'M2K'];
        
        for (const account of realAccounts) {
            console.log(`\n🧪 Test 2: Search Recent Trades for ${account.name}`);
            
            // Search for trades in the last 7 days
            const endDate = new Date();
            const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
            
            try {
                const trades = await pnlModule.getTradeData({
                    accountId: account.id,
                    startDate: startDate.toISOString(),
                    endDate: endDate.toISOString(),
                    status: 'FILLED'
                });
                
                console.log('✅ Trade search completed:', {
                    account: account.id,
                    tradesFound: trades.length,
                    dateRange: `${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`
                });
                
                if (trades.length > 0) {
                    // Group trades by symbol
                    const tradesBySymbol = trades.reduce((acc, trade) => {
                        acc[trade.symbol] = (acc[trade.symbol] || 0) + 1;
                        return acc;
                    }, {});
                    
                    console.log('📊 Trades by symbol:', tradesBySymbol);
                    
                    // Calculate total P&L
                    const totalPnL = trades.reduce((sum, trade) => sum + (trade.pnl || 0), 0);
                    console.log('💰 Total P&L from trades:', totalPnL);
                    
                    // Show sample trades
                    console.log('📈 Sample trades:', trades.slice(0, 5).map(t => ({
                        symbol: t.symbol,
                        side: t.side,
                        quantity: t.quantity,
                        price: t.price,
                        pnl: t.pnl,
                        commission: t.commission,
                        timestamp: t.timestamp
                    })));
                } else {
                    console.log('📭 No trades found in the last 7 days');
                }
                
            } catch (error) {
                console.log('⚠️ Trade search failed for', account.id, ':', error.message);
            }
        }
        
        // Test 3: Test symbol-specific searches
        console.log(`\n🧪 Test 3: Symbol-Specific Searches`);
        
        for (const symbol of tradingSymbols.slice(0, 2)) { // Test first 2 symbols
            console.log(`\n🔍 Searching ${symbol} trades for PRACTICEJUL1615111535...`);
            try {
                const symbolTrades = await pnlModule.getTradeData({
                    accountId: 'PRACTICEJUL1615111535',
                    symbol: symbol,
                    startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
                    endDate: new Date().toISOString(),
                    status: 'FILLED'
                });
                
                if (symbolTrades.length > 0) {
                    const symbolPnL = symbolTrades.reduce((sum, trade) => sum + (trade.pnl || 0), 0);
                    console.log(`✅ ${symbol} trades:`, {
                        count: symbolTrades.length,
                        totalPnL: symbolPnL,
                        avgPnL: symbolTrades.length > 0 ? (symbolPnL / symbolTrades.length).toFixed(2) : 0
                    });
                } else {
                    console.log(`📭 No ${symbol} trades found`);
                }
                
            } catch (error) {
                console.log(`⚠️ ${symbol} search failed:`, error.message);
            }
        }
        
        // Test 4: Check module status and summary
        console.log('\n📊 P&L Module Final Status:');
        const status = pnlModule.getStatus();
        console.log(status);
        
        console.log('\n💰 Daily P&L Summary:');
        const summary = pnlModule.getDailyPnLSummary();
        console.log(summary);
        
        // Test 5: Wait for one periodic refresh to see live data
        console.log('\n⏰ Waiting for periodic refresh...');
        await new Promise(resolve => setTimeout(resolve, 35000)); // Wait longer than refresh interval
        
        console.log('\n📊 Updated Status After Refresh:');
        const updatedStatus = pnlModule.getStatus();
        console.log({
            positions: updatedStatus.positions,
            trades: updatedStatus.trades,
            dailyPnL: updatedStatus.dailyPnL,
            activeAccounts: updatedStatus.activeAccounts,
            lastUpdate: updatedStatus.config.lastUpdate
        });
        
        // Cleanup
        console.log('\n🧹 Cleaning up...');
        await pnlModule.disconnect();
        console.log('✅ Real account P&L test completed successfully');
        
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
testPnLWithRealAccounts().catch(error => {
    console.error('❌ Unhandled test error:', error.message);
    process.exit(1);
});