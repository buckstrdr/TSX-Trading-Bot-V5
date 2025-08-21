/**
 * Direct test of connection-manager:requests channel
 * This will help debug if EventBroadcaster is processing messages
 */

const redis = require('redis');

async function testDirectCMRequest() {
    console.log('Testing direct connection-manager:requests channel...\n');
    
    const publisher = redis.createClient({ host: 'localhost', port: 6379 });
    await publisher.connect();
    
    // Test 1: Send REQUEST_HISTORICAL_DATA through connection-manager:requests
    const msg1 = {
        type: 'REQUEST_HISTORICAL_DATA',
        payload: {
            instanceId: 'test_direct',
            requestId: 'test_' + Date.now(),
            instrument: 'F.US.MGC',
            startTime: new Date(Date.now() - 1800000).toISOString(),
            endTime: new Date().toISOString(),
            unit: 2,
            unitNumber: 5,
            limit: 5
        }
    };
    
    console.log('📤 Sending REQUEST_HISTORICAL_DATA to connection-manager:requests');
    await publisher.publish('connection-manager:requests', JSON.stringify(msg1));
    
    // Test 2: Send through instance:control channel
    const msg2 = {
        type: 'REQUEST_HISTORICAL_DATA',
        payload: {
            instanceId: 'test_instance',
            requestId: 'test2_' + Date.now(),
            instrument: 'F.US.MGC',
            startTime: new Date(Date.now() - 1800000).toISOString(),
            endTime: new Date().toISOString(),
            unit: 2,
            unitNumber: 5,
            limit: 5
        }
    };
    
    console.log('📤 Sending REQUEST_HISTORICAL_DATA to instance:control');
    await publisher.publish('instance:control', JSON.stringify(msg2));
    
    // Test 3: Send UPDATE_SLTP request (known to work)
    const msg3 = {
        type: 'UPDATE_SLTP',
        payload: {
            accountId: 'test_account',
            positionId: 'test_position',
            stopLoss: 1850,
            takeProfit: 1870
        }
    };
    
    console.log('📤 Sending UPDATE_SLTP to connection-manager:requests (control test)');
    await publisher.publish('connection-manager:requests', JSON.stringify(msg3));
    
    console.log('\n✅ All messages sent');
    console.log('👀 Check Connection Manager output for processing logs\n');
    
    await publisher.quit();
}

testDirectCMRequest().catch(console.error);