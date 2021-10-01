const C = require('../../constants/constants');

const getMappedTransportType = (mcsCoreType) => {
  switch (mcsCoreType) {
    case C.MEDIA_TYPE.WEBRTC:
      return 'WebRtcTransport';
    case C.MEDIA_TYPE.RTP:
      return 'PlainTransport';
    default:
      return 'UnknownTransport';
  }
}

const getCodecFromMimeType = (mimeType) => {
  return mimeType.substring((mimeType.lastIndexOf("/") + 1), mimeType.length);
}

module.exports = {
  getMappedTransportType,
  getCodecFromMimeType,
}
