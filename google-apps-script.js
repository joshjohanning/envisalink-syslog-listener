// Google Apps Script - EnvisaLink Syslog Listener
//
// This script receives zone events from the envisalink-syslog-listener
// and appends them as rows in a Google Sheet.
//
// Setup:
//   1. Create a new Google Sheet
//   2. Add headers in Row 1: Timestamp | Event | Zone | Zone Name | Message
//   3. Open Extensions > Apps Script
//   4. Paste this code (replacing any existing code)
//   5. Click Deploy > New deployment
//   6. Set type to "Web app"
//   7. Set "Who has access" to "Anyone"
//   8. Click Deploy and copy the web app URL
//   9. Pass the URL to the listener:
//      --GOOGLE_SHEETS_WEBHOOK=https://script.google.com/macros/s/ABC.../exec
//
// New events are inserted at the top (row 2) so the most recent entry is
// always visible first. To append to the bottom instead, replace the
// insertRowBefore/setValues block with: sheet.appendRow([...]);

function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var data = JSON.parse(e.postData.contents);

  // Insert at row 2 (below headers) so newest events appear at the top
  sheet.insertRowBefore(2);
  sheet.getRange(2, 1, 1, 5).setValues([[
    data.timestamp,
    data.event,
    data.zone || '',
    data.zoneName || '',
    data.message
  ]]);

  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}
