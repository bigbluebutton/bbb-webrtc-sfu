/*
 * 
 */

var inherits = require('inherits');
var OutMessage2x = require('../OutMessage2x');

module.exports = function (C) {
  function MeetingStreamOAuth2UrlMessage2x (meetingId, userId, oauth2url) {
    const name = C.MEETING_STREAM_OAUTH2_URL_MESSAGE_2x;
    MeetingStreamOAuth2UrlMessage2x.super_.call(this, name, {sender: 'bbb-webrtc-sfu'}, {meetingId, userId});

    this.core.body = {};
    this.core.body[C.STREAM_OAUTH2_URL] = oauth2url;
  };

  inherits(MeetingStreamOAuth2UrlMessage2x, OutMessage2x);
  return MeetingStreamOAuth2UrlMessage2x;
}
