# RGBeAll

**One name for all your RGB — bring Magic Home Wi-Fi LED strips onto the SignalRGB canvas.**

RGBeAll is a SignalRGB plugin that drives analog Magic Home / Zengge Wi-Fi LED controllers, so a
desk light strip runs the same effects, at the same time, as the RGB inside your PC.

It talks to the controller directly in its own protocol on your local network. Nothing goes through
the Magic Home app or the vendor cloud — the plugin works with the controller's internet access
blocked entirely.

No external process. No Python daemon. No firmware flashing. No soldering.

Developed and tested against SignalRGB 2.5.x on Windows 11. Node.js is only needed if you want to
run the test suite; using the plugin needs nothing but SignalRGB.

---

## Does this work with my controller?

**This plugin supports analog (non-addressable) controllers on the legacy unencrypted protocol.**
That is the common 4-pin `+ R G B` type that drives a plain 12 V or 24 V RGB strip.

Don't guess — ask the hardware:

```powershell
.\tools\rgbeall-probe.ps1 -Discover
.\tools\rgbeall-probe.ps1 -Ip 192.0.2.50
```

The probe is strictly read-only. It never changes your lights. It reports device type, firmware and
protocol generation, and tells you plainly whether the plugin will work.

Addresses in this repository are documentation examples (`192.0.2.x` is reserved for exactly that).
Use your controller's own address — `-Discover` reports it, and on a home network it is usually
something like `192.168.x.x`.

| | Supported | Not supported |
|---|---|---|
| Controller | Analog, device type `0x33` and relatives | Addressable (`0xA3`) |
| Output | 4-pin `+ R G B` header | 3-pin `+5V / data / GND` |
| Firmware | Legacy plaintext protocol | Newer encrypted firmware (roughly 2023 onward) |

Addressable controllers speak a completely different protocol. They are out of scope rather than
half-supported — see [Contributing](#contributing).

---

## Read this before installing

**An analog controller has exactly one colour zone.** The entire strip is always a single colour.
This is a property of the hardware, not a limitation of the plugin, and no software can change it.

What that means in practice:

| Works well | Degrades |
|---|---|
| Colour cycles | Rainbow waves |
| Breathing / pulsing | Ripples and comets |
| Static colours | Rain, meteor, scanning effects |
| Audio level meters | Anything that varies *along* a strip |
| Screen ambience | |

Effects in the right-hand column collapse into the whole strip changing colour at once. If you want
genuine per-LED effects on your desk, you need addressable hardware — that is a strip and controller
swap, not a software fix.

With expectations set correctly, the result is good: your desk lighting genuinely moves in step with
your case lighting instead of doing its own thing.

---

## Installing

1. Download `RGBeAll.js`, `RGBeAllBridge.js` and `RGBeAll.qml` from this repository.
2. Copy all three into:
   ```
   %USERPROFILE%\Documents\WhirlwindFX\Plugins\
   ```
   Create the folder if it does not exist. If your Documents folder is redirected to OneDrive, use
   that path instead.
3. Restart SignalRGB.
4. Open **Devices**, find **RGBeAll**, and add your controller by IP.

Discovery runs automatically, but **adding by IP is the reliable path** — broadcast discovery is
blocked on many normal networks. Set a DHCP reservation for the controller so its address is stable.

**Upgrading?** Replace all three files together — the two `.js` files talk to each other and a
mismatched pair fails in confusing ways. [CHANGELOG.md](CHANGELOG.md) says what changed and when.

---

## Settings

| Setting | Default | What it does |
|---|---|---|
| **Lighting Mode** | Canvas | `Canvas` follows the active effect. `Forced` holds one fixed colour. |
| **Canvas Sampling** | Centre | `Centre` samples one point and keeps colours saturated. `Average` blends five points — smoother, but averaging a gradient tends toward grey. |
| **Max Brightness** | 100% | Scales every channel. Analog strips are often far brighter than case lighting. |
| **Gamma Correction** | on | Perceptual curve, so dim colours look right on a PWM-driven strip. |
| **Frame Rate Cap** | 30 FPS | Updates per second. Lower it if the strip stutters on weak Wi-Fi. |
| **When SignalRGB stops** | Restore colour and turn off | What to leave the strip in when control is lost. See below. |
| **Restore Colour** | `#FF3808` | The colour left on the strip when control is lost. |
| **Takeover Timeout** | 8 s | How long frames may stop before the restore is applied. `0` disables it. |

If the strip looks washed out, you are almost certainly on `Average` with a gradient effect. Switch
to `Centre`.

### Taking over, and handing back

**Starting up.** RGBeAll powers the strip on as soon as it connects, then takes it over. That
matters because the strip is usually *off* at that point — the previous shutdown turned it off — and
these controllers **ignore colour commands while powered off**. Sending colour without powering on
first looks like the plugin is doing nothing at all.

It also re-asserts the canvas colour about once a second, so if something else changes the strip
while SignalRGB is running, control comes straight back.

**Stopping.** **When SignalRGB stops** decides what the strip is left in:

| Option | What it does |
|---|---|
| **Restore colour and turn off** (default) | sets **Restore Colour**, then powers off |
| Turn off | powers the strip off, keeping whatever colour the effect ended on |
| Restore colour, leave on | sets **Restore Colour** and leaves it lit |
| Leave as-is | nothing |

Restoring a colour *and* powering off needs two different commands, and this hardware makes that
awkward: the controller acts on only the first command in a TCP packet, and Qt flushes writes once
per turn of its event loop — so two sends in the same turn share a packet and the second is
discarded. During a shutdown there is no later turn to use.

The bridge solves it by holding **two connections per controller** and routing colour on one and
power on the other. Two sockets cannot share a packet, so the pair always arrives intact no matter
how the event loop schedules them.

This applies in two situations:

- **SignalRGB exits or the PC shuts down** — handled on shutdown by both halves of the plugin.
  This path is deliberately cheap: a few datagrams onto a loopback socket, no waiting on
  anything, because Windows gives a process very little time once a shutdown begins.
- **Frames stop while SignalRGB keeps running** — the device is disabled, or lighting is switched
  off. The bridge notices after **Takeover Timeout** seconds and applies the same restore. If frames
  start again, the strip is powered back on automatically.

The one case nothing can cover is SignalRGB being killed outright, or the PC losing power: no code
runs, so the strip keeps whatever colour it had.

---

## How it works

```
SignalRGB effect canvas
        |  device.color(x, y)
        v
   RGBeAll.js            (device context - has the canvas, but no TCP)
        |  loopback UDP 41577, ASCII hex
        v
   RGBeAllBridge.js      (discovery context - has TCP)
        |  TCP 5577
        v
     controller  ---->  RGB strip
```

### Why there are two files

SignalRGB runs plugin code in two separate JavaScript contexts, and they do not expose the same
modules. `@SignalRGB/tcp` resolves in the **discovery** context but **not** in the **device**
context, where the import fails once per rendered frame. `@SignalRGB/udp` works in both.

Magic Home controllers accept colour only over TCP 5577 - their Wi-Fi module has no UDP control
path (`AT+NETP` is not implemented on this firmware). So the half of the plugin that can read the
canvas cannot reach the controller, and the engine is pre-ES2020, so a lazy `import()` fallback is
a syntax error rather than a workaround.

Hence the split: `RGBeAll.js` renders and sends frames over loopback UDP; `RGBeAllBridge.js`
holds the TCP connections and forwards them. Both run inside SignalRGB - there is no external
process and nothing to start at boot.

The relay payload is ASCII hex rather than raw binary because the receiving side reads datagrams as
a UTF-8 string, which mangles every byte above `0x7F`.

Each frame the device half samples the canvas, collapses it to one RGB triple, applies gamma and
brightness, then sends an 8-byte LEDNET frame. Identical consecutive frames are dropped and the
send rate is capped.

**30 FPS is comfortable.** Measured on real hardware: 300 frames at 30 FPS with zero failures, mean
acknowledgement latency 4.13 ms, p99 16 ms. Published figures for Magic Home *addressable*
controllers are far lower (~5 FPS) because those push large pixel buffers; an 8-byte analog frame is
a completely different workload.

Full wire-protocol reference: [docs/PROTOCOL.md](docs/PROTOCOL.md).

---

## Security

**Short version: this class of device is not trustworthy on a flat network.** The control protocol
has no authentication or encryption, and the controller exposes an unauthenticated command interface
that permits reboot and network reconfiguration.

That exposure exists the moment the controller is powered on — the vendor app relies on exactly the
same unauthenticated channels, and this plugin neither adds to nor reduces it. But if you run these
devices, put them on an isolated network segment.

The plugin itself holds no credentials, makes no cloud or telemetry calls, has no third-party
dependencies, never issues device configuration commands, and treats discovery replies as untrusted
input.

Full assessment, including mitigations: [docs/SECURITY.md](docs/SECURITY.md).

---

## Troubleshooting

Common problems and fixes: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

The fastest first step is almost always to run the probe tool and add the controller by IP rather
than relying on discovery.

---

## Contributing

Useful contributions, roughly in order of value:

- **Addressable (`0xA3`) support.** Deliberately not implemented here, because it cannot be tested
  without the hardware, and shipping untested code that looks supported is worse than declaring it
  out of scope. The protocol layer in `RGBeAll.js` is a self-contained object with no I/O, so an
  addressable variant slots in beside it without touching transport or rendering.
- **Reports from other controller models.** If the probe tool says "likely compatible" with an
  unrecognised device type, please open an issue with the output.
- **Test vectors** for models not covered in [tools/frame-vectors.md](tools/frame-vectors.md).

Before opening a PR, run the offline validation suite. It loads the plugin outside SignalRGB and
asserts the protocol layer against the hardware-captured byte sequences, plus the input-validation
behaviour. No device, no network and no dependencies needed:

```bash
node tools/validate.mjs
```

Please scrub IP and MAC addresses from any logs you attach.

---

## Acknowledgements

The wire protocol used here is long-established in the open-source community; `flux_led` and the
Home Assistant integration built on it are the reference implementations, and the SignalRGB plugin
API was learned from the community network addons that ship with the application.

## License

[MIT](LICENSE)
