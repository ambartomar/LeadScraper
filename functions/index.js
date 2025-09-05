const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Initialize the Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

// === HARDCODED ADMIN UID ===
// This is your UID. Any user with this UID will be considered an admin by this function.
const ADMIN_UID = 'DhD6XzfVq2fEJSvrHvws2KTKZlu1';

// This function logs a search query to a user's Firestore document.
// It is used for tracking purposes and does not affect the user's ability to perform searches.
exports.logSearch = functions.https.onCall(async (data, context) => {
    // Ensure the function is called by an authenticated user
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    const uid = context.auth.uid;

    // Check if the current user is an admin
    if (uid === ADMIN_UID) {
        // You can add special admin-only logic here
        functions.logger.log('Admin user detected:', uid);
        return { message: 'Search logged successfully. You are an admin!' };
    }

    // --- Original logic for non-admin users ---
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
