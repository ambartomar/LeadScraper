const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { JSDOM } = require('jsdom'); // New dependency to parse HTML
const fetch = require('node-fetch'); // New dependency for server-side fetching

// Initialize the Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

/**
 * Cloud Function that logs a search query to a user's Firestore document.
 * This function now uses a more robust error handling approach.
 */
exports.logSearch = functions.https.onCall(async (data, context) => {
    // Ensure the function is called by an authenticated user
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    const uid = context.auth.uid;
    const query = data.query || 'N/A';
    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    try {
        const logRef = db.collection('users').doc(uid).collection('searchLogs');
        await logRef.add({
            query: query,
            timestamp: timestamp
        });
        return { message: 'Search logged successfully.' };
    } catch (error) {
        functions.logger.error('Error logging search:', error);
        throw new functions.https.HttpsError('internal', 'An unexpected error occurred while logging the search.');
    }
});

/**
 * Cloud Function to search for YouTube channels and their basic information.
 * This is a new function to handle server-side scraping, fixing the CORS issue.
 * It searches based on a query and returns channel details.
 */
exports.getChannelData = functions.https.onRequest(async (req, res) => {
    // Set CORS headers for the request
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    const query = req.query.q;
    if (!query) {
        res.status(400).send({ error: 'Missing search query.' });
        return;
    }

    try {
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAg%253D%253D`; // sp=EgIQAg is for channels
        const response = await fetch(searchUrl);
        const html = await response.text();
        const dom = new JSDOM(html);
        const scriptTags = dom.window.document.querySelectorAll('script');
        
        let initialData = null;
        for (const script of scriptTags) {
            if (script.textContent.includes('var ytInitialData')) {
                initialData = JSON.parse(script.textContent.substring(script.textContent.indexOf('{')));
                break;
            }
        }
        
        if (!initialData) {
            return res.status(500).send({ error: 'Failed to parse YouTube data.' });
        }

        const channels = [];
        const contents = initialData?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents[0]?.itemSectionRenderer?.contents || [];

        contents.forEach(item => {
            const channel = item.channelRenderer;
            if (channel) {
                const channelId = channel.channelId;
                const channelName = channel.title.simpleText;
                const subscribers = channel.subscriberCountText?.simpleText;
                const videoCount = channel.videoCountText?.runs[0]?.text;
                
                channels.push({
                    channelId,
                    channelName,
                    subscribers,
                    videoCount
                });
            }
        });

        res.status(200).send(channels);
    } catch (error) {
        functions.logger.error('Error in getChannelData:', error);
        res.status(500).send({ error: 'Failed to get channel data.', details: error.message });
    }
});

/**
 * Cloud Function to get a channel's social links and description from its About page.
 * This is a new function to handle server-side scraping, fixing the CORS issue.
 */
exports.getChannelDetails = functions.https.onRequest(async (req, res) => {
    // Set CORS headers for the request
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    const channelId = req.query.id;
    if (!channelId) {
        res.status(400).send({ error: 'Missing channel ID.' });
        return;
    }

    try {
        const aboutUrl = `https://www.youtube.com/channel/${channelId}/about`;
        const response = await fetch(aboutUrl);
        const html = await response.text();
        const dom = new JSDOM(html);

        const descriptionElement = dom.window.document.querySelector('#description-container #description');
        const description = descriptionElement ? descriptionElement.textContent.trim() : 'No description found.';

        const socialLinks = {};
        const linkElements = dom.window.document.querySelectorAll('#link-list-container a');
        
        linkElements.forEach(link => {
            const url = link.href;
            if (url) {
                if (url.includes('twitter.com')) socialLinks.twitter = url;
                else if (url.includes('instagram.com')) socialLinks.instagram = url;
                else if (url.includes('facebook.com')) socialLinks.facebook = url;
                else if (url.includes('tiktok.com')) socialLinks.tiktok = url;
                else if (url.includes('linkedin.com')) socialLinks.linkedin = url;
                else if (!socialLinks.website) socialLinks.website = url;
            }
        });

        res.status(200).send({
            description,
            socialLinks
        });
    } catch (error) {
        functions.logger.error('Error in getChannelDetails:', error);
        res.status(500).send({ error: 'Failed to get channel details.', details: error.message });
    }
});
