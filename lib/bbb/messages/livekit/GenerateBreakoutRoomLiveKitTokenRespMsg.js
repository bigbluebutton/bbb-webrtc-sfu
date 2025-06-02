const OutMessage2x = require('../OutMessage2x');

const GENERATE_BREAKOUT_ROOM_LIVEKIT_TOKEN_RESP_MSG = "GenerateBreakoutRoomLiveKitTokenRespMsg";

module.exports = class GenerateBreakoutRoomLiveKitTokenRespMsg extends OutMessage2x {
  constructor (parentMeetingId, userId, breakoutRoomId, token, grant) {
    super(
      GENERATE_BREAKOUT_ROOM_LIVEKIT_TOKEN_RESP_MSG,
      { sender: 'bbb-webrtc-sfu' },
      { meetingId: parentMeetingId, userId },
    );

    this.core.body = {
      parentMeetingId,
      breakoutRoomId,
      token,
      grant,
    }
  }
}
