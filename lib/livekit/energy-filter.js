'use strict';

const MAGIC_NUMBER_THRESHOLD = 0.004 ** 2;

/**
 * AudioEnergyFilter Determine the speaking state based on audio energy.
 * This is an adapted JavaScript port of a similar filter used in LiveKit's
 * Gladia plugin. See https://pypi.org/project/livekit-plugins-gladia/.
 * @class
 * @property {number}
 * @typedef {Object} AudioEnergyFilterOptions
 * @param {number} [minSilence=1.5] - Minimum silence duration in seconds to trigger the END state.
 * @param {number} [rmsThreshold=MAGIC_NUMBER_THRESHOLD] - The mean square of samples threshold to detect speech.
 */
module.exports = class AudioEnergyFilter {
  static State = Object.freeze({
    START: 0,
    SPEAKING: 1,
    SILENCE: 2,
    END: 3,
  });

  /**
   * @param {object} options
   * @param {number} [options.minSilence=1.5] - Minimum silence duration in seconds to trigger the END state.
   * @param {number} [options.rmsThreshold=MAGIC_NUMBER_THRESHOLD] - The mean square of samples threshold to detect speech.
   */
  constructor({ minSilence = 1.5, rmsThreshold = MAGIC_NUMBER_THRESHOLD } = {}) {
    this._cooldownSeconds = minSilence;
    this._cooldown = minSilence;
    this._state = AudioEnergyFilter.State.SILENCE;
    this._rmsThreshold = rmsThreshold;
  }

  get state() {
    return this._state;
  }

  /**
   * Update the energy filter's speaking state based on the energy of an audio frame.
   * @param {import('@livekit/rtc').AudioFrame} frame - A LiveKit track's audio frame.
   * @returns {number} The current state from AudioEnergyFilter.State.
   */
  update(frame) {
    const samples = frame.data; // Int16Array

    if (samples.length === 0) return this._state;

    let sumOfSquares = 0.0;

    for (let i = 0; i < samples.length; i++) {
      // Normalize sample to [-1.0, 1.0]
      const sampleFloat = samples[i] / 32768.0;

      sumOfSquares += sampleFloat * sampleFloat;
    }

    const meanSquare = sumOfSquares / samples.length;
    const duration = frame.samplesPerChannel / frame.sampleRate;

    if (meanSquare > this._rmsThreshold) {
      this._cooldown = this._cooldownSeconds;

      if (this._state === AudioEnergyFilter.State.SILENCE
        || this._state === AudioEnergyFilter.State.END) {
        this._state = AudioEnergyFilter.State.START;
      } else {
        this._state = AudioEnergyFilter.State.SPEAKING;
      }
    } else {
      if (this._cooldown <= 0) {
        if (this._state === AudioEnergyFilter.State.SPEAKING
          || this._state === AudioEnergyFilter.State.START) {
          this._state = AudioEnergyFilter.State.END;
        } else if (this._state === AudioEnergyFilter.State.END) {
          this._state = AudioEnergyFilter.State.SILENCE;
        }
      } else {
        this._cooldown -= duration;
        // Maintain SPEAKING state during the cooldown period even with low energy
        this._state = AudioEnergyFilter.State.SPEAKING;
      }
    }

    return this._state;
  }
}
