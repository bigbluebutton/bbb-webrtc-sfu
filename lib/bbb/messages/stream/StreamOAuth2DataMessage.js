/*
 * 
 */

var inherits = require('inherits');
var OutMessage2x = require('../OutMessage2x');

module.exports = function (C) {
  function MeetingStreamOAuth2DataMessage2x (meetingId, userId, streamKey, streamId, err) {
    const name = C.MEETING_STREAM_OAUTH2_DATA_MESSAGE_2x;
    MeetingStreamOAuth2DataMessage2x.super_.call(this, name, {sender: 'bbb-webrtc-sfu'}, {meetingId, userId});

    this.core.body = {};
    this.core.body[C.STREAM_OAUTH2_KEY] = streamKey;
    this.core.body[C.STREAM_OAUTH2_ID] = streamId;
    this.core.body[C.STREAM_ERROR] = err;
  };

  inherits(MeetingStreamOAuth2DataMessage2x, OutMessage2x);
  return MeetingStreamOAuth2DataMessage2x;
}
