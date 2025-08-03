// Diagnostic tool to check data flow between components
import Redis from 'ioredis';
import axios from 'axios';

async function diagnoseDataFlow() {
    console.log('🔍 Trading Chart Data Flow Diagnostic Tool');
    console.log('=========================================\n');
    
    const results = {
        redis: false,
        chartServer: false,
        connectionManager: false,
        dataFlow: false
    };
    
    // 1. Check Redis connection
    console.log('1️⃣ Checking Redis connection...');
    const redis = new Redis({
        host: 'localhost',
        port: 6379,
        connectTimeout: 5000
    });
    
    try {
        await redis.ping();
        console.log('✅ Redis is running and accessible');
        results.redis = true;
    } catch (error) {
        console.error('❌ Redis is not accessible:', error.message);
        console.log('   Fix: Make sure Redis is running (redis-server)');
    }
    
    // 2. Check Chart Server
    console.log('\n2️⃣ Checking Trading Chart Server...');
    try {
        const response = await axios.get('http://localhost:4675/health', { timeout: 5000 });
        console.log('✅ Chart server is running on port 4675');
        console.log('   Redis subscriber:', response.data.services.redis ? '✅ Healthy' : '❌ Not connected');
        console.log('   WebSocket clients:', response.data.services.websocket.clients);
        results.chartServer = true;
    } catch (error) {
        console.error('❌ Chart server is not accessible');
        console.log('   Fix: Start the chart server with: npm run dev (in trading-chart folder)');
    }
    
    // 3. Check Connection Manager
    console.log('\n3️⃣ Checking Connection Manager...');
    try {
        const response = await axios.get('http://localhost:7500/status', { timeout: 5000 });
        console.log('✅ Connection Manager is running on port 7500');
        console.log('   Market data connected:', response.data.services?.marketData?.connected || false);
        console.log('   Active instruments:', response.data.services?.marketData?.subscribedInstruments?.join(', ') || 'None');
        results.connectionManager = true;
    } catch (error) {
        console.error('❌ Connection Manager is not accessible');
        console.log('   Fix: Start the Connection Manager from the main bot directory');
    }
    
    // 4. Check actual data flow
    console.log('\n4️⃣ Checking data flow on Redis channels...');
    if (results.redis) {
        const subscriber = new Redis();
        let dataReceived = false;
        
        console.log('   Listening for 5 seconds on market:data channel...');
        
        await subscriber.subscribe('market:data');
        
        const timeout = setTimeout(() => {
            if (!dataReceived) {
                console.log('❌ No data received on market:data channel');
                console.log('   This means either:');
                console.log('   - Connection Manager is not publishing data');
                console.log('   - Market is closed (no live data)');
                console.log('   - No instruments are subscribed');
            }
            subscriber.quit();
        }, 5000);
        
        subscriber.on('message', (channel, message) => {
            dataReceived = true;
            clearTimeout(timeout);
            console.log('✅ Data is flowing on market:data channel!');
            try {
                const data = JSON.parse(message);
                console.log('   Sample data:', {
                    instrument: data.payload?.instrument || data.instrument,
                    price: data.payload?.data?.price || data.data?.price,
                    timestamp: data.timestamp
                });
            } catch (e) {
                console.log('   Raw message:', message.substring(0, 100) + '...');
            }
            results.dataFlow = true;
            subscriber.quit();
        });
        
        await new Promise(resolve => setTimeout(resolve, 5100));
    }
    
    // Summary
    console.log('\n📊 DIAGNOSTIC SUMMARY');
    console.log('====================');
    console.log(`Redis:              ${results.redis ? '✅ Working' : '❌ Not working'}`);
    console.log(`Chart Server:       ${results.chartServer ? '✅ Running' : '❌ Not running'}`);
    console.log(`Connection Manager: ${results.connectionManager ? '✅ Running' : '❌ Not running'}`);
    console.log(`Data Flow:          ${results.dataFlow ? '✅ Active' : '❌ No data'}`);
    
    if (!results.dataFlow) {
        console.log('\n🔧 RECOMMENDED ACTIONS:');
        if (!results.redis) {
            console.log('1. Start Redis: redis-server');
        }
        if (!results.chartServer) {
            console.log('2. Start Chart Server: cd trading-chart && npm run dev');
        }
        if (!results.connectionManager) {
            console.log('3. Start Connection Manager from main bot directory');
        }
        if (results.redis && results.chartServer && !results.dataFlow) {
            console.log('4. Run test data publisher: node publish-test-data.js');
            console.log('   OR');
            console.log('   Wait for market to open for live data');
        }
    } else {
        console.log('\n✅ Everything is working! Your chart should be receiving data.');
    }
    
    await redis.quit();
}

diagnoseDataFlow().catch(console.error);