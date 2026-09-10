# RGBeAll

**A SignalRGB plugin for Magic Home / Zengge Wi-Fi RGB LED controllers.**

Drives an analog Magic Home controller directly from SignalRGB, so a desk light strip runs the same
effects, at the same time, as the RGB inside your PC.

No bridge process. No Python daemon. No firmware flashing. No soldering. One plugin file that talks
to the controller over its own protocol on your local network.

---

## Does this work with my controller?

**This plugin supports analog (non-addressable) controllers on the legacy unencrypted protocol.**
That is the common 4-pin `+ R G B` type that drives a plain 12 V or 24 V RGB strip.

Don't guess — ask the hardware:

```powershell
.\tools\magichome-probe.ps1 -Discover
.\tools\magichome-probe.ps1 -Ip 192.0.2.50
```

The probe is strictly read-only. It never changes your lights. It reports device type, firmware and
protocol generation, and tells you plainly whether the plugin will work.

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

1. Download `MagicHome.js` and `MagicHome.qml` from this repository.
2. Copy both into:
   ```
   %USERPROFILE%\Documents\WhirlwindFX\Plugins\
   ```
   Create the folder if it does not exist. If your Documents folder is redirected to OneDrive, use
   that path instead.
3. Restart SignalRGB.
4. Open **Devices**, find **Magic Home RGB Controller**, and add your controller by IP.

Discovery runs automatically, but **adding by IP is the reliable path** — broadcast discovery is
blocked on many normal networks. Set a DHCP reservation for the controller so its address is stable.

---

## Settings

| Setting | Default | What it does |
|---|---|---|
| **Lighting Mode** | Canvas | `Canvas` follows the active effect. `Forced` holds one fixed colour. |
| **Canvas Sampling** | Centre | `Centre` samples one point and keeps colours saturated. `Average` blends five points — smoother, but averaging a gradient tends toward grey. |
| **Max Brightness** | 100% | Scales every channel. Analog strips are often far brighter than case lighting. |
| **Gamma Correction** | on | Perceptual curve, so dim colours look right on a PWM-driven strip. |
| **Frame Rate Cap** | 30 FPS | Updates per second. Lower it if the strip stutters on weak Wi-Fi. |
| **Turn strip off on shutdown** | off | Whether to power the strip down when SignalRGB exits. |

If the strip looks washed out, you are almost certainly on `Average` with a gradient effect. Switch
to `Centre`.

---

## How it works

```
SignalRGB effect canvas
        │  device.color(x, y)
        ▼
   MagicHome.js  ──── TCP 5577 ────►  controller  ────►  RGB strip
        │                                  ▲
        └──── UDP 48899 broadcast ─────────┘
                  (discovery)
```

Each frame the plugin samples the canvas, collapses it to one RGB triple, applies gamma and
brightness, then writes an 8-byte frame to the controller over a single persistent TCP connection.
Identical consecutive frames are dropped and the send rate is capped.

**30 FPS is comfortable.** Measured on real hardware: 300 frames at 30 FPS with zero failures,
mean acknowledgement latency 4.13 ms, p99 16 ms. Published figures for Magic Home *addressable*
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
  out of scope. The protocol layer in `MagicHome.js` is a self-contained object with no I/O, so an
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
