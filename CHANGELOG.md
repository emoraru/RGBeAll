# Changelog

## 1.3.0

- Restoring a colour **and** powering off now works on a real PC shutdown. The bridge holds two
  connections per controller and routes colour on one, power on the other, so the two commands
  cannot end up in the same TCP packet — which the controller would otherwise truncate.
- `Restore colour and turn off` is the default again.
- The power connection is kept warm with a read-only state query, since it carries no traffic
  between shutdowns yet has to work at the moment the machine goes down.

## 1.2.1

- Fixed the strip staying off after logging back into Windows. The bridge now sends a power-on
  before the first frame on any new connection, instead of relying on the device half sending one
  during its first few rendered frames — which could race the relay socket being bound.

## 1.2.0

- Added `Turn off` as a shutdown option: a single command, so nothing can truncate it.
- Neither half closes its sockets during shutdown any more. Closing them discarded anything still
  queued, which is what swallowed the power-off while the colour got through.

## 1.1.0

- Split into two files. `@SignalRGB/tcp` does not resolve in SignalRGB's device context, so
  `RGBeAll.js` renders and relays over loopback UDP while `RGBeAllBridge.js` holds the TCP
  connections. Both run inside SignalRGB — there is still no external process.
- Added shutdown and takeover behaviour, with a watchdog for control being lost while SignalRGB
  keeps running.

## 1.0.0

- First release: drives analog Magic Home / Zengge controllers from the SignalRGB canvas at 30 FPS,
  with discovery, manual entry by IP, gamma correction and brightness limiting.
