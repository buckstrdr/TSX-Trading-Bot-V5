/**
 * Test P&L with Correct Request Types
 * Use the actual P&L module request types instead of Connection Manager types
 */

const redis = require('redis');

async function testPnLCorrectTypes() {
    console.log('🧪 Testing P&L with Correct Request Types...');
    
    try {
        // Create Redis clients
        const publisher = redis.createClient({ host: 'localhost', port: 6379 });
        const subscriber = redis.createClient({ host: 'localhost', port: 6379 });
        
        await publisher.connect();
        await subscriber.connect();
        
        console.log('✅ Connected to Redis');
        
        // Subscribe to P&L responses to see what we get back
        console.log('👂 Subscribing to pnl:responses channel...');
        
        const responses = [];
        await subscriber.subscribe('pnl:responses', (message) => {
            console.log('📥 RECEIVED RESPONSE:', message);
            try {
                const data = JSON.parse(message);
                responses.push(data);
                console.log('📊 Parsed response:', {
                    requestId: data.requestId,
                    success: data.success,
                    error: data.error,
                    accountSummary: data.accountSummary ? 'present' : 'absent',
                    trades: Array.isArray(data.trades) ? `${data.trades.length} trades` : 'absent',
                    dataKeys: Object.keys(data).sort()
                });
                
                if (data.success && data.accountSummary) {
                    console.log('💰 Account Summary:', {
                        accountId: data.accountSummary.accountId,
                        balance: data.accountSummary.balance,
                        dailyPnL: data.accountSummary.dailyPnL,
                        totalPnL: data.accountSummary.totalPnL
                    });
                }
                
                if (data.success && data.trades && data.trades.length > 0) {
                    console.log('📈 Sample trades:', data.trades.slice(0, 3).map(t => ({
                        symbol: t.symbol,
                        side: t.side,
                        quantity: t.quantity,
                        price: t.price,
                        pnl: t.pnl
                    })));
                }
                
            } catch (error) {
                console.error('❌ Failed to parse response:', error.message);
            }
        });
        
        // Wait a moment for subscription to be active
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Test 1: GET_ACCOUNT_PNL (this should be supported by the aggregator)
        console.log('\n📤 Test 1: Sending GET_ACCOUNT_PNL request for PRACTICEJUL1615111535...');
        
        const accountRequestId = `test_account_pnl_${Date.now()}`;
        const accountRequest = {
            type: 'GET_ACCOUNT_PNL',
            requestId: accountRequestId,
            accountId: 'PRACTICEJUL1615111535',
            date: '2025-08-19',
            timestamp: Date.now()
        };
        
        await publisher.publish('aggregator:pnl_requests', JSON.stringify(accountRequest));
        console.log('✅ GET_ACCOUNT_PNL request sent with ID:', accountRequestId);
        
        // Wait for response
        console.log('⏰ Waiting 20 seconds for response...');
        let waitCount = 0;
        while (waitCount < 20 && responses.length === 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            waitCount++;
            if (waitCount % 5 === 0) {
                console.log(`⏰ Still waiting... (${waitCount}s)`);
            }
        }
        
        if (responses.length > 0) {
            console.log('✅ Test 1 PASSED - Received account P&L response!');
        } else {
            console.log('❌ Test 1 FAILED - No response received');
        }
        
        // Test 2: SEARCH_TRADES (this should be supported by the aggregator)
        console.log('\n📤 Test 2: Sending SEARCH_TRADES request...');
        
        const searchRequestId = `test_search_trades_${Date.now()}`;
        const searchRequest = {
            type: 'SEARCH_TRADES',
            requestId: searchRequestId,
            searchParams: {
                accountId: 'PRACTICEJUL1615111535',
                startDate: '2025-08-15T00:00:00.000Z',
                endDate: '2025-08-19T23:59:59.999Z',
                status: 'FILLED'
            },
            timestamp: Date.now()
        };
        
        await publisher.publish('aggregator:pnl_requests', JSON.stringify(searchRequest));
        console.log('✅ SEARCH_TRADES request sent with ID:', searchRequestId);
        
        // Wait for second response
        console.log('⏰ Waiting 20 seconds for search response...');
        const initialResponseCount = responses.length;
        waitCount = 0;
        while (waitCount < 20 && responses.length === initialResponseCount) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            waitCount++;
            if (waitCount % 5 === 0) {
                console.log(`⏰ Still waiting for search response... (${waitCount}s)`);
            }
        }
        
        if (responses.length > initialResponseCount) {
            console.log('✅ Test 2 PASSED - Received search response!');
        } else {
            console.log('❌ Test 2 FAILED - No search response received');
        }
        
        // Test 3: Test with Express May account
        console.log('\n📤 Test 3: Sending GET_ACCOUNT_PNL for EXPRESSMAY2114064450...');
        
        const expressRequestId = `test_express_account_${Date.now()}`;
        const expressRequest = {
            type: 'GET_ACCOUNT_PNL',
            requestId: expressRequestId,
            accountId: 'EXPRESSMAY2114064450',
            date: '2025-08-19',
            timestamp: Date.now()
        };
        
        await publisher.publish('aggregator:pnl_requests', JSON.stringify(expressRequest));
        console.log('✅ Express account request sent with ID:', expressRequestId);
        
        // Wait for third response
        console.log('⏰ Waiting 15 seconds for Express account response...');
        const previousResponseCount = responses.length;
        waitCount = 0;
        while (waitCount < 15 && responses.length === previousResponseCount) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            waitCount++;
            if (waitCount % 5 === 0) {
                console.log(`⏰ Still waiting for Express response... (${waitCount}s)`);
            }
        }
        
        if (responses.length > previousResponseCount) {
            console.log('✅ Test 3 PASSED - Received Express account response!');
        } else {
            console.log('❌ Test 3 FAILED - No Express account response received');
        }
        
        console.log('\n📋 Final Summary:');
        console.log(`Total responses received: ${responses.length}`);
        
        responses.forEach((response, index) => {
            console.log(`Response ${index + 1}:`, {
                requestId: response.requestId,
                success: response.success,
                error: response.error,
                hasData: !!(response.accountSummary || response.trades)
            });
        });
        
        // Clean up
        await subscriber.quit();
        await publisher.quit();
        console.log('✅ Test completed');
        
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
testPnLCorrectTypes().catch(error => {
    console.error('❌ Unhandled test error:', error.message);
    process.exit(1);
});