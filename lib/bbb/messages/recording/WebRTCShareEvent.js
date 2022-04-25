const C = require('../Constants.js');

module.exports = class WebRTCShareEvent {
  constructor (name, meetingId, filename, timestampHR, timestampUTC, userId) {
    this.payload = {};
    this.payload[C.EVENT_NAME] = name;
    this.payload[C.MODULE] = C.MODULE_WEBCAM;
    this.payload[C.MEETING_ID] = meetingId;
    this.payload[C.TIMESTAMP] = timestampHR;
    this.payload[C.TIMESTAMP_UTC] = timestampUTC;
    this.payload[C.FILENAME] = filename;
    this.payload[C.SHARE_EVT_USER_ID_KEY] = userId;
  }

  /**
   * Generates the JSON representation of the message
   * @return {String} The JSON string of this message
   */
  toJson () {
    return JSON.stringify(this);
  }
}
