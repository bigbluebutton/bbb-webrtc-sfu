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

const enrichCodecsArrayWithPreferredPT = (codecs) => {
  return codecs.map(codec => {
    if (codec.preferredPayloadType == null && codec.payloadType) {
      codec.preferredPayloadType = codec.payloadType
    }

    return codec;
  });
}

module.exports = {
  getMappedTransportType,
  getCodecFromMimeType,
  enrichCodecsArrayWithPreferredPT,
}
