import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import twilio from 'twilio';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '.env') });

// Configuration
const config = {
  apiUrl: process.env.API_URL,
  apiMethod: process.env.API_METHOD || 'GET',
  apiHeaders: process.env.API_HEADERS ? JSON.parse(process.env.API_HEADERS) : {},
  apiBody: process.env.API_BODY ? JSON.parse(process.env.API_BODY) : null,
  pollInterval: parseInt(process.env.POLL_INTERVAL || '60000', 10), // Default: 60 seconds
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  serverName: process.env.SERVER || 'Unknown', // Server name for startup message
  targetMovie: process.env.MOVIE_NAME || null, // Movie name to search for
  checkCondition: process.env.CHECK_CONDITION || null, // JavaScript expression to evaluate
  // Twilio configuration
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
  twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER, // Your Twilio phone number
  phoneNumberToCall: process.env.PHONE_NUMBER_TO_CALL, // Phone number to call (your number)
  enablePhoneCall: process.env.ENABLE_PHONE_CALL === 'true', // Enable/disable phone calls
};

// Function to get current time in IST
function getISTTime() {
  const now = new Date();
  const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return istTime.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

// Function to format log messages with IST timestamp and emoji
function logMessage(emoji, message, addSpacing = false) {
  const timestamp = getISTTime();
  const spacing = addSpacing ? '\n' : '';
  console.log(`${spacing}${emoji} [${timestamp}] ${message}\n`);
}

// Validate configuration
if (!config.apiUrl) {
  logMessage('❌', 'Error: API_URL is required in .env file');
  process.exit(1);
}

if (!config.telegramToken || !config.telegramChatId) {
  logMessage('❌', 'Error: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required in .env file');
  process.exit(1);
}

// Initialize Telegram bot
const bot = new TelegramBot(config.telegramToken, { polling: false });

// Function to extract movies from response
function getMovies(responseData) {
  try {
    if (responseData?.output?.mv && Array.isArray(responseData.output.mv)) {
      return responseData.output.mv;
    }
    return [];
  } catch (error) {
    return [];
  }
}

// Function to get all film names from movies
function getAllFilmNames(movies) {
  const filmNames = new Set();
  movies.forEach(movie => {
    if (movie.filmName) {
      filmNames.add(movie.filmName);
    }
    if (movie.films && Array.isArray(movie.films)) {
      movie.films.forEach(film => {
        if (film.filmName) {
          filmNames.add(film.filmName);
        }
      });
    }
  });
  return Array.from(filmNames);
}

// Function to check if condition is met
function checkCondition(responseData) {
  try {
    const movies = getMovies(responseData);
    const filmNames = getAllFilmNames(movies);

    // Determine the condition to evaluate
    let conditionToEvaluate = config.checkCondition;

    // If no condition is set, use default based on targetMovie
    if (!conditionToEvaluate) {
      if (config.targetMovie) {
        // If targetMovie is set, check if it exists
        conditionToEvaluate = 'hasFilm(targetMovie)';
      } else {
        // Default: check if any movies are available
        conditionToEvaluate = 'movies.length > 0';
      }
    }

    // Create a safe evaluation context
    const context = {
      data: responseData,
      response: responseData,
      status: responseData?.status,
      output: responseData?.output,
      movies: movies,
      filmNames: filmNames,
      targetMovie: config.targetMovie, // Make targetMovie available in condition
      // Add common checks
      includes: (str, search) => String(str).includes(search),
      equals: (a, b) => a === b,
      greaterThan: (a, b) => a > b,
      lessThan: (a, b) => a < b,
      // Helper to check if a film name contains a string
      hasFilm: (search) => filmNames.some(name => String(name).toLowerCase().includes(String(search).toLowerCase())),
    };

    // Evaluate the condition
    const func = new Function(...Object.keys(context), `return ${conditionToEvaluate}`);
    return func(...Object.values(context));
  } catch (error) {
    logMessage('⚠️', `Error evaluating condition: ${error.message}`);
    return false;
  }
}

// Function to ping API
async function pingAPI() {
  try {
    const requestConfig = {
      method: config.apiMethod,
      url: config.apiUrl,
      headers: {
        ...config.apiHeaders,
      },
    };

    // Set Content-Type if not already in headers
    if (!requestConfig.headers['content-type'] && !requestConfig.headers['Content-Type']) {
      requestConfig.headers['Content-Type'] = 'application/json';
    }

    if (config.apiBody && (config.apiMethod === 'POST' || config.apiMethod === 'PUT' || config.apiMethod === 'PATCH')) {
      requestConfig.data = config.apiBody;
    }

    const response = await axios(requestConfig);
    return {
      success: true,
      status: response.status,
      data: response.data,
      headers: response.headers,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      status: error.response?.status,
      data: error.response?.data,
    };
  }
}

// Function to send Telegram notification
async function sendTelegramNotification(message) {
  try {
    await bot.sendMessage(config.telegramChatId, message, {
      parse_mode: 'Markdown',
    });
    logMessage('✅', 'Telegram notification sent successfully');
  } catch (error) {
    logMessage('❌', `Error sending Telegram notification: ${error.message}`);
  }
}

// Function to make phone call via Twilio
async function makePhoneCall() {
  if (!config.enablePhoneCall) {
    return;
  }

  if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioPhoneNumber || !config.phoneNumberToCall) {
    logMessage('⚠️', 'Twilio credentials not configured. Skipping phone call.');
    return;
  }

  try {
    const client = twilio(config.twilioAccountSid, config.twilioAuthToken);

    // Create a TwiML response
    // The call will ring your phone. If you don't answer, it will hang up (or go to voicemail if enabled)
    // If you want a message when answered, change to: '<Response><Say voice="alice">Spider Tracker Alert. Your target movie has been found.</Say><Hangup/></Response>'
    // For just a ring (no message), we hang up immediately if answered
    const call = await client.calls.create({
      twiml: '<Response><Hangup/></Response>', // Just rings - hangs up immediately if answered
      to: config.phoneNumberToCall,
      from: config.twilioPhoneNumber,
    });

    logMessage('📞', `Phone call initiated. Call SID: ${call.sid}`);
  } catch (error) {
    logMessage('❌', `Error making phone call: ${error.message}`);
  }
}

// Main monitoring function
async function monitor() {
  logMessage('🔍', `Checking API: ${config.apiUrl}`, true);

  const result = await pingAPI();

  if (!result.success) {
    const errorMessage = `❌ *API Error*\n\n` +
      `URL: ${config.apiUrl}\n` +
      `Status: ${result.status || 'N/A'}\n` +
      `Error: ${result.error}\n` +
      `Time: ${new Date().toISOString()}`;

    await sendTelegramNotification(errorMessage);
    return;
  }

  // Check if condition is met
  const conditionMet = checkCondition(result.data);

  if (conditionMet) {
    const movies = getMovies(result.data);
    const filmNames = getAllFilmNames(movies);

    // Check if target movie was found
    const targetMovieFound = config.targetMovie &&
      filmNames.some(name => String(name).toLowerCase().includes(String(config.targetMovie).toLowerCase()));

    // Format movie information
    let movieInfo = '';
    if (targetMovieFound) {
      movieInfo = `\n🎯 *TARGET MOVIE FOUND!*\n\n`;
      const matchingMovies = filmNames.filter(name =>
        String(name).toLowerCase().includes(String(config.targetMovie).toLowerCase())
      );
      matchingMovies.forEach((name) => {
        movieInfo += `✅ ${name}\n`;
      });
    }

    const message = `🎬 *PVR Cinema Update*\n\n` +
      `*Status:* ${result.data?.result || 'Unknown'}\n` +
      (config.targetMovie ? `*Tracking:* ${config.targetMovie}\n` : '') +
      movieInfo +
      `\n*Time:* ${new Date().toLocaleString()}\n` +
      `*API Status:* ${result.status}`;

    await sendTelegramNotification(message);

    // Make phone call if enabled
    await makePhoneCall();

    const statusMsg = targetMovieFound
      ? `🎯 TARGET MOVIE FOUND! Notification sent (${movies.length} movies, ${filmNames.length} unique film names)`
      : `✅ Condition met - notification sent (${movies.length} movies, ${filmNames.length} unique film names)`;
    logMessage('📬', statusMsg);
  } else {
    const movies = getMovies(result.data);
    logMessage('⏭️', `Condition not met - ${movies.length} movies found, no notification sent`);
  }
}

// Function to send startup message
async function sendStartupMessage() {
  const timestamp = getISTTime();
  const movieName = config.targetMovie || 'None';

  const startupMessage = `Spider-Tracker is now live 🚀\n\n` +
    `📅 Time: ${timestamp}\n` +
    `🌐 Server: ${config.serverName}\n` +
    `📊 Movie being tracked: ${movieName}`;

  try {
    await bot.sendMessage(config.telegramChatId, startupMessage, {
      parse_mode: 'Markdown',
    });
    logMessage('✅', 'Startup message sent successfully');
  } catch (error) {
    logMessage('❌', `Error sending startup message: ${error.message}`);
  }
}

// Start monitoring
console.log('\n' + '='.repeat(60));
logMessage('🚀', 'Starting Spider-Tracker API Monitor...', false);
console.log('='.repeat(60) + '\n');

logMessage('🌐', `API URL: ${config.apiUrl}`);
logMessage('⏱️', `Poll Interval: ${config.pollInterval / 1000} seconds`);
logMessage('🖥️', `Server: ${config.serverName}`);
if (config.targetMovie) {
  logMessage('🎬', `Target Movie: ${config.targetMovie}`);
}
logMessage('🔎', `Check Condition: ${config.checkCondition || (config.targetMovie ? `hasFilm('${config.targetMovie}')` : 'movies.length > 0')}`);

console.log('\n' + '-'.repeat(60) + '\n');

// Send startup message and then start monitoring
(async () => {
  await sendStartupMessage();

  // Run immediately after startup message is sent, then on interval
  monitor();
  setInterval(monitor, config.pollInterval);
})();

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n' + '='.repeat(60));
  logMessage('👋', 'Shutting down gracefully...');
  console.log('='.repeat(60) + '\n');
  process.exit(0);
});

