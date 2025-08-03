// Fetch and publish historical data from Connection Manager
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

async function fetchHistoricalData() {
    console.log('📊 Historical Data Fetcher for Trading Chart');
    console.log('==========================================\n');
    
    const redis = new Redis({
        host: 'localhost',
        port: 6379
    });
    
    const subscriber = new Redis({
        host: 'localhost',
        port: 6379
    });

    // Default parameters
    const instrument = process.argv[2] || 'CON.F.US.MGC.Q25';
    const timeframe = process.argv[3] || '1m';
    const barsCount = parseInt(process.argv[4]) || 1000;
    
    console.log('📈 Requesting historical data:');
    console.log(`   Instrument: ${instrument}`);
    console.log(`   Timeframe: ${timeframe}`);
    console.log(`   Bars: ${barsCount}`);
    
    // Subscribe to response channel
    await subscriber.subscribe('historical:data:response');
    
    // Create request
    const request = {
        requestId: uuidv4(),
        instanceId: 'CHART_HISTORICAL_FETCHER',
        instrument: instrument,
        timeframe: timeframe,
        barsCount: barsCount,
        timestamp: new Date().toISOString()
    };
    
    console.log('\n📤 Sending request to Connection Manager...');
    
    // Set up response handler
    const responsePromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Timeout waiting for historical data response'));
        }, 10000);
        
        subscriber.on('message', async (channel, message) => {
            try {
                const response = JSON.parse(message);
                
                if (response.requestId === request.requestId) {
                    clearTimeout(timeout);
                    
                    if (response.success && response.data) {
                        console.log(`✅ Received ${response.data.length} historical bars`);
                        
                        // Publish each bar as market data
                        console.log('\n📊 Publishing historical data to chart...');
                        
                        for (const bar of response.data) {
                            const marketData = {
                                payload: {
                                    instrument: instrument,
                                    data: {
                                        price: bar.close,
                                        bid: bar.close - 0.10,
                                        ask: bar.close + 0.10,
                                        size: bar.volume || 100,
                                        timestamp: new Date(bar.timestamp).toISOString(),
                                        side: bar.close > bar.open ? 'buy' : 'sell',
                                        // Include OHLC data
                                        open: bar.open,
                                        high: bar.high,
                                        low: bar.low,
                                        close: bar.close
                                    }
                                },
                                timestamp: new Date(bar.timestamp).toISOString(),
                                correlationId: `hist-${bar.timestamp}`
                            };
                            
                            await redis.publish('market:data', JSON.stringify(marketData));
                        }
                        
                        console.log(`✅ Published ${response.data.length} historical data points`);
                        resolve(response.data);
                    } else {
                        reject(new Error(response.error || 'Failed to fetch historical data'));
                    }
                }
            } catch (error) {
                console.error('❌ Error processing response:', error);
            }
        });
    });
    
    // Send request
    await redis.publish('system:events', JSON.stringify({
        type: 'REQUEST_HISTORICAL_DATA',
        ...request
    }));
    
    try {
        const data = await responsePromise;
        
        console.log('\n📊 Historical Data Summary:');
        console.log(`   First bar: ${new Date(data[0].timestamp).toLocaleString()}`);
        console.log(`   Last bar: ${new Date(data[data.length - 1].timestamp).toLocaleString()}`);
        console.log(`   Price range: $${Math.min(...data.map(d => d.low)).toFixed(2)} - $${Math.max(...data.map(d => d.high)).toFixed(2)}`);
        
        console.log('\n✅ Historical data loaded successfully!');
        console.log('📈 Your chart should now display the historical data.');
        
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        console.log('\n💡 Make sure:');
        console.log('   1. Connection Manager is running');
        console.log('   2. You have valid TopStep credentials');
        console.log('   3. The instrument symbol is correct');
    }
    
    await redis.quit();
    await subscriber.quit();
}

// Show usage if --help
if (process.argv.includes('--help')) {
    console.log('Usage: node fetch-historical-data.js [instrument] [timeframe] [bars]');
    console.log('');
    console.log('Examples:');
    console.log('  node fetch-historical-data.js                           # Uses defaults');
    console.log('  node fetch-historical-data.js CON.F.US.MGC.Q25 1m 500  # Gold, 1 min, 500 bars');
    console.log('  node fetch-historical-data.js CON.F.US.MES.H25 5m 200  # ES, 5 min, 200 bars');
    process.exit(0);
}

fetchHistoricalData().catch(console.error);