# Spider Movie Tracker

A Node.js application that monitors an API endpoint and sends Telegram notifications when specific conditions are met.

## Features

- 🔄 Polls an API endpoint at configurable intervals
- 📱 Sends Telegram notifications when conditions are met
- ⚙️ Configurable via environment variables
- 🎯 Custom condition checking using JavaScript expressions
- 📊 Supports GET, POST, PUT, PATCH requests
- 🛡️ Error handling and logging

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` and configure the following:

#### API Configuration
- `API_URL`: The API endpoint to monitor (required)
- `API_METHOD`: HTTP method (GET, POST, PUT, PATCH) - default: GET
- `API_HEADERS`: JSON object with custom headers (optional)
- `API_BODY`: JSON object for request body (optional, for POST/PUT/PATCH)

#### Polling Configuration
- `POLL_INTERVAL`: Time between API checks in milliseconds (default: 60000 = 60 seconds)

#### Telegram Configuration
- `TELEGRAM_BOT_TOKEN`: Your Telegram bot token (get from [@BotFather](https://t.me/BotFather))
- `TELEGRAM_CHAT_ID`: Your Telegram chat ID (get from [@userinfobot](https://t.me/userinfobot))

#### Movie Tracking Configuration
- `MOVIE_NAME`: (Optional) The name of the movie to track. If set, the app will automatically notify you when this movie is found. This is case-insensitive and will match if the movie name contains this text.
  - Example: `MOVIE_NAME=Spider-Man`
  - If `MOVIE_NAME` is set and `CHECK_CONDITION` is empty, it will automatically check for the movie
  - You can still use `CHECK_CONDITION` for more complex logic even if `MOVIE_NAME` is set

#### Condition Configuration
- `CHECK_CONDITION`: (Optional) JavaScript expression to evaluate. If not set and `MOVIE_NAME` is provided, it will automatically check for that movie.
  
  Available variables:
  - `data` - Full API response
  - `status` - HTTP status code
  - `output` - Response output object
  - `movies` - Array of movies from `output.mv`
  - `filmNames` - Array of all unique film names
  - `targetMovie` - The value of `MOVIE_NAME` from .env
  - Helper functions: `includes()`, `equals()`, `greaterThan()`, `lessThan()`, `hasFilm(search)`
  
  Examples for PVR API:
  - `hasFilm(targetMovie)` - Check for the movie specified in MOVIE_NAME (automatic if MOVIE_NAME is set)
  - `movies.length > 0` - Notify when any movies are available
  - `hasFilm('Spider-Man')` - Notify when a specific movie is found (case-insensitive)
  - `filmNames.some(name => includes(name, 'Spider'))` - Notify when movie name contains text
  - `movies.length > 5` - Notify when more than 5 movies are available
  - `true` - Always notify

### 3. Get Telegram Bot Token

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the instructions
3. Copy the bot token and add it to `.env` as `TELEGRAM_BOT_TOKEN`

### 4. Get Your Chat ID

1. Open Telegram and search for [@userinfobot](https://t.me/userinfobot)
2. Start a conversation - it will reply with your chat ID
3. Copy the chat ID and add it to `.env` as `TELEGRAM_CHAT_ID`

### 5. Start the Application

```bash
npm start
```

For development with auto-reload:

```bash
npm run dev
```

## Example Configuration

### Example 1: Monitor a REST API for new items

```env
API_URL=https://api.example.com/items
API_METHOD=GET
POLL_INTERVAL=30000
CHECK_CONDITION=Array.isArray(data) && data.length > 0
```

### Example 2: Monitor API status

```env
API_URL=https://api.example.com/health
API_METHOD=GET
POLL_INTERVAL=60000
CHECK_CONDITION=data.status !== 'healthy'
```

### Example 3: Monitor with POST request

```env
API_URL=https://api.example.com/search
API_METHOD=POST
API_BODY={"query": "test"}
POLL_INTERVAL=60000
CHECK_CONDITION=data.results && data.results.length > 5
```

## How It Works

1. The application polls the configured API endpoint at the specified interval
2. It evaluates the response against the `CHECK_CONDITION` expression
3. If the condition is met (evaluates to `true`), it sends a Telegram notification
4. If there's an API error, it also sends a notification

## Condition Expression Examples

The `CHECK_CONDITION` is a JavaScript expression that has access to:
- `data`: The full API response data
- `status`: The HTTP status code
- `output`: The response output object
- `movies`: Array of movies from `output.mv`
- `filmNames`: Array of all unique film names extracted from movies
- Helper functions: `includes()`, `equals()`, `greaterThan()`, `lessThan()`, `hasFilm(search)`

Examples for PVR Cinema API:
```javascript
// Check if any movies are available
movies.length > 0

// Check if a specific movie is available (case-insensitive)
hasFilm('Spider-Man')
hasFilm('spider')

// Check if movie name contains specific text
filmNames.some(name => includes(name, 'Spider-Man'))

// Check if more than a certain number of movies
movies.length > 5

// Check if specific movie exists with exact match
filmNames.includes('SPIDER-MAN: NO WAY HOME (ENGLISH) (UA 13+)')

// Complex condition - check status and movie availability
status === 200 && result === 'success' && movies.length > 0
```

## License

MIT

