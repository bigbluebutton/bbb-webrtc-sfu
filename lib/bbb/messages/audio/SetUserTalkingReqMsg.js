'use strict';

const OutMessage2x = require('../OutMessage2x');
const Constants = require('../Constants.js');

module.exports = class SetUserTalkingReqMsg extends OutMessage2x {
  constructor(meetingId, userId, talking) {
    super(
      Constants.SET_USER_TALKING_REQ_MSG,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId, userId }
    );
    this.core.body = {};
    this.core.body[Constants.TALKING] = talking;
  }
}
