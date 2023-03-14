const transform = require('sdp-transform');
const { spawn } = require('child_process');
const config = require('config');
const MCSWrapper = require('../lib/base/MCSAPIWrapper');
const MCS_ADDRESS = config.get("mcs-address");
const MCS_PORT = config.get("mcs-port");

const MCS_ROOM = 'aleph0';
const MCS_USER_ID = 'scarlet';

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

const generatePubOffer = () => {
  const options = {
    ignoreThresholds: true,
    adapter: 'mediasoup',
    profiles: {
      video: 'sendonly',
    },
    mediaProfile: 'main',
    adapterOptions: {
      transportOptions: {
        rtcpMux: false,
        comedia: true,
      },
      msHackStripSsrcs: true,
    },
  };

  return getMCSClient()
    .then((client) => client.publish(MCS_USER_ID, MCS_ROOM, 'RtpEndpoint', options));
};

const processPubAnswer = ({ pubId, answer }) => {
  const options = {
    mediaId: pubId,
    descriptor: answer,
    ignoreThresholds: true,
    adapter: 'mediasoup',
    profiles: {
      video: 'sendonly',
    },
    mediaProfile: 'main',
    adapterOptions: {
      transportOptions: {
        rtcpMux: false,
        comedia: true,
      },
      msHackStripSsrcs: true,
    },
  };

  return getMCSClient()
    .then((client) => client.publish(MCS_USER_ID, MCS_ROOM, 'RtpEndpoint', options));
}

const encodeVideo = ({ mediaId: pubId, answer: pubOffer }) => {
  return new Promise((resolve, reject) => {
    console.debug("Publish offer", pubOffer);
    const sdpObject = transform.parse(pubOffer);
    const videoMedia = sdpObject.media.find((media) => media.type === 'video');
    const child = spawn('bash', [
      `${process.cwd()}/ffmpeg-encode-video.sh`,
      'v.mp4',
      videoMedia.port.toString(),
      videoMedia.rtcp.port.toString(),
    ]);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      if (data.includes('SDP')) {
        const answer =  data.replace(/SDP:/ig, '')
          .replace(/RTP\/AVP/ig, 'RTP/AVPF')
          .trim()
          .concat('\r\na=ssrc:12345678 cname:ff@mpeg\r\n')
        console.log("FFMPEG SDP", answer);
        return resolve({
          pubId,
          answer
        });
      } else {
        console.debug(data);
      }
    });
    child.on('close', (code) => {
      console.log(`ffmpeg-encode-video.sh closed=${code}`);
      if (code != 0) reject(code);
    });
    child.on('error', reject);
  });
}



module.exports = {
  MCS_ROOM,
  MCS_USER_ID,
  MCS: mcs,
  getMCSClient,
  join,
  generatePubOffer,
  processPubAnswer,
  encodeVideo,
};
