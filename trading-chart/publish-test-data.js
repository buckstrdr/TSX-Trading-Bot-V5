// Test data publisher for trading chart
// Publishes historical-like data to Redis to fill the chart

import Redis from 'ioredis';

async function publishTestData() {
    console.log('📊 Starting test data publisher for trading chart...');
    
    const redis = new Redis({
        host: 'localhost',
        port: 6379
    });

    redis.on('connect', () => {
        console.log('✅ Connected to Redis');
    });

    redis.on('error', (err) => {
        console.error('❌ Redis error:', err.message);
    });

    // Test instrument
    const instrument = 'CON.F.US.MGC.Q25'; // Gold futures
    let basePrice = 2050.00;
    let lastTimestamp = Date.now();
    
    console.log('📈 Publishing test data for instrument:', instrument);
    console.log('⏳ Will publish data every second. Press Ctrl+C to stop.');
    
    // Publish data every second
    setInterval(async () => {
        try {
            // Generate realistic price movement
            const priceChange = (Math.random() - 0.5) * 2; // -1 to +1
            basePrice += priceChange;
            
            // Create market data tick
            const marketData = {
                payload: {
                    instrument: instrument,
                    data: {
                        price: basePrice,
                        bid: basePrice - 0.10,
                        ask: basePrice + 0.10,
                        size: Math.floor(Math.random() * 100) + 1,
                        timestamp: new Date().toISOString(),
                        side: Math.random() > 0.5 ? 'buy' : 'sell'
                    }
                },
                timestamp: new Date().toISOString(),
                correlationId: `test-${Date.now()}`
            };
            
            // Publish to market:data channel
            await redis.publish('market:data', JSON.stringify(marketData));
            
            console.log(`📊 Published: ${instrument} @ $${basePrice.toFixed(2)} (Bid: ${marketData.payload.data.bid.toFixed(2)}, Ask: ${marketData.payload.data.ask.toFixed(2)})`);
            
            // Occasionally publish a trade execution
            if (Math.random() > 0.8) {
                const execution = {
                    payload: {
                        instrument: instrument,
                        symbol: instrument,
                        price: basePrice,
                        quantity: Math.floor(Math.random() * 50) + 1,
                        side: Math.random() > 0.5 ? 'BUY' : 'SELL',
                        timestamp: Date.now(),
                        orderId: `ORDER-${Date.now()}`,
                        accountId: 'TEST-ACCOUNT'
                    },
                    timestamp: new Date().toISOString(),
                    correlationId: `exec-${Date.now()}`
                };
                
                await redis.publish('orders:executions', JSON.stringify(execution));
                console.log(`✅ Published trade execution: ${execution.payload.side} ${execution.payload.quantity} @ $${execution.payload.price.toFixed(2)}`);
            }
            
        } catch (error) {
            console.error('❌ Error publishing data:', error);
        }
    }, 1000);

    // Also publish some historical candles to fill the chart initially
    setTimeout(async () => {
        console.log('📊 Publishing historical candles...');
        
        const now = Date.now();
        const candleCount = 100;
        
        for (let i = candleCount; i > 0; i--) {
            const timestamp = now - (i * 60000); // 1 minute candles going back
            const open = basePrice + (Math.random() - 0.5) * 5;
            const high = open + Math.random() * 2;
            const low = open - Math.random() * 2;
            const close = low + Math.random() * (high - low);
            
            const candleData = {
                payload: {
                    instrument: instrument,
                    data: {
                        price: close,
                        bid: close - 0.10,
                        ask: close + 0.10,
                        size: Math.floor(Math.random() * 100) + 1,
                        timestamp: new Date(timestamp).toISOString(),
                        side: close > open ? 'buy' : 'sell'
                    }
                },
                timestamp: new Date(timestamp).toISOString(),
                correlationId: `hist-${timestamp}`
            };
            
            await redis.publish('market:data', JSON.stringify(candleData));
        }
        
        console.log(`✅ Published ${candleCount} historical data points`);
    }, 2000);

    // Handle shutdown
    process.on('SIGINT', async () => {
        console.log('\n👋 Shutting down test data publisher...');
        await redis.quit();
        process.exit(0);
    });
}

publishTestData().catch(console.error);