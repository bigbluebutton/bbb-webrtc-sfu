const OutMessage2x = require('../OutMessage2x');

const UPDATE_LIVEKIT_PARTICIPANT_PERMISSIONS_RESP_MSG = "UpdateLiveKitParticipantPermissionsRespMsg";

module.exports = class UpdateLiveKitParticipantPermissionsRespMsg extends OutMessage2x {
  constructor (meetingId, userId, grant, outcome) {
    super(
      UPDATE_LIVEKIT_PARTICIPANT_PERMISSIONS_RESP_MSG,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId, userId },
    );

    this.core.body = {
      grant,
      outcome,
    }
  }
}
