/*
 * 
 */

var inherits = require('inherits');
var OutMessage2x = require('../OutMessage2x');

module.exports = function (C) {
  function MeetingStreamMessage2x (meetingId, state, streamUrl, streamType, streamId) {
    const name = (state === C.STREAM_STARTED) ? C.MEETING_STREAM_STARTED_MESSAGE_2x : C.MEETING_STREAM_STOPPED_MESSAGE_2x;
    MeetingStreamMessage2x.super_.call(this, name, {sender: 'bbb-webrtc-sfu'}, {meetingId});

    this.core.body = {};
    this.core.body[C.STREAM_STATE] = state === C.STREAM_STARTED;
    this.core.body[C.STREAMING_STREAM_URL] = streamUrl;
    this.core.body[C.STREAMING_TYPE] = streamType;
    this.core.body[C.STREAM_OAUTH2_ID] = streamId;
  };

  inherits(MeetingStreamMessage2x, OutMessage2x);
  return MeetingStreamMessage2x;
}
