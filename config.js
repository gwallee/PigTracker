/* Show Pig Tracker — site configuration.
   This is the only file you need to edit after deploying the Apps Script. */

// Paste the Web app URL from Apps Script → Deploy → Manage deployments.
// It ends in /exec.
const API_URL = "https://script.google.com/macros/s/AKfycbwx5RXtlGUoXkcskkBGxQbqgpFAGqP7nb_6M7TIV6bouUr4jHMKaK0LFTAZN_XnjJyc1g/exec";

// Show Delete buttons on the page. Off by default: anyone with the link
// could wipe data. Fix mistakes in the Sheet instead (re-entering a date
// overwrites that day's row).
const ALLOW_DELETE = false;

// Optional colour coding for feed : gain. Leave null for no colouring.
// Example: { good: 3.0, mid: 4.0 } → ≤3.0 green, ≤4.0 amber, above red.
const FCR_THRESHOLDS = null;
