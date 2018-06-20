var inherits = require('inherits');
var OutMessage2x = require('../OutMessage2x');

module.exports = function(C) {
  function StopTranscoderSysReqMsg(meetingId, transcoderId) {
    StopTranscoderSysReqMsg.super_.call(this, C.STOP_TRANSCODER_REQ_2x,
        {sender: "kurento-screenshare"},
        {meetingId: meetingId});

    this.core.body = {};
    this.core.body[C.TRANSCODER_ID_2x] = transcoderId;
  };

  inherits(StopTranscoderSysReqMsg, OutMessage2x);
  return StopTranscoderSysReqMsg;
}
