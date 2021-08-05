'use strict';

const SoupRTPU = require("mediasoup-client/lib/handlers/sdp/plainRtpUtils");
const SoupSDPU = require("mediasoup-client/lib/handlers/sdp/commonUtils");
const SoupORTCU = require("mediasoup-client/lib/ortc");
const RemoteSdp = require("mediasoup-client/lib/handlers/sdp/RemoteSdp");

const getRtcpParameters = (sdpObject, kind) => {
  const mediaLine = (sdpObject.media || []).find((m) => m.type === kind);

  if (!mediaLine) {
    throw new Error(`Section not found: ${kind}`);
  }

  const ssrcCname = (mediaLine.ssrcs || []).find(s => s.attribute && s.attribute === "cname");
  const cname = ssrcCname && ssrcCname.value ? ssrcCname.value : null;
  const reducedSize = "rtcpRsize" in mediaLine;

  return { cname: cname, reducedSize: reducedSize };
}

const extractSendRtpParams = (kind, caps) => {
  return SoupORTCU.getSendingRtpParameters(kind, caps);
};

const extractRTPParams = (baseRTPCaps, parsedSdp, kind) => {
  const caps = SoupSDPU.extractRtpCapabilities({
    sdpObject: parsedSdp,
  });

  const msExtendedRtpCaps = SoupORTCU.getExtendedRtpCapabilities(
    baseRTPCaps,
    caps
  );

  const sendRTPParams = extractSendRtpParams(kind, msExtendedRtpCaps);

  // TODO: "mid"
  //sendRTPParams.mid = '1';

  const encodings = SoupRTPU.getRtpEncodings({
    sdpObject: parsedSdp,
    kind,
  });

  sendRTPParams.encodings = encodings;

  // TODO proper RTCP fillers
  //sendRTPParams.rtcp = getRtcpParameters(parsedSdp, "video");

  return sendRTPParams;
}

const extractPlainRtpParameters = (parsedSdp, kind) => {
  return SoupRTPU.extractPlainRtpParameters({
    sdpObject: parsedSdp,
    kind,
  });
}

// This obviously only works for single stream SDPs right now.
// But then again: when we reach the point where we want to do proper bundling
// and use less transports, we won't use SDP. So who cares? -- prlanzarin
const assembleSDP = (mediaTypes, {
  transportOptions,
  kind,
  offerRtpParameters,
  streamId,
}) => {

  const reassembledSDP = new RemoteSdp.RemoteSdp({
    ...transportOptions,
  });

  reassembledSDP.receive({
    // TODO proper mid
    mid: 0,
    kind,
    offerRtpParameters,
    streamId,
  });

  let answer = reassembledSDP.getSdp();

  // Could be better.
  answer = answer.replace(/actpass/ig, 'active');
  if (mediaTypes.video == `sendonly` || mediaTypes.content == 'sendonly' || mediaTypes.audio === 'sendonly') {
    answer = answer.replace(/sendonly/ig, 'recvonly');
  } else {
    answer = answer.replace(/sendonly/ig, 'sendonly');
  }

  return answer;
};

module.exports = {
  getRtcpParameters,
  extractRTPParams,
  extractPlainRtpParameters,
  extractSendRtpParams,
  assembleSDP,
};
