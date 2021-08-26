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

const extractRecvRTPParams = (extCaps) => {
  return SoupORTCU.getRecvRtpCapabilities(extCaps);
}

const extractRTPParams = (baseRTPCaps, jsonSdp, kind, mode) => {
  const caps = SoupSDPU.extractRtpCapabilities({
    sdpObject: jsonSdp,
  });

  const msExtendedRtpCaps = SoupORTCU.getExtendedRtpCapabilities(
    baseRTPCaps,
    caps
  );

  let params;

  if (mode === 'producer') {
    params = extractSendRtpParams(kind, msExtendedRtpCaps);
    const encodings = SoupRTPU.getRtpEncodings({
      sdpObject: jsonSdp,
      kind,
    });
    params.encodings = encodings;
  } else {
    params = extractRecvRTPParams(msExtendedRtpCaps);
  }

  // TODO: "mid"
  //params.mid = '1';
  // TODO proper RTCP fillers
  //params.rtcp = getRtcpParameters(jsonSdp, "video");

  return params;
}

const extractPlainRtpParameters = (jsonSdp, kind) => {
  return SoupRTPU.extractPlainRtpParameters({
    sdpObject: jsonSdp,
    kind,
  });
}

const _processHackFlags = (description, adapterOptions = {}) => {
  if (!!adapterOptions.msHackRTPAVPtoRTPAVPF) {
    description = description.replace(/RTP\/AVP/ig, 'RTP/AVPF');
  }

  return description;
}

// This obviously only works for single stream SDPs right now.
// But then again: when we reach the point where we want to do proper bundling
// and use less transports, we won't use SDP. So who cares? -- prlanzarin
const assembleSDP = (mediaTypes, {
  transportOptions,
  kind,
  offerRtpParameters,
  streamId,
  setup,
  adapterOptions,
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

  // FIXME this is just not good (up to the two replaces)
  let targetDirection = 'sendrecv';
  if (mediaTypes.video == 'sendonly'
    || mediaTypes.content == 'sendonly'
    || mediaTypes.audio === 'sendonly') {
    targetDirection = 'recvonly';
  }

  answer = answer.replace(/sendrecv|sendonly|recvonly/ig, targetDirection);
  answer = answer.replace(/actpass/ig, setup);
  answer = _processHackFlags(answer, adapterOptions);

  return answer;
};

module.exports = {
  getRtcpParameters,
  extractRTPParams,
  extractPlainRtpParameters,
  extractSendRtpParams,
  assembleSDP,
};
