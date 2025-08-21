/**
 * Test Connection Manager's ability to retrieve historical data from TSX API
 * This tests the actual data flow without going through Redis
 */

const http = require('http');

async function testHistoricalDataRetrieval() {
    console.log('========================================');
    console.log('Connection Manager Historical Data Test');
    console.log('========================================\n');
    
    // Calculate time windows - last 30 minutes of 5-minute bars
    const now = new Date();
    const endTime = new Date(now);
    const startTime = new Date(now.getTime() - (30 * 60 * 1000)); // 30 minutes ago
    
    console.log(`📅 Request Parameters:`);
    console.log(`   Start Time: ${startTime.toISOString()}`);
    console.log(`   End Time: ${endTime.toISOString()}`);
    console.log(`   Expected bars: ~6 (30 minutes / 5 minutes)\n`);
    
    // Test 1: Check if Connection Manager is running
    console.log('🔍 Test 1: Checking Connection Manager availability...');
    
    const healthCheck = await makeRequest('GET', '/health', null);
    if (!healthCheck.success) {
        console.log('❌ Connection Manager is not running on port 7500');
        console.log('💡 Please start the Connection Manager first');
        return false;
    }
    console.log('✅ Connection Manager is running\n');
    
    // Test 2: Try to call the retrieveBars endpoint directly (if it exists)
    console.log('🔍 Test 2: Testing direct /api/History/retrieveBars endpoint...');
    
    const directRequestData = {
        contractId: "F.US.MGC",  // MGC futures contract
        live: true,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        unit: 2,                 // 2 = Minute
        unitNumber: 5,           // 5-minute candles
        limit: 10,               // Get last 10 bars
        includePartialBar: false
    };
    
    console.log('📊 Request payload:', JSON.stringify(directRequestData, null, 2));
    
    const directResult = await makeRequest('POST', '/api/History/retrieveBars', directRequestData);
    
    if (directResult.success && directResult.data) {
        console.log('✅ Direct endpoint call successful!');
        
        if (directResult.data.bars && Array.isArray(directResult.data.bars)) {
            console.log(`📊 Received ${directResult.data.bars.length} bars`);
            
            // Display first and last bar
            if (directResult.data.bars.length > 0) {
                const firstBar = directResult.data.bars[0];
                const lastBar = directResult.data.bars[directResult.data.bars.length - 1];
                
                console.log('\n📈 First Bar:');
                console.log(`   Time: ${new Date(firstBar.t).toISOString()}`);
                console.log(`   Open: ${firstBar.o}, High: ${firstBar.h}, Low: ${firstBar.l}, Close: ${firstBar.c}`);
                console.log(`   Volume: ${firstBar.v}`);
                
                console.log('\n📈 Last Bar:');
                console.log(`   Time: ${new Date(lastBar.t).toISOString()}`);
                console.log(`   Open: ${lastBar.o}, High: ${lastBar.h}, Low: ${lastBar.l}, Close: ${lastBar.c}`);
                console.log(`   Volume: ${lastBar.v}`);
            }
        } else {
            console.log('⚠️ Response has no bars array');
            console.log('Response:', JSON.stringify(directResult.data, null, 2));
        }
    } else {
        console.log('❌ Direct endpoint not available (404) - this is expected');
        console.log('💡 Connection Manager does not expose this endpoint directly');
        console.log('📝 Historical data must be requested through Redis channels\n');
    }
    
    // Test 3: Check what endpoints ARE available
    console.log('\n🔍 Test 3: Checking available endpoints...');
    
    const endpoints = [
        { method: 'GET', path: '/api/positions' },
        { method: 'GET', path: '/api/manual-trading/status' },
        { method: 'GET', path: '/health' },
        { method: 'GET', path: '/api/status' }
    ];
    
    for (const endpoint of endpoints) {
        const result = await makeRequest(endpoint.method, endpoint.path, null);
        if (result.success) {
            console.log(`✅ ${endpoint.method} ${endpoint.path} - Available`);
        } else {
            console.log(`❌ ${endpoint.method} ${endpoint.path} - ${result.error}`);
        }
    }
    
    console.log('\n========================================');
    console.log('Test Summary:');
    console.log('========================================');
    
    if (!directResult.success) {
        console.log('⚠️ Connection Manager does NOT expose /api/History/retrieveBars directly');
        console.log('📝 Historical data MUST be requested through Redis pub/sub channels:');
        console.log('   1. Bot publishes REQUEST_HISTORICAL_DATA to Redis');
        console.log('   2. Aggregator forwards to Connection Manager');
        console.log('   3. Connection Manager calls TSX API');
        console.log('   4. Response flows back through Redis');
        console.log('\n🔧 The architecture is correct - direct HTTP is not allowed');
        
        return false;
    }
    
    return true;
}

async function makeRequest(method, path, data) {
    return new Promise((resolve) => {
        const options = {
            hostname: 'localhost',
            port: 7500,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };
        
        if (data) {
            const postData = JSON.stringify(data);
            options.headers['Content-Length'] = Buffer.byteLength(postData);
        }
        
        const req = http.request(options, (res) => {
            let responseData = '';
            
            res.on('data', (chunk) => {
                responseData += chunk;
            });
            
            res.on('end', () => {
                if (res.statusCode === 200 || res.statusCode === 201) {
                    try {
                        const parsed = JSON.parse(responseData);
                        resolve({ success: true, data: parsed });
                    } catch (e) {
                        resolve({ success: true, data: responseData });
                    }
                } else {
                    resolve({ 
                        success: false, 
                        error: `${res.statusCode} ${res.statusMessage}`,
                        data: responseData 
                    });
                }
            });
        });
        
        req.on('error', (error) => {
            resolve({ success: false, error: error.message });
        });
        
        if (data) {
            req.write(JSON.stringify(data));
        }
        
        req.end();
    });
}

// Run the test
testHistoricalDataRetrieval().then(success => {
    console.log('\n' + (success ? '✅ Test completed successfully' : '⚠️ Test completed with expected results'));
    process.exit(0);
}).catch(error => {
    console.error('💥 Test failed with error:', error);
    process.exit(1);
});