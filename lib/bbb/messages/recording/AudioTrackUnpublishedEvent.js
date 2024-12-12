const C = require('../Constants.js');

module.exports = class AudioTrackUnpublishedEvent {
  constructor (meetingId, userId, filename, source, timestampHR, timestampUTC) {
    this.payload = {
      [C.MODULE]: C.RECORDING_MODULE_SFU,
      [C.EVENT_NAME]: C.AUDIO_TRACK_UNPUBLISHED_EVT,
      [C.MEETING_ID]: meetingId,
      [C.SHARE_EVT_USER_ID_KEY]: userId,
      [C.FILENAME]: filename,
      [C.RECORDING_SOURCE]: source,
      [C.TIMESTAMP]: timestampHR,
      [C.TIMESTAMP_UTC]: timestampUTC,
    };
  }

  /**
   * Generates the JSON representation of the message
   * @return {String} The JSON string of this message
   */
  toJson () {
    return JSON.stringify(this);
  }
}
