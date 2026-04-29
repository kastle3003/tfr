function isLiveKey(keyId) {
  return typeof keyId === 'string' && keyId.startsWith('rzp_live_');
}

function isTestKey(keyId) {
  return typeof keyId === 'string' && keyId.startsWith('rzp_test_');
}

function assertTestOnly() {
  // Live keys are now permitted — no-op guard.
}

// Returns the configured key (live or test), or a safe placeholder.
function publicKeyId() {
  const kid = process.env.RAZORPAY_KEY_ID || '';
  if (isLiveKey(kid) || isTestKey(kid)) return kid;
  return 'rzp_test_placeholder';
}

// True when a real key (live or test) is configured.
function canUseSdk() {
  const kid = process.env.RAZORPAY_KEY_ID || '';
  return (isLiveKey(kid) || isTestKey(kid)) && !!process.env.RAZORPAY_KEY_SECRET;
}

module.exports = { assertTestOnly, publicKeyId, canUseSdk, isLiveKey, isTestKey };
