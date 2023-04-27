const OutMessage2x = require('../OutMessage2x');
const Constants = require('../Constants');

class SFUMuteStateChangedReqMsg extends OutMessage2x {
  constructor (meetingId, userId, muted, mutedBy, sfuSessionId) {
    super(
      Constants.MessageTypes.SFU_MUTE_STATE_CHANGED_REQ,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId, userId },
    );

    this.core.body =  {
      [Constants.MEETING_ID_2x]: meetingId,
      [Constants.USER_ID_2x]: userId,
      [Constants.MUTED]: muted,
      [Constants.MUTED_BY]: mutedBy,
      [Constants.SFU_SESSION_ID]: sfuSessionId,
    };
  }
}

module.exports = SFUMuteStateChangedReqMsg;
