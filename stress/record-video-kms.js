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

const INSTANCES = process.env.INSTANCES || 1;
const LIFESPAN = process.env.LIFESPAN || 15000;
const INTERVAL = process.env.INTERVAL || 0;
const RECORDING_SETS = { };
const qty = () => Object.values(RECORDING_SETS).length;
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
    MCS_USER_ID, pubId, 'RtpEndpoint', nativeOptions,
  );

  const hgaOptions = {
    descriptor: nativeDescriptor,
    adapter: 'Kurento',
    ignoreThresholds: true,
    profiles: {
      video: 'sendonly',
    },
    mediaProfile: 'main',
    adapterOptions: {
      kurentoRemoveRembRtcpFb: true,
    }
  };

  const { mediaId: hgaMediaId, answer: hgaAnswer } = await MCS.publish(
    MCS_USER_ID, MCS_ROOM, 'RtpEndpoint', hgaOptions,
  );

  nativeOptions.descriptor = hgaAnswer;
  nativeOptions.mediaId = nativeMediaId;
  await MCS.subscribe(MCS_USER_ID, pubId, 'RtpEndpoint', nativeOptions);

  //const filename = `/var/kurento/tmp/${uuidv4()}.webm`;
  const filename = '/dev/null';
  const recordingId = await MCS.startRecording(
    MCS_USER_ID,
    hgaMediaId,
    filename,
    { recordingProfile: 'WEBM_VIDEO_ONLY', ignoreThresholds: true, filename },
  );
  const recordingSet = {
    nativeMediaId,
    hgaMediaId,
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
    MCS.unpublish(MCS_USER_ID, recordingSet.hgaMediaId);
  } catch (error) {
    console.error(error);
  }

  try {
    MCS.stopRecording(MCS_USER_ID, recordingSet.recordingId);
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
join()
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
