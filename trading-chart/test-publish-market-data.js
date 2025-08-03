// Test publishing market data in the exact format that ConnectionManager sends
import Redis from 'ioredis';

async function publishTestData() {
    const redis = new Redis({
        host: 'localhost',
        port: 6379
    });

    redis.on('connect', () => {
        console.log('✅ Connected to Redis');
    });

    // Publish a few test messages in the exact format from ConnectionManager
    const testMessages = [
        {
            type: 'MARKET_DATA',
            payload: {
                instrument: 'CON.F.US.MNQ.U25',
                type: 'QUOTE',
                data: {
                    bid: 23493.5,
                    ask: 23494,
                    bidSize: 1,
                    askSize: 1,
                    timestamp: new Date().toISOString()
                }
            },
            timestamp: Date.now()
        },
        {
            type: 'MARKET_DATA',
            payload: {
                instrument: 'CON.F.US.MNQ.U25',
                type: 'TRADE',
                data: {
                    price: 23493.75,
                    size: 2,
                    side: 'BUY',
                    timestamp: new Date().toISOString()
                }
            },
            timestamp: Date.now()
        },
        {
            type: 'MARKET_DATA',
            payload: {
                instrument: 'CON.F.US.MGC.Q25',
                type: 'QUOTE',
                data: {
                    bid: 3333.3,
                    ask: 3333.5,
                    timestamp: new Date().toISOString()
                }
            },
            timestamp: Date.now()
        },
        {
            type: 'MARKET_DATA',
            payload: {
                instrument: 'CON.F.US.MGC.Q25',
                type: 'TRADE',
                data: {
                    price: 3333.4,
                    size: 1,
                    side: 'SELL',
                    timestamp: new Date().toISOString()
                }
            },
            timestamp: Date.now()
        }
    ];

    console.log('📊 Publishing test market data...');
    
    for (const message of testMessages) {
        const channel = 'market:data';
        const data = JSON.stringify(message);
        
        console.log(`Publishing to ${channel}:`, {
            instrument: message.payload.instrument,
            type: message.payload.type,
            price: message.payload.data.price || `${message.payload.data.bid}/${message.payload.data.ask}`
        });
        
        await redis.publish(channel, data);
        
        // Wait a bit between messages
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log('✅ Test data published');
    
    setTimeout(() => {
        redis.quit();
        process.exit(0);
    }, 1000);
}

publishTestData().catch(console.error);