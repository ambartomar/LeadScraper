const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { JSDOM } = require('jsdom');
const fetch = require('node-fetch');

// Initialize the Firebase Admin SDK once
admin.initializeApp();
const db = admin.firestore();

// === HARDCODED ADMIN UID ===
// This is used to grant administrative privileges to specific users.
const ADMIN_UID = 'DhD6XzfVq2fEJSvrHvws2KTKZlu1';

// A simple in-memory cache to reduce redundant requests and improve performance.
const cache = new Map();
const CACHE_TTL = 3600; // Cache results for 1 hour (in seconds)

// Rate limiting middleware to prevent abuse and manage API quotas.
const requestCounts = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 30; // 30 requests per minute

const rateLimit = (uid) => {
    const now = Date.now();
    const requestLog = requestCounts.get(uid) || [];

    // Remove expired timestamps
    const recentRequests = requestLog.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW_MS);
    requestCounts.set(uid, recentRequests);

    if (recentRequests.length >= MAX_REQUESTS_PER_WINDOW) {
        return false; // Rate limited
    }

    recentRequests.push(now);
    return true; // Request allowed
};

// Utility function to set standard CORS headers for all HTTP requests
const setCorsHeaders = (res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Max-Age', '3600');
};

/**
 * Cloud Function to log a search query to a user's Firestore document.
 * This is an HTTPS `onCall` function, which is more secure and handles authentication automatically.
 */
exports.logSearch = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Authentication is required to log searches.');
    }

    const uid = context.auth.uid;
    const query = data.query || 'N/A';
    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    try {
        await db.runTransaction(async (transaction) => {
            const userRef = db.collection('artifacts').doc(context.appId || 'default').collection('users').doc(uid);
            const logRef = userRef.collection('searchLogs').doc();
            transaction.set(logRef, {
                query: query,
                timestamp: timestamp
            });
        });

        functions.logger.info(`Search logged for user ${uid}: ${query}`);
        if (uid === ADMIN_UID) {
            functions.logger.info('Admin user detected.');
            return { message: 'Search logged successfully. You are an admin!' };
        }
        return { message: 'Search logged successfully.' };
    } catch (error) {
        functions.logger.error(`Error logging search for user ${uid}:`, error);
        throw new functions.https.HttpsError('internal', 'An unexpected error occurred while logging the search.');
    }
});

/**
 * Main search function to find YouTube channels.
 * Uses advanced scraping to extract more data points.
 */
exports.getChannelData = functions.https.onRequest(async (req, res) => {
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    const uid = req.query.uid;
    if (uid && !rateLimit(uid)) {
        res.status(429).send({ error: 'Too many requests. Please try again later.' });
        return;
    }

    const query = req.query.q;
    if (!query) {
        res.status(400).send({ error: 'Missing search query.' });
        return;
    }

    const cacheKey = `search:${query}`;
    if (cache.has(cacheKey)) {
        functions.logger.info(`Serving search results for "${query}" from cache.`);
        return res.status(200).send(cache.get(cacheKey));
    }

    try {
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAg%253D%253D`;
        const response = await fetch(searchUrl);
        const html = await response.text();
        const dom = new JSDOM(html);
        const scriptTags = dom.window.document.querySelectorAll('script');
        
        let initialData = null;
        for (const script of scriptTags) {
            if (script.textContent.includes('var ytInitialData')) {
                const jsonString = script.textContent.substring(script.textContent.indexOf('{')).trim();
                initialData = JSON.parse(jsonString);
                break;
            }
        }
        
        if (!initialData) {
            throw new Error('Failed to find and parse ytInitialData.');
        }

        const channels = [];
        const contents = initialData?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents[0]?.itemSectionRenderer?.contents || [];

        contents.forEach(item => {
            const channel = item.channelRenderer;
            if (channel) {
                const channelId = channel.channelId;
                const channelName = channel.title?.simpleText;
                const thumbnailUrl = channel.thumbnail?.thumbnails?.[0]?.url;
                const subscribers = channel.subscriberCountText?.simpleText;
                const videoCount = channel.videoCountText?.runs?.[0]?.text;
                const isVerified = channel.ownerBadges?.some(badge => badge.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_VERIFIED');
                const descriptionSnippet = channel.descriptionSnippet?.runs?.map(run => run.text).join('') || 'N/A';
                
                channels.push({
                    channelId,
                    channelName,
                    thumbnailUrl,
                    subscribers,
                    videoCount,
                    isVerified,
                    descriptionSnippet
                });
            }
        });
        
        cache.set(cacheKey, channels);
        setTimeout(() => cache.delete(cacheKey), CACHE_TTL * 1000);
        
        res.status(200).send(channels);
    } catch (error) {
        functions.logger.error(`Error in getChannelData for query "${query}":`, error);
        res.status(500).send({ error: 'Failed to get channel data.', details: error.message });
    }
});

/**
 * Gets a channel's social links, description, and membership information.
 */
exports.getChannelDetails = functions.https.onRequest(async (req, res) => {
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    const channelId = req.query.id;
    if (!channelId) {
        res.status(400).send({ error: 'Missing channel ID.' });
        return;
    }

    const cacheKey = `details:${channelId}`;
    if (cache.has(cacheKey)) {
        functions.logger.info(`Serving channel details for ${channelId} from cache.`);
        return res.status(200).send(cache.get(cacheKey));
    }

    try {
        const aboutUrl = `https://www.youtube.com/channel/${channelId}/about`;
        const response = await fetch(aboutUrl);
        const html = await response.text();
        const dom = new JSDOM(html);

        const descriptionElement = dom.window.document.querySelector('meta[name="description"]');
        const description = descriptionElement ? descriptionElement.getAttribute('content').trim() : 'No description found.';

        const socialLinks = {};
        const linkElements = dom.window.document.querySelectorAll('#link-list-container a');
        
        linkElements.forEach(link => {
            const url = link.href;
            if (url) {
                const domain = new URL(url).hostname;
                if (domain.includes('twitter.com')) socialLinks.twitter = url;
                else if (domain.includes('instagram.com')) socialLinks.instagram = url;
                else if (domain.includes('facebook.com')) socialLinks.facebook = url;
                else if (domain.includes('tiktok.com')) socialLinks.tiktok = url;
                else if (domain.includes('linkedin.com')) socialLinks.linkedin = url;
                else if (domain.includes('discord.com')) socialLinks.discord = url;
                else if (domain.includes('t.me')) socialLinks.telegram = url;
                else if (domain.includes('patreon.com')) socialLinks.patreon = url;
                else if (domain.includes('github.com')) socialLinks.github = url;
                else if (!socialLinks.website) socialLinks.website = url;
            }
        });

        // Scrape for memberships
        const membershipBadge = dom.window.document.querySelector('#channel-header .membership-badge');
        const hasMembership = !!membershipBadge;

        const details = { description, socialLinks, hasMembership };
        cache.set(cacheKey, details);
        setTimeout(() => cache.delete(cacheKey), CACHE_TTL * 1000);

        res.status(200).send(details);
    } catch (error) {
        functions.logger.error(`Error in getChannelDetails for channel ${channelId}:`, error);
        res.status(500).send({ error: 'Failed to get channel details.', details: error.message });
    }
});

/**
 * Gets a channel's videos, including likes, dislikes, and comments.
 */
exports.getChannelVideos = functions.https.onRequest(async (req, res) => {
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    const channelId = req.query.id;
    if (!channelId) {
        res.status(400).send({ error: 'Missing channel ID.' });
        return;
    }

    const cacheKey = `videos:${channelId}`;
    if (cache.has(cacheKey)) {
        functions.logger.info(`Serving channel videos for ${channelId} from cache.`);
        return res.status(200).send(cache.get(cacheKey));
    }

    try {
        const videosUrl = `https://www.youtube.com/channel/${channelId}/videos`;
        const response = await fetch(videosUrl);
        const html = await response.text();
        const dom = new JSDOM(html);
        const scriptTags = dom.window.document.querySelectorAll('script');
        
        let initialData = null;
        for (const script of scriptTags) {
            if (script.textContent.includes('var ytInitialData')) {
                const jsonString = script.textContent.substring(script.textContent.indexOf('{')).trim();
                initialData = JSON.parse(jsonString);
                break;
            }
        }
        
        if (!initialData) {
            throw new Error('Failed to parse YouTube data structure on video page.');
        }

        const videos = [];
        const contents = initialData?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[1]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.gridRenderer?.items || [];
        
        for (const item of contents) {
            const video = item.gridVideoRenderer;
            if (video) {
                const videoId = video.videoId;
                const title = video.title?.runs?.[0]?.text;
                const thumbnailUrl = video.thumbnail?.thumbnails?.[0]?.url;
                const viewCount = video.viewCountText?.simpleText;
                const publishedTime = video.publishedTimeText?.simpleText;
                const duration = video.lengthText?.simpleText;
                
                // Fetch likes and comments count from video page
                const videoDetails = await getVideoAnalytics(videoId);

                videos.push({
                    videoId,
                    title,
                    thumbnailUrl,
                    viewCount,
                    publishedTime,
                    duration,
                    ...videoDetails
                });
            }
        }
        
        cache.set(cacheKey, videos);
        setTimeout(() => cache.delete(cacheKey), CACHE_TTL * 1000);

        res.status(200).send(videos);
    } catch (error) {
        functions.logger.error(`Error in getChannelVideos for channel ${channelId}:`, error);
        res.status(500).send({ error: 'Failed to get channel videos.', details: error.message });
    }
});

// Helper function to scrape video-specific analytics
async function getVideoAnalytics(videoId) {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    try {
        const response = await fetch(videoUrl);
        const html = await response.text();
        const dom = new JSDOM(html);
        const scriptTags = dom.window.document.querySelectorAll('script');
        
        let initialData = null;
        for (const script of scriptTags) {
            if (script.textContent.includes('var ytInitialData')) {
                const jsonString = script.textContent.substring(script.textContent.indexOf('{')).trim();
                initialData = JSON.parse(jsonString);
                break;
            }
        }

        if (!initialData) {
            return { likeCount: 'N/A', commentsCount: 'N/A' };
        }

        const videoInfo = initialData?.contents?.twoColumnWatchNextResults?.results?.contents?.[0]?.videoPrimaryInfoRenderer;
        const likeButton = videoInfo?.videoActions?.menuRenderer?.contents?.[0]?.toggleButtonRenderer?.defaultText?.simpleText;
        const likeCount = likeButton || 'N/A';

        const commentsSection = initialData?.contents?.twoColumnWatchNextResults?.results?.contents?.find(item => item.itemSectionRenderer?.contents?.[0]?.commentThreadRenderer);
        const commentsCountText = commentsSection?.itemSectionRenderer?.header?.commentsHeaderRenderer?.title?.runs?.[1]?.text || '0';
        const commentsCount = commentsCountText.replace(/\D/g, '');

        return {
            likeCount,
            commentsCount: parseInt(commentsCount, 10)
        };
    } catch (error) {
        functions.logger.error(`Error fetching analytics for video ${videoId}:`, error);
        return { likeCount: 'N/A', commentsCount: 'N/A' };
    }
}
