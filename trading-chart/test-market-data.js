import Redis from 'ioredis';

const redis = new Redis({
    host: '127.0.0.1',
    port: 6379
});

// Function to generate random price movement
function generatePrice(basePrice, volatility = 0.001) {
    const change = (Math.random() - 0.5) * 2 * volatility;
    return basePrice * (1 + change);
}

// Simulate market data for testing
async function simulateMarketData() {
    console.log('Starting market data simulation...');
    
    let price = 100;
    const symbol = 'AAPL';
    
    setInterval(async () => {
        price = generatePrice(price);
        
        const marketData = {
            action: 'market-data',
            source: 'test-simulator',
            timestamp: new Date().toISOString(),
            payload: {
                instrument: symbol,
                data: {
                    price: price,
                    bid: price - 0.01,
                    ask: price + 0.01,
                    size: Math.floor(Math.random() * 1000) + 100,
                    timestamp: new Date().toISOString(),
                    side: Math.random() > 0.5 ? 'buy' : 'sell'
                }
            }
        };
        
        try {
            await redis.publish('market:data', JSON.stringify(marketData));
            console.log(`Published: ${symbol} @ $${price.toFixed(2)}`);
        } catch (error) {
            console.error('Error publishing:', error);
        }
    }, 1000); // Publish every second
    
    // Also simulate some trade executions
    setInterval(async () => {
        const execution = {
            action: 'trade-execution',
            source: 'test-simulator',
            timestamp: new Date().toISOString(),
            payload: {
                instrument: symbol,
                price: price,
                quantity: Math.floor(Math.random() * 100) + 10,
                side: Math.random() > 0.5 ? 'buy' : 'sell',
                timestamp: new Date().toISOString(),
                orderId: Math.random().toString(36).substring(7)
            }
        };
        
        try {
            await redis.publish('orders:executions', JSON.stringify(execution));
            console.log(`Trade executed: ${execution.payload.side} ${execution.payload.quantity} @ $${price.toFixed(2)}`);
        } catch (error) {
            console.error('Error publishing trade:', error);
        }
    }, 5000); // Trade every 5 seconds
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down market data simulator...');
    redis.disconnect();
    process.exit(0);
});

// Start simulation
simulateMarketData().catch(console.error);