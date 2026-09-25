/* Show Pig Tracker — site configuration.
   This is the only file you need to edit after deploying the Apps Script. */

// Paste the Web app URL from Apps Script → Deploy → Manage deployments.
// It ends in /exec.
const API_URL = "https://script.google.com/macros/s/AKfycbwx5RXtlGUoXkcskkBGxQbqgpFAGqP7nb_6M7TIV6bouUr4jHMKaK0LFTAZN_XnjJyc1g/exec";

// Link to the Google Sheet, shown next to the Refresh button so you can
// fix or remove entries by hand. Leave "" to hide the link.
const SHEET_URL = "https://docs.google.com/spreadsheets/d/1g9cRvGS8c2cNWKHrEjAyjeVWy2Exb9CVlp9LWIPDgws/edit";

// Show Delete buttons (two taps to confirm) on weigh-ins and feed rows.
// Anyone with the page link can use them, so if the link ever gets
// around, set this to false. The Sheet's File → Version history is the undo.
const ALLOW_DELETE = true;

// Optional colour coding for feed : gain. Leave null for no colouring.
// Example: { good: 3.0, mid: 4.0 } → ≤3.0 green, ≤4.0 amber, above red.
const FCR_THRESHOLDS = null;
