// Safety rail: this app is TEST-ONLY. We refuse to start Razorpay with a live
// key, and we never hand out anything other than a test key to the client.
//
// A live key is any RAZORPAY_KEY_ID that begins with "rzp_live_".
// A configured test key must begin with "rzp_test_".

function isLiveKey(keyId) {
  return typeof keyId === 'string' && keyId.startsWith('rzp_live_');
}

function isTestKey(keyId) {
  return typeof keyId === 'string' && keyId.startsWith('rzp_test_');
}

// Called once at process boot. Throws if someone set a live key.
function assertTestOnly() {
  const kid = process.env.RAZORPAY_KEY_ID || '';
  if (isLiveKey(kid)) {
    throw new Error(
      `[razorpay-guard] RAZORPAY_KEY_ID looks like a LIVE key ("${kid.slice(0, 12)}…"). ` +
      `This build is locked to test mode — set rzp_test_... in .env or leave empty for mock mode.`
    );
  }
  if (kid && !isTestKey(kid)) {
    console.warn(
      `[razorpay-guard] RAZORPAY_KEY_ID "${kid}" does not match rzp_test_ prefix — falling back to mock mode.`
    );
  }
}

// Returns the test key if valid, otherwise a placeholder that Razorpay.js on
// the client will fail gracefully against (so no real charges ever happen).
function publicKeyId() {
  const kid = process.env.RAZORPAY_KEY_ID || '';
  if (isTestKey(kid)) return kid;
  return 'rzp_test_placeholder';
}

// True only when a real test key is configured; gates whether we hit the
// Razorpay SDK vs. the local mock order path.
function canUseSdk() {
  return isTestKey(process.env.RAZORPAY_KEY_ID) && !!process.env.RAZORPAY_KEY_SECRET;
}

module.exports = { assertTestOnly, publicKeyId, canUseSdk, isLiveKey, isTestKey };
