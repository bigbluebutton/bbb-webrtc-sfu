## Running in a development environment

### Pre-requisites
  - Node.js >= 16
  - npm >= 8.x
  - gcc/g++ (>= 7.5.0)
  - python3-pip

### Installation

```
$ git clone https://github.com/bigbluebutton/bbb-webrtc-sfu.git
$ cd bbb-webrtc-sfu
$ npm install
```

### Configuration

#### In a BigBlueButton instance

A sample configuration file is located in ./config/default.example.yml.
It contains all possible configurations used by this application - most of them
with inline comments explaing what they do.

The default configuration file _does not_ work out of the box since some of
configuration values are environment-dependant. Thus, the recommended way is
to setup this application in a BigBlueButton development instance and copy
over the bbb-webrtc-sfu package config file.

```bash
$ cp /usr/local/bigbluebutton/bbb-webrtc-sfu/config/default.yml ./config/default.yml
```

After that, if necessary, create your own configuration file to override specific
configs while developing.

```bash
$ touch ./config/development.yml
```

Keep in mind that values in `development.yml` file supersedes `./config/default.yml`.
When a configuration file is changed, the application *needs to be restarted*.

### Running the application

#### Manually

After the configuration files are in place, disable the packaged bbb-webrtc-sfu
to avoid conflicts. To do that:

```bash
$ sudo systemctl stop bbb-webrtc-sfu
$ sudo systemctl disable bbb-webrtc-sfu
```

The packaged application can be re-enabled at any time by running:

```bash
$ sudo systemctl enable bbb-webrtc-sfu
```

The application can be started as any other npm application:
```bash
$ npm start
```

To run the application with auto-reload on code changes:
```bash
$ npm run nodemon-start
```

To lint the application or specific files:
```bash
$ npm run lint
$ npm run lint:file relative/path/to/file.js

```

Sending a stop signal is enough to stop the application.

#### As a systemd service

In a BigBlueButton installation, bbb-webrtc-sfu's systemd service file can be overriden to use your local development directory instead.
Suppose you've configured the local application in `/home/some_user/bbb-webrtc-sfu`. Do the following:

```
$ mkdir /etc/systemd/system/bbb-webrtc-sfu.service.d
$ touch /etc/systemd/system/bbb-webrtc-sfu.service.d/override.conf
```

Then edit `/etc/systemd/system/bbb-webrtc-sfu.service.d/override.conf` with the following:
```
[Service]
WorkingDirectory=/home/some_user/bbb-webrtc-sfu
```

Reload the unit file and restart the application:
```
$ systemctl daemon-reload
$ systemctl restart bbb-webrtc-sfu
```

### Compatibility with BBB versions

Check [BigBlueButton version compatibility](bbb-compatibility.md)
