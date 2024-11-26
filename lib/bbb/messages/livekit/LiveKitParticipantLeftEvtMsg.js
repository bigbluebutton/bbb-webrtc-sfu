const OutMessage2x = require('../OutMessage2x');

const LIVEKIT_PARTICIPANT_LEFT_EVT_MSG = "LiveKitParticipantLeftEvtMsg";

module.exports = class LiveKitParticipantLeftEvtMsg extends OutMessage2x {
  constructor (meetingId, userId) {
    super(
      LIVEKIT_PARTICIPANT_LEFT_EVT_MSG,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId, userId },
    );

    this.core.body = {
      userId,
    }
  }
}
