# TopStepX User API Documentation

**Version:** 1.0.0  
**Base URL:** https://userapi.topstepx.com  
**Protocol:** HTTPS  
**Specification:** OAS 2.0

## Overview

ProjectX User API Documentation and specification for TopStepX trading platform integration.

## Authentication

All API endpoints require Bearer token authentication:
```
Authorization: Bearer {token}
```

## Statistics Endpoints

### POST /Statistics/lifetimestats

Retrieves lifetime trading statistics for a trading account.

**Request:**
```http
POST https://userapi.topstepx.com/Statistics/lifetimestats
Content-Type: application/json
Authorization: Bearer {token}

{
  "tradingAccountId": 9627376
}
```

**Parameters:**
- `tradingAccountId` (number, required): The trading account ID

**Response:**
```json
[
  {
    "totalTrades": 0,
    "winRate": 0.0,
    "totalPnL": 0.0,
    "profitFactor": 0.0,
    "averageWin": 0.0,
    "averageLoss": 0.0,
    "grossProfit": 0.0,
    "grossLoss": 0.0,
    "winningTrades": 0,
    "losingTrades": 0,
    "largestWin": 0.0,
    "largestLoss": 0.0
  }
]
```

### POST /Statistics/todaystats

Retrieves today's trading statistics for a trading account.

**Request:**
```http
POST https://userapi.topstepx.com/Statistics/todaystats?accountId=9627376
Content-Type: application/json
Authorization: Bearer {token}

{}
```

**Parameters:**
- `accountId` (query parameter): The trading account ID

**Response:**
```json
[
  {
    "dailyPnL": 0.0,
    "totalTrades": 0,
    "winRate": 0.0,
    "profitFactor": 0.0,
    "averageWin": 0.0,
    "averageLoss": 0.0,
    "grossProfit": 0.0,
    "grossLoss": 0.0
  }
]
```

### Other Statistics Endpoints

- `POST /Statistics/monthly` - Monthly statistics
- `POST /Statistics/weekly` - Weekly statistics  
- `POST /Statistics/daily` - Daily statistics
- `POST /Statistics/profitFactor` - Profit factor data
- `POST /Statistics/daystats` - Day-specific statistics
- `POST /Statistics/daytrades` - Trades for specific day
- `POST /Statistics/trades` - Trades for date range
- `POST /Statistics/winlossavg` - Win/loss averages

## Trading Account Endpoints

### GET /TradingAccount

Retrieves all accounts associated with the current user.

**Request:**
```http
GET https://userapi.topstepx.com/TradingAccount
Authorization: Bearer {token}
```

## Order Management

### POST /Order

Places a trading order.

**Request:**
```http
POST https://userapi.topstepx.com/Order
Content-Type: application/json
Authorization: Bearer {token}

{
  "accountId": 9627376,
  "symbolId": "MES",
  "side": "BUY",
  "orderType": "MARKET",
  "quantity": 1
}
```

### GET /Order

Retrieves recent orders for an account.

**Request:**
```http
GET https://userapi.topstepx.com/Order?accountId=9627376
Authorization: Bearer {token}
```

## Position Management

### GET /Position

Retrieves open positions for an account.

**Request:**
```http
GET https://userapi.topstepx.com/Position?accountId=9627376
Authorization: Bearer {token}
```

### DELETE /Position/close/{accountId}

Closes all open positions for an account.

## Authentication Endpoints

### POST /Login/key

Authenticates using API key.

**Request:**
```http
POST https://userapi.topstepx.com/Login/key
Content-Type: application/json

{
  "userName": "username",
  "apiKey": "api-key"
}
```

**Response:**
```
Bearer-token-string
```

## Error Handling

API returns standard HTTP status codes:
- `200` - Success
- `400` - Bad Request
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `500` - Internal Server Error

## Data Models

### Statistics Models
- `CompleteDayStatistic`
- `ProductStatistic` 
- `DayStatistic`
- `ProfitFactorData`
- `TradeSummary`
- `AverageWinLossData`

### Trading Models
- `OrderModel`
- `PositionModel`
- `TradeModel`
- `TradingAccountModel`

### User Models
- `UserModel`
- `LoginResultModel`
- `TradingAccountResult`

## Rate Limits

API requests are subject to rate limiting. Implement appropriate retry logic with exponential backoff.

## Important Notes

1. **Account ID Format**: Trading account IDs should be passed as numbers, not strings
2. **Date Handling**: All timestamps are in UTC
3. **Decimal Precision**: Financial values use appropriate decimal precision for currency
4. **Authentication**: Tokens have expiration times and should be refreshed as needed
5. **Statistics API**: Returns arrays even for single account queries
6. **Query vs Body Parameters**: Some endpoints use query parameters (todaystats), others use request body (lifetimestats)

## Example Integration

```javascript
// Authentication
const authResponse = await axios.post('https://userapi.topstepx.com/Login/key', {
  userName: 'your-username',
  apiKey: 'your-api-key'
});
const token = authResponse.data;

// Get lifetime statistics
const statsResponse = await axios.post('https://userapi.topstepx.com/Statistics/lifetimestats', {
  tradingAccountId: 9627376
}, {
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
});

console.log('Lifetime Stats:', statsResponse.data);
```

---

*Generated from TopStepX Swagger Documentation: https://userapi.topstepx.com/swagger/index.html*