module.exports = function (C) {
  function WebRTCShareEvent (name, meetingId, filename, timestampHR, timestampUTC) {
    this.payload = {};
    this.payload[C.EVENT_NAME] = name;
    this.payload[C.MODULE] = C.MODULE_WEBCAM;
    this.payload[C.MEETING_ID] = meetingId;
    this.payload[C.TIMESTAMP] = timestampHR;
    this.payload[C.TIMESTAMP_UTC] = timestampUTC;
    this.payload[C.FILENAME] = filename;
  };

  return WebRTCShareEvent;
}
