const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Initialize the Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

// This function logs a search query to a user's Firestore document.
// It is used for tracking purposes and does not affect the user's ability to perform searches.
exports.logSearch = functions.https.onCall(async (data, context) => {
    // Ensure the function is called by an authenticated user
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    const uid = context.auth.uid;
    const query = data.query || 'N/A';
    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    const userRef = db.collection('users').doc(uid);

    // Use a subcollection to log each search for better data organization and scalability.
    const logRef = userRef.collection('searchLogs');
    await logRef.add({
        query: query,
        timestamp: timestamp
    });

    return { message: 'Search logged successfully.' };
});
