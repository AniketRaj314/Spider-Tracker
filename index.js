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
  targetMovie: process.env.MOVIE_NAME || null, // Movie name to search for (legacy support)
  movieKeywords: process.env.MOVIE_KEYWORDS ? JSON.parse(process.env.MOVIE_KEYWORDS) : null, // Array of keyword sets: [["keyword1", "keyword2"], ["keyword3"]]
  cinemaKeywords: process.env.CINEMA_KEYWORDS ? JSON.parse(process.env.CINEMA_KEYWORDS) : null, // Array of keyword sets for cinema names: [["Mall", "Asia"], ["PVR"]]
  checkCondition: process.env.CHECK_CONDITION || null, // JavaScript expression to evaluate
  // Theater listings API
  theaterListingsApiUrl: process.env.THEATER_LISTINGS_API_URL || 'https://api3.pvrcinemas.com/api/v1/booking/content/msessions',
  theaterListingsApiHeaders: process.env.THEATER_LISTINGS_API_HEADERS ? JSON.parse(process.env.THEATER_LISTINGS_API_HEADERS) : {},
  theaterListingsApiBody: process.env.THEATER_LISTINGS_API_BODY ? JSON.parse(process.env.THEATER_LISTINGS_API_BODY) : null,
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

// Track which matches have already triggered a phone call
// Key format: "filmCode1,filmCode2|theater1,theater2" or just "filmCode1" for legacy
const phoneCallMade = new Set();

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

// Function to check if a keyword set matches any film name
// Returns the matching film names if all keywords in the set are found
function checkKeywordSet(keywordSet, filmNames) {
  if (!Array.isArray(keywordSet) || keywordSet.length === 0) {
    return [];
  }

  const matchingFilms = [];

  // Check each film name
  filmNames.forEach(filmName => {
    const filmNameLower = String(filmName).toLowerCase();

    // Check if ALL keywords in the set are present in this film name
    const allKeywordsFound = keywordSet.every(keyword =>
      filmNameLower.includes(String(keyword).toLowerCase())
    );

    if (allKeywordsFound) {
      matchingFilms.push(filmName);
    }
  });

  return matchingFilms;
}

// Function to check if any keyword set matches
// Returns array of { keywordSet, matchingFilms } for all matching sets
function checkKeywordSets(keywordSets, filmNames) {
  if (!Array.isArray(keywordSets) || keywordSets.length === 0) {
    return [];
  }

  const matches = [];

  keywordSets.forEach((keywordSet, index) => {
    const matchingFilms = checkKeywordSet(keywordSet, filmNames);
    if (matchingFilms.length > 0) {
      matches.push({
        keywordSet: keywordSet,
        matchingFilms: matchingFilms,
        setIndex: index
      });
    }
  });

  return matches;
}

// Function to check if condition is met
function checkCondition(responseData) {
  try {
    const movies = getMovies(responseData);
    const filmNames = getAllFilmNames(movies);

    // Determine the condition to evaluate
    let conditionToEvaluate = config.checkCondition;

    // If no condition is set, use default based on keyword sets or targetMovie
    if (!conditionToEvaluate) {
      if (config.movieKeywords && Array.isArray(config.movieKeywords) && config.movieKeywords.length > 0) {
        // Use keyword sets - check if any set matches
        const matches = checkKeywordSets(config.movieKeywords, filmNames);
        return matches.length > 0;
      } else if (config.targetMovie) {
        // Legacy: If targetMovie is set, check if it exists
        conditionToEvaluate = 'hasFilm(targetMovie)';
      } else {
        // Default: check if any movies are available
        conditionToEvaluate = 'movies.length > 0';
      }
    }

    // If we already handled keyword sets above, return the result
    if (config.movieKeywords && !conditionToEvaluate) {
      const matches = checkKeywordSets(config.movieKeywords, filmNames);
      return matches.length > 0;
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

// Function to get matching keyword sets and films
function getMatchingKeywordSets(responseData) {
  try {
    const movies = getMovies(responseData);
    const filmNames = getAllFilmNames(movies);

    if (config.movieKeywords && Array.isArray(config.movieKeywords) && config.movieKeywords.length > 0) {
      return checkKeywordSets(config.movieKeywords, filmNames);
    }

    return [];
  } catch (error) {
    return [];
  }
}

// Function to extract filmCommonCode and releaseDate from matched movies
function extractFilmInfo(movies, matchingFilms) {
  const filmInfoMap = new Map(); // Map of filmCommonCode -> releaseDate

  movies.forEach(movie => {
    // Check if this movie's filmName matches any of the matching films
    if (matchingFilms.some(mf => movie.filmName && movie.filmName === mf)) {
      // Get releaseDate from movie level
      const releaseDate = movie.releaseDate || (movie.year && movie.month && movie.day
        ? formatDateFromParts(movie.year, movie.month, movie.day)
        : null);

      if (movie.films && Array.isArray(movie.films)) {
        movie.films.forEach(film => {
          if (film.filmCommonCode) {
            const filmReleaseDate = film.releaseDate || releaseDate;
            if (!filmInfoMap.has(film.filmCommonCode) || !filmInfoMap.get(film.filmCommonCode)) {
              filmInfoMap.set(film.filmCommonCode, filmReleaseDate);
            }
          }
        });
      }
    }

    // Also check films array
    if (movie.films && Array.isArray(movie.films)) {
      movie.films.forEach(film => {
        if (film.filmName && matchingFilms.includes(film.filmName) && film.filmCommonCode) {
          const filmReleaseDate = film.releaseDate || movie.releaseDate ||
            (movie.year && movie.month && movie.day
              ? formatDateFromParts(movie.year, movie.month, movie.day)
              : null);
          if (!filmInfoMap.has(film.filmCommonCode) || !filmInfoMap.get(film.filmCommonCode)) {
            filmInfoMap.set(film.filmCommonCode, filmReleaseDate);
          }
        }
      });
    }
  });

  return Array.from(filmInfoMap.entries()).map(([code, date]) => ({ code, releaseDate: date }));
}

// Function to format date from year, month, day parts
function formatDateFromParts(year, month, day) {
  const monthStr = String(month).padStart(2, '0');
  const dayStr = String(day).padStart(2, '0');
  return `${year}-${monthStr}-${dayStr}`;
}

// Function to convert releaseDate string to YYYY-MM-DD format
function convertReleaseDateToAPIFormat(releaseDateStr) {
  if (!releaseDateStr) return null;

  // If already in YYYY-MM-DD format, return as is
  if (/^\d{4}-\d{2}-\d{2}$/.test(releaseDateStr)) {
    return releaseDateStr;
  }

  // Try to parse formats like "Nov 14, 2025" or "14 Nov 2025"
  try {
    const date = new Date(releaseDateStr);
    if (!isNaN(date.getTime())) {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  } catch (error) {
    // If parsing fails, try manual parsing for "Nov 14, 2025" format
    const months = {
      'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
      'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
    };

    const match = releaseDateStr.match(/(\w+)\s+(\d+),\s+(\d+)/);
    if (match) {
      const [, monthName, day, year] = match;
      const month = months[monthName.substring(0, 3)];
      if (month) {
        return `${year}-${month}-${String(day).padStart(2, '0')}`;
      }
    }
  }

  return null;
}

// Function to fetch theater listings for a movie
async function fetchTheaterListings(filmCommonCode, releaseDate = null) {
  try {
    const requestConfig = {
      method: 'POST',
      url: config.theaterListingsApiUrl,
      headers: {
        ...config.theaterListingsApiHeaders,
      },
    };

    // Set Content-Type if not already in headers
    if (!requestConfig.headers['content-type'] && !requestConfig.headers['Content-Type']) {
      requestConfig.headers['Content-Type'] = 'application/json';
    }

    // Convert releaseDate to API format (YYYY-MM-DD)
    let dated = null;
    let releaseDateFormatted = null;

    if (releaseDate) {
      releaseDateFormatted = convertReleaseDateToAPIFormat(releaseDate);
    }

    // Get today's date in YYYY-MM-DD format
    const today = new Date();
    const todayYear = today.getFullYear();
    const todayMonth = String(today.getMonth() + 1).padStart(2, '0');
    const todayDay = String(today.getDate()).padStart(2, '0');
    const todayFormatted = `${todayYear}-${todayMonth}-${todayDay}`;

    // If releaseDate is available and in the future, use it; otherwise use today's date
    if (releaseDateFormatted) {
      // Compare dates: if today > releaseDate, use today; else use releaseDate
      if (todayFormatted > releaseDateFormatted) {
        dated = todayFormatted;
        logMessage('📅', `ReleaseDate ${releaseDate} (${releaseDateFormatted}) is in the past, using today's date: ${dated}`);
      } else {
        dated = releaseDateFormatted;
        logMessage('📅', `Using releaseDate ${releaseDate} (converted to ${dated}) for film ${filmCommonCode}`);
      }
    } else {
      // If no releaseDate or conversion failed, use today's date as fallback
      dated = todayFormatted;
      logMessage('⚠️', `No releaseDate found for film ${filmCommonCode}, using today's date: ${dated}`);
    }

    // Build request body with mid and dated
    let body = config.theaterListingsApiBody ? { ...config.theaterListingsApiBody } : {};
    body.mid = filmCommonCode;
    body.dated = dated;

    // Use default body structure if not provided
    if (!config.theaterListingsApiBody) {
      body = {
        city: config.apiBody?.city || (typeof config.apiBody === 'string' ? JSON.parse(config.apiBody).city : 'Bengaluru'),
        mid: filmCommonCode,
        experience: 'ALL',
        specialTag: 'ALL',
        lat: '12.915336',
        lng: '77.373046',
        lang: 'ALL',
        format: 'ALL',
        dated: dated,
        time: '08:00-24:00',
        cinetype: 'ALL',
        hc: 'ALL',
        adFree: false
      };
    }

    requestConfig.data = body;

    const response = await axios(requestConfig);
    return {
      success: true,
      status: response.status,
      data: response.data,
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

// Function to get theater names from listings response
function getTheaterNames(listingsData) {
  const theaterNames = [];

  try {
    if (listingsData?.output?.movieCinemaSessions && Array.isArray(listingsData.output.movieCinemaSessions)) {
      listingsData.output.movieCinemaSessions.forEach(session => {
        if (session.cinema && session.cinema.name) {
          theaterNames.push({
            name: session.cinema.name,
            theatreId: session.cinema.theatreId,
            showCount: session.showCount || 0,
            cityName: session.cinema.cityName,
            address1: session.cinema.address1
          });
        }
      });
    }
  } catch (error) {
    logMessage('⚠️', `Error extracting theater names: ${error.message}`);
  }

  return theaterNames;
}

// Function to check if cinema name keywords match
function checkCinemaKeywords(theaterNames) {
  if (!config.cinemaKeywords || !Array.isArray(config.cinemaKeywords) || config.cinemaKeywords.length === 0) {
    // No cinema keywords set, so all theaters match
    return { matched: true, matchingTheaters: theaterNames, matchedSets: [] };
  }

  const matches = [];
  const matchingTheaters = [];

  theaterNames.forEach(theater => {
    const theaterNameLower = String(theater.name).toLowerCase();

    // Check each keyword set
    config.cinemaKeywords.forEach((keywordSet, index) => {
      const allKeywordsFound = keywordSet.every(keyword =>
        theaterNameLower.includes(String(keyword).toLowerCase())
      );

      if (allKeywordsFound) {
        if (!matches.find(m => m.setIndex === index)) {
          matches.push({
            keywordSet: keywordSet,
            setIndex: index
          });
        }
        if (!matchingTheaters.find(t => t.name === theater.name)) {
          matchingTheaters.push(theater);
        }
      }
    });
  });

  return {
    matched: matches.length > 0,
    matchingTheaters: matchingTheaters,
    matchedSets: matches
  };
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
async function makePhoneCall(matchKey) {
  if (!config.enablePhoneCall) {
    return false;
  }

  if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioPhoneNumber || !config.phoneNumberToCall) {
    logMessage('⚠️', 'Twilio credentials not configured. Skipping phone call.');
    return false;
  }

  // Check if we've already called for this match
  if (matchKey && phoneCallMade.has(matchKey)) {
    logMessage('📞', `Phone call already made for this match (${matchKey}). Skipping call.`);
    return false;
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

    // Mark this match as called
    if (matchKey) {
      phoneCallMade.add(matchKey);
    }

    logMessage('📞', `Phone call initiated. Call SID: ${call.sid}`);
    return true;
  } catch (error) {
    logMessage('❌', `Error making phone call: ${error.message}`);
    return false;
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

    // Check for keyword set matches
    const keywordMatches = getMatchingKeywordSets(result.data);

    // Legacy: Check if target movie was found (for backward compatibility)
    const targetMovieFound = config.targetMovie &&
      filmNames.some(name => String(name).toLowerCase().includes(String(config.targetMovie).toLowerCase()));

    // If movie keywords matched, check cinema keywords
    let shouldNotify = false;
    let cinemaMatchResult = null;
    let allMatchingFilms = [];
    let filmCommonCodes = [];

    if (keywordMatches.length > 0) {
      // Collect all matching film names
      keywordMatches.forEach(match => {
        allMatchingFilms.push(...match.matchingFilms);
      });

      // Extract filmCommonCodes and releaseDates from matched movies
      const filmInfo = extractFilmInfo(movies, allMatchingFilms);
      filmCommonCodes = filmInfo.map(fi => fi.code);

      logMessage('🎬', `Movie keywords matched! Found ${filmInfo.length} film code(s): ${filmInfo.map(fi => `${fi.code} (${fi.releaseDate || 'no date'})`).join(', ')}`);

      // Fetch theater listings for each film code
      let allTheaterNames = [];
      for (const filmInfoItem of filmInfo) {
        logMessage('🔍', `Fetching theater listings for film code: ${filmInfoItem.code}${filmInfoItem.releaseDate ? ` (release: ${filmInfoItem.releaseDate})` : ''}`);
        const listingsResult = await fetchTheaterListings(filmInfoItem.code, filmInfoItem.releaseDate);

        if (listingsResult.success) {
          const theaters = getTheaterNames(listingsResult.data);
          allTheaterNames.push(...theaters);
          logMessage('✅', `Found ${theaters.length} theaters for film code ${filmInfoItem.code}`);
        } else {
          logMessage('❌', `Failed to fetch listings for film code ${filmInfoItem.code}: ${listingsResult.error}`);
        }
      }

      // Remove duplicates
      const uniqueTheaters = Array.from(
        new Map(allTheaterNames.map(t => [t.name, t])).values()
      );

      // Check cinema keywords
      cinemaMatchResult = checkCinemaKeywords(uniqueTheaters);

      if (config.cinemaKeywords && Array.isArray(config.cinemaKeywords) && config.cinemaKeywords.length > 0) {
        // Cinema keywords are set, only notify if they match
        shouldNotify = cinemaMatchResult.matched;
        if (shouldNotify) {
          logMessage('🎯', `Cinema keywords matched! Found ${cinemaMatchResult.matchingTheaters.length} matching theater(s)`);
        } else {
          logMessage('⏭️', `Cinema keywords did not match. Found ${uniqueTheaters.length} theaters but none matched cinema keywords.`);
        }
      } else {
        // No cinema keywords set, notify for all theaters
        shouldNotify = true;
        cinemaMatchResult = {
          matched: true,
          matchingTheaters: uniqueTheaters,
          matchedSets: []
        };
        logMessage('✅', `No cinema keywords set. Found ${uniqueTheaters.length} theater(s) - will notify.`);
      }
    } else if (targetMovieFound) {
      // Legacy mode - no cinema keyword checking for legacy
      shouldNotify = true;
      allMatchingFilms = filmNames.filter(name =>
        String(name).toLowerCase().includes(String(config.targetMovie).toLowerCase())
      );
    } else {
      // Custom condition met but no keyword matches
      shouldNotify = true;
    }

    if (shouldNotify) {
      // Format movie information
      let movieInfo = '';
      let trackingInfo = '';
      let theaterInfo = '';

      if (keywordMatches.length > 0) {
        movieInfo = `\n🎯 *KEYWORD SETS MATCHED!*\n\n`;
        keywordMatches.forEach((match, index) => {
          movieInfo += `*Set ${match.setIndex + 1}:* ${match.keywordSet.join(' AND ')}\n`;
          match.matchingFilms.forEach((name) => {
            movieInfo += `  ✅ ${name}\n`;
          });
          movieInfo += `\n`;
        });
        trackingInfo = `*Tracking:* ${keywordMatches.map(m => m.keywordSet.join(' AND ')).join(' OR ')}\n`;

        // Add theater information
        if (cinemaMatchResult && cinemaMatchResult.matchingTheaters.length > 0) {
          theaterInfo = `\n🎭 *Available Theaters:*\n\n`;
          cinemaMatchResult.matchingTheaters.forEach((theater) => {
            theaterInfo += `📍 ${theater.name}\n`;
            if (theater.showCount > 0) {
              theaterInfo += `   Shows: ${theater.showCount}\n`;
            }
            if (theater.cityName) {
              theaterInfo += `   City: ${theater.cityName}\n`;
            }
            theaterInfo += `\n`;
          });
        }

        if (config.cinemaKeywords && cinemaMatchResult.matchedSets.length > 0) {
          theaterInfo += `*Cinema Keywords Matched:* ${cinemaMatchResult.matchedSets.map(m => m.keywordSet.join(' AND ')).join(' OR ')}\n`;
        }
      } else if (targetMovieFound) {
        movieInfo = `\n🎯 *TARGET MOVIE FOUND!*\n\n`;
        allMatchingFilms.forEach((name) => {
          movieInfo += `✅ ${name}\n`;
        });
        trackingInfo = `*Tracking:* ${config.targetMovie}\n`;
      }

      const message = `🎬 *PVR Cinema Update*\n\n` +
        `*Status:* ${result.data?.result || 'Unknown'}\n` +
        trackingInfo +
        movieInfo +
        theaterInfo +
        `\n*Time:* ${new Date().toLocaleString()}\n` +
        `*API Status:* ${result.status}`;

      await sendTelegramNotification(message);

      // Create a unique key for this match to track phone calls
      let matchKey = null;
      if (keywordMatches.length > 0 && filmCommonCodes.length > 0) {
        // Create key from film codes and theater names
        const theaterNames = cinemaMatchResult && cinemaMatchResult.matchingTheaters.length > 0
          ? cinemaMatchResult.matchingTheaters.map(t => t.name).sort().join(',')
          : 'all';
        matchKey = `${filmCommonCodes.sort().join(',')}|${theaterNames}`;
      } else if (targetMovieFound) {
        // Legacy mode - use movie name as key
        matchKey = `legacy|${config.targetMovie}`;
      }

      // Make phone call if enabled (will skip if already called for this match)
      const callMade = await makePhoneCall(matchKey);

      const statusMsg = (keywordMatches.length > 0 || targetMovieFound)
        ? `🎯 MATCH FOUND! Notification sent (${movies.length} movies, ${filmNames.length} unique film names, ${keywordMatches.length} keyword set(s) matched${cinemaMatchResult ? `, ${cinemaMatchResult.matchingTheaters.length} theater(s)` : ''}${callMade ? ', phone call made' : callMade === false && matchKey && phoneCallMade.has(matchKey) ? ', phone call skipped (already called)' : ''})`
        : `✅ Condition met - notification sent (${movies.length} movies, ${filmNames.length} unique film names)`;
      logMessage('📬', statusMsg);
    } else {
      logMessage('⏭️', `Movie matched but cinema keywords did not match - no notification sent`);
    }
  } else {
    const movies = getMovies(result.data);
    logMessage('⏭️', `Condition not met - ${movies.length} movies found, no notification sent`);
  }
}

// Function to send startup message
async function sendStartupMessage() {
  const timestamp = getISTTime();

  let trackingInfo = 'None';
  if (config.movieKeywords && Array.isArray(config.movieKeywords) && config.movieKeywords.length > 0) {
    // Format keyword sets for display
    trackingInfo = config.movieKeywords.map((set, index) =>
      `Set ${index + 1}: (${set.join(' AND ')})`
    ).join(' OR ');
  } else if (config.targetMovie) {
    trackingInfo = config.targetMovie;
  }

  let cinemaInfo = '';
  if (config.cinemaKeywords && Array.isArray(config.cinemaKeywords) && config.cinemaKeywords.length > 0) {
    cinemaInfo = `\n🎭 Cinema being tracked: ${config.cinemaKeywords.map((set, index) =>
      `Set ${index + 1}: (${set.join(' AND ')})`
    ).join(' OR ')}`;
  } else {
    cinemaInfo = '\n🎭 Cinema: All theaters';
  }

  const startupMessage = `Spider-Tracker is now live 🚀\n\n` +
    `📅 Time: ${timestamp}\n` +
    `🌐 Server: ${config.serverName}\n` +
    `📊 Movie being tracked: ${trackingInfo}` +
    cinemaInfo;

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
if (config.movieKeywords && Array.isArray(config.movieKeywords) && config.movieKeywords.length > 0) {
  logMessage('🎬', `Movie Keyword Sets: ${config.movieKeywords.map((set, i) => `Set ${i + 1}: (${set.join(' AND ')})`).join(' OR ')}`);
} else if (config.targetMovie) {
  logMessage('🎬', `Target Movie: ${config.targetMovie}`);
}
if (config.cinemaKeywords && Array.isArray(config.cinemaKeywords) && config.cinemaKeywords.length > 0) {
  logMessage('🎭', `Cinema Keyword Sets: ${config.cinemaKeywords.map((set, i) => `Set ${i + 1}: (${set.join(' AND ')})`).join(' OR ')}`);
} else {
  logMessage('🎭', `Cinema Keywords: Not set (will notify for all theaters)`);
}
const conditionDisplay = config.checkCondition ||
  (config.movieKeywords ? 'keyword sets matching' :
    (config.targetMovie ? `hasFilm('${config.targetMovie}')` : 'movies.length > 0'));
logMessage('🔎', `Check Condition: ${conditionDisplay}`);

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

