'use strict';

const { v4: uuidv4 }= require('uuid');
const {
  MCS_ROOM,
  MCS_USER_ID,
  MCS,
  join,
  generateVideoPubOffer,
  processPubAnswer,
  encodeVideo,
} = require('./common.js');
const {
  BBBWebRTCRecorder,
  DEFAULT_PUB_CHANNEL,
  DEFAULT_SUB_CHANNEL,
} = require('../lib/common/bbb-webrtc-recorder.js');

const INSTANCES = process.env.INSTANCES || 1;
const LIFESPAN = process.env.LIFESPAN || 15000;
const INTERVAL = process.env.INTERVAL || 0;
const RECORDING_SETS = { };
const qty = () => Object.values(RECORDING_SETS).length;
const Recorder = new BBBWebRTCRecorder(DEFAULT_PUB_CHANNEL, DEFAULT_SUB_CHANNEL);
Recorder.start();

let up = 0;

const record = async ({ mediaId: pubId }) => {
  const nativeOptions = {
    profiles: {
      video: 'sendrecv',
    },
    mediaProfile: 'main',
    adapter: 'mediasoup',
    ignoreThresholds: true,
    adapterOptions: {
      transportOptions: {
        rtcpMux: false,
        comedia: false,
      },
      msHackRTPAVPtoRTPAVPF: true,
    }
  };

  const {  mediaId: nativeMediaId, answer: nativeDescriptor } = await MCS.subscribe(
    MCS_USER_ID, pubId, 'WebRtcEndpoint', nativeOptions,
  );

  const bbbWebRTCRecorderSet =  {
    nativeMediaId,
  };
  const recordingId = uuidv4();
  const filename = `${recordingId}.webm`;

  const { answer } = await Recorder.startRecording(
    recordingId,
    filename,
    nativeDescriptor, {
      rtpStatusChangedHdlr: () => {},
      recordingStoppedHdlr: () => {},
    },
  );

  bbbWebRTCRecorderSet.recordingId = recordingId;

  // Step 3
  nativeOptions.descriptor = answer;
  nativeOptions.mediaId = nativeMediaId;
  await MCS.subscribe(MCS_USER_ID, pubId, 'WebRtcEndpoint', nativeOptions);

  const recordingSet = {
    nativeMediaId,
    recordingId,
  }

  RECORDING_SETS[recordingId] = recordingSet;
  console.log(`[${qty()}/${INSTANCES}] Up=${qty()}`, up);
  setTimeout(() => terminateRecordingSet(recordingSet), LIFESPAN);

  return recordingId;
}

const terminateRecordingSet = async (recordingSet) => {
  up--;

  try {
    await MCS.unsubscribe(MCS_USER_ID, recordingSet.nativeMediaId);
  } catch (error) {
    console.error(error);
  }

  try {
    Recorder.stopRecording(recordingSet.recordingId);
  } catch (error) {
    console.error(error);
  }

  delete RECORDING_SETS[recordingSet.recordingId]
  console.log(`[${qty()}/${INSTANCES}] Ended=${recordingSet.recordingId}`, up);
};

process.on('SIGTERM', async () => {
  Promise
    .all(Object.values(RECORDING_SETS).map((set) => terminateRecordingSet(set)))
    .then(() => {
      process.exit(0);
    });
});

process.on('SIGINT', async () => {
  Promise
    .all(Object.values(RECORDING_SETS).map((set) => terminateRecordingSet(set)))
    .then(() => {
      process.exit(0);
    });
});

console.log(`[${qty()}/${INSTANCES}] Spinning ${INSTANCES} recorders for ${LIFESPAN/1000}s`, up);
Recorder._waitForConnection()
  .then(join)
  .then(generateVideoPubOffer)
  .then(encodeVideo)
  .then(processPubAnswer)
  .then((args) => {
    let loop = setInterval(() => {
      if (up < INSTANCES) {
        record(args).catch(console.error);
        up++;
      } else {
        clearInterval(loop);
      }
    }, INTERVAL);
  });
