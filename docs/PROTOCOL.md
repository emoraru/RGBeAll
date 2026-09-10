# Magic Home / Zengge "LEDNET" protocol reference

Wire-protocol notes for the **legacy, unencrypted** Magic Home controller family, as used by this
plugin. Everything here was confirmed against real hardware — an analog RGB controller reporting
device type `0x33` on 2017-era firmware.

> Newer Zengge firmware (roughly v7/v9 and later, sold from about 2023) uses an encrypted local API
> and **none of this applies to it**. See [Identifying your controller](#identifying-your-controller).

---

## Transport

| Purpose | Transport | Port |
|---|---|---|
| Control (colour, power, state) | TCP | `5577` |
| Discovery / AT commands | UDP | `48899` |

There is **no authentication and no encryption** on either channel. See [SECURITY.md](SECURITY.md).

---

## Frame format

Every command is a sequence of bytes with a single trailing checksum:

```
checksum = (sum of all preceding bytes) & 0xFF
```

That is the entire framing rule — no length field, no start-of-frame marker, no escaping.

---

## Commands

### Set colour

```
31 RR GG BB WW MM 0F <checksum>
│  │  │  │  │  │  └── acknowledgement flag
│  │  │  │  │  └───── write mask
│  │  │  │  └──────── warm white channel
│  └──┴──┴─────────── red, green, blue
└──────────────────── command
```

| Field | Value | Meaning |
|---|---|---|
| Write mask `MM` | `0xF0` | write colour channels only, leave white alone |
| | `0x0F` | write white channel only |
| | `0x00` | write both |
| Ack flag | `0x0F` | controller returns an acknowledgement |

**Channel order is the identity mapping**: byte 1 is red, byte 2 green, byte 3 blue. Some enclosures
are silkscreened `G R B`, which refers to the **physical pin order on the output connector**, not to
the byte order. Do not swap channels in software because of that label.

Worked example — full red:

```
31 FF 00 00 00 F0 0F 2F
```

### Head byte `0x31` vs `0x41`

`0x41` is widely documented as a non-persistent variant of the colour command. **Do not rely on
this.** On the firmware tested, `0x41` was accepted as a valid colour command, but the colour still
survived a reboot — so it persisted just the same.

This turns out not to matter. See [Is streaming safe?](#is-streaming-safe) below.

### Power

```
71 23 0F A3     power on
71 24 0F A4     power off
```

Powering on makes the controller **reload its last saved colour** from non-volatile storage. If you
power on and then write a colour as two separate steps with a delay between them, the strip visibly
flashes the stale colour first. Send the colour immediately after the power-on command.

### Query state

```
81 8A 8B 96
```

Returns 14 bytes:

```
81 33 23 61 01 01 FF 38 08 00 04 00 F0 <checksum>
│  │  │  │        │  │  │  │     │  └── colour mode (0xF0 = RGB only)
│  │  │  │        │  │  │  │     └───── cold white
│  │  │  │        │  │  │  └─────────── warm white
│  │  │  │        └──┴──┴────────────── red, green, blue
│  │  │  └───────────────────────────── mode (0x61 = static colour)
│  │  └──────────────────────────────── power (0x23 on / 0x24 off)
│  └─────────────────────────────────── device type
└────────────────────────────────────── response header, always 0x81
```

| Offset | Field |
|---|---|
| 0 | header, always `0x81` |
| 1 | device type |
| 2 | power state |
| 3 | mode |
| 6, 7, 8 | red, green, blue |
| 9 | warm white |
| 11 | cold white |
| 12 | colour mode |
| 13 | checksum |

---

## The acknowledgement trap

**This is the single most important implementation detail, and the easiest way to waste an
afternoon.**

Every command returns an acknowledgement:

| Command | Acknowledgement |
|---|---|
| Set colour (`0x31`) | **1 byte**: `30` |
| Power (`0x71`) | **4 bytes**: `F0 71 23 84` |
| Query state (`0x81`) | **14 bytes**, header `0x81` |

If you leave an acknowledgement unread and then issue a state query, your read starts at the stale
ack byte and **every field is shifted by one position**. The result is not an obvious error — it is
plausible-looking nonsense. You will read back a green value after writing red, and conclude your
channel order is wrong when it is fine.

Two safe approaches:

1. **Event-driven (what this plugin does).** Consume incoming data in a `message` handler and
   discard it. Never do a synchronous read during rendering. The problem cannot occur.
2. **Synchronous.** Drain all pending bytes before each query, then read exactly 14 bytes and
   **assert that byte 0 is `0x81`**. Treat any other header as a failed read.

---

## Discovery

Broadcast the ASCII string below on UDP port `48899`:

```
HF-A11ASSISTHREAD
```

Controllers reply with a comma-separated record:

```
<ipv4>,<12-hex-mac>,<module-model>
```

Treat replies as **untrusted input** — anything on the network can send one. Bound the payload
length and validate the shape strictly before acting on it.

### Side effect worth knowing

The discovery string is also the handshake that puts these Wi-Fi modules into **AT command mode** on
that socket. After discovery the module may accept AT commands until it times out. This is how every
tool in this ecosystem performs discovery, and it is harmless in normal use, but it is a real
behaviour rather than a pure query — see [SECURITY.md](SECURITY.md).

Useful read-only AT command, on the same UDP port:

```
AT+LVER     ->  +ok=<type>_<version>_<build date>_<variant>
```

---

## Is streaming safe?

Short answer: **yes, at 30 FPS.**

The concern is real. Colour state is persisted to the controller's non-volatile storage, and a
naive reading of that says every frame you send wears out the flash. Measurements say otherwise.

A sustained run of 300 frames at 30 FPS, reading the acknowledgement on every frame:

```
frames = 300     wall = 10.02 s     effective = 29.9 FPS     ack failures = 0
per-frame ack latency: mean 4.13 ms | p50 3.18 | p95 9.31 | p99 16.34 | max 27.21
frames slower than 15 ms: 4 / 300        slower than 30 ms: 0
```

An ESP flash page write takes roughly 10–20 ms and blocks. If the controller were writing flash per
frame, 30 FPS would be impossible and the latency histogram would show periodic stalls. It shows
none. **The controller defers its save rather than writing per frame**, so streaming is safe.

Sensible hygiene still applies, and this plugin does all of it:

- de-duplicate identical consecutive frames, so a static effect stops re-sending
- cap the frame rate rather than sending as fast as the canvas renders
- hold one persistent TCP connection instead of reconnecting per frame

For reference, published figures for Magic Home *addressable* controllers are far lower — around
5 FPS, throttling to 2. Those numbers are for large pixel buffers. An 8-byte analog frame is a
completely different workload, which is why 30 FPS is comfortable here.

---

## Identifying your controller

This protocol applies to **analog / non-addressable** controllers — the ones driving a common-anode
RGB strip through a 4-pin `+ R G B` header.

| | Analog (supported) | Addressable (not supported) |
|---|---|---|
| Device type | `0x33` and relatives | `0xA3` |
| Output connector | 4 pins: `+`, R, G, B | 3 pins: `+5V`, data, GND |
| Strip markings | cut marks every 3 LEDs, no ICs | per-LED driver IC, data-direction arrows |
| Typical label | `5-28V`, wattage rating | pixel/IC type, e.g. WS2812B |
| App shows | a colour wheel only | a pixel or segment count |

Run [`tools/rgbeall-probe.ps1`](../tools/rgbeall-probe.ps1) to identify a controller without
guessing — it reports device type, firmware and protocol generation read directly from the hardware.

If your controller does not answer the state query in plaintext, it is a newer encrypted-firmware
unit and this plugin cannot drive it.

---

## One command per packet

The controller acts on **only the first LEDNET command in a TCP packet**. Concatenating a colour and
a power-off into a single write leaves the colour applied and the power-off silently ignored:

```
31 FF 38 08 00 F0 0F 6F 71 24 0F A4     -> colour applied, power-off dropped
```

This is a packeting rule, not a timing one. Two separate `write()` calls always land, even with no
gap between them — measured at 0 ms, a 3 ms busy-wait, 15 ms, next-tick and 30 ms, all identical.

The trap is that some runtimes buffer writes and flush once per turn of their event loop, so two
sends in the *same* turn still leave as one packet. Qt does this; Node does not. If your commands
are being ignored, check whether they are sharing a packet before you start adding delays — a delay
is not what fixes it, and a delay is exactly what you cannot afford on a shutdown path.
