# Audio module

## Experimental microphone bridge

The `audio` module includes an experimental (but feature-complete) microphone bridge.

For a list of pending issues for the experimental microphone bridge to be considered production-grade, check
this [Depends on](https://github.com/bigbluebutton/bigbluebutton/issues/14021#fullaudio-depends-on) section in GitHub.

If you want to try this (keep in mind it is still experimental), you need to add the `fullAudioEnabled: true` flag in
bbb-webrtc-sfu's configuration (`/etc/bigbluebutton/bbb-webrtc-sfu/production.yml` in BBB or `./config/production.yml`
in a local installation). Alternatively, the `FULL_AUDIO_ENABLED=true` environment variable can be used.

Once that flag is enabled in bbb-webrtc-sfu, there are two ways of using it in BBB:
1. Using API parameters - you can have specific meetings use the experimental bridge by passing the
  `meta_fullaudio-bridge=fullaudio` parameter in a meeting `create` request;
3. You can change the defaults in the settings for bbb-html5 by adding the following to `/etc/bigbluebutton/bbb-html5.yml`
  (you will likely want to merge it carefully with your existing file):
  ```
  public:
    media:
      audio:
        defaultFullAudioBridge: fullaudio
  ```

After a restart of BigBlueButton (`sudo bbb-conf --restart`), it should be ready to test. Reverting to the default options 
can be achieved by removing the override sections (and passed API parameters) and restart of BigBlueButton.
