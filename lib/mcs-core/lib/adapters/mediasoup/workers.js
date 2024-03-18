'use strict';

const mediasoup = require('mediasoup');
const { v4: uuidv4 }= require('uuid');
const C = require('../../constants/constants');
const { handleError } = require('./errors.js');
const Logger = require('../../utils/logger');
const {
  WORKER_SETTINGS, WORKER_PRIORITIES, WORKER_BALANCING,
} = require('./configs.js');
const { setProcessPriority } = require('./utils.js');

const SHARED_POOL_ID = 'shared';
const WORKER_STRATEGIES = {
  ROUND_ROBIN: 'round-robin',
  CASCADED_ROUND_ROBIN: 'cascaded-round-robin',
  LEAST_LOADED: 'least-loaded',
  CASCADED_LEAST_LOADED: 'cascaded-least-loaded',
};
const LOAD_WEIGHTS = {
  TRANSPORTS: 10,
  PRODUCERS: 5,
  CONSUMERS: 2,
};

// WORKER_STORAGE: each key has a val in the form of [<worker>].
const WORKER_STORAGE = {
  [SHARED_POOL_ID]: [],
}

const _replaceWorker = (worker, replacementReason) => {
  const workerSettings = worker.appData.workerSettings;
  const workerUID = worker.appData.workerUID;
  const mediaType = worker.appData.mediaType || SHARED_POOL_ID;
  const oldWorkerId = worker.appData.internalAdapterId;

  stopWorker(worker);
  deleteWorker(worker);

  createWorker({
    workerSettings,
    mediaType,
    workerUID,
  }).then(newWorker => {
    Logger.info('mediasoup: replacement worker up', {
      mediaType,
      replacementReason,
      oldWorkerId,
      oldWorkerPID: worker.pid,
      newWorkerId: newWorker.appData.internalAdapterId,
      newWorkerPID: newWorker.pid,
      workerUID,
    });

    storeWorker(newWorker);
  }).catch(error => {
    Logger.error('mediasoup: worker replacement failed', {
      mediaType,
      replacementReason,
      oldWorkerId,
      oldWorkerPID: worker.pid,
      workerUID,
      errorMessage: error.message,
    });
  });
}

const _trackWorkerDeathEvent = (worker) => {
  worker.once('died', (error) => {
    const mediaType = worker.appData.mediaType || SHARED_POOL_ID;
    Logger.error('mediasoup: worker died', {
      errorMessage: error.message, workerId: worker.appData.internalAdapterId,
      workerPID: worker.pid, mediaType,
    });
    _replaceWorker(worker, 'died');
  });
};

const storeWorker = (worker) => {
  if (worker == null) return false;
  const storage = _fetchWorkerStorage(worker.appData.mediaType);
  if (typeof storage !== 'object') return false;

  if (hasWorker(storage, worker.appData.internalAdapterId)) {
    // Might be an ID collision. Throw this peer out and let the client reconnect
    throw handleError({
      ...C.ERROR.MEDIA_ID_COLLISION,
      details: "MEDIASOUP_WORKER_COLLISION"
    });
  }

  storage.push(worker);
  return true;
}

const _fetchWorkerStorage = (mediaType) => {
  if (mediaType && mediaType !== C.MEDIA_PROFILE.ALL) {
    const tentativeStorage = WORKER_STORAGE[mediaType];
    if (tentativeStorage) return tentativeStorage;
  }

  return WORKER_STORAGE[SHARED_POOL_ID];
}

const hasWorker = (storage, workerId) => {
  return storage.some(worker => worker.appData.internalAdapterId === workerId);
}

/*
 * Pure round-robin strategy
 * Fetches the first worker in the list and pushes it to the end
 * of the list.
 */
const getWorkerRR = (mediaType) => {
  const storage = _fetchWorkerStorage(mediaType);
  const worker = storage.shift();

  if (worker) {
    storage.push(worker);
  }

  return worker;
}

/*
 * Least loaded strategy based on the number of transports, producers, and
 * consumers associated with the worker.
 * Weights:
 * - LOAD_WEIGHTS.TRANSPORTS: 10
 * - LOAD_WEIGHTS.PRODUCERS: 5
 * - LOAD_WEIGHTS.CONSUMERS: 2
 * The load of a worker is calculated as follows:
 *   load = (LOAD_WEIGHTS.TRANSPORTS * transports) + (LOAD_WEIGHTS.PRODUCERS * producers) + (LOAD_WEIGHTS.CONSUMERS * consumers)
 *   see: calculateLoad
 *
 * The worker fetching algorithm is as follows:
 * 1. Sort the workers based on their load.
 * 2. If the load of two workers is the same, sort them based on the number of transports, producers, and consumers.
 * 3. If the load and the number of transports, producers, and consumers are the same, sort them based on their PID.
 * 4. Return the first worker in the sorted list.
 * 5. If there are no workers, return null.
 *
 * The worker fetching algorithm is implemented in the sortLL function.
 */
const calculateLoad = (worker) => {
  return (LOAD_WEIGHTS.TRANSPORTS * worker.appData.load.transports) +
    (LOAD_WEIGHTS.PRODUCERS * worker.appData.load.producers) +
    (LOAD_WEIGHTS.CONSUMERS * worker.appData.load.consumers);
}

const sortLL = (w1, w2) => {
  const load1 = calculateLoad(w1);
  const load2 = calculateLoad(w2);

  if (load1 < load2) return -1;
  if (load1 > load2) return 1;

  if (w1.appData.load.transports < w2.appData.load.transports) return -1;
  if (w1.appData.load.transports > w2.appData.load.transports) return 1;

  if (w1.appData.load.producers < w2.appData.load.producers) return -1;
  if (w1.appData.load.producers > w2.appData.load.producers) return 1;

  if (w1.appData.load.consumers < w2.appData.load.consumers) return -1;
  if (w1.appData.load.consumers > w2.appData.load.consumers) return 1;

  if (w1.pid < w2.pid) {
    return -1;
  } else return 1;
}

// Get the least loaded worker based on the media type by using the sortLL function.
const getWorkerLL = (mediaType = SHARED_POOL_ID) => {
  const storage = _fetchWorkerStorage(mediaType);
  if (storage.length === 0) return null;
  if (storage.length === 1) return storage[0];

  const leastLoaded = storage.sort(sortLL)[0];

  return leastLoaded;
}

const getWorker = (options = {}) => {
  const { balancing = WORKER_BALANCING, mediaType } = options;
  const { strategy } = balancing;

  switch (strategy) {
    case WORKER_STRATEGIES.LEAST_LOADED:
      return getWorkerLL(mediaType, balancing?.options);
    case WORKER_STRATEGIES.ROUND_ROBIN:
    default:
      return getWorkerRR(mediaType, balancing?.options);
  }
}

const deleteWorker = (worker) => {
  const storage = _fetchWorkerStorage(worker.appData.mediaType);
  let deleted = false;
  let i = 0;

  while (i < storage.length || !deleted) {
    if (storage[i].appData.internalAdapterId === worker.appData.internalAdapterId) {
      storage.splice(i, 1);
      deleted = true;
    } else {
      i++;
    }
  }

  return deleted;
}

const createWorker = async ({
  workerSettings = WORKER_SETTINGS,
  mediaType = SHARED_POOL_ID,
  workerUID,
}) => {
  if (workerUID == null) throw new Error('mediasoup: workerUID is required');

  const worker = await mediasoup.createWorker(workerSettings)

  worker.appData.internalAdapterId = uuidv4();
  worker.appData.workerSettings = workerSettings;
  worker.appData.mediaType = mediaType;
  worker.appData.workerUID = workerUID;
  worker.appData.load = {
    transports: 0,
    producers: 0,
    consumers: 0,
  };

  _trackWorkerDeathEvent(worker);
  Logger.info('mediasoup: worker created', {
    workerId: worker.appData.internalAdapterId,
    workerPID: worker.pid,
    workerUID,
    type: mediaType || SHARED_POOL_ID,
  });

  return worker;
}

const createSharedPoolWorkers = (
  sharedWorkers,
  workerSettings,
) => {
  Logger.info(`mediasoup: spawning shared pool workers (${sharedWorkers})`, {
    balancingStrategy: WORKER_BALANCING?.strategy || WORKER_STRATEGIES.ROUND_ROBIN,
  });

  for (let i = 0; i < sharedWorkers ; i++) {
    const workerUID = `${SHARED_POOL_ID}-${i}`;
    createWorker({
      workerSettings,
      mediaType: SHARED_POOL_ID,
      workerUID,
    }).then(worker => {
      storeWorker(worker);
    }).catch(error => {
      Logger.error('mediasoup: worker creation failed - shared pool',
        { errorMessage: error.message, errorCode: error.code });
    });
  }
}

const createDedicatedMediaTypeWorkers = (
  dedicatedMediaTypeWorkers,
  workerSettings,
) => {
  for (const [mediaType, numberOfWorkers] of Object.entries(dedicatedMediaTypeWorkers)) {
    if (numberOfWorkers == '0') return;
    if (WORKER_STORAGE[mediaType] == null) WORKER_STORAGE[mediaType] = [];

    Logger.info(`mediasoup: spawning ${mediaType} workers (${numberOfWorkers})`, {
      balancingStrategy: WORKER_BALANCING?.strategy || WORKER_STRATEGIES.ROUND_ROBIN,
    });

    for (let i = 0; i < numberOfWorkers; i++) {
      const workerUID = `${mediaType}-${i}`;
      createWorker({
        workerSettings,
        mediaType,
        workerUID,
      }).then(worker => {
        storeWorker(worker);

        if (WORKER_PRIORITIES[mediaType] != null) {
          setProcessPriority(worker.pid, WORKER_PRIORITIES[mediaType]);
        }
      }).catch(error => {
        Logger.error(`mediasoup: worker creation failed - ${mediaType}`,
          { mediaType, errorMessage: error.message, errorCode: error.code });
      });
    }
  }
}

const stopWorker = (worker) => {
  worker.close();
}

module.exports = {
  WORKER_STORAGE,
  createSharedPoolWorkers,
  createDedicatedMediaTypeWorkers,
  createWorker,
  stopWorker,
  getWorker,
  getWorkerRR,
  deleteWorker,
};
