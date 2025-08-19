/**
 * Simple P&L Test - Test one request at a time to debug the issue
 */

const redis = require('redis');

async function testPnLSimple() {
    console.log('🧪 Simple P&L Test - Testing Response Flow...');
    
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
                    accountCount: data.accounts?.length,
                    tradeCount: data.trades?.length,
                    dataKeys: Object.keys(data)
                });
            } catch (error) {
                console.error('❌ Failed to parse response:', error.message);
            }
        });
        
        // Wait a moment for subscription to be active
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log('\n📤 Sending GET_ACCOUNT_SUMMARY request for PRACTICEJUL1615111535...');
        
        // Send one simple request
        const requestId = `test_account_summary_${Date.now()}`;
        const request = {
            type: 'GET_ACCOUNT_SUMMARY',
            requestId: requestId,
            responseChannel: 'pnl:responses',
            accountId: 'PRACTICEJUL1615111535',
            date: '2025-08-19',
            timestamp: Date.now()
        };
        
        // Send directly to aggregator:pnl_requests
        await publisher.publish('aggregator:pnl_requests', JSON.stringify(request));
        console.log('✅ Request sent with ID:', requestId);
        
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
            console.log('✅ Test PASSED - Received response!');
            console.log('📊 Response details:', responses[0]);
        } else {
            console.log('❌ Test FAILED - No response received');
        }
        
        // Test 2: Try a SEARCH_TRADES request
        console.log('\n📤 Sending SEARCH_TRADES request...');
        
        const searchRequestId = `test_search_trades_${Date.now()}`;
        const searchRequest = {
            type: 'SEARCH_TRADES',
            requestId: searchRequestId,
            responseChannel: 'pnl:responses',
            searchParams: {
                accountId: 'PRACTICEJUL1615111535',
                startDate: '2025-08-15T00:00:00.000Z',
                endDate: '2025-08-19T23:59:59.999Z',
                status: 'FILLED'
            },
            timestamp: Date.now()
        };
        
        await publisher.publish('aggregator:pnl_requests', JSON.stringify(searchRequest));
        console.log('✅ Search request sent with ID:', searchRequestId);
        
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
            console.log('✅ Search test PASSED - Received response!');
            console.log('📊 Search response details:', responses[responses.length - 1]);
        } else {
            console.log('❌ Search test FAILED - No response received');
        }
        
        console.log('\n📋 Summary:');
        console.log(`Total responses received: ${responses.length}`);
        
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
testPnLSimple().catch(error => {
    console.error('❌ Unhandled test error:', error.message);
    process.exit(1);
});