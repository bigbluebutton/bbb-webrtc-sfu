const transform = require('sdp-transform');
const { spawn } = require('child_process');
const config = require('config');
const MCSWrapper = require('../lib/base/MCSAPIWrapper');
const MCS_ADDRESS = config.get("mcs-address");
const MCS_PORT = config.get("mcs-port");

const MCS_ROOM = 'aleph0';
const MCS_USER_ID = 'scarlet';
const FFMPEG_AUDIO_SSRC = 87654321;
const FFMPEG_VIDEO_SSRC = 12345678;
const FFMPEG_VIDEO_PORT = 3000;
const FFMPEG_AUDIO_PORT = 3002;
const CNAME = 'ff@mpeg';

const mcs = new MCSWrapper();
mcs.start(MCS_ADDRESS, MCS_PORT);

const getMCSClient = () => {
  return mcs.waitForConnection().then(() => mcs);
}

const join = () => {
  return getMCSClient()
    .then((client) => {
      client.join(MCS_ROOM, 'SFU', {
        userId: MCS_USER_ID,
        externalUserId: MCS_USER_ID,
        autoLeave: true
      });
    });
}

const generatePubOffer = ({
  profiles,
  mediaProfile = 'main',
  adapter = 'mediasoup',
  adapterOptions = {
    transportOptions: {
      rtcpMux: false,
      comedia: true,
    },
    msHackStripSsrcs: true,
    splitTransport: false,
  }
}) => {
  const options = {
    ignoreThresholds: true,
    adapter,
    profiles,
    mediaProfile,
    adapterOptions,
  };

  return getMCSClient()
    .then((client) => client.publish(MCS_USER_ID, MCS_ROOM, 'RtpEndpoint', options));
};

const generateVideoPubOffer = () => {
  return generatePubOffer({
    profiles: {
      video: 'sendonly',
    },
  });
};

const generateAVPubOffer = () => {
  return generatePubOffer({
    mediaProfile: 'content',
    profiles: {
      audio: 'sendonly',
      content: 'sendonly',
    },
    adapterOptions: {
      transportOptions: {
        rtcpMux: false,
        comedia: true,
      },
      msHackStripSsrcs: true,
      splitTransport: true,
    }
  });
};

const processPubAnswer = ({ pubId, answer }) => {
  const options = {
    mediaId: pubId,
    descriptor: answer,
  };

  return getMCSClient()
    .then((client) => client.publish(MCS_USER_ID, MCS_ROOM, 'RtpEndpoint', options));
}

const encode = ({ script, mediaId: pubId, answer: pubOffer }) => {
  return new Promise((resolve, reject) => {
    const sdpObject = transform.parse(pubOffer);
    const pVideoMedia = sdpObject.media.find((media) => media.type === 'video');
    const pAudioMedia = sdpObject.media.find((media) => media.type === 'audio');
    const child = spawn('bash', [
      `${process.cwd()}/${script}`,
      'input.mp4',
      pVideoMedia?.port.toString(),
      pVideoMedia?.rtcp?.port.toString(),
      pAudioMedia?.port.toString(),
      pAudioMedia?.rtcp?.port.toString(),
    ]);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      if (data.includes('SDP')) {
        // This is a bogus SDP used to trick the remote end (mcs)
        // Ports are actually the same. It's FFMPEG's view on the remote end's SDP.
        // Doesn't matter, but should be fixed if a sendrecv scenario is implemented
        const ffmpegSDP = data.replace(/SDP:/ig, '').trim();
        const parsedAnswer = transform.parse(ffmpegSDP);
        const aVideoMedia = parsedAnswer.media.find((media) => media.type === 'video');
        const aAudioMedia = parsedAnswer.media.find((media) => media.type === 'audio');

        if (aVideoMedia) {
          aVideoMedia.protocol = 'RTP/AVPF';
          aVideoMedia.port = FFMPEG_VIDEO_PORT;
          aVideoMedia.rtcp = { port: FFMPEG_VIDEO_PORT + 1 };
          aVideoMedia.ssrcs = [{ id: FFMPEG_VIDEO_SSRC, attribute: "cname", value: CNAME }];
        }

        if (aAudioMedia) {
          aAudioMedia.protocol = 'RTP/AVPF';
          aAudioMedia.port = FFMPEG_AUDIO_PORT;
          aAudioMedia.rtcp = { port: FFMPEG_AUDIO_PORT + 1 };
          aAudioMedia.ssrcs = [{ id: FFMPEG_AUDIO_SSRC, attribute: "cname", value: CNAME }];
        }

        const answer = transform.write(parsedAnswer);
        console.log("FFMPEG SDP", answer);

        return resolve({
          pubId,
          answer,
        });
      } else {
        console.debug(data);
      }
    });
    child.on('close', (code) => {
      console.log(`ffmpeg-encode-video.sh closed=${code}`);
      if (code != 0) {
        reject(code);
        throw new Error(`closed=${code}`);
      }
    });
    child.on('error', reject);
  });
}

const encodeVideo = ({ mediaId, answer }) => {
  return encode({ mediaId, answer, script: 'ffmpeg-encode-video.sh'} );
};

const encodeAV = ({ mediaId, answer }) => {
  return encode({ mediaId, answer, script: 'ffmpeg-encode-av.sh'} );
};

module.exports = {
  MCS_ROOM,
  MCS_USER_ID,
  MCS: mcs,
  getMCSClient,
  join,
  generatePubOffer,
  generateVideoPubOffer,
  generateAVPubOffer,
  processPubAnswer,
  encode,
  encodeVideo,
  encodeAV,
};
