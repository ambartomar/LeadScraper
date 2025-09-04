const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

// Set up App Check verification
const { initializeAppCheck, getAppCheck } = require('firebase-admin/app-check');
const appCheck = initializeAppCheck({
  appId: '1:710806971072:web:ced903befe8693f886c325', // Your App ID is correct
  serviceAccountId: 'firebase-adminsdk-fbsvc@youleadmax.iam.gserviceaccount.com', // Your service account ID is correct
});

// Admin UID to grant special permissions. MUST BE SET SECURELY.
// You must get this from your Firebase Authentication console after creating the user.
const ADMIN_UID = 'DhD6XzfVq2fEJSvrHvws2KTKZlu1';

// Deducts credits from a user's account
exports.deductCredits = functions.https.onCall(async (data, context) => {
  // Temporary fix: Commented out App Check verification to fix the "internal" error.
  // Uncomment this code after you have properly configured App Check with your Render domain.
  /*
  if (data.appCheckToken) {
    await getAppCheck().verifyToken(data.appCheckToken);
  }
  */

  // Ensure user is authenticated
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }

  const uid = context.auth.uid;
  const deduction = data.deduction || 0;
  const userRef = db.collection('users').doc(uid);

  return db.runTransaction(async (transaction) => {
    const doc = await transaction.get(userRef);
    if (!doc.exists) {
      throw new functions.https.HttpsError('not-found', 'User data not found.');
    }
    
    const currentCredits = doc.data().credits || 0;
    if (currentCredits < deduction) {
      throw new functions.https.HttpsError('failed-precondition', 'Insufficient credits.');
    }

    const newCredits = currentCredits - deduction;
    transaction.update(userRef, { credits: newCredits });
    return { credits: newCredits };
  });
});

// Admin function to reset all user credits
exports.adminResetCredits = functions.https.onCall(async (data, context) => {
  // Temporary fix: Commented out App Check verification.
  /*
  if (data.appCheckToken) {
    await getAppCheck().verifyToken(data.appCheckToken);
  }
  */

  // Ensure user is authenticated and is the admin
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  if (context.auth.uid !== ADMIN_UID) {
    throw new functions.https.HttpsError('permission-denied', 'You do not have permission to perform this action.');
  }

  const usersRef = db.collection('users');
  const snapshot = await usersRef.get();

  const batch = db.batch();
  snapshot.forEach(doc => {
    batch.update(doc.ref, { credits: 100 }); // Reset to 100 credits
  });

  await batch.commit();
  return { message: 'All user credits have been reset.' };
});
